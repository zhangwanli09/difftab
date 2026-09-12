// 变更列表里冲突那一组的展示。
//
// 分组本身由 store.test.ts 的 `groupFiles` 钉住，这里钉的是**画出来的那一行**：
// 冲突条目要把 XY 两位一起印，而其余分组各印自己那一侧。少了这条，把冲突组的徽章
// 顺手换回单个 `StatusBadge` 不会让任何用例变红——页面上 `DD`（双方都删）与
// `UU`（双方都改）从此长得一模一样，而它们要采取的动作完全不同。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeList } from '../../../src/web/components/ChangeList';
import { changeView, collapsedChangeDirs } from '../../../src/web/state/change-tree';
import { activeEditorKey, editors } from '../../../src/web/state/editors';
import { file, openPinned, resetEditors, waitFor } from './helpers';

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  // signals 活在组件树之外，不清就会漏进下一个用例
  resetEditors();
  changeView.value = 'list';
  collapsedChangeDirs.value = new Set();
});

/**
 * 某个分组标题下那一段的可见文本（空白归一）。匹配用 `startsWith` 而不是 `includes`：标题是
 * 「Staged」「Unstaged」这样的英文，而前者是后者的子串——用 `includes` 时
 * `sectionTextOf('Staged')` 会挑到哪一段取决于 DOM 顺序。h2 的文本是「标题 + 计数」，从头比即可。
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
  it('冲突行印出 XY 两位，而不是只挑一位', () => {
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
    // 分组判据在 `groupFiles`，这里确认它真的被用上了——组件自己再挑一遍是这类回归最常见的形态
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
 * 行的两段式展示。钉的是**顺序**：文件名在前、目录在后、状态位在行尾。上面那两条冲突用例比的
 * 是整段 textContent，顺序对调它们照样全绿——少了这一条，把两段换回「目录前缀 + 文件名」连读的
 * 写法、或把状态位挪回行首，都不会让任何用例变红，而前者正是要防的形态（路径一长，truncate 先
 * 裁掉文件名）。
 *
 * 「窄侧栏下先裁掉的是目录」那半条这里验不了：happy-dom 没有排版引擎，归人工那档。
 */
describe('ChangeList 的行布局', () => {
  /** 某一行（整个 <button>）的可见文本，空白归一。 */
  const rowText = () => normalize(container.querySelector('button'));

  // 两条都**锚定整行**而不是 `toContain` 片段：一条正则同时钉住顺序（名在前、状态位在尾）、目录
  // 不带尾部斜杠、两段没连读成一条完整路径。拆成两条反而更弱——后者对「文件名 + 带斜杠的目录」根本判不出来
  it('工作区干净时那句居中，且撑满列表区', () => {
    render(<ChangeList files={[]} />, container);

    const empty = container.firstElementChild;
    expect(empty?.textContent).toBe('No changes.');
    // happy-dom 没有排版引擎，能钉的只有类名（撑满为什么是前提在 EmptyState.tsx）
    for (const cls of ['h-full', 'items-center', 'justify-center']) {
      expect(empty?.classList.contains(cls)).toBe(true);
    }
  });

  it('文件名排在目录之前、状态位在行尾，目录不带尾部斜杠', () => {
    render(
      <ChangeList files={[file({ path: 'src/web/components/ChangeList.tsx', staged: 'M' })]} />,
      container,
    );

    expect(rowText()).toMatch(/^ChangeList\.tsx\s*src\/web\/components\s*M$/);
  });

  it('仓库根下的文件不拖一个空的路径段', () => {
    render(<ChangeList files={[file({ path: 'package.json', staged: 'M' })]} />, container);

    expect(rowText()).toMatch(/^package\.json\s*M$/);
  });

  /**
   * 这一条钉的是**树的形状**，不是版式——所以 happy-dom 判得了。上面两条比的是 textContent，而
   * 把两段拆成两个平级的 flex 子项时文本一模一样，它们照样全绿；真正坏掉的是「`overflow:hidden`
   * 让每段各自成为 scroll container、基线改按边框盒合成」，页面上表现为两段没对齐。「窄侧栏下先
   * 裁掉的是目录」那半条仍归人眼，但**规则本身从此有断言看着**。
   */
  it('文件名与目录同住一个 truncate span，而不是两个平级的 flex 子项', () => {
    render(<ChangeList files={[file({ path: 'src/web/List.tsx', staged: 'M' })]} />, container);
    const row = container.querySelector('button');

    const dirSegment = [...(row?.querySelectorAll('span') ?? [])].find(
      (node) => normalize(node) === 'src/web',
    );
    expect(dirSegment).toBeDefined();

    // 目录段所在的那个截断盒必须**同时装着文件名**：拆成兄弟时 closest 会停在目录段自己身上
    const truncatingBox = dirSegment?.closest('.truncate');
    expect(normalize(truncatingBox)).toContain('List.tsx');
  });
});

/**
 * 树视图。钉的都是「不报错、只是不对」：文件行在树里仍画目录段（同一段路径在祖先节点与文件
 * 行上各说一遍）、文件行与同层目录行缩进不齐、折 Staged 里的目录连带折掉 Unstaged 里的、
 * 切到树之后组头没了（分组是 git 语义，不是列表版式的附属）。
 */
