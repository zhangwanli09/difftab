# git 行为

> 收录规则与实测环境见 [`README.md`](README.md)。

- **空仓库用硬编码的空树哈希作基准，不为它写特殊分支**：空仓库里 `git diff HEAD` 报 `fatal: ambiguous argument 'HEAD'`、`rev-parse --verify HEAD` 以 128 退出，而 `status --porcelain=v2 --branch` 正常返回（`# branch.oid (initial)`）、`git diff <空树哈希>` 正常出结果，SHA-256 仓库上 numstat 与补丁同样正常。两个常量的取值用 `git hash-object -t tree --stdin < /dev/null` 的**读形态**在 fixture 生成期取得，产品代码里只有硬编码值。
- **`rev-parse --show-object-format` 非零退出即按 SHA-1 降级，无歧义**：它随 SHA-256 支持在 git 2.29 前后才引入，**高于 git 下限 2.11**——那个区间的 git 根本造不出 SHA-256 仓库。
- **进行中的操作按 git 目录下的状态文件判，且 rebase 必须先于 merge**：rebase 冲突停下时留下 `rebase-merge/`，**外加** `MERGE_MSG` 与 `AUTO_MERGE`——rebase 的痕迹里带着 merge 的那几个，反序会把 rebase 标成 merge。其余形态：merge 冲突 → `MERGE_HEAD` / `MERGE_MODE` / `MERGE_MSG` / `AUTO_MERGE`；`rebase --apply` 冲突 → `rebase-apply/`（内含 `rebasing`）；cherry-pick / revert → `CHERRY_PICK_HEAD` / `REVERT_HEAD`；bisect → `BISECT_LOG` 等四个文件。
- **`operation` 与 `detached` 是同时出现的两件事，不是二选一**：rebase 停下时 status 报 `# branch.head (detached)`，冲突文件是一条 `u UU N... … f.txt`（10 个前导字段 + 路径占一个 NUL 段）。
- **冲突文件不需要特殊分支**：`diff HEAD --numstat -z -- f.txt` 正常给出 `4\t0\tf.txt`，`diff HEAD -- f.txt` exit 0 且正文就是带 `<<<<<<< HEAD` / `=======` / `>>>>>>>` 的工作区内容。
- **状态文件只能按 `rev-parse --git-dir` 找**：linked worktree 的 `.git` 是一个内容为 `gitdir: <主仓库>/.git/worktrees/<名>` 的**文件**（submodule 同理指向 `<父仓库>/.git/modules/<路径>`），而 `--show-toplevel` 在两者下照常给出各自的工作区根。submodule 在父仓库里是一条 `1 .M S.MU 160000 …` 记录，走的是已有的已跟踪路径；bare 仓库的 `--show-toplevel` 以 **128** 退出，据此一句话拒绝。
- **`-z` 与 `-c core.quotePath=false` 互补、不可相互替代**：不加 `-z` 时 status 把 `docs/需求文档.md` 输出成 `"docs/\351\234\200\346\261\202\346\226\207\346\241\243.md"`；而 `-z` 管不到 `git diff` 正文，`diff --git` / `---` / `+++` / `rename from|to` 头部行照样 C 风格转义。
- **两种 `-z` 记录的实测形态**（解析器判据的来源）：`porcelain=v2` 的重命名是 `2 <XY> … R100 <新路径>\0<旧路径>`（两段，新在前）；`diff --numstat -z` 的重命名是**空路径 + `<旧路径>` + `<新路径>`**（三段，顺序与前者相反）。另：二进制记录两个计数都是 `-`；未跟踪路径 numstat 输出为空且 exit 0，故它能兼任「已跟踪」判据；无上游分支时不输出 `# branch.ab` 行。
- **重命名取 diff 必须传新旧两个路径**：`diff HEAD -- <新路径>` 输出的是 `new file mode` + `--- /dev/null`，`-M -- <新> <旧>` 才输出 `similarity index` + `rename from/to`。
- **numstat 要按路径挑、按合计算**：`git mv` 后把新文件重写成 60,000 行且**不 add**，`-M -- <新> <旧>` 回 `0\t20\t<旧路径>` 与 `60000\t0\t<新路径>` 两条按路径排序的记录（NUL 分隔），而 status 仍报 `R100`——取 `[0]` 拿到的是旧文件那条几十行的删除，行数闸随即放行。
- **pathspec 默认是 wildmatch 而不是字面路径**：仓库里同时有 `docs/star*.md` 与 `docs/starlight.md` 时，`diff HEAD --numstat -z -- 'docs/star*.md'` 回**两条**记录，`-- '*'` 回全部改动文件；设 `GIT_LITERAL_PATHSPECS=1`（自 git 1.9 即有）后都只按字面比较。
- **`ls-files --directory` 的 pathspec 深过折叠层时 git 直接 fatal**：`-- node_modules/.pnpm/@biomejs+biome@2.5.7` 报 `fatal: git ls-files: internal error - directory entry not superset of prefix`（exit 128），而 `-- node_modules` 与 `-- node_modules/.pnpm` 都正常回一条 `node_modules/`。判据是**层数不是路径里的 `@`/`+`**（`-- node_modules/.pnpm/node_modules` 同样 fatal）：git 拿全部 pathspec 的公共前导目录当前缀（`a/b/c` → `a/b/`），而它要吐的条目是 `node_modules/`，吐之前那道断言要求前缀不比条目长。因此深度 ≥ 3 必炸、深度 ≤ 2 恒安全。**`-C` 进那个目录、pathspec 带尾斜杠都绕不过**（三种写法实测同样 fatal），能绕的只有「pathspec 不含 `/`」——前缀因此为空。**只有 `--ignored` 那条炸得起来**：它报的是排除规则命中的那一层，与 pathspec 有多深无关；不带它的那条从 pathspec 处开始遍历，最高只折叠到 pathspec 自己（`-- fresh/deep/deeper` 回 `fresh/deep/deeper/`），永远不比前缀短。
- **`for-each-ref` 的实测形态**（`refs.ts` 解析器判据的来源，git 2.54）：没有 `-z`，记录之间是换行；格式里每个字段（含最后一个）都以 `%00` 收尾，于是按 NUL 切开后每条恰好十一段、下一条的 refname 前面带一个换行——与 `log -z` 剥前导换行同一个处理。`%(subject)` 把首段多行用空格连成一行（`line one\nline two` → `line one line two`），不会把换行带进记录。克隆出来的仓库有一条 `refs/remotes/origin/HEAD`，`%(symref)` 为 `refs/remotes/origin/main`，其余条目这一段为空——据此滤掉。附注标签的本体字段是标签对象（`%(authorname)` 与 `%(committerdate:unix)` 都为空、`%(subject)` 是标签说明），`%(*…)` 那几段才是它指向的提交；轻量标签的 `%(*…)` 全空；指向树的标签两组都空。
- **只读 `.git` 挡不住 index 回写，只是让它静默失败**：`touch` 一个内容未变的已跟踪文件后，默认 `git status` 把 `.git/index` 重写一遍，设 `GIT_OPTIONAL_LOCKS=0` 则不变；而把 `.git` 整棵 `chmod -R a-w` 之后再跑同一条默认 `git status`，它 **exit 0、stderr 全空**，只是没写成——所以收紧权限既替代不了那个环境变量，也不能拿来验只读性。
- **超限掐断 git 之后，Windows 上先到的是 `'error'` 而不是 `'close'`**：`maxStdoutBytes` 触发后 `child.kill()`，**windows × Node 22.0.x 那一档**随即走进 `'error'` 分支，`GitError.kind` 因此是 `exit` 而不是 `overflow`、`/api/diff` 回 500 而不是 `too-large`（另外八档不触发）。
- **补丁两个可选档的实测形态**（git 2.54，2026-10-16）：只改了空白的文件（`one\ntwo` → `one  \n  two`），`diff -w HEAD -- f` 与 `diff -w HEAD --numstat -z -- f` **都是空输出、exit 0**——连 `diff --git` 头都没有，后一条恰好与「未跟踪」同形；`-b` 下 `x` → `  x` 照报 `-x` / `+  x`，`-w` 才认作没改；`-w` 下缩进从 2 改到 4 的上下文行输出的是 4 个空格那一版（新侧）。`-c diff.context=0` 让 `diff HEAD` 只剩 `@@ -15 +15 @@`、上下文消失，`-c diff.interHunkContext=5` 把相隔 7 行的两处改动并成一个 `@@ -2,15 +2,15 @@`；命令行再带 `--unified=3 --inter-hunk-context=0` 时两条配置都被盖过，回到 `@@ -2,7 +2,7 @@` 与 `@@ -10,7 +10,7 @@`。30 行的文件改一行，`--unified=50000` 给出一个 `@@ -1,30 +1,30 @@`。
- **`git grep` 的几种实测形态**（git 2.54）：配了 `grep.column=true` 时 `-z` 记录变成 `<路径>\0<行>\0<列>\0<内容>`，命令行再给一次 `-c grep.column=false` 即回到三段；配了 `submodule.recurse=true` 时 `grep --untracked` 报 `fatal: --untracked not supported with --recurse-submodules` 并以 128 退出，再给 `-c submodule.recurse=false` 即正常；`grep.patternType=perl` 被命令行的 `-F` 盖过（`h.llo` 不命中 `hello`）；不带 `-I` 时二进制文件输出一行 `Binary file bin.dat matches`、不带任何 NUL；工作区已删的已跟踪文件被静默跳过、exit 0；没有命中时 exit 1。把一个已跟踪文件的 stat 弄旧后跑 `grep`，`.git/index` 逐字节不变，同一状态下默认 `git status` 重写了它。

