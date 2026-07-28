# GitGlance — 需求文档

> **产品名**:GitGlance(glance = 一瞥,意指快速看一眼代码变更、分支状态,不做复杂操作)
> **一句话定位**:一眼看懂 AI 编码 Agent 改了哪些代码——CLI 启动、本地网页展示,只读查看当前工作区的 diff 与分支状态,冷启动和资源占用做到最轻。
>
> **文档修订**:rev.1 · 2026-07-28 —— 编码开始前的基线版本,技术选型已逐条实测核查(关键结论与依据见第 10 节)
>
> 此处为**需求文档自身的修订号**,与产品版本、npm 包版本无关。发布版本的约定见第 8 节。

---

## 1. 背景与目标

开发者使用编程 agent 完成开发任务后,需要快速看一眼代码变更了什么、当前分支状态如何。这个诉求本质是"瞥一眼",不是"审查会话"——只需要在 agent 跑的过程中或跑完之后,随手确认改动内容。**查看当前工作区的 diff 和分支状态是最高频动作**,每次 agent 完成任务后都会用到。

**形态:纯只读,零写操作**。工具在终端敲一条命令启动,自动打开浏览器展示当前仓库的变更,看完关掉标签页即可,进程随后自行退出,不常驻占用资源。

## 2. 目标用户与分发

核心用户:使用 AI coding agent 后,需要快速查看当前代码变更的开发者,跨平台(macOS / Windows / Linux)使用。

分发方式:npm 包,`npm i -g gitglance` 全局安装(推荐)或 `npx gitglance` 直接试用。目标用户使用 AI coding agent,机器上必然已有 Node 环境,无需额外提供免运行时的分发形态。

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

**Node.js + 纯 DOM/原生 JS + diff2html**

### 5.1 运行时与后端

- **运行时**:Node.js,**最低支持 Node 24.14.0**。选型首要考量是生态成熟度与 Windows 上系统调用(`child_process` 执行 git、`fs.watch` 文件监听)的稳定性——本项目重度依赖这两块。下限之所以定在 24.14.0 而不是更低的 Node 22,是因为 `fs.watch` 的 `ignore` 选项自 24.14.0 起才可用(2026-02-24 发布),而它是 5.7 自动刷新方案的基石——有它才能三端统一、免去 Linux 的手写监听分支(依据见 5.7 与第 10 节)。Node 24 为 Active LTS(EOL 2028-04);CI 矩阵覆盖 **24 / 26** 两个版本 × 三个平台
- **后端实现**:仅使用 Node 标准库(`node:http`、`node:child_process`、`node:fs`),不引入 HTTP 框架——路由需求仅几个只读接口,标准库足够

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
- **未跟踪文件**不在任何 `git diff` 输出内,需从 `git status` 取列表后单独构造 diff。**明确采用「直接读取文件内容手工构造 unified diff」方案**(输出 `--- /dev/null` / `+++ b/<path>`,全部行标记为新增),**不使用 `git diff --no-index`**——后者依赖 `/dev/null` 作为对比端,在 Windows 上不可移植。手工构造路径需自行做 NUL 字节探测(判定二进制)+ 5MB 体积阈值 + 行数上限
- **二进制与大文件的判定来源**:已跟踪文件一律以 `git diff HEAD --numstat` 的输出为准(二进制文件输出 `-\t-\t<path>`),这是 git 自身含 `.gitattributes` 配置的判定结果,比启发式探测准确;文件体积用 `fs.stat`。只有未跟踪文件才走 NUL 字节探测
- **仓库定位**:统一用 `git rev-parse --show-toplevel` 定位工作区、`git rev-parse --git-dir` 定位 git 目录。**不得假设 `.git` 是目录**——linked worktree 下 `.git` 是一个文件,submodule 同理;bare 仓库(无工作区)给出明确的拒绝提示而非崩溃
- **启动前置检查**:`git` 不在 PATH、当前目录不是 git 仓库、git 版本低于 2.11(`--porcelain=v2` 的最低要求),三种情况均给出一句话友好报错,而不是抛 Node 异常栈

### 5.3 git 异常状态

- **空仓库**(尚无任何提交)下 HEAD 不存在,`git diff HEAD` 会直接 fatal(已实测确认)。降级方式:改用**空树对象哈希**作为 diff 基准,`git diff <empty-tree>` 在空仓库下正常返回,无需为此写特殊分支逻辑。空树哈希按 `git rev-parse --show-object-format` 区分 SHA-1 / SHA-256 两个常量硬编码;**不要**用 `git hash-object -t tree /dev/null`(`/dev/null` 在 Windows 不可移植),也**不要**用 `git mktree`(会写对象库,违反只读承诺)
- detached HEAD、rebase/merge 进行中等状态需保证不崩溃,分支状态展示做相应降级并明确标注当前处于何种状态

