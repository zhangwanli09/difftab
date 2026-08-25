// 探活复用。
//
// 钉的是「什么才算命中」。判错的两个方向都不报错:判成陈旧 → 同一个仓库悄悄开出
// 第二个进程;判成命中 → 把用户带到**别人的页面**(端口被系统回收给了别的东西)。
// 这里拿真的 node:http server 当对端 —— 三道校验之外的那点协议(Host / Cookie /
// 正文形状)只有真发一次请求才验得到。

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { findLiveInstance } from '../../../src/server/cli/probe.ts';
import { registryPath, writeRegistry } from '../../../src/server/cli/registry.ts';

const TOKEN_SECRET = 'secret-from-the-registry';

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(registryPath(dir), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'difftab-probe-'));
  dirs.push(dir);
  return dir;
}

/** 假实例的原始形态:自己拿着 `req` / `res` 想怎么答怎么答(答一半、没完没了)。 */
async function rawInstance(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return { port: address.port };
}

/** 一问一答的常见形态。`respond` 返回 null 表示永远不答。 */
async function fakeInstance(
  respond: (req: IncomingMessage) => { status: number; body: string } | null,
): Promise<{ port: number; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = [];
  const { port } = await rawInstance((req, res) => {
    requests.push(req);
    const answer = respond(req);
    if (answer === null) return; // 永远不答 —— 探活超时那条用例要的就是这个
    res.writeHead(answer.status, { 'Content-Type': 'application/json' });
    res.end(answer.body);
  });
  return { port, requests };
}

/** 把一条注册表条目落到 repo 对应的位置,port 指向假实例。 */
function register(repoRoot: string, port: number): void {
  writeRegistry({
    pid: 4242,
    port,
    token: `${port}.${TOKEN_SECRET}`,
    repoRoot,
    startedAt: Date.now(),
  });
}

describe('命中', () => {
  test('200 + 路径对得上 → 拿回可直接打开的 URL', async () => {
    const repo = tempRepo();
    const instance = await fakeInstance(() => ({
      status: 200,
      body: JSON.stringify({ repoRoot: repo, pid: 4242 }),
    }));
    register(repo, instance.port);

    const live = await findLiveInstance(repo);
    expect(live).not.toBe(null);
    expect(live?.pid).toBe(4242);
    // URL 必须与那个实例自己打印的完全相同 —— 少了 token 就是一个 403 的链接,
    // 而这条路平时不走,谁也不会先注意到
    expect(live?.url).toBe(
      `http://127.0.0.1:${instance.port}/?token=${encodeURIComponent(`${instance.port}.${TOKEN_SECRET}`)}`,
    );
  });

  test('探活自己也过三道校验:带合规的 Host 与注册表里的 token', async () => {
    // 不带的话对端一律 403,于是**每一个**活着的实例都被判成陈旧 —— 而症状不是
    // 报错,是「复用从来没生效过」,和功能没做一模一样
    const repo = tempRepo();
    const instance = await fakeInstance(() => ({
      status: 200,
      body: JSON.stringify({ repoRoot: repo, pid: 1 }),
    }));
    register(repo, instance.port);

    await findLiveInstance(repo);
    const req = instance.requests[0];
    expect(req?.url).toBe('/api/instance');
    expect(req?.headers.host).toBe(`127.0.0.1:${instance.port}`);
    expect(req?.headers.cookie).toBe(
      `difftab_token_${instance.port}=${instance.port}.${TOKEN_SECRET}`,
    );
  });

  test('两侧路径写法不同也认得出 —— 归一化与注册表键同一份', async () => {
    // macOS 的 /var → /private/var、Windows 的分隔符:两个活着的实例互不相认时,
    // 同一个仓库就会开出第二个进程
    const repo = tempRepo();
    const instance = await fakeInstance(() => ({
      status: 200,
      body: JSON.stringify({ repoRoot: join(repo, '.'), pid: 7 }),
    }));
    register(repo, instance.port);

    expect(await findLiveInstance(repo)).not.toBe(null);
  });
});

