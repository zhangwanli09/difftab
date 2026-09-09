# diff 渲染：diff2html 与语法高亮

> 一份 unified diff 文本怎么变成页面上那块带高亮的 HTML。组件与骨架在 [`web.md`](web.md)，配色与层叠隔离在 [`style.md`](style.md)，选型与被排除的做法见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)，门禁见 [`../gates.md`](../gates.md)。

[diff2html](https://github.com/rtfpessoa/diff2html) 直接解析 `git diff` 的 unified diff 文本渲染为带高亮的 HTML，配合 [highlight.js](https://highlightjs.org/) 做语法高亮。所有资源随包本地分发，**不走 CDN**——工具必须离线可用。

**按需 import + 显式注册 hljs 语言子集，不使用任何 diff2html 预构建 UI bundle**（`diff2html-ui.min.js` / `-slim` / `-base` 三个都不用）。

- `import { html } from 'diff2html'`——只引入 unified diff parser 与 renderer，其余由 tree-shaking 移除。
- **`html()` 不做语法高亮。** 高亮是**一行一次** `hljs.highlight()`——`highlight.js-helpers` 的 `closeTags` / `nodeStream` / `mergeStreams` 处理的是**行内**已有的 `<del>` / `<ins>` 词级标记：把高亮结果与那份标记两股流交织回同一行、补齐被切断的标签。**跨行的语法状态一律不保留**（这条从前在本文档里被写成「先把整个文件的代码合起来再按行切回」，与源码不符，实测已更正）。**被排除的是三个预构建 bundle，不是 UI 层的源码**——深导入 ESM 模块 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 与同目录的 `highlight.js-helpers.js` 参与 tree-shaking、hljs 实例由我们注入，是允许且推荐的。自行重写那三个切分函数不在本项目要解决的问题之列。
- `draw()` 内部是 `innerHTML` 赋值 + 命令式绑定事件，**必须放在 Preact 的 ref/effect 之后**，不与 vdom 争夺同一棵子树（列表由 Preact 管，单文件 diff 容器由 `Diff2HtmlUI` 管）。
- 用不到的开关一律关掉：`fileListToggle` / `fileContentToggle` / `stickyFileHeaders` 全部 `false`；打开的只有 `synchronisedScroll`（`highlight` 也是 `false`，理由见下一条）。
- **`synchronisedScroll: true` 管的是并排两侧的横向联动。** 两半各是一个独立的滚动容器（`.d2h-file-side-diff{overflow-x:scroll;overflow-y:hidden;width:50%}`），不联动时横向拖一侧去看长行、另一侧原地不动，同一行的新旧内容错开成两个列位置——并排存在的理由（同一行左右对照）正好在需要横滚时失效。
  - 实现是 `draw()` 里按 `.d2h-file-wrapper` 取出那对 `.d2h-file-side-diff`，两侧的 `scroll` 事件互相回写 `scrollLeft` / `scrollTop`（竖向恒为 0——两侧都是 `overflow-y: hidden`，整页的竖滚归外面那个面板）。
  - **逐行版式下 `.d2h-file-side-diff` 一个都没有，这一步是空操作**：两种版式共用同一份配置，不必按 `outputFormat` 分叉。
  - **监听器绑在 `draw()` 刚写出来的节点上，而每次 `draw()` 整片覆盖 `innerHTML`**：旧节点连同监听器一并被丢掉，重画不叠加，也不需要自己解绑。
  - **已知取舍：两侧滚动上限不等时，边界处会顿一下。** 上限由各自最长行决定，通常不等；越过窄侧上限的那一下，窄侧被夹住后仍冒出一次 `scroll` 事件，把宽侧回写到窄侧的上限，之后继续正常滚。（新增文件那种「左侧全是空占位、上限为 0」的情况反而没事：左侧写不动，不产生事件，也就不回写。）换掉它要自研一份带回声抑制的联动，排除理由见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)。
- **`highlight: false`，高亮整个归我们自己那个循环（`render.ts` 的 `highlightLines()`）。** 上游的 `highlightCode()` 对一个文件只认一个语言（`.d2h-file-wrapper` 上的 `data-lang`），而单文件组件一份文件里有三种——见下面「单文件组件的区块高亮」。
- **高亮只做一遍**：两条同时开（`highlight: true` 之后再走一遍我们的循环）时，第二遍读到的 `textContent` 仍是纯文本，但 `nodeStream(line)` 拿到的已是第一遍插入的 `hljs-*` span，`mergeStreams` 把两份流交织进同一行——结果是嵌套重复的 span，且高亮开销白付一倍。
- **自研的只有「这一行用哪个语言」，切分仍是上游那三个导出**（`closeTags` / `nodeStream` / `mergeStreams` 原样调用）。语言判定器由 `hljs.ts` 的 `createLineLanguage()` 给，两个视图因此仍共用同一条 `languageOf(path)`。
- **`colorScheme` 传 `'light'`，不传 `'auto'`**——深浅切换由我们覆写的 `--d2h-*` 承担，理由见 [`style.md`](style.md) 的「为什么 `colorScheme` 传 `'light'`」。**顶栏那个明暗开关不改这一条**，也不进 `draw()` 的依赖数组：主题整个发生在 CSS 变量上，diff2html 不参与，为它重跑一次 `draw()` 是白付一次全量高亮。

