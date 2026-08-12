// node:http server、路由、§5.9 三道校验、dist/web 静态托管(spec §5.9 / §5.12)。
//
// 本目录不直接触碰 git 与文件监听,只调用 git/ 与 watch/ 导出的函数 —— 这保证三道
// 校验位于唯一入口,不会被某条旁路绕开(spec §5.0 不变式 3)。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { homedir } from 'node:os';
import { DiffRequestError, readDiff } from '../git/diff.ts';
import type { RepoInfo } from '../git/repo.ts';
import { readStatus, readStatusRaw } from '../git/status.ts';
import type { ErrorPayload, RepoState, WatchState } from '../shared/protocol.ts';
import { forcedTierWarning, initialMode, resolveTier } from '../watch/tier.ts';
import { createWatcher, type WatchHandle } from '../watch/watcher.ts';
import { ASSETS, readAsset } from './assets.ts';
import {
  BIND_HOST,
  composeToken,
  createSecret,
  isHostAllowed,
  isOriginAllowed,
  readCookieToken,
  SECURITY_HEADERS,
  tokenCookie,
  tokensMatch,
} from './security.ts';
import { createSseChannel } from './sse.ts';

export interface GlanceServer {
  port: number;
  /** `<port>.<secret>`。写进注册表供 dev proxy 读取,也拼进打印出来的 URL。 */
  token: string;
  url: string;
  close(): Promise<void>;
}

/**
 * 错误信息不含绝对路径(spec §5.12 / §5.9)。
 *
 * git 的 fatal 文本里经常带着完整仓库路径,原样回给页面就把本机目录结构泄漏进了
 * 一个任何本地页面都可能读到的响应体。
 */
export function sanitizeMessage(message: string, repoRoot: string): string {
  const home = homedir();
  let out = message.split(repoRoot).join('<repo>');
  if (home) out = out.split(home).join('~');
  return out.split('\n')[0]?.trim() ?? '';
}

function send(res: ServerResponse, status: number, body: Buffer | string, contentType: string) {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': payload.byteLength,
  });
  res.end(payload);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

