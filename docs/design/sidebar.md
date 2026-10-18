# 前端：文件浏览器、全仓搜索、提交历史与分支列表

> 左栏里除变更列表之外的四块视图。页面骨架、变更列表与两棵树共用的行骨架（`TreeRow`、行内动作）在 [`web.md`](web.md)，右侧面板在 [`editors.md`](editors.md)。被排除的做法见 [`../decisions/web.md`](../decisions/web.md)，门禁见 [`../gates.md`](../gates.md)。标「有断言」的条目由 `test/unit/web/` 钉住、不进红线。

## 文件浏览器

**`Files` 那一档是仓库目录树，按目录懒加载**：展开一个目录才去取它那一层。数据与判据在 [`git.md`](git.md) 的「目录树的两条 `ls-files`」，本节只管展示。

- **一行 = 缩进 + 展开三角（目录）或等宽占位（文件）+ 名字 + 行尾记号。** 占位不能省，否则文件名比同层目录名往左挪一截。缩进用内联 `padding-left` 按层级算——层数没有上界，而 Tailwind 只产出源码里出现过的类名。层内的占位文案（`Loading…` / 错误 / `Empty`）也按文件行的骨架画、单行截断，全文进 `title`——只给缩进时文字比同层文件名往左差一枚三角加 gap，看着落在上一层。
- **展开目录的子层左侧有一条缩进引导线，悬停列表区时显形**，与变更列表的树视图同一份机制（[`web.md`](web.md) 的「两棵树的行骨架」之后那条）。`Loading…` / 错误 / `Empty` 那一层同样画线。
- **状态染色复用变更列表的 `CODE_COLORS`**（导出，不复制）：树上与列表里同一个文件必须是同一个颜色。**冲突条目优先按冲突色**——两侧状态位都不是 `.`，挑哪一位都说错一半。
- **文件行行尾印状态字母（就是 `StatusBadge` 本身），目录行印一枚圆点**（对应 VS Code Explorer 的 git decoration）。
  - **目录只印圆点不印字母，但名字与圆点都染色**：底下可以同时有改过与没改过的文件，挑一个字母就是替用户下结论。颜色按后代归并：冲突 → `M` → `T` → `R` → `C` → `D` → `A` → `?`。这是展示取舍，判据只求稳定——**每个码各占一档、不许并列**：并列时先到的赢，两者颜色一旦不同，目录颜色就随条目顺序变。
  - **判据表是 `codeByPath`（`state/store.ts` 的 computed）**：每个改动条目把状态码记到**自己的路径与所有祖先**上。「自己的路径也算一份」让 submodule（在树上是 directory、改动记在自己路径上的 `S.M.`）不需要特判（有断言）。每行只读自己那一格。
- **被忽略的文件灰显**，与 VS Code 一致；**不做「显示 / 隐藏被忽略」开关**——多数人只会拨一次，灰显已经说清楚了。
- 整行挂 `title={entry.path}`。文件行与目录行悬停都露出 `Copy path`，机制与 [`web.md`](web.md) 的「行内动作」相同。
- **展开态与树的缓存活在组件树之外**（`state/tree.ts`），SSE 刷新才能不丢展开态与滚动位置。**刷新只重取「根 + 当前展开着且真的取过的那几层」**——否则从没点开过 `Files` 的会话每个 `change` 都白跑一趟 `ls-files`。
  - **这条收窄不欠债，因为 `loadDir` 每次调用都真的去取**：收起期间那一层不在刷新范围里，再展开时 `toggleDir` 会取一份新的。若把「缓存里有就不发」当成默认，症状是展开后看到一份陈旧目录，一直旧到下一个 `change`。
  - **`force` 只有一个意思：连「已经在飞」也再发一趟**，刷新专用——「已经在取就不取」会把一次 `change` 引出的刷新整个丢掉：若它正是 agent 那一串写入的最后一个事件，这一层就停在旧内容上。重叠的请求改由按目录的请求序号（`latestWins`）决胜负，与 `loadState` / `loadDiff` 同一套。展开不传它。
  - **根那一层是切到这一档才取**，不在挂载时预取；「取过就不再取」的判据写在 `App` 那个 effect 里。
