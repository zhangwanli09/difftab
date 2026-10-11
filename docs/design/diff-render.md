# diff 渲染：diff2html 与语法高亮

> 一份 unified diff 文本怎么变成页面上那块带高亮的 HTML。组件与骨架在 [`web.md`](web.md)，配色与层叠隔离在 [`style.md`](style.md)，选型与被排除的做法见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)，门禁见 [`../gates.md`](../gates.md)。

[diff2html](https://github.com/rtfpessoa/diff2html) 解析 `git diff` 的 unified diff 文本渲染为 HTML，[highlight.js](https://highlightjs.org/) 做语法高亮。所有资源随包本地分发，**不走 CDN**——工具必须离线可用。

**按需 import + 显式注册 hljs 语言子集，不使用任何 diff2html 预构建 UI bundle**（`diff2html-ui.min.js` / `-slim` / `-base` 三个都不用）。**被排除的是三个预构建 bundle，不是 UI 层源码**——深导入 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 与同目录的 `highlight.js-helpers.js` 参与 tree-shaking、hljs 实例由我们注入，是允许且推荐的。

- **高亮是一行一次 `hljs.highlight()`**：`highlight.js-helpers` 的 `closeTags` / `nodeStream` / `mergeStreams` 把高亮结果与行内已有的 `<del>` / `<ins>` 词级标记交织回同一行、补齐被切断的标签。**跨行的语法状态一律不保留。** 禁止自行重写这三个切分函数。
- `draw()` 是 `innerHTML` 赋值 + 命令式绑定事件，**必须放在 Preact 的 ref/effect 之后**，不与 vdom 争同一棵子树。
- 用不到的开关一律关掉：`fileListToggle` / `fileContentToggle` / `stickyFileHeaders` / `highlight` 全部 `false`，打开的只有 `synchronisedScroll`。
- **`synchronisedScroll: true` 管的是并排两侧的横向联动**：两半各是一个独立的横向滚动容器，不联动时横滚一侧看长行，同一行的新旧内容错开——并排存在的理由正好在需要横滚时失效。逐行版式下它是空操作，两种版式共用一份配置。监听器绑在每次 `draw()` 新写出的节点上，重画不叠加。**已知取舍**：两侧滚动上限不等时边界处顿一下；换掉它要自研一份带回声抑制的联动，排除理由见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)。
- **`highlight: false`，高亮整个归我们自己那个循环（`render.ts` 的 `highlightLines()`）**：上游的 `highlightCode()` 对一个文件只认一个语言，而单文件组件一份文件里有三种。
- **高亮只做一遍**：两条同时开时第二遍的 `nodeStream` 拿到的已是第一遍的 `hljs-*` span，结果是嵌套重复的 span，开销也翻倍。禁再开 `highlight` 或调 `highlightCode()`。
- **自研的只有「这一行用哪个语言」**（`hljs.ts` 的 `createLineLanguage()`），切分仍是上游那三个导出原样调用。
- **`colorScheme` 传 `'light'`，不传 `'auto'`**（理由见 [`style.md`](style.md)）。**明暗开关不进 `draw()` 的依赖数组**：主题整个发生在 CSS 变量上，为它重跑 `draw()` 是白付一次全量高亮。

## 文件头整条不显示

diff2html **没有**关掉文件头（`.d2h-file-header`）的配置项，只能落在样式那侧的一条 `display: none`（见 [`style.md`](style.md) 的「四条选择器规则的例外」）。

- 头里四样：文件图标、文件名、`CHANGED` / `RENAMED` 标签、一个已经失效的「Viewed」复选框。前两样与标签栏重复，重命名由 `RenameNotice` 说得更全——**藏掉它页面上不掉任何信息**。
- **`+N` / `-M` 增删统计不在这条头里**：它属于文件列表模板，而我们传 `drawFileList: false`。difftab 至今没在页面上给过增删行数，藏掉文件头不等于放弃了统计。

## 版式按面板宽度自动切

面板宽度 < 1024px 给 `line-by-line`，否则 `side-by-side`。**1024 是按 diff2html 的字体与行号槽宽算出来的**（并排每侧约剩 50 个等宽字符），与 Tailwind 的 `lg` 相同纯属巧合。以下几条都属「违反后不报错」：

- **判据是 diff 面板自身的宽度，不是视口宽度**：按视口判等于把侧栏宽度在 CSS 之外再写一遍，侧栏一改阈值就静默错位——而侧栏现在还能拖。
- **量的是面板那一层（`<section>`），不是里面那层滚动容器**：换格式 → 内容高度变 → 竖直滚动条进出 → 内层宽度抖十几像素，阈值附近两种格式来回重画。面板自己不滚，宽度不随滚动条变。
- **border box 那两处仍显式写**（`observe(el, { box: 'border-box' })` + `entry.borderBoxSize[0].inlineSize`）：滚动条是从 content box 里扣的，这一层哪天加了 `overflow` 或内边距，默认观察就把抖动请回来；只在读值那侧挑滤的是已产生的回调，指定观察 box 才是从源头不投递。
- **量法与阈值同住 `state/layout.ts` 的 `observeDiffPanel()`**：阈值的正确性全靠送进来的是 border box，而这件事没有门禁强制得了，拆到两个文件里就让其中一半失去说明。
- 格式是一个 `computed`，靠 `Object.is` 去重，只有真跨过阈值才通知下游。贴着阈值来回蹭时每跨一次仍是一次 `draw()`——不为此加迟滞，那会把纯派生量变成第二份状态。
- **格式必须进 `DiffView` 那个 effect 的依赖数组**：`draw()` 是命令式的，不重跑就停在旧格式上——只是拖窗口没反应。
- 两种格式共用同一套 `--d2h-*` 覆写，无需分叉。
- 首版**不做版式的手动切换开关**：自动判据已覆盖「放不放得下」这个唯一的真实诉求。

