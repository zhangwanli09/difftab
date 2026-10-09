# git 交互与异常状态

> 产品运行时在**用户仓库**里执行的 git 命令，全程只读。门禁见 [`../gates.md`](../gates.md)，实测证据见 [`../decisions.md` 的「git 行为」](../decisions.md#git-行为)。

## 基准与数据源

- diff 基准是 **`git diff HEAD`**，不是 `git diff`——agent 执行过程中可能自行 `git add`，`git diff` 会漏掉已暂存的改动，而「相对上次提交改了什么」才是本工具要回答的问题。
- 文件列表以 **`git status --porcelain=v2 --branch -uall -z`** 为唯一数据源，一次调用同时拿到文件状态、暂存/未暂存双状态位、重命名信息与分支 ahead/behind。两个参数都不能省：
  - `-uall`：否则 git 把未跟踪目录折叠成一行 `dir/`。
  - `-z`：否则含非 ASCII、空格、引号的路径会被做 C 风格转义并加引号。加 `-z` 后改为 NUL 分隔、路径原样输出。**所有取路径的列表类调用**（`ls-files`、`diff --numstat` 等）一律加 `-z`，按 NUL 切分而非换行。

## 封装层统一注入的五件事

这五条都写在 `server/git` 的封装层（`run.ts`），不留给各调用点自己记得加。后两条挡的是同一类东西：**读一下就写库**——命令本身只读、不失败、不改输出，只有 `.git` 逐字节比对看得见。

- **`-c core.quotePath=false`**（所有 `git diff` 调用）。`-z` 只作用于列表输出，**管不到补丁正文**——正文里的 `diff --git` / `--- ` / `+++ ` / `rename from|to` 头部行仍会 C 风格转义，而 diff2html 恰恰从这些行解析文件名，不处理就会在界面上直接显示 `\351\234\200` 转义串。两者互补，不可相互替代。
- **`GIT_OPTIONAL_LOCKS=0`**。`git status` 默认会把刷新过的 stat 缓存写回 `.git/index`——它**不改变 status 输出**，所以只读白名单与「前后 `git status` 比对」都看不见。只读 `.git` 下它也只是静默跳过、exit 0、stderr 全空。看得见它的只有两处：`.git` 逐字节快照比对，以及「读一次 `/api/state` 不引出刷新事件」那条（写 `.git` → 推 `change` → 前端再读一次，是个自激循环）。
- **`GIT_LITERAL_PATHSPECS=1`**。`--` 后面的路径默认按 wildmatch 解释，而我们的路径来自 URL query：`path=*` 会让 `git diff HEAD -- '*'` 回一份**整仓 diff**，一个真实存在、名字里带 `*` 的文件也会匹配到邻居身上，页面在 A 的标题下显示 B 的补丁。本项目的路径无一例外来自 git 自己的输出，不需要任何通配语义。
- **`GIT_NO_LAZY_FETCH=1`**。partial clone（`--filter=blob:none`）里缺的对象，git 默认会当场从 promisor remote 取回来并写进 `.git/objects`——`diff` / `cat-file` 只要碰到一个不在本地的 blob 就会触发，而提交历史读的恰恰是那些从没检出过的旧 blob。关掉之后缺对象就是一次非零退出（实测 128：`could not fetch … from promisor remote`），不联网、不写库，封装层按 stderr 把它分类成 `GitError` 的 `missing-object`——**分类只在 `run.ts` 做一次**，不抛的 `runGit` 也照样以它失败，HTTP 层统一译成 `unsupported`（「内容不在本地」）；交给各调用点 catch 时，漏 catch 的那条路会把它说成「路径不存在」或一条 500。**这个变量 git 2.44 才有**：更老的 git 不认它，所以提交历史在「git < 2.44 ∧ partial clone」时整个拒绝（`history.ts` 的 `guardLazyFetch`）。判 partial clone 读共享 git 目录下的 `config`，两种记号都认——老 git 写 `extensions.partialClone`，新一些的只写 `remote.<名>.promisor = true`（实测 2.54 只有后者）；`promisor` 是 git 的布尔值，只写键名、`true` / `yes` / `on` / `1` 都算开，漏认一种就是在老 git 上往对象库里写。版本与共享 git 目录都是启动时 `locateRepo` 那两次调用顺手拿到的（`RepoInfo.gitVersion` / `commonDir`：`--git-common-dir` 并进原有那次 `rev-parse`，零额外进程；它的相对路径是**相对 cwd** 的，实测在子目录里给 `../.git`），新 git 上一个文件都不读，老 git 上每次读一个小文件、不另设缓存。工作区 diff 不在此列：它只碰 HEAD 里已检出的那一份。
- **每一条 `git diff` 紧跟子命令带 `--no-ext-diff --no-textconv`**——由 `runGitRaw` 按子命令注入，调用点不写，也就没有「新加一条 `diff` 忘了带」这回事。`.gitattributes` 里 `diff=<驱动>` + `diff.<驱动>.textconv` 会让补丁形态对两侧各起一次外部程序，配了 `cachetextconv` 时还把结果写进 `refs/notes/textconv/<驱动>`——实测补丁形态（工作区 diff 与提交 diff 都是）会写，`--numstat` / `--name-status` 不写，加上之后一条都不写。numstat 那几条也带：二进制与行数的判定得与补丁看的是同一份内容。`diff.external` 同理是一个外部程序。**代价**：配了 textconv 的文件（`.docx`、加密文件）按原始字节比，二进制就说二进制。

## `-z` 解析的三个陷阱

- **`porcelain=v2` 的重命名记录占两个 NUL 段**：格式是 `2 <XY> … R<score> <新路径>\0<旧路径>`。解析器不能无状态地按 NUL 平铺切分，遇到 `2 ` 开头的记录必须额外吞掉下一段作为旧路径。
- **`diff --numstat -z` 的重命名记录占三段**：路径字段为空，后面紧跟 `<旧路径>` `<新路径>`——**顺序与 `porcelain` 的 `2 ` 记录相反**（那边新在前）。平铺切分会把路径当成记录。
- **无上游分支时不输出 `# branch.ab` 行**。此时展示为「无上游」，不能默认成 0/0，更不能因取不到字段而崩溃。上游的名字取自它前面那行 `# branch.upstream`。**它是 git 缩写过的 refname，通常与 `for-each-ref` 剥掉前缀后的写法相同（`origin/main`），名字有歧义时却会带上前缀**（实测 2.54）：有个标签也叫 `main` 时跟踪本地 `main` 写成 `heads/main`，有个本地分支也叫 `origin/main` 时写成 `remotes/origin/main`，全都有歧义时是完整的 `refs/…`。前端因此不按名字精确比对，而是照 git 自己把缩写解析回完整名字的次序（`ref_rev_parse_rules` 里 `%s` → `refs/%s` → `refs/heads/%s` → `refs/remotes/%s` 那四条）逐条拼回去找——缩写与解析是同一套规则的两个方向，不必一种前缀写一个特例；精确比对时这几种情况下徽标静默不画。只在 `# branch.ab` 也在时才进 `upstream`：配了上游而远端分支已被删掉（gone）时只有名字没有 ab，那仍按「无上游」处理——给一个对不到任何 ref 的名字，前端也画不出什么。

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

### 图片：二进制里被放行的那一支

**判据是「二进制 ∧ 扩展名在表里」，两个条件缺一不可**，表在 `server/git/worktree.ts`（`imageMimeOf`，与分类链同住——它是分类链的一环，放进 `image.ts` 会让底座反向 import 一个 feature 模块；png / jpg / jpeg / gif / webp / bmp / ico / avif；**SVG 不在**——它是文本，走文本 diff 更有信息量）。二进制那一半照旧由上面那道闸给：已跟踪侧是 numstat 的 `-\t-`（含 `.gitattributes`），未跟踪侧是 NUL 探测；扩展名只在**已判定为二进制之后**查。单看扩展名的写法会把一个内容是文本的 `.png` 送去 `<img>` 里画成一张破图，而它本来有一份能看的文本 diff。

- **旧侧读 diff 基准里的 blob：`git cat-file blob <base>:<path>`，存在性与体积另用 `cat-file -s`**；它的内容身份（`ImageSide.version`）是基准的 oid——那个 blob 只在基准换了之后才可能变，而 oid 是 `resolveDiffBase` 那次 `rev-parse` 顺手就有的（`DiffBase { ref; oid }`），不为它多起一次进程。新侧的身份是体积 + mtime（`worktreeVersion`），与 git 自己的 stat 缓存同一条判据，已知边界也一样：同体积、同一个 mtime 刻度内的改写认不出来。工作区 diff 里这是唯一一处读对象库的调用，也是白名单第六条（提交历史那一侧两边都走它，见下面「提交历史」）。**只允许这两种字面参数**：`--filters` / `--textconv` 会让 git 跑 smudge / textconv 驱动——LFS 的 smudge 会往 `.git/lfs` 里写东西，而白名单只看子命令，看不见参数；不用 `git show <rev>:<path>`：字节一样（实测两者默认都不套 textconv），但它是带整套 log / diff / pretty 参数面的 porcelain，「参数只能是这几个字面量」那条断言在它身上钉不住。
- **`<rev>:<path>` 是 revision 语法，不是 pathspec**，`GIT_LITERAL_PATHSPECS=1` 管不到它。拼进去的 `path` 一律取 `resolveInRepo` 归一化后的那份（无 `.` 段、无前导 `./`、`/` 分隔），字面量那道边界校验因此仍然过了一遍；`cat-file -s` 非零退出即「这一侧不存在」（新增、或基准是空树），不是错误。
- **重命名的旧侧在 `oldPath`**，payload 里 `old.path` 由后端填成它，前端拿着直接问 `/api/blob`。
- **5MB 那道闸按侧卡**：任一侧超过 `MAX_BYTES` 整个 payload 回 `too-large`（`reason: 'size'`，`size` 取**两侧里大的那个**——固定报工作区那份时，HEAD 里 8MB 的图被换成 120KB 的，提示会说「file is 120 KB」而 Files 里同一个文件正常显示）——一张 8MB 的 PNG 说「太大」是真话。`/api/blob` 自己再卡一次（工作区侧看 `lstat`，blob 侧带 `maxStdoutBytes`）：payload 与取字节是两次请求，中间文件可以长大。
- **`/api/blob` 只服务表里的扩展名**，非图片一律 400；取 `new` 侧**就是 `inspectFile` 那条链**（`image` 支与 `text` 一样带着 `buffer`），不另写一份「lstat → 体积 → 读」的副本——上一份副本连 NUL 那道都没有，一个内容是文本的 `.png` 在 payload 里是文本、在字节端点上却被当图发出去。

## 提交历史

提交历史的三样东西——提交列表、一次提交改了哪些文件、其中一个文件的补丁——**只往只读白名单里加了 `log` 一条**，其余全部落在已有条目上：提交的 diff 就是 `diff <parent> <sha>`，图片两侧都是 `cat-file`，校验是 `rev-parse`。代码在 `server/git/history.ts`（列表、元数据、文件清单）与 `diff.ts`（单个文件的补丁，与工作区 diff 共用三道闸）。

- **`log` 的 argv 整条是字面量**，只有两种形态：列表是 `log --no-show-signature --no-color -z --format=%H%x00%P%x00%an%x00%at%x00%s%x00%b --max-count=<n> --skip=<n> <起点> --`（起点是第一页的字面量 `HEAD`、或请求带来的完整对象名），单条提交是同一串去掉 `--skip`、`--max-count=1`。冒烟逐段钉着它（数值那两段只钉形状），理由与 `cat-file` 那条一样——白名单只看子命令，而 `log` 的参数面里有会拉起外部程序的开关：
  - **`--no-show-signature`**：用户配了 `log.showSignature` 时 `log` 会对每条提交起一次 gpg，挡它要显式关掉。git 下限 2.11 已有这个开关。
  - **不带 `-p` / `--stat` / 任何 diff 选项**：`log` 一旦开始算 diff，`diff.external` 与 textconv 驱动就都在射程内。列表只要元数据。
  - **`-z` + 固定六段**：`-z` 让记录之间以 NUL 分隔，`%x00` 让字段之间也是 NUL，于是每条提交恰好六段。主题行（`%s`）不含 NUL 与换行，作者名可以有空格，正文（`%b`）可以有换行——都不是分隔符；根提交的 `%P` 是空段，不是缺段。**正文含 NUL 也不会错位**：`git commit` 拒绝含 NUL 的说明，但 `hash-object --literally` 造得出来；git 输出 `%b` 时在第一个 NUL 处截断（实测 2.54：说明写成 `Reverts\0<sha>\0tail`，回来的正文就是 `Reverts`），每条记录在输出里恒为六段，按 6 一组切即可，不需要重新对齐。`history.test.ts` 拿真 git 钉着这条——它若哪天不截断了，那个 sha 会被当成下一条记录的开头。
- **范围参数只能是完整对象名，`--` 收尾**：请求里的 `sha` / `head` 必须匹配 `^[0-9a-f]{40}([0-9a-f]{24})?$`，不认缩写、不认 `HEAD~3` 一类 revision 表达式，更不认 `-` 开头的值。它们会被原样拼进 argv 的 revision 位置，而那个位置 `GIT_LITERAL_PATHSPECS` 管不到——`--output=<路径>` 在那里就是一次写文件。末尾那个 `--` 让 git 不再把之后的任何东西当选项。
- **对象名合法不等于是本仓库里的一个提交**。单条提交那三条路（详情、补丁、图片）共用一个 `resolveCommit`：一次 `log -1` 同时校验与取元数据，**判据是回来的那条正好就是问的这个 sha**——`log` 对不存在的对象以 128 退出，对树与 blob 却以 0 退出、输出为空，对附注标签则剥到它指向的提交（实测），只看退出码三种都漏一种。失败一律 `not-found`。**对比端也只在 `resolveCommit` 里定一次**：三条路各自去找父提交时，将来改一处漏一处，文件清单、补丁与图片就是对着三个不同的父在比，而不报错。
- **分页是「锚点 + skip」，不是「从 HEAD 往下数」**：第一页不带 `head` 参数，后端直接从 `HEAD` 起 `log`，回来的第一条就是 HEAD 此刻的 oid、写进响应的 `head`（失败时再问一次 `rev-parse --verify --quiet HEAD`——`repo.ts` 的 `headOid`，「未出生」的判据只此一份，diff 基准退回空树用的也是它——分开两种：未出生退 1，是「没有提交」；指着一个读不出来的提交（中断的 fetch、坏掉的 shallow 文件）却退 0 并照样印出 oid，那是一个真实的故障，如实报错——`log` 对两者都退 128，只看它就会把故障说成 `No commits yet`）；锚点那一路 `log` 非零退出即锚点不存在；之后每一页都以这个 oid 为起点再 `--skip`（前端怎么把新提交接在顶上而锚点不动，见 [`web.md`](web.md)）。按 HEAD 数的写法在 agent 中途提交时会让第二页重复第一页的最后一条，而这正是这个工具最常见的使用时刻。一页 50 条，取 51 条来判 `hasMore`，不另起一次计数。空仓库（HEAD 未出生）回 `{ head: null, commits: [], hasMore: false }`，不是错误。
- **一次提交改了哪些文件：`diff --no-ext-diff --no-textconv <parent> <sha> --name-status -z -M`**。重命名记录占**三段**——`R<score>` `<旧路径>` `<新路径>`，与 numstat 同为旧在前、与 porcelain 相反——平铺切分会把旧路径当成下一条记录的状态字段。状态字母只认 `A` / `M` / `D` / `R` / `T`（`C` 不会出现：没开 `-C`）。
- **父提交是第一父**：`resolveCommit` 那次 `log` 顺手带回 `%P`，取第一个；**合并提交因此展示的是「这次合并相对主线带进来了什么」**，与 GitHub 的提交页、VS Code 的 Timeline 同一口径。组合 diff（`-c` / `--cc`）不做：它的补丁格式 diff2html 解析不了。**根提交没有父**，对比端用空树哈希（`repo.ts` 那份，与空仓库同一个常量），按 sha 的长度定格式（64 位即 SHA-256），不为它多起一次进程。**浅克隆的边界不是根提交**：它的 `%P` 同样为空，只是父提交没被取下来——拿空树去比会把整个仓库报成「全部新增」。`%P` 为空时读共享 git 目录下的 `shallow` 文件（逐行列着边界提交，实测 `--depth 1` 之后正好是 HEAD），命中就不比：文件清单为空并标 `shallow`，补丁与图片回 `unsupported`。不缓存——`fetch --deepen` 会改这个文件。
- **单个文件的补丁与工作区 diff 共用一套三道闸**：`diff --no-ext-diff --no-textconv <parent> <sha> --numstat -z [-M] -- <path> [<旧路径>]` 先判二进制与行数（按路径挑、按合计算，与工作区那条完全一样），再带 `maxStdoutBytes` 取补丁。两侧都在对象库里，没有未跟踪那条路、也不读磁盘；拒绝时的 `size` 用 `cat-file -s` 取新侧那个 blob（删除则取旧侧）——同一个文件在工作区 diff 里说「file is 6 MB」，这里也得说同一个数；只在要拒绝的那两条分支上才问。
- **图片两侧都读对象库**：旧侧 `<parent>:<旧路径或路径>`、新侧 `<sha>:<路径>`，存在性与体积用 `cat-file -s`、字节用 `cat-file blob`，与工作区 diff 的旧侧同两条字面量。`version` 分别是 parent 与 sha 的对象名——提交不可变，这两个身份永远不会换内容。`/api/blob` 带 `commit=<sha>` 即走这一路。

## 分支列表

状态条上那个分支列表（本地分支、远程分支、标签）**只往只读白名单里加了 `for-each-ref` 一条**，代码在 `server/git/refs.ts`。不用 `branch --list` / `tag -l`：那两个子命令本身会写，白名单只看子命令（理由见 [`../decisions.md`](../decisions.md)）。

- **argv 整条是字面量**：`for-each-ref --format=<十段> refs/heads refs/remotes refs/tags`，冒烟逐段钉着它。理由与 `log` 那条一样——`for-each-ref` 的 atom 里有 `%(signature)` 一族，用上就是每条 ref 起一次 gpg；没有任何来自请求的参数。
- **十一段，每段都以 `%00` 收尾**：`%(refname)` `%(symref)` `%(objectname)` `%(authorname)` `%(committerdate:unix)` `%(subject)`，再加 `%(*objectname)` `%(*objecttype)` 与后三样的 `%(*…)` 解引用形态。`for-each-ref` 没有 `-z`，记录之间是换行；最后一段也带 `%00`，于是整份输出按 NUL 切开后恰好十一段一组，下一条的 refname 前面多一个换行、剥掉即可（与 `log -z` 同一个处理）。只用 git 2.11 已有的 atom——`refname:lstrip` 更晚，前缀在 JS 里剥。
- **`%(symref)` 非空的跳过**：克隆出来的仓库有一条 `refs/remotes/origin/HEAD` → `origin/main`，画出来就是同一个提交的两行，VS Code 也不列它。
- **附注标签取 `%(*…)` 那几段**：本体是标签对象，作者与时间为空、主题是标签说明；解引用那几段才是它指向的提交。轻量标签的 `%(*…)` 全空，用本体；指向树或 blob 的标签两组都空，照列、只是没有提交信息。**剥出来的未必是提交**：附注标签可以指向树，标签套标签时较老的 git 只剥一层、剥到内层那个标签对象——判据是 `%(*objecttype)` 不是 `commit`，此时只留对象名，不把内层标签的说明当成提交主题。
- **排序在 JS 里做**：分三组（本地 / 远程 / 标签），组内按提交时间降序。不用 `--sort`——那是又一段要钉的参数面，而三组本来就要在 JS 里分。
- **partial clone 不触发取对象**：它只读 ref 与它们指向的提交（附注标签再多一个标签对象），`blob:none` 与 `tree:0` 两种过滤都把提交留在本地；封装层的 `GIT_NO_LAZY_FETCH` 照常兜底。
- 空仓库与没有任何 ref 时输出为空、exit 0，回一个空列表。
- **History 的上游徽标复用这一条**：status 只给上游的名字与 ahead/behind、不给它指着哪个提交，按名字在这份列表里找就是那个 oid——不另起 `rev-parse @{u}`（那是 `rev-parse` 又一种要钉的 argv 形态，多一个进程换来的东西这份列表里已经有），`for-each-ref` 的字面量 argv 一个字都不变。

## 目录树的两条 `ls-files`

文件浏览器的树**按目录懒加载**，与 diff 同一条取向：一次调用只回**一层**的直接子项，禁止一次性构造整棵树——`node_modules` 那种目录足以让一份「全量树」的 JSON 比整仓 diff 还大。

一层要**三条**调用（并发发出，墙上时间仍是一条的量级）：

```
git ls-files -z --stage --cached                                              [-- <本层>]
git ls-files -z --others           --exclude-standard --directory --no-empty-directory [-- <本层>]
git ls-files -z --others --ignored --exclude-standard --directory --no-empty-directory [-- <本层>]
                                            ↑ 后两条非零退出时，pathspec 退到 <本层的第一段> 重问一次
```

三条各答一件事：已跟踪的、未跟踪且未被忽略的、被忽略的。三者的并集就是这一层要画的东西，第三条来的打上 `ignored`。

**已跟踪那条带 `--stage`，为的是拿到 mode**：判据是 **`160000` 即 gitlink（submodule）**。它在普通 `ls-files` 输出里就是一条不带尾斜杠的路径，与一个文件长得一模一样——照文件画的话，树上那一行没有展开箭头，点下去还会以「不是普通文件」告终，而 difftab 明确支持在含 submodule 的仓库里跑。**`--stage` 与 `--others` 不能合成一条**：加上它之后 git 把未跟踪那部分整个丢掉（已实测），这正是三条而不是两条的原因。

其余参数逐条的判据：

- **`--directory` 与 `--no-empty-directory` 必须同时带**。`--others` 默认展开到文件粒度，而一个装着 30,000 个文件的 `node_modules` 在第二条调用里就是 30,000 条路径——**git 照常 exit 0**，症状只是这一层慢得离谱、内存里凭空多出几 MB 字符串。带上之后整个目录折叠成一条 `node_modules/`，正是树上要画的那一条。`--no-empty-directory` 顺带滤掉折叠后为空的那些。
- **`--ignored` 必须与 `--exclude-standard` 同用**，否则 git 以 `--ignored needs some exclude pattern` 直接 fatal。这条会响，记在这里只是免得有人「顺手精简」掉后面那个。
- **`-z`**：与其余所有列表类调用同一条约束，路径原样输出、按 NUL 切分。
- **`--` 后面那一段仍受封装层的 `GIT_LITERAL_PATHSPECS=1` 约束**，而字面量 pathspec 保留前导目录匹配：`-- src` 照样匹配 `src/` 底下的一切。根目录那一层不带 `--`。
- **两条 `--others` 非零退出时，pathspec 退到本层的第一段重问一次。** 要它是因为 git 在被忽略的那一片深处会**直接 fatal**：

  ```
  $ git ls-files -z --exclude-standard --directory --no-empty-directory \
        --others --ignored -- node_modules/.pnpm/@biomejs+biome@2.5.7
  fatal: git ls-files: internal error - directory entry not superset of prefix   (exit 128)
  ```

  判据是**层数，不是路径里的特殊字符**：git 取全部 pathspec 的公共前导目录做 `max_prefix_len`（`a/b/c` 截到最后一个 `/`，得 `a/b/`），而 `--ignored` 那条报的是**排除规则命中的那一层**（`.gitignore` 里的 `vendor/`）、与 pathspec 有多深无关；吐目录条目前那道断言正是「前缀不得比条目长」。于是**被忽略的那一片里深度 ≥ 3 的那一层必然 fatal，深度 ≤ 2 恒安全**（前缀最长就是 `a/`，正好等于最短的那条记录）。`-C` 进那个目录、pathspec 带尾斜杠都绕不过；第一段不含 `/`，`max_prefix_len` 因此恒为 0。不带 `--ignored` 的那条炸不起来（实测：它从 pathspec 处开始遍历，最高只折叠到 pathspec 自己，问 `fresh/deep/deeper` 回的是 `fresh/deep/deeper/`），退让逻辑两条都挂只是不想把这条实测钉进代码。

- **但第一段只能当兜底，不能当默认。** 无条件放宽会静默改掉另外两件事的答案，两件都不报错：

  - **被忽略的一片嵌在一个未跟踪目录里时，放宽之后 `--ignored` 那条一条都不回**（实测：`untracked/` 整个未跟踪、`untracked/ig/` 被忽略，问 `-- untracked/ig` 回 `untracked/ig/`，问 `-- untracked` 回空）。那一层于是继承「不灰显」，页面上只是它不再灰了；
  - **`?path=<未跟踪目录里的一个文件>` 从 400 变成 500**：窄 pathspec 下 git 吐的是这个文件自己（下面的「把一个文件当目录展开」正是据此判的），放宽之后它被折叠进 `a/`，于是没人认出这是坏请求，兜底拿一个普通文件去 `readdir`，以 `ENOTDIR` 收场。

  所以退让只发生在 git 已经答不出东西的那一刻，代价范围限死在「本来就是个 500」的那一层。判据用**非零退出**而不是比对那句 fatal 的字面量：这两条是只读列举，非零退出没有第二种解释，而按消息匹配要赌它逐字不变；重问那次再失败就把原来那个错误抛出去。

**收敛成直接子项的判据是「相对本层的第一段」**：`src/web/main.tsx` 相对 `src` 的第一段是 `web`，后面还有 `/`，所以 `web` 是目录；`--directory` 折叠出的 `node_modules/` 以 `/` 结尾，同样是目录。去重后目录在前、各自按名字排序（照 VS Code 的排法）。

### git 答不出这一层时的兜底

**判据是两条正面证据，不是「一条子项都没有」。** 有两种形态会走到这里，而两种手上都有证据：

- **`--directory` 把这一片折叠了**。折叠是它该有的行为（`node_modules/` 正是靠它才没变成三万条路径），但代价是 git 从此再也答不出那里面有什么——往里 scope 拿到的仍是那条折叠记录（三种 pathspec 写法与 `-C` 进去都一样，已实测；被忽略的那一片里深度 ≥ 3 时，这三种写法连折叠记录都给不出、直接 fatal，见上一节最后一条）。
- **这是一个 submodule**：父仓库的 `ls-files` 对它只有一条 gitlink 记录（mode `160000`、路径正好等于本层），看不进去。

命中时这一层改为读一次磁盘（`readdir`，只读一层）。**写成「空就兜底」是个 catch-all**：`?path=<一个文件>` 与 `?path=<不存在的路径>` 同样落进来，`readdir` 抛 `ENOTDIR` / `ENOENT` 被咽掉，页面上是一个「展开后空空如也的目录」——而它们本该是 400 / 404。为了不吞掉 `EACCES` 而加的那道 errno 过滤，本身就是在给一个过宽的开关打补丁；判据换成正面证据之后，那道过滤连同它一起没了。

**「把一个文件当目录展开」因此是一条独立的判定**：git 提到本层自己这条路径、而它不是 gitlink，就是坏请求。

**折叠发生在最高那一层，判据必须跟着放宽**：问 `dist/server` 回来的是 `dist/` 而不是 `dist/server/`。把判据写成「正好等于本层」时，那条记录既不相等、又过不了「以本层为前缀」那道过滤，于是这一层两手空空地返回——**页面上是一个展开后写着 Empty 的目录，而里面明明有东西**。正确的判据是「这条折叠记录是本层自己**或**它的某个祖先」。

这处兜底不需要任何 git 知识，这正是它成立的理由：能走到这一步，说明 git 刚刚断言过整个子树同属一档（被忽略、整目录未跟踪，或整个在 submodule 里），于是每个子项的 `ignored` **直接继承**（submodule 那一路继承「不灰显」），不必也不该在这里重新解释一遍 `.gitignore`。

三条落地细节：

- `withFileTypes` 的 dirent **不跟随符号链接**（`isDirectory()` 对指向目录的链接为 false），所以一个指向仓库外的链接在这里只会是一个文件条目，走不进去。
- **`.git` 要自己滤掉**：git 的输出里它从来不出现，而这条兜底会在一个刚 `git init`、什么都没有的仓库根上生效——那时树的第一行就是 `.git`。判据是名字、不限层级（submodule 与 linked worktree 底下那个 `.git` 是文件，同样不该画出来）。
- **仓库根那一层要单独放行**（`allowRoot`）：边界那道刻意把「解析到根自己」判为非法（读文件时那确实是坏请求），不放行的话根那一层的兜底**永远走不到**，连带上一条的 `.git` 过滤成了死代码——而它唯一要保护的正是「一个刚 `git init`、什么都没有的仓库」。

### 已知的成本

三条调用**都以「这一层底下的全部路径」为量级**，不是这一层的条目数：收敛成直接子项发生在拿到输出之后。根那一层因此每次都要枚举一遍全仓，而 `refreshTree()` 在 `Files` 打开着时每个 `change` 都会重发。（退到第一段重问的那一次量级是「第一段底下的全部路径」，仍不超过根那一层。）

按本工具的目标场景（agent 正在改的那个仓库，几千个文件量级）这是可以接受的：一次约几百 KB 的 stdout，与 `/api/state` 那次 status 同一个数量级。**但它不是常数级**，上限由封装层那个 64MB 的 stdout 兜底给出——真到那一步是一个 500，而不是悄悄给一份不全的树。若将来要支持十万文件级的仓库，先改的是这里而不是前端。

两个**已知偏差**，是 git 的数据模型使然，不当 bug 修：

- **空目录不出现**——git 不跟踪空目录，三条调用都不会提到它。（兜底那条路上是个例外：它读的是磁盘，因此被折叠区域里的空目录照常画出来。）
- **工作区已删、但仍在 index 里的文件仍会列出**（`--cached` 给的是 index）。点开它走的是读磁盘那条路，得到「文件已不在」的提示，与变更列表里那条 `1 D.` 说的是同一件事。

## 只读读取单个文件

文件浏览器右侧那份内容**直接读磁盘**，不经 git：树上点得到的路径包括未跟踪与被忽略的文件，它们在任何 `git show` 里都没有对应的对象。这条路与 `untrackedDiff` 是同一条，因此**整条分类链只有一份**（`worktree.ts` 的 `inspectFile`），两边各自只把它的结果翻译成自己的 payload：

- **仓库边界校验，两道**（见下）；
- **`lstat` 而不是 `stat`**：符号链接给的是**链接目标字符串本身**，与 git 对 mode 120000 的处理一致；
- **顺序**：符号链接 → 非普通文件 → 体积 → 二进制（NUL 探测）→ 图片（扩展名表）→ 行数。二进制排在行数之前，因为它比「太大」更具体；体积排在读进内存之前；图片是二进制的子集，所以只在 NUL 命中之后才查扩展名（判据与 diff 那侧同一条，见上面「图片」一节）；
- **5MB 与 50,000 行两道闸**，以及**行数怎么数**（空文件 0 行、末尾那个换行不另算一行，在 Buffer 上数而不是把整份切成 N 个字符串）。

**复用阈值还不够，分类链本身也必须只有一份**：先前两边各写一遍「lstat → 符号链接 → 体积 → NUL → 行数」，只共用了两个常量，而两份的行数口径在第一次提交时就差了一——一个正好 50,000 行的文件在 diff 视图里能看、在文件视图里说「太大」。

### 仓库边界是两道，缺一道就是一个路径穿越

路径来自 URL query，是外部输入。凡是**真的要落到磁盘上**的路径（未跟踪文件的补丁、只读读文件、目录树那处兜底），两道都要过——git 自己那些调用不需要，它的 pathspec 本就受仓库边界约束。

1. **字面量那道**：拒绝绝对路径、含 `\0` 的路径，以及 `relative(root, abs)` 走出去的那些。
2. **`realpath` 那道**：把中间段全部展开成真实路径，再比一次边界。

**两道在同一个入口里（`worktree.ts` 的 `resolveInRepo`），用途由参数说明、不按用途分叉成几个函数**：分叉时挑错哪一个不报错，而挑错的后果正是下面那个洞。`follow` 决定最后一段跟不跟随（读文件不跟——链接本身就是要展示的东西；列目录要跟，因为 `readdir` 本来就跟）。

它还**回一份归一化的仓库相对路径**：`dir/`、`./dir`、`dir//x` 都被 `resolve()` 归成同一份，目录树拿它同时做 pathspec、做前缀匹配、并放进自己返回的 `TreePayload.path`。只取绝对路径、把归一结果扔掉的写法，逼得外面补一条 `endsWith('/')` 的特判，而那一族拼法是拦不完的。

**只有第一道时，`lstat` 给人的保护是假的——它只管最后一段，中间段照跟不误**。仓库里有个 `linkdir -> ../outside` 时，`linkdir/secret.txt` 在字面上老老实实待在仓库内，而 `readFile` 顺着 `linkdir` 走出去，把仓库外那份内容当成一个新增文件吐回来（三个端点实测全中）。列目录那侧更直接：`readdir` 本来就跟随最后一段，所以那一侧**连最后一段也要展开后再比**。

反过来，挡的是**穿越**而不是符号链接本身：`?path=linkdir` 照常回一个 `symlink`，说清它指向哪。

二进制判定走 NUL 字节探测（与未跟踪那侧同理）：这条路上没有 numstat 可依，而 git 自己的判定只对已跟踪文件给得出。

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
