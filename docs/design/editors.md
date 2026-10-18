# 前端：右侧面板、编辑器标签页与文件视图

> 右侧面板是 [`web.md`](web.md) 那副骨架的右半边：一条标签栏 + 一个视图（diff 或全文）。diff 怎么渲染在 [`diff-render.md`](diff-render.md)。被排除的做法见 [`../decisions/web.md`](../decisions/web.md)。标「有断言」的条目由 `test/unit/web/` 钉住、不进红线。

## 编辑器标签页

**右侧面板顶部是一条标签栏，可以同时挂多个文件；左栏单击是预览、双击是固定，照 VS Code 编辑区的惯例。** 状态在 `state/editors.ts`：一个有序的 `editors` 列表 + 一个 `activeEditorKey`，此刻画哪个视图由活动项的 `kind` 派生，不另设 `activePane`——两份就有「谁是真的」这个问题。

- **tab 的身份是 `kind:path`**：同一路径的 diff 与全文是两个 tab（VS Code 同样如此）；合成一个就得再记一份「此刻显示哪种」，切换时另一种的滚动位置也丢。键只用来比对、不反解析。
- **预览 tab 全局只有一个，判据是 `pinned === false` 的那一项，不是「最后打开的」**。单击不在栏里的文件：有预览 tab 就**原位**替换，没有就追加；单击已在栏里的只是切过去。
  - **`openEditor` 的 `pinned` 档给 `Open file` 用**（照 VS Code `git.openFile` 的 `preview: false`）：不在栏里就追加一个固定 tab、不碰现有预览 tab，已在栏里就固定并切过去。调用方不自己「先开预览再 pin」——那样会先顶掉一个无辜的预览 tab。
  - **`pinEditor` 是幂等的置 `true`，永不 toggle**：一次双击是 click、click、dblclick 三个事件，写成 toggle 会让已固定的 tab 在双击时静默解开。**dblclick 只调 `pinEditor`、不再走 `selectFile`**，否则一次双击是三趟 `git diff`。
- **第三种 tab 是 `commit`，身份是 `commit:<sha>:<path>`**：`Editor` 多带一个 `sha`，`path` 仍是文件路径，其余读 `path` 的地方照旧。tab 上文件名后跟短哈希，图标 `GitCommitHorizontal`。**正文顶上只有合并提交多一行 `Merge commit · compared with first parent`**（补丁相对第一父，这件事只在看补丁时才需要知道）；普通提交不画「这是哪次提交」——短哈希已在 tab 上、主题在 History 那一行，再印一遍只是占掉一行补丁。**它活动时 `activeEditorPath` 是 `null`**：左栏同名那一行说的是工作区那一份，照亮它是在说一件不成立的事——这是「高亮不看种类」唯一的例外，判据是「左栏那一行与右侧是不是同一份内容」。
- **第四种 tab 是 `commit-changes`：一次提交的全部文件排在一个 tab 里，身份是 `commit-changes:<sha>`**（照 VS Code Graph 的 `Open Changes`，那是一个多文件 diff 视图）。入口在 History 提交行的 `Open Changes`（见 [`sidebar.md`](sidebar.md)），单击开预览 tab、双击 tab 固定。`path` 存的也是 sha，只用于比对；`worktreePathOf` 对它回 `null`，左栏不亮、tab 不染色，判据同 commit tab。tab 上是 `<短哈希> · <主题>`，主题在打开时从 History 那一行带进 `Editor`、跟着 tab 走——详情此刻可能还没取，现找就是先画一拍空名字；图标 `GitCompare`。**不参与同名目录消歧**：它没有文件名，拿 sha 当路径去比只会和谁都不撞、白占一格。正文见下文「整次提交视图」。
- **diff 与 commit tab 各带一个上下文档 `context: 'hunks' | 'full' | 'unavailable'`**，起步 `hunks`。点开第一段折叠行时写成 `full`（diff tab 那一行已不在变更列表里时不写：那一下发不出请求，点的那一段会一直停在 `Loading…`），此后这个 tab 的每次重取（SSE、切回来）都带 `fullContext=1`；带着它取回来的 `text` 却是 `full: false`（后端说过不了闸）、或者是 `too-large`（留在 `full` 时每个 SSE 都先按整份上下文撞一次闸、再退回 3 行撞一次）时写成 `unavailable`，此后退回 3 行上下文、折叠行不可点（展示规则在 [`diff-render.md`](diff-render.md) 的「没改的行」）。**它住在 tab 上，不住在缓存里**：`renameEditor` 原样带走，并入同名 tab 时取三档里靠后的那个（`unavailable` > `full` > `hunks`）；关掉、或作为预览 tab 被顶掉即归零。住在缓存里时每次 `forget` 都会把「用户点开过」一并忘掉。`unavailable` 不会自己回到 `full`：文件后来变小了也要关掉重开——已知取舍，否则每个 SSE 都要先撞一次闸再退回。
- **关掉活动 tab 切到右邻居、没有才切左邻居**，不维护 MRU 序列。
- **两栏的高亮同按活动 tab 的路径判（`activeEditorPath`），不看 diff 还是全文**：按种类各认各的时，点了行内 `Open file` 那一行就熄了——用户刚从这一行出发，左栏却说「你没在看它」。
- **切侧栏 tab、切列表 / 树版式、全部折叠，都不动 `activeEditor`**（症状见 [`web.md`](web.md) 的「页面骨架」）。**反方向有联动**：活动 tab 的路径一变，`Files` 树展开并定位那一行（机制在 [`sidebar.md`](sidebar.md) 的「文件浏览器」），但不切侧栏档位。
- **不进 `localStorage`**（跨不了实例，见 [`web.md`](web.md) 的「主题开关」）。

