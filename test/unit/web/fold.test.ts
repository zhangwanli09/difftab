// 没改的行怎么折（`foldHunks()`）。纯函数，不碰 DOM。
//
// **最要紧的那条是两种补丁折出来逐段相同**：3 行上下文时折叠位置由 hunk 头算，整份上下文时由前端
// 重开窗。两边差一行，点下去那一刻整页跳一下、且点开的不是用户点的那段。补丁由 `diff` 包按
// `context` 生成——它与 git 的 `-U3 --inter-hunk-context=0` 同一个并段规则（相隔不超过 2×3 行即并）。

import { createTwoFilesPatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { DIFF_CONTEXT_LINES } from '../../../src/server/shared/protocol';
import { foldHunks } from '../../../src/web/diff/fold';
import { parsePatch } from '../../../src/web/diff/parse';

const text = (lines: readonly string[]) => (lines.length ? `${lines.join('\n')}\n` : '');

/** 两个版本之间的补丁，按 `context` 行上下文；`full` 即整份文件。 */
const patchOf = (before: readonly string[], after: readonly string[], full: boolean) =>
  createTwoFilesPatch('a/f.txt', 'b/f.txt', text(before), text(after), '', '', {
    context: full ? Number.MAX_SAFE_INTEGER : DIFF_CONTEXT_LINES,
  });

const fold = (before: readonly string[], after: readonly string[], full: boolean) =>
  foldHunks(parsePatch(patchOf(before, after, full))[0] ?? [], full);

/** 只留形状：可见那几段的行（旧行号/新行号），折叠段的身份与行数。 */
const shapeOf = (blocks: ReturnType<typeof fold>) =>
  blocks.map((block) =>
    block.kind === 'gap'
      ? { gap: block.id, count: block.count }
      : {
          lines: block.lines.map(
            (line) => `${line.kind[0]}${line.oldNo ?? ''}:${line.newNo ?? ''}`,
          ),
        },
  );

const numbered = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));

describe('3 行上下文的补丁', () => {
  it('第一段之前、两段之间都折成一段，行数由 hunk 头算，正文为空', () => {
    const before = numbered(20);
    const after = before.map((line) => (line === '5' || line === '13' ? `${line}!` : line));
    const blocks = fold(before, after, false);
    expect(
      blocks.map((b) => (b.kind === 'gap' ? [b.id, b.count, b.lines.length] : 'lines')),
    ).toEqual([
      [1, 1, 0],
      'lines',
      [9, 1, 0],
      'lines',
      // 尾部上下文恰好 3 行：末尾可能还有东西，数不出来
      [17, null, 0],
    ]);
  });

  it('尾部上下文不足 3 行即已到文件末尾，不画最后那一段', () => {
    const before = numbered(10);
    const after = before.map((line) => (line === '9' ? 'nine' : line));
    expect(fold(before, after, false).at(-1)?.kind).toBe('lines');
  });

  it('新文件与删光的文件没有折叠段', () => {
    expect(fold([], ['a', 'b'], false).map((b) => b.kind)).toEqual(['lines']);
    expect(fold(['a', 'b'], [], false).map((b) => b.kind)).toEqual(['lines']);
  });
});

describe('整份上下文的补丁', () => {
  it('折叠段带着正文，末尾那一段数得出行数', () => {
    const before = numbered(20);
    const after = before.map((line) => (line === '5' || line === '13' ? `${line}!` : line));
    const blocks = fold(before, after, true);
    const gaps = blocks.flatMap((b) =>
      b.kind === 'gap' ? [[b.id, b.count, b.lines.map((l) => l.text)]] : [],
    );
    expect(gaps).toEqual([
      [1, 1, ['1']],
      [9, 1, ['9']],
      [17, 4, ['17', '18', '19', '20']],
    ]);
  });

  it('相隔正好 6 行的两处改动不折——与 git 并成一个 hunk 是同一个判据', () => {
    const before = numbered(20);
    const after = before.map((line) => (line === '5' || line === '12' ? `${line}!` : line));
    expect(
      fold(before, after, true)
        .filter((b) => b.kind === 'gap')
        .map((b) => b.id),
    ).toEqual([1, 16]);
    expect(
      fold(before, after, false)
        .filter((b) => b.kind === 'gap')
        .map((b) => b.id),
    ).toEqual([1, 16]);
  });

  it('两种补丁折出来逐段相同（随机改动；末尾那一段 3 行上下文时没有行数，只比身份）', () => {
    // 伪随机、固定种子：失败时可复现
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 200; round++) {
      const before = numbered(5 + Math.floor(random() * 60));
      const after: string[] = [];
      for (const line of before) {
        const roll = random();
        if (roll < 0.04) continue; // 删
        if (roll < 0.08)
          after.push(`${line}!`); // 改
        else after.push(line);
        if (random() < 0.03) after.push(`new ${line}`); // 插
      }
      const hunks = shapeOf(fold(before, after, false));
      const full = shapeOf(fold(before, after, true));
      const last = hunks.at(-1);
      if (last && 'gap' in last && last.count === null) {
        // 整份上下文回来后它要么有了行数，要么消失（恰好 3 行就到了末尾——「点了个空」）
        hunks.pop();
        const tail = full.at(-1);
        if (tail && 'gap' in tail && tail.gap === last.gap) full.pop();
      }
      expect(full, `round ${round}`).toEqual(hunks);
    }
  });
});