- **树上的选中态与变更列表是同一份 `activeEditorPath`**（活动 tab 的路径，不看种类）：高亮只回答「右侧此刻是哪个文件」。
- **树跟着活动 tab 展开并定位**（照 VS Code 的 `explorer.autoReveal`）：活动 tab 的路径一变，树把每一级祖先展开、再把那一行 `scrollIntoView({ block: 'nearest' })`。少了它，高亮行躺在没展开的层里，用户看不见「你正在读的是这个」。`state/tree.ts` 的 `revealPath` 只管展开（未展开的祖先加进集合并 `loadDir`），滚动由那一行自己按 `activeEditorPath` 做，不另设「待滚动」信号。三条不显然的判据：
  - **触发 effect 挂在 `FileTree` 组件上，不是全局 `effect()`**：树只在 `Files` 档挂载，「只在可见时 reveal、切过来时补一次」于是不必另判，`tree.ts` 也不必反向 import `store.ts`。**不切侧栏档位**，照 VS Code。
  - **那个 effect 只订阅 `activeEditorPath`，展开那一步包在 `untracked` 里**：让 `expandedDirs` 进依赖集时，用户每手动收起一个目录 effect 就把它展开回去——「收不起来」（有断言）。
  - **自动展开那一趟取失败要把展开态退回去**，手动展开失败不退：diff tab 指向一个整个目录被删的文件时，集合里会留下一个看不见的展开态，目录回来时带着陈旧的错误直接展开，且此后 reveal 它底下的文件都不再取。
- **tab 行右端是 `Collapse all`**（对应 VS Code Explorer 的 view actions）。与被否决的「显示被忽略」开关不是一类：这是每次翻完树都会用的一次性动作。
  - **它是 tablist 的兄弟、不是孩子**（理由见 [`web.md`](web.md) 的「页面骨架」），塞进 tab 行省下一整条横栏；行高由 tab 定，切档时那一行不抖。
  - **只在 `Files` 档画，且排在滚动容器之外**——掉进 `<nav>` 里会跟着树滚走。
  - 不另起组件，直接写在 `App` 那一行；动作的唯一实现是 `state/tree.ts` 的 `collapseAll`。
  - **只清展开态、不清 `treeCache`**：再展开时不该又空一拍。一个目录都没展开时照常可点（真的无操作，不做禁用态）。
  - **不动右侧面板**，也不引出一次自动展开（活动 tab 的路径没变）。

## 全仓搜索

**`Search` 是侧栏第三档，照 VS Code Search 视图：顶上一个输入框带两枚切换钮，下面按文件分组列命中的行。** 状态在 `state/search.ts`，组件是 `SearchView.tsx`；git 那侧（`grep` 的字面量 argv、截断、命中区间）见 [`git.md`](git.md) 的「全仓内容搜索」。

- **只做字面量**，两枚切换钮 `Match Case`（Lucide `CaseSensitive`）、`Match Whole Word`（`WholeWord`），`aria-pressed` 表态，默认都关（照 VS Code）。不做正则，理由见 [`../decisions/git.md`](../decisions/git.md)。
- **输入 300ms 防抖再发**；切换钮一变立即重发。空输入清空结果、不发请求。
- **查询、两枚开关、结果与折叠态都是模块级 signal**：切去别的档再回来，输入与结果原样都在。不进 `localStorage`（见 [`web.md`](web.md) 的「主题开关」）。
- **自动刷新：档位可见且有查询时每个 SSE 重搜一次；看不见时只记一笔「过期了」，切回来补搜一次**——照 History 的「看不见不判，切过来补判」。不可见时也按事件重搜，等于 agent 每写一个文件就把全仓 `grep` 一遍。**同一时刻只有一次在途、在途期间又被叫过就回来后补跑一次**（`singleFlight`）；新查询作废旧请求的结果（`latestWins`）——慢的旧查询晚到时不得盖掉新的。
- **汇总行**：`3 results in 2 files`（单复数照英文）、`No results`；`truncated` 时另起一行 `Showing the first 2,000 results — refine your search`。在取时写 `Searching…`，但**有旧结果时先留着旧的**，回来再换，不闪。出错走引导句 + 原因两行（见 [`web.md`](web.md)）。
- **文件行走 `TreeRow`**：展开三角 + 文件名 + 目录（同住一个 `truncate` span，理由同变更列表）+ 行尾命中数。点它折叠 / 展开，悬停露出 `Copy path`。**折叠态记 collapsed 集合**：默认全展开，重搜后新冒出来的文件不用登记就是展开的。**活动高亮同按 `activeEditorPath`**。
- **命中行缩进一层**：预览文本按 `ranges` 切成普通段与高亮段，高亮底色是 `find-match` token（照 VS Code `editor.findMatchHighlightBackground`）；行号不上行，`title` 是 `<路径>:<行号>`。**行首空白剥掉**，`ranges` 随之平移——缩进深的代码否则在 320px 里只剩一截空白。
- **单击命中行 = 预览打开该文件并跳到那一行，双击固定**（同其余列表）。打开的是 file tab 而不是 diff：搜到的是工作区此刻的全文，那一行在 diff 里未必出现。跳行机制在 [`editors.md`](editors.md) 的「文件视图」。
- **tab 行右端在 `Search` 档不站按钮**：行高由 tab 定，空着不抖。

