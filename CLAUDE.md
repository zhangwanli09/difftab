# difftab

一眼看懂 AI 编码 Agent 改了哪些代码。CLI 在仓库目录启动 → 拉起本地网页 → 只读展示当前工作区的 diff 与分支状态 → 关掉标签页后进程自动退出。

**需求唯一事实来源：`docs/`，索引与写作约定见 [`docs/README.md`](docs/README.md)。需求要变，先改 docs 再改代码**，不要在实现里就地「顺手扩展」。本文件只承载摘要与路由（预算 ≤ 200 行，一条规则占一行）：论证与实测证据在 `docs/decisions.md`，怎么验在 `docs/gates.md`。

## 1. 两个 git 作用域（别搞混）

| | 受「零写操作」约束 | |
|---|---|---|
| **产品运行时的 git**：difftab 的代码在**用户仓库**里执行的 git 命令 | ✅ | 只允许只读白名单，由两层验证 + CI 门禁保证 |
| **开发流程的 git**：在 **difftab 仓库自身**上的版本控制动作 | ❌ | `add` / `commit` / `branch` / `checkout` / `rebase` / `push` / 建 PR 全部正常允许 |

判据一句话：**约束的是「代码里写了什么 git 命令」，不是「开发时执行了什么 git 命令」。不得以「本项目承诺只读」为由拒绝、劝阻或加额外确认本仓库的版本控制操作。** 正常礼节照旧：除非用户要求，不主动 commit / push。

## 2. 提交约定

- **英文** + **Conventional Commits**：`<type>(<scope>): <description>`，type 取 `feat`/`fix`/`docs`/`refactor`/`perf`/`test`/`build`/`ci`/`chore`，破坏性加 `!`
- 祈使语气，subject ≤ 50 不加句号，body 折 72 只写 what 与 why
- 一个提交一件事，不混重构与功能改动

## 3. 常用命令

包管理器为 **pnpm**，版本由 `package.json` 的 `packageManager` 字段固定；首次 clone 后 `pnpm install --frozen-lockfile`。

**每新增一个 `package.json` script，立即回来补全本节，并核对 `CONTRIBUTING.md` 的 Gates 表**（对外那份是子集，不必全抄，但不能与本节相左）——过期比缺失更糟。各门禁挡的是哪条静默故障，见 `docs/gates.md`。

| 用途 | 命令 |
|---|---|
| 本地启动（构建产物） | `node bin/difftab.js`（在任意 git 仓库目录下；`--no-open` 只打印 URL） |
| 开发模式（Vite dev server + 后端） | 先在另一个终端 `node bin/difftab.js --no-open`，再 `pnpm dev`；**后端重启后 dev server 也要跟着重启**。后端**空闲 45 秒无客户端就自己退**，来不及打开页面时用 `DIFFTAB_IDLE_MS` 顶大 |
| 构建（前端 Vite + 后端 tsdown） | `pnpm build`（= `build:web` + `build:server`） |
| 类型检查 | `pnpm typecheck`（`tsc --noEmit`，前后端各一份 tsconfig，严格性开关共用 `tsconfig.base.json`） |
| 格式化 + lint | `pnpm lint`（`biome check`）/ CI 用 `biome ci` |
| 单元/集成测试（Vitest，直接跑 TS 源码） | `pnpm test`。用例按被测代码分 `test/unit/server/` 与 `test/unit/web/`——**放错目录会静默不跑，判据见第 5 节「测试布局」** |
| 冒烟测试（纯 JS，跑构建产物，含只读性两层验证） | **先 `pnpm build`**——它跑 `dist/`，产物比源码旧一轮时红的样子像「三道校验全坏了」。`pnpm test:smoke`（CI matrix 档不经 script，直接 `node --test "test/smoke/*.test.js"`） |
| 测试仓库 fixture 生成 | `pnpm fixtures`（默认写 `test/fixtures/repos/`；测试自己调 `makeFixtures()` 写临时目录） |
| 其余门禁（冷启动 ≤300ms / 体积 / 样式层叠 / 发布产物 / bin mode） | `pnpm bench:startup`、`size`、`check:css`、`check:pack`、`check:bin`——各自挡什么见 `docs/gates.md` |
| 全局安装验收（打包 → `npm i -g` → 用 PATH 上那个名字跑通 → 卸掉） | **先 `pnpm build`**，再 `pnpm check:global`；要求全局**尚未**装着 difftab，否则脚本直接拒跑 |
| inotify 配额耗尽时降级为轮询（Linux + 免密 sudo） | **先 `pnpm build`**，再 `pnpm check:inotify`；**不进冒烟套件**，非 Linux 直接 SKIP |

