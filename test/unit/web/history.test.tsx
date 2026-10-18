// `History` 那一档：锚点分页、展开即取详情、commit tab 的键与高亮、SSE 下的取舍。fetch 一律打桩，
// 断言请求的 query 而不是字符串拼法。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type {
  CommitDetail,
  CommitPage,
  CommitSummary,
  IncomingPage,
  RepoState,
} from '../../../src/server/shared/protocol';
import { CommitDiffView } from '../../../src/web/components/DiffView';
import { commitTooltip, HistoryList, relativeTime } from '../../../src/web/components/HistoryList';
import { badgesBySha, refBadges } from '../../../src/web/state/badges';
import {
  activeEditor,
  activeEditorPath,
  contextOf,
  editorKey,
  editors,
  findEditor,
  keyOf,
  openCommitEditor,
  openEditor,
} from '../../../src/web/state/editors';
import {
  commitDetails,
  ensureHistory,
  ensureIncoming,
  expandedCommits,
  historyError,
  historyList,
  incomingError,
  incomingList,
  incomingRange,
  loadMore,
  mergeFirstPage,
  moreError,
  refreshHistory,
  toggleCommit,
} from '../../../src/web/state/history';
import {
  ensureGraphRefs,
  findUpstream,
  graphRefs,
  invalidateGraphRefs,
  loadRefs,
  refList,
  refsError,
} from '../../../src/web/state/refs';
import { historyCollapsed } from '../../../src/web/state/sidebar';
import {
  activateEditor,
  activeTab,
  commitDiffStates,
  expandContext,
  PATCH_DEFAULTS,
  refresh,
  repoState,
  selectCommitFile,
  toggleIgnoreWhitespace,
} from '../../../src/web/state/store';
import {
  actionOf,
  branch,
  expectEdgeAnchored,
  expectPlaceholderRow,
  hideHistory,
  ref,
  repo,
  resetEditors,
  resetHistory,
  stubClipboard,
  stubJsonBy,
  waitFor,
} from './helpers';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const commit = (n: number, extra: Partial<CommitSummary> = {}): CommitSummary => ({
  sha: sha(n),
  parents: [sha(n - 1)],
  author: 'Ann',
  time: 1_700_000_000,
  subject: `commit ${n}`,
  body: '',
  ...extra,
});
const page = (head: number, from: number, count: number, hasMore: boolean): CommitPage => ({
  head: sha(head),
  commits: Array.from({ length: count }, (_, i) => commit(from - i)),
  hasMore,
});
const query = (url: string) => new URLSearchParams(url.slice(url.indexOf('?')));

let container: HTMLElement;

beforeEach(() => {
  resetEditors();
  resetHistory();
  activeTab.value = 'changes';
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  vi.unstubAllGlobals();
});

describe('列表与翻页', () => {
  test('第二页带着第一页的锚点与已加载条数去问，接在后面', async () => {
    const calls = stubJsonBy((url) =>
      url.searchParams.has('head')
        ? { payload: page(100, 98, 2, false) }
        : { payload: page(100, 100, 2, true) },
    );
    await refreshHistory();
    await loadMore();
    const second = query(calls[1] as string);
    expect([second.get('head'), second.get('skip')]).toEqual([sha(100), '2']);
    expect(historyList.value?.commits.map((c) => c.subject)).toEqual([
      'commit 100',
      'commit 99',
      'commit 98',
      'commit 97',
    ]);
    expect(historyList.value?.hasMore).toBe(false);
  });

  test('重取第一页时 head 没变就什么都不换——已翻到的页留着', async () => {
    stubJsonBy((url) =>
      url.searchParams.has('head')
        ? { payload: page(100, 98, 2, false) }
        : { payload: page(100, 100, 2, true) },
    );
    await refreshHistory();
    await loadMore();
    const before = historyList.value;
    await refreshHistory();
    expect(historyList.value).toBe(before);
  });

  test('HEAD 往上长了几条：接在顶上，已翻到的页与展开集合都留着', async () => {
    let head = 100;
    stubJsonBy((url) => {
      if (url.pathname === '/api/commit')
        return { payload: { ...commit(99), files: [] } satisfies CommitDetail };
      if (url.searchParams.has('head')) return { payload: page(100, 98, 2, true) };
      return { payload: page(head, head, 2, true) };
    });
    await refreshHistory();
    await loadMore();
    toggleCommit(sha(99));
    head = 101;
    await refreshHistory();
    expect(historyList.value?.commits.map((c) => c.sha)).toEqual([101, 100, 99, 98, 97].map(sha));
    expect(historyList.value).toMatchObject({ head: sha(101), anchor: sha(100), offset: 1 });
    expect(expandedCommits.value.has(sha(99))).toBe(true);
  });

  test('接在顶上之后再翻页：锚点不动，skip 只数锚点之下那几条', async () => {
    let head = 100;
    const calls = stubJsonBy((url) =>
      url.searchParams.has('head')
        ? { payload: page(100, 98, 2, false) }
        : { payload: page(head, head, 2, true) },
    );
    await refreshHistory();
    head = 101;
    await refreshHistory();
    await loadMore();
    const more = query(calls.at(-1) as string);
    expect([more.get('head'), more.get('skip')]).toEqual([sha(100), '2']);
    expect(historyList.value?.commits.map((c) => c.sha)).toEqual([101, 100, 99, 98, 97].map(sha));
  });

  test('旧 HEAD 不在新的第一页里（amend / reset / 一次长出一整页）：整体替换', () => {
    const list = mergeFirstPage(null, page(100, 100, 2, true));
    const amended = page(200, 200, 2, true);
    expect(mergeFirstPage(list, amended)).toEqual({ ...amended, anchor: sha(200), offset: 0 });
    // 旧 HEAD 在、但往下那一截对不上（合并把别的提交排进了中间）：同样整体替换
    const interleaved: CommitPage = {
      head: sha(300),
      commits: [commit(300), commit(100), commit(55)],
      hasMore: true,
    };
    expect(mergeFirstPage(list, interleaved).anchor).toBe(sha(300));
  });

  test('翻页回来时列表已被整体替换——这一页是按旧锚点数的，丢掉', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let head = 100;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('head=')) await gate;
        const body = url.includes('head=') ? page(100, 98, 2, false) : page(head, head, 2, true);
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    await refreshHistory();
    const more = loadMore();
    head = 200;
    await refreshHistory();
    release();
    await more;
    expect(historyList.value?.commits.map((c) => c.sha)).toEqual([sha(200), sha(199)]);
  });
});

