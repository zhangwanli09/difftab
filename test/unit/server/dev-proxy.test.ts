// dev 代理**没有以放宽后端校验的方式实现**(spec §6 / §5.11)。
//
// 这条验收项的正面证据只能是「同一个请求,直连被拒、经代理通过」:
// 光看 vite.config.ts 里写了 changeOrigin 证明不了后端那三道门还在。
// 因此这里起一个真的后端 + 一个真的 vite dev server,让请求走完整条路。

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { registryPath, removeRegistry, writeRegistry } from '../../../src/server/cli/registry.ts';
import { locateRepo } from '../../../src/server/git/repo.ts';
import { type GlanceServer, startServer } from '../../../src/server/http/server.ts';

const repoRoot = process.cwd();

let backend: GlanceServer;
let vite: ViteDevServer;
let viteOrigin: string;
/** 本仓库注册表项的原始内容(如果本来就有)。 */
let saved: string | null = null;

beforeAll(async () => {
  // 本用例要往**本仓库**的注册表项里写自己的 port/token,而开发者很可能正好在
  // 同一个仓库里跑着 `node bin/gitglance.js`。writeRegistry 的 EEXIST 分支会直接
  // 覆盖,afterAll 又会删掉 —— 那个实例从此没有记录,S3c 的探活复用会给同一个
  // 仓库起第二个进程。先存一份,退出时原样放回去
  try {
    saved = readFileSync(registryPath(repoRoot), 'utf8');
  } catch {
    saved = null; // 本来就没有,退出时删掉即可
  }

  backend = await startServer(await locateRepo(repoRoot));
  // vite.config.ts 在**加载时**从注册表读 port 与 token,所以先写再起
  writeRegistry({
    pid: process.pid,
    port: backend.port,
    token: backend.token,
    repoRoot,
    startedAt: Date.now(),
  });

  vite = await createViteServer({
    configFile: `${repoRoot}/vite.config.ts`,
    logLevel: 'silent',
    // 配置里钉的是 5173 + strictPort,跑测试时不该去抢那个端口
    server: { port: 0, strictPort: false },
  });
  await vite.listen();
  // 用 resolvedUrls 而不是自己拼 127.0.0.1:<port>:dev server 默认绑的是 localhost,
  // 在 IPv6 优先的机器上那是 ::1,自己拼出来的地址会 ECONNREFUSED(已实测)
  const local = vite.resolvedUrls?.local[0];
  if (!local) throw new Error('dev server 没有给出可访问的地址');
  viteOrigin = local.replace(/\/$/, '');
}, 60_000);

afterAll(async () => {
  await vite?.close();
  await backend?.close();
  removeRegistry(repoRoot);
  rmSync(registryPath(repoRoot), { force: true });
  // 0o600 与写入时保持一致 —— 放回去的内容里同样有别人的 token
  if (saved !== null) writeFileSync(registryPath(repoRoot), saved, { mode: 0o600 });
});

test('直连后端:带着 dev server 的 Origin、且没有 cookie —— 被拒', async () => {
  // 这是浏览器里那个页面原样发出的请求。它必须被拒,否则下一条测的就不是代理了
  const direct = await fetch(`http://127.0.0.1:${backend.port}/api/state`, {
    headers: { Origin: viteOrigin },
  });
  expect(direct.status).toBe(403);
});

test('经 vite 代理:同一个请求拿到 /api/state', async () => {
  const viaProxy = await fetch(`${viteOrigin}/api/state`, { headers: { Origin: viteOrigin } });
  expect(viaProxy.status).toBe(200);

  const state = (await viaProxy.json()) as { branch: unknown; files: unknown[]; watch: unknown };
  expect(state.branch).toBeTruthy();
  expect(Array.isArray(state.files)).toBe(true);
  expect(state.watch).toBeTruthy();
});
