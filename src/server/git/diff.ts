// 按文件懒加载取 diff(spec §5.2)。
//
// **禁止一次性获取或渲染全仓 diff** —— agent 单次改 300+ 文件是常态,整仓 diff 会
// 冻结浏览器主线程数秒到数十秒,同时拖垮冷启动指标。

import { lstat, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DiffPayload } from '../shared/protocol.ts';
import { resolveDiffBase } from './repo.ts';
import { runGit, runGitStrict } from './run.ts';

/** 超过这个体积只提示、不预览(spec §3 / §5.2)。 */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * 行数上限。体积阈值挡不住另一头:超长行数的窄文件体积不大,但逐行构造 diff 与
 * 前端渲染同样会卡(spec §5.2)。
 */
const MAX_LINES = 50_000;

export type DiffErrorCode = 'invalid-path' | 'not-found';

export class DiffRequestError extends Error {
  readonly code: DiffErrorCode;
  constructor(code: DiffErrorCode, message: string) {
    super(message);
    this.name = 'DiffRequestError';
    this.code = code;
  }
}

/**
 * 把请求里的仓库相对路径落到磁盘上,并保证它没有走出仓库。
 *
 * 路径来自 URL query,是外部输入。`git diff -- <pathspec>` 自身受仓库边界约束,
 * 但未跟踪文件那条路径要**直接读磁盘**,没有这道检查就是一个路径穿越。
 */
export function resolveInRepo(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0')) {
    throw new DiffRequestError('invalid-path', 'invalid path');
  }
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new DiffRequestError('invalid-path', 'invalid path');
  }
  return abs;
}

/** `-z` 输出里是否原样出现这条路径。 */
function lists(output: string, path: string): boolean {
  return output.split('\0').some((entry) => entry === path);
}

/** 路径在 index 里。 */
async function inIndex(root: string, path: string): Promise<boolean> {
  return lists(await runGitStrict(['ls-files', '-z', '--', path], root), path);
}

/**
 * 路径出现在「基准 → 工作区」的差异里。
 *
 * 这是「已跟踪」判据的另一半:`ls-files` 只答得出 index 里有什么,而已跟踪是
 * **HEAD ∪ index**。`git rm` / `git add -A` 之后,已暂存的删除在 index 里已经没有了
 * (实测 `ls-files` 输出为空),status 却照样报 `1 D.`,基准侧也还在。只认 index 的话
 * 这类文件会被误判成未跟踪、掉进读磁盘那条路,以「文件不存在」告终 —— 而它明明在
 * 变更列表里点得到,且 §3 要求删除按标准 diff 展示。
 */
async function inDiff(root: string, base: string, path: string): Promise<boolean> {
  return lists(await runGitStrict(['diff', base, '--name-only', '-z', '--', path], root), path);
}

/**
 * 已跟踪文件的补丁。
 *
 * **重命名条目必须同时传新旧两个路径**:只传新路径时 git 看不到另一侧、无法配对,
 * 会把重命名退化成一个全新增文件(已实测,spec §5.2),「重命名识别并标注」随之落空。
 * 两个路径都来自 status 的 `2 ` 记录,无需额外查询。
 */
async function trackedDiff(root: string, base: string, path: string, oldPath: string | undefined) {
  const args = oldPath ? ['diff', base, '-M', '--', path, oldPath] : ['diff', base, '--', path];
  const result = await runGit(args, root);
  // 非零退出在这里没有第二种解释(路径不存在、基准无效都属于坏请求)
  if (result.code !== 0) {
    throw new DiffRequestError('not-found', 'no diff available for this path');
  }
  return { kind: 'text', patch: result.stdout } satisfies DiffPayload;
}

/** unified diff 的头四行。未跟踪的一切都是「新增」,左侧恒为 /dev/null。 */
function newFileHeader(path: string, mode: string): string[] {
  return [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    '--- /dev/null',
    `+++ b/${path}`,
  ];
}

/**
 * 未跟踪文件的补丁:**直接读文件内容手工构造 unified diff**。
 *
 * 不用 `git diff --no-index` —— 它依赖 `/dev/null` 作为对比端,Windows 上不可移植
 * (spec §5.2 / §10)。
 */
