// highlight.js 的按需装配。
//
// 只引 lib/core，再逐个显式注册语言——清单即白名单，增删语言就是增删体积，这正是放弃
// diff2html 预构建 bundle 换来的可控性。JS 体积门禁的主导项就是这张表(22 个模块 ESM 明文
// 合计 225.6 KB)，要压体积第一刀砍这里。
//
// 别名不是模块，不得单独 import:jsx / mjs / cjs → javascript,tsx / ts → typescript，
// toml → ini,html → xml。`registerLanguage` 注册主模块时别名一并生效；而
// highlight.js/lib/languages/{jsx,tsx,toml} 三个路径实际不存在，写了会在构建期 resolve 失败。
//
// plaintext 是兜底、不是语言，但**必须一起注册**：diff2html 对未知扩展名(以及 LICENSE /
// Dockerfile 这类无扩展名文件)会把语言改写成字面量 'plaintext' 再无条件调 hljs.highlight；
// lib/core 不自带它，漏注册就抛 Unknown language，异常冒到调用方后**整个 diff 视图渲染失败**，
// 而不是那一个文件退化。

import { getLanguage as upstreamExtensionLanguage } from 'diff2html/lib-esm/ui/js/highlight.js-helpers.js';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  plaintext,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
} as const;

let registered = false;

/** 返回注册好语言子集的 hljs 实例；清单外的语言退化为 plaintext（见上，该退化依赖显式注册）。 */
export function getHljs(): typeof hljs {
  if (!registered) {
    for (const [name, definition] of Object.entries(LANGUAGES)) {
      hljs.registerLanguage(name, definition);
    }
    hljs.configure({ ignoreUnescapedHTML: true });
    registered = true;
  }
  return hljs;
}

/** 注册清单，供单测对着校验（体积门禁是零依赖 JS，读不到这里）。 */
export const REGISTERED_LANGUAGES = Object.keys(LANGUAGES);

/**
 * 单文件组件（`.vue` / `.svelte` / `.astro`）：一份文件里有三种语言，靠区块标签分界。
 *
 * **这是那三个扩展名的唯一一份名单**——下面的补漏表把它们展开成 `→ xml`，`createLineLanguage()`
 * 用它决定要不要跑区块状态机。别的文件从头到尾一种语言，多跑一次正则是白费。
 */
const SFC_EXTENSIONS = new Set(['vue', 'svelte', 'astro']);

/**
 * 扩展名 → 语言名的**补漏表**，只装 hljs 自己认不出来的那几个。
 *
 * **不要在这里重建一张完整映射**：上面那 22 个模块各自带 `aliases`，`getLanguage()` 会走它
 * ——`ts` / `tsx` / `mts` / `cts` / `jsx` / `mjs` / `cjs` / `py` / `rb` / `rs` / `sh` / `zsh` /
 * `yml` / `md` / `cc` / `hpp` / `toml` / `jsonc` / `svg` / `html` 全都直接命中。手写一张全表等
 * 于把语言清单抄第二遍，而**增删一个模块时那份抄件不会有任何东西提醒你改**。
 *
 * **值只能是上面注册过的那 22 个名字**：映射到别的名字时 `getLanguage()` 探测不到，那个文件
 * 静默退回 plaintext——看上去与压根没映射一模一样（`hljs.test.ts` 钉着这条）。
 *
 * `vue` / `svelte` / `astro` / `xaml` 走 `xml`、`env` 那一族走 `ini`，都是因为 highlight.js
 * 上游**没有**对应模块（社区包才有），而这两个模块拿到的效果已经足够：SFC 的模板标签、属性、
 * `{{ }}` 全部着色；`.env` 那一族的语法本就是 `KEY=value` 加 `#` 注释。
 *
 * **`<script>` / `<style>` 里那两段不靠这个映射**：xml 模块确实把它们交给 javascript / css 子
 * 语言，但那要**整块正文一次高亮**才成立（文件视图正是那样），而 diff 视图是逐行高亮、跨行状
 * 态一律不保留——那一侧靠下面的 `createLineLanguage()` 自己按区块换语言。
 *
 * **第三道判得对的一律不收**（`pyi` / `jsonl` / `rake` 这类「已有模块、只是别名没覆盖到」的，
 * 以及 `cfg` 这类上游本来就映到同一个语言的）——收进来只是把上游那张表抄了一行，`hljs.test.ts`
 * 有一条对着这个判据校的用例。
 */
