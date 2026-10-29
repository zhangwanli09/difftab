# 前端：右侧正文视图

> 编辑器标签页里装的正文。外面那层（tab、分屏、标签栏与动作区）在 [`editors.md`](editors.md)，diff 怎么渲染在 [`diff-render.md`](diff-render.md)。被排除的做法见 [`../decisions/editors.md`](../decisions/editors.md)。标「有断言」的条目由 `test/unit/web/` 钉住、不进红线。

## 视图外壳

- **`DiffView` / `FileView` 接 `path` prop，在渲染体里读 `diffStates.value.get(path)`，不能用 `useComputed` 包**：`useComputed` 只随 signal 依赖重算，prop 换了它停在上一个 tab——「切了 tab 标题变了正文没变」。
- **`Panel` 由两个视图共用**：各写一份时漂开的症状是「其中一个面板底下那半屏不跟着滚」。

## 文件视图

**右侧那一份是只读全文，不是 diff。** `FilePayload` 五个 `kind` 全部在 `FileView` 分支，提示行与 `DiffView` 共用 `Notice`，`image` 那一支共用 `ImageView.tsx`。

- **语言判定与 diff 视图同为 `languageOf(path)`**（`diff/hljs.ts`），它内部先 `getLanguage()` 探一下：`highlight()` 传未注册的语言名会抛，而这里没有别的兜底，抛出去炸的是整个文件视图。取不到退回 `plaintext`（见 [`diff-render.md`](diff-render.md)）。
- **行号做成兄弟元素，不按行切高亮输出**：hljs 的 span 会跨行，切开就是在重写被禁止的高亮切分逻辑。行号槽 `sticky left-0`。
- **`sticky left-0` 要成立，正文那一层必须是 `w-max`**：普通块盒只有面板宽，行号槽没有滑动余量，横向一滚整列行号跟着滑出视口，而 `sticky left-0` 字样还在原地。
- **但 `w-max` 只能给正文那一路**，判据是按 `kind` 穷举的 `NEEDS_WIDE_BOX` 表（`Record` 漏键是编译错误，写成 `kind === 'text'` 一句则是第二处独立判定）：`max-content` 下提示行那几句散文会排成一行跑出面板，`break-all` 也救不了（实测读数见 [`../decisions/editors.md`](../decisions/editors.md)）。以上有断言。
- **自动换行（`Word Wrap`，按钮见 [`editors.md`](editors.md) 的「动作区」）只管文件视图**，diff 表格照旧不折行（两张表逐行对齐全靠固定行高，见 [`diff-render.md`](diff-render.md)）。开着时：
  - **正文按行切成一行一个元素**，行号与代码同住一行（flex），折出来的几行由那一行自己撑高，行号自然落在逻辑行的第一行。切分用 diff2html 的 `closeTags`（`diff/render.ts` 的 `highlightLines`，仍是整份一次 `hljs.highlight`），不自己重写。**已知取舍**：跨行时同时开着两层以上的 span（多行的模板字符串插值）在下一行嵌套次序会颠倒，那几行颜色略怪——`closeTags` 上游如此。
  - **不套 `w-max`**（`max-content` 下一行都折不了），行号槽也就不必 `sticky`；超长且没有断点的词按 `wrap-anywhere` 折。行号槽按总行数的位数定宽，每行同宽。
  - **改动标记与跳行高亮带挂到行上**，不再按 `(line - 1) × 行高` 算：行高不再固定。标记是那一行行号格里贴右缘的一段（删除点画在第 `line` 行的顶边，`line` 比最后一行大一时画在最后一行的底边）；高亮带是那一行的底色，跳行即把那一行滚到竖直居中。
  - **关着时一切照旧**（两个 `<pre>`、按行高算位置）：一行一个元素的 DOM 是不换行时的几十倍，按需才付。
  - **这一档的几处省力**：每行是一个 props 不变就不重画的组件（跳到另一行只重画新旧两行）；每行 `content-visibility: auto`，视口外的行不排版——换行后行高随宽度变，拖一下分栏就是整篇重排。整份 hljs 输出在模块里记最近一份，两档共用：切开关是两种视图卸载重挂，不记时每按一次就把整份正文重新高亮。
