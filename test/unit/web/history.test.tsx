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
import { HistoryList, relativeTime } from '../../../src/web/components/HistoryList';
import {
  activeEditor,
  activeEditorPath,
  editorKey,
  editors,
  keyOf,
  openEditor,
} from '../../../src/web/state/editors';
import {
  expandedCommits,
  historyList,
  loadMore,
  refreshHistory,
  toggleCommit,
} from '../../../src/web/state/history';
import {
  activeTab,
  commitDiffKey,
  commitDiffStates,
  refresh,
  repoState,
  selectCommitFile,
} from '../../../src/web/state/store';
import { resetEditors, resetHistory, stubJsonBy, waitFor } from './helpers';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const commit = (n: number, extra: Partial<CommitSummary> = {}): CommitSummary => ({
  sha: sha(n),
  parents: [sha(n - 1)],
  author: 'Ann',
  time: 1_700_000_000,
  subject: `commit ${n}`,
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

  test('head 变了就以新的第一页整体替换，展开集合按 sha 留着', async () => {
    let head = 100;
    stubJsonBy((url) =>
      url.pathname === '/api/commit'
        ? { payload: { ...commit(99), files: [] } satisfies CommitDetail }
        : { payload: page(head, head, 2, true) },
    );
    await refreshHistory();
    toggleCommit(sha(99));
    head = 101;
    await refreshHistory();
    expect(historyList.value?.commits[0]?.sha).toBe(sha(101));
    expect(expandedCommits.value.has(sha(99))).toBe(true);
  });

  test('翻页回来时第一页已被换掉——这一页是按旧锚点数的，丢掉', async () => {
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
    head = 101;
    await refreshHistory();
    release();
    await more;
    expect(historyList.value?.commits.map((c) => c.sha)).toEqual([sha(101), sha(100)]);
  });
});

describe('HistoryList 组件', () => {
  test('空仓库说 No commits yet', () => {
    historyList.value = { head: null, commits: [], hasMore: false };
    render(<HistoryList />, container);
    expect(container.textContent).toContain('No commits yet');
  });

  test('一行是主题 + 短哈希 + 相对时间；hasMore 时末尾有 Load more', () => {
    historyList.value = page(100, 100, 1, true);
    render(<HistoryList />, container);
    const row = container.querySelector('[aria-expanded]') as HTMLElement;
    expect(row.textContent).toContain('commit 100');
    expect(row.textContent).toContain(sha(100).slice(0, 7));
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).toContain('Load more');
  });

  test('单击展开才取详情；文件行单击开预览 commit tab、双击固定', async () => {
    historyList.value = page(100, 100, 1, false);
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
      expect(commitDiffStates.value.get(commitDiffKey(sha(100), 'src/b.ts'))?.status).toBe('ready'),
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

describe('commit tab', () => {
  test('键带 sha：同一个文件在两次提交里是两个 tab', () => {
    openEditor('commit', 'a.ts', true, sha(1));
    openEditor('commit', 'a.ts', true, sha(2));
    expect(editors.value.map(keyOf)).toEqual([
      editorKey('commit', 'a.ts', sha(1)),
      editorKey('commit', 'a.ts', sha(2)),
    ]);
    expect(keyOf(editors.value[0] as never)).toBe(`commit:${sha(1)}:a.ts`);
  });

  test('活动时两栏不高亮——同名那一行说的是工作区那一份', () => {
    openEditor('commit', 'a.ts', false, sha(1));
    expect(activeEditorPath.value).toBeNull();
    openEditor('diff', 'a.ts');
    expect(activeEditorPath.value).toBe('a.ts');
  });

  test('已经取到过就不再取：一次提交不可变', async () => {
    const calls = stubJsonBy(() => ({ payload: { kind: 'text', patch: 'p\n' } }));
    selectCommitFile(sha(1), { path: 'a.ts', status: 'M' });
    await waitFor(() =>
      expect(commitDiffStates.value.get(commitDiffKey(sha(1), 'a.ts'))?.status).toBe('ready'),
    );
    selectCommitFile(sha(1), { path: 'a.ts', status: 'M' });
    expect(calls.filter((url) => url.startsWith('/api/commit-diff'))).toHaveLength(1);
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
    openEditor('commit', 'a.ts', true, sha(1));
    commitDiffStates.value = new Map([
      [
        commitDiffKey(sha(1), 'a.ts'),
        { status: 'ready', rename: null, payload: { kind: 'binary' } },
      ],
    ]);
    const calls = stubJsonBy(() => ({ payload: state }));
    await refresh();
    expect(editors.value).toHaveLength(1);
    expect(calls).toEqual(['/api/state']);
    repoState.value = null;
  });

  test('History 可见时重取第一页，不可见时不取', async () => {
    const calls = stubJsonBy((url) =>
      url.pathname === '/api/state' ? { payload: state } : { payload: page(1, 1, 1, false) },
    );
    await refresh();
    expect(calls.filter((url) => url.startsWith('/api/commits'))).toHaveLength(0);
    activeTab.value = 'history';
    await refresh();
    expect(calls.filter((url) => url.startsWith('/api/commits'))).toHaveLength(1);
    repoState.value = null;
  });
});

test('relativeTime：一分钟以内是 now，其余取最大的那一档', () => {
  const now = 1_700_000_000_000;
  expect(relativeTime(now / 1000 - 30, now)).toBe('now');
  expect(relativeTime(now / 1000 - 3 * 3600, now)).toBe('3 hours ago');
  expect(relativeTime(now / 1000 - 24 * 3600, now)).toBe('yesterday');
});
