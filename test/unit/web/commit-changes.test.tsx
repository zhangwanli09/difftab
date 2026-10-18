// 整次提交视图（`commit-changes` tab）：键与模型、详情与分段的取法、整组忘掉、按视口懒取、标签栏与
// History 上的入口。fetch 一律打桩，断言请求的 query。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CommitDetail,
  CommitFileEntry,
  CommitSummary,
  DiffPayload,
} from '../../../src/server/shared/protocol';
import { CommitChangesView } from '../../../src/web/components/CommitChangesView';
import { EditorTabs } from '../../../src/web/components/EditorTabs';
import { HistoryList } from '../../../src/web/components/HistoryList';
import {
  activeEditor,
  activeEditorKey,
  activeEditorPath,
  contextOf,
  editorKey,
  editors,
  findEditor,
  keyOf,
  openEditor,
  pinEditor,
} from '../../../src/web/state/editors';
import { commitDetails, historyList, mergeFirstPage } from '../../../src/web/state/history';
import {
  activateEditor,
  closeEditor,
  commitChangesStates,
  ensureSegment,
  expandSegmentContext,
  ignoreWhitespace,
  openCommitChanges,
  PATCH_DEFAULTS,
  segmentContexts,
  segmentKey,
  selectCommitFile,
} from '../../../src/web/state/store';
import { actionOf, resetEditors, resetHistory, stubJsonBy, waitFor } from './helpers';

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
const files: CommitFileEntry[] = [
  { path: 'src/a.ts', status: 'M' },
  { path: 'src/b.ts', oldPath: 'src/old-b.ts', status: 'R' },
  { path: 'docs/c.md', status: 'A' },
];
const detailOf = (n: number, extra: Partial<CommitDetail> = {}): CommitDetail => ({
  ...commit(n),
  files,
  ...extra,
});
const ready = (n: number, extra: Partial<CommitDetail> = {}) => {
  commitDetails.value = new Map(commitDetails.value).set(sha(n), {
    status: 'ready',
    detail: detailOf(n, extra),
  });
};
const TEXT: DiffPayload = { kind: 'text', patch: '', full: false };
const query = (url: string) => new URLSearchParams(url.slice(url.indexOf('?')));
const diffCalls = (calls: readonly string[]) =>
  calls.filter((url) => url.startsWith('/api/commit-diff'));

let container: HTMLElement;

beforeEach(() => {
  resetEditors();
  resetHistory();
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  vi.unstubAllGlobals();
});

describe('tab 模型', () => {
  test('键是 commit-changes:<sha>，一次提交只有一个；左栏不亮，上下文档不挂在 tab 上', () => {
    stubJsonBy(() => ({ payload: detailOf(1) }));
    openCommitChanges(commit(1));
    expect(editorKey('commit-changes', sha(1))).toBe(`commit-changes:${sha(1)}`);
    expect(activeEditorKey.value).toBe(`commit-changes:${sha(1)}`);
    expect(activeEditor.value).toMatchObject({
      kind: 'commit-changes',
      sha: sha(1),
      subject: 'commit 1',
      pinned: false,
    });
    expect(activeEditorPath.value).toBeNull();
    expect(contextOf(activeEditor.value ?? undefined)).toBe('hunks');
    openCommitChanges(commit(1));
    expect(editors.value).toHaveLength(1);
  });

  test('预览档：另一次提交原位顶掉它；双击（固定）之后不再被顶', () => {
    stubJsonBy(() => ({ payload: detailOf(1) }));
    openCommitChanges(commit(1));
    openCommitChanges(commit(2));
    expect(editors.value.map(keyOf)).toEqual([editorKey('commit-changes', sha(2))]);
    pinEditor(editorKey('commit-changes', sha(2)));
    openCommitChanges(commit(3));
    expect(editors.value.map(keyOf)).toEqual([
      editorKey('commit-changes', sha(2)),
      editorKey('commit-changes', sha(3)),
    ]);
  });
});

