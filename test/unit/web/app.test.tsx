// 顶栏那一行字，以及它右端那个明暗开关。
//
// 钉的是**顶栏写的是项目名而不是产品名**：改回产品名不会让任何别的用例变红，而页面上
// 一排标签里的每个 difftab 实例从此长得一模一样——这一栏存在的理由正是分辨「我在看
// 哪个项目」。兜底那半条同理：退回 `PRODUCT_NAME` 与「编一个占位名出来」在类型上没差别。
//
// 顶栏变成 flex 容器之后还多钉一条**树的形状**：`truncate` 必须落在装名字的那个 span 上。
// 留在 header 上不报错、类名也还在原地，只是不起作用（子项的自动最小尺寸照样撑开它），
// 而症状是长目录名重新漫过右边框——与 change-list 那条「同住一个 truncate span」同理，
// 能自动化的是形状，「谁先被裁」归肉眼。

import { render } from 'preact';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoState } from '../../../src/server/shared/protocol';
import { App } from '../../../src/web/components/App';
import { TREE_SCOPE } from '../../../src/web/components/tree-row';
import { changeView } from '../../../src/web/state/change-tree';
import {
  activeEditorKey,
  activeGroup,
  draggingEditor,
  editors,
  focusEditor,
  groups,
} from '../../../src/web/state/editors';
import { changesCollapsed, splitPercent } from '../../../src/web/state/sidebar';
import {
  activeTab,
  diffStates,
  fileStates,
  PATCH_DEFAULTS,
  repoState,
} from '../../../src/web/state/store';
import { PRODUCT_NAME } from '../../../src/web/state/title';
import { expandedDirs, ROOT, treeCache, treeErrors } from '../../../src/web/state/tree';
import { hideHistory, openPinned, press, resetChangeTree, resetEditors, waitFor } from './helpers';

const stateWith = (repoName: string): RepoState => ({
  repoName,
  branch: { head: 'main', detached: false, upstream: null },
  files: [],
  watch: { mode: 'native', tier: 'A' },
});

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  // 默认可见的 `History` 分区一挂载就要取提交列表；测分区的那一组自己展开它
  hideHistory();
  // `Files` 那一档挂载时会去取根那一层——用例里不需要真发请求
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
});

afterEach(() => {
  render(null, container);
  // signals 活在组件树之外，不清就会漏进下一个用例
  repoState.value = null;
  resetEditors();
  activeTab.value = 'changes';
  resetChangeTree();
  treeCache.value = new Map();
  treeErrors.value = new Map();
  expandedDirs.value = new Set();
  vi.unstubAllGlobals();
});

const header = () => container.querySelector('header');
const headerText = () => header()?.textContent?.trim();
const section = () => container.querySelector('section');
/** 右侧面板里的第一组编辑器（只有一组时就是它）。 */
const group = () => section()?.firstElementChild;

/** 开一个 diff tab 并把它的缓存写成一份 binary——右侧因此画得出 `Binary file` 那句。 */
function openBinaryDiff(path: string): void {
  openPinned('diff', path);
  diffStates.value = new Map([
    [path, { status: 'ready', rename: null, payload: { kind: 'binary' }, options: PATCH_DEFAULTS }],
  ]);
}

describe('左栏顶栏', () => {
  it('写的是项目名——不是产品名', () => {
    repoState.value = stateWith('my-app');
    render(<App />, container);
    expect(headerText()).toBe('my-app');
  });

  it('第一份 state 还没到时退回产品名——顶栏不空着一条边框', () => {
    render(<App />, container);
    expect(headerText()).toBe(PRODUCT_NAME);
  });

  it('根目录没有 basename 时同样退回产品名——不编一个占位名出来', () => {
    // 空串的含义见 protocol.ts:`/`、Windows 盘符根。与「还没到」合成同一种情况
    repoState.value = stateWith('');
    render(<App />, container);
    expect(headerText()).toBe(PRODUCT_NAME);
  });
});