describe('HistoryList 组件', () => {
  test('空仓库说 No commits yet', () => {
    historyList.value = mergeFirstPage(null, { head: null, commits: [], hasMore: false });
    render(<HistoryList />, container);
    expect(container.textContent).toContain('No commits yet');
  });

  test('一行是主题 + 作者，两段同住一个 truncate span；短哈希进 title；hasMore 时末尾有加载哨兵', () => {
    historyList.value = mergeFirstPage(null, page(100, 100, 1, true));
    render(<HistoryList />, container);
    const row = container.querySelector('[aria-expanded]') as HTMLElement;
    // 拆成两个平级 flex 子项时两段按底边对齐——页面上只是「看着没对齐」，所以钉结构
    const label = row.querySelector('.truncate') as HTMLElement;
    expect(label.textContent).toBe('commit 100Ann');
    expect(label.lastElementChild?.textContent).toBe('Ann');
    expect(row.textContent).not.toContain(sha(100).slice(0, 7));
    expect(row.getAttribute('title')).toContain(sha(100).slice(0, 7));
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).toContain('Load more');
  });

  test('悬停提示的次序：主题、正文、哈希与作者时间同一行垫底；没有正文不留空段', () => {
    const now = (1_700_000_000 + 3 * 3600) * 1000;
    const withBody = commitTooltip(commit(100, { body: 'line 1\nline 2' }), now);
    const parts = withBody.split('\n\n');
    expect(parts).toEqual([
      'commit 100',
      'line 1\nline 2',
      expect.stringMatching(/ · Ann · 3 hours ago \(.+\)$/),
    ]);
    expect(withBody).toContain(`\n\n${sha(100).slice(0, 7)} · Ann · `);
    expect(withBody).not.toContain(sha(100));
    expect(commitTooltip(commit(100), now).split('\n\n')).toHaveLength(2);
  });

  describe('滚到底自动翻页', () => {
    /** happy-dom 的 IntersectionObserver 从不回调：换成一个记下回调、由用例手动触发的桩。 */
    let observers: { callback: IntersectionObserverCallback; disconnected: boolean }[];
    const live = () => observers.filter((o) => !o.disconnected);
    /** 哨兵的观察者挂在 effect 里，effect 要等一拍才跑。 */
    const mounted = () => waitFor(() => expect(live()).toHaveLength(1));
    const intersect = (visible = true) => {
      for (const o of live()) {
        o.callback(
          [{ isIntersecting: visible } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      }
    };
    beforeEach(() => {
      observers = [];
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          record: { callback: IntersectionObserverCallback; disconnected: boolean };
          constructor(callback: IntersectionObserverCallback) {
            this.record = { callback, disconnected: false };
            observers.push(this.record);
          }
          observe() {}
          disconnect() {
            this.record.disconnected = true;
          }
        },
      );
    });

    test('哨兵可见即按锚点取下一页；一页回来后换一个观察者，仍可见就接着取', async () => {
      historyList.value = mergeFirstPage(null, page(100, 100, 50, true));
      const calls = stubJsonBy((url) => {
        const skip = Number(url.searchParams.get('skip'));
        return { payload: page(100, 100 - skip, 2, skip < 52) };
      });
      render(<HistoryList />, container);
      await mounted();
      intersect(false);
      expect(calls).toHaveLength(0);
      intersect();
      await waitFor(() => expect(historyList.value?.commits).toHaveLength(52));
      expect(query(calls[0] as string).get('head')).toBe(sha(100));
      expect(query(calls[0] as string).get('skip')).toBe('50');
      // 旧观察者已断开，新换上的那个报一次初始状态
      // 等的是「第二个出现」：只等「活着的恰好一个」时，旧的那个在新 effect 跑之前就满足它
      await waitFor(() => expect(observers).toHaveLength(2));
      expect(live()).toHaveLength(1);
      intersect();
      await waitFor(() => expect(historyList.value?.commits).toHaveLength(54));
      expect(query(calls[1] as string).get('skip')).toBe('52');
      await waitFor(() => expect(container.textContent).not.toContain('Loading…'));
    });

    test('列表被整体换成条数相同的新第一页：换一个观察者，不停在半截；按钮不重挂', async () => {
      historyList.value = mergeFirstPage(null, page(100, 100, 50, true));
      stubJsonBy(() => ({ payload: page(100, 50, 2, false) }));
      render(<HistoryList />, container);
      await mounted();
      const button = container.querySelector('li:last-child > button');
      // amend 之后换上来的新第一页：锚点换了，条数还是 50
      historyList.value = mergeFirstPage(historyList.value, page(300, 300, 50, true));
      await waitFor(() => expect(observers).toHaveLength(2));
      expect(live()).toHaveLength(1);
      // 同一个元素：重挂会把键盘焦点丢回 body
      expect(container.querySelector('li:last-child > button')).toBe(button);
    });

    test('空闲时是一枚 Load more 按钮，在取时写 Loading… 并 disabled', async () => {
      historyList.value = mergeFirstPage(null, page(100, 100, 50, true));
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          await gate;
          return new Response(JSON.stringify(page(100, 50, 2, false)), { status: 200 });
        }),
      );
      render(<HistoryList />, container);
      const button = () => container.querySelector('li:last-child > button') as HTMLButtonElement;
      expect(button().textContent).toBe('Load more');
      expect(button().disabled).toBe(false);
      button().click();
      await waitFor(() => expect(button().textContent).toBe('Loading…'));
      expect(button().disabled).toBe(true);
      release();
      await waitFor(() => expect(historyList.value?.commits).toHaveLength(52));
    });

    test('失败后不自动重试：哨兵再可见也不发请求，点一下才重试', async () => {
      historyList.value = mergeFirstPage(null, page(100, 100, 50, true));
      let fail = true;
      const calls = stubJsonBy(() =>
        fail ? { status: 500, payload: { error: 'boom' } } : { payload: page(100, 50, 2, false) },
      );
      render(<HistoryList />, container);
      await mounted();
      intersect();
      await waitFor(() => expect(moreError.value).not.toBeNull());
      intersect();
      expect(calls).toHaveLength(1);
      const retryButton = () =>
        [...container.querySelectorAll('button')].find((b) =>
          b.textContent?.includes('click to retry'),
        );
      await waitFor(() => expect(retryButton()).toBeDefined());
      const retry = retryButton() as HTMLButtonElement;
      fail = false;
      retry.click();
      await waitFor(() => expect(historyList.value?.commits).toHaveLength(52));
      expect(calls).toHaveLength(2);
    });
  });

  test('提交行的 Copy commit hash 写入完整 sha、换成 Copied，且不顺带展开这条提交', async () => {
    historyList.value = mergeFirstPage(null, page(100, 100, 1, false));
    const writeText = stubClipboard();
    const calls = stubJsonBy(() => ({ payload: { ...commit(100), files: [] } }));
    render(<HistoryList />, container);
    const row = container.querySelector('[aria-expanded]') as HTMLElement;
    const copy = actionOf(row, 'Copy commit hash');
    expect(copy).not.toBeNull();
    // 提交行没有状态记号：按钮贴行的右内边距
    expectEdgeAnchored(row);

    copy?.click();
    expect(writeText).toHaveBeenCalledWith(sha(100));
    await waitFor(() => expect(actionOf(row, 'Copied')).not.toBeNull());
    // 按钮是行按钮的兄弟：点它不经过行按钮，既不展开也不去取详情
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(calls).toEqual([]);
  });

  test('浅克隆的边界：不画文件清单，说清楚父提交不在本地', async () => {
    historyList.value = mergeFirstPage(null, page(100, 100, 1, false));
    stubJsonBy(() => ({ payload: { ...commit(100), parents: [], files: [], shallow: true } }));
    render(<HistoryList />, container);
    (container.querySelector('[aria-expanded]') as HTMLElement).click();
    await waitFor(() => expect(container.textContent).toContain('Shallow clone'));
    // 占位与目录树同一副行骨架
    expectPlaceholderRow(container, 'Shallow clone — parent not available');
  });

  test('单击展开才取详情；文件行单击开预览 commit tab、双击固定', async () => {
    historyList.value = mergeFirstPage(null, page(100, 100, 1, false));
    const detail: CommitDetail = {
      ...commit(100),
      files: [{ path: 'src/b.ts', oldPath: 'src/a.ts', status: 'R' }],
    };
    const calls = stubJsonBy((url) =>
      url.pathname === '/api/commit'
        ? { payload: detail }
        : { payload: { kind: 'text', patch: 'p\n', full: false } },
    );
    render(<HistoryList />, container);
    expect(calls).toEqual([]);

    (container.querySelector('[aria-expanded]') as HTMLElement).click();
    await waitFor(() => expect(container.textContent).toContain('b.ts'));
    expect(container.textContent).toContain('← src/a.ts');
    // 不画 Open file：那枚开的是工作区此刻的全文，与这一行说的那一版不是同一份
    expect(container.querySelector('[aria-label="Open file"]')).toBeNull();

    const fileRow = container.querySelector('[title="src/b.ts"]') as HTMLElement;
    fileRow.click();
    await waitFor(() =>
      expect(commitDiffStates.value.get(editorKey('commit', 'src/b.ts', sha(100)))?.status).toBe(
        'ready',
      ),
    );
    const diffCall = query(calls.find((url) => url.startsWith('/api/commit-diff')) as string);
    expect([diffCall.get('sha'), diffCall.get('path'), diffCall.get('oldPath')]).toEqual([
      sha(100),
      'src/b.ts',
      'src/a.ts',
    ]);
    expect(activeEditor.value).toMatchObject({ kind: 'commit', sha: sha(100), pinned: false });

    fileRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(activeEditor.value?.pinned).toBe(true);
  });
});

