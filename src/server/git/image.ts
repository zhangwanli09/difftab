// `/api/blob` 两侧的图片字节，以及 diff 那侧要的「基准里这个 blob 在不在、多大」。
//
// **这是本目录唯一一处读对象库的调用。** 判「这是不是图片」不在这里——那是分类链的一环，
// 归 `worktree.ts`：新侧的字节就是 `inspectFile` 那条链本身（`image` 支带着 `buffer`），本文件
// 只负责旧侧，以及把两侧的结果翻译成「字节 + MIME」或一个 400。
//
// 参数只许 `cat-file blob` 与 `cat-file -s` 两种字面量：`--filters` / `--textconv` 会让 git
// 跑 smudge / textconv 驱动（LFS 的 smudge 往 `.git/lfs/objects` 写、缺对象时还会联网），而只读
// 白名单只看子命令、看不见参数——这是它唯一漏得过的形态，冒烟里因此单独钉了一条参数断言。

import { resolveDiffBase } from './repo.ts';
import { GitError, type GitResult, runGit, runGitRaw } from './run.ts';
import { imageMimeOf, inspectFile, MAX_BYTES, resolveInRepo, WorktreeError } from './worktree.ts';

export type ImageSideName = 'old' | 'new';

/**
 * `<base>:<path>` 是 revision 语法，不是 pathspec——`GIT_LITERAL_PATHSPECS=1` 管不到它，
 * `./x` 会按相对 cwd 解释、`..` 段则直接不是一个对象名。所以拼进去的必须是 `resolveInRepo`
 * 归一化后的那份（无 `.` 段、无前导 `./`、`/` 分隔），字面量那道边界校验也因此过了一遍。
 */
function blobRef(baseRef: string, normalizedPath: string): string {
  return `${baseRef}:${normalizedPath}`;
}

/**
 * 基准里这个 blob 的字节数；**不存在即 `null`，不是错误**——新增的文件在基准里本来就没有，
 * 基准是空树时更是一个都没有。`path` 必须已经过 `resolveInRepo` 归一化（见 `blobRef`）。
 */
export async function baseBlobSize(
  root: string,
  baseRef: string,
  normalizedPath: string,
): Promise<number | null> {
  const result = await runGit(['cat-file', '-s', blobRef(baseRef, normalizedPath)], root);
  if (result.code !== 0) return null;
  const size = Number(result.stdout.trim());
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

export interface ImageBytes {
  buffer: Buffer;
  mime: string;
}

/**
 * 取一侧的字节。**非图片扩展名一律 400**——不限扩展名的话它就是一个「下载工作区任意文件」
 * 的端点，而 `/api/file` 读任意文本时至少还经过分类链与两道闸。
 *
 * 两侧都再卡一次 5MB（`MAX_BYTES`）：payload 已经按侧卡过，但字节是第二次请求，中间文件可以
 * 长大。`new` 侧走 `inspectFile`——与 payload 同一条链，NUL ∧ 扩展名两半都过；`old` 侧带
 * `maxStdoutBytes` 去撞，超限即就地掐断 git。
 */
export async function readImageBytes(
  root: string,
  path: string,
  side: ImageSideName,
): Promise<ImageBytes> {
  const mime = imageMimeOf(path);
  if (mime === null) throw new WorktreeError('invalid-path', 'not an image');

  if (side === 'new') {
    const file = await inspectFile(root, path);
    if (file.kind === 'too-large') throw new WorktreeError('too-large', 'image too large');
    if (file.kind !== 'image') throw new WorktreeError('invalid-path', 'not an image');
    return { buffer: file.buffer, mime };
  }

  // 基准与边界校验彼此不依赖，并发跑——串行等于把一次进程启动的开销直接叠在每张旧图上
  const [base, { path: normalized }] = await Promise.all([
    resolveDiffBase(root),
    resolveInRepo(root, path, { follow: false }),
  ]);
  let result: GitResult<Buffer>;
  try {
    result = await runGitRaw(['cat-file', 'blob', blobRef(base.ref, normalized)], root, {
      maxStdoutBytes: MAX_BYTES,
    });
  } catch (cause) {
    if (cause instanceof GitError && cause.kind === 'overflow') {
      throw new WorktreeError('too-large', 'image too large');
    }
    throw cause;
  }
  // 非零退出在这里只有一种解释：基准里没有这条路径（新增的文件、或基准是空树）
  if (result.code !== 0) throw new WorktreeError('not-found', 'no such file in the diff base');
  return { buffer: result.stdout, mime };
}
