# 前端：右侧面板、编辑器标签页与分屏

> 右侧面板是 [`web.md`](web.md) 那副骨架的右半边：一条标签栏 + 一个视图（diff 或全文）。正文视图在 [`views.md`](views.md)，diff 怎么渲染在 [`diff-render.md`](diff-render.md)。被排除的做法见 [`../decisions/editors.md`](../decisions/editors.md)。标「有断言」的条目由 `test/unit/web/` 钉住、不进红线。

## 编辑器标签页

**右侧面板顶部是一条标签栏，可以同时挂多个文件；左栏单击是预览、双击是固定，照 VS Code 编辑区的惯例。** 状态在 `state/editors.ts`：一到两个编辑器组（见下文「分屏」），每组是一个有序的 tab 列表 + 一个活动键，此刻画哪个视图由活动项的 `kind` 派生，不另设 `activePane`——两份就有「谁是真的」这个问题。

- **tab 的身份是 `kind:path`**：同一路径的 diff 与全文是两个 tab（VS Code 同样如此）；合成一个就得再记一份「此刻显示哪种」，切换时另一种的滚动位置也丢。键只用来比对、不反解析。
- **预览 tab 每组只有一个，判据是该组里 `pinned === false` 的那一项，不是「最后打开的」**。单击不在栏里的文件：有预览 tab 就**原位**替换，没有就追加；单击已在栏里的只是切过去。
  - **`openEditor` 的 `pinned` 档给 `Open file` 用**（照 VS Code `git.openFile` 的 `preview: false`）：不在栏里就追加一个固定 tab、不碰现有预览 tab，已在栏里就固定并切过去。调用方不自己「先开预览再 pin」——那样会先顶掉一个无辜的预览 tab。
  - **`pinEditor` 是幂等的置 `true`，永不 toggle**：一次双击是 click、click、dblclick 三个事件，写成 toggle 会让已固定的 tab 在双击时静默解开。**dblclick 只调 `pinEditor`、不再走 `selectFile`**，否则一次双击是三趟 `git diff`。
