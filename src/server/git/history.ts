// 提交历史：列表、一次提交的元数据与文件清单。单个文件的补丁在 `diff.ts`——它与工作区 diff
// 共用三道闸，分开写就是两份阈值。
//
// **只读白名单为这里只加了 `log` 一条**，其余全部落在已有条目上：提交的 diff 是
// `diff <parent> <sha>`，父提交取 `log` 的 `%P`，校验也是那一次 `log`。不用 `show`（参数面太大、
// 钉不住）、`diff-tree`（又一条白名单，合并提交默认还什么都不输出）、`rev-list`（同上）。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CommitDetail,
  CommitFileEntry,
  CommitPage,
  CommitSummary,
} from '../shared/protocol.ts';
import { atLeast, emptyTreeOf, headOid, isOid, type RepoInfo } from './repo.ts';
import { runGit, runGitStrict } from './run.ts';
import { WorktreeError } from './worktree.ts';

/** 一页多少条。取 `PAGE_SIZE + 1` 条来判 `hasMore`，不另起一次计数。 */
export const PAGE_SIZE = 50;

/**
 * 每条提交恰好五段：`-z` 让记录之间以 NUL 分隔，`%x00` 让字段之间也是 NUL。主题行（`%s`）
 * 不含 NUL 与换行，作者名里的空格不是分隔符；根提交的 `%P` 是一个空段，不是缺段。
 */
const LOG_FORMAT = '--format=%H%x00%P%x00%an%x00%at%x00%s';
const FIELDS = 5;

/**
 * `log` 的 argv，**整条是字面量**，冒烟逐段钉着它：
 * - `--no-show-signature`：用户配了 `log.showSignature` 时 `log` 会对每条提交起一次 gpg；
 * - **不带 `-p` / `--stat` / 任何 diff 选项**：一旦算 diff，`diff.external` 与 textconv 驱动就
 *   都在射程内，而白名单只看子命令；
 * - 末尾的 `--`：`rev` 之后的任何东西都不再被当成选项。
 *
 * `rev` 必须已过 `assertOid`——它拼在 revision 位置，`GIT_LITERAL_PATHSPECS` 管不到那里，
 * `--output=<路径>` 在那个位置就是一次写文件。
 */
function logArgs(rev: string, count: number, skip?: number): string[] {
  return [
    'log',
    '--no-show-signature',
    '--no-color',
    '-z',
    LOG_FORMAT,
    `--max-count=${count}`,
    ...(skip === undefined ? [] : [`--skip=${skip}`]),
    rev,
    '--',
  ];
}

/**
 * 请求里的提交只认**完整的十六进制对象名**（SHA-1 40 位 / SHA-256 64 位）：不认缩写、不认
 * `HEAD~3` 一类 revision 表达式，更不认 `-` 开头的值。前端手里的 sha 全部来自后端自己的输出，
 * 用不着任何 revision 语法。
 */
export function assertOid(value: string): string {
  if (!isOid(value)) throw new WorktreeError('invalid-path', 'not a full commit hash');
  return value;
}

/** `log -z` + `LOG_FORMAT` 的解析：按五段一组切。 */
export function parseLog(output: string): CommitSummary[] {
  const segments = output.split('\0');
  const commits: CommitSummary[] = [];
  for (let i = 0; i + FIELDS <= segments.length; i += FIELDS) {
    const [sha = '', parents = '', author = '', time = '', subject = ''] = segments.slice(
      i,
      i + FIELDS,
    );
    // 换行只可能出现在记录之间（老版本 git 在 `-z` 下仍可能补一个），不属于任何字段
    const id = sha.replace(/^\n/, '');
    if (!isOid(id)) continue;
    commits.push({
      sha: id,
      parents: parents === '' ? [] : parents.split(' '),
      author,
      time: Number(time),
      subject,
    });
  }
  return commits;
}

/**
 * 提交列表的一页。`head` 缺省即「从 HEAD 起」，并把 HEAD 此刻的 oid 回传当锚点；之后每一页
 * 都带着它再 `--skip`——按 HEAD 往下数时，agent 在两次翻页之间提交一次，第二页就重复第一页的
 * 最后一条。空仓库（HEAD 未出生）是一页空列表，不是错误。
 */