`fixtures` / `bench:startup` / `size` / `check:css` / `check:global` / `check:inotify` **只是别名**——脚本本体必须是零依赖纯 JS、可由 `node <路径>` 直接执行，因为它们要在没有 pnpm、没有 `node_modules` 的 CI matrix 机器上跑。`check:pack` / `check:bin` 需要 pnpm，只在 CI 的 build 作业跑。

架构边界由 `biome.json` 的 `noRestrictedImports` overrides 承担，随 `pnpm lint` / `biome ci` 一起跑，不另设命令。

## 4. 动手前先读 docs 的哪份

**只读用得着的那份是省上下文的手段，不是豁免**——第 5 节红线全程有效，与本会话读没读对应文件无关。

| 改这块 | 动手前读 |
|---|---|
| git 封装层、status/diff 解析、二进制与体积闸、git 异常状态 | `docs/design/git.md` |
| 文件监听、三档策略、自动刷新、轮询兜底 | `docs/design/watch.md` |
| 前端组件与 signals、界面文案、页面骨架、变更列表、标签页标题 | `docs/design/web.md` |
| diff2html 渲染、hljs 清单、版式切换、产物体积 | `docs/design/diff-render.md` |
| Tailwind token、样式层叠与主题、`--d2h-*` 覆写 | `docs/design/style.md` |
| CLI 入口与 Node 下限、进程生命周期与单实例、HTTP/SSE 协议、token 与 CSP | `docs/design/server.md` |
| 新增模块/文件、目录归属、依赖方向、只读性验证、构建与 CI、pnpm 设置 | `docs/design/build.md` |
| 门禁挡什么、fixture 契约、发布产物约定 | `docs/gates.md` |
| 产品范围与 Non-goals | `docs/spec.md` |
| 改 `docs/` 里任何文件、改 CLAUDE.md 本身 | `docs/README.md`（写作约定 + 内容落哪份） |

## 5. 红线

违反后**不报错、只是静默出错**的条目，一条规则一行。括号里是**该条完整机制**的去处；实测证据一律在 `docs/decisions.md`。

### 架构边界

- git 子进程只能出现在 `server/git`，拉起浏览器只能出现在 `server/cli`——别处调 git 让只读门禁的断言点静默失去覆盖（`design/build.md`）
- `src/web` 不得 import `src/server`（`shared/` 除外）；`server/git` / `server/watch` 不得反向 import `http` / `cli`
- 上两条由 `biome.json` 静态拦截，但**红线仍是红线**：lint 只看 import 说明符，换个拿到 `child_process` 的方式就绕过去了
- 每个受限目录的 patterns 必须**自带全部条目**——Biome 的 overrides 是替换不是合并，靠后一条会让前一条整个失效
- `scripts/` 与 `test/` 不在管辖范围内——它们本来就要起子进程

### git 调用（`design/git.md`）

