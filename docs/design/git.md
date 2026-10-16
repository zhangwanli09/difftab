# git 交互与异常状态

> 产品运行时在**用户仓库**里执行的 git 命令，全程只读。门禁见 [`../gates.md`](../gates.md)，实测证据见 [`../decisions/git.md`](../decisions/git.md)。

## 基准与数据源

- diff 基准是 **`git diff HEAD`**，不是 `git diff`——agent 可能自行 `git add`，`git diff` 会漏掉已暂存的改动，而「相对上次提交改了什么」才是本工具要回答的问题。
- 文件列表以 **`git status --porcelain=v2 --branch -uall -z`** 为唯一数据源，一次调用拿到双状态位、重命名与 ahead/behind。`-uall` 不能省（否则未跟踪目录折叠成一行 `dir/`）；`-z` 不能省（否则非 ASCII、空格、引号的路径被 C 风格转义）。**所有取路径的列表类调用一律 `-z`**，按 NUL 切分。

## 封装层统一注入的五件事

这五条都写在 `server/git` 的封装层（`run.ts`），不留给调用点自己记得加。其中后几条挡的是「读一下就写库」——命令本身只读、不失败、不改输出，只有 `.git` 逐字节比对看得见。

- **`-c core.quotePath=false`**：`-z` 管不到补丁正文，`diff --git` / `---` / `+++` / `rename from|to` 头部仍会转义，而 diff2html 的解析器正从这些行取文件名，转义后拿到的是 `\351\234\200`（界面眼下不画补丁里的文件名，但解析结果里的名字从此是错的）。
- **`GIT_OPTIONAL_LOCKS=0`**：`git status` 默认把 stat 缓存写回 `.git/index`，**不改变输出**，只读 `.git` 下也只是静默跳过。看得见它的只有 `.git` 逐字节比对与「读一次 `/api/state` 不引出刷新事件」（写 `.git` → 推 `change` → 再读一次，是个自激循环）。
- **`GIT_LITERAL_PATHSPECS=1`**：pathspec 默认是 wildmatch，而路径来自 URL query——`path=*` 会回一份整仓 diff，名字里带 `*` 的真实文件也会匹配到邻居，页面在 A 的标题下显示 B 的补丁。本项目的路径全部来自 git 自己的输出，不需要通配语义。
- **`GIT_NO_LAZY_FETCH=1`**：partial clone 里碰到一个不在本地的 blob，git 默认从 promisor remote 取回并写进 `.git/objects`，而提交历史读的恰恰是从没检出过的旧 blob。关掉后缺对象是一次非零退出，**分类只在 `run.ts` 做一次**（`GitError` 的 `missing-object`，HTTP 层统一译成 `unsupported`）——交给各调用点 catch 时，漏 catch 的那条路会把它说成「路径不存在」或一条 500。
  - **这个变量 git 2.44 才有**：「git < 2.44 ∧ partial clone」时提交历史整个拒绝（`history.ts` 的 `refuseLazyFetch`）。判 partial clone 读共享 git 目录下的 `config`，**两种记号都认**：`extensions.partialClone` 与 `remote.<名>.promisor`（git 布尔值的各种写法都算开）——漏认一种就是在老 git 上往对象库里写。版本与共享 git 目录由启动时 `locateRepo` 顺手拿到（`RepoInfo.gitVersion` / `commonDir`；`--git-common-dir` 返回的相对路径是**相对 cwd** 的）。工作区 diff 不受影响：它只碰已检出的那份。
- **每一条 `git diff` 紧跟子命令带 `--no-ext-diff --no-textconv`**，由 `runGitRaw` 按子命令注入、调用点不写。`diff=<驱动>` + `textconv` 会让补丁形态起外部程序，配了 `cachetextconv` 时还写 `refs/notes/textconv/*`；`diff.external` 同理。numstat 那几条也带：二进制与行数判定得与补丁看的是同一份内容。**代价**：配了 textconv 的文件按原始字节比。

## `-z` 解析的三个陷阱

