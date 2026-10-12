# 前端：右侧面板、编辑器标签页与文件视图

> 右侧面板是 [`web.md`](web.md) 那副骨架的右半边：一条标签栏 + 一个视图（diff 或全文）。diff 怎么渲染在 [`diff-render.md`](diff-render.md)。被排除的做法见 [`../decisions/web.md`](../decisions/web.md)。标「有断言」的条目由 `test/unit/web/` 钉住、不进红线。

## 编辑器标签页

**右侧面板顶部是一条标签栏，可以同时挂多个文件；左栏单击是预览、双击是固定，照 VS Code 编辑区的惯例。** 状态在 `state/editors.ts`：一个有序的 `editors` 列表 + 一个 `activeEditorKey`，此刻画哪个视图由活动项的 `kind` 派生，不另设 `activePane`——两份就有「谁是真的」这个问题。

- **tab 的身份是 `kind:path`**：同一路径的 diff 与全文是两个 tab（VS Code 同样如此）；合成一个就得再记一份「此刻显示哪种」，切换时另一种的滚动位置也丢。键只用来比对、不反解析。
- **预览 tab 全局只有一个，判据是 `pinned === false` 的那一项，不是「最后打开的」**。单击不在栏里的文件：有预览 tab 就**原位**替换，没有就追加；单击已在栏里的只是切过去。
  - **`openEditor` 的 `pinned` 档给 `Open file` 用**（照 VS Code `git.openFile` 的 `preview: false`）：不在栏里就追加一个固定 tab、不碰现有预览 tab，已在栏里就固定并切过去。调用方不自己「先开预览再 pin」——那样会先顶掉一个无辜的预览 tab。
  - **`pinEditor` 是幂等的置 `true`，永不 toggle**：一次双击是 click、click、dblclick 三个事件，写成 toggle 会让已固定的 tab 在双击时静默解开。**dblclick 只调 `pinEditor`、不再走 `selectFile`**，否则一次双击是三趟 `git diff`。
- **第三种 tab 是 `commit`，身份是 `commit:<sha>:<path>`**：`Editor` 多带一个 `sha`，`path` 仍是文件路径，其余读 `path` 的地方照旧。tab 上文件名后跟短哈希，图标 `GitCommitHorizontal`。**它活动时 `activeEditorPath` 是 `null`**：左栏同名那一行说的是工作区那一份，照亮它是在说一件不成立的事——这是「高亮不看种类」唯一的例外，判据是「左栏那一行与右侧是不是同一份内容」。
- **关掉活动 tab 切到右邻居、没有才切左邻居**，不维护 MRU 序列。
- **两栏的高亮同按活动 tab 的路径判（`activeEditorPath`），不看 diff 还是全文**：按种类各认各的时，点了行内 `Open file` 那一行就熄了——用户刚从这一行出发，左栏却说「你没在看它」。
- **切侧栏 tab、切列表 / 树版式、全部折叠，都不动 `activeEditor`**（症状见 [`web.md`](web.md) 的「页面骨架」）。**反方向有联动**：活动 tab 的路径一变，`Files` 树展开并定位那一行（机制在 [`sidebar.md`](sidebar.md) 的「文件浏览器」），但不切侧栏档位。
- **不进 `localStorage`**：端口随机，写了也活不过一次重启。

### 自动刷新怎么收编这些 tab

**每次 SSE 之后要过一遍栏里全部的 diff tab，不只活动那一个**：改动被撤销或 commit 掉的关掉，重命名的跟到新路径。只看活动 tab 时，后台 tab 里那份补丁照样留着，切过去看到的是左栏已断言不存在的东西，且它再也不会被刷新。

- **重命名不算消失**：先按 `path` 找、再按 `oldPath` 找，命中就 `renameEditor`（`pinned` 不变，活动键跟着走）。**两趟而不是一趟 `||`**：A→B 后又在 A 新建文件时两条都命中，该跟的是路径就是 A 的那条。**新路径上已有 tab 时并入它**：幸存者保位置，`pinned` 取或。
- **只重取活动那一个，其余切过去时再取**（`activateEditor` 每次都真的去取）：栏里 10 个 diff tab 时，否则每个事件 10 趟 `git diff`。切过去时缓存照常显示、新的回来再换，同一个 path 已 `ready` 就不回退 `loading`，不闪。**`refresh()` 内部用 `removeEditor` 而不是 `closeEditor`**：后者会顺手重取邻居，与 `refresh()` 末尾那次叠成两趟。
- **在途的请求要一并作废**：否则关掉 X 后那次请求照样写进缓存，下次打开 X 先看到它。手段是按路径 `claim` 一张票（`http.ts` 的 `latestWins`），**与删缓存成对写在 `forget()` 里**——漏掉作废那一半没有任何东西会红。
- **commit tab 不收编，`ready` 了就不再取**：提交不可变，SSE 与它无关。**在途（`loading`）也不重取**：每次 SSE 都重发时新票作废旧票，慢补丁在 agent 跑动期间永远落不了地。**只有 `error` 的才在切过去时重取**，否则唯一的重试路径是回 History 重新点。提交被 gc 掉时那一次写成 `error`。
- **file tab 永不自动关**：文件被删也只是那一次 `loadFile` 写成 `error`。
- **活动的 file tab 在 `loadState()` 之前就重取**，不等新列表：它的数据源是工作区本身。收编后活动键变了才对新活动的 file tab 补取一次。

