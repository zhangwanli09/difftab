// 「工作区路径 → 磁盘」这件事的全套规则：仓库边界、只读读一个文件的分类与两道闸。
//
// **本文件是 `diff.ts` / `file.ts` / `tree.ts` 三者共同的底座，不是谁的附属。** 它先前长在
// `diff.ts` 里，于是两个新模块反向 import 一个 feature 模块，而「只读读磁盘」这个 concern
// 没有 owner、只有一个恰好先写出来的宿主——症状是读一个与 diff 无关的文件失败时，抛的却是
// 一个叫 `DiffRequestError` 的东西。
//
// **git 自己那些调用不必经过这里**：`git` 的 pathspec 本就受仓库边界约束。要过的是所有
// **真的落到磁盘上**的路径。

import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

/**
 * 超过这个字节数只提示、不预览。**两条路量的东西不同，但量的都是「前端要吃下多少
 * 字节」**：读磁盘那一侧整份文件就是要发的东西（量文件还省得把它读进来），已跟踪那一侧
 * 补丁只含改动与上下文，所以量补丁本身（见 `diff.ts` 的 `trackedDiff`）。
 */
export const MAX_BYTES = 5 * 1024 * 1024;

/**
 * 行数上限。体积阈值挡不住另一头：超长行数的窄文件体积不大，但逐行构造 diff 与前端渲染
 * 同样会卡。已跟踪那一侧数的是**改动行数**（numstat 的加 + 减），读磁盘这一侧数文件行数。
 */
export const MAX_LINES = 50_000;

/**
 * 图片扩展名 → MIME。**图片是二进制里被放行的那一支，判据是「二进制 ∧ 扩展名在表里」**：
 * 二进制那一半由各自的路给（已跟踪侧是 numstat 的 `-\t-`，读磁盘这一侧是 NUL 探测），这张表
 * 只在**已判定为二进制之后**才查——单看扩展名会把一个内容是文本的 `.png`（占位符、被 LFS
 * 换成指针的图）送去 `<img>` 里画成一张破图，而它本来有一份能看的文本 diff。
 *
 * **SVG 刻意不在表里**：它是文本，走文本 diff 更有信息量。表也是 `/api/blob` 的 `Content-Type`
 * 来源——`nosniff` 之下类型错一个字浏览器就不画，所以值必须是精确的 MIME。
 */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/** 这条路径按扩展名算图片时给 MIME，否则 `null`。`posix.extname` 对 `.png` 这种点开头的名字给空串。 */
export function imageMimeOf(path: string): string | null {
  return IMAGE_MIME[posix.extname(path).slice(1).toLowerCase()] ?? null;
}

/**
 * `too-large` 只有取图片字节那条路会抛：payload 那一步已经按侧卡过 5MB，可字节是第二次请求，
 * 中间文件可以长大。其余两条路上「太大」是 payload 的一个分支，不是错误。
 */
export type WorktreeErrorCode = 'invalid-path' | 'not-found' | 'too-large';

/** 坏请求（路径非法 / 目标不在了）。**不叫 `DiffRequestError`**：三条路都会抛它。 */
export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  constructor(code: WorktreeErrorCode, message: string) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

/** `target` 落在 `base` 里（含相等）。**边界谓词只此一份**——两份漂开时弱的那份就是一个穿越。 */
function contains(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface ResolveOptions {
  /**
   * 最后一段跟不跟随符号链接。读文件那侧**不跟**（链接本身就是要展示的东西）；列目录那侧
   * **要跟**——`readdir` 本来就跟，不验就等于没验。
   */
  follow: boolean;
  /** 允许 `path` 为空串（即仓库根）。只有目录树的第一层要它；读文件时那是坏请求。 */
  allowRoot?: boolean;
}

/** 过完两道边界之后的路径：磁盘上的绝对路径，以及**归一化后**的仓库相对路径。 */
export interface RepoPath {
  abs: string;
  /** 以 `/` 分隔、无尾斜杠、无 `.` 段；根是空串。调用方拿它做 pathspec 与前缀匹配。 */
  path: string;
}

/**
 * 把请求里的路径落到磁盘上，**两道边界一次过完**。
 *
 * 1. **字面量那道**：拒绝绝对路径、含 `\0` 的、以及 `relative()` 走出去的那些。
 * 2. **`realpath` 那道**：把中间段全部展开成真实路径再比一次。**只有第一道时 `lstat` 给的
 *    保护是假的——它只管最后一段**：仓库里有个 `linkdir -> ../outside` 时，
 *    `linkdir/secret.txt` 在字面上老实待在仓库内，而 `readFile` 顺着它走出去（已实测）。
 *
 * **一个 gate、用途由参数说明，而不是按用途分叉成几个函数**：分叉时挑错哪一个不报错，正好
 * 复现上面那个洞。返回值里的 `path` 是**归一化**的——调用方据此做前缀匹配与 pathspec，于是
 * `dir/`、`./dir`、`dir//x` 这些拼法不必逐个特判（`resolve()` 本来就把它们归一了，先前那个
 * 只取 `abs` 的写法把这份结果扔掉了，才不得不在外面补一条 `endsWith('/')`）。
 */
export async function resolveInRepo(
  root: string,
  path: string,
  options: ResolveOptions,
): Promise<RepoPath> {
  if (path.includes('\0') || isAbsolute(path))
    throw new WorktreeError('invalid-path', 'invalid path');
  if (path === '') {
    if (options.allowRoot !== true) throw new WorktreeError('invalid-path', 'invalid path');
  }
  const abs = path === '' ? resolve(root) : resolve(root, path);
  const rel = relative(root, abs);
  if (!contains(root, abs) || (rel === '' && options.allowRoot !== true)) {
    throw new WorktreeError('invalid-path', 'invalid path');
  }

  const realRoot = await realpath(root);
  if (options.follow) {
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      throw new WorktreeError('not-found', 'no longer exists');
    }
    if (!contains(realRoot, real)) throw new WorktreeError('invalid-path', 'invalid path');
  } else {
    // 最后一段留着不动，只展开它的父链——`realpath` 对不存在的路径会抛，而「文件刚被删掉」
    // 是这条路上的常态，父目录却几乎总在
    let realParent: string;
    try {
      realParent = await realpath(resolve(abs, '..'));
    } catch {
      throw new WorktreeError('not-found', 'file no longer exists');
    }
    if (!contains(realRoot, realParent)) throw new WorktreeError('invalid-path', 'invalid path');
  }

  return { abs, path: rel.split(sep).join('/') };
}

