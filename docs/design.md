# difftab — 技术设计（§5）

> 本文承载需求文档的 §5，章节号沿用拆分前的编号，未重排。
> 索引见 [`docs/README.md`](README.md)。

## 5. 技术栈

**Node.js + TypeScript + Vite / Preact + diff2html**

**分工提醒**：5.0 给出模块划分与边界，是读其余小节的地图；5.1–5.10 描述的是**产品运行时**的约束（用户机器上实际执行的东西）；5.11 描述的是**开发期工具链**（只在本仓库和发布流水线里存在，不进用户安装的包）；5.12 是前后端之间的接口契约。运行时与工具链的边界必须清晰——运行时约束不因引入构建链路而放松。

### 5.0 架构总览：模块、目录与边界

数据流一句话：**CLI 定位仓库并拉起 HTTP server → 浏览器经 HTTP 拿只读数据、经 SSE 收变更通知 → server 把请求转给 git 封装层与文件监听层**。产品代码内不存在其他方向的调用。

**模块级目录结构**（只定“哪类东西放哪个模块”，不定文件切分）：

```
bin/difftab.js       版本守卫 + 动态 import(5.1),手写 JS,不参与构建
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
test/fixtures/         测试仓库生成脚本(两批,见 `roadmap.md` §7)
scripts/               bench:startup、size 门禁
```

源码目录到构建产物的映射见 5.11 的「产物结构」，此处不复述。

**依赖方向**（单向，可静态断言）：`bin → server/cli → server/http → {server/git, server/watch}`。`src/web` 除 `server/shared/` 外**不得 import `src/server` 下任何模块**；`server/git` 与 `server/watch` **不得反向 import `http` / `cli`**。

**边界不变式**——这四条不是风格偏好，每一条都是某道门禁能够成立的前提，违反后**不报错、只是让门禁静默失去覆盖**：

1. **`server/git` 是产品代码中唯一执行 git 子进程的位置**。5.10 主门禁“断言 git 子命令只出现在只读白名单”、以及 5.2 要求的 `-c core.quotePath=false` 统一注入，都依赖这个单点。其他模块即便只调只读命令也算违规——门禁的低成本可断言性正来自“只有一处”
2. **拉起浏览器是唯一的非 git 子进程调用**，位于 `server/cli`，即 5.1 与 5.10 已写明需要显式开口子的那一处。产品代码中出现第三处子进程调用，须先改本节
3. **`server/http` 不直接触碰 git 与文件监听**，只调用 `git` / `watch` 模块导出的函数。这保证 5.9 的三道校验位于唯一入口，不会被某条旁路绕开
4. **前端不内联任何 git 知识**（状态位含义、空树哈希、路径转义规则、重命名判定），一律由 `shared/` 的协议类型承载。否则 5.2 / 5.3 的约束会出现第二份实现，而第二份不受 5.10 门禁覆盖

**本节的修改边界**：只定模块归属与依赖方向，**不定文件切分**——文件级清单会随实施阶段推进立刻过期，而模块边界稳定且正是门禁所依赖的东西。新增或拆分文件不需要改 spec；**改变模块归属、依赖方向，或上述任一不变式，才须先改本节**。

### 5.1 运行时与后端

- **运行时**：Node.js，**最低支持 Node 22.0.0**。选型首要考量是生态成熟度与 Windows 上系统调用（`child_process` 执行 git、`fs.watch` 文件监听）的稳定性——本项目重度依赖这两块。下限取 22 而非更高的 24.14.0，是因为 **`fs.watch` 的 `ignore` 选项（Node 24.14.0 起可用）决定的是自动刷新的最优档位，不是能否运行的门槛**：低于该版本按 5.7 的三档策略降级，行为退化但功能完整。反过来把下限钉在 24.14.0 的代价是实打实的——24.14.0 比 Node 24 转入 LTS 晚了近四个月，锁版本管理器、既有 `node:24` 镜像、发行版快照上大量“自认在 Node 24 LTS”的用户会被 24.0–24.13 挡在门外（版本窗口日期见 `decisions.md` §10）。Node 22 为 Maintenance LTS、装机量大，值得覆盖；Node 20 已 EOL，不予支持。CI 矩阵覆盖 **22 / 24 / 26** 三个版本 × 三个平台
- **API 上限随下限收紧**：除 5.7 明确分档处理的 `fs.watch` `ignore` 外，不得使用 Node 22 上不存在或不稳定的 API——已知需避开 `fs.glob`（22.0 起为实验性）、不得依赖 `require(esm)`（22.12+ 才有）；`util.parseArgs`、`import.meta.dirname`、`node:test` 在 22 上均可用。下限一旦下调，“能跑通”就不再等于“在下限上能跑通”，需要有机制防止无意中把下限顶回去。**该机制由 TypeScript 配置直接承担**：`@types/node` 锁 `^22`（**不是** latest 的 26.x）+ `lib`/`target` 取 `ES2023`，用到 Node 24+ 才有的内置 API 或超出 ES2023 的语法时，`tsc --noEmit` 在编译期就直接报错，不必等 CI 的 Node 22 档跑到。CI 的 Node 22.0.x 档仍是最终底线，两者互补（详见 5.11）
- **版本守卫的位置**：CLI 入口须用**保守语法**先完成 `process.versions.node` 检查并友好报错，再动态 `import()` 主模块。若守卫与新语法同处一个模块，低于下限的用户拿到的是解析期 SyntaxError，守卫根本来不及执行（验收见 `acceptance.md` §6）。**落地要求**：`bin/difftab.js` 必须是手写的保守语法 JS，**不参与 TypeScript 编译、不作为打包入口**——一旦它进了构建管线，就可能被注入新语法或被合并进主模块，守卫在解析期即失效（见 `decisions.md` §10 禁止项）。**且必须以 `100755` 入库**：在本仓库目录里跑 `npx difftab` 会让 npm chmod 工作区里的这个文件，而丢掉可执行位的后果是下一次执行 `Permission denied`，**已有的门禁一条都看不见**。由 `check:bin` 断言仓库自己记的 mode，**HEAD 与 index 两侧都查**（机制、实测与“为什么只查 index 不够”见 `decisions.md` §10）
- **后端实现**：**运行时**仅使用 Node 标准库（`node:http`、`node:child_process`、`node:fs`），不引入 HTTP 框架——路由需求仅几个只读接口，标准库足够。TypeScript 与打包器都是开发期依赖，不进 `dependencies`，也不改变这条约束
- **拉起浏览器**：零运行时依赖的前提下没有现成库可用，只能 `child_process` 按平台调系统命令——macOS `open`、Windows `cmd /c start ""`（空串是必需的窗口标题占位，否则带引号的 URL 会被当作标题吞掉）、Linux `xdg-open`。这是产品代码中**唯一一处非 git 的子进程调用**，5.10 的只读性主门禁需为它显式开一个口子（见 5.10）。调用失败（无 `xdg-open`、headless 环境）只打印 URL 让用户自行访问，不作为启动失败
- **后端产物形态**：`src/server/**.ts` 打包为**单文件 ESM** `dist/server/main.js`，**不压缩、不混淆**。压缩对本地 CLI 场景零收益，而保持可读能让用户自行核查“这工具到底跑了哪些 git 命令”，与 4.1 只读承诺的可审计性一致；单文件则减少模块解析次数，对 `acceptance.md` §6 的冷启动门禁只有正向作用

### 5.2 git 交互

- shell out 到系统 `git` 命令读取只读信息，全程无写命令。diff 基准取 `git diff HEAD`——agent 执行过程中可能自行 `git add`，`git diff` 会漏掉已暂存的改动，而“相对上次提交改了什么”才是本工具要回答的问题
- **文件列表**：以 `git status --porcelain=v2 --branch -uall -z` 为唯一数据源，一次调用即可同时拿到文件状态、暂存/未暂存双状态位、重命名信息与分支/ahead-behind。两个参数都不能省：
  - `-uall`：否则 git 会把未跟踪目录折叠成一行 `dir/`
  - **`-z`**：否则 git 会对含非 ASCII 字符、空格、引号的路径做 C 风格转义并加引号（已实测，见 `decisions.md` §10）。加 `-z` 后改为 NUL 分隔、路径原样输出，无需自己反转义。同理，所有取路径的**列表类** git 调用（`ls-files`、`diff --numstat` 等）一律加 `-z`，解析时按 NUL 切分而非换行

- **`-z` 解析的两个陷阱**（不写清楚实现时必然踩中）：
  - **重命名记录里 NUL 既是记录分隔符、又是字段分隔符**。`porcelain=v2` 的 `2 ` 记录格式是 `2 <XY> ... R<score> <新路径>\0<旧路径>`，即一条重命名记录会占用**两个** NUL 段。解析器不能无状态地按 NUL 平铺切分，必须在遇到 `2 ` 开头的记录后额外吞掉下一段作为旧路径（已实测确认该格式）
  - **无上游分支时不输出 `# branch.ab` 行**。新建的本地分支尚未设置 upstream 时，`--branch` 只给 `# branch.oid` / `# branch.head`，没有 ahead/behind 行（已实测）。此时分支状态展示为“无上游”，不能默认成 0/0，更不能因取不到字段而崩溃

- **所有 `git diff` 调用必须加 `-c core.quotePath=false`**。`-z` 只作用于 `status` / `numstat` 这类机器可读的**列表输出**，**管不到 `git diff` 的补丁正文**——正文里的 `diff --git` / `--- ` / `+++ ` / `rename from|to` 头部行仍会按 C 风格转义（已实测，见 `decisions.md` §10）。而 diff2html 恰恰是从这些头部行解析文件名的，不处理就会在界面上直接显示 `\351\234\200` 转义串，违反 `acceptance.md` §6 验收标准。**两者互补，不可相互替代**：`-z` 解决列表解析的分隔歧义，`core.quotePath=false` 解决补丁正文的展示。实现上直接在 git 封装层对所有调用统一注入该参数，避免遗漏

