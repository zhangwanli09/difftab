# 前端：界面文案、页面骨架与变更列表

> **TypeScript + Preact + @preact/signals，经 Vite 构建为静态产物**，由后端直接托管。本文件管左栏与页面骨架；右侧面板（编辑器标签页、diff / 文件两个视图的外壳、文件视图）在 [`editors.md`](editors.md)，diff 怎么渲染在 [`diff-render.md`](diff-render.md)，配色与层叠隔离在 [`style.md`](style.md)。选型与被排除的做法见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)，门禁见 [`../gates.md`](../gates.md)。
>
> 本文件只写规则、判据与失效时的症状。类名、像素值与它们之间的加法以代码为准，标「有断言」的条目由 `test/unit/web/` 钉住、不进红线。

## 界面文案与术语

**界面文案一律英文，`<html lang>` 为 `en`。** 判据是**产品表面与文档分属两个读者**：`docs/` 与代码注释写给维护者，中文；分发形态是 npm 全局包，CLI 的 `--help`、退出提示、版本守卫报错本来就是英文。中文读者由 `README.zh-CN.md` 承接。首版不做语言切换。

- 分支与进行中操作的术语跟 git 自己的用词走（`Detached HEAD` / `Rebasing`），不自造同义词——那一栏用户是拿它对照 `git status` 看的。
- **变更列表的组标题与状态字母照 VS Code Source Control 的默认**：组是 `Merge Changes` / `Staged Changes` / `Changes`，未跟踪文件混在 `Changes` 里，字母未跟踪印 `U`、冲突印 `!`。读者每天在编辑器里看的就是那一套，两边各说一种话时同一个 `U` 在两处意思相反。协议层不跟着改：`StatusCode` 仍是 git 的字母，换字只发生在徽章那一张展示映射里（`ChangeList.tsx` 的 `BADGE_LETTERS`）。
- **判据是「`dist/web/` 三个产物里的 CJK 字符数为 0」**，不是逐个文件翻源码：漏网的最可能形态是**不长在 JSX 上的那几条**（`state/store.ts` 的错误文案就这么漏过一次）。
- **后端产物用不了这个判据**：`dist/server/main.js` 刻意保留中文注释以便审计。那一侧的用户可见文案是 `sendError` 与各 `*Error` 的字面量，归 `test/unit/server/`。
- **句点只跟句子走**：标签式的短片段（`No changes` / `Working tree clean` / `Empty` / `Loading…`）末尾不加句点，说明性的完整句子（`Binary file — contents are not compared.`）才加。判据是「它是一个标签还是一句话」，不是长短。
- **出错提示分两段：引导句（`Could not load this file`）与原因逐字各占一行，不拼成一句**——原因的来处不止一个（后端 `sendError`、浏览器的 `TypeError: Failed to fetch`、500 转发的 `ENOENT: …`），大小写与句点各成一派，接在冒号后总有一种读起来像两句话撞在一起。
- **too-large 提示的主语随视图走**：diff 视图说 `Diff too large to show (file is 3.0 MB).`，文件视图说 `File too large to show (3.0 MB).`——diff 那侧 5MB 卡的是补丁字节、`size` 却是文件体积，两边都说「File too large」时同一个文件会在 Files 档里照常显示、在 diff 里说太大。文案在 `tooLargeNotice` 里只写一次，两个视图共用。

## 页面骨架

**外壳是行向 flex：左栏一列（顶栏 → tab 行 → 错误条 → 列表区 → 状态条），右边是编辑器面板（见 [`editors.md`](editors.md)），面板自屏幕顶端满高到底。** 顶栏不横跨全屏——它归左栏。

- **顶栏里是品牌符号 + 项目名 + 主题开关**。高度与右侧编辑器标签栏钉同一个值，两条底边落在同一条水平线上（有断言）。项目名是 `RepoState.repoName`，对应 VS Code 侧栏顶端的文件夹名——这一栏回答「我在看哪个项目」，产品名答不了。拿不到时退回 `difftab`（共用 `state/title.ts` 导出的 `PRODUCT_NAME`）。
- **`truncate` 必须落在装项目名的那个 `span` 上，不是顶栏本身**：顶栏是 flex 容器，`truncate` 留在容器上不起作用（子项的自动最小尺寸会把它撑开），长目录名漫过右边框或折成第二行，而 `truncate` 字样还在原地，看上去像已经处理过了。符号与开关 `shrink-0`，被裁的永远是名字。
- **分支状态放在左栏底部的状态条**（对应 VS Code 的 status bar），不与项目名挤在顶栏：挤在一行时先被裁掉的恰恰是分支名。状态条随第一份 state 一起出现，拿不到时整条不画。
- **顶栏之下是一行两个 tab（`Changes` / `Files`）**，对应 VS Code 的 activity bar，**画成两枚靠左的图标、横排一行**——竖排要再占一列宽，而那一列是从文件名身上扣的。默认档是 `Changes`。提交历史不另占 tab，是 `Changes` 档里的一个分区（见下面「提交历史」）：「还没提交的」与「刚提交的」是同一个问题的两半。
  - **这一行本身不是 tablist**：`role="tablist"` 只挂在装两枚 tab 的那个 div 上，行的右端按当前档站一枚按钮（`Changes` 下是列表 / 树切换，`Files` 下是 `Collapse all`）。按钮写成 tablist 的孩子时读屏会把它报成第三个 tab，页面上看不出来（有断言）。
  - **通栏那条细线必须是行自己的 inset 阴影（`divider-b`），不是 `border-b`**：tab 选中的下划线要盖在它上面，`border` 画在 padding box 之外够不着，选中那一段就成了双线。这套机制与编辑器标签栏共用，全仓库只此一种。下划线用前景色而不是 `focus-border`——后者是键盘焦点的颜色，同色时两件事化成同一种蓝。
  - 行的右内边距与顶栏一致，两处的 `IconButton` 落在同一条竖线上（有断言）。