describe('顶栏的形状', () => {
  it('项目名住在自己的 truncate span 里——truncate 挂在 flex 容器上是不起作用的', () => {
    repoState.value = stateWith('a-very-long-project-directory-name');
    render(<App />, container);

    const truncating = header()?.querySelector('.truncate');
    expect(truncating?.textContent).toBe('a-very-long-project-directory-name');
    // 反过来钉一次：header 自己不再是那个截断盒
    expect(header()?.classList.contains('truncate')).toBe(false);
  });

  it('右端是 Go to File 与主题开关两枚按钮，各带无障碍名', () => {
    repoState.value = stateWith('my-app');
    render(<App />, container);

    const buttons = [...(header()?.querySelectorAll('button') ?? [])];
    // 只画图标，名字只能由 aria-label 给——掉了它这个按钮在读屏里就是一个无名控件
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Go to File',
      'Follow system',
    ]);
  });

  it('第一份 state 还没到时两枚按钮也在——它们不依赖仓库状态', () => {
    render(<App />, container);
    expect(header()?.querySelectorAll('button')).toHaveLength(2);
  });
});

// 只画图标，于是 textContent 是空的——名字只能从 aria-label 上找
const tabOf = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('[role="tab"]')].find(
    (node) => node.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`没有画出 ${label} 这个 tab`);
  return found as HTMLButtonElement;
};

