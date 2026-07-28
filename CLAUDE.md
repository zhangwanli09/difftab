# GitGlance

一眼看懂 AI 编码 Agent 改了哪些代码。CLI 在仓库目录启动 → 拉起本地网页 → 只读展示当前工作区的 diff 与分支状态 → 关掉标签页后进程自动退出。

完整需求见 `@docs/spec.md`(rev.1)。**spec 是唯一事实来源:需求要变,先改 spec 再改代码**,不要在实现里就地"顺手扩展"。

---

## 1. 两个 git 作用域(先看这条,别搞混)

本文件里所有"只读""零写操作"的约束,**只约束产品代码**,不约束开发流程。

| | 受"零写操作"约束 | 说明 |
|---|---|---|
| **产品运行时的 git**:gitglance 的代码在**用户仓库**里执行的 git 命令 | ✅ 受约束 | 只允许只读白名单(`status` / `diff` / `rev-parse` / `ls-files` / `symbolic-ref` / `cat-file` 等)。这是产品的核心承诺,由第 10 节两层验证 + CI 门禁保证 |
| **开发流程的 git**:在 **gitglance 仓库自身**上做的版本控制动作 | ❌ 不受约束 | `git add` / `commit` / `branch` / `checkout` / `merge` / `rebase` / `stash` / `push` / 建 PR 全部正常允许 |

判据一句话:**约束的是"代码里写了什么 git 命令",不是"开发时执行了什么 git 命令"。**

用户会通过 AI agent 驱动本仓库的日常版本控制操作。**不得以"本项目承诺只读"为由拒绝、劝阻或加额外确认**——那是产品行为承诺,与开发协作无关。正常的 Claude Code 礼节照旧生效:除非用户要求,不主动 commit / push。

提交约定:

- **英文** + **Conventional Commits**:`<type>(<scope>): <description>`,type 取 `feat`/`fix`/`docs`/`refactor`/`perf`/`test`/`build`/`ci`/`chore`,破坏性加 `!`
- 祈使语气,subject ≤ 50 不加句号,body 折 72 只写 what 与 why
- 一个提交一件事,不混重构与功能改动

---

## 2. 常用命令

仓库尚无 `package.json`(S1 阶段建立)。下表为规划中的命令,**每新增一个 npm script,立即回来补全本节**——本节是后续会话查命令的第一落点,过期比缺失更糟。

| 用途 | 命令 | 状态 |
|---|---|---|
| 本地启动 | `node bin/gitglance.js`(在任意 git 仓库目录下) | S1 建立 |
| 单元/集成测试 | `npm test` | S1 建立 |
| 只读性验证(fake git wrapper 白名单断言) | 待定,见第 10 节 | S1–S2 建立,S5 前入 CI |
| 只读 `.git` 冒烟测试 | 待定,见第 10 节 | 同上 |
| 冷启动耗时测量 | 待定,≤300ms 门禁 | S1 建立 |

---

## 3. 技术栈硬约束

- **Node ≥ 24.14.0**(`engines.node: ">=24.14.0"`)。下限由 `fs.watch` 的 `ignore` 选项决定,不可下调 —— 详见 `@docs/spec.md` §5.1
- CI 矩阵:Node **24 / 26** × macOS / Windows / Linux 三平台
- **后端只用标准库**(`node:http`、`node:child_process`、`node:fs`),不引入 HTTP 框架
- **前端纯 HTML + 原生 JS + CSS**,不引入前端框架,不引入构建链路
- diff 渲染固定用 `diff2html-ui-slim.min.js` + `diff2html.min.css` + highlight.js 主题 CSS,**随包本地分发,不走 CDN**(工具必须离线可用)
- **hljs 主题 CSS 必须排在 `diff2html.min.css` 之前引入**,否则被覆盖、语法高亮不出颜色
- UI 配色用 CSS 变量,命名与取值参照 VS Code 颜色 token(如 `editor.background`)