- **`Changes` 那枚图标与状态条上分支名前的是同一个 import（Lucide `GitBranch`）**，同一概念由编译器保证是同一个图形。所有 `<svg>` 走共用的 `Icon` 外壳，`size` 与 `aria-hidden` 只写一次。
- **只画图标的控件，名字只能由 `aria-label` 给**（`title` 再给一份 tooltip）；掉了它读屏里就是无名控件（有断言）。
- **切 tab 不动右侧面板（`activeEditor`）**：换的是侧栏在列什么，不是用户此刻在读什么。写成「切到 Files 就清空右侧」时页面看着正常，只是每瞄一眼目录树就丢掉正在读的 diff。
- **错误条在左栏内、列表之上**：它说的是「变更列表取不到」，与列表那句兜底文案相邻才成立；横跨全屏会在 diff 面板顶上切一条无关的横杠。
- **分支名前的分支图标在 detached 与取不到名字时照画**——它标的是「这一栏说的是 HEAD 在哪」，按情况藏掉只会让状态条左缘忽进忽出。那一行是基线对齐，图标需要单独居中，否则整个坐在文字基线上（有断言）。
- **分支名（连同图标）是一枚按钮**，点开「分支列表」；detached 时照样可点——列表回答的是「仓库里有哪些 ref」。
- **与上游的差距排成 `<behind>↓ <ahead>↑`**，逐字照 VS Code status bar 的 `syncLabel`——这一栏是拿去与另一个窗口对照的，左右反过来时每看一眼都要在心里翻一次。**两个 0 仍都画出来**：「已同步」与「无上游」必须是两个样子（有断言）。
- **滚动的是中间那一层，不是左栏本身**：顶栏、tab 行、错误条、状态条钉在原处。`Files` 档滚的是 `<nav>` 本身；`Changes` 档滚的是两个分区各自那一层——共用一个滚动容器时历史一长就把变更列表滚出视野。左右两栏各有独立的滚动容器，SSE 刷新才能留住列表的滚动位置。**列表那层必须归零自己的自动最小尺寸**（`min-h-0` 或 `overflow-auto`），否则列表把整列撑高、状态条被挤出屏幕底部。
- **左栏宽度可拖**：`<aside>` 右边缘一条竖向把手（sash，照 VS Code），范围 200–640px、默认 320px，宽度是 `state/sidebar.ts` 的一个 signal。下限给名字留得出几个字，上限防止笔记本屏上把 diff 面板挤到只剩行号。把手与「提交历史」那条横向分隔条是同一个组件 `Sash.tsx`。
  - **把手绝对定位叠在边框上**，不占布局宽度——做成第三个 flex 子项时它的宽度会从面板身上扣。悬停与拖动时只显出竖直居中的一小段握把，不是整条边变色。
  - **只有把手用的固定几何写内联样式，不写 Tailwind 类**：每个类都是产物里一条只服务一处的规则，内联样式不进产物。**`touch-action: none` 不能漏**：不带时触屏一按下就被认作滚动、发 `pointercancel`，拖几个像素就断。
  - **拖动走 pointer capture**：指针越过 diff 面板或离开窗口时 move 仍投递给把手。**拖动期间整页挂 `cursor: col-resize` 与 `user-select: none`**，松手（含 `lostpointercapture`）撤掉——不挂时光标一离开把手就闪回箭头、沿途 diff 文字被拖选成一片蓝。
  - **双击复位到 320px；键盘可达**：`role="separator"` + `aria-value*` + `tabIndex=0`，方向键与 Home / End 可调。
  - **上限还要随窗口收，这道交给 CSS**：内联 `max-width: min(640px, calc(100vw - 320px))` + `min-width: 200px`，窄窗口里 diff 面板不会被挤到 0；signal 存的是用户选的宽度，窗口拉回时自己回到原档，不必监听 `resize`。**代价是选的与屏幕上的可能不等**：拖动与键盘的起点读 `shownSidebarWidth()`（按式子算，不量 `offsetWidth`——signal 到 DOM 的绑定是异步的，连发方向键会读到旧值），否则窄窗口里的拖动全落在看不见的区间里。
  - **拖动时一个组件都不重渲染**：宽度以 signal 本身交给 `style`，由 `@preact/signals` 直接改 DOM；在 `App` 里读 `.value` 等于每个 pointermove 重渲整棵树。
  - **宽度不跨会话记忆**，与变更列表的版式开关同一个结论（端口随机，`localStorage` 跨不了实例）。
  - 拖宽左栏可能让 diff 面板跨过并排阈值而换版式：**不为此做任何事**，`outputFormat` 量的本来就是面板自身的 border box（见 [`diff-render.md`](diff-render.md) 的「版式按面板宽度自动切」）。