### 5.4 前端

纯 HTML + 原生 JS + CSS,不引入前端框架与构建链路——当前功能范围(变更列表 + Diff 视图 + 分支状态只读展示)状态复杂度低,省去构建步骤能进一步减小体积、加快启动。

### 5.5 Diff 渲染与体积

[diff2html](https://github.com/rtfpessoa/diff2html) 直接解析 `git diff` 的 unified diff 文本渲染为带高亮的 HTML,配合 [highlight.js](https://highlightjs.org/) 做语法高亮。直接复用 git 原始 diff 算法,不需要额外维护对比逻辑。

**明确采用 `diff2html-ui-slim.min.js` 预构建包**(内含 hljs 常用语言子集),随包本地分发,**不走 CDN**——工具必须离线可用。官方各 bundle 实测体积:

| 文件 | 体积 | 取舍 |
|---|---|---|
| `diff2html-ui.min.js`(全量,含全语言 hljs) | 1.05 MB | ❌ 明显超出体积预算 |
| **`diff2html-ui-slim.min.js`**(含常用语言 hljs) | **302 KB** | ✅ **采用**,开箱即用,无需自行注册语言 |
| `diff2html-ui-base.min.js`(不含 hljs) | 90 KB | 需自行注入 hljs 实例,维护成本更高 |
| `diff2html.min.css` | 17 KB | ✅ 采用 |
| `highlight.js/styles/github.min.css` | 1.3 KB | ✅ 采用(浅色主题) |
| `highlight.js/styles/github-dark.min.css` | 1.3 KB | ✅ 采用(深色主题) |

前端总计约 **323 KB**。

**注意 hljs 的配色主题需要单独引入**:slim 包只内含 highlight.js 的**运行时与语言定义**,`diff2html.min.css` 里**没有任何 hljs 配色规则**(已实测,见第 10 节),只引它语法高亮不会出颜色,必须另行本地分发 highlight.js 的主题 CSS。按 diff2html 官方 README 的要求,**hljs 主题 CSS 必须排在 `diff2html.min.css` 之前引入**,否则会被覆盖。

diff2html 自身另有两个传递依赖(`diff`、`@profoundlogic/hogan`),使用预构建 bundle 时它们已被打进产物,不影响运行时。

### 5.6 UI 样式

CSS 变量参照 VS Code 颜色 token 命名与数值(如 `editor.background`),复刻 Dark+/Light+ 主题观感,轻量优先于视觉还原度。

### 5.7 自动刷新:三端统一 `recursive + ignore` + 轮询兜底

需要规避的风险:Node 在 **Linux 上的 `fs.watch({recursive:true})` 是用户态实现**——自己遍历目录树逐个注册 inotify watch,且**对每个普通文件也注册一个**,不止目录(已核对源码,见第 10 节)。monorepo 下 `node_modules`、`.git/objects`、`target/` 会贡献绝大多数条目,足以耗尽内核 `fs.inotify.max_user_watches`,之后**整机所有依赖 inotify 的工具都开始报 ENOSPC,包括用户自己的编辑器**。这是本工具唯一可能对用户机器造成的外部副作用,与"零副作用只读工具"的核心承诺直接冲突,必须规避。

**解法:使用 `fs.watch` 的 `ignore` 选项,三端统一,不做平台分流。** `ignore` 自 Node 24.14.0 起可用,在 Linux 的用户态递归实现里是**注册前跳过**而非回调后过滤(已核对源码,见第 10 节),正是上述配额问题的官方解法。macOS / Windows 走原生 FSEvents / `ReadDirectoryChangesW`,`ignore` 在那里退化为回调过滤,但两个平台本就没有配额问题,行为一致性不受影响。

- **工作区**:一次 `fs.watch(repoRoot, { recursive: true, ignore: IGNORE }, cb)` 即可
- **`IGNORE` 必须写成不含斜杠的 basename 形式**,如 `['node_modules', '.git', 'dist', 'target', '.next', 'build']`。原因是 Node 对字符串模式启用了 minimatch 的 **`matchBase`**:不含斜杠的模式匹配任意深度的同名条目,monorepo 下 `packages/a/node_modules` 一并命中,且**能匹配到目录自身**,因而在递归进入之前就被跳过。**不要写成 `node_modules/**`**——含斜杠会使 `matchBase` 失效,既匹配不到目录本身(白白进去一层),也匹配不到嵌套路径。另注意该匹配不支持 `!` 取反(`nonegate`),macOS / Windows 上大小写不敏感
- **`.git` 内部**:上面已把 `.git` 整个排除,因此仍需对 `HEAD`、`index`、`refs/`、`MERGE_HEAD` / `rebase-*` 所在**目录**单独建**非递归** watch,否则检测不到提交与切分支。**绝不递归 `.git/objects`**
- **兜底**:任一路径失败(ENOSPC / ENOSYS / 网络盘 NFS·SMB / Docker 卷)自动降级为 **1.5s 轮询 `git status --porcelain=v2 -z`**,并在 UI 上标注降级模式。`ignore` 解决的是配额,救不了这些场景,**兜底不可省略**

另有三条 Node 官方文档载明的行为约束:

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

### 5.10 只读性的验证方式

4.1 的"零写操作"是产品核心承诺,需要能自动化证伪,而不是靠人工审查代码。**"前后 `git status` 比对无变化"强度不足**——它发现不了写进 `.git/` 但不改变 status 输出的操作(意外触发 gc、写 index、创建对象)。因此采用两层验证,均纳入 CI 门禁:

1. **主门禁**:测试期间用 fake git wrapper 劫持所有 git 调用并记录完整子命令,断言只出现只读白名单(`status` / `diff` / `rev-parse` / `ls-files` / `symbolic-ref` 等)
2. **冒烟测试**:`chmod -R a-w .git` 后跑一遍完整流程,任何写尝试都会直接失败暴露

## 6. 验收标准

- [ ] 在任意 git 仓库目录下执行 CLI 命令,能自动识别仓库并在浏览器打开对应变更视图
- [ ] 变更文件列表状态标识准确,与 `git status` 结果一致;已暂存、未暂存、未跟踪三类文件均正确展示;未跟踪目录展开到文件粒度而非折叠成 `dir/`
- [ ] Diff 展示内容与 `git diff HEAD` 结果一致;agent 执行过 `git add` 后,已暂存的改动仍能正常展示不遗漏
- [ ] 未跟踪的新文件能展示为全新增内容,而非在列表里可见却点开无 diff
- [ ] 新文件/删除文件/重命名正确展示,二进制文件仅提示变更不做内容 diff,超大文件(如 >5MB)提示不支持预览而非卡死
- [ ] 重命名的文件在懒加载点开后标注为"重命名"(展示 `rename from/to` 与相似度),而非退化成一个全新增文件
- [ ] 单次变更 300+ 文件的仓库下,列表能正常展示、点击单个文件的 diff 响应及时,浏览器主线程不出现可感知冻结
- [ ] 路径含非 ASCII 字符(中文/日文/emoji)、空格、引号的文件,在列表与 diff 中均正确展示,不出现 `\351\234\200` 这类转义残留
- [ ] 空仓库(尚无提交)、detached HEAD、rebase/merge 进行中等状态下工具不崩溃,展示合理降级
- [ ] git worktree、submodule 目录下能正常启动;bare 仓库给出明确提示而非崩溃
- [ ] 当前分支、ahead/behind 计数与 `git status` 结果一致;分支无上游(无 `# branch.ab` 行)时展示"无上游"而非 0/0 或报错
- [ ] 文件变更后,浏览器展示内容能自动刷新,延迟感知不明显;macOS / Windows / Linux 三端监听行为均验证正常
- [ ] Linux 上在含 `node_modules` 的大仓库启动时,`ignore` 过滤生效、注册的 watch 数量维持在低位,不因遍历重目录而耗尽配额
- [ ] Linux 上人为压低 `fs.inotify.max_user_watches` 直至触发 ENOSPC 时,能正确降级为轮询并在 UI 提示,功能不受影响
- [ ] 页面刷新、系统休眠唤醒、浏览器丢弃后台标签后重新激活,均不导致进程误退出,页面能自动恢复连接
- [ ] 多标签同时打开时,关闭其中一个不导致进程退出;全部关闭后进程在宽限期内自动退出,不留后台常驻进程
- [ ] 同一仓库重复执行启动命令时,复用已有实例而非新起进程;注册表文件位于 `os.tmpdir()`,仓库目录内无任何新增文件
- [ ] 工具运行期间不产生任何仓库写操作,5.10 的两层验证(git 命令白名单断言 + 只读 `.git` 冒烟测试)均通过并纳入 CI 门禁
- [ ] **冷启动 · CLI 侧**:进程 ready 并输出 URL ≤ 300ms,自动化测量并纳入 CI 门禁。**"ready" 的口径明确为「监听成功并打印 URL」**,首次 `git status` 交由第一个 HTTP 请求惰性执行、不计入——否则该指标会随被测仓库规模漂移,失去回归意义
- [ ] **冷启动 · 浏览器侧**:浏览器进程已在运行的前提下,首屏渲染 ≤ 1s(人工验证)。冷启动浏览器进程本身的耗时(通常 2-5s)与 `npx` 首次下载解包耗时均不计入,后者在 README 中说明
- [ ] 资源占用:原生监听模式下空闲时内存/CPU 接近零;降级轮询模式下空闲 CPU < 1%
- [ ] `npm i -g gitglance` 后在 Node 24.14+ 环境下能正常运行,macOS / Windows / Linux 三端均验证通过;低于该版本时给出明确的版本要求提示而非运行时报错

## 7. 实施阶段

按下表顺序推进,每个阶段完成后对照第 6 节自查。阶段划分的依据是依赖关系与验证时机,不是工作量。

| 阶段 | 内容 | 注意事项 |
|---|---|---|
| S1 | CLI 脚手架 + Node HTTP server + git shell 封装(status/diff)跑通 | — |
| S2 | 前端变更列表 + diff2html 渲染 + 按文件懒加载联动,基础样式(VS Code 风格 CSS 变量) | — |
| S3 | 分支状态展示(只读)+ 自动刷新(`recursive + ignore` 监听 + `.git` 单独监听 + 轮询兜底 + SSE)+ 进程生命周期(单实例复用 + 空闲退出) | 三件事互相独立,建议拆开逐个收口再集成,不要并行推进 |
| S4 | Diff 边界情况处理:未跟踪文件/新文件/删除/重命名/二进制/超大文件 + git 异常状态(空仓库、detached HEAD、worktree 等) | 依赖下方测试数据先就位,否则边界分支无从验证 |
| S5 | Windows/Linux 兼容性验证 + 本地安全(Host 校验/token/端口)加固 | Windows 路径与浏览器拉起、Linux 降级路径必须在真机上触发验证,CI 跑通不等于可用 |
| S6 | 开源准备(见第 8 节) | — |

**测试数据准备**(对应 S4):需针对未跟踪新文件、已暂存改动(执行过 `git add`)、新增文件、删除文件、重命名(含相似度识别阈值边界)、二进制文件变更、超过 5MB 的大文件分别构造测试仓库/测试文件;另需构造空仓库(`git init` 后无提交)、detached HEAD、rebase 进行中、linked worktree 状态的仓库,以及一个 300+ 文件变更的仓库用于验证懒加载,逐项对照第 6 节验收标准验证。

## 8. 开源规划

- **License**:MIT。运行时依赖 diff2html 为 MIT、highlight.js 为 BSD-3-Clause,均兼容
- **仓库/包名**:`gitglance`(2026-07-28 复核 npm registry 返回 404,确认未占用;`git-glance` 已被他人占用 v1.0.1,仅影响搜索时的混淆,不构成冲突。GitHub 仓库名待发布前确认)
- **需要补的东西**:README(功能说明+安装步骤)、LICENSE 文件、清理硬编码的个人路径/凭据、简单的 Issue/PR 规范、semver + GitHub Releases
- **版本号约定**:首个 npm 发布版本为 **0.1.0**。在 0.x 阶段保留破坏性调整的余地(尤其是 CLI 参数与端口/token 行为),待第 6 节验收标准**全部**通过、且三端真机验证完毕后再发 **1.0.0**。不要为了"看起来正式"直接从 1.0.0 起步——本工具的核心承诺是只读与零副作用,1.0.0 应当是这些承诺被 5.10 两层验证覆盖之后的结果,而不是起点
- **平台支持**:正式支持 macOS / Windows / Linux 三端,均需测试保证可用。用 GitHub Actions 三端 runner 跑测试,并在每个平台上做人工验证。CI 版本矩阵 **Node 24 / 26**;`package.json` 的 `engines.node` 声明为 `>=24.14.0`

## 9. 开发方式

- 全程使用 Claude Code 进行开发,按第 7 节 S1-S6 顺序推进
- 项目根目录维护 `CLAUDE.md`,避免开发过程中"发明"未授权的写操作或功能。内容为两部分,均需逐条落地、不得概括成一句话:
  - 第 4 节 Non-goals 全文(4.1、4.2 两类)
  - 第 10 节「被排除的做法」整表,每行转写为一条禁止项。**该表是禁止清单的唯一来源**,此处不再重复罗列,避免同一条约束散落多处、改一漏二
- 每个阶段完成后,对照第 6 节对应验收标准自查,不堆到后期集中验证

## 10. 附录:关键决策的依据

第 5 节中几处"排除了某个看似更自然的做法"的决策,依据记录在此,避免开发期被重新提出。核查数据的时间点为 2026-07-28。

**分工约定**:第 5 节只写规则与理由,实测输出、源码引用等原始证据一律只放本节;两处不互相复述。后续修订请沿用此分工,否则同一事实很快会出现多份拷贝。

**实测数据**

- **diff2html bundle 体积**(取自官方 CDN):全量包 `diff2html-ui.min.js` 1,048,945 B;**slim 包 `diff2html-ui-slim.min.js` 301,714 B(采用)**;`diff2html-ui-base.min.js` 90,167 B;`diff2html.min.css` 17,331 B。依赖版本 diff2html 3.4.56、highlight.js 11.11.1
- **空仓库下的 git 行为**:`git diff HEAD` → `fatal: ambiguous argument 'HEAD'`;`git rev-parse --verify HEAD` → exit 128;而 `git status --porcelain=v2 --branch` 正常返回(`# branch.oid (initial)`),`git diff <empty-tree>` 正常返回。这是 5.3 用空树哈希替代 HEAD 的直接依据
- **porcelain 的路径转义**:不加 `-z` 时,`docs/需求文档.md` 会被输出成 `"docs/\351\234\200\346\261\202\346\226\207\346\241\243.md"`;加 `-z` 后原样输出。这是 5.2 强制要求 `-z` 的依据
- **npm 包名**:`gitglance` registry 返回 404,未占用
- **Node 版本窗口**:22 = Maintenance LTS(EOL 2027-04-30),24 = Active LTS(EOL 2028-04-30),26 = Current(2026-10-28 转 LTS,EOL 2029-04-30)。本项目下限取 24.14.0,原因见下条
- **`fs.watch` 的 `ignore` 选项**:Node **24.14.0**(2026-02-24)引入,PR [#61433](https://github.com/nodejs/node/pull/61433)。核对 `lib/internal/fs/recursive_watch.js` 确认,Linux 用户态递归实现里它是**注册前跳过**(源码注释:`Skip watching ignored paths entirely to avoid kernel resource pressure`),而非回调后过滤;macOS / Windows 的原生 watcher 中则是回调过滤(`lib/internal/fs/watchers.js`)。核对 `createIgnoreMatcher` 确认字符串模式启用了 minimatch 的 `matchBase`,故须用不含斜杠的 basename 模式。Node 22.x 的 `doc/api/fs.md` 中无此选项。这是 5.1 把下限定在 24.14.0、5.7 取消平台分流的直接依据
- **Linux 用户态递归监听的实际开销**:`lib/fs.js` 中 `recursive && !isMacOS && !isWindows` 时走 `internal/fs/recursive_watch.js`;核对其 `#watchFolder`,它对遍历到的**每个目录项(含普通文件)**都调用 `#watchFile` 注册 watch,并非只对目录注册;且初次遍历时对每个条目 `emit('change','rename',...)`,启动即产生事件风暴。这是 5.7 判定配额风险、并把 debounce 列为必需项的依据
- **`git diff` 补丁正文的路径转义**:`-z` 只作用于 `status` / `numstat` 等列表输出,`git diff` 正文的 `diff --git` / `---` / `+++` / `rename from|to` 行仍会 C 风格转义(实测输出 `diff --git "a/docs/\351\234\200\346\261\202\346\226\207\346\241\243.md" ...`);加 `-c core.quotePath=false` 后原样输出。这是 5.2 强制该参数的依据
- **重命名在按文件懒加载下的退化**:实测 `git diff HEAD -- <新路径>` 对重命名文件输出 `new file mode` + `--- /dev/null`(识别为全新增);`git diff HEAD -M -- <新路径> <旧路径>` 才输出 `similarity index` + `rename from/to`。这是 5.2 要求传两个路径的依据
- **`porcelain=v2 -z` 的重命名记录格式**:实测为 `2 <XY> ... R100 <新路径>\0<旧路径>`,一条记录占两个 NUL 段;另实测无上游分支时不输出 `# branch.ab` 行。这是 5.2 两个解析陷阱的依据
- **hljs 主题 CSS 的必要性**:实测 `diff2html.min.css` 中含 hljs 的规则数为 **0**,slim 包只含 hljs 运行时与语言定义、不含配色。需另引 `highlight.js/styles/*.min.css`(`github.min.css` 1,309 B、`github-dark.min.css` 1,315 B)。这是 5.5 体积表补两行的依据
- **`os.tmpdir()` 的权限差异**:macOS 上为每用户 0700 私有目录(实测 `/var/folders/.../T` mode 700),Linux 上为 `/tmp`(1777,同机其他用户可读)。这是 5.8 要求注册表文件 `0o600` 的依据
- **冷启动实测**:node 启动 + `http.listen` + 一次 `git status --porcelain=v2 --branch -uall -z` 全程约 **30ms 墙钟**(裸 node 启动约 10-30ms),300ms 预算充裕

**被排除的做法**

| 做法 | 排除原因 |
|---|---|
| 用 `diff2html-ui.min.js` 全量包 | 1.05 MB,超出体积预算,且内含大量用不到的语言定义 |
| 未跟踪文件用 `git diff --no-index` | 依赖 `/dev/null` 作对比端,Windows 上不可移植 |
| 空树哈希用 `git hash-object -t tree /dev/null` | 同上,`/dev/null` 不可移植;`git mktree` 则会写对象库,违反只读承诺 |
| Linux 上直接用不带 `ignore` 的 `fs.watch({recursive:true})` | Node 在 Linux 是用户态实现,逐条目(含普通文件)注册 inotify 且不做排除,会耗尽 `max_user_watches` 并波及用户机器上的其他工具(详见 5.7) |
| 监听按 macOS/Windows 与 Linux 平台分流、Linux 自行遍历目录逐个注册 | 本次核查前的草案方案。Node 24.14.0 的 `fs.watch` `ignore` 选项在 Linux 上即为注册前跳过,官方能力已覆盖该需求;自行实现等于维护一份更易出错的等价物,故三端统一 |
| `ignore` 模式写成 `node_modules/**` 等含斜杠形式 | 含斜杠会使 minimatch 的 `matchBase` 失效:既匹配不到 `node_modules` 目录自身,也匹配不到 monorepo 中嵌套的 `packages/*/node_modules`,过滤形同虚设 |
| 只靠 `-z` 解决路径转义 | `-z` 管不到 `git diff` 补丁正文的头部行,非 ASCII 路径仍会显示为 `\351\234\200` 转义串,须叠加 `-c core.quotePath=false`(详见 5.2) |
| 重命名文件按单路径取 diff | git 只看到一侧无法配对,重命名会退化成全新增文件,"重命名识别并标注"落空(详见 5.2) |
| 单实例注册表写进 `.git/` 或工作区 | 污染 `git status`,实质违背零写操作承诺 |
| 陈旧实例用 pid 存活判断 | pid 会被系统复用,误判会把用户带到指向别人进程的页面 |
| 仅用 token 防 DNS rebinding | token 挡不住同源判定本身,正面防御是校验 `Host` 头(详见 5.9) |
| 用"前后 `git status` 比对"验证只读性 | 发现不了写进 `.git/` 但不改变 status 输出的操作(详见 5.10) |

**外部参考**

- [Node.js `fs.watch` 文档:recursive 支持范围与 Caveats](https://github.com/nodejs/node/blob/v24.x/doc/api/fs.md)
- [nodejs/node PR #45098:为 Linux 添加 recursive watch](https://github.com/nodejs/node/pull/45098)
- [nodejs/node PR #61433:为 `fs.watch` 添加 `ignore` 选项(Node 24.14.0)](https://github.com/nodejs/node/pull/61433)
- [nodejs/node `lib/internal/fs/recursive_watch.js`:Linux 用户态递归监听实现](https://github.com/nodejs/node/blob/v24.x/lib/internal/fs/recursive_watch.js)
- [递归 watch 逐目录注册 inotify、无排除导致耗尽内核配额的实例](https://github.com/colbymchenry/codegraph/issues/276)
- [diff2html README:bundle 用法与配置项](https://github.com/rtfpessoa/diff2html)
- [Node.js Release Working Group:LTS 时间表](https://github.com/nodejs/Release)