describe('侧栏那三个 tab', () => {
  it('只画图标，名字由 aria-label 给——掉了它这几个就是无名控件，而页面上看不出来', () => {
    render(<App />, container);
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Changes',
      'Files',
      'Search',
    ]);
    // 名字不在文本里、图标真的画出来了：两条一起才说明「换成图标」这件事成立
    expect(tabs.map((tab) => tab.textContent)).toEqual(['', '', '']);
    expect(tabs.every((tab) => tab.querySelector('svg') !== null)).toBe(true);
  });

  it('默认停在 Changes 上——工具存在的理由仍是「瞥一眼改了什么」', () => {
    render(<App />, container);
    expect(tabOf('Changes').getAttribute('aria-selected')).toBe('true');
    expect(tabOf('Files').getAttribute('aria-selected')).toBe('false');
  });

  // 行高在 `<nav>` 一处给、底下全靠继承：这一条掉了不报错，只是每一行缩回 20px、`Files` 那档的
  // 占位与 `Changes` 的行不再等高。happy-dom 没有排版引擎，能钉的只有类名
  it('列表区那一层带 text-sm/6——行高是容器的属性，不是每行各抄一遍', () => {
    repoState.value = stateWith('demo');
    render(<App />, container);
    expect(container.querySelector('nav')?.classList.contains('text-sm/6')).toBe(true);
  });

  // 缩进引导线的悬停作用域挂在列表区 `<nav>` 上：这一条掉了不报错，只是两棵树的线永远不显形
  it('列表区那一层带 TREE_SCOPE——引导线的悬停作用域', () => {
    repoState.value = stateWith('demo');
    render(<App />, container);
    expect(container.querySelector('nav')?.classList.contains(TREE_SCOPE)).toBe(true);
  });

  it('切到 Files 换的是左栏列什么', async () => {
    repoState.value = stateWith('demo');
    render(<App />, container);
    // Changes 档是上下两块（变更列表 + 提交历史）
    expect(container.querySelector('nav')?.textContent).toContain('History');

    tabOf('Files').click();
    // 树那一档还没取到第一层，画的是 Loading…
    await waitFor(() => expect(tabOf('Files').getAttribute('aria-selected')).toBe('true'));
    expect(container.querySelector('nav')?.textContent).toBe('Loading…');
  });

  it('**切 tab 不动右侧面板**——每瞄一眼目录树就丢掉正在读的 diff 是不能接受的', async () => {
    openBinaryDiff('src/app.ts');
    render(<App />, container);
    expect(section()?.textContent).toContain('Binary file');

    tabOf('Files').click();
    await waitFor(() => expect(tabOf('Files').getAttribute('aria-selected')).toBe('true'));
    expect(activeEditorKey.value).toBe('diff:src/app.ts');
    expect(section()?.textContent).toContain('Binary file');
  });

  it('右侧画哪一个由活动 tab 的 kind 定，与停在哪个侧栏 tab 上无关', async () => {
    openPinned('file', 'a.ts');
    fileStates.value = new Map([['a.ts', { status: 'ready', payload: { kind: 'binary' } }]]);
    render(<App />, container);
    // 侧栏还停在 Changes 上，右边已经是文件视图了——两者本就不是一回事
    await waitFor(() =>
      expect(section()?.textContent).toContain('Binary file — contents are not shown.'),
    );
    expect(tabOf('Changes').getAttribute('aria-selected')).toBe('true');
  });

  it('切回 Files 时把树刷一遍——不看那一档时 SSE 不重取它，回来就得补上', async () => {
    const fetchMock = vi.fn((_url: string) => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    // 已经取过根那一层：那个 effect 里的「取过就不再取」把取根那一趟挡掉，真去发的只能是 refreshTree
    treeCache.value = new Map([[ROOT, []]]);
    render(<App />, container);

    tabOf('Files').click();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/tree');
  });

  it('切到 Files 时取根那一趟与刷新那一趟不重复发', async () => {
    const fetchMock = vi.fn((_url: string) => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    // 根已经取过：这一趟该由 refreshTree 发。`loadDir` 自己不看缓存（展开与刷新要的都是新的
    // 那一份），少了这个 effect 里那道「取过就不再取」，切一次 tab 就是两趟 ls-files×3
    treeCache.value = new Map([[ROOT, []]]);
    render(<App />, container);

    tabOf('Files').click();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/tree')),
    ).toHaveLength(1);
  });

  it('切到 Files 那一刻按活动 tab 的路径把祖先展开——树不可见时不跟随，切过来补上', async () => {
    render(<App />, container);
    openPinned('diff', 'src/web/a.ts');
    // 还在 Changes 档：树没挂载，一趟 ls-files 都不发、侧栏也不自己切档
    expect(expandedDirs.value.size).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(tabOf('Changes').getAttribute('aria-selected')).toBe('true');

    // 切过来才展开；各取一趟的账在 file-tree.test.tsx 里算——这里的 fetch 永不回来，前面几个
    // 用例留下的在途票会把同一条路径的请求吞掉，按请求数断言会随用例顺序变
    tabOf('Files').click();
    await waitFor(() => expect(expandedDirs.value).toEqual(new Set(['src', 'src/web'])));
  });

  it('状态条在两个 tab 下都留着——它说的是仓库怎么样，与左栏列什么无关', async () => {
    repoState.value = stateWith('demo');
    render(<App />, container);
    expect(container.querySelector('footer')?.textContent).toContain('main');

    tabOf('Files').click();
    await waitFor(() => expect(tabOf('Files').getAttribute('aria-selected')).toBe('true'));
    expect(container.querySelector('footer')?.textContent).toContain('main');
  });
});

