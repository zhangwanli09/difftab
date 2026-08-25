# 自动刷新：三档监听 + 轮询兜底

> 门禁见 [`../gates.md`](../gates.md)，源码核对与实测数据见 [`../decisions.md`](../decisions.md)。

## 要规避的风险

Node 在 **Linux 上的 `fs.watch({recursive:true})` 是用户态实现**——自己遍历目录树逐个注册 inotify watch，且**对每个普通文件也注册一个**，不止目录。monorepo 下 `node_modules`、`.git/objects`、`target/` 会贡献绝大多数条目，足以耗尽内核 `fs.inotify.max_user_watches`，之后**整机所有依赖 inotify 的工具都开始报 ENOSPC，包括用户自己的编辑器**。这是本工具唯一可能对用户机器造成的外部副作用，与「零副作用只读工具」的核心承诺直接冲突，必须规避。

解法是 `fs.watch` 的 **`ignore` 选项**：它自 Node 24.14.0 起可用，在 Linux 的用户态递归实现里是**注册前跳过**而非回调后过滤。但运行时下限是 Node 22，`ignore` 未必存在，因此按运行时能力分三档。

## 三档

| 档 | 条件 | 工作区监听 | `.git` 监听 | UI 标注 |
|---|---|---|---|---|
| **A** | Node ≥ 24.14.0，三端 | `fs.watch(root, { recursive: true, ignore: isIgnored }, cb)` | 非递归 watch | 无 |
| **B** | Node < 24.14.0，macOS / Windows | `fs.watch(root, { recursive: true }, cb)` + 回调最前面复用同一个 `isIgnored` 过滤 | 同上 | 无 |
| **C** | Node < 24.14.0，Linux | **不建递归 watch**，工作区改动走 1.5s 轮询 | 同上 | 标注降级模式 |

表里只列原生监听那一半：**A / B 两档另有一个 30s 的低频安全轮询**，见下方「兜底」。

- **档位判定用 `process.versions.node` 的 semver 比对，不得靠特性探测**。任何探测写法都要依赖 `fs.watch` 对未知选项处理这一未文档化的内部细节，误判的代价是在 Linux 上静默退化成无 `ignore` 的递归 watch。
- **三档须能由内部环境变量 `DIFFTAB_WATCH_TIER=A|B|C` 强制指定**。一台机器只有一个 Node 版本、一个平台，而三档正是按这两者分的——没有它，档位相关的验证在单机上一条都无从自查。**取值不合法即启动失败，不得退回自动判定**：退回时手滑写错的那次照样启动成功、照样给出一个看着合理的档位，于是「我逐档验过了」建立在一次根本没生效的强制指定上。它不是给用户的开关，不进 `--help` 与 README。
- **B 档为什么安全**：macOS / Windows 走原生 FSEvents / `ReadDirectoryChangesW`，单句柄监听整棵树，本就没有配额问题；`ignore` 在这两个平台上本身也只是回调后过滤，我们自己在回调里调同一个匹配函数即可，不是重新实现监听。
- **B 档的过滤必须发生在 debounce 之前**，否则 `node_modules` 的写入噪声照样把 debounce 窗口顶开、触发无谓刷新。
- **C 档不是全盘轮询**：`.git` 侧的目录级非递归 watch 与 Node 版本无关，提交、切分支仍是即时的；只有工作区文件改动退化为 1.5s 轮询。

## `isIgnored`：逐段匹配函数，不用字符串模式

```ts
const IGNORE_NAMES = new Set(['node_modules', '.git', 'dist', 'target', '.next', 'build']);
// 逐段匹配：路径任一段命中即忽略
const isIgnored = (p: string) => p.split(/[\\/]/).some(seg => IGNORE_NAMES.has(caseFold(seg)));
```

`fs.watch` 的 `ignore` 除字符串 / 正则外**也接受函数**，传函数即可绕开字符串模式的两个坑：

- **字符串 basename 模式在 macOS / Windows 上形同虚设**：原生 watcher 交给匹配器的是事件的**相对路径**（如 `node_modules/.bin/foo`），按 basename 比对时匹配不上模式 `node_modules` → 事件照常放行。B 档在回调里按 basename 过滤同样失效。
- **也不得写成 `node_modules/**` 这类含斜杠的字符串模式**：含斜杠会使 `matchBase` 失效，既匹配不到目录自身（白白进去一层），也匹配不到 monorepo 里嵌套的 `packages/*/node_modules`，两头落空。
- Linux 侧两种写法等价（递归实现是对遍历到的每个条目的相对路径求值），逐段函数在这里的行为与 basename 模式完全一致。
- `caseFold` 在 macOS / Windows 上做小写归一（对齐 `ignore` 内部的 `nocase`），Linux 上原样返回。
- **`.git` 内部**：`isIgnored` 已把 `.git` 整个排除，因此三档都需对 `HEAD`、`index`、`refs/`、`MERGE_HEAD` / `rebase-*` 所在**目录**单独建**非递归** watch，否则检测不到提交与切分支。**绝不递归 `.git/objects`**。

## 兜底与安全轮询

任一路径失败（ENOSPC / ENOSYS / 网络盘 NFS·SMB / Docker 卷）自动降级为 **1.5s 轮询**，并在 UI 上标注降级模式。这条与档位正交：A / B 档失败时同样落到轮询，C 档则是一开始就以它为工作区通路。`ignore` 解决的是配额，救不了这些场景，**兜底不可省略**。