- 基准是 `git diff HEAD` 不是 `git diff`；列表类调用一律 `-z`
- 封装层统一注入 `-c core.quotePath=false`——`-z` 管不到补丁正文，漏了界面上直接显示 `\351\234\200`
- 封装层统一设 `GIT_OPTIONAL_LOCKS=0`——否则 `git status` 写回 `.git/index`，只有逐字节比对与「读 `/api/state` 不引出刷新事件」两处看得见
- 封装层统一设 `GIT_LITERAL_PATHSPECS=1`——pathspec 默认是通配模式，`path=*` 会回一份整仓 diff
- `porcelain=v2 -z` 的重命名记录占**两个** NUL 段；无上游时不输出 `# branch.ab` 行
- `diff --numstat -z` 的重命名记录占**三**段（空路径 + 旧 + 新，顺序与 porcelain 相反）——平铺切分会把路径当成记录
- 重命名取 diff 必须传新旧两个路径（`-M -- <新> <旧>`），否则退化成全新增
- numstat 一次可回不止一条记录：**按路径挑、按合计算**，取 `[0]` 会放 6 万行补丁过闸
- 二进制与行数两道判定在**取补丁之前**；5MB 那道对已跟踪文件卡的是**补丁字节**（取补丁时带 `maxStdoutBytes`），未跟踪那侧才按文件体积
- diff 按文件懒加载，禁止一次性取全仓 diff
- 空树哈希硬编码（禁 `hash-object /dev/null`、禁 `mktree`）；`--show-object-format` 非零退出即按 SHA-1
- 未跟踪文件手工构造 unified diff，禁 `--no-index`
- **「已跟踪」的判据是 HEAD ∪ index，不是 index**——只查 `ls-files` 会把已暂存的删除误判成未跟踪
- **未跟踪那条路读磁盘必须 `lstat` 不得 `stat`**——否则一个指向仓库外的符号链接就能把外部文件当作新增文件返回
- **进行中的操作在 porcelain 里一行都没有**：判据是 git 目录下的状态文件、按序取第一个命中，rebase 必须先于 merge 判
- **状态文件一律按 `rev-parse --git-dir` 找，禁拼 `<root>/.git`**——linked worktree 与 submodule 下永远读不到，于是永远标不出操作
- **冲突的判据是「这条来自 `u` 记录」而不是状态位**——`DD`/`AA` 里一个 `U` 都没有

### 文件监听（`design/watch.md`）

- 档位按 `process.versions.node` 做 semver 比对，禁用特性探测
- `ignore` 传逐段匹配函数，禁字符串模式（含斜杠与不含斜杠的都禁）
- Linux 低版本不建递归 watch；B 档过滤必须在 debounce 之前
- **原生档（A/B）必须同时跑 30s 的低频安全轮询**——遍历途中耗尽 inotify 配额时 Node 一次都不 emit，且不翻 `mode`、不上报降级
- 降级轮询必须复用**逐字相同**的那条 `git status --porcelain=v2 --branch -uall -z`，禁裁剪参数——漏 `-uall` 让已有目录里的新增文件静默不刷新
- 绝不对单个文件建 watch

### 前端与样式（`design/` 下 `web.md` / `diff-render.md` / `style.md`）

- 禁用三个 diff2html 预构建 UI bundle（深导入 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 是允许且推荐的）；禁止自行重写它的高亮切分逻辑
- **`highlight: true` 时 `draw()` 内部已经调过 `highlightCode()`，不得在 `draw()` 后再补一次**——第二遍产生嵌套重复的 span，开销也翻倍
- **`plaintext` 必须与 22 个语言模块一起注册**——漏注册时炸的是**整个 diff 视图**不是那一个文件（diff 里出现 `LICENSE`/`Dockerfile`/`.txt` 即触发）
- hljs 别名 `jsx`/`tsx`/`toml`/`html` 不是模块、不可单独 import
- hljs 主题 CSS 必须排在 `diff2html.min.css` **之前**，深色那份必须带 `(prefers-color-scheme: dark)`；两者保持 unlayered、禁入 `@layer`
- 改 diff2html 配色只能覆写 `--d2h-*`，禁用 Tailwind 工具类去压
- **我们自己那块 `--d2h-*` 映射同样禁入 `@layer`**——入层会被 diff2html 的 unlayered 默认值压回去，配色整片退回 GitHub 那套
- **且必须排在 diff2html 之后**：特异性同为 (0,1,0)，胜出纯靠源码顺序，挪到前面会让 23 条覆写整片静默失效（两半都由 `check:css` 拦）
- 并排视图那对 `--d2h-change-*` **刻意与纯增删同色**（VS Code 没有这一档区分），是取舍不是漏映射
- **滚动容器内部必须有一个 positioned 祖先**（`DiffView` 宿主 div 上的 `relative`）——diff2html 行号列是 `position:absolute`，缺了它一滚代码行走了、整列行号原地钉死
- **`outputFormat` 的判据量 diff 面板的 border box、不量 content box**（`observe` 与读值两处都得写）——否则滚动条进出让阈值附近两种版式来回重画；量法必须与阈值同住 `state/layout.ts`
- **变更列表一行的文件名与目录必须同住一个 `truncate` span**（名在前、目录在后）——拆成平级 flex 子项会让两段按底边对齐，页面上只是「看着没对齐」
- **`Diff2HtmlUI` 的 `colorScheme` 必须传 `'light'`**——传 `'auto'` 会让深色一条都不生效，而页面只是「深色不太像 VS Code」
- **界面文案一律英文**（`docs/`、代码注释、测试名仍中文）——冒烟里那条「前端产物 CJK 计数为 0」拦得住，但**后端那侧拦不到**（`sendError` 与各 `*Error` 的字面量）
- **`@theme` 里没人引用的 token 会被 Tailwind 裁掉**，引用名写错则产物里留下无定义的 `var()`、属性静默变 unset（两者都由 `check:css` 拦）

