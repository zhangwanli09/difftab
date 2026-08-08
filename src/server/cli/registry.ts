// 同仓库单实例的注册表文件(spec §5.8)。
//
// 本阶段只做**写入**。「启动时探活复用已有实例」与「空闲 45 秒退出」属 S3c ——
// 但写入不能一起推到 S3c:S1–S3b 期间 dev proxy 没有 token 来源,而那段时间里
// 「临时给后端加个放宽校验的环境变量」恰好是最短路径,正是 §10 明令禁止的做法
// (spec §5.11 的「因此注册表文件的写入必须与 server 同期落地」)。

import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface RegistryEntry {
  pid: number;
  port: number;
  /** `<port>.<secret>`,dev proxy 靠它注入 cookie(spec §5.11)。 */
  token: string;
  repoRoot: string;
  startedAt: number;
}

/**
 * 注册表目录。
 *
 * **绝不能写进 `.git/` 或工作区** —— 那既污染 `git status`,也实质违背零写操作承诺
 * (spec §5.8 / §10)。`os.tmpdir()` 的权限因平台而异,Linux 上是 `/tmp`(1777,
 * 同机其他用户可读),所以这里再套一层每用户私有子目录,文件本身另有 0o600。
 */
function registryDir(): string {
  return join(tmpdir(), 'gitglance');
}

/**
 * 把仓库路径归一成注册表的键。
 *
 * 写入侧给的是 `git rev-parse --show-toplevel`,读取侧(dev proxy)给的是
 * `process.cwd()` —— **两者指向同一个目录时字面量仍可能不同**,而 hash 只认字面量:
 *   - Windows:git 给 `C:/Users/x/repo`,cwd 给 `C:\Users\x\repo`;
 *   - macOS:cwd 经符号链接进来时是 `/var/...`,git 给的是 `/private/var/...`。
 * 不归一的话 dev proxy 永远找不到正在运行的后端,症状是「后端明明起着却说没找到」。
 */
function registryKey(repoRoot: string): string {
  const abs = resolve(repoRoot);
  try {
    // native 版在 Windows 上还会一并归一化大小写与 8.3 短名
    return realpathSync.native(abs);
  } catch {
    // 目录已经不在了(退出清理时可能如此)——退回纯字面量归一,总比抛异常好
    return abs;
  }
}

/** 文件名用仓库绝对路径的 hash,避免把路径本身暴露在一个全局可读的目录名里。 */
export function registryPath(repoRoot: string): string {
  const hash = createHash('sha256').update(registryKey(repoRoot)).digest('hex').slice(0, 32);
  return join(registryDir(), `${hash}.json`);
}

/**
 * 写入注册表。
 *
 * `0o600` 必须**配合 `O_EXCL` 在创建时**给出(`'wx'` + mode),而不是先建后 chmod ——
 * 后者留下一个竞态窗口,窗口里文件是可读的,而它存着本次会话的 token(spec §5.8)。
 */
function writeExclusive(path: string, payload: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, payload);
  } finally {
    closeSync(fd);
  }
}

export function writeRegistry(entry: RegistryEntry): string {
  const path = registryPath(entry.repoRoot);
  mkdirSync(registryDir(), { recursive: true, mode: 0o700 });

  const payload = JSON.stringify(entry);
  try {
    writeExclusive(path, payload);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    // TODO(S3c):这里正是「探活复用」的落点 —— 对已记录的端口做 HTTP 探活并校验
    // 返回的 repo 路径,命中则复用已有实例而不是起第二个进程。**不得改用 pid 存活
    // 判断**:pid 会被系统复用,误判会把用户带到一个指向别人进程的页面(§5.8)。
    // 在那之前一律按陈旧条目覆盖 —— 否则同一个仓库第二次启动直接失败。
    unlinkSync(path);
    writeExclusive(path, payload);
  }
  return path;
}

/** 读取注册表。给 dev proxy 用(见 vite.config.ts);读不到一律返回 null。 */
export function readRegistry(repoRoot: string): RegistryEntry | null {
  try {
    const raw = readFileSync(registryPath(repoRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RegistryEntry>;
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return null;
    return parsed as RegistryEntry;
  } catch {
    return null;
  }
}

/** 退出时清理。只删自己写的那一条,免得把另一个实例的条目带走。 */
export function removeRegistry(repoRoot: string): void {
  const path = registryPath(repoRoot);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // 已经不在了,清理完成
  }

  let entry: Partial<RegistryEntry> | null = null;
  try {
    entry = JSON.parse(raw) as Partial<RegistryEntry>;
  } catch {
    // 落空,下面按「不是我们的」处理
  }

  // **解析失败不等于是自己的**。写到一半的条目、或将来换了格式的条目都会落到这里,
  // 而它们背后多半有另一个活着的实例 —— 删掉之后那个实例就没有记录了,S3c 的探活
  // 复用会给同一个仓库起第二个进程。宁可留一个陈旧文件:writeRegistry 的 EEXIST
  // 分支本来就会覆盖它,不构成死结。
  if (!entry || entry.pid !== process.pid) return;

  try {
    unlinkSync(path);
  } catch {
    // 清理失败不该盖过退出本身
  }
}
