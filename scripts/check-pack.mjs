#!/usr/bin/env node
// 发布产物内容门禁。
//
// 用 `pnpm pack --dry-run --json` 核对将要发出去的**文件清单**与**运行时依赖**，不必实际落
// tarball。文件白名单为 bin/、dist/、README（含 README.<lang>.md 译文）、LICENSE、
// package.json；不得含 src/、配置文件与测试。dependencies / optionalDependencies /
// peerDependencies 必须为空——只查文件清单是查不出这条的：加一个运行时依赖不会改变文件清单，
// 构建照样成功，用户却开始悄悄拿到一棵传递依赖树，而承诺没有这棵树。读的是磁盘上的
// package.json:pnpm 的 manifest obfuscation 只**剥**字段(packageManager、publish 生命周期脚
// 本)，从不新增依赖；产物侧的对应断言在 test/smoke/，那边直接查 dist/ 里的 import 说明符。
//
// 本脚本只在 CI 的 build 作业跑（需要 pnpm），不进 matrix 档。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

/** 必须为空的依赖字段：后端只用标准库。 */
const MUST_BE_EMPTY = ['dependencies', 'optionalDependencies', 'peerDependencies'];

const ALLOWED = [
  { label: 'bin/', test: (p) => p.startsWith('bin/') },
  { label: 'dist/', test: (p) => p.startsWith('dist/') },
  // npm / pnpm 无条件把根目录下的所有 README* 打进 tarball，与 files 白名单无关。译文 README
  // 因此只有两条路：进白名单，或者根本别叫 README.*——选前者，5 KB 的译文进 tarball 无害，而
  // 改名会让它在 GitHub 上失去约定俗成的位置。
  //
  // `.md` **提在语言段外面**，于是「带语言段却不带 `.md`」在结构上就写不出来——写成并列的两
  // 支(`…\.md|\.md`)时，`README.sh` / `README.js` 会被当成译文放行。穷举 6859 个样本验过等价。
  { label: 'README', test: (p) => /^README((\.[a-z]{2}(-[a-z]{2,4})?)?\.md)?$/i.test(p) },
  { label: 'LICENSE', test: (p) => /^LICEN[CS]E(\.md|\.txt)?$/i.test(p) },
  { label: 'package.json', test: (p) => p === 'package.json' },
];

const r = spawnSync('pnpm', ['pack', '--dry-run', '--json'], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

if (r.status !== 0) {
  console.error(`check-pack: pnpm pack 失败(exit ${r.status})。\n${r.stderr}`);
  process.exit(1);
}

// pnpm 可能在 JSON 前后打印其他行，取第一个 { 到最后一个 }
const start = r.stdout.indexOf('{');
const end = r.stdout.lastIndexOf('}');
if (start === -1 || end === -1) {
  console.error(`check-pack: 无法从输出里解析出 JSON。\n${r.stdout}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(r.stdout.slice(start, end + 1));
} catch (err) {
  console.error(`check-pack: JSON 解析失败：${err.message}\n${r.stdout}`);
  process.exit(1);
}

// 只认 { path } 这一种形状：兼容写法(typeof f === 'string' ? f : f.path)在形状变成第三种时会
// 产出一串 undefined，把「清单核对」降级成一堆看不懂的输出——这个门禁的全部意义是响亮地失败。
const files = Array.isArray(report.files) ? report.files.map((f) => f.path) : [];
if (files.length === 0 || files.some((p) => typeof p !== 'string')) {
  console.error(
    `check-pack: 无法从 pnpm pack 的输出里读出文件清单（期望 files: [{ path }]）。原始输出：\n${r.stdout}`,
  );
  process.exit(1);
}

// --- 运行时依赖必须为空 ---------------------------------------------------
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const nonEmptyDeps = MUST_BE_EMPTY.map((field) => [
  field,
  Object.keys(manifest[field] ?? {}),
]).filter(([, names]) => names.length > 0);

const unexpected = files.filter((p) => !ALLOWED.some((rule) => rule.test(p)));
const missing = ALLOWED.filter((rule) => !files.some((p) => rule.test(p))).map((r2) => r2.label);

console.log(`check-pack: ${files.length} 个文件`);
for (const p of files.slice().sort()) console.log(`  ${p}`);

let failed = false;
if (unexpected.length > 0) {
  console.error(`\nFAIL  白名单外的文件：${unexpected.join(', ')}`);
  failed = true;
}
if (missing.length > 0) {
  console.error(`\nFAIL  缺少应当发布的内容：${missing.join(', ')}`);
  failed = true;
}
if (nonEmptyDeps.length > 0) {
  for (const [field, names] of nonEmptyDeps) {
    console.error(`\nFAIL  ${field} 非空：${names.join(', ')}`);
  }
  console.error('后端只用标准库、dependencies 保持为空（CLAUDE.md 红线）');
  failed = true;
} else {
  console.log(`PASS  ${MUST_BE_EMPTY.join(' / ')} 均为空`);
}
if (!failed) {
  console.log('\nPASS 发布产物内容干净');
}

process.exit(failed ? 1 : 0);
