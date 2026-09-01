// node:http server、路由、三道校验、dist/web 静态托管。
//
// 本目录不直接触碰 git 与文件监听,只调用 git/ 与 watch/ 导出的函数 —— 三道校验因此
// 位于唯一入口,不会被某条旁路绕开。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { homedir } from 'node:os';
import { DiffRequestError, readDiff } from '../git/diff.ts';
import { type RepoInfo, repoNameOf } from '../git/repo.ts';
import { readStatus, readStatusRaw } from '../git/status.ts';
import type { ErrorPayload, RepoState, WatchState } from '../shared/protocol.ts';
import { forcedTierWarning, initialMode, resolveTier } from '../watch/tier.ts';
import { createWatcher, type WatchHandle } from '../watch/watcher.ts';
import { ASSETS, readAsset } from './assets.ts';
import { createIdleWatchdog, resolveIdleMs } from './idle.ts';
import {
  BIND_HOST,
  composeToken,
  createSecret,
  isHostAllowed,
  isOriginAllowed,
  readCookieToken,
  SECURITY_HEADERS,
  sessionUrl,
  tokenCookie,
  tokensMatch,
} from './security.ts';
import { createSseChannel } from './sse.ts';

export interface DifftabServer {
  port: number;
  /** `<port>.<secret>`。写进注册表供 dev proxy 读取,也拼进打印出来的 URL。 */
  token: string;
  url: string;
  close(): Promise<void>;
}

export interface ServerOptions {
  /**
   * 宽限期走满且仍无客户端时调用一次。**进程怎么退是 cli 的事,不是 http 的事**:这一层
   * 只知道「没人了」,否则单测里每跑一次空闲用例都要防着 `process.exit` 把 runner 带走。
   */
  onIdle?: () => void;
}

/**
 * `GET /api/instance` 的响应体。**不放 `shared/`**:那个目录是「前端唯一允许 import 的
 * 后端目录」,里面每一项都真的被 `src/web` 消费,而这一项的唯一消费者是**下一个 CLI
 * 进程**。放进去就再没有一个按目录回答「前端到底依赖什么」的办法;`cli → http` 本就是
 * 允许的依赖方向,probe 直接 `import type` 即可。
 */
export interface InstanceInfo {
  repoRoot: string;
  pid: number;
}

