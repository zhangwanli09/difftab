#!/usr/bin/env node
// 样式层叠方案的产物门禁。
//
// 零依赖纯 JS,可由 `node scripts/check-css-cascade.mjs` 直接执行。
//
// 要证的事,每一条违反后都**不报错、只是静默出错**(编号跟着历史走、不连续,
// 别按数量读 —— 写死一个「共几条」只会在下次加断言时过期,而没有任何东西会响):
//   1. hljs 主题与 diff2html.min.css 在构建产物里仍是 unlayered ——
//      无层样式在层叠中永远胜过有层样式,而 Tailwind v4 把 preflight 放在
//      @layer base。一旦这两份 CSS 被裹进任何 @layer,这层结构性保障就没了。
//      这正是列为 S0 前提验证第 1 项的东西:`@import "tailwindcss"` 展开后,
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
//   6. **明暗开关的三条 color-scheme 规则都在,且没人把深色值写回媒体查询。**
//      深浅取值现在写成 `light-dark(浅, 深)` 的单条声明,选中哪一半全靠 :root 上的
//      color-scheme —— 那三条规则(:root 跟随系统 / [data-theme=light] / [data-theme=dark])
//      就是整个开关的全部机制,少一条的症状是**按钮照常有反应而页面不变**。
//      6b 是同一件事的另一半,也是**旧断言的反转**:从前深色是写在
//      @media (prefers-color-scheme: dark) 里的一份 delta,那时查的是"delta 里的名字
//      在浅色侧也得有";现在凡把 --color-* / --hljs-* 声明进那个媒体条件的一律判红 ——
//      那样写不报错、浅色也对,只有手动档对它无效(切到 Light 时那一个颜色还是深的)。
//      diff2html 自己在那个媒体条件里声明的是 --d2h-dark-*,不受影响;Lightning CSS
//      降级 light-dark() 时补进去的是 --lightningcss-*,也不受影响。
//   5. **没有无定义的 var() 引用**。Tailwind v4 会裁掉既没被工具类、也没被我们自己的
//      CSS 以 var() 引用的 @theme 变量(已实测),所以引用侧写错一个字符时
//      产物里留下的是一个无定义的 var() —— 该属性变成 unset,颜色悄悄没了,没有任何
//      报错。--tw-* 除外:它们由 @property 声明,不走 `--x:` 这个形状。
//   3/4. **hljs 规则里没有硬编码颜色,且每个 --hljs-* 都被用到。**
//      上游那两份主题(github / github-dark)已经合成我们自己的 hljs-theme.css:
//      15 条规则照抄选择器(上游 18 条里的空规则与两条 code.hljs 没抄,理由在那个文件里),
//      颜色一律 `var(--hljs-…)`,深浅由 token 的 light-dark() 翻。
//      于是从前那条「深浅两套选择器集合必须相等」失去了对象 —— 现在只有一套规则。
//      接手的是两条:规则里出现任何硬编码颜色,说明有一条漏了 token 化,症状是
//      **另一档下那一处静默停在错的颜色上**;某个 --hljs-* 定义了却没被任何 hljs
//      规则引用,说明抄漏了它对应的那条规则(第 5 条查不到 —— 它查的是引用侧)。
//      色值本身抄没抄对不在门禁能力范围内,归人工逐条对。

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
// `.hljs` 不要求在选择器开头:上游主题里 `code.hljs` / `pre code.hljs` 两条正是长在
// 别的类型选择器后面的。曾经写成 `(^|[\s,])\.hljs`,于是那两条**一条都不在集合里** ——
// 顺序与 unlayered 那几项因此少查了两条,而「hljs 规则里不许有硬编码颜色」那条更是
// 对着它们完全失效(往 `pre code.hljs` 里写死一个 background 能一路绿到底)。
const hljsRules = blocks.filter((b) => isRule(b) && /\.hljs(\b|-)/.test(b.prelude));
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
 * 各调用点分头各写一遍正则时,改窄其中一处的口径,另几处就在悄悄检查另一批名字 ——
 * 而每一处都是为了抓静默失效才存在的。
 *
 * 要名字的用 `declaredNames`,要名字带值的(双值检查)用本函数,**共用同一条正则**:
 * 值那半写成 `[^;}]*`(可以为空),因此两者匹配到的名字集合逐条相同。
 */
