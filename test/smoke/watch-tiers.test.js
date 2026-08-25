// 三档监听在**各平台上的实际行为**,跑的是 dist/ 产物(四条档位验收项)。
//
// 与别处的分工:
//   - `test/unit/server/watch-tiers.test.ts` 钉判档函数(给什么版本回什么档),
//     `test/unit/server/ignore.test.ts` 钉逐段匹配本身 —— 两者都不碰真实的 `fs.watch`;
//   - `test/smoke/events.test.js` 钉「三档能被强制指定出来」与 C 档的轮询通路;
//   - **这里钉的是「在这台机器自动判定出的那一档上,过滤真的拦住了 `node_modules`」**。
//
// 为什么不强制指定档位:第 6 节那几条要的是**用户实际会拿到的那一档**,而它由平台 ×
// Node 版本决定 —— 那正是 CI 矩阵的两个维度。三平台 × 三个 Node 跑下来,A 档落在
// Node 24 / 26 的三个平台上、B 档落在 macOS / Windows × Node 22.0.x 上,一份用例覆盖
// 三条验收项。强制指定反而验不到:在 Node 22 上强制 A 档拿到的是一个**没有 `ignore`**
// 的递归 watch(Node 对未知选项静默忽略,见 watch/tier.ts 的 `forcedTierWarning`)。

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeFixtures } from '../fixtures/make.mjs';
import {
  authedGet,
  cleanupOnExit,
  once,
  openEvents,
  sleep,
  startDifftab,
  waitUntil,
} from './helpers.js';

/** `node_modules` 里那条深路径。**必须是嵌套的**,只写顶层目录本身证伪不了 basename 写法。 */
const DEEP = ['node_modules', 'some-dep', 'lib', 'nested'];

/**
 * 批量写入之后、断言「一个事件都没有」之前要等多久。
 *
 * 合并窗口是 150ms(watcher.ts 的 `DEBOUNCE_MS`),这里给到十倍:等不够的话
 * 「0 个事件」说明的是「还没到」而不是「被过滤掉了」,而那种绿是假的。
 */
const QUIET_MS = 1_500;

let workdir;
let repos;
cleanupOnExit(() => workdir);

/** 见 helpers.js 的 `once()`:下限档 Node 22.0.0 不等顶层 `before()`。 */
const setup = once(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'difftab-tiers-'));
  repos = makeFixtures(join(workdir, 'repos'), ['staged']);
  mkdirSync(join(repos.staged, ...DEEP), { recursive: true });
});

/**
 * 这条 CI 泳道**应该**判到哪一档。
 *
 * **不加这条断言的话,判档一旦漂走,覆盖会静默地关掉而不是变红**:两个用例都按拿到
 * 的档位分支,于是 Linux × Node 24 若某天回了 C,test 1 就从 C 那个出口早退、
 * 「A 档过滤生效」这条验收项在任何泳道上都不再被执行,而套件全绿、只在 `t.diagnostic`
 * 里留一行谁也不会看的字。
 *
 * 这里是刻意把三档表**再写一遍**(`watch/tier.ts` 里那份是唯一实现,
 * `test/unit/server/watch-tiers.test.ts` 钉的是它)——本文件跑的是 `dist/` 产物,
 * 断言的是「发布出去的那份跟 spec 说的一致」,复用实现就把这层意思抵消了。
 * 只按 major.minor 比:CI 上跑的都是正式版,预发布标签那条边界归单测。
 */
function expectedTier() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const hasIgnore = major > 24 || (major === 24 && minor >= 14);
  if (hasIgnore) return 'A';
  return process.platform === 'linux' ? 'C' : 'B';
}

/**
 * 进程 `pid` 当前持有的 inotify watch 数(Linux)。
 *
 * 判据是 `/proc/<pid>/fdinfo/<fd>` 里的 `inotify wd:` 行:一行一个 watch。**不能只数
 * inotify **fd** 的个数** —— Node 在 Linux 上的递归实现是用户态遍历、每个目录一个
 * 独立的 `fs.watch`,fd 数与 watch 数恰好同阶时看不出区别,而 `.git` 侧那几条非递归的
 * 也各占一个 fd,两种形态混在一起就再也分不开了。
 */
