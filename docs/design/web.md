# 前端：界面文案、页面骨架与变更列表

> **TypeScript + Preact + @preact/signals，经 Vite 构建为静态产物**，由后端直接托管。本文件管页面骨架与左栏的变更列表，文件浏览器、提交历史与分支列表在 [`sidebar.md`](sidebar.md)；右侧面板（编辑器标签页、diff / 文件两个视图的外壳、文件视图）在 [`editors.md`](editors.md)，diff 怎么渲染在 [`diff-render.md`](diff-render.md)，配色与层叠隔离在 [`style.md`](style.md)。选型与被排除的做法见 [`../decisions/web.md`](../decisions/web.md)，门禁见 [`../gates.md`](../gates.md)。标「有断言」的条目由 `test/unit/web/` 钉住、不进红线。

## 界面文案与术语

**界面文案一律英文，`<html lang>` 为 `en`。** 判据是**产品表面与文档分属两个读者**：`docs/` 与代码注释写给维护者，中文；分发形态是 npm 全局包，CLI 的 `--help`、退出提示、版本守卫报错本来就是英文。中文读者由 `README.zh-CN.md` 承接。

- 分支与进行中操作的术语跟 git 自己的用词走（`Detached HEAD` / `Rebasing`），不自造同义词——那一栏用户是拿它对照 `git status` 看的。
- **变更列表的组标题与状态字母照 VS Code Source Control 的默认**：组是 `Merge Changes` / `Staged Changes` / `Changes`，未跟踪文件混在 `Changes` 里，字母未跟踪印 `U`、冲突印 `!`。读者每天在编辑器里看的就是那一套，两边各说一种话时同一个 `U` 在两处意思相反。协议层不跟着改：`StatusCode` 仍是 git 的字母，换字只发生在徽章那一张展示映射里（`ChangeList.tsx` 的 `BADGE_LETTERS`）。
- **判据是「`dist/web/` 三个产物里的 CJK 字符数为 0」**，不是逐个文件翻源码：漏网的最可能形态是**不长在 JSX 上的那几条**（`state/store.ts` 的错误文案就这么漏过一次）。
- **后端产物用不了这个判据**：`dist/server/main.js` 刻意保留中文注释以便审计。那一侧的用户可见文案是 `sendError` 与各 `*Error` 的字面量，归 `test/unit/server/`。
- **句点只跟句子走**：标签式的短片段（`No changes` / `Empty` / `Loading…`）末尾不加句点，说明性的完整句子（`Binary file — contents are not compared.`）才加。判据是「它是一个标签还是一句话」，不是长短。
- **出错提示分两段：引导句（`Could not load this file`）与原因逐字各占一行，不拼成一句**——原因的来处不止一个（后端 `sendError`、浏览器的 `TypeError: Failed to fetch`、500 转发的 `ENOENT: …`），大小写与句点各成一派，接在冒号后总有一种读起来像两句话撞在一起。
- **too-large 提示的主语随视图走**：diff 视图说 `Diff too large to show (file is 3.0 MB).`，文件视图说 `File too large to show (3.0 MB).`——diff 那侧 5MB 卡的是补丁字节、`size` 却是文件体积，两边都说「File too large」时同一个文件会在 Files 档里照常显示、在 diff 里说太大。文案在 `tooLargeNotice` 里只写一次，两个视图共用。

## 页面骨架

**外壳是行向 flex：左栏一列（顶栏 → tab 行 → 错误条 → 列表区 → 状态条），右边是编辑器面板（见 [`editors.md`](editors.md)），面板自屏幕顶端满高到底。** 顶栏不横跨全屏——它归左栏。

