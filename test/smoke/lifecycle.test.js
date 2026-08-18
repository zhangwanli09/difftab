// 进程生命周期与单实例(spec §5.8),**跑的是 dist/ 产物**。
//
// 与 test/unit/server/{idle,probe}.test.ts 的分工:那边用假时钟与假对端钉住两个
// 模块各自的判断,这边钉「它们真的被接在了一起,而且在三个平台上都成立」——
// 一条 SSE 连接断掉之后进程会不会自己走、第二次敲同一条命令会不会起第二个进程。
// 两侧全绿而中间没接上是完全可能的:touch 忘了挂在断连上、探活忘了带 token,
// 都不报错。
//
// **宽限期一律用 `GITGLANCE_IDLE_MS` 压到秒级**(§5.8 给它的用途就是这个):
// 真等 45 秒的用例没人会跑第二次。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeFixtures } from '../fixtures/make.mjs';
import {
  authedGet,
  BIN,
  cleanupOnExit,
  once,
  openEvents,
  sleep,
  startGitglance,
  waitForExit,
} from './helpers.js';

/** 空闲宽限期的内部环境变量(spec §5.8)。 */
const IDLE_ENV = 'GITGLANCE_IDLE_MS';

let workdir;
let repos;
cleanupOnExit(() => workdir);

/** 见 helpers.js 的 `once()`:下限档 Node 22.0.0 不等顶层 `before()`。 */
const setup = once(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'gitglance-lifecycle-'));
  repos = makeFixtures(join(workdir, 'repos'), ['staged']);
});

/** `os.tmpdir()` 下记着这个端口的注册表条目(spec §5.8 要求写在这里,不在仓库里)。 */
function registryEntriesFor(port) {
  const dir = join(tmpdir(), 'gitglance');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    try {
      const entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (entry.port === port) found.push(entry);
    } catch {
      // 别的实例写到一半、或格式不同的条目 —— 与本用例无关
    }
  }
  return found;
}

/** 仓库当前的状态快照。用来断言「仓库目录内无任何新增文件」。 */
function statusSnapshot(cwd) {
  const r = spawnSync('git', ['status', '--porcelain=v2', '--branch', '-uall', '-z'], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `快照失败:${r.stderr}`);
  return r.stdout;
}

test('没有任何客户端时,宽限期一到就自己退 —— 不留后台常驻进程', async () => {
  await setup();
  // 宽限期**从启动那一刻就开始计**,不等第一个客户端(§5.8):等第一个客户端才
  // 起计时的话,「浏览器压根没拉起来」(headless、无 xdg-open、--no-open 之后
  // 用户改了主意)这一整类情形留下的就是一个永久常驻的后台进程
  const server = await startGitglance({ cwd: repos.staged, env: { [IDLE_ENV]: '1500' } });

  assert.equal(await waitForExit(server), 0, '空闲退出应当是正常退出,不是异常码');
  // 这句提示同时是「它是自己走的、不是被谁 kill 的」的判据。走 writeSync 是必需的:
  // process.stdout.write 写到管道时在 Windows 上是异步的,紧跟着的 process.exit()
  // 会把整条消息丢掉,症状是 stdout 里什么都没有(spec §5.8 / §5.1)
  assert.match(server.stdout, /no tabs left/);
});

test('stdout 的读端先走了(`| head -1`),空闲退出仍是干净的 0', async () => {
  await setup();
  /**
   * `| head -1` 是这个形态最日常的来源:用户只想要那行 URL。读端一走,此后每一次写
   * 都以 EPIPE 失败,而这条路上有**两处**写:
   *
   * 1. 紧跟 URL 的那句「read-only view…」(普通的 `process.stdout.write`)。
   *    **在 Windows 上管道写是异步的**,失败以 `'error'` 事件到达,零监听器的流收到
   *    它就是整个进程带裸栈以 1 退出 —— 已在 CI 的 windows × Node 24 档实测到,
   *    而 macOS / Linux 上同一条路一声不响(spec §10);
   * 2. 宽限期走满时那句告别(`writeSync`,**同步抛** EPIPE)。抛在定时器回调里时
   *    退出闩已经合上,`server.close()` 不再执行,同样以 1 退出。
   *
   * 所以断言有两条:退出码是干净的 0,**而且是熬到宽限期才退的**。只看退出码的话,
   * 第 1 处那种「243ms 就崩了」会在某些平台上恰好也给出 0(比如崩在别处),
   * 而这条路承诺的是「读端走了不影响服务,浏览器照常用得上」。
   */
  const idleMs = 1500;
  const server = await startGitglance({ cwd: repos.staged, env: { [IDLE_ENV]: String(idleMs) } });
  const started = Date.now();
  server.child.stdout.destroy(); // 读端关掉,等同于 head 已经退了

  assert.equal(await waitForExit(server), 0, '写不出提示就该当没这回事,而不是崩掉');
  assert.ok(
    Date.now() - started > idleMs / 2,
    '进程在宽限期之前就没了 —— 它是被某一次写打死的,不是自己走的',
  );
  assert.doesNotMatch(server.stderr, /EPIPE| {4}at /, `stderr 里出现了 Node 栈:\n${server.stderr}`);
});

test('有一条 SSE 连着就不退,断开之后才开始数宽限期', async () => {
  await setup();
  const server = await startGitglance({ cwd: repos.staged, env: { [IDLE_ENV]: '1500' } });
  const events = openEvents(server.port, server.token);
  await events.connected;

  // 跨过不止一个宽限期。退早了的症状是「用户开着页面,进程自己没了」
  await sleep(3000);
  assert.equal(server.child.exitCode, null, '有客户端连着却退出了');
  const state = await authedGet(server.port, server.token, '/api/state');
  assert.equal(state.status, 200);

  events.close();
  assert.equal(await waitForExit(server), 0);
});