- **`porcelain=v2` 的重命名记录占两个 NUL 段**：`2 <XY> … R<score> <新路径>\0<旧路径>`。遇到 `2 ` 开头的记录必须额外吞掉下一段。
- **`diff --numstat -z` 的重命名记录占三段**：空路径 + `<旧路径>` + `<新路径>`，**顺序与 porcelain 相反**。平铺切分会把路径当成记录。
- **无上游分支时不输出 `# branch.ab` 行**：展示为「无上游」，不能默认成 0/0。上游名取自 `# branch.upstream`；配了上游而远端分支已被删掉（只有名字没有 ab）时仍按无上游处理。
  - **上游名是 git 缩写过的 refname，有歧义时会带前缀**（`heads/main`、`remotes/origin/main`、乃至完整 `refs/…`）。前端因此不精确比对，而是照 git 自己的 `ref_rev_parse_rules` 次序（`%s` → `refs/%s` → `refs/heads/%s` → `refs/remotes/%s`）拼回完整名字去找——精确比对时这几种情况下徽标静默不画。

## 取 diff

- **按文件懒加载**：列表只做一次 status，diff 在用户点击时才取。**禁止一次性取或渲染全仓 diff**——300+ 文件的整仓 diff 会冻结浏览器主线程数秒以上。
- **重命名必须同时传新旧两个路径**（`git diff HEAD -M -- <新> <旧>`），否则 git 无法配对，退化成一个全新增文件。
- **numstat 可以回不止一条记录：按路径挑、按合计算，不能取 `[0]`**。`git mv` 后重写内容却不 add 时（status 仍报 `R100`），git 拆成「删旧」+「增新」两条：取第一条拿到的是几十行的删除，行数闸放行一份 6 万行的补丁；二进制同理会被挑错。
- 字面量 pathspec 与按路径挑记录**各自都有只有它才拦得住的形态**，不可相互替代。

## 已跟踪与未跟踪的分流

- **「已跟踪」的判据是 HEAD ∪ index，不是 index**：`git rm` 后路径已从 index 摘掉，但 status 照报 `1 D.`、基准侧还在——只查 `ls-files` 会误判成未跟踪，去读一个不存在的文件。`--numstat` 那次调用兼任这个判据，并顺带给出二进制与行数。
- **未跟踪文件手工构造 unified diff**（`--- /dev/null` / `+++ b/<path>`）。**不用 `git diff --no-index`**——它依赖 `/dev/null`，Windows 上不可移植。
- **未跟踪那条路读磁盘必须 `lstat` 不得 `stat`**：`stat` 跟随链接，一个指向仓库外的符号链接就能把外部文件当作新增文件返回。

## 二进制与体积的三道闸

**两道判定在取补丁之前**（numstat 那次调用）：

- **二进制**：已跟踪文件以 numstat 的 `-\t-` 为准（含 `.gitattributes`），只有未跟踪文件走 NUL 字节探测。
- **行数上限 50,000**：已跟踪数 numstat 加+减，未跟踪数文件行数。它挡的是体积挡不住的另一头——窄而长的文件。

**5MB 那道闸，已跟踪侧卡的是补丁字节而不是文件体积**：按文件体积拒绝时，一个 6MB 的数据文件改一行就再也看不了；行数也替代不了它（一行 6MB 的文件 numstat 只报 1 行）。所以这一闸由**取补丁那次调用带着 `maxStdoutBytes` 去撞**，超限即掐断 git。未跟踪侧仍按文件体积判——整份文件就是补丁。`lstat` 因此只用于展示（`DiffPayload.size`，取不到给 0）。

### 图片：二进制里被放行的那一支

**判据是「二进制 ∧ 扩展名在表里」，缺一不可**。表是 `server/git/worktree.ts` 的 `imageMimeOf`（png / jpg / jpeg / gif / webp / bmp / ico / avif；**SVG 不在**——它是文本，文本 diff 更有信息量）。单看扩展名会把内容是文本的 `.png` 画成一张破图。