### 自动刷新怎么收编这些 tab

**每次 SSE 之后要过一遍栏里全部的 diff tab，不只活动那一个**：改动被撤销或 commit 掉的关掉，重命名的跟到新路径。只看活动 tab 时，后台 tab 里那份补丁照样留着，切过去看到的是左栏已断言不存在的东西，且它再也不会被刷新。

- **重命名不算消失**：先按 `path` 找、再按 `oldPath` 找，命中就 `renameEditor`（`pinned` 不变，活动键跟着走）。**两趟而不是一趟 `||`**：A→B 后又在 A 新建文件时两条都命中，该跟的是路径就是 A 的那条。**新路径上已有 tab 时并入它**：幸存者保位置，`pinned` 取或。
- **只重取活动那一个，其余切过去时再取**（`activateEditor` 每次都真的去取）：栏里 10 个 diff tab 时，否则每个事件 10 趟 `git diff`。切过去时缓存照常显示、新的回来再换，同一个 path 已 `ready` 就不回退 `loading`，不闪。**`refresh()` 内部用 `removeEditor` 而不是 `closeEditor`**：后者会顺手重取邻居，与 `refresh()` 末尾那次叠成两趟。
- **在途的请求要一并作废**：否则关掉 X 后那次请求照样写进缓存，下次打开 X 先看到它。手段是按路径 `claim` 一张票（`http.ts` 的 `latestWins`），**与删缓存成对写在 `forget()` 里**——漏掉作废那一半没有任何东西会红。
- **commit-changes tab 同样不收编**：切过去时 `refetch` 只补取提交详情（失败了才重取，取到过就不动），各段的补丁由视图按可见性自己取（见下文「整次提交视图」）。
- **commit tab 不收编，`ready` 了就不再取**：提交不可变，SSE 与它无关。**在途（`loading`）也不重取**：每次 SSE 都重发时新票作废旧票，慢补丁在 agent 跑动期间永远落不了地。**只有 `error` 的才在切过去时重取**，否则唯一的重试路径是回 History 重新点。提交被 gc 掉时那一次写成 `error`。**例外是取的那一档与此刻不同**：请求状态记着一档（`loading` 记的是这一趟问了什么，`ready` 记的是**这份补丁是什么**——整份上下文只认 payload 的 `full`，被退回 3 行的就记成关），与此刻的开关和 tab 的上下文档不一致时照常重取——这两样只在用户点了什么时才变，不会有 SSE 那种饿死。**这一趟重取不回退 `loading`**：手上已有一份时照常显示它、在状态上记一笔 `pending`（这一趟按哪一档在取），`refetch` 拿它判「已经在取了」；回退 `loading` 会让表格卸载重挂，点开折叠行的那一刻展开状态（住在组件里）跟着没了。
- **file tab 永不自动关**：文件被删也只是那一次 `loadFile` 写成 `error`。
- **活动的 file tab 在 `loadState()` 之前就重取**，不等新列表：它的数据源是工作区本身。收编后活动键变了才对新活动的 file tab 补取一次。

