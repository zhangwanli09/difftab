# GitGlance

一眼看懂 AI 编码 Agent 改了哪些代码。CLI 在仓库目录启动 → 拉起本地网页 → 只读展示当前工作区的 diff 与分支状态 → 关掉标签页后进程自动退出。

**需求唯一事实来源:`docs/spec.md`。需求要变,先改 spec 再改代码**,不要在实现里就地"顺手扩展"。本文件只承载摘要与路由,论证与实测证据都在 spec。

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

| 用途 | 命令 | 状态 |
|---|---|---|
| 本地启动(构建产物) | `node bin/gitglance.js`(在任意 git 仓库目录下) | S1 接真实流程 |
| 开发模式(Vite dev server + 后端) | `pnpm dev` | ✅ S0(后端待 S1) |
| 构建(前端 Vite + 后端 tsdown) | `pnpm build`(= `build:web` + `build:server`) | ✅ S0 |
| 类型检查 | `pnpm typecheck`(`tsc --noEmit`,前后端各一份 tsconfig,严格性开关共用 `tsconfig.base.json`) | ✅ S0 |
| 格式化 + lint | `pnpm lint`(`biome check`)/ CI 用 `biome ci` | ✅ S0 |
| 单元/集成测试(Vitest,直接跑 TS 源码) | `pnpm test`。用例按被测代码分 `test/unit/server/` 与 `test/unit/web/`,分别归两份 tsconfig | ✅ S0(hljs 语言装配) |
| 冒烟测试(纯 JS,跑构建产物,含只读性两层验证) | `pnpm test:smoke`(CI matrix 档不经 script,直接 `node --test "test/smoke/*.test.js"`) | ✅ S0(版本守卫、版本号一致性、产物只 import 标准库);第一层(git 白名单断言)S1 入 CI,第二层(只读 `.git`)S2 入 CI |
| 测试仓库 fixture 生成 | `pnpm fixtures` | 第一批 S1,第二批 S4 |
| 冷启动耗时测量(对构建产物,≤300ms 门禁) | `pnpm bench:startup` | ✅ S0 骨架,S1 接真实流程 |
| 产物体积门禁 | `pnpm size` | ✅ S0,S2 收口回填实测 |
| 样式层叠门禁(unlayered + hljs 在前 + 深色带媒体条件) | `pnpm check:css` | ✅ S0 |
| 发布产物内容门禁(`pnpm pack --dry-run --json`) | `pnpm check:pack` | ✅ S0 |
| `bin/gitglance.js` 未被构建管线触碰 | `pnpm check:bin`(内部跑一次完整构建) | ✅ S0 |

`fixtures` / `bench:startup` / `size` / `check:css` **只是别名**——脚本本体必须是零依赖纯 JS、可由 `node <路径>` 直接执行,因为它们要在没有 pnpm、没有 `node_modules` 的 CI matrix 机器上跑(见 spec §5.11)。`check:pack` / `check:bin` 需要 pnpm,只在 CI 的 build 作业跑。

架构边界由 `biome.json` 的 `noRestrictedImports` overrides 承担,随 `pnpm lint` / `biome ci` 一起跑,不另设命令:import 方向、`node:child_process` 只许出现在 `server/git` 与 `server/cli`、以及不得直接引用 diff2html 的传递依赖。**每个受限目录的 patterns 必须自带全部条目**——Biome 的 overrides 对同一规则是替换而非合并,靠后一条 override 覆盖同一文件时,前一条的 patterns 会整个失效。

## 4. 动手前先读 spec 的哪节

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

## 5. 红线

违反后**不报错、只是静默出错**的条目。理由与实测证据见 spec §10「被排除的做法」,架构边界一条见 spec §5.0。

