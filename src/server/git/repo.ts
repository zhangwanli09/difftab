// 仓库定位、启动前置检查、diff 基准。

import { basename, isAbsolute, resolve } from 'node:path';
import { GitError, runGit } from './run.ts';

/** `--porcelain=v2` 的最低要求。 */
const MIN_GIT = { major: 2, minor: 11 };

/**
 * 空树对象哈希。空仓库下 HEAD 不存在、`git diff HEAD` 直接 fatal，改用它作 diff 基准即可。
 * 硬编码是**要求**而不是偷懒：`git hash-object -t tree /dev/null` 依赖 `/dev/null`，
 * Windows 上不可移植；`git mktree` 会写对象库，直接违反只读承诺。
 */
const EMPTY_TREE = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  // 两个常量**都是实测取来的**：写错的后果是空仓库下 diff 基准无效，而症状与「空仓库
  // 不支持」难以区分
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

export type PreflightCode = 'git-missing' | 'git-too-old' | 'not-a-repo' | 'bare-repo';

/** 启动前置检查失败。CLI 据此打印一句话友好报错，而不是抛 Node 异常栈。 */
export class PreflightError extends Error {
  readonly code: PreflightCode;
  constructor(code: PreflightCode, message: string) {
    super(message);
    this.name = 'PreflightError';
    this.code = code;
  }
}

export interface RepoInfo {
  /** 工作区根目录绝对路径。 */
  root: string;
  /** git 目录绝对路径。**不得假设它是 `<root>/.git`**——linked worktree 下 `.git` 是文件。 */
  gitDir: string;
}

/** `git version 2.50.1 (Apple Git-155)` → `{ major: 2, minor: 50 }`。 */
export function parseGitVersion(output: string): GitVersion | null {
  const m = /\bversion\s+(\d+)\.(\d+)/.exec(output);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export interface GitVersion {
  major: number;
  minor: number;
}

/** `v` 不低于 `min`。版本比较只此一份——启动下限与 `GIT_NO_LAZY_FETCH` 那道下限共用。 */
export function atLeast(v: GitVersion, min: GitVersion): boolean {
  return v.major > min.major || (v.major === min.major && v.minor >= min.minor);
}

/**
 * 完整对象名：SHA-1 40 位 / SHA-256 64 位小写十六进制。**判据只此一份**——status 解析
 * `# branch.oid` 与提交历史校验请求里的 sha 用的是同一条，两份漂开时前端拿 `BranchState.oid` 去比
 * 的东西与后端认的对象名就不是一回事了。
 */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
}

/**
 * 前置检查 + 定位，一次做完。两条命令并发跑：串行等于把两次进程启动开销叠加进 300ms
 * 冷启动预算，而它们之间没有依赖。
 */
export async function locateRepo(cwd: string): Promise<RepoInfo> {
  const [version, located] = await Promise.all([
    runGit(['--version'], cwd),
    // **不问 `--is-bare-repository`**：成功那条路上它的答案必然是 false，而失败那条路要
    // 靠它区分 bare 与「不是仓库」——那时再单独问一次
    runGit(['rev-parse', '--show-toplevel', '--git-dir'], cwd),
  ]).catch((cause: unknown) => {
    if (cause instanceof GitError && cause.kind === 'missing') {
      throw new PreflightError(
        'git-missing',
        'git was not found on your PATH. Install git and try again.',
      );
    }
    throw cause;
  });

  const parsed = version.code === 0 ? parseGitVersion(version.stdout) : null;
  // 解析不出版本号不当作失败：那多半是某个包装过的 git，而真正的判据是下面
  // rev-parse 能不能跑通。只有**确知**版本低于下限时才拒绝。
  if (parsed && !atLeast(parsed, MIN_GIT)) {
    throw new PreflightError(
      'git-too-old',
      `difftab needs git ${MIN_GIT.major}.${MIN_GIT.minor} or newer ` +
        `(for --porcelain=v2), but found ${parsed.major}.${parsed.minor}.`,
    );
  }

  if (located.code !== 0) {
    // 这里只有两种可能：bare 仓库（`--show-toplevel` 报「must be run in a work tree」）
    // 或根本不是仓库。再问一次以区分——两者的提示完全不同，合并成一句会误导用户。
    const bare = await runGit(['rev-parse', '--is-bare-repository'], cwd);
    if (bare.code === 0 && bare.stdout.trim() === 'true') {
      throw new PreflightError(
        'bare-repo',
        'this is a bare repository — it has no working tree to show changes for.',
      );
    }
    throw new PreflightError('not-a-repo', 'this directory is not inside a git repository.');
  }

  const lines = located.stdout.split('\n');
  const root = lines[0]?.trim();
  const gitDir = lines[1]?.trim();
  if (!root || !gitDir) {
    throw new PreflightError('not-a-repo', 'this directory is not inside a git repository.');
  }

  return {
    root,
    // `--git-dir` 在仓库根下返回相对路径 `.git`，换个子目录跑又是绝对路径
    gitDir: isAbsolute(gitDir) ? gitDir : resolve(root, gitDir),
  };
}

