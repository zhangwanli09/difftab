// 前后端共用的协议类型(spec §5.12)。**前端唯一允许 import 的后端目录。**
//
// 字段与判别式在 S1 即定型,即使 binary / too-large / 重命名标注的填充逻辑要到 S4、
// watch 的真实取值要到 S3b。晚定的代价是前端按 kind: 'text' 单一形状、按「永远不
// 降级」写死,后面再回头改渲染分支(spec §5.12「字段定型时机」)。
//
// 本文件描述**形状**,外加解释这些形状所需的谓词。**解析**逻辑(把 git 的字节变成
// 这些形状)一律留在 server/git;而**状态位的含义**按 §5.0 不变式 4 正是本文件的职责,
// 否则每个消费者都会各自把 `staged !== '.'` 这类判据再写一遍,而那些判据并不都对
// (见下面 `hasStagedChange` 的注释)。

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

/**
 * 该条目在**暂存区侧**是否有改动(porcelain 的 X 位)。
 *
 * 判据看起来只是 `staged !== '.'`,但三种取值里有两种不能按字面读,所以它必须
 * 只有一份实现(§5.0 不变式 4):
 * - `?` 是本协议对未跟踪的编码、**不是** porcelain 的状态位,只出现在 `unstaged` 上;
 *   未跟踪自成一类,靠 `kind` 判定,不能靠状态位;
 * - `U`(未合并)两侧同时为 `U`,按字面读会让一个冲突文件同时进「已暂存」和
 *   「未暂存」两组。**TODO(S4b)**:合并冲突应当单独成组 —— §5.3 的 git 异常状态归
 *   那一阶段,在此之前维持现状(进两组)而不是让它从列表里消失,后者更糟。
 */
export function hasStagedChange(entry: FileEntry): boolean {
  return entry.kind === 'tracked' && entry.staged !== '.';
}

/** 同上,工作区侧(porcelain 的 Y 位)。未跟踪不算在内 —— 它由 `isUntracked` 承担。 */
export function hasUnstagedChange(entry: FileEntry): boolean {
  return entry.kind === 'tracked' && entry.unstaged !== '.';
}

/** 未跟踪。判据是 `kind`,不是 `unstaged === '?'`(理由见 `hasStagedChange`)。 */
export function isUntracked(entry: FileEntry): boolean {
  return entry.kind === 'untracked';
}

export interface BranchState {
  /**
   * 分支名;detached 时为 `# branch.head` 给出的字面量(git 输出 `(detached)`)。
   *
   * **空串的含义是「status 输出里根本没有 `# branch.head` 行」**(解析器的初值,
   * 由 status.test.ts 钉着)。解析器不为此编一个 `main` / `HEAD` 出来 —— 那是在
   * 事实来源这一层说假话;「取不到时显示什么」是展示决定,归消费者。
   */
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
 * 服务端 SSE 心跳周期(spec §5.8「服务端 SSE 心跳约 15s」)。
 *
 * **它是协议的一部分,所以定在这里而不是 http/sse.ts**:后端拿它当发送周期,前端
 * 拿它当「对端还在」的判据(`web/state/events.ts` 的 `STALE_MS` 由它推出来)。两边
 * 各写一个 15000,改周期时只改一边不会报错、也没有任何用例会红 —— 前端的死连接
 * 判定就此静默失准,而症状只是「有时候刷不出来」。
 */
export const HEARTBEAT_MS = 15_000;

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
  | {
      kind: 'too-large';
      /** 文件字节数。**不足以解释拒绝的原因**,见 `reason`。 */
      size: number;
      /**
       * 哪个阈值拦下了它:`size` 是体积超 5MB,`lines` 是行数超 50,000(§5.2 两个
       * 触发口都在 server/git/diff.ts)。
       *
       * 少了这个字段,行数那一路的文件前端只能拿到一个几百 KB 的体积 —— 既解释不了
       * 为什么不预览,按 MB 取整还会显示「文件过大(0 MB)」。判别原因属 git 侧知识,
       * 前端无法从 `size` 反推(§5.0 不变式 4)。
       */
      reason: 'size' | 'lines';
    };

/** 错误响应。`message` 不含绝对路径(§5.12 / §5.9)。 */
export interface ErrorPayload {
  error: { code: string; message: string };
}