/**
 * 数行数。**空文件是 0 行，末尾那个换行不另算一行**——这是全仓唯一一份行数口径，diff 与文件
 * 视图共用它；两份漂开的症状是一个正好 50,000 行的文件在一个面板里能看、在另一个里说太大。
 *
 * 在 **Buffer 上数**而不是 `split('\n').length`：后者为了得到一个数字，把整份文件又切成 N 个
 * 字符串立刻丢掉，而超限那一路根本不需要正文。
 */
export function countLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (let i = buffer.indexOf(10); i !== -1; i = buffer.indexOf(10, i + 1)) lines += 1;
  return buffer[buffer.length - 1] === 10 ? lines : lines + 1;
}

/**
 * 磁盘上那个文件是什么。**分类链只此一份**：`untrackedDiff` 与 `readFileContent` 先前各写了
 * 一遍同样的「lstat → 符号链接 → 非普通文件 → 体积 → NUL 探测 → 行数」，而两份已经在第一次
 * 提交时就漂开了（行数口径差一）。
 */
export type WorktreeFile =
  | { kind: 'symlink'; target: string }
  | { kind: 'binary' }
  | { kind: 'image'; buffer: Buffer; size: number; version: string }
  | { kind: 'too-large'; size: number; reason: 'size' | 'lines' }
  | { kind: 'text'; buffer: Buffer; size: number; lines: number; executable: boolean };

/**
 * 工作区里一份内容的身份：体积 + mtime。**内容身份，不是时间戳**——前端拿它当 `<img>` 的
 * `v=` 与 `key`，不变就不重取；按「取过一次」换戳的写法让每一次无关文件的 SSE 都重下两张图。
 * 与 git 自己的 stat 缓存同一条判据（size + mtime），已知边界也一样：同体积、同一个 mtime
 * 刻度内的改写认不出来，在 APFS / ext4 / NTFS 的纳秒级 mtime 上这是理论形态。
 */
export function worktreeVersion(info: { size: number; mtimeMs: number }): string {
  return `${info.size}-${info.mtimeMs}`;
}

/**
 * 读一个工作区文件并分类。顺序是固定的：符号链接 → 非普通文件 → 体积 → 二进制 → 图片 → 行数。
 *
 * - **`lstat` 而不是 `stat`**：未跟踪的符号链接照样进变更列表、也照样出现在目录树里，而
 *   `stat` 跟随链接——校验过的是**链接自身**的路径，读到的却是链接目标。给的因此是**链接
 *   目标字符串本身**，与 git 对 mode 120000 的处理一致。
 * - **二进制走 NUL 字节探测**：这条路上没有 numstat 可依（未跟踪与被忽略的文件 git 根本不
 *   比对），而 git 自己那套含 `.gitattributes` 的判定只对已跟踪文件给得出。
 * - **二进制排在行数之前**：它比「太大」更具体，一个 8MB 的 PNG 说「文件过大」等于把原因说错。
 * - **图片只在 NUL 命中之后才查扩展名**（`imageMimeOf`）：它是二进制的子集，不是与二进制并列
 *   的一档。与 `text` 一样把 `buffer` 带出去：`/api/blob` 的新侧就是这条链，不另写一份「lstat →
 *   体积 → 读」的副本——上一份副本连 NUL 那道都没有，一个内容是文本的 `.png` 在 payload 里是
 *   文本、在字节端点上却被当图发出去。
 * - **`version` 是这份内容的身份**（`worktreeVersion`），前端拿它决定要不要重取。
 */
export async function inspectFile(root: string, path: string): Promise<WorktreeFile> {
  const { abs } = await resolveInRepo(root, path, { follow: false });

  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(abs);
  } catch {
    throw new WorktreeError('not-found', 'file no longer exists');
  }

  if (info.isSymbolicLink()) return { kind: 'symlink', target: await readlink(abs) };
  if (!info.isFile()) throw new WorktreeError('invalid-path', 'not a regular file');
  // 体积这一闸在**读进来之前**：超限那一路省下的正是把它读进内存这件事
  if (info.size > MAX_BYTES) return { kind: 'too-large', size: info.size, reason: 'size' };

  const buffer = await readFile(abs);
  if (buffer.includes(0)) {
    if (imageMimeOf(path) === null) return { kind: 'binary' };
    return { kind: 'image', buffer, size: info.size, version: worktreeVersion(info) };
  }

  const lines = countLines(buffer);
  // 体积没超、行数超了——`reason` 区分的就是这条路径：文件可能只有几百 KB，
  // 光把体积报给前端解释不了为什么不预览
  if (lines > MAX_LINES) return { kind: 'too-large', size: info.size, reason: 'lines' };

  return { kind: 'text', buffer, size: info.size, lines, executable: (info.mode & 0o111) !== 0 };
}