function countInotifyWatches(pid) {
  const dir = `/proc/${pid}/fdinfo`;
  let total = 0;
  for (const fd of readdirSync(dir)) {
    let content;
    try {
      content = readFileSync(join(dir, fd), 'utf8');
    } catch {
      // fd 可能在 readdir 与 read 之间就关掉了,跳过即可
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.startsWith('inotify wd:')) total += 1;
    }
  }
  return total;
}

test('自动判定的那一档:node_modules 深层批量写入不刷新,同一轮里仓库内的新文件必须刷新', async (t) => {
  await setup();
  const server = await startDifftab({ cwd: repos.staged });
  try {
    /**
     * **先连 SSE 再取 `/api/state`**:监听是懒起的(第一个订阅者到达时才建),连之前
     * 那一次拿到的 `mode` 只是 `initialMode(tier)` 给的既定值,不是 watcher 的真实
     * 取值 —— 拿它断言等于断言了一个常量。`sleep` 是给 watcher 一点起身的时间,
     * 抢在它前面写等于对着没人听的通道写。
     */
    const sse = openEvents(server.port, server.token);
    await sse.connected;
    await sleep(300);

    const state = JSON.parse((await authedGet(server.port, server.token, '/api/state')).body);
    const { tier, mode } = state.watch;
    t.diagnostic(`平台 ${process.platform} · Node ${process.versions.node} → 档位 ${tier}`);
    assert.equal(tier, expectedTier(), '判到的档位与三档表对不上');

    /**
     * **判据是「这批写入之后多出了几个」,不是「一共有几个」**(2026-08-18 实测,CI 的
     * windows 三档):起监听那一下,Windows 会先冒出一个事件 —— `ReadDirectoryChangesW`
     * 建流时会把建流前一刻的写入补报进来,而 `filename` 为 null 的事件是**放行**
     * 的(漏刷一次比多刷一次糟)。它与 `node_modules` 那批写入毫无关系,却把绝对计数
     * 顶成 1,读起来像"过滤没生效"。**这不是把标准放宽**:下面量的仍然是那 50 次写入
     * 引出了几次刷新,只是把量程的零点挪到了它们开始之前。
     *
     * 「起监听本身之外还有谁在推事件」由下一条用例单独盯,那才是它该待的地方。
     */
    await sleep(QUIET_MS);
    const baseline = sse.count;
    if (baseline > 0) t.diagnostic(`起监听阶段先来了 ${baseline} 个事件,已作为零点扣除`);

    /**
     * **C 档跳过,这是已知边界而不是漏测**:C 档的工作区通路是轮询,比的是
     * `git status` 的输出本身,那条路上根本不调 `isIgnored` —— 没有 `.gitignore` 的
     * 仓库里,`node_modules` 下的新文件照样进列表、照样触发一次刷新。它的验收项是
     * 另一条(inotify 用量),见下一个用例。
     */
    if (tier === 'C') {
      assert.equal(mode, 'polling', 'C 档的工作区通路一开始就该是轮询');
      t.diagnostic('C 档:过滤这条不适用(轮询不看 isIgnored),由 inotify 用量那条覆盖');
      sse.close();
      return;
    }
    assert.equal(mode, 'native', `${tier} 档应当在原生监听,实际是 ${mode}`);

    const stamp = Date.now();
    const deep = join(repos.staged, ...DEEP);
    const write = (name) => writeFileSync(join(deep, name), `module.exports = '${name}';\n`);

    /**
     * **两种写法各量一次,两个数一起报出来再一起断言**。
     *
     * 快写一批在 Windows 上有第二种解释:`ReadDirectoryChangesW` 的通知缓冲区被一次
     * 突发写满时,内核报的是"丢了一批",Node 由此 emit 一个**没有 filename** 的事件,
     * 而那种事件是**刻意放行**的(漏刷一次比多刷一次糟)。它与"逐段过滤没生效"
     * 会给出一模一样的一个事件 —— 合并窗口把 50 次写入本来也压成 1 个。
     *
     * 慢写把两者分开:每次写入之间隔开一个合并窗口,过滤失效时应当逐个漏出来(数个
     * 事件),缓冲区溢出则一个都没有。先各记一个数、都打进 diagnostic,再一起断言 ——
     * 断言分两条写、遇到第一条就停的话,红的那次只能看到一半数据,而这两个数**只有
     * 摆在一起才说明得了病因**。
     */
    const SLOW_WRITES = 6;
    const slowStart = sse.count;
    for (let i = 0; i < SLOW_WRITES; i += 1) {
      write(`slow-${stamp}-${i}.js`);
      await sleep(250); // > DEBOUNCE_MS(150),每次写入各占一个合并窗口
    }
    await sleep(QUIET_MS);
    const slowDelta = sse.count - slowStart;

    const burstStart = sse.count;
    for (let i = 0; i < 50; i += 1) write(`burst-${stamp}-${i}.js`);
    await sleep(QUIET_MS);
    const burstDelta = sse.count - burstStart;

    t.diagnostic(
      `往 ${DEEP.join('/')} 写入引出的刷新:慢写 ${SLOW_WRITES} 次 → ${slowDelta} 个;快写 50 次 → ${burstDelta} 个`,
    );
    /**
     * **慢写那一路是判据,三端一律 0**;快写那一路在 Windows 上放宽到最多 1 次 ——
     * `ReadDirectoryChangesW` 的通知缓冲区被突发写满时报的是"丢了一批"而不是路径,
     * Node 由此 emit 一个没有 `filename` 的事件,而那种事件是**刻意放行**的
     * (漏刷一次比多刷一次糟)。这不是把标准放宽:合并窗口本来就把 50 次写入压成
     * 1 个,单看快写那一路时"过滤失效"与"缓冲区溢出"给出的数一模一样,**能分辨的
     * 只有慢写那一路** —— 过滤失效时它会逐个漏出来。
     */
    const burstCeiling = process.platform === 'win32' ? 1 : 0;
    assert.deepEqual(
      { 慢写: slowDelta, 快写: burstDelta > burstCeiling },
      { 慢写: 0, 快写: false },
      `${tier} 档:node_modules 深层写入引出了刷新(快写上限 ${burstCeiling})`,
    );

    /**
     * **对照组不可省**:没有它,「0 次」只说明什么都没在听 —— 监听整个没起来、SSE 断了、
     * 或者过滤把整棵树都吞了,三种都会给出同样漂亮的 0。
     */
    writeFileSync(join(repos.staged, `probe-${stamp}.md`), 'a real change\n');
    await waitUntil(() => sse.count > baseline, 10_000, `${tier} 档对仓库内新文件的刷新`);
    sse.close();
  } finally {
    await server.stop();
  }
});

