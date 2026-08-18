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

/**
 * 探索用的几轮。前三档小到连根那一次注册都做不成,正是"检测不到"的那一种。
 *
 * 最后一轮是**残留缺口**的探针:改一个启动前就存在、且深到多半没轮上注册的文件。
 * 新建文件会引出一次注册尝试从而把 ENOSPC 暴露出来,改已有文件不会 —— 若那个目录
 * 没被注册,事件就是静默丢失。这一轮回 `refreshed=false` 就说明缺口真的存在。
 */
const EXPLORE_CASES = (repo) => [
  [1, '新建文件'],
  [4, '新建文件'],
  [16, '新建文件'],
  [
    ASSERT_QUOTA,
    '改已有的深层文件',
    () =>
      writeFileSync(join(repo, 'src', `pkg-${PACKAGES - 1}`, 'lib', 'deep.txt'), `${Date.now()}\n`),
  ],
];

function sysctl(value) {
  const r = spawnSync('sudo', ['-n', 'sysctl', '-w', `fs.inotify.max_user_watches=${value}`], {
    encoding: 'utf8',
  });
  return r.status === 0;
}

const readState = async (server) =>
  JSON.parse((await authedGet(server.port, server.token, '/api/state')).body).watch;

/**
 * 在给定配额下跑一轮:起进程 → 连 SSE → 记下此刻的 `mode` → 动一下工作区 → 看刷不刷新
 * → **再读一次 `mode`**。
 *
 * **`mode` 必须在动过之后再读**(2026-08-18 实测,见下):配额在遍历途中耗尽时,Node
 * 并不立刻 emit —— 它是在**下一次要注册 watch 的时候**才失败的,而那一刻正是工作区
 * 出现新条目的时候。于是"降级"这件事发生在用户第一次改动之后而不是启动那一刻,
 * 提前读到的 `native` 说明不了任何问题。两个时刻都记下来,差别本身就是数据。
 *
 * `refreshed` 才是用户视角的判据:`mode` 只说服务自己**以为**在干什么。
 *
 * `change` 可换,默认是"新建一个文件"。**新建与改已有文件不是一回事**:前者会引出
 * 一次注册尝试(于是 ENOSPC 浮出水面、降级、推事件),后者不会 —— 那条路上如果这个
 * 文件所在的目录压根没轮上注册,事件就是**静默丢失**,没有任何东西会响。探索区里
 * 两种各来一次。
 */
async function probe(repo, quota, { refreshMs = 8_000, change } = {}) {
  if (!sysctl(quota)) throw new Error(`压低配额到 ${quota} 失败(需要免密 sudo)`);
  const server = await startGitglance({ cwd: repo });
  try {
    const sse = openEvents(server.port, server.token);
    await sse.connected;
    // 递归 watch 是懒起的,给它一点走完遍历的时间
    await sleep(1_000);

    const modeBefore = (await readState(server)).mode;
    const before = sse.count;
    (change ?? (() => writeFileSync(join(repo, `probe-${Date.now()}.md`), 'a real change\n')))();

    let refreshed = false;
    for (let waited = 0; waited < refreshMs && !refreshed; waited += 200) {
      await sleep(200);
      refreshed = sse.count > before;
    }
    const watch = await readState(server);
    sse.close();
    return {
      quota,
      tier: watch.tier,
      modeBefore,
      mode: watch.mode,
      refreshed,
      stderr: server.stderr,
    };
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
  // 最后一个包里放一个**启动前就存在**的文件,给探索区那条残留缺口探针用
  writeFileSync(join(repo, 'src', `pkg-${PACKAGES - 1}`, 'lib', 'deep.txt'), 'v1\n');
  const dirCount = PACKAGES * 2;
  console.log(`# 仓库里 ${dirCount} 个目录(空目录,git status 看不见)`);

  console.log(`\n# 断言:配额 ${ASSERT_QUOTA} ≪ ${dirCount},ENOSPC 必然落在遍历途中`);
  const main = await probe(repo, ASSERT_QUOTA);
  console.log(
    `  档位 ${main.tier} · mode ${main.modeBefore} → ${main.mode} · 改动刷新=${main.refreshed}`,
  );
  if (main.stderr.trim()) console.log(`  stderr: ${main.stderr.trim().split('\n').join(' / ')}`);

  if (main.tier !== 'A') {
    // C 档压根不建递归 watch,这条验收项对它不适用
    console.log(`SKIP 这个 Node 判到 ${main.tier} 档,没有递归 watch 可耗尽`);
    asserted = false;
  } else {
    // 判据取的是**改动之后**那一次读数(理由见 `probe` 的注释):降级发生在第一次
    // 注册失败的那一刻,而不是启动那一刻
    if (main.mode !== 'polling') {
      console.error(`FAIL 改动之后仍未降级为 polling,实际 mode=${main.mode}`);
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
  console.log('\n# 探索:§5.7 的已知缺口 —— 配额小到连根那一次注册都做不成');
  console.log('  配额 | 档位 | mode(改动前→后) | 改动刷新 | 改动形态');
  for (const [quota, label, change] of EXPLORE_CASES(repo)) {
    /**
     * **每行自己兜住异常,且不计入 `failures`**。配额压到个位数时 `probe()` 本来就
     * 可能抛(启动超时、SSE 连不上),而那恰恰是这一档要观察的现象之一 —— 让它把
     * 作业弄红,等于把一个已知缺陷钉成断言;让它中断循环,则后面几行数据一起没了,
     * 而这一段存在的全部意义就是那张表。
     */
    let row;
    try {
      const r = await probe(repo, quota, { refreshMs: 2_000, change });
      row = `${r.tier}    | ${`${r.modeBefore} → ${r.mode}`.padEnd(19)} | ${String(r.refreshed).padEnd(8)} | ${label}`;
      if (r.stderr.trim()) row += `\n       stderr: ${r.stderr.trim().split('\n').join(' / ')}`;
    } catch (cause) {
      row = `—    | (抛了)             |          | ${cause.message.split('\n')[0]}`;
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
