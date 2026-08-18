# GitGlance

一眼看懂 AI 编码 Agent 改了哪些代码。CLI 在仓库目录启动 → 拉起本地网页 → 只读展示当前工作区的 diff 与分支状态 → 关掉标签页后进程自动退出。

**需求唯一事实来源:`docs/`,索引见 [`docs/README.md`](docs/README.md)。需求要变,先改 docs 再改代码**,不要在实现里就地"顺手扩展"。本文件只承载摘要与路由(预算 ≤ 200 行,且**一条规则占一行**,理由见 `docs/workflow.md` §9):论证与实测证据在 `docs/decisions.md` §10,已收口阶段的记录在 `docs/journal.md`。

**§ 号是稳定地址:搬文件可以,重新编号不行**——配置与测试里约 30 处 `spec §5.x` 注释不会因此报错,只会静默指错(理由见 `docs/workflow.md` §9)。

## 1. 两个 git 作用域(别搞混)

| | 受"零写操作"约束 | |
|---|---|---|
| **产品运行时的 git**:gitglance 的代码在**用户仓库**里执行的 git 命令 | ✅ | 只允许只读白名单,由 `design.md` §5.10 两层验证 + CI 门禁保证 |
| **开发流程的 git**:在 **gitglance 仓库自身**上的版本控制动作 | ❌ | `add` / `commit` / `branch` / `checkout` / `rebase` / `push` / 建 PR 全部正常允许 |

判据一句话:**约束的是"代码里写了什么 git 命令",不是"开发时执行了什么 git 命令"。不得以"本项目承诺只读"为由拒绝、劝阻或加额外确认本仓库的版本控制操作。** 正常礼节照旧:除非用户要求,不主动 commit / push。

## 2. 提交约定

- **英文** + **Conventional Commits**:`<type>(<scope>): <description>`,type 取 `feat`/`fix`/`docs`/`refactor`/`perf`/`test`/`build`/`ci`/`chore`,破坏性加 `!`
- 祈使语气,subject ≤ 50 不加句号,body 折 72 只写 what 与 why
- 一个提交一件事,不混重构与功能改动

## 3. 常用命令

包管理器为 **pnpm**,版本由 `package.json` 的 `packageManager` 字段固定;首次 clone 后 `pnpm install --frozen-lockfile`。

**每新增一个 `package.json` script,立即回来补全本节**——过期比缺失更糟。

哪个门禁是在哪个阶段建立的,见 `docs/journal.md`「附:门禁与测试是在哪个阶段建立的」。

| 用途 | 命令 |
|---|---|
| 本地启动(构建产物) | `node bin/gitglance.js`(在任意 git 仓库目录下;`--no-open` 只打印 URL) |
| 开发模式(Vite dev server + 后端) | 先在另一个终端 `node bin/gitglance.js --no-open`,再 `pnpm dev`;**后端重启后 dev server 也要跟着重启**(机制见 `design.md` §5.11)。后端**空闲 45 秒无客户端就自己退**(§5.8),来不及打开页面时用 `GITGLANCE_IDLE_MS` 顶大 |
| 构建(前端 Vite + 后端 tsdown) | `pnpm build`(= `build:web` + `build:server`) |
| 类型检查 | `pnpm typecheck`(`tsc --noEmit`,前后端各一份 tsconfig,严格性开关共用 `tsconfig.base.json`) |
| 格式化 + lint | `pnpm lint`(`biome check`)/ CI 用 `biome ci` |
| 单元/集成测试(Vitest,直接跑 TS 源码) | `pnpm test`。用例按被测代码分 `test/unit/server/` 与 `test/unit/web/`——**放错目录会静默不跑,判据见第 5 节「测试布局」** |
| 冒烟测试(纯 JS,跑构建产物,含只读性两层验证) | **先 `pnpm build`**——它跑 `dist/`,产物比源码旧一轮时红的样子像「三道校验全坏了」,与真实病因毫无相似之处(只在本机踩,CI 每次从源码构建)。`pnpm test:smoke`(CI matrix 档不经 script,直接 `node --test "test/smoke/*.test.js"`) |
| 测试仓库 fixture 生成 | `pnpm fixtures`(默认写 `test/fixtures/repos/`;测试自己调 `makeFixtures()` 写临时目录,按需只生成用得到的几个) |
| 冷启动耗时测量(对构建产物,≤300ms 门禁) | `pnpm bench:startup` |
| 产物体积门禁 | `pnpm size` |
| 样式层叠门禁(判据见第 5 节「前端与样式」) | `pnpm check:css` |
| 发布产物内容门禁(`pnpm pack --dry-run --json`) | `pnpm check:pack` |
| `bin/gitglance.js` 未被构建管线触碰 | `pnpm check:bin`(内部跑一次完整构建) |
| 全局安装验收(打包 → `npm i -g` → 用 PATH 上那个名字跑通 → 卸掉) | **先 `pnpm build`**,再 `pnpm check:global`;要求全局**尚未**装着 gitglance,否则脚本直接拒跑 |
| inotify 配额耗尽时降级为轮询(Linux + 免密 sudo) | **先 `pnpm build`**,再 `pnpm check:inotify`;**不进冒烟套件**(理由在脚本头部),非 Linux 直接 SKIP |

