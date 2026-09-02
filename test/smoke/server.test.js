// CLI 启动 + 三道校验 + 注册表写入，**跑的是 dist/ 产物**（CI 分层）。
//
// 与 test/unit/server/security.test.ts 的分工：那边钉纯函数的行为，这边钉「它们真的
// 被接在了唯一入口上」。三道校验各自写对、却漏接一处端点，单测全绿而这里会红。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { makeFixtures } from '../fixtures/make.mjs';
import {
  authedGet,
  BIN,
  cleanupOnExit,
  expectStartupRefusal,
  httpGet,
  once,
  REPO_ROOT,
  startDifftab,
} from './helpers.js';

/** 本文件用得到的 fixture。生成全部 16 个要 1.5s 上下，其中一半这里根本不打开。 */
const NEEDED = ['unicodePaths', 'staged', 'empty', 'diffEdges'];

/**
 * 只读工具不接受的方法。**两个用例共用一份**：各写一份的话，哪天添一个
 * （`OPTIONS` 是最现实的候选）只加到其中一处，另一处就在更窄的方法集上悄悄变绿。
 */
const NON_IDEMPOTENT = ['POST', 'PUT', 'DELETE', 'PATCH'];

/**
 * 前端产物里被静态托管的那几个文件（与 `server/http/assets.ts` 的白名单一一对应）。同样是**两个
 * 用例共用一份**：添一个资源时只改其中一处，漏掉的那一处不会红——而下面那条 CJK 门禁漏掉一个
 * 文件，恰恰意味着那个文件里的中文没人看着。
 */
const WEB_ASSETS = ['index.html', 'app.js', 'app.css'];

/** rebinding 的攻击页面发出的请求长这样：Host 是攻击者自己的域名。 */
const ATTACKER_HOST = { Host: 'evil.example' };

let workdir;
let repos;
let server;
cleanupOnExit(() => workdir);

/** 递归列出仓库里的所有文件（相对路径），用来证明工具没往里写东西。 */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * 共享的 fixture 与被测进程。**不用 `before()`**——下限档 Node 22.0.0 的 runner
 * 不等它就开跑用例（理由与复现见 helpers.js 的 `once()`）。用到共享状态的用例
 * 一律以 `await setup()` 开头；自己起进程的用例不需要。
 */
const setup = once(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'difftab-server-'));
  repos = makeFixtures(join(workdir, 'repos'), NEEDED);
  server = await startDifftab({ cwd: repos.unicodePaths });
});

test('stdout 的第一行是且只是 URL——冷启动门禁以它为 ready 判据', async () => {
  await setup();
  const first = server.stdout.split('\n')[0];
  assert.match(first, /^http:\/\/127\.0\.0\.1:\d+\/\?token=\d+\./);
  assert.equal(first, server.url);
  // 只绑 127.0.0.1，不监听任何外部可达地址
  assert.ok(!first.includes('0.0.0.0'));
});