export const EXTRA_ALIASES: Record<string, string> = {
  // 三个 SFC 扩展名由 SFC_EXTENSIONS 展开，**不在这里再抄一遍**：两份名单谁改了谁没改，
  // 症状是那个扩展名要么有颜色但不换区块语言、要么反过来，两样都不报错
  ...Object.fromEntries([...SFC_EXTENSIONS].map((ext) => [ext, 'xml'])),
  conf: 'ini',
  editorconfig: 'ini',
  env: 'ini',
  htm: 'xml',
  properties: 'ini',
  // xaml 同样是 xml，但它**不是**「脚本 + 样式 + 模板」三段式，故不进区块状态机
  xaml: 'xml',
};

/**
 * 按**整个文件名**判的唯一一条规则：`.env.local` / `.env.production` 的「扩展名」是 `local` /
 * `production`，上面那张表够不着。
 *
 * **后面只许再跟一段、且那一段不含点**：写成 `(\..+)?` 会把 `.env.d.ts` 也判成 ini——它是
 * TypeScript，而这条规则本来只想接住 dotenv 那种「一个环境名」的后缀。
 *
 * **不为它铺一张「文件名 → 语言」的表**——只有一个实例时，表与遍历只是一层间接；`Dockerfile` /
 * `Makefile` / `.gitignore` 这些无扩展名文件在上游对应的模块我们没注册，写了规则也只是绕一圈回
 * 到 plaintext，真正的口子在「要不要加模块」。有第二条时再升级成表。
 */
const DOTENV_FILE = /^\.env(\.[^.]+)?$/;

/**
 * 「这个名字是注册过的语言吗」——是就原样返回，不是返回 null。
 *
 * **必须先验 `typeof` 再问 hljs**：两张表（我们的 `EXTRA_ALIASES` 与 diff2html 的
 * `languagesToExt`）都是对象字面量，`表[ext]` 会走到 `Object.prototype` 上去——`a.constructor`
 * 这样的文件名取出来的是**构造函数**，而 `hljs.getLanguage()` 对它当场抛
 * `(name || "").toLowerCase is not a function`（实测）。异常从这里冒上去炸的是整个 diff 视图或
 * 文件面板，而这两条路径的入参是**文件名与文件内容**，不是我们自己写死的字面量。
 */
function registeredLanguage(name: unknown): string | null {
  // 空串不必单独挡：`getLanguage('')` 返回 undefined，不抛（实测）
  return typeof name === 'string' && getHljs().getLanguage(name) ? name : null;
}

/**
 * 一条路径的扩展名（小写，不含点；没有就是空串）。
 *
 * **先剥目录再取点**：`src/v1.2/Makefile` 的扩展名是空串，不是 `2/Makefile`。判定语言与判定
 * 「是不是 SFC」两处都要用它——各写一份时两处对「扩展名」的定义就只是碰巧一致。
 */