`fixtures` / `bench:startup` / `size` / `check:css` / `check:global` / `check:inotify` **只是别名**——脚本本体必须是零依赖纯 JS、可由 `node <路径>` 直接执行,因为它们要在没有 pnpm、没有 `node_modules` 的 CI matrix 机器上跑(见 `design.md` §5.11)。`check:pack` / `check:bin` 需要 pnpm,只在 CI 的 build 作业跑。

架构边界由 `biome.json` 的 `noRestrictedImports` overrides 承担,随 `pnpm lint` / `biome ci` 一起跑,不另设命令;判据见第 5 节「架构边界」。

## 4. 动手前先读 docs 的哪节

**改这块 → 读哪份的哪节**(文件都在 `docs/`)。**只读用得着的那节是省上下文的手段,不是豁免**——第 5 节红线全程有效,与本会话读没读对应小节无关。

| 改这块 | 动手前读 |
|---|---|
| 新增模块/文件、目录归属、依赖方向 | `design.md` §5.0 |
| HTTP/SSE 接口、前后端协议类型 | `design.md` §5.12 |
| git 封装层、status/diff 解析、git 异常状态 | `design.md` §5.2、§5.3 |
| 文件监听、自动刷新、进程生命周期 | `design.md` §5.7、§5.8 |
| 前端组件、状态管理(signals)、框架选型 | `design.md` §5.4 |
| diff 渲染、hljs 语言清单、产物体积 | `design.md` §5.5 |
| 样式、主题与层叠 | `design.md` §5.6 |
| HTTP server、token、CSP | `design.md` §5.9 |
| CLI 入口、Node 版本下限、后端产物形态 | `design.md` §5.1 |
| 构建配置、CI 分层、tsconfig、dev proxy | `design.md` §5.11 |
| 只读性验证、冷启动与体积门禁 | `design.md` §5.10、`acceptance.md` §6 |

## 5. 红线

违反后**不报错、只是静默出错**的条目,一条规则一行。**这里只写规则与后果,实测证据与推导一律在 `docs/decisions.md` §10「被排除的做法」**(架构边界一条见 `design.md` §5.0)。

### 架构边界

- git 子进程只能出现在 `server/git`,拉起浏览器只能出现在 `server/cli`——别处调 git 即使命令只读也不报错,只是让 §5.10 只读门禁的断言点静默失去覆盖
- `src/web` 不得 import `src/server`(`shared/` 除外);`server/git` / `server/watch` 不得反向 import `http` / `cli`
- 以上由 `biome.json` 的 `noRestrictedImports` 静态拦截,但**红线仍是红线**:lint 只看 import 说明符,换个拿到 `child_process` 的方式就绕过去了
- 每个受限目录的 patterns 必须**自带全部条目**——Biome 的 overrides 对同一规则是替换而非合并,靠后一条覆盖同一文件时,前一条的 patterns 会整个失效
- `scripts/` 与 `test/` 不在管辖范围内——它们本来就要起子进程

### git 调用