## 变更列表

**一行的构成是「文件名 → 目录 →（重命名标注）→ 状态位」。** 目录跟在文件名之后、小一号、次要色、不带尾部斜杠；状态位在行尾靠右，成一列定宽字母（对应 VS Code Source Control 的 decoration）。判据是**侧栏宽度有限而 `truncate` 从右边裁**：路径在前时先被裁掉的恰恰是文件名，故空间不足时先牺牲目录、保住文件名。

- **两段必须同住一个 `truncate` span**（名在前、目录作为它的行内子元素）。拆成两个平级 flex 子项时两件事一起坏、都不报错：各自成为 scroll container 后基线按边框盒合成，两段按底边对齐、看着没对齐；谁先被裁只能靠 flex-basis 调，且会把重命名标注推离它注解的文件名。同住一个 span 时两段共用一个行盒，省略号天然先吃掉目录（有断言）。
- 整行挂 `title={file.path}` 补完整路径；不挂在目录 span 上——它被裁到零宽时就没得可悬停了。
- **不做文件类型图标**：要么引一套 SVG 去顶体积门禁，要么自维护一张扩展名→颜色表，换来的只是观感。
- **状态位的外壳是 `STATUS_SLOT` 一个常量**，三种记号（字母、冲突两位、目录圆点）共用，不一致时冲突组那一列会横着挪一截。记号比文件名淡一档（照 VS Code），**淡一档必须走 `opacity`，不能走 token 的 `/75` 修饰符**——双值 token 经 `color-mix()` 会让整条声明作废（红线）。
- **列表区的三句占位（`Loading…`、取不到、`No changes`）共用 `SidebarPlaceholder`，一起居中在列表区正中**：它们轮流占同一个 `<nav>`，各摆各的位置时每次启动都是「贴左上 → 跳到正中」闪一下。`<nav>` 是块盒，占位得 `h-full` 才真的居中（有断言）。不配图标，也不与右侧面板的空态合成一个组件。
- **左栏所有行一律 24px，行高由列表区 `<nav>` 的 `text-sm/6` 给、底下全靠继承，行自己不写字号也不给纵向内边距**：一行里嵌着小一号的片段，行高由 line-height 定时它们共用同一个行盒；靠 `py-*` 凑时两个视图曾各凑各的，切一次 tab 行高跳一截（有断言）。**唯一例外是分组标题**：它自带 `text-xs`，Tailwind 的 `text-*` 会重设 line-height，得自带 `/6`。
- **两棵树的行骨架只在 `tree-row.tsx` 一份**：`ROW_BASE`（间距、焦点环）、`indent()`（左内边距，平铺列表取第 0 层）、展开三角与它等宽的占位、`TreeRow` 本身。各写一份时改一处不报错，只是切一次 tab 缩进或间距跳一截（有断言）。它独立成文件是因为 `FileTree` 已 import `ChangeList`，反向会成环。

### 列表与树两种版式

**tab 行右端那枚开关在平铺列表与目录树之间切换，默认列表。** 对应 VS Code 的 View as Tree / View as List：agent 单次改 300+ 文件时目录段满屏重复，树把同一目录的文件收在一起。开关的图标与文案表达的是**目标视图**（它是动作按钮，不是状态灯）。只在 `Changes` 档画。

- **版式只活在本次页面里，不进 `localStorage`**：不是「不值得记」，是**记了也存不住**——后端 `listen(0)` 端口随机，`localStorage` 按 origin 隔离，换一次启动就归零（主题那份同样受限）。状态是 `state/change-tree.ts` 的一个模块级 signal。
- **分组标题两种版式都留着**：三组是 git 语义（同一个文件可同时在两组），树只是组内的排法。
- **`Changes` 组内是两份有序列表的归并，不是整体重排**：porcelain v2 先吐全部已跟踪、再吐 `?` 记录，直接拼接时未跟踪文件全堆在组尾。按路径归并一次即可（`store.ts` 的 `mergeByPath`）。
- **冲突一律印 `!`，悬停给出原始 XY**（`Conflict (UD)`）。VS Code 把 `DU` / `UD` 印成 `D`，这里不跟：`Files` 档只拿得到归并后的 `ChangeCode`，跟了的话同一个文件在两档字母不一样。
- **分组标题 `sticky top-0` 必须带 `z-10`**：每一行的 group div 是 `relative`，与标题同为 positioned、同为 `z-index: auto` 时按 DOM 顺序绘制，滚到标题底下的行会画在标题上面（有断言）。
- **树由 `buildChangeTree(files)` 从路径纯算出来，用 `useMemo` 不用 `useComputed`**：`files` 是 prop 不是 signal，computed 不会随它重算——SSE 刷新后树停在旧的那份。每层目录在前、文件在后，各自沿用 git 的顺序不另排序。
- **单子目录链紧凑合并**（VS Code 的 compact folders）：只有一个子节点且它是目录时合并成 `src/web/components`，`path` 取链尾。有文件的目录不合并。
- **折叠态记 collapsed 集合（`collapsedChangeDirs`），不记 expanded**：默认全展开，SSE 新冒出来的目录不用登记就是展开的；记 expanded 时漏登记的新目录默认收起——页面上只是「刚改的文件没显示出来」。
- **折叠键带分组 id**（`${groupId}:${path}`）：同一个目录可同时出现在两组，不带分组时折 Staged Changes 里的 `src` 会连 Changes 里的一起折掉。陈旧的键不清理。
- **不复用 `state/tree.ts` 的 `expandedDirs`**：那份默认收起、且 `refreshTree` 按它发请求，混进去每折一个变更目录就多一趟 `ls-files`。
- **文件行不再画目录段**（祖先节点已经说了），重命名标注照旧。
- **选中态不变**：仍是 `activeEditorPath` 按 `path` 比，切版式不动右侧。
- **本版不做树模式下的 `Collapse all`**。

