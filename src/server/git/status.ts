// `git status --porcelain=v2 --branch -uall -z` 的调用与解析。

import type { BranchState, FileEntry, StatusCode } from '../shared/protocol.ts';
import { readOperation } from './operation.ts';
import type { RepoInfo } from './repo.ts';
import { runGitStrict } from './run.ts';

/**
 * 文件列表与分支状态的**唯一**数据源,一次调用同时拿到文件状态、暂存/未暂存双状态位、
 * 重命名信息与分支 / ahead-behind。
 *
 * 导出成常量是为了让降级轮询**复用逐字相同的这一条**:漏掉 `-uall` 的后果是静默的 ——
 * git 会把未跟踪目录折叠成一行 `dir/`,于是在一个已存在的未跟踪目录里新增文件根本不改变
 * 输出,轮询判「无变化」、页面不刷新。`-z` 则是因为不加它 git 会对含非 ASCII 字符、空格、
 * 引号的路径做 C 风格转义并加引号。
 */
export const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-uall', '-z'] as const;

export interface StatusResult {
  branch: BranchState;
  files: FileEntry[];
}

const STATUS_CODES = new Set(['.', 'M', 'T', 'A', 'D', 'R', 'C', 'U']);

function asStatusCode(ch: string | undefined): StatusCode {
  return ch && STATUS_CODES.has(ch) ? (ch as StatusCode) : '.';
}

/**
 * 切出记录开头的 `n` 个空格分隔字段,剩下的整段就是路径。不能整条 `split(' ')` ——
 * 路径本身可以含空格,而 `-z` 只把**记录**分隔成 NUL 段,段内仍是空格分隔。
 */
function splitLeading(rec: string, n: number): [string[], string] | null {
  const fields: string[] = [];
  let start = 0;
  for (let k = 0; k < n; k += 1) {
    const sp = rec.indexOf(' ', start);
    if (sp === -1) return null;
    fields.push(rec.slice(start, sp));
    start = sp + 1;
  }
  const rest = rec.slice(start);
  return rest ? [fields, rest] : null;
}

/** `R100` / `C75` → 100 / 75。 */
function parseScore(field: string | undefined): number | null {
  const m = field ? /^[RC](\d+)$/.exec(field) : null;
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * 解析 `-z` 输出。**NUL 在重命名记录里既是记录分隔符、又是字段分隔符**:`2 ` 记录是
 * `2 <XY> ... R<score> <新路径>\0<旧路径>`,一条占**两个** NUL 段。因此不能无状态地按
 * NUL 平铺切分,遇到 `2 ` 必须额外吞掉下一段作为旧路径。
 */
export function parseStatus(raw: string): StatusResult {
  const segments = raw.split('\0');
  const files: FileEntry[] = [];
  let head = '';
  let detached = false;
  let upstream: BranchState['upstream'] = null;

  for (let i = 0; i < segments.length; i += 1) {
    const rec = segments[i];
    if (!rec) continue;

    switch (rec[0]) {
      case '#': {
        const sp = rec.indexOf(' ', 2);
        const key = sp === -1 ? rec.slice(2) : rec.slice(2, sp);
        const value = sp === -1 ? '' : rec.slice(sp + 1);
        if (key === 'branch.head') {
          head = value;
          // git 在 detached HEAD 下把这一行的值写成字面量 `(detached)`
          detached = value === '(detached)';
        } else if (key === 'branch.ab') {
          // `+3 -1`。**这一行在无上游时根本不输出**,因此 upstream 的初值是 null 而不是
          // { ahead: 0, behind: 0 } —— 「无上游」与「同步」合并成 0/0 就再也分不开了
          const m = /^\+(\d+)\s+-(\d+)$/.exec(value.trim());
          if (m?.[1] && m[2]) upstream = { ahead: Number(m[1]), behind: Number(m[2]) };
        }
        break;
      }

      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
      case '1': {
        const split = splitLeading(rec, 8);
        if (!split) break;
        const [fields, path] = split;
        files.push({
          path,
          kind: 'tracked',
          staged: asStatusCode(fields[1]?.[0]),
          unstaged: asStatusCode(fields[1]?.[1]),
        });
        break;
      }

      // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <新路径>\0<旧路径>`
      case '2': {
        const split = splitLeading(rec, 9);
        // 旧路径在**下一段**。即便本条记录解析失败也必须把它吞掉,否则它会被
        // 当成下一条记录去解析 —— 那是一个静默的错位,而不是一个报错
        const oldPath = segments[i + 1] ?? '';
        i += 1;
        if (!split) break;
        const [fields, path] = split;
        const score = parseScore(fields[8]);
        files.push({
          path,
          oldPath,
          kind: 'tracked',
          staged: asStatusCode(fields[1]?.[0]),
          unstaged: asStatusCode(fields[1]?.[1]),
          ...(score === null ? {} : { renameScore: score }),
        });
        break;
      }

      // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`(未合并)
      case 'u': {
        const split = splitLeading(rec, 10);
        if (!split) break;
        const [fields, path] = split;
        files.push({
          path,
          kind: 'tracked',
          staged: asStatusCode(fields[1]?.[0]),
          unstaged: asStatusCode(fields[1]?.[1]),
          // **「是 `u` 记录」这件事只有这里知道**:XY 可以是 `DD` / `AA`,两位都不是
          // `U`,下游再想从状态位认回来就已经晚了(`conflicted`)
          conflicted: true,
        });
        break;
      }

      // `? <path>`。`-uall` 保证未跟踪目录展开到文件粒度,不会折叠成 `dir/`
      case '?': {
        files.push({ path: rec.slice(2), kind: 'untracked', staged: '.', unstaged: '?' });
        break;
      }

      // `! <path>`:只在传了 `--ignored` 时出现,我们没传。留个分支免得将来
      // 有人加了参数却在这里静默走到 default
      case '!':
        break;

      default:
        break;
    }
  }

  return { branch: { head, detached, upstream }, files };
}

/**
 * 主查询的**原始输出**,不解析。存在的唯一理由是降级轮询:它只需要回答「变没变」,而逐
 * 字节比对原始输出既是最省的判据,也让「轮询与主查询是同一条命令」成为**构造上的事实**
 * 而不是两处各自维护的巧合。比对解析后的结构也做得到,但深比较与 `JSON.stringify` 都会
 * 随协议类型增删字段而静默改变灵敏度。
 */
export async function readStatusRaw(root: string): Promise<string> {
  return runGitStrict(STATUS_ARGS, root);
}

/**
 * 变更列表 + 分支状态。
 *
 * 取 `RepoInfo` 而不是两个字符串:进行中的多步操作只能从 **git 目录**下的状态文件读,而
 * 它和工作区根是两条不同的路径 —— 两个同类型参数并排放着,调换顺序不会报错,只会让
 * `operation` 从此恒为空。两件事并发:status 是一次子进程,`readOperation` 是七个 `access`。
 */
export async function readStatus(repo: RepoInfo): Promise<StatusResult> {
  const [raw, operation] = await Promise.all([
    readStatusRaw(repo.root),
    readOperation(repo.gitDir),
  ]);
  const status = parseStatus(raw);
  // 没有进行中的操作时**不写这个字段**(而不是写 undefined):响应体因此干净,前端的判据
  // 也就只有「有没有」这一种形态。就地写:`parseStatus` 每次都新造一份
  if (operation !== undefined) status.branch.operation = operation;
  return status;
}
