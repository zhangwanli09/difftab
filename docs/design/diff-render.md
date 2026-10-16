# diff 渲染：解析、配对、高亮与两种版式

> 一份 unified diff 文本怎么变成页面上那块带高亮的表格。组件与骨架在 [`web.md`](web.md)，配色与层叠隔离在 [`style.md`](style.md)，选型与被排除的做法见 [`../decisions/web.md`](../decisions/web.md)，门禁见 [`../gates.md`](../gates.md)。

[diff2html](https://github.com/rtfpessoa/diff2html) **只负责解析**，[highlight.js](https://highlightjs.org/) 做语法高亮，画成表格的是我们自己的 Preact 组件。所有资源随包本地分发，**不走 CDN**——工具必须离线可用。

一份补丁走四步，前三步与版式无关：

1. **解析**（`diff/parse.ts`）：深导入 `diff2html/lib-esm/diff-parser.js` 的 `parse()`，映射成我们自己的 `Hunk` / `PatchLine`。**不经包入口 `diff2html.js`**：它连带引入两个 renderer 与 hogan 模板。没有 hunk（只改了权限位、空的新文件）是正常结果，视图画一句 `File without changes.`（忽略空白开着时另说，见下文「忽略空白」）。
2. **配对**（`diff/rows.ts`，纯函数）：一段连续删除与紧随其后的那段插入是一组，组内按下标两两配对，多出来的那侧补空位——照搬上游默认的 `matching: 'none'`，即页面上一直以来的样子。配上对的一删一增用 `diff` 包的 `diffWordsWithSpace` 算词级区间（与上游同一个函数），**任一侧超过 10000 字符就不算**（同上游 `maxLineLengthHighlight`）：它是 O(N·D)，一行压缩过的 JS 能把页面卡住好几秒。
3. **上色**（`diff/render.ts` 的 `prepareDiff()`）：一行一次 `hljs.highlight()`，**跨行的语法状态一律不保留**。词级区间先在脱离文档的元素里搭成 `<del>` / `<ins>`，再由 `highlight.js-helpers` 的 `closeTags` / `nodeStream` / `mergeStreams` 与高亮结果交织回同一行、补齐被切断的标签。**禁止自行重写这三个切分函数**，排除理由见 [`../decisions/web.md`](../decisions/web.md)。
4. **排版**（`DiffView.tsx`）：逐行版式每组先列全部删除再列全部插入，并排版式按配对一行一行排，见下文「两种版式的 DOM」。

- **结果按 `[path, patch, 忽略空白]` 缓存，版式不在依赖里**（忽略空白取这份补丁**取的时候**的那一档，不是此刻开关的值，见下文「忽略空白」）：两种版式共用同一份上色结果，拖窗口跨过阈值只是换一种排法，不重新高亮。**明暗开关也不在**：主题整个发生在 CSS 变量上。
- **整张表的 vnode 再按 `[上色结果, 版式]` 缓存**：视图订阅的是整个 `diffStates`，别的 tab 加载或关掉、SSE 重取到逐字相同的补丁都会让它重渲染；缓存命中时 Preact 拿到同一个 vnode 直接跳过，不把几万行再建一遍、比一遍。
- **表格行的 `key` 跟着行号走，不跟下标**（上下文与删除行认旧行号、插入行认新行号、并排的空位认对面那一行）：SSE 刷新时文件开头多一行，按下标比对会让其后每一行的正文都重写一遍 `innerHTML`。
- **高亮只做一遍**：上下文行两侧共用同一份 HTML。把它改成两侧各上一次色、再交织回去，产出的是嵌套重复的 span，开销也翻倍，而页面只是颜色略怪。
- **语言判定器旧侧一个、新侧一个**，各吃自己那一侧的连续行序（上下文行两侧都吃），见下文「单文件组件的区块高亮」。
- **每行正文经 `dangerouslySetInnerHTML` 写进去**：内容来自 hljs，它自己转义了正文里的一切标记；词级标签由 DOM API 搭出来，不拼字符串。

## diff2html 的触点

**JS 只许在 `src/web/diff/` 里 import `diff2html`**，而且只剩两个深导入：`diff-parser.js`（`parse.ts`）与 `ui/js/highlight.js-helpers.js`（`render.ts` 的三个切分函数、`hljs.ts` 的第三道语言判定）。CSS 一条都不引。违反时不报错，只是触点又散回各处。

- 由 `biome.json` 静态拦截：`src/web/**` 的 override 禁 `diff2html`，`src/web/diff/**` 的 override 放开它，并原样带上其余条目（替换不合并，见 AGENTS.md 红线）——**往 `src/web/**` 加新禁令时两处都要加**。
- **`diff` 由我们自己声明**（钉在与 diff2html 解析到的那份相同的版本上，升级时的核对见 [`build.md`](build.md)）；**`@profoundlogic/hogan` 仍是禁止直接引用的传递依赖**，而且已经不在产物里——它只被我们不再 import 的 renderer 用到。
- 组件只经 `diff/render.ts` 的 `prepareDiff()`、`DiffLine` / `PreparedHunk` / `DiffOutputFormat` 类型与 `diff/rows.ts` 的排版函数接触这一层。

## 两种版式的 DOM

外面一层 `font-mono text-[13px] leading-5` 的 div 在两种版式之间不换，换版式、SSE 刷新都落在同一个元素里；里面是 `[data-diff-layout]`。

- **每一侧是两张表：行号表在左、不滚，正文表装在它右边的横向滚动容器里**——横向滚动条从正文起头，横滚时正文不从行号底下滑过（照 VS Code）。两张表各标一份 `data-line`，同一行同一个值。
- **逐行**：一侧，滚动容器 `overflow-x-auto`（不交给面板），让行号与改名标注之类排在补丁上面的东西都不跟着横滚出去。行号槽 7.5em，新旧两个号各 3.5em 并列，槽 `whitespace-nowrap`——不然两个 inline-block 的号会折成两行、整行变高。
- **并排**：左旧右新两侧，正文表带 `[data-diff-side]`，各自的滚动容器 `overflow-x-scroll`；两侧行数相同、行高相同，竖直方向天然对齐。行号槽 4em，折叠行的文案与按钮只在旧侧画一次，新侧那一行留空占高。
- **行号放不下才撑宽，不裁**：3.5em / 4em 只装得下四位数，第 10000 行起会溢进旁边那格。`Patch` 把这份补丁最大行号的位数写在 `--diff-digits` 上，格宽取 `max(原宽, 位数 × 1ch + 1em)`，两侧一起变、仍然等宽。diff2html 的做法是 `overflow:hidden` 裁掉，而被裁的行号就是错的行号。
- **两张表逐行对齐全靠行高**：行号格与正文格都是 `h-5`（= `leading-5`），正文 `whitespace-pre` 不折行。空位与折叠行的格子没有字，少了 `h-5` 就塌成 0，行号从那一行起往上错；正文格里加任何会换行或比 20px 高的东西同理（emoji / CJK 回退字体的实测见 [`../decisions/web.md`](../decisions/web.md)）。
- **外层 flex 必须 `items-start`**：拉伸时行号表被撑到「正文 + 横向滚动条」那么高，多出来的高度按比例分给每一行，行号一行比一行往下错。
- **正文表 `min-w-full`**：行都比滚动容器短时也铺满，行底色画到右缘。行号表 **`border-separate`**：preflight 的合并边框模式下，行号格右边线的一半算进表格。
- 颜色机制（`--diff-tint` / `--diff-edge` 与 `diff-gutter` / `diff-code` 两个工具类）见 [`style.md`](style.md)。
- **行首记号后面带一个空格**（`- ` / `+ ` / 两个空格）：照旧的观感——diff2html 模板里记号与正文之间那个换行在 `nowrap` 下折成一个空格。记号与行号都 `select-none`，复制出来的是代码本身。
- **并排两侧横向联动**：一侧的 `scroll` 事件无条件把另一侧的 `scrollLeft` 写成同一个值，与上游 `synchronisedScroll` 同语义。**已知取舍**：没有回声抑制，两侧滚动上限不等时边界处顿一下，之后继续正常滚（排除理由见 [`../decisions/web.md`](../decisions/web.md)）。监听器在 layout effect 里绑：与元素同一次提交就绑上，中间没有一帧「滚了不跟」。
- **不画文件头**：文件名在标签栏，改名由 `RenameNotice` 说。`+N` / `-M` 增删统计 difftab 至今没在页面上给过。
- **`RenameNotice` 只说旧路径，不印相似度**（照 VS Code，它哪里都不印）：status 的 `R<score>` 量的是 HEAD→index，而补丁是 HEAD→工作区。`RM`（暂存了改名、之后又改了内容）时两者不是一回事——内容改多了 git 在补丁里甚至配不上对，下面画的是整段删 + 整段增，头上却写着「100% similar」。故 `R<score>` 在解析时就丢掉、不进协议；要从补丁头另取一个准的数是一条新的协议面，换来的只是一个 VS Code 也不给的数字。

## 没改的行：折起与展开

**补丁里不再画 `@@ -a,b +c,d @@` 那一行**：hunk 之间、第一个 hunk 之前、最后一个之后没改的行，各折成一行 `N hidden lines`（照 VS Code 的 `hideUnchangedRegions`），点一下展开**那一整段**。后端怎么给整份上下文在 [`git.md`](git.md) 的「补丁的两个可选档」。

- **起步是 3 行上下文的补丁，点开第一段时才取整份上下文**（这个 tab 从此带 `fullContext=1`，机制在 [`editors.md`](editors.md)）。不一开始就取：活动 tab 每个 SSE 都重取，整份上下文就是每次刷新发一份整文件（最多 5MB）、再全部解析一遍，而多数补丁没人去展开。
- **折叠行的位置与行数在两种补丁上必须逐行相同**（有断言）：3 行上下文时由 hunk 头算——第一段是 `旧起始行 − 1`，两段之间是「后一段的旧起始行 − 前一段的旧结束行 − 1」，算出来 ≤ 0 不画（新增文件的 `-0,0` 即此）；整份上下文时前端自己重算——离任一改动行 3 行以内的上下文可见，其余连续的那几段各折成一行，与 git 的 `-U3` 加 `--inter-hunk-context=0` 同一判据。两边差一行时，点下去那一刻整页跳一下，且点开的不是用户点的那段。
- **文件末尾那一段，3 行上下文时数不出来**：补丁里没有文件总行数。最后一个 hunk 的尾部上下文**不足 3 行**（含 0 行）即已到末尾、不画；恰好 3 行时末尾可能还有东西，画一行不带数字的 `Show remaining lines`。整份上下文回来后它要么变成 `N hidden lines`，要么消失——后者即「点了个空」，已知取舍。这条推断要成立，后端必须显式带 `--unified=3`。
- **一段的身份是它在旧侧的起始行号**，行的 `key` 写作 `g<旧起始行>`、展开了哪几段也按它记（仅 SSE 刷新与「从 3 行换成整份」两个时刻要比对）。刷新后这一段的起始行变了（它上面多了或少了几行）就重新折起——已知取舍，不为它做区间重叠的匹配。**切了忽略空白时记着的展开一律作废**：`-w` 一翻 hunk 就挪位，同一个旧侧行号可能已是另一段，不作废时那一段没人点就开着。判据是「记下展开时补丁按哪一档取」与此刻这份对不上，派生出来、不另起 effect 去清。**展开状态住在组件里**：切 tab 是卸载重挂（见 [`editors.md`](editors.md)），回来时全部折起，与「滚动位置不保留」同一个样子；整份上下文还在缓存里，再点是即时的。
- **点下去要取整份上下文时，那一行换成 `Loading…` 且不可再点**；回来后点的那一段展开，其余照旧折着。后端说过不了闸时（带着 `fullContext=1` 取回来的 `text` 是 `full: false`，tab 的上下文档随之记成 `unavailable`，见 [`editors.md`](editors.md)）**所有折叠行变成不可点的文本** `N hidden lines · too large to expand`。「这份补丁是不是整份上下文」只认 payload 的 `full`，不拿自己发出去的参数推。
- **折着的行照样解析、照样喂给语言判定器，但不上色**：hljs 只给真正画出来的行跑。区块状态机要吃整条连续行序（见下文「单文件组件的区块高亮」），而上色是逐行的、跳过不影响别的行——否则一份 4 万行的文件改一行，点开一小段要先把 4 万行全部高亮一遍。上下文行两侧共用一份 HTML 那条照旧。
- **一段展开就是整段**：不做 VS Code 那两枚「向上 / 向下再多 20 行」。整段很长时就是那么多 DOM，与看一份同样长的补丁同一个量级。
- **折叠行的正文格里是一个整宽的 `<button>`**（键盘可达，图标 Lucide `UnfoldVertical`）；行号槽不可点。底色与行号槽沿用原先 hunk 头那一行的外观（`data-line="hunk"`）。

## 忽略空白

**标签栏右端一枚开关，开了之后补丁按 `git diff -w` 取**（git 侧判据见 [`git.md`](git.md)）。默认关，全局生效、不分 tab，状态与按钮在 [`editors.md`](editors.md)。

- **默认关**：VS Code 的 `ignoreTrimWhitespace` 默认开，但 difftab 看的是 agent 的输出，而 Python、YAML、Makefile 里缩进就是语义——默认藏起来时一处改错层级的缩进在页面上不存在。
- **开着的补丁里，词级区间改用 `diffWords`（不计空白）**：一行同时改了内容与缩进时只标内容那几段。判据是这份补丁取的时候开没开，不是此刻的开关——切换之后、新补丁回来之前的那一段里，画的仍是旧补丁，用新口径算词级会让它标错。
- **零个 hunk 时按取的那一档说话**：开着是 `Only whitespace changes.`，关着照旧是 `File without changes.`。
- **上下文行在 `-w` 下显示的是新侧的正文**：并排时旧侧那几行的空白与旧文件不一致（行号是对的）。

## 版式：按面板宽度自动切，可手动固定

面板宽度 < 1024px 给 `line-by-line`，否则 `side-by-side`。**1024 是按字体与行号槽宽算出来的**（并排每侧约剩 50 个等宽字符，推导在 `state/layout.ts`），与 Tailwind 的 `lg` 相同纯属巧合。以下几条都属「违反后不报错」：

- **判据是 diff 面板自身的宽度，不是视口宽度**：按视口判等于把侧栏宽度在 CSS 之外再写一遍，侧栏一改阈值就静默错位——而侧栏现在还能拖。
- **量的是面板那一层（`<section>`），不是里面那层滚动容器**：换格式 → 内容高度变 → 竖直滚动条进出 → 内层宽度抖十几像素，阈值附近两种格式来回重画。面板自己不滚，宽度不随滚动条变。
- **border box 那两处仍显式写**（`observe(el, { box: 'border-box' })` + `entry.borderBoxSize[0].inlineSize`）：滚动条是从 content box 里扣的，这一层哪天加了 `overflow` 或内边距，默认观察就把抖动请回来；只在读值那侧挑滤的是已产生的回调，指定观察 box 才是从源头不投递。
- **量法与阈值同住 `state/layout.ts` 的 `observeDiffPanel()`**：阈值的正确性全靠送进来的是 border box，而这件事没有门禁强制得了，拆到两个文件里就让其中一半失去说明。
- 格式是一个 `computed`，靠 `Object.is` 去重，只有真跨过阈值才通知下游。贴着阈值来回蹭时每跨一次仍是一次重排（不重新高亮）——不为此加迟滞，那会把纯派生量变成第二份状态。
- **`Patch` 必须在渲染体里读 `diffOutputFormat`**：读到 memo 或 effect 里去，拖窗口时版式就纹丝不动。
- **手动切换是一枚两态按钮，点过即固定**：住在编辑器标签栏右端的动作区（显示条件见 [`editors.md`](editors.md)），点一下翻到当前版式的另一种并写进 `diffFormatOverride`，此后本次页面内不再跟宽度走；刷新回到自动。图标与文案表达的是**目标**版式（`View inline` / `View side by side`），与变更列表的 `View as tree` 同类，不是显示当前档的状态灯。
- **override 与宽度判据合成同一个 `diffOutputFormat`**（`override ?? 宽度判据`）：`DiffView` 只认这一个 signal；另开一条通路时固定之后拖窗口照样换版式。固定后观察者照写宽度，`computed` 去重，不触发重画。
- **override 不进 `localStorage`**：跨不了实例（见 [`web.md`](web.md) 的「主题开关」）。也正因为不落盘，两态不会像主题那样「点过一次就永远回不到自动」——为什么不做三态见 [`../decisions/web.md`](../decisions/web.md)。

## hljs 语言清单

`import hljs from 'highlight.js/lib/core'`，再**逐个显式注册** **22 个语言模块**：`javascript` / `typescript` / `json` / `css` / `scss` / `xml` / `markdown` / `python` / `go` / `rust` / `java` / `kotlin` / `swift` / `c` / `cpp` / `csharp` / `bash` / `yaml` / `ini` / `sql` / `php` / `ruby`。注册清单是白名单，增删语言即增删体积。

- **别名不是模块，不得单独 import**：`jsx` 属 `javascript`、`tsx` 属 `typescript`、`toml` 属 **`ini`**、`html` 属 `xml`。`highlight.js/lib/languages/{jsx,tsx,toml}` 不存在，写了构建期 resolve 失败。
- **`plaintext` 必须与这 22 个一起注册，它是兜底而非语言**：`lib/core` 不自带它，漏注册时 `hljs.highlight()` 抛 `Unknown language: "plaintext"`，**整个 diff 视图渲染失败**——diff 里出现 `LICENSE` / `Dockerfile` / `.txt` 即触发。
- 配色 CSS 不来自 highlight.js，与语言清单增删互不影响（见 [`style.md`](style.md)）。

## 扩展名 / 文件名 → 语言的补漏表

**两个视图共用 `languageOf(path)`（`src/web/diff/hljs.ts`），它是全项目唯一一条语言判据。** 各写一份的症状是同一个文件在 diff 里有色、在文件视图里没色。

- **判定是三道，顺序不能换**：我们的补漏表 → hljs 模块自带的 `aliases` → diff2html 那张 `languagesToExt`（每道结果都要过 `getLanguage()`），全落空才是 `plaintext`。**第三道不能砍、也不许抄成自己的表**：它随 `highlight.js-helpers.js` 早就在产物里（那三个切分函数也住在那里）、体积为 0，实测比前两道多认 88 个扩展名（`pyi` / `jsonl` / `rake` …），砍掉后它们静默变纯文本；抄件则不会跟上游更新。
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

- **状态机在 `hljs.ts`（`createLineLanguage()`），喂给它哪条行序在 `render.ts`（`prepareDiff()`）**。
- **区块标签行自己按 `xml` 判**；`lang="ts"` / `lang="scss"` 走同一条 `languageOf()`，判不出来时退回区块默认值（script→javascript / style→css / template→xml），**不退回 plaintext**。
- **看不见起始标签的 hunk 保守停在 `xml`**：只改了 `<script>` 中间几行时判定器没见过 `<script>`，宁可没颜色也不猜。
- **一行开闭的区块不算进入区块**（`<script src="…"></script>`、一行写完的 `<style>`）：漏判时状态回不来，之后每一行都按 JS 高亮。
- **旧侧一个判定器、新侧一个**：状态属于一条连续的行序，而文件的旧版本与新版本各是一条，与版式无关。上下文行两侧都吃；两侧判出来的语言不同时（区块边界恰好在这一段里变了）按新侧上色。**取舍**：逐行版式下状态从前是跟着「删增交错的那条行序」走的，现在各跟各的版本——后者才是文件真实的样子。

## 产物体积门禁

门禁值为预算而非承诺。**主导项是语言清单**：要压体积第一刀砍它，要加语言先看这张表还剩多少。

| 产物 | 门禁 | 当前实测 |
|---|---|---|
| 前端 JS（明文） | ≤ 350 KB | 229.0 KB |
| 前端 JS（gzip） | ≤ 120 KB | 79.5 KB |
| 前端 CSS（明文，自建 hljs 主题 + Tailwind 产物） | ≤ 48 KB | 28.2 KB |
| 前端 CSS（gzip） | ≤ 10 KB | 6.4 KB |

**CSS 与 JS 一样明文、gzip 两道并卡**（理由见 [`../decisions/web.md`](../decisions/web.md)）。单次小幅增量两道都够不着，review 时看一眼 `dist/web/app.css` 的增量。
