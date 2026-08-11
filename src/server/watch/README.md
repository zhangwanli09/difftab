# server/watch

三档监听(A/B/C)+ debounce + 轮询兜底(spec §5.7)。

**边界**:不得反向 import `http/` 或 `cli/`。
档位判定用 `process.versions.node` 的 semver 比对,禁用特性探测;
`ignore` 传逐段匹配函数,禁字符串模式;B 档过滤必须在 debounce 之前。

## 已落地(S3b1)

- `tier.ts`:档位判定 + `initialMode`。**内部环境变量 `GITGLANCE_WATCH_TIER=A|B|C`
  强制指定档位**——它是 §7 给 S3b1 定的首个交付物,也是 S3b2 六条档位验收项在单机上
  唯一的自查手段(一台机器只有一个 Node 版本、一个平台)。取值不合法即启动失败,
  不退回自动判定。**不是给用户的开关,README / `--help` 都不写它。**
- `watcher.ts`:`.git` 侧的目录级**非递归** watch + 合并窗口。与档位无关,三档共用。

## 待落地(S3b2)

工作区那一半:A 档 `ignore` 逐段函数 / B 档回调最前面过滤 / C 档 1.5s 轮询 +
通用轮询兜底。`createWatcher` 的 `onError` 就是降级挂点,届时还要把
`WatchState.mode` 翻成 `polling` 并推一个 `change`,让前端重取 `/api/state` 看到降级。