test('多标签:关掉其中一个不退出,全部关掉后才在宽限期内退出', async () => {
  await setup();
  const server = await startGitglance({ cwd: repos.staged, env: { [IDLE_ENV]: '1500' } });
  const first = openEvents(server.port, server.token);
  const second = openEvents(server.port, server.token);
  await first.connected;
  await second.connected;

  first.close();
  await sleep(3000);
  assert.equal(server.child.exitCode, null, '还有一个标签开着,不该退');

  second.close();
  assert.equal(await waitForExit(server), 0);
});

test('注册表条目写在 os.tmpdir(),退出时被清掉', async () => {
  await setup();
  const before = statusSnapshot(repos.staged);
  const server = await startGitglance({ cwd: repos.staged, env: { [IDLE_ENV]: '1500' } });

  const entries = registryEntriesFor(server.port);
  assert.equal(entries.length, 1, `os.tmpdir()/gitglance 下没找到本次实例的条目`);
  assert.equal(entries[0].token, server.token);
  assert.equal(entries[0].pid, server.child.pid);
  // 仓库目录内无任何新增文件(§6)—— 注册表写进 .git/ 或工作区既污染 git status,
  // 也实质违背零写操作承诺
  assert.equal(statusSnapshot(repos.staged), before);

  assert.equal(await waitForExit(server), 0);
  assert.deepEqual(registryEntriesFor(server.port), [], '退出后条目还在');
});

test('同一仓库再敲一次命令:复用已有实例,不起第二个进程', async () => {
  await setup();
  const server = await startGitglance({ cwd: repos.staged, env: { [IDLE_ENV]: '30000' } });
  try {
    const before = statusSnapshot(repos.staged);
    const second = spawnSync(process.execPath, [BIN], {
      cwd: repos.staged,
      env: { ...process.env, GITGLANCE_NO_OPEN: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(second.status, 0, `第二次启动失败:${second.stderr}`);
    // 第一行是且只是 URL,而且是**同一个** URL —— 拼错 token 的话它是个 403 链接,
    // 而这条路平时不走,谁也不会先注意到
    assert.equal(second.stdout.split('\n')[0], server.url);
    assert.match(second.stdout, /reusing the instance/);
    // 复用那一侧什么都不写:注册表条目仍是第一个进程的
    const entries = registryEntriesFor(server.port);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].pid, server.child.pid);
    assert.equal(statusSnapshot(repos.staged), before);

    // 第一个进程照常活着、照常服务
    assert.equal(server.child.exitCode, null);
    const state = await authedGet(server.port, server.token, '/api/state');
    assert.equal(state.status, 200);
  } finally {
    await server.stop();
  }
});

test('陈旧条目(实例被 SIGKILL,来不及清理)不会挡住下一次启动', async () => {
  await setup();
  const dead = await startGitglance({ cwd: repos.staged, env: { [IDLE_ENV]: '30000' } });
  // SIGKILL 没有清理机会,条目原样留在 os.tmpdir() 里指向一个已经死掉的端口
  dead.child.kill('SIGKILL');
  await waitForExit(dead);
  assert.equal(registryEntriesFor(dead.port).length, 1, '前提没成立:条目已经被清掉了');

  const fresh = await startGitglance({ cwd: repos.staged, env: { [IDLE_ENV]: '30000' } });
  try {
    // **判据是 token 不同,不是端口不同**:内核完全可能把刚释放的端口再分配一次,
    // 而 token 每次启动都重新随机(§5.9)
    assert.notEqual(fresh.token, dead.token, '复用了一个已经死掉的实例');
    assert.doesNotMatch(fresh.stdout, /reusing/);
    const state = await authedGet(fresh.port, fresh.token, '/api/state');
    assert.equal(state.status, 200);
  } finally {
    await fresh.stop();
  }
});

test('探活端点答的是本仓库的身份,且同样过三道校验', async () => {
  await setup();
  const server = await startGitglance({ cwd: repos.staged, env: { [IDLE_ENV]: '30000' } });
  try {
    const ok = await authedGet(server.port, server.token, '/api/instance');
    assert.equal(ok.status, 200);
    const info = JSON.parse(ok.body);
    assert.equal(info.pid, server.child.pid);
    // 路径可能经符号链接归一(macOS 的 /var → /private/var),只断言尾段
    assert.match(info.repoRoot.replace(/\\/g, '/'), /\/staged$/);

    // 没有 token 一律 403 —— 「所有端点统一校验,无例外」(§5.9 第 4 条)。
    // 这个端点是探活唯一的消费者,给它开个不校验的口子是最容易顺手做的事,
    // 而那正好把 §5.9 说的「任何一个不校验 token 的端点」摆到了 rebinding 面前
    const anonymous = await authedGet(server.port, 'wrong-token', '/api/instance');
    assert.equal(anonymous.status, 403);
  } finally {
    await server.stop();
  }
});

test(`${IDLE_ENV} 写错时是一句话报错,不是 Node 异常栈`, async () => {
  await setup();
  await assert.rejects(
    () => startGitglance({ cwd: repos.staged, env: { [IDLE_ENV]: 'soon' }, timeoutMs: 10_000 }),
    (cause) => {
      // 悄悄退回默认的 45s 的话,这里会**启动成功** —— 而写错的那次照样跑出一个
      // 看着合理的行为,于是「我验过空闲退出了」建立在一次没生效的指定上
      assert.match(cause.message, /must be a positive number of milliseconds/);
      assert.doesNotMatch(cause.message, /at \w+ \(/, 'stderr 里出现了 Node 异常栈');
      return true;
    },
  );
});