- **视图按请求状态里记的那一档（忽略空白开没开）渲染，不读此刻的开关**（按钮见 [`editors.md`](editors.md) 的「动作区」）：否则切换后、新补丁回来前的那一段里，旧补丁会按新口径算词级、零 hunk 时说错话。
- **SVG 预览（按钮见 [`editors.md`](editors.md) 的「动作区」）**：开着时视图把那份 `preview` 交给图片视图（`ImageDiff` / `ImageFile`）。**挂着跳行请求（全仓搜索的命中）的那个 file tab 按文本画、按钮显示未按下，全局开关不动**：预览态下那一行不在面板上，跳行请求会一直挂着、等关掉预览时冷不丁滚过去；而改全局开关会让此后打开的每个 SVG 都莫名回到文本。在这个 tab 上按下 `Preview` 即清掉跳行请求、按图画。「此刻按不按图画」只有 `shownPreview` 一处判，视图与按钮都读它。
- **Markdown 预览（同一枚 `Preview`）**：开着时正文换成渲染视图（`MarkdownView.tsx`）。**挂着跳行请求时按源码画**，按下即清掉跳行请求，理由与判据同 SVG 那条，「此刻按不按渲染画」只有 `shownMarkdown` 一处判。
  - **marked 的输出整份过一遍白名单清洗**（浏览器自带的 `<template>`，惰性、不跑脚本不取图），不靠 CSP 兜底：CSP 拦得住脚本，拦不住一个盖满页面的块。原始 HTML 放行安全子集（照 GitHub，README 顶上的居中 logo 与徽章靠它），不在表里的标签拆壳留孩子，`script` / `style` / `iframe` / `source` 之类连内容删；属性只留 `align` / `width` / `alt` 等几个，**`class` 只认 `hljs-*`（连同 `class_` 这类 hljs 修饰记号）与我们自己的两个记号**——Tailwind 的工具类都在产物里，放行任意 `class` 时一句 `fixed inset-0` 就盖掉整张页面。下面两条链接与图片的规则也在这一遍里，原始 HTML 与 markdown 语法同一套判据。
  - **外链图片不发请求，画成 alt 文本**：`img-src 'self' data:` 本来就会拦，而产品承诺不往外发东西；相对路径的图按 md 文件所在目录解析成工作区路径，走 `/api/blob`（`side=new`），不在图片表里的扩展名由那条路 400、画成一张破图；`<picture>` 的 `<source>` 删掉、退回里面那张 `<img>`。**已知取舍：图只改了、md 没改时预览停在旧图**——`v=` 恒为 `0`（payload 里没有被引用那张图的身份），HTML 字串不变时 Preact 不碰 `<img>`、浏览器不重新请求；`no-store` 管的是缓存，管不到「没有发请求」。要修得让后端给每张被引用的图一个内容身份，按渲染换戳则每个 SSE 都重下全部图片（图片视图那条 `v=` 的教训）。关掉预览再打开即换新。
  - **链接只放行 `http(s):` / `mailto:`**，新开标签页并带 `rel="noopener noreferrer"`；相对链接画成不可点的文本——点了会把这张页面导航走，而仓库内跳转是另一个功能。**`#` 锚点同样画成文本**：marked 不给标题生成 `id`、清洗又删掉了 `id`，放行时它只改地址栏不滚动，是一个看着能点的死链；要做得给标题生成带前缀的 `id`（防撞上页面自己的），那是另一个功能。
  - **代码块走同一份 hljs 注册清单**（围栏信息串取第一个词、按 `languageOf` 认），认不出的转义后原样显示，不为它注册新语言。
