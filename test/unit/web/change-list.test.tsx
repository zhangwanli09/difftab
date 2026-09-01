// 变更列表里冲突那一组的展示。
//
// 分组本身由 store.test.ts 的 `groupFiles` 钉住,这里钉的是**画出来的那一行**:
// 冲突条目要把 XY 两位一起印,而其余分组各印自己那一侧。少了这条,把冲突组的徽章
// 顺手换回单个 `StatusBadge` 不会让任何用例变红 —— 页面上 `DD`(双方都删)与
// `UU`(双方都改)从此长得一模一样,而它们要采取的动作完全不同。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileEntry } from '../../../src/server/shared/protocol';
import { ChangeList } from '../../../src/web/components/ChangeList';
import { diffState } from '../../../src/web/state/store';

const file = (partial: Partial<FileEntry> & { path: string }): FileEntry => ({
  kind: 'tracked',
  staged: '.',
  unstaged: '.',
  ...partial,
});

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  // signals 活在组件树之外,不清就会漏进下一个用例
  diffState.value = null;
});

/**
 * 某个分组标题下那一段的可见文本(空白归一)。匹配用 `startsWith` 而不是 `includes`:标题是
 * 「Staged」「Unstaged」这样的英文,而前者是后者的子串 —— 用 `includes` 时
 * `sectionTextOf('Staged')` 会挑到哪一段取决于 DOM 顺序。h2 的文本是「标题 + 计数」,从头比即可。
 */
function normalize(node: Element | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function sectionTextOf(title: string): string {
  return normalize(
    [...container.querySelectorAll('section')].find((node) =>
      node.querySelector('h2')?.textContent?.trim().startsWith(title),
    ),
  );
}

describe('ChangeList 的冲突组', () => {
  it('冲突行印出 XY 两位,而不是只挑一位', () => {
    render(
      <ChangeList
        files={[
          file({ path: 'both-modified.txt', staged: 'U', unstaged: 'U', conflicted: true }),
          file({ path: 'both-deleted.txt', staged: 'D', unstaged: 'D', conflicted: true }),
        ]}
      />,
      container,
    );
    const text = sectionTextOf('Conflicted');

    expect(text).toContain('UU');
    expect(text).toContain('DD');
    expect(text).toContain('both-modified.txt');
    expect(text).toContain('both-deleted.txt');
  });

  it('冲突文件不出现在已暂存 / 未暂存两组里', () => {
    // 分组判据在 `groupFiles`,这里确认它真的被用上了 —— 组件自己再挑一遍是这类回归最常见的形态
    render(
      <ChangeList
        files={[
          file({ path: 'conflict.txt', staged: 'U', unstaged: 'U', conflicted: true }),
          file({ path: 'normal.txt', staged: 'M' }),
        ]}
      />,
      container,
    );

    expect(sectionTextOf('Staged')).not.toContain('conflict.txt');
    expect(sectionTextOf('Staged')).toContain('normal.txt');
    expect(sectionTextOf('Unstaged')).toBe('');
  });
});

/**
 * 行的两段式展示。钉的是**顺序**:文件名在前、目录在后。上面那两条冲突用例比的是整段
 * textContent,顺序对调它们照样全绿 —— 少了这一条,把两段换回「目录前缀 + 文件名」连读的写法不
 * 会让任何用例变红,而那正是要防的形态(路径一长,truncate 先裁掉文件名)。
 *
 * 「窄侧栏下先裁掉的是目录」那半条这里验不了:happy-dom 没有排版引擎,归人工那档。
 */
describe('ChangeList 的行布局', () => {
  /** 某一行(整个 <button>)的可见文本,空白归一。 */
  const rowText = () => normalize(container.querySelector('button'));

  // 两条都**锚定整行**而不是 `toContain` 片段:一条正则同时钉住顺序(名在前)、目录不带尾部斜杠、
  // 两段没连读成一条完整路径。拆成两条反而更弱 —— 后者对「文件名 + 带斜杠的目录」根本判不出来
  it('文件名排在目录之前,目录不带尾部斜杠', () => {
    render(
      <ChangeList files={[file({ path: 'src/web/components/ChangeList.tsx', staged: 'M' })]} />,
      container,
    );

    expect(rowText()).toMatch(/^M\s*ChangeList\.tsx\s*src\/web\/components$/);
  });

  it('仓库根下的文件不拖一个空的路径段', () => {
    render(<ChangeList files={[file({ path: 'package.json', staged: 'M' })]} />, container);

    expect(rowText()).toMatch(/^M\s*package\.json$/);
  });

  /**
   * 这一条钉的是**树的形状**,不是版式 —— 所以 happy-dom 判得了。上面两条比的是 textContent,而
   * 把两段拆成两个平级的 flex 子项时文本一模一样,它们照样全绿;真正坏掉的是「`overflow:hidden`
   * 让每段各自成为 scroll container、基线改按边框盒合成」,页面上表现为两段没对齐。「窄侧栏下先
   * 裁掉的是目录」那半条仍归人眼,但**规则本身从此有断言看着**。
   */
  it('文件名与目录同住一个 truncate span,而不是两个平级的 flex 子项', () => {
    render(<ChangeList files={[file({ path: 'src/web/List.tsx', staged: 'M' })]} />, container);
    const row = container.querySelector('button');

    const dirSegment = [...(row?.querySelectorAll('span') ?? [])].find(
      (node) => normalize(node) === 'src/web',
    );
    expect(dirSegment).toBeDefined();

    // 目录段所在的那个截断盒必须**同时装着文件名**:拆成兄弟时 closest 会停在目录段自己身上
    const truncatingBox = dirSegment?.closest('.truncate');
    expect(normalize(truncatingBox)).toContain('List.tsx');
  });
});