const declarationsIn = (text, prefix = '--') => {
  const re = new RegExp(`(${prefix}[\\w-]+)\\s*:\\s*([^;}]*)`, 'g');
  return [...text.matchAll(re)].map((m) => [m[1], m[2]]);
};

const declaredNames = (text, prefix = '--') => declarationsIn(text, prefix).map(([name]) => name);

/**
 * 「一次 `var()` 引用」的匹配口径,与上面 `declarationsIn` 同一个理由收成一处。
 *
 * 第 5 条那处**刻意不用它**:那条只认**不带 fallback** 的引用(带 fallback 的写法本身
 * 就承认可能没定义,坏了也不是静默的),契约与这里不同,合并会悄悄放松它。
 */
const varRefsIn = (text, prefix = '--') =>
  [...text.matchAll(new RegExp(`var\\(\\s*(${prefix}[\\w-]+)`, 'g'))].map((m) => m[1]);

/** 选择器与值里的空白归一。跨断言共用,故与上面几个工具同住。 */
const normalize = (text) => text.replace(/\s+/g, ' ').trim();

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
      `${label} 有 ${layered.length}/${matched.length} 条规则落在 @layer 内(如 "${layered[0].prelude.slice(0, 60)}",层链 ${layered[0].ancestors.join(' > ')})—— 无层胜有层的保障失效`,
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
      `有 ${late.length}/${hljsRules.length} 条 hljs 规则排在了 diff2html.min.css 之后(如 "${late[0].prelude.slice(0, 60)}")—— 这部分配色会被 d2h 覆盖`,
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
    `产物里找不到带哨兵 ${MAP_SENTINEL} 的 --d2h-* 映射块 —— 要么 vscode-theme.css 没被打进来(配色整片是 diff2html 的默认值),要么哨兵那行被删了`,
  );
} else if (theirBlocks.length === 0) {
  failures.push(
    '产物里找不到 diff2html 自己声明 --d2h-* 默认值的块 —— 顺序与覆盖率断言都会对着空集合通过,先确认 diff2html.min.css 是否还在 @import 里',
  );
} else {
  // 2b:两侧都必须 unlayered。入层的后果是被 diff2html 的默认值(unlayered)压回去。
  const layered = d2hVarBlocks.filter(inLayer);
  if (layered.length > 0) {
    failures.push(
      `有 ${layered.length}/${d2hVarBlocks.length} 个声明 --d2h-* 的块落在 @layer 内(如 "${firstOf(layered).prelude.slice(0, 60)}",层链 ${firstOf(layered).ancestors.join(' > ')})—— 会被 diff2html 自己 :host,:root 里的默认值压回去`,
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
      `--d2h-* 的覆写块排在了 diff2html 的默认值之前(覆写 @${firstOurs.start} < 默认值 @${lastTheirs.start})—— 两者特异性同为 (0,1,0),胜出全靠顺序,现在整片覆写静默失效。检查 app.css 里 @import "./vscode-theme.css" 是否还在 diff2html.min.css 之后`,
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
      `diff2html 的 ${missing.length}/${theirNames.size} 个无前缀 --d2h-* 没有被映射:${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''} —— 这些会留在 GitHub 的默认取值上`,
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
    `${undefinedRefs.length} 个 var() 引用在产物里找不到定义:${undefinedRefs.slice(0, 5).join(', ')}${undefinedRefs.length > 5 ? ' …' : ''} —— 引用名写错或 @theme 变量被裁掉,该属性会静默变成 unset`,
  );
} else {
  notes.push(`var() 引用:${referenced.size} 个不带 fallback 的自定义属性,全部有定义`);
}

// --- 5b. diff2html 行号列的包含块那条工具类确实在产物里 --------------------
// `DiffView` 给 diff2html 的宿主 div 挂了 `relative`,补的是行号列(它们是
// `position: absolute`)的包含块;没有它右侧一滚,整列行号原地钉死。
// 这条查的是**产物**而不是源码:Tailwind 靠 @source 扫**字面量**生成工具类,类名一旦
// 改成拼出来的(`cx('relative')`、模板串、别处 import 的常量),DOM 上的 className 还是
// 'relative'、组件测试照常绿,而 CSS 里那条规则没了 —— 布局静默退回坏的样子。
if (!/(^|[\s,}])\.relative\s*\{[^}]*position\s*:\s*relative/.test(css)) {
  failures.push(
    '产物里没有 `.relative{position:relative}` —— diff2html 行号列少了包含块,右侧一滚整列行号会原地钉死、与代码行错开',
  );
} else {
  notes.push('包含块:`.relative{position:relative}` 在产物里');
}