export async function listCommits(
  root: string,
  query: { head?: string | undefined; skip: number },
): Promise<CommitPage> {
  // 第一页直接从 `HEAD` 起：回来的第一条就是 HEAD 此刻的 oid，不为锚点另起一次 `rev-parse`
  const rev = query.head === undefined ? 'HEAD' : assertOid(query.head);
  const result = await runGit(logArgs(rev, PAGE_SIZE + 1, query.skip), root);
  if (result.code !== 0) {
    if (query.head !== undefined) throw new WorktreeError('not-found', 'no such commit');
    // 从 HEAD 起失败有两种：HEAD 未出生（空仓库）与 HEAD 指着一个读不出来的提交（中断的 fetch、
    // 坏掉的 shallow 文件）。`log` 对两者都以 128 退出；`rev-parse --verify` 只在前一种上失败
    // （实测：未出生退 1，指向缺失对象却退 0 并照样印出 oid）。只有前一种是「没有提交」——把后一种
    // 也说成 `No commits yet` 等于把一个真实的故障藏起来
    if ((await headOid(root)) === null) return { head: null, commits: [], hasMore: false };
    throw new Error('HEAD points to a commit that cannot be read');
  }
  const commits = parseLog(result.stdout);
  const head = query.head ?? commits[0]?.sha ?? null;
  return { head, commits: commits.slice(0, PAGE_SIZE), hasMore: commits.length > PAGE_SIZE };
}

/** 一次提交与它的对比端。提交详情、单个文件的补丁、图片两侧三条路都从这一份出发。 */
interface CommitRange {
  commit: CommitSummary;
  /**
   * **第一父**。合并提交因此展示「这次合并相对主线带进来了什么」，与 GitHub 提交页、VS Code
   * Timeline 同一口径（组合 diff 的多列前缀 diff2html 解析不了）。根提交没有父，对比端是空树
   * ——与空仓库的 diff 基准同一个常量，按对象名长度取，不为它多起一次进程。
   *
   * **`null` 是浅克隆的边界**：那条提交的 `%P` 同样是空的，可它不是根提交，只是父提交没被取下来。
   * 拿空树去比会把整个仓库报成「全部新增」——一份看着完全正常、却在说假话的文件清单。
   */
  parent: string | null;
}

/**
 * 把请求里的 sha 落成 `CommitRange`。**对比端只在这里定一次**：三条路各自去找父提交时，将来
 * 改一处（比如合并提交换个父）漏改另一处，文件清单、补丁与图片就是对着三个不同的父在比，而
 * 不报错。
 *
 * 一次 `log -1` 同时做校验与取元数据：对象名合法不等于是本仓库里的一个提交——`log` 对不存在
 * 的对象以 128 退出，对树与 blob **以 0 退出、输出为空**，对附注标签则剥到它指向的提交（实测）。
 * 所以判据是「回来的那条正好就是问的这个 sha」，退出码只是其中一半。
 */
export async function resolveCommit(repo: RepoInfo, sha: string): Promise<CommitRange> {
  assertOid(sha);
  await refuseLazyFetch(repo);
  const result = await runGit(logArgs(sha, 1), repo.root);
  const [commit] = result.code === 0 ? parseLog(result.stdout) : [];
  if (commit?.sha !== sha) throw new WorktreeError('not-found', 'no such commit');
  const [first] = commit.parents;
  if (first !== undefined) return { commit, parent: first };
  return { commit, parent: (await isShallowBoundary(repo, sha)) ? null : emptyTreeOf(sha) };
}

/** 浅克隆边界上的提交没有父可比。补丁与图片两条路据此拒绝，而不是拿空树去比。 */
export function requireParent(range: CommitRange): string {
  if (range.parent === null) {
    throw new WorktreeError(
      'unsupported',
      'shallow clone: this commit has no parent to compare with',
    );
  }
  return range.parent;
}

/**
 * 这条提交是不是浅克隆的边界：共享 git 目录下的 `shallow` 文件逐行列着它们（实测 `--depth 1` 之后
 * 正好是 HEAD 那一条）。只在 `%P` 为空时才读——根提交与边界只有这一处分得开。**不缓存**：
 * `fetch --deepen` 会改这个文件，而这条路只在根提交上走。
 */