// tab 行右端那枚「全部折叠」。五条钉的都是「不报错、只是不对」：`Changes` 档下
// 多出一枚点了没反应的按钮、读屏把它报成第三个 tab、它被塞回滚动容器里跟着树滚走（那时按钮还
// 在，只是往下翻两屏就找不着了）、两枚 IconButton 的图标没落在同一条竖线上，以及只画图标时
// 掉了 `aria-label` 就是个无名控件。
describe('tab 行右端那枚「全部折叠」', () => {
  const collapseButton = () => container.querySelector('[aria-label="Collapse all"]');
  const tabList = () => container.querySelector('[role="tablist"]');

  /** 画出来、切到 `Files`、等按钮出现。 */
  const openFilesTab = async () => {
    render(<App />, container);
    tabOf('Files').click();
    await waitFor(() => expect(collapseButton()).not.toBeNull());
  };

  it('只在 Files 那一档画——Changes 档下它一个动作都放不了', async () => {
    render(<App />, container);
    expect(collapseButton()).toBeNull();

    tabOf('Files').click();
    await waitFor(() => expect(collapseButton()).not.toBeNull());
  });

  it('只画图标，名字由 aria-label 给——掉了它这就是一个无名控件，而页面上看不出来', async () => {
    await openFilesTab();
    expect((collapseButton() as HTMLButtonElement).title).toBe('Collapse all');
    expect(collapseButton()?.textContent).toBe('');
    expect(collapseButton()?.querySelector('svg')).not.toBeNull();
  });

  it('站在 tab 行里，但在 tablist 之外——躺进去读屏会把它报成第三个 tab', async () => {
    await openFilesTab();
    expect(tabList()?.contains(collapseButton())).toBe(false);
    // 后一条钉的是「确实在那一行里」：少了它，按钮被挪回下面另起的一条栏时前一条照样绿
    expect(tabList()?.parentElement?.contains(collapseButton())).toBe(true);
  });

  it('右内边距与顶栏同一档——两枚都是 IconButton，于是图标落在同一条竖线上', async () => {
    await openFilesTab();
    // 这一行只能给 pr-3 不能给 px-3：tab 得贴着左边缘起排，而要对齐的只有右边那 12px。
    // 按钮自身的内边距不必再钉：两处走的是同一个组件，构造上就相等
    expect(header()?.className).toContain('px-3');
    expect(collapseButton()?.parentElement?.className).toContain('pr-3');
  });

  it('通栏那条线是行的 divider-b，tab 不 -mb-px——与右侧编辑器标签栏同一套压线机制', async () => {
    await openFilesTab();
    const row = collapseButton()?.parentElement;
    expect(row?.classList.contains('divider-b')).toBe(true);
    expect(row?.classList.contains('border-b')).toBe(false);
    for (const tab of tabList()?.querySelectorAll('[role="tab"]') ?? []) {
      expect(tab.classList.contains('border-b')).toBe(true);
      expect(tab.classList.contains('-mb-px')).toBe(false);
    }
  });

  it('排在滚动容器之外——塞进 nav 里按钮会跟着树滚走', async () => {
    await openFilesTab();
    expect(container.querySelector('nav')?.contains(collapseButton())).toBe(false);
  });
});

// tab 行右端那枚列表 / 树切换。与上面「全部折叠」同一组判据：`Files` 档下多出一枚点了没反应的
// 按钮、读屏把它报成第三个 tab、它掉进滚动容器里跟着列表滚走、只画图标时掉了 `aria-label`。
// 另加一条这枚独有的：图标与文案表达的是**目标**视图，点一下之后名字要翻过来。
describe('tab 行右端那枚列表 / 树切换', () => {
  const viewButton = () =>
    container.querySelector('[aria-label="View as tree"], [aria-label="View as list"]');
  const tabList = () => container.querySelector('[role="tablist"]');

  it('只在 Changes 那一档画——Files 档下它一个动作都放不了', async () => {
    render(<App />, container);
    expect(viewButton()).not.toBeNull();

    tabOf('Files').click();
    await waitFor(() => expect(tabOf('Files').getAttribute('aria-selected')).toBe('true'));
    expect(viewButton()).toBeNull();
  });

  it('名字说的是目标视图：列表下是 View as tree，点一下变 View as list', async () => {
    render(<App />, container);
    expect(viewButton()?.getAttribute('aria-label')).toBe('View as tree');
    expect(viewButton()?.querySelector('svg')).not.toBeNull();

    (viewButton() as HTMLButtonElement).click();
    await waitFor(() => expect(viewButton()?.getAttribute('aria-label')).toBe('View as list'));
    expect(changeView.value).toBe('tree');
  });

  it('站在 tab 行里，但在 tablist 之外，也不在滚动容器里', () => {
    render(<App />, container);
    expect(tabList()?.contains(viewButton())).toBe(false);
    expect(tabList()?.parentElement?.contains(viewButton())).toBe(true);
    expect(container.querySelector('nav')?.contains(viewButton())).toBe(false);
  });

  it('切版式不动右侧面板，也不动选中态', async () => {
    openBinaryDiff('src/app.ts');
    render(<App />, container);
    (viewButton() as HTMLButtonElement).click();
    await waitFor(() => expect(changeView.value).toBe('tree'));
    expect(activeEditorKey.value).toBe('diff:src/app.ts');
    expect(section()?.textContent).toContain('Binary file');
  });
});

