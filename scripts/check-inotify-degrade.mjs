// 压低 `fs.inotify.max_user_watches` 直至 ENOSPC，验降级（那条 Linux 验收项）。
//
// **为什么是脚本而不是一个冒烟用例**：它要动的是**全机器共享**的 sysctl，而 `node --test` 默
// 认按文件并行跑——混在冒烟套件里等于在别的监听用例跑到一半时把配额抽掉，红的会是它们，原因
// 却在这里。所以另起一个 CI 作业单独跑。下面的探索区把几个配额档位下的实际表现打成一张表，
// 先有数再定，不猜。
//
// 需要 Linux + 免密 sudo。零依赖纯 JS；起进程与开 SSE 一律复用 `test/smoke/helpers.js`，不在
// 这里再抄一份——那两个判据是与服务端的契约，分了家会静默漂开，而这一侧漂开的症状是数出 0
// 个事件、看着像「没刷新」。

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixtures } from '../test/fixtures/make.mjs';
import { authedGet, openEvents, removeDir, sleep, startDifftab } from '../test/smoke/helpers.js';

const QUOTA_PATH = '/proc/sys/fs/inotify/max_user_watches';

/**
 * 造多少个目录。**只建目录、不放文件**：递归 watch 照样要逐个注册，而 `git status` 看不见空目
 * 录——于是配额压力上去了，状态查询的开销没跟着上去。
 */
const PACKAGES = 600;

/** 断言用的那一档配额。远小于目录数，ENOSPC 必然落在**遍历途中**。 */
const ASSERT_QUOTA = 128;

/** 探索用的三档：小到连根那一次注册都做不成，正是"检测不到"的那一种。 */
const EXPLORE_QUOTAS = [1, 4, 16];

/**
 * 安全轮询兜住那个缺口要等多久（`SAFETY_POLL_MS` 是 30s）。给到 45s 而不是贴着 30s：贴着写的
 * 话，一次慢一点的 status 就能让这条在负载高的 runner 上假红，而假红比不测更糟。
 */
const SAFETY_WAIT_MS = 45_000;

function sysctl(value) {
  const r = spawnSync('sudo', ['-n', 'sysctl', '-w', `fs.inotify.max_user_watches=${value}`], {
    encoding: 'utf8',
  });
  return r.status === 0;
}

const readState = async (server) =>
  JSON.parse((await authedGet(server.port, server.token, '/api/state')).body).watch;

/**
 * 在给定配额下跑一轮：起进程 → 连 SSE → 记下此刻的 `mode` → 动一下工作区 → 看刷不刷新 →
 * **再读一次 `mode`**。
 *
 * **`mode` 必须在动过之后再读**：配额在遍历途中耗尽时 Node 并不立刻 emit——它是在**下一次要
 * 注册 watch 的时候**才失败的，而那一刻正是工作区出现新条目的时候。于是「降级」发生在用户第一
 * 次改动之后而不是启动那一刻，提前读到的 `native` 说明不了任何问题。`refreshed` 才是用户视角
 * 的判据：`mode` 只说服务自己**以为**在干什么。
 *
 * `change` 可换，默认是「新建一个文件」。**新建与改已有文件不是一回事**：前者会引出一次注册尝
 * 试（于是 ENOSPC 浮出水面、降级、推事件），后者不会——那条路上如果这个文件所在的目录压根没
 * 轮上注册，事件就是**静默丢失**。探索区里两种各来一次。
 */
async function probe(repo, quota, { refreshMs = 8_000, change } = {}) {
  if (!sysctl(quota)) throw new Error(`压低配额到 ${quota} 失败（需要免密 sudo）`);
  const server = await startDifftab({ cwd: repo });
  try {
    const sse = openEvents(server.port, server.token);
    await sse.connected;
    // 递归 watch 是懒起的，给它一点走完遍历的时间
    await sleep(1_000);

    const modeBefore = (await readState(server)).mode;
    const before = sse.count;
    const startedAt = Date.now();
    (change ?? (() => writeFileSync(join(repo, `probe-${Date.now()}.md`), 'a real change\n')))();

    let refreshed = false;
    for (let waited = 0; waited < refreshMs && !refreshed; waited += 200) {
      await sleep(200);
      refreshed = sse.count > before;
    }
    const elapsedMs = Date.now() - startedAt;
    const watch = await readState(server);
    sse.close();
    return {
      quota,
      tier: watch.tier,
      modeBefore,
      mode: watch.mode,
      refreshed,
      elapsedMs,
      stderr: server.stderr,
    };
  } finally {
    await server.stop();
  }
}

if (process.platform !== 'linux') {
  console.log(`SKIP inotify 是 Linux 专有（当前 ${process.platform}）`);
  process.exit(0);
}

const original = readFileSync(QUOTA_PATH, 'utf8').trim();
console.log(`# 原配额 fs.inotify.max_user_watches=${original}`);
if (!sysctl(original)) {
  console.error('FAIL 没有免密 sudo，改不了 sysctl——这条验收项在这台机器上做不了');
  process.exit(1);
}

const workdir = mkdtempSync(join(tmpdir(), 'difftab-inotify-'));
let failures = 0;
/**
 * 断言那一轮到底跑没跑。**没跑就不许打 PASS**——一个什么都没断言的绿勾正是本仓库反复在防的
 * 东西。
 */
let asserted = true;