## 文件头整条不显示

diff2html **没有**关掉自带文件头（`.d2h-file-header`）的配置项（上面那三个关掉的开关管的是文件列表折叠、文件内容折叠与吸顶，头照画），这件事只能落在样式那侧的一条 `display: none`（规则本身与它的三处讲究在 [`style.md`](style.md) 的「四条选择器规则的例外」）。

- 头里只有四样：文件图标、文件名、`CHANGED` / `RENAMED` 之类的标签、一个在 `fileContentToggle: false` 下已经是死的「Viewed」折叠复选框。前两样与 `DiffView` 自己那行标题重复，第三样里唯一有信息量的重命名已由 `RenameNotice` 说得更全（带完整旧路径与相似度）——**四样合起来，藏掉它页面上不掉任何信息**。
- **`+N` / `-M` 那对增删统计不在这条头里**：它属于文件列表模板，而我们传 `drawFileList: false`，那份列表从来没画过。特意写下这条是因为它太容易被想当然（GitHub 的文件头上就有那对数字）——藏掉文件头**不等于**放弃了统计，difftab 至今就没在页面上给过增删行数。

## 版式按面板宽度自动切

面板宽度 < 1024px 给 `line-by-line`，否则 `side-by-side`。**1024 是按 diff2html 的字体与行号槽宽算出来的**（约当并排每侧只剩 50 个等宽字符，正是多数源码行开始要横向滚的地方），**与 Tailwind 的 `lg` 数值相同纯属巧合**：那是视口断点，这里是面板宽度。以下几条都属「违反后不报错」：

- **判据是 diff 面板自身的宽度，不是视口宽度**。侧栏固定 `w-80`（320px）且 `shrink-0`，面板宽度恒等于「视口 − 320」；按视口判等于把这个常数在两处各写一遍，而侧栏宽度将来一改，阈值就静默错位到别的地方去了。
- **量的是面板那一层（`<section>`），不是它里面那层滚动容器**：换格式会改变内容高度 → 竖直滚动条出现/消失 → 那一层的 content box 宽度抖十几个像素，阈值附近于是在两种格式之间来回重画。面板自己不滚（标题栏排在滚动容器之外，见 [`web.md`](web.md) 的「选中态与右侧面板」），它的宽度不随滚动条进出而变。
- **border box 那两处仍显式写**（`observe(el, { box: 'border-box' })` + `entry.borderBoxSize[0].inlineSize`）：**滚动条是从 content box 里扣的**，而这一层哪天又拿回 `overflow` 或添上内边距，默认的 content-box 观察就把上面那条抖动原样请回来；只在读值那侧挑则滤掉的是**已经产生的**回调噪声，指定观察 box 才是从源头不投递。
- **量法与阈值同住 `state/layout.ts` 的 `observeDiffPanel()`**，`App.tsx` 只管「量哪个元素、什么时候开始和停」：阈值的正确性全靠「送进来的是 border box」，而这件事没有任何门禁强制得了（happy-dom 没有布局引擎），拆到两个文件里就等于让其中一半失去说明。
- 格式本身是个 `computed`，靠 signals 的 `Object.is` 去重——拖窗口每像素写一次宽度，只有**真跨过阈值**那一次会通知下游。**去重封的是「每像素一次」而不是「每次跨越一次」**：贴着阈值来回蹭，每跨一次仍是一次完整的 `draw()`。不为此加迟滞或 debounce 是有意的——那要存一份「上一次是哪种版式」，把纯派生量变成第二份状态，而换来的只是一个转瞬即逝的动作下的顺滑。
- **格式必须进 `DiffView` 那个 effect 的依赖数组**。`draw()` 是命令式的，格式变了不重跑就永远停在旧格式上——**不报错，只是拖窗口没反应**。
- **两种格式共用同一套 `--d2h-*` 覆写**，无需分叉：那对 `--d2h-change-*` 与 `--d2h-empty-placeholder-*` 只被并排视图的选择器读到，逐行视图下是失效而不是漏映射。
- 首版**不做版式的手动切换开关**：自动判据已经覆盖了「放不放得下」这个唯一的真实诉求。（顶栏那个明暗开关不是这条的反例——明暗没有等价的自动判据可用，「跟随系统」只答得了系统那一半。）