- **检测得到才降得了级，而 Linux 上的 ENOSPC 有一大半检测不到**：`internal/fs/recursive_watch.js` 的 `kFSWatchStart` 把**根**那一次注册的失败整个吞掉（`catch (error) { if (error.code === 'ENOENT') throw; }`），ENOSPC / EACCES / EPERM 一律丢弃，`fs.watch()` 返回一个看着活着、却永远不 emit 的 watcher。**遍历途中耗尽同样不 emit**——真正让 ENOSPC 浮出水面的是**下一次要注册 watch 的时候**，也就是工作区新出现一个条目的那一刻，于是「降级」发生在用户第一次新建文件之后，而不是启动那一刻。
- **残留缺口因此是「改一个启动前就存在、且没轮上注册的文件」**：它不引出任何注册尝试，事件静默丢失、`mode` 一直是 `native`、没有任何东西会响。
- **补法是原生档（A / B）同时跑一个 30s 的低频安全轮询**，用与降级轮询逐字相同的那条 status 命令，发现变化就照常推一次刷新。它补的正是上面那个缺口——原生监听少报了什么时没有任何信号，只有拿 status 输出本身去比才看得见。**不翻 `mode`、不上报降级**：原生监听确实还活着（只是不完整），翻了会把一次可能的误判说成「已降级」，而两者代价不对称——多刷一次没有代价，把状态说错有。周期取 30s 而不是 1.5s，是为了让「原生监听模式下空闲 CPU 接近零」继续成立（一次 status 几十毫秒，占空比千分之几），代价是那个病态场景下最坏 30s 的滞后。真降级之后周期自动收到 1.5s——两者是同一个轮询循环的两个周期，不是两套机制。
- **轮询必须复用同一条命令 `git status --porcelain=v2 --branch -uall -z`，不得为「轮询只要知道变没变」而裁剪参数**。漏掉 `-uall` 的后果是静默的：git 把未跟踪目录折叠成一行 `dir/`，于是**在一个已存在的未跟踪目录里新增文件根本不改变输出**，轮询判定为「无变化」、页面不刷新，而这正是 agent 边跑边生成文件时最常见的形态。漏掉 `--branch` 则丢掉提交与切分支的检测。逐字一致也让只读白名单只需覆盖一种调用形态。

## 三条 Node 官方文档载明的行为约束（三档均适用）

1. **绝不能对单个文件建 watch**。Linux / macOS 上 watch 绑定的是 inode，路径被删除后重建会分配新 inode，原 watch 从此静默失效——而编辑器和 agent 普遍用「写临时文件 + 原子 rename」保存文件。必须 watch 目录。
2. 回调的 `filename` 参数**可能为 null**，即便在支持的平台上也不保证提供，必须有 fallback 逻辑。
3. 事件需做 debounce（100–200ms）合并。**在 Linux 上这是必需项而非优化项**：用户态递归实现在初次遍历目录树时会对遍历到的每个条目 emit 事件，启动瞬间即产生一波与实际变更无关的事件风暴，没有 debounce 会直接触发一次无意义的全量刷新。

## 三条已知边界

- **`IGNORE_NAMES` 只管监听、不管展示，且只在 A / B 档成立。** 变更列表的数据源是那条 `git status`，它只认 `.gitignore`；而 `isIgnored` 那六个名字是写死的。对不齐时的形态是：**没有 `.gitignore` 的仓库里，`node_modules/` 或 `dist/` 下的文件在列表里看得见，改它却不触发刷新**。**这条边界方向反直觉：C 档（以及任何降级到轮询的情形）照常刷新**——轮询比的是 status 输出本身，`isIgnored` 在那条路上一次都不会被调用。因此「同一个仓库在不同机器上刷不刷新」是可能的，排查时别把它当成机器坏了。不改成「按 git 的忽略规则建 watch」：那要么在监听层引一次 `check-ignore`（把 `watch/` 拖上 git 的依赖边），要么自己解析 `.gitignore`（重写一份 git 的匹配语义），代价都远大于这个形态的实际影响。
- **轮询看不见「未跟踪文件的内容变化」。** 未跟踪文件在 status 输出里只有一行 `? <路径>`，**改它的内容一个字节都不会变**，于是那条改动在**所有走轮询的路上**都发现不了。已跟踪文件不受影响（`? ` → ` M `），新增与删除也不受影响。**原生监听没有这个问题**，所以它只在 C 档与真降级之后才浮出来。**不修**：要看见它就得给每个未跟踪文件算内容哈希，而未跟踪文件恰恰可能是几百 MB 的构建产物。
- **Windows 上一次突发写入可能引出一次与内容无关的刷新。** `ReadDirectoryChangesW` 的通知缓冲区被突发写满时，内核报的是「丢了一批」而不是具体路径，Node 由此 emit 一个**没有 `filename`** 的事件——而 `filename` 为 null 时我们**放行**（漏刷一次比多刷一次糟）。**这是取舍不是缺陷**：溢出恰恰意味着「你漏掉了些什么」，此刻唯一安全的做法就是刷新。因此过滤生效的判据是「**间隔开**的写入一次都不刷」，突发那一路在 Windows 上放宽到最多 1 次。

变更通过 SSE 推送前端刷新，通道与生命周期见 [`server.md`](server.md)。
