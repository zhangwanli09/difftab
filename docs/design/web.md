# 前端：组件、diff 渲染与样式层叠

> **TypeScript + Preact + @preact/signals，经 Vite 构建为静态产物**，由后端直接托管。选型与被排除的做法见 [`../decisions.md`](../decisions.md)，门禁见 [`../gates.md`](../gates.md)。

## 界面文案与术语

**界面文案一律英文，`<html lang>` 为 `en`。** 判据是**产品表面与文档分属两个读者**：`docs/` 与代码注释写给维护者，中文；而分发形态是 npm 全局包，CLI 的 `--help`、退出提示、版本守卫报错本来就是英文，界面是同一个表面上唯一说中文的部分。中文读者由 `README.zh-CN.md` 承接。首版不做语言切换。

- 术语跟 git 自己的用词走（`Staged` / `Unstaged` / `Untracked` / `Conflicted` / `Detached HEAD` / `Rebasing`），不自造同义词——用户是拿它对照 `git status` 看的。
- **判据是「`dist/web/` 三个产物里的 CJK 字符数为 0」**，不是逐个文件翻源码：漏网的最可能形态是**不长在 JSX 上的那几条**（`state/store.ts` 的错误文案就这么漏过一次），而按文件翻依赖「想不想得起来」。前端产物里本来就不该有中文——注释在构建期已去掉，diff2html / hljs 也不带。
- **后端产物用不了这个判据**：`dist/server/main.js` 不压缩不混淆，中文注释原样留着正是为了可审计。那一侧的用户可见文案是 `sendError` 与各 `*Error` 的字面量，归 `test/unit/server/`。
- 改文案要同步改 `test/unit/web/` 里的可见文本断言。这一条**会报错**，不进红线。

## 变更列表

**一行的构成是「状态位 → 文件名 → 目录」。** 目录跟在文件名之后、小一号、次要色、**不带尾部斜杠**——它是独立的一段而不是与文件名连读的路径前缀。判据是**侧栏宽度固定 320px 而 `truncate` 从右边裁**：路径在前时先被裁掉的恰恰是文件名，而文件名才是用来认出这一行的东西。故空间不足时**先牺牲目录、保住文件名**（排法参照 VS Code 的 Source Control 面板）。

- **两段必须同住一个 `truncate` span**（名在前、目录作为它的行内子元素）。拆成两个平级 flex 子项**两件事一起坏、且都不报错**：
  - `overflow:hidden` 让每段各自成为 scroll container，基线改按**边框盒**合成而不再露出文字基线，`items-baseline` 于是把两段按底边对齐，字号不同时看着就是没对齐；
  - 谁先被裁只能靠 flex-basis 去调，而给目录 `flex-1` 会把它后面那段重命名标注推到侧栏最右、与它注解的文件名断开。

  同住一个 span 时两件都不必处理：两段共用一个行盒（基线是真的），而省略号在右端**天然**先吃掉排在后面的目录。（`min-w-0` 不在此列——截断盒无论一个还是两个都得给。）
- **这条规则钉的是树的形状，不是版式，所以它有断言**：`change-list.test.tsx` 的「同住一个 truncate span」一条查目录段所在的截断盒是否同时装着文件名，拆成兄弟即红。happy-dom 判不了的只剩「谁先被裁」那半条，归人工。
- 目录被裁是设计中的常态，故**整行挂 `title={file.path}`** 补一份完整路径；不挂在目录那个 span 上——它被裁到零宽时就没得可悬停了。
- **不做文件类型图标**：要么引一套 SVG 资源去顶产物体积门禁，要么自己维护一张扩展名→颜色表，而换来的只是观感。状态位仍留在**行首**——那一列定宽对齐，扫一眼比右侧对齐快，冲突行的 XY 两位也照旧印在那里。

## 页面标题