- **顶栏里是品牌符号 + 项目名 + `Go to File` + 主题开关**。高度与右侧编辑器标签栏钉同一个值，两条底边落在同一条水平线上（有断言）。项目名是 `RepoState.repoName`，对应 VS Code 侧栏顶端的文件夹名——这一栏回答「我在看哪个项目」，产品名答不了。拿不到时退回 `difftab`（共用 `state/title.ts` 导出的 `PRODUCT_NAME`）。
- **`truncate` 必须落在装项目名的那个 `span` 上，不是顶栏本身**：顶栏是 flex 容器，`truncate` 留在容器上不起作用（子项的自动最小尺寸会把它撑开），长目录名漫过右边框或折成第二行，而 `truncate` 字样还在原地，看上去像已经处理过了。符号与开关 `shrink-0`，被裁的永远是名字。
- **分支状态放在左栏底部的状态条**（对应 VS Code 的 status bar），不与项目名挤在顶栏：挤在一行时先被裁掉的恰恰是分支名。状态条随第一份 state 一起出现，拿不到时整条不画。
- **顶栏之下是一行三个 tab（`Changes` / `Files` / `Search`）**，对应 VS Code 的 activity bar，**画成三枚靠左的图标、横排一行**——竖排要再占一列宽，而那一列是从文件名身上扣的。默认档是 `Changes`。提交历史不另占 tab，是 `Changes` 档里的一个分区（见 [`sidebar.md`](sidebar.md) 的「提交历史」）：「还没提交的」与「刚提交的」是同一个问题的两半。
  - **这一行本身不是 tablist**：`role="tablist"` 只挂在装 tab 的那个 div 上，行的右端按当前档站一枚按钮（`Changes` 下是列表 / 树切换，`Files` 下是 `Collapse all`，`Search` 下没有）。按钮写成 tablist 的孩子时读屏会把它报成又一个 tab，页面上看不出来（有断言）。
  - **通栏那条细线必须是行自己的 inset 阴影（`divider-b`），不是 `border-b`**：tab 选中的下划线要盖在它上面，`border` 画在 padding box 之外够不着，选中那一段就成了双线。这套机制与编辑器标签栏共用，全仓库只此一种。下划线用前景色而不是 `focus-border`——后者是键盘焦点的颜色，同色时两件事化成同一种蓝。
  - 行的右内边距与顶栏一致，两处的 `IconButton` 落在同一条竖线上（有断言）。
