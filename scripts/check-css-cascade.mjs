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
//   2b. **覆写 --d2h-* 的那些块自己也必须 unlayered**。第 1 条看的是 d2h 的规则,
//      这条看的是变量定义:vscode-theme.css 里那 23 条映射一旦入层,就会被 diff2html
//      自己 `:host,:root` 里的默认值(unlayered)压回去,配色整片退回 GitHub 那套。
//      同一个失效机制的另一半,少了它第 1 条是绿的而页面是错的。
//   2c. **而且要排在 d2h 的默认值之后、覆盖它的全部无前缀变量**。我们的 `:root` 与
//      d2h 的 `:host,:root` 特异性同为 (0,1,0),胜出**纯靠源码顺序** —— 光"unlayered"
//      不够。把 vscode-theme.css 的 @import 挪到 diff2html 之前,23 条覆写整片静默失效
//      而 2b 照样绿。两侧都必须存在(缺一侧说明有一份 CSS 没打进来,顺序就对着空集合
//      通过了),且 d2h 声明的每个无前缀 --d2h-* 都得在我们那块里出现 —— 删掉半张
//      映射表同样是静默退色。哪块是"我们的"由 vscode-theme.css 里的哨兵声明认定,
//      不按值的形状猜(理由见 MAP_SENTINEL 那段)。
//   6. **深色媒体条件里声明的每个 --color-* 都得在条件外也有声明**。深色那半是 delta,
//      名字写错一个字符不会有任何症状:第 5 条查的是**引用**侧,而 `--color-git-modifed: …`
//      在语法上是个合法的新自定义属性(它反而给 defined 集合添了个成员),深色下那个
//      token 就悄悄留在浅色取值上。反向不查 —— 浅色有而深色没有正是"深浅共用"的正常写法。
//      顺带盖住第二种形状(弄红这条时撞出来的):浅色那半住在 @theme 里、会被 Tailwind
//      按引用裁剪,而深色 delta 是我们自己的 CSS、不会被裁。于是删掉某个 token 的最后
//      一处 var() 引用时,浅色侧消失、深色侧留着,同样由本条报出来。
//   5. **没有无定义的 var() 引用**。Tailwind v4 会裁掉既没被工具类、也没被我们自己的
//      CSS 以 var() 引用的 @theme 变量(已实测,spec §10),所以引用侧写错一个字符时
//      产物里留下的是一个无定义的 var() —— 该属性变成 unset,颜色悄悄没了,没有任何
//      报错。--tw-* 除外:它们由 @property 声明,不走 `--x:` 这个形状。
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

// blocks 由 scanBlocks 在遇到 `{` 时按序 push,因此**天然按 start 升序**,filter 也保序。
// 下面取"最前/最后一条"一律用下标,不再各写一个 reduce 比较器 —— 那种写法两处只差
// 一个 `>` / `<`,写反了在今天的产物上仍然通过。
const firstOf = (list) => list[0];
const lastOf = (list) => list[list.length - 1];

/** 块正文只切一次:下面几项断言都要读它,每项各切一遍既浪费也容易切成不同口径。 */
const textOf = (block) => {
  block.text ??= css.slice(block.start, block.end);
  return block.text;
};

/**
 * 「一条自定义属性声明」的匹配口径**只定义一次**(与上面 hljs / d2h 规则同一个道理):
 * 三处调用(--d2h-* / --color-* / 全部)分头各写一遍正则时,改窄其中一处的口径,
 * 另两处就在悄悄检查另一批名字 —— 而这三处每一处都是为了抓静默失效才存在的。
 */
const declaredNames = (text, prefix = '--') => {
  const re = new RegExp(`(${prefix}[\\w-]+)\\s*:`, 'g');
  return [...text.matchAll(re)].map((m) => m[1]);
};

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
  const lastHljs = lastOf(hljsRules);
  const firstD2h = firstOf(d2hRules);
  if (lastHljs.start < firstD2h.start) {
    notes.push(`顺序:${hljsRules.length} 条 hljs 规则全部排在 diff2html.min.css 之前`);
  } else {
    const late = hljsRules.filter((b) => b.start > firstD2h.start);
    failures.push(
      `有 ${late.length}/${hljsRules.length} 条 hljs 规则排在了 diff2html.min.css 之后(如 "${late[0].prelude.slice(0, 60)}")—— 这部分配色会被 d2h 覆盖(spec §5.5)`,
    );
  }
}