describe('详情（文件清单）', () => {
  test('没取过就取一次；已就绪不再取；失败了切回来即重试', async () => {
    let fail = true;
    const calls = stubJsonBy(() =>
      fail
        ? { payload: { error: { code: 'internal', message: 'boom' } }, status: 500 }
        : { payload: detailOf(1) },
    );
    openCommitChanges(commit(1));
    await waitFor(() => expect(commitDetails.value.get(sha(1))?.status).toBe('error'));
    openEditor('diff', 'other.ts', true);
    fail = false;
    activateEditor(editorKey('commit-changes', sha(1)));
    await waitFor(() => expect(commitDetails.value.get(sha(1))?.status).toBe('ready'));
    activateEditor(editorKey('commit-changes', sha(1)));
    expect(calls.filter((url) => url.startsWith('/api/commit?'))).toHaveLength(2);
  });
});

describe('分段的取法', () => {
  const key = segmentKey(sha(1), 'src/b.ts');
  const b = files[1] as CommitFileEntry;

  test('与 commit tab 同一个请求：带 sha、路径与旧路径；取到过就不再取', async () => {
    const calls = stubJsonBy(() => ({ payload: TEXT }));
    ensureSegment(sha(1), b);
    await waitFor(() => expect(commitChangesStates.value.get(key)?.status).toBe('ready'));
    const call = query(diffCalls(calls)[0] as string);
    expect([call.get('sha'), call.get('path'), call.get('oldPath')]).toEqual([
      sha(1),
      'src/b.ts',
      'src/old-b.ts',
    ]);
    expect(commitChangesStates.value.get(key)).toMatchObject({
      rename: { oldPath: 'src/old-b.ts' },
    });
    ensureSegment(sha(1), b);
    expect(diffCalls(calls)).toHaveLength(1);
  });

  test('失败的段再问即重取；切了忽略空白按新的一档重取、不回退 loading', async () => {
    let fail = true;
    const calls = stubJsonBy(() =>
      fail
        ? { payload: { error: { code: 'internal', message: 'boom' } }, status: 500 }
        : { payload: TEXT },
    );
    ensureSegment(sha(1), b);
    await waitFor(() => expect(commitChangesStates.value.get(key)?.status).toBe('error'));
    fail = false;
    ensureSegment(sha(1), b);
    await waitFor(() => expect(commitChangesStates.value.get(key)?.status).toBe('ready'));

    ignoreWhitespace.value = true;
    ensureSegment(sha(1), b);
    expect(commitChangesStates.value.get(key)).toMatchObject({
      status: 'ready',
      pending: { ignoreWhitespace: true },
    });
    await waitFor(() =>
      expect(commitChangesStates.value.get(key)).toMatchObject({
        options: { ignoreWhitespace: true },
      }),
    );
    expect(query(diffCalls(calls)[2] as string).get('ignoreWhitespace')).toBe('1');
  });

  test('点开折叠行：只这一段带 fullContext=1；回来的不是整份上下文就只把这一段记成 unavailable', async () => {
    stubJsonBy(() => ({ payload: TEXT }));
    ensureSegment(sha(1), b);
    await waitFor(() => expect(commitChangesStates.value.get(key)?.status).toBe('ready'));
    const after = stubJsonBy(() => ({ payload: TEXT }));
    expandSegmentContext(sha(1), b);
    await waitFor(() => expect(segmentContexts.value.get(key)).toBe('unavailable'));
    expect(query(diffCalls(after)[0] as string).get('fullContext')).toBe('1');
    // 别的段照旧按 3 行取
    ensureSegment(sha(1), files[0] as CommitFileEntry);
    await waitFor(() => expect(diffCalls(after)).toHaveLength(2));
    expect(query(diffCalls(after)[1] as string).has('fullContext')).toBe(false);
  });

  test('关掉 tab 整组忘掉：缓存、上下文档，以及在途的那一次回来也不再写进来；别的提交不受牵连', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/commit?')) return new Response(JSON.stringify(detailOf(1)));
        await gate;
        return new Response(JSON.stringify(TEXT));
      }),
    );
    openCommitChanges(commit(1));
    ensureSegment(sha(1), b);
    segmentContexts.value = new Map([
      [key, 'full'],
      [segmentKey(sha(2), 'src/b.ts'), 'full'],
    ]);
    const other = segmentKey(sha(2), 'src/a.ts');
    commitChangesStates.value = new Map(commitChangesStates.value).set(other, {
      status: 'ready',
      rename: null,
      payload: TEXT,
      options: PATCH_DEFAULTS,
    });

    closeEditor(editorKey('commit-changes', sha(1)));
    expect([...commitChangesStates.value.keys()]).toEqual([other]);
    expect([...segmentContexts.value.keys()]).toEqual([segmentKey(sha(2), 'src/b.ts')]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commitChangesStates.value.has(key)).toBe(false);
  });

  test('作为预览 tab 被顶掉同样整组忘掉', () => {
    stubJsonBy(() => ({ payload: TEXT }));
    openCommitChanges(commit(1));
    ensureSegment(sha(1), b);
    selectCommitFile(sha(3), { path: 'x.ts', status: 'M' });
    expect(commitChangesStates.value.has(key)).toBe(false);
  });
});