- **`Changes` 那枚图标与状态条上分支名前的是同一个 import（Lucide `GitBranch`）**，同一概念由编译器保证是同一个图形。所有 `<svg>` 走共用的 `Icon` 外壳，`size` 与 `aria-hidden` 只写一次。
- **只画图标的控件，名字只能由 `aria-label` 给**（`title` 再给一份 tooltip）；掉了它读屏里就是无名控件（有断言）。
- **切 tab 不动右侧面板（`activeEditor`）**：换的是侧栏在列什么，不是用户此刻在读什么。写成「切到 Files 就清空右侧」时页面看着正常，只是每瞄一眼目录树就丢掉正在读的 diff。
- **错误条在左栏内、列表之上**：它说的是「变更列表取不到」，与列表那句兜底文案相邻才成立；横跨全屏会在 diff 面板顶上切一条无关的横杠。
- **分支名前的分支图标在 detached 与取不到名字时照画**——它标的是「这一栏说的是 HEAD 在哪」，按情况藏掉只会让状态条左缘忽进忽出。那一行是基线对齐，图标需要单独居中，否则整个坐在文字基线上（有断言）。
- **分支名（连同图标）是一枚按钮**，点开「分支列表」（见 [`sidebar.md`](sidebar.md)）；detached 时照样可点——列表回答的是「仓库里有哪些 ref」。
- **与上游的差距排成 `<behind>↓ <ahead>↑`**，逐字照 VS Code status bar 的 `syncLabel`——这一栏是拿去与另一个窗口对照的，左右反过来时每看一眼都要在心里翻一次。**两个 0 仍都画出来**：「已同步」与「无上游」必须是两个样子（有断言）。
- **滚动的是中间那一层，不是左栏本身**：顶栏、tab 行、错误条、状态条钉在原处。`Files` 档滚的是 `<nav>` 本身；`Changes` 档滚的是两个分区各自那一层——共用一个滚动容器时历史一长就把变更列表滚出视野。左右两栏各有独立的滚动容器，SSE 刷新才能留住列表的滚动位置。**列表那层必须归零自己的自动最小尺寸**（`min-h-0` 或 `overflow-auto`），否则列表把整列撑高、状态条被挤出屏幕底部。
- **左栏宽度可拖**：`<aside>` 右边缘一条竖向把手（sash，照 VS Code），范围 200–960px、默认 320px，宽度是 `state/sidebar.ts` 的一个 signal。下限给名字留得出几个字，上限防止大屏上把 diff 面板挤到只剩行号（笔记本屏靠下面随窗口收的那道）。把手与「提交历史」那条横向分隔条是同一个组件 `Sash.tsx`。
  - **把手绝对定位叠在边框上**，不占布局宽度——做成第三个 flex 子项时它的宽度会从面板身上扣。悬停与拖动时只显出竖直居中的一小段握把，不是整条边变色。
  - **只有把手用的固定几何写内联样式，不写 Tailwind 类**：每个类都是产物里一条只服务一处的规则，内联样式不进产物。**`touch-action: none` 不能漏**：不带时触屏一按下就被认作滚动、发 `pointercancel`，拖几个像素就断。
  - **拖动走 pointer capture**：指针越过 diff 面板或离开窗口时 move 仍投递给把手。**拖动期间整页挂 `cursor: col-resize` 与 `user-select: none`**，松手（含 `lostpointercapture`）撤掉——不挂时光标一离开把手就闪回箭头、沿途 diff 文字被拖选成一片蓝。
  - **双击复位到 320px；键盘可达**：`role="separator"` + `aria-value*` + `tabIndex=0`，方向键与 Home / End 可调。
  - **上限还要随窗口收，这道交给 CSS**：内联 `max-width: min(960px, calc(100vw - 320px))` + `min-width: 200px`，窄窗口里 diff 面板不会被挤到 0；signal 存的是用户选的宽度，窗口拉回时自己回到原档，不必监听 `resize`。**代价是选的与屏幕上的可能不等**：拖动与键盘的起点读 `shownSidebarWidth()`（按式子算，不量 `offsetWidth`——signal 到 DOM 的绑定是异步的，连发方向键会读到旧值），否则窄窗口里的拖动全落在看不见的区间里。
  - **拖动时一个组件都不重渲染**：宽度以 signal 本身交给 `style`，由 `@preact/signals` 直接改 DOM；在 `App` 里读 `.value` 等于每个 pointermove 重渲整棵树。
  - **宽度不跨会话记忆**（`localStorage` 跨不了实例，见「主题开关」）。
  - 拖宽左栏可能让 diff 面板跨过并排阈值而换版式：**不为此做任何事**，`outputFormat` 量的本来就是面板自身的 border box；手动固定过版式就不再跟（见 [`diff-render.md`](diff-render.md) 的「版式：按面板宽度自动切，可手动固定」）。

## Quick Open 与全局快捷键

**`⌘P` / `Ctrl+P` 或顶栏那枚 `Go to File`（Lucide `FileSearch`）弹出 Quick Open：照 VS Code，一个 quick pick，按文件名模糊匹配全仓文件，选中即以固定 tab 打开全文。** 状态在 `state/quick-open.ts`，组件是 `QuickOpen.tsx`，外壳与分支列表共用 `QuickPick.tsx`（见 [`sidebar.md`](sidebar.md)）；数据是 `/api/files`（见 [`git.md`](git.md) 的「全量文件列表」）。

