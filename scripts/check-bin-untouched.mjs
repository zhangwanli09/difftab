#!/usr/bin/env node
// bin/gitglance.js 未被构建管线触碰(spec §5.1 / §6 / §10)。
//
// 为什么这条要有门禁:一旦它进了构建管线,就可能被注入超出 Node 22 的语法、
// 或被合并进主模块,低于下限的用户拿到的将是解析期 SyntaxError —— 版本守卫
// 在解析期即失效。违反后**不报错**,只有在一台老 Node 的机器上才会暴露。
//
// 两项断言:
//   1. 跑完完整构建后,该文件与构建前逐字节一致;
//   2. 守卫的特征串没有出现在 dist/ 的任何产物里 —— 若它被当作打包入口
//      或被合并进主模块,那段文本必然会跟着进产物。
//
// 需要 pnpm(要跑构建),只在 CI 的 build 作业执行,不进 matrix 档。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const binPath = join(repoRoot, 'bin', 'gitglance.js');
const distDir = join(repoRoot, 'dist');

/** 守卫里独一无二的一段文本;改这行文案时同步改这里。 */
const GUARD_MARKER = 'gitglance: requires Node.js ';

const hash = (buf) => createHash('sha256').update(buf).digest('hex');

const before = readFileSync(binPath);
if (!before.includes(GUARD_MARKER)) {
  console.error(
    `check-bin-untouched: bin/gitglance.js 里找不到守卫特征串 "${GUARD_MARKER}"。\n` +
      '文案改了就把本脚本的 GUARD_MARKER 一并改掉 —— 否则第 2 项断言会静默失效。',
  );
  process.exit(1);
}

const build = spawnSync('pnpm', ['run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.status !== 0) {
  console.error('check-bin-untouched: 构建失败。');
  process.exit(1);
}

const after = readFileSync(binPath);
if (hash(before) !== hash(after)) {
  console.error(
    'FAIL  构建改动了 bin/gitglance.js —— 它进了构建管线,版本守卫已不可信(spec §5.1)。',
  );
  process.exit(1);
}
console.log('PASS  构建前后 bin/gitglance.js 逐字节一致');

const leaked = readdirSync(distDir, { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name))
  .filter((f) => readFileSync(f, 'utf8').includes(GUARD_MARKER));

if (leaked.length > 0) {
  console.error(
    `FAIL  守卫代码出现在构建产物里:${leaked.map((f) => relative(repoRoot, f)).join(', ')}\n` +
      '      说明 bin/gitglance.js 被当作了打包入口或被合并进主模块(spec §5.1)。',
  );
  process.exit(1);
}
console.log('PASS  守卫代码未出现在 dist/ 的任何产物中');
