// hunk 里的行怎么配对、怎么排成两种版式的行序，以及配上对的两行之间的词级差异。**纯函数，
// 不碰 DOM**：上色在 `render.ts`，画在 `DiffView.tsx`。
//
// 配对规则照搬 diff2html 3.4.56 的默认（`matching: 'none'`）：一段连续的删除行与紧随其后的那段
// 插入行是一组，组内按下标两两配对，多出来的那侧补空位。上游另有按相似度重新配对的两档，默认
// 不开，我们也从没开过——照搬的是页面上一直以来的样子。

import { diffWords, diffWordsWithSpace } from 'diff';
import type { LineKind } from './parse';

/** 一组：一行上下文，或一段「删除 + 插入」 */
export type Group<L> =
  | { kind: 'context'; line: L }
  | { kind: 'change'; deleted: L[]; inserted: L[] };

/**
 * 按上游 `applyLineGroupping` 的结果分组。**与上游逐行等价，但少了一种分组**：上游把「前面没有删
 * 除行的插入行」各自单独成组，而单独成组与并进同一组的 `inserted`，两种版式画出来逐行相同。
 */
export function groupLines<L extends { kind: LineKind }>(lines: readonly L[]): Group<L>[] {
  const groups: Group<L>[] = [];
  let deleted: L[] = [];
  let inserted: L[] = [];
  const flush = () => {
    if (deleted.length || inserted.length) groups.push({ kind: 'change', deleted, inserted });
    deleted = [];
    inserted = [];
  };
  for (const line of lines) {
    if (line.kind === 'context') {
      flush();
      groups.push({ kind: 'context', line });
    } else if (line.kind === 'delete') {
      // 插入之后又出现删除：上一组到此为止，这一行开一个新组
      if (inserted.length) flush();
      deleted.push(line);
    } else {
      inserted.push(line);
    }
  }
  flush();
  return groups;
}

/** 逐行版式的行序：上下文照排，每组先列全部删除、再列全部插入。 */
export function unifiedLines<L>(groups: readonly Group<L>[]): L[] {
  return groups.flatMap((g) => (g.kind === 'context' ? [g.line] : [...g.deleted, ...g.inserted]));
}

export interface SplitRow<L> {
  left: L | null;
  right: L | null;
}

/** 并排版式的行序：上下文两侧同一行；每组按下标配对，短的那侧补 `null`（空位）。 */
export function splitRows<L>(groups: readonly Group<L>[]): SplitRow<L>[] {
  return groups.flatMap((g) => {
    if (g.kind === 'context') return [{ left: g.line, right: g.line }];
    const rows: SplitRow<L>[] = [];
    for (let i = 0; i < Math.max(g.deleted.length, g.inserted.length); i++) {
      rows.push({ left: g.deleted[i] ?? null, right: g.inserted[i] ?? null });
    }
    return rows;
  });
}

/** 一行里的一段，按 UTF-16 下标，左闭右开 */
export interface Range {
  start: number;
  end: number;
}

/**
 * 任一侧超过这个长度就不算词级差异（与上游 `maxLineLengthHighlight` 同值）：`diffWordsWithSpace`
 * 是 O(N·D)，一行压缩过的 JS 动辄几十万字符，算一次能把页面卡住好几秒。
 */
export const MAX_WORD_DIFF_LENGTH = 10000;

/**
 * 配上对的一删一增之间的词级差异：旧侧被删掉的那几段、新侧加进来的那几段。超长时给两个空数组，
 * 那一对就只有整行底色。
 *
 * `ignoreWhitespace` 时改用 `diffWords`（不计空白）：补丁是按 `-w` 取的，一行同时改了内容与缩进时
 * 只该标内容那几段。**它不能与另一档共用一趟循环**：空白不同而被认作相同的片段，`value` 取的是第二
 * 个参数那一侧的原文，两侧的偏移按同一个长度累加就从第一处缩进起错开。所以两侧各比一次，每次只沿
 * 第二个参数那一侧走——未删除的片段拼起来恰好是那一侧的原文。
 */
export function wordRanges(
  before: string,
  after: string,
  ignoreWhitespace = false,
): { deleted: Range[]; inserted: Range[] } {
  if (before.length > MAX_WORD_DIFF_LENGTH || after.length > MAX_WORD_DIFF_LENGTH) {
    return { deleted: [], inserted: [] };
  }
  if (ignoreWhitespace) {
    return { deleted: addedRanges(after, before), inserted: addedRanges(before, after) };
  }
  const deleted: Range[] = [];
  const inserted: Range[] = [];
  let atOld = 0;
  let atNew = 0;
  for (const part of diffWordsWithSpace(before, after)) {
    const length = part.value.length;
    if (part.removed) {
      deleted.push({ start: atOld, end: atOld + length });
      atOld += length;
    } else if (part.added) {
      inserted.push({ start: atNew, end: atNew + length });
      atNew += length;
    } else {
      atOld += length;
      atNew += length;
    }
  }
  return { deleted, inserted };
}

/** 不计空白时 `to` 比 `from` 多出来的那几段，按 `to` 的下标。 */
function addedRanges(from: string, to: string): Range[] {
  const ranges: Range[] = [];
  let at = 0;
  for (const part of diffWords(from, to)) {
    if (part.removed) continue;
    const length = part.value.length;
    if (part.added) ranges.push({ start: at, end: at + length });
    at += length;
  }
  return ranges;
}