// `CHANGES` 分区标题右端那枚 `Open Changes`：是标题按钮的兄弟（点它不折叠分区），右内边距与 tab 行同一档，
// 分区折起时照画；工作区干净时也照画，点开说 `No changes`。
describe('CHANGES 分区标题上那枚 Open Changes', () => {
  const openButton = () => container.querySelector('[aria-label="Open Changes"]');
  const paneTitle = () => openButton()?.parentElement;

  it('站在 CHANGES 标题行里，是标题按钮的兄弟；不在 tab 行里', () => {
    render(<App />, container);
    expect(paneTitle()?.tagName).toBe('H2');
    expect(paneTitle()?.textContent).toContain('Changes');
    expect(openButton()?.previousElementSibling?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="tablist"]')?.parentElement?.contains(openButton())).toBe(
      false,
    );
    // 与 tab 行同一档右内边距，两处的 IconButton 落在同一条竖线上
    expect(paneTitle()?.className).toContain('pr-3');
  });

  it('点它不折叠分区；分区折起时照画', async () => {
    repoState.value = stateWith('demo');
    render(<App />, container);
    (openButton() as HTMLButtonElement).click();
    await waitFor(() => expect(activeEditorKey.value).toBe('changes:'));
    expect(changesCollapsed.value).toBe(false);

    ((openButton() as Element).previousElementSibling as HTMLButtonElement).click();
    await waitFor(() => expect(changesCollapsed.value).toBe(true));
    expect(openButton()).not.toBeNull();
  });

  it('工作区干净时照画，点开是一个说 No changes 的 Changes tab', async () => {
    repoState.value = stateWith('demo');
    render(<App />, container);
    (openButton() as HTMLButtonElement).click();
    await waitFor(() => expect(section()?.textContent).toContain('No changes'));
    expect(section()?.querySelector('[role="tab"]')?.textContent).toBe('Changes');
  });
});

/**
 * 右侧面板：空态与标签栏的位置。空态从 diff-view 那份搬过来——它现在归 `App`，两个视图
 * 自己不再有空态分支。
 */