describe('判为陈旧', () => {
  test('没有注册表条目 —— 常态,不发任何请求', async () => {
    expect(await findLiveInstance(tempRepo())).toBe(null);
  });

  test('端口已经没人听了(实例被 SIGKILL 掉、条目没来得及清)', async () => {
    const repo = tempRepo();
    const instance = await fakeInstance(() => ({ status: 200, body: '{}' }));
    register(repo, instance.port);
    // 把假实例整个关掉,那个端口从此是死端口 —— localhost 上 ECONNREFUSED 立即返回
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }

    expect(await findLiveInstance(repo)).toBe(null);
  });

  test('403 —— 那个端口已经归了别的 difftab(它的 token 不是我们记下的这个)', async () => {
    const repo = tempRepo();
    const instance = await fakeInstance(() => ({ status: 403, body: '{"error":{}}' }));
    register(repo, instance.port);

    expect(await findLiveInstance(repo)).toBe(null);
  });

  test('**200 但路径不是这个仓库** —— 复用它等于把用户带到别人的页面', async () => {
    // 这一条是 200 之后还要比路径的全部理由。少了它,判据退化成「端口上有人应答」,
    // 而应答的可能是任何一个恰好认得这份 token 的进程
    const repo = tempRepo();
    const other = tempRepo();
    const instance = await fakeInstance(() => ({
      status: 200,
      body: JSON.stringify({ repoRoot: other, pid: 9 }),
    }));
    register(repo, instance.port);

    expect(await findLiveInstance(repo)).toBe(null);
  });

  test('答的不是 JSON、或形状不对', async () => {
    const repo = tempRepo();
    const instance = await fakeInstance(() => ({ status: 200, body: '<html>hello</html>' }));
    register(repo, instance.port);
    expect(await findLiveInstance(repo)).toBe(null);

    const repo2 = tempRepo();
    const instance2 = await fakeInstance(() => ({ status: 200, body: '{"pid":1}' }));
    register(repo2, instance2.port);
    expect(await findLiveInstance(repo2)).toBe(null);
  });

  test('**答了响应头就不说话了** —— 超时照样得管用', async () => {
    /**
     * 回归点:响应头一到手,`req` 就不再是错误的出口 —— `req.destroy()` 的错误只落在
     * `res` 上,而 `IncomingMessage` 把没人听的 `'error'` 吞掉。于是超时那一下什么
     * 都不会发生,Promise 永远不 settle,`start.ts` 里 `await findLiveInstance()`
     * 把**启动整个吊死**,一行输出都没有。
     *
     * 下面那条「对端不答话」抓不到它:响应头都没发时,错误确实落在 `req` 上。
     * 两条差的只是一次 `writeHead`,症状却是天壤之别。
     */
    const repo = tempRepo();
    const instance = await rawInstance((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"repoRoot":'); // 半句话,然后装死
    });
    register(repo, instance.port);

    expect(await findLiveInstance(repo, { timeoutMs: 150 })).toBe(null);
  });

  test('正文没完没了 —— 超过上限就断,同样得 settle', async () => {
    // 端口归了别的服务时,`/api/instance` 可以是任何东西,包括一条无穷的流。
    // 断了之后不自己 resolve 的话,后果与上一条相同
    const repo = tempRepo();
    const instance = await rawInstance((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const pump = () => {
        if (res.writableEnded || res.destroyed) return;
        res.write('x'.repeat(8 * 1024));
        setTimeout(pump, 1);
      };
      pump();
    });
    register(repo, instance.port);

    expect(await findLiveInstance(repo, { timeoutMs: 5000 })).toBe(null);
  });

  test('对端不答话 —— 超时是整次探活的墙钟上限,不是 socket 空闲', async () => {
    const repo = tempRepo();
    const instance = await fakeInstance(() => null);
    register(repo, instance.port);

    const started = Date.now();
    expect(await findLiveInstance(repo, { timeoutMs: 120 })).toBe(null);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