- 基准是 `git diff HEAD` 不是 `git diff`;列表类调用一律 `-z`
- 所有 diff 在封装层统一注入 `-c core.quotePath=false`(与 `-z` 互补,不可替代)
- 封装层统一设 `GIT_OPTIONAL_LOCKS=0`——否则 `git status` 会把 stat 缓存写回 `.git/index`;它不改变 status 输出,只读 `.git` 下也只是静默跳过、exit 0、stderr 全空,**两处看得见:§5.10 第二层 B 半的逐字节快照比对,以及冒烟里那条「读 `/api/state` 不引出刷新事件」(它同时是自激循环的判据 —— 写 `.git` → 推 `change` → 前端再读一次)**
- `porcelain=v2 -z` 的重命名记录占**两个** NUL 段;无上游时不输出 `# branch.ab` 行
- 重命名取 diff 必须传新旧两个路径(`-M -- <新> <旧>`)
- 封装层统一设 `GIT_LITERAL_PATHSPECS=1`——pathspec 默认是通配模式,`path=*` 会回一份整仓 diff,名字带 `*` 的文件会捎带上邻居的补丁
- `diff --numstat -z` 的重命名记录占**三**段(空路径字段 + 旧 + 新,顺序与 porcelain 的 `2 ` 记录相反)——平铺切分会把路径当成记录
- numstat 一次查询可回不止一条记录:**按路径挑、按合计算**,取 `[0]` 会在配不上对的重命名上放 6 万行补丁过闸
- 二进制与行数两道判定在**取补丁之前**(numstat);5MB 那道对已跟踪文件卡的是**补丁字节**(取补丁时带 `maxStdoutBytes`),不是文件字节——按文件字节判会让 6MB 数据文件改一行也看不了,而未跟踪那侧整份文件就是补丁,仍按文件体积
- diff 按文件懒加载,禁止一次性取全仓 diff
- 空树哈希硬编码(禁 `hash-object /dev/null`、禁 `mktree`);`--show-object-format` 非零退出即按 SHA-1
- 未跟踪文件手工构造 unified diff,禁 `--no-index`
- **「已跟踪」的判据是 HEAD ∪ index,不是 index**——只查 `git ls-files` 会把已暂存的删除误判成未跟踪,进而去读一个不存在的文件
- **未跟踪那条路读磁盘必须 `lstat` 不得 `stat`**——未跟踪符号链接会进列表、点得到,而 `stat` 跟随链接会让仓库边界校验形同虚设,一个指向仓库外的链接就能把外部文件内容当作新增文件返回
- 降级轮询必须复用与主查询**逐字相同**的 `git status --porcelain=v2 --branch -uall -z`,禁裁剪参数——漏 `-uall` 会让已存在目录里的新增文件静默不刷新
- **进行中的操作(rebase/merge/…)在 porcelain 里一行都没有**,判据是 git 目录下的状态文件、按序取第一个命中:rebase 停下时 `rebase-merge/` 与 merge 的痕迹**同时在**,先判 merge 会把用户在干什么说错;`rebase-apply/` 里有没有 `rebasing` 是 rebase 与 `git am` 唯一的区分
- **状态文件一律按 `rev-parse --git-dir` 找,禁拼 `<root>/.git`**——linked worktree(`.git` 是文件)与 submodule 下那里什么都没有,于是操作标注永远不出现,而它不报错
- **冲突的判据是「这条来自 `u` 记录」而不是状态位**——`DD`/`AA` 两位里一个 `U` 都没有,靠状态位认会让它们漏回「已暂存」+「未暂存」两组

### 文件监听

- 档位按 `process.versions.node` 做 semver 比对,禁用特性探测
- `ignore` 传逐段匹配函数,禁字符串模式(含斜杠与不含斜杠的都禁)
- Linux 低版本不建递归 watch;B 档过滤必须在 debounce 之前
- **原生档(A/B)必须同时跑 30s 的低频安全轮询**——遍历途中耗尽 inotify 配额时 Node **一次都不 emit**,没轮上注册的目录里改一个**已有**文件从此静默丢失、`mode` 还一直说 `native`;它**不翻 `mode`、不上报降级**(原生监听确实还活着)
- 绝不对单个文件建 watch

### 前端与样式