- **架构边界**:git 子进程只能出现在 `server/git`、拉起浏览器只能出现在 `server/cli`——在别处调 git 即使命令只读也不报错,只是让 §5.10 只读门禁的断言点静默失去覆盖;`src/web` 不得 import `src/server`(`shared/` 除外);`server/git` / `server/watch` 不得反向 import `http` / `cli`
- **git 调用**:基准是 `git diff HEAD` 不是 `git diff`;列表类调用一律 `-z`;所有 diff 在封装层统一注入 `-c core.quotePath=false`(与 `-z` 互补,不可替代);`porcelain=v2 -z` 的重命名记录占**两个** NUL 段、无上游时不输出 `# branch.ab` 行;重命名取 diff 必须传新旧两个路径(`-M -- <新> <旧>`);diff 按文件懒加载,禁止一次性取全仓 diff;空树哈希硬编码(禁 `hash-object /dev/null`、禁 `mktree`),`--show-object-format` 非零退出即按 SHA-1;未跟踪文件手工构造 unified diff,禁 `--no-index`;降级轮询必须复用与主查询**逐字相同**的 `git status --porcelain=v2 --branch -uall -z`,禁裁剪参数(漏 `-uall` 会让已存在目录里的新增文件静默不刷新)
- **文件监听**:档位按 `process.versions.node` 做 semver 比对,禁用特性探测;`ignore` 传逐段匹配函数,禁字符串模式(含斜杠与不含斜杠的都禁);Linux 低版本不建递归 watch;B 档过滤必须在 debounce 之前;绝不对单个文件建 watch
- **前端与样式**:禁用三个 diff2html 预构建 UI bundle(深导入 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 是允许且推荐的);禁止自行重写它的高亮切分逻辑;hljs 别名 `jsx`/`tsx`/`toml`/`html` 不是模块、不可单独 import;hljs 主题 CSS 必须排在 `diff2html.min.css` 之前、深色那份必须带 `(prefers-color-scheme: dark)`;两者保持 unlayered、禁入 `@layer`;改 diff2html 配色只能覆写 `--d2h-*`,禁用 Tailwind 工具类去压
- **包管理器(pnpm 11)**:全部 pnpm 设置只写 `pnpm-workspace.yaml`——**禁写 `package.json` 的 `pnpm` 字段或 `.npmrc`,pnpm 11 静默忽略**(`.npmrc` 只留 registry/auth);禁 `shamefullyHoist` / `nodeLinker: hoisted`,被 import 的包必须由自己声明(diff2html 的 `diff` / `@profoundlogic/hogan` 不得直接引用);依赖的生命周期脚本默认不跑,需要跑的必须显式进 **`allowBuilds`**(已知 `lefthook`,以 `.git/hooks` 下钩子文件实际存在为准);CI matrix 档完全不装依赖、冒烟直接 `node --test`,禁止改成经 `pnpm` script 跑或"装一点点";CI 用 `pnpm/action-setup` 读 `packageManager` 字段,禁 `corepack enable`
- **运行时与安全**:`dependencies` 保持为空、后端只用标准库;`bin/gitglance.js` 手写、不参与 TS 编译、不作打包入口;禁止依赖 Node 原生 type stripping 直接跑 `.ts` 产品代码;校验 `Host` 头才是 DNS rebinding 的正面防御,禁止只靠 token;后端零 dev 分支(禁为本地开发加放宽 Host / Origin / token 校验的环境变量或分支);单实例注册表写 `os.tmpdir()`(禁写 `.git/` 或工作区)、`0o600` + `O_EXCL` 创建、陈旧实例用 HTTP 探活而非 pid;只读性验证禁用"前后 `git status` 比对"

## 6. 明确不做

**长期不做**是架构性承诺,破例等于变成另一个产品;**首版不做**是本版范围收窄。**两类在开发期同为硬约束——"首版不做"不等于"可以先做"。**

- 长期:**任何仓库写操作**(不 stage/unstage、不 commit、不 discard、不 pull/push/sync、不建/切分支、不 stash;作用域见第 1 节)、代码编辑功能、账号体系与云同步、多用户协作交互
- 首版:提交历史查看、分支列表展示(只展示当前分支)、逐行 blame 等 GitLens 类深度追溯

## 7. 开发阶段

S0 工具链脚手架(含 `pnpm-lock.yaml`、`pnpm-workspace.yaml` 的 `allowBuilds` 白名单、`.gitignore`、**手写定稿的 `bin/gitglance.js`**)+ 三项前提验证(在 pnpm 严格 node_modules 布局下跑)+ 三平台 CI 矩阵拉起 → S1 CLI + HTTP server(**含 §5.9 三道校验的最终形态**)+ **注册表文件写入(port + token)** + git 封装 + 只读主门禁 + fixture 第一批 → S2 变更列表 + diff2html 渲染 + 懒加载 → **S3a** 分支状态 → **S3b** 自动刷新 → **S3c** 进程生命周期(注册表**探活复用** + 空闲退出)→ S4 diff 边界情况 + git 异常状态 + fixture 第二批 → S5 Windows/Linux 真机验证 + 安全加固自查(**CI 跑通不等于可用**)→ S6 开源准备。各阶段展开见 spec §7。

- **S3a / S3b / S3c 按序逐个收口,不得并行推进**;S3b 的首个交付物是三档强制指定的环境变量
- **门禁不得晚于它所保护的代码**:只读白名单断言随 git 封装层在 S1 落地,安全校验随 server 在 S1 落地,注册表写入同期落地(dev proxy 靠它拿 token)——**不得为让 dev 跑通而在后端放宽校验**(见第 5 节红线)
- **每个阶段完成后立即对照 spec §6 中标记为本阶段的 `[Sx]` 验收项自查**,并满足 spec §9 的三条收口判据,不堆到后期集中验证
- 测试数据分两批,时机与清单见 spec §7 末段;fixture 脚本对测试仓库的 git 写操作属"开发流程的 git",见第 1 节
- 版本从 **0.1.0** 起,spec §6 全部通过 + 三端真机验证后才发 1.0.0。License MIT