describe('CommitChangesView', () => {
  /** happy-dom 的 IntersectionObserver 从不回调：桩记下 root、选项与被观察的元素，由用例手动触发。 */
  let observers: {
    callback: IntersectionObserverCallback;
    options: IntersectionObserverInit | undefined;
    targets: Element[];
  }[];
  const intersect = (el: Element, visible = true) => {
    for (const o of observers) {
      if (!o.targets.includes(el)) continue;
      o.callback(
        [{ target: el, isIntersecting: visible } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    }
  };
  const sections = () => [...container.querySelectorAll('section')];

  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        record: (typeof observers)[number];
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          this.record = { callback, options, targets: [] };
          observers.push(this.record);
        }
        observe(el: Element) {
          this.record.targets.push(el);
        }
        unobserve(el: Element) {
          this.record.targets = this.record.targets.filter((t) => t !== el);
        }
        disconnect() {
          this.record.targets = [];
        }
      },
    );
  });

  test('每个文件一段、段头带名字目录与状态字母；只取进了视口的那一段', async () => {
    ready(1);
    const calls = stubJsonBy(() => ({ payload: TEXT }));
    render(<CommitChangesView sha={sha(1)} />, container);
    await waitFor(() => expect(observers[0]?.targets).toHaveLength(3));
    // 一个观察者给全部段共用，root 是面板那层滚动容器（不是视口），上下多留一屏
    expect(observers).toHaveLength(1);
    expect(observers[0]?.options?.root).toBe(container.firstElementChild);
    expect(observers[0]?.options?.rootMargin).toBe('100% 0px');
    expect(sections().map((s) => s.querySelector('[aria-expanded]')?.textContent)).toEqual([
      'a.tssrc',
      'b.tssrc',
      'c.mddocs',
    ]);
    expect(diffCalls(calls)).toEqual([]);

    intersect(sections()[1] as Element);
    await waitFor(() => expect(diffCalls(calls)).toHaveLength(1));
    expect(query(diffCalls(calls)[0] as string).get('path')).toBe('src/b.ts');
    await waitFor(() => expect(sections()[1]?.textContent).toContain('Renamed from src/old-b.ts'));
    // 没取到的段占半屏高（只有一行 Loading… 时首屏一次塞得下几十段）；取到了就按实际高度
    const tall = (section: Element | undefined) => section?.querySelector('.min-h-\\[50vh\\]');
    expect(tall(sections()[0])).not.toBeNull();
    expect(tall(sections()[1])).toBeNull();
    // 离开再回来：已经取到过，不再取
    intersect(sections()[1] as Element, false);
    intersect(sections()[1] as Element);
    expect(diffCalls(calls)).toHaveLength(1);
  });

  test('折起的段不取；展开即取', async () => {
    ready(1);
    const calls = stubJsonBy(() => ({ payload: TEXT }));
    render(<CommitChangesView sha={sha(1)} />, container);
    await waitFor(() => expect(observers[0]?.targets).toHaveLength(3));
    const header = sections()[0]?.querySelector('[aria-expanded]') as HTMLButtonElement;
    header.click();
    await waitFor(() => expect(header.getAttribute('aria-expanded')).toBe('false'));
    intersect(sections()[0] as Element);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(diffCalls(calls)).toEqual([]);
    header.click();
    await waitFor(() => expect(diffCalls(calls)).toHaveLength(1));
  });

  test('可见的段在切了忽略空白后按新的一档重取', async () => {
    ready(1);
    const calls = stubJsonBy(() => ({ payload: TEXT }));
    render(<CommitChangesView sha={sha(1)} />, container);
    await waitFor(() => expect(observers[0]?.targets).toHaveLength(3));
    intersect(sections()[0] as Element);
    await waitFor(() =>
      expect(commitChangesStates.value.get(segmentKey(sha(1), 'src/a.ts'))?.status).toBe('ready'),
    );
    ignoreWhitespace.value = true;
    await waitFor(() => expect(diffCalls(calls)).toHaveLength(2));
    expect(query(diffCalls(calls)[1] as string).get('ignoreWhitespace')).toBe('1');
  });

  test('合并提交顶上一行说明对比端；浅克隆、没有文件、出错各有一句', () => {
    ready(1, { parents: [sha(0), sha(9)] });
    stubJsonBy(() => ({ payload: TEXT }));
    render(<CommitChangesView sha={sha(1)} />, container);
    expect(container.textContent).toContain('Merge commit · compared with first parent');

    ready(2, { files: [], parents: [], shallow: true });
    render(<CommitChangesView key="2" sha={sha(2)} />, container);
    expect(container.textContent).toContain('Shallow clone — parent not available');

    ready(3, { files: [] });
    render(<CommitChangesView key="3" sha={sha(3)} />, container);
    expect(container.textContent).toContain('No file changes');

    commitDetails.value = new Map([[sha(4), { status: 'error', message: 'boom' }]]);
    render(<CommitChangesView key="4" sha={sha(4)} />, container);
    expect(container.textContent).toContain('Could not load the commit');
  });
});

