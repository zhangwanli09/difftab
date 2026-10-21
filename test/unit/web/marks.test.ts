// 补丁 → 文件视图的改动标记（`marksOf()`）。纯函数，不碰 DOM。
//
// 标错的症状不报错：绿条落在改过的行上（该是蓝）、删除点画在别的行缝里，页面看起来照样正常。补丁由
// `diff` 包按 3 行上下文生成，与 git 的默认口径相同。

import { createTwoFilesPatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { marksOf } from '../../../src/web/diff/marks';
import { parsePatch } from '../../../src/web/diff/parse';

const text = (lines: readonly string[]) => (lines.length ? `${lines.join('\n')}\n` : '');

const marks = (before: readonly string[], after: readonly string[]) =>
  marksOf(parsePatch(createTwoFilesPatch('a/f.txt', 'b/f.txt', text(before), text(after))));

const numbered = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));

describe('marksOf', () => {
  it('删一行再在原处插一行是修改，标在新侧那一行上', () => {
    expect(marks(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual([
      { kind: 'modified', line: 2, count: 1 },
    ]);
  });

  it('删得比插得多仍只标插入的那几行（新侧没有多出来的行可标）', () => {
    expect(marks(['a', 'b', 'c', 'd'], ['a', 'X', 'd'])).toEqual([
      { kind: 'modified', line: 2, count: 1 },
    ]);
  });

  it('只有插入是新增', () => {
    expect(marks(['a', 'b'], ['a', 'x', 'y', 'b'])).toEqual([{ kind: 'added', line: 2, count: 2 }]);
  });

  it('只有删除是删除点，落在新侧被删处的下一行顶边——开头、中间、末尾三处', () => {
    expect(marks(['a', 'b', 'c'], ['a', 'c'])).toEqual([{ kind: 'deleted', line: 2, count: 0 }]);
    expect(marks(['a', 'b', 'c'], ['b', 'c'])).toEqual([{ kind: 'deleted', line: 1, count: 0 }]);
    // 末尾那行删了：落在最后一行的底边，即「第 3 行」的顶边
    expect(marks(['a', 'b', 'c'], ['a', 'b'])).toEqual([{ kind: 'deleted', line: 3, count: 0 }]);
  });

  it('多个 hunk 各标各的，行号按新侧走', () => {
    const before = numbered(20);
    const after = ['0', ...before.slice(0, 14), ...before.slice(15)];
    after[after.length - 1] = 'last';
    expect(marks(before, after)).toEqual([
      { kind: 'added', line: 1, count: 1 },
      { kind: 'deleted', line: 16, count: 0 },
      { kind: 'modified', line: 20, count: 1 },
    ]);
  });

  it('全新增（未跟踪文件）整份标绿；没有 hunk 时什么都不标', () => {
    expect(marks([], ['x', 'y'])).toEqual([{ kind: 'added', line: 1, count: 2 }]);
    expect(marksOf(parsePatch(''))).toEqual([]);
  });

  it('两段补丁（类型变了）只取后一段——那一段才是此刻的文件', () => {
    const removed = createTwoFilesPatch('a/f', '/dev/null', 'target\n', '');
    const added = createTwoFilesPatch('/dev/null', 'b/f', '', 'x\ny\n');
    expect(marksOf(parsePatch(`${removed}${added}`))).toEqual([
      { kind: 'added', line: 1, count: 2 },
    ]);
  });
});