describe('ChangeList 的树视图', () => {
  const rows = () => [...container.querySelectorAll('button')];
  const rowByTitle = (title: string) => rows().find((row) => row.title === title);
  // signals 驱动的重渲染是异步的，点完要等一拍
  const waitFor = (assert: () => void) => vi.waitFor(assert, { interval: 5 });

  it('目录行带 aria-expanded、默认展开，其下文件行只画名字与行尾状态位、不画目录段', () => {
    changeView.value = 'tree';
    render(
      <ChangeList files={[file({ path: 'src/web/components/ChangeList.tsx', staged: 'M' })]} />,
      container,
    );

    const dir = rowByTitle('src/web/components');
    expect(dir?.getAttribute('aria-expanded')).toBe('true');
    // 单子目录链合并成一个节点，名字连读
    expect(normalize(dir)).toBe('src/web/components');
    expect(normalize(rowByTitle('src/web/components/ChangeList.tsx'))).toMatch(
      /^ChangeList\.tsx\s*M$/,
    );
  });

  it('文件行按层级缩进，与同层目录行同一个左内边距', () => {
    changeView.value = 'tree';
    render(
      <ChangeList
        files={[
          file({ path: 'src/a.ts', staged: 'M' }),
          file({ path: 'src/web/b.ts', staged: 'M' }),
        ]}
      />,
      container,
    );

    // `src` 在第 0 层、它底下的 `web` 与 `a.ts` 同在第 1 层、`b.ts` 在第 2 层
    expect(rowByTitle('src')?.style.paddingLeft).toBe('12px');
    expect(rowByTitle('src/web')?.style.paddingLeft).toBe('24px');
    expect(rowByTitle('src/a.ts')?.style.paddingLeft).toBe('24px');
    expect(rowByTitle('src/web/b.ts')?.style.paddingLeft).toBe('36px');
  });

  it('点目录行把它底下的行折起来，再点展开', async () => {
    changeView.value = 'tree';
    render(<ChangeList files={[file({ path: 'src/a.ts', staged: 'M' })]} />, container);

    rowByTitle('src')?.click();
    await waitFor(() => expect(rowByTitle('src')?.getAttribute('aria-expanded')).toBe('false'));
    expect(rowByTitle('src/a.ts')).toBeUndefined();

    rowByTitle('src')?.click();
    await waitFor(() => expect(rowByTitle('src/a.ts')).toBeDefined());
  });

  it('同一目录在 Staged 与 Unstaged 里各折各的', async () => {
    changeView.value = 'tree';
    // X=M Y=M：同一个文件同时落在两组
    render(
      <ChangeList files={[file({ path: 'src/a.ts', staged: 'M', unstaged: 'M' })]} />,
      container,
    );

    const dirs = rows().filter((row) => row.title === 'src');
    expect(dirs).toHaveLength(2);
    dirs[0]?.click();
    await waitFor(() => expect(dirs[0]?.getAttribute('aria-expanded')).toBe('false'));
    expect(dirs[1]?.getAttribute('aria-expanded')).toBe('true');
  });

  it('组头两种版式都留着——分组是 git 语义，树只是组内的排法', () => {
    changeView.value = 'tree';
    render(
      <ChangeList
        files={[file({ path: 'src/a.ts', staged: 'M' }), file({ path: 'src/b.ts', unstaged: 'M' })]}
      />,
      container,
    );
    expect(sectionTextOf('Staged')).toContain('a.ts');
    expect(sectionTextOf('Unstaged')).toContain('b.ts');
  });

  it('列表版式下没有目录行', () => {
    render(<ChangeList files={[file({ path: 'src/a.ts', staged: 'M' })]} />, container);
    expect(rowByTitle('src')).toBeUndefined();
    expect(rows()).toHaveLength(1);
  });
});

/**
 * 选中态与标签栏的接线。钉的是「不报错、只是不对」：高亮只认活动的 **diff** tab——同一路径的
 * file tab 活动时这一行不亮（那一行说的是这份补丁，而此刻在读的是全文）；单击开预览、双击固定。
 */
describe('ChangeList 的选中态', () => {
  const rows = () => [...container.querySelectorAll('button')];
  const rowByTitle = (title: string) => rows().find((row) => row.title === title);
  const SELECTED = 'bg-list-active-selection-background';

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"kind":"binary"}', { status: 200 })),
    );
  });

  it('高亮跟着活动的 diff tab 走；同一路径的 file tab 不算', async () => {
    render(<ChangeList files={[file({ path: 'a.ts', staged: 'M' })]} />, container);
    expect(rowByTitle('a.ts')?.className).not.toContain(SELECTED);

    openPinned('file', 'a.ts');
    await waitFor(() => expect(activeEditorKey.value).toBe('file:a.ts'));
    expect(rowByTitle('a.ts')?.className).not.toContain(SELECTED);

    openPinned('diff', 'a.ts');
    await waitFor(() => expect(rowByTitle('a.ts')?.className).toContain(SELECTED));
  });

  it('单击开一个预览 tab，双击把它固定——且双击那一下不再取第三趟', async () => {
    render(<ChangeList files={[file({ path: 'a.ts', staged: 'M' })]} />, container);
    const row = rowByTitle('a.ts');
    row?.click();
    expect(editors.value).toEqual([{ kind: 'diff', path: 'a.ts', pinned: false }]);

    // 浏览器的一次双击：click、click、dblclick。前两个各取一趟，dblclick 只置 pinned
    row?.click();
    row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(editors.value).toEqual([{ kind: 'diff', path: 'a.ts', pinned: true }]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(row?.className).toContain(SELECTED));
  });
});
