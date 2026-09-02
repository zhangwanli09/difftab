// 产品代码中**唯一**执行 git 子进程的位置。只读白名单主门禁与 `-c core.quotePath=false`
// 统一注入都依赖这个单点——在别处调 git 即使命令只读也算违规，不报错，只是让门禁静默
// 失去覆盖。

import { spawn } from 'node:child_process';

/**
 * 所有 git 调用统一注入，不留给各调用点自己记得加。`-z` 只作用于 status / numstat 这类
 * **列表输出**，管不到 `git diff` 的补丁正文——正文里的 `diff --git` / `---` / `+++` /
 * `rename from|to` 头部行仍按 C 风格转义，而 diff2html 恰恰从这些头部行解析文件名。
 *
 * 注入位置必须在子命令**之前**：`-c` 是 git 的全局选项，放在子命令后面 git 不认。
 */
const GLOBAL_CONFIG = ['-c', 'core.quotePath=false'];

/**
 * 子进程环境。
 *
 * `GIT_OPTIONAL_LOCKS=0` 是只读承诺的一部分而不是性能开关：默认情况下 `git status` 会顺手
 * 把刷新过的 stat 缓存写回 `.git/index`。那不改变 status 的输出，「前后 `git status` 比对」
 * 这类验证因此发现不了它。**把这一行删掉，只读 `.git` 那半层门禁照样全绿**——git 把
 * index 回写当 best-effort,`.git` 不可写时静默跳过、exit 0、stderr 全空；真正看得见的是
 * 第二层的 **B 半**（可写 `.git` 上的逐字节快照比对），别把它当成 A 半的重复给删了。
 *
 * `GIT_TERMINAL_PROMPT=0` 防止任何意外的凭据交互把无人值守的进程挂住。
 *
 * **`GIT_LITERAL_PATHSPECS=1` 是安全项而不是洁癖**：`--` 后面的路径默认是 wildmatch
 * 模式，而我们的路径全部来自 URL query——`path=*` 会让 `git diff HEAD -- '*'` 回一份
 * **整仓 diff**，正是红线明令禁止、会把浏览器主线程冻上数十秒的那件事；而一个真实存在、
 * 名字里带 `*` 的文件同样会匹配到别人身上，页面在 A 的标题下显示 B 的补丁。
 */
const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_LITERAL_PATHSPECS: '1',
} as const;

/**
 * stdout 的**兜底**上限：没有它，一个几百 MB 的文件的 diff 会被整个读进内存，而这条路径
 * 上没有任何东西会先失败。产品语义那道 5MB 闸不在这里，由调用方按次传 `maxStdoutBytes`
 *——**能不能渲染取决于补丁多大，而不是文件多大**，一个 6MB 的数据文件改一行照样该看得见。
 */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export interface RunOptions {
  /**
   * 这一次调用的 stdout 上限，超过即以 `overflow` 失败（仍受上面的兜底约束）。**超限是
   * 调用方要的答案，不是意外**：取补丁那一路正是靠它把「补丁太大」与「补丁正常」分开，
   * 而这件事在读完之前无从判断——numstat 给得出行数，给不出字节。
   */
  maxStdoutBytes?: number;
}

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
 * 跑一条 git 命令。**非零退出不抛异常**——若干只读探测（空仓库下的
 * `rev-parse --verify HEAD`、下限之下的 `--show-object-format`）正是靠非零退出给答案的。
 */
export function runGit(
  args: readonly string[],
  cwd: string,
  options: RunOptions = {},
): Promise<GitResult> {
  const limit = Math.min(options.maxStdoutBytes ?? MAX_STDOUT_BYTES, MAX_STDOUT_BYTES);
  return new Promise((resolvePromise, rejectPromise) => {
    const argv = [...GLOBAL_CONFIG, ...args];
    const child = spawn('git', argv, {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
      // shell: false（默认）——参数原样传递，路径里的空格与引号不经第二次解析
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let overflowed = false;

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > limit) {
        overflowed = true;
        child.kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err.push(chunk);
    });

    /**
     * **`kill()` 之后到达的报错是这次 kill 的后果，不是新事实。**
     *
     * 实测里 windows × Node 22.0.x 那一档会在超限掐断 git 之后走到下面的 `'error'` 分支，
     * 于是 `kind` 成了 `exit`，调用方认不出「补丁太大」，`too-large` 那条分支静默变成一个
     * 500。报的是 EPIPE（git 还写在管道上）还是 kill 本身失败无从也无需区分：判定超限
     * 之后，任何错误都是我们自己动手的结果，一律以 `overflow` 收尾。流上的 `'error'` 同样
     * 咽掉——一个没人监听的流错误会以未捕获异常掀掉整个服务。
     */
    const settleOverflow = () => rejectPromise(new GitError('overflow', argv, '', null));
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('error', () => {
        if (overflowed) settleOverflow();
      });
    }

    child.on('error', (cause: NodeJS.ErrnoException) => {
      if (overflowed) {
        settleOverflow();
        return;
      }
      // ENOENT 即 git 不在 PATH——前置检查靠它给出一句话友好报错
      rejectPromise(
        new GitError(
          cause.code === 'ENOENT' ? 'missing' : 'exit',
          argv,
          String(cause.message),
          null,
        ),
      );
    });

    // 'close' 而非 'exit'：后者在进程终止时就触发，此时 stdio 未必读干净
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

/** 同上，但非零退出即抛。用于「失败没有第二种解释」的调用点。 */
export async function runGitStrict(args: readonly string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw new GitError('exit', args, result.stderr, result.code);
  }
  return result.stdout;
}
