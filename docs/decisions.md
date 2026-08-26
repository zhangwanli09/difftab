# 被排除的做法与关键决策依据

> [`design/`](design/) 写规则与它失效时的机制，**本文只写实测输出、源码引用与被排除的做法**——机制不在这里复述第二遍。索引见 [`README.md`](README.md)。
>
> **一条记录留下来的唯一理由，是「将来有人会重新提出那个做法、或重新踩那个坑，而它不会报错」。** 三类不满足的写了也要删：事实源在别处且会过期的（版本号、latest 是多少、发布日程），复述 `design/` / `gates.md` / `RELEASING.md` 已有规则的，以及不改变任何未来判断的一次性叙事。
>
> **实测环境**：未单条注明时为 git 2.50.1 / Node 24.14.1 / macOS 26，时间在 2026 年 8 月；注明 CI 的那几条跑在 GitHub runner 上。**重测时先核这一行**——结论会随这些版本失效，而失效不会有任何东西报错。

## git 行为

- **空仓库**：`git diff HEAD` → `fatal: ambiguous argument 'HEAD'`、`rev-parse --verify HEAD` → exit 128，而 `status --porcelain=v2 --branch` 正常返回（`# branch.oid (initial)`）、`git diff <空树哈希>` 正常出结果。空树基准因此是唯一不必写特殊分支的降级路径；SHA-256 仓库上同样验过（numstat 与补丁都正常）
- **两个空树常量的取法**：`git hash-object -t tree --stdin < /dev/null`，用的是**读形态**（不带 `-w`、不写对象库）且发生在 fixture 生成期，产品代码里只有硬编码值。`rev-parse --show-object-format` 随 SHA-256 支持在 2.29 前后才引入，**高于 git 下限 2.11**——那个区间的 git 根本造不出 SHA-256 仓库，故非零退出按 SHA-1 降级无歧义
- **进行中的多步操作在 git 目录里留下的痕迹**（git 2.50.1）：merge 冲突 → `MERGE_HEAD` / `MERGE_MODE` / `MERGE_MSG` / `AUTO_MERGE`；rebase 冲突 → `rebase-merge/`（内含 `git-rebase-todo` / `head-name`）**外加** `MERGE_MSG` 与 `AUTO_MERGE`；`rebase --apply` 冲突 → `rebase-apply/`（内含 `rebasing`）；cherry-pick → `CHERRY_PICK_HEAD`；revert → `REVERT_HEAD`；bisect → `BISECT_LOG` / `BISECT_NAMES` / `BISECT_START` / `BISECT_TERMS`。**rebase 的痕迹里带着 merge 的那几个**，判据表「按序取第一个命中、rebase 先判」由此而来
- **rebase 停下时 status 报的是 detached**（`# branch.head (detached)`，冲突文件是一条 `u UU N... … f.txt`，10 个前导字段 + 路径占一个 NUL 段）：`operation` 与 `detached` 是同时出现的两件事，不是二选一
- **冲突文件不需要特殊分支**：`diff HEAD --numstat -z -- f.txt` → `4\t0\tf.txt`，`diff HEAD -- f.txt` exit 0 且正文就是带 `<<<<<<< HEAD` / `=======` / `>>>>>>>` 的工作区内容（`ls-files -z` 对同一路径回**三**条暂存位，但取 diff 这条路用不到）
- **linked worktree / submodule / bare 的 `rev-parse` 形态**：linked worktree 的 `.git` 是一个内容为 `gitdir: <主仓库>/.git/worktrees/<名>` 的**文件**，`--show-toplevel` 照常给出该工作区根，而 `--git-dir` 给出的是那个 worktree 专属目录（submodule 同理，为 `<父仓库>/.git/modules/<路径>`）——状态文件只能按它找。submodule 在父仓库里是一条 `1 .M S.MU 160000 …` 记录、numstat 给 `0\t0\t<路径>`、补丁是一行 `-Subproject commit …`，走的都是已有的已跟踪路径。bare 仓库 `--show-toplevel` 报 `fatal: this operation must be run in a work tree` 并以 **128** 退出，而 `--is-bare-repository` 正常回 `true`
- **路径转义有两处，`-z` 只管得住一处**：不加 `-z` 时 status 把 `docs/需求文档.md` 输出成 `"docs/\351\234\200\346\261\202\346\226\207\346\241\243.md"`；而 `-z` 管不到 `git diff` 正文，`diff --git` / `---` / `+++` / `rename from|to` 头部行照样 C 风格转义，须叠加 `-c core.quotePath=false` 才原样输出
- **两种 `-z` 记录的实测形态**：`porcelain=v2` 的重命名是 `2 <XY> … R100 <新路径>\0<旧路径>`（两段）；`diff --numstat -z` 的重命名是**空路径 + `<旧路径>` + `<新路径>`**（三段，新旧顺序与前者相反），二进制记录两个计数都是 `-`，未跟踪路径输出为空且 exit 0——numstat 因此能兼任「已跟踪」判据。另：无上游分支时不输出 `# branch.ab` 行
- **重命名按单路径取 diff 会退化**：`diff HEAD -- <新路径>` 输出 `new file mode` + `--- /dev/null`，`-M -- <新> <旧>` 才输出 `similarity index` + `rename from/to`；numstat 那侧同样把它算成整份新增
- **配不上对时 numstat 回两条记录**：`git mv` 后把新文件重写成 60,000 行且**不 add**，`-M -- <新> <旧>` 回 `0\t20\t<旧路径>\0 60000\t0\t<新路径>` 两条按路径排序的记录，而 status 仍报 `R100`——取 `[0]` 拿到的是旧文件那条几十行的删除，于是行数闸放行
- **pathspec 默认是 wildmatch，不是字面路径**（git 2.50.1）：仓库里同时有 `docs/star*.md` 与 `docs/starlight.md` 时，`diff HEAD --numstat -z -- 'docs/star*.md'` 回**两条**记录，`-- '*'` 回全部改动文件；设 `GIT_LITERAL_PATHSPECS=1` 后都只按字面比较。该变量自 git 1.9（2014）即有
- **超限掐断 git 之后，Windows 上先到的是 `'error'` 而不是 `'close'`**：`maxStdoutBytes` 触发后 `child.kill()`，**windows × Node 22.0.x 那一档**随即走进 `'error'` 分支，`GitError.kind` 因此是 `exit` 而不是 `overflow`，`/api/diff` 回 500 而不是 `too-large`；另外八档不触发
- **`GIT_TRACE` 的记录形态**：每次调用留下一行 `trace: built-in: git status --porcelain=v2 --branch -uall -z`——`-c core.quotePath=false` 已被 git 前端消化、**不出现在这一行**（白名单断言不受影响，但 `core.quotePath` 的生效得靠别的断言证）；`git --version` 记作 `built-in: git version`，故白名单里那一项叫 `version`；外部子命令与 git 内部再起的进程分别记作 `exec:` / `run_command:`；给相对路径时 git 会警告并退回 stderr
- **Windows 上 fake git wrapper 的两条死路**：(a) Node 自 20.12 起不带 `shell` 时 spawn `.cmd` / `.bat` 直接抛 `EINVAL`（CVE-2024-27980 的修复），而 PATH 劫持在 Windows 上只有 `.cmd` / `.exe` 两种可用形态；(b) 退而把 node 二进制装成 `git` + `NODE_OPTIONS=--require <shim>` 时，node 自己的 CLI 解析先跑——`-c` 被当成 node 的 `--check` 吃掉，其后第一个参数还被 `path.resolve` 改写，记到的「完整子命令」因此是错的
- **只读 `.git` 挡不住 index 回写，只是让它静默失败**（git 2.50.1 / macOS）：`touch` 一个内容未变的已跟踪文件后，默认 `git status` 把 `.git/index` 重写一遍（mtime 变），设 `GIT_OPTIONAL_LOCKS=0` 则不变；而把 `.git` 整棵 `chmod -R a-w` 之后再跑同一条默认 `git status`，它 **exit 0、stderr 全空**，只是没写成。已在故意去掉该变量的产物上复现：A 半 3 条全过，B 半报 `index` 变了
- **Node 22.0.0 的 `node --test` 不等顶层 `before()`**：顶层异步 `before()` 尚在执行时该文件的用例就已开跑——依赖其中所建 server 的用例全部在 1ms 内以读取 `undefined` 失败，而自己起进程的用例照常通过；`after()` 同样提早触发，清理撞上还在写的 fixture 报 `ENOTEMPTY`。Node 24 / 26 行为正确，故本机绿、CI 也只有下限那一档红
- **未被显式 stop 的被测子进程会吊住 `node --test`**：残留 server 的 stdio 管道让 runner 的事件循环永不清空，表现为**全部用例通过、命令却不返回**。因此 ready 后 `unref()` 子进程与其 stdio，并在 `process.on('exit')` 里统一 kill；`stop()` 里要 `ref()` 回来，否则 kill 之后等 `'close'` 时循环可能已经空了

