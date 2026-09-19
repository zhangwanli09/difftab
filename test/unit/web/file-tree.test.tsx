// 文件树画出来的那一行。
//
// 几条钉的都是「不报错、只是不对」：被忽略的行没灰显（那一档与普通文件长得一模一样）、状态
// 染色与变更列表用了两份表（同一个文件在两处不同色）、目录行的圆点归并错了颜色或印成了字母、
// 以及展开时没去取下一层。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry, TreeEntry } from '../../../src/server/shared/protocol';
import { FileTree } from '../../../src/web/components/FileTree';
import { REVEAL, ROW_BASE, ROW_GROUP } from '../../../src/web/components/tree-row';
import { activeEditorKey, editors } from '../../../src/web/state/editors';
import { setIn } from '../../../src/web/state/immutable';
import { repoState } from '../../../src/web/state/store';
import {
  collapseAll,
  expandedDirs,
  ROOT,
  toggleDir,
  treeCache,
  treeErrors,
} from '../../../src/web/state/tree';
import {
  actionOf,
  file,
  groupOf,
  openPinned,
  resetEditors,
  spacerIn,
  stubClipboard,
  stubJsonBy,
  waitFor,
} from './helpers';

const entry = (partial: Partial<TreeEntry> & { name: string }): TreeEntry => ({
  path: partial.name,
  kind: 'file',
  ignored: false,
  ...partial,
});

let container: HTMLElement;

/**
 * 等到某个断言成立。**不在用例里补 `render()`**：树在渲染体里订阅那几个 signal，状态一变自己
 * 就重画——手动补一次会把「状态变了会不会重画」替它做掉。`interval` 调小的理由同 diff-view。
 */
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  // 模块级 signal 会跨用例串味，挂载之前先清干净
  treeCache.value = new Map();
  treeErrors.value = new Map();
  expandedDirs.value = new Set();
  resetEditors();
  repoState.value = null;
  vi.stubGlobal('fetch', vi.fn());
  render(<FileTree />, container);
});