- **每次打开取一次文件列表，不随 SSE 重取**；取到过就先用旧的、回来再换（`latestWins`），与分支列表同一套。
- **模糊匹配是子序列匹配，不分大小写**（`matchPath`）：查询的每个字符按序出现在路径里即命中。打分偏好 basename 里的命中、连续命中与段首命中，同分时短路径在前；命中下标交给行去加粗。一次最多画 200 条，规则同分支列表。
- **空输入列当前的变更文件**（`repoState.files`；工作区里已不存在的不列——它唯一能打开的是一条错误，判据同 `Open file` 的 `isAbsentFromWorktree`）。VS Code 在这里列「最近打开」，本工具最常要跳的是 agent 刚改过的那批。
- **一行 = 文件名 + 目录**，两段同住一个 `truncate` span（理由同变更列表），`title` 是完整路径。
- **选中走 `openFile` 的固定档**（照 VS Code `workbench.editor.enablePreviewFromQuickOpen` 的默认 `false`），不切侧栏档位。关闭后焦点交还给打开前那个元素。
- **全局快捷键挂在 `document` 的 `keydown` 上，只有两条**：`⌘P` / `Ctrl+P` 开 Quick Open（`preventDefault` 拦下浏览器打印），`⌘⇧F` / `Ctrl+Shift+F` 切到 `Search` 档并聚焦、全选输入框。Mac 判 `metaKey`、其余判 `ctrlKey`——两个都认时会吃掉 macOS 输入框里 `Ctrl+P`（光标上移一行）这条系统级 Emacs 键位。按钮的 `title` 按平台写 `⌘P` 或 `Ctrl+P`。
- **两条快捷键连同它们的名字只有一份清单**（`SHORTCUTS`，与 `handleGlobalKey` 同住 `state/shortcuts.ts`）：按钮与侧栏 tab 的名字和 tooltip（格式只在 `withShortcut` 写一次）、Quick Open 弹窗的名字、右侧空态的快捷键列表都从它取，改键或改名时界面上一起变（本节上面写的具体按键是文档，要手动跟）。

## 变更列表

**一行的构成是「文件名 → 目录 → 状态位」。** 目录跟在文件名之后、小一号、次要色、不带尾部斜杠；状态位在行尾靠右，成一列定宽字母（对应 VS Code Source Control 的 decoration）。判据是**侧栏宽度有限而 `truncate` 从右边裁**：路径在前时先被裁掉的恰恰是文件名，故空间不足时先牺牲目录、保住文件名。