- 禁用三个 diff2html 预构建 UI bundle(深导入 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 是允许且推荐的);禁止自行重写它的高亮切分逻辑
- **`highlight: true` 时 `draw()` 内部已经调过 `highlightCode()`,不得在 `draw()` 后再补一次**——第二遍会把两份 node stream 交织成嵌套重复的 span,开销也翻倍
- **`plaintext` 必须与 22 个语言模块一起注册**——它是兜底不是语言,diff2html 对未知/无扩展名文件把语言改写成字面量 `'plaintext'` 再无条件调 hljs,而 `lib/core` 不自带它;漏注册时**炸的是整个 diff 视图不是那一个文件**(diff 里出现 `LICENSE`/`Dockerfile`/`.txt` 即触发)
- hljs 别名 `jsx`/`tsx`/`toml`/`html` 不是模块、不可单独 import
- hljs 主题 CSS 必须排在 `diff2html.min.css` **之前**,深色那份必须带 `(prefers-color-scheme: dark)`;两者保持 unlayered、禁入 `@layer`
- 改 diff2html 配色只能覆写 `--d2h-*`,禁用 Tailwind 工具类去压
- **我们自己那块 `--d2h-*` 映射同样禁入 `@layer`**——入层会被 diff2html 自己 `:host,:root` 里的 unlayered 默认值压回去,配色整片退回 GitHub 那套
- **且必须排在 diff2html 之后**:两者特异性同为 (0,1,0),胜出纯靠源码顺序,把 `@import "./vscode-theme.css"` 挪到 diff2html 之前会让 23 条覆写整片静默失效(两半都由 `pnpm check:css` 拦)
- 并排视图那对 `--d2h-change-*` **刻意与纯增删同色**(VS Code 没有这一档区分),是取舍不是漏映射
- **`Diff2HtmlUI` 的 `colorScheme` 必须传 `'light'`**——传 `'auto'` 会让 diff2html 自带的 `--d2h-dark-*` 压过我们的取值,深色一条都不生效,而页面只是"深色不太像 VS Code"
- **`@theme` 里没人引用的 token 会被 Tailwind 裁掉**,引用名写错则产物里留下无定义的 `var()`、属性静默变 unset(两者都由 `pnpm check:css` 拦)

### 包管理器(pnpm 11)

- 全部 pnpm 设置只写 `pnpm-workspace.yaml`;**禁写 `package.json` 的 `pnpm` 字段或 `.npmrc`**——pnpm 11 静默忽略(`.npmrc` 只留 registry/auth)
- 禁 `shamefullyHoist` / `nodeLinker: hoisted`;被 import 的包必须由自己声明(diff2html 的 `diff` / `@profoundlogic/hogan` 不得直接引用)
- 依赖的生命周期脚本默认不跑,需要跑的必须显式进 **`allowBuilds`**(已知 `lefthook`)——漏列时安装本身是成功的、只是脚本被静默跳过
- 上条的判据是两条并列:**`pnpm ignored-builds` 报 `None`** + 钩子文件实际存在。**只看钩子文件会在 CI 上假红**(lefthook 的 postinstall 检测到 `CI` 就跳过 `lefthook install`),故安装步骤必须设 `LEFTHOOK=1`
- CI matrix 档完全不装依赖、冒烟直接 `node --test`,禁止改成经 `pnpm` script 跑或"装一点点"
- CI 用 `pnpm/action-setup` 读 `packageManager` 字段,禁 `corepack enable`

### 运行时与安全