## hljs 语言清单

`import hljs from 'highlight.js/lib/core'`，再**逐个显式注册**。清单为 **22 个真实语言模块**：`javascript` / `typescript` / `json` / `css` / `scss` / `xml` / `markdown` / `python` / `go` / `rust` / `java` / `kotlin` / `swift` / `c` / `cpp` / `csharp` / `bash` / `yaml` / `ini` / `sql` / `php` / `ruby`。注册清单是白名单，增删语言即增删体积，这正是放弃预构建包换来的可控性。

- **别名不是模块，不得单独 import**——`jsx` / `mjs` / `cjs` 属 `javascript`，`tsx` / `ts` 属 `typescript`，`toml` 属 **`ini`**，`html` 属 `xml`；`registerLanguage` 注册主模块时别名一并生效。`highlight.js/lib/languages/{jsx,tsx,toml}` 三个路径实际不存在，写了会在构建期 resolve 失败。
- **`plaintext` 必须与这 22 个一起注册，它是兜底而非语言。** 「未命中的语言退化为 plaintext」不是自动发生的：`highlightCode()` 对无扩展名/未知扩展名把语言改写为字面量 `'plaintext'`，随后无条件调用 `hljs.highlight()`。而 `lib/core` **不自带** plaintext，漏注册时这一步抛 `Unknown language: "plaintext"`，异常从 `highlightCode()` 冒到调用方，**整个 diff 视图渲染失败**——不是那一个文件退化。触发条件极普通：diff 里出现 `LICENSE` / `Dockerfile` / `notes.txt` / `.lua` 即可。模块本身 318 B，对体积无影响。
- **语法高亮的配色 CSS 不来自 highlight.js**：`hljs-theme.css` 是我们自己那份（色值抄自上游 github / github-dark 两套主题，写成 `light-dark()` 的单份规则），理由见 [`style.md`](style.md) 的「hljs 主题为什么变成我们自己那份」。这里这张语言清单管的是**语言模块**，与配色无关，两者增删互不影响。
- diff2html 的两个传递依赖（`diff`、`@profoundlogic/hogan`）由打包器一并处理。注意 `@profoundlogic/hogan` 只有 CJS 入口，需打包器的 CJS 互操作，不影响可行性但也别指望它被 tree-shake。

## 扩展名 / 文件名 → 语言的补漏表

**两个视图共用 `languageOf(path)`（`src/web/diff/hljs.ts`），它是全项目唯一一条语言判据。** 各写一份的症状是同一个文件在 diff 里有色、在文件视图里没色——两处都不报错。

- **判定是三道，顺序不能换**：我们的补漏表 → hljs 模块自带的 `aliases` → diff2html 那张 `languagesToExt`（每一道的结果都要过 `getLanguage()` 才算数），全都落空才是 `plaintext`。第三道**是回收而不是新依赖**：那个模块随 `diff2html-ui-base` 早就在产物里，接过来体积是 0，而实测它比前两道多认 **88** 个扩展名（按小写扩展名去重）（`pyi` / `pyw` / `jsonl` / `geojson` / `rake` / `es6` / `mysql` / `inc` / `mdown` …）。**只查前两道等于让这 88 个在 diff 视图里从有色退回纯文本**，而页面上不会有任何提示。
- **第三道排在最后而不是最前**：`properties` 这类两边都认的得按我们的判——上游把它映到同名的 `properties` 模块，而那个模块我们没注册，让给上游等于让它退回 plaintext。
- **表里的值只允许是上面那 22 个已注册模块。** 映射到别的名字时 `getLanguage()` 探测不到，静默退回 plaintext；真要那个语言就得加模块，而那是体积门禁那一节的事。
- **表里查出来的东西要先验 `typeof`**：两张表（我们的与上游的）都是对象字面量，`表[ext]` 会走到 `Object.prototype` 上——`a.constructor` 这样的文件名取出来的是**构造函数**，`hljs.getLanguage()` 对它当场抛，异常冒上去炸的是整个 diff 视图 / 文件面板。而这两条路径的入参是文件名与文件内容，不是我们写死的字面量。
- **只装前两道都认不出、而第三道也接不住的那几个，不重建一张全表。** `pyi` / `jsonl` / `rake` 这类「模块有、只是别名没覆盖到」的，交给第三道，不要抄进来——抄件不会跟着上游更新。`ts` / `tsx` / `mts` / `cts` / `mjs` / `cjs` / `py` / `rb` / `rs` / `sh` / `zsh` / `yml` / `md` / `toml` / `svg` / `html` / `jsonc` 等已实测由模块自带的 `aliases` 命中。手写全表等于把语言清单抄第二遍，而增删模块时那份抄件不会有任何东西提醒你改。
- **`vue` / `svelte` / `astro` / `xaml` → `xml`**：highlight.js 上游**没有**这几个模块（`lib/languages/` 里查无此文件，社区包才有），而 `xml` 拿到的效果已经足够——实测一份 Vue SFC：模板标签、属性、`{{ }}` 全部着色，`<script>` / `<style>` 还会自动走 javascript / css 子语言。
- **`env` / `conf` / `properties` / `editorconfig` → `ini`**：同样没有对应模块，而这几类的语法就是 `KEY=value` + `#` 注释——实测 `.env` 走 ini 后 `KEY` 是 `hljs-attr`、`true` 是字面量，正是 VS Code 的观感。（`cfg` 不在表里：第三道自己就把它映到 `ini`，收进来只是抄了上游一行——这条判据由 `hljs.test.ts` 逐条校。）
- **`.env.local` 这类多段名靠按文件名的规则命中，不是靠扩展名**：`.env.production` 的「扩展名」是 `production`。规则只有 `.env` 这一条——`Dockerfile` / `Makefile` / `.gitignore` 这些无扩展名文件在上游对应的模块我们没注册，写了规则也只是绕一圈回到 plaintext。
- **本节存在的原因**：diff 侧的判定原先整个归 diff2html——它按「文件名最后一段」取 `data-lang` 再查 `languagesToExt`，而那张表里既没有 `vue` 也没有 `env`（`svelte` / `astro` / `htm` 同样没有），文件视图那侧又只查 hljs 别名，于是这几类文件在两个视图里都静默无色。现在那张表没有被丢掉，只是降为第三道。