**浏览器标签页标题是 `<仓库名> · difftab`。** 仓库名取自 `RepoState.repoName`，即工作区根目录名——linked worktree 下那是该 worktree 的目录名，正好把同一仓库的多个工作区分开。

- **仓库名排在产品名之前**：判据是标签被压窄时从**尾部**截断，产品名在前时一排标签压窄后长得一模一样，而分辨「这个标签属于哪个项目」正是它存在的理由。
- 取不到仓库名时（第一份 state 还没到、或 `repoName` 是空串）退回纯 `difftab`，不画占位符——两秒内说一句假话比少一段更糟。
- **仓库名是用户数据，不是界面文案**，因此不受「一律英文」的约束：中文目录名会原样出现在标题里。这与 CJK 门禁不冲突——它查的是产物文件的字面量，而仓库名是运行时才有的值，一个字节都不落在产物里。
- 接线在 `web/state/title.ts`：一个 signals `effect` 把 `repoState` 接到 `document.title` 上，**标题格式与接线同住一处**。不放进组件：标题不是组件树的产出，挂在 `App` 的 `useEffect` 上等于让一个 document 级副作用跟着某个组件的生命周期走。`index.html` 里的 `<title>difftab</title>` 保留为 JS 跑起来之前的兜底。

## diff 渲染

