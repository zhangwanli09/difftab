# test/unit

Vitest,**直接跑 TS 源码**(spec §5.11 的 build 作业)。配置见根目录 `vitest.config.ts`。

按被测代码分成 `server/` 与 `web/` 两个子目录,分别由 `tsconfig.server.json` 与
`tsconfig.web.json` 收 —— 两份 tsconfig 的 `moduleResolution` 与 `lib` 不同,
同一个文件不能被两边同时收进来。新增测试放对目录,否则 `pnpm typecheck` 会漏掉它。

跑 `dist/` 产物的冒烟测试在 `test/smoke/`,是纯 JS + `node:test`,不经这里。
