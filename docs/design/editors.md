# 前端：右侧面板、编辑器标签页与文件视图

> 右侧面板是 [`web.md`](web.md) 那副骨架的右半边：一条标签栏 + 一个视图（diff 或全文）。diff 怎么渲染在 [`diff-render.md`](diff-render.md)，左栏与页面骨架在 [`web.md`](web.md)。被排除的做法见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)。

## 编辑器标签页

**右侧面板顶部是一条标签栏，可以同时挂着多个文件；左栏单击是预览、双击是固定，照 VS Code 编辑区的惯例。** 状态在 `state/editors.ts`：一个有序的 `editors` 列表 + 一个 `activeEditorKey`，此刻画哪个视图由活动那一项的 `kind` 派生，不再另设一个 `activePane`——两份就有「谁是真的」这个问题。

- **tab 的身份是「视图种类 + 路径」（`kind:path`），同一路径从 `Changes` 点开的 diff 与从 `Files` 点开的全文是两个 tab**。两处点进去看到的是两样东西（补丁 / 全文），VS Code 里 diff editor 与普通 editor 同样是两个 tab；合成一个就得再记一份「这个 tab 此刻显示哪种」，切换时另一种的滚动位置也跟着丢。键只用来比对、不反解析：`kind` 是闭合的 union 且不含 `:`，路径里的 `:` 因此不产生歧义。
- **预览 tab 全局只有一个，判据是 `pinned === false` 的那一项，不是「最后打开的」**。单击一个不在栏里的文件：有预览 tab 就**原位**替换它（位置不跳），没有就追加；单击已在栏里的只是切过去，它是预览就还是预览。双击把它固定；**`pinEditor` 是幂等的置 `true`，永不 toggle**——浏览器的一次双击是 click、click、dblclick 三个事件，第三个到时 tab 早已存在，写成 toggle 会让已固定的 tab 在双击时静默解开。第二次 click 会再激活一次并重取一趟（沿用「点当前这一行照样重新取」），双击因此多花一趟请求，按路径的「后发为准」保证它不出错；**dblclick 那一下只调 `pinEditor`、不再走 `selectFile`**，否则一次双击是三趟 `git diff`。
- **关掉活动 tab 切到右邻居、没有右邻居才切左邻居**，不按最近使用顺序：MRU 要多维护一份访问序列，而它换来的只是关掉一个刚从别处切过来的 tab 时少切一次。
- **两栏的高亮各认自己那一种**：变更列表按 `activeDiffPath`、目录树按 `activeFilePath`，都是从活动那一项派生的 computed。活动 tab 是 `file:src/a.ts` 时变更列表里 `src/a.ts` 那一行不亮——那一行说的是「这份补丁」，而此刻在读的是全文。
- **切侧栏 tab、切列表 / 树版式、全部折叠，都不动 `activeEditor`**：换的是左栏在列什么，不是用户此刻在读什么。写成「切到 Files 就清空右侧」时页面看着完全正常，只是每瞄一眼目录树就丢掉正在读的那份 diff。
- **不进 `localStorage`**，与变更列表的版式开关同一个理由：后端 `listen(0)` 端口随机，写了也活不过一次重启。

### 自动刷新怎么收编这些 tab

**每次 SSE 之后要过一遍栏里全部的 diff tab，不只活动那一个**：改动被撤销或 commit 掉的 tab 关掉，重命名的跟着走到新路径。判据仍是「左栏此刻正在断言这些改动不存在，而右栏还在展示其中一份」——只看活动 tab 时，后台 tab 里那份补丁照样留着，切过去看到的是一份左栏已经说不存在的东西，且它再也不会被刷新。