async function isShallowBoundary(repo: RepoInfo, sha: string): Promise<boolean> {
  try {
    const shallow = await readFile(join(repo.commonDir, 'shallow'), 'utf8');
    return shallow.split('\n').some((line) => line.trim() === sha);
  } catch {
    return false;
  }
}

/** `GIT_NO_LAZY_FETCH` 的版本下限（git 2.44）。 */
const LAZY_FETCH_SWITCH = { major: 2, minor: 44 };

/**
 * **老 git + partial clone 下提交历史整个拒绝**。`GIT_NO_LAZY_FETCH` 是 git 2.44 才有的变量，更老
 * 的 git 不认它：缺的 blob 照样当场从 promisor remote 取回来写进 `.git/objects`，而提交历史读的
 * 恰恰是那些从没检出过的旧 blob——工作区 diff 只碰 HEAD 里已检出的那一份，不在此列。
 *
 * 版本是启动时 `locateRepo` 解析好的（解析不出按新的算，与启动下限同一取向），partial clone 的记号
 * 读共享 git 目录下的 `config`——与进行中的操作同一个取向：读状态文件，不为它往白名单里添
 * `config`。新 git 上一次文件都不读；老 git 上每次读一个小文件，不另设缓存。
 */
async function refuseLazyFetch(repo: RepoInfo): Promise<void> {
  if (repo.gitVersion === null || atLeast(repo.gitVersion, LAZY_FETCH_SWITCH)) return;
  let config = '';
  try {
    config = await readFile(join(repo.commonDir, 'config'), 'utf8');
  } catch {
    return;
  }
  if (isPartialCloneConfig(config)) {
    throw new WorktreeError(
      'unsupported',
      'commit history in a partial clone needs git 2.44 or newer',
    );
  }
}

/**
 * 一份 git `config` 正文里有没有 partial clone 的记号：`extensions.partialClone = <名>`，或
 * `remote.<名>.promisor` 为真——git 的布尔值只写键名、`true` / `yes` / `on` / `1` 都算，不区分大小写。
 */
export function isPartialCloneConfig(config: string): boolean {
  return /^\s*(?:partialclone\s*=|promisor\s*(?:$|=\s*"?(?:true|yes|on|1)\b))/im.test(config);
}

/**
 * `diff --name-status -z -M` 的解析。**重命名记录占三段**：`R<score>` `<旧路径>` `<新路径>`——
 * 与 numstat 同为旧在前、与 porcelain 的 `2 ` 记录相反。平铺切分会把旧路径当成下一条记录的
 * 状态字段。没开 `-C`，`C` 不会出现；认不出的状态字母整条跳过，不猜。
 */
export function parseNameStatus(output: string): CommitFileEntry[] {
  const segments = output.split('\0');
  const files: CommitFileEntry[] = [];
  for (let i = 0; i < segments.length; ) {
    const status = segments[i] ?? '';
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = segments[i + 1] ?? '';
      const path = segments[i + 2] ?? '';
      if (letter === 'R') files.push({ path, oldPath, status: 'R' });
      i += 3;
      continue;
    }
    if (letter === 'A' || letter === 'M' || letter === 'D' || letter === 'T') {
      files.push({ path: segments[i + 1] ?? '', status: letter });
      i += 2;
      continue;
    }
    i += status === '' ? 1 : 2;
  }
  return files;
}

/** 一次提交的元数据 + 改了哪些文件（相对第一父）。 */
export async function readCommit(repo: RepoInfo, sha: string): Promise<CommitDetail> {
  const { commit, parent } = await resolveCommit(repo, sha);
  // 浅克隆边界：没有父可比，就不列文件——拿空树比出来的「全部新增」是一句假话
  if (parent === null) return { ...commit, files: [], shallow: true };
  const output = await runGitStrict(
    ['diff', parent, commit.sha, '--name-status', '-z', '-M', '--'],
    repo.root,
  );
  return { ...commit, files: parseNameStatus(output) };
}
