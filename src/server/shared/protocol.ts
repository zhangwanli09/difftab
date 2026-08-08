// 前后端共用的协议类型(spec §5.12)。**前端唯一允许 import 的后端目录。**
//
// 字段与判别式在 S1 即定型,即使 binary / too-large / 重命名标注的填充逻辑要到 S4、
// watch 的真实取值要到 S3b。晚定的代价是前端按 kind: 'text' 单一形状、按「永远不
// 降级」写死,后面再回头改渲染分支(spec §5.12「字段定型时机」)。
//
// 本文件只描述**形状**,不含任何解析逻辑 —— git 知识(状态位含义、空树哈希、
// 路径转义、重命名判定)一律留在 server/git,前端不得出现第二份实现(§5.0 不变式 4)。

/**
 * `porcelain=v2` 的单侧状态位。
 *
 * `.` 未改动 / `M` 修改 / `T` 类型变更 / `A` 新增 / `D` 删除 / `R` 重命名 /
 * `C` 复制 / `U` 未合并;`?` 是本协议对未跟踪文件的编码 —— porcelain 的 `? ` 记录
 * 本身没有 XY 两位,统一成 `staged: '.'` + `unstaged: '?'`,前端不必为它单开一条分支。
 */
export type StatusCode = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

export interface FileEntry {
  /** 相对仓库根、以 `/` 分隔的路径。原样来自 `-z` 输出,不含任何 C 风格转义。 */
  path: string;
  /** 仅重命名/复制条目有:改名前的路径。取 diff 时必须与 `path` 一同传给 git(§5.2)。 */
  oldPath?: string;
  kind: 'tracked' | 'untracked';
  /** 暂存区相对 HEAD 的状态位(porcelain 的 X)。 */
  staged: StatusCode;
  /** 工作区相对暂存区的状态位(porcelain 的 Y)。 */
  unstaged: StatusCode;
  /** 重命名/复制的相似度(`R100` → 100)。 */
  renameScore?: number;
}

export interface BranchState {
  /** 分支名;detached 时为 `# branch.head` 给出的字面量(git 输出 `(detached)`)。 */
  head: string;
  detached: boolean;
  /**
   * `null` 即**无上游**。
   *
   * 无上游分支不输出 `# branch.ab` 行(已实测,§5.2),此时必须展示「无上游」
   * 而不是 0/0。把它编码进类型而非留作约定,前端就不可能漏掉这条分支。
   */
  upstream: null | { ahead: number; behind: number };
  /** 仓库正处于的多步操作。TODO(S4):当前恒不填充。 */
  operation?: 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect';
}

/**
 * 监听档位与是否已降级(spec §5.7 / §5.12)。
 *
 * 降级既可能是 C 档的既定形态,也可能是 A/B 档运行中落到轮询兜底 —— 前端无从
 * 自己推断,必须由后端告知。TODO(S3b):当前返回占位值。
 */
export interface WatchState {
  mode: 'native' | 'polling';
  tier: 'A' | 'B' | 'C';
}

/** `GET /api/state` 的响应体。 */
export interface RepoState {
  branch: BranchState;
  files: FileEntry[];
  watch: WatchState;
}

/**
 * `GET /api/diff` 的响应体,判别联合。
 *
 * `text` 是已跟踪文件的 `git diff` 补丁正文;`untracked-text` 是未跟踪文件手工
 * 构造的 unified diff(不走 `--no-index`,§5.2)—— 两者分开是因为后者的补丁不来自
 * git,前端将来若要做「以 git 输出为准」的断言,得能区分。
 */
export type DiffPayload =
  | { kind: 'text'; patch: string }
  | { kind: 'untracked-text'; patch: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number };

/** 错误响应。`message` 不含绝对路径(§5.12 / §5.9)。 */
export interface ErrorPayload {
  error: { code: string; message: string };
}
