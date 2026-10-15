# Node 运行时与进程

> 收录规则与实测环境见 [`README.md`](README.md)。

- **`os.tmpdir()` 的权限在两端不同，故注册表文件自己带 `0o600`**：macOS 上是每用户 0700 私有目录（实测 mode 700），Linux 上是 `/tmp`（1777，同机其他用户可读）。
- **SSE 端点不需要为超时做任何特殊设置**：把 `server.requestTimeout` 压到 1s、服务端保持一条 200ms 一发的 `text/event-stream`，3s 后连接仍然活着、数据持续到达——它掐不断已完成请求的长响应。
- **判死重连只放在 `visibilitychange` 一处、不另设定时器**：整机休眠在回环上不留半开 TCP（macOS 26 / Chrome 151：`pmset sleepnow` 睡 234 秒，唤醒后 SSE 连接完好并继续工作——浏览器与服务一起冻结、一起醒来，中间没有网络分区）。真正走得到重连的是**连接静默 + 标签切回**：`SIGSTOP` 冻住 40 秒后切走标签再切回，`/api/events` 由 1 次变 2 次且**发生在服务仍冻着时**（触发者是前端判定）；冻 45 秒**不切标签**则一次重连都没有。
- **拿到响应头之后的 `req.destroy()` 必须自己 `resolve`**：`http.request` 收到 200 之后再 `destroy()`，错误只落在 `IncomingMessage` 上（`'aborted'` 随后 `ECONNRESET`），而**无人监听的 `IncomingMessage` `'error'` 被内部吞掉**——于是「超时了就 destroy」在对端「发了响应头就装死」时既不 settle 也不报错，启动**整个吊死、一行输出都没有**。**「对端连响应头都不发」这一形态抓不到它**：那时错误确实落在 `req` 上，两者只差一次 `writeHead`。
- **退出前的提示走 `fs.writeSync(2, …)`，且必须容许这次写失败**：**管道写在 Windows 上是异步的**、POSIX 上是同步的，于是读端一走（`difftab --no-open | head -1`）EPIPE 以一个 `'error'` 事件到达，零监听器的流收到它就是整个进程带裸栈以 1 退出。**macOS 上这个码不总是 EPIPE**：Node 的 stdio 管道在那里是 unix socket，对端刚关闭时内核有个竞态回 EPROTOTYPE，libuv 的 `uv__try_write` 把它翻译成 ECONNRESET（源码里 `__APPLE__` 那段注释写明是 10.10–10.15 的内核 bug）。实测：2026-09-19 `main` 上一个纯文档提交的 CI 在 `smoke macos-latest · Node 26` 红了一次——`| head -1` 那条 98ms 就以 1 退出，重跑即绿；本机 Darwin 27 上 Node 24 / 26 各 300 次全是 EPIPE（其中 `'error'` 事件 298 次、`writeSync` 同步抛 2 次），复现不了。**同一个竞态还有第三种拼法 ENOTCONN**：2026-10-15 `main` 上又一个纯文档提交（#116）的 CI 在 `smoke macos-latest · Node 24` 红了，同一条用例，这次是紧跟 URL 那句提示的 `process.stdout.write` 以 `write ENOTCONN`（errno -57）失败，监听器不认识这个码就照抛。监听器因此咽 EPIPE、ECONNRESET、ENOTCONN 三个码，别的照抛——三者说的都是「对端已经不在了」，服务本身没坏。另一半是 `writeSync` 自己：读端已关闭时它**抛** EPIPE，在 45 秒空闲退出的定时器回调里抛出时退出闩已经合上、`server.close()` 不再执行，进程带着一屏 Node 栈以 **1** 退出，而这条路承诺的是干净的 **0**。
- **冒烟用例的被测子进程 ready 后 `unref()`、`stop()` 里再 `ref()` 回来**：未被显式 stop 的残留 server 其 stdio 管道让 runner 的事件循环永不清空，表现为**全部用例通过、命令却不返回**；`ref()` 那半也不能省，否则 kill 之后等 `'close'` 时循环可能已经空了。清理同理要带 `maxRetries`（rimraf 的重试是 `Atomics.wait`，同步、在退出钩子里可用）：Windows 上 `child.kill()` 返回时系统尚未回收该进程，而它的 cwd 正是 fixture 仓库，紧接着的 `rmSync` 报 `EBUSY`、**断言全过却仍以 1 退出**；重试用尽只警告不抛。
- **Node 22.0.0 的 `node --test` 不等顶层 `before()`，故冒烟用例不靠顶层钩子建共享状态**：顶层异步 `before()` 尚在执行时该文件的用例就已开跑，依赖其中所建 server 的用例全部在 1ms 内以读取 `undefined` 失败；`after()` 同样提早触发，清理撞上还在写的 fixture 报 `ENOTEMPTY`。Node 24 / 26 行为正确，故只有 CI 下限那一档红。

## 被排除的做法

| 做法 | 排除原因 |
|---|---|
| 空闲宽限期「等第一个客户端连上之后才开始计」 | 把「浏览器压根没拉起来」整类情形变成永久常驻的后台进程；从启动即开始计，再由「任何请求都重置计时」补住误退的一侧 |
