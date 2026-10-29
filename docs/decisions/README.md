# 被排除的做法与关键决策依据

> [`../design/`](../design/) 写规则与它失效时的机制，**本目录只回答「为什么是当前这套、为什么不能换成别的」**：每条按「决策 → 理由 → 最小证据」写，机制不在这里复述第二遍。
>
> **一条记录留下来的唯一理由，是「将来有人会重新提出那个做法、或重新踩那个坑，而它不会报错」。** 三类不满足的写了也要删：事实源在别处且会过期的（版本号、发布日程），复述 `design/` / `gates.md` / `RELEASING.md` 已有规则的，以及不改变任何未来判断的一次性叙事（那类不入库，留在 git log 与 PR 里）。`design/` 里已经写明理由的被排除做法，不在这里再列一行。
>
> **实测环境**：未单条注明时为 git 2.50.1 / Node 24.14.1 / macOS 26，时间在 2026 年 8 月；注明 CI 的那几条跑在 GitHub runner 上。**重测时先核这一行**——结论会随这些版本失效，而失效不会有任何东西报错。

## 一域一份

每份末尾自带本域那张「被排除的做法」分表。新增内容先认域；横跨两个域的证据放进主要相关的那份，另一份链过去。

| 文件 | 域 |
|---|---|
| [`git.md`](git.md) | git 行为 |
| [`watch.md`](watch.md) | 文件监听 |
| [`runtime.md`](runtime.md) | Node 运行时与进程 |
| [`web.md`](web.md) | 前端渲染与体积 |
| [`editors.md`](editors.md) | 右侧面板：标签页、分屏与正文视图 |
| [`style.md`](style.md) | 样式层叠 |
| [`security.md`](security.md) | 只读性验证与本地安全 |
| [`toolchain.md`](toolchain.md) | 工具链与发布 |

## 外部参考

- [Node.js `fs.watch` 文档：recursive 支持范围与 Caveats](https://github.com/nodejs/node/blob/v24.x/doc/api/fs.md)
- [nodejs/node PR #61433：为 `fs.watch` 添加 `ignore` 选项（Node 24.14.0）](https://github.com/nodejs/node/pull/61433)
- [nodejs/node `lib/internal/fs/recursive_watch.js`：Linux 用户态递归监听实现](https://github.com/nodejs/node/blob/v24.x/lib/internal/fs/recursive_watch.js)
- [nodejs/Release `schedule.json`：各版本 LTS / 维护期 / EOL 日期](https://github.com/nodejs/Release/blob/main/schedule.json)
- [MDN：CSS Cascade Layers——无层声明与层内声明的优先级](https://developer.mozilla.org/en-US/docs/Web/CSS/@layer)
- [pnpm v10 → v11 迁移指南：`allowBuilds`、配置文件位置变更](https://pnpm.io/migration)
- [pnpm/pnpm#11536：pnpm 11 静默忽略 `package.json` 的 `pnpm` 字段](https://github.com/pnpm/pnpm/issues/11536)
- [Lucide：图标源与 `lucide-preact` 包（ISC，Copyright Lucide Contributors）](https://github.com/lucide-icons/lucide)
