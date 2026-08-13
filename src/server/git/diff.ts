// 按文件懒加载取 diff(spec §5.2)。
//
// **禁止一次性获取或渲染全仓 diff** —— agent 单次改 300+ 文件是常态,整仓 diff 会
// 冻结浏览器主线程数秒到数十秒,同时拖垮冷启动指标。

import { lstat, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DiffPayload } from '../shared/protocol.ts';
import { resolveDiffBase } from './repo.ts';
import { GitError, runGit, runGitStrict } from './run.ts';

/**
 * 超过这个字节数只提示、不预览(spec §3 / §5.2)。
 *
 * **两条路量的东西不同,但量的都是「前端要吃下多少字节」**:未跟踪那一侧整份文件
 * 就是补丁,所以量文件(还省得把它读进来);已跟踪那一侧补丁只含改动与上下文,
 * 所以量补丁本身(见 `trackedDiff`)。
 */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * 行数上限。体积阈值挡不住另一头:超长行数的窄文件体积不大,但逐行构造 diff 与
 * 前端渲染同样会卡(spec §5.2)。
 *
 * 已跟踪那一侧数的是**改动行数**(numstat 的加 + 减),未跟踪数的是文件行数 ——
 * 后者本来就整份都是新增行。两边量的都是「前端要渲染多少行」。
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
 * 一条 `--numstat` 记录。`binary` 时两个计数都取不到(git 输出 `-\t-`)。
 */
export interface Numstat {
  binary: boolean;
  /** 新增 + 删除的行数。`binary` 时为 0,没有意义。 */
  lines: number;
  /**
   * 这条记录说的是哪个文件。**不能省**:一次查询未必只回一条记录(见 `readNumstat`),
   * 而丢掉路径之后调用方只能靠下标去猜,猜错不报错、只是拿了另一个文件的数字。
   */
  path: string;
  /** 仅重命名/复制记录有:旧路径。 */
  oldPath: string | null;
}

/**
 * `git diff --numstat -z` 的解析。**重命名记录不是一段而是三段。**
 *
 * 实测(见 spec §10):普通记录是 `<加>\t<减>\t<路径>`,一条占一个 NUL 段;
 * 重命名记录的**路径字段是空的**,后面紧跟两段 `<旧路径>` `<新路径>` ——
 * 与 `status --porcelain=v2` 的 `2 ` 记录**顺序相反**(那边是新在前、旧在后)。
 * 无状态地按 NUL 平铺切分,就会把 `<旧路径>` 当成下一条记录的开头。
 *
 * 本项目每次只问一条路径,所以「多吞两段」眼下不改变结果 —— 但把它写对的成本是
 * 三行,而写错的症状是将来某天改成批量查询后,一半记录静默错位。
 */
export function parseNumstat(output: string): Numstat[] {
  const segments = output.split('\0');
  const records: Numstat[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(segments[i] ?? '');
    if (!match) continue;
    const binary = match[1] === '-' || match[2] === '-';
    let path = match[3] as string;
    let oldPath: string | null = null;
    // 路径字段为空 = 重命名/复制:后两段是旧路径与新路径,一并吞掉
    if (path === '') {
      oldPath = segments[i + 1] ?? '';
      path = segments[i + 2] ?? '';
      i += 2;
    }
    records.push({
      binary,
      lines: binary ? 0 : Number(match[1]) + Number(match[2]),
      path,
      oldPath,
    });
  }
  return records;
}

/**
 * 「基准 → 工作区」这条路径上的 numstat 记录;不在差异里就是 `null`。
 *
 * 这一次调用同时回答三个问题,所以它取代了原先那次 `diff --name-only`:
 * 1. **它是不是已跟踪的**。`ls-files` 只答得出 index 里有什么,而已跟踪是
 *    **HEAD ∪ index**:`git rm` 之后已暂存的删除在 index 里已经没有了(实测
 *    `ls-files` 输出为空),status 却照样报 `1 D.`、基准侧也还在。只认 index 会把
 *    它误判成未跟踪、掉进读磁盘那条路,以「文件不存在」告终;
 * 2. **是不是二进制**。已跟踪那一侧一律以 git 自己的判定为准(含 `.gitattributes`),
 *    比 NUL 探测准确(§5.2),形态是 `-\t-\t<路径>`;
 * 3. **改了多少行**。行数阈值那一路的判据。
 *
 * 重命名同样要传两个路径 + `-M`:只传新路径时 git 无法配对,numstat 会把它算成
 * 一个全新增文件(行数因此是整份文件),与补丁那一侧的退化是同一回事(§5.2)。
 */