## hljs 语言清单

`import hljs from 'highlight.js/lib/core'`，再**逐个显式注册** **22 个语言模块**：`javascript` / `typescript` / `json` / `css` / `scss` / `xml` / `markdown` / `python` / `go` / `rust` / `java` / `kotlin` / `swift` / `c` / `cpp` / `csharp` / `bash` / `yaml` / `ini` / `sql` / `php` / `ruby`。注册清单是白名单，增删语言即增删体积。

- **别名不是模块，不得单独 import**：`jsx` 属 `javascript`、`tsx` 属 `typescript`、`toml` 属 **`ini`**、`html` 属 `xml`。`highlight.js/lib/languages/{jsx,tsx,toml}` 不存在，写了构建期 resolve 失败。
- **`plaintext` 必须与这 22 个一起注册，它是兜底而非语言**：`lib/core` 不自带它，漏注册时 `hljs.highlight()` 抛 `Unknown language: "plaintext"`，**整个 diff 视图渲染失败**——diff 里出现 `LICENSE` / `Dockerfile` / `.txt` 即触发。
- 配色 CSS 不来自 highlight.js，与语言清单增删互不影响（见 [`style.md`](style.md)）。
- diff2html 的传递依赖 `@profoundlogic/hogan` 只有 CJS 入口，靠打包器的 CJS 互操作，不会被 tree-shake。

## 扩展名 / 文件名 → 语言的补漏表

**两个视图共用 `languageOf(path)`（`src/web/diff/hljs.ts`），它是全项目唯一一条语言判据。** 各写一份的症状是同一个文件在 diff 里有色、在文件视图里没色。

- **判定是三道，顺序不能换**：我们的补漏表 → hljs 模块自带的 `aliases` → diff2html 那张 `languagesToExt`（每道结果都要过 `getLanguage()`），全落空才是 `plaintext`。**第三道不能砍、也不许抄成自己的表**：它随 `diff2html-ui-base` 早就在产物里、体积为 0，实测比前两道多认 88 个扩展名（`pyi` / `jsonl` / `rake` …），砍掉后它们静默变纯文本；抄件则不会跟上游更新。
- **第三道排在最后**：`properties` 这类两边都认的得按我们的判——上游映到一个我们没注册的模块。
- **表里的值只允许是那 22 个已注册模块**，映射到别的名字静默退回 plaintext。
- **表里查出来的东西要先验 `typeof`**：两张表都是对象字面量，`a.constructor` 这样的文件名会取出**构造函数**，`getLanguage()` 对它当场抛，炸的是整个视图。
- **只补后两道都接不住的那几个，不重建全表**：
  - **`vue` / `svelte` / `astro` / `xaml` → `xml`**：上游没有这些模块，`xml` 已足够（SFC 的另两段见下一节）。
  - **`env` / `conf` / `properties` / `editorconfig` → `ini`**：语法就是 `KEY=value` + `#` 注释。`cfg` 不在表里——第三道已映到 `ini`（`hljs.test.ts` 逐条校）。
  - **`.env.local` 这类多段名按文件名规则命中**，规则只有 `.env` 一条；`Dockerfile` / `Makefile` 对应的模块没注册，写规则也只是绕回 plaintext。

## 单文件组件的区块高亮

`.vue` / `.svelte` / `.astro` 一份文件里有三种语言。**只判成 `xml` 不够**：xml 模块把 `<script>` / `<style>` 交给子语言，要**整块正文一次高亮**才成立——文件视图是那样，而 diff 视图是一行一次。实测按 `xml` 逐行高亮：

```
"<template>"                → <span class="hljs-tag">…      有色
"import { ref } from 'vue'" → import { ref } from 'vue'      一个 span 都没有
"  max-width: 1024px;"      →   max-width: 1024px;           一个 span 都没有
```

症状是「模板那段有色、`<script>` 与 `<style>` 整块白」，不报错。因此 diff 侧用逐行区块状态机：

- **状态机在 `hljs.ts`（`createLineLanguage()`），DOM 操作在 `render.ts`（`highlightLines()`）**。
- **区块标签行自己按 `xml` 判**；`lang="ts"` / `lang="scss"` 走同一条 `languageOf()`，判不出来时退回区块默认值（script→javascript / style→css / template→xml），**不退回 plaintext**。
- **看不见起始标签的 hunk 保守停在 `xml`**：只改了 `<script>` 中间几行时判定器没见过 `<script>`，宁可没颜色也不猜。
- **一行开闭的区块不算进入区块**（`<script src="…"></script>`、一行写完的 `<style>`）：漏判时状态回不来，之后每一行都按 JS 高亮。
- **一张 `.d2h-diff-table` 一个判定器**：状态属于一条连续的行序，并排版式下左右各一条。

## 产物体积门禁

门禁值为预算而非承诺。**主导项是语言清单**：要压体积第一刀砍它，要加语言先看这张表还剩多少。

| 产物 | 门禁 | 当前实测 |
|---|---|---|
| 前端 JS（明文） | ≤ 350 KB | 241.3 KB |
| 前端 JS（gzip） | ≤ 120 KB | 81.0 KB |
| 前端 CSS（明文，含 `diff2html.min.css` + 自建 hljs 主题 + Tailwind 产物） | ≤ 48 KB | 38.6 KB |
| 前端 CSS（gzip） | ≤ 10 KB | 7.5 KB |

**CSS 与 JS 一样明文、gzip 两道并卡**（理由见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)）。单次小幅增量两道都够不着，review 时看一眼 `dist/web/app.css` 的增量。