## 标签栏与视图

**标签栏是面板唯一的 chrome，排在滚动区域之外。** 面板是一列 flex：`EditorTabs` 占第一行，底下 `Panel` 那一层（`min-h-0 flex-1 overflow-auto`）才滚。不再有路径横杠或面包屑——「在看哪个文件」由活动 tab 回答，完整路径挂在 tab 的 `title` 上。

- **一个 tab = 种类图标 + 文件名 +（同名时的）目录 + 关闭按钮**（commit-changes 是图标 + 短哈希 + 主题，见上文）。图标按 `kind`（`FileDiff` / `FileCode` / `GitCommitHorizontal` / `GitCompare`，同一张 `KIND_ICON`），是同一路径两个 tab 之间唯一的视觉差别。文件名与目录**同住一个 `truncate` span**，理由同变更列表。预览 tab 的名字 `italic`。
  - **目录只在栏里有同名文件时才画，且只画最短可区分后缀**（照 VS Code `labelFormat: default`）：常显时每个 tab 都宽出一截，栏里多数时候并没有要区分的东西。判据是「栏里有**不同路径**的 tab 文件名相同」——同一路径的 diff / file / commit tab 不算，它们之间靠图标与短哈希区分，目录一模一样、画了也分不开。段数 = 1 + 与其余每个同名路径的公共尾段数的最大值，截到全长；没取全时前面写 `…/`，根目录下的文件没有目录段、画空（`packages/{foo,bar}/src/index.ts` → `…/foo/src` 与 `…/bar/src`）。**取尾段而不是整段目录**：能区分的那段常在中间，整段画出来会被 `max-w-64` 从右端裁掉，剩下的两个 tab 还是一个样。完整路径照旧在 `title` 上。表在 `EditorTabs` 按整栏算一次再逐个下发——单个 tab 看不见邻居，关掉一个同名 tab 时另一个的目录要跟着消失。
  - **文件名按 git 状态染色**（照 VS Code `workbench.editor.decorations.colors`），查的是文件树那一张 `codeByPath`、颜色是同一张 `CODE_COLORS`：同一个文件在树上与 tab 上必须是同一个颜色，自己再按 `FileEntry` 推一遍会在冲突、暂存加改动这些归并上漂开。只染名字，目录与短哈希自带次要色。**commit tab 不染**：它是一份历史补丁，工作区此刻的状态说的不是它——与「commit tab 活动时 `activeEditorPath` 为 `null`」同一条判据，两处都调 `worktreePathOf`，不各写一遍 `kind === 'commit'`——多一种显示非工作区内容的 tab 时只改了一处，症状是 tab 染着工作区的色、左栏却不亮。**每个 `Tab` 用 `useComputed` 取自己那一格**（同文件树的行）：`codeByPath` 每个 SSE 都换一份，直接读时每次刷新整栏重画。这里包 prop 不会停在上一个（与下面 `DiffView` 那条不同）：`Tab` 按 `keyOf` 挂载，路径与种类都在键里，改名即重挂。
  - **关闭按钮只在活动 tab 上常显，其余悬停或键盘焦点在 tab 内时才露出**（照 VS Code）。**用透明度藏而不是不渲染**：位置留着，悬停时 tab 宽度不跳。键盘那半条是 `group-focus-within`（不是行内动作那种 `has-focus-visible`）：活动 tab 本来就常亮着 ×，鼠标点过后焦点留在 tab 内也不会多钉住什么。`IconButton` 的悬停底色是半透明叠加的 `toolbar-hover-background`，否则在非活动 tab 的悬停底色上看不出反应。