[diff2html](https://github.com/rtfpessoa/diff2html) 直接解析 `git diff` 的 unified diff 文本渲染为带高亮的 HTML，配合 [highlight.js](https://highlightjs.org/) 做语法高亮。所有资源随包本地分发，**不走 CDN**——工具必须离线可用。

**按需 import + 显式注册 hljs 语言子集，不使用任何 diff2html 预构建 UI bundle**（`diff2html-ui.min.js` / `-slim` / `-base` 三个都不用）。

- `import { html } from 'diff2html'`——只引入 unified diff parser 与 renderer，其余由 tree-shaking 移除。
- **`html()` 不做语法高亮**。高亮位于 `Diff2HtmlUI.highlightCode()`，它依赖 `highlight.js-helpers` 的 `closeTags` / `nodeStream` / `mergeStreams` / `getLanguage`——先把整个文件的代码合起来交给 hljs，再按 diff 的行边界切回、补齐跨行未闭合的标签。**被排除的是三个预构建 bundle，不是 UI 层的源码**：深导入 ESM 模块 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 参与 tree-shaking、hljs 实例由我们注入，是允许且推荐的。自行重写这段切分逻辑不在本项目要解决的问题之列。
- `draw()` 内部是 `innerHTML` 赋值 + 命令式绑定事件，**必须放在 Preact 的 ref/effect 之后**，不与 vdom 争夺同一棵子树（列表由 Preact 管，单文件 diff 容器由 `Diff2HtmlUI` 管）。
- 用不到的开关一律关掉：`synchronisedScroll` / `fileListToggle` / `fileContentToggle` / `stickyFileHeaders` 全部 `false`，只留 `highlight: true`。
- **`highlight: true` 时 `draw()` 内部已经调过 `highlightCode()`，不要在 `draw()` 后再手工调一次**。第二次调用读到的 `textContent` 仍是纯文本，但 `nodeStream(line)` 拿到的已是第一遍插入的 `hljs-*` span，`mergeStreams` 会把两份流交织进同一行——结果是嵌套重复的 span，且高亮开销白付一倍。二选一：要么只 `draw()`，要么 `highlight: false` + 手工调。
- **`colorScheme` 传 `'light'`，不传 `'auto'`**——深浅切换由我们覆写的 `--d2h-*` 承担，见下方「深色」。

### 文件头整条不显示

diff2html **没有**关掉自带文件头（`.d2h-file-header`）的配置项（上面那四个开关管的是同步滚动、文件列表折叠与吸顶，头照画），这件事只能落在样式那侧的一条 `display: none`。

- 头里**只有四样：文件图标、文件名、`CHANGED` / `RENAMED` 之类的标签、一个「Viewed」折叠复选框**。前两样与 `DiffView` 自己那行标题重复，第三样里唯一有信息量的重命名已由 `RenameNotice` 说得更全（带完整旧路径与相似度），第四样在 `fileContentToggle: false` 下是死的——**四样合起来，藏掉它页面上不掉任何信息**。
- **`+N` / `-M` 那对增删统计不在这条头里**：它属于文件列表模板（`d2h-file-list-line` 里的 `.d2h-file-stats`），而我们传 `drawFileList: false`，那份列表从来没画过。特意写下这条是因为它太容易被想当然（GitHub 的文件头上就有那对数字）——藏掉文件头**不等于**放弃了统计，difftab 至今就没在页面上给过增删行数。

### 版式按面板宽度自动切

面板宽度 < 1024px 给 `line-by-line`，否则 `side-by-side`。**1024 是算出来的，与 Tailwind 的 `lg` 数值相同纯属巧合**（那是视口断点，这里是面板宽度）：diff2html 的表是 13px Menlo，并排每侧留 `9em` 行号槽、逐行留 `8em`，于是面板 1024 时并排每侧只剩约 395px（约 50 个等宽字符）而逐行有 920px（约 118 个），50 列正是多数源码行开始要横向滚的地方。以下几条都属「违反后不报错」：

- **判据是 diff 面板自身的宽度，不是视口宽度**。侧栏固定 `w-80`（320px）且 `shrink-0`，面板宽度恒等于「视口 − 320」；按视口判等于把这个常数在两处各写一遍，而侧栏宽度将来一改，阈值就静默错位到别的地方去了。
- **量的是 border box，不是 content box**——观察与读值两处都显式写死：`observe(el, { box: 'border-box' })` + `entry.borderBoxSize[0].inlineSize`。面板自己是 `overflow-auto` 的滚动容器：换格式会改变内容高度 → 竖直滚动条出现/消失 → content box 宽度抖十几个像素，阈值附近于是在两种格式之间来回重画。**滚动条是从 content box 里扣的**（它占掉 padding box 内的空间，border box 照样把它圈在里面），border box 宽度因此不随它进出而变。**观察 box 也必须是 border box，不能只在读值那侧挑**：默认的 content-box 观察会在滚动条进出时各推一次回调，靠下游去重虽然挡得住，挡的却是已经产生的噪声。
- **量法与阈值同住 `state/layout.ts` 的 `observeDiffPanel()`**，`App.tsx` 只管「量哪个元素、什么时候开始和停」：阈值的正确性全靠「送进来的是 border box」，而这件事没有任何门禁强制得了（happy-dom 没有布局引擎），拆到两个文件里就等于让其中一半失去说明。
- 格式本身是个 `computed`，靠 signals 的 `Object.is` 去重——拖窗口每像素写一次宽度，只有**真跨过阈值**那一次会通知下游。**去重封的是「每像素一次」而不是「每次跨越一次」**：贴着阈值来回蹭，每跨一次仍是一次完整的 `draw()`。不为此加迟滞或 debounce 是有意的——同一次 `draw()` 的代价 SSE 刷新每个事件都要付一遍，而贴着边界反复拖是转瞬即逝的动作，换来的却是一份「上一次是哪种版式」的反馈状态，把纯派生量变成第二份状态。
- **格式必须进 `DiffView` 那个 effect 的依赖数组**。`draw()` 是命令式的，格式变了不重跑就永远停在旧格式上——**不报错，只是拖窗口没反应**。
- **两种格式共用同一套 `--d2h-*` 覆写**，无需分叉：那对 `--d2h-change-*` 与 `--d2h-empty-placeholder-*` 只被并排视图的选择器读到，逐行视图下是失效而不是漏映射。
- 首版**不做手动切换开关**，与不做页面内明暗开关同一取向。

### hljs 语言清单

`import hljs from 'highlight.js/lib/core'`，再**逐个显式注册**。清单为 **22 个真实语言模块**：`javascript` / `typescript` / `json` / `css` / `scss` / `xml` / `markdown` / `python` / `go` / `rust` / `java` / `kotlin` / `swift` / `c` / `cpp` / `csharp` / `bash` / `yaml` / `ini` / `sql` / `php` / `ruby`。注册清单是白名单，增删语言即增删体积，这正是放弃预构建包换来的可控性。

- **别名不是模块，不得单独 import**——`jsx` / `mjs` / `cjs` 属 `javascript`，`tsx` / `ts` 属 `typescript`，`toml` 属 **`ini`**，`html` 属 `xml`；`registerLanguage` 注册主模块时别名一并生效。`highlight.js/lib/languages/{jsx,tsx,toml}` 三个路径实际不存在，写了会在构建期 resolve 失败。
- **`plaintext` 必须与这 22 个一起注册，它是兜底而非语言。** 「未命中的语言退化为 plaintext」不是自动发生的：`highlightCode()` 里 `hljs.getLanguage(x) === undefined` 时把语言改写为字面量 `'plaintext'`，`getLanguage()` 对无扩展名/未知扩展名也直接返回 `'plaintext'`，随后无条件调用 `hljs.highlight(text, { language: 'plaintext' })`。而 `lib/core` **不自带** plaintext，漏注册时这一步抛 `Unknown language: "plaintext"`，异常从 `highlightCode()` 冒到调用方，**整个 diff 视图渲染失败**——不是那一个文件退化。触发条件极普通：diff 里出现 `LICENSE` / `Dockerfile` / `notes.txt` / `.lua` 即可。模块本身 318 B，对体积无影响。
- diff2html 的两个传递依赖（`diff`、`@profoundlogic/hogan`）由打包器一并处理。注意 `@profoundlogic/hogan` 只有 CJS 入口（无 `module` / `exports` 字段），需打包器的 CJS 互操作，不影响可行性但也别指望它被 tree-shake。

### 产物体积门禁

门禁值为预算而非承诺。**主导项是语言清单**：22 个语言模块的 ESM 明文合计 225.6 KB，压缩后约 130 KB / gzip 约 40 KB，占了预算的大头。因此后续若要压体积，第一刀砍语言清单而不是别处；若要加语言，先看这张表还剩多少。

| 产物 | 门禁 | 当前实测 |
|---|---|---|
| 前端 JS（明文） | ≤ 350 KB | 203.4 KB |
| 前端 JS（gzip） | ≤ 120 KB | 67.8 KB |
| 前端 CSS（明文，含 `diff2html.min.css` 17 KB + hljs 双主题 2.6 KB + Tailwind 产物） | ≤ 40 KB | 29.3 KB |

对照基线：diff2html slim 预构建包单文件即 302 KB（min）。**CSS 是余量最紧的一行，且它对「多写几个工具类」最敏感**——加 token 时留意。

## 样式：Tailwind v4 + 层叠隔离

**Tailwind v4（CSS-first，`@tailwindcss/vite`）。** 设计 token 写进 `@theme` 块，命名与数值参照 VS Code 颜色 token（如 `editor.background`），复刻 Dark+/Light+ 主题观感，轻量优先于视觉还原度。

引入完整 preflight——它就是跨浏览器归一化那一层，不引则要自己手写一份等价物。与 diff2html 的冲突面实测下来几乎为零：表格合并、行号列盒模型、边框等关键声明 diff2html 均自带，且类选择器特异性稳压 preflight 的通配重置。

在此之上再用**层叠层**做结构性隔离——**无层（unlayered）样式在层叠中永远胜过有层样式，与特异性无关**，而 Tailwind v4 把 preflight 放在 `@layer base`：

```css
/* src/web/app.css */
@import "tailwindcss";                              /* preflight → @layer base；utilities → @layer utilities */
@import "highlight.js/styles/github.css";           /* unlayered，且必须排在 d2h 之前 */
@import "highlight.js/styles/github-dark.css" (prefers-color-scheme: dark);
@import "diff2html/bundles/css/diff2html.min.css";  /* unlayered → 结构上不可能被 preflight 压过 */
@import "./vscode-theme.css";                       /* unlayered，覆写 --d2h-* 与 VS Code token */
```

- **hljs 主题 CSS 必须排在 `diff2html.min.css` 之前**（diff2html 官方 README 的要求），否则配色被覆盖。`diff2html.min.css` 里**没有任何 hljs 配色规则**，只引 hljs 运行时与语言定义不会出颜色。
- **深色主题的 `@import` 必须带媒体条件**：两份 hljs 主题都是无条件的 `.hljs { … }` 规则、自身不含任何 `@media`，平铺引入的结果是 `github-dark` 无条件覆盖 `github`、浅色主题直接失效。媒体条件不引入层叠层，unlayered 保障不受影响。
- **hljs 主题与 `diff2html.min.css` 不得放进任何 `@layer`**，一旦放进去就把这层保障拆掉了。
- **diff2html 渲染出的内部元素只能通过覆写 `--d2h-*` 改配色，不得用 Tailwind 工具类去压**——无层的 diff2html CSS 同样会胜过 `@layer utilities`，写了也不生效。
- **首版不做页面内的明暗手动开关**：那需要为 hljs 主题 CSS 在构建期加作用域前缀，与「轻量优先」的取向不符。深浅统一由 `prefers-color-scheme` 切换。

### 为什么 `colorScheme` 传 `'light'`

**diff2html 自带的深色方案不用。** 它的深色配色由渲染时挂在容器上的 class 门控：`colorScheme: 'auto'` 输出 `.d2h-auto-color-scheme`，对应规则整块包在 diff2html 自带的那唯一一个 `@media (prefers-color-scheme: dark)` 里，读的是**另一套** `--d2h-dark-*` 变量。

- 传 `'light'` 输出 `.d2h-light-color-scheme`，而这个 class 在 diff2html 的 CSS 里**一条规则都没有**，于是全部配色都落在无前缀的基础规则上，深浅切换完全由我们覆写的同一套 `--d2h-*` 承担。**这不是「只支持浅色」**，恰恰相反——它是深色能按 VS Code 取值出来的前提。
- 传 `'auto'` 的后果是静默的：`.d2h-auto-color-scheme .d2h-xxx` 特异性 (0,2,0) 稳压基础规则 (0,1,0)，深色下读回 `--d2h-dark-*` 里 GitHub 的取值，我们的 VS Code 深色一条都不生效，而页面看上去只是「深色不太像 VS Code」，不像出错。
- 且 auto 块里有一处真实缺口：`.d2h-deleted` 被写成 `.d2h-dark-color-scheme .d2h-deleted` 而非 `.d2h-auto-color-scheme .d2h-deleted`，auto 模式下深色盖不到它。即走它的方案仍要自己补规则，收益为负。
- 换来的好处是**深浅只声明一次**：23 个无前缀 `--d2h-*` 一律写成 `var(--color-…)` 指向 VS Code token，token 自己在 `prefers-color-scheme` 里翻。CSS 变量在**使用时**解析，因此不存在「加了浅色忘了深色」这一半。
- 但**并排视图那对「改动行」不跟着无脑映射**：diff2html 为 `.d2h-del.d2h-change` / `.d2h-ins.d2h-change` 另留了 `--d2h-change-del-color` / `--d2h-change-ins-color`（默认是琥珀与浅绿，与纯增删不同色系），而 **VS Code 的 diff 编辑器没有这一档区分**。故这两个变量**刻意指向与纯增删相同的 token**，主动放弃上游那档琥珀。**这是取舍不是遗漏，注释里必须这么写**：写成「比纯增删淡一档」会让下一个人以为区分还在。

### 覆写生效的两个条件

**unlayered **且** 排在 diff2html 之后，两条缺一不可。** 我们的 `:root` 与 diff2html 自己的 `:host,:root` 特异性同为 (0,1,0)，胜出**纯靠源码顺序**。把 `@import "./vscode-theme.css"` 挪到 `@import "diff2html/…"` 之前，23 条覆写会**整片静默失效**、配色退回 GitHub 那套，而「块是 unlayered」这条断言照样通过。

`check:css` 因此必须**同时**查三件事：声明 `--d2h-*` 的块全部 unlayered；diff2html 那块与我们那块**都存在**（缺哪一侧都说明有一份 CSS 没被打进产物，顺序断言会对着空集合通过）；且后者整个排在前者之后。

- **「哪块是我们的」由 `vscode-theme.css` 里的一条哨兵声明（`--gg-d2h-map`）认定，不按值的形状猜**：按「值里有没有 `var(--color-…)`」区分会给出**误导性红**——深色下给某个 `--d2h-*` 补一条字面量覆写（完全正当）就会被归到 diff2html 那一侧，于是门禁报「检查 `@import` 顺序」而顺序根本没问题。哨兵由我们自己写、自己控制，且它不见了本身就是一条正面断言。
- 顺带把「覆写有没有覆全」也钉住：**diff2html 声明的每一个无前缀 `--d2h-*` 都必须出现在我们那个块里**，删掉半张映射表同样是静默退色。

### `@theme` 变量会被裁掉

**Tailwind v4 会裁掉没被引用的 `@theme` 变量**：被工具类用到、或被我们自己的 CSS 以 `var()` 引用到的都会输出，两者都没有的会被丢掉。「`--d2h-*` 一律指向 VS Code token」因此是安全的——那就是一次 `var()` 引用。但**引用名写错时没有任何报错**：引用侧留下一个无定义的 `var()`，该属性变为 unset，颜色悄悄没了。故 `check:css` 断言：产物中每个不带 fallback 的 `var(--…)` 引用都必须在产物里找得到定义（`--tw-*` 除外，它们由 `@property` 声明）。

**深色那半是 delta，于是「声明侧」也有同一形状的静默失效**：`@media (prefers-color-scheme: dark)` 里只列与浅色不同的 token，名字**写错一个字符不会有任何症状**——上面那条查的是**引用**侧，而一条 `--color-git-modifed: …` 在语法上就是个合法的新自定义属性，连「无定义」都算不上（它反而给 `defined` 集合添了一个成员）。故 `check:css` 再增一条：**产物里凡在深色媒体条件内声明的 `--color-*`，都必须在深色条件之外也有声明**。反向不查——浅色有而深色没有，正是「深浅共用同一取值」的正常写法。

### 三条选择器规则的例外

`vscode-theme.css` 末尾那三条在「只能改 `--d2h-*`」这条约束之外，**且只有这三条**：`.d2h-diff-table { font-family }`、`.d2h-file-header { display: none }` 与 `.d2h-file-wrapper { border: none; margin-bottom: 0 }`。47 个 `--d2h-*` 实测全是颜色，**字体、显不显示、有没有这个盒子、它底下那截留白都没有变量可覆**，而那条约束管的是配色。三条与 diff2html 自己的同名规则特异性同为 (0,1,0)，胜出与那 23 条变量覆写同理——**靠本文件排在 `diff2html.min.css` 之后**（preflight 的 `*{border:0 solid}` 在 `@layer base`，三条都压不过）。

文件头不显示之后，`--d2h-file-header-bg-color` / `--d2h-file-header-border-color` 两条映射**仍要留在映射块里**：`check:css` 的覆盖率断言是从 diff2html 自己那块推导出全部无前缀变量名再逐一比对的，删掉即红——它们不是死代码，是那条断言的一部分。**不为 `display: none` 另加断言**：它失效的症状是文件头又出现在页面上，肉眼可见，不属于门禁要防的那类静默故障。

**补丁外框与它底下那截留白一起去掉。** `.d2h-file-wrapper` 自带 `border: 1px solid var(--d2h-border-color); border-radius: 3px; margin-bottom: 1em`，把整份补丁圈在一个圆角盒里、底下再垫一截留白。文件头藏掉之后这个盒子只剩副作用：上边紧贴 `DiffView` 那行文件名标题的 `border-b`、画出第二条平行线，左边紧贴侧栏的 `border-r`，右边在横向滚动时停在盒子边界上。

- **不写成 `--d2h-border-color: transparent`**，尽管那样看着更守「只能改 `--d2h-*`」那条规矩。三个理由：透明边框**仍占 1px 布局**；那个变量还被 `.d2h-lines-added` / `.d2h-lines-deleted`（长在文件头里）与 `.d2h-file-list > li`（`drawFileList: false`，那份列表从没画过）读到，谁把文件头或文件列表放回来就会连带静默失色；而这里要的是「没有这个盒子」而不是「这个盒子的颜色」，写进配色映射表等于把一个版式决定藏在颜色里。
- **映射块里那条 `--d2h-border-color: var(--color-panel-border)` 因此保持不动**，与上面 `--d2h-file-header-*` 两条同一道理：覆盖率断言少一个即红。
- **`margin-bottom: 1em` 一并去掉**：上游留它是为了在「一次画多个文件」时分隔相邻补丁，而 difftab 一次只画一个（`drawFileList: false` + 单文件容器），于是它只剩滚到底时补丁最后一行与面板底边之间一段没有来由的空白。写 `margin-bottom: 0` 而不是 `margin: 0`——diff2html 只设了这一边，其余三边归 preflight 的 `*{margin:0}`，写成 `margin: 0` 会让人以为另有三边要压。
- **`border-radius: 3px` 仍然不动**：没有边框也没有背景时它不可见，删它只是多一条不产生任何差别的声明。
- **同样不加断言**：失效的症状是框或那截留白又出现在页面上，肉眼可见，不属于门禁要防的那类静默故障。

### 行号列需要一个 positioned 祖先

**diff2html 的行号列是 `position: absolute`，滚动容器内部必须有一个 positioned 祖先。** 这与「两侧各自滚」是同一个决定的两半：diff2html 把行号做成绝对定位、偏移量全 auto，靠的是「包含块 = 初始包含块，而滚的就是整个文档」这个前提；我们为了让 SSE 刷新时留住列表侧的滚动位置，把滚动收进了内层的 `overflow-auto` 容器，那个前提就不再成立——**包含块在滚动容器之外的绝对定位盒不随该容器的内容滚动**，于是一滚代码行就跑了、整列行号原地不动，页面不报任何错。

- 包含块由 `DiffView` 里交给 `Diff2HtmlUI` 的那个宿主 div 上的 `relative` 提供。**滚动容器 `<section>` 自己加 `position: relative` 同样修得好**，选宿主 div 只是因为它是**作用域最小**的那个：与 diff2html 子树同生共死，不给外壳上任何别的绝对定位埋一个意料之外的包含块。
- 它写成 Tailwind 工具类**不违反「只能改 `--d2h-*`」**：那条管的是 diff2html *渲染出来的*元素的配色，而宿主 div 是我们自己的元素，没有任何 d2h 规则命中它。
- `diff-view.test.tsx` 有一条断言钉着这个类名，`check:css` 查产物里那条规则在不在。**两者都只能钉到「类名/规则还在」**——happy-dom 没有排版引擎，滚动与错位在那里不可判定，真布局归人工。
- 两种版式都成立：`.d2h-code-linenumber` 与 `.d2h-code-side-linenumber` 都是 `position:absolute`。