- **重命名不算消失**：先按 `path` 找、再按 `oldPath` 找一次，命中就 `renameEditor` 到新路径（`pinned` 不变，活动键跟着走）。**两趟而不是一趟带 `||` 的谓词**：A→B 改名之后又在 A 位置新建一个文件时，两条都能命中同一个 `path`，而该跟的是路径就是 A 的那条。**新路径上已经开着一个 tab 时并入它**：幸存者保位置，`pinned` 取或，活动键移过去——两个同键的 tab 并排在栏里是没有意义的。
- **只重取活动那一个 tab，其余切过去时再取**（`activateEditor` 每次都真的去取，与目录树的 `loadDir` 同一取向）。每个 SSE 事件都走这条路，而 agent 跑动期间事件密集：栏里挂着 10 个 diff tab 时每个事件就是 10 趟 `git diff`。切过去时缓存的那份正文照常显示、新的回来再换掉——「同一个 path 已 `ready` 就不回退 `loading`」那条让它不闪。**`refresh()` 内部用列表层的 `removeEditor` 而不是 `closeEditor`**：后者会顺手重取新邻居，而 `refresh()` 末尾本来就要取一次活动 tab，两处各取一趟就是一次事件两趟请求。
- **在途的那次请求要一并作废**：关掉 X 之后、响应回来之前，那次请求回来照旧写进缓存——不报错，只是内存里多一份没人看的补丁，且下次再打开 X 时先看到的是它。作废手段是按路径 `claim` 一张票（`http.ts` 的 `latestWins` 本就按 key 计数），**与删缓存成对写在 `forget()` 里**，调用方不展开——漏掉作废那一半时没有任何东西会红。票不 `release`，`latest` 那张表随本次会话触过的路径增长，有界。
- **file tab 永不自动关**：目录树列的是整棵仓库，文件被删了也只是那一次 `loadFile` 写成 `error`，与从前一致。
- **活动的 file tab 与从前一样在 `loadState()` 之前就重取**，不等新列表也不受它失败影响：它的数据源是工作区本身。收编之后活动键变了（活动 tab 被关、邻居顶上）才对新活动的 file tab 补取一次，否则那一趟已经发过了。

## 标签栏与视图

**标签栏是面板唯一的 chrome，排在滚动区域之外。** 面板（`App` 那个 `<section>`）是一列 flex：`EditorTabs` `shrink-0` 占第一行，底下 `Panel` 那一层 `min-h-0 flex-1 overflow-auto` 才是滚的那一个。从前那条路径横杠去掉了——它回答的「在看哪个文件」现在由活动 tab 回答，完整路径挂在 tab 的 `title` 上；栏下再留一行面包屑等于每个 tab 都写两遍名字。