test('读 /api/state 不会引出刷新事件 —— 自激循环的判据', async (t) => {
  await setup();
  /**
   * 每读一次状态就跑一次 `git status`,而**只要它往 `.git` 里写一个字节,`.git` 侧的
   * watch 就会推一个 `change`,前端收到就再读一次状态** —— 一个不报错、只是 CPU 常年
   * 挂着 1% 的自激循环,而 status 的输出从头到尾都是对的。挡住它的是封装层那句
   * `GIT_OPTIONAL_LOCKS=0`(红线:不设它 git 会把 stat 缓存写回 `.git/index`)。
   *
   * 那条红线原本只有第二层 B 半的逐字节快照盯着,而**那是在单进程里比对文件,
   * 不经过监听**。这里从另一头断:连着 SSE 的时候连读几次状态,一个事件都不该冒出来。
   * 三个平台各跑一次 —— git 在哪个平台上多写一次都算数。
   */
  const server = await startDifftab({ cwd: repos.staged });
  try {
    const sse = openEvents(server.port, server.token);
    await sse.connected;
    // 起监听阶段自己会带出事件(见上一条用例),等它过去再取零点
    await sleep(QUIET_MS);
    const baseline = sse.count;

    for (let i = 0; i < 3; i += 1) {
      await authedGet(server.port, server.token, '/api/state');
      await sleep(200);
    }
    await sleep(QUIET_MS);
    t.diagnostic(`读 3 次 /api/state:事件数 ${baseline} → ${sse.count}`);
    assert.equal(
      sse.count,
      baseline,
      `读状态引出了 ${sse.count - baseline} 次刷新 —— git status 多半在往 .git 里写东西`,
    );
    sse.close();
  } finally {
    await server.stop();
  }
});

