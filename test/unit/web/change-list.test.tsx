// 变更列表里冲突那一组的展示。
//
// 分组本身由 store.test.ts 的 `groupFiles` 钉住，这里钉的是**画出来的那一行**：
// 冲突条目要把 XY 两位一起印，而其余分组各印自己那一侧。少了这条，把冲突组的徽章
// 顺手换回单个 `StatusBadge` 不会让任何用例变红——页面上 `DD`（双方都删）与
// `UU`（双方都改）从此长得一模一样，而它们要采取的动作完全不同。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeList } from '../../../src/web/components/ChangeList';
import { ROW_BASE, ROW_GROUP } from '../../../src/web/components/tree-row';
import { changeView, collapsedChangeDirs } from '../../../src/web/state/change-tree';
import { editors } from '../../../src/web/state/editors';
import {
  actionOf,
  file,
  groupOf,
  openPinned,
  resetEditors,
  spacerIn,
  stubClipboard,
  stubJson,
  waitFor,
} from './helpers';

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
  vi.restoreAllMocks();
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

/**
 * 列表里的**行**按钮（文件行与目录行）。行内动作那两枚也是 `<button>`，但它们带 `aria-label`（只画
 * 图标的按钮名字只能由它给），行按钮的名字来自可见文本、没有——按这一条把两种按钮分开，而不是
 * 按 DOM 位置数。
 */
const ROW_SELECTOR = 'button:not([aria-label])';
const rowButtons = () => [...container.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR)];
/** 按整行的 `title`（完整路径）挑一行；目录行的 `title` 是合并后的目录路径。 */
const rowByTitle = (title: string) => rowButtons().find((row) => row.title === title);

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
  const rowText = () => normalize(container.querySelector(ROW_SELECTOR));

  // 两条都**锚定整行**而不是 `toContain` 片段：一条正则同时钉住顺序（名在前、状态位在尾）、目录
  // 不带尾部斜杠、两段没连读成一条完整路径。拆成两条反而更弱——后者对「文件名 + 带斜杠的目录」根本判不出来
  it('工作区干净时那句居中，且撑满列表区', () => {
    render(<ChangeList files={[]} />, container);

    const empty = container.firstElementChild;
    expect(empty?.textContent).toBe('No changes');
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
    const row = container.querySelector(ROW_SELECTOR);

    const dirSegment = [...(row?.querySelectorAll('span') ?? [])].find(
      (node) => normalize(node) === 'src/web',
    );
    expect(dirSegment).toBeDefined();

    // 目录段所在的那个截断盒必须**同时装着文件名**：拆成兄弟时 closest 会停在目录段自己身上
    const truncatingBox = dirSegment?.closest('.truncate');
    expect(normalize(truncatingBox)).toContain('List.tsx');
  });

  // 行的骨架（间距、焦点环）与 `Files` 那档共用 `tree-row.tsx` 那一份：各写一份时漂开不报错，只是
  // 切一次 tab 三角间距跳一截。happy-dom 没有排版引擎，能钉的只有类名。树视图一次画出目录行与文件
  // 行两种，平铺版式的文件行与树里的是同一个 `ROW_CLASS`，不必再渲染一遍
  it('目录行与文件行都取 tree-row 那份 ROW_BASE——各写一份时切 tab 会跳', () => {
    changeView.value = 'tree';
    render(<ChangeList files={[file({ path: 'src/a.ts', staged: 'M' })]} />, container);
    const rows = rowButtons();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.className).toContain(ROW_BASE);
  });
});

/**
 * 树视图。钉的都是「不报错、只是不对」：文件行在树里仍画目录段（同一段路径在祖先节点与文件
 * 行上各说一遍）、文件行与同层目录行缩进不齐、折 Staged 里的目录连带折掉 Unstaged 里的、
 * 切到树之后组头没了（分组是 git 语义，不是列表版式的附属）。
 */
describe('ChangeList 的树视图', () => {
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

    const dirs = rowButtons().filter((row) => row.title === 'src');
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
    expect(rowButtons()).toHaveLength(1);
  });
});

/**
 * 选中态与标签栏的接线。钉的是「不报错、只是不对」：高亮按活动 tab 的**路径**判、不看种类——
 * 同一路径的 file tab 活动时这一行也亮（点了行内 `Open file` 之后那一行不能熄）；单击开预览、
 * 双击固定。
 */