describe('同一时刻只有一次在途', () => {
  test('第一页还没回来时再刷新：搭上那一次，回来后补跑一次——叫多少次都只补一次', async () => {
    let head = 1;
    const calls = stubJsonBy(() => ({ payload: page(head, head, 1, false) }));
    const first = refreshHistory();
    // 在途期间 HEAD 挪了、又来了三个 SSE：在途那一次是挪动之前发的，搭车不等于拿到了答案
    head = 2;
    expect(refreshHistory()).toBe(first);
    refreshHistory();
    refreshHistory();
    await first;
    expect(calls.filter((url) => url.startsWith('/api/commits'))).toHaveLength(2);
    expect(historyList.value?.head).toBe(sha(2));
    // 都落定之后再刷新照常发
    await refreshHistory();
    expect(calls.filter((url) => url.startsWith('/api/commits'))).toHaveLength(3);
  });

  test('commit tab 的补丁在途时切回去：不另发——新票会作废旧票，慢补丁永远落不了地', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        await gate;
        return new Response(JSON.stringify({ kind: 'text', patch: 'p\n', full: false }), {
          status: 200,
        });
      }),
    );
    selectCommitFile(sha(1), { path: 'a.ts', status: 'M' });
    openEditor('diff', 'other.ts', true);
    activateEditor(editorKey('commit', 'a.ts', sha(1)));
    release();
    await waitFor(() =>
      expect(commitDiffStates.value.get(editorKey('commit', 'a.ts', sha(1)))?.status).toBe('ready'),
    );
    expect(calls.filter((url) => url.startsWith('/api/commit-diff'))).toHaveLength(1);
  });
});

