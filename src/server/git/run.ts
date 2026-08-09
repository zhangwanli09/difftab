// 产品代码中**唯一**执行 git 子进程的位置(spec §5.0 不变式 1)。
//
// §5.10 的只读白名单主门禁与 §5.2 的 `-c core.quotePath=false` 统一注入都依赖这个单点。
// 在别处调 git 即使命令只读也算违规 —— 不报错,只是让门禁静默失去覆盖。

import { spawn } from 'node:child_process';

/**
 * 所有 git 调用统一注入,不留给各调用点自己记得加(spec §5.2)。
 *
 * `-z` 只作用于 status / numstat 这类**列表输出**,管不到 `git diff` 的补丁正文 ——
 * 正文里的 `diff --git` / `---` / `+++` / `rename from|to` 头部行仍会按 C 风格转义
 * (已实测),而 diff2html 恰恰是从这些头部行解析文件名的。两者互补,不可相互替代。
 *
 * 注入位置必须在子命令**之前**:`-c` 是 git 的全局选项,放在子命令后面 git 不认。
 */
const GLOBAL_CONFIG = ['-c', 'core.quotePath=false'];

/**
 * 子进程环境。
 *
 * `GIT_OPTIONAL_LOCKS=0` 是只读承诺的一部分而不是性能开关:默认情况下 `git status`
 * 会顺手把刷新过的 stat 缓存写回 `.git/index`。那不改变 status 的输出,因此
 * 「前后 `git status` 比对」这类验证发现不了它(§5.10 排除该做法的原因之一)。
 *
 * **把这一行删掉,只读 `.git` 那半层门禁照样全绿**(已实测,见 §10):git 把 index
 * 回写当 best-effort,`.git` 不可写时它静默跳过、exit 0、stderr 全空。真正看得见
 * 的是 §5.10 第二层的 **B 半**——在可写的 `.git` 上前后做逐字节快照比对
 * (`test/smoke/readonly-git-dir.test.js`)。别把 B 半当成 A 半的重复给删了。
 *
 * 该变量在 git < 2.15 上不存在,设了也无害 —— 那个区间的 git 只是照旧写 index。
 *
 * `GIT_TERMINAL_PROMPT=0` 防止任何意外的凭据交互把无人值守的进程挂住。
 */
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } as const;

/**
 * 单次调用的 stdout 上限。
 *
 * 没有它,一个几百 MB 的文件的 diff 会被整个读进内存,而这条路径上没有任何东西
 * 会先失败。TODO(S4):真正的 5MB / 50,000 行门槛属于 §5.2 的边界情况处理,
 * 应当在**取 diff 之前**判定;本处只是最后一道防线,不承担产品语义。
 */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
  /** 退出码。`null` 表示被信号杀掉。 */
  code: number | null;
}

export type GitFailureKind = 'missing' | 'exit' | 'overflow';

export class GitError extends Error {
  readonly kind: GitFailureKind;
  readonly args: readonly string[];
  readonly stderr: string;
  readonly code: number | null;

  constructor(kind: GitFailureKind, args: readonly string[], stderr: string, code: number | null) {
    super(`git ${args.join(' ')} failed (${kind})`);
    this.name = 'GitError';
    this.kind = kind;
    this.args = args;
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * 跑一条 git 命令。**非零退出不抛异常** —— 交给调用方判断,因为若干只读探测
 * (空仓库下的 `rev-parse --verify HEAD`、下限之下的 `--show-object-format`)
 * 正是靠非零退出来给出答案的。
 */
export function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const argv = [...GLOBAL_CONFIG, ...args];
    const child = spawn('git', argv, {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
      // shell: false(默认)—— 参数原样传递,路径里的空格与引号不经第二次解析
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let overflowed = false;

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        overflowed = true;
        child.kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err.push(chunk);
    });

    child.on('error', (cause: NodeJS.ErrnoException) => {
      // ENOENT 即 git 不在 PATH —— 前置检查靠它给出一句话友好报错(§5.2)
      rejectPromise(
        new GitError(
          cause.code === 'ENOENT' ? 'missing' : 'exit',
          argv,
          String(cause.message),
          null,
        ),
      );
    });

    // 'close' 而非 'exit':后者在进程终止时就触发,此时 stdio 未必读干净
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (overflowed) {
        rejectPromise(new GitError('overflow', argv, stderr, code));
        return;
      }
      resolvePromise({ stdout: Buffer.concat(out).toString('utf8'), stderr, code });
    });
  });
}

/** 同上,但非零退出即抛。用于「失败没有第二种解释」的调用点。 */
export async function runGitStrict(args: readonly string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw new GitError('exit', args, result.stderr, result.code);
  }
  return result.stdout;
}
