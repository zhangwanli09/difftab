// 前后端共用的协议类型。**前端唯一允许 import 的后端目录。**
//
// 本文件描述**形状**，外加解释这些形状所需的谓词。**解析**逻辑(把 git 的字节变成这些
// 形状)一律留在 server/git；而**状态位的含义**正是本文件的职责，否则每个消费者都会各自
// 把 `staged !== '.'` 这类判据再写一遍，而那些判据并不都对（见下面 `hasStagedChange`）。

/**
 * `porcelain=v2` 的单侧状态位。`.` 未改动 / `M` 修改 / `T` 类型变更 / `A` 新增 / `D` 删除
 * / `R` 重命名 / `C` 复制 / `U` 未合并；`?` 是本协议对未跟踪文件的编码——porcelain 的
 * `? ` 记录本身没有 XY 两位，统一成 `staged: '.'` + `unstaged: '?'`。
 */
export type StatusCode = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

export interface FileEntry {
  /** 相对仓库根、以 `/` 分隔的路径。原样来自 `-z` 输出，不含任何 C 风格转义。 */
  path: string;
  /** 仅重命名/复制条目有：改名前的路径。取 diff 时必须与 `path` 一同传给 git。 */
  oldPath?: string;
  kind: 'tracked' | 'untracked';
  /** 暂存区相对 HEAD 的状态位（porcelain 的 X）。 */
  staged: StatusCode;
  /** 工作区相对暂存区的状态位（porcelain 的 Y）。 */
  unstaged: StatusCode;
  /** 重命名/复制的相似度(`R100` → 100)。 */
  renameScore?: number;
  /**
   * 未合并（冲突）条目——**「这条来自 porcelain 的 `u` 记录」这一事实本身**，不是从状态
   * 位推出来的：`u` 记录的 XY 可以是 `UU` / `AA` / `DD` / `AU` / `UD`，而 `DD` 两位都不是
   * `U`，靠状态位认会漏掉一半形态。判据留在解析器那一侧，前端就不必重写一遍 porcelain 的
   * 记录类型。
   */
  conflicted?: true;
}

/**
 * 该条目在**暂存区侧**是否有改动（porcelain 的 X 位）。判据看起来只是 `staged !== '.'`，
 * 但三种取值里有两种不能按字面读，所以它必须只有一份实现：
 * - `?` 是本协议对未跟踪的编码、**不是** porcelain 的状态位，未跟踪自成一类，靠 `kind` 判；
 * - **未合并（冲突）条目两侧同样都不是 `.`**，按字面读会让一个冲突文件同时进「已暂存」与
 *   「未暂存」两组——而那两组说的是「已经 add 了」与「改了还没 add」，冲突文件哪一组都
 *   不属于，它由 `isConflicted` 单独成组。
 */
export function hasStagedChange(entry: FileEntry): boolean {
  return entry.kind === 'tracked' && !entry.conflicted && entry.staged !== '.';
}

/** 同上，工作区侧（porcelain 的 Y 位）。未跟踪不算在内——它由 `isUntracked` 承担。 */
export function hasUnstagedChange(entry: FileEntry): boolean {
  return entry.kind === 'tracked' && !entry.conflicted && entry.unstaged !== '.';
}

/** 未跟踪。判据是 `kind`，不是 `unstaged === '?'`（理由见 `hasStagedChange`）。 */
export function isUntracked(entry: FileEntry): boolean {
  return entry.kind === 'untracked';
}

/**
 * 未合并（冲突）。判据是 `conflicted` 而不是 `staged === 'U'`（理由见该字段）。少了它，冲突
 * 文件要么同时出现在两组里、要么被两组同时排除掉从列表里消失——后者更糟：用户正在解冲突，
 * 而页面告诉他工作区是干净的。
 */
export function isConflicted(entry: FileEntry): boolean {
  return entry.conflicted === true;
}