describe('commit tab', () => {
  test('键带 sha：同一个文件在两次提交里是两个 tab', () => {
    openCommitEditor(sha(1), 'a.ts', undefined, true);
    openCommitEditor(sha(2), 'a.ts', undefined, true);
    expect(editors.value.map(keyOf)).toEqual([
      editorKey('commit', 'a.ts', sha(1)),
      editorKey('commit', 'a.ts', sha(2)),
    ]);
    expect(keyOf(editors.value[0] as never)).toBe(`commit:${sha(1)}:a.ts`);
  });

  test('活动时两栏不高亮——同名那一行说的是工作区那一份', () => {
    openCommitEditor(sha(1), 'a.ts', undefined, false);
    expect(activeEditorPath.value).toBeNull();
    openEditor('diff', 'a.ts');
    expect(activeEditorPath.value).toBe('a.ts');
  });

  test('已经取到过就不再取：一次提交不可变', async () => {
    const calls = stubJsonBy(() => ({ payload: { kind: 'text', patch: 'p\n', full: false } }));
    selectCommitFile(sha(1), { path: 'a.ts', status: 'M' });
    await waitFor(() =>
      expect(commitDiffStates.value.get(editorKey('commit', 'a.ts', sha(1)))?.status).toBe('ready'),
    );
    selectCommitFile(sha(1), { path: 'a.ts', status: 'M' });
    expect(calls.filter((url) => url.startsWith('/api/commit-diff'))).toHaveLength(1);
  });

  test('顶上那一行只给合并提交：普通提交不画，合并提交写明对比的是第一父', () => {
    commitDiffStates.value = new Map([
      [
        editorKey('commit', 'a.ts', sha(2)),
        { status: 'ready', rename: null, payload: { kind: 'binary' }, options: PATCH_DEFAULTS },
      ],
    ]);
    const ready = (parents: string[]) =>
      new Map([
        [sha(2), { status: 'ready' as const, detail: { ...commit(2, { parents }), files: [] } }],
      ]);
    commitDetails.value = ready([sha(1)]);
    render(<CommitDiffView sha={sha(2)} path="a.ts" />, container);
    expect(container.textContent).not.toContain('commit 2');
    expect(container.textContent).not.toContain('Merge commit');

    commitDetails.value = ready([sha(1), sha(9)]);
    render(<CommitDiffView sha={sha(2)} path="a.ts" />, container);
    expect(container.textContent).toContain('Merge commit · compared with first parent');
  });

  test('上次没取到：切回这个 tab 就重试，并带上旧路径', async () => {
    let fail = true;
    const calls = stubJsonBy(() =>
      fail
        ? { payload: { error: { code: 'internal', message: 'boom' } }, status: 500 }
        : { payload: { kind: 'text', patch: 'p\n', full: false } },
    );
    selectCommitFile(sha(1), { path: 'b.ts', oldPath: 'a.ts', status: 'R' });
    const key = editorKey('commit', 'b.ts', sha(1));
    await waitFor(() => expect(commitDiffStates.value.get(key)?.status).toBe('error'));
    openEditor('diff', 'other.ts', true);
    fail = false;
    activateEditor(editorKey('commit', 'b.ts', sha(1)));
    await waitFor(() => expect(commitDiffStates.value.get(key)?.status).toBe('ready'));
    expect(query(calls.at(-1) as string).get('oldPath')).toBe('a.ts');
  });
});

describe('commit tab 的两个补丁开关', () => {
  const key = editorKey('commit', 'a.ts', sha(1));
  const stateOf = () => commitDiffStates.value.get(key);
  const diffCalls = (calls: readonly string[]) =>
    calls.filter((url) => url.startsWith('/api/commit-diff'));

  test('切了忽略空白：照常显示旧补丁、记一笔在取；在取期间 SSE 不再发第二趟', async () => {
    let release: (() => void) | undefined;
    const calls = stubJsonBy(() => ({ payload: { kind: 'text', patch: 'p\n', full: false } }));
    selectCommitFile(sha(1), { path: 'a.ts', status: 'M' });
    await waitFor(() => expect(stateOf()?.status).toBe('ready'));

    // 下一趟挂住不回：看「在取」那一段
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return new Response(JSON.stringify({ kind: 'text', patch: 'q\n', full: false }));
      }),
    );
    toggleIgnoreWhitespace();
    await waitFor(() => expect(diffCalls(calls)).toHaveLength(2));
    expect(query(diffCalls(calls)[1] as string).get('ignoreWhitespace')).toBe('1');
    // 不回退 loading：回退会把表格连同展开状态一起卸掉
    expect(stateOf()).toMatchObject({ status: 'ready', pending: { ignoreWhitespace: true } });

    activateEditor(key);
    expect(diffCalls(calls)).toHaveLength(2);

    release?.();
    await waitFor(() =>
      expect(stateOf()).toMatchObject({
        status: 'ready',
        options: { ignoreWhitespace: true, fullContext: false },
      }),
    );
    expect(stateOf()).not.toHaveProperty('pending');
    // 落地之后这一档与此刻一致：再切回来也不取
    activateEditor(key);
    expect(diffCalls(calls)).toHaveLength(2);
  });

  test('点开折叠行：带 fullContext=1 重取；回来的不是整份上下文就记成 unavailable', async () => {
    const calls = stubJsonBy(() => ({ payload: { kind: 'text', patch: 'p\n', full: false } }));
    selectCommitFile(sha(1), { path: 'a.ts', status: 'M' });
    await waitFor(() => expect(stateOf()?.status).toBe('ready'));

    expandContext(key);
    await waitFor(() => expect(diffCalls(calls)).toHaveLength(2));
    expect(query(diffCalls(calls)[1] as string).get('fullContext')).toBe('1');
    await waitFor(() => expect(contextOf(findEditor(key))).toBe('unavailable'));

    // 手上那份记成 3 行那一档：后端退回的正是它，再取一趟只会拿到逐字相同的补丁
    expect(stateOf()).toMatchObject({ options: { fullContext: false } });
    // unavailable 之后再点什么都不做；切回来也不再取
    expandContext(key);
    activateEditor(key);
    expect(stateOf()?.status).toBe('ready');
    expect(diffCalls(calls)).toHaveLength(2);
  });
});