// --- 2b. 覆写 --d2h-* 的块必须 unlayered ----------------------------------
// 判据落在「声明变量的那个块」上,而不是「用变量的那条规则」上:压回默认值这件事
// 发生在变量层,规则层看不出来。
// 两侧的身份判据是 vscode-theme.css 那块里的**哨兵声明** MAP_SENTINEL,不是"值长什么样"。
// 曾经按"值里有没有 var(--color-…)"分,那是个会给出**误导性红**的代理:深色下给某个
// --d2h-* 补一条字面量覆写(完全正当)就会被归到 diff2html 那一侧,于是顺序断言报
// 「检查 @import 顺序」,而 @import 顺序根本没问题。哨兵由我们自己写、自己控制,
// 值的形状怎么变都不影响分类,并且它不见了本身就是一条正面断言。
const MAP_SENTINEL = '--gg-d2h-map';
const D2H_DECL = /--d2h-[\w-]+\s*:/;
const d2hVarBlocks = blocks.filter((b) => isRule(b) && D2H_DECL.test(textOf(b)));

// 一次遍历分两侧,不写两个互为反义的 filter —— 那种写法要求两个谓词永远严格互补,
// 改了判据得同时读两处,而"两边都不匹配"的块会从两个集合里一起消失。
const ourBlocks = [];
const theirBlocks = [];
for (const block of d2hVarBlocks) {
  (textOf(block).includes(`${MAP_SENTINEL}:`) ? ourBlocks : theirBlocks).push(block);
}

if (ourBlocks.length === 0) {
  failures.push(
    `产物里找不到带哨兵 ${MAP_SENTINEL} 的 --d2h-* 映射块 —— 要么 vscode-theme.css 没被打进来(配色整片是 diff2html 的默认值),要么哨兵那行被删了(spec §5.6)`,
  );
} else if (theirBlocks.length === 0) {
  failures.push(
    '产物里找不到 diff2html 自己声明 --d2h-* 默认值的块 —— 顺序与覆盖率断言都会对着空集合通过,先确认 diff2html.min.css 是否还在 @import 里(spec §5.6)',
  );
} else {
  // 2b:两侧都必须 unlayered。入层的后果是被 diff2html 的默认值(unlayered)压回去。
  const layered = d2hVarBlocks.filter(inLayer);
  if (layered.length > 0) {
    failures.push(
      `有 ${layered.length}/${d2hVarBlocks.length} 个声明 --d2h-* 的块落在 @layer 内(如 "${firstOf(layered).prelude.slice(0, 60)}",层链 ${firstOf(layered).ancestors.join(' > ')})—— 会被 diff2html 自己 :host,:root 里的默认值压回去(spec §5.6)`,
    );
  } else {
    notes.push(`--d2h-* 覆写:${d2hVarBlocks.length} 个块声明它,全部 unlayered`);
  }

  // 2c 的两半是**互相独立的事实**,平铺成两个 if:嵌套起来的话,顺序一坏就看不见
  // 映射表被删了半张,一次只报得出两个故障里的一个。
  const lastTheirs = lastOf(theirBlocks);
  const firstOurs = firstOf(ourBlocks);
  if (firstOurs.start < lastTheirs.start) {
    failures.push(
      `--d2h-* 的覆写块排在了 diff2html 的默认值之前(覆写 @${firstOurs.start} < 默认值 @${lastTheirs.start})—— 两者特异性同为 (0,1,0),胜出全靠顺序,现在整片覆写静默失效。检查 app.css 里 @import "./vscode-theme.css" 是否还在 diff2html.min.css 之后(spec §5.6)`,
    );
  } else {
    notes.push('--d2h-* 覆写:整块排在 diff2html 默认值之后');
  }

  // 覆全没覆全:名字从 d2h 自己那块里**推导**,不硬编码 23 个字面量 —— 升级 diff2html
  // 新增一个变量时,门禁会直接告诉我们"这个还没映射"。
  // --d2h-dark-* 刻意不管:colorScheme 传 'light',那两个前缀 class 一个都不挂。
  const theirNames = new Set(
    theirBlocks
      .flatMap((b) => declaredNames(textOf(b), '--d2h-'))
      .filter((n) => !n.startsWith('--d2h-dark-')),
  );
  const ourNames = new Set(ourBlocks.flatMap((b) => declaredNames(textOf(b), '--d2h-')));
  const missing = [...theirNames].filter((n) => !ourNames.has(n));

  if (theirNames.size === 0) {
    failures.push('diff2html 那块里一个无前缀 --d2h-* 都没有 —— 覆盖率断言在对着空集合通过');
  } else if (missing.length > 0) {
    failures.push(
      `diff2html 的 ${missing.length}/${theirNames.size} 个无前缀 --d2h-* 没有被映射:${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''} —— 这些会留在 GitHub 的默认取值上(spec §5.6)`,
    );
  } else {
    notes.push(`--d2h-* 覆写:${theirNames.size} 个无前缀变量全部映射到 token`);
  }
}

