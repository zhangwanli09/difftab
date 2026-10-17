# 运行时、进程生命周期、本地安全与接口契约

> 描述**产品运行时**的约束（用户机器上实际执行的东西）。工具链见 [`build.md`](build.md)，被排除的做法见 [`../decisions/runtime.md`](../decisions/runtime.md) 与 [`security.md`](../decisions/security.md)。

## 运行时与后端

- **Node.js，最低支持 Node 22.0.0。** 首要考量是 Windows 上 `child_process` 与 `fs.watch` 的稳定性。下限不取 24.14.0：**`fs.watch` 的 `ignore` 决定的是自动刷新的最优档位，不是能否运行的门槛**（见 [`watch.md`](watch.md)），而钉在 24.14.0 会把大量「自认在 Node 24 LTS」的 24.0–24.13 用户挡在门外。Node 20 已 EOL。
- **API 上限随下限收紧**：除 `fs.watch` 的 `ignore` 外，不得使用 Node 22 上不存在或不稳定的 API（已知要避开 `fs.glob`、`require(esm)`）。**由 TypeScript 配置承担**（`@types/node` 锁 `^22` + `ES2023`），编译期就报错。
- **后端只用 Node 标准库**，不引入 HTTP 框架。TypeScript 与打包器都是开发期依赖。
- **后端产物是单文件 ESM `dist/server/main.js`，不压缩、不混淆**：让用户能自行核查「这工具跑了哪些 git 命令」，与只读承诺的可审计性一致。

## 版本守卫与 `bin/difftab.js`

- CLI 入口须用**保守语法**先检查 `process.versions.node` 并友好报错，再动态 `import()` 主模块。**守卫与新语法同处一个模块时，低版本用户拿到的是解析期 SyntaxError，守卫来不及执行。**
- 因此 `bin/difftab.js` 手写、**不参与 TypeScript 编译、不作打包入口**——进了构建管线就可能被注入新语法或被合并进主模块。
- **且必须以 `100755` 入库**：在本仓库目录跑 `npx difftab` 会让 npm chmod 这个文件，冒出一个内容零差异的变更，discard 掉之后下一次执行就是 `Permission denied`。`check:bin` **HEAD 与 index 两侧都查**——`--chmod=+x` 只写暂存区，而 CI 上 index 恒等于 HEAD，只查 index 会在开发者本机最弱。

## 拉起浏览器

零运行时依赖下只能按平台调系统命令：macOS `open`、Windows `cmd /c start ""`（空串是窗口标题占位，否则带引号的 URL 会被当成标题吞掉）、Linux `xdg-open`。

这是产品代码中**唯一一处非 git 的子进程调用**，只读性门禁为它显式开口子（见 [`build.md`](build.md)）。调用失败只打印 URL，**不作为启动失败**。

## 进程生命周期

- **无任何已连接客户端持续 45 秒即退出**。页面刷新、休眠唤醒、浏览器丢弃后台标签都会造成短暂断连，需要宽限期；多标签以客户端计数为准。
- **SSE 心跳约 15s**；前端在 `visibilitychange` 重新激活时按「静默是否超过两拍心跳」判一次死连接，不新鲜就重连。**判死只在这一处做，不另设定时器**——代价是一个始终可见的标签页在连接静默后不会自愈，而回环上造得出这种形态的只有服务进程被冻住。
- **空闲计时从启动那一刻就起，不等第一个客户端**：否则「浏览器没拉起来」这一整类情形留下一个永久常驻的进程。
- **判据是 SSE 连接数，但任何请求都重置计时**：「刚被探活复用、浏览器还在启动」与「SSE 被中间层悄悄回收」时连接数都是 0，只有请求活动能证明另一头还有人。
- **重新武装接在 SSE 通道的 `onChange` 上而非端点**——端点各记一次时漏掉断连那侧不报错，只是关完标签也不退。
- **宽限期可由内部环境变量 `DIFFTAB_IDLE_MS` 覆盖，取值不合法即启动失败，不退回 45 秒**：否则生命周期的每次自动化验证都要真等 45 秒。它不放宽任何安全校验，因此不属于禁止的「dev 分支」；不进 `--help` 与 README。
- **退出前的报错走 `writeSync(2, …)` 并裹 try/catch**：`process.stderr.write` 写管道在 Windows 上是异步的，紧跟 `process.exit()` 时整条消息丢掉——而这句提示正是自动化验证「它是自己走的」的判据。**读端可能先走**（`| head -1`）：入口给 stdout / stderr 各挂一个只咽 **EPIPE、ECONNRESET 与 ENOTCONN** 的 `'error'` 监听器。后两个是 macOS 上同一件事的另外两种拼法（stdio 管道是 unix socket），漏了任一个 `| head -1` 偶发以 1 退出。
- **已知边界**：HTTP/1.1 同源 6 条并发连接上限，一条常驻 SSE 占一条，超过 6 个标签页时新标签挂起。实际场景无影响。

