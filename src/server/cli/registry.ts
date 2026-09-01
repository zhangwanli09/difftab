// 同仓库单实例的注册表文件。
//
// 与 probe.ts 的分工:这边是文件(写入、清理、键归一化),那边是探活的那一次 HTTP 请求。
// dev proxy 也从这里拿 token —— 否则「临时给后端加个放宽校验的环境变量」就成了最短路径,
// 而那是红线明令禁止的做法。

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
  /** `<port>.<secret>`,dev proxy 靠它注入 cookie。 */
  token: string;
  repoRoot: string;
  startedAt: number;
}

/**
 * 注册表目录。**绝不能写进 `.git/` 或工作区** —— 那既污染 `git status`,也实质违背零写
 * 操作承诺。`os.tmpdir()` 的权限因平台而异(Linux 上 `/tmp` 是 1777、同机其他用户可读),
 * 所以这里再套一层每用户私有子目录,文件本身另有 0o600。
 */
function registryDir(): string {
  return join(tmpdir(), 'difftab');
}

/**
 * 把仓库路径归一成注册表的键。写入侧给的是 `git rev-parse --show-toplevel`,读取侧(dev
 * proxy)给的是 `process.cwd()` —— **两者指向同一个目录时字面量仍可能不同**,而 hash 只认
 * 字面量:Windows 上 git 给 `C:/Users/x/repo` 而 cwd 给 `C:\Users\x\repo`;macOS 上 cwd 经
 * 符号链接进来时是 `/var/...` 而 git 给 `/private/var/...`。不归一的话 dev proxy 永远找不
 * 到正在运行的后端,症状是「后端明明起着却说没找到」。
 *
 * **探活比对仓库身份时用的也是这一份**:两处各写一份归一化,漂移是静默的 —— 症状是同一个
 * 仓库开出第二个进程。
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
 * 写入注册表。`0o600` 必须**配合 `O_EXCL` 在创建时**给出(`'wx'` + mode),而不是先建后
 * chmod —— 后者留下一个竞态窗口,窗口里文件是可读的,而它存着本次会话的 token。
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
     * 走到这里说明**探活已经判过它是陈旧的**(start.ts 命中就不会再启动,更不会写注册
     * 表),所以覆盖是对的。保留 `O_EXCL` + 显式 unlink 而不是改成 `'w'`:那条「`0o600`
     * 必须在创建时给出」只有 `'wx'` 满足 —— `'w'` 对已存在的文件根本不套用 mode,一次遗留
     * 的 0644 条目会被原样沿用,里面躺着本次会话的 token。
     */
    unlinkSync(path);
    writeExclusive(path, payload);
  }
  return path;
}

/**
 * 读取注册表。dev proxy(见 vite.config.ts)与探活共用;读不到、或者读到一条用不了的条目,
 * 一律返回 null。**「这条目还能用吗」只在这里判一次**:端口得是一个真能连的端口号、token
 * 不能是空串。放在消费侧各判各的话,两个消费者迟早对「可用」有两套定义,而分歧的表现是
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

  // **解析失败不等于是自己的**:写到一半的条目、或将来换了格式的条目都会落到这里,而它们
  // 背后多半有另一个活着的实例 —— 删掉之后探活复用会给同一个仓库起第二个进程。宁可留一个
  // 陈旧文件,writeRegistry 的 EEXIST 分支本来就会覆盖它,不构成死结
  if (!entry || entry.pid !== process.pid) return;

  try {
    unlinkSync(path);
  } catch {
    // 清理失败不该盖过退出本身
  }
}