---

## 4. 产品代码调用 git 的强制规则

这一节的每条都对应过一次实测踩坑(证据在 `@docs/spec.md` §10),不要凭直觉简化。

- **diff 基准是 `git diff HEAD`**,不是 `git diff` —— agent 可能自行 `git add`,后者会漏掉已暂存改动
- **空仓库**下 `git diff HEAD` 会 fatal。降级为**空树对象哈希**做基准,按 `git rev-parse --show-object-format` 区分 SHA-1 / SHA-256 两个硬编码常量
- **文件列表唯一数据源**:`git status --porcelain=v2 --branch -uall -z`。`-uall` 与 `-z` 都不能省
- 所有取路径的**列表类**调用(`status`、`ls-files`、`diff --numstat` …)一律加 `-z`,解析按 NUL 切分,不按换行
- **所有 `git diff` 调用统一注入 `-c core.quotePath=false`**。在 git 封装层统一注入,不要逐处手写。`-z` 管不到补丁正文的头部行,两者互补
- **`porcelain=v2 -z` 的两个解析陷阱**:
  - `2 ` 开头的重命名记录占**两个 NUL 段**(`... R<score> <新路径>\0<旧路径>`),解析器必须有状态地额外吞掉下一段作旧路径
  - 无上游分支时**不输出 `# branch.ab` 行**,展示为"无上游",不得默认 0/0,不得因取不到字段崩溃
- **重命名条目取 diff 必须传新旧两个路径**:`git diff HEAD -M -- <新路径> <旧路径>`。两个路径都已在 `2 ` 记录里给出,无需额外查询
- **diff 按文件懒加载**。列表只做一次 status 调用,点击文件才取该文件 diff
- **未跟踪文件**手工构造 unified diff(`--- /dev/null` / `+++ b/<path>`,全行标为新增),自行做 NUL 字节探测 + 5MB 阈值 + 行数上限
- **二进制/大文件判定来源**:已跟踪文件以 `git diff HEAD --numstat` 为准(二进制输出 `-\t-\t<path>`),体积用 `fs.stat`;**只有未跟踪文件**才走 NUL 字节探测
- **仓库定位**用 `git rev-parse --show-toplevel` / `--git-dir`。**不得假设 `.git` 是目录**(linked worktree / submodule 下是文件);bare 仓库给明确拒绝提示而非崩溃
- **启动前置检查**三项 —— git 不在 PATH、当前目录非 git 仓库、git < 2.11 —— 均给一句话友好报错,不抛 Node 异常栈
- detached HEAD、rebase/merge 进行中:不崩溃,分支状态降级展示并标注当前状态

---

## 5. 自动刷新与进程生命周期

- 工作区监听:一次 `fs.watch(repoRoot, { recursive: true, ignore: IGNORE }, cb)`,**三端统一,不做平台分流**
- **`IGNORE` 必须是不含斜杠的 basename 模式**,如 `['node_modules', '.git', 'dist', 'target', '.next', 'build']`。Node 对字符串模式启用了 minimatch 的 `matchBase`,含斜杠会使其失效
- `.git` 已被整体排除,因此需对 `HEAD`、`index`、`refs/`、`MERGE_HEAD` / `rebase-*` 所在**目录**单独建**非递归** watch。**绝不递归 `.git/objects`**
- **绝不对单个文件建 watch** —— watch 绑 inode,原子 rename 保存后原 watch 静默失效。必须 watch 目录
- 回调的 `filename` **可能为 null**,必须有 fallback
- 事件必须 **debounce 100–200ms**。Linux 用户态递归实现在初次遍历时会产生启动事件风暴,这是必需项不是优化项
- **兜底不可省略**:任一路径失败(ENOSPC / ENOSYS / 网络盘 / Docker 卷)降级为 **1.5s 轮询 `git status --porcelain=v2 -z`**,并在 UI 标注降级模式
- 变更通过 **SSE** 推送前端刷新;服务端心跳约 **15s**;前端监听 `visibilitychange`,标签激活时主动重连
- **空闲 45 秒无任何已连接客户端则退出**,按客户端计数判断;保留 Ctrl+C 手动退出
- **单实例注册表**写在 `os.tmpdir()`,文件名用仓库绝对路径 hash;以 `mode: 0o600` 配合 `O_EXCL` 创建(不是先建后 chmod);陈旧实例判定用 **HTTP 探活**(校验返回的 repo 路径一致)