/**
 * 工作区根目录名——页面标题里的项目标识(`RepoState.repoName`)。
 *
 * **和 `root` 住在一起，不在消费者那边现切**：下面那条「用 `node:path` 不手写切分」的理由
 * 整个建立在 `root` 是怎么来的之上(`rev-parse --show-toplevel`)，而那件事只有本文件知道。
 *
 * **用 `node:path` 的 `basename`，不要自己切 `/`**：Windows 上 `--show-toplevel` 回的是
 * `C:/…` 正斜杠，而 win32 的 basename 两种分隔符都认；POSIX 上 `\` 是合法文件名字符，
 * posix 的 basename 不会误把它当分隔符。根目录没有 basename 时回空串，**不编一个名字
 * 出来**——「取不到时显示什么」是展示决定，归消费者。
 */
export function repoNameOf(repo: RepoInfo): string {
  return basename(repo.root);
}

/**
 * diff 的基准：`ref` 是交给 git 的那个名字，`oid` 是它此刻指向的对象。两个字段是同一次
 * `rev-parse` 的两面——`oid` 只给图片旧侧当内容身份用（基准里那个 blob 只在基准换了之后才可能
 * 变），不再为它多起一次进程。
 */
export interface DiffBase {
  ref: string;
  oid: string;
}

/**
 * 正常仓库的基准是 `HEAD`；空仓库（尚无任何提交）下 HEAD 不存在、`git diff HEAD` 会 fatal，
 * 降级为空树哈希（`ref` 与 `oid` 同为它）。不做缓存：`git checkout --orphan` 之后 HEAD 会重新
 * 变回未出生状态，缓存的正结果会让 diff 从此全部 fatal。
 */
export async function resolveDiffBase(root: string): Promise<DiffBase> {
  const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
  const oid = head.stdout.trim();
  if (head.code === 0 && oid) return { ref: 'HEAD', oid };
  const empty = await emptyTree(root);
  return { ref: empty, oid: empty };
}

/**
 * 某个对象名所在格式下的空树哈希：64 位即 SHA-256，其余按 SHA-1。提交历史手里已经有一个对象名，
 * 用它的长度就能定格式，不必为根提交再问一次 `--show-object-format`。
 */
export function emptyTreeOf(oid: string): string {
  return oid.length === 64 ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1;
}

/**
 * 本仓库对象格式下的空树哈希——空仓库的 diff 基准。手上还没有任何对象名，只能问 git。
 */
async function emptyTree(root: string): Promise<string> {
  const format = await runGit(['rev-parse', '--show-object-format'], root);
  // `--show-object-format` 随 SHA-256 支持（git 2.29 前后）才引入，高于下限 2.11。
  // **非零退出即按 SHA-1 处理**——那个区间的 git 根本造不出 SHA-256 仓库，降级无歧义
  const name = format.code === 0 ? format.stdout.trim() : 'sha1';
  return name === 'sha256' ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1;
}
