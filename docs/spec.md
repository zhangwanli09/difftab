# GitGlance — 需求文档

> **产品名**:GitGlance(glance = 一瞥,意指快速看一眼代码变更、分支状态,不做复杂操作)
> **一句话定位**:一眼看懂 AI 编码 Agent 改了哪些代码——CLI 启动、本地网页展示,只读查看当前工作区的 diff 与分支状态,冷启动和资源占用做到最轻。

---

## 1. 背景与目标

开发者使用编程 agent 完成开发任务后,需要快速看一眼代码变更了什么、当前分支状态如何。这个诉求本质是"瞥一眼",不是"审查会话"——只需要在 agent 跑的过程中或跑完之后,随手确认改动内容。**查看当前工作区的 diff 和分支状态是最高频动作**,每次 agent 完成任务后都会用到。

**形态:纯只读,零写操作**。工具在终端敲一条命令启动,自动打开浏览器展示当前仓库的变更,看完关掉标签页即可,进程随后自行退出,不常驻占用资源。

## 2. 目标用户与分发

核心用户:使用 AI coding agent 后,需要快速查看当前代码变更的开发者,跨平台(macOS / Windows / Linux)使用。

分发方式:npm 包,`npm i -g gitglance` 全局安装(推荐)或 `npx gitglance` 直接试用(pnpm 用户为 `pnpm add -g gitglance` / `pnpm dlx gitglance`)。目标用户使用 AI coding agent,机器上必然已有 Node 环境,无需额外提供免运行时的分发形态。

**本仓库自身用 pnpm 开发(见 5.11),这与用户侧的安装方式无关**——包照常发到 npm registry,且 `dependencies` 为空、零传递依赖(见第 8 节),用户用哪个包管理器安装都一样。

## 3. 功能范围

| 功能 | 说明 | 优先级 |
|---|---|---|
| CLI 启动 | 在仓库目录下执行命令,自动识别当前 git 仓库,启动本地服务并打开默认浏览器 | P0 |
| 变更文件列表 | 展示变更文件及状态(修改/新增/删除/重命名),覆盖已暂存、未暂存、未跟踪三类,纯展示。数据源见 5.2 | P0 |
| 查看 Diff | 以 `git diff HEAD` 为基准,diff2html 渲染 + 语法高亮,**按文件懒加载**(见 5.2)。边界情况:未跟踪文件构造为全新增;新增/删除文件按标准 diff 展示(对应一侧为空);重命名识别并标注;二进制文件仅提示"二进制文件已变更";超过 5MB 的文件提示"文件过大,不支持预览"而非加载卡死 | P0 |
| 当前分支状态 | 展示当前所在分支,以及相对远程的 ahead/behind 计数,纯只读展示 | P0 |
| 自动刷新 | 文件系统/仓库状态变化后,通过 SSE 推送前端自动刷新展示内容。核心场景是"agent 还在跑、边改边看",不自动刷新会明显削弱工具价值。监听不可用时降级为轮询并在 UI 标注(见 5.7) | P0 |
| 同仓库单实例 | 启动时检测该仓库路径是否已有实例运行,有则直接打开浏览器指向已有实例,不重复起进程 | P0 |
| 空闲自动退出 | 无任何已连接客户端持续一段时间(建议 30-60 秒)后,本地服务进程自动退出;同时保留 Ctrl+C 手动退出 | P0 |

## 4. 明确不做(Non-goals)

分两类:**长期不做**是产品的架构性承诺,破例等于变成另一个产品;**首版不做**是本版范围收窄,后续是否加入以实际使用中暴露的真实痛点为依据,不提前预设。两类在开发期同为硬约束——"首版不做"不等于"可以先做"。

### 4.1 长期不做

- **任何仓库写操作**——不 stage/unstage、不 commit、不 discard、不 pull/push/sync、不创建/切换分支、不 stash。工具全程只读,不需要用户对"工具会不会动我的仓库"有任何顾虑。这是产品的核心承诺
- **代码编辑功能**——不是编辑器,diff 仅用于查看;放开这条会推翻第 5 节的 diff 渲染选型
- **账号体系、云同步**——工具是纯本地形态,引入后第 5 节的本地安全设计失去意义
- **多用户协作交互**(PR 评审、评论、审批)

### 4.2 首版不做

- 提交历史查看
- 分支列表展示,只展示当前分支(切换属 4.1 写操作范畴)
- 逐行 blame、行内标注等 GitLens 类深度追溯功能

## 5. 技术栈

**Node.js + TypeScript + Vite / Preact + diff2html**

**分工提醒**:5.0 给出模块划分与边界,是读其余小节的地图;5.1–5.10 描述的是**产品运行时**的约束(用户机器上实际执行的东西);5.11 描述的是**开发期工具链**(只在本仓库和发布流水线里存在,不进用户安装的包);5.12 是前后端之间的接口契约。运行时与工具链的边界必须清晰——运行时约束不因引入构建链路而放松。

### 5.0 架构总览:模块、目录与边界

数据流一句话:**CLI 定位仓库并拉起 HTTP server → 浏览器经 HTTP 拿只读数据、经 SSE 收变更通知 → server 把请求转给 git 封装层与文件监听层**。产品代码内不存在其他方向的调用。

**模块级目录结构**(只定"哪类东西放哪个模块",不定文件切分):

```
bin/gitglance.js       版本守卫 + 动态 import(5.1),手写 JS,不参与构建
src/server/
  cli/                 参数解析、仓库定位与前置检查、拉起浏览器、单实例注册表(5.1 / 5.8)
  http/                node:http server、路由、5.9 三道校验、dist/web 静态托管
  git/                 唯一的 git 子进程出口:status / diff / numstat 调用与解析(5.2 / 5.3)
  watch/               三档监听 + debounce + 轮询兜底(5.7)
  shared/              前后端共用的协议类型(5.12)
src/web/
  components/          变更列表、分支状态、diff 容器(5.4)
  diff/                diff2html 深导入 + hljs 语言注册(5.5)
  state/               signals(5.4)
  styles/              app.css / vscode-theme.css(5.6)
test/unit/             Vitest,跑 TS 源码
test/smoke/            纯 JS,跑 dist/ 产物(含只读性两层验证)
test/fixtures/         测试仓库生成脚本(两批,见第 7 节)
scripts/               bench:startup、size 门禁
```

源码目录到构建产物的映射见 5.11 的「产物结构」,此处不复述。

**依赖方向**(单向,可静态断言):`bin → server/cli → server/http → {server/git, server/watch}`。`src/web` 除 `server/shared/` 外**不得 import `src/server` 下任何模块**;`server/git` 与 `server/watch` **不得反向 import `http` / `cli`**。

**边界不变式**——这四条不是风格偏好,每一条都是某道门禁能够成立的前提,违反后**不报错、只是让门禁静默失去覆盖**:

1. **`server/git` 是产品代码中唯一执行 git 子进程的位置**。5.10 主门禁"断言 git 子命令只出现在只读白名单"、以及 5.2 要求的 `-c core.quotePath=false` 统一注入,都依赖这个单点。其他模块即便只调只读命令也算违规——门禁的低成本可断言性正来自"只有一处"
2. **拉起浏览器是唯一的非 git 子进程调用**,位于 `server/cli`,即 5.1 与 5.10 已写明需要显式开口子的那一处。产品代码中出现第三处子进程调用,须先改本节
3. **`server/http` 不直接触碰 git 与文件监听**,只调用 `git` / `watch` 模块导出的函数。这保证 5.9 的三道校验位于唯一入口,不会被某条旁路绕开
4. **前端不内联任何 git 知识**(状态位含义、空树哈希、路径转义规则、重命名判定),一律由 `shared/` 的协议类型承载。否则 5.2 / 5.3 的约束会出现第二份实现,而第二份不受 5.10 门禁覆盖

**本节的修改边界**:只定模块归属与依赖方向,**不定文件切分**——文件级清单会随实施阶段推进立刻过期,而模块边界稳定且正是门禁所依赖的东西。新增或拆分文件不需要改 spec;**改变模块归属、依赖方向,或上述任一不变式,才须先改本节**。

### 5.1 运行时与后端

- **运行时**:Node.js,**最低支持 Node 22.0.0**。选型首要考量是生态成熟度与 Windows 上系统调用(`child_process` 执行 git、`fs.watch` 文件监听)的稳定性——本项目重度依赖这两块。下限取 22 而非更高的 24.14.0,是因为 **`fs.watch` 的 `ignore` 选项(Node 24.14.0 起可用)决定的是自动刷新的最优档位,不是能否运行的门槛**:低于该版本按 5.7 的三档策略降级,行为退化但功能完整。反过来把下限钉在 24.14.0 的代价是实打实的——24.14.0 比 Node 24 转入 LTS 晚了近四个月,锁版本管理器、既有 `node:24` 镜像、发行版快照上大量"自认在 Node 24 LTS"的用户会被 24.0–24.13 挡在门外(版本窗口日期见第 10 节)。Node 22 为 Maintenance LTS、装机量大,值得覆盖;Node 20 已 EOL,不予支持。CI 矩阵覆盖 **22 / 24 / 26** 三个版本 × 三个平台
- **API 上限随下限收紧**:除 5.7 明确分档处理的 `fs.watch` `ignore` 外,不得使用 Node 22 上不存在或不稳定的 API——已知需避开 `fs.glob`(22.0 起为实验性)、不得依赖 `require(esm)`(22.12+ 才有);`util.parseArgs`、`import.meta.dirname`、`node:test` 在 22 上均可用。下限一旦下调,"能跑通"就不再等于"在下限上能跑通",需要有机制防止无意中把下限顶回去。**该机制由 TypeScript 配置直接承担**:`@types/node` 锁 `^22`(**不是** latest 的 26.x)+ `lib`/`target` 取 `ES2023`,用到 Node 24+ 才有的内置 API 或超出 ES2023 的语法时,`tsc --noEmit` 在编译期就直接报错,不必等 CI 的 Node 22 档跑到。CI 的 Node 22.0.x 档仍是最终底线,两者互补(详见 5.11)
- **版本守卫的位置**:CLI 入口须用**保守语法**先完成 `process.versions.node` 检查并友好报错,再动态 `import()` 主模块。若守卫与新语法同处一个模块,低于下限的用户拿到的是解析期 SyntaxError,守卫根本来不及执行(验收见第 6 节)。**落地要求**:`bin/gitglance.js` 必须是手写的保守语法 JS,**不参与 TypeScript 编译、不作为打包入口**——一旦它进了构建管线,就可能被注入新语法或被合并进主模块,守卫在解析期即失效(见第 10 节禁止项)
- **后端实现**:**运行时**仅使用 Node 标准库(`node:http`、`node:child_process`、`node:fs`),不引入 HTTP 框架——路由需求仅几个只读接口,标准库足够。TypeScript 与打包器都是开发期依赖,不进 `dependencies`,也不改变这条约束
- **拉起浏览器**:零运行时依赖的前提下没有现成库可用,只能 `child_process` 按平台调系统命令——macOS `open`、Windows `cmd /c start ""`(空串是必需的窗口标题占位,否则带引号的 URL 会被当作标题吞掉)、Linux `xdg-open`。这是产品代码中**唯一一处非 git 的子进程调用**,5.10 的只读性主门禁需为它显式开一个口子(见 5.10)。调用失败(无 `xdg-open`、headless 环境)只打印 URL 让用户自行访问,不作为启动失败
- **后端产物形态**:`src/server/**.ts` 打包为**单文件 ESM** `dist/server/main.js`,**不压缩、不混淆**。压缩对本地 CLI 场景零收益,而保持可读能让用户自行核查"这工具到底跑了哪些 git 命令",与 4.1 只读承诺的可审计性一致;单文件则减少模块解析次数,对第 6 节的冷启动门禁只有正向作用

### 5.2 git 交互

- shell out 到系统 `git` 命令读取只读信息,全程无写命令。diff 基准取 `git diff HEAD`——agent 执行过程中可能自行 `git add`,`git diff` 会漏掉已暂存的改动,而"相对上次提交改了什么"才是本工具要回答的问题
- **文件列表**:以 `git status --porcelain=v2 --branch -uall -z` 为唯一数据源,一次调用即可同时拿到文件状态、暂存/未暂存双状态位、重命名信息与分支/ahead-behind。两个参数都不能省:
  - `-uall`:否则 git 会把未跟踪目录折叠成一行 `dir/`
  - **`-z`**:否则 git 会对含非 ASCII 字符、空格、引号的路径做 C 风格转义并加引号(已实测,见第 10 节)。加 `-z` 后改为 NUL 分隔、路径原样输出,无需自己反转义。同理,所有取路径的**列表类** git 调用(`ls-files`、`diff --numstat` 等)一律加 `-z`,解析时按 NUL 切分而非换行

- **`-z` 解析的两个陷阱**(不写清楚实现时必然踩中):
  - **重命名记录里 NUL 既是记录分隔符、又是字段分隔符**。`porcelain=v2` 的 `2 ` 记录格式是 `2 <XY> ... R<score> <新路径>\0<旧路径>`,即一条重命名记录会占用**两个** NUL 段。解析器不能无状态地按 NUL 平铺切分,必须在遇到 `2 ` 开头的记录后额外吞掉下一段作为旧路径(已实测确认该格式)
  - **无上游分支时不输出 `# branch.ab` 行**。新建的本地分支尚未设置 upstream 时,`--branch` 只给 `# branch.oid` / `# branch.head`,没有 ahead/behind 行(已实测)。此时分支状态展示为"无上游",不能默认成 0/0,更不能因取不到字段而崩溃