export async function startServer(repo: RepoInfo): Promise<GlanceServer> {
  /**
   * 出站错误一律经此发出,**sanitize 就做在这里**。
   *
   * 早先只在兜底的 500 分支上过一次 sanitizeMessage,于是「响应体不含绝对路径」这条
   * 不变式实际挂在「以后新增的错误消息恰好都不带路径」上 —— 那不是不变式,是巧合。
   * 放在唯一出口上,新增分支自动被覆盖(spec §5.12)。
   */
  const sendError = (res: ServerResponse, status: number, code: string, message: string) => {
    const payload: ErrorPayload = { error: { code, message: sanitizeMessage(message, repo.root) } };
    sendJson(res, status, payload);
  };

  const secret = createSecret();
  // 端口是 listen 之后才知道的,token 里又要绑端口 —— 先起 server,再合成 token
  let token = '';
  let port = 0;

  /**
   * 档位在**启动时**定,不等第一个订阅者。
   *
   * `/api/state` 里就带着它(§5.12),而那个请求先于任何 SSE 连接到达;更要紧的是
   * `GITGLANCE_WATCH_TIER` 写错时要在启动那一刻响亮地失败,而不是等到某次订阅。
   * 判定本身是纯计算(读 `process.versions.node` 与 `process.platform`),不落在
   * §6 的 300ms 冷启动预算上。
   */
  const tier = resolveTier();
  // 强制指定的档位在这个 Node 上跑不出它该有的样子时提醒一句(不拦启动,理由见那边)
  const tierWarning = forcedTierWarning();
  if (tierWarning) process.stderr.write(`gitglance: ${tierWarning}\n`);

  const events = createSseChannel();

  /**
   * 监听**懒起**:第一个 SSE 订阅者到了才建,起了就一直留到关服务。
   *
   * 两头都是有理由的。懒起是因为 §6 的冷启动门禁量的是「监听成功并打印 URL」,而
   * S3b2 的 A/B 档要在 repoRoot 上建递归 watch —— Linux 上那是用户态遍历整棵树,
   * 大仓库里足以把 300ms 预算一口吃掉,而此刻还没有任何人在等变更通知。
   * 不随最后一个订阅者关掉,则是因为刷新页面 = 断开再连,那会让上面那趟遍历
   * 每刷新一次重来一遍;空闲着的原生 watch 本身开销接近零(§6 的资源占用项)。
   */
  let watcher: WatchHandle | null = null;
  const ensureWatcher = () => {
    if (watcher !== null) return;
    watcher = createWatcher({
      gitDir: repo.gitDir,
      repoRoot: repo.root,
      tier,
      onChange: () => events.send('change', {}),
      /**
       * 轮询探针。**注入而不是让 watch/ 自己去调 git**:git 子进程只许出现在
       * server/git(§5.0 不变式 1),而 §5.0 的依赖方向里也没有 watch → git 这条边。
       * 传进去的是主查询本身(`readStatusRaw` 用的就是 `STATUS_ARGS`),于是「轮询
       * 与主查询逐字相同」这条红线在这里是**一处赋值**而不是两处各自维护的巧合。
       * 拦住它的不是类型(签名只是 `() => Promise<string>`),是这个唯一的注入点
       * 加上冒烟里那条「C 档在已存在的未跟踪目录里新增文件要推出 change」。
       */
      pollStatus: () => readStatusRaw(repo.root),
      /**
       * 降级为轮询(§5.7 的兜底)。**推一个 `change` 是必需的**:`mode` 只在
       * `/api/state` 里,前端不重取就看不到降级 —— 而它自己无从推断这件事(§5.12),
       * 于是页面会一直标着「原生监听」直到下一次真的有文件变更。
       */
      onDegrade: (cause) => {
        process.stderr.write(
          `gitglance: file watching degraded — ${sanitizeMessage(cause.message, repo.root)}\n`,
        );
        events.send('change', {});
      },
    });
  };

  /**
   * 当前的监听状态(§5.12 的 `WatchState`)。
   *
   * **每次请求现算,不是启动时算一次**:降级发生在运行中,而算一次存起来的那份
   * 不会报错,只是从此永远说「原生监听」。监听懒起(见上),还没起来时按档位的
   * 既定形态答 —— C 档从第一份 `/api/state` 起就该是 `polling`。
   */
  const currentWatchState = (): WatchState => ({
    mode: watcher?.mode ?? initialMode(tier),
    tier,
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 只读工具不需要任何非幂等端点(spec §5.12)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method-not-allowed', 'only GET is supported');
      return;
    }

    // 第 1 道:Host。DNS rebinding 的正面防御
    if (!isHostAllowed(req.headers.host, port)) {
      sendError(res, 403, 'forbidden', 'forbidden');
      return;
    }
    // 第 2 道:Origin。所有响应不带任何 CORS 头
    if (!isOriginAllowed(req.headers.origin, port)) {
      sendError(res, 403, 'forbidden', 'forbidden');
      return;
    }

    const url = new URL(req.url ?? '/', `http://${BIND_HOST}:${port}`);

    // 第 3 道:token。URL 带 token → 置换为 cookie 并 302 掉 query,
    // 避免 token 长期滞留在浏览器历史、地址栏和日志中(spec §5.9)
    const fromQuery = url.searchParams.get('token');
    if (fromQuery !== null) {
      if (!tokensMatch(fromQuery, token)) {
        sendError(res, 403, 'forbidden', 'forbidden');
        return;
      }
      url.searchParams.delete('token');
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        'Set-Cookie': tokenCookie(port, token),
        Location: `${url.pathname}${url.search}`,
        'Content-Length': 0,
      });
      res.end();
      return;
    }
    // 所有端点统一校验,无例外(spec §5.9 第 4 条)
    if (!tokensMatch(readCookieToken(req.headers.cookie, port), token)) {
      sendError(res, 403, 'forbidden', 'forbidden');
      return;
    }

    const asset = ASSETS.get(url.pathname);
    if (asset) {
      send(res, 200, await readAsset(asset), asset.contentType);
      return;
    }

    switch (url.pathname) {
      case '/api/state': {
        const status = await readStatus(repo.root);
        sendJson(res, 200, {
          branch: status.branch,
          files: status.files,
          watch: currentWatchState(),
        } satisfies RepoState);
        return;
      }

      case '/api/diff': {
        const path = url.searchParams.get('path');
        if (!path) {
          sendError(res, 400, 'bad-request', 'path is required');
          return;
        }
        const oldPath = url.searchParams.get('oldPath');
        sendJson(res, 200, await readDiff(repo.root, { path, ...(oldPath ? { oldPath } : {}) }));
        return;
      }

      /**
       * SSE(spec §5.8 / §5.12)。**三道校验在上面已经统一走过**,这里没有例外分支 ——
       * 「所有端点(含 SSE)统一校验」正是 §5.9 第 4 条。
       */
      case '/api/events': {
        const headers = {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
        };
        // HEAD 不能落进下面那条长连接:它永远不会有正文,却会把连接吊到超时
        if (req.method === 'HEAD') {
          res.writeHead(200, headers);
          res.end();
          return;
        }
        res.writeHead(200, headers);
        // 先写一行注释把响应头顶出去:在此之前浏览器不会派发 `open`,dev 下的
        // Vite 代理也可能一直攒着不发,表现为「页面连上了但第一个事件迟到 15 秒」
        res.write(': connected\n\n');

        /**
         * 两个监听器都必须挂在 `events.add` **之前**。
         *
         * `close` 覆盖全部断开路径(关标签、刷新、进程被 kill 掉对端);`error` 则是
         * 长连接独有的一条:写向一条已经结束的响应,`write()` 不会同步抛,而是在 `res`
         * 上**异步** emit 一个 `'error'` —— 一个零监听器的 EventEmitter 收到 `'error'`
         * 是整个进程带着裸栈崩掉,而不是丢一条心跳。
         *
         * 顺序则是因为 add 之后、挂上之前的那一小段里断开的话,就再没人把它摘出去:
         * 心跳会一直写向一条死响应,§5.8 的空闲退出也永远数不回 0。
         */
        res.on('close', () => events.remove(res));
        res.on('error', () => events.remove(res));

        events.add(res);
        /**
         * **监听推到下一拍再起**,不在这个请求里同步建。
         *
         * Linux 上 A / B 档的递归 watch 是**用户态的同步遍历**(`readdirSync` +
         * `statSync` 递归,已核对 `internal/fs/recursive_watch.js`),大仓库上要跑
         * 几百毫秒到数秒。留在这里的话,它占住的是整条事件循环 —— 页面此刻正并发
         * 发着 `/api/state` 与静态资源,那些请求会一起卡住,首屏因此变慢,
         * 而症状与「监听很慢」毫无相似之处。
         */
        setImmediate(ensureWatcher);
        return;
      }

      default:
        sendError(res, 404, 'not-found', 'not found');
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((cause: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (cause instanceof DiffRequestError) {
        sendError(res, 400, cause.code, cause.message);
        return;
      }
      const detail = cause instanceof Error ? cause.message : String(cause);
      sendError(res, 500, 'internal', detail);
    });
  });

  // 空闲连接在关服务时不会自己走 —— 记下来,close() 时一并断掉。
  // TODO(S3c):空闲 45 秒退出与多标签计数在这里长出来。
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    // 端口取 0 由内核随机分配;只绑 127.0.0.1,不监听任何外部可达地址
    server.listen(0, BIND_HOST, () => {
      server.removeListener('error', rejectPromise);
      resolvePromise();
    });
  });

  // listen 成功后上面那个一次性监听器就摘掉了,**必须补一个常驻的**:此后任何
  // 'error'(accept 时的 EMFILE / ENFILE 之类)都会撞上一个零 error 监听器的
  // EventEmitter,以裸异常栈崩掉整个进程 —— 正好是 main() 承诺的「一句话友好报错、
  // 绝不甩 Node 栈」的反面。这类错误不影响已建立的连接,打一行就够,不必退出。
  server.on('error', (cause: Error) => {
    // 这里不跟着 process.exit(),所以不需要 main.ts 那个 writeSync 的规避手法 ——
    // 那条是专为「写完立刻退出」准备的
    process.stderr.write(
      `gitglance: local server error — ${sanitizeMessage(cause.message, repo.root)}\n`,
    );
  });

  const address = server.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('failed to determine the listening port');
  }
  port = address.port;
  token = composeToken(port, secret);

  return {
    port,
    token,
    url: `http://${BIND_HOST}:${port}/?token=${encodeURIComponent(token)}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        // 顺序有讲究:先停监听与心跳,再断连接。反过来的话,断连引发的
        // `.git` 事件(没有)与正在发的心跳会写向已经 destroy 的 socket
        watcher?.close();
        events.close();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolvePromise());
      }),
  };
}