## Node 运行时与 `fs.watch`

- **`fs.watch` 的 `ignore` 选项**（Node 24.14.0 引入，PR [#61433](https://github.com/nodejs/node/pull/61433)）：核对 `lib/internal/fs/recursive_watch.js`，Linux 用户态递归实现里它是**注册前跳过**（源码注释 `Skip watching ignored paths entirely to avoid kernel resource pressure`），而 macOS / Windows 的原生 watcher（`lib/internal/fs/watchers.js`）里是回调过滤；`createIgnoreMatcher` 除字符串 / 正则外**也直接接受 Function**（收下即用、不做包装），故函数写法是官方支持的用法。Node 22.x 的 `doc/api/fs.md` 中无此选项
- **minimatch `matchBase` 的实际语义**：`deps/minimatch/index.js` 的主循环是 `if (options.matchBase && pattern.length === 1) { file = [filename] }`——**仅当模式为单段时，把整条路径替换成 basename 再比**。Linux 侧对**每个遍历条目**的相对路径求值，走到 `node_modules` 自身时 basename 即命中，字符串模式碰巧成立；macOS / Windows 侧拿的是**事件的相对路径**（`node_modules/.bin/foo` → basename `foo`），模式 `node_modules` 匹配不上，过滤完全失效
- **Linux 用户态递归监听的实际开销**（`lib/fs.js` 里 `recursive && !isMacOS && !isWindows` 才走 `recursive_watch.js`，故只有 Linux 是用户态实现）：`#watchFolder` 对遍历到的**每个目录项（含普通文件）**都注册 watch，并非只对目录，且初次遍历时对每个条目 emit 事件、启动即产生事件风暴——配额风险与「debounce 是必需项」都出自这里。另：整趟遍历是 `readdirSync` + `statSync`，**同步跑在 `fs.watch()` 调用内部**，大仓库上会连带卡住此刻并发的 `/api/state` 与静态资源（症状与「监听很慢」毫无相似之处），故懒起须推到 `setImmediate` 的下一拍
- **出错的用户态递归 watcher 不会自己关，原生的会**（Node 24.14.1 源码）：原生 `FSWatcher` 在 emit `'error'` 之前就关掉了 `_handle`，而 `#watchFolder` 出错时**只有一句** `this.emit('error', error)`——已注册的那一大批 inotify watch 全都还在，只有显式 `close()` 才放得掉，而这条路径最典型的触发原因正是配额耗尽，此时占着配额不放伤的是用户整机。`close()` 对已关闭的 watcher 是 no-op
- **压低 `fs.inotify.max_user_watches`：ENOSPC 大半不 emit，残留缺口是「改已有文件」**（CI 的 ubuntu-24.04 / Node 24.19.0，仓库里 1200 个空目录；watch 用量在 `/proc/<pid>/fdinfo/*` 里数得到）：配额 **128** 时 `mode` 启动后仍是 `native`，直到新建一个文件才翻成 `polling`——即遍历途中撞到的 ENOSPC 一次都没 emit，与按源码得出的推断相反。配额 **1** / **4** 时改在 `.git` 那条先失败、`mode` 一开始就是 `polling`（`.git` 侧先注册，极低配额反而是**检测得到**的那一种）。四轮**新建文件**的刷新全部成功，第五轮改一个**启动前就存在**的深层文件 → `refreshed=false`，静默丢失。这也否掉了「建流前先探一次非递归 watch」：根那次注册在 128 档是成功的
- **非递归 watch 在 macOS 上确实收不到子目录里的写入**（Node 24.14.1）：对一个目录 `fs.watch(dir, { recursive: false })`，随后在**已存在的**子目录里建文件、建子目录，回调一次都不响；改直接子文件 `HEAD` 则报 `('rename', 'HEAD')`。**测法是这条结论成立的前提**：建流前后紧邻的写入会以 `('rename', <被监听目录自身的 basename>)` 补报进来，故必须让目录结构先静下来再建流、并把启动阶段单独收一段——先前一版就是把这条补报误读成「嵌套写入漏了过来」，据此加过一层死代码。补报对产品无害（debounce 合成一次多余的 `git status`），但它足以让「启动后断言零事件」这类用例偶发变红——**「debounce 是必需项而非优化项」因此在 macOS 上也成立，理由与 Linux 的遍历风暴不同**
- **逐段匹配函数在 macOS 上三档都真的拦住了 `node_modules`**（Node 24.14.1）：强制指定 A / B 档各起一次，往 `node_modules/.difftab-probe/deep/` 批量写 50 个文件——两档都是 **0 个 `change` 事件**；紧接着往仓库里写一个真文件，两档都各推出 **1 个**（否则「0 个」只说明什么都没在听）。同一份判据换成 basename 比对后，单测里 A / B 两档的真实文件系统用例双双变红（已弄红验证）。Linux 侧的注册前跳过与 inotify 用量由 CI 的 ubuntu 档断言
- **忽略清单与变更列表对不齐，且这条边界在 C 档不成立**：**没有 `.gitignore`** 的仓库里放 `node_modules/deep/nested/dep.js`，`/api/state` 与页面列表里都有它；随后往该目录写入，A 档与 B 档**各 0 次 `change`**，而 **C 档 1 次**——轮询比的是 status 输出本身，那条路上不调 `isIgnored`。三档各配一条对照均为 1 次。**测法有个坑**：写一个已存在且内容相同的文件不改变 status 输出，轮询那档会因此判「无变化」，每轮须换新文件名
- **Windows 的突发写入会溢出通知缓冲区，漏出一次无 `filename` 的事件**（CI 三平台 × Node 22.0.x/24/26）：往 `node_modules/some-dep/lib/nested/` 间隔 250ms（> 合并窗口 150ms）写 6 个文件，**三端九档一律 0 次刷新**；紧接着一口气写 50 个，**windows × Node 24 / 26 各出 1 次**，macOS 与 Linux 仍是 0。两种写法给出的数不同，正是把「逐段过滤没生效」与「缓冲区溢出」分开的判据——合并窗口会把 50 次写入压成 1 个事件，只看突发那一路时两种病因给出的数**一模一样**。同一轮里另有一条「读 3 次 `/api/state` 事件数不变」（三端九档全 0），排除了 `git status` 自激这条解释
- **降级轮询的空闲开销**（30s 采样、SSE 挂着不动）：C 档 **+0.08s CPU（0.27%）**、A 档 0.03%、B 档 0.00%，RSS 三档均约 60 MB（Node 基线）。轮询周期实测 1.53s 一拍，命令与主查询逐字相同。**测法有个坑**：macOS 的 `ps -o time` 是 `MM:SS.ss` 而不是 `HH:MM:SS`，按三段解析会把秒当成分钟、读数虚高 60 倍；git 子进程的 CPU 不计在父进程的 TIME 里，需另行核对
- **`os.tmpdir()` 的权限差异**：macOS 上为每用户 0700 私有目录（实测 mode 700），Linux 上为 `/tmp`（1777，同机其他用户可读）——注册表文件 `0o600` 的依据
- **`server.requestTimeout` 掐不断已完成请求的长响应**（Node 24.14.1）：把它压到 1s、服务端保持一条 200ms 一发的 `text/event-stream`，3s 后连接仍然活着、数据持续到达。故 SSE 端点不需要为超时做任何特殊设置（Node 18 早期曾有此问题，现已修复）
- **整机休眠在回环上不留半开 TCP**（macOS 26 / Node 24.14.1 / Chrome 151）：`pmset sleepnow` 睡 234 秒，唤醒后服务进程还在、SSE 连接完好并继续工作——浏览器与服务一起冻结、一起醒来，中间没有网络分区。真正走得到「判死重连」的是**连接静默 + 标签切回**：`SIGSTOP` 冻住 40 秒后切走标签再切回，`/api/events` 由 1 次变 2 次、**且发生在服务仍冻着时**（触发者是前端的判定），`/api/state` 同时补取一次；而冻 45 秒**不切标签**时一次重连都没有。故判死只放在 `visibilitychange` 一处、不另设定时器
- **响应头一到手，`req.destroy()` 就不再走 `req` 的 `'error'`**（Node 24.14.1）：`http.request` 收到 200 之后再 `destroy()`，错误只落在 `IncomingMessage` 上（`'aborted'` 随后 `ECONNRESET`），而**无人监听的 `IncomingMessage` `'error'` 被内部吞掉**。于是「超时了就 destroy」在对端「发了响应头就装死」时既不 settle 也不报错——实测 300ms 超时的探活挂满 3 秒仍无结果，启动**整个吊死、一行输出都没有**。**「对端连响应头都不发」这一形态抓不到它**：那时错误确实落在 `req` 上，两者只差一次 `writeHead`
- **读端一走，Windows 上写 stdout 就能打死进程**（CI 的 windows × Node 24 档；macOS / Linux 同一条路一声不响）：**管道写在 Windows 上是异步的**、POSIX 上是同步的，于是 EPIPE 在 Windows 上以一个 `'error'` 事件到达，而零监听器的流收到 `'error'` 就是整个进程带裸栈以 1 退出（实测 `difftab --no-open | head -1`，**243ms**）。同一件事的另一半：`fs.writeSync(1, …)` 在读端已关闭时**抛** EPIPE，45 秒空闲退出的定时器回调里抛出它时退出闩已经合上、`server.close()` 不再执行，进程带着一屏 Node 栈以 **1** 退出，而这条路承诺的是干净的 **0**。所以「提示走 `writeSync`」与「容许这次写失败」是同一条要求的两半
- **Windows 上删不掉「仍是某进程 cwd」的目录**（CI 的 windows × Node 22.0.x 档）：冒烟套件以 fixture 仓库为 cwd 起被测进程，退出钩子里 `child.kill()` 返回时系统尚未回收该进程，紧接着的 `rmSync` 报 `EBUSY`，于是**全部断言都已通过、进程仍以 1 退出**。对策是 `rmSync` 带 `maxRetries`（rimraf 的重试是 `Atomics.wait`，同步、在退出钩子里可用），重试用尽只警告不抛——收尾失败不该盖过断言结果

## 前端渲染与体积

- **diff2html bundle 体积**（官方 CDN，diff2html 3.4.56 / highlight.js 11.11.1）：全量包 `diff2html-ui.min.js` 1,048,945 B；slim 包 301,714 B；`diff2html-ui-base.min.js` 90,167 B；`diff2html.min.css` 17,331 B。三个预构建 UI bundle 均已排除，此处仅作体积参照
- **`html()` 不含语法高亮**：核对 `lib-esm/ui/js/diff2html-ui-base.js`，高亮由 `Diff2HtmlUI.highlightCode()` 完成，依赖 `./highlight.js-helpers` 的 `closeTags` / `nodeStream` / `mergeStreams` / `getLanguage`；`draw()` 内部为 `innerHTML` 赋值后逐项绑定事件。四个模块明文体积 7,252 / 13,699 / 1,556 / 12,711 B（ui-base / helpers / diff2html / templates）。diff2html 的 `package.json` **无 `exports` 字段**，深导入合法
- **hljs 的三个「语言」实际不存在**：`highlight.js@11.11.1/es/languages/{jsx,tsx,toml}.js` 实测均 404；`ini.js` 中 `aliases: ['toml']`、`javascript.js` 中含 `jsx`、`typescript.js` 含 `tsx`
- **语言子集体积实测**（`es/languages/*.js` 明文，22 个模块）：**合计 225,598 B**；最大的五个是 swift 22,517 / typescript 21,359 / scss 19,468 / css 18,884 / javascript 17,756 B，最小的 json 1,343 B，`es/core.js` 仅 202 B。压缩后约 130 KB / gzip 约 40 KB——**要砍体积先砍这张表的头部**
- **hljs 主题 CSS 是必需的**：`diff2html.min.css` 中含 hljs 的规则数为 **0**，预构建 slim 包也只含 hljs 运行时与语言定义、不含配色。**体积数取自 min 版**：`github.min.css` 1,309 B、`github-dark.min.css` 1,315 B，合计约 2.6 KB；我们 `@import` 写的是非 min 的两份，构建期由 Vite 压缩，最终产物对齐 min 版口径
- **diff2html 的文件头里没有增删统计，统计在从没被渲染过的文件列表模板里**（3.4.56）：`.d2h-file-header` 的全部内容是 `d2h-icon` + `d2h-file-name` + `d2h-tag` + `d2h-file-collapse`，四样，**没有任何数字**；`d2h-file-stats` / `d2h-lines-added` / `d2h-lines-deleted` 在 `lib-esm/diff2html-templates.js` 里全仓各出现 **1 次**，且都在 `d2h-file-list-line` 那份模板里（我们传 `drawFileList: false`）。两份 diff 模板都把 `.d2h-file-header` 无条件写在 `.d2h-file-wrapper` 的第一个子节点上，**没有任何配置项能关掉它**。另：重命名在文件头里是紧凑形式 `src/{kept.txt → kept-renamed.txt}`（公共前缀被提出来、不含相似度），替代不了带完整旧路径与相似度的 `RenameNotice`
- **diff2html 模板中的内联 `style=` 出现 0 次**，`draw()` 改样式走 CSSOM（`el.style.display = …`），不受 CSP 约束——严格 CSP 不需要 `'unsafe-inline'` 的依据
- **happy-dom 的 `Attr.nodeName` 返回空字符串**（20.11.2：同一个 `class="hljs-keyword"` 属性上 `name` / `localName` 都正常、`nodeName` 为 `''`），而 diff2html 的 `mergeStreams.open()` 恰好用 `attr.nodeName` 重新序列化属性。后果：凡走过 `mergeStreams` 的行——即带 `<del>` / `<ins>` 词级标记的增删行——**类名丢失**。**只影响 DOM 测试环境**（真机实测 177 个 hljs span / 12 类），故 `test/unit/web/` 里「高亮出颜色」的断言必须压在**上下文行**上。顺带的好处：重复调 `highlightCode()` 时连上下文行也会被卷进去、span 数 20+ → 0，那条禁令因此更容易被抓住
- **两种 `outputFormat` 在 DOM 上的分界**（3.4.56）：同一份补丁 `side-by-side` 输出 **2 张** `.d2h-diff-table`（各裹在一个 `.d2h-file-side-diff` 里）、`line-by-line` 输出 **1 张**且 `.d2h-file-side-diff` 出现 **0** 次——这对正反计数就是单测里区分两种格式的判据。只被并排选择器读到的是 `--d2h-change-*` 与 `--d2h-empty-placeholder-*`，逐行下**失效而非缺失**，故两种格式共用同一套映射即可
- **1024 这个阈值的算法**（就 `diff2html.min.css` 实测）：`.d2h-diff-table{font-family:Menlo,Consolas,monospace;font-size:13px}`，并排的 `.d2h-code-side-line{padding:0 4.5em;width:calc(100% - 9em)}`、逐行的 `.d2h-code-line{padding:0 8em}`——即 13px 下并排每侧固定吃掉 **117px**、逐行吃掉 **104px** 的行号槽，按 Menlo 13px 每字符约 **7.8px** 折算。**与 Tailwind 的 `lg`（1024px）数值相同是巧合**：那是视口断点，这里量的是面板
- **`ResizeObserver` 的观察 box 与读值 box 是两件事**：`observe(el)` 默认按 **content box** 判「有没有变」，于是滚动条每次进出都推一次回调，哪怕 border box 一动没动——只在读值那侧取 `borderBoxSize` 滤的是**已经产生的**回调，`observe(el, { box: 'border-box' })` 才是从源头不投递。另：`borderBoxSize` 读的是观察阶段已算好的值（不另走脏检查、不分配 DOMRect），且**不带 transform 缩放**——对「还剩多少地方排版」这个问题，未缩放的排版宽度才是想要的那个
- **happy-dom 的 `ResizeObserver` 是个空壳**（20.11.2：`observe` / `unobserve` / `disconnect` 三个方法体都只有一句 `// TODO: Not implemented`），而它本来也没有布局引擎、量不出宽度。故自动切换里「`ResizeObserver` → 宽度 signal」这一段在 `test/unit/web/` 里**盖不到**，只能归肉眼项；阈值映射与「格式进了 effect 依赖数组」两段则通过**直接写那个 signal** 照常断言
- **前端框架体积量级**：Preact 运行时约 4 KB gzip，React 19 + ReactDOM 约 42 KB gzip，Svelte 5 编译后约 2–5 KB。Svelte 的劣势在工具链而非体积——Biome 2.x 对 `.svelte` 仅覆盖 `<script>` 块，模板与样式仍需 Prettier 加插件

## 样式层叠

- **Tailwind preflight 与 diff2html 的冲突面几乎为零**：preflight（`tailwindcss@4.3.3`，8,489 B）会做 `*{box-sizing:border-box;margin:0;padding:0;border:0 solid}`、`table{border-collapse:collapse}` 等重置，而 `diff2html.min.css`（3.4.56）**自带**了所有关键声明：`.d2h-diff-table{border-collapse:collapse}`，四个行号类均含 `box-sizing:border-box`，边框写作 `border:solid var(--d2h-line-border-color);border-width:0 1px`（类选择器 0,1,0 稳压通配的 0,0,0），`.d2h-file-list{list-style:none;margin:0;padding:0}` 亦自声明。**唯一实质差异是 `<td>` 的 1px UA 默认 padding 被清零，反使跨浏览器渲染更一致**
- **hljs 两份主题都不含 `@media`**：`styles/github.css` 与 `styles/github-dark.css` 实测 `@media` 出现次数均为 **0**，两者都是无条件 `.hljs { … }` 规则——深色那份的媒体条件只能由我们在 `@import` 上加
- **diff2html 的深色配色由 class 门控，且 auto 那条路有缺口**（就 3.4.56 的 `diff2html.min.css` 逐条实测）：整份 CSS 只有 **1 个** `@media`，即 `(prefers-color-scheme:dark)`，里面 29 条规则清一色以 `.d2h-auto-color-scheme` 前缀开头、且只读 `--d2h-dark-*`；`:host,:root` 里声明了 **47** 个变量（23 个无前缀 + 24 个 `--d2h-dark-*`），所有颜色声明都写成 `prop:硬编码; prop:var(--d2h-…)` 双写、**没有任何一条只有硬编码值**——覆写无前缀那 23 个即可完全接管配色。另三点：`.d2h-light-color-scheme` 在 CSS 里出现 **0** 次（是个空 class）；auto 前缀规则特异性 (0,2,0) 稳压基础规则 (0,1,0)；auto 块里 `.d2h-deleted` 被误写成 `.d2h-dark-color-scheme .d2h-deleted`，是 29 条里唯一挂错前缀的一条
- **diff2html 的行号列是绝对定位，且它假设滚的是整个文档**（就 3.4.56 的 `diff2html.min.css` 实测）：`.d2h-code-linenumber`（`width:7.5em`）与 `.d2h-code-side-linenumber`（`width:4em`）均声明 `position:absolute`、偏移量全是 `auto`；整份 CSS 里**除 `.d2h-file-header.d2h-sticky-header`（我们传 `stickyFileHeaders:false`）之外再无任何 `position` 声明**，即 diff2html 自己**不提供**包含块，而我们这侧在此之前也没有（产物里唯一的 `position:relative` 来自 preflight 的 `sub,sup`）。**修好那一侧用 Chrome 量过**：400 行删除的补丁竖滚到 3000 / 7500 时行号格与所在 `tr` 的 `top` 差恒为 0，把宿主 div 的 `position` 临时改回 `static` 后同样两处的差变成 3000 / 7500（整列钉死）；横滚 400px 时行号列的 `left` 保持 321 不动。**`<section>` 那种放法没有实测过**
- **Tailwind v4 裁剪未引用的 `@theme` 变量**（4.3.3 + Vite 8 构建实测）：在 `@theme` 里放三个探针 token，只被 `var()` 从我们自己的 CSS 引用的那个**出现在产物里**，谁都没引用的那个**被裁掉**，被工具类用到的照常输出；同时实测 `@theme` 的产出落在 **`@layer theme`** 内（故写在 `vscode-theme.css` 里的 unlayered 深色覆写天然压得住浅色取值）。改用 `@theme static` 会把 Tailwind 默认主题的全部变量一并吐出，直接压 CSS 的 40 KB 预算

## 工具链与发布

- **`tsdown` 与 `vite` 的 Node 要求都高于产品运行时下限 22.0.0**（npm registry 实测）：`tsdown` 的 engines 为 `^22.18.0 || >=24.11.0`、`vite` 为 `^20.19.0 || >=22.12.0`。这是 CI 拆成 build / matrix 两层的直接依据。**其余工具链版本一律以 `package.json` 与 lockfile 为事实源，不在本文抄第二份**
- **两条与打包有关的入口形态**（npm registry 实测）：`highlight.js` 的 `exports` 把 `./lib/core`、`./lib/languages/*` 映射到 ESM（`es/`），`./styles/*` 亦已导出；`@profoundlogic/hogan` 只有 CJS 入口（`main`，无 `module` / `exports`），需打包器的 CJS 互操作，也别指望它被 tree-shake
- **拉起浏览器时 token 经过命令行，且 argv 不因属主不同而被遮蔽**（macOS 26）：以真流程启动并让它真的 `open` 那个 URL，同时用**紧循环**反复 `ps -Ao args=` 采样——token 的 secret 部分在 **t=31ms** 那一拍出现在 `open` 自己的 argv 里，命中 1 拍，此后不再出现（已在运行的浏览器经 LaunchServices 收 URL，不进 argv）。另实测 `ps -Ao user=,args=` 读得到 **root 进程的完整参数**。**250ms 一拍的粗采样连打 24 次一无所获**——粗采样的「没抓到」不构成反证。Linux 那侧仍未实测
- **三道校验的渗透式复核**（对构建产物，逐条见冒烟用例）：15 种 Host 变体（伪装成后缀 / 前缀的攻击者域名、大写、尾点、错端口、`[::1]`、十进制 `2130706433`、`0.0.0.0`、`127.0.0.2`、空值等）一律 403，合规两个 200；HTTP/1.1 缺 Host 头由 Node 的解析器直接 400；**双 Host 头 Node 只认第一条**，故无法靠追加一条绕过。`Origin: null` 与攻击者 Origin 403，响应无任何 `Access-Control-*`。**`fetch` 测不了这一组**：undici 按 fetch 规范把 `Host` 列为禁止头并静默改写，拿它打整栏都是假 200，必须用裸 `node:http` / socket。另实测 `//evil.com/…` 形态的请求行只影响 `url.pathname`，302 的 `Location` 仍是纯路径，不构成开放重定向
- **CSP 的 `frame-ancestors` 是唯一挡住嵌套的那一道**（真实 Chrome）：从**同机另一个端口**的页面 iframe 嵌套本服务——iframe 导航不带 `Origin`、Host 又是合规的 `127.0.0.1:<port>`，而 cookie 的 site 是 `127.0.0.1`（端口不分 site），于是 `SameSite=Strict` **不阻止**它发出，三道校验全过、网络层实测拿到 **200**；浏览器仍拒绝渲染（父页面 `contentDocument` 为 null），父页面的 `fetch('/api/state', {credentials:'include'})` 则被无 CORS 头挡掉。页面自身零内联脚本、console 无任何 CSP 违规——即不开 `'unsafe-inline'` 确实跑得起来
- **冷启动实测**：node 启动 + `http.listen` + 一次 `git status --porcelain=v2 --branch -uall -z` 全程约 **30ms 墙钟**（裸 node 启动约 10-30ms），300ms 预算充裕。**浏览器侧**：`app.js` / `app.css` 各 1ms 内取完，`/api/state` 在 **47ms** 返回，`first-contentful-paint` **56-72ms**（三次刷新），列表 18 行全部就位——1s 预算的十几分之一
- **npm 的重名判据是归一化后的名字，不是精确名**：npm 把包名小写化并去掉 `-` `_` `.` 再与已有包比对，因此原定的 `gitglance` 尽管 `GET /gitglance` 返回 404，却与他人已占用的 `git-glance` 归一同名，发布时会被 registry 以 “too similar to existing package” 拒绝。**只查 404 是查不出重名的**。`difftab` 连同 `diff-tab` / `diff_tab` / `diff.tab` 四个变体逐个核过均为 404；去掉 `git` 前缀同时避开了 Git 商标政策对「以 git 开头命名软件」的建议
- **`bin/difftab.js` 的可执行位为什么只能钉在仓库记的 mode 上**（macOS 实测）：在**本仓库目录里**跑 `npx difftab` 时，npm exec 认出 cwd 的 `package.json` 自己就叫 `difftab`、带同名 `bin`，于是压根不去 registry 取包，而是建一条 `file:<仓库路径>` 依赖，npm 的 `bin-links` / `fixBin` 随即把 bin 目标 `chmod 0755`——**被改的就是工作区里那个真文件**。而 registry 上的 tarball 里恒为 `-rwxr-xr-x`（pnpm pack 把 bin 归一，与仓库 mode 无关），CI 每次全新 checkout 也不保留本地 chmod：**三条已有路径对这件事全部免疫**。**「拿不到记录一律 FAIL」那半也单独验过**：`git ls-files -s` 对未跟踪路径是 exit 0 + 空 stdout
- **pnpm 11 相对 10 的破坏性变更，恰好全部打在配置面上**（就 pnpm 11 实测 + 官方迁移文档复核），因此本项目按 11 而非 10 落地：
  - **`onlyBuiltDependencies` 已被移除**：与 `neverBuiltDependencies` / `ignoredBuiltDependencies` / `onlyBuiltDependenciesFile` / `ignoreDepScripts` 一并合并为单一的 **`allowBuilds`** map（`{ 包名: true | false }`）
  - **配置文件位置**：不再读 `package.json` 的 `pnpm` 字段，也不再把 `.npmrc` 当通用设置文件（只留 registry 与鉴权）；pnpm 专有设置一律走 `pnpm-workspace.yaml`，原 kebab-case 键改为 camelCase，环境变量前缀由 `npm_config_*` 改为 `pnpm_config_*`。**写错位置不报错、无 deprecation 警告，只是设置静默不生效**（pnpm/pnpm#11536 记录了 `pnpm.overrides` / `pnpm.patchedDependencies` 被静默忽略的实例）
  - **因此每条设置都要一次正面对照**：`publishBranch: main` 那组是这么验的——临时仓库里它直接过检查并打印 `📦 name@version → <registry>`，改成 `release` 后同一条命令停在分支确认上，**即那个 camelCase 键确实被读到了**。没有对照时「没报错」与「设置生效了」长得一模一样
  - **`pnpm publish` 不再委托 npm CLI**（`login` / `view` 等同理），于是它**不认 npm 的登录态**，而那时的报错完全不像认证问题：`npm whoami` 有回应、`~/.npmrc` 里有 `_authToken`，`pnpm publish` 仍回 `[E404] 404 Not Found - PUT …`——**npm 对「不允许的写」在包还不存在时回 404 而不是 403**，于是错误长得像「包找不到」。判据是 `pnpm whoami`，补 `pnpm login` 之后错误换成 `ERR_PNPM_OTP_NON_INTERACTIVE`，那条才说实话。它另自带 git 检查、照常执行 `prepublishOnly`，2FA 为 `auth-and-writes` 时无法非交互跑
  - **manifest obfuscation 的实测范围比想象的窄**（发 0.1.0 时对着发出去的产物核对）：剥掉的只有 `packageManager` 与 `prepublishOnly` 两项，其余 `scripts` 与整份 `devDependencies` 原样发布——核对产物时别把这份差异误判为不干净。步骤照 `RELEASING.md` 走

**被排除的做法**

| 做法 | 排除原因 |
|---|---|
| 不引入前端框架与构建链路（纯 HTML + 原生 JS + CSS） | 三个支点全部不成立：**「加快启动」**——构建只发生在发布期，用户拿到的是构建产物，冷启动门禁与有无构建链路无关；**「减小体积」是反的**——无构建链路时只能用 diff2html 的预构建 bundle，其 slim 包 302 KB 里含大量用不到的 hljs 语言定义，有 tree-shaking 后可按需 import 并显式控制语言子集；**「状态复杂度低」低估了一处**——SSE 刷新要求在不丢失当前选中文件与滚动位置的前提下更新列表，而单次变更 300+ 文件是常态，整树 `innerHTML` 重建会闪烁并跳滚动，不重建则要手写一份按 path 的 keyed reconcile，那正是框架存在的理由 |
| 用 React 19 或 Svelte 5 代替 Preact | React 19 的 ~42 KB gzip 对一个只读三区块界面是明显溢价（Preact 约 4 KB）；Svelte 的劣势在工具链而非体积，与「一个二进制一份配置」的取向冲突 |
| 用任何 diff2html 预构建 UI bundle（`-ui` 1.05 MB / `-ui-slim` 302 KB / `-ui-base` 90 KB） | 三者的存在理由是「无构建环境下只能整包引入」，引入构建链路后已消失；改为按需 import + 显式注册语言子集，产物更小且语言清单可控。**被排除的是三个预构建 bundle，不是 UI 层源码**——深导入 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 是允许且推荐的 |
| 自行重写 diff2html 的高亮切分逻辑 | 需要把整文件高亮结果按 diff 行边界切回并补齐跨行未闭合标签；上一行既已允许深导入源码模块，自研等于维护一份更易出错的等价物 |
| 单独 import `highlight.js/lib/languages/{jsx,tsx,toml}` | 这三个模块不存在（实测 404），它们是 `javascript` / `typescript` / `ini` 的**别名**，注册主模块时自动生效；写了会在构建期 resolve 失败 |
| 把两份 hljs 主题 CSS 平铺 import | 两者都是无条件的 `.hljs { … }`、自身零 `@media`，后引入者无条件覆盖前者，浅色主题直接失效；深色那份必须带 `(prefers-color-scheme: dark)` |
| `outputFormat` 按**视口**宽度判（`matchMedia`） | 面板宽度恒等于「视口 − 320」，按视口判等于把侧栏宽度这个常数在 CSS 之外再写一遍；侧栏一改阈值就静默错位，页面照常渲染、只是切换点不对 |
| 量面板的 content box（`contentRect` / `contentBoxSize`）判阈值 | 面板是 `overflow:auto` 容器，换格式改变内容高度 → 滚动条进出 → content box 宽度抖十几像素，阈值落在抖动区间里时两种格式来回重画。**滚动条是从 content box 里扣的**，border box 不随它进出而变 |
| 给用户加一个 side-by-side / line-by-line 手动开关 | 自动判据已覆盖「放不放得下」这个唯一的真实诉求，而加开关要引入一份需跨会话保持的用户偏好，以及「自动值与用户值谁优先」这条状态。首版不做，不是长期不做 |
| 未跟踪文件用 `git diff --no-index` | 依赖 `/dev/null` 作对比端，Windows 上不可移植 |
| 空树哈希用 `git hash-object -t tree /dev/null` | 同上，`/dev/null` 不可移植；`git mktree` 则会写对象库，违反只读承诺 |
| Linux 上直接用不带 `ignore` 的 `fs.watch({recursive:true})` | Node 在 Linux 是用户态实现，逐条目（含普通文件）注册 inotify 且不做排除，会耗尽 `max_user_watches` 并波及用户机器上的其他工具。**这正是 C 档在低版本 Linux 上宁可退回轮询、也不建递归 watch 的原因** |
| Linux 上自行遍历目录树逐个注册 watch（手写一份递归监听） | Node 24.14.0 的 `ignore` 在 Linux 上即为注册前跳过，官方能力已覆盖。**被排除的是「手写 Linux 递归注册」，不是「按平台/版本选策略」**——后者正是三档方案本身 |
| 用 try/catch 或传入选项后观察行为来探测 `ignore` 是否可用 | 探测要成立得依赖「支持的版本上传非法 `ignore` 会抛、不支持的版本上因选项被忽略而不抛」这一**未文档化的内部细节**，一次校验时机调整就会让它把 A 档误判成 C 档、或把 C 档误判成 A 档——后者在 Linux 上正是上一行禁止的无 `ignore` 递归 watch。`process.versions.node` 的 semver 比对无此风险 |
| B 档把 `isIgnored` 过滤放在 debounce 之后 | 放其后则 `node_modules` 的写入噪声照样顶开 debounce 窗口、刷新照旧触发，过滤形同虚设 |
| `ignore` 模式写成 `node_modules/**` 等含斜杠形式 | 含斜杠会使 `matchBase` 失效：既匹配不到目录自身，也匹配不到 monorepo 里嵌套的 `packages/*/node_modules`，两头落空 |
| `ignore` 传不含斜杠的字符串 basename 模式 | macOS / Windows 的原生 watcher 交给匹配器的是事件的**相对路径**，basename 对不上模式，过滤在这两个平台上完全失效（判据见上方 minimatch 那条）。必须传逐段匹配函数，三档共用 |
| 降级轮询用裁剪过参数的 `git status`（省掉 `-uall` / `--branch`） | 省掉 `-uall` 后 git 把未跟踪目录折叠成一行 `dir/`，**在一个已存在的未跟踪目录里新增文件不改变输出**，轮询判「无变化」——而这正是 agent 边跑边生成文件时最常见的形态；省掉 `--branch` 则丢掉提交与切分支的检测 |
| 只靠 `-z` 解决路径转义 | `-z` 管不到 `git diff` 补丁正文的头部行，非 ASCII 路径仍会显示为 `\351\234\200` 转义串，须叠加 `-c core.quotePath=false` |
| 重命名文件按单路径取 diff | git 只看到一侧无法配对，重命名会退化成全新增文件，「重命名识别并标注」落空 |
| 单实例注册表写进 `.git/` 或工作区 | 污染 `git status`，实质违背零写操作承诺 |
| 陈旧实例用 pid 存活判断 | pid 会被系统复用，误判会把用户带到指向别人进程的页面 |
| 空闲宽限期「等第一个客户端连上之后才开始计」 | 把「浏览器压根没拉起来」（headless、无 `xdg-open`、`--no-open` 后用户改主意）整类情形变成永久常驻的后台进程；从启动即开始计，再由「任何请求都重置计时」补住误退的一侧 |
| 无订阅者时暂停降级轮询、有订阅者时恢复 | 省下的是 45 秒宽限期内至多约 30 次 `git status`（空闲退出已给它封顶），换来一个「恢复」分支——漏掉时的症状是**页面连上了却永远不刷新**，既不报错也没有门禁看得见 |
| 仅用 token 防 DNS rebinding | token 挡不住同源判定本身，正面防御是校验 `Host` 头 |
| 用「前后 `git status` 比对」验证只读性 | 发现不了写进 `.git/` 但不改变 status 输出的操作 |
| 只读性主门禁用 PATH 上的 fake git wrapper | Windows 上落不了地：`.cmd` / `.bat` 被 Node ≥ 20.12 的 spawn 直接拒绝，`node.exe` 复制成 `git.exe` 则被 node 自己的 CLI 解析吃掉参数（两条均已实测，见上）。改用 `GIT_TRACE`，三端同一套写法，且连 git 内部再起的子进程一并入账 |
| 用 Tailwind 工具类覆盖 diff2html 渲染出的内部元素 | diff2html 的 CSS 是 unlayered，在层叠中胜过 `@layer utilities`，工具类写了不生效；改配色只能覆写 `--d2h-*` |
| 把 hljs 主题或 `diff2html.min.css` 放进 `@layer` | 一旦入层就与 preflight 同处层叠体系，「无层胜有层」这层结构性保障随即失效，退回逐条比特异性的脆弱状态 |
| 用 tarball 里的 bin mode（`check:pack` / `check:global` 那两道）来保证可执行位 | pnpm pack 无条件把 bin 归一成 0755，查它等于查一个恒真命题；真正会丢的是**仓库自己记的 mode**，而它不经过 tarball。**只查 index 同样不够**：`--chmod=+x` 只写暂存区，fresh clone 拿的是 HEAD，而 CI 上 index 恒等于 HEAD——只查 index 的版本恰好在它唯一要保护的地方（开发者本机）最弱 |
| 让 `bin/difftab.js` 参与 TS 编译或作为打包入口 | 可能被注入超出 Node 22 的语法、或被合并进主模块，低于下限的用户拿到解析期 SyntaxError，版本守卫随之失效 |
| 为本地开发在后端加放宽 Host / Origin / token 校验的环境变量或分支 | 等于把正面防御做成一个可被误开的开关。dev server 的跨源问题应在代理层改写请求头解决，后端零 dev 分支 |
| 依赖 Node 原生 type stripping 直接运行 `.ts` 产品代码 | 会把运行时下限从 22.0.0 顶到 22.18，且每次启动都要付一次转换开销，挤占 300ms 冷启动预算。产品代码一律发布为已转译的 JS |
| pnpm 开 `shamefullyHoist: true` 或 `nodeLinker: hoisted` | 用扁平化掩盖 phantom dependency：本机构建通过，换到别人机器、CI 或改依赖版本后才 resolve 失败，而那时问题已离开引入它的那次改动。深导入 diff2html 内部模块的方案更需要这层校验 |
| 把 pnpm 设置写进 `package.json` 的 `pnpm` 字段或 `.npmrc` | pnpm 11 两处都不再读取，**且是静默忽略、无 deprecation 警告**：`allowBuilds` 写错位置即等同于没写（hooks 静默不装），禁止扁平化的设置写错位置即等同于没禁 |
| matrix 作业用 `pnpm install --prod` 之类的「装一点点」代替完全不装 | 仍会建 `node_modules`、且要求每台 matrix 机器上有 pnpm，而该作业的全部意义是只跑用户真正拿到的 `dist/`；一旦装了东西，测的就不再是那个东西 |
| 靠 `corepack enable` 在 CI 里准备 pnpm | Corepack 已不再随 Node 25+ 发行版分发而 CI 矩阵含 Node 26；哪天基础镜像不再自带，这一步就从「能用」变成失败或静默走到系统里的另一个 pnpm 版本 |

**外部参考**

- [Node.js `fs.watch` 文档：recursive 支持范围与 Caveats](https://github.com/nodejs/node/blob/v24.x/doc/api/fs.md)
- [nodejs/Release `schedule.json`：各版本 LTS / 维护期 / EOL 日期](https://github.com/nodejs/Release/blob/main/schedule.json)
- [nodejs/node PR #45098：为 Linux 添加 recursive watch](https://github.com/nodejs/node/pull/45098)
- [nodejs/node PR #61433：为 `fs.watch` 添加 `ignore` 选项（Node 24.14.0）](https://github.com/nodejs/node/pull/61433)
- [nodejs/node `lib/internal/fs/recursive_watch.js`：Linux 用户态递归监听实现](https://github.com/nodejs/node/blob/v24.x/lib/internal/fs/recursive_watch.js)
- [递归 watch 逐目录注册 inotify、无排除导致耗尽内核配额的实例](https://github.com/colbymchenry/codegraph/issues/276)
- [MDN：CSS Cascade Layers——无层声明与层内声明的优先级](https://developer.mozilla.org/en-US/docs/Web/CSS/@layer)
- [pnpm v10 → v11 迁移指南：`allowBuilds`、配置文件位置变更](https://pnpm.io/migration)
- [pnpm/pnpm#11536：pnpm 11 静默忽略 `package.json` 的 `pnpm` 字段](https://github.com/pnpm/pnpm/issues/11536)
- [Node.js TSC 投票停止随发行版分发 Corepack](https://socket.dev/blog/node-js-tsc-votes-to-stop-distributing-corepack)
