#!/usr/bin/env node
// 样式层叠方案的产物门禁(spec §5.6 / §6)。
//
// 零依赖纯 JS,可由 `node scripts/check-css-cascade.mjs` 直接执行。
//
// 要证的四件事,每一条违反后都**不报错、只是静默出错**:
//   1. hljs 主题与 diff2html.min.css 在构建产物里仍是 unlayered ——
//      无层样式在层叠中永远胜过有层样式,而 Tailwind v4 把 preflight 放在
//      @layer base。一旦这两份 CSS 被裹进任何 @layer,这层结构性保障就没了。
//      这正是 §7 列为 S0 前提验证第 1 项的东西:`@import "tailwindcss"` 展开后,
//      后续 @import 的内容是否确实保持 unlayered。
//   2. **每一条** hljs 规则都排在**第一条** d2h 规则之前(diff2html 官方 README
//      的要求),否则 hljs 配色被 d2h 覆盖。断言取 max(hljs) < min(d2h) 而不是
//      first < first:后者只要两份 CSS 的头部顺序对就放行,深色那整块跑到
//      diff2html 之后也照样绿(已实测能骗过)。
//   3/4. 深浅两套各就各位:两份主题都是无条件的 .hljs 规则、自身零 @media,
//      平铺引入的结果是 github-dark 无条件覆盖 github、浅色主题直接失效。
//      判据不是「某条规则里有某个颜色值」,而是**两套的选择器集合完全相等、
//      一套在 dark 媒体条件内、另一套不在** —— github 与 github-dark 各 18 条、
//      选择器逐一对应(已实测)。按颜色值断言只覆盖 30 条里的 1 条,把其余
//      16 条深色规则搬出媒体查询同样能骗过它(也已实测);且换主题时会以
//      「深色主题没被打进来」这种误导性理由失败。

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const cssPath = join(repoRoot, 'dist', 'web', 'app.css');

let css;
try {
  css = readFileSync(cssPath, 'utf8');
} catch {
  console.error(`check-css-cascade: 找不到 ${cssPath}。先跑 \`pnpm build\`。`);
  process.exit(1);
}

/**
 * 极简 CSS 块扫描:只需要「某条规则外层套着哪些 at-rule」,不需要完整 AST。
 * 返回 [{ prelude, start, end, ancestors }]。
 */
function scanBlocks(source) {
  const blocks = [];
  const stack = [];
  let preludeStart = 0;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === '"' || ch === "'") {
      // 跳过字符串,避免里面的花括号干扰
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    if (ch === '{') {
      const prelude = source.slice(preludeStart, i).trim();
      const block = { prelude, start: i, end: -1, ancestors: stack.map((b) => b.prelude) };
      blocks.push(block);
      stack.push(block);
      preludeStart = i + 1;
      continue;
    }

    if (ch === '}') {
      const block = stack.pop();
      if (block) block.end = i;
      preludeStart = i + 1;
      continue;
    }

    if (ch === ';') {
      preludeStart = i + 1;
    }
  }

  return blocks;
}

const blocks = scanBlocks(css);
const failures = [];
const notes = [];

// 「什么算 hljs / d2h 的一条规则」只定义一次 —— 下面三项断言全部由这两个集合驱动。
// 分散成多份 filter 的后果是:改窄其中一份的匹配口径,另几项就在悄悄检查另一批规则。
const isRule = (b) => !b.prelude.startsWith('@');
const hljsRules = blocks.filter((b) => isRule(b) && /(^|[\s,])\.hljs(\b|-)/.test(b.prelude));
const d2hRules = blocks.filter((b) => isRule(b) && /(^|[\s,])\.d2h-/.test(b.prelude));

// isRule 已经排除了 @layer 自身,这里只需看祖先链
const inLayer = (block) => block.ancestors.some((a) => a.startsWith('@layer'));
const isDarkMedia = (a) => /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/.test(a);
const inDarkMedia = (block) => block.ancestors.some(isDarkMedia);

// --- 1. unlayered ---------------------------------------------------------
for (const [label, matched] of [
  ['hljs 主题', hljsRules],
  ['diff2html', d2hRules],
]) {
  if (matched.length === 0) {
    failures.push(`产物里找不到任何 ${label} 的规则 —— @import 是否没被打进 app.css?`);
    continue;
  }
  const layered = matched.filter(inLayer);
  if (layered.length > 0) {
    failures.push(
      `${label} 有 ${layered.length}/${matched.length} 条规则落在 @layer 内(如 "${layered[0].prelude.slice(0, 60)}",层链 ${layered[0].ancestors.join(' > ')})—— 无层胜有层的保障失效(spec §5.6)`,
    );
  } else {
    notes.push(`${label}:${matched.length} 条规则,全部 unlayered`);
  }
}

// --- 2. 顺序:**每一条** hljs 都在**第一条** d2h 之前 ----------------------
if (hljsRules.length > 0 && d2hRules.length > 0) {
  const lastHljs = hljsRules.reduce((a, b) => (a.start > b.start ? a : b));
  const firstD2h = d2hRules.reduce((a, b) => (a.start < b.start ? a : b));
  if (lastHljs.start < firstD2h.start) {
    notes.push(`顺序:${hljsRules.length} 条 hljs 规则全部排在 diff2html.min.css 之前`);
  } else {
    const late = hljsRules.filter((b) => b.start > firstD2h.start);
    failures.push(
      `有 ${late.length}/${hljsRules.length} 条 hljs 规则排在了 diff2html.min.css 之后(如 "${late[0].prelude.slice(0, 60)}")—— 这部分配色会被 d2h 覆盖(spec §5.5)`,
    );
  }
}

// --- 3/4. 深浅两套各就各位 ------------------------------------------------
// 判据是集合关系,不是颜色值:两套选择器必须完全对应,一套在 dark 条件内、一套在外。
const normalize = (prelude) => prelude.replace(/\s+/g, ' ').trim();
const selectorsOf = (list) => new Set(list.map((b) => normalize(b.prelude)));

const darkSet = selectorsOf(hljsRules.filter(inDarkMedia));
const lightSet = selectorsOf(hljsRules.filter((b) => !inDarkMedia(b)));

if (darkSet.size === 0) {
  failures.push(
    '没有任何 hljs 规则落在 (prefers-color-scheme: dark) 内 —— 深色主题没被打进来,或媒体条件丢了',
  );
} else if (lightSet.size === 0) {
  failures.push('全部 hljs 规则都在 dark 媒体查询内 —— 浅色主题没被打进来');
} else {
  const onlyLight = [...lightSet].filter((s) => !darkSet.has(s));
  const onlyDark = [...darkSet].filter((s) => !lightSet.has(s));
  if (onlyLight.length > 0 || onlyDark.length > 0) {
    failures.push(
      `深浅两套 hljs 规则的选择器集合不一致:仅浅色有 ${onlyLight.length} 条(如 ${onlyLight[0] ?? '—'}),仅深色有 ${onlyDark.length} 条(如 ${onlyDark[0] ?? '—'})。` +
        '两份主题本应逐条对应;不对应意味着有规则漏在媒体条件之外,会无条件覆盖另一套(spec §5.6)',
    );
  } else {
    notes.push(
      `深浅两套各 ${lightSet.size} 条、选择器逐一对应,深色那套全部包在 (prefers-color-scheme: dark) 内`,
    );
  }
}

for (const note of notes) console.log(`PASS  ${note}`);
for (const failure of failures) console.error(`FAIL  ${failure}`);

if (failures.length > 0) {
  process.exit(1);
}