- **第三种 tab 是 `commit`，身份是 `commit:<sha>:<path>`**：`Editor` 多带一个 `sha`，`path` 仍是文件路径，其余读 `path` 的地方照旧。tab 上文件名后跟短哈希，图标 `GitCommitHorizontal`。**正文顶上只有合并提交多一行 `Merge commit · compared with first parent`**（补丁相对第一父，这件事只在看补丁时才需要知道）；普通提交不画「这是哪次提交」——短哈希已在 tab 上、主题在 History 那一行，再印一遍只是占掉一行补丁。**它活动时 `activeEditorPath` 是 `null`**：左栏同名那一行说的是工作区那一份，照亮它是在说一件不成立的事——这是「高亮不看种类」唯一的例外，判据是「左栏那一行与右侧是不是同一份内容」。
- **第四种 tab 是 `commit-changes`：一次提交的全部文件排在一个 tab 里，身份是 `commit-changes:<sha>`**（照 VS Code Graph 的 `Open Changes`，那是一个多文件 diff 视图）。入口在 History 提交行的 `Open Changes`（见 [`sidebar.md`](sidebar.md)），单击开预览 tab、双击 tab 固定。`path` 存的也是 sha，只用于比对；`worktreePathOf` 对它回 `null`，左栏不亮、tab 不染色，判据同 commit tab。tab 上是 `<短哈希> · <主题>`，主题在打开时从 History 那一行带进 `Editor`、跟着 tab 走——详情此刻可能还没取，现找就是先画一拍空名字；图标 `GitCompare`。**不参与同名目录消歧**：它没有文件名，拿 sha 当路径去比只会和谁都不撞、白占一格。正文见 [`views.md`](views.md) 的「整次提交视图」。
- **第五种 tab 是 `changes`：工作区此刻的全部改动排在一个 tab 里，身份是 `changes:`，全局只此一个**（照 VS Code Source Control 的多文件 diff 视图）。入口是 `CHANGES` 分区标题右端那枚 `Open Changes`（见 [`sidebar.md`](sidebar.md) 的「提交历史」那节开头的两个分区），单击开预览 tab、双击 tab 固定。tab 上只写 `Changes`，图标同 commit-changes 的 `GitCompare`，`path` 是空串、只用于比对。`worktreePathOf` 对它回 `null`：它不是某一个文件，左栏哪一行都不该亮、tab 也不染色；不参与同名目录消歧，理由同 commit-changes。正文见 [`views.md`](views.md) 的「工作区改动视图」。
- **diff 与 commit tab 各带一个上下文档 `context: 'hunks' | 'full' | 'unavailable'`**，起步 `hunks`。点开第一段折叠行时写成 `full`（diff tab 那一行已不在变更列表里时不写：那一下发不出请求，点的那一段会一直停在 `Loading…`），此后这个 tab 的每次重取（SSE、切回来）都带 `fullContext=1`；带着它取回来的 `text` 却是 `full: false`（后端说过不了闸）、或者是 `too-large`（留在 `full` 时每个 SSE 都先按整份上下文撞一次闸、再退回 3 行撞一次）时写成 `unavailable`，此后退回 3 行上下文、折叠行不可点（展示规则在 [`diff-render.md`](diff-render.md) 的「没改的行」）。**它住在 tab 上，不住在缓存里**：`renameEditor` 原样带走，并入同名 tab 时取三档里靠后的那个（`unavailable` > `full` > `hunks`）；关掉、或作为预览 tab 被顶掉即归零。住在缓存里时每次 `forget` 都会把「用户点开过」一并忘掉。`unavailable` 不会自己回到 `full`：文件后来变小了也要关掉重开——已知取舍，否则每个 SSE 都要先撞一次闸再退回。
- **关掉活动 tab 切到右邻居、没有才切左邻居**，不维护 MRU 序列。
- **两栏的高亮同按活动 tab 的路径判（`activeEditorPath`），不看 diff 还是全文**：按种类各认各的时，点了行内 `Open file` 那一行就熄了——用户刚从这一行出发，左栏却说「你没在看它」。
- **切侧栏 tab、切列表 / 树版式、全部折叠，都不动 `activeEditor`**（症状见 [`web.md`](web.md) 的「页面骨架」）。**反方向有联动**：活动 tab 的路径一变，`Files` 树展开并定位那一行（机制在 [`sidebar.md`](sidebar.md) 的「文件浏览器」），但不切侧栏档位。
- **不进 `localStorage`**（跨不了实例，见 [`web.md`](web.md) 的「主题开关」）。

### 自动刷新怎么收编这些 tab

**每次 SSE 之后要过一遍栏里全部的 diff tab，不只活动那一个**：改动被撤销或 commit 掉的关掉，重命名的跟到新路径。只看活动 tab 时，后台 tab 里那份补丁照样留着，切过去看到的是左栏已断言不存在的东西，且它再也不会被刷新。

