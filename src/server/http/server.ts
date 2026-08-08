// node:http server、路由、§5.9 三道校验、dist/web 静态托管(spec §5.9 / §5.12)。
//
// 本目录不直接触碰 git 与文件监听,只调用 git/ 与 watch/ 导出的函数 —— 这保证三道
// 校验位于唯一入口,不会被某条旁路绕开(spec §5.0 不变式 3)。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { homedir } from 'node:os';
import { DiffRequestError, readDiff } from '../git/diff.ts';
import type { RepoInfo } from '../git/repo.ts';
import { readStatus } from '../git/status.ts';
import type { ErrorPayload, RepoState, WatchState } from '../shared/protocol.ts';
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

/**
 * TODO(S3b):监听档位与降级状态的真实取值随 §5.7 落地。
 *
 * 字段现在就必须有:晚定等于前端在 S2 按「永远不降级」写死,S3b 再回头改渲染分支
 * (spec §5.12「字段定型时机」)。
 */
const PLACEHOLDER_WATCH: WatchState = { mode: 'native', tier: 'A' };

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
          watch: PLACEHOLDER_WATCH,
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

      // TODO(S3b):SSE 通道随自动刷新一同落地。端点在 §5.12 的清单里,但它的
      // 连接计数正是 §5.8 空闲退出的判据,两者属 S3b / S3c,不在本阶段提前拼一半。
      case '/api/events': {
        sendError(res, 501, 'not-implemented', 'live updates land in a later milestone');
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
        for (const socket of sockets) socket.destroy();
        server.close(() => resolvePromise());
      }),
  };
}
