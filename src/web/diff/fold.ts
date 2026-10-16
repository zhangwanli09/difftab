// 没改的行怎么折：一份补丁 → 一串「可见的行」与「折起来的一段」交替的块。**纯函数，不碰 DOM**，
// 也不管上色（`render.ts`）与画法（`DiffView.tsx`）。
//
// 两种补丁走同一个出口，且**折出来的位置与行数必须逐段相同**：
// - 3 行上下文的补丁（`full: false`）：git 已经按 `-U3` 开好了窗，可见的就是 hunk 里那些行；两段
//   之间隔了几行由 hunk 头算，那几行的正文补丁里没有；
// - 整份上下文的补丁（`full: true`）：整个文件一个 hunk，窗由这里按同一个判据重开——离任一改动行
//   3 行以内的上下文可见，其余连续的那几段各折成一段，与后端那条 `--unified=3 --inter-hunk-context=0`
//   逐行相同。两边差一行时，点下去那一刻整页跳一下，且点开的不是用户点的那段。

import { DIFF_CONTEXT_LINES } from '../../server/shared/protocol';
import type { Hunk, PatchLine } from './parse';

/**
 * 折起来的一段。`L` 是行的类型：解析出来的 `PatchLine`，或上过色的 `DiffLine`。
 */
export interface Gap<L> {
  kind: 'gap';
  /**
   * 这一段在旧侧的第一行。**它是这一段的身份**：行的 `key`、展开了哪几段都按它认，SSE 刷新与
   * 「从 3 行换成整份上下文」两个时刻按它比对。这一段上面多了或少了几行时它跟着变，那一段就重新
   * 折起——已知取舍。
   */
  id: number;
  /** 有几行。`null` 是 3 行上下文时文件末尾那一段：补丁里没有文件总行数。 */
  count: number | null;
  /** 这几行的正文。3 行上下文时为空——补丁里没有，要展开得先取整份上下文。 */
  lines: L[];
}

/** 折起来的一段，或一串照常画的行。 */
export type Block<L> = { kind: 'lines'; lines: L[] } | Gap<L>;

/**
 * 一个文件段的 hunk → 块。`full` 取自 payload（后端说这份补丁是不是整份上下文），不取自请求参数。
 *
 * **文件末尾那一段，3 行上下文时只能推断**：最后一个 hunk 的尾部上下文不足 3 行（含 0 行）即已到
 * 末尾；恰好 3 行时末尾可能还有东西，给一段 `count: null`。整份上下文回来后它要么有了行数，要么
 * 消失。这条推断成立的前提是后端显式带 `--unified=3`——用户配了 `diff.context` 时 git 照配置给。
 */
export function foldHunks(hunks: readonly Hunk[], full: boolean): Block<PatchLine>[] {
  const blocks: Block<PatchLine>[] = [];
  // 上一段在旧侧的最后一行；第一段之前当作第 0 行
  let oldLast = 0;
  for (const hunk of hunks) {
    const before = hunk.oldFirst - oldLast - 1;
    if (before > 0) blocks.push({ kind: 'gap', id: oldLast + 1, count: before, lines: [] });
    if (full) blocks.push(...openWindows(hunk.lines));
    else blocks.push({ kind: 'lines', lines: hunk.lines });
    oldLast = hunk.oldFirst + hunk.oldCount - 1;
  }
  const last = hunks.at(-1);
  if (!full && last !== undefined && trailingContext(last.lines) >= DIFF_CONTEXT_LINES) {
    blocks.push({ kind: 'gap', id: oldLast + 1, count: null, lines: [] });
  }
  return blocks;
}

/** 末尾连着几行上下文。 */
function trailingContext(lines: readonly PatchLine[]): number {
  let count = 0;
  for (let i = lines.length - 1; i >= 0 && lines[i]?.kind === 'context'; i--) count += 1;
  return count;
}

/**
 * 整份上下文的一个 hunk 里重开窗：一行上下文离前后最近的改动（按上下文行数计）都超过 3 行就折起。
 * 距离只数上下文行——与 git 一样，改动行本身不算进 `-U` 的那几行里。
 */
function openWindows(lines: readonly PatchLine[]): Block<PatchLine>[] {
  const distance = lines.map(() => Number.POSITIVE_INFINITY);
  // 两趟：先量到前一处改动的距离，再量到后一处的，取小的那个
  for (const order of [lines.keys(), [...lines.keys()].reverse()]) {
    let since = Number.POSITIVE_INFINITY;
    for (const i of order) {
      if (lines[i]?.kind === 'context') {
        since += 1;
        distance[i] = Math.min(distance[i] ?? since, since);
      } else {
        since = 0;
        distance[i] = 0;
      }
    }
  }

  const blocks: Block<PatchLine>[] = [];
  lines.forEach((line, i) => {
    const hidden = (distance[i] ?? 0) > DIFF_CONTEXT_LINES;
    const tail = blocks.at(-1);
    if (hidden) {
      if (tail?.kind === 'gap') {
        tail.lines.push(line);
        tail.count = tail.lines.length;
      } else {
        blocks.push({ kind: 'gap', id: line.oldNo ?? 0, count: 1, lines: [line] });
      }
    } else if (tail?.kind === 'lines') {
      tail.lines.push(line);
    } else {
      blocks.push({ kind: 'lines', lines: [line] });
    }
  });
  return blocks;
}
