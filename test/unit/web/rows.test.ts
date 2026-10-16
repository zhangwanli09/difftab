// 解析与行序：`parsePatch()`、配对、两种版式的行序、词级区间。全是纯函数，不碰 DOM。
//
// 配对规则照搬 diff2html 3.4.56 的默认（`matching: 'none'`），这里钉的是「页面上一直以来的样子」：
// 改了它不报错，只是并排时哪一行对着哪一行悄悄变了。

import { describe, expect, it } from 'vitest';
import { type PatchLine, parsePatch } from '../../../src/web/diff/parse';
import {
  groupLines,
  MAX_WORD_DIFF_LENGTH,
  splitRows,
  unifiedLines,
  wordRanges,
} from '../../../src/web/diff/rows';

/** 按「种类 + 正文」造一行，行号不参与配对 */
const line = (spec: string): PatchLine => {
  const kind = ({ ' ': 'context', '-': 'delete', '+': 'insert' } as const)[
    spec[0] as ' ' | '-' | '+'
  ];
  return { kind, oldNo: undefined, newNo: undefined, text: spec.slice(1) };
};
const texts = (lines: readonly (PatchLine | null)[]) => lines.map((l) => (l ? l.text : null));

describe('parsePatch', () => {
  it('行号、种类、去掉前缀的正文', () => {
    const [[hunk, ...rest] = []] = parsePatch(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -3,3 +3,3 @@ function f() {
 keep
-old
+new
 tail
`);

    expect(rest).toHaveLength(0);
    expect(hunk).toMatchObject({ oldFirst: 3, oldCount: 3 });
    expect(hunk?.lines).toEqual([
      { kind: 'context', oldNo: 3, newNo: 3, text: 'keep' },
      { kind: 'delete', oldNo: 4, newNo: undefined, text: 'old' },
      { kind: 'insert', oldNo: undefined, newNo: 4, text: 'new' },
      { kind: 'context', oldNo: 5, newNo: 5, text: 'tail' },
    ]);
  });

  it('「\\ No newline at end of file」不是一行', () => {
    const [[hunk] = []] = parsePatch(`--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
\\ No newline at end of file
`);

    expect(texts(hunk?.lines ?? [])).toEqual(['a', 'b']);
  });

  it('只改了权限位：一段、没有 hunk，不是错误', () => {
    // 调用方据此画「File without changes.」，而不是一张空表
    expect(
      parsePatch(`diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`),
    ).toEqual([[]]);
  });

  it('类型变了的路径是两段，段界留着', () => {
    // 符号链接换成普通文件：git 给一段删除、一段新增。两段是两个文件版本，语言判定的状态不能
    // 从前一段带进后一段——拼成一段时不报错，只是后一段从错的状态起步
    const sections = parsePatch(`diff --git a/link b/link
deleted file mode 120000
index 1111111..0000000
--- a/link
+++ /dev/null
@@ -1 +0,0 @@
-target
\\ No newline at end of file
diff --git a/link b/link
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/link
@@ -0,0 +1,2 @@
+one
+two
`);

    expect(sections.map((hunks) => hunks.flatMap((h) => texts(h.lines)))).toEqual([
      ['target'],
      ['one', 'two'],
    ]);
  });
});

describe('groupLines / unifiedLines / splitRows', () => {
  // 一段删除后紧跟插入是一组；插入之后再出现删除就开新组；上下文把组切开
  const lines = [' a', '-b', '-c', '+B', ' d', '+e', '-f', '+F', '+G'].map(line);

  it('分组', () => {
    expect(
      groupLines(lines).map((g) =>
        g.kind === 'context' ? g.line.text : [texts(g.deleted), texts(g.inserted)],
      ),
    ).toEqual(['a', [['b', 'c'], ['B']], 'd', [[], ['e']], [['f'], ['F', 'G']]]);
  });

  it('逐行：每组先列全部删除，再列全部插入', () => {
    expect(texts(unifiedLines(groupLines(lines)))).toEqual([
      'a',
      'b',
      'c',
      'B',
      'd',
      'e',
      'f',
      'F',
      'G',
    ]);
  });

  it('并排：组内按下标配对，短的那侧补空位，上下文两侧同一行', () => {
    const rows = splitRows(groupLines(lines));

    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      ['c', null],
      ['d', 'd'],
      [null, 'e'],
      ['f', 'F'],
      [null, 'G'],
    ]);
  });
});

describe('wordRanges', () => {
  it('旧侧标出删掉的，新侧标出加进来的', () => {
    const before = 'return a + b;';
    const after = 'return a - b;';
    const { deleted, inserted } = wordRanges(before, after);

    expect(deleted.map((r) => before.slice(r.start, r.end))).toEqual(['+']);
    expect(inserted.map((r) => after.slice(r.start, r.end))).toEqual(['-']);
  });

  it('任一侧超长就不算', () => {
    const long = 'a '.repeat(MAX_WORD_DIFF_LENGTH);

    // 正面断言：同样的改动在不超长时是有标记的
    expect(wordRanges('a b', 'a c').deleted).not.toHaveLength(0);
    expect(wordRanges(long, `${long}c`)).toEqual({ deleted: [], inserted: [] });
  });

  it('忽略空白时缩进不算差异，两侧的下标仍各按各的原文', () => {
    const before = '  foo(a, b)';
    const after = '      foo(a,  c)';
    const pick = (line: string, ranges: { start: number; end: number }[]) =>
      ranges.map((r) => line.slice(r.start, r.end));

    // 正面对照：不忽略时缩进本身就是一处差异
    expect(pick(after, wordRanges(before, after).inserted)).toContain('      ');
    // 两侧的空白宽度不同：共用一个偏移累加时，旧侧从第一处缩进起就整体错开、标到别的字上
    const { deleted, inserted } = wordRanges(before, after, true);
    // 标记里可以带着词前那个空格（`diff` 包把它算进词里），但不会落到缩进或别的字上
    expect(pick(before, deleted).map((part) => part.trim())).toEqual(['b']);
    expect(pick(after, inserted).map((part) => part.trim())).toEqual(['c']);
    expect(deleted[0]?.start).toBeGreaterThan(before.indexOf(','));
    expect(inserted[0]?.start).toBeGreaterThan(after.indexOf(','));
  });
});