- **跳到行（全仓搜索的命中行）**：`openFile` 带 `line` 时在 `state/editors.ts` 记一份 `revealRequest { path, line }`，`FileView` 在 `text` 就绪且路径对得上时把那一行滚到面板竖直居中，并在那一行画一条绝对定位的整行高亮带。**行的位置按 `(line - 1) × 行高` 算**——行号槽靠同一个 `leading-5` 对齐，正文是一整块 hljs 输出、不按行切（理由同上）。每次请求都是一个新对象、跳行 effect 依赖它的身份，再点同一行也重新滚一次；高亮带留到下一次跳行或切走。**全文已 `ready` 时同样生效**，不等重取。
- **改动标记（照 VS Code quick diff）**：file tab 的路径此刻在变更列表里（`repoState.files` 有这一行）且 HEAD 里有它（不是未跟踪的 `U`、也不是新建后暂存的 `A`）时，行号槽右缘画一列 3px 的标记——新增绿条、修改蓝条、删除点一枚红三角，色值照 VS Code 的 `editorGutter.{added,modified,deleted}Background`。不在列表里的文件（Files 树、Quick Open、搜索打开的干净文件）不画、**也不发请求**。
  - **数据源是 diff tab 那条 `/api/diff`，不新增路由**：基准同为 `git diff HEAD`，重命名照带 `oldPath`；按 `PATCH_DEFAULTS` 取，**不跟忽略空白开关**——标记回答的是「这行动过没有」，空白改动也是改动。**`U` 与 `A` 不标、也不发请求**（照 VS Code）：对着 HEAD 比是整份绿条，不带信息，左栏那个字母已经说了「整个是新的」。`A` 之后又改过（`AM`）的同样不标——VS Code 在那里对着暂存区画剩下的改动，而这里只有 HEAD 一个基准，已知差异。`git add -N`（`.A`）与冲突里对方新建的 `UA`、我方删了的 `DU` 同样不在 HEAD 里；冲突的 `AA` / `AU` 是我方新建、HEAD 里有，照常标。判据只在 `shared/protocol.ts` 的 `isAbsentFromHead` 一处——冲突条目的 XY 是合并阶段码，不能按状态位字面读。补丁不是 `text`（二进制、过大）或取失败时不画，全文照常显示。
  - **判定按 `groupLines` 的分组**（`diff/marks.ts`，纯函数）：一组里既有删除又有插入 → 插入的那几行标修改；只有插入 → 标新增；只有删除 → 在新侧的插入点画删除。多段补丁（类型变了）只取最后一段，那一段才是工作区此刻的这个文件。
  - **位置与跳行高亮带同一套算法**（`PAD_TOP + (line - 1) × LINE_HEIGHT`），标记是行号 `<pre>` 里绝对定位的子元素，随行号槽一起 `sticky`；不按行切 hljs 输出。
  - **缓存 `fileMarkStates` 按路径，与全文同取同忘**：`openFile`、切到这个 tab、SSE 刷新都与 `loadFile` 一起取；SSE 那一路要等新列表（`loadState` 之后），「还在不在列表里」与 `oldPath` 都得按新的一份判，判出已不在列表里即清掉。
  - **全文与补丁是两趟请求**：agent 写到一半时两份可能错开一拍、标记落在旁边一行，下一次 SSE 自愈。已知取舍，不为它在后端合一个接口。

## 整次提交视图

**`commit-changes` tab 的正文是一个滚动容器，提交里每个文件一段，次序同 History 展开后那一列**（`CommitChangesView.tsx`；段本身在 `MultiDiff.tsx`、段的状态在 `store.ts` 的 `segmentStore`，都与工作区改动视图共用）。文件清单就是 History 展开时那份 `commitDetails`（`ensureCommitDetail`：没展开过就此刻取，失败了再进来即重试）；每段的补丁走 `/api/commit-diff`，与 commit tab 同一个取法（`store.ts` 的 `loadCommitPatch`），不新增路由。