- **一个 tab = 种类图标 + 文件名 + 目录 + 关闭按钮。** 图标按 `kind`（diff 是 `FileDiff`、全文是 `FileCode`，与空态那两枚同源），是同一路径两个 tab 之间唯一的视觉差别。文件名与目录**同住一个 `truncate` span**（名在前、目录作它的行内子元素、`max-w-64`），理由与变更列表那一行一字不差：省略号在右端天然先吃掉目录。预览 tab 的名字 `italic`（VS Code 的惯例），固定之后转正。`title` 挂整个 tab。**关闭按钮只在活动 tab 上常显，其余 tab 悬停或键盘焦点落在 tab 内时才露出来**（照 VS Code）：一排 `×` 常亮就是一排随时会误点的按钮，而此刻在看的那个是最可能要关的。**用透明度藏而不是不渲染**：位置留着，悬停时 tab 宽度才不跳；`group-focus-within` 那半条是给键盘的，Tab 到关闭按钮上时它得看得见。**鼠标单独悬在 `×` 上要有自己的一档高亮**：非活动 tab 自己在 hover 态就是 `list-hover` 底色，按钮再用同一个 token 就与它所在的 tab 同色、看不出反应——`IconButton` 的悬停底色因此是半透明叠加的 `toolbar-hover-background`（VS Code 的 `toolbar.hoverBackground`），叠在哪种底色上都比周围深一档。
- **关闭按钮（`IconButton`，`Close`）是 tab 按钮的兄弟，不是孩子**：一个 tab 是外壳 div 里并排的两枚 `<button>`——`role="tab"` 那枚装图标与名字，`×` 在它旁边。套在里面的写法（tab 是 div、× 是它的孩子）要跟着付三样：tab 不是按钮就得手写 `tabIndex` 与 Enter / Space、手型光标得给 `[role="tab"]` 另开一条规则、四个处理器各带一个「来自 × 的事件不处理」的守卫（不守时点 × 会顺带把那个 tab 激活再关掉，快速双击 × 时第一下已经把 tab 关了、后两个事件落在滑到指针底下的邻居上——邻居被静默固定住）；而 `role="tab"` 的子元素在无障碍树里本就只当文本，嵌进去的 × 读屏根本看不见。并排之后 × 的事件压根不经过 tab 按钮，三样一起消失，键盘与光标由原生按钮免费给。中键（`auxclick` 且 `button === 1`）也关闭，照 VS Code。`role="tablist"` 带 `aria-label`（`Open editors`），tab 按钮上 `aria-selected`、`title` 是完整路径。
- **选中态的画法与侧栏那两枚 tab 同一套机制**（`-mb-px border-b` 压在栏的 `border-b` 上，选中 `border-editor-foreground`），外加 `bg-editor-background` 让活动 tab 与底下的正文连成一片（VS Code 活动 tab 的底色就是编辑器底色）；未选中是次要色 + 悬停底色。类名不与 `App.tsx` 的 `TAB_CLASS` 共用一个常量——内边距与内容都不同，共用之后改一处会连累另一处。
- **栏 `overflow-x-auto`、每个 tab `shrink-0`**：tab 多了往横向滚，不压扁。**活动 tab 要自己滚进视野**（`scrollIntoView`，`inline: 'nearest'`）：新 tab 追加在末尾，溢出之后新开的那个就在屏幕外——正文换了而栏上看不出任何变化，关掉活动 tab 时顶上来的邻居在屏幕外也一样。
- **`DiffView` / `FileView` 接 `path` prop，在渲染体里读 `diffStates.value.get(path)`，不能用 `useComputed` 包一层**：`@preact/signals` 的 `useComputed` 只在 signal 依赖变了时重算，prop 换了而 map 没写时它停在上一个 tab 的正文上——页面上就是「切了 tab 标题变了正文没变」。视图只是一个订阅者，每次 map 写入重渲染一次，代价可以忽略。缓存里没有这一项时画一行 `Loading…` 兜底——`openEditor` 与写 loading 在同一个同步 tick 里，产品里到不了，留着是让组件对每个状态都有答案。换文件的卸载重挂由 `App` 给视图的 `key` 承担（见下），视图里不再另给 `Payload` 一份 `key`——两个机制做同一件事，其中一个永远走不到。
- **切 tab 是卸载重挂，滚动位置不保留**：diff2html 的 DOM 每份都是 MB 级，N 个 tab 常驻挂载等于 N 份 DOM 常驻；且 `outputFormat` 一变每份都要重画。切回来重画一遍是刻意的代价。**「卸载重挂」要靠 `App` 给视图按 tab 键 `key`**：只换 `path` prop 时组件不卸载，`Panel` 那层滚动容器连同 `scrollTop` 一起留着——在 A 里滚到三千像素再切到同种的 B，B 从同一个偏移量打开；切到另一种视图却因为换了组件类型从顶部开始。两种切法必须一个样子。同一个 tab 内换补丁不换键，容器照旧留在原地。
- **右侧空态只在栏里一个 tab 都没有时画**（`PanelEmptyState`，判据在它里面只写一次）：说哪句、配哪枚按**侧栏档位**定——`Changes` 档且工作区干净是 `Working tree clean.` 配 ✓，其余是 `Select a file on the left.`，`Changes` 档配 `FileDiff`、`Files` 档配 `FileCode`。「没得选」与「还没选」在页面上是两件事；`Files` 档下即使干净也走「还没选」那句，那一档列的是整棵目录树。判「干净」读的是 `repoState`：第一份 state 还没到时走「还没选」，左栏此时写的正是 `Loading…`。两个视图自己不再有空态分支：它们拿到的永远是一个存在的 tab。
  - **空态居中并配一枚图标**：面板空着时没有别的东西可对齐，一行贴在左上角的小字看着像漏画了什么。`flex-1` 撑满面板是居中成立的前提——宿主 `<section>` 是一列 flex，这一层不撑满时 `justify-center` 只在自己那点内容高度里居中，页面上仍然贴顶、不报错（`app.test.tsx` 钉类名）。图标只是装饰：走同一个 `Icon` 外壳（`aria-hidden`）、`stroke-1` 收细、`opacity-60` 与被忽略文件灰显同一档。
  - **其余提示（loading / error / binary / too-large / symlink）仍是 `Notice` 贴左上**：它们在 `Panel` 里，说的是「这个文件怎么了」而不是「面板空着」，居中反而让它们看着像整个面板坏了。