## 提交历史

**`History` 是 `Changes` 档里变更列表下面那个分区，列 HEAD 可达的近期提交，照 VS Code Source Control Graph：一条提交一行，单击原地展开它改了哪些文件，点文件在右侧开一个 diff tab。** 状态在 `state/history.ts`，组件是 `HistoryList.tsx`；git 那侧的判据（锚点分页、第一父、`log` 的字面量 argv）见 [`git.md`](git.md) 的「提交历史」。

- **两个分区**：上面 `Changes`、下面 `History`（不叫 Graph——没有图形列）。分区壳在 `SourceControl.tsx`，比例与折叠态在 `state/sidebar.ts`。
  - **分区标题是一枚按钮**（三角 + 大写小号标题、`aria-expanded`），排在分区自己的滚动容器之外。
  - **两块各自滚动。都展开时按比例分高度**：上面那块 `flex-basis` 是百分比（默认 50%，夹在 15%–85%），下面 `flex-1` 吃剩下的——存比例不存像素，窗口变高变矮时一起伸缩。一块折起时另一块占满。
  - **折起是隐藏不是卸载**：卸载时滚动容器连同 `scrollTop` 一起没了，折一下再展开就回到顶上。比例与折叠态不进 `localStorage`（见 [`web.md`](web.md) 的「主题开关」）。
  - **中间的横向分隔条与左栏把手是同一个组件 `Sash.tsx`**，只有轴向与单位（像素 / 百分比）由调用方给：pointer capture、收尾、键盘、`touch-action` 这些易漏的机制只写一次，两份副本时修了一把、另一把静默坏着。百分比就是存储单位，取一位小数；拖动起点那一刻量一次列高。
  - **`History` 折起时不取**，与「不在 `Changes` 档」同等对待。默认可见即页面一打开就取第一页。**但要等第一份 state 到了才判**：否则挂载时 HEAD 未知必判「对不上」，state 一到又判一次，每开一次页面两遍 `git log`。这条写在两处：`historyVisible` 把「state 已到」算进可见，`ensureHistory(null)` 自己也直接返回。补判的 effect 挂在 `SourceControl` 而不是 `App`，免得点一下分区标题整页重画。
