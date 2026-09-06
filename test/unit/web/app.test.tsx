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
import {
  activePane,
  activeTab,
  diffState,
  fileState,
  repoState,
} from '../../../src/web/state/store';
import { PRODUCT_NAME } from '../../../src/web/state/title';
import { expandedDirs, ROOT, treeCache, treeErrors } from '../../../src/web/state/tree';

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
  diffState.value = null;
  fileState.value = null;
  activeTab.value = 'changes';
  activePane.value = 'diff';
  treeCache.value = new Map();
  treeErrors.value = new Map();
  expandedDirs.value = new Set();
  vi.unstubAllGlobals();
});

const header = () => container.querySelector('header');
const headerText = () => header()?.textContent?.trim();

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

const waitFor = (assert: () => void) => vi.waitFor(assert, { interval: 5 });

const tabOf = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('[role="tab"]')].find(
    (node) => node.textContent === label,
  );
  if (!found) throw new Error(`没有画出 ${label} 这个 tab`);
  return found as HTMLButtonElement;
};

describe('侧栏那两个 tab', () => {
  it('默认停在 Changes 上——工具存在的理由仍是「瞥一眼改了什么」', () => {
    render(<App />, container);
    expect(tabOf('Changes').getAttribute('aria-selected')).toBe('true');
    expect(tabOf('Files').getAttribute('aria-selected')).toBe('false');
  });

  it('切到 Files 换的是左栏列什么', async () => {
    repoState.value = stateWith('demo');
    render(<App />, container);
    expect(container.querySelector('nav')?.textContent).toContain('Working tree clean');

    tabOf('Files').click();
    // 树那一档还没取到第一层，画的是 Loading…
    await waitFor(() => expect(tabOf('Files').getAttribute('aria-selected')).toBe('true'));
    expect(container.querySelector('nav')?.textContent).not.toContain('Working tree clean');
  });

  it('**切 tab 不动右侧面板**——每瞄一眼目录树就丢掉正在读的 diff 是不能接受的', async () => {
    diffState.value = {
      status: 'ready',
      path: 'src/app.ts',
      rename: null,
      payload: { kind: 'binary' },
    };
    render(<App />, container);
    expect(container.querySelector('section')?.textContent).toContain('Binary file');

    tabOf('Files').click();
    await waitFor(() => expect(tabOf('Files').getAttribute('aria-selected')).toBe('true'));
    expect(activePane.value).toBe('diff');
    expect(container.querySelector('section')?.textContent).toContain('Binary file');
  });

  it('右侧画哪一个由 activePane 定，与停在哪个 tab 上无关', async () => {
    fileState.value = { status: 'ready', path: 'a.ts', payload: { kind: 'binary' } };
    activePane.value = 'file';
    render(<App />, container);
    // 侧栏还停在 Changes 上，右边已经是文件视图了——两者本就不是一回事
    await waitFor(() =>
      expect(container.querySelector('section')?.textContent).toContain(
        'Binary file — contents are not shown.',
      ),
    );
    expect(tabOf('Changes').getAttribute('aria-selected')).toBe('true');
  });

  it('切回 Files 时把树刷一遍——不看那一档时 SSE 不重取它，回来就得补上', async () => {
    const fetchMock = vi.fn((_url: string) => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    // 已经取过根那一层：`loadDir` 自带「取过就不再取」，所以真去发请求的只能是 refreshTree
    treeCache.value = new Map([[ROOT, []]]);
    render(<App />, container);

    tabOf('Files').click();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/tree');
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
