#!/usr/bin/env node
// ci.yml 的汇总作业 gates-passed 写法正确。
//
// 它是 ruleset 里唯一一个来自 ci.yml 的 required check，而**被跳过的作业对 required check 而言
// 算通过**，所以它写错的三种方式都不报错，只是静默放行：
//   - needs 漏列一个作业：那个作业红了也挡不住合并；
//   - if 不是 always()：运行被取消、或某个依赖红了时它被跳过；
//   - 判定不再要求每个依赖都是 success：skipped 的依赖被当成绿的。
// 第三条按行为验：把 gates-passed 那段 run 脚本取出来，喂几份 needs fixture 实际跑一遍，
// 而不是比对 jq 表达式的字面量——字面量比对拦得住无害的改写，却拦不住换个写法的回归。
//
// 零依赖、没有 YAML 解析器，按缩进切：jobs 下的作业键是两格缩进。**先断言确实切出了作业**，
// 否则正则一旦失配，两边都是空表，照样「相等」。
//
// 不需要安装依赖（要 bash 与 jq），CI 在 build 作业 checkout 之后立刻跑。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const ciPath = join(repoRoot, '.github', 'workflows', 'ci.yml');
const GATE = 'gates-passed';

const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};

const text = readFileSync(ciPath, 'utf8');
const jobsAt = text.indexOf('\njobs:\n');
if (jobsAt < 0) fail('ci.yml 里找不到顶层 jobs:');

const blocks = new Map(
  text
    .slice(jobsAt + '\njobs:\n'.length)
    .split(/^(?= {2}[a-z][a-z0-9-]*:\s*$)/m)
    .map((block) => [block.match(/^ {2}([a-z][a-z0-9-]*):/)?.[1], block])
    .filter(([name]) => name),
);
const gate = blocks.get(GATE);
if (blocks.size < 2 || !gate)
  fail(`没切出作业，或没有 ${GATE}（切出 ${[...blocks.keys()].join(', ') || '无'}）`);

// needs 可以写成一行 [a, b]，也可以写成块列表
const flow = gate.match(/^ {4}needs: \[([^\]]*)\]/m);
const list = gate.match(/^ {4}needs:\s*\n((?: {6}- .*\n)+)/m);
const needs = flow
  ? flow[1].split(',').map((s) => s.trim())
  : (list?.[1].match(/- *(\S+)/g) ?? []).map((s) => s.replace(/^- */, ''));
const want = [...blocks.keys()].filter((name) => name !== GATE).sort();
if (needs.sort().join(' ') !== want.join(' ')) {
  fail(`${GATE} 的 needs 是 [${needs.join(', ')}]，应为其余全部作业 [${want.join(', ')}]`);
}
console.log(`PASS  ${GATE} needs 其余全部作业：${want.join(', ')}`);

if (!/^ {4}if: \$\{\{\s*always\(\)\s*\}\}\s*$/m.test(gate)) {
  fail(`${GATE} 必须以 if: \${{ always() }} 运行：被跳过的 required check 算通过`);
}
console.log(`PASS  ${GATE} 以 always() 运行`);

const run = gate.match(/^ {8}run: \|\n((?: {10}.*\n?)+)/m)?.[1].replace(/^ {10}/gm, '');
if (!run) fail(`找不到 ${GATE} 的 run 脚本`);

// 与 Actions 默认的 bash 调用方式一致（-eo pipefail）
const exitCode = (needsJson) =>
  spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], {
    env: { ...process.env, NEEDS: JSON.stringify(needsJson) },
    stdio: 'ignore',
  }).status;

const cases = [
  ['全部 success', { a: { result: 'success' }, b: { result: 'success' } }, true],
  ['一个 skipped', { a: { result: 'success' }, b: { result: 'skipped' } }, false],
  ['一个 cancelled', { a: { result: 'success' }, b: { result: 'cancelled' } }, false],
  ['一个 failure', { a: { result: 'failure' }, b: { result: 'skipped' } }, false],
];
for (const [label, fixture, shouldPass] of cases) {
  const code = exitCode(fixture);
  if ((code === 0) !== shouldPass)
    fail(`${GATE} 的判定在「${label}」时 exit ${code}，应${shouldPass ? '通过' : '失败'}`);
}
console.log(`PASS  ${GATE} 只在全部依赖为 success 时通过（${cases.length} 份 fixture）`);