- **一行 = 展开箭头 + 主题 + 作者**，作者次要色小一号，**两段同住一个 `truncate` span**，理由与变更列表「文件名 + 目录」相同。**短哈希与时间不上行**，进原生 `title`，次序为主题、正文、`短哈希 · 作者 · 相对时间 (绝对时间)`（短哈希 7 位，对照 `git log --oneline`）；完整 sha 不进提示。元信息垫底、不照 VS Code 悬停卡片把作者与时间放在最前，是为了让第一眼落在主题上。不自绘卡片：改动统计要每条多一次 diff，`Open on GitHub` 要读 remote（白名单之外）。body 随列表那次 `log` 一起回来。相对时间用 `Intl.RelativeTimeFormat('en')`，不挂计时器自己跳。
- **提交行悬停露出 `Copy commit hash`，复制完整 sha**（短哈希在大仓库里可能有歧义）。与 `Copy path` 是同一个 `CopyButton`，站在 `TreeRow` 的动作外壳里——点它不会顺带展开这条提交。
- **ref 徽标照 VS Code `scm.graph.badges: all` 的画法**（1.142 源码核对）：当前分支与它的上游各一枚、带色；其余分支与标签按种类合成中性色的几枚。要回答的是两件事——**上游那枚之上的几条就是还没推送的**（状态条上的 `↑3` 对不到具体是哪三条），以及某个分支或标签此刻指着哪一条。当前分支与上游指着同一条时并排，本地在前。
  - **徽标排在 `truncate` span 之后、`shrink-0`，靠行右缘对齐**（`truncate` span 自己 `grow`、把徽标推到右边），照 VS Code：紧跟主题时各行徽标的横向位置随主题长短乱跳，扫一列看「上游在哪一行」得逐行找；本地那枚自身过长时独立 `truncate`。悬停时行内动作的占位照常进流，徽标随之左移一枚按钮宽，按钮盖不到它。**上游那枚只画图标、不印名字**，完整名进原生 `title`：它要回答的「哪几条还没推送」只需要位置，而名字多半还是 `<remote>/<本地分支名>`，印出来只是把主题挤成省略号。判据是角色不是 `kind`——上游是本地分支时照样只画图标。图标同分支列表（本地 `GitBranch`、远程 `Cloud`、标签 `Tag`），色相照 VS Code 的 `scmGraph.historyItem*RefColor`，**但只给图标上色、底色是同色相淡底**——实心底 + 白字在这一栏里比主题还抢眼、对比度也不够。
  - **其余的 ref 每种（本地 / 远程 / 标签）合成一枚：只画图标，多于一条时图标前印条数，名字逐行进 `title`**，照 VS Code：一条提交上常同时挂着一个远程分支和两三个标签，逐个印名字会把主题挤没。次序是本地、远程、标签。与当前分支、上游同名的那条去掉——它已经以带色那枚画过了；判据是名字不是 sha，refs 是早些时候取的，当前分支在里面的 sha 可能已经过时。**中性色**：图标 `description-foreground`、底色借 `list-hover-background`。VS Code 给这几枚用 `badge.background`，而 2026 两份主题里那是一块实心蓝，与当前分支那枚同色相，分不出谁是谁。
  - **当前分支那枚不用取**，画在 `BranchState.oid` 那一行，detached 时不画。**其余的都要取**：status 不给上游的 oid，按 `BranchState.upstream.name` 在 `/api/refs` 的列表里按 git 的解析次序找（见 [`git.md`](git.md)）；其余分支与标签直接读同一份列表。
  - **取的时机：看得见才判，判据是「HEAD oid / 上游名 / ahead / behind 四样对不对得上」，不是「来过 SSE」**，另外 History 每次变得看不见时作废一次、再现身时必重取。**不能只看 HEAD**：push 只挪上游，ahead 那一项是它在 status 里看得见的地方。**没有上游也照样取**，标签与其余分支要它；上游名作为空串进判据，`--unset-upstream` 后再设回同一个时判据也必然变过一次。失败也算对不上（下次判即重试），失败本身不报。
  - **已知局限**：别处打了标签、或挪了一条不是当前分支的分支，而四样都没变时，徽标停在旧位置，直到四样再变、或 History 被折起再展开。refs 不跟 SSE：agent 跑动时每个文件事件都推一次，为这一种情形每次多跑一趟 `for-each-ref` 不值。
  - **徽标指的提交不在已加载的页里就不画**，不为它多翻页。
  - **与分支列表共用 `/api/refs` 端点、不共用状态**（`state/refs.ts` 另存一份 `graphRefs`，票各领各的）：共用时一边失败会抹掉另一边。存的是原样列表，上游是哪条由 `state/badges.ts` 拿**此刻的**上游名去推。失败只在那一次仍是最新时才算。
  - **徽标表只依赖分支状态里的三样字符串与 `graphRefs`**：直接依赖 `repoState` 时 agent 每改一个文件带徽标的行就重画一次。
  - **两样数据从同一个入口进**：`ensureHistory` 既判提交列表也判徽标那份 refs，`refresh` 与可见性 effect 只调它；可见性 effect 在 History 藏起时作废 refs 的判据——不在现身时作废：第一份 state 经 `refresh` 到达时已经取过一次，现身时再作废就是同一份取两遍。
