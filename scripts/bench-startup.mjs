#!/usr/bin/env node
// 冷启动测量(spec §6「冷启动 · CLI 侧」)。
//
// 零依赖纯 JS,可由 `node scripts/bench-startup.mjs` 直接执行 —— 它要在没有 pnpm、
// 没有 node_modules 的 CI matrix 机器上跑,package.json 里的 `bench:startup` 只是别名。
//
// 「ready」的口径:**监听成功并打印 URL**。首次 `git status` 交由第一个 HTTP 请求
// 惰性执行、不计入 —— 否则该指标会随被测仓库规模漂移,失去回归意义。
//
// S0 是骨架:此时 bin/gitglance.js 拉起的后端还只打印一行占位输出,量到的是
// 「node 启动 + 动态 import dist/server/main.js + 第一行 stdout」。
// TODO(S1):接真实启动流程并入 CI 门禁。届时 ready 的判据应当由**后端的输出契约**
// 承担 —— main.ts 在 listen 成功后打印且只打印一行可机器识别的 URL,本处的
// READY_PATTERN 收敛成只认 URL 那一种形态。下面 `gitglance: ` 这个分支是 S0 占位
// 输出的权宜,它会匹配任何以该前缀开头的行(启动横幅、警告、降级提示都算),
// 留到 S1 就成了「量到一个没有意义的数字却显示绿色」。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const entry = join(repoRoot, 'bin', 'gitglance.js');

/** spec §6 的门禁值。 */
const BUDGET_MS = 300;
const RUNS = 7;
const READY_PATTERN = /^(http:\/\/127\.0\.0\.1:\d+|gitglance: )/;
// S1 起被测进程是常驻 HTTP server:它不会退出,ready 行没出现时 'exit' 也就永远不来。
// 没有这道超时,单次测量会挂死,而这一步在 9 个 matrix 组合里都跑 —— 结果不是失败,
// 是 job 一直烧到 GitHub 的 6 小时上限。取门禁的 20 倍,正常路径够宽、异常路径够快。
const HANG_TIMEOUT_MS = BUDGET_MS * 20;

if (!existsSync(join(repoRoot, 'dist', 'server', 'main.js'))) {
  console.error('bench:startup: 找不到 dist/server/main.js。先跑 `pnpm build`。');
  process.exit(1);
}

function measureOnce(cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [entry], {
      cwd,
      // 拉起浏览器在 CI 与测量中必须可关(spec §5.10)
      env: { ...process.env, GITGLANCE_NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let stderr = '';
    let elapsed = null;
    let error = null;

    // 「只结算一次」集中在这一个函数里,任何结束路径都必须经过它 —— 否则计时器
    // 不会被清、子进程不会被杀。散成 settled / done / finish / fail 四件互相牵扯
    // 的东西时,加第五条路径的人得先读懂全部四件才知道该调哪个。
    const settle = (err) => {
      if (elapsed !== null || error !== null) return;
      if (err) error = err;
      else elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      clearTimeout(timer);
      // 这里只 kill,不 resolve:要等 'close',确保子进程真的退干净了再开下一轮。
      // 否则第 N 轮的收尾(S1 起是关 socket、删 os.tmpdir() 里的注册表项)会与
      // 第 N+1 轮的启动重叠,而被测的正是那次启动 —— 门禁刚开始变得重要就变吵。
      child.kill();
    };

    const timer = setTimeout(() => {
      settle(
        new Error(`等待 ready 行超过 ${HANG_TIMEOUT_MS}ms。\nstdout: ${buffer}\nstderr: ${stderr}`),
      );
    }, HANG_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        if (READY_PATTERN.test(line.trim())) {
          settle(null);
          return;
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    // 用 'close' 而非 'exit':'exit' 在进程终止时就触发,此时 stdio 未必读干净,
    // 快速退出的子进程可能让失败路径抢在最后一个 'data' 之前(Windows 管道的
    // 时序与 POSIX 不同)。'close' 保证所有 stdio 已关闭、进程已回收。
    child.on('close', (code) => {
      clearTimeout(timer);
      if (elapsed !== null) resolvePromise(elapsed);
      else
        rejectPromise(
          error ??
            new Error(
              `进程以 ${code} 退出但未打印 ready 行。\nstdout: ${buffer}\nstderr: ${stderr}`,
            ),
        );
    });
    child.on('error', rejectPromise);
  });
}

const cwd = process.argv[2] ? resolve(process.argv[2]) : repoRoot;
const samples = [];

// 第一轮预热,不计入统计(文件系统缓存)
await measureOnce(cwd);
for (let i = 0; i < RUNS; i += 1) {
  samples.push(await measureOnce(cwd));
}

samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
const fmt = (n) => `${n.toFixed(1)}ms`;

console.log(`bench:startup  仓库 ${cwd}`);
console.log(`  样本 (${RUNS} 次): ${samples.map(fmt).join('  ')}`);
console.log(`  中位数 ${fmt(median)} / 门禁 ${BUDGET_MS}ms  最快 ${fmt(samples[0])}`);

if (median > BUDGET_MS) {
  console.error(`\nbench:startup: 冷启动中位数 ${fmt(median)} 超出 ${BUDGET_MS}ms 门禁(spec §6)。`);
  process.exit(1);
}
