// 仓库定位、启动前置检查、diff 基准(spec §5.2 / §5.3)。

import { isAbsolute, resolve } from 'node:path';
import { GitError, runGit } from './run.ts';

/** `--porcelain=v2` 的最低要求(spec §5.2)。 */
const MIN_GIT = { major: 2, minor: 11 };

/**
 * 空树对象哈希。空仓库下 HEAD 不存在、`git diff HEAD` 直接 fatal,改用它作 diff 基准
 * 即可(spec §5.3),不必为空仓库写一条特殊分支。
 *
 * 硬编码是**要求**而不是偷懒:`git hash-object -t tree /dev/null` 依赖 `/dev/null`,
 * Windows 上不可移植;`git mktree` 会写对象库,直接违反只读承诺。
 */
const EMPTY_TREE = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  // 两个常量**都是实测取来的**,不是凭记忆写的(§5.3):写错的后果是空仓库下
  // diff 基准无效,而症状与「空仓库不支持」难以区分。SHA-256 这个于 S4b 在
  // `git init --object-format=sha256` 的仓库上取值,并验过它当基准确实出补丁(§10)
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

export type PreflightCode = 'git-missing' | 'git-too-old' | 'not-a-repo' | 'bare-repo';

/** 启动前置检查失败。CLI 据此打印一句话友好报错,而不是抛 Node 异常栈(§5.2)。 */
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
  /** git 目录绝对路径。**不得假设它是 `<root>/.git`** —— linked worktree 下 `.git` 是文件(§5.2)。 */
  gitDir: string;
}

/** `git version 2.50.1 (Apple Git-155)` → `{ major: 2, minor: 50 }`。 */
export function parseGitVersion(output: string): { major: number; minor: number } | null {
  const m = /\bversion\s+(\d+)\.(\d+)/.exec(output);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

function tooOld(v: { major: number; minor: number }): boolean {
  return v.major < MIN_GIT.major || (v.major === MIN_GIT.major && v.minor < MIN_GIT.minor);
}

/**
 * 前置检查 + 定位,一次做完。
 *
 * 两条命令并发跑:串行等于把两次进程启动开销叠加进 §6 的 300ms 冷启动预算,
 * 而它们之间没有依赖。失败路径上的额外一次 `rev-parse` 不计成本 —— 那条路径的
 * 终点是打印一行报错然后退出。
 */
export async function locateRepo(cwd: string): Promise<RepoInfo> {
  const [version, located] = await Promise.all([
    runGit(['--version'], cwd),
    // **不问 `--is-bare-repository`**:成功那条路上它的答案必然是 false(bare 仓库
    // 根本走不到这里),而失败那条路要靠它区分 bare 与「不是仓库」—— 那时再单独问
    // 一次。跟着问一句从不读的输出,只会让下一个人以为这里读了它
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
  // 解析不出版本号不当作失败:那多半是某个包装过的 git,而真正的判据是下面
  // rev-parse 能不能跑通。只有**确知**版本低于下限时才拒绝。
  if (parsed && tooOld(parsed)) {
    throw new PreflightError(
      'git-too-old',
      `difftab needs git ${MIN_GIT.major}.${MIN_GIT.minor} or newer ` +
        `(for --porcelain=v2), but found ${parsed.major}.${parsed.minor}.`,
    );
  }

  if (located.code !== 0) {
    // 这里只有两种可能:bare 仓库(`--show-toplevel` 报「must be run in a work tree」)
    // 或根本不是仓库。再问一次以区分 —— 两者的提示完全不同,合并成一句会误导用户。
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
    // `--git-dir` 在仓库根下返回相对路径 `.git`,换个子目录跑又是绝对路径
    gitDir: isAbsolute(gitDir) ? gitDir : resolve(root, gitDir),
  };
}

/**
 * diff 的基准。
 *
 * 正常仓库是 `HEAD`;空仓库(尚无任何提交)下 HEAD 不存在,`git diff HEAD` 会 fatal,
 * 降级为空树哈希(spec §5.3)。
 *
 * 不做缓存:`git checkout --orphan` 之后 HEAD 会重新变回未出生状态,缓存的正结果
 * 会让 diff 从此全部 fatal。这条只在取 diff 时调用,不落在冷启动路径上。
 */
export async function resolveDiffBase(root: string): Promise<string> {
  const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
  if (head.code === 0 && head.stdout.trim()) return 'HEAD';

  const format = await runGit(['rev-parse', '--show-object-format'], root);
  // `--show-object-format` 随 SHA-256 支持(git 2.29 前后)才引入,高于 §5.2 的
  // 下限 2.11。**非零退出即按 SHA-1 处理** —— 那个区间的 git 根本造不出 SHA-256
  // 仓库,降级无歧义,不得让它成为空仓库路径上的崩溃点(spec §5.3)。
  const name = format.code === 0 ? format.stdout.trim() : 'sha1';
  return name === 'sha256' ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1;
}