- **关闭按钮是 tab 按钮的兄弟，不是孩子**：套在里面时 tab 不是按钮，得手写 `tabIndex` / Enter / Space、另开手型光标规则、每个处理器加「来自 × 的事件不处理」守卫（不守时快速双击 × 会把滑到指针底下的邻居静默固定住），且 `role="tab"` 的子元素在无障碍树里只当文本、读屏看不见 ×。并排之后这些一起消失。中键（`auxclick` 且 `button === 1`）也关闭。`role="tablist"` 带 `aria-label="Open editors"`。
- **栏是两层：外层管高度、底色与通栏分隔线，里面的 `role="tablist"` 只装 tab、管横向滚动，右端的编辑器动作区是 tablist 的兄弟**——与侧栏那行 tab 同一种切法。动作按钮躺进 tablist 时读屏把它报成又一个 tab，且会随 tab 一起横向滚出视野。动作区 `shrink-0`，tab 再多也钉在右端。
- **选中态是 tab 自己的 `border-b`，通栏分隔线是外层的 `divider-b`（inset 阴影）——与侧栏那行 tab 同一套机制**。**这一栏是这套机制存在的理由**：tablist 是滚动容器，按 padding box 裁内容，「`border-b` + tab `-mb-px`」的教科书写法伸进 border 带的那 1px 会被裁掉——下划线看不见，还留下 1px 纵向可滚溢出，「始终显示滚动条」的系统设置下就是一条常驻滚动条。tablist 被 flex 拉满外层高度，tab 的 `border-b` 于是落在外层阴影那 1px 上、画在它上面。活动 tab 带 `bg-editor-background`，与正文连成一片。
- **栏与左栏顶栏同高**（有断言）。**tablist 横向滚动、每个 tab `shrink-0`、滚动条隐藏（`scrollbar-none`）**：画出滚动条时栏会被撑高、与顶栏错开。**活动 tab 要自己滚进视野**（`scrollIntoView`，`inline: 'nearest'`）：否则溢出后新开的 tab 在屏幕外，正文换了而栏上看不出变化。**动作区的按钮数变了也再滚一次**（有断言），判据是数按钮的那一个 computed（`editorActionCount`），不是「画不画」——在 `text` 与 `untracked-text` 两种补丁之间切时，版式按钮一直在，忽略空白那一枚却会进出：新开的全文 tab 先以 `loading` 激活、滚到 tablist 末端，正文就绪后复制按钮才挤进来，tablist 窄一截而 `scrollLeft` 不动，活动 tab 的右端连同 × 就被裁掉。拖窄侧栏或窗口同样会让 tablist 变窄，那一路不跟——要接 `ResizeObserver`，眼下不做。
- **`DiffView` / `FileView` 接 `path` prop，在渲染体里读 `diffStates.value.get(path)`，不能用 `useComputed` 包**：`useComputed` 只随 signal 依赖重算，prop 换了它停在上一个 tab——「切了 tab 标题变了正文没变」。
- **切 tab 是卸载重挂，滚动位置不保留**：一份 diff 的 DOM 动辄数万行，N 个 tab 常驻挂载等于 N 份 DOM，`outputFormat` 一变每份都要重排。**卸载重挂靠 `App` 给视图按 tab 键 `key`**：只换 `path` prop 时 `Panel` 连同 `scrollTop` 留着，B 从 A 的偏移量打开，而换视图种类时又从顶部开始——两种切法必须一个样子。视图里不再另给 `Payload` 一份 `key`。
- **右侧空态只在栏里一个 tab 都没有时画**（`PanelEmptyState`），照 VS Code 的空编辑区列**一列全局快捷键**（`Go to File` / `Search`，名字与顶栏按钮、侧栏 tab 同一份），不再说「点左边一个文件」——左栏就在旁边，这句不带信息。**不画 VS Code 列表上方那枚大号 logo 水印**：试过，放在这个面板里看着突兀。
  - **不说「工作区干净」**：左栏 `Changes` 档空着已经答了「为什么没得看」，右侧再说一遍只是重复。
  - **快捷键列表与全局快捷键同一份清单**（`state/shortcuts.ts` 的 `SHORTCUTS`），只展示、不可点——入口在顶栏与侧栏 tab 上已经有了。**布局照 VS Code**：一行一条、名字靠左、按键靠右；宽度随内容、两列只隔一小段（定宽时名字与按键离得太远，看着不像一行）；按键各一个 `<kbd>`，配色取 VS Code 的 `keybindingLabel.*`，按平台写 `⌘` 或 `Ctrl`。**按键那一列 `aria-hidden`**，读屏只念名字：一串 `⇧⌘F` 念出来是「shift symbol, place of interest sign」，与按钮 tooltip 里快捷键不进无障碍名同一条理由。
  - **空态居中**，`flex-1` 撑满面板是居中成立的前提（有断言）。**居中用里层 `m-auto` + 外层 `overflow-auto`，不用 `justify-center`**：面板比这一块矮时后者往上下两头溢出，顶上那截滚不到；auto margin 放不下时归零，从顶上排起、照常能滚（有断言）。
  - **其余提示（loading / error / binary / too-large / symlink）仍是 `Notice` 贴左上**：它们说的是「这个文件怎么了」，居中反而像整个面板坏了。
