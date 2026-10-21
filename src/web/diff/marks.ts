// 补丁 → 文件视图行号旁的改动标记（照 VS Code 的 quick diff）。**纯函数，不碰 DOM**：画在
// `FileView.tsx`。
//
// 分组复用 `rows.ts` 的 `groupLines`：一段连续的删除与紧随其后的插入是一组，与 diff 表格配对的口径
// 是同一份——两处各分一遍时，同一处改动在 diff tab 里是「改」、在全文里却标成「增」。

import type { Hunk } from './parse';
import { groupLines } from './rows';

export type MarkKind = 'added' | 'modified' | 'deleted';

/**
 * 一段标记，行号是新侧（工作区此刻那份文件）的。`count` 为 0 即删除点：画在第 `line` 行的顶边，
 * `line` 可以比最后一行大一（删的是文件末尾那几行）。
 */
export interface LineMark {
  kind: MarkKind;
  line: number;
  count: number;
}

/**
 * 一份补丁的标记。参数是 `parsePatch` 的结果：**只取最后一段**——类型变了的路径（符号链接换成普通
 * 文件）git 给的是一段删除加一段新增，后一段才是此刻的这个文件。
 */
export function marksOf(files: readonly (readonly Hunk[])[]): LineMark[] {
  const hunks = files.at(-1) ?? [];
  return hunks.flatMap((hunk) => {
    const marks: LineMark[] = [];
    // 新侧的下一行：上下文与插入行都带 `newNo`，删除行没有，删除点就落在这里
    let next = hunk.lines.find((line) => line.newNo !== undefined)?.newNo ?? 1;
    for (const group of groupLines(hunk.lines)) {
      if (group.kind === 'context') {
        next = (group.line.newNo ?? next) + 1;
        continue;
      }
      const first = group.inserted[0]?.newNo;
      if (first === undefined) {
        marks.push({ kind: 'deleted', line: next, count: 0 });
        continue;
      }
      const kind = group.deleted.length > 0 ? 'modified' : 'added';
      marks.push({ kind, line: first, count: group.inserted.length });
      next = first + group.inserted.length;
    }
    return marks;
  });
}
