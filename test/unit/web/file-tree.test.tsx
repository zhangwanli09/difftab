// 文件树画出来的那一行。
//
// 三条钉的都是「不报错、只是不对」：被忽略的行没灰显（那一档与普通文件长得一模一样）、状态
// 染色与变更列表用了两份表（同一个文件在两处不同色）、以及展开时没去取下一层。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry, TreeEntry } from '../../../src/server/shared/protocol';
import { FileTree } from '../../../src/web/components/FileTree';
import { fileState, repoState } from '../../../src/web/state/store';
import {
  collapseAll,
  expandedDirs,
  ROOT,
  treeCache,
  treeErrors,
} from '../../../src/web/state/tree';

const entry = (partial: Partial<TreeEntry> & { name: string }): TreeEntry => ({
  path: partial.name,
  kind: 'file',
  ignored: false,
  ...partial,
});

const file = (partial: Partial<FileEntry> & { path: string }): FileEntry => ({
  kind: 'tracked',
  staged: '.',
  unstaged: '.',
  ...partial,
});

let container: HTMLElement;

/**
 * 等到某个断言成立。**不在用例里补 `render()`**：树在渲染体里订阅那几个 signal，状态一变自己
 * 就重画——手动补一次会把「状态变了会不会重画」替它做掉。`interval` 调小的理由同 diff-view。
 */
const waitFor = (assert: () => void) => vi.waitFor(assert, { interval: 5 });

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  // 模块级 signal 会跨用例串味，挂载之前先清干净
  treeCache.value = new Map();
  treeErrors.value = new Map();
  expandedDirs.value = new Set();
  fileState.value = null;
  repoState.value = null;
  vi.stubGlobal('fetch', vi.fn());
  render(<FileTree />, container);
});

afterEach(() => {
  render(null, container);
  vi.unstubAllGlobals();
});

/** 按可见文本挑一行的 `<button>`。 */
function rowOf(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  );
  if (!found) throw new Error(`没有画出名为 ${text} 的行`);
  return found;
}

/**
 * 一行里装名字的那个 `<span>`——**取最后一个**：文件那一侧的第一个 span 是等宽占位，
 * `querySelector('span')` 挑到的会是它，而断言随之说一句与真正原因无关的话。
 */
function nameOf(text: string): HTMLSpanElement {
  const spans = rowOf(text).querySelectorAll('span');
  const last = spans[spans.length - 1];
  if (!last) throw new Error(`${text} 那一行没有装名字的 span`);
  return last as HTMLSpanElement;
}