async function readNumstat(
  root: string,
  base: string,
  path: string,
  oldPath: string | undefined,
): Promise<{ binary: boolean; lines: number } | null> {
  const args = oldPath
    ? ['diff', base, '--numstat', '-z', '-M', '--', path, oldPath]
    : ['diff', base, '--numstat', '-z', '--', path];
  const records = parseNumstat(await runGitStrict(args, root));

  /**
   * **一次查询可以回不止一条记录**,所以必须按路径挑,不能取 `[0]`:
   *
   * 传了两个路径而 git **配不上对**时(`git mv` 之后把内容全部重写、留在工作区不
   * `git add` —— status 照报 `R100`,所以 `oldPath` 是有的,见 §10),它会拆成
   * 「删掉旧的」+「新增新的」两条,按路径排序。取 `[0]` 就是掷硬币:实测那条
   * 60,000 行的改名里,排在前面的是旧文件那条 100 行的删除,于是行数闸放它过去,
   * 一份 6 万行的补丁照旧发给浏览器 —— 正是本阶段要防的那次冻结。二进制同理,
   * 挑错记录会让一个文本文件被报成 binary(或反过来)。
   *
   * 挑中之后**合并**而不是取一条:那份补丁里两个文件都在,前端要渲染的是两者之和。
   */
  // 挑的是 `path` 字段:git 的重命名检测发生在 pathspec 过滤**之后**,配上对的记录
  // 两侧都在我们给的这两个路径里(新路径落在 `path` 上),配不上对的两条同理。
  // 因此不必再比 `record.oldPath` —— 那个分支永远走不到
  const mine = records.filter(
    (record) => record.path === path || (oldPath !== undefined && record.path === oldPath),
  );
  if (mine.length === 0) return null;
  return {
    binary: mine.some((record) => record.binary),
    lines: mine.reduce((total, record) => total + record.lines, 0),
  };
}

/** 工作区里这个文件的字节数;文件不在(删除)就是 `null`。 */
async function worktreeSize(abs: string): Promise<number | null> {
  try {
    // lstat 而非 stat:与未跟踪那条路同理,跟随链接读到的是链接目标的体积
    return (await lstat(abs)).size;
  } catch {
    return null;
  }
}

/**
 * 已跟踪文件的补丁,以及三道拒绝(§5.2 / §5.12)。
 *
 * **已跟踪那一侧卡的是「补丁多大」,不是「文件多大」**:文件体积只对未跟踪那条路
 * 成立(整份文件就是补丁),而已跟踪文件的补丁只包含改动与上下文 —— 按文件体积拒绝,
 * 一个 6MB 的数据文件改一行就再也看不了,而那是 agent 最常见的输出之一。反过来,
 * 行数也**不能**替代:一个「一行 6MB」的文件 numstat 只报 1 行,行数闸对它毫无作用。
 * 两者都量不到的东西正是字节,所以那一闸只能由取补丁那次调用自己带着上限去撞。
 *
 * 顺序:二进制(numstat)→ 行数(numstat)→ 取补丁并卡字节。二进制先答是因为它比
 * 「太大」更具体,一个 8MB 的 PNG 说「文件过大」等于把原因说错了;行数排在取补丁之前,
 * 是因为它不用付出取补丁的代价就能拦下 5 万行以上的改动。
 *
 * `size` 只用于**说话**(告诉用户这文件多大),不再参与判定,所以**只在要拒绝的那两条
 * 分支上才去 `lstat`**:正常那条路(绝大多数请求)一次系统调用都不欠。文件已被删除时
 * 取不到,给 0,前端据此不显示体积(§5.12)。
 *
 * **重命名条目必须同时传新旧两个路径**:只传新路径时 git 看不到另一侧、无法配对,
 * 会把重命名退化成一个全新增文件(已实测,spec §5.2),「重命名识别并标注」随之落空。
 * 两个路径都来自 status 的 `2 ` 记录,无需额外查询。
 */
async function trackedDiff(
  root: string,
  base: string,
  path: string,
  abs: string,
  oldPath: string | undefined,
  stat: { binary: boolean; lines: number } | null,
): Promise<DiffPayload> {
  if (stat?.binary) return { kind: 'binary' };
  if (stat && stat.lines > MAX_LINES) {
    // 行数这一路的 size 可能只有几百 KB,前端因此必须靠 reason 而不是 size 说话(§5.12)
    return { kind: 'too-large', size: (await worktreeSize(abs)) ?? 0, reason: 'lines' };
  }

  const args = oldPath ? ['diff', base, '-M', '--', path, oldPath] : ['diff', base, '--', path];
  let result: Awaited<ReturnType<typeof runGit>>;
  try {
    result = await runGit(args, root, { maxStdoutBytes: MAX_BYTES });
  } catch (cause) {
    // 超限是**这一路要的答案**而不是意外:git 被就地掐断,补丁一个字节都不会发给前端
    if (cause instanceof GitError && cause.kind === 'overflow') {
      return { kind: 'too-large', size: (await worktreeSize(abs)) ?? 0, reason: 'size' };
    }
    throw cause;
  }
  // 非零退出在这里没有第二种解释(路径不存在、基准无效都属于坏请求)
  if (result.code !== 0) {
    throw new DiffRequestError('not-found', 'no diff available for this path');
  }
  return { kind: 'text', patch: result.stdout };
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
  const abs = resolveInRepo(root, query.path);
  if (query.oldPath) resolveInRepo(root, query.oldPath);

  // 基准与 index 查询彼此不依赖,并发跑:串行等于把两次进程启动开销直接叠加,而
  // **每条 `/api/diff` 都要付**。基准在一次请求里只解析一次、两条分支共用 ——
  // 这不是缓存,`resolveDiffBase` 刻意不跨请求缓存的理由见 repo.ts
  const [base, listed] = await Promise.all([resolveDiffBase(root), inIndex(root, query.path)]);

  // 这一轮躲不掉:二进制与行数都必须在**取补丁之前**判完(§5.2)。未跟踪那条路两样
  // 都不用 —— 它自己读磁盘时顺手就有,所以这里只为已跟踪那一侧付这次调用
  const stat = await readNumstat(root, base, query.path, query.oldPath);

  if (listed || stat !== null) {
    return trackedDiff(root, base, query.path, abs, query.oldPath, stat);
  }
  return untrackedDiff(root, query.path);
}