### 行内动作：`Copy path` 与 `Open file`

**悬停一行（或键盘焦点落在行内）时，状态位之前露出两枚图标按钮：`Copy path` 把仓库相对路径写进剪贴板，`Open file` 以 file tab 打开该文件此刻的全文；点行本身仍是打开 diff。** 照 VS Code Source Control 的 inline action：看完补丁最常见的下一步是把路径贴给 agent 或终端，或顺手看一眼整个文件。`Open file` 调目录树那条 `openFile` 并走**固定**档（照 VS Code `git.openFile` 的 `preview: false`），不切侧栏档位（机制在 [`editors.md`](editors.md)）。**`Files` 档的文件行与两棵树的目录行只有 `Copy path`**。为什么不是右键菜单、不复制绝对路径、不弹 toast，见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)。本节各条均有断言。

- **`Copy path` 走 `navigator.clipboard.writeText`**——服务绑定 loopback，三家浏览器都视为 secure context。**反馈画在按钮自己身上**：成功后换 `Check` 图标与 `Copied` 文案、1.5s 复原；失败静默（只剩用户拒了权限这一种，320px 里没地方放错误条）。计时器随组件卸载清掉。
- **`Copy path` 排在 `Open file` 左侧**，`Open file` 紧贴状态位。
- **按钮是行按钮的兄弟，不是孩子**（按钮里不能套按钮）。**行按钮与按钮外壳同住一个 `group relative` 的 div（`ROW_GROUP`），`<li>` 本身不是 group**：目录行的 `<li>` 还套着子 `<ul>`，group 挂在那里时悬停任一后代整段目录行都会亮。四种行都走 `TreeRow`，形状只说一遍。
- **显隐走 `display`，不走透明度**：透明的按钮是一块看不见却能点的死区。键盘那半条用 **`has-focus-visible` 不是 `focus-within`**——鼠标点过按钮后焦点留在它身上，`focus-within` 会让按钮在鼠标移开后仍钉在行上。**触屏常驻显示（`pointer-coarse:flex`）不能漏**：Tailwind v4 把 `group-hover` 包在 `@media (hover: hover)` 里，触屏上它从不成立，触摸焦点也不算 focus-visible——少了它触屏上从来没人见过这两枚按钮。
- **出现时文字真的重新排版**：行按钮里有一个与按钮组等宽的占位，与按钮外壳**共用同一个 `REVEAL` 常量**——各写一份时漂开就是文字被挤开而按钮没出来（或反过来）。占位的枚数由 `TreeRow` 从 `actions` 算出，不另写。不常驻预留（每行永久少一截文字），也不覆盖在文字上（得补一块随选中态变色的遮罩）。
- **按钮外壳锚在状态位左侧，偏移量是行骨架右内边距 + 状态位宽 + 间距之和**；状态位宽只有 `STATUS_WIDTH` 一份。**没有记号的行由 `TreeRow` 补一个状态位宽的空槽**，否则文字末端压在按钮底下。改骨架间距或状态位宽度时这道加法要跟着改。
- **行的悬停底色画在 group div 上，不画在行按钮上**：指针移到按钮上时已离开行按钮，底色挂在那里会在那一刻消失。
- **工作区里已不存在的文件不画 `Open file`**（它唯一能打开的是一条错误）。判据是 `shared/protocol.ts` 的 `isAbsentFromWorktree`：冲突条目只有 `DD` 是文件不在，非冲突看 `unstaged === 'D'` 或 `D.`——**只看 `unstaged === 'D'` 会把 `UD` 误判成不在**。已删除的文件照画 `Copy path`。
- **图标**：`Open file` 是 Lucide `FileInput`（最贴近 codicon `go-to-file`，不用 file tab 那枚种类标识 `FileCode`），`Copy path` 是 Lucide `Copy`。**两枚静止时与状态字母同档淡化，指到哪枚哪枚恢复满色**：淡化画在动作外壳 `ACTION_SHELL` 上按子选择器逐枚生效，`IconButton` 本身不动——「与状态字母同档」是这个槽位的不变量，站在别处的按钮不该淡。同样走 `opacity` 不走 `/75`。

## 文件浏览器

**`Files` 那一档是仓库目录树，按目录懒加载**：展开一个目录才去取它那一层。数据与判据在 [`git.md`](git.md) 的「目录树的两条 `ls-files`」，本节只管展示。