describe('标签栏', () => {
  test('tab 上是短哈希 · 主题，图标之外没有目录；详情就绪后画忽略空白与版式切换', async () => {
    stubJsonBy(() => ({ payload: detailOf(1) }));
    openCommitChanges(commit(1, { subject: 'fix the thing' }));
    render(<EditorTabs />, container);
    const tab = container.querySelector('[role="tab"]') as HTMLElement;
    expect(tab.textContent).toBe(`${sha(1).slice(0, 7)} ·fix the thing`);
    expect(tab.getAttribute('title')).toBe(`fix the thing @ ${sha(1)}`);
    expect(container.querySelector('[aria-label="Hide whitespace changes"]')).toBeNull();
    await waitFor(() => expect(commitDetails.value.get(sha(1))?.status).toBe('ready'));
    render(<EditorTabs />, container);
    expect(container.querySelector('[aria-label="Hide whitespace changes"]')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="View inline"], [aria-label="View side by side"]'),
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Preview"]')).toBeNull();
  });

  test('有一段带 SVG 预览时才画 Preview，按下态就是全局开关', () => {
    ready(1);
    openCommitChanges(commit(1));
    commitChangesStates.value = new Map([
      [
        segmentKey(sha(1), 'icon.svg'),
        {
          status: 'ready',
          rename: null,
          payload: {
            kind: 'text',
            patch: '',
            full: false,
            preview: { old: null, new: { path: 'icon.svg', size: 1, version: 'v' } },
          },
          options: PATCH_DEFAULTS,
        },
      ],
    ]);
    render(<EditorTabs />, container);
    expect(container.querySelector('[aria-label="Preview"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

describe('History 上的入口', () => {
  test('提交行多一枚 Open Changes：点它开预览 tab、不展开这一行', () => {
    historyList.value = mergeFirstPage(null, {
      head: sha(5),
      commits: [commit(5)],
      hasMore: false,
    });
    const calls = stubJsonBy(() => ({ payload: detailOf(5) }));
    render(<HistoryList />, container);
    const row = container.querySelector('[aria-expanded]') as HTMLElement;
    const open = actionOf(row, 'Open Changes');
    // 排在 Copy commit hash 前面
    expect(open?.nextElementSibling?.getAttribute('aria-label')).toBe('Copy commit hash');
    open?.click();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(findEditor(editorKey('commit-changes', sha(5)))).toMatchObject({ pinned: false });
    expect(calls.filter((url) => url.startsWith('/api/commit?'))).toHaveLength(1);
  });
});