test('第 1 道：Host 不是 127.0.0.1/localhost 加本端口一律 403', async () => {
  await setup();
  // 带着**有效** cookie 发，这样 403 只可能出自 Host 那一道
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

test('三道校验排在其余一切判定之前——没过的请求一律与那句 forbidden 逐字节一致', async () => {
  await setup();
  // **钉的是那条类级规则，不是「方法判定」这一个实例**——
  // 按方法枚举的话，下一个被顺手提到函数开头的廉价 guard（体积上限、限流）照样漏，而套件全绿
  const baseline = await authedGet(server.port, server.token, '/api/state', ATTACKER_HOST);
  assert.equal(baseline.status, 403, '基准：攻击者 Host 下的普通 GET 应当是 403');

  // 三道校验之前就可能被答复的请求形态，逐个比对
  const shapes = [
    ...NON_IDEMPOTENT.map((method) => [`${method} /api/state`, '/api/state', method]),
    ['未知路径', '/nope', 'GET'],
    ['缺参数的 /api/diff', '/api/diff', 'GET'],
    ['SSE', '/api/events', 'GET'],
    ['/api/instance', '/api/instance', 'GET'],
  ];
  for (const [name, path, method] of shapes) {
    const res = await authedGet(server.port, server.token, path, ATTACKER_HOST, method);
    assert.equal(res.status, baseline.status, `${name}：状态码与基准不同(${res.status})`);
    assert.equal(res.body, baseline.body, `${name}：响应体把本服务认了出来——${res.body}`);
  }
  // 连 token 都没有的那一档同样不许有区别
  const noToken = await httpGet(server.port, '/api/state', ATTACKER_HOST, 'POST');
  assert.equal(noToken.status, baseline.status);
  assert.equal(noToken.body, baseline.body);
});

test('第 2 道：Origin 非空且不等于自身则 403，且响应不带任何 CORS 头', async () => {
  await setup();
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

test('第 3 道：URL 上的 token 换成 HttpOnly cookie 并 302 掉 query', async () => {
  await setup();
  const res = await httpGet(server.port, `/?token=${encodeURIComponent(server.token)}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
  const setCookie = String(res.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  // token 不该留在跳转目标里——那正是 302 掉 query 要解决的事
  assert.ok(!String(res.headers.location).includes('token'));
});

test('第 3 道：没有 token 一律 403，静态资源与 SSE 端点无例外', async () => {
  await setup();
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
  // 端口对、secret 不对——形状合法的 token 也必须被拒
  const wrong = await authedGet(server.port, `${server.port}.wrong`, '/api/state');
  assert.equal(wrong.status, 403);
});

test('安全响应头出现在每一个响应上，包括被拒的那些', async () => {
  await setup();
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

test('静态资源按白名单映射，拼路径读文件的写法一个都不留', async () => {
  await setup();
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
    assert.ok(!res.body.includes('"name": "difftab"'), `${path} 把 package.json 读出来了`);
  }
});

test('只有 GET——出现非幂等方法即 405', async () => {
  await setup();
  // 这条是上面那条「三道校验排在前面」的反向一半：把方法判定整条删掉，上面那条照样绿
  for (const method of NON_IDEMPOTENT) {
    const res = await authedGet(server.port, server.token, '/api/state', {}, method);
    assert.equal(res.status, 405, `${method} 返回了 ${res.status}`);
  }
});

test('/api/state 的 repoName 是工作区根目录名——标签页标题的项目标识', async () => {
  await setup();
  // **这是「后端真的从真实仓库推出了它」唯一的端到端证据**：单测那侧的 `RepoState` fixture 是手写
  // 的，后端把这个字段填成常量、填成整条路径甚至压根不填，单测一条都不会红，而页面上只是标题不对
  const state = JSON.parse((await authedGet(server.port, server.token, '/api/state')).body);
  assert.equal(state.repoName, basename(repos.unicodePaths));
  // 给的是目录名不是路径：带绝对路径的响应只有 /api/instance 一个，且不是给前端的。**两种分隔符
  // 都查**：今天 `rev-parse --show-toplevel` 一律回正斜杠，所以只查 `/` 在本机是够的——但这条断
  // 言防的正是「有人把 basename 换成手写切分」，而那种写法挑错分隔符时恰恰是在 Windows 上回一条
  // `C:\\…\\repo`
  assert.doesNotMatch(state.repoName, /[/\\]/, `repoName 里有路径分隔符：${state.repoName}`);
});

test('路径含非 ASCII / 空格 / 引号的文件，在产物上也不出现转义残留', async () => {
  await setup();
  const state = JSON.parse((await authedGet(server.port, server.token, '/api/state')).body);
  const tricky = state.files.find((f) => f.path.includes('需求'));
  assert.ok(tricky, `列表里没有非 ASCII 路径：${JSON.stringify(state.files.map((f) => f.path))}`);
  for (const file of state.files) {
    assert.doesNotMatch(file.path, /\\[0-7]{3}/, `路径里有 C 风格转义残留：${file.path}`);
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

test('query 里的路径是字面量：`path=*` 取不到东西，更不是一份整仓 diff', async () => {
  await setup();
  // 路径来自 URL query，是外部输入；而 `git diff -- <路径>` 默认按 wildmatch 解释。
  // 少了 GIT_LITERAL_PATHSPECS 与「按路径挑记录」这两道，`*` 会变成一份整仓补丁——
  // 既撞上「禁止一次性获取全仓 diff」，也让浏览器主线程冻上数秒
  for (const path of ['*', 'docs/*', '?ocs/**']) {
    const res = await authedGet(
      server.port,
      server.token,
      `/api/diff?path=${encodeURIComponent(path)}`,
    );
    assert.notEqual(res.status, 200, `path=${path} 竟然取到了 diff：${res.body.slice(0, 200)}`);
    assert.ok(!res.body.includes('diff --git'), `path=${path} 回了补丁正文`);
  }
});

test('注册表落在 os.tmpdir()，权限 0600，仓库目录内无任何新增文件', async () => {
  await setup();
  const before = listFiles(repos.staged);
  const other = await startDifftab({ cwd: repos.staged });
  try {
    const dir = join(tmpdir(), 'difftab');
    const entries = readdirSync(dir).map((name) => join(dir, name));
    const mine = entries.find((path) => {
      try {
        return JSON.parse(readFileSync(path, 'utf8')).port === other.port;
      } catch {
        return false;
      }
    });
    assert.ok(mine, `os.tmpdir()/difftab 下找不到本次会话的注册表项`);

    const entry = JSON.parse(readFileSync(mine, 'utf8'));
    // dev proxy 就靠这两个字段拿到 token 与端口
    assert.equal(entry.token, other.token);
    assert.ok(entry.repoRoot.endsWith('staged'), `repoRoot 记错了：${entry.repoRoot}`);

    // Windows 没有 POSIX 权限位，mode 读出来恒是 0666/0444 之类，断言没有意义
    if (process.platform !== 'win32') {
      assert.equal(statSync(mine).mode & 0o777, 0o600, '注册表文件不是 0600——里面存着 token');
    }

    // **绝不能写进 .git/ 或工作区**：那既污染 git status，也实质违背零写操作承诺
    assert.deepEqual(listFiles(repos.staged), before, '工具在仓库目录里新增了文件');
  } finally {
    await other.stop();
  }
});

test('空仓库（尚无提交）下不崩溃：列表与分支状态正常，diff 走空树基准', async () => {
  await setup();
  const empty = await startDifftab({ cwd: repos.empty });
  try {
    const state = JSON.parse((await authedGet(empty.port, empty.token, '/api/state')).body);
    assert.equal(state.branch.head, 'main');
    // 无上游要展示成「无上游」，不是 0/0
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

test('diff 边界在产物上也各回各的 kind，且超大文件不会把正文整个吐回来', async () => {
  await setup();
  const edges = await startDifftab({ cwd: repos.diffEdges });
  try {
    const get = async (path) => {
      const res = await authedGet(
        edges.port,
        edges.token,
        `/api/diff?path=${encodeURIComponent(path)}`,
      );
      assert.equal(res.status, 200, `${path} 返回了 ${res.status}:${res.body}`);
      return { payload: JSON.parse(res.body), bytes: Buffer.byteLength(res.body) };
    };

    // 已跟踪（numstat 的 `-\t-`）与未跟踪（NUL 探测）两条判定路径各走一遍
    assert.equal((await get('assets/icon.bin')).payload.kind, 'binary');
    assert.equal((await get('untracked.bin')).payload.kind, 'binary');

    // 「超大文件提示不支持预览而非卡死」在这一层的判据是**正文有多大**：判定漏掉时接口照常回
    // 200、kind 也还是 'text'，只是正文里躺着 6MB 补丁——断言 kind 的写法看不出区别
    for (const path of ['huge.txt', 'untracked-huge.txt']) {
      const { payload, bytes } = await get(path);
      assert.equal(payload.kind, 'too-large', `${path} 没被拦住`);
      assert.equal(payload.reason, 'size');
      assert.ok(bytes < 1024, `${path} 的响应有 ${bytes} 字节——补丁正文被一并回来了`);
    }

    // 同一道闸的另一面：6MB 的文件只改一行，补丁只有几 KB，必须照常给
    const bulky = await get('bulky.txt');
    assert.equal(bulky.payload.kind, 'text', '大文件的小改动被误拦了');
    assert.match(bulky.payload.patch, /\+3000: after/);

    // 行数那一路：体积只有几百 KB，拦住它的是另一道闸
    const wide = await get('wide.txt');
    assert.equal(wide.payload.kind, 'too-large');
    assert.equal(wide.payload.reason, 'lines');
    assert.ok(wide.bytes < 1024, `wide.txt 的响应有 ${wide.bytes} 字节`);

    // 对照面：同一个仓库里正常的新增文件照常给补丁，否则上面几条可能只是「全都拦住了」
    const added = await get('added-staged.txt');
    assert.equal(added.payload.kind, 'text');
    assert.match(added.payload.patch, /\+brand new line one/);
  } finally {
    await edges.stop();
  }
});

test('不是 git 仓库时给一句话友好报错，而不是 Node 异常栈', () => {
  const outside = mkdtempSync(join(tmpdir(), 'difftab-outside-'));
  try {
    // 「退出码 / 空 stdout / 不带栈」三条归 helpers，这里只断言这种拒绝形态自己那句话
    assert.match(expectStartupRefusal(assert, outside), /not inside a git repository/);
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

test('未知参数给用法提示，而不是抛 parseArgs 的异常', () => {
  const r = spawnSync(process.execPath, [BIN, '--nope'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage:/);
  assert.ok(!r.stderr.includes('    at '));
});

test('后端零 dev 分支：产物里的自有环境变量只有这三个', () => {
  // dev server 的跨源问题一律在代理层解决（见 vite.config.ts），**后端不得为此新增任何环境变量或
  // 分支**——那等于把正面防御做成一个可被误开的开关。这条把「不得」变成一个会红的断言：加一个
  // DIFFTAB_DEV_SKIP_AUTH 就炸。名单是**逐个具名**的，不是「以 DIFFTAB_ 开头就放行」：三个都是
  // 点名要求的（拉起浏览器的开关、档位强制指定、空闲宽限期），且三个都不碰三道校验。
  const bundle = readFileSync(
    join(import.meta.dirname, '..', '..', 'dist', 'server', 'main.js'),
    'utf8',
  );
  const names = [...new Set([...bundle.matchAll(/\bDIFFTAB_[A-Z0-9_]+/g)].map((m) => m[0]))];
  assert.deepEqual(names.sort(), ['DIFFTAB_IDLE_MS', 'DIFFTAB_NO_OPEN', 'DIFFTAB_WATCH_TIER']);
});

test('dist/ 产物齐备——静态托管的白名单指向的三个文件都在', () => {
  for (const file of WEB_ASSETS) {
    assert.ok(existsSync(join(REPO_ROOT, 'dist', 'web', file)), file);
  }
});

test('前端产物里一个中文字符都没有——界面文案一律英文', () => {
  // 判据落在**产物**上而不是逐个文件翻源码：漏网的那两条（`state/store.ts` 里的错误文案）正是因为
  // 它们不长在 JSX 上，按组件翻就想不起来。产物里本来就不该有中文——注释在构建期已被去掉。
  // **后端那份不能这么查**：`dist/server/main.js` 不压缩不混淆，注释原样留着正是为了让用户自己核
  // 查跑了哪些 git 命令；那一侧的用户可见文案由 test/unit/server/ 压。
  //
  // 字符类要**连标点一起罩住**：只查汉字时，一条把词翻成英文、却把括号留成全角的文案照样过闸。
  // 于是四段一起：CJK 标点、假名、汉字与扩展 A、全角/半角形式。
  const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/gu;
  for (const file of WEB_ASSETS) {
    const text = readFileSync(join(REPO_ROOT, 'dist', 'web', file), 'utf8');
    // 报出上下文而不是光报字符——只说「第 N 个字符是『未』」没法定位到是哪条文案
    const hits = [...text.matchAll(CJK)].map((m) =>
      text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' '),
    );
    assert.equal(hits.length, 0, `${file} 里有中文文案：\n  ${hits.slice(0, 5).join('\n  ')}`);
  }
});