- **一行 = 缩进 + 展开三角（目录）或等宽占位（文件）+ 名字 + 行尾记号。** 占位不能省，否则文件名比同层目录名往左挪一截。缩进用内联 `padding-left` 按层级算——层数没有上界，而 Tailwind 只产出源码里出现过的类名。
- **状态染色复用变更列表的 `CODE_COLORS`**（导出，不复制）：树上与列表里同一个文件必须是同一个颜色。**冲突条目优先按冲突色**——两侧状态位都不是 `.`，挑哪一位都说错一半。
- **文件行行尾印状态字母（就是 `StatusBadge` 本身），目录行印一枚圆点**（对应 VS Code Explorer 的 git decoration）。
  - **目录只印圆点不印字母，但名字与圆点都染色**：底下可以同时有改过与没改过的文件，挑一个字母就是替用户下结论。颜色按后代归并：冲突 → `M`/`T`/`R`/`C` → `D` → `A` → `?`。这是展示取舍，判据只求稳定。
  - **判据表是 `codeByPath`（`state/store.ts` 的 computed）**：每个改动条目把状态码记到**自己的路径与所有祖先**上。「自己的路径也算一份」让 submodule（在树上是 directory、改动记在自己路径上的 `S.M.`）不需要特判（有断言）。每行只读自己那一格。
- **被忽略的文件灰显**，与 VS Code 一致；**不做「显示 / 隐藏被忽略」开关**——多数人只会拨一次，灰显已经说清楚了。
- 整行挂 `title={entry.path}`。文件行与目录行悬停都露出 `Copy path`，机制与「行内动作」相同。
- **展开态与树的缓存活在组件树之外**（`state/tree.ts`），SSE 刷新才能不丢展开态与滚动位置。**刷新只重取「根 + 当前展开着且真的取过的那几层」**——否则从没点开过 `Files` 的会话每个 `change` 都白跑一趟 `ls-files`。
  - **这条收窄不欠债，因为 `loadDir` 每次调用都真的去取**：收起期间那一层不在刷新范围里，再展开时 `toggleDir` 会取一份新的。若把「缓存里有就不发」当成默认，症状是展开后看到一份陈旧目录，一直旧到下一个 `change`。
  - **`force` 只有一个意思：连「已经在飞」也再发一趟**，刷新专用——「已经在取就不取」会把一次 `change` 引出的刷新整个丢掉（见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)）。展开不传它。
  - **根那一层是切到这一档才取**，不在挂载时预取；「取过就不再取」的判据写在 `App` 那个 effect 里。
- **树上的选中态与变更列表是同一份 `activeEditorPath`**（活动 tab 的路径，不看种类）：高亮只回答「右侧此刻是哪个文件」。
- **树跟着活动 tab 展开并定位**（照 VS Code 的 `explorer.autoReveal`）：活动 tab 的路径一变，树把每一级祖先展开、再把那一行 `scrollIntoView({ block: 'nearest' })`。少了它，高亮行躺在没展开的层里，用户看不见「你正在读的是这个」。`state/tree.ts` 的 `revealPath` 只管展开（未展开的祖先加进集合并 `loadDir`），滚动由那一行自己按 `activeEditorPath` 做，不另设「待滚动」信号。三条不显然的判据：
  - **触发 effect 挂在 `FileTree` 组件上，不是全局 `effect()`**：树只在 `Files` 档挂载，「只在可见时 reveal、切过来时补一次」于是不必另判，`tree.ts` 也不必反向 import `store.ts`。**不切侧栏档位**，照 VS Code。
  - **那个 effect 只订阅 `activeEditorPath`，展开那一步包在 `untracked` 里**：让 `expandedDirs` 进依赖集时，用户每手动收起一个目录 effect 就把它展开回去——「收不起来」（有断言）。
  - **自动展开那一趟取失败要把展开态退回去**，手动展开失败不退：diff tab 指向一个整个目录被删的文件时，集合里会留下一个看不见的展开态，目录回来时带着陈旧的错误直接展开，且此后 reveal 它底下的文件都不再取。
- **tab 行右端是 `Collapse all`**（对应 VS Code Explorer 的 view actions）。与被否决的「显示被忽略」开关不是一类：这是每次翻完树都会用的一次性动作。
  - **它是 tablist 的兄弟、不是孩子**（理由见「页面骨架」），塞进 tab 行省下一整条横栏；行高由 tab 定，切档时那一行不抖。
  - **只在 `Files` 档画，且排在滚动容器之外**——掉进 `<nav>` 里会跟着树滚走。
  - 不另起组件，直接写在 `App` 那一行；动作的唯一实现是 `state/tree.ts` 的 `collapseAll`。
  - **只清展开态、不清 `treeCache`**：再展开时不该又空一拍。一个目录都没展开时照常可点（真的无操作，不做禁用态）。
  - **不动右侧面板**，也不引出一次自动展开（活动 tab 的路径没变）。

## 提交历史

**`History` 是 `Changes` 档里变更列表下面那个分区，列 HEAD 可达的近期提交，照 VS Code Source Control Graph：一条提交一行，单击原地展开它改了哪些文件，点文件在右侧开一个 diff tab。** 状态在 `state/history.ts`，组件是 `HistoryList.tsx`；git 那侧的判据（锚点分页、第一父、`log` 的字面量 argv）见 [`git.md`](git.md) 的「提交历史」。