- **`Panel` 由两个视图共用**：各写一份时漂开的症状是「其中一个面板底下那半屏不跟着滚」。

## 文件视图

**右侧那一份是只读全文，不是 diff。** `FilePayload` 五个 `kind` 全部在 `FileView` 分支，提示行与 `DiffView` 共用 `Notice`，`image` 那一支共用 `ImageView.tsx`。

- **语言判定与 diff 视图同为 `languageOf(path)`**（`diff/hljs.ts`），它内部先 `getLanguage()` 探一下：`highlight()` 传未注册的语言名会抛，而这里没有别的兜底，抛出去炸的是整个文件视图。取不到退回 `plaintext`（见 [`diff-render.md`](diff-render.md)）。
- **行号做成兄弟元素，不按行切高亮输出**：hljs 的 span 会跨行，切开就是在重写被禁止的高亮切分逻辑。行号槽 `sticky left-0`。
- **`sticky left-0` 要成立，正文那一层必须是 `w-max`**：普通块盒只有面板宽，行号槽没有滑动余量，横向一滚整列行号跟着滑出视口，而 `sticky left-0` 字样还在原地。
- **但 `w-max` 只能给正文那一路**，判据是按 `kind` 穷举的 `NEEDS_WIDE_BOX` 表（`Record` 漏键是编译错误，写成 `kind === 'text'` 一句则是第二处独立判定）：`max-content` 下提示行那几句散文会排成一行跑出面板，`break-all` 也救不了（实测读数见 [`../decisions/web.md`](../decisions/web.md)）。以上有断言。
- 标签栏在滚动容器之外，不参与横向滚动。
- **复制全文（`Copy file contents`）**：活动 tab 是 file 且全文 `ready`、`kind === 'text'` 时，标签栏右端的动作区画这一枚，把缓存里那份 `payload.content` 原文写进剪贴板——不是 hljs 输出，也不带行号。其余 kind、`loading` / `error`、diff 与 commit tab 都不画：没有正文可复制，灰着一枚按钮只是一块死区。写剪贴板与 `Check` + `Copied` 反馈复用行内动作那枚 `CopyButton`（规矩在 [`web.md`](web.md) 的「行内动作」）。**按钮按活动 tab 的键 `key`**：切 tab 时 `Copied` 归零，不把上一个文件的「已复制」带到这一个上。以上有断言。
- **版式切换（`View inline` / `View side by side`）**：活动 tab 是 diff 或 commit、补丁 `ready` 且 `kind` 为 `text` / `untracked-text` 时，动作区画这一枚（语义在 [`diff-render.md`](diff-render.md) 的「版式：按面板宽度自动切，可手动固定」）。`loading` / `error`、`binary` / `image` / `too-large` 与 file tab 都不画：没有补丁表格可换版式。它与 `Copy file contents` 按 tab 种类互斥：动作区在 diff / commit / commit-changes tab 上至多三枚（预览、忽略空白、版式，自左向右），在 file tab 上至多两枚（预览、复制）。**「按钮数变了活动 tab 再滚进视野一次」的判据覆盖全部四枚**：新开的 diff tab 同样先以 `loading` 激活、补丁就绪后按钮才挤进来。以上有断言。
- **忽略空白（`Hide whitespace changes`）**：活动 tab 是 diff 或 commit、补丁 `ready` 且 `kind === 'text'` 时画（`untracked-text` 不画：全新增的文件没有空白差异可藏）。语义与 git 侧判据在 [`diff-render.md`](diff-render.md) 的「忽略空白」。
  - **它是一枚带按下态的开关（`aria-pressed`），文案恒定**，与搜索框那两枚切换钮共用 `Toggle.tsx`（图标 Lucide `Pilcrow`）；与版式按钮「文案写目标版式」刻意不同：版式是什么一眼看得出，空白藏没藏看不出——开着而认不出来时，用户只会觉得 diff 少了几处改动。
  - **全局一个 signal，不分 tab，不进 `localStorage`**（照 VS Code 那是一个全局设置；不落盘的理由同版式 override）。切换后**只重取活动 tab**，其余切过去时按上一条的「取的那一档与此刻不同」重取。重取期间照常显示旧补丁、不回退 `loading`，与 SSE 刷新同一条。
  - **视图按请求状态里记的那一档渲染，不读此刻的开关**：否则切换后、新补丁回来前的那一段里，旧补丁会按新口径算词级、零 hunk 时说错话。