- **重命名不算消失**：先按 `path` 找、再按 `oldPath` 找，命中就 `renameEditor`（`pinned` 不变，活动键跟着走）。**两趟而不是一趟 `||`**：A→B 后又在 A 新建文件时两条都命中，该跟的是路径就是 A 的那条。**新路径上已有 tab 时并入它**：幸存者保位置，`pinned` 取或。
- **只重取看得见的那几个（每组的活动 tab，`visibleEditors`，同键去重），其余切过去时再取**（`activateEditor` 每次都真的去取）：栏里 10 个 diff tab 时，否则每个事件 10 趟 `git diff`；分屏时两组的活动 tab 都在屏幕上，只取焦点组的那一个时另一组停在旧补丁上。切过去时缓存照常显示、新的回来再换，同一个 path 已 `ready` 就不回退 `loading`，不闪。**`refresh()` 内部用 `removeEditor` 而不是 `closeEditor`**：后者会顺手重取邻居，与 `refresh()` 末尾那次叠成两趟。
- **在途的请求要一并作废**：否则关掉 X 后那次请求照样写进缓存，下次打开 X 先看到它。手段是按路径 `claim` 一张票（`http.ts` 的 `latestWins`），**与删缓存成对写在 `forget()` 里**——漏掉作废那一半没有任何东西会红。
- **commit-changes tab 同样不收编**：切过去时 `refetch` 只补取提交详情（失败了才重取，取到过就不动），各段的补丁由视图按可见性自己取（见 [`views.md`](views.md) 的「整次提交视图」）。
- **changes tab 不收编、永不自动关**：改动全清空时正文说 `No changes`，等下一批改动再排出来——它看的是整个工作区，不是某一行改动，判据同 file tab。按 diff tab 那条「左栏已断言不存在就关」去关，agent 每提交一次，用户正盯着的这个 tab 就消失一次。SSE 时 `refresh` 只替它剪掉不在新列表里的段，要不要重取由视图里的段自己判（见 [`views.md`](views.md) 的「工作区改动视图」）。
- **commit tab 不收编，`ready` 了就不再取**：提交不可变，SSE 与它无关。**在途（`loading`）也不重取**：每次 SSE 都重发时新票作废旧票，慢补丁在 agent 跑动期间永远落不了地。**只有 `error` 的才在切过去时重取**，否则唯一的重试路径是回 History 重新点。提交被 gc 掉时那一次写成 `error`。**例外是取的那一档与此刻不同**：请求状态记着一档（`loading` 记的是这一趟问了什么，`ready` 记的是**这份补丁是什么**——整份上下文只认 payload 的 `full`，被退回 3 行的就记成关），与此刻的开关和 tab 的上下文档不一致时照常重取——这两样只在用户点了什么时才变，不会有 SSE 那种饿死。**这一趟重取不回退 `loading`**：手上已有一份时照常显示它、在状态上记一笔 `pending`（这一趟按哪一档在取），`refetch` 拿它判「已经在取了」；回退 `loading` 会让表格卸载重挂，点开折叠行的那一刻展开状态（住在组件里）跟着没了。
- **file tab 永不自动关**：文件被删也只是那一次 `loadFile` 写成 `error`。
- **每组活动的 file tab 都在 `loadState()` 之前就重取**，不等新列表：它的数据源是工作区本身。收编后活动键变了才对新活动的 file tab 补取一次。

## 分屏（编辑器组）

**右侧面板最多两组编辑器，左右并排**（照 VS Code 的 editor group，封顶两组、不做上下与网格）。状态是 `groups`（长度 1 或 2）+ 焦点组 `activeGroup`；每组一个 `EditorGroup`：自己的 tab 列表、活动键、量出来的宽度。`editors` / `activeEditorKey` / `activeEditor` / `activeEditorPath` 是**焦点组**的只读派生。