describe('refresh 对 History 那一半', () => {
  const state = repo();

  test('commit tab 不收编、不重取——工作区变了与它无关', async () => {
    // 提交列表不在这条的射程里：折起分区，`refresh` 就只剩 `/api/state` 一趟
    hideHistory();
    openCommitEditor(sha(1), 'a.ts', undefined, true);
    commitDiffStates.value = new Map([
      [
        editorKey('commit', 'a.ts', sha(1)),
        { status: 'ready', rename: null, payload: { kind: 'binary' }, options: PATCH_DEFAULTS },
      ],
    ]);
    const calls = stubJsonBy(() => ({ payload: state }));
    await refresh();
    expect(editors.value).toHaveLength(1);
    expect(calls).toEqual(['/api/state']);
    repoState.value = null;
  });

  test('History 可见且 HEAD 挪了才重取第一页；HEAD 没挪、或不可见时一条都不发', async () => {
    activeTab.value = 'files';
    let oid = sha(1);
    const calls = stubJsonBy((url) =>
      url.pathname === '/api/state'
        ? { payload: { ...state, branch: { ...state.branch, oid } } }
        : { payload: page(Number.parseInt(oid, 16), Number.parseInt(oid, 16), 1, false) },
    );
    const commitsCalls = () => calls.filter((url) => url.startsWith('/api/commits')).length;
    await refresh();
    expect(commitsCalls()).toBe(0);
    // 回到 `Changes` 档但分区折着：同样看不见
    activeTab.value = 'changes';
    historyCollapsed.value = true;
    await refresh();
    expect(commitsCalls()).toBe(0);

    historyCollapsed.value = false;
    await refresh();
    expect(commitsCalls()).toBe(1);
    // 工作区改动推来的 SSE：HEAD 没挪，不起 `git log`
    await refresh();
    await refresh();
    expect(commitsCalls()).toBe(1);

    oid = sha(2);
    await refresh();
    expect(commitsCalls()).toBe(2);
    expect(historyList.value?.head).toBe(sha(2));
    repoState.value = null;
  });

  test('上一次取失败了：HEAD 没挪也重试', async () => {
    let fail = true;
    const calls = stubJsonBy((url) => {
      if (url.pathname === '/api/state')
        return { payload: { ...state, branch: { ...state.branch, oid: sha(1) } } };
      return fail
        ? { payload: { error: { code: 'internal', message: 'busy' } }, status: 500 }
        : { payload: page(1, 1, 1, false) };
    });
    await refresh();
    expect(historyError.value).toBe('busy');
    fail = false;
    await refresh();
    expect(historyError.value).toBeNull();
    expect(calls.filter((url) => url.startsWith('/api/commits'))).toHaveLength(2);
    repoState.value = null;
  });
});

test('relativeTime：一分钟以内是 now，其余取最大的那一档', () => {
  const now = 1_700_000_000_000;
  expect(relativeTime(now / 1000 - 30, now)).toBe('now');
  // 时钟漂移：未来的时间不说「in 10 minutes」
  expect(relativeTime(now / 1000 + 600, now)).toBe('now');
  expect(relativeTime(now / 1000 - 3 * 3600, now)).toBe('3 hours ago');
  expect(relativeTime(now / 1000 - 24 * 3600, now)).toBe('yesterday');
});