- **两段必须同住一个 `truncate` span**（名在前、目录作为它的行内子元素）。拆成两个平级 flex 子项时两件事一起坏、都不报错：各自成为 scroll container 后基线按边框盒合成，两段按底边对齐、看着没对齐；谁先被裁只能靠 flex-basis 调。同住一个 span 时两段共用一个行盒，省略号天然先吃掉目录（有断言）。
- 整行挂 `title={file.path}` 补完整路径；不挂在目录 span 上——它被裁到零宽时就没得可悬停了。
- **文件名不染色，只有本组那一位是 `D` 时加删除线**（照 VS Code Source Control：颜色只在行尾字母上，删除行划掉名字）：已暂存组看 X、其余看 Y。删除线只挂在名字上，目录段不带（有断言）。`Files` 档与 tab 染名字是照 VS Code 的 explorer 与编辑器标签，那是另两处的约定，不往这里搬。
- **`R` 有自己的颜色**（`--color-git-renamed`，照 VS Code `gitDecoration.renamedResourceForeground`），不借 `M` 那一格：借了时改名行在列表里与改动行同色，而 VS Code 里它是绿的。`C` 仍借 `A`——VS Code 没有复制这一档。
- **不画重命名来源**（照 VS Code，只显示新路径）：`RM` 条目在 `Changes` 组那一行印的是 `M`，再标「`← old`」读起来像在说这一侧的改动是改名。改名只在点开后的 diff 里说（`RenameNotice`）；**取 diff 照样带 `oldPath`**，那是 git 配对用的，不是展示。
- **不做文件类型图标**：要么引一套 SVG 去顶体积门禁，要么自维护一张扩展名→颜色表，换来的只是观感。
- **状态位的外壳是 `STATUS_SLOT` 一个常量**，三种记号（字母、冲突两位、目录圆点）共用，不一致时冲突组那一列会横着挪一截。记号比文件名淡一档（照 VS Code），**淡一档必须走 `opacity`，不能走 token 的 `/75` 修饰符**——双值 token 经 `color-mix()` 会让整条声明作废（红线）。
- **列表区的三句占位（`Loading…`、取不到、`No changes`）共用 `SidebarPlaceholder`，一起居中在列表区正中**：它们轮流占同一个 `<nav>`，各摆各的位置时每次启动都是「贴左上 → 跳到正中」闪一下。`<nav>` 是块盒，占位得 `h-full` 才真的居中（有断言）。不配图标，也不与右侧面板的空态合成一个组件。
- **左栏所有行一律 24px，行高由列表区 `<nav>` 的 `text-sm/6` 给、底下全靠继承，行自己不写字号也不给纵向内边距**：一行里嵌着小一号的片段，行高由 line-height 定时它们共用同一个行盒；靠 `py-*` 凑时两个视图曾各凑各的，切一次 tab 行高跳一截（有断言）。**唯一例外是分组标题**：它自带 `text-xs`，Tailwind 的 `text-*` 会重设 line-height，得自带 `/6`。
- **两棵树的行骨架只在 `tree-row.tsx` 一份**：`ROW_BASE`（间距、焦点环）、`indent()`（左内边距，平铺列表取第 0 层）、展开三角与它等宽的占位、`TreeRow` 本身。各写一份时改一处不报错，只是切一次 tab 缩进或间距跳一截（有断言）。它独立成文件是因为 `FileTree` 已 import `ChangeList`，反向会成环。
- **两棵树的每个子层左侧画一条缩进引导线，指针在列表区时才显形**（照 VS Code 的 `workbench.tree.renderIndentGuides: onHover`，颜色 token 照 `tree.inactiveIndentGuidesStroke`——不做活动高亮，每条线都是 inactive 那档）：每层只缩进 12px，agent 的改动又常在四五层深的路径里，没有线时 320px 侧栏里看不出一行属于哪个目录。机制只在 `tree-row.tsx` 一份（`TreeLevelList`），各条均有断言：
  - **横坐标对准父目录展开三角的中心**，与 `indent()` 从同一个缩进常量算——各算各的时改缩进量不报错，只是线与三角错开。根层不画。
  - **画在子层 `<ul>` 的 `::after` 上、不给 z-index**：排在这一层所有行之后，于是盖在悬停与选中底色上；给 `z-10` 会与 sticky 分组标题按 DOM 顺序比，滚到标题底下时线画在标题上。不吃点击。
  - **悬停作用域挂在列表区 `<nav>` 上，是具名 group**：挂在每棵树的根上时 `Changes` 档悬在一组上另一组不亮；裸 `group` 已被行占着。**触屏常显**，理由同行内动作。
  - 不做 VS Code 那档「活动引导线高亮」（包含选中行的那条加深）。平铺列表与提交展开后的文件列表不画。

### 列表与树两种版式

**tab 行右端那枚开关在平铺列表与目录树之间切换，默认列表。** 对应 VS Code 的 View as Tree / View as List：agent 单次改 300+ 文件时目录段满屏重复，树把同一目录的文件收在一起。开关的图标与文案表达的是**目标视图**（它是动作按钮，不是状态灯）。只在 `Changes` 档画。

