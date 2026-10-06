// `History` 那一档：锚点分页、展开即取详情、commit tab 的键与高亮、SSE 下的取舍。fetch 一律打桩，
// 断言请求的 query 而不是字符串拼法。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CommitDetail,
  CommitPage,
  CommitSummary,
  RepoState,
} from '../../../src/server/shared/protocol';
import { commitTooltip, HistoryList, relativeTime } from '../../../src/web/components/HistoryList';
import {
  activeEditor,
  activeEditorPath,
  editorKey,
  editors,
  keyOf,
  openCommitEditor,
  openEditor,
} from '../../../src/web/state/editors';
import {
  expandedCommits,
  historyError,
  historyList,
  loadMore,
  mergeFirstPage,
  moreError,
  refreshHistory,
  toggleCommit,
} from '../../../src/web/state/history';
import {
  activateEditor,
  activeTab,
  commitDiffStates,
  refresh,
  repoState,
  selectCommitFile,
} from '../../../src/web/state/store';
import {
  actionOf,
  expectStatusGap,
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

  test('悬停提示照 VS Code 的次序：作者与时间、主题、正文、哈希；没有正文不留空段', () => {
    const now = (1_700_000_000 + 3 * 3600) * 1000;
    const withBody = commitTooltip(commit(100, { body: 'line 1\nline 2' }), now);
    const parts = withBody.split('\n\n');
    expect(parts[0]).toMatch(/^Ann · 3 hours ago \(.+\)$/);
    expect(parts.slice(1)).toEqual(['commit 100', 'line 1\nline 2', sha(100).slice(0, 7)]);
    expect(withBody).not.toContain(sha(100));
    const bare = commitTooltip(commit(100), now);
    expect(bare.split('\n\n')).toHaveLength(3);
    expect(bare).not.toContain('\n\n\n');
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
      await mounted();
      expect(observers).toHaveLength(2);
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
    // 提交行没有状态记号
    expectStatusGap(row);

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
        : { payload: { kind: 'text', patch: 'p\n' } },
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
        return new Response(JSON.stringify({ kind: 'text', patch: 'p\n' }), { status: 200 });
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
    const calls = stubJsonBy(() => ({ payload: { kind: 'text', patch: 'p\n' } }));
    selectCommitFile(sha(1), { path: 'a.ts', status: 'M' });
    await waitFor(() =>
      expect(commitDiffStates.value.get(editorKey('commit', 'a.ts', sha(1)))?.status).toBe('ready'),
    );
    selectCommitFile(sha(1), { path: 'a.ts', status: 'M' });
    expect(calls.filter((url) => url.startsWith('/api/commit-diff'))).toHaveLength(1);
  });

  test('上次没取到：切回这个 tab 就重试，并带上旧路径', async () => {
    let fail = true;
    const calls = stubJsonBy(() =>
      fail
        ? { payload: { error: { code: 'internal', message: 'boom' } }, status: 500 }
        : { payload: { kind: 'text', patch: 'p\n' } },
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

describe('refresh 对 History 那一半', () => {
  const state: RepoState = {
    repoName: 'demo',
    branch: { head: 'main', detached: false, upstream: null },
    files: [],
    watch: { mode: 'native', tier: 'A' },
  };

  test('commit tab 不收编、不重取——工作区变了与它无关', async () => {
    openCommitEditor(sha(1), 'a.ts', undefined, true);
    commitDiffStates.value = new Map([
      [
        editorKey('commit', 'a.ts', sha(1)),
        { status: 'ready', rename: null, payload: { kind: 'binary' } },
      ],
    ]);
    const calls = stubJsonBy(() => ({ payload: state }));
    await refresh();
    expect(editors.value).toHaveLength(1);
    expect(calls).toEqual(['/api/state']);
    repoState.value = null;
  });

  test('History 可见且 HEAD 挪了才重取第一页；HEAD 没挪、或不可见时一条都不发', async () => {
    let oid = sha(1);
    const calls = stubJsonBy((url) =>
      url.pathname === '/api/state'
        ? { payload: { ...state, branch: { ...state.branch, oid } } }
        : { payload: page(Number.parseInt(oid, 16), Number.parseInt(oid, 16), 1, false) },
    );
    const commitsCalls = () => calls.filter((url) => url.startsWith('/api/commits')).length;
    await refresh();
    expect(commitsCalls()).toBe(0);

    activeTab.value = 'history';
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
    activeTab.value = 'history';
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