- **旧侧读 diff 基准里的 blob：`git cat-file blob <base>:<path>`，存在性与体积用 `cat-file -s`。只允许这两种字面参数**：`--filters` / `--textconv` 会跑 smudge / textconv 驱动（LFS 的写 `.git/lfs`），而白名单只看子命令；不用 `git show <rev>:<path>`——字节相同，但它的参数面大到「参数只能是字面量」那条断言钉不住。`cat-file -s` 非零退出即「这一侧不存在」，不是错误。
- **内容身份 `ImageSide.version`**：旧侧是基准的 oid（`resolveDiffBase` 顺手带回的 `DiffBase { ref; oid }`），新侧是体积 + mtime（`worktreeVersion`，与 git 的 stat 缓存同一判据与同一边界）。
- **`<rev>:<path>` 是 revision 语法，`GIT_LITERAL_PATHSPECS` 管不到**：拼进去的 `path` 一律取 `resolveInRepo` 归一化后的那份。
- 重命名的旧侧在 `oldPath`，payload 的 `old.path` 由后端填好。
- **5MB 按侧卡**：任一侧超过 `MAX_BYTES` 即 `too-large`，`size` 取**两侧里大的那个**（只报工作区那份时，8MB 换成 120KB 的图会被说成「file is 120 KB」）。`/api/blob` 自己再卡一次——payload 与取字节是两次请求，中间文件可以长大。
- **`/api/blob` 只服务表里的扩展名**，非图片一律 400；取新侧**就是 `inspectFile` 那条链**，不另写副本——上一份副本连 NUL 那道都没有，同一个文件在 payload 里是文本、在字节端点上被当图发出去。

## 提交历史

提交列表、一次提交改了哪些文件、其中一个文件的补丁——**只往只读白名单里加了 `log` 一条**：提交 diff 是 `diff <parent> <sha>`，图片两侧是 `cat-file`，校验是 `rev-parse`。禁引入 `show` / `diff-tree` / `rev-list`。代码在 `server/git/history.ts` 与 `diff.ts`。

- **`log` 的 argv 整条是字面量，只有两种形态**：列表 `log --no-show-signature --no-color -z --format=%H%x00%P%x00%an%x00%at%x00%s%x00%b --max-count=<n> --skip=<n> <起点> --`，单条提交是同一串去掉 `--skip`、`--max-count=1`。冒烟逐段钉着它。
  - **`--no-show-signature`**：`log.showSignature` 会对每条提交起一次 gpg。
  - **不带 `-p` / `--stat` / 任何 diff 选项**：`log` 一算 diff，`diff.external` 与 textconv 就在射程内。
  - **`-z` + 固定六段**：根提交的 `%P` 是空段不是缺段。正文含 NUL 也不错位——git 输出 `%b` 时在第一个 NUL 处截断，每条恒为六段（`history.test.ts` 拿真 git 钉着）。
- **`sha` / `head` 只认完整十六进制对象名**（`^[0-9a-f]{40}([0-9a-f]{24})?$`），`--` 收尾：它们拼在 revision 位置，`GIT_LITERAL_PATHSPECS` 管不到，`--output=<路径>` 在那里就是一次写文件。
- **对象名合法不等于是本仓库里的一个提交**。详情、补丁、图片三条路共用 `resolveCommit`：一次 `log -1` 同时校验与取元数据，**判据是回来的那条正好就是问的这个 sha**——`log` 对不存在的对象退 128，对树与 blob 却退 0、输出为空，对附注标签则剥到它指向的提交，只看退出码总漏一种。失败一律 `not-found`。**对比端也只在这里定一次**，否则三条路可能对着三个不同的父在比。
- **分页是「锚点 + skip」，不是「从 HEAD 往下数」**：第一页从 `HEAD` 起，回来的第一条 oid 写进响应的 `head`；之后每页以它为起点再 `--skip`。按 HEAD 数时 agent 中途提交会让第二页重复第一页的最后一条。一页 50 条，取 51 条判 `hasMore`。
  - **HEAD 取不到时再问一次 `rev-parse --verify --quiet HEAD`**（`repo.ts` 的 `headOid`，「未出生」的判据只此一份）：未出生退 1，回 `{ head: null, commits: [], hasMore: false }`；指着一个读不出来的提交却退 0，那是真实故障、如实报错——`log` 对两者都退 128，只看它会把故障说成 `No commits yet`。