- **版式只活在本次页面里，不进 `localStorage`**（跨不了实例，见「主题开关」）。状态是 `state/change-tree.ts` 的一个模块级 signal。
- **分组标题两种版式都留着**：三组是 git 语义（同一个文件可同时在两组），树只是组内的排法。
- **组内按 VS Code 的 `comparePaths` 排序，不沿用 git 的字节序**（`store.ts` 的 `comparePaths`）：逐段比，**同一层里文件排在子目录之前**，段内用 numeric、不分大小写的 collator。git 的字节序下 `src/pages-x/…`（`-` 0x2D）排在 `src/pages.json`（`.` 0x2E）前面，与读者在编辑器里看到的那份对不上；porcelain v2 先吐已跟踪、再吐 `?`，整组重排也顺带把未跟踪文件归到它们该在的位置。
- **冲突一律印 `!`，悬停给出原始 XY**（`Conflict (UD)`）。VS Code 把 `DU` / `UD` 印成 `D`，这里不跟：`Files` 档只拿得到归并后的 `ChangeCode`，跟了的话同一个文件在两档字母不一样。
- **分组标题 `sticky top-0` 必须带 `z-10`**：每一行的 group div 是 `relative`，与标题同为 positioned、同为 `z-index: auto` 时按 DOM 顺序绘制，滚到标题底下的行会画在标题上面（有断言）。
- **树由 `buildChangeTree(files)` 从路径纯算出来，用 `useMemo` 不用 `useComputed`**：`files` 是 prop 不是 signal，computed 不会随它重算——SSE 刷新后树停在旧的那份。每层目录在前、文件在后，各自沿用传入列表的顺序不另排序——传入的已按 `comparePaths` 排好，目录按首次出现的先后插入，于是同层目录与同层文件各自已是 collator 序。
- **单子目录链紧凑合并**（VS Code 的 compact folders）：只有一个子节点且它是目录时合并成 `src/web/components`，`path` 取链尾。有文件的目录不合并。
- **折叠态记 collapsed 集合（`collapsedChangeDirs`），不记 expanded**：默认全展开，SSE 新冒出来的目录不用登记就是展开的；记 expanded 时漏登记的新目录默认收起——页面上只是「刚改的文件没显示出来」。
- **折叠键带分组 id**（`${groupId}:${path}`）：同一个目录可同时出现在两组，不带分组时折 Staged Changes 里的 `src` 会连 Changes 里的一起折掉。陈旧的键不清理。
- **不复用 `state/tree.ts` 的 `expandedDirs`**：那份默认收起、且 `refreshTree` 按它发请求，混进去每折一个变更目录就多一趟 `ls-files`。
- **文件行不再画目录段**（祖先节点已经说了）。
- **选中态不变**：仍是 `activeEditorPath` 按 `path` 比，切版式不动右侧。
- **本版不做树模式下的 `Collapse all`**。

### 行内动作：`Copy path` 与 `Open file`

**悬停一行（或键盘焦点落在行内）时，状态位之前露出两枚图标按钮：`Copy path` 把仓库相对路径写进剪贴板，`Open file` 以 file tab 打开该文件此刻的全文；点行本身仍是打开 diff。** 照 VS Code Source Control 的 inline action：看完补丁最常见的下一步是把路径贴给 agent 或终端，或顺手看一眼整个文件。`Open file` 调目录树那条 `openFile` 并走**固定**档（照 VS Code `git.openFile` 的 `preview: false`），不切侧栏档位（机制在 [`editors.md`](editors.md)）。**`Files` 档的文件行与两棵树的目录行只有 `Copy path`**。为什么不是右键菜单、不复制绝对路径、不弹 toast，见 [`../decisions/web.md`](../decisions/web.md)。本节各条均有断言。

