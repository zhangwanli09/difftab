// Quick Open（`⌘P` / `Ctrl+P`）的状态与模糊匹配。文件列表**每次打开时取一次，不随 SSE 重取**：
// 它只在建文件、删文件时变，而 agent 跑动时每个文件事件都推一次 SSE；取到过就先用旧的、回来再换。

import { signal } from '@preact/signals';
import type { FileList } from '../../server/shared/protocol';
import { getJson, latestWins, toMessage } from './http';

export const quickOpenVisible = signal(false);

/** 上一次取到的全仓文件路径；`null` 即还没取到过、或上一次取失败了（理由同 `refList`）。 */
export const fileList = signal<readonly string[] | null>(null);
export const fileListError = signal<string | null>(null);

const tickets = latestWins();

export async function loadFileList(): Promise<void> {
  const ticket = tickets.claim();
  fileListError.value = null;
  try {
    const { paths } = await getJson<FileList>('/api/files');
    if (!tickets.isCurrent(ticket)) return;
    fileList.value = paths;
  } catch (cause) {
    if (!tickets.isCurrent(ticket)) return;
    fileList.value = null;
    fileListError.value = toMessage(cause);
  } finally {
    tickets.release(ticket);
  }
}

/** 一条命中：路径、分数，以及命中的字符下标（UTF-16，相对整条路径），给行去加粗。 */
export interface PathMatch {
  path: string;
  score: number;
  positions: readonly number[];
}

/** 这些字符之后的那个字符算「段首」：路径分隔、扩展名、常见的命名分隔。 */
const SEPARATORS = new Set(['/', '.', '-', '_', ' ']);

/**
 * `needle` 在 `hay` 里从 `from` 起的子序列命中，每个字符取最左那一处；不成立时 `null`。最左贪心
 * 不保证分数最高，但几十行能写完、结果可预期——VS Code 的 `fuzzyScorer` 也先认子序列再打分。
 */
function subsequence(hay: string, needle: string, from: number): number[] | null {
  const positions: number[] = [];
  let at = from;
  for (const char of needle) {
    const found = hay.indexOf(char, at);
    if (found === -1) return null;
    positions.push(found);
    at = found + 1;
  }
  return positions;
}

/** 连续命中优先于散开的命中：整段子串在里面就取它，否则退回子序列。 */
function bestRun(hay: string, needle: string, from: number): number[] | null {
  const run = hay.indexOf(needle, from);
  if (run !== -1) return Array.from(needle, (_, i) => run + i);
  return subsequence(hay, needle, from);
}

/** 查询的规整：空白不算、不分大小写。整份列表打分前只做一次。 */
const normalize = (query: string) => query.replace(/\s+/g, '').toLowerCase();

/**
 * 路径的小写形态，下标与原路径逐个对齐。`toLowerCase` 改了长度（极少数字符会，如 `İ`）时逐个码元转，
 * 变长的那几个留原样——整条退回原样比的话，路径里其余的大写字母也一并不认了。
 */
function foldCase(path: string): string {
  const lower = path.toLowerCase();
  if (lower.length === path.length) return lower;
  return path.replace(/[\s\S]/g, (char) => {
    const folded = char.toLowerCase();
    return folded.length === 1 ? folded : char;
  });
}

/**
 * 模糊匹配一条路径：**不分大小写的子序列匹配**，查询里的空白不算。打分偏好三件事——命中全落在
 * basename 里（找文件的人敲的多半是文件名）、命中连成一段、命中落在段首；同分时短路径在前（由
 * `matchFiles` 排）。
 */
export function matchPath(query: string, path: string): PathMatch | null {
  return score(normalize(query), path, foldCase(path));
}

/** `needle` 已规整、`hay` 是 `path` 的 `foldCase`。 */
function score(needle: string, path: string, hay: string): PathMatch | null {
  if (needle === '') return { path, score: 0, positions: [] };
  const base = path.lastIndexOf('/') + 1;

  const inBase = bestRun(hay, needle, base);
  const positions = inBase ?? bestRun(hay, needle, 0);
  if (positions === null) return null;

  let points = inBase === null ? 0 : 1000;
  for (let i = 0; i < positions.length; i += 1) {
    const at = positions[i] as number;
    const previous = hay[at - 1];
    if (at === 0 || (previous !== undefined && SEPARATORS.has(previous))) points += 30;
    if (i > 0 && positions[i - 1] === at - 1) points += 20;
  }
  // basename 以查询开头是最强的信号：敲 `app` 时 `App.tsx` 应排在 `mapper.ts` 之前
  if (inBase !== null && inBase[0] === base) points += 200;
  return { path, score: points, positions };
}

/**
 * 上一份列表的小写形态。**按列表的身份缓存**：每敲一个字都要对几万条路径打一遍分，每次都重新
 * `toLowerCase` 一遍是白做的；列表只在打开 Quick Open 取回来时换一份。
 */
let folded: { source: readonly string[]; hays: string[] } | null = null;

/** 对整份列表打分、排序。同分时短路径在前，再按路径排，结果稳定。 */
export function matchFiles(paths: readonly string[], query: string): PathMatch[] {
  if (folded?.source !== paths) folded = { source: paths, hays: paths.map(foldCase) };
  const { hays } = folded;
  const needle = normalize(query);
  const matches: PathMatch[] = [];
  paths.forEach((path, i) => {
    const match = score(needle, path, hays[i] as string);
    if (match !== null) matches.push(match);
  });
  return matches.sort(
    (a, b) =>
      b.score - a.score ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}
