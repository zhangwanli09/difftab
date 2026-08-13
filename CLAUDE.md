# GitGlance

一眼看懂 AI 编码 Agent 改了哪些代码。CLI 在仓库目录启动 → 拉起本地网页 → 只读展示当前工作区的 diff 与分支状态 → 关掉标签页后进程自动退出。

**需求唯一事实来源:`docs/spec.md`。需求要变,先改 spec 再改代码**,不要在实现里就地"顺手扩展"。本文件只承载摘要与路由(预算 ≤ 200 行 / ≤ 20 KB,理由见 spec §9):论证与实测证据在 spec,已收口阶段的记录在 `docs/journal.md`。

## 1. 两个 git 作用域(别搞混)

| | 受"零写操作"约束 | |
|---|---|---|
| **产品运行时的 git**:gitglance 的代码在**用户仓库**里执行的 git 命令 | ✅ | 只允许只读白名单,由 spec §5.10 两层验证 + CI 门禁保证 |
| **开发流程的 git**:在 **gitglance 仓库自身**上的版本控制动作 | ❌ | `add` / `commit` / `branch` / `checkout` / `rebase` / `push` / 建 PR 全部正常允许 |

判据一句话:**约束的是"代码里写了什么 git 命令",不是"开发时执行了什么 git 命令"。不得以"本项目承诺只读"为由拒绝、劝阻或加额外确认本仓库的版本控制操作。** 正常礼节照旧:除非用户要求,不主动 commit / push。

## 2. 提交约定

- **英文** + **Conventional Commits**:`<type>(<scope>): <description>`,type 取 `feat`/`fix`/`docs`/`refactor`/`perf`/`test`/`build`/`ci`/`chore`,破坏性加 `!`
- 祈使语气,subject ≤ 50 不加句号,body 折 72 只写 what 与 why
- 一个提交一件事,不混重构与功能改动

## 3. 常用命令

包管理器为 **pnpm**,版本由 `package.json` 的 `packageManager` 字段固定;首次 clone 后 `pnpm install --frozen-lockfile`。

**每新增一个 `package.json` script,立即回来补全本节**——过期比缺失更糟。

全部已可用;哪个门禁是在哪个阶段建立的,见 `docs/journal.md`「附:门禁与测试是在哪个阶段建立的」。

| 用途 | 命令 |
|---|---|
| 本地启动(构建产物) | `node bin/gitglance.js`(在任意 git 仓库目录下;`--no-open` 只打印 URL) |
| 开发模式(Vite dev server + 后端) | 先在另一个终端 `node bin/gitglance.js --no-open`,再 `pnpm dev` —— dev proxy 在**加载时**从 `os.tmpdir()` 的注册表读 port + token,后端重启后 dev server 也要重启;后端**空闲 45 秒无客户端就自己退**(§5.8),来不及打开页面时用 `GITGLANCE_IDLE_MS` 顶大 |
| 构建(前端 Vite + 后端 tsdown) | `pnpm build`(= `build:web` + `build:server`) |
| 类型检查 | `pnpm typecheck`(`tsc --noEmit`,前后端各一份 tsconfig,严格性开关共用 `tsconfig.base.json`) |
| 格式化 + lint | `pnpm lint`(`biome check`)/ CI 用 `biome ci` |
| 单元/集成测试(Vitest,直接跑 TS 源码) | `pnpm test`。用例按被测代码分 `test/unit/server/`(node 环境)与 `test/unit/web/`(happy-dom),分别归两份 tsconfig,靠 `vitest.config.ts` 的 `projects` 分环境——**放错目录会静默不跑,判据见第 5 节** |
| 冒烟测试(纯 JS,跑构建产物,含只读性两层验证) | `pnpm test:smoke`(CI matrix 档不经 script,直接 `node --test "test/smoke/*.test.js"`) |
| 测试仓库 fixture 生成 | `pnpm fixtures`(默认写 `test/fixtures/repos/`;测试自己调 `makeFixtures()` 写临时目录)。第一批已就位,第二批归 S4a / S4b |
| 冷启动耗时测量(对构建产物,≤300ms 门禁) | `pnpm bench:startup` |
| 产物体积门禁 | `pnpm size` |
| 样式层叠门禁(unlayered + hljs 在前 + 深色带媒体条件 + 四条 `--d2h-*` 覆写判据) | `pnpm check:css` |
| 发布产物内容门禁(`pnpm pack --dry-run --json`) | `pnpm check:pack` |
| `bin/gitglance.js` 未被构建管线触碰 | `pnpm check:bin`(内部跑一次完整构建) |