describe('右侧面板', () => {
  const tabStrip = () => section()?.querySelector('[role="tablist"]');
  /** 标签栏的外层：tablist 与右端动作区并排住在里面，高度归它。 */
  const tabBar = () => tabStrip()?.parentElement;
  const scroller = () => section()?.querySelector('.overflow-auto');

  it('栏里没有 tab 时画快捷键列表，居中', async () => {
    render(<App />, container);
    await waitFor(() => expect(section()?.textContent).toContain('Go to File'));
    expect(section()?.textContent).toContain('Search');
    expect(section()?.textContent).toContain('Split Editor');
    // 每个按键一枚 `<kbd>`：P 那条两枚，F 那条三枚，\ 那条两枚；整列对读屏隐藏，符号念出来没有意义
    expect(section()?.querySelectorAll('kbd')).toHaveLength(7);
    for (const dd of section()?.querySelectorAll('dd') ?? []) {
      expect(dd.getAttribute('aria-hidden')).toBe('true');
    }

    // 空态居中。happy-dom 没有排版引擎，能钉的只有类名（撑满为什么是前提在 EmptyState.tsx）。
    // 居中靠里层 `m-auto` 而不是外层 `justify-center`：面板矮时后者往上溢出、顶上那截滚不到
    const box = group()?.firstElementChild;
    for (const cls of ['flex-1', 'overflow-auto']) {
      expect(box?.classList.contains(cls)).toBe(true);
    }
    expect(box?.classList.contains('justify-center')).toBe(false);
    expect(box?.firstElementChild?.classList.contains('m-auto')).toBe(true);
    expect(tabStrip()).toBeNull();
  });

  it('有 tab 时标签栏排在面板顶上、滚动层之外——面板仍是一列 flex', async () => {
    openBinaryDiff('src/app.ts');
    render(<App />, container);
    await waitFor(() => expect(section()?.textContent).toContain('Binary file'));

    expect(group()?.classList.contains('flex-col')).toBe(true);
    // 标签栏是组的直接子项、排在装着滚动层的正文之前：塞进滚动层里页面不报错，只是往下翻两屏就
    // 再也找不着它
    expect(tabBar()?.parentElement).toBe(group());
    expect(tabBar()?.nextElementSibling?.contains(scroller() ?? null)).toBe(true);
    expect(tabStrip()?.textContent).toContain('app.ts');
    expect(section()?.textContent).not.toContain('Go to File');
  });

  it('标签栏与左栏顶栏钉同一个高度——漂开时不报错，只是两条底边看着不齐', async () => {
    openBinaryDiff('src/app.ts');
    render(<App />, container);
    await waitFor(() => expect(tabStrip()).not.toBeNull());

    const heightOf = (el: Element | null | undefined) => el?.className.match(/\bh-\d+\b/)?.[0];
    expect(heightOf(header())).toBeDefined();
    expect(heightOf(tabBar())).toBe(heightOf(header()));
  });

  it('切到同种的另一个 tab 时滚动容器换新的——不然 B 会从 A 的滚动偏移量打开', async () => {
    openBinaryDiff('src/a.ts');
    openPinned('diff', 'src/b.ts');
    diffStates.value = new Map(diffStates.value).set('src/b.ts', {
      status: 'ready',
      rename: null,
      options: PATCH_DEFAULTS,
      payload: { kind: 'binary' },
    });
    focusEditor('diff:src/a.ts');
    render(<App />, container);
    await waitFor(() => expect(scroller()).not.toBeNull());
    const before = scroller();

    focusEditor('diff:src/b.ts');
    await waitFor(() => expect(scroller()).not.toBe(before));

    // 同一个 tab 内换补丁不换键：容器留在原地（另一半在 diff-view 那份用例里）
    const after = scroller();
    diffStates.value = new Map(diffStates.value).set('src/b.ts', {
      status: 'ready',
      rename: null,
      options: PATCH_DEFAULTS,
      payload: { kind: 'too-large', size: 0, reason: 'size' },
    });
    await waitFor(() => expect(section()?.textContent).toContain('Diff too large'));
    expect(scroller()).toBe(after);
  });

  it('关掉最后一个 tab 之后右侧回到空态', async () => {
    openBinaryDiff('src/app.ts');
    render(<App />, container);
    await waitFor(() => expect(section()?.textContent).toContain('Binary file'));

    container.querySelector<HTMLButtonElement>('section button[aria-label="Close"]')?.click();
    await waitFor(() => expect(section()?.textContent).toContain('Go to File'));
    expect(editors.value).toEqual([]);
  });
});

