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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoState } from '../../../src/server/shared/protocol';
import { App } from '../../../src/web/components/App';
import { changeView } from '../../../src/web/state/change-tree';
import { activeEditorKey, editors } from '../../../src/web/state/editors';
import { activeTab, diffStates, fileStates, repoState } from '../../../src/web/state/store';
import { PRODUCT_NAME } from '../../../src/web/state/title';
import { expandedDirs, ROOT, treeCache, treeErrors } from '../../../src/web/state/tree';
import { openPinned, resetEditors, waitFor } from './helpers';

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
  changeView.value = 'list';
  treeCache.value = new Map();
  treeErrors.value = new Map();
  expandedDirs.value = new Set();
  vi.unstubAllGlobals();
});

const header = () => container.querySelector('header');
const headerText = () => header()?.textContent?.trim();
const section = () => container.querySelector('section');

/** 开一个 diff tab 并把它的缓存写成一份 binary——右侧因此画得出 `Binary file` 那句。 */
function openBinaryDiff(path: string): void {
  openPinned('diff', path);
  diffStates.value = new Map([
    [path, { status: 'ready', rename: null, payload: { kind: 'binary' } }],
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

  it('右端有一个带无障碍名的主题开关——它是顶栏里唯一的另一样东西', () => {
    repoState.value = stateWith('my-app');
    render(<App />, container);

    const buttons = header()?.querySelectorAll('button') ?? [];
    expect(buttons).toHaveLength(1);
    // 只画图标，名字只能由 aria-label 给——掉了它这个按钮在读屏里就是一个无名控件
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Follow system');
  });

  it('第一份 state 还没到时开关也在——它不依赖仓库状态', () => {
    render(<App />, container);
    expect(header()?.querySelectorAll('button')).toHaveLength(1);
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

describe('侧栏那两个 tab', () => {
  it('只画图标，名字由 aria-label 给——掉了它这两个就是无名控件，而页面上看不出来', () => {
    render(<App />, container);
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Changes', 'Files']);
    // 名字不在文本里、图标真的画出来了：两条一起才说明「换成图标」这件事成立
    expect(tabs.map((tab) => tab.textContent)).toEqual(['', '']);
    expect(tabs.every((tab) => tab.querySelector('svg') !== null)).toBe(true);
  });

  it('默认停在 Changes 上——工具存在的理由仍是「瞥一眼改了什么」', () => {
    render(<App />, container);
    expect(tabOf('Changes').getAttribute('aria-selected')).toBe('true');
    expect(tabOf('Files').getAttribute('aria-selected')).toBe('false');
  });

  it('切到 Files 换的是左栏列什么', async () => {
    repoState.value = stateWith('demo');
    render(<App />, container);
    expect(container.querySelector('nav')?.textContent).toContain('No changes');

    tabOf('Files').click();
    // 树那一档还没取到第一层，画的是 Loading…
    await waitFor(() => expect(tabOf('Files').getAttribute('aria-selected')).toBe('true'));
    expect(container.querySelector('nav')?.textContent).not.toContain('No changes');
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

/**
 * 右侧面板：空态与标签栏的位置。空态那三句从 diff-view 那份搬过来——它们现在归 `App`，两个视图
 * 自己不再有空态分支。
 */
describe('右侧面板', () => {
  const tabStrip = () => section()?.querySelector('[role="tablist"]');
  const scroller = () => section()?.querySelector('.overflow-auto');

  it('栏里没有 tab 时给一句提示，居中并配一枚图标', async () => {
    render(<App />, container);
    await waitFor(() => expect(section()?.textContent).toContain('Select a file on the left'));

    // 空态居中并配图标。happy-dom 没有排版引擎，能钉的只有类名（撑满为什么是前提在 EmptyState.tsx）
    const box = section()?.firstElementChild;
    for (const cls of ['flex-1', 'items-center', 'justify-center']) {
      expect(box?.classList.contains(cls)).toBe(true);
    }
    expect(section()?.querySelector('svg.lucide-file-diff')).not.toBeNull();
    expect(tabStrip()).toBeNull();
  });

  it('工作区干净时换一句——「点左边一个文件」指着的是一个空列表', async () => {
    // 「没得选」与「还没选」是两件事：上一条用例的 repoState 是 null，走的正是「还没选」那句
    repoState.value = stateWith('demo');
    render(<App />, container);

    await waitFor(() => expect(section()?.textContent).toContain('Working tree clean'));
    expect(section()?.textContent).not.toContain('Select a file on the left');
    // 图标跟着文案一起换：干净是一个 ✓，不再是那份 diff
    expect(section()?.querySelector('svg.lucide-circle-check')).not.toBeNull();
    expect(section()?.querySelector('svg.lucide-file-diff')).toBeNull();
  });

  it('切到 Files 档时空态跟着档走：图标换成全文那枚，干净也照样说「点左边一个」', async () => {
    // 干净仓库 + Files 档：那一档列的是整棵目录树，「Working tree clean」对着一列能点的文件说不通
    repoState.value = stateWith('demo');
    activeTab.value = 'files';
    render(<App />, container);

    await waitFor(() => expect(section()?.querySelector('svg.lucide-file-code')).not.toBeNull());
    expect(section()?.textContent).toContain('Select a file on the left');
    expect(section()?.textContent).not.toContain('Working tree clean');
  });

  it('有 tab 时标签栏排在面板顶上、滚动层之外——面板仍是一列 flex', async () => {
    openBinaryDiff('src/app.ts');
    render(<App />, container);
    await waitFor(() => expect(section()?.textContent).toContain('Binary file'));

    expect(section()?.classList.contains('flex-col')).toBe(true);
    // 标签栏与滚动层是 `<section>` 的两个直接子项，前者在前：塞进滚动层里页面不报错，只是
    // 往下翻两屏就再也找不着它
    expect(tabStrip()?.parentElement).toBe(section());
    expect(tabStrip()?.nextElementSibling).toBe(scroller());
    expect(tabStrip()?.textContent).toContain('app.ts');
    expect(section()?.textContent).not.toContain('Select a file on the left');
  });

  it('切到同种的另一个 tab 时滚动容器换新的——不然 B 会从 A 的滚动偏移量打开', async () => {
    openBinaryDiff('src/a.ts');
    openPinned('diff', 'src/b.ts');
    diffStates.value = new Map(diffStates.value).set('src/b.ts', {
      status: 'ready',
      rename: null,
      payload: { kind: 'binary' },
    });
    activeEditorKey.value = 'diff:src/a.ts';
    render(<App />, container);
    await waitFor(() => expect(scroller()).not.toBeNull());
    const before = scroller();

    activeEditorKey.value = 'diff:src/b.ts';
    await waitFor(() => expect(scroller()).not.toBe(before));

    // 同一个 tab 内换补丁不换键：容器留在原地（另一半在 diff-view 那份用例里）
    const after = scroller();
    diffStates.value = new Map(diffStates.value).set('src/b.ts', {
      status: 'ready',
      rename: null,
      payload: { kind: 'too-large', size: 0, reason: 'size' },
    });
    await waitFor(() => expect(section()?.textContent).toContain('File too large'));
    expect(scroller()).toBe(after);
  });

  it('关掉最后一个 tab 之后右侧回到空态', async () => {
    openBinaryDiff('src/app.ts');
    render(<App />, container);
    await waitFor(() => expect(section()?.textContent).toContain('Binary file'));

    container.querySelector<HTMLButtonElement>('section button[aria-label="Close"]')?.click();
    await waitFor(() => expect(section()?.textContent).toContain('Select a file on the left'));
    expect(editors.value).toEqual([]);
  });
});