- **两个分区**：上面 `Changes`、下面 `History`（不叫 Graph——没有图形列）。分区壳在 `SourceControl.tsx`，比例与折叠态在 `state/sidebar.ts`。
  - **分区标题是一枚按钮**（三角 + 大写小号标题、`aria-expanded`），排在分区自己的滚动容器之外。
  - **两块各自滚动。都展开时按比例分高度**：上面那块 `flex-basis` 是百分比（默认 50%，夹在 15%–85%），下面 `flex-1` 吃剩下的——存比例不存像素，窗口变高变矮时一起伸缩。一块折起时另一块占满。
  - **折起是隐藏不是卸载**：卸载时滚动容器连同 `scrollTop` 一起没了，折一下再展开就回到顶上。比例与折叠态不进 `localStorage`，理由同左栏宽度。
  - **中间的横向分隔条与左栏把手是同一个组件 `Sash.tsx`**，只有轴向与单位（像素 / 百分比）由调用方给：pointer capture、收尾、键盘、`touch-action` 这些易漏的机制只写一次，两份副本时修了一把、另一把静默坏着。百分比就是存储单位，取一位小数；拖动起点那一刻量一次列高。
  - **`History` 折起时不取**，与「不在 `Changes` 档」同等对待。默认可见即页面一打开就取第一页。**但要等第一份 state 到了才判**：否则挂载时 HEAD 未知必判「对不上」，state 一到又判一次，每开一次页面两遍 `git log`。这条写在两处：`historyVisible` 把「state 已到」算进可见，`ensureHistory(null)` 自己也直接返回。补判的 effect 挂在 `SourceControl` 而不是 `App`，免得点一下分区标题整页重画。
- **一行 = 展开箭头 + 主题 + 作者**，作者次要色小一号，**两段同住一个 `truncate` span**，理由与变更列表「文件名 + 目录」相同。**短哈希与时间不上行**，进原生 `title`，次序照 VS Code 的悬停卡片：`作者 · 相对时间 (绝对时间)`、主题、正文、短哈希（7 位，对照 `git log --oneline`）；完整 sha 不进提示。不自绘卡片：改动统计要每条多一次 diff，`Open on GitHub` 要读 remote（白名单之外）。body 随列表那次 `log` 一起回来。相对时间用 `Intl.RelativeTimeFormat('en')`，不挂计时器自己跳。
- **提交行悬停露出 `Copy commit hash`，复制完整 sha**（短哈希在大仓库里可能有歧义）。与 `Copy path` 是同一个 `CopyButton`，站在 `TreeRow` 的动作外壳里——点它不会顺带展开这条提交。
- **当前分支与它的上游在各自指着的那条提交上各画一枚徽标**，照 VS Code `scm.graph.badges` 的默认档：只画这两枚，要回答的只有一件事——**上游那枚之上的几条就是还没推送的**（状态条上的 `↑3` 对不到具体是哪三条）。指着同一条时并排，本地在前。
  - **徽标排在 `truncate` span 之后、`shrink-0`**，自身过长时独立 `truncate`。图标同分支列表（本地 `GitBranch`、远程 `Cloud`），色相照 VS Code 的 `scmGraph.historyItem*RefColor`，**但只给图标上色、底色是同色相淡底**——实心底 + 白字在这一栏里比主题还抢眼、对比度也不够。
  - **本地那枚不用取**，画在 `BranchState.oid` 那一行，detached 时不画。**上游那枚要取**：status 不给上游的 oid，按 `BranchState.upstream.name` 在 `/api/refs` 的列表里按 git 的解析次序找（见 [`git.md`](git.md)）。无上游时不画，**并忘掉上一次的判据**——`--unset-upstream` 后再设回同一个时，判据可能一字不差而上游已挪过。
  - **取的时机：看得见才判，判据是「HEAD oid / 上游名 / ahead / behind 四样对不对得上」，不是「来过 SSE」**。**不能只看 HEAD**：push 只挪上游，ahead 那一项是它在 status 里看得见的地方。失败也算对不上（下次判即重试），失败本身不报。
  - **上游指的提交不在已加载的页里就不画**，不为它多翻页。
  - **与分支列表共用 `/api/refs` 端点、不共用状态**（`state/refs.ts` 另存一份 `upstreamRefs`，票各领各的）：共用时一边失败会抹掉另一边。存的是原样列表，上游是哪条由 `state/badges.ts` 拿**此刻的**上游名去推。失败只在那一次仍是最新时才算。
  - **徽标表只依赖分支状态里的三样字符串与 `upstreamRefs`**：直接依赖 `repoState` 时 agent 每改一个文件带徽标的行就重画一次。
  - **两样数据从同一个入口进**：`ensureHistory` 既判提交列表也判上游 refs，`refresh` 与可见性 effect 只调它。
