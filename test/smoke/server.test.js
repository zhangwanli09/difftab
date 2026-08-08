// CLI 启动 + §5.9 三道校验 + 注册表写入,**跑的是 dist/ 产物**(spec §5.11 CI 分层)。
//
// 与 test/unit/server/security.test.ts 的分工:那边钉纯函数的行为,这边钉「它们真的
// 被接在了唯一入口上」。三道校验各自写对、却漏接一处端点,单测全绿而这里会红。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { makeFixtures } from '../fixtures/make.mjs';
import { authedGet, BIN, httpGet, startGitglance } from './helpers.js';

let workdir;
let repos;
let server;

/** 递归列出仓库里的所有文件(相对路径),用来证明工具没往里写东西。 */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'gitglance-server-'));
  repos = makeFixtures(join(workdir, 'repos'));
  server = await startGitglance({ cwd: repos.unicodePaths });
});

after(async () => {
  await server?.stop();
  rmSync(workdir, { recursive: true, force: true });
});

test('stdout 的第一行是且只是 URL —— 冷启动门禁以它为 ready 判据', () => {
  const first = server.stdout.split('\n')[0];
  assert.match(first, /^http:\/\/127\.0\.0\.1:\d+\/\?token=\d+\./);
  assert.equal(first, server.url);
  // 只绑 127.0.0.1,不监听任何外部可达地址
  assert.ok(!first.includes('0.0.0.0'));
});

test('第 1 道:Host 不是 127.0.0.1/localhost 加本端口一律 403', async () => {
  // 带着**有效** cookie 发,这样 403 只可能出自 Host 那一道
  for (const host of ['evil.example', `evil.example:${server.port}`, '127.0.0.1', 'localhost']) {
    const res = await authedGet(server.port, server.token, '/api/state', { Host: host });
    assert.equal(res.status, 403, `Host: ${host} 竟然通过了`);
  }
  assert.equal((await authedGet(server.port, server.token, '/api/state')).status, 200);
  const viaLocalhost = await authedGet(server.port, server.token, '/api/state', {
    Host: `localhost:${server.port}`,
  });
  assert.equal(viaLocalhost.status, 200);
});

test('第 2 道:Origin 非空且不等于自身则 403,且响应不带任何 CORS 头', async () => {
  const bad = await authedGet(server.port, server.token, '/api/state', {
    Origin: 'http://evil.example',
  });
  assert.equal(bad.status, 403);

  const good = await authedGet(server.port, server.token, '/api/state', {
    Origin: `http://127.0.0.1:${server.port}`,
  });
  assert.equal(good.status, 200);
  for (const header of Object.keys(good.headers)) {
    assert.ok(!header.toLowerCase().startsWith('access-control-'), `出现了 CORS 头 ${header}`);
  }
});