- **`Panel` 只剩滚动那一层，仍由两个视图共用**：这一层是 `<section>` 的直接子项，类名必须逐字相同——各写一份时漂开的症状是「其中一个面板底下那半屏不跟着滚」，不报错。

## 文件视图

**右侧那一份是只读全文，不是 diff。** `FilePayload` 四个 `kind` 全部在 `FileView` 分支，提示行的外观与 `DiffView` 共用同一个 `Notice`。

- **语言判定是「扩展名 → hljs 语言名」的一张小表，且必须先 `getLanguage()` 探一下**：`highlight()` 传未注册的语言名会抛，而这里没有 diff2html 兜底——抛出去炸的是整个文件视图。取不到一律退回 `plaintext`（它已在那 22 个模块里注册着，见 [`diff-render.md`](diff-render.md)）。
- **容器上不得加 `hljs` 类**，理由在 [`style.md`](style.md) 的「文件视图与 `.hljs`」：那条规则是 unlayered 的，会压过 Tailwind 的背景工具类。15 条 token 规则（`.hljs-keyword` 之类）是独立选择器，不挂容器类照样生效。
- **行号做成兄弟元素，不按行切高亮输出**：hljs 的 span 会跨行，切开要自己重开标签——那正是红线在 diff2html 上明令禁止的事，在这里同样不做。行号槽 `sticky left-0`，横向滚代码时它留在左边。
- **`sticky left-0` 要成立，正文那一层必须是 `w-max`。** 长行把正文撑得比面板宽，而横向滚动发生在标签栏底下那层滚动容器上；这一层若是普通块盒，它只有面板那么宽，行号槽因此**一点滑动余量都没有**——粘不粘都是同一个位置，横向一滚整列行号跟着内容滑出视口，而「`sticky left-0`」这几个字还在原地，看上去像是已经处理过了。**从前与它并写的 `min-w-full` 已经去掉**：那半条挡的是「短文件下标题栏缩成半截」，而标题栏搬出滚动区之后宽度不再来自这一层，正文这一路自己没有任何要铺满面板的底色或边框。
- **但这个类只能给正文那一路**，判据是 `NEEDS_WIDE_BOX` 那张按 `kind` 穷举的表（写成 `payload.kind === 'text'` 一句时它就是第二处独立判定 kind 的地方，与 `Payload` 的 switch 各写各的，加进第五个 kind 时漏改这边会让粘性静默退回 static；`Record` 的键是穷举的，漏一个是编译错误）。**理由**：`max-content` 下文本一律不折行，而提示行那几路是散文——整句排成一行横着跑出面板，要横向滚才看得全；symlink 那句里为长路径写的 `break-all` 也救不了，它只把 min-content 降到一个字符、max-content 仍是整句不断。实测读数见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)。上面这几件事都有断言（`file-view.test.tsx` 直接钉类名——happy-dom 没有排版引擎，能断言的只有类名在不在），故不进红线。
- **标签栏不参与横向滚动**：它排在滚动容器之外（见上面「标签栏与视图」），横向滚动只发生在底下那层，栏自己恒等于面板宽。
