# server/git

status / diff / numstat 的调用与解析，外加文件浏览器那两样：`tree.ts`（一层目录的两条 `ls-files`）与 `file.ts`（只读读一个文件）。

`worktree.ts` 是三者共同的底座：仓库边界（两道）、只读读一个文件的分类链、以及 5MB / 50,000 行两道闸都归它，`diff.ts` / `file.ts` / `tree.ts` 平级 import。它**不起 git 子进程**——树上点得到的路径包含未跟踪与被忽略的文件，那些在对象库里根本没有对应的对象。它先前长在 `diff.ts` 里，于是两个新模块反向 import 一个 feature 模块，而「只读读磁盘」这个 concern 没有 owner，只有一个恰好先写出来的宿主。

另一个例外是 `operation.ts`：进行中的多步操作（rebase / merge / …）在 porcelain 输出里一行都没有，只能读 git 目录下的状态文件，所以它是本目录里**不起子进程**的那一个。为它多起一次 git 既落在每次 `/api/state` 上，又要往只读白名单里添条目。

**边界**：本目录是产品代码中**唯一**执行 git 子进程的位置（架构边界不变式 1）。只读白名单主门禁与 `-c core.quotePath=false` 统一注入都依赖这个单点，在别处调 git 即使命令只读也算违规——不报错，只是让门禁静默失去覆盖。不得反向 import `http/` 或 `cli/`。
