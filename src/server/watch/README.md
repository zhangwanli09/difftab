# server/watch

三档监听(A/B/C)+ debounce + 轮询兜底(spec §5.7)。

**边界**:不得反向 import `http/` 或 `cli/`,也**不 import `git/`** ——
轮询要跑的那条 `git status` 由调用方注入(`WatcherOptions.pollStatus`),
git 子进程只许出现在 `server/git`(§5.0 不变式 1),而 §5.0 的依赖方向里
也没有 watch → git 这条边。
档位判定用 `process.versions.node` 的 semver 比对,禁用特性探测;
`ignore` 传逐段匹配函数,禁字符串模式;B 档过滤必须在 debounce 之前。

## 三个文件的分工

- `tier.ts`:档位判定 + `initialMode`。**内部环境变量 `GITGLANCE_WATCH_TIER=A|B|C`
  强制指定档位**——它是 §6 那六条档位验收项在单机上唯一的自查手段(一台机器只有
  一个 Node 版本、一个平台)。取值不合法即启动失败,不退回自动判定。
  **不是给用户的开关,README / `--help` 都不写它。**
- `ignore.ts`:三档共用的逐段匹配器。A 档传给 `fs.watch` 的 `ignore`、
  B 档在回调**最前面**调,是同一个函数。字符串模式的两种失效形态写在文件头。
- `watcher.ts`:`.git` 侧的目录级**非递归** watch + 工作区侧的三档 + 1.5s 轮询兜底。
  **合并窗口只有一个**,`.git`、工作区、轮询共用 —— 一条 `git commit` 同时惊动两侧,
  各起各的窗口等于每次提交刷两遍。

## 降级(§5.7 的兜底)

任一路径失败(ENOSPC / ENOSYS / 网络盘 / Docker 卷)→ 落到轮询 + 调一次 `onDegrade`。
调用方(`http/server.ts`)据此把 `WatchState.mode` 翻成 `polling` **并推一个 `change`**:
`mode` 只在 `/api/state` 里,不推事件的话前端要等到下一次真的有文件变更才会重取,
而它自己无从推断降级这件事(§5.12)。降级**不可逆**,也只上报一次 ——
一次 ENOSPC 往往连着把几个 watcher 全打下来。

`WatchHandle.size` 只数 `.git` 侧,工作区侧的死活看 `mode`:合并成一个数之后,
「`.git` 没了但工作区还在」与「工作区没了但 `.git` 还在」就成了同一个 1。