export interface BranchState {
  /**
   * 分支名；detached 时为 `# branch.head` 给出的字面量（git 输出 `(detached)`）。**空串的
   * 含义是「status 输出里根本没有 `# branch.head` 行」**——解析器不为此编一个 `main` 出
   * 来，那是在事实来源这一层说假话；「取不到时显示什么」是展示决定，归消费者。
   */
  head: string;
  detached: boolean;
  /**
   * `null` 即**无上游**：无上游分支不输出 `# branch.ab` 行，此时必须展示「无上游」而不是
   * 0/0。把它编码进类型而非留作约定，前端就不可能漏掉这条分支。
   */
  upstream: null | { ahead: number; behind: number };
  /**
   * 仓库正处于的多步操作；缺省即「没有」。它**不来自 status 输出**——porcelain 里一行都
   * 没有，判据是 git 目录下的状态文件。`am` 与 `rebase` 分开列是因为两者共用同一个
   * `rebase-apply/` 目录，合并成一个标注等于对用户说假话。
   *
   * **与 `detached` 是同时出现的两件事，不是二选一**：rebase 停下时 status 报的
   * `# branch.head` 就是 `(detached)`。
   */
  operation?: 'rebase' | 'am' | 'merge' | 'cherry-pick' | 'revert' | 'bisect';
}

/**
 * 服务端 SSE 心跳周期（约 15s）。**它是协议的一部分，所以定在这里而不是 http/sse.ts**：
 * 后端拿它当发送周期，前端拿它当「对端还在」的判据。两边各写一个 15000，改周期时只改一边
 * 不会报错、也没有任何用例会红——前端的死连接判定就此静默失准，症状只是「有时候刷不出来」。
 */
export const HEARTBEAT_MS = 15_000;

/**
 * 监听档位与是否已降级。降级既可能是 C 档的既定形态，也可能是 A/B 档运行中落到轮询兜底
 *——前端无从自己推断，必须由后端告知。
 */
export interface WatchState {
  mode: 'native' | 'polling';
  tier: 'A' | 'B' | 'C';
}

/** `GET /api/state` 的响应体。 */
export interface RepoState {
  /**
   * 工作区根目录名（`RepoInfo.root` 的 basename），页面标题里的项目标识。**给的是目录名
   * 而不是路径**：「错误消息不含绝对路径」防的是把本机目录结构混进面向页面的输出，而
   * basename 是回答「这个标签属于哪个项目」所需的最小的那一份。
   *
   * **空串的含义是「这个根目录没有 basename」**（`/`、Windows 的盘符根），与
   * `BranchState.head` 同一条口径：后端不为此编一个名字出来，前端退回纯 `difftab`。
   */
  repoName: string;
  branch: BranchState;
  files: FileEntry[];
  watch: WatchState;
}

/**
 * `GET /api/diff` 的响应体，判别联合。`text` 是已跟踪文件的 `git diff` 补丁正文；
 * `untracked-text` 是未跟踪文件手工构造的 unified diff（不走 `--no-index`）——两者分开是
 * 因为后者的补丁不来自 git，前端将来若要做「以 git 输出为准」的断言，得能区分。
 */
export type DiffPayload =
  | { kind: 'text'; patch: string }
  | { kind: 'untracked-text'; patch: string }
  | { kind: 'binary' }
  | {
      kind: 'too-large';
      /** 文件字节数。**不足以解释拒绝的原因**，见 `reason`。 */
      size: number;
      /**
       * 哪个阈值拦下了它：`size` 是体积超 5MB,`lines` 是行数超 50,000。少了这个字段，行数
       * 那一路的文件前端只能拿到一个几百 KB 的体积——既解释不了为什么不预览，按 MB 取整
       * 还会显示「文件过大(0 MB)」。判别原因属 git 侧知识，前端无法从 `size` 反推。
       */
      reason: 'size' | 'lines';
    };

/** 错误响应。`message` 不含绝对路径。 */
export interface ErrorPayload {
  error: { code: string; message: string };
}
