// 单实例的**探活复用**:注册表里记着一个端口,那头还活着吗、还是同一个仓库吗?
//
// 与 registry.ts 的分工:那边是文件(写入、清理、键归一化),这边是那一次 HTTP 请求。
// **判活绝不用 pid** —— pid 会被系统复用,误判会把用户带到一个指向别人进程的页面。

import { request } from 'node:http';
import { BIND_HOST, cookieName, sessionUrl } from '../http/security.ts';
import type { InstanceInfo } from '../http/server.ts';
import { normalizeRepoKey, type RegistryEntry, readRegistry } from './registry.ts';

/**
 * 探活超时。**不取更短**:被探的实例可能正卡在那趟用户态递归遍历里(Linux 大仓库上几百
 * 毫秒到数秒),超时过短的代价不是慢一点,而是**给同一个仓库起了第二个进程**。反过来这
 * 1.5s 平时根本走不到 —— 注册表不存在时压根不探,端口已死时 localhost 上的
 * `ECONNREFUSED` 是立即返回的。
 */
export const PROBE_TIMEOUT_MS = 1500;

/**
 * 正文读到这么多还没完就放弃:端口可能已经归了一个完全无关的服务,而它的 `/api/instance`
 * 可以是任何东西 —— 一个流式响应会让下面那句 `body +=` 一直涨下去。
 */
const MAX_BODY_BYTES = 64 * 1024;

export interface LiveInstance {
  /** 对端自报的 pid。**只用于打印**,判活不看它。 */
  pid: number;
  /** 直接可交给浏览器的 URL(带 token),与那个实例自己打印的完全相同。 */
  url: string;
}

/**
 * 向记录的端口要一份 `InstanceInfo`。任何不顺利一律返回 null(= 按陈旧处理)。**带上
 * token 与合规的 `Host`**:三道校验一视同仁,探活不是例外 —— 那也正是「端口已经归了另一个
 * 仓库的 difftab」这种情形的判据:它那份 token 不是我们记下的这个,于是 403、判陈旧。
 */
function requestInstance(entry: RegistryEntry, timeoutMs: number): Promise<InstanceInfo | null> {
  return new Promise((resolvePromise) => {
    const req = request(
      {
        host: BIND_HOST,
        port: entry.port,
        path: '/api/instance',
        headers: {
          Host: `${BIND_HOST}:${entry.port}`,
          Cookie: `${cookieName(entry.port)}=${entry.token}`,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          req.destroy();
          resolvePromise(null);
          return;
        }
        /**
         * **响应头到手之后,`req` 就不再是错误的出口了**:此后 `req.destroy()` 与对端中途
         * 断开都只落在 `res` 上(`'aborted'` 随后 `'error': ECONNRESET`),而
         * `IncomingMessage` 会把没人听的 `'error'` 自己吞掉 —— 于是下面那两处 `destroy()`
         * (超时、正文过大)既走不到 `'end'`、也走不到 `req.on('error')`,**这个 Promise
         * 永远不 settle**,`start.ts` 里那句 `await findLiveInstance()` 把启动整个吊死。
         *
         * `'close'` 是 `res` 上唯一覆盖全部结局的事件;正常读完时它排在 `'end'` 之后,那时
         * 早已 resolve 过,再 resolve 一次没有作用(首次为准)。
         */
        res.on('close', () => resolvePromise(null));

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > MAX_BODY_BYTES) {
            req.destroy();
            resolvePromise(null);
          }
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as Partial<InstanceInfo>;
            if (typeof parsed.repoRoot !== 'string' || typeof parsed.pid !== 'number') {
              resolvePromise(null);
              return;
            }
            resolvePromise({ repoRoot: parsed.repoRoot, pid: parsed.pid });
          } catch {
            // 端口归了别的服务,答的不是 JSON
            resolvePromise(null);
          }
        });
      },
    );

    // 连接被拒(端口已死)、被我们自己 destroy、以及读到一半对端没了,都走这里
    req.on('error', () => resolvePromise(null));
    /**
     * 超时用 `setTimeout` 而不是 `req.setTimeout`:后者只管 **socket 空闲**,一个每 200ms
     * 吐一个字节的第三方服务能让它永远不触发。**`destroy()` 之后必须自己 resolve** ——
     * 响应头已经到手时,这一下的错误落在 `res` 上而不是 `req` 上,光 destroy 等于把超时做
     * 成了一个不生效的摆设,而症状是启动整个吊死,恰好比没有超时更难看出来。
     */
    const timer = setTimeout(() => {
      req.destroy();
      resolvePromise(null);
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

/**
 * 这个仓库已经有活着的实例吗?有就返回它的 URL,没有就 null。命中之后调用方**不得碰注册
 * 表**:那条目是另一个进程写的,连「顺手更新一下」都不行 —— 它退出时按 pid 只删自己的那
 * 条,我们改过的内容会让它留下垃圾。
 */
export async function findLiveInstance(
  repoRoot: string,
  { timeoutMs = PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<LiveInstance | null> {
  const entry = readRegistry(repoRoot);
  // 「这条目还能用吗」只由 readRegistry 判(端口范围、token 非空都在那儿)
  if (!entry) return null;

  const info = await requestInstance(entry, timeoutMs);
  if (!info) return null;

  /**
   * **200 还不够,路径也得对得上**:这一条挡的是「注册表条目还在,而那个端口已经被系统
   * 回收给了别的东西」—— 它恰好也认得这份 token 的概率不高,但代价是把用户带到别人的页面,
   * 而这类判断错了不会有任何东西报错。归一化复用注册表键那一份实现。
   */
  if (normalizeRepoKey(info.repoRoot) !== normalizeRepoKey(repoRoot)) return null;

  return { pid: info.pid, url: sessionUrl(entry.port, entry.token) };
}