- **段头粘性**（`sticky top-0`，实心底色盖住滚上去的补丁）：折叠三角 + 文件名 + 目录（同住一个 `truncate` span，理由同变更列表）+ 状态字母 + `Copy path`。点段头折起 / 展开那一段，折起的段不画段体、也不取。**折叠态住在组件里**：切 tab 是卸载重挂，回来时全部展开，与「滚动位置不保留」同一个样子。重命名的旧路径照 commit tab 由段体顶上的 `RenameNotice` 说。
- **按视口懒加载**：一段进入面板可视区附近（`IntersectionObserver`，上下各多一屏左右的 `rootMargin`）才取它的补丁。一个提交改几百个文件也只取看得到的那几段；一个观察者给全部段共用。**root 必须是面板那层滚动容器，不能是视口**：`rootMargin` 只放大 root，祖先 `overflow` 的裁剪不跟着放——以视口为 root 时「附近」那一圈被面板裁掉，滚到哪段才开始取哪段，每段都先闪一拍 `Loading…`。**还没取到的段占半屏高（`min-h-[50vh]`）**：只画一行 `Loading…` 时一段才八十多像素，首次挂载那一刻面板加上下边距里能塞下二三十段，一打开就是二三十趟 `git diff`；占位撑高之后首屏先取三四段；它们取回来缩到实际高度，又会把后面几段带进边距，补丁都短时首屏会接着多取几段（本仓库一次 22 个文件的提交实测从 22 趟降到 8 趟），其余随滚动逐段进入边距再取。代价是段取回来时从半屏缩到实际高度，后面的段跟着往上挪：落地的段在视口之下时看着的那一段不动；**在视口之上时（直接跳到一个大提交的中段，上方那一屏的占位也在边距里被取）正在读的内容会被往上顶**——Chrome 与 Firefox 的 scroll anchoring 会补偿这一下，Safari 没有。已知取舍，未做补偿：要做就是落地时按高度差回写 `scrollTop`。
- **缓存 `commitChangesCache`，键 `<sha>:<path>`**：tab 关掉、或作为预览 tab 被顶掉时**整组** `forget`——删缓存与作废在途成对，漏掉作废时关掉的 tab 再打开先看到一份过期的。**不跟 SSE**，`ready` 了就不再取；`error` 的段在重新进入视口时重取；取的那一档与此刻不同（切了忽略空白、点开了折叠行）时**可见的段**当场重取，看不见的等进入视口再取。判据与 commit tab 的 `refetch` 是同一个函数，重取不回退 `loading`（记 `pending`）的理由也同那一条（[`editors.md`](editors.md) 的「自动刷新怎么收编这些 tab」）。
- **上下文档按段记**（`hunks` / `full` / `unavailable`，三档的规则见 [`editors.md`](editors.md) 的「编辑器标签页」），存在 `store.ts` 一张按段键的表里，随整组 `forget` 归零。**不挂在 tab 上**：点开一段的折叠行不该让同一个 tab 里其余几百段此后都按整份上下文取。`Patch` 因此不再自己按 tab 键去查上下文档，由调用方把「此刻哪一档」与「点开一段时做什么」交进去。
- **段体复用 `DiffView.tsx` 的 `Payload`**：图片、二进制、过大、SVG 预览走现有分支，提示文案一字不改。**图片与 SVG 预览在段内限高**：它们在 commit tab 里是占满面板的那种（`fill`），段里没有「面板剩余高度」可吃，`ImageRow` 高为 0 时退回只限宽，一张高图就把后面几段推出好几屏；所以段体给它们一块固定高度的一列 flex 当基准。
- **顶上的说明行**：合并提交画 `Merge commit · compared with first parent`（同 commit tab）。详情 `Loading…` / 出错 / 浅克隆 `Shallow clone — parent not available` / `No file changes` 走 `Notice`，文案同 History 展开那一层。

## 工作区改动视图

**`changes` tab 的正文与整次提交视图是同一套段（`MultiDiff.tsx`）**：粘性段头、按视口懒取、半屏占位、按段记上下文档、段体复用 `Payload`、图片限高，以上各条同上一节，不再复述。不同的只有数据源与「什么时候重取」（`WorktreeChangesView.tsx`）。

