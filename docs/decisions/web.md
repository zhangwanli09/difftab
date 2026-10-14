# 前端渲染与体积

> 收录规则与实测环境见 [`README.md`](README.md)。

- **深导入 diff2html 的 UI 层源码是合法且够用的**：`html()` 本身不含语法高亮，高亮由 `Diff2HtmlUI.highlightCode()` 完成，依赖 `./highlight.js-helpers` 的 `closeTags` / `nodeStream` / `mergeStreams` / `getLanguage`；四个模块明文体积合计约 35 KB，而 diff2html 的 `package.json` **无 `exports` 字段**，深导入不受限制。作为对照，三个预构建 UI bundle（diff2html 3.4.56 / highlight.js 11.11.1）分别是 1,048,945 / 301,714 / 90,167 B，`diff2html.min.css` 17,331 B。
- **hljs 的语言子集是体积大头，也是唯一值得再砍的地方**：22 个 `es/languages/*.js` 明文**合计 225,598 B**（最大的五个是 swift 22,517 / typescript 21,359 / scss 19,468 / css 18,884 / javascript 17,756 B），压缩后约 130 KB / gzip 约 40 KB。另：`es/languages/{jsx,tsx,toml}.js` 实测均 **404**——它们是别名（`ini.js` 里 `aliases: ['toml']`、`javascript.js` 含 `jsx`、`typescript.js` 含 `tsx`），注册主模块即生效。
- **hljs 主题 CSS 是必需的**：`diff2html.min.css` 中含 hljs 的规则数为 **0**，预构建 slim 包也只含 hljs 运行时与语言定义、不含配色。上游那两份体积微不足道（`github.min.css` 1,309 B、`github-dark.min.css` 1,315 B，合计约 2.6 KB），现已合成我们自己的 `hljs-theme.css`（理由见 [`style.md`](style.md)）。
- **文件头里的增删统计得自己画，`RenameNotice` 也不能省**（3.4.56）：`.d2h-file-header` 的全部内容是 `d2h-icon` + `d2h-file-name` + `d2h-tag` + `d2h-file-collapse` 四样、**没有任何数字**——三个统计类只出现在 `d2h-file-list-line` 那份模板里（我们传 `drawFileList: false`）；两份 diff 模板又把 `.d2h-file-header` 无条件写在 `.d2h-file-wrapper` 的第一个子节点上，**没有任何配置项能关掉它**。它对重命名给的是紧凑形式 `src/{kept.txt → kept-renamed.txt}`，替代不了带完整旧路径与相似度的 `RenameNotice`。
- **严格 CSP 不需要 `'unsafe-inline'`**：diff2html 模板中的内联 `style=` 出现 **0** 次，`draw()` 改样式走 CSSOM（`el.style.display = …`）。
- **两种 `outputFormat` 在 DOM 上的分界**（3.4.56）：同一份补丁 `side-by-side` 输出 **2 张** `.d2h-diff-table`（各裹在一个 `.d2h-file-side-diff` 里）、`line-by-line` 输出 **1 张**且 `.d2h-file-side-diff` 出现 **0** 次——这对正反计数就是单测里区分两种格式的判据。只被并排选择器读到的是 `--d2h-change-*` 与 `--d2h-empty-placeholder-*`，逐行下**失效而非缺失**，故两种格式共用同一套映射即可。
- **`synchronisedScroll` 是并排两侧唯一的联动机制，且没有回声抑制**（就 3.4.56 的 `diff2html-ui-base` 源码逐行核对）：`draw()` 里按 `.d2h-file-wrapper` 取出那对 `.d2h-file-side-diff`，两侧的 `scroll` 事件**无条件**互相回写 `scrollLeft` / `scrollTop`——回写引起的那次事件与用户自己滚出来的那次分不开。两侧滚动上限由各自最长行决定、通常不等，于是越过窄侧上限的那一下，窄侧被夹住后仍冒出一次事件，把宽侧回写到窄侧的上限：**表现为边界处顿一下，不是卡死**，之后继续正常滚（Chrome 实测，拿本仓库对 `docs/decisions.md` 的工作区改动、视口 1600 走并排：两侧横向上限分别是 **3765 / 4839**；把宽的那侧写到 4200，两侧一起落在 3765，再写 4500 则停在 **3765 / 4500**——窄侧饱和之后不再冒事件，宽侧照常滚到底）。上限为 0 的那一侧（新增文件的左半边全是空占位）反而不受影响——写不动就不产生事件。CSS 那侧没有替代品：`.d2h-file-side-diff{overflow-x:scroll;overflow-y:hidden;width:50%}` 让两半各自成为滚动容器，而把滚动收到共同祖先上得先给这两半 `overflow-x: visible`——两半各占 50% 宽，溢出的正文不再被裁，随即互相压盖。
- **1024 这个阈值是算出来的，不是断点抄来的**（就 `diff2html.min.css` 实测）：`.d2h-diff-table` 的字体是 `Menlo,Consolas,monospace` 13px，并排的 `.d2h-code-side-line{padding:0 4.5em;width:calc(100% - 9em)}`、逐行的 `.d2h-code-line{padding:0 8em}`——即 13px 下并排每侧固定吃掉 **117px**、逐行吃掉 **104px** 的行号槽，按 Menlo 13px 每字符约 **7.8px** 折算。**与 Tailwind 的 `lg`（1024px）数值相同是巧合**：那是视口断点，这里量的是面板。
- **`ResizeObserver` 要 `observe(el, { box: 'border-box' })`，只在读值那侧取 `borderBoxSize` 不够**：`observe(el)` 默认按 **content box** 判「有没有变」，于是滚动条每次进出都推一次回调，哪怕 border box 一动没动——读值那侧滤的是**已经产生的**回调，指定观察 box 才是从源头不投递。另：`borderBoxSize` 读的是观察阶段已算好的值，且**不带 transform 缩放**——对「还剩多少地方排版」这个问题，未缩放的排版宽度才是想要的那个。
- **`position: sticky` 的滑动余量来自包含块，不是滚动容器**（Chrome 实测）：文件视图的行号槽`sticky left-0` 长期不生效，因为它的包含块只有面板那么宽（960px），而横向滚动发生在外面那个`<section>` 上、内容实测宽 9446px——**余量为 0 时 sticky 与 static 在页面上完全一样**，没有任何东西会响。给那一层 `w-max` 之后包含块与内容齐宽，行号槽的 `left` 实测从 -266 回到 320（= 面板左缘）。**代价是这个类只能给正文那一路**：`max-content` 下 `break-all` 不再起作用（它只降 min-content），一条 60 层的相对路径实测把提示行撑到 **1977px**、而面板 960px——去掉 `w-max` 后同一条回到 960px 正常折行。
- **happy-dom 盖不到的两处**（20.11.2）：其一，`Attr.nodeName` 返回空字符串（同一属性上 `name` / `localName` 都正常），而 diff2html 的 `mergeStreams.open()` 恰好用它重新序列化属性，于是凡走过 `mergeStreams` 的行——带 `<del>` / `<ins>` 词级标记的增删行——**类名丢失**（真机实测 177 个 hljs span / 12 类，故只影响 DOM 测试环境），`test/unit/web/` 里「高亮出颜色」的断言只能压在**上下文行**上。其二，它的 `ResizeObserver` 三个方法体都只有一句 `// TODO: Not implemented`，也没有布局引擎，故「`ResizeObserver` → 宽度 signal」这一段归肉眼项，阈值映射与「格式进了 effect 依赖数组」则靠**直接写那个 signal** 断言。