/**
 * 错误信息不含绝对路径:git 的 fatal 文本经常带着完整仓库路径,原样回给页面就把本机
 * 目录结构泄漏进了一个任何本地页面都可能读到的响应体。
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

export async function startServer(
  repo: RepoInfo,
  options: ServerOptions = {},
): Promise<DifftabServer> {
  /**
   * 出站错误一律经此发出,**sanitize 就做在这里**。只在兜底的 500 分支上做时,「响应体
   * 不含绝对路径」实际挂在「以后新增的消息恰好都不带路径」上 —— 那不是不变式,是巧合。
   */
  const sendError = (res: ServerResponse, status: number, code: string, message: string) => {
    const payload: ErrorPayload = { error: { code, message: sanitizeMessage(message, repo.root) } };
    sendJson(res, status, payload);
  };

  // 实例级常量:`repo` 整个进程生命周期不变,没有理由每次 /api/state 再切一遍
  const repoName = repoNameOf(repo);

  const secret = createSecret();
  // 端口是 listen 之后才知道的,token 里又要绑端口 —— 先起 server,再合成 token
  let token = '';
  let port = 0;

  /**
   * 档位在**启动时**定,不等第一个订阅者:`/api/state` 里就带着它,而
   * `DIFFTAB_WATCH_TIER` 写错时要在启动那一刻响亮地失败。判定是纯计算,不落在 300ms
   * 冷启动预算上。
   */
  const tier = resolveTier();
  // 强制指定的档位在这个 Node 上跑不出它该有的样子时提醒一句(不拦启动,理由见那边)
  const tierWarning = forcedTierWarning();
  if (tierWarning) process.stderr.write(`difftab: ${tierWarning}\n`);

  /**
   * 通道与空闲计时器互相接线:连接数一变(add / remove)就 `touch` 一次。
   * 端点那侧因此**不必记得**在断连时重新武装 —— 见 sse.ts 的 `onChange`。
   */
  const events = createSseChannel({ onChange: () => idle.touch() });

  /**
   * 空闲退出的计时器。**判据是 SSE 连接数,但任何通过校验的请求都重置计时** —— 连接数
   * 为 0 也可能是「刚被探活复用、浏览器还在启动」或「页面活着但 SSE 被中间层回收了」。
   * 两者取并集,退出条件因此严格弱于「连接数为 0 持续 45s」,只会晚退不会早退。
   *
   * `resolveIdleMs()` 在这里(listen 之前)读环境变量:写错的取值要在启动那一刻失败,
   * 而不是等到 45 秒后什么都没发生。
   */
  const idle = createIdleWatchdog({
    idleMs: resolveIdleMs(),
    hasClients: () => events.size > 0,
    onIdle: () => options.onIdle?.(),
  });

  /**
   * 监听**懒起**:第一个 SSE 订阅者到了才建,起了就一直留到关服务。
   *
   * 懒起是因为冷启动门禁量的是「监听成功并打印 URL」,而 A / B 档要在 repoRoot 上建递归
   * watch —— Linux 上那是用户态遍历整棵树,大仓库里足以把 300ms 预算一口吃掉。不随最后
   * 一个订阅者关掉,是因为刷新页面 = 断开再连,那会让那趟遍历每刷新一次重来一遍。
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
       * 轮询探针。**注入而不是让 watch/ 自己去调 git**:git 子进程只许出现在 server/git,
       * 依赖方向里也没有 watch → git 这条边。传进去的是主查询本身(`readStatusRaw` 用的
       * 就是 `STATUS_ARGS`),于是「轮询与主查询逐字相同」在这里是**一处赋值**而不是两处
       * 各自维护的巧合。
       *
       * **已知的覆盖边界**:`operation` 不来自 status 输出,这条探针看不见它。三档都在
       * `gitDir` 上建了非递归 watch,正常情况下照样推得出 change;只有**那条 watch 自己也
       * 失败、整体落到轮询**之后,一次只动 git 目录的操作(`rebase --quit` 一类)才会让
       * 标注停在旧值上。不为它把探针拆成两个来源。
       */
      pollStatus: () => readStatusRaw(repo.root),
      /**
       * 降级为轮询(兜底)。**推一个 `change` 是必需的**:`mode` 只在 `/api/state` 里,
       * 前端不重取就看不到降级,页面会一直标着「原生监听」直到下一次真的有文件变更。
       */
      onDegrade: (cause) => {
        process.stderr.write(
          `difftab: file watching degraded — ${sanitizeMessage(cause.message, repo.root)}\n`,
        );
        events.send('change', {});
      },
    });
  };

  /**
   * 当前的监听状态(`WatchState`)。**每次请求现算**:降级发生在运行中,算一次存起来的
   * 那份不报错,只是从此永远说「原生监听」。监听懒起,还没起来时按档位的既定形态答。
   */
  const currentWatchState = (): WatchState => ({
    mode: watcher?.mode ?? initialMode(tier),
    tier,
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
    // 避免 token 长期滞留在浏览器历史、地址栏和日志中
    const fromQuery = url.searchParams.get('token');
    if (fromQuery !== null) {
      if (!tokensMatch(fromQuery, token)) {
        sendError(res, 403, 'forbidden', 'forbidden');
        return;
      }
      idle.touch();
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
    // 所有端点统一校验,无例外
    if (!tokensMatch(readCookieToken(req.headers.cookie, port), token)) {
      sendError(res, 403, 'forbidden', 'forbidden');
      return;
    }
    /**
     * 到这里才算「有人在」,**三道校验之前不算**(上面那个 302 分支同理)。放在函数开头
     * 更省事,代价是本机任何一个端口扫描器都能无限期续命一个该退的进程。
     */
    idle.touch();

    /**
     * 只读工具不需要任何非幂等端点。**必须留在三道校验之后**,否则泄漏服务存在性。副作用
     * 是带合法 token 的非幂等请求会先被上面那个分支 302 换成 cookie 而不是 405 —— 它已经
     * 过了三道校验,是取舍。
     */
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method-not-allowed', 'only GET is supported');
      return;
    }

    const asset = ASSETS.get(url.pathname);
    if (asset) {
      send(res, 200, await readAsset(asset), asset.contentType);
      return;
    }

    switch (url.pathname) {
      case '/api/state': {
        // 整个 `RepoInfo` 传下去:进行中的多步操作要从 **git 目录**读,
        // 而它与工作区根在 linked worktree / submodule 下是两条完全不同的路径
        const status = await readStatus(repo);
        sendJson(res, 200, {
          repoName,
          branch: status.branch,
          files: status.files,
          watch: currentWatchState(),
        } satisfies RepoState);
        return;
      }

      /**
       * 探活复用的应答。**消费者是下一个 CLI 进程,不是前端。** 它答的是「这个端口现在
       * 还是**这个仓库**的实例吗」:光有三道校验答不了 —— token 不匹配只证明「不是我们
       * 这一份会话」,而 200 之后还要确认路径确实是我们这个仓库,否则「复用」会把用户带到
       * 别人的页面(排除 pid 判活也是同一条理由)。
       */
      case '/api/instance': {
        sendJson(res, 200, { repoRoot: repo.root, pid: process.pid } satisfies InstanceInfo);
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

      /** SSE。**三道校验在上面已经统一走过**,这里没有例外分支。 */
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
         * 两个监听器都必须挂在 `events.add` **之前**。`close` 覆盖全部断开路径(关标签、
         * 刷新、对端被 kill);`error` 是长连接独有的一条 —— 写向一条已经结束的响应,
         * `write()` 不同步抛,而是在 `res` 上**异步** emit `'error'`,而零监听器的
         * EventEmitter 收到 `'error'` 是整个进程带着裸栈崩掉。顺序则是因为 add 之后、挂上
         * 之前断开的话就再没人把它摘出去:心跳一直写向死响应,空闲退出也永远数不回 0。
         *
         * 断开之后**必须再 touch 一次**(计时只在 `touch()` 里起):这是「最后一个标签被
         * 关掉」在服务端的唯一形态,少了它就是关完浏览器留一个永久常驻进程。
         */
        res.on('close', () => events.remove(res));
        res.on('error', () => events.remove(res));

        events.add(res);
        /**
         * **监听推到下一拍再起**,不在这个请求里同步建:Linux 上 A / B 档的递归 watch 是
         * 用户态的同步遍历,大仓库上要跑几百毫秒到数秒,留在这里占住的是整条事件循环 ——
         * 页面此刻正并发发着 `/api/state` 与静态资源,首屏因此一起卡住,而症状与「监听很
         * 慢」毫无相似之处。
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

  // 空闲连接在关服务时不会自己走 —— 记下来,close() 时一并断掉。空闲退出**不看这个
  // 集合**:一条 keep-alive 的空闲 TCP 连接与「有人在看页面」是两回事
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
    // 这里不跟着 process.exit(),所以不需要 main.ts 那个 writeSync 的规避手法
    process.stderr.write(
      `difftab: local server error — ${sanitizeMessage(cause.message, repo.root)}\n`,
    );
  });

  const address = server.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('failed to determine the listening port');
  }
  port = address.port;
  token = composeToken(port, secret);

  /**
   * **宽限期从这一刻就开始计,不等第一个客户端**:等第一个客户端才起计时,会把「浏览器
   * 压根没拉起来」(headless、无 `xdg-open`、`--no-open` 之后改主意)整类情形变成永久
   * 常驻的后台进程。45 秒足够覆盖冷启动一个浏览器进程的 2-5s。
   */
  idle.touch();

  return {
    port,
    token,
    url: sessionUrl(port, token),
    close: () =>
      new Promise<void>((resolvePromise) => {
        // 顺序有讲究:先停监听、心跳与空闲计时,再断连接。反过来的话,断连引发的
        // `.git` 事件(没有)与正在发的心跳会写向已经 destroy 的 socket;而空闲计时
        // 不先停,断连接触发的那一串 'close' 会把它重新武装起来
        idle.stop();
        watcher?.close();
        events.close();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolvePromise());
      }),
  };
}