- **所有 `git diff` 调用必须加 `-c core.quotePath=false`**。`-z` 只作用于 `status` / `numstat` 这类机器可读的**列表输出**,**管不到 `git diff` 的补丁正文**——正文里的 `diff --git` / `--- ` / `+++ ` / `rename from|to` 头部行仍会按 C 风格转义(已实测,见第 10 节)。而 diff2html 恰恰是从这些头部行解析文件名的,不处理就会在界面上直接显示 `\351\234\200` 转义串,违反第 6 节验收标准。**两者互补,不可相互替代**:`-z` 解决列表解析的分隔歧义,`core.quotePath=false` 解决补丁正文的展示。实现上直接在 git 封装层对所有调用统一注入该参数,避免遗漏

- **重命名文件的 diff 必须同时传新旧两个路径**。懒加载若按常规只传新路径(`git diff HEAD -- <新路径>`),git 因为只看到一侧、无法配对,会把重命名**退化成一个全新增文件**(已实测,见第 10 节),导致"重命名识别并标注"的需求落空。正确做法是对重命名条目调用 `git diff HEAD -M -- <新路径> <旧路径>`,两个路径都来自上面 `2 ` 记录已经给出的信息,无需额外查询
- **diff 按文件懒加载**:列表只做上述一次 status 调用,diff 在用户点击某个文件时才用 `git diff HEAD -- <path>` 单独取(重命名条目按上一条传两个路径)。**禁止一次性获取或渲染全仓 diff**——agent 单次改 300+ 文件是常态,整仓 diff 会冻结浏览器主线程数秒到数十秒,同时拖垮冷启动指标
- **未跟踪文件**不在任何 `git diff` 输出内,需从 `git status` 取列表后单独构造 diff。**明确采用「直接读取文件内容手工构造 unified diff」方案**(输出 `--- /dev/null` / `+++ b/<path>`,全部行标记为新增),**不使用 `git diff --no-index`**——后者依赖 `/dev/null` 作为对比端,在 Windows 上不可移植。手工构造路径需自行做 NUL 字节探测(判定二进制)+ 5MB 体积阈值 + **行数上限 50,000 行**(超出按 `too-large` 处理;体积阈值挡不住"几十 MB 单行"以外的另一头——超长行数的窄文件体积不大,但逐行构造 diff 与前端渲染同样会卡)
- **二进制与大文件的判定来源**:已跟踪文件一律以 `git diff HEAD --numstat` 的输出为准(二进制文件输出 `-\t-\t<path>`),这是 git 自身含 `.gitattributes` 配置的判定结果,比启发式探测准确;文件体积用 `fs.stat`。只有未跟踪文件才走 NUL 字节探测
- **仓库定位**:统一用 `git rev-parse --show-toplevel` 定位工作区、`git rev-parse --git-dir` 定位 git 目录。**不得假设 `.git` 是目录**——linked worktree 下 `.git` 是一个文件,submodule 同理;bare 仓库(无工作区)给出明确的拒绝提示而非崩溃
- **启动前置检查**:`git` 不在 PATH、当前目录不是 git 仓库、git 版本低于 2.11(`--porcelain=v2` 的最低要求),三种情况均给出一句话友好报错,而不是抛 Node 异常栈

### 5.3 git 异常状态

- **空仓库**(尚无任何提交)下 HEAD 不存在,`git diff HEAD` 会直接 fatal(已实测确认)。降级方式:改用**空树对象哈希**作为 diff 基准,`git diff <empty-tree>` 在空仓库下正常返回,无需为此写特殊分支逻辑。空树哈希按 `git rev-parse --show-object-format` 区分 SHA-1 / SHA-256 两个常量硬编码;**不要**用 `git hash-object -t tree /dev/null`(`/dev/null` 在 Windows 不可移植),也**不要**用 `git mktree`(会写对象库,违反只读承诺)
  - **`--show-object-format` 本身高于 5.2 的 git 下限**:该选项随 SHA-256 支持一同引入(git 2.29 前后),而启动前置检查只要求 ≥ 2.11,中间区间会直接报错。因此**非零退出即按 SHA-1 处理**——那个区间的 git 根本造不出 SHA-256 仓库,降级无歧义,不得让它成为空仓库路径上的崩溃点
  - 常量取值:SHA-1 为 `4b825dc642cb6eb9a060e54bf8d69288fbee4904`(已实测)。**SHA-256 常量留待 S4 用 `git init --object-format=sha256` 的测试仓库实测取值后回填本行,不得凭记忆写死**——写错的后果是空仓库下 diff 基准无效,且症状与"空仓库不支持"难以区分
- detached HEAD、rebase/merge 进行中等状态需保证不崩溃,分支状态展示做相应降级并明确标注当前处于何种状态

### 5.4 前端

**TypeScript + Preact + @preact/signals,经 Vite 构建为静态产物**,由 5.1 的 Node 服务直接托管。

**曾考虑"纯 HTML + 原生 JS + CSS,不引入前端框架与构建链路"**,理由是"状态复杂度低,省去构建步骤能进一步减小体积、加快启动"。这条论据的三个支点均不成立,记录于此避免被重新提出:

- **"加快启动"不成立**:构建只发生在发布期,用户拿到的是构建产物。第 6 节的冷启动门禁(CLI 侧 ≤300ms / 浏览器侧首屏 ≤1s)与是否存在构建链路无关
- **"减小体积"是反的**:无构建链路时只能用 diff2html 的预构建 bundle,其 slim 包 302 KB 里含大量用不到的 hljs 语言定义;有 tree-shaking 后可按需 import 并显式控制语言子集,产物更小(见 5.5)
- **"状态复杂度低"低估了一处**:5.7 的 SSE 刷新要求在**不丢失当前选中文件与滚动位置**的前提下更新列表。agent 跑动期间刷新频繁、单次变更 300+ 文件是常态(见第 6 节),整树 `innerHTML` 重建会闪烁并跳滚动,不重建则要手写一份按 path 的 keyed reconcile。这正是框架存在的理由,自己实现等于维护一份更易出错的等价物

选型取 **Preact + signals** 而非 React / Svelte:

- Preact 运行时约 4 KB gzip,量级与本工具"最轻"的定位相称;React 19 的 ~42 KB gzip 对一个只读三区块界面是明显溢价
- 保留 TSX 心智模型,与 5.11 的 Biome 原生支持 `.tsx` 对齐;Svelte 的 `.svelte` 模板/样式 Biome 不支持,需额外挂一套 Prettier 工具链

**TypeScript 的收益不限于前端**:5.2 的 `porcelain=v2 -z` 有状态重命名解析、5.7 的三档监听策略、SSE 消息协议,都是类型能在编译期挡住真实 bug 的地方;`@types/node@^22` 同时承担了 5.1 的 API 上限守卫职责。

### 5.5 Diff 渲染与体积