- **一次提交改了哪些文件：`diff --no-ext-diff --no-textconv <parent> <sha> --name-status -z -M`**。重命名占**三段**（`R<score>` + 旧 + 新）。状态字母只认 `A` / `M` / `D` / `R` / `T`。
- **父提交是第一父**（`resolveCommit` 带回的 `%P`）：合并提交展示的是「相对主线带进来了什么」，与 GitHub、VS Code Timeline 同口径。组合 diff 不做——diff2html 解析不了。**根提交对比空树**（`repo.ts` 那份常量，按 sha 长度定格式）。**浅克隆的边界不是根提交**：它的 `%P` 同样为空，拿空树比会把整仓报成全新增。`%P` 为空时读共享 git 目录下的 `shallow` 文件，命中则文件清单为空并标 `shallow`、补丁与图片回 `unsupported`。不缓存——`fetch --deepen` 会改它。
- **单个文件的补丁与工作区 diff 共用三道闸**：先 numstat 判二进制与行数（按路径挑、按合计算），再带 `maxStdoutBytes` 取补丁。拒绝时的 `size` 用 `cat-file -s` 取新侧 blob（删除则旧侧），与工作区 diff 报同一个数；只在拒绝分支上才问。
- **图片两侧都读对象库**：旧侧 `<parent>:<旧路径或路径>`、新侧 `<sha>:<路径>`，同两条 `cat-file` 字面量；`version` 分别是两个对象名，永不换内容。`/api/blob` 带 `commit=<sha>` 即走这一路。

## 分支列表

状态条上那个分支列表**只往白名单里加了 `for-each-ref` 一条**，代码在 `server/git/refs.ts`。**禁用 `branch` / `tag` 列 ref**：那两个子命令本身会写，白名单只看子命令。

- **argv 整条是字面量**：`for-each-ref --format=<…> refs/heads refs/remotes refs/tags`，冒烟逐段钉着。`%(signature)` 一族 atom 会起 gpg；没有任何来自请求的参数。
- **格式是十一段、每段以 `%00` 收尾**（本体六样 + `%(*…)` 解引用形态）。`for-each-ref` 没有 `-z`，按 NUL 切开后每组十一段、下一条前面多一个换行，剥掉即可。只用 git 2.11 已有的 atom，前缀在 JS 里剥。
- **`%(symref)` 非空的跳过**（`refs/remotes/origin/HEAD`，否则同一提交画两行）。
- **附注标签取 `%(*…)` 那几段**：本体是标签对象。轻量标签的 `%(*…)` 全空，用本体。**剥出来的未必是提交**：可能是树，老 git 对标签套标签只剥一层——判据是 `%(*objecttype)` 不是 `commit` 时只留对象名，不把内层标签的说明当提交主题。
- **排序在 JS 里做**（三组，组内按提交时间降序），不用 `--sort`——又一段要钉的参数面。
- partial clone 下只读 ref 与提交，不触发取对象。空仓库输出为空、回空列表。
- **History 的上游徽标复用这一条**按名字找 oid，不另起 `rev-parse @{u}`（又一种要钉的 argv）。

## 全仓内容搜索

侧栏 `Search` 档**只往白名单里加了 `grep` 一条**，代码在 `server/git/search.ts`。搜的是**工作区此刻**的内容（已跟踪文件读工作区那一份，不是 index 或 HEAD），agent 刚写下的字节立刻搜得到。

```
git -c core.quotePath=false -c grep.column=false -c submodule.recurse=false \
    grep --no-color --no-textconv -I -z -n -F --untracked [-i] [-w] -e <查询> --
```