## 同仓库单实例

- 注册表写在 `os.tmpdir()`，文件名是仓库绝对路径的 hash。**绝不能写进 `.git/` 或工作区**——既污染 `git status`，也违背零写操作承诺。
- 它存着端口与 token，而 Linux 的 `/tmp` 同机用户可读：**必须 `mode: 0o600` + `O_EXCL` 创建**，不先建后 chmod（竞态窗口）。
- **注册表的键必须归一化后再 hash**：写入侧是 `--show-toplevel`、读取侧是 `process.cwd()`，字面量未必相同（Windows 的 `/` vs `\`、macOS 的 `/var` 符号链接）。
- 清理时**解析失败不等于是自己的**——会删掉另一个活着实例的条目。
- **陈旧实例用 HTTP 探活而非 pid**——pid 会被复用。
- **探活**：向记录的端口发 `GET /api/instance`，带记录里的 token 与合规 `Host`（三道校验一视同仁）。**命中要两条同时成立**：200（403 说明端口已归别的进程，哪怕也是 difftab），且返回的仓库路径与本次 `--show-toplevel` **归一化后**相等。命中即打印同一个 URL、拉起浏览器、以 0 退出，**全程不碰注册表**。未命中按陈旧处理，照常启动并覆盖条目。**正文另设 64 KB 上限**：端口可能归了任何服务，应答可以是无穷的流。
- **探活超时 1.5s，不取更短**：被探实例可能正卡在 Linux 用户态递归遍历里，超时过短的代价是**给同一个仓库起第二个进程**；过长只让启动慢（端口已死时 `ECONNREFUSED` 是立即返回的）。
- **拿到响应头之后的 `req.destroy()` 也要自己 `resolve`**——那之后错误只落在 `res` 上而 `IncomingMessage` 会把它吞掉，启动整个吊死。

## 本地安全

服务绑定 `127.0.0.1`，启动时生成随机端口 + 会话级 token，token 在进程生命周期内持续有效。

**token 本身不是 DNS rebinding 的防御手段**：rebinding 让攻击者页面与本服务同源，只要有一个端点不校验 token 就会泄漏。因此必须同时具备：

1. **校验 `Host`** 是 `127.0.0.1:<port>` 或 `localhost:<port>`，其余 403——**这才是 rebinding 的正面防御**。
2. **校验 `Origin`**：非空且不等于自身则 403；不带任何 CORS 头。
3. **token 落地**：URL 携带 → 首访置换为 `HttpOnly; SameSite=Strict` cookie 并 302 掉 query。**cookie 的作用域是 host 不隔离端口**，同机其他 localhost 服务也会收到它，因此校验 token 时**一并绑定本次会话的端口**。
4. **所有端点（含 SSE）统一校验，且这三道排在其余一切判定之前**——包括「只接受 GET / HEAD」这类廉价判定。排在前面时 POST 会在 Host 那道之前拿到 `method-not-allowed`，rebinding 页面读得到它，漏的是**服务本身的存在性**。响应带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。
5. **严格 CSP**：`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`。后三个**不回退到 `default-src`**，不写就等于没设。
6. **`/api/blob` 只服务图片扩展名表里的路径（外加 svg），按表给精确 MIME**：`nosniff` 下类型错一个字浏览器就不画；不限扩展名时它就是一个「下载工作区任意文件」的端点，比带闸的 `/api/file` 还宽。**不开 `blob:`**。**svg 的响应把 CSP 换成 `default-src 'none'; style-src 'unsafe-inline'; sandbox`**：`<img>` 里的 SVG 本就不跑脚本、不取外链，可直接打开这条 URL 时它是一份同源文档——`sandbox` 把它放进不透明源，内联脚本与事件属性一律不跑。
7. **静态资源按内存清单白名单映射**，不得用 `path.join(root, req.url)` 拼接。文件名因此固定、不加 hash（响应本就 `no-store`）。

**后端零 dev 分支**：Vite dev server 撞上 Host、Origin、token 三道门时，解法一律放在 dev server 的代理层（改写 `Host` / `Origin`、注入 cookie），**后端不得为此新增任何环境变量或分支**——那等于把正面防御做成一个可被误开的开关。

**已知边界：URL 里的 token 会经过命令行 argv，同机其他用户可见。** 三条拉起浏览器的命令只能从 argv 收 URL。接受它的依据是窗口只有几十毫秒、且攻击者要已在本机以另一用户紧循环轮询；唯一真正关掉它的改法是一次性交换码，而探活复用那条路上重拼 URL 的是另一个进程、手上只有长期 token。

## 后端接口契约

类型定义放 `src/server/shared/`，前后端共享——**除了 `InstanceInfo`**：`shared/` 是前端唯一允许 import 的后端目录，而它的唯一消费者是下一个 CLI 进程，放进去会让「前端依赖什么」无法按目录回答。它与端点同住 `http/`，由 `cli/probe.ts` 以 `import type` 取用。

**端点全部为 `GET`。** 出现 `POST` / `PUT` / `DELETE` 即意味着有人在往只读承诺外扩功能。

| 端点 | 返回 | 说明 |
|---|---|---|
| `GET /` | `dist/web` 静态资源 | 固定文件名不加 hash |
| `GET /api/state` | `{ repoName, branch, files, watch }` | 对应**单次** status 调用 |
| `GET /api/diff?path=&oldPath=&ignoreWhitespace=1&fullContext=1` | `DiffPayload` | 按文件懒加载；`oldPath` 仅重命名条目传；后两个开关缺省即关，**只认 `1`、其余值 400** |
| `GET /api/tree?path=` | `TreePayload` | **按目录懒加载**，一次只回一层；`path` 缺省即仓库根 |
| `GET /api/file?path=` | `FilePayload` | 单个文件的只读内容 |
| `GET /api/blob?path=&side=old\|new&commit=` | 图片与 SVG 字节 | **只服务图片扩展名表里的路径与 svg**；`old` 读 diff 基准、`new` 读工作区；**带 `commit` 时两侧都读对象库**（第一父 / 该提交） |
| `GET /api/commits?head=&skip=` | `CommitPage` | 一页 50 条；`head` 缺省即从 HEAD 起并回传锚点 |
| `GET /api/commit?sha=` | `CommitDetail` | 一次提交的元数据 + 改了哪些文件 |
| `GET /api/commit-diff?sha=&path=&oldPath=&ignoreWhitespace=1&fullContext=1` | `DiffPayload` | 相对第一父，三道闸与两个开关都与 `/api/diff` 同一套 |
| `GET /api/refs` | `RefList` | 本地分支、远程分支、标签，无参数 |
| `GET /api/files` | `FileList` | Quick Open 用的全仓文件路径（已跟踪 + 未跟踪，不含被忽略的与 submodule），无参数 |
| `GET /api/search?q=&case=1&word=1` | `SearchPayload` | 全仓字面量搜索；`q` 必填、≤ 1,000 字符、不得含 `\n` / `\r` / `\0`，否则 400 |
| `GET /api/events` | SSE | 事件 `change` / `heartbeat`；空闲退出以本端点的连接数判定 |
| `GET /api/instance` | `{ repoRoot, pid }` | 探活复用**唯一**的消费者 |

**协议类型**（git 判据在 [`git.md`](git.md)）：

- `FileEntry { path; oldPath?; kind: 'tracked' | 'untracked'; staged; unstaged; conflicted? }`——**`conflicted` 是「这条来自 `u` 记录」这一事实本身**，不从状态位推：`DD` / `AA` 都不是 `U`，归属留给前端等于让它重写一遍 porcelain 的记录类型。
- `BranchState { head; detached; upstream: null | { name; ahead; behind }; oid?; operation? }`——`oid` 是 HEAD 指向的提交（缺省即未出生），前端拿它判提交列表要不要重取。**`upstream: null` 即「无上游」**，编码进类型前端就漏不掉；`name` 供 History 在 `/api/refs` 里找上游。`operation` 缺省即没有进行中的操作。
- `DiffPayload` 为判别联合：`text` / `binary` / `image { old, new }` / `too-large { size, reason: 'size' | 'lines' }` / `untracked-text`。
  - **`text` 带 `full: boolean`**：`true` 即补丁带着整份文件作上下文。它回答的是「这份补丁是什么」，不是「请求里问了什么」——`fullContext=1` 过不了闸时后端退回 3 行上下文并给 `false`（判据在 [`git.md`](git.md)），前端只认这个字段，不拿自己发出去的参数推。`untracked-text` 不带：它按构造就是整份文件。
  - **开关值只认 `1`、其余值 400**，与 `/api/search` 的 `case` / `word`（非 `1` 即关）刻意不同：唯一的调用方是前端，写成 `true` 的笔误在宽松解析下是一个静默不生效的开关。
  - **`too-large` 必须带 `reason`**：两个触发口，只带 `size` 时行数那一路可能只有几百 KB，前端会说出「文件过大（0 MB）」。
  - **`size` 只用于展示，可以是 0**（已删除的文件）：前端此时不显示体积，不编一个数出来。
  - **`image` 只带元数据，字节走 `/api/blob`**：`old` / `new` 各是 `ImageSide { path; size; version } | null`。`version` 是内容身份，前端只比对不解读；`path` 由后端填好（重命名旧侧是 `oldPath`），前端不自己拼。不内联 base64：大 33% 且没法按侧懒加载。
  - **`text` / `untracked-text` 可带 `preview { old; new }`**（两侧同 `ImageSide`），只在 `.svg` 上、两侧都不超 5MB 时出现；缺省即「没有可预览的」。前端只认这个字段，不判扩展名。
- `InstanceInfo { repoRoot; pid }`——**唯一正文里带绝对路径的响应**：路径就是被问的那件事，而拿着 token 本就能读遍整个仓库。前端不消费它。
- `repoName: string`——工作区根目录的 **basename**，回答「这个标签属于哪个项目」的最小一份；**不复用 `InstanceInfo.repoRoot`**。空串即根目录没有 basename，显示什么归前端。
- `TreeEntry { name; path; kind: 'directory' | 'file'; ignored }` 与 `TreePayload { path; entries }`——`path: ''` 即仓库根。**`ignored` 由后端给**：前端没有 `.gitignore` 的语义。一次只回一层。
- `FilePayload` 为判别联合：`text { content; preview? }` / `symlink { target }` / `binary` / `image { size, version }` / `too-large { size, reason }`。**`symlink` 单独成一支**：「这是一个指向 X 的链接」与「这是 X 的内容」是两句话。`preview { size; version }` 与 diff 那侧同一条口径，只在 `.svg` 上出现。
- `CommitSummary { sha; parents; author; time; subject }`、`CommitPage { head; commits; hasMore }`、`CommitDetail { …CommitSummary; files; shallow? }`、`CommitFileEntry { path; oldPath?; status: 'A' | 'M' | 'D' | 'R' | 'T' }`：
  - **`sha` 与 `head` 都是完整对象名**，前端原样回传，截断只是展示。
  - **`shallow`** 即浅克隆边界：`files` 为空不代表「没改东西」。**`head: null` 即空仓库**。
  - **`time` 是作者时间的 Unix 秒**，只带作者不带提交者——回答的是「谁写的、什么时候写的」。
  - **`CommitFileEntry` 不复用 `FileEntry`**：一次提交只有一个状态字母，硬塞进双状态位会让前端分组逻辑面对永远不该出现的组合。
  - **非法 `sha` 与不存在的提交都回 400**（`invalid-path` / `not-found`），与其余端点的 `WorktreeError` 同一张映射。partial clone 里内容不在本地是 `unsupported`。
- `FileList { paths }`——仓库相对路径，已去重、按路径排序。
- `SearchPayload { files; truncated }`、`SearchFile { path; matches }`、`SearchMatch { line; text; ranges }`：
  - **`ranges` 是 `[起, 止)` 的 UTF-16 下标，相对 `text`**——前端只切段着色，不自己再找一遍：大小写与全词的口径归后端一份。
  - **`text` 可能已被裁过**（长行两端带 `…`），`ranges` 已随之平移。`line` 从 1 起。
  - **`truncated` 即「后面还有，没给全」**（stdout 或行数上限任一触发），前端据此提示收窄查询。
- `WatchState { mode: 'native' | 'polling'; tier: 'A' | 'B' | 'C' }`——降级可能是 C 档的既定形态、也可能是运行中落到轮询兜底，**前端无从推断，必须由后端告知**。
  - **`onDegrade` 里要推一个 `change`，且 `watch` 字段每次请求现算**（`http/server.ts`）：`mode` 只在 `/api/state` 里，不推事件时前端要等到下一次真的有文件变更才重取；启动时算一次存起来的那份不报错，只是从此永远说「原生监听」。

**错误约定**：`{ error: { code, message } }`，`message` **不含绝对路径**。

**明确不做**：协议版本协商。前端随进程分发，不存在版本错配。
