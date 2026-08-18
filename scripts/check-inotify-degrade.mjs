// 压低 `fs.inotify.max_user_watches` 直至 ENOSPC,验降级(spec §6 的那条 Linux 验收项)。
//
// **为什么是脚本而不是一个冒烟用例**:它要动的是**全机器共享**的 sysctl,而
// `node --test` 默认按文件并行跑 —— 混在冒烟套件里等于在别的监听用例跑到一半时
// 把配额抽掉,红的会是它们,原因却在这里。所以另起一个 CI 作业单独跑。
//
// **同时是 §5.7 那条"启动时配额已耗尽检测不到"的两条候选补法择一的判据**:下面的
// 探索区把几个配额档位下的实际表现打成一张表,先有数再定,不猜。
//
// 需要 Linux + 免密 sudo(GitHub 的 ubuntu runner 两条都满足)。零依赖纯 JS;
// 起进程与开 SSE 一律复用 `test/smoke/helpers.js`,不在这里再抄一份 —— "等到 stdout
// 第一行是 URL"与"`: connected` 握手 + 数 `event: change`"都是与服务端的契约,
// 分了家就会在下一次改动里静默漂开,而这一侧漂开的症状是数出 0 个事件、看着像"没刷新"。

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixtures } from '../test/fixtures/make.mjs';
import { authedGet, openEvents, removeDir, sleep, startGitglance } from '../test/smoke/helpers.js';

const QUOTA_PATH = '/proc/sys/fs/inotify/max_user_watches';

/**
 * 造多少个目录。**只建目录、不放文件**:递归 watch 照样要逐个注册,而 `git status`
 * 看不见空目录 —— 于是配额压力上去了,状态查询的开销没跟着上去。
 */
const PACKAGES = 600;

/** 断言用的那一档配额。远小于目录数,ENOSPC 必然落在**遍历途中**。 */
const ASSERT_QUOTA = 128;

/** 探索用的几档:小到连根那一次注册都做不成,正是"检测不到"的那一种。 */
const EXPLORE_QUOTAS = [1, 4, 16];

function sysctl(value) {
  const r = spawnSync('sudo', ['-n', 'sysctl', '-w', `fs.inotify.max_user_watches=${value}`], {
    encoding: 'utf8',
  });
  return r.status === 0;
}

const readState = async (server) =>
  JSON.parse((await authedGet(server.port, server.token, '/api/state')).body).watch;

/**
 * 在给定配额下跑一轮:起进程 → 连 SSE → 等 `mode` 落定 → 写一个新文件 → 看刷不刷新。
 *
 * `refreshed` 才是用户视角的判据。`mode` 只说服务自己**以为**在干什么 —— 两者分开
 * 记,正是因为"检测不到"的那一种里它俩会打架:`mode` 说 `native`,而什么都不刷新。
 *
 * `refreshMs` 分档给:断言那一轮要证的是"刷得出来",等不够就是假红,给足;探索那几轮
 * 记的是"往哪边倒",没有任何东西需要被证明**不**发生,给一个短的就行 —— 而它们的预期
 * 结果恰恰是 `false`,也就是每轮都会把预算耗满。
 */
async function probe(repo, quota, { refreshMs = 8_000 } = {}) {
  if (!sysctl(quota)) throw new Error(`压低配额到 ${quota} 失败(需要免密 sudo)`);
  const server = await startGitglance({ cwd: repo });
  try {
    const sse = openEvents(server.port, server.token);
    await sse.connected;

    /**
     * 递归 watch 是懒起的,还要走完一遍遍历才谈得上耗尽配额 —— 但**等的是一个可观测
     * 的条件而不是一个固定的毫秒数**:`mode` 翻成 `polling` 就是遍历撞上 ENOSPC 的
     * 那一刻。翻不了的那几轮(正是"检测不到"的那一种)才付满这 1.5 秒。
     */
    let watch = await readState(server);
    for (let waited = 0; waited < 1_500 && watch.mode === 'native'; waited += 100) {
      await sleep(100);
      watch = await readState(server);
    }

    const before = sse.count;
    writeFileSync(join(repo, `probe-${Date.now()}.md`), 'a real change\n');
    let refreshed = false;
    for (let waited = 0; waited < refreshMs && !refreshed; waited += 200) {
      await sleep(200);
      refreshed = sse.count > before;
    }
    sse.close();
    return { quota, mode: watch.mode, tier: watch.tier, refreshed, stderr: server.stderr };
  } finally {
    await server.stop();
  }
}