- **落后上游时，列表顶上另起一段 incoming：上游有、HEAD 走不到的那几条**，照 VS Code Graph 把 incoming 画在最上面。状态条上的 `↓3` 只回答「落后几条」，这一段回答「是哪几条」——上游那枚徽标指着的提交 HEAD 走不到，不另起一段它根本画不出来。为什么不合成一列见 [`../decisions/web.md`](../decisions/web.md)。
  - **段首一行不可点的小标题 `Incoming · ↓N`**，N 取 status 的 `behind`，`title` 是 `As of the last fetch`：这几条是远端跟踪分支上次 fetch 时的样子，**不替用户 fetch**（fetch 写 `.git`）。下面用同一个 `CommitRow` 画，展开、`Copy commit hash` 照常——`resolveCommit` 对任意本地提交都成立。段末一条分隔线，之后才是主列表。
  - **不翻页**：一次至多 50 条，还有更多时末尾一行 `+M more`（M = `behind` − 已画条数），不可点。落后几百条时该做的是去终端 pull，不是在侧栏里翻；主列表的锚点分页也因此一行不用改。
  - **上游那枚徽标自然落在这一段里**：`badgesBySha` 按 sha 查、不分段，不为它改一行。
  - **判据是「HEAD oid + 上游此刻的 sha」两样**，上游 sha 拿此刻的上游名在徽标那份 refs 里找（`findUpstream`），所以这一步排在 `ensureGraphRefs` 回来之后，仍从 `ensureHistory` 一个入口进。push 之后 HEAD 与上游都没挪就不重取；fetch 挪了上游时 `behind` 变了，refs 随之重取，sha 也就变了。**`behind` 为 0、没有上游、HEAD 未出生、或 refs 里找不到上游时清空、不取**；refs 还没到、那次取失败、或手里那份不是按此刻的分支状态取的（fetch 之后 `behind` 变了、新 refs 还在途，旧那份里的上游还指着 fetch 之前那条）时**不动现有那段**，等下一次判——判据是 refs 回来时记下的分支状态（`graphRefsFor`），不是「`graphRefs` 有值」。同一时刻只有一次在途，在途期间又被叫过就回来后补跑一次（`singleFlight`），理由同提交列表。
  - **失败只坏这一段**：小标题照画，下面一行错误（`PlaceholderRow`），主列表照常；上次失败也算对不上，下一次判即重试。