try {
  const repo = makeFixtures(join(workdir, 'repos'), ['staged']).staged;
  for (let i = 0; i < PACKAGES; i += 1) {
    mkdirSync(join(repo, 'src', `pkg-${i}`, 'lib'), { recursive: true });
  }
  /**
   * 最后一个包里放一个**启动前就存在、而且已被 git 跟踪**的文件，给下面那条残留缺口的断言用。
   *
   * **「已跟踪」这三个字是判据的一半**（第一版就栽在这里）：轮询比的是 `git status` 的输出，而
   * 未跟踪文件在那份输出里只有一行 `? <路径>`——**改它的内容一个字节都不会变**，于是轮询天生
   * 看不见。已跟踪文件才会从「没这一行」变成「` M <路径>`」。
   */
  const deepFile = join('src', `pkg-${PACKAGES - 1}`, 'lib', 'deep.txt');
  writeFileSync(join(repo, deepFile), 'v1\n');
  for (const args of [
    ['add', deepFile],
    // **身份要在命令行上给**：CI 的 runner 没有全局 `user.name` / `user.email`，提交会以
    // `empty ident name not allowed` 失败
    ['-c', 'user.email=ci@example.com', '-c', 'user.name=ci', 'commit', '-q', '-m', 'deep'],
  ]) {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]} 失败：${r.stderr}${r.stdout}`);
  }
  const dirCount = PACKAGES * 2;
  console.log(`# 仓库里 ${dirCount} 个目录（空目录，git status 看不见）`);

  console.log(`\n# 断言：配额 ${ASSERT_QUOTA} ≪ ${dirCount},ENOSPC 必然落在遍历途中`);
  const main = await probe(repo, ASSERT_QUOTA);
  console.log(
    `  档位 ${main.tier} · mode ${main.modeBefore} → ${main.mode} · 改动刷新=${main.refreshed}`,
  );
  if (main.stderr.trim()) console.log(`  stderr: ${main.stderr.trim().split('\n').join(' / ')}`);

  if (main.tier !== 'A') {
    // C 档压根不建递归 watch，这条验收项对它不适用
    console.log(`SKIP 这个 Node 判到 ${main.tier} 档，没有递归 watch 可耗尽`);
    asserted = false;
  } else {
    // 判据取的是**改动之后**那一次读数（理由见 `probe` 的注释）：降级发生在第一次
    // 注册失败的那一刻，而不是启动那一刻
    if (main.mode !== 'polling') {
      console.error(`FAIL 改动之后仍未降级为 polling，实际 mode=${main.mode}`);
      failures += 1;
    }
    if (!main.refreshed) {
      console.error('FAIL 降级之后工作区改动仍然刷不出来——"功能不受影响"不成立');
      failures += 1;
    }
  }

  /**
   * **第二条断言：改一个启动前就存在、且没轮上注册的深层文件，照样刷得出来。**
   *
   * 这正是那个残留缺口的形态——它不引出任何注册尝试，于是 ENOSPC 永远不浮出水面，原生监听那
   * 侧一声不响。兜住它的是 30s 的低频安全轮询，所以这一轮的预算按秒计而不是毫秒计；它一旦回
   * false，说明安全轮询没接上，而页面上什么都不会显示。
   */
  console.log(`\n# 断言：改一个已有的深层文件（不引出注册尝试），靠安全轮询兜住`);
  const deep = await probe(repo, ASSERT_QUOTA, {
    refreshMs: SAFETY_WAIT_MS,
    change: () => writeFileSync(join(repo, deepFile), `${Date.now()}\n`),
  });
  /**
   * `elapsedMs` 不是凑数：它说明这次刷新来自哪条路。安全轮询是 30s 一拍，所以接近 30s 才是「缺
   * 口被兜住了」；只花了几百毫秒则说明这个目录**恰好**排在配额耗尽之前——断言照样绿，但它这
   * 一轮什么都没证明。目录的注册顺序是 readdir 顺序，压不住，所以把这个数打出来。
   */
  console.log(
    `  档位 ${deep.tier} · mode ${deep.modeBefore} → ${deep.mode} · 改动刷新=${deep.refreshed} · 耗时 ${deep.elapsedMs}ms`,
  );
  if (deep.tier === 'A' && !deep.refreshed) {
    console.error('FAIL 改已有深层文件刷不出来——低频安全轮询没接上');
    failures += 1;
  }

  /**
   * 探索区：**只打印不断言**。这里量的是那个已知缺口(根那一次注册的 ENOSPC 被 Node 整个吞掉，
   * `fs.watch()` 返回一个看着活着却永不 emit 的 watcher)在真机上到底长什么样——断言一个已知
   * 缺陷等于把它钉死。
   */
  console.log('\n# 探索：已知缺口——配额小到连根那一次注册都做不成');
  console.log('  配额 | 档位 | mode（改动前→后） | 改动刷新 | 改动形态');
  for (const quota of EXPLORE_QUOTAS) {
    /**
     * **每行自己兜住异常，且不计入 `failures`**。配额压到个位数时 `probe()` 本来就可能抛（启
     * 动超时、SSE 连不上），而那恰恰是这一档要观察的现象之一——让它把作业弄红等于把一个已知
     * 缺陷钉成断言；让它中断循环，则后面几行数据一起没了。
     */
    let row;
    try {
      const r = await probe(repo, quota, { refreshMs: 2_000 });
      row = `${r.tier}    | ${`${r.modeBefore} → ${r.mode}`.padEnd(19)} | ${String(r.refreshed).padEnd(8)} | 新建文件`;
      if (r.stderr.trim()) row += `\n       stderr: ${r.stderr.trim().split('\n').join(' / ')}`;
    } catch (cause) {
      row = `—    | （抛了）             |          | ${cause.message.split('\n')[0]}`;
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
else if (asserted) console.log('PASS 配额耗尽时降级为轮询，功能不受影响');
else console.log('SKIP 本轮没有断言任何东西——不算通过');