- **`Copy path` 走 `navigator.clipboard.writeText`**——服务绑定 loopback，三家浏览器都视为 secure context。**反馈画在按钮自己身上**：成功后换 `Check` 图标与 `Copied` 文案、1.5s 复原；失败静默（只剩用户拒了权限这一种，320px 里没地方放错误条）。计时器随组件卸载清掉。
- **`Copy path` 排在 `Open file` 左侧**，`Open file` 紧贴状态位。
- **按钮是行按钮的兄弟，不是孩子**（按钮里不能套按钮）。**行按钮与按钮外壳同住一个 `group relative` 的 div（`ROW_GROUP`），`<li>` 本身不是 group**：目录行的 `<li>` 还套着子 `<ul>`，group 挂在那里时悬停任一后代整段目录行都会亮。四种行都走 `TreeRow`，形状只说一遍。
- **显隐走 `display`，不走透明度**：透明的按钮是一块看不见却能点的死区。键盘那半条用 **`has-focus-visible` 不是 `focus-within`**——鼠标点过按钮后焦点留在它身上，`focus-within` 会让按钮在鼠标移开后仍钉在行上。**触屏常驻显示（`pointer-coarse:flex`）不能漏**：Tailwind v4 把 `group-hover` 包在 `@media (hover: hover)` 里，触屏上它从不成立，触摸焦点也不算 focus-visible——少了它触屏上从来没人见过这两枚按钮。
- **出现时文字真的重新排版**：行按钮里有一个与按钮组等宽的占位，与按钮外壳**共用同一个 `REVEAL` 常量**——各写一份时漂开就是文字被挤开而按钮没出来（或反过来）。占位的枚数由 `TreeRow` 从 `actions` 算出，不另写。不常驻预留（每行永久少一截文字），也不覆盖在文字上（得补一块随选中态变色的遮罩）。
- **按钮外壳的锚点按这一行有没有状态记号二选一**：有记号时锚在状态位左侧，偏移量是行骨架右内边距 + 状态位宽 + 间距之和（状态位宽只有 `STATUS_WIDTH` 一份），改骨架间距或状态位宽度时这道加法要跟着改；**没有记号的行（没改动的文件、目录、提交行）贴行骨架的右内边距，不补空槽**——锚在状态位左侧时按钮右边空着一截，看着像没对齐。两种锚点都由 `TreeRow` 按 `badge` 判，两种行里占位的右缘都正好落在外壳右缘（无记号时它是行按钮的最后一个在流项，有记号时其后只剩间距与状态位），文字被截断时正好落在按钮底下。代价是同一列表里有记号与无记号的行，按钮不在同一列。
- **行的悬停底色画在 group div 上，不画在行按钮上**：指针移到按钮上时已离开行按钮，底色挂在那里会在那一刻消失。
- **工作区里已不存在的文件不画 `Open file`**（它唯一能打开的是一条错误）。判据是 `shared/protocol.ts` 的 `isAbsentFromWorktree`：冲突条目只有 `DD` 是文件不在，非冲突看 `unstaged === 'D'` 或 `D.`——**只看 `unstaged === 'D'` 会把 `UD` 误判成不在**。已删除的文件照画 `Copy path`。
- **图标**：`Open file` 是 Lucide `FileInput`（最贴近 codicon `go-to-file`，不用 file tab 那枚种类标识 `FileCode`），`Copy path` 是 Lucide `Copy`。**两枚静止时与状态字母同档淡化，指到哪枚哪枚恢复满色**：淡化画在动作外壳 `ACTION_SHELL` 上按子选择器逐枚生效，`IconButton` 本身不动——「与状态字母同档」是这个槽位的不变量，站在别处的按钮不该淡。同样走 `opacity` 不走 `/75`。

## 主题开关

**顶栏那个按钮是三档循环：跟随系统 → 亮 → 暗 → 跟随系统。** 默认跟随系统，即加开关之前的全部行为；显式选过的档记在 `localStorage`。为什么是三档、为什么不做多标签页同步，见 [`../decisions/web.md`](../decisions/web.md)。CSS 那侧的机制在 [`style.md`](style.md) 的「明暗切换」，本节只管状态与控件。

- **「跟随系统」是属性不存在，不是 `data-theme="system"`**：CSS 不必为它写第三条规则，`localStorage` 里也只有两个合法值。
- 接线在 `state/theme.ts`：一个模块级 signal + 一个 `effect` 接到 `document.documentElement`。**同一个 effect 顺带写 `localStorage`**——拆开就会出现「切了但没记住」，只在刷新后才看得见。
- **`localStorage` 的读与写各自 `try/catch`**：Safari 隐私模式下取值就会抛。抛了只在内存里生效；脏值退回跟随系统。
- **这是仓库里唯一一份进 `localStorage` 的偏好**，key 为 `difftab:theme`。**但「跨会话」目前只到同一实例的刷新为止**：后端 `listen(0)` 端口随机，而 `localStorage` 按 origin（含端口）隔离，换一次启动就归零。**没有任何门禁看得见**（`theme.test.ts` 跑在同一个 happy-dom origin 里）；被排除的修法见 [`../decisions/web.md`](../decisions/web.md)。**其余页面状态——列表版式、左栏宽度、分区比例与折叠态、标签栏——因此一律不进 `localStorage`**：不是不值得记，是记了也存不住。
- **在 `render()` 之前接线**，但**首帧仍可能闪一下系统色**：CSP 是 `script-src 'self'`，塞不了惯用的 pre-paint 内联脚本。代价只落在选了与系统相反档的人身上、闪一帧，为它开 `unsafe-inline` 或维护脚本 hash 不划算。
- 控件只画图标，`title` 与 `aria-label` 分别是 `Follow system` / `Light` / `Dark`——三个词会跟项目名抢宽度。图标是 Lucide `Monitor` / `Sun` / `Moon`；`lucide-preact` 只进 `devDependencies`、构建期 tree-shake。

