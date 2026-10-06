// 提交历史：列表、一次提交的元数据与文件清单。单个文件的补丁在 `diff.ts`——它与工作区 diff
// 共用三道闸，分开写就是两份阈值。
//
// **只读白名单为这里只加了 `log` 一条**，其余全部落在已有条目上：提交的 diff 是
// `diff <parent> <sha>`，父提交取 `log` 的 `%P`，校验是 `rev-parse`。不用 `show`（参数面太大、
// 钉不住）、`diff-tree`（又一条白名单，合并提交默认还什么都不输出）、`rev-list`（同上）。

import type {
  CommitDetail,
  CommitFileEntry,
  CommitPage,
  CommitSummary,
} from '../shared/protocol.ts';
import { emptyTree } from './repo.ts';
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

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * 请求里的提交只认**完整的十六进制对象名**（SHA-1 40 位 / SHA-256 64 位）：不认缩写、不认
 * `HEAD~3` 一类 revision 表达式，更不认 `-` 开头的值。前端手里的 sha 全部来自后端自己的输出，
 * 用不着任何 revision 语法。
 */
export function assertOid(value: string): string {
  if (!OID.test(value)) throw new WorktreeError('invalid-path', 'not a full commit hash');
  return value;
}

/** 对象名合法不等于是本仓库里的一个提交；不是即 `not-found`。 */
async function verifyCommit(root: string, sha: string): Promise<void> {
  const result = await runGit(
    ['rev-parse', '--verify', '--quiet', `${assertOid(sha)}^{commit}`],
    root,
  );
  if (result.code !== 0) throw new WorktreeError('not-found', 'no such commit');
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
    if (!OID.test(id)) continue;
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
  let head: string;
  if (query.head === undefined) {
    const resolved = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
    const oid = resolved.stdout.trim();
    if (resolved.code !== 0 || !OID.test(oid)) return { head: null, commits: [], hasMore: false };
    head = oid;
  } else {
    head = assertOid(query.head);
    await verifyCommit(root, head);
  }

  const commits = parseLog(await runGitStrict(logArgs(head, PAGE_SIZE + 1, query.skip), root));
  return { head, commits: commits.slice(0, PAGE_SIZE), hasMore: commits.length > PAGE_SIZE };
}

/** 单条提交的元数据。`sha` 先过 `assertOid` 与 `verifyCommit`。 */
export async function readCommitSummary(root: string, sha: string): Promise<CommitSummary> {
  await verifyCommit(root, sha);
  const [commit] = parseLog(await runGitStrict(logArgs(sha, 1), root));
  if (!commit) throw new WorktreeError('not-found', 'no such commit');
  return commit;
}

/**
 * 这次提交的对比端：**第一父**。合并提交因此展示「这次合并相对主线带进来了什么」，与 GitHub
 * 提交页、VS Code Timeline 同一口径（组合 diff 的多列前缀 diff2html 解析不了）。根提交没有父，
 * 对比端是空树——与空仓库的 diff 基准同一个常量，不为它写特殊分支。
 */
export async function commitParent(root: string, commit: CommitSummary): Promise<string> {
  return commit.parents[0] ?? emptyTree(root);
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
export async function readCommit(root: string, sha: string): Promise<CommitDetail> {
  const commit = await readCommitSummary(root, sha);
  const parent = await commitParent(root, commit);
  const output = await runGitStrict(
    ['diff', parent, commit.sha, '--name-status', '-z', '-M', '--'],
    root,
  );
  return { ...commit, files: parseNameStatus(output) };
}