if (process.platform !== 'linux') {
  console.log(`SKIP inotify 是 Linux 专有(当前 ${process.platform})`);
  process.exit(0);
}

const original = readFileSync(QUOTA_PATH, 'utf8').trim();
console.log(`# 原配额 fs.inotify.max_user_watches=${original}`);
if (!sysctl(original)) {
  console.error('FAIL 没有免密 sudo,改不了 sysctl —— 这条验收项在这台机器上做不了');
  process.exit(1);
}

const workdir = mkdtempSync(join(tmpdir(), 'gitglance-inotify-'));
let failures = 0;
/**
 * 断言那一轮到底跑没跑。**没跑就不许打 PASS** —— 一个什么都没断言的绿勾正是本仓库
 * 反复在防的东西(CI 里那条"冒烟用例确实被发现了"存在的理由与此完全相同)。
 */
let asserted = true;

try {
  const repo = makeFixtures(join(workdir, 'repos'), ['staged']).staged;
  for (let i = 0; i < PACKAGES; i += 1) {
    mkdirSync(join(repo, 'src', `pkg-${i}`, 'lib'), { recursive: true });
  }
  const dirCount = PACKAGES * 2;
  console.log(`# 仓库里 ${dirCount} 个目录(空目录,git status 看不见)`);

  console.log(`\n# 断言:配额 ${ASSERT_QUOTA} ≪ ${dirCount},ENOSPC 落在遍历途中`);
  const main = await probe(repo, ASSERT_QUOTA);
  console.log(`  档位 ${main.tier} · mode=${main.mode} · 改动刷新=${main.refreshed}`);
  if (main.stderr.trim()) console.log(`  stderr: ${main.stderr.trim().split('\n').join(' / ')}`);

  if (main.tier !== 'A') {
    // C 档压根不建递归 watch,这条验收项对它不适用
    console.log(`SKIP 这个 Node 判到 ${main.tier} 档,没有递归 watch 可耗尽`);
    asserted = false;
  } else {
    if (main.mode !== 'polling') {
      console.error(`FAIL 期望降级为 polling,实际 mode=${main.mode}`);
      failures += 1;
    }
    if (!main.refreshed) {
      console.error('FAIL 降级之后工作区改动仍然刷不出来 —— "功能不受影响"不成立');
      failures += 1;
    }
  }

  /**
   * 探索区:**只打印不断言**。这里量的是 §5.7 记下的那个已知缺口(根那一次注册的
   * ENOSPC 被 Node 整个吞掉,`fs.watch()` 返回一个看着活着却永不 emit 的 watcher),
   * 而"补法二选一"的判据正是它在真机上到底长什么样。断言一个已知缺陷等于把它钉死。
   */
  console.log('\n# 探索:配额小到连根那一次注册都做不成时(§5.7 的已知缺口)');
  console.log('  配额 | 档位 | mode | 改动刷新');
  for (const quota of EXPLORE_QUOTAS) {
    /**
     * **每行自己兜住异常,且不计入 `failures`**。配额压到个位数时 `probe()` 本来就
     * 可能抛(启动超时、SSE 连不上),而那恰恰是这一档要观察的现象之一 —— 让它把
     * 作业弄红,等于把一个已知缺陷钉成断言;让它中断循环,则后面几行数据一起没了,
     * 而这一段存在的全部意义就是那张表。
     */
    let row;
    try {
      const r = await probe(repo, quota, { refreshMs: 2_000 });
      row = `${r.tier}    | ${r.mode.padEnd(7)} | ${r.refreshed}`;
      if (r.stderr.trim()) row += `\n       stderr: ${r.stderr.trim().split('\n').join(' / ')}`;
    } catch (cause) {
      row = `—    | (抛了)  | ${cause.message.split('\n')[0]}`;
    }
    console.log(`  ${String(quota).padStart(4)} | ${row}`);
  }
} catch (cause) {
  console.error(`FAIL ${cause.stack ?? cause}`);
  failures += 1;
} finally {
  sysctl(original);
  console.log(`\n# 配额已还原为 ${original}`);
  removeDir(workdir);
}

if (failures > 0) process.exitCode = 1;
else if (asserted) console.log('PASS 配额耗尽时降级为轮询,功能不受影响');
else console.log('SKIP 本轮没有断言任何东西 —— 不算通过');