`fixtures` / `bench:startup` / `size` / `check:css` **只是别名**——脚本本体必须是零依赖纯 JS、可由 `node <路径>` 直接执行,因为它们要在没有 pnpm、没有 `node_modules` 的 CI matrix 机器上跑(见 spec §5.11)。`check:pack` / `check:bin` 需要 pnpm,只在 CI 的 build 作业跑。

架构边界由 `biome.json` 的 `noRestrictedImports` overrides 承担,随 `pnpm lint` / `biome ci` 一起跑,不另设命令:import 方向、`node:child_process` 只许出现在 `server/git` 与 `server/cli`、以及不得直接引用 diff2html 的传递依赖。**每个受限目录的 patterns 必须自带全部条目**——Biome 的 overrides 对同一规则是替换而非合并,靠后一条 override 覆盖同一文件时,前一条的 patterns 会整个失效。

## 4. 动手前先读 spec 的哪节

**改这块 → 读哪节**

| 改这块 | 动手前读 |
|---|---|
| 新增模块/文件、目录归属、依赖方向 | spec §5.0 |
| HTTP/SSE 接口、前后端协议类型 | spec §5.12 |
| git 封装层、status/diff 解析、git 异常状态 | spec §5.2、§5.3 |
| 文件监听、自动刷新、进程生命周期 | spec §5.7、§5.8 |
| 前端组件、状态管理(signals)、框架选型 | spec §5.4 |
| diff 渲染、hljs 语言清单、产物体积 | spec §5.5 |
| 样式、主题与层叠 | spec §5.6 |
| HTTP server、token、CSP | spec §5.9 |
| CLI 入口、Node 版本下限、后端产物形态 | spec §5.1 |
| 构建配置、CI 分层、tsconfig、dev proxy | spec §5.11 |
| 只读性验证、冷启动与体积门禁 | spec §5.10、§6 |

**做哪个阶段 → 本会话必读哪几节**。spec 全文约 47k token,整篇读进来会挤掉实现所需的上下文;按本表只读该阶段真正用得上的几节(约 20k),是 spec §7 把 S2 / S3b / S4 拆成子阶段时一并定下的切口。**"明确不必读"是省上下文的手段,不是豁免**——第 5 节红线全程有效,与本会话读没读对应小节无关。

**只列尚未收口的阶段**;已收口阶段当时的切口见 `docs/journal.md`「附:已收口阶段的 spec 阅读切口」。

| 做这个阶段 | 本会话必读 | 明确不必读 |
|---|---|---|
| **S4a** diff 边界情况 | §5.2、§5.12 的 `DiffPayload`、§10「git 行为」、§7 的 fixture 第二批清单 | §5.6、§5.7、§5.11 |
| **S4b** git 异常状态 | §5.3、§5.2 的仓库定位段、§5.12 的 `BranchState`、§10「git 行为」 | §5.5、§5.6、§5.7 |
| **S5** 三端真机 + 安全自查 | §5.9、§5.1 的拉起浏览器段、§6 全表复核 | — |
| **S6** 开源准备 | §8 | — |

## 5. 红线

违反后**不报错、只是静默出错**的条目。理由与实测证据见 spec §10「被排除的做法」,架构边界一条见 spec §5.0。