## 标签栏与视图

**标签栏是面板唯一的 chrome，排在滚动区域之外。** 面板是一列 flex：`EditorTabs` 占第一行，底下 `Panel` 那一层（`min-h-0 flex-1 overflow-auto`）才滚。不再有路径横杠或面包屑——「在看哪个文件」由活动 tab 回答，完整路径挂在 tab 的 `title` 上。

- **一个 tab = 种类图标 + 文件名 + 目录 + 关闭按钮。** 图标按 `kind`（`FileDiff` / `FileCode`），是同一路径两个 tab 之间唯一的视觉差别。文件名与目录**同住一个 `truncate` span**，理由同变更列表。预览 tab 的名字 `italic`。
  - **关闭按钮只在活动 tab 上常显，其余悬停或键盘焦点在 tab 内时才露出**（照 VS Code）。**用透明度藏而不是不渲染**：位置留着，悬停时 tab 宽度不跳。键盘那半条是 `group-focus-within`（不是行内动作那种 `has-focus-visible`）：活动 tab 本来就常亮着 ×，鼠标点过后焦点留在 tab 内也不会多钉住什么。`IconButton` 的悬停底色是半透明叠加的 `toolbar-hover-background`，否则在非活动 tab 的悬停底色上看不出反应。
- **关闭按钮是 tab 按钮的兄弟，不是孩子**：套在里面时 tab 不是按钮，得手写 `tabIndex` / Enter / Space、另开手型光标规则、每个处理器加「来自 × 的事件不处理」守卫（不守时快速双击 × 会把滑到指针底下的邻居静默固定住），且 `role="tab"` 的子元素在无障碍树里只当文本、读屏看不见 ×。并排之后这些一起消失。中键（`auxclick` 且 `button === 1`）也关闭。`role="tablist"` 带 `aria-label="Open editors"`。
- **选中态是 tab 自己的 `border-b`，通栏分隔线是栏的 `divider-b`（inset 阴影）——与侧栏那行 tab 同一套机制**。**这一栏是这套机制存在的理由**：它是滚动容器，按 padding box 裁内容，「栏 `border-b` + tab `-mb-px`」的教科书写法伸进 border 带的那 1px 会被裁掉——下划线看不见，还留下 1px 纵向可滚溢出，「始终显示滚动条」的系统设置下就是一条常驻滚动条。活动 tab 带 `bg-editor-background`，与正文连成一片。
- **栏与左栏顶栏同高**（有断言）。**栏横向滚动、每个 tab `shrink-0`、滚动条隐藏（`scrollbar-none`）**：画出滚动条时栏会被撑高、与顶栏错开。**活动 tab 要自己滚进视野**（`scrollIntoView`，`inline: 'nearest'`）：否则溢出后新开的 tab 在屏幕外，正文换了而栏上看不出变化。
- **`DiffView` / `FileView` 接 `path` prop，在渲染体里读 `diffStates.value.get(path)`，不能用 `useComputed` 包**：`useComputed` 只随 signal 依赖重算，prop 换了它停在上一个 tab——「切了 tab 标题变了正文没变」。
- **切 tab 是卸载重挂，滚动位置不保留**：diff2html 的 DOM 每份 MB 级，N 个 tab 常驻挂载等于 N 份 DOM，`outputFormat` 一变每份都要重画。**卸载重挂靠 `App` 给视图按 tab 键 `key`**：只换 `path` prop 时 `Panel` 连同 `scrollTop` 留着，B 从 A 的偏移量打开，而换视图种类时又从顶部开始——两种切法必须一个样子。视图里不再另给 `Payload` 一份 `key`。
- **右侧空态只在栏里一个 tab 都没有时画**（`PanelEmptyState`）：`Changes` 档且工作区干净是 `Working tree clean` 配 ✓，其余是 `Select a file on the left`，图标按档位。「没得选」与「还没选」是两件事；第一份 state 没到时走「还没选」。
  - **空态居中并配一枚图标**，`flex-1` 撑满面板是居中成立的前提（有断言）。
  - **其余提示（loading / error / binary / too-large / symlink）仍是 `Notice` 贴左上**：它们说的是「这个文件怎么了」，居中反而像整个面板坏了。