- **argv 除 `-i` / `-w` 两个可选位与 `-e` 后那一个值外整条是字面量**，冒烟逐段钉着。两个 `-c` 由 `run.ts` 按子命令注入（与 `diff` 那两道开关同一处），调用点只写 `grep …`。
- **`-c grep.column=false`**：用户配了 `grep.column` 时每条记录多出一段列号，`-z` 切分整体错位、不报错。`--no-column` 要 git 2.19，而 `-c` 一个老 git 不认的键是静默忽略——下限 2.11 上也成立。
- **`-c submodule.recurse=false`**：配了它时 `--untracked` 直接 fatal（`--untracked not supported with --recurse-submodules`，exit 128），症状是「这台机器上搜索永远报错」。`--no-recurse-submodules` 要 2.12，理由同上。
- **`-I` 不能省**：不带时二进制文件吐的是一行 `Binary file <路径> matches`，没有 NUL 段，解析器会把它与下一条粘成一条。
- **`--no-textconv`**：与 `diff` 同一道外部程序闸。**禁 `-O`（起 pager）、`-f <文件>`（读文件当模式）、`--no-index`（搜仓库外）、`--textconv`**——白名单只看子命令。
- **`-F -e <查询>`**：字面量，`grep.patternType` 被命令行的 `-F` 盖过；`-e` 让以 `-` 开头的查询不被当成选项。查询里的换行会被 git 拆成多个模式，HTTP 层因此拒绝含 `\n` / `\r` / `\0` 的查询（400）。
- **`--untracked`** 让 agent 新建、还没 add 的文件也搜得到，仍尊重 `.gitignore`——被忽略的不搜（`node_modules` 会淹没结果）。工作区已删的已跟踪文件被静默跳过，不报错。
- **退出码 1 是「没有命中」，不是错误**；`runGit` 不抛非零，按码分流，其余非零照常是错误。
- **`-z` 记录是 `<路径>\0<行号>\0<内容>\n`**，按「读到 NUL → 读到 NUL → 读到换行」顺序解析：路径可以含换行；`-I` 只看前 8000 字节，之后的内容里可能有 NUL。
- **体积两道上限，任一触发即 `truncated`**：stdout 8MB 时掐断 git、**收下已到的字节**（`runGit` 的 `truncate` 档，与 diff 那条「超限即 `overflow`」相反——这里要的是前 N 条，不是全有或全无），丢掉最后一条不完整的记录；再按 2,000 行截。git 2.38 才有 `-m`，靠不住。
- **命中区间由后端算**（UTF-16 下标，前端只切段着色）：同一个字面量在 JS 里以 `RegExp` 重找一次，`-i` 对 `i` 标志、`-w` 对 `(?<![A-Za-z0-9_])…(?![A-Za-z0-9_])`——与 git 的字词集一致。找不出区间的行照常返回、只是不高亮。**超过 300 字符的行裁成首个命中前后各一截**、两端补 `…`、区间随之平移：一份压缩过的 JS 一行就是整个文件。
- 搜索不写 `.git`：实测把一个已跟踪文件 stat 弄旧后跑 `grep`，`.git/index` 不变（同一状态下的默认 `git status` 会重写它）。

## 全量文件列表

Quick Open 要一份全仓文件路径，**复用 `ls-files`、不扩白名单**，代码在 `server/git/tree.ts`（与目录树共用 `--stage` 那条的常量与 gitlink 判据）：

```
git ls-files -z --stage --cached
git ls-files -z --others --exclude-standard
```

- **已跟踪那条带 `--stage`、滤掉 `160000`**：submodule 打不开，列出来只会以「不是普通文件」告终。两条不能合一，理由同目录树。
- **未跟踪那条不带 `--directory`**：这里要的是文件，折叠成 `dir/` 就打不开了。被忽略的不列，`node_modules` 因此进不来；代价是未跟踪又未忽略的大目录会整片展开，与 `status -uall` 同一量级。
- **未跟踪那条里以 `/` 结尾的条目丢掉**：未跟踪的内嵌 git 仓库（agent 刚 clone 进来的）即便不带 `--directory` 也只列成一条 `sub/`，它不是文件，列出来是一行名字为空、点开必然失败的条目。
- 去重、按路径排序后整份返回；上限由封装层 64MB 兜底。**工作区已删但仍在 index 里的文件仍会列出**，与目录树同一个已知偏差。

## 目录树的两条 `ls-files`

文件浏览器的树**按目录懒加载**，一次只回**一层**的直接子项——全量树的 JSON 光 `node_modules` 就能比整仓 diff 还大。

一层要**三条**调用（并发发出）：

```
git ls-files -z --stage --cached                                              [-- <本层>]
git ls-files -z --others           --exclude-standard --directory --no-empty-directory [-- <本层>]
git ls-files -z --others --ignored --exclude-standard --directory --no-empty-directory [-- <本层>]
                                            ↑ 后两条非零退出时，pathspec 退到 <本层的第一段> 重问一次
```

三条各答一件事：已跟踪的、未跟踪未忽略的、被忽略的（打上 `ignored`）。