- **入口是拖动与一条快捷键**：把 tab 拖到另一组的正文或标签栏，或在只有一组时拖到正文贴左 / 右边的那 1/3（在那一边分出新组，遮罩盖那半边；分到左边时原来那组退到右边，按组 `id` 挂载、不重挂）。**正文中间那 1/3 不收**（照 VS Code）：拖出 tab 后反悔、在本组正文上松手时什么都不该发生；键盘上 `⌘\` / `Ctrl+\` 见下一条。拖动走 HTML5 drag and drop，**拖的是哪个 tab 记在 `draggingEditor` 这个 signal 上，不从 `dataTransfer` 里读**：`dataTransfer` 只在 `drop` 时可读、`dragover` 时读不到内容，而判投放区恰恰在 `dragover`；`dataTransfer` 上只写一份占位（Firefox 不写不起拖）。投放区画一层 `pointer-events: none` 的遮罩，颜色 `editor-group-drop-background`。
- **快捷键是复制，不是移动**（`splitActiveEditor`，照 VS Code `workbench.action.splitEditor`）：焦点组的活动 tab 在另一组再开一份并固定，焦点跟过去，源组不动。**DOM 焦点也要跟过去**（`groupFocusRequest`，目标组渲染完之后聚焦它的活动 tab；signal effect 的通知排在渲染之后，新开的 tab 已经在 DOM 里）：只改焦点组时键盘焦点还留在源组，下一次 Tab 落在源组里，`focusin` 就把焦点组换了回去，之后 Quick Open 与左栏的点击又开回源组。只有一组时先分出右组，已有两组时就开在另一组，**不分第三组**。所以**只有一个 tab 的组也能分**——源组那份留着，不会移空。另一组已开着同键时只切过去，同拖动。按住不放的自动重复与 Quick Open 开着时不认（前者让焦点在两组间来回跳，后者在浮层底下换掉焦点组、选中的文件开到另一组），但照样 `preventDefault`。不另发请求：源组那份正在屏幕上、缓存两组共用，新开的这份拿到的就是最新的。HTML5 drag and drop 对键盘不可达，没有这条时只用键盘的人打不开第二组，两组之间那把「键盘可达」的把手也就无从谈起。
- **只有一个 tab 的组不能再拖出新组**：分出去等于原地不动，左右两半的投放区都不亮。**同一组内拖动不排序**，标签栏只接受来自另一组的 tab，插到指针落在的那个 tab 之前或之后。
- **拖过去即固定**（照 VS Code）：拖动是明确意图，留成预览会被下一次单击顶掉。目标组已开着同键时只切过去，不并排两个同键 tab；上下文档取靠后的那档。
- **组空即合并**：拖走、关掉、或被 SSE 收编掉最后一个 tab 时这一组消失，焦点落到剩下那组；只剩一组时空着就画空态。**两组时永远没有空组**——空组只会是一块不能做任何事的白地。
- **焦点组**：组的根元素 `pointerdown` / `focusin` 时成为焦点组。左栏的单击、双击、`Open file`、Quick Open、搜索命中、History 一律开在焦点组；左栏的高亮与 `Files` 树的定位跟焦点组的活动 tab 走。**非焦点组的活动 tab 文字用次要前景色**：否则看不出左栏此刻跟的是哪一组。动作区的按钮作用于**所在那一组**的活动 tab，不读焦点组——点下去之前焦点不一定已经过来。
- **同一个 tab 可以两组各开一份**：两份共用同一格缓存（缓存按路径 / 键存，不按组）。所以**关掉一份、或作为预览被顶掉时，另一组还开着同键就不 `forget`**（判据 `isOpenAnywhere`）：否则另一组那份的缓存被删、在途请求被作废，它退回 `Loading…`、再也不取。**上下文档跨组同步**：`setEditorContext` 改写所有组里同键的那一项，新开同键 tab 与逐组改名并入之后对齐到靠后的那档（`syncContext`）；各持一档时两组的请求会轮流改写同一格缓存。
- **两组之间的把手调左组占的百分比**（`splitPercent`，20–80，默认 50，一位小数），以 signal 本身交给 `style`、拖动时不重渲染，与左栏、History 那两把同一个 `Sash.tsx`；双击复位、方向键可调、刷新后保留（同左栏宽度，见 [`web.md`](web.md)）。**把手挂在 `App` 里两组之间一个零宽的 `relative` 槽里，不挂进左组**：挂进去时左组「被点到即成为焦点组」那条会把拖把手也算进去，焦点组跟着跳。
- **两组的视图各自卸载重挂**、各自滚动；跳行请求（`revealRequest`）不分组，两组开着同一个文件时两边都跳——不为此分组。

## 标签栏与视图

**标签栏是面板唯一的 chrome，排在滚动区域之外。** 面板是一列 flex：`EditorTabs` 占第一行，底下 `Panel` 那一层（`min-h-0 flex-1 overflow-auto`）才滚。不再有路径横杠或面包屑——「在看哪个文件」由活动 tab 回答，完整路径挂在 tab 的 `title` 上。

- **一个 tab = 种类图标 + 文件名 +（同名时的）目录 + 关闭按钮**（commit-changes 是图标 + 短哈希 + 主题，见上文）。图标按 `kind`（`FileDiff` / `FileCode` / `GitCommitHorizontal` / `GitCompare`，同一张 `KIND_ICON`；changes 与 commit-changes 同一枚，它们是同一种多文件视图，tab 上的字已经分得开），是同一路径两个 tab 之间唯一的视觉差别。文件名与目录**同住一个 `truncate` span**，理由同变更列表。预览 tab 的名字 `italic`。
  - **目录只在栏里有同名文件时才画，且只画最短可区分后缀**（照 VS Code `labelFormat: default`）：常显时每个 tab 都宽出一截，栏里多数时候并没有要区分的东西。判据是「栏里有**不同路径**的 tab 文件名相同」——同一路径的 diff / file / commit tab 不算，它们之间靠图标与短哈希区分，目录一模一样、画了也分不开。段数 = 1 + 与其余每个同名路径的公共尾段数的最大值，截到全长；没取全时前面写 `…/`，根目录下的文件没有目录段、画空（`packages/{foo,bar}/src/index.ts` → `…/foo/src` 与 `…/bar/src`）。**取尾段而不是整段目录**：能区分的那段常在中间，整段画出来会被 `max-w-64` 从右端裁掉，剩下的两个 tab 还是一个样。完整路径照旧在 `title` 上。表在 `EditorTabs` 按整栏算一次再逐个下发——单个 tab 看不见邻居，关掉一个同名 tab 时另一个的目录要跟着消失。
  - **文件名按 git 状态染色**（照 VS Code `workbench.editor.decorations.colors`），查的是文件树那一张 `codeByPath`、颜色是同一张 `CODE_COLORS`：同一个文件在树上与 tab 上必须是同一个颜色，自己再按 `FileEntry` 推一遍会在冲突、暂存加改动这些归并上漂开。只染名字，目录与短哈希自带次要色。**commit tab 不染**：它是一份历史补丁，工作区此刻的状态说的不是它——与「commit tab 活动时 `activeEditorPath` 为 `null`」同一条判据，两处都调 `worktreePathOf`，不各写一遍 `kind === 'commit'`——多一种显示非工作区内容的 tab 时只改了一处，症状是 tab 染着工作区的色、左栏却不亮。**每个 `Tab` 用 `useComputed` 取自己那一格**（同文件树的行）：`codeByPath` 每个 SSE 都换一份，直接读时每次刷新整栏重画。这里包 prop 不会停在上一个（与下面 `DiffView` 那条不同）：`Tab` 按 `keyOf` 挂载，路径与种类都在键里，改名即重挂。
  - **关闭按钮只在活动 tab 上常显，其余悬停或键盘焦点在 tab 内时才露出**（照 VS Code）。**用透明度藏而不是不渲染**：位置留着，悬停时 tab 宽度不跳。键盘那半条是 `group-focus-within`（不是行内动作那种 `has-focus-visible`）：活动 tab 本来就常亮着 ×，鼠标点过后焦点留在 tab 内也不会多钉住什么。`IconButton` 的悬停底色是半透明叠加的 `toolbar-hover-background`，否则在非活动 tab 的悬停底色上看不出反应。
- **关闭按钮是 tab 按钮的兄弟，不是孩子**：套在里面时 tab 不是按钮，得手写 `tabIndex` / Enter / Space、另开手型光标规则、每个处理器加「来自 × 的事件不处理」守卫（不守时快速双击 × 会把滑到指针底下的邻居静默固定住），且 `role="tab"` 的子元素在无障碍树里只当文本、读屏看不见 ×。并排之后这些一起消失。中键（`auxclick` 且 `button === 1`）也关闭。`role="tablist"` 带 `aria-label="Open editors"`。
- **栏是两层：外层管高度、底色与通栏分隔线，里面的 `role="tablist"` 只装 tab、管横向滚动，右端的编辑器动作区是 tablist 的兄弟**——与侧栏那行 tab 同一种切法。动作按钮躺进 tablist 时读屏把它报成又一个 tab，且会随 tab 一起横向滚出视野。动作区 `shrink-0`，tab 再多也钉在右端。
- **选中态是 tab 自己的 `border-b`，通栏分隔线是外层的 `divider-b`（inset 阴影）——与侧栏那行 tab 同一套机制**。**这一栏是这套机制存在的理由**：tablist 是滚动容器，按 padding box 裁内容，「`border-b` + tab `-mb-px`」的教科书写法伸进 border 带的那 1px 会被裁掉——下划线看不见，还留下 1px 纵向可滚溢出，「始终显示滚动条」的系统设置下就是一条常驻滚动条。tablist 被 flex 拉满外层高度，tab 的 `border-b` 于是落在外层阴影那 1px 上、画在它上面。活动 tab 带 `bg-editor-background`，与正文连成一片。
- **栏与左栏顶栏同高**（有断言）。**tablist 横向滚动、每个 tab `shrink-0`、滚动条隐藏（`scrollbar-none`）**：画出滚动条时栏会被撑高、与顶栏错开。**活动 tab 要自己滚进视野**（`scrollIntoView`，`inline: 'nearest'`）：否则溢出后新开的 tab 在屏幕外，正文换了而栏上看不出变化。**动作区的按钮数变了也再滚一次**（有断言），判据是数按钮的那一个 computed（每组一份的 `actionCount`），不是「画不画」——在 `text` 与 `untracked-text` 两种补丁之间切时，版式按钮一直在，忽略空白那一枚却会进出：新开的全文 tab 先以 `loading` 激活、滚到 tablist 末端，正文就绪后复制按钮才挤进来，tablist 窄一截而 `scrollLeft` 不动，活动 tab 的右端连同 × 就被裁掉。拖窄侧栏或窗口同样会让 tablist 变窄，那一路不跟——要接 `ResizeObserver`，眼下不做。
- **切 tab 是卸载重挂，滚动位置不保留**：一份 diff 的 DOM 动辄数万行，N 个 tab 常驻挂载等于 N 份 DOM，`outputFormat` 一变每份都要重排。**卸载重挂靠 `EditorGroupView` 给视图按 tab 键 `key`**：只换 `path` prop 时 `Panel` 连同 `scrollTop` 留着，B 从 A 的偏移量打开，而换视图种类时又从顶部开始——两种切法必须一个样子。视图里不再另给 `Payload` 一份 `key`。
- **右侧空态只在栏里一个 tab 都没有时画**（`PanelEmptyState`），照 VS Code 的空编辑区列**一列全局快捷键**（`Go to File` / `Search` / `Split Editor`，前两条的名字与顶栏按钮、侧栏 tab 同一份），不再说「点左边一个文件」——左栏就在旁边，这句不带信息。**不画 VS Code 列表上方那枚大号 logo 水印**：试过，放在这个面板里看着突兀。
  - **不说「工作区干净」**：左栏 `Changes` 档空着已经答了「为什么没得看」，右侧再说一遍只是重复。
  - **快捷键列表与全局快捷键同一份清单**（`state/shortcuts.ts` 的 `SHORTCUTS`），只展示、不可点——前两条的入口在顶栏与侧栏 tab 上已经有了，`Split Editor` 有拖动。**布局照 VS Code**：一行一条、名字靠左、按键靠右；宽度随内容、两列只隔一小段（定宽时名字与按键离得太远，看着不像一行）；按键各一个 `<kbd>`，配色取 VS Code 的 `keybindingLabel.*`，按平台写 `⌘` 或 `Ctrl`。**按键那一列 `aria-hidden`**，读屏只念名字：一串 `⇧⌘F` 念出来是「shift symbol, place of interest sign」，与按钮 tooltip 里快捷键不进无障碍名同一条理由。
  - **空态居中**，`flex-1` 撑满面板是居中成立的前提（有断言）。**居中用里层 `m-auto` + 外层 `overflow-auto`，不用 `justify-center`**：面板比这一块矮时后者往上下两头溢出，顶上那截滚不到；auto margin 放不下时归零，从顶上排起、照常能滚（有断言）。
  - **其余提示（loading / error / binary / too-large / symlink）仍是 `Notice` 贴左上**：它们说的是「这个文件怎么了」，居中反而像整个面板坏了。

### 动作区

**标签栏右端的动作区按活动 tab 的种类与正文状态画按钮**；正文那一侧怎么响应各开关在 [`views.md`](views.md)。

- **复制全文（`Copy file contents`）**：活动 tab 是 file 且全文 `ready`、`kind === 'text'` 时，标签栏右端的动作区画这一枚，把缓存里那份 `payload.content` 原文写进剪贴板——不是 hljs 输出，也不带行号。其余 kind、`loading` / `error`、diff 与 commit tab 都不画：没有正文可复制，灰着一枚按钮只是一块死区。写剪贴板与 `Check` + `Copied` 反馈复用行内动作那枚 `CopyButton`（规矩在 [`web.md`](web.md) 的「行内动作」）。**按钮按活动 tab 的键 `key`**：切 tab 时 `Copied` 归零，不把上一个文件的「已复制」带到这一个上。以上有断言。
- **自动换行（`Word Wrap`，照 VS Code 的 `editor.wordWrap`）**：活动 tab 是 file、全文 `ready`、`kind === 'text'` 且没按图画着时，动作区在复制左边画这一枚 `Toggle`（图标 Lucide `TextWrap`）。**全局一个 signal、默认关、不进 `localStorage`**，理由同忽略空白。正文怎么折见 [`views.md`](views.md) 的「文件视图」。
- **版式切换（`View inline` / `View side by side`）**：活动 tab 是 diff 或 commit、补丁 `ready` 且 `kind` 为 `text` / `untracked-text` 时，动作区画这一枚（语义在 [`diff-render.md`](diff-render.md) 的「版式：按面板宽度自动切，可手动固定」）。`loading` / `error`、`binary` / `image` / `too-large` 与 file tab 都不画：没有补丁表格可换版式。它与 `Copy file contents` 按 tab 种类互斥：动作区在 diff / commit / commit-changes / changes tab 上至多三枚（预览、忽略空白、版式，自左向右），在 file tab 上至多三枚（预览、自动换行、复制；按渲染画 markdown 时没有自动换行）。**上文「按钮数变了也再滚一次」的判据覆盖全部五枚**：新开的 diff tab 同样先以 `loading` 激活、补丁就绪后按钮才挤进来。以上有断言。
- **忽略空白（`Hide whitespace changes`）**：活动 tab 是 diff 或 commit、补丁 `ready` 且 `kind === 'text'` 时画（`untracked-text` 不画：全新增的文件没有空白差异可藏）。语义与 git 侧判据在 [`diff-render.md`](diff-render.md) 的「忽略空白」。
  - **它是一枚带按下态的开关（`aria-pressed`），文案恒定**，与搜索框那两枚切换钮共用 `Toggle.tsx`（图标 Lucide `Pilcrow`）；与版式按钮「文案写目标版式」刻意不同：版式是什么一眼看得出，空白藏没藏看不出——开着而认不出来时，用户只会觉得 diff 少了几处改动。
  - **全局一个 signal，不分 tab，不进 `localStorage`**（照 VS Code 那是一个全局设置；不落盘的理由同版式 override）。切换后**只重取活动 tab**，其余切过去时再重取（判据在上文「自动刷新怎么收编这些 tab」）。重取期间照常显示旧补丁、不回退 `loading`，与 SSE 刷新同一条。
- **SVG 预览（`Preview`）**：活动 tab 正文 `ready` 且 payload 带 `preview`（diff / commit 是 `text` / `untracked-text`，file 是 `text`）时画，三种 tab 都有。它是 `Toggle`（图标 Lucide `Eye`），**全局一个 signal、默认开、不进 `localStorage`**，与忽略空白同一条理由。开着时版式与忽略空白两枚不画——没有补丁表格可换；复制照留，复制的仍是原文。**判据只认 `preview` 字段**，不判扩展名。不重取：`preview` 本来就在已到的 payload 上。挂着跳行请求的 file tab 上按钮显示未按下，见 [`views.md`](views.md) 的「文件视图」。
- **Markdown 预览（同一枚 `Preview`）**：只在 file tab 上，活动 tab 全文 `ready` 且 payload 是带 `markdown: true` 的 `text` 时画（diff / commit / 多文件视图不做：两版渲染后并排对照不说明改了哪一行）。**开关与 SVG 那个是两个 signal**：markdown 默认关（照 VS Code，打开 `.md` 先看源码），SVG 默认开，共用一个时总有一边的默认是错的；同样全局、不进 `localStorage`。一个文件不会两者都带（扩展名互斥），所以按钮仍只一枚，点下去翻的是这个 payload 带着的那一种。开着时自动换行不画（正文自己折行），复制照留、复制的仍是原文。
- **多文件视图（commit-changes / changes tab）**：忽略空白与版式切换在详情就绪且有文件时就画，**不看已取到的段里有没有 `text`**：段是懒加载的，按此刻取到的几段判时按钮会随滚动进出。`Preview` 只能看已取到的段（前端不判扩展名）：任一段的 payload 带 `preview` 时画，按下态就是全局开关本身——这个 tab 没有跳行请求可压它。三个开关都全局生效；切忽略空白时只有可见的段重取。
