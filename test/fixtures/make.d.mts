// `make.mjs` 的类型契约。
//
// 生成脚本本身必须是零依赖纯 JS(它要在没有 node_modules 的 matrix 机器上跑,
// spec §5.11),所以类型只能手写在这里。改 make.mjs 的导出时记得同步本文件 ——
// 不同步的症状是 `pnpm typecheck` 报错,不会静默。

/** 路径转义验收项的样本:非 ASCII、空格、引号各一;Windows 上不含双引号那条。 */
export declare const TRICKY_PATHS: readonly string[];

/** 仓库外那个文件的内容 —— 任何 diff 里出现它都意味着符号链接被跟随了。 */
export declare const OUTSIDE_SECRET: string;

export interface FixtureRepos {
  /** 路径含非 ASCII / 空格 / 引号,外加一个未跟踪文件。 */
  unicodePaths: string;
  /** 高相似度重命名(`2 R100` 两段记录)+ 阈值之下的重写(拆成 D + A)。 */
  renames: string;
  /** 双状态位的四种组合:`M.` / `.M` / `MM` / `A.`。 */
  staged: string;
  /** 已暂存的删除(`D.`)+ 未暂存的删除(`.D`)+ 一个指向仓库外的未跟踪符号链接。 */
  deletions: string;
  /** 新建分支、无 upstream —— 不输出 `# branch.ab` 行。 */
  noUpstream: string;
  /** 有 upstream 且 ahead 2 / behind 1 —— 上一项的对照面。 */
  upstreamTracking: string;
  /** `git init` 后无任何提交,含一个已 add 的文件。 */
  empty: string;
  /** 320 个文件同时变更。 */
  manyFiles: string;
}

export declare function makeFixtures(destDir: string): FixtureRepos;