- **`--` 后面的路径必须按字面量而不是通配模式解释**，封装层统一设 `GIT_LITERAL_PATHSPECS=1`（2026-08-13 于 S4a 补，起因见 `decisions.md` §10）。路径来自 URL query，是外部输入，而 git 的 pathspec 默认是 wildmatch：`path=*` 会让 `git diff HEAD -- '*'` 回一份**整仓 diff**——正是本节明令禁止的那件事；一个真实存在、名字里带 `*` 的文件同样会匹配到别人身上，页面在 A 的标题下多出 B 的补丁。本项目的路径无一例外来自 git 自己的输出，不需要任何通配语义。**这与「按路径挑 numstat 记录」是两道独立的防线，各自都有只有它才拦得住的形态**，不可相互替代
- **一次 `--numstat` 查询可以回不止一条记录，必须按路径挑、按合计算，不能取第一条**。传了两个路径而 git 配不上对时（`git mv` 后重写内容却不 `git add`——status 照报 `R100`，故条目带 `oldPath`），它会拆成「删旧」+「增新」两条按路径排序的记录，取 `[0]` 等于掷硬币：实测拿到的是旧文件那条几十行的删除，于是行数闸放行、一份 6 万行的补丁照旧发给浏览器。二进制同理，挑错记录会让文本文件被报成 `binary`
- **重命名文件的 diff 必须同时传新旧两个路径**。懒加载若按常规只传新路径（`git diff HEAD -- <新路径>`），git 因为只看到一侧、无法配对，会把重命名**退化成一个全新增文件**（已实测，见 `decisions.md` §10），导致“重命名识别并标注”的需求落空。正确做法是对重命名条目调用 `git diff HEAD -M -- <新路径> <旧路径>`，两个路径都来自上面 `2 ` 记录已经给出的信息，无需额外查询
- **diff 按文件懒加载**：列表只做上述一次 status 调用，diff 在用户点击某个文件时才用 `git diff HEAD -- <path>` 单独取（重命名条目按上一条传两个路径）。**禁止一次性获取或渲染全仓 diff**——agent 单次改 300+ 文件是常态，整仓 diff 会冻结浏览器主线程数秒到数十秒，同时拖垮冷启动指标
- **未跟踪文件**不在任何 `git diff` 输出内，需从 `git status` 取列表后单独构造 diff。**明确采用「直接读取文件内容手工构造 unified diff」方案**（输出 `--- /dev/null` / `+++ b/<path>`，全部行标记为新增），**不使用 `git diff --no-index`**——后者依赖 `/dev/null` 作为对比端，在 Windows 上不可移植。手工构造路径需自行做 NUL 字节探测（判定二进制）+ 5MB 体积阈值 + **行数上限 50,000 行**（超出按 `too-large` 处理；体积阈值挡不住“几十 MB 单行”以外的另一头——超长行数的窄文件体积不大，但逐行构造 diff 与前端渲染同样会卡）
- **二进制与大文件的判定来源**：已跟踪文件一律以 `git diff HEAD --numstat` 的输出为准（二进制文件输出 `-\t-\t<path>`），这是 git 自身含 `.gitattributes` 配置的判定结果，比启发式探测准确；只有未跟踪文件才走 NUL 字节探测
  - **`--numstat` 那次调用同时兼任「已跟踪」判据**（2026-08-13 于 S4a 落地），取代了原先那次 `diff --name-only`：两者回答的是同一个问题（这条路径在不在「基准 → 工作区」的差异里），而 numstat 顺带把二进制与行数一并给了。判据仍是 **HEAD ∪ index**——`ls-files` 那一半照旧
  - **行数上限对已跟踪文件同样成立**，数的是 numstat 的**加 + 减**（未跟踪那一侧数的是文件行数，因为整份都是新增行）。原文只写了未跟踪那一侧，而「前端要渲染多少行」两条路是同一件事——一个改了 6 万行的已跟踪文件同样会卡住主线程。它排在取补丁**之前**：不用付出取补丁的代价就能拦下
  - **5MB 那道闸，已跟踪那一侧卡的是「补丁多大」而不是「文件多大」**（2026-08-13 于 S4a 的代码评审后改定，原方案是 `fs.stat` 文件体积）。两者不是同一件事：已跟踪文件的补丁只含改动与上下文，按文件体积拒绝会让**一个 6MB 的数据文件改一行就再也看不了**，而那正是 agent 最常见的输出之一；反过来，行数也替代不了它——「一行 6MB」的文件 numstat 只报 1 行。两者都量不到的东西正是字节，所以这一闸只能由**取补丁那次调用自己带着 `maxStdoutBytes` 去撞**：超限即就地掐断 git，补丁一个字节都不会发给前端。未跟踪那一侧仍按文件体积判——那里整份文件就是补丁，而且省得把它读进来
  - 顺带闭掉一个缺口：已被删除的文件取不到工作区体积，按文件体积判时它只剩行数那道闸；改判补丁字节后不再有例外。`fs.stat`（实现取 `lstat`，`stat` 会跟随符号链接）从判据降为**只用于展示**——`DiffPayload.size` 告诉用户这文件多大，取不到就给 0（见 5.12）
- **仓库定位**：统一用 `git rev-parse --show-toplevel` 定位工作区、`git rev-parse --git-dir` 定位 git 目录。**不得假设 `.git` 是目录**——linked worktree 下 `.git` 是一个文件，submodule 同理；bare 仓库（无工作区）给出明确的拒绝提示而非崩溃
- **启动前置检查**：`git` 不在 PATH、当前目录不是 git 仓库、git 版本低于 2.11（`--porcelain=v2` 的最低要求），三种情况均给出一句话友好报错，而不是抛 Node 异常栈

### 5.3 git 异常状态

- **空仓库**（尚无任何提交）下 HEAD 不存在，`git diff HEAD` 会直接 fatal（已实测确认）。降级方式：改用**空树对象哈希**作为 diff 基准，`git diff <empty-tree>` 在空仓库下正常返回，无需为此写特殊分支逻辑。空树哈希按 `git rev-parse --show-object-format` 区分 SHA-1 / SHA-256 两个常量硬编码；**不要**用 `git hash-object -t tree /dev/null`（`/dev/null` 在 Windows 不可移植），也**不要**用 `git mktree`（会写对象库，违反只读承诺）
  - **`--show-object-format` 本身高于 5.2 的 git 下限**：该选项随 SHA-256 支持一同引入（git 2.29 前后），而启动前置检查只要求 ≥ 2.11，中间区间会直接报错。因此**非零退出即按 SHA-1 处理**——那个区间的 git 根本造不出 SHA-256 仓库，降级无歧义，不得让它成为空仓库路径上的崩溃点
  - 常量取值：SHA-1 为 `4b825dc642cb6eb9a060e54bf8d69288fbee4904`、SHA-256 为 `6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321`（**两者均已实测**，后者 2026-08-14 于 S4b 在 `git init --object-format=sha256` 的测试仓库上取值并验过它当 diff 基准确实出补丁，见 `decisions.md` §10）。凭记忆写死的后果是空仓库下 diff 基准无效，且症状与“空仓库不支持”难以区分
- **detached HEAD**：`# branch.head` 的值是字面量 `(detached)`（已实测），解析器据此给出 `detached: true`。**前端不得把这个字面量当分支名画出去**——那是 git 的内部表述，不是分支
- **进行中的多步操作（rebase / merge / cherry-pick / revert / am / bisect）在 `--porcelain=v2` 的任何一行里都没有**，唯一判据是 git 目录下的状态文件（git 自身的 `wt-status.c` 也正是这么判的），这也是 `BranchState.operation` 的唯一来源。**用 `fs` 读、不新起 git**：多一次子进程既落在每次 `/api/state` 上，又要往 5.10 的只读白名单里添条目，而读文件存在性一个字节都不写
  - 判据与优先级（**按序取第一个命中**）：`rebase-merge/` 或 `rebase-apply/rebasing` → `rebase`；`rebase-apply/` 而无 `rebasing` → `am`（`git am` 与 rebase 共用这个目录，合并成一个标注等于对用户说假话）；`MERGE_HEAD` → `merge`；`CHERRY_PICK_HEAD` → `cherry-pick`；`REVERT_HEAD` → `revert`；`BISECT_LOG` → `bisect`
  - **顺序不是随手排的**：rebase 冲突停下时 git 目录里同时躺着 `rebase-merge/` 与 `MERGE_MSG` / `AUTO_MERGE`（已实测），而用户处在的是 rebase 不是 merge；先判 rebase 才不会把它标错
  - **路径基准是 `rev-parse --git-dir` 的返回值，不是 `<root>/.git`**——linked worktree 与 submodule 下这些文件躺在各自的 git 目录里（`…/.git/worktrees/<名>` 与 `…/.git/modules/<路径>`，均已实测），按 `<root>/.git` 拼的写法在那两种仓库里**永远读不到**、于是永远标不出操作，而它不报错
- **合并冲突自成一组**：porcelain 的 `u` 记录里 XY 两位可以是 `UU` / `AA` / `DD` / `AU` / `UD` 等组合，按 5.12 那两个谓词的字面判据（`!== '.'`）读会让同一个文件同时落进“已暂存”与“未暂存”两组，而两组都不是它的真实处境。**判据是“这条记录来自 `u` 段”，不是状态位**——`DD` 两位都不是 `U`，靠状态位认会漏掉一半形态。编码为 `FileEntry.conflicted`（5.12）
  - 冲突文件**自身的 diff 照常走 `git diff HEAD`**，不需要任何特殊分支：实测补丁正文就是带 `<<<<<<<` / `=======` / `>>>>>>>` 标记的工作区内容，而那正是用户此刻要看的东西
- **bare 仓库**：`rev-parse --show-toplevel` 直接以 128 退出（已实测），5.2 的前置检查据此给一句话拒绝而不是崩溃。linked worktree 与 submodule 则照常启动——它们都有工作区，唯一的特殊之处是上面那条 git 目录不在 `<root>/.git`

### 5.4 前端

**TypeScript + Preact + @preact/signals，经 Vite 构建为静态产物**，由 5.1 的 Node 服务直接托管。

**曾考虑“纯 HTML + 原生 JS + CSS，不引入前端框架与构建链路”**，理由是“状态复杂度低，省去构建步骤能进一步减小体积、加快启动”。这条论据的三个支点均不成立，记录于此避免被重新提出：

- **“加快启动”不成立**：构建只发生在发布期，用户拿到的是构建产物。 `acceptance.md` §6 的冷启动门禁（CLI 侧 ≤300ms / 浏览器侧首屏 ≤1s）与是否存在构建链路无关
- **“减小体积”是反的**：无构建链路时只能用 diff2html 的预构建 bundle，其 slim 包 302 KB 里含大量用不到的 hljs 语言定义；有 tree-shaking 后可按需 import 并显式控制语言子集，产物更小（见 5.5）
- **“状态复杂度低”低估了一处**：5.7 的 SSE 刷新要求在**不丢失当前选中文件与滚动位置**的前提下更新列表。agent 跑动期间刷新频繁、单次变更 300+ 文件是常态（见 `acceptance.md` §6），整树 `innerHTML` 重建会闪烁并跳滚动，不重建则要手写一份按 path 的 keyed reconcile。这正是框架存在的理由，自己实现等于维护一份更易出错的等价物

选型取 **Preact + signals** 而非 React / Svelte：

- Preact 运行时约 4 KB gzip，量级与本工具“最轻”的定位相称；React 19 的 ~42 KB gzip 对一个只读三区块界面是明显溢价
- 保留 TSX 心智模型，与 5.11 的 Biome 原生支持 `.tsx` 对齐；Svelte 的 `.svelte` 模板/样式 Biome 不支持，需额外挂一套 Prettier 工具链

**TypeScript 的收益不限于前端**：5.2 的 `porcelain=v2 -z` 有状态重命名解析、5.7 的三档监听策略、SSE 消息协议，都是类型能在编译期挡住真实 bug 的地方；`@types/node@^22` 同时承担了 5.1 的 API 上限守卫职责。

**界面文案一律英文，`<html lang>` 为 `en`**（2026-08-19 于 S6 定，此前是中文）。判据是**产品表面与文档分属两个读者**：`docs/` 与本文件写给维护者，中文；而分发形态是 npm 全局包（§2），CLI 的 `--help`、退出提示、版本守卫的报错从 5.1 起就是英文，界面是同一个表面上唯一说中文的部分——它不是“还没翻”，是**当中一处不一致**。中文读者由 `README.zh-CN.md` 承接。首版不做语言切换，理由见 `spec.md` §4.2。