test('第 3 道:URL 上的 token 换成 HttpOnly cookie 并 302 掉 query', async () => {
  const res = await httpGet(server.port, `/?token=${encodeURIComponent(server.token)}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
  const setCookie = String(res.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  // token 不该留在跳转目标里 —— 那正是 302 掉 query 要解决的事
  assert.ok(!String(res.headers.location).includes('token'));
});

test('第 3 道:没有 token 一律 403,静态资源与 SSE 端点无例外', async () => {
  for (const path of [
    '/',
    '/app.js',
    '/app.css',
    '/api/state',
    '/api/diff?path=a',
    '/api/events',
  ]) {
    const res = await httpGet(server.port, path);
    assert.equal(res.status, 403, `${path} 在没有 token 时返回了 ${res.status}`);
  }
  // 端口对、secret 不对 —— 形状合法的 token 也必须被拒
  const wrong = await authedGet(server.port, `${server.port}.wrong`, '/api/state');
  assert.equal(wrong.status, 403);
});

test('安全响应头出现在每一个响应上,包括被拒的那些', async () => {
  const responses = [
    await httpGet(server.port, '/api/state'),
    await authedGet(server.port, server.token, '/api/state'),
    await authedGet(server.port, server.token, '/'),
  ];
  for (const res of responses) {
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.ok(!csp.includes('unsafe-inline'));
  }
});

test('静态资源按白名单映射,拼路径读文件的写法一个都不留', async () => {
  const ok = await authedGet(server.port, server.token, '/app.js');
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /javascript/);

  for (const path of [
    '/../package.json',
    '/..%2fpackage.json',
    '/app.js/../../package.json',
    '/dist/server/main.js',
    '/nope.txt',
  ]) {
    const res = await authedGet(server.port, server.token, path);
    assert.ok(res.status === 404 || res.status === 400, `${path} 返回了 ${res.status}`);
    assert.ok(!res.body.includes('"name": "gitglance"'), `${path} 把 package.json 读出来了`);
  }
});

test('只有 GET —— 出现非幂等方法即 405', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await authedGet(server.port, server.token, '/api/state', {}, method);
    assert.equal(res.status, 405, `${method} 返回了 ${res.status}`);
  }
});

test('路径含非 ASCII / 空格 / 引号的文件,在产物上也不出现转义残留', async () => {
  const state = JSON.parse((await authedGet(server.port, server.token, '/api/state')).body);
  const tricky = state.files.find((f) => f.path.includes('需求'));
  assert.ok(tricky, `列表里没有非 ASCII 路径:${JSON.stringify(state.files.map((f) => f.path))}`);
  for (const file of state.files) {
    assert.doesNotMatch(file.path, /\\[0-7]{3}/, `路径里有 C 风格转义残留:${file.path}`);
  }

  const diff = JSON.parse(
    (
      await authedGet(
        server.port,
        server.token,
        `/api/diff?path=${encodeURIComponent(tricky.path)}`,
      )
    ).body,
  );
  assert.equal(diff.kind, 'text');
  assert.ok(diff.patch.includes(`diff --git a/${tricky.path}`));
  assert.doesNotMatch(diff.patch, /\\[0-7]{3}/);
});

test('注册表落在 os.tmpdir(),权限 0600,仓库目录内无任何新增文件', async () => {
  const before = listFiles(repos.staged);
  const other = await startGitglance({ cwd: repos.staged });
  try {
    const dir = join(tmpdir(), 'gitglance');
    const entries = readdirSync(dir).map((name) => join(dir, name));
    const mine = entries.find((path) => {
      try {
        return JSON.parse(readFileSync(path, 'utf8')).port === other.port;
      } catch {
        return false;
      }
    });
    assert.ok(mine, `os.tmpdir()/gitglance 下找不到本次会话的注册表项`);

    const entry = JSON.parse(readFileSync(mine, 'utf8'));
    // dev proxy 就靠这两个字段拿到 token 与端口(spec §5.11)
    assert.equal(entry.token, other.token);
    assert.ok(entry.repoRoot.endsWith('staged'), `repoRoot 记错了:${entry.repoRoot}`);

    // Windows 没有 POSIX 权限位,mode 读出来恒是 0666/0444 之类,断言没有意义
    if (process.platform !== 'win32') {
      assert.equal(statSync(mine).mode & 0o777, 0o600, '注册表文件不是 0600 —— 里面存着 token');
    }

    // **绝不能写进 .git/ 或工作区**:那既污染 git status,也实质违背零写操作承诺
    assert.deepEqual(listFiles(repos.staged), before, '工具在仓库目录里新增了文件');
  } finally {
    await other.stop();
  }
});

test('空仓库(尚无提交)下不崩溃:列表与分支状态正常,diff 走空树基准', async () => {
  const empty = await startGitglance({ cwd: repos.empty });
  try {
    const state = JSON.parse((await authedGet(empty.port, empty.token, '/api/state')).body);
    assert.equal(state.branch.head, 'main');
    // 无上游要展示成「无上游」,不是 0/0
    assert.equal(state.branch.upstream, null);
    assert.equal(state.files.length, 2);

    const diff = JSON.parse(
      (await authedGet(empty.port, empty.token, '/api/diff?path=staged-before-first-commit.txt'))
        .body,
    );
    assert.equal(diff.kind, 'text');
    assert.match(diff.patch, /\+no commits yet/);
  } finally {
    await empty.stop();
  }
});

test('不是 git 仓库时给一句话友好报错,而不是 Node 异常栈', () => {
  const outside = mkdtempSync(join(tmpdir(), 'gitglance-outside-'));
  try {
    const r = spawnSync(process.execPath, [BIN], {
      cwd: outside,
      encoding: 'utf8',
      env: { ...process.env, GITGLANCE_NO_OPEN: '1' },
    });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /not inside a git repository/);
    // 一句话,不是栈
    assert.ok(!r.stderr.includes('    at '), `报错里带了栈:\n${r.stderr}`);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('--help 打印用法并以 0 退出', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--no-open/);
});

test('未知参数给用法提示,而不是抛 parseArgs 的异常', () => {
  const r = spawnSync(process.execPath, [BIN, '--nope'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage:/);
  assert.ok(!r.stderr.includes('    at '));
});

test('后端零 dev 分支:产物里唯一的自有环境变量是拉起浏览器的开关', () => {
  // §5.9 / §10:dev server 的跨源问题一律在代理层解决(见 vite.config.ts),
  // **后端不得为此新增任何环境变量或分支** —— 那等于把正面防御做成一个可被误开的
  // 开关。这条把「不得」变成一个会红的断言:加一个 GITGLANCE_DEV_SKIP_AUTH 就炸。
  const bundle = readFileSync(
    join(import.meta.dirname, '..', '..', 'dist', 'server', 'main.js'),
    'utf8',
  );
  const names = [...new Set([...bundle.matchAll(/\bGITGLANCE_[A-Z0-9_]+/g)].map((m) => m[0]))];
  assert.deepEqual(names, ['GITGLANCE_NO_OPEN']);
});

test('dist/ 产物齐备 —— 静态托管的白名单指向的三个文件都在', () => {
  for (const file of ['index.html', 'app.js', 'app.css']) {
    assert.ok(existsSync(join(import.meta.dirname, '..', '..', 'dist', 'web', file)), file);
  }
});
