# test/fixtures

测试仓库生成脚本。**零依赖纯 JS,可由 `node <路径>` 直接执行** ——
它要在没有 pnpm、没有 node_modules 的 CI matrix 机器上跑,`pnpm fixtures` 只是别名。

脚本对测试仓库执行的 `git init` 等写操作属「开发流程的 git」,不受零写操作约束
(作用域见 CLAUDE.md 第 1 节)。生成出的仓库落在 `repos/`,已在 `.gitignore` 里。

两批:
- **第一批(S1)决定解析器结构**:非 ASCII / 空格 / 引号路径、重命名(含相似度阈值边界)、
  已暂存改动、无上游的新建分支、空仓库;另需一个 300+ 文件变更的仓库供 S2 验收懒加载
- **第二批(S4)边界与异常**,分两次就位:**S4a** 的新增 / 删除 / 二进制 / >5MB 大文件;
  **S4b** 的 detached HEAD、merge 与 rebase 进行中(各留一个冲突条目)、linked worktree、
  submodule、bare 仓库,以及 SHA-256 空树常量所需的 `--object-format=sha256` 空仓库
