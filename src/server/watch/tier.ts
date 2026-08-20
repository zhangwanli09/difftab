// 监听档位判定(spec §5.7)。
//
// **档位按 `process.versions.node` 做 semver 比对,禁用特性探测**:任何探测写法
// (给 `fs.watch` 传一个 `ignore` 看它报不报错、或看选项对象有没有被读过)都要依赖
// 「`fs.watch` 如何处理未知选项」这一未文档化的内部细节。误判的代价是不对称的 ——
// 错判成 A 档时,Linux 上会建一个**没有 `ignore`** 的递归 watch,而 Node 在 Linux 上的
// 递归实现是用户态遍历、对每个普通文件也注册一个 inotify watch,足以耗尽
// `fs.inotify.max_user_watches`,之后整机所有依赖 inotify 的工具(包括用户自己的
// 编辑器)开始报 ENOSPC。那是本工具唯一可能对用户机器造成的外部副作用。

import type { WatchState } from '../shared/protocol.ts';

export type WatchTier = 'A' | 'B' | 'C';

/** `fs.watch` 的 `ignore` 选项自此版本可用(spec §5.7)。 */
const IGNORE_SINCE = { major: 24, minor: 14, patch: 0 };

/**
 * 强制指定档位的**内部**环境变量(spec §7:S3b1 的首个交付物)。
 *
 * 没有它,S3b2 的六条档位验收项在单机上一条都无从自查 —— 一台机器只有一个 Node
 * 版本、一个平台,而三档正是按这两者分的。它不是给用户的开关,README 不写它。
 */
export const TIER_ENV = 'DIFFTAB_WATCH_TIER';

/** 档位环境变量的取值不合法。由 main() 收成一句话友好报错。 */
export class WatchTierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchTierError';
  }
}

/**
 * `24.14.1` / `26.0.0-nightly20260101` → 三元组 + 是否带预发布标签。
 *
 * 解析不出来返回 null,调用方按「没有 `ignore`」处理 —— 见 `supportsIgnoreOption`
 * 里那段关于误判方向的说明。
 */
function parseNodeVersion(
  version: string,
): { major: number; minor: number; patch: number; prerelease: boolean } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] !== undefined,
  };
}

/**
 * 当前 Node 是否具备 `fs.watch` 的 `ignore` 选项。
 *
 * **解析失败一律按「没有」处理**,方向是刻意的:误判成没有,代价是 Linux 上退化为
 * 1.5s 轮询(功能完整,只是不即时);误判成有,代价是上面那条注释里的 ENOSPC。
 * 两种误判的代价差着一个数量级,判据不确定时只能倒向便宜的那一侧。
 *
 * 预发布标签按 semver 的规矩算作**低于**同版本正式版(`24.14.0-rc.1 < 24.14.0`):
 * 那正是选项刚合入、行为还可能变的窗口。
 */
export function supportsIgnoreOption(nodeVersion: string): boolean {
  const v = parseNodeVersion(nodeVersion);
  if (!v) return false;
  if (v.major !== IGNORE_SINCE.major) return v.major > IGNORE_SINCE.major;
  if (v.minor !== IGNORE_SINCE.minor) return v.minor > IGNORE_SINCE.minor;
  if (v.patch !== IGNORE_SINCE.patch) return v.patch > IGNORE_SINCE.patch;
  return !v.prerelease;
}

/**
 * 档位判定(spec §5.7 的三档表)。
 *
 * - **A**:有 `ignore`,三端通用 —— Linux 上是注册前跳过,正是配额问题的官方解法
 * - **B**:没有 `ignore`,但在 macOS / Windows 上走原生 FSEvents / `ReadDirectoryChangesW`,
 *   单句柄监听整棵树,本就没有配额问题,回调里自己过滤即可
 * - **C**:没有 `ignore` 且在 Linux 上 —— **不建递归 watch**,工作区改动走轮询
 */
export function detectTier(nodeVersion: string, platform: string): WatchTier {
  if (supportsIgnoreOption(nodeVersion)) return 'A';
  return platform === 'linux' ? 'C' : 'B';
}

/**
 * 实际生效的档位:环境变量优先,否则按运行时判定。
 *
 * **取值不合法时抛错而不是退回自动判定**:`DIFFTAB_WATCH_TIER=b` 那种手滑,退回
 * 自动判定的话在本机上多半照样给出 B 档,于是「我验过 B 档了」这个结论建立在
 * 一次根本没生效的强制指定上 —— 而 S3b2 的六条验收项全都压在这个变量上。
 */
function forcedTier(env: NodeJS.ProcessEnv): WatchTier | null {
  const forced = env[TIER_ENV];
  if (forced === undefined || forced.trim() === '') return null;

  const tier = forced.trim().toUpperCase();
  if (tier !== 'A' && tier !== 'B' && tier !== 'C') {
    throw new WatchTierError(`${TIER_ENV} must be one of A, B, C — got ${JSON.stringify(forced)}.`);
  }
  return tier;
}

export function resolveTier(
  env: NodeJS.ProcessEnv = process.env,
  nodeVersion: string = process.versions.node,
  platform: string = process.platform,
): WatchTier {
  return forcedTier(env) ?? detectTier(nodeVersion, platform);
}

/**
 * 该档位下**工作区通路**的既定形态(spec §5.12 的 `WatchState.mode`)。
 *
 * C 档一开始就以轮询为工作区通路,A / B 档则是原生监听。**它只是「还没起监听时
 * 答什么」**:监听懒起(见 http/server.ts),起了之后真实取值由 `WatchHandle.mode`
 * 给 —— A / B 档运行中落到轮询兜底时,那一侧会翻成 `polling`。
 */
export function initialMode(tier: WatchTier): WatchState['mode'] {
  return tier === 'C' ? 'polling' : 'native';
}

/**
 * 强制指定 A 档、但这个 Node 根本没有 `ignore` 时的一句提醒(没有则返回 null)。
 *
 * **不是报错**:「三档均可通过内部环境变量强制指定」是 §6 已经勾掉的验收项,
 * 在 Node 22 上拒绝启动会把它推翻,而 macOS / Windows 上强制 A 档去看别的行为
 * 也是正当用法。但沉默同样不行 —— Node 对未知选项是**静默忽略**,于是这次
 * 「A 档」跑的是一个**没有任何过滤的递归 watch**:在 Linux 上那正是耗尽
 * `fs.inotify.max_user_watches` 的那条路,而结论会写成「我验过 A 档了」。
 */
export function forcedTierWarning(
  env: NodeJS.ProcessEnv = process.env,
  nodeVersion: string = process.versions.node,
): string | null {
  // 归一走 `forcedTier`,不在这里再解析一遍:两份判据里松掉一份,警告会在它最该
  // 出现的那次(手滑写成别的形式)静默失灵,而两份都归一化过的用例照样绿
  if (forcedTier(env) !== 'A' || supportsIgnoreOption(nodeVersion)) return null;
  const since = `${IGNORE_SINCE.major}.${IGNORE_SINCE.minor}.${IGNORE_SINCE.patch}`;
  return `${TIER_ENV}=A on Node ${nodeVersion}: fs.watch has no "ignore" option before ${since}, so the recursive watch runs unfiltered — this is not tier A.`;
}
