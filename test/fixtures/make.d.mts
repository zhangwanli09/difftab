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
  /**
   * diff 边界(S4a):已跟踪/未跟踪各一个二进制、一行 6MB 的 `huge.txt`、
   * 60,000 行的 `wide.txt`(两个阈值各触发一个)、6MB 但只改一行的 `bulky.txt`
   * (补丁字节闸与文件字节闸的分水岭)、一个已暂存的新增文件。
   */
  diffEdges: string;
}

export type FixtureName = keyof FixtureRepos;

/** 全部仓库名。既是 `only` 的校验表,也是未生成仓库那几个报错 getter 的清单。 */
export declare const ALL_REPOS: readonly FixtureName[];

/**
 * `only` 省略即生成全部。只列一部分时,**未生成的仓库仍在返回值上**,但读它会抛 ——
 * 给 undefined 会让调用方带着它去 spawn,错得离原因很远。
 */
export declare function makeFixtures(destDir: string, only?: readonly FixtureName[]): FixtureRepos;