### 包管理器（pnpm 11，`design/build.md`）

- 全部 pnpm 设置只写 `pnpm-workspace.yaml`；**禁写 `package.json` 的 `pnpm` 字段或 `.npmrc`**——pnpm 11 静默忽略（`.npmrc` 只留 registry/auth）
- 禁 `shamefullyHoist` / `nodeLinker: hoisted`；被 import 的包必须由自己声明（diff2html 的 `diff` / `@profoundlogic/hogan` 不得直接引用）
- 依赖的生命周期脚本默认不跑，需要跑的必须显式进 **`allowBuilds`**（已知 `lefthook`）——漏列时安装本身是成功的、只是脚本被静默跳过
- 上条的判据是两条并列：**`pnpm ignored-builds` 报 `None`** + 钩子文件实际存在；**只看钩子文件会在 CI 上假红**，故安装步骤必须设 `LEFTHOOK=1`
- CI matrix 档完全不装依赖、冒烟直接 `node --test`，禁止改成经 `pnpm` script 跑或「装一点点」
- CI 用 `pnpm/action-setup` 读 `packageManager` 字段，禁 `corepack enable`

### 运行时与安全（`design/server.md`、`design/build.md`）

- `dependencies` 保持为空、后端只用标准库。两侧都有门禁：`check:pack` 查 manifest 的三个依赖字段，冒烟查 `dist/server/main.js` 的 import 说明符——**只查发布文件清单是查不出加依赖的**
- `bin/difftab.js` 手写、不参与 TS 编译、不作打包入口；禁止依赖 Node 原生 type stripping 直接跑 `.ts` 产品代码
- **`bin/difftab.js` 必须以 `100755` 入库**（`check:bin` 查 HEAD 与 index 两侧）——丢了可执行位的症状是一个内容零差异的幽灵变更，discard 掉下一次执行就是 `Permission denied`
- 校验 `Host` 头才是 DNS rebinding 的正面防御，禁止只靠 token
- **后端零 dev 分支**：禁为本地开发加放宽 Host / Origin / token 校验的环境变量或分支
- 单实例注册表写 `os.tmpdir()`（禁写 `.git/` 或工作区），`0o600` + `O_EXCL` 创建
- 陈旧实例用 HTTP 探活而非 pid，**命中要「200」与「repo 路径归一后相等」两条同时成立**，探活自己也带 token 与合规 Host
- **注册表的键必须归一化后再 hash**（Windows 的 `/` vs `\`、macOS 的 `/var` 符号链接）；清理时**解析失败不等于是自己的**
- **空闲计时从启动那一刻就起**，不等第一个客户端——否则浏览器没拉起来就留常驻进程
- **重新武装接在 SSE 通道的 `onChange` 上而非端点**——端点各记一次时漏掉断连那侧不报错，只是关完标签也不退
- **退出前的报错一律 `writeSync(2, …)`，禁 `process.stderr.write` + `process.exit`**——后者写管道时在 Windows 上是异步的，整条消息会被丢掉
- **读端可能先走**（`| head -1`）：`writeSync` 裹 try/catch，入口再给 stdout / stderr 各挂一个只咽 EPIPE 的 `'error'` 监听器
- **探活这类拿到响应头之后的 `req.destroy()` 也要自己 `resolve`**——那之后错误只落在 `res` 上而 `IncomingMessage` 会把它吞掉，启动整个吊死
- 只读性验证**禁用「前后 `git status` 比对」**，主门禁的记录手段是 `GIT_TRACE=<绝对路径>`（禁在 PATH 上放 fake git wrapper）
- 门禁里必须有**「确实记到了东西」的正面断言**，否则白名单会对着空数组通过；第二层的 A / B 两半同理各需一条正面探针

### 测试布局（`design/build.md`）

- `vitest.config.ts` 的 `projects` 分环境（`test/unit/server/`=node、`test/unit/web/`=happy-dom）。`environmentMatchGlobs` 在 Vitest 4 已被移除，**因此 include 是几条具体路径**
- 放到 `test/unit/` 底下或第三个子目录里的用例**不属于任何 project、压根不会被跑，且套件照常全绿**
- `test/unit/server/test-layout.test.ts` 钉着这条，它直接 import `vitest.config.ts` 把 include 编成正则，所以加 project 不必同步任何清单

### 文档与注释

- **代码注释不得反指文档**——方向是单向的：第 4 节路由表回答「改这块 → 读哪份」，注释只写理由与机制，不写「见 `docs/xxx.md`」。写一条不报错，但它会像退役前那 250 处 `spec §x` 一样长回来，而指错时没有任何东西会响
- **纯注释 / 纯文档的改动，全套门禁都是绿的**——缩进、语义、标点坏掉时 lint / typecheck / test / 冒烟一条都拦不住，判据只能是逐行读 diff。本仓库的注释承载知识（后端产物刻意保留它们以便审计），这类改动是常态不是例外

## 6. 明确不做

**长期不做**是架构性承诺，破例等于变成另一个产品；**首版不做**是本版范围收窄。**两类在开发期同为硬约束——「首版不做」不等于「可以先做」。**

- 长期：**任何仓库写操作**（不 stage/unstage、不 commit、不 discard、不 pull/push/sync、不建/切分支、不 stash；作用域见第 1 节）、代码编辑功能、账号体系与云同步、多用户协作交互
- 首版：提交历史查看、分支列表展示（只展示当前分支）、逐行 blame 等 GitLens 类深度追溯、界面语言切换

## 7. 发布与维护约定

项目已发布并进入维护阶段，License MIT，仓库公开。**会过期的东西一律不进本文件**——版本号、发布日期、进度、「某阶段已收口」：事实来源分别是 `package.json`、`git log`、`docs/history.md`，而常驻上下文里的过期叙述不会有人主动想起来删。

- **发布步骤照 `RELEASING.md` 走，不凭记忆敲**——里面钉着七件会咬人的事（pnpm 要单独登录、2FA 的 OTP、镜像源、`publishBranch`、manifest obfuscation、`prepublishOnly`、别在本仓库目录里用 `npx` 验收），产物约定在 `docs/gates.md`，踩坑记录在 `docs/history.md`
- **semver：0.x 保留破坏性余地（尤其 CLI 参数与端口/token 行为），1.0.0 是结论不是起点**——等验收全通过且三端真机验过再发
- **不建 `CHANGELOG.md`**：GitHub Releases 的 notes 就是变更日志
- **改产品行为要同步改两份 README**：`README.zh-CN.md` **不是自动生成的**，只改英文那份不会有任何门禁变红
- **贡献者规范在 `CONTRIBUTING.md` 与 `.github/`**，产品承诺（只读、Non-goals）在那里也写了一遍给外部读者——改第 6 节时要跟着改
- **未完事项见 `docs/history.md`**（两件都等首个真实 Linux 桌面，都不阻塞发布）