- **段的清单就是变更列表此刻那份 `repoState.files`，次序同左栏自上而下**（冲突、已暂存、工作区改动；同一个文件只排在它第一次出现的位置）。段头的状态字母按 `codeOf` 归并成一枚（冲突印 `!`），与 `Files` 档同一个判据：一段是一份 `git diff HEAD`，分不出是哪一组的改动。补丁走 `/api/diff`，重命名带 `oldPath` 的规矩同 diff tab。
- **缓存独立（`segmentStore` 另建一份，键是路径），不与 diff tab 的 `diffCache` 共用**：diff tab 的上下文档挂在 tab 上，每次 SSE 由 `refresh` 重取；段的上下文档按段记，什么时候取由可见性定。共用一格时两边按各自那档轮流改写，点开一边的折叠行，另一边的表格跟着换。代价是同一个文件两处都开着时取两趟。
- **重取的判据是「这一段上次是对着第几份 `repoState` 取的」**（记代数不记快照：各段在不同的 SSE 之间取，记快照就是每段各留住一整份旧列表）：SSE 换上新 state 后，可见的段（视口附近、没折起）当场重取，看不见的等进入视口再取。不是每次 SSE 重取全部段：几百段就是几百趟 `git diff`，而一段的内容变没变，前端看不出来——状态字母不变是最常见的形态。`error` 的段与上一节一样，重新进入视口时重取。
- **段只收路径，外壳在 props 没变时不重画**（`ChangesSegmentShell`）：每份新 state 里的条目都是新对象，按条目传 prop 时每个 SSE 几百段连同补丁表格全部重画一遍。条目在要取时按路径现找（`changesEntryOf`），状态字母包成 computed，字母不变就不重画。
- **在途的段不重发，落地时发现 state 已经换过、且这一段仍可见才补发一次**：每个 SSE 都重发时新票作废旧票，agent 跑动期间慢补丁永远落不了地（同 commit tab 那一条）。于是每段至多一趟在途。**补发由视图发起、不在 store 里落地即发**：store 只把「手上那份落后于此刻的 state、且没有在途」交出去（`changesOutdated`），可见的段据此再问一次；落地那一刻 store 没有可见性可问，在那里直接补发时，滚出视口或 tab 退到后台的段会在 agent 跑动期间一趟接一趟地取下去。出错落地而 state 没换不算过期，不会原地重试成环。重取期间照常显示旧补丁（`pending`），不回退 `loading`。
- **段从列表里消失（撤销、commit 掉）时整格忘掉**：`refresh` 换上新列表后，缓存、在途请求、上下文档、「对着第几份 state 取的」四样按新列表一起剪掉，同 diff tab 收编那一处。漏剪时这个文件下次再改，段先画出上一轮的旧补丁。**重命名的段在新路径上从头取、上下文档从 `hunks` 起**：已知取舍，不为它跟着 `oldPath` 搬状态。
- **state 还没到时说 `Loading…`，列表为空时说 `No changes`**（`Notice`）。tab 关掉、或作为预览 tab 被顶掉时整组 `forget`。
- **段的增删会挪动正在读的位置**：新改的文件排在前面时，下面的段整体往下推；Safari 没有 scroll anchoring 去补偿。与上一节「占位缩回实际高度」同一条已知取舍。

## 图片视图

**`DiffPayload` / `FilePayload` 的 `image` 支由 `ImageView.tsx` 承接，两个面板共用**：diff 那侧 `ImageDiff` 按 `old` / `new` 各画一张（`null` 的那侧不画），文件那侧 `ImageFile` 画一张。图片不是新的一种 tab。SVG 预览也走这两个组件：它们收的是两侧元数据（`{ old, new }` / `{ size, version }`），不是整份 `image` payload。

