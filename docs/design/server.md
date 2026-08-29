# 运行时、进程生命周期、本地安全与接口契约

> 描述**产品运行时**的约束（用户机器上实际执行的东西）。工具链见 [`build.md`](build.md)，被排除的做法见 `../decisions.md` 的[「Node 运行时与进程」](../decisions.md#node-运行时与进程)与[「只读性验证与本地安全」](../decisions.md#只读性验证与本地安全)两节。

## 运行时与后端

- **Node.js，最低支持 Node 22.0.0。** 选型首要考量是生态成熟度与 Windows 上系统调用（`child_process` 执行 git、`fs.watch` 文件监听）的稳定性——本项目重度依赖这两块。下限取 22 而非更高的 24.14.0，是因为 **`fs.watch` 的 `ignore` 选项决定的是自动刷新的最优档位，不是能否运行的门槛**（见 [`watch.md`](watch.md)）：低于该版本按三档策略降级，行为退化但功能完整。反过来把下限钉在 24.14.0 的代价是实打实的——它比 Node 24 转入 LTS 晚了近四个月，锁版本管理器、既有 `node:24` 镜像、发行版快照上大量「自认在 Node 24 LTS」的用户会被 24.0–24.13 挡在门外。Node 20 已 EOL，不予支持。
- **API 上限随下限收紧**：除 `fs.watch` 的 `ignore` 外，不得使用 Node 22 上不存在或不稳定的 API——已知需避开 `fs.glob`（22.0 起为实验性）、不得依赖 `require(esm)`（22.12+ 才有）；`util.parseArgs`、`import.meta.dirname`、`node:test` 在 22 上均可用。**该机制由 TypeScript 配置直接承担**（`@types/node` 锁 `^22` + `lib`/`target` 取 `ES2023`），用到 Node 24+ 才有的内置 API 时编译期就报错，不必等 CI 的 Node 22 档跑到。
- **后端实现只用 Node 标准库**（`node:http`、`node:child_process`、`node:fs`），不引入 HTTP 框架——路由需求仅几个只读接口。TypeScript 与打包器都是开发期依赖，不进 `dependencies`。
- **后端产物形态**：`src/server/**.ts` 打包为**单文件 ESM** `dist/server/main.js`，**不压缩、不混淆**。压缩对本地 CLI 场景零收益，而保持可读能让用户自行核查「这工具到底跑了哪些 git 命令」，与只读承诺的可审计性一致；单文件则减少模块解析次数。

## 版本守卫与 `bin/difftab.js`

- CLI 入口须用**保守语法**先完成 `process.versions.node` 检查并友好报错，再动态 `import()` 主模块。**若守卫与新语法同处一个模块，低于下限的用户拿到的是解析期 SyntaxError，守卫根本来不及执行。**
- **落地要求**：`bin/difftab.js` 必须是手写的保守语法 JS，**不参与 TypeScript 编译、不作为打包入口**——一旦它进了构建管线，就可能被注入新语法或被合并进主模块，守卫在解析期即失效。
- **且必须以 `100755` 入库**：在本仓库目录里跑 `npx difftab` 会让 npm chmod 工作区里的这个文件，冒出一个**内容零差异**的变更；discard 掉，下一次执行就是 `Permission denied`。由 `check:bin` 断言仓库自己记的 mode，**HEAD 与 index 两侧都查**——`--chmod=+x` 只写暂存区，fresh clone 拿的是 HEAD，而 CI 上 index 恒等于 HEAD，只查 index 的版本会恰好在它唯一要保护的地方（开发者本机）最弱。

## 拉起浏览器

零运行时依赖的前提下没有现成库可用，只能 `child_process` 按平台调系统命令——macOS `open`、Windows `cmd /c start ""`（空串是必需的窗口标题占位，否则带引号的 URL 会被当作标题吞掉）、Linux `xdg-open`。

这是产品代码中**唯一一处非 git 的子进程调用**，只读性门禁需为它显式开一个口子（见 [`build.md`](build.md)）。调用失败（无 `xdg-open`、headless 环境）只打印 URL 让用户自行访问，**不作为启动失败**。

## 进程生命周期

- 以「无任何已连接客户端持续 **45 秒**」作为退出条件。页面刷新、系统休眠唤醒、浏览器丢弃后台标签都会造成短暂断连，需要宽限期避免误退出；多标签同时连接时以客户端计数为准。
- **实现要点**：服务端 SSE 心跳约 15s；前端监听 `visibilitychange`，标签重新激活时先按「静默是否超过两拍心跳」判一次死连接，已经不新鲜就掐掉重连。**判死只在这一处做，不另设定时器**——用户回来看的那一刻正是最值得重试的时刻；代价是一个**始终可见**的标签页在连接静默后不会自愈，而回环上能造出「连接活着却没人应答」的只有服务进程被冻住这一种形态。
- **宽限期从启动那一刻就开始计，不等第一个客户端到达**：否则「浏览器没拉起来」（headless、无 `xdg-open`、`--no-open` 后用户改主意）这一整类情形留下的是一个永久常驻的后台进程。45 秒足够覆盖冷启动浏览器进程的 2–5s。
- **判据是 SSE 连接数，但任何请求都重置计时。** 连接数是正面判据（`GET /api/events` 的连接集合大小，不另设保活端点）；而「刚被探活复用、浏览器还在启动」与「页面活着但 SSE 被中间层悄悄回收了」这两种情形下连接数都是 0，只有请求活动能证明另一头还有人。两者取并集，退出条件因此严格弱于「连接数为 0 持续 45s」。
- **重新武装接在 SSE 通道的 `onChange` 上而非端点**——端点各记一次时，漏掉断连那侧不报错，只是关完标签也不退。
- **宽限期须能由内部环境变量 `DIFFTAB_IDLE_MS` 覆盖，取值不合法即启动失败，不得退回默认的 45 秒**。没有它，生命周期的每一次自动化验证都要真等 45 秒，而那种用例没人会跑第二次。它**不放宽任何一道安全校验**，因此不属于下面禁止的「dev 分支」；同样不是给用户的开关，不进 `--help` 与 README。
- **退出前的那句提示走 `writeSync(2, …)`，而且要容许它失败**（读端已走时它抛 EPIPE）。`process.stdout.write` / `process.stderr.write` 写到管道时在 Windows 上是异步的，紧跟着 `process.exit()` 会把整条消息丢掉，症状是 stderr 全空——而这句提示正是自动化验证「它是自己走的，不是被 kill 的」的判据。**读端可能先走**（`| head -1`）：入口再给 stdout / stderr 各挂一个只咽 EPIPE 的 `'error'` 监听器，漏了这条连普通的 `process.stdout.write` 都能带裸栈打死进程。
- **已知边界**：HTTP/1.1 下浏览器对同源有 6 条并发连接上限，一条常驻 SSE 会占用其中一条，因此超过 6 个标签页时新标签会挂起。对实际使用场景（1–2 个标签）无影响，不为此调整架构。

## 同仓库单实例

- 实例注册表文件写在 `os.tmpdir()`，文件名用仓库绝对路径的 hash。**绝不能写进 `.git/` 或工作区**——否则既污染 `git status`，也实质违背零写操作承诺。
- **文件权限**：该文件存有端口与会话 token，而 `os.tmpdir()` 的权限因平台而异（**Linux 上是 `/tmp`，同机其他用户可读**）。必须以 `mode: 0o600` 配合 `O_EXCL` 创建，而非先建后 chmod（避免竞态窗口），或统一落在 tmpdir 下的每用户私有子目录中。
- **注册表的键必须归一化后再 hash**：写入侧是 `git rev-parse --show-toplevel`、读取侧是 `process.cwd()`，同一目录的字面量未必相同（Windows 的 `/` vs `\`、macOS 的 `/var` 符号链接）。
- 清理时**解析失败不等于是自己的**——会删掉另一个活着实例的条目。
- **陈旧实例的判定用 HTTP 探活而非 pid 存活判断**——pid 会被系统复用，误判会把用户带到一个指向别人进程的页面。
- **探活的落地形态**：向记录的端口发 `GET /api/instance`，带上记录里的 token 与合规的 `Host`——三道校验一视同仁，探活不是例外。命中的判据是**两条同时成立**：响应 200（token 不匹配即 403，说明这个端口已经归了别的进程，哪怕它也是 difftab），且返回的仓库路径与本次 `rev-parse --show-toplevel` **归一化后**相等。命中即打印同一个 URL、拉起浏览器、以 0 退出，**全程不碰注册表**——那条目是别人的进程写的，连「顺手更新一下」都不行。未命中一律按陈旧处理，照常启动并覆盖该条目。**正文另设一个 64 KB 上限**：端口可能已经归了一个完全无关的服务，而它的应答可以是任何东西，包括一条无穷的流。
- **探活超时取 1.5s，不取更短**：被探的实例可能正卡在 Linux 上那趟用户态递归遍历里（大仓库要几百毫秒到数秒），超时过短的代价不是慢一点，而是**给同一个仓库起了第二个进程**。反过来超时过长的代价只是启动慢：注册表不存在时根本不探活，存在而端口已死时 `ECONNREFUSED` 在 localhost 上是立即返回的。
- **拿到响应头之后的 `req.destroy()` 也要自己 `resolve`**——那之后错误只落在 `res` 上而 `IncomingMessage` 会把它吞掉，超时形同虚设、启动整个吊死。

## 本地安全

服务绑定 `127.0.0.1`，启动时生成随机端口 + 会话级 token。token 在进程生命周期内持续有效，以支持页面刷新与多标签场景。

**token 本身不是 DNS rebinding 的防御手段。** rebinding 的攻击路径是恶意页面把自己的域名重绑到 `127.0.0.1`，使浏览器认为攻击者页面与本服务同源；token 能挡住攻击者读取受保护端点，但只要存在任何一个不校验 token 的端点，仍会泄漏信息。因此必须同时具备：

1. **校验 `Host` 请求头**必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，其余一律 403——**这才是 rebinding 的正面防御**。
2. **校验 `Origin`**：非空且不等于自身则 403；所有响应不带任何 CORS 头。
3. **token 落地方式**：URL 携带 token → 首次访问后置换为 `HttpOnly; SameSite=Strict` cookie 并 302 掉 query，避免 token 长期滞留在浏览器历史、地址栏和日志中。SSE 端点同样校验。**需知 cookie 的作用域是 host 而非 origin，不隔离端口**：同机另一个监听 `127.0.0.1:<其他端口>` 的服务同样会收到这个 cookie。这不影响第 1 条（攻击者页面的 host 是自己的域名，cookie 根本不会发出），但意味着 token 会暴露给本机其他 localhost 服务，因此服务端校验 token 时需**一并绑定校验本次会话的端口**。
4. 所有端点（含 SSE）统一校验，无例外；响应带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。**这三道也必须排在其余一切判定之前**——包括「只接受 GET / HEAD」这类看着无害、且天然想往函数开头放的廉价同步判定。排在前面时，一个 POST 会在 Host 那道开口之前就拿到 `method-not-allowed`，而 rebinding 的攻击页面此刻与本服务同源、读得到这句话：数据仍拿不到（还有 token），漏的是**服务本身的存在性**，而第 1 条正是为挡住这类页面而设。
5. **严格 CSP**：`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`。后三个指令**不回退到 `default-src`**，不显式写就等于没设。这条是构建链路顺带解锁的——产物是独立的 `.js` / `.css` 文件、页面无内联脚本，才有条件不开 `'unsafe-inline'`。
6. **静态资源按内存清单白名单式映射**，不得用 `path.join(root, req.url)` 之类的路径拼接读文件，避免路径穿越。构建产物文件名因此固定、不加 hash——服务端本就对所有响应发 `Cache-Control: no-store`。

**开发期不得以放宽本节校验为代价换取便利。** Vite dev server 与后端不同源，会同时撞上 Host、Origin、token 三道门，解法一律放在 dev server 的代理层（改写 `Host` / `Origin`、注入 token cookie），**后端不得为此新增任何环境变量或分支**——那等于把正面防御做成一个可被误开的开关。

**已知边界：URL 里的 token 会经过命令行，而 argv 对同机其他用户可见。** 拉起浏览器的三条系统命令都只能从 argv 收 URL，没有别的传递面（`open` 不读 stdin）。**不装作它不存在——它与给注册表文件加 `0o600` 防的是同一件事**：那边挡住了同机其他用户读 token，这边又从命令行交了出去。接受它的依据是代价对比：窗口是几十毫秒量级、且要求攻击者已经在同一台机器上以另一个用户身份紧循环轮询；而**唯一能真正关掉它的改法是把 URL 里那份换成一次性交换码**（首访换成 cookie 后即作废），代价是探活复用要另想办法拿到 URL——那条路上重拼 URL 的是**另一个进程**，它手上只有注册表里那份长期有效的 token。首版按本条接受，不做交换码。

## 后端接口契约

类型定义放 `src/server/shared/`，前后端共享同一份——**除了 `InstanceInfo`**：`shared/` 是「前端唯一允许 import 的后端目录」，而这一项的唯一消费者是下一个 CLI 进程，放进去等于把它从「前端的契约面」变成「任何线上类型」，于是「前端到底依赖什么」不再有按目录回答的办法。它与端点同住 `http/`，由 `cli/probe.ts` 以 `import type` 取用。

**端点清单——全部为 `GET`。** 只读工具不需要任何非幂等端点，这条本身就是一道约束：出现 `POST` / `PUT` / `DELETE` 即意味着有人在往只读承诺外扩功能。

| 端点 | 返回 | 说明 |
|---|---|---|
| `GET /` | `dist/web` 静态资源 | 固定文件名不加 hash |
| `GET /api/state` | `{ repoName, branch, files, watch }` | 对应**单次** status 调用 |
| `GET /api/diff?path=&oldPath=` | `DiffPayload` | 按文件懒加载；`oldPath` 仅重命名条目传 |
| `GET /api/events` | SSE | 事件 `change` / `heartbeat`；空闲退出以本端点的连接数判定 |
| `GET /api/instance` | `{ repoRoot, pid }` | 探活复用**唯一**的消费者（不是给前端的） |

**协议类型**（各字段背后的 git 判据在 [`git.md`](git.md)）：

- `FileEntry { path; oldPath?; kind: 'tracked' | 'untracked'; staged; unstaged; renameScore?; conflicted? }`——`staged` / `unstaged` 承载 `porcelain=v2` 的双状态位，`oldPath` + `renameScore` 来自 `2 ` 记录。
  - **`conflicted` 是「这条来自 `u` 记录」这一事实本身**，不是从状态位推出来的：`DD` / `AA` 两位都不是 `U`，而「未合并」恰恰是那三个分组谓词唯一无法从 XY 读出来的东西。归属留给前端等于让它自己重写一遍 porcelain 的记录类型。
- `BranchState { head; detached; upstream: null | { ahead; behind }; operation? }`——**`upstream: null` 即「无上游」**，把它编码进类型而非留作约定，前端就不可能漏掉这条分支。`operation` 缺省即「没有进行中的多步操作」。
- `DiffPayload` 为判别联合：`{ kind: 'text', patch }` / `{ kind: 'binary' }` / `{ kind: 'too-large', size, reason: 'size' | 'lines' }` / `{ kind: 'untracked-text', patch }`。
  - **`too-large` 必须带 `reason`**：它有**两个**触发口（体积超 5MB 与行数超 50,000）。只带 `size` 时，行数那一路的文件可能只有几百 KB，前端手里唯一的数字既解释不了为什么不预览、按 MB 取整还会显示「文件过大（0 MB）」这种自相矛盾的话。判别原因属后端知识。
  - **`size` 只用于展示，不是判定依据**，且**可以是 0**——已被删除的文件在工作区没有体积可取。前端据此不显示体积，而不是把 0 四舍五入成「1 KB」：编一个数出来比不说更糟。
- `InstanceInfo { repoRoot; pid }`——**唯一一个正文里带绝对路径的响应**，与「错误消息不含绝对路径」不冲突：那条防的是把本机目录结构混进面向页面的输出，而这里路径**就是**被问的那件事。能读到它的前提是手里已有本会话 token，而拿着 token 本就能读遍整个仓库的 diff。前端不消费它。
- `repoName: string`——工作区根目录的 **basename**，用作页面标题里的项目标识。**给的是目录名而不是路径**：basename 是回答「这个标签属于哪个项目」所需的最小的那一份。**不复用 `InstanceInfo.repoRoot`**：让页面去读它等于把上面那条边界作废。**空串的含义是「这个根目录没有 basename」**（`/`、Windows 的盘符根）——后端不为此编一个名字出来，「取不到时显示什么」是展示决定，归前端。
- `WatchState { mode: 'native' | 'polling'; tier: 'A' | 'B' | 'C' }`——降级既可能是 C 档的既定形态、也可能是 A/B 档运行中落到轮询兜底，**前端无从自己推断，必须由后端告知**。

**错误约定**：`{ error: { code, message } }`，`message` **不含绝对路径**。

**明确不做**：协议版本协商。前端随进程自带分发，不存在版本错配的可能，加版本字段只是空转。