describe('ChangeList 的选中态', () => {
  const SELECTED = 'bg-list-active-selection-background';

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"kind":"binary"}', { status: 200 })),
    );
  });

  it('高亮跟着活动 tab 的路径走，diff 与 file tab 都算；别的路径活动时不亮', async () => {
    render(
      <ChangeList
        files={[file({ path: 'a.ts', staged: 'M' }), file({ path: 'b.ts', staged: 'M' })]}
      />,
      container,
    );
    expect(rowByTitle('a.ts')?.className).not.toContain(SELECTED);

    openPinned('file', 'a.ts');
    await waitFor(() => expect(rowByTitle('a.ts')?.className).toContain(SELECTED));
    expect(rowByTitle('b.ts')?.className).not.toContain(SELECTED);

    openPinned('diff', 'b.ts');
    await waitFor(() => expect(rowByTitle('b.ts')?.className).toContain(SELECTED));
    expect(rowByTitle('a.ts')?.className).not.toContain(SELECTED);
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

/**
 * 每行悬停露出的 `Open file`（照 VS Code Source Control 的 inline action）。钉的都是「不报错、只是
 * 不对」：按钮套进行按钮里（按钮里套按钮，点它顺带开一个 diff tab）；占位与按钮外壳的显隐变体漂开
 * （文字被挤开了而按钮没出来）；行底色用 `hover:`（指针移到按钮上那一刻行底色消失）；已删除的文件
 * 也画（点了只有一条错误）。happy-dom 没有排版引擎，能钉的只有树形与类名。
 */
describe('ChangeList 的 Open file 行内动作', () => {
  const openButtons = () => [
    ...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Open file"]'),
  ];
  const openButtonOf = (path: string) => actionOf(rowByTitle(path), 'Open file');

  it('按钮是行按钮的兄弟、同住一个 group div，不套在行按钮里；group 不是 <li>', () => {
    render(<ChangeList files={[file({ path: 'src/a.ts', staged: 'M' })]} />, container);
    const row = rowByTitle('src/a.ts');
    const button = openButtonOf('src/a.ts');

    expect(button?.title).toBe('Open file');
    expect(row?.contains(button ?? null)).toBe(false);
    expect(groupOf(row)?.classList.contains('group')).toBe(true);
    expect(groupOf(row)?.tagName).toBe('DIV');
    expect(row?.closest('li')?.classList.contains('group')).toBe(false);
  });

  it('点它开一个**固定**的 file tab 并取全文，不顶掉现有预览、也不顺带开 diff tab', async () => {
    const calls = stubJson({ kind: 'text', content: '' });
    render(
      <ChangeList
        files={[file({ path: 'src/a.ts', staged: 'M' }), file({ path: 'src/b.ts', staged: 'M' })]}
      />,
      container,
    );
    // 先单击一行开一个预览 diff tab：照 VS Code `git.openFile` 的 `preview: false`，Open file
    // 追加一个固定 tab、这个预览留在原地
    rowByTitle('src/b.ts')?.click();

    openButtonOf('src/a.ts')?.click();
    expect(editors.value).toEqual([
      { kind: 'diff', path: 'src/b.ts', pinned: false },
      { kind: 'file', path: 'src/a.ts', pinned: true },
    ]);
    await waitFor(() => expect(calls).toContain('/api/file?path=src%2Fa.ts'));
  });

  it('占位与按钮外壳共用同一对显隐变体，悬停底色在 group div 上而不在行按钮上', () => {
    render(<ChangeList files={[file({ path: 'src/a.ts', staged: 'M' })]} />, container);
    const row = rowByTitle('src/a.ts');
    const shell = openButtonOf('src/a.ts')?.parentElement;
    const spacer = spacerIn(row);

    // 键盘那半条钉的是 `has-focus-visible` 不是 `focus-within`：后者在鼠标点过按钮之后一直成立，
    // 鼠标移开按钮还钉在行上
    for (const node of [shell, spacer]) {
      expect(node).toBeDefined();
      for (const cls of [
        'hidden',
        'group-hover:flex',
        'group-has-focus-visible:flex',
        'pointer-coarse:flex',
      ]) {
        expect(node?.classList.contains(cls)).toBe(true);
      }
    }
    // 底色挂在行按钮上时，指针移到按钮上那一刻行底色就消失
    expect(groupOf(row)?.className).toBe(ROW_GROUP);
    expect(ROW_GROUP).toContain('hover:bg-list-hover-background');
    expect(row?.className).not.toContain('bg-list-hover-background');
  });

  it('工作区里已不存在的文件不画；冲突里只有 DD 算不存在', () => {
    render(
      <ChangeList
        files={[
          file({ path: 'wt-deleted.ts', unstaged: 'D' }),
          file({ path: 'rm.ts', staged: 'D' }),
          file({ path: 'added-then-deleted.ts', staged: 'A', unstaged: 'D' }),
          file({ path: 'both-deleted.ts', staged: 'D', unstaged: 'D', conflicted: true }),
          file({ path: 'deleted-by-them.ts', staged: 'U', unstaged: 'D', conflicted: true }),
          file({ path: 'deleted-by-us.ts', staged: 'D', unstaged: 'U', conflicted: true }),
          file({ path: 'modified.ts', unstaged: 'M' }),
          file({ path: 'renamed.ts', staged: 'R', oldPath: 'old.ts' }),
          file({ path: 'new.ts', kind: 'untracked', unstaged: '?' }),
        ]}
      />,
      container,
    );

    for (const path of ['wt-deleted.ts', 'rm.ts', 'added-then-deleted.ts', 'both-deleted.ts']) {
      expect(openButtonOf(path), path).toBeNull();
    }
    for (const path of [
      'deleted-by-them.ts',
      'deleted-by-us.ts',
      'modified.ts',
      'renamed.ts',
      'new.ts',
    ]) {
      expect(openButtonOf(path), path).not.toBeNull();
    }
  });

  it('树视图下的文件行同样有这枚按钮，目录行没有', () => {
    changeView.value = 'tree';
    render(<ChangeList files={[file({ path: 'src/a.ts', staged: 'M' })]} />, container);

    expect(openButtonOf('src/a.ts')).not.toBeNull();
    expect(openButtons()).toHaveLength(1);
  });
});

/**
 * 每行悬停露出的另一枚 `Copy path`。钉的同样是「不报错、只是不对」：两枚各起一个外壳（位置各算
 * 各的）；占位的宽度与真画的枚数不一致（省略号多退或少退 20px）；已删除的行漏掉它（那正是要贴给
 * `git checkout --` 的路径）；复制成功没有反馈、或反馈永远不复原；写失败时换了图标（用户以为复制
 * 成了）。
 */
describe('ChangeList 的 Copy path 行内动作', () => {
  const copyButtons = () => [
    ...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy path"]'),
  ];
  const copyButtonOf = (path: string) => actionOf(rowByTitle(path), 'Copy path');
  const openButtonOf = (path: string) => actionOf(rowByTitle(path), 'Open file');

  afterEach(() => {
    vi.useRealTimers();
  });

  it('与 Open file 同住一个外壳、排在它左边；占位两枚宽', () => {
    render(<ChangeList files={[file({ path: 'src/a.ts', staged: 'M' })]} />, container);
    const copy = copyButtonOf('src/a.ts');
    const open = openButtonOf('src/a.ts');

    expect(copy?.title).toBe('Copy path');
    expect(copy?.parentElement).toBe(open?.parentElement);
    expect(copy?.nextElementSibling).toBe(open);
    expect(spacerIn(rowByTitle('src/a.ts'))?.classList.contains('w-10')).toBe(true);
  });

  it('已删除的行照画，此时只有它一枚、占位一枚宽', () => {
    render(<ChangeList files={[file({ path: 'rm.ts', staged: 'D' })]} />, container);

    expect(copyButtonOf('rm.ts')).not.toBeNull();
    expect(openButtonOf('rm.ts')).toBeNull();
    expect(spacerIn(rowByTitle('rm.ts'))?.classList.contains('w-5')).toBe(true);
  });

  it('点它把仓库相对路径写进剪贴板，不开 tab；图标短暂换成 Copied 再复原', async () => {
    vi.useFakeTimers();
    const writeText = stubClipboard();
    render(<ChangeList files={[file({ path: 'src/a.ts', staged: 'M' })]} />, container);

    copyButtonOf('src/a.ts')?.click();
    expect(writeText).toHaveBeenCalledWith('src/a.ts');
    expect(editors.value).toEqual([]);
    // 反馈等 writeText 的 promise 落定才画
    await vi.advanceTimersByTimeAsync(0);
    const button = actionOf(rowByTitle('src/a.ts'), 'Copied');
    expect(button?.getAttribute('aria-label')).toBe('Copied');
    expect(button?.getAttribute('title')).toBe('Copied');

    await vi.advanceTimersByTimeAsync(1500);
    expect(button?.getAttribute('aria-label')).toBe('Copy path');
  });

  it('写失败时静默，不换成 Copied', async () => {
    vi.useFakeTimers();
    stubClipboard(new Error('denied'));
    render(<ChangeList files={[file({ path: 'src/a.ts', staged: 'M' })]} />, container);

    copyButtonOf('src/a.ts')?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(copyButtonOf('src/a.ts')).not.toBeNull();
  });

  it('树视图下文件行与目录行都有；目录行复制合并节点的链尾路径，且它的 group 不含子层', () => {
    changeView.value = 'tree';
    const writeText = stubClipboard();
    render(<ChangeList files={[file({ path: 'src/web/a.ts', staged: 'M' })]} />, container);
    const dirRow = rowByTitle('src/web');

    expect(copyButtonOf('src/web/a.ts')).not.toBeNull();
    expect(copyButtons()).toHaveLength(2);
    // 目录行的 group 里只有它自己那一行：子层 `<ul>` 在外面，悬停后代不会把它一起点亮
    expect(groupOf(dirRow)?.contains(rowByTitle('src/web/a.ts') ?? null)).toBe(false);
    expect(groupOf(dirRow)?.className).toBe(ROW_GROUP);

    copyButtonOf('src/web')?.click();
    expect(writeText).toHaveBeenCalledWith('src/web');
    expect(editors.value).toEqual([]);
  });
});