- 术语跟 git 自己的用词走（`Staged` / `Unstaged` / `Untracked` / `Conflicted` / `Detached HEAD` / `Rebasing`），不自造同义词——用户是拿它对照 `git status` 看的
- **变更列表一行的构成是「状态位 → 文件名 → 目录」**（2026-08-22 改，此前是「状态位 → 完整路径」）。目录跟在文件名之后、小一号、次要色、**不带尾部斜杠**——它是独立的一段而不是与文件名连读的路径前缀。判据是**侧栏宽度固定 320px（5.4 的外壳）而 `truncate` 从右边裁**：路径在前时先被裁掉的恰恰是文件名，而文件名才是用来认出这一行的东西。故空间不足时**先牺牲目录、保住文件名**，只有文件名自己都放不下才轮到它截断（排法参照 VS Code 的 Source Control 面板）
  - **两段必须同住一个 `truncate` span**（名在前、目录作为它的行内子元素）。拆成两个平级 flex 子项**两件事一起坏、且都不报错**：(a) `overflow:hidden` 让每段各自成为 scroll container，基线改按**边框盒**合成而不再露出文字基线，`items-baseline` 于是把两段按底边对齐，字号不同时看着就是没对齐；(b) 谁先被裁只能靠 flex-basis 去调，而给目录 `flex-1` 会把它后面那段重命名标注推到侧栏最右、与它注解的文件名断开。同住一个 span 时两件都不必处理：两段共用一个行盒（基线是真的），而省略号在右端**天然**先吃掉排在后面的目录。（`min-w-0` 不在此列——截断盒无论一个还是两个都得给，它不是拆开的代价。）**2026-08-22 在真实页面上量过**：文件名文本盒 top/bottom 为 169/189，目录段为 171/188——上下各内缩、而非底边对齐，即基线对齐成立
  - **这条规则钉的是树的形状，不是版式，所以它有断言而不是只有散文**：`change-list.test.tsx` 的「同住一个 truncate span」一条查目录段所在的截断盒是否同时装着文件名，拆成兄弟即红（已弄红验过）。happy-dom 判不了的只剩「谁先被裁」那半条，归 `acceptance.md` §6 的人工那档
  - 目录被裁是设计中的常态，故**整行挂 `title={file.path}`** 补一份完整路径；不挂在目录那个 span 上——它被裁到零宽时就没得可悬停了
  - **不做文件类型图标**（VS Code 那一列 JS / TS / `{}`）：要么引一套 SVG 资源去顶 5.5 的产物体积门禁，要么自己维护一张扩展名→颜色表，而换来的只是观感。状态位仍留在**行首**——那一列定宽对齐，扫一眼比右侧对齐快，冲突行的 XY 两位也照旧印在那里
- **改文案要同步改 `test/unit/web/` 里的可见文本断言**，那几条压的正是用户看到的字。这一条**会报错**，不进红线
- **判据是「`dist/web/` 三个产物里的 CJK 字符数为 0」**（冒烟，已弄红验过），不是逐个文件翻源码：漏网的最可能形态是**不长在 JSX 上的那几条**（`state/store.ts` 的错误文案就是这么漏的一次），而按文件翻依赖“想不想得起来”。前端产物里本来就不该有中文——注释在构建期已去掉，diff2html / hljs 也不带
- **后端产物用不了这个判据**：`dist/server/main.js` 按 5.1 不压缩不混淆，中文注释原样留着正是为了可审计。那一侧的用户可见文案是 `sendError` 与各 `*Error` 的字面量，归 `test/unit/server/`

### 5.5 Diff 渲染与体积