describe('ref 徽标', () => {
  const tracking = (extra: Partial<RepoState['branch']> = {}) =>
    branch({ upstream: { name: 'origin/main', ahead: 2, behind: 0 }, oid: sha(100), ...extra });
  const remote = (n: number) => ref('remote', 'origin/main', { sha: sha(n) });

  const head = (name: string) => ({ role: 'head', kind: 'local', name });
  const up = (kind: 'local' | 'remote', name: string) => ({ role: 'upstream', kind, name });
  const group = (kind: 'local' | 'remote' | 'tag', ...names: string[]) => ({
    role: 'group',
    kind,
    names,
  });

  test('当前分支那枚画在 HEAD 上、不看 refs；上游那枚画在它指着的那条', () => {
    const badges = refBadges('main', sha(100), remote(98), []);
    expect(badges.get(sha(100))).toEqual([head('main')]);
    expect(badges.get(sha(98))).toEqual([up('remote', 'origin/main')]);
    expect(refBadges('main', sha(100), null, []).get(sha(100))).toEqual([head('main')]);
    // 上游是本地分支时 kind 也是 local，靠角色认出它是上游（只画图标的是它）
    expect(
      refBadges('main', sha(100), ref('local', 'base', { sha: sha(95) }), []).get(sha(95)),
    ).toEqual([up('local', 'base')]);
  });

  test('已同步时两枚落在同一条上，本地在前；没有分支（detached）时没有本地那枚', () => {
    expect(
      refBadges('main', sha(100), remote(100), [])
        .get(sha(100))
        ?.map((b) => b.role),
    ).toEqual(['head', 'upstream']);
    expect(refBadges('', sha(100), remote(100), []).get(sha(100))).toEqual([
      up('remote', 'origin/main'),
    ]);
  });

  test('其余的 ref 按种类合成，次序本地、远程、标签，排在带色那两枚之后', () => {
    const refs = [
      ref('local', 'feature', { sha: sha(100) }),
      ref('remote', 'origin/feature', { sha: sha(100) }),
      ref('tag', 'v1.1', { sha: sha(100) }),
      ref('tag', 'v1.0', { sha: sha(100) }),
      ref('tag', 'v0.9', { sha: sha(97) }),
    ];
    const badges = refBadges('main', sha(100), null, refs);
    expect(badges.get(sha(100))).toEqual([
      head('main'),
      group('local', 'feature'),
      group('remote', 'origin/feature'),
      group('tag', 'v1.1', 'v1.0'),
    ]);
    expect(badges.get(sha(97))).toEqual([group('tag', 'v0.9')]);
  });

  test('与当前分支、上游同名的那条不再进合成那枚——按名字认，refs 里的 sha 可能已经过时', () => {
    const refs = [
      // HEAD 已经挪到 100，refs 还是 HEAD 在 99 时取的
      ref('local', 'main', { sha: sha(99) }),
      remote(98),
      // 名字相同、种类不同的不算：同名标签照样画
      ref('tag', 'main', { sha: sha(99) }),
    ];
    const badges = refBadges('main', sha(100), remote(98), refs);
    expect(badges.get(sha(100))).toEqual([head('main')]);
    expect(badges.get(sha(99))).toEqual([group('tag', 'main')]);
    expect(badges.get(sha(98))).toEqual([up('remote', 'origin/main')]);
  });

  test('按 git 解析缩写 refname 的次序找上游：名字有歧义时 git 带的前缀照样对得上；标签不算', () => {
    // 实测 2.54：有个标签也叫 `main` → `heads/main`；有个本地分支也叫 `origin/main` → `remotes/origin/main`
    const refs = [
      ref('tag', 'main', { sha: sha(97) }),
      ref('local', 'main', { sha: sha(99) }),
      ref('local', 'origin/main', { sha: sha(96) }),
      remote(98),
    ];
    expect(findUpstream(refs, 'heads/main')?.sha).toBe(sha(99));
    expect(findUpstream(refs, 'remotes/origin/main')?.sha).toBe(sha(98));
    expect(findUpstream(refs, 'refs/remotes/origin/main')?.sha).toBe(sha(98));
    expect(findUpstream(refs, 'refs/heads/origin/main')?.sha).toBe(sha(96));
    // 没有歧义时是光名字：本地分支（上游可以是本地分支）与远程分支都认
    expect(findUpstream([ref('local', 'base', { sha: sha(95) })], 'base')?.sha).toBe(sha(95));
    expect(findUpstream([remote(98)], 'origin/main')?.sha).toBe(sha(98));
    expect(findUpstream([ref('tag', 'base')], 'base')).toBeNull();
  });

  test('徽标排在 truncate span 之后，不在里面——省略号吃不到它', () => {
    historyList.value = mergeFirstPage(null, page(100, 100, 3, false));
    repoState.value = repo({ branch: tracking() });
    graphRefs.value = [
      remote(98),
      ref('tag', 'v1.0', { sha: sha(99) }),
      ref('tag', 'v0.9', { sha: sha(98) }),
      ref('tag', 'v0.8', { sha: sha(98) }),
    ];
    render(<HistoryList />, container);
    const rows = [...container.querySelectorAll('[aria-expanded]')] as HTMLElement[];
    // [title, aria-label, 印出来的字]：只有当前分支那枚印名字；上游只画图标；合成那枚多于一条时印条数，
    // 名字在 title 里一行一个
    const badges = (row: HTMLElement) =>
      [...row.querySelectorAll(':scope > [role="img"]')].map((el) => [
        el.getAttribute('title'),
        el.getAttribute('aria-label'),
        el.textContent,
      ]);
    expect(rows.map(badges)).toEqual([
      [['main', 'main', 'main']],
      [['v1.0', 'v1.0', '']],
      [
        ['origin/main', 'origin/main', ''],
        ['v0.9\nv0.8', 'v0.9, v0.8', '2'],
      ],
    ]);
    const label = rows[0]?.querySelector('.truncate') as HTMLElement;
    expect(label.textContent).toBe('commit 100Ann');
    // 少了 grow 时徽标紧跟主题，各行横向位置随主题长短乱跳
    expect(label.classList.contains('grow')).toBe(true);
    repoState.value = null;
  });

  test('上游名换了、新的 refs 还没回来：拿此刻的名字去推，不把上一个上游的位置画成这一个', () => {
    graphRefs.value = [remote(98)];
    repoState.value = repo({ branch: tracking() });
    expect(badgesBySha.value.get(sha(98))).toEqual([up('remote', 'origin/main')]);
    repoState.value = repo({
      branch: tracking({ upstream: { name: 'origin/dev', ahead: 1, behind: 0 } }),
    });
    // origin/main 不再是上游：退回成合成的那枚，而不是继续顶着上游的角色
    expect(badgesBySha.value.get(sha(98))).toEqual([group('remote', 'origin/main')]);
    repoState.value = null;
  });

  test('SSE 换了一份 repoState 而分支状态没变：徽标表不重建，带徽标的行就不重画', () => {
    repoState.value = repo({ branch: tracking() });
    const before = badgesBySha.value;
    repoState.value = repo({ branch: tracking() });
    expect(badgesBySha.value).toBe(before);
    repoState.value = repo({ branch: tracking({ oid: sha(101) }) });
    expect(badgesBySha.value).not.toBe(before);
    repoState.value = null;
  });

  test('refs 重取回来内容没变、或 HEAD 挪了：没挪的那几格还是原来那个数组，行不重画', () => {
    repoState.value = repo({ branch: tracking() });
    graphRefs.value = [remote(98), ref('tag', 'v1.0', { sha: sha(97) })];
    const before = badgesBySha.value;
    const tag = before.get(sha(97));
    graphRefs.value = [remote(98), ref('tag', 'v1.0', { sha: sha(97) })];
    expect(badgesBySha.value).toBe(before);
    repoState.value = repo({ branch: tracking({ oid: sha(101) }) });
    expect(badgesBySha.value).not.toBe(before);
    expect(badgesBySha.value.get(sha(97))).toBe(tag);
    expect(badgesBySha.value.get(sha(101))).toEqual([head('main')]);
    repoState.value = null;
  });

  describe('refresh 对徽标 refs 的取舍', () => {
    let upstream: RepoState['branch']['upstream'];
    let oid: string;
    let failRefs: boolean;
    let calls: string[];
    const refsCalls = () => calls.filter((url) => url === '/api/refs').length;

    beforeEach(() => {
      upstream = { name: 'origin/main', ahead: 2, behind: 0 };
      oid = sha(100);
      failRefs = false;
      calls = stubJsonBy((url) => {
        if (url.pathname === '/api/state')
          return { payload: repo({ branch: tracking({ upstream, oid }) }) };
        if (url.pathname === '/api/refs')
          return failRefs
            ? { payload: { error: { code: 'internal', message: 'busy' } }, status: 500 }
            : { payload: { refs: [remote(98)] } };
        return { payload: page(Number.parseInt(oid, 16), Number.parseInt(oid, 16), 3, false) };
      });
    });
    afterEach(() => {
      repoState.value = null;
      refList.value = null;
      refsError.value = null;
    });

    test('分支状态没变就不重取；push 只挪了上游（HEAD 没动）也要重取', async () => {
      await refresh();
      expect(refsCalls()).toBe(1);
      expect(badgesBySha.value.get(sha(98))).toEqual([up('remote', 'origin/main')]);
      await refresh();
      await refresh();
      expect(refsCalls()).toBe(1);
      upstream = { name: 'origin/main', ahead: 0, behind: 0 };
      await refresh();
      expect(refsCalls()).toBe(2);
      oid = sha(101);
      await refresh();
      expect(refsCalls()).toBe(3);
    });

    test('看不见时一条都不发；没有上游也照样取——标签与其余分支要它', async () => {
      historyCollapsed.value = true;
      await refresh();
      expect(refsCalls()).toBe(0);
      historyCollapsed.value = false;
      upstream = null;
      await refresh();
      expect(refsCalls()).toBe(1);
      await refresh();
      expect(refsCalls()).toBe(1);
    });

    test('判据被作废（History 藏起过）：分支状态没变也重取，旧的那份回来之前照画', async () => {
      await refresh();
      expect(refsCalls()).toBe(1);
      invalidateGraphRefs();
      expect(graphRefs.value).toHaveLength(1);
      await refresh();
      expect(refsCalls()).toBe(2);
    });

    test('上游被取消后再设回、四样与当初一字不差：照样重取——没有上游那一刻判据已经变过', async () => {
      await refresh();
      expect(refsCalls()).toBe(1);
      upstream = null;
      await refresh();
      expect(refsCalls()).toBe(2);
      upstream = { name: 'origin/main', ahead: 2, behind: 0 };
      await refresh();
      expect(refsCalls()).toBe(3);
    });

    test('上一次取失败了：分支状态没变也重试', async () => {
      failRefs = true;
      await refresh();
      expect(graphRefs.value).toBeNull();
      failRefs = false;
      await refresh();
      expect(refsCalls()).toBe(2);
      expect(graphRefs.value).toHaveLength(1);
    });

    test('与分支列表不共用状态：徽标那次失败不碰列表，列表那次失败不碰徽标', async () => {
      refList.value = [ref('local', 'main')];
      failRefs = true;
      await refresh();
      expect(refList.value).toHaveLength(1);
      expect(refsError.value).toBeNull();

      failRefs = false;
      await refresh();
      expect(graphRefs.value).toHaveLength(1);
      failRefs = true;
      await loadRefs();
      expect(refsError.value).toBe('busy');
      expect(graphRefs.value).toHaveLength(1);
    });

    test('被后一次顶掉、而后一次失败了：仍按失败算，下一次判即重试', async () => {
      // 第一次挂着不回，第二次（分支状态变了）失败——第一次回来时已经过期，什么都不改
      let release: () => void = () => {};
      let first = true;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          calls.push(url);
          if (url === '/api/refs' && first) {
            first = false;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return new Response(JSON.stringify({ refs: [remote(97)] }));
          }
          if (url === '/api/refs')
            return new Response(JSON.stringify({ error: { code: 'internal', message: 'busy' } }), {
              status: 500,
            });
          return new Response(JSON.stringify(repo({ branch: tracking({ upstream, oid }) })));
        }),
      );
      const pending = ensureGraphRefs(repo({ branch: tracking() }));
      await ensureGraphRefs(repo({ branch: tracking({ oid: sha(101) }) }));
      release();
      await pending;
      expect(graphRefs.value).toBeNull();
      // 分支状态与失败那次相同，照样重取
      await ensureGraphRefs(repo({ branch: tracking({ oid: sha(101) }) }));
      expect(refsCalls()).toBe(3);
    });
  });
});

