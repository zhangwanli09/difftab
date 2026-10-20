// 工作区改动视图（`changes` tab）：键与模型、段的次序、按「对着哪份 state 取的」重取、在途不重发、SSE
// 后剪掉消失的段且不关 tab、按视口懒取、标签栏。fetch 一律打桩，断言请求的 query。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DiffPayload, FileEntry } from '../../../src/server/shared/protocol';
import { EditorTabs } from '../../../src/web/components/EditorTabs';
import { WorktreeChangesView } from '../../../src/web/components/WorktreeChangesView';
import {
  activeEditorKey,
  activeEditorPath,
  activeGroup,
  editorKey,
  editors,
  findEditor,
  keyOf,
  openEditor,
} from '../../../src/web/state/editors';
import {
  changesContexts,
  changesFilesOf,
  changesOutdated,
  changesStates,
  closeEditor,
  ensureChangesSegment,
  expandChangesContext,
  ignoreWhitespace,
  openChanges,
  refresh,
  repoState,
} from '../../../src/web/state/store';
import { file, hideHistory, repo, resetEditors, stubJsonBy, waitFor } from './helpers';

const TEXT: DiffPayload = { kind: 'text', patch: '', full: false };
const query = (url: string) => new URLSearchParams(url.slice(url.indexOf('?')));
const diffCalls = (calls: readonly string[]) => calls.filter((url) => url.startsWith('/api/diff'));

const a = file({ path: 'src/a.ts', unstaged: 'M' });
const b = file({ path: 'src/b.ts', oldPath: 'src/old-b.ts', staged: 'R' });
const c = file({ path: 'docs/c.md', kind: 'untracked', unstaged: '?' });

/** 换上一份新 state（新对象，即一次 SSE 之后的样子）。 */
const snapshot = (files: FileEntry[]) => {
  repoState.value = repo({ files: files.map((f) => ({ ...f })) });
};

let container: HTMLElement;

beforeEach(() => {
  resetEditors();
  hideHistory();
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  repoState.value = null;
  vi.unstubAllGlobals();
});

describe('tab 模型', () => {
  test('键是 changes:，全局一个；左栏不亮；开出来是预览 tab，会顶掉别的预览', () => {
    openEditor('diff', 'src/a.ts');
    openChanges();
    expect(editorKey('changes')).toBe('changes:');
    expect(editors.value.map(keyOf)).toEqual(['changes:']);
    expect(activeEditorKey.value).toBe('changes:');
    expect(activeEditorPath.value).toBeNull();
    expect(findEditor('changes:')).toMatchObject({ kind: 'changes', pinned: false });
    openChanges();
    expect(editors.value).toHaveLength(1);
  });

  test('关掉 tab 时整组段一起忘掉：缓存与上下文档', () => {
    snapshot([a]);
    openChanges();
    stubJsonBy(() => ({ payload: TEXT }));
    ensureChangesSegment('src/a.ts');
    changesContexts.value = new Map([['src/a.ts', 'full']]);
    closeEditor('changes:');
    expect(changesStates.value.size).toBe(0);
    expect(changesContexts.value.size).toBe(0);
  });
});

describe('段的次序', () => {
  test('同左栏自上而下：冲突、已暂存、工作区改动（组内文件在子目录前）；同一个文件只排第一次', () => {
    const both = file({ path: 'z.ts', staged: 'M', unstaged: 'M' });
    const conflict = file({ path: 'y.ts', staged: 'U', unstaged: 'U', conflicted: true });
    expect(changesFilesOf([a, both, c, b, conflict]).map((f) => f.path)).toEqual([
      'y.ts',
      'z.ts',
      'src/b.ts',
      'docs/c.md',
      'src/a.ts',
    ]);
  });
});

