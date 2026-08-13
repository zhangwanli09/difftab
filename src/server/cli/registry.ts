// 同仓库单实例的注册表文件(spec §5.8)。
//
// 写入在 S1 就落地(dev proxy 要从这里拿 token,否则那段时间里「临时给后端加个
// 放宽校验的环境变量」就成了最短路径,而那是 §10 明令禁止的做法);**消费**它的
// 那一半 —— 探活复用 —— 在 S3c,落在同目录的 probe.ts。

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
 *
 * **探活比对仓库身份时用的也是这一份**(probe.ts):一侧是 `/api/instance` 返回的
 * `git rev-parse --show-toplevel`、另一侧是本进程的同一条命令,看着不可能不等 ——
 * 但 macOS 上 `/tmp` 与 `/private/tmp` 这类差异照样能让两个活着的实例互不相认,
 * 于是同一个仓库开出第二个进程。两处各写一份归一化,漂移是静默的。
 */
export function normalizeRepoKey(repoRoot: string): string {
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
  const hash = createHash('sha256').update(normalizeRepoKey(repoRoot)).digest('hex').slice(0, 32);
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
    /**
     * 走到这里说明**探活已经判过它是陈旧的**(start.ts 命中就不会再启动,更不会
     * 写注册表),所以覆盖是对的。
     *
     * 保留 `O_EXCL` + 显式 unlink 而不是改成 `'w'`:两者的区别只在这个分支要不要
     * 显式承认「我在覆盖别人的条目」。而 §5.8 那条 `0o600` 必须在创建时给出的要求
     * 也只有 `'wx'` 满足 —— `'w'` 对已存在的文件根本不套用 mode,一次遗留的
     * 0644 条目会被原样沿用,里面躺着本次会话的 token。
     */
    unlinkSync(path);
    writeExclusive(path, payload);
  }
  return path;
}

/**
 * 读取注册表。dev proxy(见 vite.config.ts)与探活(probe.ts)共用;读不到、或者
 * 读到一条用不了的条目,一律返回 null。
 *
 * **「这条目还能用吗」只在这里判一次**:端口得是一个真能连的端口号、token 不能是
 * 空串。放在消费侧各判各的话,两个消费者迟早对「可用」有两套定义,而分歧的表现是
 * dev proxy 与探活对同一条陈旧条目给出不同结论。
 */
export function readRegistry(repoRoot: string): RegistryEntry | null {
  try {
    const raw = readFileSync(registryPath(repoRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RegistryEntry>;
    if (typeof parsed.token !== 'string' || parsed.token === '') return null;
    if (!Number.isInteger(parsed.port) || (parsed.port ?? 0) <= 0 || (parsed.port ?? 0) > 65_535) {
      return null;
    }
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
