# 架构边界、工具链与只读性验证

> 本文的工具链部分为**开发期依赖**，不进 `dependencies`、不随 npm 包分发给用户，不改变「运行时只用 Node 标准库」这条约束（见 [`server.md`](server.md)）。被排除的做法与实测证据见 `../decisions.md` 的[「只读性验证与本地安全」](../decisions.md#只读性验证与本地安全)与[「工具链与发布」](../decisions.md#工具链与发布)两节，门禁见 [`../gates.md`](../gates.md)。

## 架构总览

数据流一句话：**CLI 定位仓库并拉起 HTTP server → 浏览器经 HTTP 拿只读数据、经 SSE 收变更通知 → server 把请求转给 git 封装层与文件监听层**。产品代码内不存在其他方向的调用。

**模块级目录结构**（只定「哪类东西放哪个模块」，不定文件切分）：

```
bin/difftab.js       版本守卫 + 动态 import，手写 JS，不参与构建
src/server/
  cli/                 参数解析、仓库定位与前置检查、拉起浏览器、单实例注册表
  http/                node:http server、路由、三道校验、dist/web 静态托管
  git/                 唯一的 git 子进程出口：status / diff / numstat 调用与解析
  watch/               三档监听 + debounce + 轮询兜底
  shared/              前后端共用的协议类型
src/web/
  components/          变更列表、分支状态、diff 容器
  diff/                diff2html 深导入 + hljs 语言注册
  state/               signals
  styles/              app.css / vscode-theme.css
test/unit/             Vitest，跑 TS 源码
test/smoke/            纯 JS，跑 dist/ 产物（含只读性两层验证）
test/fixtures/         测试仓库生成脚本
scripts/               bench:startup、size 等门禁
```

**依赖方向**（单向，可静态断言）：`bin → server/cli → server/http → {server/git, server/watch}`。`src/web` 除 `server/shared/` 外**不得 import `src/server` 下任何模块**；`server/git` 与 `server/watch` **不得反向 import `http` / `cli`**。

### 四条边界不变式

这四条不是风格偏好，每一条都是某道门禁能够成立的前提，违反后**不报错、只是让门禁静默失去覆盖**：

1. **`server/git` 是产品代码中唯一执行 git 子进程的位置。** 只读主门禁「断言 git 子命令只出现在只读白名单」、以及封装层那三个统一注入的参数，都依赖这个单点。其他模块即便只调只读命令也算违规——门禁的低成本可断言性正来自「只有一处」。那个单点里发的是哪些命令、每条为什么必须那么发，见 [`git.md`](git.md)。
2. **拉起浏览器是唯一的非 git 子进程调用**，位于 `server/cli`，即只读门禁已写明需要显式开口子的那一处。产品代码中出现第三处子进程调用，须先改本节。
3. **`server/http` 不直接触碰 git 与文件监听**，只调用 `git` / `watch` 模块导出的函数。这保证三道校验位于唯一入口，不会被某条旁路绕开。
4. **前端不内联任何 git 知识**（状态位含义、空树哈希、路径转义规则、重命名判定），一律由 `shared/` 的协议类型承载。否则 git 那侧的约束会出现第二份实现，而第二份不受只读门禁覆盖。

前三条中 import 方向那半由 `biome.json` 的 `noRestrictedImports` 静态拦截，随 `pnpm lint` 一起跑。**但 lint 只看 import 说明符**，换个拿到 `child_process` 的方式就绕过去了——红线仍是红线。每个受限目录的 patterns 必须**自带全部条目**：Biome 的 overrides 对同一规则是替换而非合并，靠后一条覆盖同一文件时，前一条的 patterns 会整个失效。`scripts/` 与 `test/` 不在管辖范围内——它们本来就要起子进程。

**本节的修改边界**：只定模块归属与依赖方向，**不定文件切分**——文件级清单会随实施推进立刻过期，而模块边界稳定且正是门禁所依赖的东西。新增或拆分文件不必改本文；**改变模块归属、依赖方向，或上述任一不变式，才须先改这里**。

## 只读性的验证方式

「零写操作」是产品核心承诺，需要能自动化证伪，而不是靠人工审查代码。**「前后 `git status` 比对」强度不足**——它发现不了写进 `.git/` 但不改变 status 输出的操作（意外触发 gc、写 index、创建对象）。因此采用两层验证，均纳入 CI 门禁。

### 第一层 · 主门禁（`test/smoke/readonly.test.js`）

测试期间用 git 自带的 **`GIT_TRACE=<绝对路径>`** 记录产品发出的每一次 git 调用（含完整参数），断言子命令只出现在只读白名单（`status` / `diff` / `rev-parse` / `ls-files` / `version` 等）。

- **不用「PATH 上放一个 fake git wrapper」**：那要求一个 Windows 认得的可执行文件，而 Node 自 20.12 起不带 `shell` 就**拒绝 spawn `.cmd` / `.bat`**；退而把 node 二进制装成 `git` 时，node 自己的 CLI 解析会先把参数吃掉一截，记到的「完整子命令」是错的。`GIT_TRACE` 三端同一套写法。
- `GIT_TRACE` 反而多覆盖一层：git **内部**再起的子进程（自动 gc 之类）同样入账，而那正是「写进 `.git/` 但不改变 status 输出」的典型。
- **必须同时断言「确实记到了东西」**：环境变量没传下去、路径给成相对的、产品换了个不经封装层的方式调 git，都会让白名单断言对着一个**空数组**通过。**假绿的只读门禁比没有门禁更糟**，因此完整流程跑完后，日志里必须见到 `status` / `diff` / `rev-parse` / `ls-files`。

### 第二层 · `.git` 没被动过（`test/smoke/readonly-git-dir.test.js`）

由**两半**组成，缺一不可：

- **A · 只读 `.git`**：`chmod -R a-w .git` 后跑完整流程，凡是**会报错**的写尝试当场暴露。Windows 上 `chmod` 挡不住写入（Node 只映射只读属性，对目录无效），改用 `icacls` 的拒绝 ACL，拿不到则**显式跳过并打印原因**，不得静默通过。这一半必须自带一条「锁真的锁上了」的探针断言——root 用户、某些容器挂载下 `chmod` 不生效，那时用例照常变绿却什么都没验证。
- **B · `.git` 逐字节不变**：在**可写**的 `.git` 上前后各拍一次快照（每个文件的 size + mtime + 内容摘要）并比对。**A 单独不成立**：git 把 index 回写当作 best-effort，`.git` 只读时它**静默跳过、exit 0、stderr 全空**——于是漏掉 `GIT_OPTIONAL_LOCKS=0` 时 A 照样全绿，而那恰恰是本层唯一要保护的东西。
  - B 需要一个**会触发 index 回写**的仓库状态（把某个「内容与 index 一致、只是 stat 过期」的文件的 mtime 改旧），并自带一条**正面对照**：同一仓库上直接跑一条不设 `GIT_OPTIONAL_LOCKS=0` 的 `git status`，断言 `.git` 这次确实变了。没有它，「产品没改动 `.git`」会在仓库压根不触发回写时变成一句对谁都成立的空话。

### 唯一的非 git 子进程豁免

拉起浏览器（`open` / `cmd /c start ""` / `xdg-open`）不经过 git 封装层、`GIT_TRACE` 也记不到，因此需在测试里**单独断言**：产品代码中除 git 封装层外只存在这一处 `child_process` 调用，且被调命令来自这三者的固定映射、参数只有 URL 一项。**该静态断言查的是相等而非「没有多余的」**——只查多出来的一半时，两处调用点双双改名会让白名单静默变成空表。CI 里该调用需可通过环境变量关闭，避免每次跑测试都弹出浏览器。

## 工具链

| 位置 | 选型 | 理由 |
|---|---|---|
| 包管理器 | pnpm 11 | 严格 node_modules（不扁平化）+ 内容寻址存储。**版本的唯一事实来源是 `package.json` 的 `packageManager` 字段** |
| 构建 | Vite（Rolldown / Oxc） | Rolldown 已为默认 bundler |
| 语言 | TypeScript（**仅 `--noEmit` 类型检查**） | 本项目不需要 declaration emit，转译交给 Vite / tsdown。**二进制名是 `tsc`**——`tsgo` 是预览包的名字，稳定版并入主包后已回归 `tsc` |
| 前端框架 | Preact + @preact/signals | 见 [`web.md`](web.md) |
| 样式 | Tailwind v4 + `@tailwindcss/vite` | 见 [`web.md`](web.md) |
| 后端打包 | tsdown（Rolldown 系） | 与 Vite 同引擎，产出单文件 ESM |
| 格式化 / lint | Biome | 一个二进制覆盖 format + lint + import 排序，一份配置 |
| git hooks | lefthook | 单 YAML，不需要额外的 lint-staged |
| 测试 | Vitest + `node:test` | 分层用途见下方 CI |
| DOM 测试环境 | happy-dom | 只给 `src/web` 的渲染路径用，按目录分环境 |

**DOM 测试环境**：几条「违反后不报错、只是静默出错」的约束——`draw()` 后重复调 `highlightCode()` 产生嵌套重复 span、漏注册 `plaintext` 炸掉整个 diff 视图、`colorScheme` 一旦回到 `auto` 就让深色取值静默失效——**都只有在真实 DOM 上跑一遍才断言得了**。选 happy-dom 而非 jsdom：纯 JS、无原生依赖、启动快，本项目只需要 `innerHTML` 与属性/class 断言这一档能力。

- **环境按目录分，不全局开**：`test/unit/web/` 用 happy-dom，`test/unit/server/` 保持 node。给后端用例套一层 DOM 全局，是把「前端拿不到也不该拿到 Node API」那条边界反向捅一刀。
- **落地方式是 Vitest 的 `projects`，不是 `environmentMatchGlobs`**——后者在 Vitest 4 已被移除，**因此 include 是几条具体路径**。放到 `test/unit/` 底下或第三个子目录里的用例**不属于任何 project、压根不会被跑，且套件照常全绿**。`test/unit/server/test-layout.test.ts` 钉着这条：它直接 import `vitest.config.ts` 把 include 编成正则（不抄目录白名单），所以加 project 不必同步任何清单。

## 包管理器（pnpm 11）

- **版本的唯一事实来源是 `package.json` 的 `packageManager` 字段**，不在别处重复写版本号。CI 用 `pnpm/action-setup` 且**不传 `version`**，让它读该字段；**不靠 `corepack enable`**——Corepack 已不再随 Node 25+ 发行版分发，而 CI 矩阵含 Node 26，靠它等于把工具链固定寄托在一个正在消失的东西上。
- **`pnpm-workspace.yaml` 是所有 pnpm 设置的唯一位置**，单包仓库同样需要这个文件。pnpm 11 起**不再读 `package.json` 的 `pnpm` 字段**，`.npmrc` **只保留 registry 与鉴权**。**写错位置不报错、无 deprecation 警告，只是设置静默不生效**，因此每一条约束的落地都必须连带确认它写在了正确的文件里。
- `pnpm-lock.yaml` 入库，所有非交互安装用 `pnpm install --frozen-lockfile`。
- **严格 node_modules 是资产不是障碍**：禁 `shamefullyHoist` / `nodeLinker: hoisted`。任何被 import 的包必须由我们自己声明——diff2html 的两个传递依赖（`diff`、`@profoundlogic/hogan`）由打包器经 diff2html 自身的依赖树解析，**我们的代码与配置不得直接引用它们**。
- **依赖的生命周期脚本默认不执行**：需要执行的包必须显式列进 **`allowBuilds`**（已知 `lefthook`——它靠安装后脚本把 git hooks 写进 `.git/hooks`，漏列不报错、安装照常成功，只是 hooks 静默没装、提交前检查全线失效）。判据是两条并列：**`pnpm ignored-builds` 报 `None`** + 钩子文件实际存在。**只看钩子文件会在 CI 上假红**（lefthook 的 postinstall 检测到 `CI` 就跳过 `lefthook install`），故 CI 的安装步骤必须设 `LEFTHOOK=1`。
- **`test/fixtures/` 的生成脚本与 `scripts/` 下的门禁脚本必须是零依赖纯 JS、可由 `node <路径>` 直接执行**，`package.json` 里的 `fixtures` / `bench:startup` / `size` / `check:css` / `check:global` / `check:inotify` 只是别名。理由与下方 matrix 档「完全不装依赖」同源：这些脚本要在没有 pnpm、没有 `node_modules` 的 matrix 机器上跑。

## 产物结构与 TypeScript 配置

```
bin/difftab.js      手写保守语法 JS。不参与 TS 编译、不作为打包入口。
                      只做 process.versions.node 检查 + 动态 import('../dist/server/main.js')
src/server/**.ts  →   tsdown → dist/server/main.js   单文件 ESM，不压缩不混淆
src/web/**.tsx    →   vite   → dist/web/{index.html, app.js, app.css}   固定文件名不加 hash
```

- `@types/node` 锁 `^22`——**不是** latest。用到 Node 24+ 才有的内置 API 时编译期即报错。
- 后端：`target` / `lib` 取 `ES2023`、`module: nodenext`；前端单独一份：`lib: ["ES2022","DOM"]`、`jsx: "react-jsx"`、`jsxImportSource: "preact"`。
- 两份均开 `verbatimModuleSyntax` + `erasableSyntaxOnly`（禁掉 enum 与参数属性，保持语法可擦除）。
- JSX 转换走 **Vite 的 Oxc 选项 + alias**，不引 `@preact/preset-vite`（它会拖入 `@babel/core`）。代价是失去 prefresh 的组件状态保留 HMR，整页刷新对本项目够用。

## Dev server 与安全校验的交互

Vite dev server 在 `localhost:5173`，后端在 `127.0.0.1:<随机端口>`，三道校验全部在 `vite.config.ts` 的 proxy `configure` 钩子里解决，**后端零 dev 分支**：

- `changeOrigin: true` → `Host` 头改写为后端的 `127.0.0.1:<port>`
- `configure` 中把 `Origin` 头重写为后端自身 origin
- `configure` 中从 `os.tmpdir()` 的单实例注册表读出 port 与 token，注入 `Cookie` 头

**因此后端重启后 dev server 也要跟着重启**——端口与 token 都变了。

## CI 分层

`tsdown` 要求 Node `^22.18 || >=24.11`、Vite 要求 `>=22.12`，均高于产品运行时下限 22.0.0，因此 CI 必须拆成两层。**矩阵作业测的是用户真正拿到的产物，而非 TS 源码。**

1. **build 作业**（Node 24）：`pnpm/action-setup` → `actions/setup-node`（`cache: 'pnpm'`）→ `pnpm install --frozen-lockfile` → `biome ci` → `tsc --noEmit` → `vitest run` → 构建 → 体积门禁 → 上传 `dist/` artifact。**`pnpm/action-setup` 必须排在 `actions/setup-node` 之前**，否则后者的 `cache: 'pnpm'` 找不到 pnpm 可执行文件。
2. **matrix 作业**（Node **22.0.x** / 24 / 26 × macOS / Windows / Linux）：下载 `dist/` artifact，**完全不执行安装、也不需要 pnpm**，用 `node --test` 直接打到纯 JS 冒烟套件文件（不经 `package.json` 的 script）。**不得改成「装一点点」**（如 `pnpm install --prod`）——那一装，测的就不再是用户拿到的那个东西。
   - `node --test` 在一个文件都没匹配上时是 **0 用例、exit 0**。因此本档必须断言 `readonly.test.js` / `readonly-git-dir.test.js` **确实进了这次调用的参数**——判据是这一步（本就 `shell: bash`）自己用 bash 展开 `test/smoke/*.test.js` 到一个数组、检查数组里有没有那两个文件名、再把数组原样传给 `node --test`，全程不经 node 解析 glob，因此与 node 版本、reporter 能力都无关。**试过按 junit reporter 的 testcase `file=` 属性点名**，但那个属性是 Node 后来才加的字段，**下限档 Node 22.0.0 的内建 junit reporter 不写它**，导致检查只在下限档必挂——这正是这份下限矩阵存在的意义：本地在更新的 Node 上验证过的东西，不代表在 22.0.0 上成立。**数磁盘上的文件顶不了这条**（只证明文件在，不证明真被传给了 node）；**只数用例总数也顶不了**（「跑了 N 个用例」被任何一个别的文件满足，而漏掉的偏偏可能是这两个）。磁盘那侧的存在性检查另有平台与 Node 无关的一份，归 build 跑一次。
   - **体积门禁不进本档**：matrix 下载的是同一份 `dist/`，字节完全相同，再跑 9 遍不增加覆盖，反而引入方差——gzip 输出长度取决于各 Node 大版本自带的 zlib，贴着预算的行会只在某一个 Node 上红。
3. **old-node-guard 作业**（Node 20，即**低于下限**；ubuntu + windows 两档）：不下载产物，直接 `node bin/difftab.js`，断言 exit 1 + 打印友好提示 + stderr 无 `SyntaxError` + stdout 为空。单列一档是因为 build 与 matrix 都跑在 ≥22 上，而守卫要防的是**解析期**失败——在 22+ 上文件早已解析成功，那条路径永远测不到。冒烟里那条「不含 `?.` / `??` / 顶层 await / 私有字段 / `||=`」的正则清单只是它的替身，替身按具体语法逐条列举，`catch {}`、对象展开、class 静态块等一律漏网。**取 stderr 必须经管道**——文件重定向在 Windows 上是同步写、恒绿。**不列 macOS**：那句提示丢不丢只在 Windows 上看得见（`process.stderr.write` + `process.exit` 写管道时才是异步的），macOS 与 ubuntu 在这条断言上是同一种 POSIX 行为。
4. **冒烟测试不得依赖 `node:test` 的顶层 `before()` / `after()`**：下限档 Node 22.0.0 的 runner **不等顶层异步 `before()` 完成就开跑该文件的用例**，`after()` 同样提早触发。准备工作要写成记忆化的 Promise、由各用例自己 `await`。这条只在下限档红，24 / 26 全绿——正是 matrix 要有一档真跑在下限上的理由。
