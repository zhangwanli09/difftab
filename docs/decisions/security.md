# 只读性验证与本地安全

> 收录规则与实测环境见 [`README.md`](README.md)。

- **只读主门禁用 `GIT_TRACE` 记录，不用 PATH 上的 fake git wrapper**：后者在 Windows 上落不了地——(a) Node 自 20.12 起不带 `shell` 时 spawn `.cmd` / `.bat` 直接抛 `EINVAL`（CVE-2024-27980 的修复），而 PATH 劫持在 Windows 上只有 `.cmd` / `.exe` 两种可用形态；(b) 退而把 node 二进制装成 `git` + `NODE_OPTIONS=--require <shim>` 时，node 自己的 CLI 解析先跑，`-c` 被当成 node 的 `--check` 吃掉、其后第一个参数还被 `path.resolve` 改写，记到的「完整子命令」因此是错的。
- **`GIT_TRACE` 的记录形态决定了白名单怎么写**：每次调用留下一行 `trace: built-in: git status …`——`-c core.quotePath=false` 已被 git 前端消化、**不出现在这一行**（白名单断言不受影响，但 `core.quotePath` 的生效得靠别的断言证）；`git --version` 记作 `built-in: git version`，故白名单里那一项叫 `version`；外部子命令与 git 内部再起的进程分别记作 `exec:` / `run_command:`。
- **三道校验的渗透式复核**（对构建产物，逐条见冒烟用例）：15 种 Host 变体（伪装成后缀 / 前缀的攻击者域名、大写、尾点、错端口、`[::1]`、十进制 `2130706433`、`0.0.0.0` 等）一律 403，合规两个 200；缺 Host 头由 Node 的解析器直接 400；**双 Host 头 Node 只认第一条**，故无法靠追加一条绕过。`Origin: null` 与攻击者 Origin 403，响应无任何 `Access-Control-*`；`//evil.com/…` 形态的请求行只影响 `url.pathname`，不构成开放重定向。**这一组必须用裸 `node:http` / socket 写**：undici 按 fetch 规范把 `Host` 列为禁止头并静默改写，拿 `fetch` 打整栏都是假 200。
- **CSP 的 `frame-ancestors` 是唯一挡住嵌套的那一道**（真实 Chrome）：从**同机另一个端口**的页面 iframe 嵌套本服务——iframe 导航不带 `Origin`、Host 又是合规的 `127.0.0.1:<port>`，而 cookie 的 site 是 `127.0.0.1`（端口不分 site），于是 `SameSite=Strict` **不阻止**它发出，三道校验全过、网络层实测拿到 **200**；浏览器仍拒绝渲染（父页面 `contentDocument` 为 null），父页面的 `fetch('/api/state', {credentials:'include'})` 则被无 CORS 头挡掉。页面自身零内联脚本、console 无任何 CSP 违规。
- **token 经命令行只有一个窄窗口，且 argv 不因属主不同而被遮蔽**（macOS 26）：以真流程启动并让它真的 `open` 那个 URL，同时用**紧循环**反复 `ps -Ao args=` 采样——token 的 secret 部分在 **t=31ms** 那一拍出现在 `open` 自己的 argv 里，命中 1 拍，此后不再出现（已在运行的浏览器经 LaunchServices 收 URL，不进 argv）；另实测 `ps -Ao user=,args=` 读得到 **root 进程的完整参数**。**250ms 一拍的粗采样连打 24 次一无所获**——粗采样的「没抓到」不构成反证。Linux 那侧仍未实测。

## 被排除的做法

| 做法 | 排除原因 |
|---|---|
| 仅用 token 防 DNS rebinding | token 挡不住同源判定本身，正面防御是校验 `Host` 头 |
| 用「前后 `git status` 比对」验证只读性 | 发现不了写进 `.git/` 但不改变 status 输出的操作（`GIT_OPTIONAL_LOCKS=0` 挡的正是这类） |