// --- 6. 明暗开关的三条 color-scheme 规则都在,且都 unlayered ---------------
// 这三条就是整个开关:`data-theme` 属性由 state/theme.ts 写在 <html> 上,缺省(属性不
// 存在)即跟随系统。丢了其中一条不报错 —— 按钮照常切档、`data-theme` 照常变,只是页面
// 一动不动,而这恰恰是最像"没坏"的坏法。
//
// 值也一起查:把 [data-theme=dark] 那条写成 `light dark` 同样是"点了没反应",而选择器
// 还在原地,只查规则在不在会放它过去。
const ruleBlocks = blocks.filter(isRule);
// 属性值的引号由压缩器决定(实测被剥掉),两种形状都要认得
const normalizeSelector = (prelude) => normalize(prelude).replace(/["']/g, '');
const schemeValueOf = (block) => {
  const m = /color-scheme\s*:\s*([^;}]+)/.exec(textOf(block));
  return m ? normalize(m[1]) : null;
};

// 属性名在本文件里**只写一次**,选择器由它拼出来 —— 下面 6e 拿同一个常量去查 JS 那侧,
// 「CSS 读的属性」与「JS 写的属性」因此不可能各自漂走。
const THEME_ATTR = 'data-theme';
const EXPECTED_SCHEMES = [
  [':root', 'light dark', '缺省档:跟随系统'],
  [`:root[${THEME_ATTR}=light]`, 'light', '手动亮档'],
  [`:root[${THEME_ATTR}=dark]`, 'dark', '手动暗档'],
];

for (const [selector, expected, label] of EXPECTED_SCHEMES) {
  const matched = ruleBlocks.filter(
    (b) => normalizeSelector(b.prelude) === selector && schemeValueOf(b) !== null,
  );
  if (matched.length === 0) {
    failures.push(
      `产物里没有 \`${selector} { color-scheme }\`(${label})—— 明暗开关的机制少了一条,按钮照常切档而页面一动不动`,
    );
    continue;
  }
  const layered = matched.filter(inLayer);
  const wrong = matched.filter((b) => schemeValueOf(b) !== expected);
  if (layered.length > 0) {
    failures.push(
      `${selector} 的 color-scheme 规则落在 @layer 内(层链 ${firstOf(layered).ancestors.join(' > ')})—— 会被无层样式压过,开关静默失效`,
    );
  } else if (wrong.length > 0) {
    failures.push(
      `${selector} 的 color-scheme 是 "${schemeValueOf(firstOf(wrong))}",应为 "${expected}"(${label})—— 值错了同样是"点了没反应",而选择器还在原地`,
    );
  } else {
    notes.push(`明暗开关:${selector} → color-scheme: ${expected}(${label})`);
  }
}

// --- 6e. JS 写的属性名与 CSS 读的是同一个 ---------------------------------
// 开关的契约横跨两个产物:`state/theme.ts` 写 <html> 上的属性,`vscode-theme.css` 的
// 两条选择器读它。上面 6a 只守 CSS 那一侧,`theme.test.ts` 只守 JS 那一侧,**两条断言
// 各自钉在接缝的一端**:把属性改名时只改了 TS 与它的单测,两处都绿,而页面上按钮照常
// 切档、什么都不变。
//
// 这是本脚本唯一读 CSS 以外产物的一条 —— 判据本身跨产物,拆到两个文件里就等于把它
// 重新拆成两半。查的是字面量而不是行为:JS 那侧的行为归 `theme.test.ts`。
const jsPath = join(repoRoot, 'dist', 'web', 'app.js');
let js = '';
try {
  js = readFileSync(jsPath, 'utf8');
} catch {
  failures.push(`找不到 ${jsPath} —— 先跑 \`pnpm build\`(本条要拿它与 CSS 里的属性名对照)`);
}
if (js && !js.includes(THEME_ATTR)) {
  failures.push(
    `CSS 按 [${THEME_ATTR}] 选择,而 dist/web/app.js 里找不到这个属性名 —— 两侧漂开了,按钮照常切档而页面一动不动`,
  );
} else if (js) {
  notes.push(`开关接缝:JS 与 CSS 两侧用的都是 ${THEME_ATTR}`);
}

// --- 6b. 我们自己的 CSS 里没有任何 prefers-color-scheme 决策 --------------
// 旧断言的反转。写回媒体查询不报错、浅色也对,只有手动档对它无效 —— 用户切到 Light
// 时那一个颜色仍是深的,而页面上其余部分都跟着翻了,看上去像是那个颜色"本来就该这样"。
//
// 判据落在**「谁在决定明暗」**上,而不是"哪几个前缀的 token"。只查 token 前缀的话,
// 一条 `dark:bg-editor-background` 工具类、或手写的
// `@media (prefers-color-scheme:dark){ .x{background:#111} }` 都不声明自定义属性、
// 一路绿,而失效机制与它挡的那条逐字相同 —— 而 `dark:` 变体恰恰是 Tailwind v4 的
// 主流答案(已列进 decisions.md 的被排除做法),是下一个人最容易顺手写出来的形状。
//
// 于是先整体断言:深色媒体条件里的每一条规则都必须属于两个**已知的、不是我们写的**
// 例外,其余一律判红。两个例外已逐条实测(见 decisions.md 的「样式层叠」):
//   - diff2html 自带那块,29 条以 `.d2h-auto-color-scheme` 开头、另有 1 条以
//     `.d2h-dark-color-scheme` 开头(3.4.56 实测)。**两个 class 我们都不挂**
//     (render.ts 传 colorScheme:'light'),故它整块是死的;
//   - Lightning CSS 降级 light-dark() 时补的开关,只声明 `--lightningcss-*`。
const DARK_MEDIA_EXEMPT = [
  (block) => /(^|[\s,])\.d2h-(?:auto|dark)-color-scheme\b/.test(block.prelude),
  (block) => declaredNames(textOf(block), '--lightningcss-').length > 0,
];
const darkRules = ruleBlocks.filter(inDarkMedia);
const ourDarkRules = darkRules.filter((b) => !DARK_MEDIA_EXEMPT.some((exempt) => exempt(b)));
if (darkRules.length === 0) {
  failures.push(
    '产物里一条 (prefers-color-scheme: dark) 规则都没有 —— diff2html 的 CSS 或 light-dark() 的降级开关没被打进来,本条与下面几条都在对着空集合通过',
  );
} else if (ourDarkRules.length > 0) {
  failures.push(
    `${ourDarkRules.length}/${darkRules.length} 条 (prefers-color-scheme: dark) 里的规则不属于两个已知例外(如 "${normalize(firstOf(ourDarkRules).prelude).slice(0, 60)}")—— 明暗一律由 :root 的 color-scheme 决定,写进媒体查询的那条手动档翻不动它`,
  );
} else {
  notes.push(
    `深色媒体条件:${darkRules.length} 条规则全部属于 diff2html / Lightning CSS 两个已知例外`,
  );
}

// 「哪几族属性算主题 token」与「它们声明在哪」都只写一次:下面 6b(深浅分侧)、
// 6c(hljs 双值)、6d(color-mix)三条断言全部从 themedDecls 派生。
//
// 分头各扫一遍的后果是:这个前缀清单看着像唯一事实来源,其实只有 6b 读它 —— 将来纳入
// 第三族前缀时 6b 会跟着扩,而 6c 与 6d 对新前缀一条都不查,且不报错。
const THEMED_PREFIX = '--(?:color|hljs)-';
const themedDecls = [];
for (const block of ruleBlocks) {
  const dark = inDarkMedia(block);
  for (const [name, value] of declarationsIn(textOf(block), THEMED_PREFIX)) {
    themedDecls.push({ name, value, dark });
  }
}

// 一次遍历分两侧,与上面 --d2h-* 那处同一个理由:两个互为反义的 filter 要求两个谓词
// 永远严格互补,改了判据得同时读两处
const themedDark = new Set();
const themedOutside = new Set();
for (const { name, dark } of themedDecls) (dark ? themedDark : themedOutside).add(name);
const strayDark = [...themedDark];

// 正面探针:一个都没有时上面那条恒为空、断言变空转(vscode-theme.css / hljs-theme.css
// 整份没被打进来就是这个形状)
if (themedOutside.size === 0) {
  failures.push(
    '产物里一个 --color-* / --hljs-* 都没有 —— vscode-theme.css 或 hljs-theme.css 没被打进来,本条与深色断言都在对着空集合通过',
  );
} else if (strayDark.length > 0) {
  failures.push(
    `${strayDark.length} 个 token 被声明在 (prefers-color-scheme: dark) 里:${strayDark.slice(0, 6).join(', ')}${strayDark.length > 6 ? ' …' : ''} —— 深浅两套取值一律写成 light-dark(),写回媒体查询的那个手动档翻不动它`,
  );
} else {
  notes.push(`主题 token:${themedOutside.size} 个,没有一个被声明在深色媒体条件里`);
}

// --- 6c. 深浅双值的 token 确实是双值 --------------------------------------
// Lightning CSS 按构建目标把 light-dark() 降级成 space-toggle 变量对,产物里搜不到
// 那个函数名(已实测)。**两种形状都得认**:今天是降级后的,构建目标一提就变回原生的,
// 只认一种的话那天整条断言会以"一个双值 token 都没有"的形状假红。
const DUAL_VALUE = /light-dark\(|--lightningcss-light\b[\s\S]*--lightningcss-dark\b/;
// 15 个 hljs token **全部**该是双值,这一点与 --color-* 不同(那边「深浅共用同一取值」
// 是正当写法,故只统计不断言):它们逐一来自上游两份主题的同一处色值,而那两份实测
// 逐条不同。哪天上游让某个语义两档同色,这条会红 —— 那时该改的是这条断言,不是去写
// 一条两半逐字相同的 light-dark()。
const hljsDecls = themedDecls.filter((d) => d.name.startsWith('--hljs-'));
const singleValued = hljsDecls.filter((d) => !DUAL_VALUE.test(d.value)).map((d) => d.name);
if (hljsDecls.length === 0) {
  failures.push('产物里一个 --hljs-* 定义都没有 —— hljs-theme.css 没被打进来,语法高亮会整片没颜色');
} else if (singleValued.length > 0) {
  failures.push(
    `${singleValued.length}/${hljsDecls.length} 个 --hljs-* 只有单值:${singleValued.slice(0, 6).join(', ')}${singleValued.length > 6 ? ' …' : ''} —— 它在另一档下不翻,而当前这一档看着完全正常`,
  );
} else {
  notes.push(`hljs token:${hljsDecls.length} 个,全部是 light-dark() 双值`);
}

const dual = themedDecls.filter((d) => DUAL_VALUE.test(d.value));
const dualNames = new Set(dual.map((d) => d.name));
notes.push(
  `VS Code token:${dual.filter((d) => d.name.startsWith('--color-')).length} 个深浅双值(其余为深浅共用同一取值)`,
);

// --- 6d. 双值 token 没有被塞进 color-mix() --------------------------------
// 即 Tailwind 的不透明度修饰符(`bg-editor-background/50` → color-mix())。降级后的双值
// 是一段 token 流而不是一个合法 <color>,进 color-mix() 整条声明在解析期作废、属性
// 静默变 unset。名单直接用上面算好的 dualNames —— 单值 token 没有这个问题,
// 按名字一刀切会把完全正当的 `bg-warning-border/50` 也拦下来。
//
// 结果按**声明序**输出(而不是产物里的出现序),报错信息才稳定。
const mixedRefs = new Set([...css.matchAll(/color-mix\([^;{}]*/g)].flatMap((m) => varRefsIn(m[0])));
const mixed = [...dualNames].filter((name) => mixedRefs.has(name));
if (mixed.length > 0) {
  failures.push(
    `${mixed.length} 个深浅双值 token 出现在 color-mix() 里:${mixed.join(', ')} —— 多半是给它带了不透明度修饰符(如 bg-x/50),那条声明会在解析期整条作废、属性静默变 unset`,
  );
} else {
  notes.push(`不透明度修饰符:${dualNames.size} 个双值 token 没有一个被塞进 color-mix()`);
}

// --- 3/4. hljs 规则全部走 token,且每个 token 都被用到 ---------------------
// 从前这里查的是"深浅两套选择器集合完全相等",那条随着两份上游主题被合成一份而失去
// 对象。接手的两条各自盯着一种抄写事故。
const HARDCODED_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|color-mix)\(/;
const hardcoded = hljsRules.filter((b) => HARDCODED_COLOR.test(textOf(b)));
if (hljsRules.length > 0) {
  if (hardcoded.length > 0) {
    failures.push(
      `${hardcoded.length}/${hljsRules.length} 条 hljs 规则里有硬编码颜色(如 "${normalize(firstOf(hardcoded).prelude).slice(0, 60)}")—— 深浅切换发生在 token 层,写死的那条在另一档下静默停在错的颜色上`,
    );
  } else {
    notes.push(`hljs 规则:${hljsRules.length} 条,颜色全部走 var(--hljs-*)`);
  }

  // 定义了却没人用 = 抄漏了它对应的那条规则。第 5 条查不到:它查的是引用侧的孤儿,
  // 而这里是**声明侧**的孤儿 —— 语法上完全合法,页面上那一类词恰好没有颜色。
  const hljsUsed = new Set(hljsRules.flatMap((b) => varRefsIn(textOf(b), '--hljs-')));
  const unused = [...new Set(hljsDecls.map((d) => d.name))].filter((n) => !hljsUsed.has(n));
  if (unused.length > 0) {
    failures.push(
      `${unused.length} 个 --hljs-* 定义了却没有任何 hljs 规则引用:${unused.join(', ')} —— 多半是抄漏了它对应的那条规则,那一类词在页面上没有颜色`,
    );
  } else {
    notes.push(`hljs token:${hljsUsed.size} 个被规则引用,没有孤儿定义`);
  }
}

for (const note of notes) console.log(`PASS  ${note}`);
for (const failure of failures) console.error(`FAIL  ${failure}`);

if (failures.length > 0) {
  process.exit(1);
}