- **架构边界**:git 子进程只能出现在 `server/git`、拉起浏览器只能出现在 `server/cli`——在别处调 git 即使命令只读也不报错,只是让 §5.10 只读门禁的断言点静默失去覆盖;`src/web` 不得 import `src/server`(`shared/` 除外);`server/git` / `server/watch` 不得反向 import `http` / `cli`。这三条现由 `biome.json` 静态拦截(见第 3 节末),但**红线仍是红线**:lint 只看 import 说明符,换个拿到 `child_process` 的方式就绕过去了。`scripts/` 与 `test/` 不在管辖范围内——它们本来就要起子进程
- **git 调用**:基准是 `git diff HEAD` 不是 `git diff`;列表类调用一律 `-z`;所有 diff 在封装层统一注入 `-c core.quotePath=false`(与 `-z` 互补,不可替代);封装层统一设 `GIT_OPTIONAL_LOCKS=0`(否则 `git status` 会把 stat 缓存写回 `.git/index`——不改变 status 输出,**而且只读 `.git` 下 git 也只是静默跳过、exit 0、stderr 全空**,所以只有 §5.10 第二层 B 半的逐字节快照比对看得见它);`porcelain=v2 -z` 的重命名记录占**两个** NUL 段、无上游时不输出 `# branch.ab` 行;重命名取 diff 必须传新旧两个路径(`-M -- <新> <旧>`);diff 按文件懒加载,禁止一次性取全仓 diff;空树哈希硬编码(禁 `hash-object /dev/null`、禁 `mktree`),`--show-object-format` 非零退出即按 SHA-1;未跟踪文件手工构造 unified diff,禁 `--no-index`;**"已跟踪"的判据是 HEAD ∪ index,不是 index**——只查 `git ls-files` 会把已暂存的删除(`git rm` 之后路径已从 index 摘掉,但 status 照报 `1 D.`)误判成未跟踪,进而去读一个不存在的文件;**未跟踪那条路读磁盘必须 `lstat` 不得 `stat`**——`git status -uall` 把未跟踪符号链接报成 `?`,它进列表、点得到,而 `stat` 跟随链接会让仓库边界校验形同虚设(校验的是链接自身的路径,读到的是链接目标),一个指向仓库外的链接就能把外部文件内容当作新增文件返回;降级轮询必须复用与主查询**逐字相同**的 `git status --porcelain=v2 --branch -uall -z`,禁裁剪参数(漏 `-uall` 会让已存在目录里的新增文件静默不刷新)
- **文件监听**:档位按 `process.versions.node` 做 semver 比对,禁用特性探测;`ignore` 传逐段匹配函数,禁字符串模式(含斜杠与不含斜杠的都禁);Linux 低版本不建递归 watch;B 档过滤必须在 debounce 之前;绝不对单个文件建 watch
- **前端与样式**:禁用三个 diff2html 预构建 UI bundle(深导入 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 是允许且推荐的);禁止自行重写它的高亮切分逻辑;**`highlight: true` 时 `draw()` 内部已经调过 `highlightCode()`,不得在 `draw()` 后再补一次**(第二遍会把两份 node stream 交织成嵌套重复的 span,开销也翻倍);**`plaintext` 必须与 22 个语言模块一起注册**——它是兜底不是语言,diff2html 对未知/无扩展名文件把语言改写成字面量 `'plaintext'` 再无条件调 hljs,而 `lib/core` 不自带它,漏注册时异常冒到调用方,**炸的是整个 diff 视图不是那一个文件**(diff 里出现 `LICENSE`/`Dockerfile`/`.txt` 即触发,spike 样例发现不了);hljs 别名 `jsx`/`tsx`/`toml`/`html` 不是模块、不可单独 import;hljs 主题 CSS 必须排在 `diff2html.min.css` 之前、深色那份必须带 `(prefers-color-scheme: dark)`;两者保持 unlayered、禁入 `@layer`;改 diff2html 配色只能覆写 `--d2h-*`,禁用 Tailwind 工具类去压;**我们自己那块 `--d2h-*` 映射同样禁入 `@layer`**——入层会被 diff2html 自己 `:host,:root` 里的默认值(unlayered)压回去,配色整片退回 GitHub 那套;**而且"unlayered"只是一半,另一半是"排在 diff2html 之后"**:两者特异性同为 (0,1,0),胜出纯靠源码顺序,把 `@import "./vscode-theme.css"` 挪到 diff2html 之前会让 23 条覆写整片静默失效(两半都由 `pnpm check:css` 拦);并排视图那对 `--d2h-change-*` **刻意与纯增删同色**(VS Code 没有这一档区分),是取舍不是漏映射;**`Diff2HtmlUI` 的 `colorScheme` 必须传 `'light'`**,传 `'auto'` 会让 `.d2h-auto-color-scheme` 前缀规则(0,2,0)压过基础规则、读回 diff2html 自带的 `--d2h-dark-*`,我们的 VS Code 深色取值一条都不生效(而页面只是"深色不太像 VS Code");**`@theme` 里没人引用的 token 会被 Tailwind 裁掉**,引用名写错则产物里留下无定义的 `var()`、属性静默变 unset(两者都由 `pnpm check:css` 拦)
- **包管理器(pnpm 11)**:全部 pnpm 设置只写 `pnpm-workspace.yaml`——**禁写 `package.json` 的 `pnpm` 字段或 `.npmrc`,pnpm 11 静默忽略**(`.npmrc` 只留 registry/auth);禁 `shamefullyHoist` / `nodeLinker: hoisted`,被 import 的包必须由自己声明(diff2html 的 `diff` / `@profoundlogic/hogan` 不得直接引用);依赖的生命周期脚本默认不跑,需要跑的必须显式进 **`allowBuilds`**(已知 `lefthook`)——判据是 **`pnpm ignored-builds` 报 `None`** 加上钩子文件实际存在两条,漏列时安装本身是成功的、只是脚本被静默跳过。**只看钩子文件会在 CI 上假红**:lefthook 的 postinstall 检测到 `CI` 就跳过 `lefthook install`,必须给安装步骤设 `LEFTHOOK=1`(已实测);CI matrix 档完全不装依赖、冒烟直接 `node --test`,禁止改成经 `pnpm` script 跑或"装一点点";CI 用 `pnpm/action-setup` 读 `packageManager` 字段,禁 `corepack enable`
- **运行时与安全**:`dependencies` 保持为空、后端只用标准库(两侧都有门禁:`check:pack` 查 manifest 的三个依赖字段,冒烟查 `dist/server/main.js` 的 import 说明符是否全部以 `node:` 开头——**只查发布文件清单是查不出加依赖的**,加一个运行时依赖不会改变文件清单);`bin/gitglance.js` 手写、不参与 TS 编译、不作打包入口;禁止依赖 Node 原生 type stripping 直接跑 `.ts` 产品代码;校验 `Host` 头才是 DNS rebinding 的正面防御,禁止只靠 token;后端零 dev 分支(禁为本地开发加放宽 Host / Origin / token 校验的环境变量或分支);单实例注册表写 `os.tmpdir()`(禁写 `.git/` 或工作区)、`0o600` + `O_EXCL` 创建、陈旧实例用 HTTP 探活而非 pid,**命中要 200 与 repo 路径归一后相等两条同时成立**(探活自己也带 token 与合规 Host;只认 200 会在端口被回收后把用户带到别人的页面,漏带 token 则每个活实例都被判陈旧、复用静默失效),**空闲计时从启动那一刻就起**(不等第一个客户端,否则浏览器没拉起来就留常驻进程)、**重新武装接在 SSE 通道的 `onChange` 上而非端点**(端点各记一次时漏掉断连那侧不报错,只是关完标签也不退),**键必须归一化后再 hash**(写入侧是 `git rev-parse --show-toplevel`、读取侧是 `process.cwd()`,同一目录字面量未必相同:Windows 的 `/` vs `\`、macOS 的 `/var` 符号链接),**清理时解析失败不等于是自己的**(会删掉另一个活着实例的条目);**退出前的报错一律 `writeSync(2, …)`,禁 `process.stderr.write` + `process.exit`**——后者写管道时在 Windows 上是异步的,整条消息会被丢掉,症状是 stderr 全空;**读端可能先走**(`| head -1`):`writeSync` 裹 try/catch,入口再给 stdout / stderr 各挂一个只咽 EPIPE 的 `'error'` 监听器——**管道写只在 Windows 上是异步的**,漏了这条连普通的 `process.stdout.write` 都能带裸栈打死进程(实测 243ms,macOS / Linux 一声不响);**探活这类拿到响应头之后的 `req.destroy()` 也要自己 `resolve`**,那之后错误只落在 `res` 上而 `IncomingMessage` 会把它吞掉,超时形同虚设、启动整个吊死(两条均已实测,见 spec §10);只读性验证禁用"前后 `git status` 比对",主门禁的记录手段是 `GIT_TRACE=<绝对路径>`(禁 PATH 上放 fake git wrapper——Windows 上两种形态都落不了地,见 spec §10),且门禁里必须有一条"确实记到了东西"的正面断言,否则白名单会对着空数组通过;**第二层同理**——A 半要有"锁真的锁上了"的探针(root / 容器 / Windows 下 chmod 不生效),B 半要有"不设 `GIT_OPTIONAL_LOCKS=0` 的对照组确实改了 `.git`"的断言,否则比对的是一个本来就不会变的 `.git`

- **测试布局**:`vitest.config.ts` 的 `projects` 分环境(`test/unit/server/`=node、`test/unit/web/`=happy-dom),`environmentMatchGlobs` 在 Vitest 4 已被移除,**因此 include 是几条具体路径**——放到 `test/unit/` 底下或第三个子目录里的用例不属于任何 project、压根不会被跑,**且套件照常全绿**。`test/unit/server/test-layout.test.ts` 钉着这条,它**直接 import `vitest.config.ts` 把 include 编成正则**(不抄目录白名单:`server` 那档只收 `*.test.ts`,白名单式判据会漏掉 `test/unit/server/foo.test.tsx`),所以加 project 不必同步任何清单

## 6. 明确不做

**长期不做**是架构性承诺,破例等于变成另一个产品;**首版不做**是本版范围收窄。**两类在开发期同为硬约束——"首版不做"不等于"可以先做"。**

- 长期:**任何仓库写操作**(不 stage/unstage、不 commit、不 discard、不 pull/push/sync、不建/切分支、不 stash;作用域见第 1 节)、代码编辑功能、账号体系与云同步、多用户协作交互
- 首版:提交历史查看、分支列表展示(只展示当前分支)、逐行 blame 等 GitLens 类深度追溯

## 7. 开发阶段

S0 工具链脚手架 → S1 CLI + HTTP server(**含 §5.9 三道校验的最终形态**)+ **注册表文件写入(port + token)** + git 封装 + 只读主门禁 + fixture 第一批 → **S2a** 变更列表 + 只读 `.git` 第二层 → **S2b** diff2html 渲染 + 懒加载 → **S2c** 主题样式 + 体积收口 → **S3a** 分支状态 → **S3b1** SSE 通道 + 档位骨架 → **S3b2** 三档监听 + 轮询兜底 → **S3c** 进程生命周期(注册表**探活复用** + 空闲退出)→ **S4a** diff 边界情况 → **S4b** git 异常状态(两者各配一半 fixture 第二批)→ **S5** Windows/Linux 真机验证 + 安全加固自查(**CI 跑通不等于可用**)→ **S6** 开源准备。各阶段展开见 spec §7,**已收口阶段的实测数字与踩坑记录见 `docs/journal.md`**(本节不留副本)。

**当前:S3c 已收口(CI 全绿,run `31708311355` 11 个作业),下一步 S4a。**

- 体积不变(JS 201.4 KB / gzip 67.5 / CSS 28.5);冷启动中位 42.5ms —— 探活没进冷启动路径,注册表不存在时压根不发请求
- spec §6 的 2 个 `[S3c]` 已勾;「刷新 / 休眠唤醒 / 后台标签」那条改标 `[S3c/S5]`(休眠唤醒的半开 TCP 只有真机验得了),按规矩不勾

**未消费的跨阶段交接**——消费掉即从本节删除,连同该阶段的收口记录一起落到 `docs/journal.md`。

- **→ S4b(一条)**:header 现在是**一个 guard 包住两项**(`BranchStatus` + `WatchBadge`),S4b 的 `operation` 标注直接加在同一个 guard 里,别再回到每项各写一次 `state !== null`
- **→ S5(两条)**:① Linux 上「启动时 inotify 配额已被别的工具耗尽」这一种 ENOSPC **检测不到**——`kFSWatchStart` 把根那次注册的失败整个吞掉(只有 ENOENT 会抛),`fs.watch()` 返回一个看着活着、永远不 emit 的 watcher,于是 `mode` 停在 `native`、工作区从此静默不刷新;遍历**途中**耗尽则照常抛得出来、兜底生效。两条候选补法(低频安全轮询 / 建流前先探一次非递归 watch)**择一的判据留给 S5 在真机上压低 `max_user_watches` 实测**,现在不猜。已写进 spec §5.7 与 §10;② **系统休眠唤醒**要在真机上过一遍:它与「刷新 / 后台标签」的区别是网卡断开后留下的**半开 TCP**(`readyState` 照样 `OPEN`,`error` 永远不来),前端那条 `STALE_MS` 判定只有单测覆盖过

**流程规则**

- **全部子阶段按序逐个收口,不得并行推进**(S2a→S2b→S2c、S3a→S3b1→S3b2→S3c、S4a→S4b);S3b1 的首个交付物是三档强制指定的环境变量。拆分依据见 spec §7,**开工第一件事是按第 4 节那张阶段表确定本会话该读 spec 哪几节**
- **门禁不得晚于它所保护的代码**:只读白名单断言随 git 封装层在 S1 落地,安全校验随 server 在 S1 落地,注册表写入同期落地(dev proxy 靠它拿 token),只读 `.git` 第二层前移到 S2a(它保护的封装层 S1 就有了)——**不得为让 dev 跑通而在后端放宽校验**(见第 5 节红线)
- **每个阶段完成后立即对照 spec §6 中标记为本阶段的 `[Sx]` 验收项自查**,并满足 spec §9 的四条收口判据(第 4 条:收口记录写 `docs/journal.md`、本节只留当前进度与未消费的交接、核对本文件仍在 200 行 / 20 KB 预算内),不堆到后期集中验证
- **打勾以 CI 绿为准,不以本机绿为准**;`[Sx/Sy]` 做完前一半也不勾。本机绿而 CI 红是常态(见第 5 节 `allowBuilds` 那条的实测)
- 测试数据分两批,时机与清单见 spec §7 末段;fixture 脚本对测试仓库的 git 写操作属"开发流程的 git",见第 1 节
- 版本从 **0.1.0** 起,spec §6 全部通过 + 三端真机验证后才发 1.0.0。License MIT
