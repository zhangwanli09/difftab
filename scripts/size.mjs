#!/usr/bin/env node
// 产物体积门禁(spec §5.5 / §6)。
//
// 零依赖纯 JS,可由 `node scripts/size.mjs` 直接执行 —— 它要在没有 pnpm、
// 没有 node_modules 的 CI matrix 机器上跑,package.json 里的 `size` 只是别名。
//
// 用法:
//   node scripts/size.mjs            对照门禁,超预算即以非 0 退出
//   node scripts/size.mjs --json     以 JSON 输出实测值(用于回填 spec §5.5 表格)

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const repoRoot = resolve(import.meta.dirname, '..');
const webDir = join(repoRoot, 'dist', 'web');

/** spec §5.5 的门禁。当前为预算值,S2 收口时回填实测。 */
const BUDGETS = [
  { name: '前端 JS(明文)', match: /\.js$/, metric: 'plain', limit: 350 * 1024 },
  { name: '前端 JS(gzip)', match: /\.js$/, metric: 'gzip', limit: 120 * 1024 },
  { name: '前端 CSS(明文)', match: /\.css$/, metric: 'plain', limit: 40 * 1024 },
];

/** 某个文件是否有任何门禁盯着它的 gzip 值 —— 没有就别白压一遍。 */
const needsGzip = (path) => BUDGETS.some((b) => b.metric === 'gzip' && b.match.test(path));

function collect(dir) {
  let entries;
  try {
    // 递归交给 readdirSync 自己做,不手写一份遍历;withFileTypes 下 parentPath
    // 给出所在目录(Node 20.12+,下限 22.0.0 上可用)
    entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  } catch {
    console.error(`size: 找不到构建产物目录 ${dir}。先跑 \`pnpm build\`。`);
    process.exit(1);
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = join(entry.parentPath, entry.name);
      const path = relative(repoRoot, full);
      const buf = readFileSync(full);
      // buf.length 就是明文字节数,再 statSync 一次只是把同一个数字重新问一遍
      return { path, plain: buf.length, gzip: needsGzip(path) ? gzipSync(buf).length : 0 };
    });
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const files = collect(webDir);
const results = BUDGETS.map((budget) => {
  const matched = files.filter((f) => budget.match.test(f.path));
  const actual = matched.reduce((sum, f) => sum + f[budget.metric], 0);
  return { ...budget, actual, files: matched.map((f) => f.path), ok: actual <= budget.limit };
});

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      results.map((r) => ({
        name: r.name,
        actualBytes: r.actual,
        actualKB: Number((r.actual / 1024).toFixed(1)),
        limitKB: r.limit / 1024,
        files: r.files,
        ok: r.ok,
      })),
      null,
      2,
    ),
  );
} else {
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    console.log(
      `${mark}  ${r.name.padEnd(20)} ${kb(r.actual).padStart(10)} / 门禁 ${kb(r.limit)}  ${r.files.join(', ')}`,
    );
  }
}

if (results.some((r) => !r.ok)) {
  console.error('\nsize: 超出 spec §5.5 的体积门禁。第一刀砍 hljs 语言清单(见 §5.5)。');
  process.exit(1);
}