describe('incoming 段', () => {
  const behindBy = (behind: number, extra: Partial<RepoState['branch']> = {}) =>
    branch({ upstream: { name: 'origin/main', ahead: 0, behind }, oid: sha(100), ...extra });
  const remote = (n: number) => ref('remote', 'origin/main', { sha: sha(n) });
  const incoming = (from: number, count: number, hasMore = false): IncomingPage => ({
    commits: Array.from({ length: count }, (_, i) => commit(from - i)),
    hasMore,
  });

  test('incomingRange：不落后、没有上游、HEAD 未出生、refs 里找不到上游都是 null；refs 没到是说不准', () => {
    const refs = [remote(200)];
    expect(incomingRange(repo({ branch: behindBy(2) }), refs)).toEqual({
      head: sha(100),
      upstream: sha(200),
    });
    expect(incomingRange(repo({ branch: behindBy(0) }), refs)).toBeNull();
    expect(incomingRange(repo({ branch: branch({ oid: sha(100) }) }), refs)).toBeNull();
    const { oid: _, ...unborn } = behindBy(2);
    expect(incomingRange(repo({ branch: unborn }), refs)).toBeNull();
    expect(incomingRange(repo({ branch: behindBy(2) }), [ref('tag', 'origin/main')])).toBeNull();
    expect(incomingRange(repo({ branch: behindBy(2) }), null)).toBeUndefined();
  });

  describe('refresh 对 incoming 的取舍', () => {
    let behind: number;
    let upstreamSha: number;
    let failIncoming: boolean;
    let calls: string[];
    const incomingCalls = () => calls.filter((url) => url.startsWith('/api/commits/incoming'));

    beforeEach(() => {
      behind = 2;
      upstreamSha = 200;
      failIncoming = false;
      calls = stubJsonBy((url) => {
        if (url.pathname === '/api/state') return { payload: repo({ branch: behindBy(behind) }) };
        if (url.pathname === '/api/refs') return { payload: { refs: [remote(upstreamSha)] } };
        if (url.pathname === '/api/commits/incoming')
          return failIncoming
            ? { payload: { error: { code: 'internal', message: 'busy' } }, status: 500 }
            : { payload: incoming(upstreamSha, behind) };
        return { payload: page(100, 100, 3, false) };
      });
    });
    afterEach(() => {
      repoState.value = null;
    });

    test('带着 HEAD oid 与 refs 里上游的 sha 去问；两样都没变就不重取，上游挪了（fetch）才重取', async () => {
      await refresh();
      expect(incomingCalls()).toHaveLength(1);
      const asked = query(incomingCalls()[0] as string);
      expect([asked.get('head'), asked.get('upstream')]).toEqual([sha(100), sha(200)]);
      expect(incomingList.value?.commits.map((c) => c.sha)).toEqual([sha(200), sha(199)]);
      await refresh();
      expect(incomingCalls()).toHaveLength(1);
      // fetch 之后上游多了一条：behind 变了 → refs 重取 → 上游 sha 变了
      behind = 3;
      upstreamSha = 201;
      await refresh();
      expect(incomingCalls()).toHaveLength(2);
      expect(query(incomingCalls()[1] as string).get('upstream')).toBe(sha(201));
      expect(incomingList.value?.commits).toHaveLength(3);
    });

    test('不再落后（pull 之后）：清空、不发请求', async () => {
      await refresh();
      expect(incomingList.value).not.toBeNull();
      behind = 0;
      await refresh();
      expect(incomingList.value).toBeNull();
      expect(incomingCalls()).toHaveLength(1);
    });

    test('History 看不见时一条都不发', async () => {
      historyCollapsed.value = true;
      onTestFinished(() => {
        historyCollapsed.value = false;
      });
      await refresh();
      expect(incomingCalls()).toHaveLength(0);
    });

    test('取失败：只记这一段的错误、主列表照常；两端没变也重试', async () => {
      failIncoming = true;
      await refresh();
      expect(incomingError.value).toBe('busy');
      expect(incomingList.value).toBeNull();
      expect(historyList.value?.commits).toHaveLength(3);
      failIncoming = false;
      await refresh();
      expect(incomingCalls()).toHaveLength(2);
      expect(incomingError.value).toBeNull();
      expect(incomingList.value?.commits).toHaveLength(2);
    });

    test('在途期间不再落后：回来的那份不算数，不把清掉的段又画回来', async () => {
      let release: () => void = () => {};
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.startsWith('/api/commits/incoming')) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return new Response(JSON.stringify(incoming(200, 2)));
          }
          return new Response(JSON.stringify({ refs: [remote(200)] }));
        }),
      );
      await ensureGraphRefs(repo({ branch: behindBy(2) }));
      const pending = ensureIncoming(repo({ branch: behindBy(2) }));
      await ensureIncoming(repo({ branch: behindBy(0) }));
      release();
      await pending;
      expect(incomingList.value).toBeNull();
    });

    test('fetch 之后新 refs 还在途：不拿旧 refs 里 fetch 之前的上游 sha 去问', async () => {
      let release: () => void = () => {};
      const asked: string[] = [];
      let refsCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          asked.push(url);
          if (url.startsWith('/api/refs') && refsCalls++ > 0)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          if (url.startsWith('/api/commits/incoming'))
            return new Response(JSON.stringify(incoming(201, 3)));
          return new Response(JSON.stringify({ refs: [remote(refsCalls > 1 ? 201 : 100)] }));
        }),
      );
      await ensureGraphRefs(repo({ branch: behindBy(0) }));
      // behind 变了：refs 重取并卡在途中，此刻手里那份还是 fetch 之前的
      const pending = ensureGraphRefs(repo({ branch: behindBy(3) }));
      await ensureIncoming(repo({ branch: behindBy(3) }));
      expect(asked.filter((url) => url.startsWith('/api/commits/incoming'))).toHaveLength(0);
      release();
      await pending;
      await ensureIncoming(repo({ branch: behindBy(3) }));
      const incomingAsks = asked.filter((url) => url.startsWith('/api/commits/incoming'));
      expect(incomingAsks).toHaveLength(1);
      expect(query(incomingAsks[0] as string).get('upstream')).toBe(sha(201));
    });
  });

  test('被顶掉的那次 refs 最后才回来：拿最新的 state 判，不把 pull 之前那一段画回来', async () => {
    const calls: string[] = [];
    let release: () => void = () => {};
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === '/api/refs' && first) {
          first = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        if (url === '/api/refs') return new Response(JSON.stringify({ refs: [remote(200)] }));
        if (url.startsWith('/api/commits/incoming'))
          return new Response(JSON.stringify(incoming(200, 2)));
        return new Response(JSON.stringify(page(100, 100, 3, false)));
      }),
    );
    const stale = ensureHistory(repo({ branch: behindBy(2) }));
    await ensureHistory(repo({ branch: behindBy(0) }));
    release();
    await stale;
    expect(incomingList.value).toBeNull();
    expect(calls.filter((url) => url.startsWith('/api/commits/incoming'))).toHaveLength(0);
  });

  describe('HistoryList 里的那一段', () => {
    beforeEach(() => {
      historyList.value = mergeFirstPage(null, page(100, 100, 2, false));
      repoState.value = repo({ branch: behindBy(5) });
    });
    afterEach(() => {
      repoState.value = null;
    });

    test('没有 incoming 时不画小标题', () => {
      render(<HistoryList />, container);
      expect(container.textContent).not.toContain('Incoming');
    });

    test('小标题带 status 的 behind、提示是上次 fetch；行排在主列表之前；还有更多时末尾写 +M more', () => {
      incomingList.value = incoming(203, 3, true);
      render(<HistoryList />, container);
      const heading = container.querySelector('h3') as HTMLElement;
      expect(heading.textContent).toBe('Incoming · 5↓');
      expect(heading.getAttribute('title')).toBe('As of the last fetch');
      const subjects = [...container.querySelectorAll('[aria-expanded]')].map(
        (row) => row.querySelector('.truncate')?.firstChild?.textContent,
      );
      expect(subjects).toEqual([
        'commit 203',
        'commit 202',
        'commit 201',
        'commit 100',
        'commit 99',
      ]);
      expectPlaceholderRow(container, '+2 more');
    });

    test('取失败：小标题照画，下面一行错误，主列表照常', () => {
      incomingError.value = 'busy';
      render(<HistoryList />, container);
      expect((container.querySelector('h3') as HTMLElement).textContent).toBe('Incoming · 5↓');
      expectPlaceholderRow(container, 'busy');
      expect(container.querySelectorAll('[aria-expanded]')).toHaveLength(2);
    });
  });
});