- **SVG 预览（`Preview`）**：活动 tab 正文 `ready` 且 payload 带 `preview`（diff / commit 是 `text` / `untracked-text`，file 是 `text`）时画，三种 tab 都有。它是 `Toggle`（图标 Lucide `Eye`），**全局一个 signal、默认开、不进 `localStorage`**，与忽略空白同一条理由。开着时视图把那份 `preview` 交给图片视图（`ImageDiff` / `ImageFile`），版式与忽略空白两枚不画——没有补丁表格可换；复制照留，复制的仍是原文。**判据只认 `preview` 字段**，不判扩展名。不重取：`preview` 本来就在已到的 payload 上。**挂着跳行请求（全仓搜索的命中）的那个 file tab 按文本画、按钮显示未按下，全局开关不动**：预览态下那一行不在面板上，跳行请求会一直挂着、等关掉预览时冷不丁滚过去；而改全局开关会让此后打开的每个 SVG 都莫名回到文本。在这个 tab 上按下 `Preview` 即清掉跳行请求、按图画。「此刻按不按图画」只有 `shownPreview` 一处判，视图与按钮都读它。
- **跳到行（全仓搜索的命中行）**：`openFile` 带 `line` 时在 `state/editors.ts` 记一份 `revealRequest { path, line }`，`FileView` 在 `text` 就绪且路径对得上时把那一行滚到面板竖直居中，并在那一行画一条绝对定位的整行高亮带。**行的位置按 `(line - 1) × 行高` 算**——行号槽靠同一个 `leading-5` 对齐，正文是一整块 hljs 输出、不按行切（理由同上）。每次请求都是一个新对象、跳行 effect 依赖它的身份，再点同一行也重新滚一次；高亮带留到下一次跳行或切走。**全文已 `ready` 时同样生效**，不等重取。

## 整次提交视图

**`commit-changes` tab 的正文是一个滚动容器，提交里每个文件一段，次序同 History 展开后那一列**（`CommitChangesView.tsx`）。文件清单就是 History 展开时那份 `commitDetails`（`ensureCommitDetail`：没展开过就此刻取，失败了再进来即重试）；每段的补丁走 `/api/commit-diff`，与 commit tab 同一个取法（`store.ts` 的 `loadCommitPatch`），不新增路由。