- **展开是懒加载的**：第一次展开才问 `/api/commit`，结果按 sha 缓存且**永不失效**（提交不可变）；失败了再展开即重试。浅克隆边界那一条写 `Shallow clone — parent not available`。展开后的占位文案（`Loading…` / 错误 / 浅克隆 / `No file changes`）与文件浏览器的层内占位是同一个组件，规矩同那一条。展开状态记 **expanded 集合**——与变更列表刻意相反：这里默认全收起，新长出来的提交不该自己摊开。
- **文件行复用变更列表那一套**（`TreeRow` + `StatusBadge` + `Copy path`）。单击预览、双击固定。**不画 `Open file`**：它打开的是工作区此刻的全文，而这一行说的是历史上某一版。只平铺、不出树版式。
- **合并提交在行上不另画记号**，说明画在 commit tab 顶上（见 [`editors.md`](editors.md)）。
- **滚到底自动取下一页**：列表末尾一行哨兵，进入可视区（`IntersectionObserver`）即取。**列表每变一次就换一个观察者**：新观察者一 `observe` 就报一次初始状态，高屏上一页填不满时会接着取；只靠一个观察者时哨兵一直可见、交叉状态不变，它不再回调，列表停在半截。不用 `key` 整行重挂代替（会漏判且丢键盘焦点）。**哨兵是一枚按钮**：空闲 `Load more`，在取 `Loading…` 并 `disabled`，同时是键盘那条路。**失败后不自动重试**：哨兵原地变成错误 + 点击重试，否则哨兵一直可见时是一串打不停的失败请求。
- **自动刷新只在 HEAD 挪了时取**：判据是 `BranchState.oid` 与列表顶上那条对不对得上，**不是「来过 SSE」**——按事件重取等于每个文件事件一次 `rev-parse` + `log`。看不见时不判，切过来 / 展开时补判。**同一时刻只有一次在途，在途期间又被叫过就回来后补跑一次**（`http.ts` 的 `singleFlight`）：每次新发并作废前一次时，agent 跑动期间是一串永远轮不到落地的 `git log`；只搭车不补跑时，最后那个 SSE 白来。
- **新提交接在顶上，已翻到的页不丢**：重取的第一页里找到旧 HEAD 且往下那一截与已加载的逐条相同，就只把新的几条接在顶上。**翻页锚点不跟着换**：记着 `anchor` 与它的 `offset`，下一页从锚点起跳过 `commits.length - offset` 条。对不上（amend、reset、rebase、一次长出一整页、合并排进了中间）就整体换成新的第一页，在途的翻页回来即丢弃。
- **空态**：没有提交时是 `No commits yet`。右侧无 tab 时按 `Changes` 档的规矩走——分区不是档位。
- **commit tab 活动时两栏都不高亮**（`activeEditorPath` 为 `null`）：同名那一行说的是工作区那份，照亮它等于说「你正在看它」（见 [`editors.md`](editors.md)）。

## 分支列表

**点状态条上的分支名，窗口顶部居中弹出一个列表，照 VS Code 的 quick pick：顶上一个输入框，下面本地分支、远程分支、标签三组。选中一项即把名字复制进剪贴板**——checkout 属仓库写操作，只读工具能给「选中」的含义只有这一种（为什么不是「在 History 里打开」见 [`../decisions/git.md`](../decisions/git.md)）。状态在 `state/refs.ts`，组件是 `BranchPicker.tsx`；git 那侧见 [`git.md`](git.md) 的「分支列表」。**quick pick 的外壳（弹层、`combobox` / `listbox`、键盘、外部点击、200 条上限、焦点交还）在 `QuickPick.tsx` 只写一份**，与 Quick Open（见 [`web.md`](web.md)）共用——理由同 `Sash.tsx`：易漏的机制两份副本时修了一份、另一份静默坏着。

- **一项两行，照 VS Code**：图标 + 名字 + 相对时间；`作者 • 短哈希 • 主题`。三组图标：本地 `GitBranch`、远程 `Cloud`、标签 `Tag`。相对时间与短哈希复用 History 的 `relativeTime` / `shortSha`。指向树的标签只画第一行。
- **组名画在每组第一项的右端**，第二组起顶上一条分隔线，不另起组标题行。
- **当前分支那一项末尾画 `Check`**：判据是 `BranchState.head` 等于一条本地分支名且不 detached，后端不另标。
- **过滤只按名字**，不分大小写的子串匹配；输入一变活动项回到第一项。**一次最多画 200 条**，超出时写 `N more — type to filter`——几千个标签整份挂进 DOM 是可感知的卡顿。
- **键盘照 quick pick**：输入框自动聚焦，`↑`/`↓` 首尾相接，`Enter` 复制并关闭，`Esc` 关闭；输入框是 `combobox`、列表是 `listbox`，活动项由 `aria-activedescendant` 指。点外部关闭，**外部点击的判据要排除状态条那枚按钮**，否则按下时关、松开又被 click 打开。**关闭后焦点还给那枚按钮**，不还时键盘用户落回 `body`。
- **复制成功的反馈画在状态条那枚按钮上**（列表那时已关）：图标换 `Check`、`title` 换 `Copied <名字>`，时长与 `CopyButton` 同一个常量。写失败静默。
- **每次打开时取一次 `/api/refs`，不随 SSE 重取**：ref 只在 fetch / 建分支 / 打标签时变。取到过就先画旧的、回来再换（`latestWins`）；首次写 `Loading…`；失败写错误且**不与旧列表并排**（看不出哪一样是现在的）；空列表写 `No branches or tags`。