- `dependencies` 保持为空、后端只用标准库。两侧都有门禁:`check:pack` 查 manifest 的三个依赖字段,冒烟查 `dist/server/main.js` 的 import 说明符是否全部以 `node:` 开头——**只查发布文件清单是查不出加依赖的**
- `bin/gitglance.js` 手写、不参与 TS 编译、不作打包入口;禁止依赖 Node 原生 type stripping 直接跑 `.ts` 产品代码
- 校验 `Host` 头才是 DNS rebinding 的正面防御,禁止只靠 token
- **后端零 dev 分支**:禁为本地开发加放宽 Host / Origin / token 校验的环境变量或分支
- 单实例注册表写 `os.tmpdir()`(禁写 `.git/` 或工作区),`0o600` + `O_EXCL` 创建
- 陈旧实例用 HTTP 探活而非 pid,**命中要「200」与「repo 路径归一后相等」两条同时成立**,探活自己也带 token 与合规 Host——只认 200 会在端口被回收后把用户带到别人的页面,漏带 token 则每个活实例都被判陈旧、复用静默失效
- **空闲计时从启动那一刻就起**,不等第一个客户端——否则浏览器没拉起来就留常驻进程
- **重新武装接在 SSE 通道的 `onChange` 上而非端点**——端点各记一次时漏掉断连那侧不报错,只是关完标签也不退
- **注册表的键必须归一化后再 hash**:写入侧是 `git rev-parse --show-toplevel`、读取侧是 `process.cwd()`,同一目录字面量未必相同(Windows 的 `/` vs `\`、macOS 的 `/var` 符号链接)
- 清理时**解析失败不等于是自己的**——会删掉另一个活着实例的条目
- **退出前的报错一律 `writeSync(2, …)`,禁 `process.stderr.write` + `process.exit`**——后者写管道时在 Windows 上是异步的,整条消息会被丢掉,症状是 stderr 全空
- **读端可能先走**(`| head -1`):`writeSync` 裹 try/catch,入口再给 stdout / stderr 各挂一个只咽 EPIPE 的 `'error'` 监听器——漏了这条连普通的 `process.stdout.write` 都能带裸栈打死进程(macOS / Linux 一声不响)
- **探活这类拿到响应头之后的 `req.destroy()` 也要自己 `resolve`**——那之后错误只落在 `res` 上而 `IncomingMessage` 会把它吞掉,超时形同虚设、启动整个吊死
- 只读性验证**禁用「前后 `git status` 比对」**,主门禁的记录手段是 `GIT_TRACE=<绝对路径>`(禁在 PATH 上放 fake git wrapper,Windows 上两种形态都落不了地)
- 门禁里必须有一条**「确实记到了东西」的正面断言**,否则白名单会对着空数组通过
- 第二层同理:A 半要有「锁真的锁上了」的探针(root / 容器 / Windows 下 chmod 不生效),B 半要有「不设 `GIT_OPTIONAL_LOCKS=0` 的对照组确实改了 `.git`」的断言,否则比对的是一个本来就不会变的 `.git`

### 测试布局

- `vitest.config.ts` 的 `projects` 分环境(`test/unit/server/`=node、`test/unit/web/`=happy-dom)。`environmentMatchGlobs` 在 Vitest 4 已被移除,**因此 include 是几条具体路径**
- 放到 `test/unit/` 底下或第三个子目录里的用例**不属于任何 project、压根不会被跑,且套件照常全绿**
- `test/unit/server/test-layout.test.ts` 钉着这条,它直接 import `vitest.config.ts` 把 include 编成正则(不抄目录白名单),所以加 project 不必同步任何清单

## 6. 明确不做

**长期不做**是架构性承诺,破例等于变成另一个产品;**首版不做**是本版范围收窄。**两类在开发期同为硬约束——"首版不做"不等于"可以先做"。**

- 长期:**任何仓库写操作**(不 stage/unstage、不 commit、不 discard、不 pull/push/sync、不建/切分支、不 stash;作用域见第 1 节)、代码编辑功能、账号体系与云同步、多用户协作交互
- 首版:提交历史查看、分支列表展示(只展示当前分支)、逐行 blame 等 GitLens 类深度追溯

## 7. 开发阶段

**当前:S5 已收口(CI 全绿,17 个作业);`acceptance.md` §6 至此一条未勾的都没有。下一步是 S6 开源准备。** 阶段序列与各阶段展开见 `roadmap.md` §7,已收口阶段的实测数字与踩坑见 `docs/journal.md` —— 两处都不在本节留副本。版本从 **0.1.0** 起,License MIT。

**未消费的跨阶段交接**——本节是它的唯一来源,消费掉即从这里删除,连同该阶段的收口记录一起落到 `docs/journal.md`。

- **→ S6 的两件事,都在 CI 之外**(理由见 `acceptance.md` §6 开头的「真机」口径):① **浏览器在 Windows / Linux 桌面上真的弹出来**——runner 没有桌面会话,命令选择与 argv 由 `browser.test.ts` 与 §5.10 的单点断言覆盖,弹窗与否只能靠首个真实用户;② §5.9 那条 token 经命令行的已知边界在 `xdg-open` 下有多宽仍未实测,**且不打算靠 CI 补**(headless 上 `xdg-open` 立刻失败,量出来是个会让人放心的假数)。两条都不阻塞发布,但 README / RELEASE 说明里该提一句

**流程规则**

- **每阶段完成即自查,不堆到后期**:对照 `acceptance.md` §6 本阶段的 `[Sx]` 验收项,并满足 `workflow.md` §9 的四条收口判据
- **打勾以 CI 绿为准,不以本机绿为准**;`[Sx/Sy]` 做完前一半也不勾
- **S6 收口后本节整体退场**,换成发布与维护约定——阶段推进结束,留一句"S6 已收口"没有读者(判据见 `workflow.md` §9)