## 被排除的做法

| 做法 | 排除原因 |
|---|---|
| 目录树整体以 `readdir` 遍历工作区 | 要把「仓库边界 + 不跟随符号链接 + `.gitignore` 语义」三件事全部重写一遍——最后那件等于在产品里塞进第二份 git 知识，而它不受只读门禁覆盖；`.git/` 与 `node_modules` 也得自己滤。`ls-files` 已在只读白名单里，三件事一次都不用写。**被排除的是「整体这么做」**：`--directory` 折叠掉的那一层 git 答不出内容，那一处读一层磁盘是唯一的兜底，而它落在「整棵子树已被 git 判为同一档」之后，一条 `.gitignore` 语义都不需要重写 |
| 目录树一次性返回整棵树 | 与「禁止一次性取全仓 diff」同一条理由，且更糟：`node_modules` 让一份全量树的 JSON 比整仓 diff 还大，而它每次 SSE 刷新都要重发一遍 |
| 目录树那处兜底把 `readdir` 的错误一律咽成「空目录」 | 「读不了」会伪装成「里面是空的」。只对 `ENOENT` / `ENOTDIR` 回空（目录刚被删是 agent 跑动期间的常态），`EACCES` 一类照抛 |
| 只读读文件走 `git show` / `git cat-file` | 树上点得到的路径包含未跟踪与被忽略的文件，它们在对象库里根本没有对应的对象；而已跟踪文件要看的也是**工作区**那一份，不是 index 或 HEAD 那一份 |
| 图片旧侧用 `git show <base>:<path>` 取字节 | 字节上两者一样——实测（`*.bin diff=conv` + `diff.conv.textconv`）`show HEAD:x.bin` 与 `cat-file blob HEAD:x.bin` 都给原文、只有 `cat-file --textconv` 给转换结果，textconv 在两者上都是显式开关。差别在 `show` 是 porcelain：带整套 log / diff / pretty 参数面，冒烟里那条「子命令之后只能是 `blob` / `-s`」的字面量断言在它身上钉不住；`cat-file` 是专门读对象的 plumbing，参数面就那几个 |
| 把提交历史列为不做 | 实际使用里暴露的痛点：agent 跑完常常自己 commit，工作区一干净 difftab 就什么都看不到，想回顾「刚才这几步改了什么」只能回终端敲 `git log -p`。这是「瞥一眼」的同一个诉求换了个时刻，不是 GitLens 式的深度追溯（分支列表后来另有理由放开，见下） |
| 把分支列表列为不做 | 原先的理由是「切换属写操作范畴」——那说的是**切换**，不是**看**。列表本身是纯读，而真实诉求是「agent 开了哪些分支、远端有什么、最近一个 tag 叫什么」，回答它不需要动仓库一个字节。选中之后**复制名字**而不是做任何事：checkout 仍属长期不做，用户拿着名字去终端里自己切 |
| 选中一项在 History 里打开那个 ref 的提交 | History 的锚点、自动刷新判据（HEAD 挪没挪）都是围着「HEAD 可达」这一件事建的；换成任意 ref 要给它再加一层「当前看的是谁」的状态与回到 HEAD 的入口。复制名字零状态，且是用户确认过的取舍 |
| 提交里单个文件的补丁用 `git show <sha> -- <path>` | 与图片旧侧不用 `show` 同一条理由：带整套 log / diff / pretty 参数面，「argv 只能是这几个字面量」那条断言钉不住；而 `diff <parent> <sha>` 本就在白名单里，三道闸、按路径挑 numstat、重命名传两个路径全部原样复用 |
| 一次提交的文件清单用 `git diff-tree` | 又一条白名单，换来的东西 `diff <parent> <sha> --name-status` 都给得出；且 `diff-tree` 对合并提交默认什么都不输出，要另配 `-m` / `--first-parent` 才说得出话，多一个要钉的参数面 |
| 父提交用 `rev-list --parents` / `rev-parse <sha>^` 取 | 前者是第二条新白名单；后者对根提交非零退出，要把「没有父」与「坏请求」从退出码里分开。单条提交那次 `log` 本来就要取元数据，`%P` 顺手带回全部父提交，零额外进程 |
| 只读承诺只靠「子命令白名单 + 只读 `.git` 跑一遍」来证 | 两个陷阱都穿得过去：partial clone 的 lazy fetch 与 textconv 的 `cachetextconv` 都发生在白名单里的 `diff` / `cat-file` 之内，不让命令失败、不改输出；锁死的 `.git` 下 git 把写入当 best-effort，取不回来、写不进去也照常 exit 0。实测（git 2.54）：`blob:none` 克隆里 `git diff <旧> <旧>` 让 in-pack 从 7 变 9，`GIT_NO_LAZY_FETCH=1` 下以 128 退出、一个对象都不多；补丁形态的 `git diff`（工作区与提交都是）写出 `refs/notes/textconv/<驱动>`，`--numstat` / `--name-status` 不写，带 `--no-textconv` 一条都不写。所以第二层 B 半另有一个专门布了这两个陷阱的仓库，并带一条默认环境下确实写了库的正面对照 |
| 提交列表末尾放一枚 `Load more` 按钮，不自动取 | 第一版的做法，理由是「滚到底自动取会在不经意间把列表拉到几百条」。实际用起来是多一次点击、且与 VS Code Source Control Graph 不一致；而自动取同样要有人滚到底才发生，DOM 的增长仍由用户驱动，agent 跑动时列表不会自己变长 |
| 提交说明正文（`%b`）按需另取——展开或悬停时再问 | 悬停提示是原生 `title`，没有「悬停时异步填进去」这回事，要么自绘卡片、要么提前备好。列表那次 `log` 加一段 `%b` 是零额外进程，一页 50 条正文的体积可以忽略 |
| HEAD 一挪就以新的第一页整体替换列表 | 翻到 200 条之后 agent 提交一次，列表缩回 50 条、滚动位置跳走，而那正是「边跑边看」最常见的时刻。新 HEAD 只是在旧 HEAD 之上多长了几条时接在顶上即可；锚点不动、只记新长出来几条（`offset`），翻页照旧从原锚点数 |
| History 的 ref 徽标从 `log` 的 `%D` 取 | 徽标会跟着列表一起缓存，而列表只在 HEAD 挪了时重取：`git push` 只挪 `origin/main`、不挪 HEAD，徽标就停在推送前那一行，页面不报错、只是「还没推送」的界线画错了地方。`log` 那条字面量 argv 也得为它多钉一段。上游的 oid 用已在白名单里的 `for-each-ref` 取、按分支状态变没变来判，push 之后 ahead 归零那一刻就重取 |
| 按 `ahead` 计数把列表顶上 N 条标成「未推送」，不取 ref | 只在线性历史上成立：`log` 默认按提交时间排而不是按拓扑，HEAD 侧有合并时，从别的分支并进来的、早已推送的提交会与未推送的交错排列，顶上 N 条就不是那 N 条。上游那枚徽标落在它真正指着的那一行，不需要推断 |
| History 画全部分支与标签的徽标 | VS Code 的默认档（`filter`）也只画图里那几条 ref；320px 一行里多一枚徽标就从主题上再扣一截，而「瞥一眼」要回答的只是「哪些还没推」。要看别的 ref 有分支列表 |
| 全仓搜索支持正则（照 VS Code 的第三枚开关） | git 下限 2.11 上能用的只有 POSIX ERE（`-P` 要 git 编进了 PCRE，各发行版不一），而命中区间要在 JS 里重找一次：ERE 与 JS `RegExp` 的语义差（字符类、反向引用、`\b`）会让高亮静默漂开。字面量在两边是同一件事 |
| 用 `--column` 拿命中列、`-m` 限每个文件的命中数 | 分别要 git 2.19 / 2.38，下限是 2.11。列由后端拿同一个字面量在 JS 里找（区间本来就要算），数量上限靠 stdout 截断 + 行数上限 |
| 全仓搜索也搜被忽略的文件（`--no-exclude-standard`） | `node_modules`、`dist/` 会淹没结果，且一次就把整棵依赖树读一遍；VS Code 的默认档同样不搜。要搜依赖里的东西回编辑器 |
| Quick Open 的文件列表复用目录树那条 `--others --directory` | `--directory` 把未跟踪目录折叠成一条 `dir/`，Quick Open 要的是文件，折叠了就打不开；被忽略的那条更不能要 |
