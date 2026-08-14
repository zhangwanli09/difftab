# server/git

status / diff / numstat 的调用与解析(spec §5.2 / §5.3)。

唯一的例外是 `operation.ts`:进行中的多步操作(rebase / merge / …)在 porcelain 输出里
一行都没有,只能读 git 目录下的状态文件,所以它是本目录里**不起子进程**的那一个
(spec §5.3)。为它多起一次 git 既落在每次 `/api/state` 上,又要往只读白名单里添条目。

**边界**:本目录是产品代码中**唯一**执行 git 子进程的位置(spec §5.0 不变式 1)。
§5.10 的只读白名单主门禁与 §5.2 的 `-c core.quotePath=false` 统一注入都依赖这个单点,
在别处调 git 即使命令只读也算违规 —— 不报错,只是让门禁静默失去覆盖。
不得反向 import `http/` 或 `cli/`。