---

## 6. 本地安全

- 绑定 `127.0.0.1` + 随机端口 + 会话级 token(进程生命周期内持续有效)
- **校验 `Host` 头**必须是 `127.0.0.1:<port>` 或 `localhost:<port>`,其余 403 —— 这才是 DNS rebinding 的正面防御
- **校验 `Origin`**:非空且不等于自身则 403;响应不带任何 CORS 头
- token 落地:URL 携带 → 首次访问置换为 `HttpOnly; SameSite=Strict` cookie 并 302 掉 query
- cookie 作用域是 host 不隔离端口,因此**服务端校验 token 时须一并绑定校验本次会话的端口**
- 所有端点(**含 SSE**)统一校验,无例外;响应带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`

---

## 7. 明确不做(Non-goals)

分两类:**长期不做**是产品的架构性承诺,破例等于变成另一个产品;**首版不做**是本版范围收窄,后续是否加入以实际使用中暴露的真实痛点为依据,不提前预设。**两类在开发期同为硬约束 —— "首版不做"不等于"可以先做"。**

### 7.1 长期不做

- **任何仓库写操作** —— 不 stage/unstage、不 commit、不 discard、不 pull/push/sync、不创建/切换分支、不 stash。工具全程只读,不需要用户对"工具会不会动我的仓库"有任何顾虑。这是产品的核心承诺
  - ← 作用域见第 1 节:这条约束**产品代码**,不约束本仓库的开发期 git 操作
- **代码编辑功能** —— 不是编辑器,diff 仅用于查看;放开这条会推翻第 3 节的 diff 渲染选型
- **账号体系、云同步** —— 工具是纯本地形态,引入后第 6 节的本地安全设计失去意义
- **多用户协作交互**(PR 评审、评论、审批)

### 7.2 首版不做

- 提交历史查看
- 分支列表展示,只展示当前分支(切换属 7.1 写操作范畴)
- 逐行 blame、行内标注等 GitLens 类深度追溯功能

---

## 8. 禁止清单

以下每条都是曾被考虑、经核查后排除的做法。除最后一条(来自 spec §5.2)外,**唯一来源是 `@docs/spec.md` §10「被排除的做法」表 —— 要增删禁止项,先改 spec,再同步本节**,不要只改一处。

- **禁止用 `diff2html-ui.min.js` 全量包** —— 1.05 MB,超出体积预算,且内含大量用不到的语言定义。用 slim 包
- **禁止未跟踪文件用 `git diff --no-index`** —— 依赖 `/dev/null` 作对比端,Windows 上不可移植。手工构造 unified diff
- **禁止用 `git hash-object -t tree /dev/null` 取空树哈希** —— 同样依赖 `/dev/null`,不可移植。硬编码常量
- **禁止用 `git mktree`** —— 会写对象库,违反只读承诺
- **禁止在 Linux 上使用不带 `ignore` 的 `fs.watch({recursive:true})`** —— Node 在 Linux 是用户态实现,逐条目(含普通文件)注册 inotify 且不做排除,会耗尽 `max_user_watches` 并波及用户机器上的其他工具
- **禁止按平台分流监听、在 Linux 自行遍历目录逐个注册** —— Node 24.14.0 的 `ignore` 在 Linux 即为注册前跳过,官方能力已覆盖;自行实现等于维护一份更易出错的等价物
- **禁止把 `ignore` 模式写成 `node_modules/**` 等含斜杠形式** —— 含斜杠会使 minimatch 的 `matchBase` 失效:既匹配不到 `node_modules` 目录自身,也匹配不到 monorepo 中嵌套的 `packages/*/node_modules`,过滤形同虚设
- **禁止只靠 `-z` 解决路径转义** —— `-z` 管不到 `git diff` 补丁正文的头部行,非 ASCII 路径仍会显示为 `\351\234\200` 转义串,须叠加 `-c core.quotePath=false`
- **禁止对重命名文件按单路径取 diff** —— git 只看到一侧无法配对,重命名会退化成全新增文件,"重命名识别并标注"落空
- **禁止把单实例注册表写进 `.git/` 或工作区** —— 污染 `git status`,实质违背零写操作承诺。写 `os.tmpdir()`
- **禁止用 pid 存活判断陈旧实例** —— pid 会被系统复用,误判会把用户带到指向别人进程的页面。用 HTTP 探活
- **禁止仅用 token 防 DNS rebinding** —— token 挡不住同源判定本身,正面防御是校验 `Host` 头
- **禁止用"前后 `git status` 比对"验证只读性** —— 发现不了写进 `.git/` 但不改变 status 输出的操作(gc、写 index、创建对象)。用第 10 节的两层验证
- **禁止一次性获取或渲染全仓 diff** —— agent 单次改 300+ 文件是常态,整仓 diff 会冻结浏览器主线程数秒到数十秒并拖垮冷启动指标。按文件懒加载

---

## 9. 只读性验证与 CI 门禁

零写操作必须能**自动化证伪**,不靠人工审查代码。两层验证均须纳入 CI 门禁:

1. **主门禁**:测试期间用 fake git wrapper 劫持所有 git 调用并记录完整子命令,断言只出现只读白名单(`status` / `diff` / `rev-parse` / `ls-files` / `symbolic-ref` 等)
2. **冒烟测试**:`chmod -R a-w .git` 后跑一遍完整流程,任何写尝试都会直接失败暴露

另有性能门禁:**冷启动 CLI 侧 ≤ 300ms**,自动化测量。"ready" 口径明确为「监听成功并打印 URL」,首次 `git status` 交由第一个 HTTP 请求惰性执行、**不计入**。

---

## 10. 开发流程

| 阶段 | 内容 |
|---|---|
| S1 | CLI 脚手架 + Node HTTP server + git shell 封装(status/diff)跑通 |
| S2 | 前端变更列表 + diff2html 渲染 + 按文件懒加载联动 + 基础样式 |
| S3 | 分支状态展示 + 自动刷新(监听 + 轮询兜底 + SSE)+ 进程生命周期(单实例复用 + 空闲退出)。**三件事互相独立,拆开逐个收口再集成,不要并行推进** |
| S4 | Diff 边界情况(未跟踪/新增/删除/重命名/二进制/超大文件)+ git 异常状态(空仓库、detached HEAD、worktree 等)。**依赖测试数据先就位** |
| S5 | Windows/Linux 兼容性验证 + 本地安全加固。**必须真机触发验证,CI 跑通不等于可用** |
| S6 | 开源准备(README、LICENSE、Issue/PR 规范、semver + Releases) |

规则:

- **每个阶段完成后立即对照 `@docs/spec.md` §6 验收标准自查,不堆到后期集中验证**
- S4 前先备齐测试数据仓库:未跟踪新文件、已暂存改动、新增/删除/重命名(含相似度阈值边界)、二进制、>5MB 大文件、空仓库、detached HEAD、rebase 进行中、linked worktree、300+ 文件变更的仓库
- 版本从 **0.1.0** 起。§6 验收标准**全部**通过 + 三端真机验证完毕后才发 1.0.0,不为"看起来正式"直接从 1.0.0 起步
- License MIT