function extensionOf(path: string): string {
  const base = basenameOf(path);
  // 点开头的文件按「点后面那一段」取，与 diff2html 的取法一致（`.env` 的扩展名就是 `env`）
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/** 路径的最后一段。**分隔符只认 `/`**：协议里的路径一律是 git 给的 POSIX 形式。 */
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * 一条路径该用哪个语言高亮。**两个视图共用这一条**——diff 视图（`render.ts` 的
 * `highlightLines()` 逐行判）与文件视图（`FileView` 整份判）各写一份的症状是同一个文件在一边
 * 有色、另一边没色，两处都不报错。
 * 清单在本文件，解析也就该在本文件：放到组件里的话，那张表与它依赖的注册清单会隔着两层目录
 * 各活各的。
 *
 * **必须先 `getLanguage()` 探一下**：`highlight()` 传一个没注册的语言名会**抛**，而文件视图
 * 那侧没有 diff2html 兜底，异常冒上去炸的是整个面板。取不到一律退回 `plaintext`（它随那 22
 * 个模块一起注册着，正是为这类兜底）。
 */
export function languageOf(path: string): string {
  if (DOTENV_FILE.test(basenameOf(path))) return 'ini';
  const ext = extensionOf(path);
  // 我们的补漏表与 hljs 自带别名先来：`properties` 这类两边都认的，得按我们的判（上游把它映
  // 到同名的 `properties` 模块，而那个模块我们没注册，让给上游等于让它退回 plaintext）
  const own = registeredLanguage(EXTRA_ALIASES[ext] ?? ext);
  if (own !== null) return own;
  // 最后一道是 diff2html 那张 `languagesToExt`。**它随 `diff2html-ui-base` 早就在产物里**，接
  // 过来体积是 0，而实测它比「我们的表 + hljs 别名」多认 88 个扩展名（`pyi` / `jsonl` / `rake`
  // / `mysql` / `es6` …）。抄一份进上面那张表才是真花钱的做法，且抄件不会跟着上游更新
  return registeredLanguage(upstreamExtensionLanguage(ext)) ?? 'plaintext';
}

/** 区块起始标签：`<script setup lang="ts">` / `<style scoped>` / `<template>`。 */
const BLOCK_OPEN = /^\s*<(script|style|template)\b([^>]*)>/;
/** 区块结束标签。结束之后回到 `xml`——SFC 的顶层就是标签。 */
const BLOCK_CLOSE = /^\s*<\/(script|style|template)\s*>/;
/** `lang="ts"` / `lang='scss'`。 */
const BLOCK_LANG = /\blang\s*=\s*["']([\w-]+)["']/;

/** 区块默认语言；`lang` 属性判不出东西时退回这里。 */
const BLOCK_DEFAULT: Record<string, string> = {
  script: 'javascript',
  style: 'css',
  template: 'xml',
};

/** 一个区块标签行说的是「**下一行起**用什么语言」。标签行自己永远是 `xml`。 */
function blockLanguage(tag: string, attributes: string): string {
  const lang = BLOCK_LANG.exec(attributes)?.[1];
  // lang 走的是同一条 languageOf——`ts` → typescript、`scss` → scss 都由它认。判不出来
  // （`lang="pug"` 这类我们没注册的）时退回区块默认值，而不是退回 plaintext：那会把一段本
  // 来还能按 xml 上色的模板整个抹白
  const fallback = BLOCK_DEFAULT[tag] ?? 'xml';
  const resolved = lang === undefined ? 'plaintext' : languageOf(`x.${lang}`);
  return resolved === 'plaintext' ? fallback : resolved;
}

/**
 * 造一个**逐行**的语言判定器：`(这一行的文本) => 这一行该用的语言`。
 *
 * **为什么是逐行而不是整份**：diff2html 的高亮是一行一次 `hljs.highlight()`，跨行的语法状态一
 * 律不保留——于是 SFC 在 `xml` 下只有模板那段有色，`<script>` / `<style>` 里的行一个 span 都
 * 拿不到（实测：`import { ref } from 'vue'` 按 xml 高亮的输出里没有任何标签）。判定器自己按
 * 区块标签记住「现在在哪一段」，把那两段换成 javascript / css。
 *
 * **状态从 `xml` 起，且只认看得见的标签**：diff 给的是片段，hunk 里可能压根没有区块起始行
 * （只改了 `<script>` 中间几行）。那时保守停在 xml——与改动前一样没有颜色，而不是猜错语言把
 * 一段模板按 JS 乱着色。看得见起始标签的那些 hunk（以及整份新增的文件）则完全生效。
 *
 * **每个「行序列」各要一个**：并排版式下左右两栏各是一棵独立的行序列（旧文件序 / 新文件序），
 * 共用一个判定器会让左栏的 `</script>` 把右栏的状态也关掉。
 */
export function createLineLanguage(path: string): (lineText: string) => string {
  const base = languageOf(path);
  if (!SFC_EXTENSIONS.has(extensionOf(path))) return () => base;

  let current = base;
  return (lineText) => {
    const close = BLOCK_CLOSE.exec(lineText);
    if (close) {
      current = base;
      // 结束标签行自己按 base（xml）高亮：它是标签，不是被它括起来的那段代码
      return base;
    }
    const open = BLOCK_OPEN.exec(lineText);
    if (open) {
      const tag = open[1] ?? '';
      // **同一行就闭合的不算进入区块**：Vue 的外置块写法 `<script src="./App.js"></script>`、
      // `<template src="./tpl.html"></template>` 都是一行开闭。漏了这一条时状态再也回不来，
      // 那之后的每一行——模板、样式全在内——都按 JS 高亮，正是这份注释说要避免的「猜错」
      current = lineText.includes(`</${tag}`) ? base : blockLanguage(tag, open[2] ?? '');
      return base;
    }
    return current;
  };
}