[diff2html](https://github.com/rtfpessoa/diff2html) 直接解析 `git diff` 的 unified diff 文本渲染为带高亮的 HTML，配合 [highlight.js](https://highlightjs.org/) 做语法高亮。直接复用 git 原始 diff 算法，不需要额外维护对比逻辑。

**明确采用「按需 import + 显式注册 hljs 语言子集」，不使用任何 diff2html 预构建 UI bundle**（`diff2html-ui.min.js` / `-slim` / `-base` 三个都不用）。所有资源随包本地分发，**不走 CDN**——工具必须离线可用。

- `import { html } from 'diff2html'`——只引入 unified diff parser 与 renderer，其余部分由 tree-shaking 移除
- **`html()` 不做语法高亮**（已实测，见 `decisions.md` §10）。高亮位于 `Diff2HtmlUI.highlightCode()`，它依赖 `highlight.js-helpers` 的 `closeTags` / `nodeStream` / `mergeStreams` / `getLanguage`——先把整个文件的代码合起来交给 hljs，再按 diff 的行边界切回、补齐跨行未闭合的标签。**被排除的是三个预构建 UI bundle，不是 UI 层的源码**：允许深导入 ESM 源码模块 `diff2html/lib-esm/ui/js/diff2html-ui-base.js`，它参与 tree-shaking、hljs 实例由我们注入，深导入合法（模块体积与依据见 `decisions.md` §10）。自行重写这段切分逻辑不在本项目要解决的问题之列
  - `draw()` 内部是 `innerHTML` 赋值 + 命令式绑定事件，**必须放在 Preact 的 ref/effect 之后**，不与 vdom 争夺同一棵子树（与 5.4 的 keyed reconcile 不冲突：列表由 Preact 管，单文件 diff 容器由 `Diff2HtmlUI` 管）
  - 用不到的开关一律关掉：`synchronisedScroll` / `fileListToggle` / `fileContentToggle` / `stickyFileHeaders` 全部 `false`，只留 `highlight: true`
  - **`colorScheme` 传 `'light'`，不传 `'auto'`**——深浅切换由 5.6 覆写的 `--d2h-*` 承担，不走 diff2html 自带那套 class 门控的 `--d2h-dark-*`。传 `'auto'` 不报错，只是深色下我们的 VS Code 取值一条都不生效（机制与实测见 5.6 与 `decisions.md` §10）
  - **`outputFormat` 按 diff 面板宽度自动切**：面板宽度 < 1024px 给 `line-by-line`，否则 `side-by-side`。**1024 是算出来的，与 Tailwind 的 `lg` 数值相同纯属巧合**（那是视口断点，这里是面板宽度）：diff2html 的表是 13px Menlo，并排每侧留 `9em` 行号槽、逐行留 `8em`（实测见 `decisions.md` §10），于是面板 1024 时并排每侧只剩约 395px（约 50 个等宽字符）而逐行有 920px（约 118 个），50 列正是多数源码行开始要横向滚的地方。以下几条都属「违反后不报错」：
    - **判据是 diff 面板自身的宽度，不是视口宽度**。5.4 的外壳里侧栏固定 `w-80`（320px）且 `shrink-0`，面板宽度恒等于「视口 − 320」；按视口判等于把这个常数在两处各写一遍，而侧栏宽度将来一改，阈值就静默错位到别的地方去了
    - **量的是 border box**，不是 content box——观察与读值两处都显式写死：`observe(el, { box: 'border-box' })` + `entry.borderBoxSize[0].inlineSize`。面板自己是 `overflow-auto` 的滚动容器：换格式会改变内容高度 → 竖直滚动条出现/消失 → content box 宽度抖十几个像素，阈值附近于是在两种格式之间来回重画。**滚动条是从 content box 里扣的**（它占掉 padding box 内的空间，border box 照样把它圈在里面），border box 宽度因此不随它进出而变，天然稳定。**观察 box 也必须是 border box，不能只在读值那侧挑**：默认的 content-box 观察会在滚动条进出时（竖直改宽、水平改高）各推一次回调，靠下游去重虽然挡得住，挡的却是已经产生的噪声。测量点只有一处——`App.tsx` 只管「量哪个元素、什么时候开始和停」，**量法与阈值同住 `state/layout.ts` 的 `observeDiffPanel()`**：阈值的正确性全靠「送进来的是 border box」，而这件事没有任何门禁强制得了（happy-dom 没有布局引擎），拆到两个文件里就等于让其中一半失去说明。格式本身是个 `computed`，格式本身是个 `computed`，靠 signals 的 `Object.is` 去重——拖窗口每像素写一次宽度，只有**真跨过阈值**那一次会通知下游。**去重封的是「每像素一次」而不是「每次跨越一次」**：贴着阈值来回蹭，每跨一次仍是一次完整的 `draw()`。不为此加迟滞或 debounce 是有意的——同一次 `draw()` 的代价 SSE 刷新每个事件都要付一遍，而贴着边界反复拖是转瞬即逝的动作，换来的却是一份「上一次是哪种版式」的反馈状态，把纯派生量变成第二份状态
    - **格式必须进 `DiffView` 那个 effect 的依赖数组**。`draw()` 是命令式的，格式变了不重跑就永远停在旧格式上——**不报错，只是拖窗口没反应**（由 `test/unit/web/diff-view.test.tsx` 直接写 signal 钉住；`ResizeObserver` → signal 那一段 happy-dom 盖不到，它的 `ResizeObserver` 是个 `observe()` 什么都不做的空壳，归 6 的肉眼项）
    - **两种格式共用同一套 `--d2h-*` 覆写**，5.6 无需分叉：那对 `--d2h-change-*` 与 `--d2h-empty-placeholder-*` 只被并排视图的选择器读到，逐行视图下是失效而不是漏映射；反过来 5.6 那条「行号列要有 positioned 祖先」两种格式都成立（`.d2h-code-linenumber` 与 `.d2h-code-side-linenumber` 都是 `position:absolute`，见 `decisions.md` §10）
    - 首版**不做手动切换开关**，与 5.6 不做页面内明暗开关同一取向；被排除的几种做法见 `decisions.md` §10
  - **`highlight: true` 时 `draw()` 内部已经调过 `highlightCode()`，不要在 `draw()` 后再手工调一次**。第二次调用读到的 `textContent` 仍是纯文本，但 `nodeStream(line)` 拿到的已是第一遍插入的 `hljs-*` span，`mergeStreams` 会把两份流交织进同一行——结果是嵌套重复的 span，且高亮开销白付一倍。二选一：要么只 `draw()`，要么 `highlight: false` + 手工调
- `import hljs from 'highlight.js/lib/core'`，再**逐个显式注册**语言。清单为 **22 个真实语言模块**：`javascript` / `typescript` / `json` / `css` / `scss` / `xml` / `markdown` / `python` / `go` / `rust` / `java` / `kotlin` / `swift` / `c` / `cpp` / `csharp` / `bash` / `yaml` / `ini` / `sql` / `php` / `ruby`。**别名不是模块，不得单独 import**——`jsx` / `mjs` / `cjs` 属 `javascript`，`tsx` / `ts` 属 `typescript`，`toml` 属 **`ini`**，`html` 属 `xml`；`registerLanguage` 注册主模块时别名一并生效（`highlight.js/lib/languages/{jsx,tsx,toml}` 三个路径实际不存在，写了会在构建期 resolve 失败，已实测）。注册清单是白名单，增删语言即增删体积，这正是放弃预构建包换来的可控性
  - **`plaintext` 必须与这 22 个一起注册**，它是兜底而非语言。「未命中的语言退化为 plaintext」不是自动发生的：`highlightCode()` 里 `hljs.getLanguage(x) === undefined` 时把语言改写为字面量 `'plaintext'`，`getLanguage()` 对无扩展名/未知扩展名也直接返回 `'plaintext'`，随后无条件调用 `hljs.highlight(text, { language: 'plaintext' })`。而 `lib/core` **不自带** plaintext，漏注册时这一步抛 `Unknown language: "plaintext"`，异常从 `highlightCode()` 冒到调用方，**整个 diff 视图渲染失败**——不是那一个文件退化。触发条件极普通：diff 里出现 `LICENSE` / `Dockerfile` / `notes.txt` / `.lua` 即可（已实测）。模块本身 318 B，对体积无影响
- diff2html 的两个传递依赖（`diff`、`@profoundlogic/hogan`）由打包器一并处理。注意 `@profoundlogic/hogan` 只有 CJS 入口（无 `module` / `exports` 字段），需打包器的 CJS 互操作，不影响可行性但也不要指望它被 tree-shake

**产物体积门禁**（门禁值为预算而非承诺。S0 的 spike 先给出预估以决定是否需要当场砍语言清单，S2c 收口时填入最终实测，见 `roadmap.md` §7）：

| 产物 | 门禁 | S0 spike 预估 | S2c 收口实测 |
|---|---|---|---|
| 前端 JS（明文） | ≤ 350 KB | **196.0 KB** | **199.5 KB**（余 43%） |
| 前端 JS（gzip） | ≤ 120 KB | **65.6 KB** | **66.7 KB**（余 44%） |
| 前端 CSS（明文，含 `diff2html.min.css` 17 KB + hljs 双主题 2.6 KB + Tailwind 产物） | ≤ 40 KB | **22.3 KB** | **28.3 KB**（余 29%） |

S0 spike 的口径：22 个语言模块 + `plaintext` 全部注册 + 深导入 `diff2html-ui-base` + `@preact/signals` + Preact，经 Vite 8（Rolldown）构建、压缩后的 `dist/web/app.js` / `app.css`。三行均在预算内，**语言清单不需要在 S0 砍**。余量最紧的是 CSS（22.3 / 40 KB），而它的增量来自 Tailwind 工具类，与语言清单无关；JS 两行各剩四成以上，S2b 接入真实组件后仍有空间。

**S2c 收口实测的口径与结论**（2026-08-09，`node scripts/size.mjs --json` 对 `pnpm build` 的产物）：JS 两行比 S0 spike 各高约 1 KB——那是真实组件、store 与 signals 的全部增量，**spike 的预估基本就是终值**，因为主导项（语言清单）没变。CSS 从 22.3 涨到 28.3 KB，6 KB 全部来自本阶段：VS Code token 的两套取值 + 组件实际用到的那些工具类。**三行余量都在 29% 以上，首版无需砍语言清单**；后续若要加语言，先回来看这张表。注意 CSS 仍是余量最紧的一行，而它对“多写几个工具类”最敏感——加 token 时留意这条。

对照基线：diff2html slim 预构建包单文件即 302 KB（min）。门禁纳入 CI（见 `acceptance.md` §6）。

**JS 门禁的主导项是语言清单**：上述 22 个语言模块的 ESM 明文合计 225.6 KB（实测，见 `decisions.md` §10），压缩后约 130 KB / gzip 约 40 KB，占了预算的大头；diff2html + hogan + jsdiff + preact 合计仍留有余量。因此后续若要压体积，第一刀砍语言清单而不是别处；若要加语言，先看这张表还剩多少。

**注意 hljs 的配色主题需要单独引入**：`diff2html.min.css` 里**没有任何 hljs 配色规则**（已实测，见 `decisions.md` §10），只引 hljs 运行时与语言定义不会出颜色，必须另行本地分发 highlight.js 的主题 CSS（`github.css` / `github-dark.css`）。按 diff2html 官方 README 的要求，**hljs 主题 CSS 必须排在 `diff2html.min.css` 之前引入**，否则会被覆盖——这条在 5.6 的层叠方案里同样成立。

### 5.6 UI 样式

**Tailwind v4（CSS-first，`@tailwindcss/vite`）**。设计 token 写进 `@theme` 块，命名与数值参照 VS Code 颜色 token（如 `editor.background`），复刻 Dark+/Light+ 主题观感，轻量优先于视觉还原度。Tailwind v4 的 `@theme` 同时产出 CSS 变量与工具类，VS Code token 可直接由 CSS 变量承载。

**Tailwind preflight 与 diff2html 的共存方案**（已实测，依据见 `decisions.md` §10）：

引入完整 preflight——它就是跨浏览器归一化那一层，不引则要自己手写一份等价物。与 diff2html 的冲突面实测下来几乎为零：表格合并、行号列盒模型、边框等关键声明 diff2html 均自带，且类选择器特异性稳压 preflight 的通配重置（逐条比对见 `decisions.md` §10）。

在此之上再用**层叠层（cascade layer）**做结构性隔离——**无层（unlayered）样式在层叠中永远胜过有层样式，与特异性无关**，而 Tailwind v4 把 preflight 放在 `@layer base`：

```css
/* src/web/app.css */
@import "tailwindcss";                              /* preflight → @layer base;utilities → @layer utilities */
@import "highlight.js/styles/github.css";           /* unlayered,且必须排在 d2h 之前(见 5.5) */
@import "highlight.js/styles/github-dark.css" (prefers-color-scheme: dark);
@import "diff2html/bundles/css/diff2html.min.css";  /* unlayered → 结构上不可能被 preflight 压过 */
@import "./vscode-theme.css";                       /* unlayered,覆写 --d2h-* 与 VS Code token */
```

**深色主题的 `@import` 必须带媒体条件**：两份 hljs 主题都是无条件的 `.hljs { … }` 规则、自身不含任何 `@media`（已实测，见 `decisions.md` §10），平铺引入的结果是 `github-dark` 无条件覆盖 `github`、浅色主题直接失效（`acceptance.md` §6 有“深浅两套主题下均验证”的验收项）。媒体条件不引入层叠层，上面的 unlayered 保障不受影响。

同理，`--d2h-*` 与 VS Code token 的深浅两套取值也统一由 `prefers-color-scheme` 切换，**首版不做页面内的明暗手动开关**——那需要为 hljs 主题 CSS 在构建期加作用域前缀，与“轻量优先”的取向不符。

**diff2html 自带的深色方案不用**（2026-08-09 就 3.4.56 实测，依据见 `decisions.md` §10）。它的深色配色由渲染时挂在容器上的 class 门控：`colorScheme: 'auto'` 输出 `.d2h-auto-color-scheme`，对应规则整块包在 diff2html 自带的那唯一一个 `@media (prefers-color-scheme: dark)` 里，读的是**另一套** `--d2h-dark-*` 变量。

- **`Diff2HtmlUI` 的 `colorScheme` 固定传 `'light'`**：它输出 `.d2h-light-color-scheme`，而这个 class 在 diff2html 的 CSS 里**一条规则都没有**（实测），于是全部配色都落在无前缀的基础规则上，深浅切换完全由我们覆写的同一套 `--d2h-*` 承担。**这不是“只支持浅色”**，恰恰相反——它是深色能按 VS Code 取值出来的前提
- 传 `'auto'` 的后果是静默的：`.d2h-auto-color-scheme .d2h-xxx` 特异性 (0,2,0) 稳压基础规则 (0,1,0)，深色下读回 `--d2h-dark-*` 里 GitHub 的取值，我们的 VS Code 深色一条都不生效，而页面看上去只是“深色不太像 VS Code”，不像出错
- 且 3.4.56 的 auto 块里有一处真实缺口：`.d2h-deleted` 被写成 `.d2h-dark-color-scheme .d2h-deleted` 而非 `.d2h-auto-color-scheme .d2h-deleted`（实测），auto 模式下深色盖不到它。即走它的方案仍要自己补规则，收益为负
- 换来的好处是**深浅只声明一次**：23 个无前缀 `--d2h-*` 一律写成 `var(--color-…)` 指向 VS Code token，token 自己在 `prefers-color-scheme` 里翻。CSS 变量在**使用时**解析，间接引用拿到的是当时生效的取值，因此不存在“加了浅色忘了深色”这一半
- 但**并排视图那对“改动行”不跟着无脑映射**：diff2html 为 `.d2h-file-diff .d2h-del.d2h-change` / `.d2h-ins.d2h-change` 另留了 `--d2h-change-del-color` / `--d2h-change-ins-color`（默认是琥珀 `#fdf2d0` 与浅绿 `#ded`，与纯增删的 `#fee8e9` / `#dfd` 不同色系），而 **VS Code 的 diff 编辑器没有这一档区分**——成对修改的两侧用的就是 `diffEditor.insertedTextBackground` / `removedTextBackground`。故这两个变量**刻意指向与纯增删相同的 token**，主动放弃上游那档琥珀。这是取舍不是遗漏，注释里必须这么写：写成“比纯增删淡一档”会让下一个人以为区分还在

**这套覆写的生效条件是“unlayered **且** 排在 diff2html 之后”两条，不是一条**：我们的 `:root` 与 diff2html 自己的 `:host,:root` 特异性同为 (0,1,0)，胜出**纯靠源码顺序**（实测产物里 d2h 在前、我们在后）。把 `@import "./vscode-theme.css"` 挪到 `@import "diff2html/…"` 之前，23 条覆写会**整片静默失效**、配色退回 GitHub 那套，而“块是 unlayered”这条断言照样通过。故 `check:css` 那条断言必须**同时**查三件事：声明 `--d2h-*` 的块全部 unlayered；diff2html 那块与我们那块**都存在**——缺哪一侧都说明有一份 CSS 没被打进产物，顺序断言会对着空集合通过；且后者整个排在前者之后。**「哪块是我们的」由 `vscode-theme.css` 里的一条哨兵声明（`--gg-d2h-map`）认定，不按值的形状猜**：按“值里有没有 `var(--color-…)`”区分会给出**误导性红**——深色下给某个 `--d2h-*` 补一条字面量覆写（完全正当）就会被归到 diff2html 那一侧，于是门禁报「检查 `@import` 顺序」而顺序根本没问题。哨兵由我们自己写、自己控制，值怎么变都不影响分类，且它不见了本身就是一条正面断言。顺带把“覆写有没有覆全”也钉住：**diff2html 声明的每一个无前缀 `--d2h-*` 都必须出现在我们那个块里**，删掉半张映射表同样是静默退色。

**Tailwind v4 会裁掉没被引用的 `@theme` 变量**（2026-08-09 就 4.3.3 实测，见 `decisions.md` §10）：被工具类用到、或被我们自己的 CSS 以 `var()` 引用到的 token 都会输出到产物，两者都没有的会被丢掉。上一条“`--d2h-*` 一律指向 VS Code token”因此是安全的——那就是一次 `var()` 引用。但**引用名写错时没有任何报错**：引用侧留下一个无定义的 `var()`，该属性变为 unset，颜色悄悄没了。故 `check:css` 增一条断言：产物中每个不带 fallback 的 `var(--…)` 引用都必须在产物里找得到定义（`--tw-*` 除外，它们由 `@property` 声明）。

**深色那半是 delta，于是“声明侧”也有同一形状的静默失效**：`vscode-theme.css` 的 `@media (prefers-color-scheme: dark)` 里只列与浅色不同的 token，名字**写错一个字符不会有任何症状**——上面那条断言查的是**引用**侧，而一条 `--color-git-modifed: …` 在语法上就是个合法的新自定义属性，连“无定义”都算不上（它反而给 `defined` 集合添了一个成员）。后果是深色下那个 token 悄悄留在浅色取值上。故 `check:css` 再增一条：**产物里凡在深色媒体条件内声明的 `--color-*`，都必须在深色条件之外也有声明**。反向不查——浅色有而深色没有，正是“深浅共用同一取值”的正常写法（见 5.5 的六个 diff 底色）。

**随之而来的一条硬约束**：diff2html 渲染出的内部元素**只能通过覆写 `--d2h-*` CSS 变量改配色，不得用 Tailwind 工具类去压**——无层的 diff2html CSS 同样会胜过 `@layer utilities`，写了也不生效（见 `decisions.md` §10 禁止项）。同理，hljs 主题与 diff2html 的 CSS **不得放进任何 `@layer`**，一旦放进去就把上面这层保障拆掉了。

**diff2html 的行号列是 `position: absolute`，滚动容器内部必须有一个 positioned 祖先**（依据与实测见 `decisions.md` §10）。这与 5.4 的“两侧各自滚”是同一个决定的两半：diff2html 把行号做成绝对定位、偏移量全 auto，靠的是“包含块 = 初始包含块，而滚的就是整个文档”这个前提；我们为了让 SSE 刷新时留住列表侧的滚动位置，把滚动收进了内层的 `overflow-auto` 容器，那个前提就不再成立——**包含块在滚动容器之外的绝对定位盒不随该容器的内容滚动**，于是一滚代码行就跑了、整列行号原地不动，页面不报任何错。

- 包含块由 `DiffView` 里交给 `Diff2HtmlUI` 的那个宿主 div 上的 `relative` 提供。**滚动容器 `<section>` 自己加 `position: relative` 同样修得好**（包含块就是滚动容器时，绝对定位盒属于它的可滚动溢出、随内容滚动），选宿主 div 只是因为它是**作用域最小**的那个：与 diff2html 子树同生共死，不给外壳上任何别的绝对定位埋一个意料之外的包含块
- 它写成 Tailwind 工具类**不违反上面那条“只能改 `--d2h-*`”**：那条管的是 diff2html *渲染出来的*元素的配色，而宿主 div 是我们自己的元素，没有任何 d2h 规则命中它，不存在“被无层规则压过”的问题
- `test/unit/web/diff-view.test.tsx` 有一条断言钉着这个类名。**它只能钉到“类名还在”**——happy-dom 没有排版引擎，滚动与错位在那里不可判定，真布局属 `acceptance.md` §6 的人工那档

**S0 需验证**：`@import "tailwindcss"` 在 Tailwind v4 构建期展开后，后续 `@import` 的内容确实保持 unlayered。这是方案成立的前提，列为 S0 的前提验证项之一而非既定事实（三项前提验证见 `roadmap.md` §7）。

### 5.7 自动刷新：按 Node 能力分三档 + 轮询兜底

需要规避的风险：Node 在 **Linux 上的 `fs.watch({recursive:true})` 是用户态实现**——自己遍历目录树逐个注册 inotify watch，且**对每个普通文件也注册一个**，不止目录（已核对源码，见 `decisions.md` §10）。monorepo 下 `node_modules`、`.git/objects`、`target/` 会贡献绝大多数条目，足以耗尽内核 `fs.inotify.max_user_watches`，之后**整机所有依赖 inotify 的工具都开始报 ENOSPC，包括用户自己的编辑器**。这是本工具唯一可能对用户机器造成的外部副作用，与“零副作用只读工具”的核心承诺直接冲突，必须规避。

**解法：`fs.watch` 的 `ignore` 选项。** 它自 Node 24.14.0 起可用，在 Linux 的用户态递归实现里是**注册前跳过**而非回调后过滤（已核对源码，见 `decisions.md` §10），正是上述配额问题的官方解法。但 5.1 的下限是 Node 22，`ignore` 未必存在，因此按运行时能力分三档：

| 档 | 条件 | 工作区监听 | `.git` 监听 | UI 标注 |
|---|---|---|---|---|
| **A** | Node ≥ 24.14.0，三端 | `fs.watch(repoRoot, { recursive: true, ignore: isIgnored }, cb)` | 非递归 watch | 无 |
| **B** | Node < 24.14.0，macOS / Windows | `fs.watch(repoRoot, { recursive: true }, cb)` + 回调最前面复用同一个 `isIgnored` 过滤 | 同上 | 无 |
| **C** | Node < 24.14.0，Linux | **不建递归 watch**，工作区改动走 1.5s 轮询 | 同上 | 标注降级模式 |

表里只列原生监听那一半：**A / B 两档另有一个 30s 的低频安全轮询**，理由见下方兜底那条。

- **档位判定用 `process.versions.node` 的 semver 比对**，不得靠特性探测：任何探测写法都要依赖 `fs.watch` 对未知选项的处理这一未文档化的内部细节，误判的代价是在 Linux 上静默退化成无 `ignore` 的递归 watch（见 `decisions.md` §10 禁止项）
- **三档须能由内部环境变量 `DIFFTAB_WATCH_TIER=A|B|C` 强制指定**（名字定在此处，以免两处实现各起一个）。一台机器只有一个 Node 版本、一个平台，而三档正是按这两者分的——没有它，`acceptance.md` §6 那六条档位验收项在单机上一条都无从自查。**取值不合法即启动失败，不得退回自动判定**：退回时手滑写错的那次照样启动成功、照样给出一个看着合理的档位，于是“我逐档验过了”建立在一次根本没生效的强制指定上。它不是给用户的开关，不进 `--help` 与 README
- **B 档为什么安全**：macOS / Windows 走原生 FSEvents / `ReadDirectoryChangesW`，单句柄监听整棵树，本就没有配额问题；`ignore` 在这两个平台上本身也只是回调后过滤（已核对源码），我们自己在回调里调同一个匹配函数即可，不是重新实现监听
- **B 档的过滤必须发生在 debounce 之前**，否则 `node_modules` 的写入噪声照样把 debounce 窗口顶开、触发无谓刷新
- **C 档不是全盘轮询**：`.git` 侧的目录级非递归 watch 与 Node 版本无关，提交、切分支仍是即时的；只有工作区文件改动退化为 1.5s 轮询

**三档共用同一个匹配函数 `isIgnored`，不用字符串模式**：

```ts
const IGNORE_NAMES = new Set(['node_modules', '.git', 'dist', 'target', '.next', 'build']);
// 逐段匹配:路径任一段命中即忽略
const isIgnored = (p: string) => p.split(/[\\/]/).some(seg => IGNORE_NAMES.has(caseFold(seg)));
```

`fs.watch` 的 `ignore` 除字符串 / 正则外**也接受函数**，传函数即可绕开字符串模式的坑：

- **字符串 basename 模式在 macOS / Windows 上形同虚设**（已实测源码，机制见 `decisions.md` §10）。原生 watcher 交给匹配器的是事件的**相对路径**（如 `node_modules/.bin/foo`），按 basename 比对时匹配不上模式 `node_modules` → 事件照常放行。B 档在回调里按 basename 过滤同样失效，`acceptance.md` §6 “B 档：`node_modules` 下批量写文件不触发刷新”的验收项按字面实现必挂
- **Linux 侧两种写法等价**：递归实现是对遍历到的每个条目的相对路径调用匹配器，走到条目 `node_modules` 自身时即命中 → 注册前跳过、不再递归进入。逐段函数在这里的行为与 basename 模式完全一致
- **仍然不得写成 `node_modules/**` 这类含斜杠的字符串模式**：含斜杠会使 `matchBase` 失效，既匹配不到目录自身（白白进去一层），也匹配不到 monorepo 里嵌套的 `packages/*/node_modules`，两头落空。逐段函数两头都覆盖
- `caseFold` 在 macOS / Windows 上做小写归一（对齐 `ignore` 内部 `nocase: isWindows || isMacOS`），Linux 上原样返回；`.git` 已在集合内，与档位无关
- **`.git` 内部**：`isIgnored` 已把 `.git` 整个排除（C 档则根本没有递归 watch），因此三档都需对 `HEAD`、`index`、`refs/`、`MERGE_HEAD` / `rebase-*` 所在**目录**单独建**非递归** watch，否则检测不到提交与切分支。**绝不递归 `.git/objects`**
- **兜底**：任一路径失败（ENOSPC / ENOSYS / 网络盘 NFS·SMB / Docker 卷）自动降级为 **1.5s 轮询**，并在 UI 上标注降级模式。这条与档位正交：A / B 档失败时同样落到轮询，C 档则是一开始就以它为工作区通路。`ignore` 解决的是配额，救不了这些场景，**兜底不可省略**
  - **检测得到才降得了级，而 Linux 上的 ENOSPC 有一大半检测不到**（2026-08-12 核对 Node 24.14.1 源码，2026-08-18 在 CI 的 ubuntu runner 上压低配额实测，数据见 `decisions.md` §10）：`internal/fs/recursive_watch.js` 的 `kFSWatchStart` 把**根**那一次注册的失败整个吞掉——`catch (error) { if (error.code === 'ENOENT') throw; }`，ENOSPC / EACCES / EPERM 一律丢弃，`fs.watch()` 返回一个看着活着、却永远不 emit 的 watcher。**实测把这条推得更远：遍历途中耗尽同样不 emit**——此前按源码推断它会 `emit('error')` 从而被兜底接住，那个推断**是错的**。真正让 ENOSPC 浮出水面的是**下一次要注册 watch 的时候**，也就是工作区新出现一个条目的那一刻；于是“降级”发生在用户第一次新建文件之后，而不是启动那一刻
  - **残留缺口因此是「改一个启动前就存在、且没轮上注册的文件」**：它不引出任何注册尝试，事件静默丢失、`mode` 一直是 `native`、没有任何东西会响（已实测：配额 128 对 1200 个目录，改深层已有文件 → 不刷新）。**补法是下一条的低频安全轮询**；另一条候选“建流前先探一次非递归 watch”**被实测否掉**——根那次注册在该配额下是成功的，探它探不出任何东西
- **原生档（A / B）同时跑一个低频安全轮询**（`SAFETY_POLL_MS`，30s），用与降级轮询逐字相同的那条 status 命令，只做一件事：发现变化就照常推一次刷新。它补的正是上一条那个缺口——原生监听少报了什么时没有任何信号，只有拿 status 输出本身去比才看得见。**不翻 `mode`、不上报降级**：原生监听确实还活着（只是不完整），翻了会把一次可能的误判说成“已降级”，而两者代价不对称——多刷一次没有代价，把状态说错有。**周期取 30s 而不是 1.5s**，是为了让 `acceptance.md` §6 “原生监听模式下空闲 CPU 接近零”继续成立（一次 status 几十毫秒，占空比千分之几），代价是那个病态场景下最坏 30s 的滞后。真降级之后周期自动收到 1.5s——两者是同一个轮询循环的两个周期，不是两套机制
  - **轮询必须复用 5.2 的同一条命令 `git status --porcelain=v2 --branch -uall -z`，不得为“轮询只要知道变没变”而裁剪参数**。漏掉 `-uall` 的后果是静默的：git 会把未跟踪目录折叠成一行 `dir/`，于是**在一个已存在的未跟踪目录里新增文件根本不改变输出**，轮询判定为“无变化”、页面不刷新，而这正是 agent 边跑边生成文件时最常见的形态。漏掉 `--branch` 则会丢掉提交与切分支的检测（C 档只有 `.git` 侧的非递归 watch 兜着）。两条命令保持逐字一致，也让 5.10 的只读白名单只需覆盖一种调用形态

**已知边界：`IGNORE_NAMES` 只管监听、不管展示，且只在 A / B 档成立。** 变更列表的数据源是 5.2 那条 `git status`，它只认 `.gitignore`；而 `isIgnored` 那六个名字是写死的。两者对不齐时的形态是：**没有 `.gitignore` 的仓库里，`node_modules/` 或 `dist/` 下的文件在列表里看得见，改它却不触发刷新**。

**已知边界：轮询看不见「未跟踪文件的内容变化」。** 判据是 `git status` 的输出，而未跟踪文件在那份输出里只有一行 `? <路径>`——**改它的内容一个字节都不会变**，于是那条改动在**所有走轮询的路上**都发现不了：C 档的工作区通路、A / B 档降级之后、以及原生档那条低频安全轮询，三者一样。已跟踪文件不受影响（`? <路径>` → ` M <路径>`），新增与删除也不受影响（那一行本身出现或消失）。**原生监听没有这个问题**，所以它只在 Linux + Node 22（C 档）与真降级之后才浮出来；症状是页面上那个未跟踪文件的内容停在旧版本，而列表本身一切正常。**不修**：要看见它就得给每个未跟踪文件算内容哈希，而未跟踪文件恰恰可能是几百 MB 的构建产物——那与“零副作用只读工具”的开销承诺冲突得更厉害。这条边界在 2026-08-18 由一条写错的门禁探针暴露出来（拿未跟踪文件去验安全轮询，永远为假），记在这里免得下次再踩。

**另一条已知边界：Windows 上一次突发写入可能引出一次与内容无关的刷新。** `ReadDirectoryChangesW` 的通知缓冲区被突发写满时，内核报的是“丢了一批”而不是具体路径，Node 由此 emit 一个**没有 `filename`** 的事件——而本节明写着 `filename` 为 null 时**放行**（漏刷一次比多刷一次糟）。于是往 `node_modules` 里一口气写几十个文件，过滤逐个都拦住了，却仍会因为一次溢出多刷一次。**这是取舍不是缺陷**：溢出恰恰意味着“你漏掉了些什么”，此刻唯一安全的做法就是刷新；真要按名字丢掉它，代价是与 `node_modules` 噪声混在一起的那次真实改动一起丢。已实测三端九档：间隔开写入时三端都是 0，突发写入只有 Windows 出 1（见 `decisions.md` §10）。**因此 `acceptance.md` §6 那条 A 档验收项的判据是“间隔开的写入一次都不刷”**，突发那一路在 Windows 上按本条放宽到最多 1 次。

**这条边界与档位有关，而且方向反直觉：C 档（以及任何降级到轮询的情形）照常刷新。** 轮询比的是那条 status 命令的输出本身，`isIgnored` 在那条路上一次都不会被调用（它只出现在 A 档传给 `fs.watch` 的 `ignore` 与 B 档的回调过滤两处）。三档已逐一实测，见 `decisions.md` §10。**因此“同一个仓库在不同机器上刷不刷新”是可能的**——Linux + Node 22 落 C 档会刷，换成 Node 24 落 A 档就不刷；排查时别把它当成机器坏了。

不改成“按 git 的忽略规则建 watch”：那要么在监听层引一次 `check-ignore`（把 watch/ 拖上 git 的依赖边，5.0 不允许），要么自己解析 `.gitignore`（重写一份 git 的匹配语义）——代价都远大于这个形态的实际影响。**A / B 档上影响面之所以窄，是因为它只在“这一整段时间里除了这些目录什么都没动”时才可见**：任何其他变更都会触发一次完整的 status 重取，把它们一并带出来。UI 不为此加标注——那要求 UI 说清“哪些文件不受监听”，而那正是这条边界本身的复杂度。

另有三条 Node 官方文档载明的行为约束，三档均适用：

1. **绝不能对单个文件建 watch**。Linux/macOS 上 watch 绑定的是 inode，路径被删除后重建会分配新 inode，原 watch 从此静默失效——而编辑器和 agent 普遍用“写临时文件 + 原子 rename”保存文件。必须 watch 目录
2. 回调的 `filename` 参数**可能为 null**，即便在支持的平台上也不保证提供，必须有 fallback 逻辑
3. 事件需做 debounce（建议 100-200ms）合并，避免 agent 批量写文件时风暴式推送。**在 Linux 上这是必需项而非优化项**：用户态递归实现在初次遍历目录树时，会对遍历到的每个条目 `emit('change', 'rename', ...)`，启动瞬间即产生一波与实际变更无关的事件风暴（已核对源码），没有 debounce 会直接触发一次无意义的全量刷新

变更通过 SSE（Server-Sent Events）推送前端刷新。

### 5.8 进程生命周期

- 以“无任何已连接客户端持续 **45 秒**”作为退出条件（取 30-60s 区间中值）。页面刷新、系统休眠唤醒、浏览器丢弃后台标签（Chrome 省内存机制）都会造成短暂断连，需要宽限期避免误退出；多标签同时连接时以客户端计数为准
- **实现要点**：服务端 SSE 心跳约 15s；前端监听 `visibilitychange`，标签重新激活时先按「静默是否超过两拍心跳」判一次死连接，已经不新鲜就掐掉重连。**判死只在这一处做，不另设定时器**——用户回来看的那一刻正是最值得重试的时刻；代价是一个**始终可见**的标签页在连接静默后不会自愈，而回环上能造出「连接活着却没人应答」的只有服务进程被冻住这一种形态（已实测，见 `decisions.md` §10）
- **宽限期从启动那一刻就开始计**，不等第一个客户端到达：否则“浏览器没拉起来”（headless、无 `xdg-open`、`--no-open` 后用户改主意）这一整类情形留下的是一个永久常驻的后台进程，而 `acceptance.md` §6 那条验收项要的正是“不留后台常驻进程”。45 秒足够覆盖冷启动浏览器进程的 2-5s（见 `acceptance.md` §6）
- **判据是 SSE 连接数，但任何请求都重置计时**。连接数是正面判据（`GET /api/events` 的连接集合大小，不另设保活端点）；而“刚被探活复用、浏览器还在启动”与“页面活着但 SSE 被中间层悄悄回收了”这两种情形下连接数都是 0，只有请求活动能证明另一头还有人。两者取并集，退出条件因此严格弱于“连接数为 0 持续 45s”，不会误退
- **宽限期须能由内部环境变量 `DIFFTAB_IDLE_MS` 覆盖**（名字定在此处，以免两处实现各起一个），**取值不合法即启动失败，不得退回默认的 45 秒**。两条理由都与 5.7 的 `DIFFTAB_WATCH_TIER` 同类：没有它，`acceptance.md` §6 那三条生命周期验收项的每一次自动化验证都要真等 45 秒，而那种用例没人会跑第二次。它**不放宽 5.9 的任何一道校验**，因此不属于 5.9 末段禁止的“dev 分支”；同样不是给用户的开关，不进 `--help` 与 README
- **退出前的那句提示走 `writeSync`，而且要容许它失败**（读端已走时它抛 EPIPE，见 `decisions.md` §10），与 5.1 版本守卫的报错同理：`process.stdout.write` 写到管道时在 Windows 上是异步的，紧跟着 `process.exit()` 会把整条消息丢掉——而这句提示正是自动化验证“它是自己走的，不是被 kill 的”的判据
- **已知边界**：HTTP/1.1 下浏览器对同源有 6 条并发连接上限，一条常驻 SSE 会占用其中一条，因此超过 6 个标签页时新标签会挂起。对本工具的实际使用场景（1-2 个标签）无影响，不为此调整架构
- **同仓库单实例**：实例注册表文件写在 `os.tmpdir()`，文件名用仓库绝对路径的 hash。**绝不能写进 `.git/` 或工作区**——否则既污染 `git status`，也实质违背零写操作承诺。陈旧实例的判定用 **HTTP 探活**（请求已记录的端口，校验返回的 repo 路径一致）而非 pid 存活判断——pid 会被系统复用，误判会把用户带到一个指向别人进程的页面
- **探活的落地形态**：向记录的端口发 `GET /api/instance`（5.12），带上记录里的 token 与合规的 `Host`——三道校验一视同仁，探活不是例外。命中的判据是**两条同时成立**：响应 200（token 不匹配即 403，那说明这个端口已经归了别的进程，哪怕它也是 difftab）、且返回的仓库路径与本次的 `git rev-parse --show-toplevel` **归一化后**相等（归一化复用注册表键那一份实现，理由同该处：Windows 的分隔符、macOS 的 `/var` 符号链接）。命中即**打印同一个 URL、拉起浏览器、以 0 退出，全程不碰注册表**——那条目是别人的进程写的，连“顺手更新一下”都不行。未命中（连接被拒、超时、非 200、路径不符）一律按陈旧处理，照常启动并覆盖该条目。**正文另设一个 64 KB 上限**：端口可能已经归了一个完全无关的服务，而它的应答可以是任何东西，包括一条无穷的流
- **探活超时取 1.5s，不取更短**：被探的实例可能正卡在 5.7 说的那趟用户态递归遍历里（Linux 上大仓库要几百毫秒到数秒），超时过短的代价不是慢一点，而是**给同一个仓库起了第二个进程**——正是本条要防的那件事。反过来超时过长的代价只是启动慢：注册表不存在时根本不探活（常态，冷启动门禁因此不受影响），存在而端口已死时 `ECONNREFUSED` 在 localhost 上是立即返回的，只有“端口被一个不答话的第三方服务占着”这一种罕见形态才真的等满 1.5s
- **注册表文件权限**：该文件存有端口与 5.9 的会话 token。`os.tmpdir()` 的权限因平台而异，**Linux 上是 `/tmp`，同机其他用户可读**（已实测，见 `decisions.md` §10）。因此必须以 `mode: 0o600` 配合 `O_EXCL` 创建（而非先建后 chmod，避免竞态窗口），或统一落在 tmpdir 下的每用户私有子目录中

### 5.9 本地安全

服务绑定 `127.0.0.1`，启动时生成随机端口 + 会话级 token。token 在进程生命周期内持续有效，以支持页面刷新与多标签场景。

需要澄清的是：**token 本身不是 DNS rebinding 的防御手段**。rebinding 的攻击路径是恶意页面把自己的域名重绑到 `127.0.0.1`，使浏览器认为攻击者页面与本服务同源；token 能挡住攻击者读取受保护端点（它拿不到 token），但只要存在任何一个不校验 token 的端点（健康检查、静态资源），仍会泄漏信息。因此必须同时具备：

1. **校验 `Host` 请求头**必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，其余一律 403——这才是 rebinding 的正面防御
2. **校验 `Origin`**：非空且不等于自身则 403；所有响应不带任何 CORS 头
3. **token 落地方式**：URL 携带 token → 首次访问后置换为 `HttpOnly; SameSite=Strict` cookie 并 302 掉 query，避免 token 长期滞留在浏览器历史、地址栏和日志中。SSE 端点同样校验。**需知 cookie 的作用域是 host 而非 origin，不隔离端口**：同机另一个监听 `127.0.0.1:<其他端口>` 的服务同样会收到这个 cookie。这不影响第 1 条的 rebinding 防御（攻击者页面的 host 是自己的域名，cookie 根本不会发出），但意味着 token 会暴露给本机其他 localhost 服务，因此服务端校验 token 时需**一并绑定校验本次会话的端口**，使泄漏出去的 token 无法在别处复用
4. 所有端点（含 SSE）统一校验，无例外；响应带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。**这三道也必须排在其余一切判定之前**——包括“只接受 GET / HEAD”这类看着无害、且天然想往函数开头放的廉价同步判定。排在前面时，一个 POST 会在 Host 那道开口之前就拿到 `method-not-allowed`，而 rebinding 的攻击页面此刻与本服务同源、读得到这句话：数据仍拿不到（还有 token），漏的是**服务本身的存在性**，而第 1 条正是为挡住这类页面而设。可检查的判据在 `acceptance.md` §6 的验收项里
5. **严格 CSP**：`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`。后三个指令**不回退到 `default-src`**，不显式写就等于没设，`'none'` 一并挡掉被 iframe 嵌套、`<base>` 改写相对 URL 与表单外发。这条是 5.11 构建链路顺带解锁的——产物是独立的 `.js` / `.css` 文件、页面无内联脚本，才有条件不开 `'unsafe-inline'`。diff2html 的输出经 `innerHTML` 注入，其自身对内容做转义，CSP 在此作纵深防御
6. **静态资源按内存清单白名单式映射**，不得用 `path.join(root, req.url)` 之类的路径拼接读文件，避免路径穿越。构建产物文件名因此固定、不加 hash——服务端本就对所有响应发 `Cache-Control: no-store`，内容哈希没有意义

**已知边界：URL 里的 token 会经过命令行，而 argv 对同机其他用户可见。** 5.1 拉起浏览器的三条系统命令都只能从 argv 收 URL，没有别的传递面（`open` 不读 stdin），于是 token 在浏览器被拉起的那一瞬对本机其他用户是可读的（已实测，见 `decisions.md` §10）。**不装作它不存在——它与 5.8 给注册表文件加 `0o600` 防的是同一件事**：那边挡住了同机其他用户读 token，这边又从命令行交了出去。接受它的依据是代价对比：窗口是几十毫秒量级、且要求攻击者已经在同一台机器上以另一个用户身份紧循环轮询；而**唯一能真正关掉它的改法是把 URL 里那份换成一次性交换码**（首访换成 cookie 后即作废——被抢跑时用户看到的是一个 403 页面，即由无声泄漏变成响亮失败），代价是 5.8 的探活复用要另想办法拿到 URL：那条路上重拼 URL 的是**另一个进程**，它手上只有注册表里那份长期有效的 token。首版按本条接受，不做交换码；**Linux 上的窗口至今未实测，而且不打算靠 CI 补**（`xdg-open` 是脚本、`/proc/<pid>/cmdline` 默认全局可读，预计比 macOS 大）——runner 没有桌面会话，`xdg-open` 在那里立刻失败退出，量出来的窗口比真实桌面上短得多，**是个会让人放心的假数**。它归 `acceptance.md` §6 开头列的「留在 CI 之外」那两类，与“浏览器真的弹出来”同一批，待有真实 Linux 桌面时复核。

**开发期不得以放宽本节校验为代价换取便利。** Vite dev server 与后端不同源，会同时撞上 Host、Origin、token 三道门，解法一律放在 dev server 的代理层（改写 `Host` / `Origin`、注入 token cookie），**后端不得为此新增任何环境变量或分支**——那等于把本节的正面防御做成一个可被误开的开关（详见 5.11，并见 `decisions.md` §10 禁止项）。

### 5.10 只读性的验证方式

4.1 的“零写操作”是产品核心承诺，需要能自动化证伪，而不是靠人工审查代码。**“前后 `git status` 比对无变化”强度不足**——它发现不了写进 `.git/` 但不改变 status 输出的操作（意外触发 gc、写 index、创建对象）。因此采用两层验证，均纳入 CI 门禁：

1. **主门禁**：测试期间用 git 自带的 **`GIT_TRACE=<绝对路径>`** 记录产品发出的每一次 git 调用（含完整参数），断言子命令只出现在只读白名单（`status` / `diff` / `rev-parse` / `ls-files` 等）。S1 落地为 `test/smoke/readonly.test.js`，归 matrix 作业，三平台同一套写法
   - **原方案“PATH 上放一个 fake git wrapper”已在 S1 排除**，原因正是当初标出来的那条 Windows 风险：PATH 劫持要求一个 Windows 认得的可执行文件，而 Node 自 20.12 起不带 `shell` 就**拒绝 spawn `.cmd` / `.bat`**；退而把 node 二进制装成 `git` 时，node 自己的 CLI 解析会先把参数吃掉一截，记到的“完整子命令”是错的。两条均已实测，依据见 `decisions.md` §10
   - `GIT_TRACE` 反而多覆盖一层：git **内部**再起的子进程（自动 gc 之类）同样入账，而那正是“写进 `.git/` 但不改变 status 输出”的典型——本节开头排除“前后 `git status` 比对”时说的就是它
   - **必须同时断言“确实记到了东西”**：环境变量没传下去、路径给成相对的、产品换了个不经封装层的方式调 git，都会让白名单断言对着一个**空数组**通过。假绿的只读门禁比没有门禁更糟，因此门禁里要有一条正面断言——完整流程跑完后，日志里必须见到 `status` / `diff` / `rev-parse` / `ls-files`
2. **冒烟测试**：跑一遍完整流程，证明 `.git` 没被动过。这一层由**两半**组成，缺一不可（S2a 落地为 `test/smoke/readonly-git-dir.test.js`，归 matrix 作业）：
   - **A · 只读 `.git`**：`chmod -R a-w .git` 后跑完整流程。凡是**会报错**的写尝试（创建对象、写 lock 文件、意外触发的 gc）当场暴露。Windows 上 `chmod` 挡不住写入（Node 只映射只读属性，对目录无效），改用 `icacls` 的拒绝 ACL，拿不到则**显式跳过并打印原因**，不得静默通过。这一半必须自带一条“锁真的锁上了”的探针断言——root 用户、某些容器挂载下 `chmod` 不生效，那时用例照常变绿却什么都没验证
   - **B · `.git` 逐字节不变**：在**可写**的 `.git` 上前后各拍一次快照（每个文件的 size + mtime + 内容摘要）并比对。**A 单独不成立**，这是 2026-08-08 的实测修订：git 把 index 回写当作 best-effort，`.git` 只读时它**静默跳过，exit 0、stderr 全空**（证据见 `decisions.md` §10）——于是漏掉 `GIT_OPTIONAL_LOCKS=0` 时 A 照样全绿，而那恰恰是本层唯一要保护的东西
     - B 需要一个**会触发 index 回写**的仓库状态（把某个“内容与 index 一致、只是 stat 过期”的文件的 mtime 改旧），并自带一条**正面对照**：同一仓库上直接跑一条不设 `GIT_OPTIONAL_LOCKS=0` 的 `git status`，断言 `.git` 这次确实变了。没有它，“产品没改动 `.git`”会在仓库压根不触发回写时变成一句对谁都成立的空话——与主门禁必须有“确实记到了东西”是同一条道理
   - 本层要求产品**不得让 git 写 index**：`git status` 默认会把刷新过的 stat 缓存写回 `.git/index`，它不改变 status 输出（所以第一层与“前后比对”都看不见）。封装层统一设 `GIT_OPTIONAL_LOCKS=0` 规避，该变量在 git < 2.15 上不存在、设了无害

**唯一的非 git 子进程豁免**：5.1 的拉起浏览器（`open` / `cmd /c start ""` / `xdg-open`）。它不经过 git 封装层、`GIT_TRACE` 也记不到，因此需在测试里**单独断言**：产品代码中除 git 封装层外只存在这一处 `child_process` 调用，且被调命令来自这三者的固定映射、参数只有 URL 一项。该静态断言查的是**相等**而非“没有多余的”——只查多出来的一半时，两处调用点双双改名会让白名单静默变成空表。CI 里该调用需可通过环境变量关闭，避免每次跑测试都弹出浏览器。

### 5.11 开发工具链与构建

本节全部内容为**开发期依赖**，不进 `dependencies`，不随 npm 包分发给用户，不改变 5.1 “运行时只用 Node 标准库” 的约束。版本为 2026-07-31 从 npm registry 实测的当时最新版（依据见 `decisions.md` §10）。

| 位置 | 选型 | 版本 | 理由 |
|---|---|---|---|
| 包管理器 | pnpm | **11.20.0** | 严格 node_modules（不扁平化）+ 内容寻址存储。**版本的唯一事实来源是 `package.json` 的 `packageManager` 字段**，本表只作记录。见下方「包管理器」一段 |
| 构建 | Vite（Rolldown / Oxc） | 8.2.1 | 2026-03 发布，Rolldown 已为默认 bundler |
| 语言 | TypeScript（**仅 `--noEmit` 类型检查**） | 7.0.2 | 2026-07-08 稳定的 Go 原生编译器。本项目不需要 declaration emit，正好避开 7.x 尚在完善的部分；转译交给 Vite / tsdown。**二进制名是 `tsc`**——`tsgo` 是预览包 `@typescript/native-preview` 的名字，稳定版并入 `typescript` 主包后已回归 `tsc`（实测 `bin` 字段，见 `decisions.md` §10） |
| 前端框架 | Preact + @preact/signals | 10.29.8 / 2.11.0 | 见 5.4 |
| 样式 | Tailwind v4 + `@tailwindcss/vite` | 4.3.3 | 见 5.6 |
| 后端打包 | tsdown（Rolldown 系） | 0.22.14 | 与 Vite 8 同引擎，产出单文件 ESM |
| 格式化 / lint | Biome | 2.5.7 | 一个二进制覆盖 format + lint + import 排序，一份配置 |
| git hooks | lefthook | 2.1.10 | 单 YAML，不需要额外的 lint-staged |
| 测试 | Vitest + `node:test` | 4.1.10 | 分层用途见下方 CI 一段 |
| DOM 测试环境 | happy-dom | 20.11.2 | 只给 `src/web` 的渲染路径用，按目录分环境。见下方「DOM 测试环境」一段 |

**未采用**：React 19（~42 KB gzip，与“最轻”定位相悖）、Svelte 5（Biome 不支持 `.svelte` 模板/样式，需额外挂 Prettier）、Node 原生 type stripping 直接运行 `.ts`（会把运行时下限从 22.0.0 顶到 22.18，且给冷启动加转换开销，见 `decisions.md` §10 禁止项）。

**DOM 测试环境**（2026-08-09 于 S2c 加入）：5.5 那几条“违反后不报错、只是静默出错”的约束——`draw()` 后重复调 `highlightCode()` 产生嵌套重复 span、漏注册 `plaintext` 炸掉整个 diff 视图、`colorScheme` 一旦回到 `auto` 就让 5.6 的深色取值静默失效——**都只有在真实 DOM 上跑一遍才断言得了**，而在此之前 `src/web/diff/` 与组件是零自动化覆盖。选 happy-dom 而非 jsdom：纯 JS、无原生依赖、启动快，本项目只需要 `innerHTML` 与属性/class 断言这一档能力。

- **环境按目录分，不全局开**：`test/unit/web/` 用 happy-dom，`test/unit/server/` 保持 node。给后端用例套一层 DOM 全局，是把“前端拿不到也不该拿到 Node API”那条边界反向捅一刀
- **落地方式是 Vitest 的 `projects`，不是 `environmentMatchGlobs`**——后者在 Vitest 4 已被移除（实测 4.1.10 的类型定义里已无此键）
- 它仍只是开发期依赖：matrix 档不装依赖、跑的是 `node --test` 冒烟套件，不受影响

**包管理器**——pnpm 只用于开发期，不改变 2. 的分发口径，也不改变 `dependencies` 为空这一事实。**版本钉 pnpm 11**，本节的配置面按 11 描述（11 相对 10 有三处破坏性变更，均直接打在下列条目上，依据见 `decisions.md` §10）：

- **版本的唯一事实来源是 `package.json` 的 `packageManager: "pnpm@11.20.0"` 字段**，不在别处重复写版本号。CI 用 `pnpm/action-setup` 且**不传 `version`**，让它读该字段；不依赖 Node 是否自带 Corepack——Corepack 已不再随 Node 25+ 发行版分发，而 CI 矩阵含 Node 26，靠它等于把工具链固定寄托在一个正在消失的东西上
- **`pnpm-workspace.yaml` 是所有 pnpm 设置的唯一位置**，单包仓库同样需要这个文件。pnpm 11 起：**不再读 `package.json` 的 `pnpm` 字段**，`.npmrc` **只保留 registry 与鉴权**，其余设置一律改用 `pnpm-workspace.yaml` 里的 camelCase 键。**写错位置不报错、无 deprecation 警告，只是设置静默不生效**（见 `decisions.md` §10），因此本节每一条约束的落地都必须连带确认它写在了正确的文件里
- `pnpm-lock.yaml` 入库，所有非交互安装用 `pnpm install --frozen-lockfile`（CI、以及本地复现问题时）
- **严格 node_modules 是资产不是障碍**：禁 `shamefullyHoist` / `nodeLinker: hoisted`（pnpm 11 的键名，写在 `pnpm-workspace.yaml`；理由见 `decisions.md` §10）。任何被 import 的包必须由我们自己声明——5.5 提到的 diff2html 两个传递依赖（`diff`、`@profoundlogic/hogan`）由打包器经 diff2html 自身的依赖树解析，**我们的代码与配置不得直接引用它们**
- **依赖的生命周期脚本默认不执行**：需要执行的包必须显式列进 **`allowBuilds`** 白名单（pnpm 11 把 `onlyBuiltDependencies` / `neverBuiltDependencies` / `ignoredBuiltDependencies` / `onlyBuiltDependenciesFile` / `ignoreDepScripts` 合并成的这一个 map 设置，形如 `allowBuilds: { lefthook: true }`）。**已知 `lefthook` 需要**——它靠安装后脚本把 git hooks 写进 `.git/hooks`，漏列不报错、安装照常成功，只是 hooks 静默没装、提交前检查全线失效。S0 建立时逐个确认该清单
- **S0 的三项前提验证一律在 pnpm 的 node_modules 布局下跑**（见 `roadmap.md` §7），尤其第 2 项深导入 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 与第 3 项体积 spike：在 npm 扁平布局下通过、换到严格布局才 resolve 失败，是这类 spike 最典型的假绿
- **`test/fixtures/` 的生成脚本与 `scripts/` 下的 bench / size 门禁脚本必须是零依赖纯 JS，可由 `node <路径>` 直接执行**，`package.json` 里的 `fixtures` / `bench:startup` / `size` / `check:css` / `check:global` / `check:inotify` 只是别名。理由与下方 matrix 档“完全不装依赖”同源：这些脚本要在没有 pnpm、没有 `node_modules` 的 matrix 机器上跑，一旦写成 TS 或引入 devDependency，matrix 档就只能退回“装一点点”，而那是 `decisions.md` §10 明令禁止的

**产物结构**：

```
bin/difftab.js      手写保守语法 JS。不参与 TS 编译、不作为打包入口(见 5.1)。
                      只做 process.versions.node 检查 + 动态 import('../dist/server/main.js')
src/server/**.ts  →   tsdown → dist/server/main.js   单文件 ESM,不压缩不混淆(见 5.1)
src/web/**.tsx    →   vite   → dist/web/{index.html, app.js, app.css}   固定文件名不加 hash(见 5.9)
```

**TypeScript 配置**（承担 5.1 的 API 上限守卫）：

- `@types/node` 锁 `^22`——**不是** latest 的 26.x。用到 Node 24+ 才有的内置 API 时编译期即报错
- 后端：`target` / `lib` 取 `ES2023`、`module: nodenext`
- 前端单独一份 tsconfig：`lib: ["ES2022","DOM"]`、`jsx: "react-jsx"`、`jsxImportSource: "preact"`
- 两份均开 `verbatimModuleSyntax` + `erasableSyntaxOnly`（禁掉 enum 与参数属性，保持语法可擦除，为将来若改用原生 type stripping 留门）
- JSX 转换首选走 **Vite 8 的 Oxc 选项 + alias**，不引 `@preact/preset-vite`（它会拖入 `@babel/core`）。代价是失去 prefresh 的组件状态保留 HMR，整页刷新对本项目够用；若 DX 明显不足再回补该插件

**Dev server 与 5.9 的交互**：Vite dev server 在 `localhost:5173`，后端在 `127.0.0.1:<随机端口>`，三道校验全部在 `vite.config.ts` 的 proxy `configure` 钩子里解决，**后端零 dev 分支**：

- `changeOrigin: true` → `Host` 头改写为后端的 `127.0.0.1:<port>`
- `configure` 中把 `Origin` 头重写为后端自身 origin
- `configure` 中从 `os.tmpdir()` 的单实例注册表（5.8）读出 port 与 token，注入 `Cookie` 头

**因此注册表文件的写入必须与 server 同期落地（S1），不能等到 S3c。** 5.8 的单实例能力可以拆开：**“server 启动即把 port + token 写进注册表”属 S1**（含 5.8 要求的 `0o600` + `O_EXCL`），**“启动时探活复用已有实例”与“空闲 45 秒退出”才属 S3c**。若把整个注册表推到 S3c，S1 到 S3c 之前 dev proxy 就没有 token 来源，而那段时间里“临时给后端加个放宽校验的环境变量”恰好是最短路径——正是 `decisions.md` §10 明令禁止、且 `roadmap.md` §7 总原则（“门禁不得晚于它所保护的代码”）要求消除的那种排期。

**CI 分层**——`tsdown` 要求 Node `^22.18 || >=24.11`、Vite 8 要求 `>=22.12`，均高于产品运行时下限 22.0.0，因此 CI 必须拆成两层。矩阵作业测的是**用户真正拿到的产物**，而非 TS 源码：

1. **build 作业**（Node 24）：`pnpm/action-setup` → `actions/setup-node`（`cache: 'pnpm'`）→ `pnpm install --frozen-lockfile` → `biome ci` → `tsc --noEmit` → `vitest run`（单元/集成，直接跑 TS 源码）→ 构建 → 检查产物体积门禁（5.5）→ 上传 `dist/` artifact。**`pnpm/action-setup` 必须排在 `actions/setup-node` 之前**，否则后者的 `cache: 'pnpm'` 找不到 pnpm 可执行文件，缓存步骤直接失败
2. **matrix 作业**（Node **22.0.x** / 24 / 26 × macOS / Windows / Linux）：下载 `dist/` artifact，**完全不执行安装、也不需要 pnpm**，用 `node --test` 直接打到纯 JS 编写的冒烟套件文件（不经 `package.json` 的 script）——CLI 启动、status、diff、5.10 的两层只读验证、冷启动 ≤300ms 测量。**不得改成“装一点点”**（如 `pnpm install --prod`），理由见 `decisions.md` §10
   - `node --test` 在一个用例都没匹配上时是 **0 用例、exit 0**。因此本档在跑测试之前必须先数一遍冒烟文件、数不到就失败：一次改名或某个平台上的引号行为不同，会把「只读承诺的唯一自动化保护」变成一个什么都没跑的绿勾
   - **体积门禁不进本档**：matrix 下载的是同一份 `dist/`，字节完全相同，再跑 9 遍不增加覆盖，反而引入方差——gzip 输出长度取决于各 Node 大版本自带的 zlib，贴着预算的行会只在某一个 Node 上红。它归 build 作业跑一次
3. **old-node-guard 作业**（Node 20，即**低于下限**）：不下载产物，直接 `node bin/difftab.js`，断言 exit 1 + 打印友好提示 + stderr 无 `SyntaxError` + stdout 为空。单列一档是因为 build 与 matrix 都跑在 ≥22 上，而守卫要防的是**解析期**失败——在 22+ 上文件早已解析成功，那条路径永远测不到。冒烟里那条「不含 `?.` / `??` / 顶层 await / 私有字段 / `||=`」的正则清单只是它的替身，替身按具体语法逐条列举，`catch {}`、对象展开、class 静态块等一律漏网
4. 5.10 的主门禁靠 `GIT_TRACE` 记录，与代码是否打包无关，归属 matrix 作业
5. **冒烟测试不得依赖 `node:test` 的顶层 `before()` / `after()`**：下限档 Node 22.0.0 的 runner **不等顶层异步 `before()` 完成就开跑该文件的用例**（2026-08-08 在本机 22.0.0 复现，证据见 `decisions.md` §10），`after()` 同样提早触发。准备工作要写成记忆化的 Promise、由各用例自己 `await`。这条只在下限档红，24 / 26 全绿——正是 matrix 要有一档真跑在下限上的理由

### 5.12 后端接口契约

本节汇总 5.2 / 5.3 / 5.7 的产物在 HTTP 层的形状，是 5.0 边界不变式第 4 条（前端不内联 git 知识）的具体承载。类型定义放 `src/server/shared/`，前后端共享同一份——**除了 `InstanceInfo`**：`shared/` 是「前端唯一允许 import 的后端目录」（5.0 不变式 4），而这一项的唯一消费者是下一个 CLI 进程，放进去等于把它从「前端的契约面」变成「任何线上类型」，于是「前端到底依赖什么」不再有按目录回答的办法。它与端点同住 `http/`，由 `cli/probe.ts` 以 `import type` 取用（`cli → http` 本就是允许的方向，连运行时的边都不多一条）。

**端点清单——全部为 `GET`**。只读工具不需要任何非幂等端点，这条本身就是一道约束：出现 `POST` / `PUT` / `DELETE` 即意味着有人在往 4.1 的承诺外扩功能。

| 端点 | 返回 | 说明 |
|---|---|---|
| `GET /` | `dist/web` 静态资源 | 固定文件名不加 hash（见 5.9） |
| `GET /api/state` | `{ branch: BranchState, files: FileEntry[], watch: WatchState }` | 对应 5.2 的**单次** status 调用；`watch` 见下 |
| `GET /api/diff?path=&oldPath=` | `DiffPayload` | 按文件懒加载；`oldPath` 仅重命名条目传（5.2 的双路径要求） |
| `GET /api/events` | SSE | 事件 `change` / `heartbeat`；5.8 的空闲退出以本端点的连接数判定，不另设保活端点 |
| `GET /api/instance` | `{ repoRoot, pid }` | 5.8 的探活复用**唯一**的消费者（不是给前端的）；返回的 `repoRoot` 是给下一个 CLI 进程比对身份用的 |

**协议类型**：

- `FileEntry { path; oldPath?; kind: 'tracked' | 'untracked'; staged; unstaged; renameScore?; conflicted? }`——`staged` / `unstaged` 承载 `porcelain=v2` 的双状态位，`oldPath` + `renameScore` 来自 5.2 的 `2 ` 记录
  - **`conflicted` 是“这条来自 `u` 记录”这一事实本身**（2026-08-14 于 S4b 补），不是从状态位推出来的：`DD` / `AA` 两位都不是 `U`（5.3），而“未合并”恰恰是那三个分组谓词唯一无法从 XY 读出来的东西。归属留给前端等于让它自己重写一遍 porcelain 的记录类型，正是 5.0 不变式 4 禁止的
- `BranchState { head; detached: boolean; upstream: null | { ahead; behind }; operation?: 'rebase' | 'am' | 'merge' | 'cherry-pick' | 'revert' | 'bisect' }`——**`upstream: null` 即“无上游”**。 `acceptance.md` §6 要求无 `# branch.ab` 行时展示“无上游”而非 0/0，把它编码进类型而非留作约定，前端就不可能漏掉这条分支。`operation` 缺省即“没有进行中的多步操作”，取值与判据见 5.3
- `DiffPayload` 为判别联合：`{ kind: 'text', patch }` / `{ kind: 'binary' }` / `{ kind: 'too-large', size, reason: 'size' | 'lines' }` / `{ kind: 'untracked-text', patch }`
  - **`too-large` 必须带 `reason`**（2026-08-09 于 S2c 补，原因见本节末「字段定型时机」）。它有**两个**触发口：体积超 5MB 与行数超 50,000（5.2）。只带 `size` 时，行数那一路的文件可能只有几百 KB，前端手里唯一的数字既解释不了为什么不预览、按 MB 取整还会显示「文件过大（0 MB）」这种自相矛盾的话。判别原因属后端知识，前端不该也无法从 `size` 反推
  - **`size` 只用于展示，不是判定依据**（5.2：判定在补丁字节与行数上）。它**可以是 0**——已被删除的文件在工作区没有体积可取，两个 `reason` 都会遇上；前端据此不显示体积，而不是把 0 四舍五入成「1 KB」，编一个数出来比不说更糟
- `InstanceInfo { repoRoot: string; pid: number }`——**唯一一个正文里带绝对路径的响应**，与“错误消息不含绝对路径”不冲突：那条防的是把本机目录结构混进面向页面的输出，而这里路径**就是**被问的那件事（5.8 要比对的正是它）。能读到它的前提是手里已有本会话 token，而拿着 token 本就能读遍整个仓库的 diff，路径是其中最不敏感的一项。前端不消费它，页面上不出现
- `WatchState { mode: 'native' | 'polling'; tier: 'A' | 'B' | 'C' }`——承载 5.7 的档位与是否已降级。**`acceptance.md` §6 多处要求“UI 明确标注降级模式”，而降级既可能是 C 档的既定形态、也可能是 A/B 档运行中落到轮询兜底，前端无从自己推断，必须由后端告知**；放进协议类型也正是 5.0 边界不变式第 4 条（前端不内联 git / 监听知识）的要求

**字段定型时机**：**payload 的字段与判别式在 S1 / S2b 即定型，即使 `binary` / `too-large` / 重命名标注的填充逻辑要到 S4a 才实现、`watch` 的真实取值要到 S3b1 才有**。在此之前后端可以永远不返回那几个分支、`watch` 固定返回占位值，但类型里必须先有。这与 `roadmap.md` §7 “第一批 fixture 决定解析器结构”是同一条论证：字段晚定，等于前端在 S2b 按 `kind: 'text'` 单一形状、按“永远不降级”写死，S3b / S4 再回头改渲染分支。

**错误约定**：`{ error: { code, message } }`，`message` **不含绝对路径**（与 5.9 及 S5 的安全自查一致）。

**明确不做**：协议版本协商。前端随进程自带分发，不存在版本错配的可能，加版本字段只是空转。