- **已跟踪那条带 `--stage` 拿 mode：`160000` 即 gitlink（submodule）**。否则它与一个文件长得一模一样，点下去以「不是普通文件」告终。**`--stage` 与 `--others` 不能合成一条**：合起来 git 会丢掉未跟踪那部分。
- **`--directory` 与 `--no-empty-directory` 必须同时带**：否则 `node_modules` 底下几万条路径全数返回，**git 照常 exit 0**，症状只是慢得离谱。
- **`--ignored` 必须与 `--exclude-standard` 同用**（否则 fatal，会响，记在这里免得被「顺手精简」）。
- `--` 后那段受 `GIT_LITERAL_PATHSPECS=1` 约束，字面量 pathspec 仍保留前导目录匹配。根那一层不带 `--`。
- **两条 `--others` 非零退出时，pathspec 退到本层第一段重问一次**：被忽略的那一片里深度 ≥ 3 的层，`--ignored` 那条会直接 fatal（`directory entry not superset of prefix`，判据是层数、不是特殊字符，实测与源码分析见 [`../decisions/git.md`](../decisions/git.md)）。第一段不含 `/`，于是恒安全。
- **但第一段只能当兜底，不能当默认**——无条件放宽会静默改掉两件事：被忽略的一片嵌在未跟踪目录里时，`--ignored` 那条一条都不回（那一层不再灰显）；`?path=<未跟踪目录里的一个文件>` 从 400 变 500（文件被折叠进父目录，没人认出这是坏请求）。所以只在 git 已经答不出的那一刻退让；判据是**非零退出**而不是 fatal 消息的字面量；重问再失败就抛原来那个错误。

**收敛成直接子项的判据是「相对本层的第一段」**：后面还有 `/` 的、或 `--directory` 折叠出的以 `/` 结尾的，都是目录。去重后目录在前、各按名字排序（照 VS Code）。

### git 答不出这一层时的兜底

**判据是两条正面证据，不是「一条子项都没有」**：

- **`--directory` 把这一片折叠了**：往里 scope 拿到的仍是那条折叠记录，git 答不出里面有什么。
- **这是一个 submodule**：父仓库只有一条 gitlink 记录，看不进去。

命中时这一层改为 `readdir` 读一层磁盘。**写成「空就兜底」是个 catch-all**：`?path=<一个文件>` 与不存在的路径也会落进来，`ENOTDIR` / `ENOENT` 被咽掉，页面上是一个空目录——而它们本该是 400 / 404。

- **「把一个文件当目录展开」是一条独立判定**：git 提到本层自己这条路径、而它不是 gitlink，就是坏请求。
- **折叠是折在最高那一层**：问 `dist/server` 回来的是 `dist/`。判据必须是「这条折叠记录是本层自己**或祖先**」——写成「正好等于本层」时，这一层两手空空返回，页面上是一个展开后写着 Empty 的目录。
- 走到兜底说明 git 刚断言过整个子树同属一档，于是每个子项的 `ignored` **直接继承**，不在这里重新解释 `.gitignore`。
- `withFileTypes` 的 dirent 不跟随符号链接，指向仓库外的链接只会是一个文件条目。
- **`.git` 要自己滤掉**（按名字、不限层级）：git 输出里从不出现它，而兜底会在刚 `git init` 的空仓库根上生效。
- **仓库根那一层要单独放行**（`allowRoot`）：边界校验刻意把「解析到根自己」判为非法，不放行时根那一层的兜底永远走不到，上一条成了死代码。

### 已知的成本

三条调用**都以「这一层底下的全部路径」为量级**：根那一层每次都枚举全仓，而 `Files` 打开着时每个 `change` 都会重发。目标场景（几千文件）下是几百 KB 的 stdout，与 status 同一量级；上限由封装层 64MB 的 stdout 兜底——真到那一步是 500，不是悄悄给一份不全的树。要支持十万文件级仓库时先改这里。

两个**已知偏差**，是 git 的数据模型使然，不当 bug 修：**空目录不出现**（兜底那条路读磁盘，是例外）；**工作区已删但仍在 index 里的文件仍会列出**，点开得到「文件已不在」。

## 只读读取单个文件

文件浏览器右侧那份内容**直接读磁盘**，不经 git——未跟踪与被忽略的文件在 git 里没有对象。这条路与 `untrackedDiff` 是同一条，**整条分类链只有一份**（`worktree.ts` 的 `inspectFile`）：

- 仓库边界两道（见下）；**`lstat` 而不是 `stat`**，符号链接给的是链接目标字符串本身；
- **顺序**：符号链接 → 非普通文件 → 体积 → 二进制（NUL）→ 图片（扩展名）→ 行数；
- **5MB 与 50,000 行两道闸**复用 `diff.ts` 导出的 `MAX_BYTES` / `MAX_LINES`，**禁另写字面量**；行数在 Buffer 上数，空文件 0 行、末尾换行不另算。

**复用阈值还不够，分类链本身也必须只有一份**：两边各写一遍时，行数口径差了一——正好 50,000 行的文件在 diff 视图能看、在文件视图说太大。

