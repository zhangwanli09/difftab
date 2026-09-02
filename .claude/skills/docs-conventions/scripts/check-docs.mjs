#!/usr/bin/env node
// 文档写作规范的机械自检。零依赖，可由 `node <路径>` 直接执行。
//
// 只查有固定判据、不需要判断力的那几条：全角标点、汉字间硬换行、破折号旁的空格、
// CLAUDE.md 行预算、decisions.md 小节标题里的标点、跨文件锚点、注释反指文档。
// 「内容落哪份」「README 收不收这条」这类需要判断的，脚本不碰，留给 SKILL.md。
//
// 用法：
//   node check-docs.mjs            # 查工作区里改动过的 md 与源码
//   node check-docs.mjs --all      # 查全仓
//   node check-docs.mjs a.md b.md  # 查指定文件

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const CJK = '\\u4e00-\\u9fff\\u3040-\\u30ff';
const CJK_RE = new RegExp(`[${CJK}]`);
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const problems = [];
const report = (file, line, rule, text) => problems.push({ file, line, rule, text });

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
}

function targets() {
  const argv = process.argv.slice(2);
  if (argv.includes('--all')) {
    return git(['ls-files', '*.md', 'src/**/*.ts', 'src/**/*.tsx', 'scripts/*.mjs', 'bin/*.js']);
  }
  const explicit = argv.filter((a) => !a.startsWith('-'));
  if (explicit.length) return explicit.map((p) => relative(root, resolve(p)));
  const changed = new Set([
    ...git(['diff', '--name-only', 'HEAD']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ]);
  return [...changed].filter((p) => /\.(md|ts|tsx|mjs|js)$/.test(p) && existsSync(join(root, p)));
}

// 剥掉围栏代码块与行内代码：标点三类不转里的两类（代码块、行内代码）在这里排除，
// 第三类（成段英文引文）没有语法标记，只能靠 SKILL.md 的自检步骤兜住。
// 填充字符用私用区而不是空格——用空格的话，`code` —— 会被误判成「破折号旁有空格」。
const FILL = '\ue000';
const fill = (n) => FILL.repeat(n);

function stripCode(lines) {
  let fenced = false;
  return lines.map((raw) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return fill(raw.length);
    }
    if (fenced) return fill(raw.length);
    if (/^\s{4,}\S/.test(raw)) return fill(raw.length); // 缩进代码块
    return raw.replace(/`[^`]*`/g, (m) => fill(m.length));
  });
}

function checkMarkdown(file, text) {
  const rawLines = text.split('\n');
  const lines = stripCode(rawLines);

  lines.forEach((line, i) => {
    const n = i + 1;
    if (!line.trim()) return;
    const prose = line.replace(/\]\([^)]*\)/g, (m) => `]${fill(m.length - 1)}`); // 链接目标不是正文

    // 半角标点贴着汉字。数字千分位（1,048,945）与 file.md 这类不会命中，两侧都不是汉字。
    const halfWidth = [
      ...prose.matchAll(
        new RegExp(`.?[${CJK}][,;:!?][^\\s]?|.?[,;:!?][${CJK}]|[${CJK}]\\.(?![0-9a-zA-Z])`, 'g'),
      ),
    ].map((m) => m[0]);
    if (halfWidth.length) report(file, n, '半角标点', [...new Set(halfWidth)].join(' / '));
    // 半角括号里包着汉字
    for (const m of prose.matchAll(new RegExp(`\\([^()]*[${CJK}][^()]*\\)`, 'g'))) {
      report(file, n, '半角括号', m[0]);
    }
    // 破折号前后不加空格
    if (/ ——|—— /.test(prose)) report(file, n, '破折号旁有空格', line.trim());

    // 段落在两个汉字之间硬换行：markdown 会渲染成一个可见空格
    const next = lines[i + 1];
    if (next && CJK_RE.test(line.slice(-1)) && CJK_RE.test(next.trimStart().slice(0, 1))) {
      if (!/^\s*([-*+]|\d+\.|>|#|\|)/.test(next))
        report(file, n, '汉字间硬换行', `${line.trim().slice(-12)} ⏎ ${next.trim().slice(0, 12)}`);
    }
  });

  if (file === 'CLAUDE.md' && rawLines.length > 200) {
    report(file, rawLines.length, 'CLAUDE.md 超预算', `${rawLines.length} 行 > 200`);
  }

  if (file === 'docs/decisions.md') {
    rawLines.forEach((line, i) => {
      const h = line.match(/^#{2,3}\s+(.*)$/);
      if (h && /[（）()，。、：:；;「」“”]/.test(h[1])) {
        report(file, i + 1, '锚点标题带标点', h[1]);
      }
    });
  }

  checkAnchors(file, rawLines);
}

const slugCache = new Map();
function slugsOf(absPath) {
  if (slugCache.has(absPath)) return slugCache.get(absPath);
  const set = new Set();
  if (existsSync(absPath)) {
    const seen = new Map();
    for (const line of stripCode(readFileSync(absPath, 'utf8').split('\n'))) {
      const h = line.match(/^#{1,6}\s+(.*?)\s*$/);
      if (!h) continue;
      const base = h[1]
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[`*_~]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-');
      const k = seen.get(base) ?? 0;
      seen.set(base, k + 1);
      set.add(k === 0 ? base : `${base}-${k}`);
    }
  }
  slugCache.set(absPath, set);
  return set;
}

function checkAnchors(file, rawLines) {
  rawLines.forEach((line, i) => {
    for (const m of line.matchAll(/\]\(([^)\s]*)#([^)\s]+)\)/g)) {
      const [, target, anchor] = m;
      if (/^https?:/.test(target)) continue;
      const abs = target ? resolve(root, dirname(file), target) : resolve(root, file);
      if (!existsSync(abs)) {
        report(file, i + 1, '链接目标不存在', `${target}#${anchor}`);
        continue;
      }
      if (!slugsOf(abs).has(decodeURIComponent(anchor).toLowerCase())) {
        report(file, i + 1, '锚点打不中', `${target}#${anchor}`);
      }
    }
  });
}

// 红线：代码注释不得反指文档。方向是单向的——CLAUDE.md 第 4 节负责路由，注释只写理由。
function checkComments(file, text) {
  text.split('\n').forEach((line, i) => {
    const c = line.match(/(?:\/\/|\*|#)\s*(.*)$/);
    if (!c) return;
    if (/(docs\/[\w./-]+|CLAUDE\.md|RELEASING\.md|gates\.md|decisions\.md)/.test(c[1])) {
      report(file, i + 1, '注释反指文档', line.trim());
    }
  });
}

const files = targets();
for (const f of files) {
  const abs = join(root, f);
  if (!existsSync(abs)) continue;
  const text = readFileSync(abs, 'utf8');
  if (f.endsWith('.md')) checkMarkdown(f, text);
  else if (f.startsWith('src/')) checkComments(f, text);
}

if (!files.length) {
  console.log('没有改动过的文档或源码文件。');
  process.exit(0);
}
console.log(`检查了 ${files.length} 个文件。`);
if (!problems.length) {
  console.log('未发现机械可判的问题。仍需逐行读 diff——语义、层级、内容落哪份，脚本看不见。');
  process.exit(0);
}
for (const p of problems) console.log(`${p.file}:${p.line}  [${p.rule}] ${p.text}`);
console.log(`\n共 ${problems.length} 处。逐条确认——脚本会误报（尤其成段英文引文里的半角标点）。`);
process.exit(1);