describe('ensureChangesSegment', () => {
  test('同一份 state 只取一次；换了一份 state 再取', async () => {
    snapshot([a, b]);
    const calls = stubJsonBy(() => ({ payload: TEXT }));
    ensureChangesSegment('src/b.ts');
    await waitFor(() => expect(changesStates.value.get('src/b.ts')?.status).toBe('ready'));
    expect(query(diffCalls(calls)[0] as string).get('oldPath')).toBe('src/old-b.ts');
    ensureChangesSegment('src/b.ts');
    expect(diffCalls(calls)).toHaveLength(1);

    snapshot([a, b]);
    ensureChangesSegment('src/b.ts');
    expect(diffCalls(calls)).toHaveLength(2);
    // 重取期间留着旧的那份，不回退 loading
    expect(changesStates.value.get('src/b.ts')).toMatchObject({ status: 'ready' });
  });

  test('在途时换了 state 不重发；落地后不自己补发，changesOutdated 翻成 true、再问才补发', async () => {
    snapshot([a]);
    const pending: ((value: Response) => void)[] = [];
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        return new Promise<Response>((resolve) => pending.push(resolve));
      }),
    );
    ensureChangesSegment('src/a.ts');
    snapshot([a]);
    ensureChangesSegment('src/a.ts');
    snapshot([a]);
    ensureChangesSegment('src/a.ts');
    expect(calls).toHaveLength(1);

    expect(changesOutdated('src/a.ts')).toBe(false);

    pending[0]?.(new Response(JSON.stringify(TEXT)));
    await waitFor(() => expect(changesStates.value.get('src/a.ts')?.status).toBe('ready'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 落地那一刻没有可见性可问：store 不自己补发，只把过期的信号交给视图
    expect(calls).toHaveLength(1);
    expect(changesOutdated('src/a.ts')).toBe(true);
    ensureChangesSegment('src/a.ts');
    expect(calls).toHaveLength(2);
    pending[1]?.(new Response(JSON.stringify(TEXT)));
    await waitFor(() => expect(changesOutdated('src/a.ts')).toBe(false));
  });

  test('出错落地而 state 没换：不算过期，不会原地重试成环', async () => {
    snapshot([a]);
    const calls = stubJsonBy(() => ({ status: 500, payload: { error: 'boom' } }));
    ensureChangesSegment('src/a.ts');
    await waitFor(() => expect(changesStates.value.get('src/a.ts')?.status).toBe('error'));
    expect(changesOutdated('src/a.ts')).toBe(false);
    expect(diffCalls(calls)).toHaveLength(1);
  });

  test('出错的段再问即重取；点开折叠行按整份上下文取，过不了闸记成 unavailable', async () => {
    snapshot([a]);
    let fail = true;
    const calls = stubJsonBy(() =>
      fail ? { payload: { error: 'boom' }, status: 500 } : { payload: TEXT },
    );
    ensureChangesSegment('src/a.ts');
    await waitFor(() => expect(changesStates.value.get('src/a.ts')?.status).toBe('error'));
    fail = false;
    ensureChangesSegment('src/a.ts');
    await waitFor(() => expect(changesStates.value.get('src/a.ts')?.status).toBe('ready'));

    expandChangesContext('src/a.ts');
    expect(query(diffCalls(calls).at(-1) as string).get('fullContext')).toBe('1');
    await waitFor(() => expect(changesContexts.value.get('src/a.ts')).toBe('unavailable'));
  });
});

describe('SSE 之后', () => {
  test('剪掉已不在列表里的段，留下的不动；改动清空也不关 tab', async () => {
    snapshot([a, b]);
    openChanges();
    stubJsonBy(() => ({ payload: TEXT }));
    ensureChangesSegment('src/a.ts');
    ensureChangesSegment('src/b.ts');
    await waitFor(() => expect(changesStates.value.size).toBe(2));
    changesContexts.value = new Map([
      ['src/a.ts', 'full'],
      ['src/b.ts', 'full'],
    ]);

    stubJsonBy(() => ({ payload: repo({ files: [a] }) }));
    await refresh();
    expect([...changesStates.value.keys()]).toEqual(['src/a.ts']);
    expect([...changesContexts.value.keys()]).toEqual(['src/a.ts']);

    stubJsonBy(() => ({ payload: repo({ files: [] }) }));
    await refresh();
    expect(changesStates.value.size).toBe(0);
    expect(editors.value.map(keyOf)).toEqual(['changes:']);
  });
});