afterEach(() => {
  render(null, container);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * 一行里装名字的那个 `<span>`——按 `truncate` 挑，**不按位置**：文件那一侧的第一个 span 是等宽
 * 占位，最后一个则可能是行尾的状态记号，按位置挑到哪个都会让断言说一句与真正原因无关的话。
 */
function nameOf(text: string): HTMLSpanElement {
  const found = [...container.querySelectorAll<HTMLSpanElement>('button .truncate')].find(
    (span) => span.textContent === text,
  );
  if (!found) throw new Error(`没有画出名为 ${text} 的行`);
  return found;
}

/** 按名字挑一行的 `<button>`。走 `nameOf`：整行的文本还带着行尾的状态字母，直接比不齐。 */
function rowOf(text: string): HTMLButtonElement {
  const row = nameOf(text).closest('button');
  if (!row) throw new Error(`${text} 那一段不在任何一行里`);
  return row;
}

/** 一行行尾的状态记号（字母或圆点）；没有即 `null`。判据是 `ml-auto`——它是唯一靠右的子项。 */
const badgeOf = (text: string) => rowOf(text).querySelector<HTMLSpanElement>('.ml-auto');

/** 换一份变更列表。只有 `files` 在用例之间不同，其余字段树上一个都不读。 */
function withFiles(files: FileEntry[]) {
  repoState.value = {
    repoName: 'demo',
    branch: { head: 'main', detached: false, upstream: null },
    watch: { mode: 'native', tier: 'A' },
    files,
  };
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
    withFiles([
      file({ path: 'a.ts', unstaged: 'M' }),
      // 冲突两侧状态位都不是 `.`，挑哪一位都会说错一半——一律按 U 上色
      file({ path: 'b.ts', staged: 'D', unstaged: 'D', conflicted: true }),
    ]);
    await waitFor(() => expect(container.textContent).toContain('c.ts'));

    expect(nameOf('a.ts').className).toContain('text-git-modified');
    expect(nameOf('b.ts').className).toContain('text-git-conflicting');
    // 没改动的那一行不上色
    expect(nameOf('c.ts').className).toBe('min-w-0 truncate');
  });

  /**
   * 文件行行尾印状态字母，且是变更列表那一枚（同色、带 tooltip）。没改动的行连那个壳也不画——画
   * 一个空壳不报错，只是每行右端多占 20px。
   */
  it('文件行行尾印状态字母，没改动的不印', async () => {
    treeCache.value = new Map([[ROOT, [entry({ name: 'a.ts' }), entry({ name: 'c.ts' })]]]);
    withFiles([file({ path: 'a.ts', unstaged: 'M' })]);
    await waitFor(() => expect(badgeOf('a.ts')).not.toBeNull());

    const badge = badgeOf('a.ts');
    expect(badge?.textContent).toBe('M');
    expect(badge?.className).toContain('text-git-modified');
    expect(badge?.title).toBe('Modified');
    expect(badgeOf('c.ts')).toBeNull();
  });

  /**
   * 目录行：底下有改动就染色 + 行尾一枚圆点，**不印字母**——一个目录底下可以同时躺着改过的和没
   * 改过的文件，挑一个字母就是替用户下结论。颜色按后代归并、冲突最先；干净的目录什么都不画。
   */
  it('目录行按后代归并出颜色、行尾印圆点不印字母，冲突优先', async () => {
    treeCache.value = new Map([
      [
        ROOT,
        [
          entry({ name: 'src', kind: 'directory' }),
          entry({ name: 'lib', kind: 'directory' }),
          entry({ name: 'docs', kind: 'directory' }),
        ],
      ],
    ]);
    withFiles([
      // src 底下既有修改又有冲突：冲突赢
      file({ path: 'src/a.ts', unstaged: 'M' }),
      file({ path: 'src/deep/b.ts', staged: 'D', unstaged: 'D', conflicted: true }),
      // lib 底下只有未跟踪
      file({ path: 'lib/new.ts', kind: 'untracked', unstaged: '?' }),
    ]);
    await waitFor(() => expect(badgeOf('src')).not.toBeNull());

    const dot = badgeOf('src');
    expect(nameOf('src').className).toContain('text-git-conflicting');
    expect(dot?.className).toContain('text-git-conflicting');
    expect(dot?.textContent).toBe('');
    expect(dot?.getAttribute('aria-label')).toBe('Contains changes');

    expect(nameOf('lib').className).toContain('text-git-untracked');
    expect(badgeOf('lib')?.className).toContain('text-git-untracked');

    expect(nameOf('docs').className).toBe('min-w-0 truncate');
    expect(badgeOf('docs')).toBeNull();
  });

  /**
   * 「自己的路径也算一份」：submodule 在树上是一条 `directory`，而它的改动在 status 里记在它
   * **自己**的路径上（`S.M.`），不是任何后代。表只按后代归并时会漏掉它：变更列表说它 `M`，树上
   * 却什么都不画。
   */
  it('submodule 那一行按自己的路径取状态——它是目录，但改动不在后代上', async () => {
    treeCache.value = new Map([[ROOT, [entry({ name: 'vendor', kind: 'directory' })]]]);
    withFiles([file({ path: 'vendor', unstaged: 'M' })]);
    await waitFor(() => expect(badgeOf('vendor')).not.toBeNull());

    expect(nameOf('vendor').className).toContain('text-git-modified');
    expect(badgeOf('vendor')?.className).toContain('text-git-modified');
    // 仍是目录的画法：圆点，不是字母
    expect(badgeOf('vendor')?.textContent).toBe('');
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

  it('选中的文件高亮，判据是活动 tab 的路径——变更列表那侧点开的 diff tab 活动时也亮', async () => {
    treeCache.value = new Map([[ROOT, [entry({ name: 'a.ts' }), entry({ name: 'b.ts' })]]]);
    await waitFor(() => expect(container.textContent).toContain('a.ts'));
    expect(rowOf('a.ts').className).not.toContain('bg-list-active-selection-background');

    openPinned('diff', 'a.ts');
    await waitFor(() =>
      expect(rowOf('a.ts').className).toContain('bg-list-active-selection-background'),
    );
    expect(rowOf('b.ts').className).not.toContain('bg-list-active-selection-background');

    openPinned('file', 'b.ts');
    await waitFor(() =>
      expect(rowOf('b.ts').className).toContain('bg-list-active-selection-background'),
    );
    expect(rowOf('a.ts').className).not.toContain('bg-list-active-selection-background');
  });

  it('单击开一个预览 tab，双击把它固定；目录行双击什么都不开', async () => {
    treeCache.value = new Map([
      [ROOT, [entry({ name: 'src', kind: 'directory' }), entry({ name: 'a.ts' })]],
    ]);
    await waitFor(() => expect(container.textContent).toContain('a.ts'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"kind":"binary"}', { status: 200 })),
    );

    rowOf('a.ts').click();
    expect(editors.value).toEqual([{ kind: 'file', path: 'a.ts', pinned: false }]);
    // 浏览器的一次双击：click、click、dblclick。前两个各取一趟，dblclick 只置 pinned
    rowOf('a.ts').click();
    rowOf('a.ts').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(editors.value).toEqual([{ kind: 'file', path: 'a.ts', pinned: true }]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    rowOf('src').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(editors.value).toHaveLength(1);
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
    // 占位在前、名字在后：名字那一段是第二个子项
    expect(rowOf('a.ts').children[1]).toBe(nameOf('a.ts'));
  });

  // 行的骨架与变更列表共用 `tree-row.tsx` 那一份：各写一份时漂开不报错，只是切一次 tab 三角与
  // 名字的间距跳一截。happy-dom 没有排版引擎，能钉的只有类名；目录行与文件行是同一个 `Row`，钉一行够
  it('行取 tree-row 那份 ROW_BASE——各写一份时切 tab 会跳', async () => {
    treeCache.value = new Map([[ROOT, [entry({ name: 'a.ts' })]]]);
    await waitFor(() => expect(container.textContent).toContain('a.ts'));
    expect(rowOf('a.ts').className).toContain(ROW_BASE);
  });
});

/**
 * 文件行与目录行悬停露出的 `Copy path`，机制与变更列表那枚共用（`TreeRow`）。钉的是「不报错、只是
 * 不对」：这棵树的行没走 `TreeRow`（group 挂回 `<li>` 上——目录行套着子 `<ul>`，悬停任一后代时整段
 * 目录行一起亮；底色回到行按钮上——指针移到按钮上那一刻行底色消失；占位与外壳的显隐变体漂开）；
 * 复制的不是仓库相对路径。变体本身是哪几个由 `change-list.test.tsx` 钉，这里只钉「与外壳同一份」。
 */
describe('FileTree 的 Copy path 行内动作', () => {
  const copyButtonOf = (text: string) => actionOf(rowOf(text), 'Copy path');

  it('文件行与目录行都有；group 是行按钮的父 div 而不是 <li>，目录行的 group 不含子层', async () => {
    treeCache.value = new Map([
      [ROOT, [entry({ name: 'src', kind: 'directory' }), entry({ name: 'a.ts' })]],
      ['src', [entry({ name: 'app.ts', path: 'src/app.ts' })]],
    ]);
    expandedDirs.value = new Set(['src']);
    await waitFor(() => expect(container.textContent).toContain('app.ts'));

    for (const text of ['a.ts', 'src']) {
      const button = copyButtonOf(text);
      expect(button?.title, text).toBe('Copy path');
      expect(rowOf(text).contains(button)).toBe(false);
      expect(groupOf(rowOf(text))).toBe(rowOf(text).parentElement);
      expect(groupOf(rowOf(text))?.className).toBe(ROW_GROUP);
      expect(rowOf(text).closest('li')?.classList.contains('group')).toBe(false);
      expect(rowOf(text).className).not.toContain('bg-list-hover-background');
    }
    expect(groupOf(rowOf('src'))?.contains(rowOf('app.ts'))).toBe(false);
  });

  it('占位与按钮外壳共用同一对显隐变体，占位一枚宽', async () => {
    treeCache.value = new Map([[ROOT, [entry({ name: 'a.ts' })]]]);
    await waitFor(() => expect(container.textContent).toContain('a.ts'));
    const shell = copyButtonOf('a.ts')?.parentElement;
    const spacer = spacerIn(rowOf('a.ts'));

    for (const node of [shell, spacer]) {
      expect(node?.className).toContain(REVEAL);
    }
    expect(spacer?.classList.contains('w-5')).toBe(true);
  });

  it('点它把仓库相对路径写进剪贴板，不开 tab 也不折叠目录', async () => {
    const writeText = stubClipboard();
    treeCache.value = new Map([
      [ROOT, [entry({ name: 'src', kind: 'directory' })]],
      ['src', [entry({ name: 'app.ts', path: 'src/app.ts' })]],
    ]);
    expandedDirs.value = new Set(['src']);
    await waitFor(() => expect(container.textContent).toContain('app.ts'));

    copyButtonOf('app.ts')?.click();
    expect(writeText).toHaveBeenCalledWith('src/app.ts');
    copyButtonOf('src')?.click();
    expect(writeText).toHaveBeenCalledWith('src');
    expect(editors.value).toEqual([]);
    expect(expandedDirs.value.has('src')).toBe(true);
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
    openPinned('file', 'src/web/App.tsx');
    await waitFor(() => expect(container.textContent).toContain('App.tsx'));

    collapseAll();
    await waitFor(() => expect(container.textContent).not.toContain('App.tsx'));
    expect(activeEditorKey.value).toBe('file:src/web/App.tsx');
  });
});

// 树跟着右侧活动 tab 展开并定位（照 VS Code 的 `explorer.autoReveal`）。钉的都是「不报错、只是
// 不对」：切 tab 之后高亮行躺在没展开的层里（等于没跟随）、已展开的祖先被白取一趟、用户手动收起的
// 目录被 effect 顶回去（展开那一步没 `untracked`）、以及自动展开失败留下一个看不见的展开态。
describe('跟随活动 tab', () => {
  /**
   * 把 fetch 换成一份按目录回内容的树，回的是各请求的 `path`：没给的目录回空层，给 `null` 的回
   * 404（整个目录被删）。**要真的回来**：外面那个 `vi.fn()` 回的是 `undefined`，`loadDir` 会把它记成
   * 错误，而自动展开失败是要退回展开态的。
   */
  const stubTree = (levels: Record<string, TreeEntry[] | null> = {}) => {
    const paths: string[] = [];
    stubJsonBy((url) => {
      const path = url.searchParams.get('path') ?? '';
      paths.push(path);
      return levels[path] === null
        ? { payload: { error: 'not-found', message: 'not found' }, status: 404 }
        : { payload: { path, entries: levels[path] ?? [] } };
    });
    return paths;
  };

  it('活动 tab 一变就把每一级祖先展开，各取一层；换到别的路径只补新的祖先', async () => {
    const paths = stubTree();
    openPinned('diff', 'src/web/a.ts');
    await waitFor(() => expect(expandedDirs.value).toEqual(new Set(['src', 'src/web'])));
    // 根不因此多取（它由 App 切到 Files 那一刻取）
    expect(paths).toEqual(['src', 'src/web']);

    // 旧的照旧展开着：跟随只加不减
    openPinned('file', 'lib/x.ts');
    await waitFor(() => expect(expandedDirs.value).toEqual(new Set(['src', 'src/web', 'lib'])));
    expect(paths).toEqual(['src', 'src/web', 'lib']);
  });

  it('已经展开的祖先不重取——它本就在刷新范围里', async () => {
    const paths = stubTree();
    expandedDirs.value = new Set(['src']);
    openPinned('diff', 'src/web/a.ts');
    await waitFor(() => expect(expandedDirs.value.has('src/web')).toBe(true));
    expect(paths).toEqual(['src/web']);
  });

  it('根目录下的文件不引出请求', async () => {
    const paths = stubTree();
    openPinned('diff', 'README.md');
    // 给 effect 一拍的机会
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(expandedDirs.value.size).toBe(0);
    expect(paths).toEqual([]);
  });

  it('祖先目录已经不存在（整个目录被删）时展开态退回去，不留一个看不见的展开态', async () => {
    // `src` 还在、`src/old` 整个没了
    stubTree({ 'src/old': null });
    openPinned('diff', 'src/old/gone.ts');
    // 那一趟回来是 404：目录回来时那一行不该带着一句陈旧的错误直接展开，之后 reveal 它底下的
    // 文件也该再取一次。取到了的那一级照旧展开着
    await waitFor(() => expect(expandedDirs.value).toEqual(new Set(['src'])));
    expect(treeErrors.value.has('src/old')).toBe(false);
  });

  it('用户手动收起与全部折叠都不会被顶回去——effect 只订阅活动 tab，不订阅展开态', async () => {
    stubTree();
    openPinned('diff', 'src/web/a.ts');
    await waitFor(() => expect(expandedDirs.value.has('src/web')).toBe(true));

    toggleDir('src/web');
    // 再等一拍：让展开态进依赖集的写法会在这里把它重新展开
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(expandedDirs.value.has('src/web')).toBe(false);

    collapseAll();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(expandedDirs.value.size).toBe(0);
  });

  it('那一行挂上后滚进视野；刷新不重滚', async () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const paths = stubTree({
      src: [entry({ name: 'web', kind: 'directory', path: 'src/web' })],
      'src/web': [entry({ name: 'a.ts', path: 'src/web/a.ts' })],
    });
    openPinned('diff', 'src/web/a.ts');
    await waitFor(() => expect(paths).toEqual(['src', 'src/web']));
    // 根还没到：行没挂上，一次都没滚
    expect(scrolled).not.toHaveBeenCalled();

    treeCache.value = setIn(treeCache.value, ROOT, [entry({ name: 'src', kind: 'directory' })]);
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
    expect(scrolled.mock.instances[0]).toBe(rowOf('a.ts'));
    // 已经在视野里就一个像素都不动
    expect(scrolled.mock.calls[0]?.[0]).toMatchObject({ block: 'nearest' });

    // SSE 换一份同样的目录：行按路径 keyed、不重挂，不再滚
    treeCache.value = setIn(treeCache.value, 'src/web', [
      entry({ name: 'a.ts', path: 'src/web/a.ts' }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scrolled).toHaveBeenCalledTimes(1);
  });
});
