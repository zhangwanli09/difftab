# server/http

`node:http` server、路由、§5.9 三道校验(Host / Origin / token)、`dist/web` 静态托管(spec §5.9 / §5.12)。

**边界**:本目录不直接触碰 git 与文件监听,只调用 `git/` 与 `watch/` 导出的函数,
以保证三道校验位于唯一入口、不被旁路绕开(spec §5.0 不变式 3)。
**后端零 dev 分支**:不得新增任何放宽 Host / Origin / token 校验的环境变量或分支。