- **`<img src>` 字串不变时 Preact 不改属性、浏览器不重新请求**：SSE 刷新后 `loadDiff` 落进来的是新 payload 对象，两侧 `path` / `side` 一字不变——`v=` 不随内容变时右图停在旧的那张，控制台一条都不报。第一版把 `v=` 做成 `useMemo(() => Date.now(), [payload])`，图确实换了，代价是每一次无关文件的 SSE（`refresh()` 对活动 tab 无条件重取）都重挂两张图、重下最多 10MB 外加一次 `cat-file blob`，且依赖「`getJson` 永远给新对象、缓存永不去重」这条没写下来的契约。现在 `v=` 是后端给的内容身份（`ImageSide.version`）。
- **图片视图的棋盘复用 `--color-diff-diagonal-fill`**：那个 token 本就是「叠在编辑器底色上、明暗两档都成立」的 6% 半透明，`repeating-conic-gradient` 两格交替即成棋盘，不为它新开颜色（`@theme` 里没人引用的 token 会被裁，多开一个就多一处要被 `check:css` 看着的地方）。

- **界面图标统一到 Lucide，装包由构建期 tree-shake，不再手抄 path**：原先 6 枚抄自 Octicons 与 Heroicons 两套、两种版式（16 + `fill` / 24 + `stroke`），同一界面两种质感并存。「复制 path 而不装包」那条理由在 Lucide 下不成立：它的 `git-branch` / `sun` / `monitor` 都不是单条 path，手抄就是手抄一段 JSX 子树。**体积实测反而持平**：`lucide-preact@1.41.0`（ISC，零运行时依赖，`sideEffects: false`）tree-shake 后 6 枚连同 `createLucideIcon` 合计 **+1.4 KB 明文 / +0.5 KB gzip**，与原先六条 path 的 1,335 B 基本持平，CSS 一字未增。顺带让状态条与 `Changes` tab 的分支图标从「共用一条 path 字符串」变成「import 同一个具名组件」，拼错即编译错误。