describe('FileTree', () => {
  it('还没取到那一层时说 Loading…，取不到时把原因写在这一层里', async () => {
    expect(container.textContent).toContain('Loading…');

    treeErrors.value = new Map([[ROOT, 'Request failed (HTTP 500).']]);
    // **不写进那条全局错误条**：一个目录展不开不该让整个页面看起来坏掉
    await waitFor(() => expect(container.textContent).toContain('Request failed (HTTP 500).'));
  });

  it('手上已经有这一层时，刷新失败不把它换成一行红字', async () => {
    treeCache.value = new Map([[ROOT, [entry({ name: 'a.ts' })]]]);
    await waitFor(() => expect(container.textContent).toContain('a.ts'));

    // 刷新途中失败是常态（后端重启、dev 代理抖一下）。先看错误的写法会让一个已经画出来的
    // 目录连同它底下展开的一切被一行红字换掉，直到下一个 change 恰好成功
    treeErrors.value = new Map([[ROOT, 'Request failed (HTTP 500).']]);
    await waitFor(() => expect(container.textContent).toContain('a.ts'));
    expect(container.textContent).not.toContain('Request failed');
  });

  it('被忽略的行灰显，可见的不灰', async () => {
    treeCache.value = new Map([
      [
        ROOT,
        [
          entry({ name: 'node_modules', kind: 'directory', ignored: true }),
          entry({ name: 'README.md' }),
        ],
      ],
    ]);
    await waitFor(() => expect(container.textContent).toContain('README.md'));

    expect(rowOf('node_modules').className).toContain('opacity-60');
    expect(rowOf('README.md').className).not.toContain('opacity-60');
  });

  it('状态染色取自变更列表那张表，且冲突优先', async () => {
    treeCache.value = new Map([
      [ROOT, [entry({ name: 'a.ts' }), entry({ name: 'b.ts' }), entry({ name: 'c.ts' })]],
    ]);
    repoState.value = {
      repoName: 'demo',
      branch: { head: 'main', detached: false, upstream: null },
      watch: { mode: 'native', tier: 'A' },
      files: [
        file({ path: 'a.ts', unstaged: 'M' }),
        // 冲突两侧状态位都不是 `.`，挑哪一位都会说错一半——一律按 U 上色
        file({ path: 'b.ts', staged: 'D', unstaged: 'D', conflicted: true }),
      ],
    };
    await waitFor(() => expect(container.textContent).toContain('c.ts'));

    expect(nameOf('a.ts').className).toContain('text-git-modified');
    expect(nameOf('b.ts').className).toContain('text-git-conflicting');
    // 没改动的那一行不上色
    expect(nameOf('c.ts').className).toBe('min-w-0 truncate');
  });

  it('目录不上状态色——底下可以同时躺着改过的和没改过的文件', async () => {
    treeCache.value = new Map([[ROOT, [entry({ name: 'src', kind: 'directory' })]]]);
    repoState.value = {
      repoName: 'demo',
      branch: { head: 'main', detached: false, upstream: null },
      watch: { mode: 'native', tier: 'A' },
      files: [file({ path: 'src', unstaged: 'M' })],
    };
    await waitFor(() => expect(container.textContent).toContain('src'));
    expect(nameOf('src').className).not.toContain('text-git-modified');
  });

  it('展开的目录才画下一层，收起的不画', async () => {
    treeCache.value = new Map([
      [ROOT, [entry({ name: 'src', kind: 'directory' })]],
      ['src', [entry({ name: 'app.ts', path: 'src/app.ts' })]],
    ]);
    await waitFor(() => expect(container.textContent).toContain('src'));
    expect(container.textContent).not.toContain('app.ts');
    expect(rowOf('src').getAttribute('aria-expanded')).toBe('false');

    expandedDirs.value = new Set(['src']);
    await waitFor(() => expect(container.textContent).toContain('app.ts'));
    expect(rowOf('src').getAttribute('aria-expanded')).toBe('true');
  });

  it('再展开一个取过的目录会重取——收起期间它不在刷新范围里，缓存可能已经陈旧了', async () => {
    const fetchMock = vi.mocked(fetch);
    treeCache.value = new Map([
      [ROOT, [entry({ name: 'src', kind: 'directory' })]],
      ['src', [entry({ name: 'app.ts', path: 'src/app.ts' })]],
    ]);
    await waitFor(() => expect(container.textContent).toContain('src'));

    rowOf('src').click();
    // 旧那几行照画（不空一拍），同时去取一份新的——不重取时页面上是一份停在收起那一刻的目录，
    // 一直旧到下一个 change 到达，而它不报错、也不空白，只是少了几行
    await waitFor(() => expect(container.textContent).toContain('app.ts'));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('path=src');
  });

  it('选中的文件高亮，且判据是 fileState 而不是变更列表那份选中态', async () => {
    treeCache.value = new Map([[ROOT, [entry({ name: 'a.ts' })]]]);
    await waitFor(() => expect(container.textContent).toContain('a.ts'));
    expect(rowOf('a.ts').className).not.toContain('bg-list-active-selection-background');

    fileState.value = { status: 'ready', path: 'a.ts', payload: { kind: 'text', content: '' } };
    await waitFor(() =>
      expect(rowOf('a.ts').className).toContain('bg-list-active-selection-background'),
    );
  });

  it('整行挂完整路径——名字会被 320px 裁掉，路径在树上找不回来', async () => {
    treeCache.value = new Map([
      ['src', [entry({ name: 'app.ts', path: 'src/app.ts' })]],
      [ROOT, [entry({ name: 'src', kind: 'directory' })]],
    ]);
    expandedDirs.value = new Set(['src']);
    await waitFor(() => expect(container.textContent).toContain('app.ts'));
    expect(rowOf('app.ts').title).toBe('src/app.ts');
  });

  it('文件那一侧画等宽占位——少了它文件名会比同层的目录名往左挪一截', async () => {
    treeCache.value = new Map([
      [ROOT, [entry({ name: 'src', kind: 'directory' }), entry({ name: 'a.ts' })]],
    ]);
    await waitFor(() => expect(container.textContent).toContain('a.ts'));
    expect(rowOf('src').querySelector('svg')).not.toBeNull();
    expect(rowOf('a.ts').querySelector('svg')).toBeNull();
    expect(rowOf('a.ts').querySelector('span')?.className).toContain('w-3');
    // 占位在前、名字在后：名字那一段永远是最后一个 span
    expect(nameOf('a.ts').textContent).toBe('a.ts');
  });
});