// --- 5. 没有无定义的 var() 引用 -------------------------------------------
// 带 fallback 的 var(--x, …) 不算:那种写法本身就承认可能没定义,坏了也不是静默的。
const defined = new Set(declaredNames(css));

// `@property --x { … }` 也是一份声明,只是形状不是 `--x:`(Tailwind 用它注册
// --tw-border-style 之类)。把它并进 defined,而**不是**按 `--tw-` 前缀豁免:
// 前缀豁免是按名字给的,于是 var(--tw-写错了) 这种引用永久隐身,将来 Tailwind 换出
// 一个没 @property 声明的 --tw-* 也一样查不到。判据统一成"它有一份声明"。
for (const block of blocks) {
  const at = /^@property\s+(--[\w-]+)/.exec(block.prelude);
  if (at) defined.add(at[1]);
}

// 只需要"引用了哪些名字",不需要各引用了几次 —— 计数没有任何断言读它
const referenced = new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]));
const undefinedRefs = [...referenced].filter((name) => !defined.has(name));
if (referenced.size === 0) {
  failures.push('产物里一个不带 fallback 的 var() 引用都没有 —— 本条断言在对着空集合通过');
} else if (undefinedRefs.length > 0) {
  failures.push(
    `${undefinedRefs.length} 个 var() 引用在产物里找不到定义:${undefinedRefs.slice(0, 5).join(', ')}${undefinedRefs.length > 5 ? ' …' : ''} —— 引用名写错或 @theme 变量被裁掉,该属性会静默变成 unset(spec §5.6)`,
  );
} else {
  notes.push(`var() 引用:${referenced.size} 个不带 fallback 的自定义属性,全部有定义`);
}

// --- 5b. diff2html 行号列的包含块那条工具类确实在产物里 --------------------
// `DiffView` 给 diff2html 的宿主 div 挂了 `relative`,补的是行号列(它们是
// `position: absolute`)的包含块;没有它右侧一滚,整列行号原地钉死(spec §5.6)。
// 这条查的是**产物**而不是源码:Tailwind 靠 @source 扫**字面量**生成工具类,类名一旦
// 改成拼出来的(`cx('relative')`、模板串、别处 import 的常量),DOM 上的 className 还是
// 'relative'、组件测试照常绿,而 CSS 里那条规则没了 —— 布局静默退回坏的样子。
if (!/(^|[\s,}])\.relative\s*\{[^}]*position\s*:\s*relative/.test(css)) {
  failures.push(
    '产物里没有 `.relative{position:relative}` —— diff2html 行号列少了包含块,右侧一滚整列行号会原地钉死、与代码行错开(spec §5.6)',
  );
} else {
  notes.push('包含块:`.relative{position:relative}` 在产物里');
}

// --- 6. 深色里声明的 --color-* 都得在浅色也有 -----------------------------
// 第 5 条守引用侧,这条守声明侧。深色块是 delta,写错的名字是个"合法的新 token",
// 第 5 条看不见(它甚至会被算进 defined),症状只是深色下那个颜色留在浅色取值上。
// isRule 这层过滤是**承重的**:少了它,`@media` 包装块自己那份正文(含嵌套的深色
// 声明)会被当成"深色条件之外的声明",于是孤儿检查恒为空、断言变成空转。
const colorNamesIn = (block) => declaredNames(textOf(block), '--color-');
const ruleBlocks = blocks.filter(isRule);
const darkColors = new Set(ruleBlocks.filter(inDarkMedia).flatMap(colorNamesIn));
const lightColors = new Set(ruleBlocks.filter((b) => !inDarkMedia(b)).flatMap(colorNamesIn));

if (darkColors.size === 0) {
  failures.push(
    '深色媒体条件里一个 --color-* 都没声明 —— vscode-theme.css 的深色 delta 没被打进产物,整页深色会停在浅色取值上(spec §5.6)',
  );
} else {
  const orphans = [...darkColors].filter((n) => !lightColors.has(n));
  if (orphans.length > 0) {
    failures.push(
      `深色里有 ${orphans.length} 个 --color-* 在浅色侧没有对应声明:${orphans.join(', ')} —— 名字写错的 delta 是个合法的新 token,不会报错,只是深色下那个颜色留在浅色取值上(spec §5.6)`,
    );
  } else {
    notes.push(`深色 delta:${darkColors.size} 个 --color-*,浅色侧逐一都有声明`);
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