describe('分屏', () => {
  /**
   * happy-dom 的元素上没有 `ondragstart` / `ondrop` 这几个属性（浏览器里有）。Preact 按「`on` + 小写名
   * 在不在元素上」决定监听小写的事件名还是原样的 `DragStart`，缺了它们时监听挂在 `DragStart` 上，
   * 派发真实的 `dragstart` 一个都收不到。补上属性，让 Preact 走与浏览器相同的那一支。
   */
  const DRAG_HANDLERS = ['ondragstart', 'ondragend', 'ondragover', 'ondragleave', 'ondrop'];
  beforeAll(() => {
    for (const name of DRAG_HANDLERS) {
      if (!(name in HTMLElement.prototype))
        Object.defineProperty(HTMLElement.prototype, name, {
          value: null,
          writable: true,
          configurable: true,
        });
    }
  });
  // 只在右侧面板里找：左栏那一行 tab 也是一个 tablist
  const tablists = () => [...(section()?.querySelectorAll('[role="tablist"]') ?? [])];
  const tabButton = (name: string, root: Element | null | undefined = section()) =>
    [...(root?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find((tab) =>
      tab.textContent?.includes(name),
    );
  /** 一组正文（标签栏的下一个兄弟），拖到正文上的那一路挂在它上面。 */
  const bodyOf = (index: number) => tablists()[index]?.parentElement?.nextElementSibling;
  /**
   * happy-dom 没有排版，`getBoundingClientRect` 全是 0：`clientX` 大于 0 就算「右半边」、贴右边，小于 0
   * 贴左边，等于 0 落在正文中间。
   */
  const drag = (type: string, target: Element | null | undefined, clientX = 10) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
    target?.dispatchEvent(event);
    return event;
  };

  function openTwo(): void {
    openBinaryDiff('src/a.ts');
    openPinned('diff', 'src/b.ts');
    diffStates.value = new Map(diffStates.value).set('src/b.ts', {
      status: 'ready',
      rename: null,
      options: PATCH_DEFAULTS,
      payload: { kind: 'binary' },
    });
  }

  afterEach(() => {
    splitPercent.value = 50;
  });

  it('把 tab 拖到正文右半边：先画遮罩，放下即分出右组，中间多一把把手', async () => {
    openTwo();
    render(<App />, container);
    await waitFor(() => expect(tabButton('b.ts')).toBeDefined());

    drag('dragstart', tabButton('b.ts'));
    expect(draggingEditor.value?.key).toBe('diff:src/b.ts');
    const over = drag('dragover', bodyOf(0));
    // 不 `preventDefault` 时浏览器认为这里不收，`drop` 不会来
    expect(over.defaultPrevented).toBe(true);
    await waitFor(() => expect(container.querySelector('[data-drop-zone="right"]')).not.toBeNull());

    drag('drop', bodyOf(0));
    await waitFor(() => expect(tablists()).toHaveLength(2));
    expect(groups.value).toHaveLength(2);
    expect(tablists()[1]?.textContent).toContain('b.ts');
    expect(tablists()[0]?.textContent).not.toContain('b.ts');
    expect(container.querySelector('[aria-label="Resize editor groups"]')).not.toBeNull();
    expect(container.querySelector('[data-drop-zone]')).toBeNull();
  });

  it('拖到正文左半边：放下即分出左组，原来那组退到右边', async () => {
    openTwo();
    render(<App />, container);
    await waitFor(() => expect(tabButton('b.ts')).toBeDefined());
    const original = groups.value[0];

    drag('dragstart', tabButton('b.ts'));
    expect(drag('dragover', bodyOf(0), -10).defaultPrevented).toBe(true);
    await waitFor(() => expect(container.querySelector('[data-drop-zone="left"]')).not.toBeNull());

    drag('drop', bodyOf(0), -10);
    await waitFor(() => expect(tablists()).toHaveLength(2));
    expect(groups.value[1]).toBe(original);
    expect(activeGroup.value).toBe(groups.value[0]);
    expect(tablists()[0]?.textContent).toContain('b.ts');
    expect(tablists()[1]?.textContent).not.toContain('b.ts');
    expect(container.querySelector('[data-drop-zone]')).toBeNull();
  });

  it('正文中间不收：拖出来反悔、在本组松手时什么都不发生', async () => {
    openTwo();
    render(<App />, container);
    await waitFor(() => expect(tabButton('b.ts')).toBeDefined());
    drag('dragstart', tabButton('b.ts'));
    expect(drag('dragover', bodyOf(0), 0).defaultPrevented).toBe(false);
    drag('drop', bodyOf(0), 0);
    expect(groups.value).toHaveLength(1);
    expect(container.querySelector('[data-drop-zone]')).toBeNull();
  });

  it('只有一个 tab 时左右两边都不收', async () => {
    openBinaryDiff('src/a.ts');
    render(<App />, container);
    await waitFor(() => expect(tabButton('a.ts')).toBeDefined());
    drag('dragstart', tabButton('a.ts'));
    expect(drag('dragover', bodyOf(0)).defaultPrevented).toBe(false);
    expect(drag('dragover', bodyOf(0), -10).defaultPrevented).toBe(false);
  });

  it('拖回另一组的标签栏：移过去，源组空了即合并、把手消失', async () => {
    openTwo();
    render(<App />, container);
    await waitFor(() => expect(tabButton('b.ts')).toBeDefined());
    drag('dragstart', tabButton('b.ts'));
    drag('dragover', bodyOf(0));
    drag('drop', bodyOf(0));
    await waitFor(() => expect(tablists()).toHaveLength(2));

    drag('dragstart', tabButton('b.ts'));
    // 拖到 a 那一格的左半边（clientX 0 不大于中线 0）：插在它前面
    drag('dragover', tabButton('a.ts'), 0);
    drag('drop', tabButton('a.ts'), 0);
    await waitFor(() => expect(tablists()).toHaveLength(1));
    expect(editors.value.map((e) => e.path)).toEqual(['src/b.ts', 'src/a.ts']);
    expect(container.querySelector('[aria-label="Resize editor groups"]')).toBeNull();
  });

  it('点到哪一组，哪一组就是焦点组；非焦点组的活动 tab 用次要前景色', async () => {
    openTwo();
    render(<App />, container);
    await waitFor(() => expect(tabButton('b.ts')).toBeDefined());
    drag('dragstart', tabButton('b.ts'));
    drag('dragover', bodyOf(0));
    drag('drop', bodyOf(0));
    await waitFor(() => expect(tablists()).toHaveLength(2));
    expect(activeEditorKey.value).toBe('diff:src/b.ts');

    bodyOf(0)?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(activeGroup.value).toBe(groups.value[0]);
    expect(activeEditorKey.value).toBe('diff:src/a.ts');
    await waitFor(() =>
      expect(
        tabButton('b.ts')?.parentElement?.classList.contains('text-description-foreground'),
      ).toBe(true),
    );
    expect(tabButton('a.ts')?.parentElement?.classList.contains('text-editor-foreground')).toBe(
      true,
    );
  });

  it('⌘\\ 分屏后 DOM 焦点跟到新组的活动 tab：只改焦点组时，下一次 Tab 落在源组里就把它换回去', async () => {
    openBinaryDiff('src/a.ts');
    render(<App />, container);
    await waitFor(() => expect(tabButton('a.ts')).toBeDefined());
    tabButton('a.ts')?.focus();

    press({ key: '\\', metaKey: true }, true);
    await waitFor(() => expect(tablists()).toHaveLength(2));
    const right = tablists()[1]?.querySelector('[role="tab"]');
    await waitFor(() => expect(document.activeElement).toBe(right));
  });

  it('已有两组时 ⌘\\ 的 DOM 焦点落在刚开进另一组的那个 tab，不是它原先的活动 tab', async () => {
    openTwo();
    render(<App />, container);
    await waitFor(() => expect(tabButton('b.ts')).toBeDefined());
    press({ key: '\\', metaKey: true }, true);
    await waitFor(() => expect(tablists()).toHaveLength(2));

    focusEditor('diff:src/a.ts', groups.value[0]);
    press({ key: '\\', metaKey: true }, true);
    await waitFor(() => expect(tablists()[1]?.textContent).toContain('a.ts'));
    await waitFor(() => expect(document.activeElement).toBe(tabButton('a.ts', tablists()[1])));
  });
});