- **logo 是画出来看过才定的，不是推出来的**（headless Chrome 渲 16 / 24 / 32 / 64 / 160 px，亮暗并列）：带外框的「标签页」系列在小尺寸下读成墓碑、手柄或急救箱；最终换成无外框的「三条 hunk」，语义直接由红绿给，16px 下三条色块比 2 单位描边稳得多。颜色试了六套：直接读 `--color-git-deleted` / `--color-git-added` 亮档偏泥、暗档偏粉（那两个 token 是给文字调的），定的是**一套固定色明暗不切**（`#e5484d` / `#30a46c`），只让上下文那条跟 `currentColor`。favicon 的两条 data URI 合计约 1 KB，不在体积门禁的匹配范围内。**字标一并退役**：界面只用符号，README 与 npm 页面本就是文字，社交预览的名字由 Chrome 用系统字体渲进 PNG。

## 被排除的做法

| 做法 | 排除原因 |
|---|---|
| 不引入前端框架与构建链路（纯 HTML + 原生 JS + CSS） | 三个支点全部不成立：**「加快启动」**——构建只发生在发布期，用户拿到的是构建产物；**「减小体积」是反的**——无构建链路时只能整包引入 diff2html 的预构建 bundle（slim 包 302 KB 含大量用不到的 hljs 语言定义）；**「状态复杂度低」低估了一处**——SSE 刷新要在不丢失当前选中文件与滚动位置的前提下更新列表，而单次变更 300+ 文件是常态，整树 `innerHTML` 重建会闪烁并跳滚动，不重建则要手写一份按 path 的 keyed reconcile |
| 用 React 19 或 Svelte 5 代替 Preact | React 19 的 ~42 KB gzip 对一个只读三区块界面是明显溢价（Preact 约 4 KB）；Svelte（编译后约 2–5 KB）的劣势在工具链而非体积（Biome 2.x 对 `.svelte` 仅覆盖 `<script>` 块），与「一个二进制一份配置」的取向冲突 |
| 用任何 diff2html 预构建 UI bundle（`-ui` 1.05 MB / `-ui-slim` 302 KB / `-ui-base` 90 KB） | 三者的存在理由是「无构建环境下只能整包引入」，引入构建链路后已消失。**被排除的是三个预构建 bundle，不是 UI 层源码**——深导入 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 是允许且推荐的 |
| 自行重写 diff2html 的高亮切分逻辑 | 需要把整文件高亮结果按 diff 行边界切回并补齐跨行未闭合标签；既然允许深导入源码模块，自研等于维护一份更易出错的等价物 |
| 自研一份带回声抑制的两侧联动，替掉 `synchronisedScroll` | 换回来的只有「两侧滚动上限不等时边界处那一次顿挫」，而代价是一段自研的滚动同步代码（要拿「这一侧已经停在它自己够得着的位置」把回声认出来）、一条决策记录，以及一个只有在 happy-dom 里手工模拟 clamp 才跑得起来的单测 |
| 单独 import `highlight.js/lib/languages/{jsx,tsx,toml}` | 这三个模块不存在（实测 404），它们是 `javascript` / `typescript` / `ini` 的**别名**，注册主模块时自动生效；写了会在构建期 resolve 失败 |
| 为 `.vue` / `.env` 引第三方语言包（highlightjs-vue 之类）或新增模块 | 上游 highlight.js **没有** vue / svelte / env 模块，第三方包意味着一份不受 hljs 版本约束的额外依赖；而实测把它们映射到已注册的模块已经够用——SFC 的模板段按 `xml` 上色，`<script>` / `<style>` 那两段由逐行判定器换成 javascript / css（**不是**靠 xml 的子语言：那要整块正文一次高亮才成立，diff 视图是逐行的，见 [`design/diff-render.md`](../design/diff-render.md) 的「单文件组件的区块高亮」），`.env` 走 `ini` 后 `KEY` 是 `hljs-attr`、`#` 是注释。补一张映射表的体积是 0，而语言清单是 JS 预算的主导项 |
| 右侧标题栏用滚动容器内的 `sticky top-0` 钉住 | 要靠 `z-10` 与实心底色去躲 diff2html 那列 `position:absolute` 的行号（宿主 div 的 `relative` 是它们的包含块，两者都排在横杠之后）；文件视图那侧还得靠外层 `w-max min-w-full` 与一个 `sticky left-0` 的 span 才铺得满、留得住，`px-4` 与 `left-4` 两个数字从此绑死。把横杠排到滚动容器之外，这几处一起消失——越界的盒子被容器的 `overflow` 裁掉，够不着它 |
| 明暗开关只做「亮 / 暗」两档 | 点过一次就再也回不到「跟随系统」，而跟随系统恰恰是加开关之前唯一的行为——不该被一次点击永久换掉。三档的代价只是循环里多一格 |
| diff 版式的手动开关做成三档循环（自动 → 并排 → 逐行），照主题开关 | 主题选三档的理由是「两档点过一次就**永远**回不到跟随系统」，而那是因为它落盘；版式 override 不进 `localStorage`，刷新即回自动，那条理由不成立。三档的代价则是每次多点一下、按钮还得画出「自动」这一档的当前态 |
| diff 版式的手动选择进 `localStorage` | 与列表版式、左栏宽度同一结论：端口随机，跨不了实例，记了也存不住 |
| 文件内容构造成「全新增 diff」交给 diff2html 渲染 | 省下一个渲染路径，代价是每一行前面都挂着 `+`、整片底色是新增绿——读起来像在审一份补丁而不是读一个文件，而「看项目整体面貌」正是要摆脱补丁视角 |
| 目录树某一层出错就画那句话（不看手上有没有缓存） | 刷新途中失败是常态（后端重启、dev 代理抖一下），而 `loadDir` 失败只写 `treeErrors`、不动 `treeCache`。先看错误的写法会让一个已经画出来的目录连同它底下展开的一切被一行红字换掉——陈旧的内容比消失的内容有用得多，且下一拍就会被换新 |
| 目录树的「滚进视野」写成 `Row` 里的 `useEffect([selected])` | 要在组件体里读选中态，等于这一行订阅了 `activeEditorPath`——换一次活动 tab 整棵展开的树重渲染，正是 `rowClass` 包成 computed 刻意避开的事。改成每行一份 signal effect：只做一次相等比较，不引起渲染 |
| 树上的「滚进视野」另设一个「待滚动」信号，由 `revealPath` 登记、行滚完清掉 | 一份只为一个组件存在的状态层信号、一条「消费后必须清」的不变量、一个「没人消费就留到下次覆盖」的边角，外加每个用例的 `beforeEach` 多一行重置。换来的只有「收起再展开含选中文件的目录时不再滚一次」，而 `nearest` 让那一下在已经看得见时是零像素。行直接按 `activeEditorPath` 判，与编辑器 tab 同一条 |
| 后台 tab 用一个 stale 标记记「SSE 后没重取」，激活时按标记决定取不取 | 多一份要在收编、改名、关闭各处维护的状态，而它省下的只是「切过去时内容没变也发一趟」那一次请求。`activateEditor` 每次都真的去取，与目录树的 `loadDir` 同一取向 |
| 关掉活动 tab 后按最近使用顺序（MRU）选下一个 | 要多维护一份访问序列，换来的只是关掉一个刚从别处切过来的 tab 时少切一次。右邻居优先、否则左邻居，一眼能预期 |
| 编辑器 tab 上常显整段目录（上一版的做法） | 每个 tab 都宽出一截，而栏里多数时候没有同名文件、目录什么也没区分；VS Code 的默认 `labelFormat` 也只在撞名时才补 |
| 撞名时画整段目录 | 能区分的那段常在中间（`packages/foo/src` 与 `packages/bar/src`），而目录排在名字后面、`max-w-64` 从右端裁，两个 tab 裁完还是一个样 |
| 撞名时照搬 VS Code `labels.ts` 的 `shorten` | 找的是最短的唯一**连续**段，结果是 `…/foo/…` 这种两头都省的形式，读的人得自己补出它在路径里的位置；移植下来约 80 行。取尾段的公式一行能说清，产出的总是一段完整的路径后缀 |
| commit tab 的名字也按工作区状态染色 | 那份补丁是历史，工作区的 `M` 说的是另一份内容；同一个文件在两次提交里的 tab 会被染成同一个颜色，而它们与工作区的关系各不相同 |
| 编辑器标签栏用 `overflow-x-hidden` 去掉滚动条 | `scrollIntoView` 照样能把活动 tab 滚进来，但用户自己滚不了——溢出之后前面的 tab 只能靠关掉后面的才够得着。`scrollbar-width: none` 只是不画滚动条，滚动能力一样不少 |
| 编辑器标签栏的分隔线写成外层的 `border-b`、tab 留 `-mb-px` | 外层如今为了右端的动作区本就存在，但 tab 住在 tablist 这个滚动容器里，压出去的那 1px 照样被它裁掉。外层画一条 inset 阴影当分隔线，tab 的 `border-b` 落在它最后 1px 上盖过它（`divider-b`） |
| `Copy file contents` 浮在全文正文的右上角（GitHub 代码块那种） | 正文那层是双向滚动容器、内容 `w-max`，浮层要在两个轴上都 sticky 才留得住，且会盖住长行末尾的代码。标签栏本就在滚动区之外，右端放动作照 VS Code editor title 的 actions |
| 分隔线写成内联的 `shadow-[inset_0_-1px_var(--color-panel-border)]` | Tailwind 的 `shadow-*` 会把整套 shadow / ring 变量机制拖进产物：实测 CSS +2.2 KB（14 条 `@property` 注册、`@layer properties` 兜底块翻倍、五段式 `box-shadow` 里四段是 `0 0 #0000` 空转），为一条 1px 分隔线付整套机制；一条 `@utility divider-b { box-shadow: … }` 是 200 字节，测试也能钉一个名字而不是一段任意值的拼写 |
| `Copy path` 放右键上下文菜单（VS Code 的 `Copy Path` 住在那里） | 仓库里没有任何菜单先例，为一项功能起整套定位、Escape、点外关闭、键盘导航；一项的菜单打开后还得再点一次。行内动作的机制上一版已为 `Open file` 铺好，第二枚只是往里再站一个，键盘可达性也一并继承（触屏靠 `pointer-coarse:flex` 常驻显示，见 [`../design/web.md`](../design/web.md)） |
| `Copy path` 复制绝对路径，或两种路径各一枚（照 VS Code 的 Copy Path / Copy Relative Path） | 贴给 agent 与 `git` 子命令要的都是仓库相对路径，而它就是页面上现成的 `path`；绝对路径要给 `RepoState` 加 `root`（协议、冒烟断言各补一处）。再多一枚按钮时悬停要退 60px，320px 侧栏里近两成 |
| `Copy path` 点后弹一条 toast 说「Copied」 | 320px 侧栏里没有地方放，且反馈该出现在手指底下：图标换 `Check`、label 换 `Copied` 1.5s，照 GitHub 代码块上那枚复制按钮。写失败（`writeText` reject）静默不换——服务绑定 `127.0.0.1`，loopback 是 secure context，失败只剩用户拒了权限这一种 |
| 行内动作外壳一律锚在状态位左侧，没有记号的行在行按钮里补一个状态位宽的空槽（上一版的做法） | 换来的是有记号与无记号的行按钮在同一列，但 `Files` 档里多数文件、两棵树的目录行、提交行都没有记号，按钮右边常年空着 26px，看着像没右对齐。改成无记号的行贴右内边距，错开的那一列只在有记号与无记号的行相邻时才看得出 |
| 行内动作静止淡一档做成 `IconButton` 的一个 `muted` 档，或在它上面开放 `class` | 「与旁边的状态字母同档」是 `TreeRow` 那个动作槽位的不变量——凡站进来的都得如此、站在别处的都不该如此；写成按钮的 prop 时第三枚动作忘传不报错，只是比邻居重一档，共享组件也从「构造上相等」退成「有一个开关」。画在外壳上按子选择器变体逐枚生效（`[&>*:hover]` 恢复的是悬停的那一枚），`IconButton` 一个字不改。另造一枚更淡的颜色 token 同样排除：一个固定的淡色要在静止 / 悬停 / 选中三种底上各自核对对比度、深浅再翻一倍，`opacity-75` 一个值三种底都跟着 |
| 图片视图做缩放、滑块、洋葱皮、像素 diff | 首版只回答「改成了什么样」，新旧并排已够；那几样各要一段交互状态，而它们对「瞥一眼」没有增量 |
| 右侧空态照 VS Code 在快捷键列表上方画一枚大号 logo 水印（单色、压进底色的 letterpress） | 做出来看过，在这个面板里显得突兀：VS Code 的水印是填满整片编辑区的品牌符号，而 difftab 的符号是三条横条，放大到 256px 读起来像一块加载中的骨架屏，不像一枚标识。快捷键列表单独成立，不靠它撑 |
| 图片 tab 做成第三种 `EditorKind` | tab 的身份是「视图种类 + 路径」，图片不是新的视图种类，只是 diff / 全文两种视图的正文换成了图；加一种要连累 `EditorTabs` 图标、`cacheOf`、`refresh` 三处 |
| 让主题偏好跨实例存活（固定端口 / 偏好搬到后端按用户存 / `sessionUrl` 带一段 hash 让页面去读父 origin） | 三条各有代价：固定端口与「随机端口 + token」的安全取向相抵，且单实例注册表按仓库区分的正是端口；后端存要多一个写端点，而它此刻零写操作；第三条不存在这种机制。**先记着不动**，代价是主题的「跨会话」只到同一实例的刷新为止 |
| 监听 `storage` 事件做多标签页同步 | difftab 一个仓库只跑一个实例、正常只有一个标签页，为此接一条跨标签通道是给一个不存在的场景付代价 |
| logo 带字标（几何拼字，或 SVG `<text>`、Google Fonts、转曲入库） | 界面只用符号，README 与 npm 页面本就是文字，字标唯一的读者是 README 头图——为它养几十行几何不值。用字体的几条各自也不成立：`<text>` 在 GitHub 的 `<img>` 沙箱里拿不到网页字体，各端各画各的；转曲要一份字体工具链，而仓库连 devDependencies 里都没有；Google Fonts 是外链。于是 `assets/mark.svg` 里一个字都没有；社交预览的 `<text>` 只在 Chrome 截成的 PNG 里定型，不受那条沙箱限制 |
| README 头图用 `<picture>` 配亮暗两份 SVG | 同一组坐标要养两份文件，只为让 GitHub 的手动主题也能命中；单文件内嵌 `prefers-color-scheme` 已覆盖跟随系统的多数人，npm 包页面也照常认 |
| 统一到 Heroicons v2 或 Codicons | **Heroicons 整套没有任何 git 图标**（就 Iconify 的 316 枚清单逐条核对），而分支图标是这个产品最核心的语义——统一到它等于把唯一一枚不可替代的图标永久留在混用状态。Codicons 是 VS Code 自家那套、视觉取向最贴，但**没有 sun / moon / desktop**（651 枚里只有一枚 `color-mode`），三档主题开关画不出来；它还是 CC BY 4.0 而非 MIT / ISC，是本仓库唯一一处要求署名的依赖。Tabler（6184 枚，MIT）全覆盖、也够格，落选只因 Lucide 的线性观感更接近 VS Code，两者差别不构成理由 |
| 前端 CSS 只卡明文一道 | 只卡明文时，功能 PR 的正常累积会把余量吃到贴边（2026-10-08 实测明文 38.6 KB 对 40 KB 上限，只剩 1.4 KB），此后加一个工具类都要先争余量，挡住的是正常改动而不是缺陷。现与 JS 同形卡明文 + gzip 两道（上限以 `scripts/size.mjs` 为准）。**后端不压缩响应，明文才是浏览器实收的字节**，主力是明文那道，寻常的规则累积总是它先响（改后实测 39,559 / 7,649 B 时，明文那道只容 24% 的增长、gzip 那道容 34%）。gzip 那道补的是**压不动的内容**：内联进 CSS 的 base64 图片或字体压缩率远低于规则文本，同样的明文增量在 gzip 下涨得更多，会在明文那道响之前先响 |
| Quick Open 的模糊匹配引第三方库（fzf、fuse.js 之类） | 要的只是「子序列 + basename / 连续 / 段首加分」几十行，第三方库带进来的是一整套可配权重与体积，而 `size` 门禁卡的是总量。VS Code 自己的 `fuzzyScorer` 也是这一路的打分 |
| 全仓搜索的命中行打开 diff 而不是全文 | 搜的是工作区此刻的全文，命中那一行多半根本不在任何 hunk 里；且没改动过的文件没有 diff 可开 |
| 跳到行时把 hljs 输出按行切开、给每行一个元素 | 那正是被禁止的「重写高亮切分逻辑」（hljs 的 span 会跨行）。行高固定（`leading-5`），按行号乘行高就能定位，高亮带是一个绝对定位的兄弟元素 |
| Quick Open 与 Search 不设快捷键，只给按钮 | `⌘P` / `⌘⇧F` 是每个 VS Code 用户的肌肉记忆，「瞥一眼」的工具里找个文件还要去点按钮是倒退。`⌘P` 拦下的是浏览器打印，这个页面没有要打印的东西 |