export async function untrackedDiff(root: string, path: string): Promise<DiffPayload> {
  const abs = resolveInRepo(root, path);

  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    // **必须是 lstat 而不是 stat**:未跟踪的符号链接照样进变更列表(`git status
    // -uall` 报 `? <链接>`,已实测),而 stat 跟随链接 —— 上面 resolveInRepo 校验的
    // 是**链接自身**的路径,读到的却会是链接目标。仓库里一个指向 /etc/passwd 的
    // 链接就能让这个接口把仓库外的文件内容当作新增文件吐出去,穿越防线形同虚设。
    info = await lstat(abs);
  } catch {
    throw new DiffRequestError('not-found', 'file no longer exists');
  }

  // 顺带也是正确的语义:git 对符号链接给的是 mode 120000,正文是**链接目标字符串
  // 本身**、不带末尾换行(已实测),而不是目标文件的内容
  if (info.isSymbolicLink()) {
    const target = await readlink(abs);
    const patch = [
      ...newFileHeader(path, '120000'),
      '@@ -0,0 +1 @@',
      `+${target}`,
      '\\ No newline at end of file',
    ].join('\n');
    return { kind: 'untracked-text', patch: `${patch}\n` };
  }

  if (!info.isFile()) throw new DiffRequestError('invalid-path', 'not a regular file');
  if (info.size > MAX_BYTES) return { kind: 'too-large', size: info.size, reason: 'size' };

  const buffer = await readFile(abs);
  // 已跟踪文件的二进制判定以 `git diff --numstat` 为准(git 自身含 .gitattributes
  // 的判定结果,比启发式准确);只有未跟踪文件才走 NUL 字节探测(spec §5.2)
  if (buffer.includes(0)) return { kind: 'binary' };

  const text = buffer.toString('utf8');
  const endsWithNewline = text.endsWith('\n');
  // `''.split('\n')` 是 `['']` 而不是 `[]` —— 不特判的话空文件会产出一个
  // 「一行空内容 + 末尾无换行」的假 hunk
  const lines = text === '' ? [] : text.split('\n');
  if (endsWithNewline) lines.pop();
  // 体积没超、行数超了 —— `reason` 区分的就是这条路径:文件可能只有几百 KB,
  // 光把体积报给前端解释不了为什么不预览(§5.12)
  if (lines.length > MAX_LINES) return { kind: 'too-large', size: info.size, reason: 'lines' };

  const head = newFileHeader(path, info.mode & 0o111 ? '100755' : '100644');
  if (lines.length === 0) {
    // 空文件:git 自己也不输出 hunk
    return { kind: 'untracked-text', patch: `${head.join('\n')}\n` };
  }
  const body = lines.map((line) => `+${line}`);
  if (!endsWithNewline) body.push('\\ No newline at end of file');

  const patch = [...head, `@@ -0,0 +1,${lines.length} @@`, ...body].join('\n');
  return { kind: 'untracked-text', patch: `${patch}\n` };
}

export interface DiffQuery {
  path: string;
  oldPath?: string | undefined;
}

export async function readDiff(root: string, query: DiffQuery): Promise<DiffPayload> {
  // 先确认路径本身合法,再决定走哪条路 —— 两条路都要用到它
  resolveInRepo(root, query.path);
  if (query.oldPath) resolveInRepo(root, query.oldPath);

  // 基准与 index 查询彼此不依赖,并发跑:串行等于把两次进程启动开销直接叠加,而
  // **每条 `/api/diff` 都要付**。基准在一次请求里只解析一次、两条分支共用 ——
  // 这不是缓存,`resolveDiffBase` 刻意不跨请求缓存的理由见 repo.ts
  const [base, listed] = await Promise.all([resolveDiffBase(root), inIndex(root, query.path)]);

  if (listed || (await inDiff(root, base, query.path))) {
    return trackedDiff(root, base, query.path, query.oldPath);
  }
  return untrackedDiff(root, query.path);
}