test('Linux · inotify 用量:A 档不随 node_modules 的目录数增长,C 档只有 .git 侧那几条', async (t) => {
  await setup();
  if (process.platform !== 'linux') {
    // inotify 是 Linux 专有;macOS 走 FSEvents、Windows 走 ReadDirectoryChangesW,
    // 两者都是单句柄监听整棵树,本就没有配额这回事
    t.skip('inotify 是 Linux 专有');
    return;
  }

  /**
   * 单独造一个仓库,不复用上一个用例那个:那边的 `node_modules` 只有一条深路径,
   * 而这里要的正是**目录数**本身 —— 过滤失效时涨的是它。
   */
  const big = makeFixtures(join(workdir, 'big'), ['staged']).staged;
  const PACKAGES = 200;
  for (let i = 0; i < PACKAGES; i += 1) {
    // **只建目录、不放文件**:递归 watch 照样要逐个注册(判据是目录数),而 `git status`
    // 看不见空目录 —— 于是配额压力上去了,而这个 fixture **没有 `.gitignore`**,
    // 放了文件就会有 200 条未跟踪路径进每一次 status 与 `/api/state` 的正文
    mkdirSync(join(big, 'node_modules', `pkg-${i}`, 'lib'), { recursive: true });
  }
  const dirCount = PACKAGES * 2; // pkg-<i> 与它下面的 lib/

  const server = await startDifftab({ cwd: big });
  try {
    // 监听懒起:不连 SSE 的话工作区那条递归 watch 根本还没建,数出来的必然是低位
    const sse = openEvents(server.port, server.token);
    await sse.connected;
    await sleep(500);

    /**
     * **`/api/state` 必须在 SSE 连上之后才取**:监听是懒起的,连之前那一次拿到的
     * `mode` 只是 `initialMode(tier)` 给的既定值,不是 watcher 的真实取值 —— 拿它
     * 断言等于断言了一个常量。
     */
    const state = JSON.parse((await authedGet(server.port, server.token, '/api/state')).body);
    const { tier, mode } = state.watch;
    const watches = countInotifyWatches(server.child.pid);
    t.diagnostic(
      `档位 ${tier} · mode=${mode} · ${dirCount} 个 node_modules 目录 → inotify watch ${watches} 个`,
    );
    sse.close();

    /**
     * **「确实数到了东西」的正面断言**:计数手段自己坏掉(fdinfo 读不到、格式变了)
     * 时,下面那条上限断言会对着一个恒为 0 的数字通过 —— 而那正是它最该报警的时候。
     */
    assert.ok(watches >= 1, 'inotify watch 数为 0 —— 计数手段坏了,或者监听根本没起来');

    if (tier === 'C') {
      // C 档一个递归 watch 都不建,剩下的只可能来自 `.git` 侧那几个目录级非递归 watch
      assert.equal(mode, 'polling', 'C 档的工作区通路一开始就该是轮询');
      assert.ok(watches <= 9, `C 档的 inotify 用量应为个位数,实为 ${watches}`);
      return;
    }

    /**
     * A 档:`ignore` 在 Linux 上是**注册前跳过**,于是 `node_modules` 那 400 个目录
     * 一个都不该进来。上限取 24(仓库根 + 5 个文件 + `.git` 侧 4 个,留一倍余量),
     * 同时压一条与目录数挂钩的相对判据 —— 阈值将来因别的原因放宽时,后者仍拦得住
     * 「过滤失效」这一种。
     */
    assert.equal(tier, expectedTier(), '判到的档位与三档表对不上');
    /**
     * **「数得低」与「还在原生监听」必须一起断**:递归 watch 若因任何原因没建起来
     * (配额耗尽后 Node 把已注册的全 `close()` 掉、网络盘 ENOSYS、根那次注册失败),
     * 数出来同样是 `.git` 侧那几条 —— 下面三条上限断言**全部通过**,而结论会写成
     * 「过滤生效」。`mode` 是把这两种情形分开的唯一判据。
     */
    assert.equal(mode, 'native', `A 档已经落到 ${mode} —— 低 watch 数不能算作过滤生效`);
    assert.ok(watches <= 24, `A 档的 inotify 用量偏高(${watches}) —— ignore 可能没生效`);
    assert.ok(
      watches * 10 < dirCount,
      `A 档的 inotify 用量与 node_modules 的目录数同阶(${watches} vs ${dirCount})`,
    );
  } finally {
    await server.stop();
  }
});
