// 变更列表里冲突那一组的展示(spec §5.3 / §6 的 `[S4b]`)。
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
  // signals 活在组件树之外(§5.4),不清就会漏进下一个用例
  diffState.value = null;
});

/**
 * 某个分组标题下那一段的可见文本(空白归一)。
 *
 * 匹配用 `startsWith` 而不是 `includes`:标题是「Staged」「Unstaged」这样的英文
 * (§5.4),而前者是后者的子串 —— 用 `includes` 时 `sectionTextOf('Staged')` 会挑到
 * 哪一段取决于 DOM 顺序,而那个顺序归 `groupFiles`。h2 的文本是「标题 + 计数」,
 * 从头比即可。
 */
function sectionTextOf(title: string): string {
  const section = [...container.querySelectorAll('section')].find((node) =>
    node.querySelector('h2')?.textContent?.trim().startsWith(title),
  );
  return (section?.textContent ?? '').replace(/\s+/g, ' ').trim();
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
    // 分组判据在 `groupFiles`,这里确认它真的被用上了 —— 组件自己再挑一遍文件
    // (`files.filter(…)`)是这类回归最常见的形态
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