- **展开是懒加载的**：第一次展开才问 `/api/commit`，结果按 sha 缓存且**永不失效**（提交不可变）；失败了再展开即重试。浅克隆边界那一条写 `Shallow clone — parent not available`。展开状态记 **expanded 集合**——与变更列表刻意相反：这里默认全收起，新长出来的提交不该自己摊开。
- **文件行复用变更列表那一套**（`TreeRow` + `StatusBadge` + `Copy path`）。单击预览、双击固定。**不画 `Open file`**：它打开的是工作区此刻的全文，而这一行说的是历史上某一版。只平铺、不出树版式。
- **合并提交在行上不另画记号**，在 diff tab 顶上写 `Merge commit · compared with first parent`。
- **滚到底自动取下一页**：列表末尾一行哨兵，进入可视区（`IntersectionObserver`）即取。**列表每变一次就换一个观察者**：新观察者一 `observe` 就报一次初始状态，高屏上一页填不满时会接着取；只靠一个观察者时哨兵一直可见、交叉状态不变，它不再回调，列表停在半截。不用 `key` 整行重挂代替（会漏判且丢键盘焦点）。**哨兵是一枚按钮**：空闲 `Load more`，在取 `Loading…` 并 `disabled`，同时是键盘那条路。**失败后不自动重试**：哨兵原地变成错误 + 点击重试，否则哨兵一直可见时是一串打不停的失败请求。
- **自动刷新只在 HEAD 挪了时取**：判据是 `BranchState.oid` 与列表顶上那条对不对得上，**不是「来过 SSE」**——按事件重取等于每个文件事件一次 `rev-parse` + `log`。看不见时不判，切过来 / 展开时补判。**同一时刻只有一次在途，在途期间又被叫过就回来后补跑一次**（`http.ts` 的 `singleFlight`）：每次新发并作废前一次时，agent 跑动期间是一串永远轮不到落地的 `git log`；只搭车不补跑时，最后那个 SSE 白来。
- **新提交接在顶上，已翻到的页不丢**：重取的第一页里找到旧 HEAD 且往下那一截与已加载的逐条相同，就只把新的几条接在顶上。**翻页锚点不跟着换**：记着 `anchor` 与它的 `offset`，下一页从锚点起跳过 `commits.length - offset` 条。对不上（amend、reset、rebase、一次长出一整页、合并排进了中间）就整体换成新的第一页，在途的翻页回来即丢弃。
- **空态**：没有提交时是 `No commits yet`。右侧无 tab 时按 `Changes` 档的规矩走——分区不是档位。
- **commit tab 活动时两栏都不高亮**（`activeEditorPath` 为 `null`）：同名那一行说的是工作区那份，照亮它等于说「你正在看它」（见 [`editors.md`](editors.md)）。

## 分支列表

**点状态条上的分支名，窗口顶部居中弹出一个列表，照 VS Code 的 quick pick：顶上一个输入框，下面本地分支、远程分支、标签三组。选中一项即把名字复制进剪贴板**——checkout 属仓库写操作，只读工具能给「选中」的含义只有这一种（为什么不是「在 History 里打开」见 [`../decisions.md`](../decisions.md#git-行为)）。状态在 `state/refs.ts`，组件是 `BranchPicker.tsx`；git 那侧见 [`git.md`](git.md) 的「分支列表」。

- **一项两行，照 VS Code**：图标 + 名字 + 相对时间；`作者 • 短哈希 • 主题`。三组图标：本地 `GitBranch`、远程 `Cloud`、标签 `Tag`。相对时间与短哈希复用 History 的 `relativeTime` / `shortSha`。指向树的标签只画第一行。
- **组名画在每组第一项的右端**，第二组起顶上一条分隔线，不另起组标题行。
- **当前分支那一项末尾画 `Check`**：判据是 `BranchState.head` 等于一条本地分支名且不 detached，后端不另标。
- **过滤只按名字**，不分大小写的子串匹配；输入一变活动项回到第一项。**一次最多画 200 条**，超出时写 `N more — type to filter`——几千个标签整份挂进 DOM 是可感知的卡顿。
- **键盘照 quick pick**：输入框自动聚焦，`↑`/`↓` 首尾相接，`Enter` 复制并关闭，`Esc` 关闭；输入框是 `combobox`、列表是 `listbox`，活动项由 `aria-activedescendant` 指。点外部关闭，**外部点击的判据要排除状态条那枚按钮**，否则按下时关、松开又被 click 打开。**关闭后焦点还给那枚按钮**，不还时键盘用户落回 `body`。
- **复制成功的反馈画在状态条那枚按钮上**（列表那时已关）：图标换 `Check`、`title` 换 `Copied <名字>`，时长与 `CopyButton` 同一个常量。写失败静默。
- **每次打开时取一次 `/api/refs`，不随 SSE 重取**：ref 只在 fetch / 建分支 / 打标签时变。取到过就先画旧的、回来再换（`latestWins`）；首次写 `Loading…`；失败写错误且**不与旧列表并排**（看不出哪一样是现在的）；空列表写 `No branches or tags`。

## 主题开关

**顶栏那个按钮是三档循环：跟随系统 → 亮 → 暗 → 跟随系统。** 默认跟随系统，即加开关之前的全部行为；显式选过的档记在 `localStorage`。为什么是三档、为什么不做多标签页同步，见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)。CSS 那侧的机制在 [`style.md`](style.md) 的「明暗切换」，本节只管状态与控件。