describe('WorktreeChangesView', () => {
  /** happy-dom 的 IntersectionObserver 从不回调：桩记下被观察的元素，由用例手动触发。 */
  let observers: { callback: IntersectionObserverCallback; targets: Element[] }[];
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
        constructor(callback: IntersectionObserverCallback) {
          this.record = { callback, targets: [] };
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

  test('state 没到说 Loading…，没有改动说 No changes', () => {
    render(<WorktreeChangesView />, container);
    expect(container.textContent).toContain('Loading…');
    snapshot([]);
    render(<WorktreeChangesView />, container);
    expect(container.textContent).toContain('No changes');
  });

  test('每个文件一段、带归并后的状态字母；只取进了视口的段，换了 state 只重取可见的', async () => {
    snapshot([a, c]);
    const calls = stubJsonBy(() => ({ payload: TEXT }));
    render(<WorktreeChangesView />, container);
    await waitFor(() => expect(observers[0]?.targets).toHaveLength(2));
    expect(sections().map((s) => s.querySelector('[aria-expanded]')?.textContent)).toEqual([
      'c.mddocs',
      'a.tssrc',
    ]);
    expect(sections()[0]?.textContent).toContain('U');
    expect(sections()[1]?.textContent).toContain('M');
    expect(diffCalls(calls)).toEqual([]);

    intersect(sections()[1] as Element);
    await waitFor(() => expect(changesStates.value.get('src/a.ts')?.status).toBe('ready'));
    expect(diffCalls(calls).map((url) => query(url).get('path'))).toEqual(['src/a.ts']);

    // 一次 SSE：可见的那段重取，看不见的那段不动
    snapshot([a, c]);
    await waitFor(() => expect(diffCalls(calls)).toHaveLength(2));
    expect(query(diffCalls(calls)[1] as string).get('path')).toBe('src/a.ts');

    // 不可见的段进了视口才取；可见的段在同一份 state 下离开再回来不再取
    intersect(sections()[0] as Element);
    await waitFor(() => expect(diffCalls(calls)).toHaveLength(3));
    intersect(sections()[1] as Element, false);
    intersect(sections()[1] as Element);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(diffCalls(calls)).toHaveLength(3);
  });

  test('可见的段在途时换了 state：落地后补发一次；看不见的段落地后不补发', async () => {
    snapshot([a, c]);
    const pending: { url: string; resolve: (value: Response) => void }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string) =>
          new Promise<Response>((resolve) => {
            pending.push({ url, resolve });
          }),
      ),
    );
    const settle = (path: string) => {
      const call = pending.find((p) => query(p.url).get('path') === path);
      pending.splice(pending.indexOf(call as (typeof pending)[number]), 1);
      call?.resolve(new Response(JSON.stringify(TEXT)));
    };
    const fetched = vi.mocked(fetch).mock.calls;
    render(<WorktreeChangesView />, container);
    await waitFor(() => expect(observers[0]?.targets).toHaveLength(2));
    intersect(sections()[0] as Element);
    intersect(sections()[1] as Element);
    await waitFor(() => expect(fetched).toHaveLength(2));

    // 两段都在途时来一次 SSE；c 那段随后滚出视口
    snapshot([a, c]);
    intersect(sections()[0] as Element, false);
    settle('src/a.ts');
    settle('docs/c.md');
    await waitFor(() => expect(fetched).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetched).toHaveLength(3);
    expect(query(fetched[2]?.[0] as string).get('path')).toBe('src/a.ts');
  });

  test('可见的段在切了忽略空白后按新的一档重取', async () => {
    snapshot([a]);
    const calls = stubJsonBy(() => ({ payload: TEXT }));
    render(<WorktreeChangesView />, container);
    await waitFor(() => expect(observers[0]?.targets).toHaveLength(1));
    intersect(sections()[0] as Element);
    await waitFor(() => expect(changesStates.value.get('src/a.ts')?.status).toBe('ready'));
    ignoreWhitespace.value = true;
    await waitFor(() => expect(diffCalls(calls)).toHaveLength(2));
    expect(query(diffCalls(calls)[1] as string).get('ignoreWhitespace')).toBe('1');
  });
});

describe('标签栏', () => {
  test('tab 上是 Changes，title 说清是工作区；有改动时画忽略空白与版式切换', async () => {
    snapshot([]);
    openChanges();
    render(<EditorTabs group={activeGroup.value} />, container);
    const tab = container.querySelector('[role="tab"]') as HTMLElement;
    expect(tab.textContent).toBe('Changes');
    expect(tab.getAttribute('title')).toBe('Working tree changes');
    expect(container.querySelector('[aria-label="Hide whitespace changes"]')).toBeNull();

    snapshot([a]);
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Hide whitespace changes"]')).not.toBeNull(),
    );
    expect(
      container.querySelector('[aria-label="View inline"], [aria-label="View side by side"]'),
    ).not.toBeNull();
  });
});