- **`Panel` 由两个视图共用**：各写一份时漂开的症状是「其中一个面板底下那半屏不跟着滚」。

## 文件视图

**右侧那一份是只读全文，不是 diff。** `FilePayload` 五个 `kind` 全部在 `FileView` 分支，提示行与 `DiffView` 共用 `Notice`，`image` 那一支共用 `ImageView.tsx`。

- **语言判定与 diff 视图同为 `languageOf(path)`**（`diff/hljs.ts`），它内部先 `getLanguage()` 探一下：`highlight()` 传未注册的语言名会抛，而这里没有 diff2html 兜底，抛出去炸的是整个文件视图。取不到退回 `plaintext`（见 [`diff-render.md`](diff-render.md)）。
- **容器上不得加 `hljs` 类**（理由在 [`style.md`](style.md) 的「文件视图与 `.hljs`」）。
- **行号做成兄弟元素，不按行切高亮输出**：hljs 的 span 会跨行，切开就是在重写被禁止的高亮切分逻辑。行号槽 `sticky left-0`。
- **`sticky left-0` 要成立，正文那一层必须是 `w-max`**：普通块盒只有面板宽，行号槽没有滑动余量，横向一滚整列行号跟着滑出视口，而 `sticky left-0` 字样还在原地。
- **但 `w-max` 只能给正文那一路**，判据是按 `kind` 穷举的 `NEEDS_WIDE_BOX` 表（`Record` 漏键是编译错误，写成 `kind === 'text'` 一句则是第二处独立判定）：`max-content` 下提示行那几句散文会排成一行跑出面板，`break-all` 也救不了（实测读数见 [`../decisions/web.md`](../decisions/web.md)）。以上有断言。
- 标签栏在滚动容器之外，不参与横向滚动。

## 图片视图

**`DiffPayload` / `FilePayload` 的 `image` 支由 `ImageView.tsx` 承接，两个面板共用**：diff 那侧 `ImageDiff` 按 `old` / `new` 各画一张（`null` 的那侧不画），文件那侧 `ImageFile` 画一张。图片不是新的一种 tab。

- **说明文字（`Before` / `After` · 像素尺寸，体积另起一段、只隔 `gap-2` 不加点）挂在每张图的右下角**：排在图上方时 caption 宽度随文字变，两张并排的图顶边不齐。**像素尺寸由 `<img>` 的 `onLoad` 读 `naturalWidth × naturalHeight`**，不让后端解析图片头——那是第二份事实来源。
- **前端不判「这是不是图片」，只认 `payload.kind === 'image'`**：判据与扩展名表只在后端一份。
- **commit tab 里的图片 URL 多带 `commit=<sha>`**，`version` 是对象名，取一次就够。
- **字节走 `<img src="/api/blob?path=&side=&v=">`**：同源、带 cookie、CSP 的 `img-src 'self'` 现成放行；不 `fetch` + `createObjectURL`（要给 CSP 开 `blob:`），不内联 base64。`path` 直接用 `ImageSide.path`。
- **`v=` 与 figure 的 `key` 都是后端给的内容身份 `ImageSide.version`，前端只比对不解读**。它必须随内容变：URL 不变时浏览器不重新请求，「图改了、页面上还是旧的」。它也**只能**随内容变：`loadDiff` 每个 SSE 都跑，按「取过一次」换戳会让每次无关改动都重下两张图。
- **图底下垫棋盘（`checkerboard`）**，格子色复用 `--color-diff-diagonal-fill`，不另开颜色；图外一圈边框。
- **图 `max-w-full h-auto`，不做缩放、滑块、洋葱皮、像素 diff**。两张图 `flex-wrap`，与 diff 的版式切换不联动。
- **图水平居中、从顶部起排，放图的那一行（`ImageRow`）两个视图共用、单张也走它**：单张退成普通块盒时 caption 贴的是面板右边而不是图的右下角。
- **`<img>` 的 `onError` 落成一句 `Could not load the image.`**：payload 与取字节之间文件可以被删、被改、长过 5MB，旧侧是 symlink / gitlink 时字节也解不出。**失败态必须随内容变化归零**：figure 按 `version` 给 `key`，否则撞上一次半写的文件后那一侧永远停在提示上。
- **`NEEDS_WIDE_BOX.image = false`**：写 `true` 时宽图把滚动区撑到原始像素宽。
- **体积走 `formatSize(size, 2)`，0 不画**：与 `too-large` 同一个 helper，精度靠一个参数分——caption 是元数据，`1.59 KB` 与 `2 KB` 的差别正是它要回答的。两份 helper 第一次提交就漂开过。