### 仓库边界是两道，缺一道就是一个路径穿越

路径来自 URL query。凡是**真的要落到磁盘上**的路径（未跟踪文件的补丁、只读读文件、目录树兜底），两道都要过：

1. **字面量那道**：拒绝绝对路径、含 `\0` 的路径，以及 `relative(root, abs)` 走出去的。
2. **`realpath` 那道**：中间段全部展开成真实路径，再比一次。

**两道在同一个入口 `resolveInRepo` 里，用途由参数说明、不分叉成几个函数**——分叉时挑错哪个不报错。`follow` 决定最后一段跟不跟随：读文件不跟（链接本身就是要展示的），列目录要跟（`readdir` 本来就跟）。它还**回一份归一化的仓库相对路径**，目录树拿它同时做 pathspec、前缀匹配与 `TreePayload.path`，免得外面补拦不完的 `endsWith('/')` 特判。

**只有第一道时，`lstat` 的保护是假的——它只管最后一段**：`linkdir -> ../outside` 时 `linkdir/secret.txt` 字面上在仓库内，`readFile` 却顺着中间段走出去。挡的是**穿越**而不是符号链接本身：`?path=linkdir` 照常回一个 `symlink`。

## 仓库定位与前置检查

- 用 `git rev-parse --show-toplevel` 定位工作区、`--git-dir` 定位 git 目录。**不得假设 `.git` 是目录**——linked worktree 与 submodule 下它是文件。
- 启动前置检查：`git` 不在 PATH、不是 git 仓库、git 低于 2.11（`--porcelain=v2` 的最低要求），三种情况均给一句话报错，不抛异常栈。
- **bare 仓库**：`--show-toplevel` 以 128 退出，据此一句话拒绝。

## 空仓库

HEAD 不存在时 `git diff HEAD` 直接 fatal，改用**空树对象哈希**作基准，不写特殊分支。

- 按 `git rev-parse --show-object-format` 区分两个**硬编码**常量。**不要**用 `git hash-object -t tree /dev/null`（Windows 不可移植），也**不要**用 `git mktree`（会写对象库）。
- **`--show-object-format` 非零退出即按 SHA-1**：它比 git 下限 2.11 新，而那个区间的 git 造不出 SHA-256 仓库。
- 取值：SHA-1 `4b825dc642cb6eb9a060e54bf8d69288fbee4904`、SHA-256 `6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321`。

## detached HEAD 与进行中的操作

- **detached HEAD**：`# branch.head` 的值是字面量 `(detached)`，据此给出 `detached: true`。**前端不得把这个字面量当分支名画出去**。
- **进行中的多步操作在 porcelain 里一行都没有**，唯一判据是 git 目录下的状态文件（git 自己的 `wt-status.c` 也这么判）。**用 `fs` 读、不新起 git**：多一次子进程既落在每次 `/api/state` 上，又要扩白名单。
- 判据与优先级，**按序取第一个命中**：

  | 命中 | 标注 |
  |---|---|
  | `rebase-merge/` 或 `rebase-apply/rebasing` | `rebase` |
  | `rebase-apply/` 而无 `rebasing` | `am` |
  | `MERGE_HEAD` | `merge` |
  | `CHERRY_PICK_HEAD` | `cherry-pick` |
  | `REVERT_HEAD` | `revert` |
  | `BISECT_LOG` | `bisect` |

  **rebase 必须先于 merge**：rebase 冲突停下时 git 目录里同时有 `MERGE_MSG` / `AUTO_MERGE`。`rebasing` 是 rebase 与 `git am` 唯一的区分。
- **状态文件一律按 `rev-parse --git-dir` 找，不拼 `<root>/.git`**：linked worktree 与 submodule 下按 `<root>/.git` 永远读不到，于是永远标不出操作，且不报错。

## 合并冲突

- **判据是「这条记录来自 `u` 段」，不是状态位**：`u` 记录的 XY 可以是 `UU` / `AA` / `DD` / `AU` / `UD`；按 `!== '.'` 读会让同一个文件同时落进两组，而 `DD` / `AA` 里一个 `U` 都没有。编码为 `FileEntry.conflicted`。
- 冲突文件自身的 diff 照常走 `git diff HEAD`：补丁正文就是带冲突标记的工作区内容。