- **说明文字（`Before` / `After` · 像素尺寸，体积另起一段、只隔 `gap-2` 不加点）挂在每张图的右下角**：排在图上方时 caption 宽度随文字变，两张并排的图顶边不齐。**像素尺寸由 `<img>` 的 `onLoad` 读 `naturalWidth × naturalHeight`**，不让后端解析图片头——那是第二份事实来源。
- **前端不判「这是不是图片」，只认 `payload.kind === 'image'` 与 `payload.preview`**：判据与扩展名表只在后端一份。
- **commit tab 里的图片 URL 多带 `commit=<sha>`**，`version` 是对象名，取一次就够。
- **字节走 `<img src="/api/blob?path=&side=&v=">`**：同源、带 cookie、CSP 的 `img-src 'self'` 现成放行；不 `fetch` + `createObjectURL`（要给 CSP 开 `blob:`），不内联 base64。`path` 直接用 `ImageSide.path`。
- **`v=` 与 figure 的 `key` 都是后端给的内容身份 `ImageSide.version`，前端只比对不解读**。它必须随内容变：URL 不变时浏览器不重新请求，「图改了、页面上还是旧的」。它也**只能**随内容变：`loadDiff` 每个 SSE 都跑，按「取过一次」换戳会让每次无关改动都重下两张图。
- **图底下垫棋盘（`checkerboard`）**，格子色复用 `--color-diff-diagonal-fill`，不另开颜色；图外一圈边框。**棋盘那层 `self-end`、不 stretch**：图比 caption 窄时 figure 宽由 caption 撑，stretch 会把棋盘拉宽、图右边多一截空格子。
- **图按宽高一起缩进面板（照 VS Code 的「Whole Image」），只缩不放**：宽 `max-w-full`、高 `max-h` = 放图那一层的高减去内边距、caption 与边框，`h-auto` 保比例。只限宽时高图要往下滚才看得全。**不做缩放、滑块、洋葱皮、像素 diff**。两张图 `flex-wrap`，与 diff 的版式切换不联动；缩完仍并排不下时上下排，此时面板竖向滚。
- **图在面板里水平、垂直都居中，放图的那一行（`ImageRow`）两个视图共用、单张也走它**：单张退成普通块盒时 caption 贴的是面板右边而不是图的右下角。
- **高从面板一路传下来，只在 `image` 那一支与预览态**：`Panel` 带 `fill` 时成一列 flex，`ImageRow` 外层 `flex-1` 吃掉提示行（重命名、合并提交）之外的剩余高度，并做成 size 容器给 `max-h` 的 `cqh` 当基准；文件视图的 `w-max` 包裹只套正文那一路，图片那一支直接落在 `Panel` 里，两个视图层数相同。哪几个 kind 要 `fill` 按 kind 穷举成 `Record`，理由同 `NEEDS_WIDE_BOX`。正文与提示行不加 `fill`：滚动层的类名保持原样。
- **放图那层矮于 8rem 时撤掉 `max-h`、退回只限宽**（size 容器查询）：矮面板里那条 calc 为负、钳成 0；漏带 `fill` 时那层高为 0。两种都会让图整张消失，退回往下滚才不出错。**门槛要离 calc 归零的点（约 3.4rem）留足余量**：写成 4rem 时 4–5rem 高的容器把图压成十几像素的一条，比滚动更糟。
- **垂直居中靠内层 `m-auto` 而不是 `items-center`**：内容比面板高时 auto margin 归零、从顶部起排；`items-center` 会把溢出的那截均分到上下两头，顶上那截滚不到。
- **`<img>` 的 `onError` 落成一句 `Could not load the image.`**：payload 与取字节之间文件可以被删、被改、长过 5MB，旧侧是 symlink / gitlink 时字节也解不出。**失败态必须随内容变化归零**：figure 按 `version` 给 `key`，否则撞上一次半写的文件后那一侧永远停在提示上。
- **`NEEDS_WIDE_BOX.image = false`，预览态同样不套宽盒**：写 `true` 时宽图把滚动区撑到原始像素宽。
- **体积走 `formatSize(size, 2)`，0 不画**：与 `too-large` 同一个 helper，精度靠一个参数分——caption 是元数据，`1.59 KB` 与 `2 KB` 的差别正是它要回答的。两份 helper 第一次提交就漂开过。