// 「全部折叠」在树上的效果。三条钉的都是「不报错、只是不对」：折不干净、顺手把缓存也清了（再
// 展开时凭空空一拍），以及连右侧正在读的那个文件一起丢掉。**直接调 `collapseAll()`，不画那枚
// 按钮**：按钮住在 tab 行里（见 `App`），在这里摆一个等于让树的用例跟着侧栏版式走——`app.test.tsx`
// 已经钉着「点得到、且点的是这个动作」，这里要的只是「这个动作落在树上是什么样」。
describe('collapseAll()', () => {
  /** 根 → src → src/web → 一个文件，两层都展开着。 */
  const twoLevelsOpen = () => {
    treeCache.value = new Map([
      [ROOT, [entry({ name: 'src', kind: 'directory' })]],
      ['src', [entry({ name: 'web', kind: 'directory', path: 'src/web' })]],
      ['src/web', [entry({ name: 'App.tsx', path: 'src/web/App.tsx' })]],
    ]);
    expandedDirs.value = new Set(['src', 'src/web']);
  };

  it('一下把展开着的那几层全收起来，树回到只剩根那一层', async () => {
    twoLevelsOpen();
    await waitFor(() => expect(container.textContent).toContain('App.tsx'));

    collapseAll();
    await waitFor(() => expect(container.textContent).not.toContain('App.tsx'));
    expect(container.textContent).not.toContain('web');
    expect(container.textContent).toContain('src');
    expect(expandedDirs.value.size).toBe(0);
  });

  it('不清 treeCache——再展开时不该又空一拍', async () => {
    twoLevelsOpen();
    await waitFor(() => expect(container.textContent).toContain('App.tsx'));

    collapseAll();
    await waitFor(() => expect(container.textContent).not.toContain('App.tsx'));
    expect(treeCache.value.get('src')).toHaveLength(1);

    // 手上还有那一层，于是再展开画的是原来那行，不是 Loading…
    expandedDirs.value = new Set(['src']);
    await waitFor(() => expect(container.textContent).toContain('web'));
    expect(container.textContent).not.toContain('Loading…');
  });

  it('不动右侧选中态——折的是左栏在列什么，不是用户此刻在读什么', async () => {
    twoLevelsOpen();
    fileState.value = {
      status: 'ready',
      path: 'src/web/App.tsx',
      payload: { kind: 'text', content: '' },
    };
    await waitFor(() => expect(container.textContent).toContain('App.tsx'));

    collapseAll();
    await waitFor(() => expect(container.textContent).not.toContain('App.tsx'));
    expect(fileState.value?.path).toBe('src/web/App.tsx');
  });
});