- **段头粘性**（`sticky top-0`，实心底色盖住滚上去的补丁）：折叠三角 + 文件名 + 目录（同住一个 `truncate` span，理由同变更列表）+ 状态字母 + `Copy path`。点段头折起 / 展开那一段，折起的段不画段体、也不取。**折叠态住在组件里**：切 tab 是卸载重挂，回来时全部展开，与「滚动位置不保留」同一个样子。重命名的旧路径照 commit tab 由段体顶上的 `RenameNotice` 说。
- **按视口懒加载**：一段进入面板可视区附近（`IntersectionObserver`，上下各多一屏左右的 `rootMargin`）才取它的补丁。一个提交改几百个文件也只取看得到的那几段；一个观察者给全部段共用。**root 必须是面板那层滚动容器，不能是视口**：`rootMargin` 只放大 root，祖先 `overflow` 的裁剪不跟着放——以视口为 root 时「附近」那一圈被面板裁掉，滚到哪段才开始取哪段，每段都先闪一拍 `Loading…`。**还没取到的段占半屏高（`min-h-[50vh]`）**：只画一行 `Loading…` 时一段才八十多像素，首次挂载那一刻面板加上下边距里能塞下二三十段，一打开就是二三十趟 `git diff`；占位撑高之后首屏先取三四段；它们取回来缩到实际高度，又会把后面几段带进边距，补丁都短时首屏会接着多取几段（本仓库一次 22 个文件的提交实测从 22 趟降到 8 趟），其余随滚动逐段进入边距再取。代价是段取回来时从半屏缩到实际高度，后面的段跟着往上挪：落地的段在视口之下时看着的那一段不动；**在视口之上时（直接跳到一个大提交的中段，上方那一屏的占位也在边距里被取）正在读的内容会被往上顶**——Chrome 与 Firefox 的 scroll anchoring 会补偿这一下，Safari 没有。已知取舍，未做补偿：要做就是落地时按高度差回写 `scrollTop`。
- **缓存 `commitChangesCache`，键 `<sha>:<path>`**：tab 关掉、或作为预览 tab 被顶掉时**整组** `forget`——删缓存与作废在途成对，同 `PathCache` 那一条，漏掉作废时关掉的 tab 再打开先看到一份过期的。**不跟 SSE**，`ready` 了就不再取；`error` 的段在重新进入视口时重取；取的那一档与此刻不同（切了忽略空白、点开了折叠行）时**可见的段**当场重取，看不见的等进入视口再取。判据与 commit tab 的 `refetch` 是同一个函数，重取不回退 `loading`（记 `pending`）的理由也同那一条。
- **上下文档按段记**（`hunks` / `full` / `unavailable`，三档的规则同 tab 上那一格），存在 `store.ts` 一张按段键的表里，随整组 `forget` 归零。**不挂在 tab 上**：点开一段的折叠行不该让同一个 tab 里其余几百段此后都按整份上下文取。`Patch` 因此不再自己按 tab 键去查上下文档，由调用方把「此刻哪一档」与「点开一段时做什么」交进去。
- **段体复用 `DiffView.tsx` 的 `Payload`**：图片、二进制、过大、SVG 预览走现有分支，提示文案一字不改。**图片与 SVG 预览在段内限高**：它们在 commit tab 里是占满面板的那种（`fill`），段里没有「面板剩余高度」可吃，`ImageRow` 高为 0 时退回只限宽，一张高图就把后面几段推出好几屏；所以段体给它们一块固定高度的一列 flex 当基准。
- **顶上的说明行**：合并提交画 `Merge commit · compared with first parent`（同 commit tab）。详情 `Loading…` / 出错 / 浅克隆 `Shallow clone — parent not available` / `No file changes` 走 `Notice`，文案同 History 展开那一层。
- **动作区**：忽略空白与版式切换在详情就绪且有文件时就画，**不看已取到的段里有没有 `text`**：段是懒加载的，按此刻取到的几段判时按钮会随滚动进出。`Preview` 只能看已取到的段（前端不判扩展名）：任一段的 payload 带 `preview` 时画，按下态就是全局开关本身——这个 tab 没有跳行请求可压它。三个开关都全局生效；切忽略空白时只有可见的段重取。

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