- **「跟随系统」是属性不存在，不是 `data-theme="system"`**：CSS 不必为它写第三条规则，`localStorage` 里也只有两个合法值。
- 接线在 `state/theme.ts`：一个模块级 signal + 一个 `effect` 接到 `document.documentElement`。**同一个 effect 顺带写 `localStorage`**——拆开就会出现「切了但没记住」，只在刷新后才看得见。
- **`localStorage` 的读与写各自 `try/catch`**：Safari 隐私模式下取值就会抛。抛了只在内存里生效；脏值退回跟随系统。
- **这是仓库里第一份跨会话偏好**，key 为 `difftab:theme`。**但「跨会话」目前只到同一实例的刷新为止**（端口随机，origin 隔离），修法记在 [`../history.md`](../history.md) 的「未完事项」。
- **在 `render()` 之前接线**，但**首帧仍可能闪一下系统色**：CSP 是 `script-src 'self'`，塞不了惯用的 pre-paint 内联脚本。代价只落在选了与系统相反档的人身上、闪一帧，为它开 `unsafe-inline` 或维护脚本 hash 不划算。
- 控件只画图标，`title` 与 `aria-label` 分别是 `Follow system` / `Light` / `Dark`——三个词会跟项目名抢宽度。图标是 Lucide `Monitor` / `Sun` / `Moon`；`lucide-preact` 只进 `devDependencies`、构建期 tree-shake。

## 页面标题

**浏览器标签页标题是 `<仓库名> · difftab`。** 仓库名取自 `RepoState.repoName`（工作区根目录名，linked worktree 下正好把同一仓库的多个工作区分开）。

- **仓库名排在产品名之前**：标签被压窄时从尾部截断，产品名在前时一排标签长得一模一样。
- 取不到仓库名时退回纯 `difftab`，不画占位符。
- **仓库名是用户数据，不受「一律英文」约束**，与 CJK 门禁不冲突——它是运行时的值，不落在产物里。
- 接线在 `web/state/title.ts`，一个 `effect` 把 `repoState` 接到 `document.title`，格式与接线同住一处；不挂在组件生命周期上。`index.html` 的 `<title>difftab</title>` 是 JS 跑起来之前的兜底。**`PRODUCT_NAME` 由这里导出给顶栏共用**。

## 品牌标识

**符号是「一段 diff hunk」：三条圆角色条，上下文（灰）、删除（红）、新增（绿），没有外框，没有字标。** 24 网格（与 Lucide 同一坐标系），包围盒横竖都以 12 为中心；由填充不由描边——16px 下 2 单位描边的线稿糊成一团。为什么换成这版、颜色为什么固定、字标为什么退役，见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)。

- **几何只有一份，在 `brand/geometry.mjs`**（纯 JS + 一份 `.d.mts`）：`components/Logo.tsx` 与 `scripts/logo.mjs` 都从它取。写成 `.mjs` 是因为脚本零依赖、import 不了 TS；反过来让组件 import 脚本会把拉起 Chrome 的模块打进前端产物。改符号只改这一份再 `node scripts/logo.mjs`（重写 `assets/*.svg`，有 Chrome 时再渲 PNG 并回写 `index.html` 的 favicon）。**没重跑时红的是 `test/unit/web/logo.test.ts`**。
- **红绿是固定的品牌色，明暗两档不切，常量与几何同住 `geometry.mjs`，不进 `app.css`**：favicon、社交预览、README 头图三处于是逐字节相同。不用 `--color-git-added` / `--color-git-deleted`（给文字调的，铺成色块不好看），也不另立 token（CSS 里没有引用处，会被 Tailwind 裁掉）。**只有上下文那条跟主题走**：组件里 `fill: currentColor` 跟顶栏文字色；独立 SVG 内嵌一条媒体查询，取值由脚本从 `app.css` 的 `light-dark()` 里读，不另抄一份。
- **顶栏那枚由 `createLucideIcon` 造出来**，与其它图标同一类型、走同一个 `Icon` 外壳。**每条 rect 自带 `stroke: 'none'`**——Lucide 把描边写在 `<svg>` 上，rect 继承后会被描一圈边，症状只是「色条偏胖发暗」。
- **没有字标**：README 头图是 `assets/mark.svg` 与「difftab」同住一个 `<h1>`（只能用 `align`，GitHub 的 sanitizer 不放行 `style`）。社交预览里的文字是 Chrome 截成 PNG 后定型的，符号与名字的间距按符号的**可见包围盒**量、不按 24 网格，否则右侧留白叠进间距。
- **favicon 是两条 data URI 的 `<link rel="icon">`，不加静态路由**：CSP 已放行 `img-src data:`，加文件则 `assets.ts` 白名单与冒烟的 `WEB_ASSETS` 各要补一处。**SVG 那条排在 PNG 之后**——Chrome / Firefox 取靠后的那条，Safari 不认 SVG favicon、退到 PNG。
- **GitHub 社交预览没有 API**：`assets/social-preview.png` 要手工上传到仓库 Settings，改了 logo 就得再传一次。
- **`assets/` 刻意不进 `files`**：它只给 GitHub 与 README 用（`check:pack` 会拦）。