[diff2html](https://github.com/rtfpessoa/diff2html) 直接解析 `git diff` 的 unified diff 文本渲染为带高亮的 HTML,配合 [highlight.js](https://highlightjs.org/) 做语法高亮。直接复用 git 原始 diff 算法,不需要额外维护对比逻辑。

**明确采用「按需 import + 显式注册 hljs 语言子集」,不使用任何 diff2html 预构建 UI bundle**(`diff2html-ui.min.js` / `-slim` / `-base` 三个都不用)。所有资源随包本地分发,**不走 CDN**——工具必须离线可用。

- `import { html } from 'diff2html'` —— 只引入 unified diff parser 与 renderer,其余部分由 tree-shaking 移除
- **`html()` 不做语法高亮**(已实测,见第 10 节)。高亮位于 `Diff2HtmlUI.highlightCode()`,它依赖 `highlight.js-helpers` 的 `closeTags` / `nodeStream` / `mergeStreams` / `getLanguage`——先把整个文件的代码合起来交给 hljs,再按 diff 的行边界切回、补齐跨行未闭合的标签。**被排除的是三个预构建 UI bundle,不是 UI 层的源码**:允许深导入 ESM 源码模块 `diff2html/lib-esm/ui/js/diff2html-ui-base.js`,它参与 tree-shaking、hljs 实例由我们注入,深导入合法(模块体积与依据见第 10 节)。自行重写这段切分逻辑不在本项目要解决的问题之列
  - `draw()` 内部是 `innerHTML` 赋值 + 命令式绑定事件,**必须放在 Preact 的 ref/effect 之后**,不与 vdom 争夺同一棵子树(与 5.4 的 keyed reconcile 不冲突:列表由 Preact 管,单文件 diff 容器由 `Diff2HtmlUI` 管)
  - 用不到的开关一律关掉:`synchronisedScroll` / `fileListToggle` / `fileContentToggle` / `stickyFileHeaders` 全部 `false`,只留 `highlight: true`
  - **`highlight: true` 时 `draw()` 内部已经调过 `highlightCode()`,不要在 `draw()` 后再手工调一次**。第二次调用读到的 `textContent` 仍是纯文本,但 `nodeStream(line)` 拿到的已是第一遍插入的 `hljs-*` span,`mergeStreams` 会把两份流交织进同一行 —— 结果是嵌套重复的 span,且高亮开销白付一倍。二选一:要么只 `draw()`,要么 `highlight: false` + 手工调
- `import hljs from 'highlight.js/lib/core'`,再**逐个显式注册**语言。清单为 **22 个真实语言模块**:`javascript` / `typescript` / `json` / `css` / `scss` / `xml` / `markdown` / `python` / `go` / `rust` / `java` / `kotlin` / `swift` / `c` / `cpp` / `csharp` / `bash` / `yaml` / `ini` / `sql` / `php` / `ruby`。**别名不是模块,不得单独 import**——`jsx` / `mjs` / `cjs` 属 `javascript`,`tsx` / `ts` 属 `typescript`,`toml` 属 **`ini`**,`html` 属 `xml`;`registerLanguage` 注册主模块时别名一并生效(`highlight.js/lib/languages/{jsx,tsx,toml}` 三个路径实际不存在,写了会在构建期 resolve 失败,已实测)。注册清单是白名单,增删语言即增删体积,这正是放弃预构建包换来的可控性
  - **`plaintext` 必须与这 22 个一起注册**,它是兜底而非语言。「未命中的语言退化为 plaintext」不是自动发生的:`highlightCode()` 里 `hljs.getLanguage(x) === undefined` 时把语言改写为字面量 `'plaintext'`,`getLanguage()` 对无扩展名/未知扩展名也直接返回 `'plaintext'`,随后无条件调用 `hljs.highlight(text, { language: 'plaintext' })`。而 `lib/core` **不自带** plaintext,漏注册时这一步抛 `Unknown language: "plaintext"`,异常从 `highlightCode()` 冒到调用方,**整个 diff 视图渲染失败**——不是那一个文件退化。触发条件极普通:diff 里出现 `LICENSE` / `Dockerfile` / `notes.txt` / `.lua` 即可(已实测)。模块本身 318 B,对体积无影响
- diff2html 的两个传递依赖(`diff`、`@profoundlogic/hogan`)由打包器一并处理。注意 `@profoundlogic/hogan` 只有 CJS 入口(无 `module` / `exports` 字段),需打包器的 CJS 互操作,不影响可行性但也不要指望它被 tree-shake

**产物体积门禁**(当前为预算值而非承诺值。S0 的 spike 先给出预估以决定是否需要当场砍语言清单,S2 收口时填入最终实测,见第 7 节):

| 产物 | 门禁 | S0 spike 预估 | S2 收口实测 |
|---|---|---|---|
| 前端 JS(明文) | ≤ 350 KB | **196.0 KB** | S2 填入 |
| 前端 JS(gzip) | ≤ 120 KB | **65.6 KB** | S2 填入 |
| 前端 CSS(明文,含 `diff2html.min.css` 17 KB + hljs 双主题 2.6 KB + Tailwind 产物) | ≤ 40 KB | **22.3 KB** | S2 填入 |

S0 spike 的口径:22 个语言模块 + `plaintext` 全部注册 + 深导入 `diff2html-ui-base` + `@preact/signals` + Preact,
经 Vite 8(Rolldown)构建、压缩后的 `dist/web/app.js` / `app.css`。三行均在预算内,
**语言清单不需要在 S0 砍**。余量最紧的是 CSS(22.3 / 40 KB),而它的增量来自 Tailwind 工具类,
与语言清单无关;JS 两行各剩四成以上,S2 接入真实组件后仍有空间。

对照基线:diff2html slim 预构建包单文件即 302 KB(min)。门禁纳入 CI(见第 6 节)。

**JS 门禁的主导项是语言清单**:上述 22 个语言模块的 ESM 明文合计 225.6 KB(实测,见第 10 节),压缩后约 130 KB / gzip 约 40 KB,占了预算的大头;diff2html + hogan + jsdiff + preact 合计仍留有余量。因此后续若要压体积,第一刀砍语言清单而不是别处;若要加语言,先看这张表还剩多少。

**注意 hljs 的配色主题需要单独引入**:`diff2html.min.css` 里**没有任何 hljs 配色规则**(已实测,见第 10 节),只引 hljs 运行时与语言定义不会出颜色,必须另行本地分发 highlight.js 的主题 CSS(`github.css` / `github-dark.css`)。按 diff2html 官方 README 的要求,**hljs 主题 CSS 必须排在 `diff2html.min.css` 之前引入**,否则会被覆盖——这条在 5.6 的层叠方案里同样成立。

### 5.6 UI 样式

**Tailwind v4(CSS-first,`@tailwindcss/vite`)**。设计 token 写进 `@theme` 块,命名与数值参照 VS Code 颜色 token(如 `editor.background`),复刻 Dark+/Light+ 主题观感,轻量优先于视觉还原度。Tailwind v4 的 `@theme` 同时产出 CSS 变量与工具类,VS Code token 可直接由 CSS 变量承载。

**Tailwind preflight 与 diff2html 的共存方案**(已实测,依据见第 10 节):

引入完整 preflight——它就是跨浏览器归一化那一层,不引则要自己手写一份等价物。与 diff2html 的冲突面实测下来几乎为零:表格合并、行号列盒模型、边框等关键声明 diff2html 均自带,且类选择器特异性稳压 preflight 的通配重置(逐条比对见第 10 节)。

在此之上再用**层叠层(cascade layer)**做结构性隔离——**无层(unlayered)样式在层叠中永远胜过有层样式,与特异性无关**,而 Tailwind v4 把 preflight 放在 `@layer base`:

```css
/* src/web/app.css */
@import "tailwindcss";                              /* preflight → @layer base;utilities → @layer utilities */
@import "highlight.js/styles/github.css";           /* unlayered,且必须排在 d2h 之前(见 5.5) */
@import "highlight.js/styles/github-dark.css" (prefers-color-scheme: dark);
@import "diff2html/bundles/css/diff2html.min.css";  /* unlayered → 结构上不可能被 preflight 压过 */
@import "./vscode-theme.css";                       /* unlayered,覆写 --d2h-* 与 VS Code token */
```

**深色主题的 `@import` 必须带媒体条件**:两份 hljs 主题都是无条件的 `.hljs { … }` 规则、自身不含任何 `@media`(已实测,见第 10 节),平铺引入的结果是 `github-dark` 无条件覆盖 `github`、浅色主题直接失效(第 6 节有"深浅两套主题下均验证"的验收项)。媒体条件不引入层叠层,上面的 unlayered 保障不受影响。

同理,`--d2h-*` 与 VS Code token 的深浅两套取值也统一由 `prefers-color-scheme` 切换,**首版不做页面内的明暗手动开关**——那需要为 hljs 主题 CSS 在构建期加作用域前缀,与"轻量优先"的取向不符。

**随之而来的一条硬约束**:diff2html 渲染出的内部元素**只能通过覆写 `--d2h-*` CSS 变量改配色,不得用 Tailwind 工具类去压**——无层的 diff2html CSS 同样会胜过 `@layer utilities`,写了也不生效(见第 10 节禁止项)。同理,hljs 主题与 diff2html 的 CSS **不得放进任何 `@layer`**,一旦放进去就把上面这层保障拆掉了。

**S0 需验证**:`@import "tailwindcss"` 在 Tailwind v4 构建期展开后,后续 `@import` 的内容确实保持 unlayered。这是方案成立的前提,列为 S0 的前提验证项之一而非既定事实(三项前提验证见第 7 节)。

### 5.7 自动刷新:按 Node 能力分三档 + 轮询兜底

需要规避的风险:Node 在 **Linux 上的 `fs.watch({recursive:true})` 是用户态实现**——自己遍历目录树逐个注册 inotify watch,且**对每个普通文件也注册一个**,不止目录(已核对源码,见第 10 节)。monorepo 下 `node_modules`、`.git/objects`、`target/` 会贡献绝大多数条目,足以耗尽内核 `fs.inotify.max_user_watches`,之后**整机所有依赖 inotify 的工具都开始报 ENOSPC,包括用户自己的编辑器**。这是本工具唯一可能对用户机器造成的外部副作用,与"零副作用只读工具"的核心承诺直接冲突,必须规避。

**解法:`fs.watch` 的 `ignore` 选项。** 它自 Node 24.14.0 起可用,在 Linux 的用户态递归实现里是**注册前跳过**而非回调后过滤(已核对源码,见第 10 节),正是上述配额问题的官方解法。但 5.1 的下限是 Node 22,`ignore` 未必存在,因此按运行时能力分三档:

| 档 | 条件 | 工作区监听 | `.git` 监听 | UI 标注 |
|---|---|---|---|---|
| **A** | Node ≥ 24.14.0,三端 | `fs.watch(repoRoot, { recursive: true, ignore: isIgnored }, cb)` | 非递归 watch | 无 |
| **B** | Node < 24.14.0,macOS / Windows | `fs.watch(repoRoot, { recursive: true }, cb)` + 回调最前面复用同一个 `isIgnored` 过滤 | 同上 | 无 |
| **C** | Node < 24.14.0,Linux | **不建递归 watch**,工作区改动走 1.5s 轮询 | 同上 | 标注降级模式 |

- **档位判定用 `process.versions.node` 的 semver 比对**,不得靠特性探测:任何探测写法都要依赖 `fs.watch` 对未知选项的处理这一未文档化的内部细节,误判的代价是在 Linux 上静默退化成无 `ignore` 的递归 watch(见第 10 节禁止项)
- **B 档为什么安全**:macOS / Windows 走原生 FSEvents / `ReadDirectoryChangesW`,单句柄监听整棵树,本就没有配额问题;`ignore` 在这两个平台上本身也只是回调后过滤(已核对源码),我们自己在回调里调同一个匹配函数即可,不是重新实现监听
- **B 档的过滤必须发生在 debounce 之前**,否则 `node_modules` 的写入噪声照样把 debounce 窗口顶开、触发无谓刷新
- **C 档不是全盘轮询**:`.git` 侧的目录级非递归 watch 与 Node 版本无关,提交、切分支仍是即时的;只有工作区文件改动退化为 1.5s 轮询

**三档共用同一个匹配函数 `isIgnored`,不用字符串模式**:

```ts
const IGNORE_NAMES = new Set(['node_modules', '.git', 'dist', 'target', '.next', 'build']);
// 逐段匹配:路径任一段命中即忽略
const isIgnored = (p: string) => p.split(/[\\/]/).some(seg => IGNORE_NAMES.has(caseFold(seg)));
```

`fs.watch` 的 `ignore` 除字符串 / 正则外**也接受函数**,传函数即可绕开字符串模式的坑:

- **字符串 basename 模式在 macOS / Windows 上形同虚设**(已实测源码,机制见第 10 节)。原生 watcher 交给匹配器的是事件的**相对路径**(如 `node_modules/.bin/foo`),按 basename 比对时匹配不上模式 `node_modules` → 事件照常放行。B 档在回调里按 basename 过滤同样失效,第 6 节"B 档:`node_modules` 下批量写文件不触发刷新"的验收项按字面实现必挂
- **Linux 侧两种写法等价**:递归实现是对遍历到的每个条目的相对路径调用匹配器,走到条目 `node_modules` 自身时即命中 → 注册前跳过、不再递归进入。逐段函数在这里的行为与 basename 模式完全一致
- **仍然不得写成 `node_modules/**` 这类含斜杠的字符串模式**:含斜杠会使 `matchBase` 失效,既匹配不到目录自身(白白进去一层),也匹配不到 monorepo 里嵌套的 `packages/*/node_modules`,两头落空。逐段函数两头都覆盖
- `caseFold` 在 macOS / Windows 上做小写归一(对齐 `ignore` 内部 `nocase: isWindows || isMacOS`),Linux 上原样返回;`.git` 已在集合内,与档位无关
- **`.git` 内部**:`isIgnored` 已把 `.git` 整个排除(C 档则根本没有递归 watch),因此三档都需对 `HEAD`、`index`、`refs/`、`MERGE_HEAD` / `rebase-*` 所在**目录**单独建**非递归** watch,否则检测不到提交与切分支。**绝不递归 `.git/objects`**
- **兜底**:任一路径失败(ENOSPC / ENOSYS / 网络盘 NFS·SMB / Docker 卷)自动降级为 **1.5s 轮询**,并在 UI 上标注降级模式。这条与档位正交:A / B 档失败时同样落到轮询,C 档则是一开始就以它为工作区通路。`ignore` 解决的是配额,救不了这些场景,**兜底不可省略**
  - **轮询必须复用 5.2 的同一条命令 `git status --porcelain=v2 --branch -uall -z`,不得为"轮询只要知道变没变"而裁剪参数**。漏掉 `-uall` 的后果是静默的:git 会把未跟踪目录折叠成一行 `dir/`,于是**在一个已存在的未跟踪目录里新增文件根本不改变输出**,轮询判定为"无变化"、页面不刷新,而这正是 agent 边跑边生成文件时最常见的形态。漏掉 `--branch` 则会丢掉提交与切分支的检测(C 档只有 `.git` 侧的非递归 watch 兜着)。两条命令保持逐字一致,也让 5.10 的只读白名单只需覆盖一种调用形态

另有三条 Node 官方文档载明的行为约束,三档均适用:

1. **绝不能对单个文件建 watch**。Linux/macOS 上 watch 绑定的是 inode,路径被删除后重建会分配新 inode,原 watch 从此静默失效——而编辑器和 agent 普遍用"写临时文件 + 原子 rename"保存文件。必须 watch 目录
2. 回调的 `filename` 参数**可能为 null**,即便在支持的平台上也不保证提供,必须有 fallback 逻辑
3. 事件需做 debounce(建议 100-200ms)合并,避免 agent 批量写文件时风暴式推送。**在 Linux 上这是必需项而非优化项**:用户态递归实现在初次遍历目录树时,会对遍历到的每个条目 `emit('change', 'rename', ...)`,启动瞬间即产生一波与实际变更无关的事件风暴(已核对源码),没有 debounce 会直接触发一次无意义的全量刷新

变更通过 SSE(Server-Sent Events)推送前端刷新。

### 5.8 进程生命周期

- 以"无任何已连接客户端持续 **45 秒**"作为退出条件(取 30-60s 区间中值)。页面刷新、系统休眠唤醒、浏览器丢弃后台标签(Chrome 省内存机制)都会造成短暂断连,需要宽限期避免误退出;多标签同时连接时以客户端计数为准
- **实现要点**:服务端 SSE 心跳约 15s;前端监听 `visibilitychange`,标签重新激活时主动重连
- **已知边界**:HTTP/1.1 下浏览器对同源有 6 条并发连接上限,一条常驻 SSE 会占用其中一条,因此超过 6 个标签页时新标签会挂起。对本工具的实际使用场景(1-2 个标签)无影响,不为此调整架构
- **同仓库单实例**:实例注册表文件写在 `os.tmpdir()`,文件名用仓库绝对路径的 hash。**绝不能写进 `.git/` 或工作区**——否则既污染 `git status`,也实质违背零写操作承诺。陈旧实例的判定用 **HTTP 探活**(请求已记录的端口,校验返回的 repo 路径一致)而非 pid 存活判断——pid 会被系统复用,误判会把用户带到一个指向别人进程的页面
- **注册表文件权限**:该文件存有端口与 5.9 的会话 token。`os.tmpdir()` 的权限因平台而异,**Linux 上是 `/tmp`,同机其他用户可读**(已实测,见第 10 节)。因此必须以 `mode: 0o600` 配合 `O_EXCL` 创建(而非先建后 chmod,避免竞态窗口),或统一落在 tmpdir 下的每用户私有子目录中

### 5.9 本地安全

服务绑定 `127.0.0.1`,启动时生成随机端口 + 会话级 token。token 在进程生命周期内持续有效,以支持页面刷新与多标签场景。

需要澄清的是:**token 本身不是 DNS rebinding 的防御手段**。rebinding 的攻击路径是恶意页面把自己的域名重绑到 `127.0.0.1`,使浏览器认为攻击者页面与本服务同源;token 能挡住攻击者读取受保护端点(它拿不到 token),但只要存在任何一个不校验 token 的端点(健康检查、静态资源),仍会泄漏信息。因此必须同时具备:

1. **校验 `Host` 请求头**必须是 `127.0.0.1:<port>` 或 `localhost:<port>`,其余一律 403 —— 这才是 rebinding 的正面防御
2. **校验 `Origin`**:非空且不等于自身则 403;所有响应不带任何 CORS 头
3. **token 落地方式**:URL 携带 token → 首次访问后置换为 `HttpOnly; SameSite=Strict` cookie 并 302 掉 query,避免 token 长期滞留在浏览器历史、地址栏和日志中。SSE 端点同样校验。**需知 cookie 的作用域是 host 而非 origin,不隔离端口**:同机另一个监听 `127.0.0.1:<其他端口>` 的服务同样会收到这个 cookie。这不影响第 1 条的 rebinding 防御(攻击者页面的 host 是自己的域名,cookie 根本不会发出),但意味着 token 会暴露给本机其他 localhost 服务,因此服务端校验 token 时需**一并绑定校验本次会话的端口**,使泄漏出去的 token 无法在别处复用
4. 所有端点(含 SSE)统一校验,无例外;响应带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`
5. **严格 CSP**:`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`。后三个指令**不回退到 `default-src`**,不显式写就等于没设,`'none'` 一并挡掉被 iframe 嵌套、`<base>` 改写相对 URL 与表单外发。这条是 5.11 构建链路顺带解锁的——产物是独立的 `.js` / `.css` 文件、页面无内联脚本,才有条件不开 `'unsafe-inline'`。diff2html 的输出经 `innerHTML` 注入,其自身对内容做转义,CSP 在此作纵深防御
6. **静态资源按内存清单白名单式映射**,不得用 `path.join(root, req.url)` 之类的路径拼接读文件,避免路径穿越。构建产物文件名因此固定、不加 hash——服务端本就对所有响应发 `Cache-Control: no-store`,内容哈希没有意义

**开发期不得以放宽本节校验为代价换取便利。** Vite dev server 与后端不同源,会同时撞上 Host、Origin、token 三道门,解法一律放在 dev server 的代理层(改写 `Host` / `Origin`、注入 token cookie),**后端不得为此新增任何环境变量或分支**——那等于把本节的正面防御做成一个可被误开的开关(详见 5.11,并见第 10 节禁止项)。

### 5.10 只读性的验证方式

4.1 的"零写操作"是产品核心承诺,需要能自动化证伪,而不是靠人工审查代码。**"前后 `git status` 比对无变化"强度不足**——它发现不了写进 `.git/` 但不改变 status 输出的操作(意外触发 gc、写 index、创建对象)。因此采用两层验证,均纳入 CI 门禁:

1. **主门禁**:测试期间用 fake git wrapper 劫持所有 git 调用并记录完整子命令,断言只出现只读白名单(`status` / `diff` / `rev-parse` / `ls-files` / `symbolic-ref` 等)
   - **Windows 上 shim 的形态需单独落地**:PATH 劫持要求存在一个 Windows 认得的可执行文件(`git.cmd` / `git.exe`),裸的无扩展名脚本不会被找到;且 Node 的 `spawn` 不带 `shell` 时对 `.cmd` 的解析与 POSIX 不同。**S1 建立主门禁时须在 CI 的 Windows 档实测确认劫持真的生效**——只在 macOS 上验过就推广,会让 Windows 档变成"门禁跑了但什么都没劫持到"的假绿,而假绿的只读门禁比没有门禁更糟
2. **冒烟测试**:`chmod -R a-w .git` 后跑一遍完整流程,任何写尝试都会直接失败暴露

**唯一的非 git 子进程豁免**:5.1 的拉起浏览器(`open` / `cmd /c start ""` / `xdg-open`)。它不经过 git 封装层、fake git wrapper 也劫持不到,因此需在测试里**单独断言**:产品代码中除 git 封装层外只存在这一处 `child_process` 调用,且被调命令来自这三者的固定映射、参数只有 URL 一项。CI 里该调用需可通过环境变量关闭,避免每次跑测试都弹出浏览器。

### 5.11 开发工具链与构建

本节全部内容为**开发期依赖**,不进 `dependencies`,不随 npm 包分发给用户,不改变 5.1 "运行时只用 Node 标准库" 的约束。版本为 2026-07-31 从 npm registry 实测的当时最新版(依据见第 10 节)。

| 位置 | 选型 | 版本 | 理由 |
|---|---|---|---|
| 包管理器 | pnpm | **11.20.0** | 严格 node_modules(不扁平化)+ 内容寻址存储。**版本的唯一事实来源是 `package.json` 的 `packageManager` 字段**,本表只作记录。见下方「包管理器」一段 |
| 构建 | Vite(Rolldown / Oxc) | 8.2.1 | 2026-03 发布,Rolldown 已为默认 bundler |
| 语言 | TypeScript(**仅 `--noEmit` 类型检查**) | 7.0.2 | 2026-07-08 稳定的 Go 原生编译器。本项目不需要 declaration emit,正好避开 7.x 尚在完善的部分;转译交给 Vite / tsdown。**二进制名是 `tsc`**——`tsgo` 是预览包 `@typescript/native-preview` 的名字,稳定版并入 `typescript` 主包后已回归 `tsc`(实测 `bin` 字段,见第 10 节) |
| 前端框架 | Preact + @preact/signals | 10.29.8 / 2.11.0 | 见 5.4 |
| 样式 | Tailwind v4 + `@tailwindcss/vite` | 4.3.3 | 见 5.6 |
| 后端打包 | tsdown(Rolldown 系) | 0.22.14 | 与 Vite 8 同引擎,产出单文件 ESM |
| 格式化 / lint | Biome | 2.5.7 | 一个二进制覆盖 format + lint + import 排序,一份配置 |
| git hooks | lefthook | 2.1.10 | 单 YAML,不需要额外的 lint-staged |
| 测试 | Vitest + `node:test` | 4.1.10 | 分层用途见下方 CI 一段 |

**未采用**:React 19(~42 KB gzip,与"最轻"定位相悖)、Svelte 5(Biome 不支持 `.svelte` 模板/样式,需额外挂 Prettier)、Node 原生 type stripping 直接运行 `.ts`(会把运行时下限从 22.0.0 顶到 22.18,且给冷启动加转换开销,见第 10 节禁止项)。

**包管理器**——pnpm 只用于开发期,不改变 2. 的分发口径,也不改变 `dependencies` 为空这一事实。**版本钉 pnpm 11**,本节的配置面按 11 描述(11 相对 10 有三处破坏性变更,均直接打在下列条目上,依据见第 10 节):

- **版本的唯一事实来源是 `package.json` 的 `packageManager: "pnpm@11.20.0"` 字段**,不在别处重复写版本号。CI 用 `pnpm/action-setup` 且**不传 `version`**,让它读该字段;不依赖 Node 是否自带 Corepack——Corepack 已不再随 Node 25+ 发行版分发,而 CI 矩阵含 Node 26,靠它等于把工具链固定寄托在一个正在消失的东西上
- **`pnpm-workspace.yaml` 是所有 pnpm 设置的唯一位置**,单包仓库同样需要这个文件。pnpm 11 起:**不再读 `package.json` 的 `pnpm` 字段**,`.npmrc` **只保留 registry 与鉴权**,其余设置一律改用 `pnpm-workspace.yaml` 里的 camelCase 键。**写错位置不报错、无 deprecation 警告,只是设置静默不生效**(见第 10 节),因此本节每一条约束的落地都必须连带确认它写在了正确的文件里
- `pnpm-lock.yaml` 入库,所有非交互安装用 `pnpm install --frozen-lockfile`(CI、以及本地复现问题时)
- **严格 node_modules 是资产不是障碍**:禁 `shamefullyHoist` / `nodeLinker: hoisted`(pnpm 11 的键名,写在 `pnpm-workspace.yaml`;理由见第 10 节)。任何被 import 的包必须由我们自己声明——5.5 提到的 diff2html 两个传递依赖(`diff`、`@profoundlogic/hogan`)由打包器经 diff2html 自身的依赖树解析,**我们的代码与配置不得直接引用它们**
- **依赖的生命周期脚本默认不执行**:需要执行的包必须显式列进 **`allowBuilds`** 白名单(pnpm 11 把 `onlyBuiltDependencies` / `neverBuiltDependencies` / `ignoredBuiltDependencies` / `onlyBuiltDependenciesFile` / `ignoreDepScripts` 合并成的这一个 map 设置,形如 `allowBuilds: { lefthook: true }`)。**已知 `lefthook` 需要**——它靠安装后脚本把 git hooks 写进 `.git/hooks`,漏列不报错、安装照常成功,只是 hooks 静默没装、提交前检查全线失效。S0 建立时逐个确认该清单
- **S0 的三项前提验证一律在 pnpm 的 node_modules 布局下跑**(见第 7 节),尤其第 2 项深导入 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 与第 3 项体积 spike:在 npm 扁平布局下通过、换到严格布局才 resolve 失败,是这类 spike 最典型的假绿
- **`test/fixtures/` 的生成脚本与 `scripts/` 下的 bench / size 门禁脚本必须是零依赖纯 JS,可由 `node <路径>` 直接执行**,`package.json` 里的 `fixtures` / `bench:startup` / `size` 只是别名。理由与下方 matrix 档"完全不装依赖"同源:这些脚本要在没有 pnpm、没有 `node_modules` 的 matrix 机器上跑,一旦写成 TS 或引入 devDependency,matrix 档就只能退回"装一点点",而那是第 10 节明令禁止的

**产物结构**:

```
bin/gitglance.js      手写保守语法 JS。不参与 TS 编译、不作为打包入口(见 5.1)。
                      只做 process.versions.node 检查 + 动态 import('../dist/server/main.js')
src/server/**.ts  →   tsdown → dist/server/main.js   单文件 ESM,不压缩不混淆(见 5.1)
src/web/**.tsx    →   vite   → dist/web/{index.html, app.js, app.css}   固定文件名不加 hash(见 5.9)
```

**TypeScript 配置**(承担 5.1 的 API 上限守卫):

- `@types/node` 锁 `^22`——**不是** latest 的 26.x。用到 Node 24+ 才有的内置 API 时编译期即报错
- 后端:`target` / `lib` 取 `ES2023`、`module: nodenext`
- 前端单独一份 tsconfig:`lib: ["ES2022","DOM"]`、`jsx: "react-jsx"`、`jsxImportSource: "preact"`
- 两份均开 `verbatimModuleSyntax` + `erasableSyntaxOnly`(禁掉 enum 与参数属性,保持语法可擦除,为将来若改用原生 type stripping 留门)
- JSX 转换首选走 **Vite 8 的 Oxc 选项 + alias**,不引 `@preact/preset-vite`(它会拖入 `@babel/core`)。代价是失去 prefresh 的组件状态保留 HMR,整页刷新对本项目够用;若 DX 明显不足再回补该插件

**Dev server 与 5.9 的交互**:Vite dev server 在 `localhost:5173`,后端在 `127.0.0.1:<随机端口>`,三道校验全部在 `vite.config.ts` 的 proxy `configure` 钩子里解决,**后端零 dev 分支**:

- `changeOrigin: true` → `Host` 头改写为后端的 `127.0.0.1:<port>`
- `configure` 中把 `Origin` 头重写为后端自身 origin
- `configure` 中从 `os.tmpdir()` 的单实例注册表(5.8)读出 port 与 token,注入 `Cookie` 头

**因此注册表文件的写入必须与 server 同期落地(S1),不能等到 S3c。** 5.8 的单实例能力可以拆开:**"server 启动即把 port + token 写进注册表"属 S1**(含 5.8 要求的 `0o600` + `O_EXCL`),**"启动时探活复用已有实例"与"空闲 45 秒退出"才属 S3c**。若把整个注册表推到 S3c,S1–S3b 期间 dev proxy 就没有 token 来源,而那段时间里"临时给后端加个放宽校验的环境变量"恰好是最短路径——正是第 10 节明令禁止、且第 7 节总原则("门禁不得晚于它所保护的代码")要求消除的那种排期。

**CI 分层**——`tsdown` 要求 Node `^22.18 || >=24.11`、Vite 8 要求 `>=22.12`,均高于产品运行时下限 22.0.0,因此 CI 必须拆成两层。矩阵作业测的是**用户真正拿到的产物**,而非 TS 源码:

1. **build 作业**(Node 24):`pnpm/action-setup` → `actions/setup-node`(`cache: 'pnpm'`)→ `pnpm install --frozen-lockfile` → `biome ci` → `tsc --noEmit` → `vitest run`(单元/集成,直接跑 TS 源码)→ 构建 → 检查产物体积门禁(5.5)→ 上传 `dist/` artifact。**`pnpm/action-setup` 必须排在 `actions/setup-node` 之前**,否则后者的 `cache: 'pnpm'` 找不到 pnpm 可执行文件,缓存步骤直接失败
2. **matrix 作业**(Node **22.0.x** / 24 / 26 × macOS / Windows / Linux):下载 `dist/` artifact,**完全不执行安装、也不需要 pnpm**,用 `node --test` 直接打到纯 JS 编写的冒烟套件文件(不经 `package.json` 的 script)——CLI 启动、status、diff、5.10 的两层只读验证、冷启动 ≤300ms 测量。**不得改成"装一点点"**(如 `pnpm install --prod`),理由见第 10 节
   - `node --test` 在一个用例都没匹配上时是 **0 用例、exit 0**。因此本档在跑测试之前必须先数一遍冒烟文件、数不到就失败:一次改名或某个平台上的引号行为不同,会把「只读承诺的唯一自动化保护」变成一个什么都没跑的绿勾
   - **体积门禁不进本档**:matrix 下载的是同一份 `dist/`,字节完全相同,再跑 9 遍不增加覆盖,反而引入方差 —— gzip 输出长度取决于各 Node 大版本自带的 zlib,贴着预算的行会只在某一个 Node 上红。它归 build 作业跑一次
3. **old-node-guard 作业**(Node 20,即**低于下限**):不下载产物,直接 `node bin/gitglance.js`,断言 exit 1 + 打印友好提示 + stderr 无 `SyntaxError` + stdout 为空。单列一档是因为 build 与 matrix 都跑在 ≥22 上,而守卫要防的是**解析期**失败 —— 在 22+ 上文件早已解析成功,那条路径永远测不到。冒烟里那条「不含 `?.` / `??` / 顶层 await / 私有字段 / `||=`」的正则清单只是它的替身,替身按具体语法逐条列举,`catch {}`、对象展开、class 静态块等一律漏网
4. 5.10 的 fake git wrapper 靠 PATH 劫持,与代码是否打包无关,归属 matrix 作业

### 5.12 后端接口契约

本节汇总 5.2 / 5.3 / 5.7 的产物在 HTTP 层的形状,是 5.0 边界不变式第 4 条(前端不内联 git 知识)的具体承载。类型定义放 `src/server/shared/`,前后端共享同一份。

**端点清单——全部为 `GET`**。只读工具不需要任何非幂等端点,这条本身就是一道约束:出现 `POST` / `PUT` / `DELETE` 即意味着有人在往 4.1 的承诺外扩功能。

| 端点 | 返回 | 说明 |
|---|---|---|
| `GET /` | `dist/web` 静态资源 | 固定文件名不加 hash(见 5.9) |
| `GET /api/state` | `{ branch: BranchState, files: FileEntry[], watch: WatchState }` | 对应 5.2 的**单次** status 调用;`watch` 见下 |
| `GET /api/diff?path=&oldPath=` | `DiffPayload` | 按文件懒加载;`oldPath` 仅重命名条目传(5.2 的双路径要求) |
| `GET /api/events` | SSE | 事件 `change` / `heartbeat`;5.8 的空闲退出以本端点的连接数判定,不另设保活端点 |

**协议类型**:

- `FileEntry { path; oldPath?; kind: 'tracked' | 'untracked'; staged; unstaged; renameScore? }`——`staged` / `unstaged` 承载 `porcelain=v2` 的双状态位,`oldPath` + `renameScore` 来自 5.2 的 `2 ` 记录
- `BranchState { head; detached: boolean; upstream: null | { ahead; behind }; operation?: 'rebase' | 'merge' | … }`——**`upstream: null` 即"无上游"**。第 6 节要求无 `# branch.ab` 行时展示"无上游"而非 0/0,把它编码进类型而非留作约定,前端就不可能漏掉这条分支
- `DiffPayload` 为判别联合:`{ kind: 'text', patch }` / `{ kind: 'binary' }` / `{ kind: 'too-large', size }` / `{ kind: 'untracked-text', patch }`
- `WatchState { mode: 'native' | 'polling'; tier: 'A' | 'B' | 'C' }`——承载 5.7 的档位与是否已降级。**第 6 节多处要求"UI 明确标注降级模式",而降级既可能是 C 档的既定形态、也可能是 A/B 档运行中落到轮询兜底,前端无从自己推断,必须由后端告知**;放进协议类型也正是 5.0 边界不变式第 4 条(前端不内联 git / 监听知识)的要求

**字段定型时机**:**payload 的字段与判别式在 S1/S2 即定型,即使 `binary` / `too-large` / 重命名标注的填充逻辑要到 S4 才实现、`watch` 的真实取值要到 S3b 才有**。在此之前后端可以永远不返回那几个分支、`watch` 固定返回占位值,但类型里必须先有。这与第 7 节"第一批 fixture 决定解析器结构"是同一条论证:字段晚定,等于前端在 S2 按 `kind: 'text'` 单一形状、按"永远不降级"写死,S3b / S4 再回头改渲染分支。

**错误约定**:`{ error: { code, message } }`,`message` **不含绝对路径**(与 5.9 及 S5 的安全自查一致)。

**明确不做**:协议版本协商。前端随进程自带分发,不存在版本错配的可能,加版本字段只是空转。

## 6. 验收标准

每条前缀的 `[Sx]` 标记的是**该项第一次可被验证的阶段**(对应第 7 节),不是它最终定稿的阶段;`[Sx/Sy]` 表示前一阶段可验证其可自动化的部分、后一阶段补齐余下部分(通常是真机或跨平台部分)。第 7 节的收口判据要求一个阶段结束时,标记为该阶段的项**全部**打勾。本节不含 `[S6]` 项——S6 的收口清单在第 8 节。

**启动与仓库识别**

- [ ] `[S1/S2]` 在任意 git 仓库目录下执行 CLI 命令,能自动识别仓库并在浏览器打开对应变更视图(S1 验到启动与拉起浏览器,变更视图待 S2)
- [ ] `[S1]` 空仓库(尚无提交)下工具不崩溃:diff 基准降级为空树哈希,列表与分支状态展示合理
- [ ] `[S4]` detached HEAD、rebase/merge 进行中等状态下工具不崩溃,分支状态降级并明确标注当前处于何种状态
- [ ] `[S4]` git worktree、submodule 目录下能正常启动;bare 仓库给出明确提示而非崩溃

**变更列表与分支状态**

- [ ] `[S2]` 变更文件列表状态标识准确,与 `git status` 结果一致;已暂存、未暂存、未跟踪三类文件均正确展示;未跟踪目录展开到文件粒度而非折叠成 `dir/`
- [ ] `[S3a]` 当前分支、ahead/behind 计数与 `git status` 结果一致;分支无上游(无 `# branch.ab` 行)时展示"无上游"而非 0/0 或报错

**Diff 正确性与边界**

- [ ] `[S2]` Diff 展示内容与 `git diff HEAD` 结果一致;agent 执行过 `git add` 后,已暂存的改动仍能正常展示不遗漏
- [ ] `[S4]` 未跟踪的新文件能展示为全新增内容,而非在列表里可见却点开无 diff
- [ ] `[S4]` 新文件/删除文件/重命名正确展示,二进制文件仅提示变更不做内容 diff,超大文件(如 >5MB)提示不支持预览而非卡死
- [ ] `[S4]` 重命名的文件在懒加载点开后标注为"重命名"(展示 `rename from/to` 与相似度),而非退化成一个全新增文件
- [ ] `[S2]` 单次变更 300+ 文件的仓库下,列表能正常展示、点击单个文件的 diff 响应及时,浏览器主线程不出现可感知冻结
- [ ] `[S1]` 路径含非 ASCII 字符(中文/日文/emoji)、空格、引号的文件,在列表与 diff 中均正确展示,不出现 `\351\234\200` 这类转义残留(S1 即可在封装层输出上验证,不必等渲染)

**自动刷新与三档监听**

- [ ] `[S3b]` 三档均可通过内部环境变量强制指定,在单一 Node 版本的机器上逐档验证(**本组其余各项的自查前提**)
- [ ] `[S3b/S5]` 文件变更后,浏览器展示内容能自动刷新,延迟感知不明显;macOS / Windows / Linux 三端监听行为均验证正常
- [ ] `[S3b/S5]` **A 档**(Node ≥ 24.14.0):Linux 上在含 `node_modules` 的大仓库启动时,`ignore` 过滤生效、注册的 watch 数量维持在低位,不因遍历重目录而耗尽配额
- [ ] `[S3b/S5]` **A 档在 macOS / Windows 上同样验证过滤生效**:`ignore` 传的是逐段匹配函数而非字符串模式,`node_modules/**` 深层写入不触发刷新
- [ ] `[S3b/S5]` **B 档**(Node 22 × macOS / Windows):回调内 `isIgnored` 过滤生效,**在 `node_modules` 的嵌套子目录里**批量写文件不触发刷新(只测顶层目录本身无法证伪 basename 写法的缺陷),仓库内改文件正常触发刷新
- [ ] `[S3b/S5]` **C 档**(Node 22 × Linux):启动后**不注册任何递归 watch**,inotify 用量维持在个位数,工作区改动经轮询在 1.5s 内反映到页面,UI 明确标注降级模式
- [ ] `[S3b/S5]` Linux 上人为压低 `fs.inotify.max_user_watches` 直至触发 ENOSPC 时,能正确降级为轮询并在 UI 提示,功能不受影响

**进程生命周期与单实例**

- [ ] `[S3c]` 页面刷新、系统休眠唤醒、浏览器丢弃后台标签后重新激活,均不导致进程误退出,页面能自动恢复连接
- [ ] `[S3c]` 多标签同时打开时,关闭其中一个不导致进程退出;全部关闭后进程在宽限期内自动退出,不留后台常驻进程
- [ ] `[S3c]` 同一仓库重复执行启动命令时,复用已有实例而非新起进程;注册表文件位于 `os.tmpdir()`,仓库目录内无任何新增文件

**只读性与本地安全**

- [ ] `[S1]` 5.10 的**主门禁**(fake git wrapper 劫持并断言 git 子命令只出现在只读白名单)与浏览器拉起的单点断言均通过,并随 git 封装层一同纳入 CI 门禁
- [ ] `[S2]` 5.10 的**第二层**(`chmod -R a-w .git` 后跑完整流程)通过并纳入 matrix 作业;Windows 上改用只读 ACL 或显式跳过,不得静默通过
- [ ] `[S1/S2]` **dev 代理未以放宽后端校验实现**:后端代码中不存在任何绕过 Host / Origin / token 校验的环境变量或分支;`vite dev` 下经代理发出的请求能通过后端三道校验拿到 `/api/state`(S1 即可验到这一步——此时前端尚未建立,以请求本身通过为准;完整页面功能待 S2)
- [ ] `[S0/S1]` **5.0 的架构边界可自动断言**:CI 中存在规则或脚本,能在「`src/web` 反向 import `src/server`(`shared/` 除外)」或「`server/git` 之外出现 git 子进程调用」时失败。import 方向部分由 Biome 的 `noRestrictedImports` 承担(S0 建立),子进程单点部分与 5.10 主门禁合并断言(S1 建立)

**性能与资源**

- [ ] `[S1]` **冷启动 · CLI 侧**:进程 ready 并输出 URL ≤ 300ms,自动化测量并纳入 CI 门禁。**"ready" 的口径明确为「监听成功并打印 URL」**,首次 `git status` 交由第一个 HTTP 请求惰性执行、不计入——否则该指标会随被测仓库规模漂移,失去回归意义
- [ ] `[S2]` **冷启动 · 浏览器侧**:浏览器进程已在运行的前提下,首屏渲染 ≤ 1s(人工验证)。冷启动浏览器进程本身的耗时(通常 2-5s)与 `npx` 首次下载解包耗时均不计入,后者在 README 中说明
- [ ] `[S3b]` 资源占用:原生监听模式下空闲时内存/CPU 接近零;降级轮询模式下空闲 CPU < 1%

**样式、主题与语法高亮**

- [ ] `[S0/S2]` **样式层叠方案生效**:构建产物中 hljs 主题与 `diff2html.min.css` 均为 unlayered 且 hljs 在前;Tailwind preflight 未破坏 diff2html 渲染(行号列宽、边框、表格对齐正常),深浅两套主题下均验证(S0 的前提验证只证 unlayered 成立,渲染观感待 S2)
- [ ] `[S2]` **深浅主题各自生效**:`github-dark.css` 在构建产物中确实被 `(prefers-color-scheme: dark)` 包住;切换系统外观后语法高亮配色随之切换,浅色下不是深色配色
- [ ] `[S0/S2]` **语法高亮真的出颜色**:diff 中的代码按语言着色(而非只有 diff 增删底色);清单外的语言退化为 plaintext 且不报错(S0 的 spike 即需看到颜色,否则深导入方案不成立)。**退化路径要有单测守着**:`hljs.highlight(x, { language: 'plaintext' })` 不抛异常 —— 光看 spike 样例是发现不了的,样例里的语言全在清单内

**构建产物与发布**

- [ ] `[S0/S2]` **产物体积门禁**:5.5 的三行门禁(前端 JS 明文 ≤350 KB / gzip ≤120 KB、CSS 明文 ≤40 KB)自动化测量并纳入 CI;S0 的 spike 预估与 S2 的收口实测均回填 5.5 表格
- [ ] `[S0]` **静态检查进 CI**:`biome ci` 与 `tsc --noEmit` 均为 CI 门禁,失败即阻断
- [ ] `[S2]` **下限档跑的是构建产物**:CI matrix 的 Node **22.0.x** 档在完全不执行安装的前提下,对下载的 `dist/` artifact 跑通全部冒烟套件;5.10 的两层只读验证与冷启动 ≤300ms 测量均在构建产物上执行,而非 TS 源码(matrix 作业本身在 S0 即拉起,此项以冒烟套件补齐为准)
- [ ] `[S0]` **发布产物内容干净**:`pnpm pack --dry-run --json` 列出的文件清单只含 `bin/`、`dist/`、README、LICENSE、`package.json`,不含 `src/`、配置文件、测试与任何 devDependency。注意打包出的 `package.json` 因 pnpm 的 manifest obfuscation 本就与仓库里的不同(剥离 `packageManager` 与 publish 生命周期脚本),核对时勿误判(见第 10 节)
- [ ] `[S0]` **pnpm 安装可复现**:干净环境(无 store 缓存、无 `node_modules`)下 `pnpm install --frozen-lockfile` 通过且不修改 `pnpm-lock.yaml`
- [ ] `[S0]` **`allowBuilds` 白名单生效**:安装后 `.git/hooks` 下确有 lefthook 写入的钩子文件且能触发——**以钩子文件实际存在为准,不以安装日志无报错为准**,漏列白名单时安装本身是成功的(见 5.11)
- [ ] `[S0]` **pnpm 设置写在正确的文件里**:`allowBuilds` 等设置位于 `pnpm-workspace.yaml`;`package.json` 无 `pnpm` 字段、`.npmrc` 无非 auth 设置——**pnpm 11 对写错位置的设置是静默忽略**,故此项须逐个设置确认实际生效(如上一条以钩子文件为准),不能只看文件里写了什么(见 5.11)
- [ ] `[S1/S5]` `npm i -g gitglance` 后在 Node 22+ 环境下能正常运行,macOS / Windows / Linux 三端均验证通过;低于 22 时打印明确的版本要求提示并以非 0 退出,**不得是 SyntaxError 或 Node 异常栈**——版本守卫必须先于任何可能超出该语法/API 范围的模块加载执行
- [ ] `[S0]` **`bin/gitglance.js` 未被构建管线触碰**:跑完完整构建后,该文件与仓库源文件逐字节一致,且不出现在任何打包入口中(该文件在 S0 即须定稿——它是手写保守语法 JS、不参与构建,内容不依赖后续阶段;真机上"低于下限的 Node 打印友好提示"部分见上方版本守卫项,标 `[S1/S5]`)

## 7. 实施阶段

按下表顺序推进,每个阶段完成后对照第 6 节中标记为本阶段的验收项自查。阶段划分的依据是依赖关系与验证时机,不是工作量。

**排期的一条总原则:门禁不得晚于它所保护的代码,方案前提不得晚于依赖该前提的实现。** 第 9 节的开发方式决定了这条原则比通常更重要——阶段边界既是工期划分,也是"哪条路此刻最短"的塑造手段,把校验或门禁排在后面,等于在前面的阶段里为绕过它留出最短路径。

| 阶段 | 内容 | 注意事项 |
|---|---|---|
| **S0** | 工具链脚手架:`package.json`(含 `engines` / `files` / scripts / `packageManager`)、`pnpm-lock.yaml`、`pnpm-workspace.yaml`(承载 `allowBuilds` 等全部 pnpm 设置)、`.gitignore`、**`bin/gitglance.js`(手写定稿,见 5.1)**、Vite + tsdown 配置、两份 tsconfig、Biome、lefthook、冷启动测量脚本;**按 5.0 建立目录骨架与依赖方向断言规则**;CI 两层作业骨架,且 **matrix 层的三平台 × Node 22/24/26 即刻拉起**(初期跑占位冒烟即可) | 三项前提验证须在本阶段收口,见下方「S0 的三项前提验证」。matrix 提前拉起是为了让 Windows / Linux 回归从第一天起持续存在,而不是堆到 S5 一次性暴露。`bin/gitglance.js` 放在 S0 是因为它不参与构建、内容不依赖后续阶段,而第 6 节"未被构建管线触碰"这条验收项要成立,它必须在构建管线建立的同一阶段就已存在 |
| **S1** | CLI 脚手架 + HTTP server(**按 5.9 最终形态实现,含三道校验**)+ **注册表文件写入(port + token,`0o600` + `O_EXCL`)** + git shell 封装(status/diff)+ **5.12 协议类型随 server 一同定型** + **测试数据第一批** + **5.10 主门禁入 CI** | server 一建立即是最终形态,5.11 的 dev proxy 三道改写同期落地。**注册表的"写入"必须在本阶段**,否则 dev proxy 无 token 来源(见 5.11);"探活复用"与"空闲退出"留 S3c。**先做前端再补校验的顺序,会把"临时加环境变量放宽后端"变成本阶段内的最短路径,而那是第 10 节明令禁止的做法** |
| **S2** | 前端变更列表 + diff2html 渲染 + 按文件懒加载联动,基础样式(Tailwind `@theme` 承载 VS Code token) | 收口时实测并回填 5.5 的产物体积表;5.10 第二层(只读 `.git` 冒烟)在此建立并入 matrix 作业 |
| **S3a** | 分支状态展示(只读) | — |
| **S3b** | 自动刷新:SSE 通道 + `.git` 非递归 watch + A / B 档 `isIgnored` 过滤 + C 档轮询 + 通用轮询兜底(5.7) | **首个交付物是"三档强制指定的内部环境变量"**——没有它,后续所有档位的验收项在单机上都无从自查 |
| **S3c** | 进程生命周期:启动时读注册表并对已记录端口做 **HTTP 探活**、命中则复用已有实例;空闲 45 秒退出 + 退出时清理注册表(5.8) | 注册表文件的**写入**已在 S1(见该行);本阶段补的是**消费**它的那一半 |
| **S4** | Diff 边界情况处理:未跟踪文件/新文件/删除/重命名标注/二进制/超大文件 + git 异常状态(空仓库、detached HEAD、rebase 进行中、worktree、bare)+ **测试数据第二批** | 5.3 的 SHA-256 空树常量在本阶段实测回填 |
| **S5** | Windows / Linux 真机验证 + 安全**加固自查**(端口选择、token 熵、CSP 实测生效、错误信息不泄漏绝对路径) | 安全**实现**已在 S1,本阶段只做真机与渗透式复核。Windows 路径与浏览器拉起、Linux 降级路径必须在真机上触发验证,CI 跑通不等于可用 |
| **S6** | 开源准备(见第 8 节) | — |

S3 拆出的三件事**按 S3a → S3b → S3c 顺序逐个收口,不得并行推进**——三者互相独立,合并推进时任一处的故障都会被另外两处的噪声掩盖。

**S0 的三项前提验证**——每一项都是某个方案能否成立的前提而非既定事实,任一项不通过都在 S0 内改方案,不带进后续阶段。**三项一律在 pnpm 的严格 node_modules 布局下执行**(见 5.11):在 npm 扁平布局下通过、换到严格布局才 resolve 失败,是这类 spike 最典型的假绿。

1. `@import "tailwindcss"` 在 Tailwind v4 构建期展开后,后续 `@import` 的内容确实保持 unlayered(5.6)。不通过则改用不引 preflight + 自写最小 reset 的备选方案
2. 深导入 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 能被 Rolldown 正确 tree-shake、hljs 实例可注入、`highlightCode()` 实际出颜色(5.5)。不通过则 S2 的整条渲染路径需重做,必须在编码开始前暴露
3. 22 个语言模块 + diff2html + hogan + jsdiff + preact 打包后的明文 / gzip 体积实测,对照 5.5 的预算。**超预算即在 S0 砍语言清单**——5.5 已写明"第一刀砍语言清单",那一刀应当落在 S2 编码之前,而不是之后

**门禁与测试数据的建立时机**:

- **5.10 主门禁(fake git wrapper 白名单断言)在 S1 与 git 封装层同阶段建立**。封装层只有一处子进程调用,断言成本极低;而它是 4.1 "零写操作"承诺在开发期唯一的自动化护栏,晚一个阶段就多一个阶段没有护栏
- **5.10 第二层(只读 `.git` 冒烟)在 S2 建立并入 matrix 作业**。需一并明确 **Windows 上该层改用只读 ACL 或显式跳过**——`chmod -R a-w` 在 Windows 无等价语义,照搬会让 matrix 的 Windows 档假绿
- **测试数据分两批**。生成脚本对测试仓库执行 `git init` 等写操作,属开发流程的 git,不受 4.1 约束(作用域见 `CLAUDE.md` 第 1 节):
  - **第一批(S1)——决定解析器结构,不是边界修补**:路径含非 ASCII 字符/空格/引号的文件、重命名(含相似度识别阈值边界)、已暂存改动(执行过 `git add`)、无上游的新建分支、空仓库(`git init` 后无提交)。这五项分别决定 5.2 的 `-z` 与 `core.quotePath=false` 是否真的生效、解析循环是有状态还是无状态平铺、`# branch.ab` 缺失的降级路径、以及 5.3 的 diff 基准该做成怎样的接口形状——S4 才引入等于 S1 先按 HEAD 写死再返工。另需一个 300+ 文件变更的仓库,S2 验收懒加载时即需就位
  - **第二批(S4)——边界与异常**:新增文件、删除文件、二进制文件变更、超过 5MB 的大文件、detached HEAD、rebase 进行中、linked worktree、bare 仓库

两批均逐项对照第 6 节验收标准验证。

## 8. 开源规划

- **License**:MIT。运行时依赖 diff2html 为 MIT、highlight.js 为 BSD-3-Clause,均兼容
- **仓库/包名**:`gitglance`(2026-07-28 复核 npm registry 返回 404,确认未占用;`git-glance` 已被他人占用 v1.0.1,仅影响搜索时的混淆,不构成冲突。GitHub 仓库名待发布前确认)
- **需要补的东西**:README(功能说明+安装步骤)、LICENSE 文件、清理硬编码的个人路径/凭据、简单的 Issue/PR 规范、semver + GitHub Releases
- **发布产物约定**:`package.json` 的 `files` 字段白名单为 `bin/`、`dist/`、README、LICENSE;`prepublishOnly` 执行完整构建;发布前用 `pnpm pack --dry-run --json` 核对产物内容,确认不含 `src/`、配置文件与测试(验收见第 6 节)。前端依赖(diff2html / highlight.js / preact)在构建期即被打进 `dist/web/app.js`,后端只用 Node 标准库,因此 **`dependencies` 为空**——用户 `npm i -g` 时零传递依赖安装,应在 README 中说明
- **`pnpm publish` 与 `npm publish` 的差异**(均已实测,见第 10 节):pnpm 默认会做 git 检查(工作区必须干净、分支需匹配),这层检查有价值、**不要用 `--no-git-checks` 关掉**;`prepublishOnly` **确实会被执行**,上一条不会落空。另注意 pnpm 打包时默认做 **manifest obfuscation**——会从发布出去的 `package.json` 里剥掉 `packageManager` 字段与 publish 生命周期脚本。这对本项目是想要的(用户侧不该看到我们的开发期工具链),**不要用 `--skip-manifest-obfuscation` 关掉**,但核对产物时要知道打出来的 `package.json` 本就与仓库里的不同,别误判为产物不干净
- **版本号约定**:首个 npm 发布版本为 **0.1.0**。在 0.x 阶段保留破坏性调整的余地(尤其是 CLI 参数与端口/token 行为),待第 6 节验收标准**全部**通过、且三端真机验证完毕后再发 **1.0.0**。不要为了"看起来正式"直接从 1.0.0 起步——本工具的核心承诺是只读与零副作用,1.0.0 应当是这些承诺被 5.10 两层验证覆盖之后的结果,而不是起点
- **平台支持**:正式支持 macOS / Windows / Linux 三端,均需测试保证可用。用 GitHub Actions 三端 runner 跑测试,并在每个平台上做人工验证。CI 版本矩阵 **Node 22 / 24 / 26** × 三平台(22 这档同时覆盖 5.7 的 B 档与 C 档);`package.json` 的 `engines.node` 声明为 `>=22.0.0`

## 9. 开发方式

- 全程使用 Claude Code 进行开发,按第 7 节 S0–S6 顺序推进
- 项目根目录维护 `CLAUDE.md`,避免开发过程中"发明"未授权的写操作或功能。**`CLAUDE.md` 是每轮会话无条件加载的常驻上下文,因此只承载摘要与路由,不承载论证** —— **至少**包含以下三部分:
  - 第 4 节 Non-goals **摘要**(4.1、4.2 两类各保留条目本身,理由删去)
  - 第 10 节「被排除的做法」中**违反后不报错、只是静默出错**的条目,压成一行式红线(只写规则,不写理由)
  - 一张「改哪块 → 动手前先读本文档哪节」的路由表,**覆盖第 5 节各小节**(5.0–5.12 每节都要有落点)

  另按实际需要承载几项同样"每轮都用得上、且不适合放进 spec"的内容,当前为:产品定位一句话、**两个 git 作用域的区分**(产品运行时的 git 受零写操作约束,开发流程的 git 不受——这条不澄清会导致工具拒绝执行本仓库的正常版本控制操作)、提交约定、常用命令表、开发阶段概览。新增此类内容前先确认它不属于"论证",论证一律留在 spec。
- **第 10 节仍是「被排除的做法」的唯一来源**,`CLAUDE.md` 不再逐条转写整表;增删禁止项只改第 10 节,避免同一条约束散落多处、改一漏二
- 每个阶段完成后,对照第 6 节中标记为本阶段的验收项自查,不堆到后期集中验证

**阶段收口判据(Definition of Done)**——一个阶段算完成,须同时满足三条:

1. 第 6 节中标记为本阶段的验收项**全部**打勾;因客观条件(如缺真机)无法当场验证的,显式记为待 S5 复核,而不是默认通过
2. `biome ci`、`tsc --noEmit`、`pnpm test`,以及截至本阶段已建立的冒烟与门禁脚本(只读性两层验证、体积、冷启动)全部为绿
3. `CLAUDE.md` 第 3 节命令表已补全本阶段新增的 `package.json` script

## 10. 附录:关键决策的依据

第 5 节中几处"排除了某个看似更自然的做法"的决策,依据记录在此,避免开发期被重新提出。核查数据首轮取自 2026-07-28,2026-07-31 完成外部复核;以下条目均为复核后现行有效的结论。

**分工约定**:第 5 节只写规则与理由,实测输出、源码引用等原始证据一律只放本节;两处不互相复述。后续修订请沿用此分工,否则同一事实很快会出现多份拷贝。

### git 行为

- **空仓库下的 git 行为**:`git diff HEAD` → `fatal: ambiguous argument 'HEAD'`;`git rev-parse --verify HEAD` → exit 128;而 `git status --porcelain=v2 --branch` 正常返回(`# branch.oid (initial)`),`git diff <empty-tree>` 正常返回。这是 5.3 用空树哈希替代 HEAD 的直接依据
- **空树 SHA-1 常量**:`git hash-object -t tree --stdin < /dev/null` → `4b825dc642cb6eb9a060e54bf8d69288fbee4904`。另注意 `git rev-parse --show-object-format` 随 SHA-256 支持(2.29 前后)才引入,高于 5.2 声明的 git 下限 2.11,这是 5.3 要求"非零退出即按 SHA-1 处理"的依据
- **porcelain 的路径转义**:不加 `-z` 时,`docs/需求文档.md` 会被输出成 `"docs/\351\234\200\346\261\202\346\226\207\346\241\243.md"`;加 `-z` 后原样输出。这是 5.2 强制要求 `-z` 的依据
- **`git diff` 补丁正文的路径转义**:`-z` 只作用于 `status` / `numstat` 等列表输出,`git diff` 正文的 `diff --git` / `---` / `+++` / `rename from|to` 行仍会 C 风格转义(实测输出 `diff --git "a/docs/\351\234\200\346\261\202\346\226\207\346\241\243.md" ...`);加 `-c core.quotePath=false` 后原样输出。这是 5.2 强制该参数的依据
- **重命名在按文件懒加载下的退化**:实测 `git diff HEAD -- <新路径>` 对重命名文件输出 `new file mode` + `--- /dev/null`(识别为全新增);`git diff HEAD -M -- <新路径> <旧路径>` 才输出 `similarity index` + `rename from/to`。这是 5.2 要求传两个路径的依据
- **`porcelain=v2 -z` 的重命名记录格式**:实测为 `2 <XY> ... R100 <新路径>\0<旧路径>`,一条记录占两个 NUL 段;另实测无上游分支时不输出 `# branch.ab` 行。这是 5.2 两个解析陷阱的依据

### Node 运行时与 `fs.watch`

- **Node 版本窗口**(复核 `nodejs/Release` 的 `schedule.json`):20 = **已 EOL(2026-04-30)**;22 = Maintenance LTS(2024-04-24 发布、2024-10-29 转 LTS、**2025-10-21 起进入 maintenance**,EOL 2027-04-30);24 = Active LTS(2025-05-06 起,2025-10-28 转 LTS,EOL 2028-04-30);26 = Current(2026-05-05 起,2026-10-28 转 LTS,EOL 2029-04-30)。本项目下限取 **22.0.0**:22 仍受支持且装机量大,20 已 EOL 不予支持。注意 24 转 LTS(2025-10-28)与 24.14.0 发布(2026-02-24)相隔近四个月,把下限钉在 24.14.0 会误伤大量停留在 24.0–24.13 的 LTS 用户——这是下限没有跟随 `ignore` 的直接原因,`ignore` 改为只决定 5.7 的档位
- **`fs.watch` 的 `ignore` 选项**:Node **24.14.0**(2026-02-24)引入,PR [#61433](https://github.com/nodejs/node/pull/61433);`doc/changelogs/CHANGELOG_V24.md` 的 `2026-02-24, Version 24.14.0 'Krypton' (LTS)` 一节内含 `(SEMVER-MINOR) fs: add ignore option to fs.watch (Matteo Collina) [#61433]`。核对 `lib/internal/fs/recursive_watch.js` 确认,Linux 用户态递归实现里它是**注册前跳过**(源码注释:`Skip watching ignored paths entirely to avoid kernel resource pressure`),而非回调后过滤;macOS / Windows 的原生 watcher 中则是回调过滤(`lib/internal/fs/watchers.js`)。`createIgnoreMatcher` 除字符串 / 正则外**也直接接受 Function**(收下即用,不做包装),故函数写法是官方支持的用法而非绕路。另核对 Node 22.x 的 `doc/api/fs.md`(复核 v22.23.2 文档)确认其中**无 `ignore` 选项**,故 22 上无法通过任何写法取得等价行为。这是 5.7 分三档、并把 Linux 低版本判到 C 档的直接依据。(另注:v24.x 的 `fs.watch` 文档新增了 `throwIfNoEntry` 选项——24.16.0,PR #61870——本项目用不到)
- **minimatch `matchBase` 的实际语义**:核对 Node 打包的 `deps/minimatch/index.js`,匹配主循环是 `if (options.matchBase && pattern.length === 1) { file = [filename] }`——**仅当模式为单段时,把整条路径替换成 basename 再比**。据此:
  - Linux 侧 `recursive_watch.js` 的 `#watchFolder` 对**每个遍历条目**的 `relativePath` 调用匹配器,走到条目 `node_modules` 自身时 basename 即命中 → 注册前跳过,字符串模式碰巧成立
  - macOS / Windows 侧 `watchers.js` 是拿**事件的相对路径**(如 `node_modules/.bin/foo`)调用匹配器,basename 为 `foo`,模式 `node_modules` 匹配不上 → 过滤完全失效
  - 这是 5.7 把 `IGNORE` 定为逐段匹配函数而非字符串模式、并单列 A 档 macOS/Windows 过滤验收项的依据
- **Linux 用户态递归监听的实际开销**:`lib/fs.js` 中 `recursive && !isMacOS && !isWindows` 时走 `internal/fs/recursive_watch.js`;核对其 `#watchFolder`,它对遍历到的**每个目录项(含普通文件)**都调用 `#watchFile` 注册 watch,并非只对目录注册;且初次遍历时对每个条目 `emit('change','rename',...)`,启动即产生事件风暴。这是 5.7 判定配额风险、并把 debounce 列为必需项的依据
- **`os.tmpdir()` 的权限差异**:macOS 上为每用户 0700 私有目录(实测 `/var/folders/.../T` mode 700),Linux 上为 `/tmp`(1777,同机其他用户可读)。这是 5.8 要求注册表文件 `0o600` 的依据

### 前端渲染与体积

- **diff2html bundle 体积**(取自官方 CDN):全量包 `diff2html-ui.min.js` 1,048,945 B;slim 包 `diff2html-ui-slim.min.js` 301,714 B;`diff2html-ui-base.min.js` 90,167 B;`diff2html.min.css` 17,331 B。依赖版本 diff2html 3.4.56、highlight.js 11.11.1。三个预构建 UI bundle 均已排除,见下方「被排除的做法」表首行;此处仅作体积参照
- **`html()` 不含语法高亮**:核对 `lib-esm/ui/js/diff2html-ui-base.js`,高亮由 `Diff2HtmlUI.highlightCode()` 完成,依赖 `./highlight.js-helpers` 的 `closeTags` / `nodeStream` / `mergeStreams` / `getLanguage`;`draw()` 内部为 `targetElement.innerHTML = …` 后逐项绑定事件。模块明文体积:`diff2html-ui-base.js` 7,252 B、`highlight.js-helpers.js` 13,699 B、`diff2html.js` 1,556 B、`diff2html-templates.js` 12,711 B。diff2html 的 `package.json` **无 `exports` 字段**,深导入合法。这是 5.5 允许深导入 ui-base 源码模块的依据
- **hljs 的三个"语言"实际不存在**:`highlight.js@11.11.1/es/languages/{jsx,tsx,toml}.js` 实测均 404;`ini.js` 中 `aliases: ['toml']`、`javascript.js` 中 `aliases: ['js','jsx','mjs','cjs']`、`typescript.js` 含 `tsx`。这是 5.5 语言清单定为 22 个真实模块的依据
- **语言子集体积实测**(`es/languages/*.js` 明文,22 个模块):swift 22,517 / typescript 21,359 / scss 19,468 / css 18,884 / javascript 17,756 / php 14,425 / cpp 12,689 / sql 11,990 / ruby 9,944 / python 9,190 / csharp 8,562 / c 8,292 / kotlin 7,464 / xml 7,007 / bash 6,523 / java 6,233 / rust 6,130 / markdown 5,253 / yaml 5,022 / go 3,195 / ini 2,352 / json 1,343 B,**合计 225,598 B**;`es/core.js` 仅 202 B(入口再引内部模块)。压缩后约 130 KB / gzip 约 40 KB,是 5.5 JS 门禁的主导项
- **hljs 主题 CSS 的必要性**:实测 `diff2html.min.css` 中含 hljs 的规则数为 **0**,预构建 slim 包也只含 hljs 运行时与语言定义、不含配色。需另引 `highlight.js/styles/*.css`(**体积数取自 min 版**:`github.min.css` 1,309 B、`github-dark.min.css` 1,315 B,合计约 2.6 KB;5.6 的 `@import` 写的是非 min 的 `github.css` / `github-dark.css`,构建期由 Vite 压缩,最终产物对齐 min 版口径)。这是 5.5 体积表补两行的依据
- **diff2html 模板中的内联 `style=` 出现 0 次**(`lib-esm/diff2html-templates.js` 实测);`draw()` 改样式走 CSSOM(`el.style.display = …`),不受 CSP 约束。这是 5.9 严格 CSP 不需要 `'unsafe-inline'` 的依据
- **前端框架体积量级**:Preact 运行时约 4 KB gzip,React 19 + ReactDOM 约 42 KB gzip,Svelte 5 编译后运行时约 2-5 KB。Svelte 的劣势在工具链而非体积——Biome 2.x 对 `.svelte` 仅覆盖 `<script>` 块,模板与样式仍需 Prettier + `prettier-plugin-svelte`,与 5.11 "一个二进制一份配置" 的取向冲突。这是 5.4 选 Preact 的依据

### 样式层叠

- **Tailwind preflight 与 diff2html 的冲突面**:实测 `tailwindcss@4.3.3/preflight.css`(8,489 B)与 `diff2html@3.4.56/bundles/css/diff2html.min.css`(17,331 B)。preflight 会做 `*{box-sizing:border-box;margin:0;padding:0;border:0 solid}`、`table{border-collapse:collapse}`、`h1-h6{font-size:inherit;font-weight:inherit}`、`button,input{font:inherit;border-radius:0}` 等重置;而 diff2html **自带**了所有关键声明——`.d2h-diff-table{border-collapse:collapse}`、`.line-num1`/`.line-num2`/`.d2h-code-linenumber`/`.d2h-code-side-linenumber` 均含 `box-sizing:border-box`、边框写作 `border:solid var(--d2h-line-border-color);border-width:0 1px`(类选择器特异性 0,1,0 稳压 preflight 的 0,0,0),`.d2h-file-list{list-style:none;margin:0;padding:0}` 亦自声明。唯一实质差异是 `<td>` 的 1px UA 默认 padding 被清零,反使跨浏览器渲染更一致。这是 5.6 决定引入完整 preflight 的依据
- **层叠层优先级**:CSS Cascade Layers 规定**无层(unlayered)的常规声明优先级高于任何层内的常规声明,与特异性无关**;Tailwind v4 将 preflight 置于 `@layer base`、工具类置于 `@layer utilities`。因此把 hljs 主题与 `diff2html.min.css` 以 unlayered 形式引在其后,即可结构性地保证不被 preflight 压过——代价是它们同样会压过 Tailwind 工具类。这是 5.6 层叠方案与"只能改 `--d2h-*` 变量"约束的共同依据
- **hljs 两份主题都不含 `@media`**:`styles/github.css` 与 `styles/github-dark.css` 实测 `@media` 出现次数均为 **0**,两者都是无条件 `.hljs { … }` 规则。这是 5.6 给深色那份加 `(prefers-color-scheme: dark)` 媒体条件的依据

### 工具链与发布

- **工具链版本与 engines**(npm registry 实测):`vite` 8.2.0(engines `^20.19.0 || >=22.12.0`)、`typescript` 7.0.2、`tailwindcss` / `@tailwindcss/vite` 4.3.3、`preact` 10.29.7、`@preact/signals` 2.10.1、`@biomejs/biome` 2.5.6、`lefthook` 2.1.10、`tsdown` 0.22.14(engines `^22.18.0 || >=24.11.0`)、`vitest` 4.1.10、`diff2html` 3.4.56、`highlight.js` 11.11.1。**注意 `tsdown` 与 `vite` 的 Node 要求均高于产品运行时下限 22.0.0**,这是 5.11 把 CI 拆成 build / matrix 两层的直接依据
- **peer 依赖相容性**(npm registry 实测):`@tailwindcss/vite@4.3.3` 的 peer 为 `vite: ^5.2.0 || ^6 || ^7 || ^8`、`@preact/signals@2.10.1` 的 peer 为 `preact: >= 10.25.0`、`vitest@4.1.10` 的 peer 含 `vite ^8`,三者与本项目选型相容。`highlight.js` 的 `exports` 把 `./lib/core`、`./lib/languages/*` 映射到 ESM(`es/`),`./styles/*` 亦已导出;`@profoundlogic/hogan@3.0.4` 只有 CJS 入口(`main`,无 `module` / `exports`)
- **TypeScript 7 的状态与二进制名**:Go 原生编译器于 **2026-07-08** 稳定发布(7.0.2 为 latest);已知 7.x 的命令行 declaration emit 仍在完善中,本项目只用 `--noEmit` 做类型检查、转译交给 Vite / tsdown,不触及该短板。`typescript@7.0.2` 的 `bin` 字段实测为 `{"tsc": "bin/tsc"}`——**命令是 `tsc` 不是 `tsgo`**;`tsgo` 是预览包 `@typescript/native-preview` 的二进制名(该包仍在发布,latest `7.0.0-dev.20260707.2`),稳定版并入 `typescript` 主包后二进制名回归 `tsc`
- **`@types/node` 的 latest 是 26.1.2**,与产品运行时下限 22.0.0 相差四个大版本。锁 `^22` 是 5.1 API 上限守卫成立的前提,不锁则 TS 会放行 Node 24+ 才有的内置 API
- **CSP 指令的回退规则**:`frame-ancestors` / `base-uri` / `form-action` 均**不回退到 `default-src`**,`default-src 'none'` 对它们无效,须显式声明。这是 5.9 补这三个指令的依据
- **冷启动实测**:node 启动 + `http.listen` + 一次 `git status --porcelain=v2 --branch -uall -z` 全程约 **30ms 墙钟**(裸 node 启动约 10-30ms),300ms 预算充裕
- **npm 包名**:`gitglance` registry 返回 404,未被占用;`git-glance` 为他人 1.0.1,仅影响搜索时的混淆,不构成冲突
- **pnpm 相关事实**(2026-08-06 就本机 pnpm 11.20.0 逐条实测 + 官方迁移文档复核;此前本组曾按 pnpm 10 撰写并标记"尚未实测",其中一条已证伪,见下):
  - **版本**:latest 为 **11.20.0**,`packageManager` 即钉此版本。**pnpm 11 相对 10 有三处破坏性变更,恰好全部打在 5.11 的配置面上**,因此本项目按 11 而非 10 落地
  - **`onlyBuiltDependencies` 在 pnpm 11 已被移除**:与 `neverBuiltDependencies` / `ignoredBuiltDependencies` / `onlyBuiltDependenciesFile` / `ignoreDepScripts` 一并合并为单一的 **`allowBuilds`** map 设置(`{ 包名: true | false }`)。这是 5.11 白名单写法的直接依据
  - **配置文件位置**:pnpm 11 **不再读 `package.json` 的 `pnpm` 字段**,也**不再把 `.npmrc` 当通用设置文件**(只留 registry 与鉴权);pnpm 专有设置一律走 `pnpm-workspace.yaml`(或全局 `~/.config/pnpm/config.yaml`),原 `.npmrc` 的 kebab-case 键改为 camelCase。**写错位置不报错、无 deprecation 警告,只是设置静默不生效**(pnpm/pnpm#11536 记录了 `pnpm.overrides` / `pnpm.patchedDependencies` 被静默忽略的实例)。另注意环境变量前缀由 `npm_config_*` 改为 `pnpm_config_*`
  - **`pnpm pack` 有 `--dry-run`**(实测 `pnpm pack --help`),另有 `--json` 可直接以 JSON 打印 tarball 内容清单。**此条修正了本节此前"`pnpm pack` 无 `--dry-run`"的错误断言**,第 6 节与第 8 节的产物核对口径随之改回 `--dry-run --json`,不必实际落 tarball
  - **`pnpm publish` 的 git 检查**:默认要求工作区干净、分支匹配(`--no-git-checks` 可关,但不关),`npm publish` 无此行为。**`prepublishOnly` 确实会被执行**——`--ignore-scripts` 的帮助文本为 "Ignores any publish related lifecycle scripts (prepublishOnly, postpublish, and the like)"、`--force` 的帮助文本提到 "useful when a `prepublishOnly` script bumps the version",两处互证。另:pnpm 11 起 `publish` / `login` / `view` 等不再委托 npm CLI,改为原生实现
  - **manifest obfuscation**:`pnpm pack` / `publish` 默认从打包出的 `package.json` 剥离 `packageManager` 字段与 publish 生命周期脚本(`--skip-manifest-obfuscation` 可关)。这是第 8 节提醒"核对产物时别把这份差异误判为不干净"的依据
  - **Corepack 的去留**:Node TSC 已投票停止随发行版分发 Corepack,**Node 25+ 的官方发行版不再自带**(24 及以前仍带),需要时改为 `npm i -g corepack`。CI 矩阵含 Node 26,因此这是 5.11 选 `pnpm/action-setup` 而非 `corepack enable` 的直接依据

**被排除的做法**

| 做法 | 排除原因 |
|---|---|
| 用任何 diff2html 预构建 UI bundle(`-ui` 全量 1.05 MB / `-ui-slim` 302 KB / `-ui-base` 90 KB) | 全量包体积明显超预算;slim 包含大量用不到的语言定义。三者的存在理由(无构建环境下只能整包引入)在引入构建链路后已消失,改为按需 import + 显式注册语言子集,产物更小且语言清单可控(详见 5.5)。**被排除的是三个预构建 bundle,不是 UI 层源码**——深导入 ESM 模块 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 参与 tree-shaking、hljs 由我们注入,是允许且推荐的 |
| 自行重写 diff2html 的高亮切分逻辑 | `html()` 不含语法高亮,高亮在 `Diff2HtmlUI.highlightCode()` 里,需要把整文件高亮结果按 diff 行边界切回并补齐跨行未闭合标签(`closeTags` / `nodeStream` / `mergeStreams`)。上一行既已允许深导入源码模块,自研等于维护一份更易出错的等价物(详见 5.5) |
| 单独 import `highlight.js/lib/languages/{jsx,tsx,toml}` | 这三个模块不存在(实测 404),它们是 `javascript` / `typescript` / `ini` 的**别名**,注册主模块时自动生效。写了会在构建期 resolve 失败(详见 5.5) |
| 把两份 hljs 主题 CSS 平铺 import | 两者都是无条件的 `.hljs { … }`、自身零 `@media`,后引入者无条件覆盖前者,浅色主题直接失效。深色那份必须带 `(prefers-color-scheme: dark)` 媒体条件(详见 5.6) |
| 未跟踪文件用 `git diff --no-index` | 依赖 `/dev/null` 作对比端,Windows 上不可移植 |
| 空树哈希用 `git hash-object -t tree /dev/null` | 同上,`/dev/null` 不可移植;`git mktree` 则会写对象库,违反只读承诺 |
| Linux 上直接用不带 `ignore` 的 `fs.watch({recursive:true})` | Node 在 Linux 是用户态实现,逐条目(含普通文件)注册 inotify 且不做排除,会耗尽 `max_user_watches` 并波及用户机器上的其他工具(详见 5.7)。**这正是 5.7 的 C 档在低版本 Linux 上宁可退回轮询、也不建递归 watch 的原因** |
| Linux 上自行遍历目录树逐个注册 watch(手写一份递归监听) | Node 24.14.0 的 `ignore` 在 Linux 上即为注册前跳过,官方能力已覆盖该需求;自行实现等于维护一份更易出错的等价物。**被排除的是"手写 Linux 递归注册"这件事,不是"按平台/Node 版本选择策略"**——后者正是 5.7 三档方案本身 |
| 用 try/catch 或传入选项后观察行为来探测 `ignore` 是否可用 | 探测要成立,得依赖"支持的版本上传非法 `ignore` 会抛 `ERR_INVALID_ARG_TYPE`、不支持的版本上因选项被忽略而不抛"这一**内部实现细节**——它不是文档承诺的行为,一次校验时机调整就会让探测反过来把 A 档误判成 C 档、或把 C 档误判成 A 档。而后者在 Linux 上正是上面第一行被禁止的无 `ignore` 递归 watch,静默耗尽用户机器的 inotify 配额。`process.versions.node` 的 semver 比对与官方"自 24.14.0 起可用"的承诺一一对应,无此风险 |
| B 档把 `isIgnored` 过滤放在 debounce 之后 | 过滤的目的是不让 `node_modules` 的写入噪声顶开 debounce 窗口;放在其后则窗口照样被反复重置、刷新照旧触发,过滤形同虚设 |
| `ignore` 模式写成 `node_modules/**` 等含斜杠形式 | 含斜杠会使 minimatch 的 `matchBase` 失效:既匹配不到 `node_modules` 目录自身,也匹配不到 monorepo 中嵌套的 `packages/*/node_modules`,过滤形同虚设 |
| `ignore` 传不含斜杠的字符串 basename 模式 | `matchBase` 只在模式为单段时把整条路径替换成 basename 再比,而 macOS / Windows 的原生 watcher 交给匹配器的是事件的**相对路径**(`node_modules/.bin/foo` → basename `foo`),模式 `node_modules` 匹配不上,过滤在这两个平台上完全失效(Linux 因为是对遍历条目本身求值才碰巧成立)。必须传**逐段匹配函数**,三档共用(详见 5.7) |
| 降级轮询用裁剪过参数的 `git status`(如省掉 `-uall` / `--branch`) | 省掉 `-uall` 后 git 把未跟踪目录折叠成一行 `dir/`,**在一个已存在的未跟踪目录里新增文件不改变输出**,轮询判定"无变化"、页面静默不刷新——而这正是 agent 边跑边生成文件时最常见的形态;省掉 `--branch` 则丢掉提交与切分支的检测。轮询与主查询必须是逐字相同的一条命令(详见 5.7 / 5.2) |
| 只靠 `-z` 解决路径转义 | `-z` 管不到 `git diff` 补丁正文的头部行,非 ASCII 路径仍会显示为 `\351\234\200` 转义串,须叠加 `-c core.quotePath=false`(详见 5.2) |
| 重命名文件按单路径取 diff | git 只看到一侧无法配对,重命名会退化成全新增文件,"重命名识别并标注"落空(详见 5.2) |
| 单实例注册表写进 `.git/` 或工作区 | 污染 `git status`,实质违背零写操作承诺 |
| 陈旧实例用 pid 存活判断 | pid 会被系统复用,误判会把用户带到指向别人进程的页面 |
| 仅用 token 防 DNS rebinding | token 挡不住同源判定本身,正面防御是校验 `Host` 头(详见 5.9) |
| 用"前后 `git status` 比对"验证只读性 | 发现不了写进 `.git/` 但不改变 status 输出的操作(详见 5.10) |
| 用 Tailwind 工具类覆盖 diff2html 渲染出的内部元素 | diff2html 的 CSS 是 unlayered,在层叠中胜过 `@layer utilities`,工具类写了不生效。改配色只能覆写 `--d2h-*` CSS 变量(详见 5.6) |
| 把 hljs 主题或 `diff2html.min.css` 放进 `@layer` | 一旦入层就与 Tailwind preflight 同处层叠体系,"无层胜有层"这层结构性保障随即失效,重新退回逐条比特异性的脆弱状态(详见 5.6) |
| 让 `bin/gitglance.js` 参与 TS 编译或作为打包入口 | 可能被注入超出 Node 22 的语法、或被合并进主模块,低于下限的用户拿到解析期 SyntaxError,5.1 的版本守卫在解析期即失效 |
| 为本地开发在后端加放宽 Host / Origin / token 校验的环境变量或分支 | 等于把 5.9 的正面防御做成一个可被误开的开关。dev server 的跨源问题应在代理层改写请求头解决,后端零 dev 分支(详见 5.11) |
| 依赖 Node 原生 type stripping 直接运行 `.ts` 产品代码 | 会把运行时下限从 22.0.0 顶到 22.18(type stripping 在 22 线的可用版本),与 5.1 覆盖 Node 22 全线的取舍冲突;且每次启动都要付一次转换开销,挤占第 6 节的 300ms 冷启动预算。产品代码一律发布为已转译的 JS |
| pnpm 开 `shamefullyHoist: true` 或 `nodeLinker: hoisted` | 用扁平化掩盖 phantom dependency:本机构建通过,换到别人机器、CI 或改依赖版本后才 resolve 失败,而那时问题已离开引入它的那次改动。严格布局暴露的正是必须暴露的问题——5.5 深导入 diff2html 内部模块的方案更需要这层校验 |
| 把 pnpm 设置写进 `package.json` 的 `pnpm` 字段或 `.npmrc` | pnpm 11 两处都不再读取,**且是静默忽略、无 deprecation 警告**。后果不是报错而是"约束看起来写了、实际没生效"——`allowBuilds` 写错位置即等同于没写(hooks 静默不装),禁止扁平化的设置写错位置即等同于没禁。全部 pnpm 设置只放 `pnpm-workspace.yaml`(详见 5.11) |
| matrix 作业用 `pnpm install --prod` 之类的"装一点点"代替完全不装 | 仍会建 `node_modules`、且要求每个 matrix 机器上有 pnpm,而该作业的全部意义是**只跑用户真正拿到的 `dist/` 产物**;一旦装了东西,测的就不再是那个东西,5.11 拆两层 CI 的理由随之落空 |
| 靠 `corepack enable` 在 CI 里准备 pnpm | Corepack 正在从 Node 发行版剥离,而 CI 矩阵含 Node 26;哪天基础镜像不再自带,这一步就从"能用"变成失败或静默走到系统里的另一个 pnpm 版本。用 `pnpm/action-setup` 读 `packageManager` 字段(详见 5.11) |

**外部参考**

- [Node.js `fs.watch` 文档:recursive 支持范围与 Caveats](https://github.com/nodejs/node/blob/v24.x/doc/api/fs.md)
- [nodejs/Release `schedule.json`:各版本 LTS / 维护期 / EOL 日期](https://github.com/nodejs/Release/blob/main/schedule.json)
- [nodejs/node PR #45098:为 Linux 添加 recursive watch](https://github.com/nodejs/node/pull/45098)
- [nodejs/node PR #61433:为 `fs.watch` 添加 `ignore` 选项(Node 24.14.0)](https://github.com/nodejs/node/pull/61433)
- [nodejs/node `lib/internal/fs/recursive_watch.js`:Linux 用户态递归监听实现](https://github.com/nodejs/node/blob/v24.x/lib/internal/fs/recursive_watch.js)
- [递归 watch 逐目录注册 inotify、无排除导致耗尽内核配额的实例](https://github.com/colbymchenry/codegraph/issues/276)
- [diff2html README:bundle 用法与配置项](https://github.com/rtfpessoa/diff2html)
- [Vite 8.0 发布公告:Rolldown 成为默认 bundler](https://vite.dev/blog/announcing-vite8)
- [Tailwind CSS v4.0 发布公告:Oxide 引擎与 CSS-first `@theme` 配置](https://tailwindcss.com/blog/tailwindcss-v4)
- [MDN:CSS Cascade Layers —— 无层声明与层内声明的优先级](https://developer.mozilla.org/en-US/docs/Web/CSS/@layer)
- [tsdown 文档:面向库的 Rolldown 打包器](https://tsdown.dev/guide/)
- [Biome 文档:formatter 与 linter](https://biomejs.dev/)
- [pnpm v10 → v11 迁移指南:`allowBuilds`、配置文件位置变更](https://pnpm.io/migration)
- [pnpm 11.0 发布说明:破坏性变更清单](https://pnpm.io/blog/releases/11.0)
- [pnpm/pnpm#11536:pnpm 11 静默忽略 `package.json` 的 `pnpm` 字段](https://github.com/pnpm/pnpm/issues/11536)
- [Node.js TSC 投票停止随发行版分发 Corepack](https://socket.dev/blog/node-js-tsc-votes-to-stop-distributing-corepack)
- [Node.js Release Working Group:LTS 时间表](https://github.com/nodejs/Release)