## 页面标题

**浏览器标签页标题是 `<仓库名> · difftab`。** 仓库名取自 `RepoState.repoName`（工作区根目录名，linked worktree 下正好把同一仓库的多个工作区分开）。

- **仓库名排在产品名之前**：标签被压窄时从尾部截断，产品名在前时一排标签长得一模一样。
- 取不到仓库名时退回纯 `difftab`，不画占位符。
- **仓库名是用户数据，不受「一律英文」约束**，与 CJK 门禁不冲突——它是运行时的值，不落在产物里。
- 接线在 `web/state/title.ts`，一个 `effect` 把 `repoState` 接到 `document.title`，格式与接线同住一处；不挂在组件生命周期上。`index.html` 的 `<title>difftab</title>` 是 JS 跑起来之前的兜底。**`PRODUCT_NAME` 由这里导出给顶栏共用**。

## 品牌标识

**符号是「一段 diff hunk」：三条圆角色条，上下文（灰）、删除（红）、新增（绿），没有外框，没有字标。** 24 网格（与 Lucide 同一坐标系），包围盒横竖都以 12 为中心；由填充不由描边——16px 下 2 单位描边的线稿糊成一团。为什么换成这版、颜色为什么固定、字标为什么退役，见 [`../decisions/web.md`](../decisions/web.md)。

- **几何只有一份，在 `brand/geometry.mjs`**（纯 JS + 一份 `.d.mts`）：`components/Logo.tsx` 与 `scripts/logo.mjs` 都从它取。写成 `.mjs` 是因为脚本零依赖、import 不了 TS；反过来让组件 import 脚本会把拉起 Chrome 的模块打进前端产物。改符号只改这一份再 `node scripts/logo.mjs`（重写 `assets/*.svg`，有 Chrome 时再渲 PNG 并回写 `index.html` 的 favicon）。**没重跑时红的是 `test/unit/web/logo.test.ts`**。
- **红绿是固定的品牌色，明暗两档不切，常量与几何同住 `geometry.mjs`，不进 `app.css`**：favicon、社交预览、README 头图三处于是逐字节相同。不用 `--color-git-added` / `--color-git-deleted`（给文字调的，铺成色块不好看），也不另立 token（CSS 里没有引用处，会被 Tailwind 裁掉）。**只有上下文那条跟主题走**：组件里 `fill: currentColor` 跟顶栏文字色；独立 SVG 内嵌一条媒体查询，取值由脚本从 `app.css` 的 `light-dark()` 里读，不另抄一份。
- **顶栏那枚由 `createLucideIcon` 造出来**，与其它图标同一类型、走同一个 `Icon` 外壳。**每条 rect 自带 `stroke: 'none'`**——Lucide 把描边写在 `<svg>` 上，rect 继承后会被描一圈边，症状只是「色条偏胖发暗」。
- **没有字标**：README 头图是 `assets/mark.svg` 与「difftab」同住一个 `<h1>`（只能用 `align`，GitHub 的 sanitizer 不放行 `style`）。社交预览里的文字是 Chrome 截成 PNG 后定型的，符号与名字的间距按符号的**可见包围盒**量、不按 24 网格，否则右侧留白叠进间距。
- **favicon 是两条 data URI 的 `<link rel="icon">`，不加静态路由**：CSP 已放行 `img-src data:`，加文件则 `assets.ts` 白名单与冒烟的 `WEB_ASSETS` 各要补一处。**SVG 那条排在 PNG 之后**——Chrome / Firefox 取靠后的那条，Safari 不认 SVG favicon、退到 PNG。
- **GitHub 社交预览没有 API**：`assets/social-preview.png` 要手工上传到仓库 Settings，改了 logo 就得再传一次。
- **`assets/` 刻意不进 `files`**：它只给 GitHub 与 README 用（`check:pack` 会拦）。