## 单文件组件的区块高亮

`.vue` / `.svelte` / `.astro` 一份文件里有三种语言。**只把它判成 `xml` 是不够的**：hljs 的 xml 模块确实会把 `<script>` / `<style>` 的内容交给 javascript / css 子语言，但那**要整块正文一次高亮才成立**——文件视图（`hljs.highlight(整份正文)`）正是那样，而 diff 视图是一行一次，跨行状态不保留。实测按 `xml` 逐行高亮：

```
"<template>"                → <span class="hljs-tag">…      有色
"import { ref } from 'vue'" → import { ref } from 'vue'      一个 span 都没有
"  max-width: 1024px;"      →   max-width: 1024px;           一个 span 都没有
```

页面上的症状就是「模板那段有色、`<script>` 与 `<style>` 整块白」，不报错。因此 diff 侧自己接管那个逐行循环：

- **状态机在 `hljs.ts`（`createLineLanguage()`），DOM 操作在 `render.ts`（`highlightLines()`）**：语言的事继续只在一个文件里，渲染的事只在另一个文件里。
- **区块标签行自己按 `xml` 判**，它是标签而不是被它括起来的代码；`lang="ts"` / `lang="scss"` 走的仍是同一条 `languageOf()`（`x.<lang>` 喂进去），判不出来（`lang="pug"` 这类我们没注册的）时退回区块默认值（script→javascript / style→css / template→xml），**不是退回 plaintext**——那会把一段本来还能按 xml 上色的模板整个抹白。
- **看不见起始标签的 hunk 保守停在 `xml`。** diff 给的是片段，只改了 `<script>` 中间几行时判定器从头到尾没见过 `<script>`；那时宁可与改动前一样没颜色，也不猜——猜错的症状是一段模板被按 JS 乱着色。整份新增的文件、以及包含区块头的 hunk 都完全生效。
- **一行开闭的区块不算进入区块**：Vue 的外置块（`<script src="./App.js"></script>`、`<template src=…></template>`）与一行写完的 `<style>` 都是开闭同行。漏判时状态再也回不来，那之后每一行——模板、样式全在内——都按 JS 高亮。
- **一张 `.d2h-diff-table` 一个判定器**：状态属于一条连续的行序，并排版式下左右两栏各是一条。

## 产物体积门禁

门禁值为预算而非承诺。**主导项是语言清单**：22 个语言模块的明文体积占了预算的大头。因此后续若要压体积，第一刀砍语言清单而不是别处；若要加语言，先看这张表还剩多少。

| 产物 | 门禁 | 当前实测 |
|---|---|---|
| 前端 JS（明文） | ≤ 350 KB | 214.8 KB |
| 前端 JS（gzip） | ≤ 120 KB | 72.0 KB |
| 前端 CSS（明文，含 `diff2html.min.css` + 自建 hljs 主题 + Tailwind 产物） | ≤ 40 KB | 31.3 KB |

**CSS 是余量最紧的一行，且它对「多写几个工具类」最敏感**——加 token 时留意。
