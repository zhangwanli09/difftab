# server/http

`node:http` server、路由、三道校验（Host / Origin / token）、`dist/web` 静态托管。

**边界**：本目录不直接触碰 git 与文件监听，只调用 `git/` 与 `watch/` 导出的函数，以保证三道校验位于唯一入口、不被旁路绕开（架构边界不变式 3）。
**后端零 dev 分支**：不得新增任何放宽 Host / Origin / token 校验的环境变量或分支。

`sse.ts` 是 `/api/events` 的通道：只依赖 `write` / `end` 两个方法，好让 15s 心跳能用假时钟单测，而不是靠一个跑 15 秒的用例。**SSE 与别的端点一样过三道校验，没有例外**。文件监听**懒起**在第一个订阅者到达时，起了就留到关服务——理由见 `server.ts` 里那段注释（冷启动门禁 + 刷新页面不该重来一遍）。

监听那一侧本目录只做两件事：把主查询（`readStatusRaw`）作为**轮询探针**注入——git 子进程只许出现在 `server/git`（架构边界不变式 1），`watch/` 因此不自己调 git；以及在 `onDegrade` 里把 `WatchState.mode` 翻成 `polling` 并**推一个 `change`**，让前端重取 `/api/state` 才看得见降级。`watch` 字段每次请求现算，不在启动时算一次存起来——降级发生在运行中，存起来的那份不会报错，只是从此永远说「原生监听」。
