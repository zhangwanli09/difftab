# 文件监听

> 收录规则与实测环境见 [`README.md`](README.md)。

- **`ignore` 传逐段匹配函数，是官方支持的用法，也是三端唯一都成立的写法**（`ignore` 随 Node 24.14.0 引入，PR [#61433](https://github.com/nodejs/node/pull/61433)；Node 22.x 的 `doc/api/fs.md` 无此选项）：`createIgnoreMatcher` 除字符串 / 正则外**也直接接受 Function**。字符串模式则落在 minimatch 的 `matchBase` 上——其主循环是 `if (options.matchBase && pattern.length === 1) { file = [filename] }`，**仅当模式为单段时把整条路径替换成 basename 再比**，而 macOS / Windows 的原生 watcher 交给匹配器的是**事件**的相对路径，模式 `node_modules` 匹配不上、过滤完全失效。函数写法实测拦得住：macOS 上强制 A / B 档各起一次，往 `node_modules/.difftab-probe/deep/` 写 50 个文件均 **0 个** `change` 事件，紧接着写一个仓库内真文件、两档各推 **1 个**（否则「0 个」只说明什么都没在听）。
- **Linux 的用户态递归实现是分三档的全部理由**（`lib/fs.js` 里 `recursive && !isMacOS && !isWindows` 才走 `recursive_watch.js`）：`#watchFolder` 对遍历到的**每个目录项（含普通文件）**注册 watch，并在初次遍历时对每个条目 emit 事件；`ignore` 在这里是**注册前跳过**（源码注释 `Skip watching ignored paths entirely to avoid kernel resource pressure`），在原生 watcher 里则只是回调过滤。另：整趟遍历是同步的 `readdirSync` + `statSync`、**跑在 `fs.watch()` 调用内部**，大仓库上会连带卡住此刻并发的 `/api/state` 与静态资源，故懒起须推到 `setImmediate` 的下一拍。
- **出错的用户态递归 watcher 不会自己关，原生的会**（Node 24.14.1 源码）：原生 `FSWatcher` 在 emit `'error'` 之前就关掉了 `_handle`，而 `#watchFolder` 出错时**只有一句** `this.emit('error', error)`——已注册的那一大批 inotify watch 全都还在，只有显式 `close()` 才放得掉（对已关闭的 watcher 是 no-op），而这条路径最典型的触发原因正是配额耗尽，此时占着配额不放伤的是用户整机。
- **ENOSPC 大半不 emit，残留缺口是「改一个启动前就存在的文件」**（CI 的 ubuntu-24.04 档，仓库里 1200 个空目录）：`fs.inotify.max_user_watches` 压到 **128** 时 `mode` 启动后仍是 `native`，直到新建一个文件才翻成 `polling`——遍历途中撞到的 ENOSPC 一次都没 emit；压到 **1** / **4** 时先注册的 `.git` 那条就失败、`mode` 一开始即为 `polling`。四轮新建文件的刷新全部成功，第五轮改一个**启动前就存在**的深层文件 → `refreshed=false`，静默丢失——**30s 安全轮询补的正是这个缺口**。这也否掉了「建流前先探一次非递归 watch」：根那次注册在 128 档是成功的。
- **debounce 在 macOS 上同样是必需项，理由与 Linux 的遍历风暴不同**：非递归 watch 在 macOS 上确实收不到子目录里的写入（在已存在的子目录里建文件、建子目录一次不响，改直接子文件 `HEAD` 则报 `('rename', 'HEAD')`），但**建流前后紧邻的写入会以 `('rename', <被监听目录自身的 basename>)` 补报进来**。补报对产品无害（debounce 把它合成一次多余的 `git status`），却足以让「启动后断言零事件」这类用例偶发变红。
- **忽略清单与变更列表对不齐，且这条边界在 C 档不成立**：**没有 `.gitignore`** 的仓库里放 `node_modules/deep/nested/dep.js`，`/api/state` 与页面列表里都有它；随后往该目录写入，A 档与 B 档**各 0 次** `change`，而 **C 档 1 次**——轮询比的是 status 输出本身，那条路上不调 `isIgnored`。三档各配一条对照均为 1 次。
- **Windows 的突发写入会溢出通知缓冲区，漏出无 `filename` 的事件**（CI 三平台 × Node 22.0.x / 24 / 26）：间隔 250ms（> 合并窗口 150ms）写 6 个文件，**三端九档一律 0 次刷新**；一口气写 50 个，则 **windows × Node 24 / 26 各出 1 次**，macOS 与 Linux 仍是 0。**后来在 windows × Node 26 上实测到 2 次**——那个「1 次」不是上界，只是当时的采样。
- **降级轮询的空闲开销可以接受**（30s 采样、SSE 挂着不动）：C 档 **+0.08s CPU（0.27%）**、A 档 0.03%、B 档 0.00%，RSS 三档均约 60 MB（Node 基线）；轮询周期实测 1.53s 一拍，命令与主查询逐字相同。

## 被排除的做法

| 做法 | 排除原因 |
|---|---|
| Linux 上自行遍历目录树逐个注册 watch（手写一份递归监听） | Node 24.14.0 的 `ignore` 在 Linux 上即为注册前跳过，官方能力已覆盖。**被排除的是「手写 Linux 递归注册」，不是「按平台/版本选策略」**——后者正是三档方案本身 |
| 用 try/catch 或传入选项后观察行为来探测 `ignore` 是否可用 | 探测要成立得依赖「不支持的版本上非法 `ignore` 因选项被忽略而不抛」这一**未文档化的内部细节**，一次校验时机调整就会让它把 A 档误判成 C 档、或把 C 档误判成 A 档。`process.versions.node` 的 semver 比对无此风险 |
| 用「一口气写 50 个文件」那一路来验过滤（曾经有，已删） | **在能断言的地方冗余，在不冗余的地方断言不了。** macOS / Linux 上合并窗口把整批压成**一个**事件，过滤失效时它只漏出 1 个而间隔写入逐个漏出 6 个——它是同一条断言的更弱形式，没有独有的覆盖；Windows 上「缓冲区溢出」与「过滤失效」给出同一个信号，只能带一个放宽的上限，而那个上限正是它唯一稳定的产出（实测溢出过 2 次，超过原定的 1）。调大上限只是让它更晚一点再骗人一次 |
| 无订阅者时暂停降级轮询、有订阅者时恢复 | 省下的是 45 秒宽限期内至多约 30 次 `git status`，换来一个「恢复」分支——漏掉时的症状是**页面连上了却永远不刷新**，既不报错也没有门禁看得见 |
