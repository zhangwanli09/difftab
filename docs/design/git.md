# git 交互与异常状态

> 产品运行时在**用户仓库**里执行的 git 命令，全程只读。门禁见 [`../gates.md`](../gates.md)，实测证据见 [`../decisions.md` 的「git 行为」](../decisions.md#git-行为)。

## 基准与数据源

- diff 基准是 **`git diff HEAD`**，不是 `git diff`——agent 执行过程中可能自行 `git add`，`git diff` 会漏掉已暂存的改动，而「相对上次提交改了什么」才是本工具要回答的问题。
- 文件列表以 **`git status --porcelain=v2 --branch -uall -z`** 为唯一数据源，一次调用同时拿到文件状态、暂存/未暂存双状态位、重命名信息与分支 ahead/behind。两个参数都不能省：
  - `-uall`：否则 git 把未跟踪目录折叠成一行 `dir/`。
  - `-z`：否则含非 ASCII、空格、引号的路径会被做 C 风格转义并加引号。加 `-z` 后改为 NUL 分隔、路径原样输出。**所有取路径的列表类调用**（`ls-files`、`diff --numstat` 等）一律加 `-z`，按 NUL 切分而非换行。

## 封装层统一注入的三件事

这三条都写在 `server/git` 的封装层，不留给各调用点自己记得加。

- **`-c core.quotePath=false`**（所有 `git diff` 调用）。`-z` 只作用于列表输出，**管不到补丁正文**——正文里的 `diff --git` / `--- ` / `+++ ` / `rename from|to` 头部行仍会 C 风格转义，而 diff2html 恰恰从这些行解析文件名，不处理就会在界面上直接显示 `\351\234\200` 转义串。两者互补，不可相互替代。
- **`GIT_OPTIONAL_LOCKS=0`**。`git status` 默认会把刷新过的 stat 缓存写回 `.git/index`——它**不改变 status 输出**，所以只读白名单与「前后 `git status` 比对」都看不见。只读 `.git` 下它也只是静默跳过、exit 0、stderr 全空。看得见它的只有两处：`.git` 逐字节快照比对，以及「读一次 `/api/state` 不引出刷新事件」那条（写 `.git` → 推 `change` → 前端再读一次，是个自激循环）。
- **`GIT_LITERAL_PATHSPECS=1`**。`--` 后面的路径默认按 wildmatch 解释，而我们的路径来自 URL query：`path=*` 会让 `git diff HEAD -- '*'` 回一份**整仓 diff**，一个真实存在、名字里带 `*` 的文件也会匹配到邻居身上，页面在 A 的标题下显示 B 的补丁。本项目的路径无一例外来自 git 自己的输出，不需要任何通配语义。

## `-z` 解析的三个陷阱

- **`porcelain=v2` 的重命名记录占两个 NUL 段**：格式是 `2 <XY> … R<score> <新路径>\0<旧路径>`。解析器不能无状态地按 NUL 平铺切分，遇到 `2 ` 开头的记录必须额外吞掉下一段作为旧路径。
- **`diff --numstat -z` 的重命名记录占三段**：路径字段为空，后面紧跟 `<旧路径>` `<新路径>`——**顺序与 `porcelain` 的 `2 ` 记录相反**（那边新在前）。平铺切分会把路径当成记录。
- **无上游分支时不输出 `# branch.ab` 行**。此时展示为「无上游」，不能默认成 0/0，更不能因取不到字段而崩溃。

## 取 diff

- **按文件懒加载**：列表只做一次 status 调用，diff 在用户点击某个文件时才单独取。**禁止一次性获取或渲染全仓 diff**——agent 单次改 300+ 文件是常态，整仓 diff 会冻结浏览器主线程数秒到数十秒。
- **重命名条目必须同时传新旧两个路径**（`git diff HEAD -M -- <新> <旧>`）。只传新路径时 git 只看到一侧、无法配对，会把重命名**退化成一个全新增文件**。两个路径都来自 `2 ` 记录，无需额外查询。
- **一次 `--numstat` 查询可以回不止一条记录，必须按路径挑、按合计算，不能取 `[0]`**。传了两个路径而 git 配不上对时（`git mv` 后重写内容却不 `git add`——status 照报 `R100`），它会拆成「删旧」+「增新」两条按路径排序的记录：取第一条等于掷硬币，实测拿到的是旧文件那条几十行的删除，于是行数闸放行、一份 6 万行的补丁照旧发给浏览器。二进制同理，挑错记录会让文本文件被报成 `binary`。
- 这两道防线（字面量 pathspec / 按路径挑记录）**各自都有只有它才拦得住的形态**，不可相互替代。

## 已跟踪与未跟踪的分流

- **「已跟踪」的判据是 HEAD ∪ index，不是 index**。已暂存的删除（`git rm` 之后）路径已从 index 摘掉、`git ls-files` 输出为空，但 status 照报 `1 D.`、基准侧也还在——只查 `ls-files` 会把它误判成未跟踪，进而去读一个不存在的文件。
- `--numstat` 那次调用同时兼任「已跟踪」判据（这条路径在不在「基准 → 工作区」的差异里），并顺带把二进制与行数一并给了。
- **未跟踪文件**不在任何 `git diff` 输出内，**手工构造 unified diff**（`--- /dev/null` / `+++ b/<path>`，全部行标记为新增）。**不用 `git diff --no-index`**——它依赖 `/dev/null` 作对比端，Windows 上不可移植。
- **未跟踪那条路读磁盘必须 `lstat` 不得 `stat`**。未跟踪符号链接会进列表、点得到，而 `stat` 跟随链接会让仓库边界校验形同虚设：一个指向仓库外的链接就能把外部文件内容当作新增文件返回。

## 二进制与体积的三道闸

**两道判定在取补丁之前**（numstat 那次调用），不用付出取补丁的代价就能拦下：

- **二进制**：已跟踪文件一律以 numstat 输出为准（`-\t-\t<path>`），这是 git 自身含 `.gitattributes` 配置的判定结果，比启发式探测准确；只有未跟踪文件走 NUL 字节探测。
- **行数上限 50,000**：已跟踪那侧数 numstat 的加+减，未跟踪那侧数文件行数（整份都是新增行）。它挡的是体积挡不住的另一头——超长行数的窄文件体积不大，但逐行构造 diff 与前端渲染同样会卡。

**5MB 那道闸，已跟踪那一侧卡的是「补丁多大」而不是「文件多大」**：已跟踪文件的补丁只含改动与上下文，按文件体积拒绝会让**一个 6MB 的数据文件改一行就再也看不了**，而那正是 agent 最常见的输出之一；反过来行数也替代不了它——「一行 6MB」的文件 numstat 只报 1 行。两者都量不到的东西正是字节，所以这一闸只能由**取补丁那次调用自己带着 `maxStdoutBytes` 去撞**，超限即就地掐断 git。未跟踪那一侧仍按文件体积判——那里整份文件就是补丁，而且省得把它读进来。

顺带闭掉一个缺口：已被删除的文件取不到工作区体积，按文件体积判时它只剩行数那道闸。`lstat` 因此从判据降为**只用于展示**（`DiffPayload.size`，取不到就给 0）。

## 仓库定位与前置检查

- 统一用 `git rev-parse --show-toplevel` 定位工作区、`git rev-parse --git-dir` 定位 git 目录。**不得假设 `.git` 是目录**——linked worktree 下它是一个文件，submodule 同理。
- 启动前置检查：`git` 不在 PATH、当前目录不是 git 仓库、git 版本低于 2.11（`--porcelain=v2` 的最低要求），三种情况均给一句话友好报错，不抛 Node 异常栈。
- **bare 仓库**：`rev-parse --show-toplevel` 直接以 128 退出，据此给一句话拒绝。linked worktree 与 submodule 则照常启动——它们都有工作区。

## 空仓库

空仓库下 HEAD 不存在，`git diff HEAD` 直接 fatal。降级方式是改用**空树对象哈希**作为 diff 基准，无需为此写特殊分支逻辑。

- 按 `git rev-parse --show-object-format` 区分 SHA-1 / SHA-256 两个常量**硬编码**。**不要**用 `git hash-object -t tree /dev/null`（Windows 不可移植），也**不要**用 `git mktree`（会写对象库，违反只读承诺）。
- **`--show-object-format` 本身高于 git 下限 2.11**（它随 SHA-256 支持在 2.29 前后引入），因此**非零退出即按 SHA-1 处理**——那个区间的 git 根本造不出 SHA-256 仓库，降级无歧义，不得让它成为空仓库路径上的崩溃点。
- 取值：SHA-1 `4b825dc642cb6eb9a060e54bf8d69288fbee4904`、SHA-256 `6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321`。凭记忆写死的后果是空仓库下 diff 基准无效，且症状与「空仓库不支持」难以区分。

## detached HEAD 与进行中的操作

- **detached HEAD**：`# branch.head` 的值是字面量 `(detached)`，据此给出 `detached: true`。**前端不得把这个字面量当分支名画出去**——那是 git 的内部表述，不是分支。
- **进行中的多步操作（rebase / merge / cherry-pick / revert / am / bisect）在 porcelain 的任何一行里都没有**，唯一判据是 git 目录下的状态文件（git 自身的 `wt-status.c` 也正是这么判的）。**用 `fs` 读、不新起 git**：多一次子进程既落在每次 `/api/state` 上，又要往只读白名单里添条目，而读文件存在性一个字节都不写。
- 判据与优先级，**按序取第一个命中**：

  | 命中 | 标注 |
  |---|---|
  | `rebase-merge/` 或 `rebase-apply/rebasing` | `rebase` |
  | `rebase-apply/` 而无 `rebasing` | `am` |
  | `MERGE_HEAD` | `merge` |
  | `CHERRY_PICK_HEAD` | `cherry-pick` |
  | `REVERT_HEAD` | `revert` |
  | `BISECT_LOG` | `bisect` |

  **顺序不是随手排的**：rebase 冲突停下时 git 目录里同时躺着 `rebase-merge/` 与 `MERGE_MSG` / `AUTO_MERGE`，而用户处在的是 rebase 不是 merge，先判 rebase 才不会把它标错。`rebase-apply/` 里有没有 `rebasing`，是 rebase 与 `git am` 唯一的区分——合成一个标注等于对用户说假话。
- **路径基准是 `rev-parse --git-dir` 的返回值，不是 `<root>/.git`**。linked worktree 与 submodule 下这些文件躺在各自的 git 目录里（`…/.git/worktrees/<名>` 与 `…/.git/modules/<路径>`），按 `<root>/.git` 拼的写法在那两种仓库里**永远读不到**、于是永远标不出操作，而它不报错。

## 合并冲突

- **判据是「这条记录来自 `u` 段」，不是状态位**。porcelain 的 `u` 记录里 XY 可以是 `UU` / `AA` / `DD` / `AU` / `UD` 等组合，按 `!== '.'` 的字面判据读会让同一个文件同时落进「已暂存」和「未暂存」两组，而两组都不是它的真实处境；`DD` / `AA` 两位里一个 `U` 都没有，靠状态位认会漏掉一半形态。编码为 `FileEntry.conflicted`。
- 冲突文件**自身的 diff 照常走 `git diff HEAD`**，不需要任何特殊分支：补丁正文就是带 `<<<<<<<` / `=======` / `>>>>>>>` 标记的工作区内容，而那正是用户此刻要看的东西。
