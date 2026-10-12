// `Search` 档：防抖、开关进 query、新查询作废旧结果、看不见时只记一笔切回来补搜、汇总行与截断提示、
// 命中段高亮、折叠、点命中行打开文件并跳行。fetch 一律打桩。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchPayload } from '../../../src/server/shared/protocol';
import { SearchView } from '../../../src/web/components/SearchView';
import { activeEditor, revealRequest } from '../../../src/web/state/editors';
import {
  DEBOUNCE_MS,
  ensureSearchFresh,
  refreshSearch,
  resetSearch,
  runSearch,
  searchQuery,
  searchResult,
  setSearchQuery,
  toggleMatchCase,
} from '../../../src/web/state/search';
import { resetEditors, stubJsonBy, waitFor } from './helpers';

const PAYLOAD: SearchPayload = {
  files: [
    {
      path: 'src/app.ts',
      matches: [
        { line: 3, text: 'const needle = 1;', ranges: [[6, 12]] },
        { line: 9, text: 'needle()', ranges: [[0, 6]] },
      ],
    },
    { path: 'README.md', matches: [{ line: 1, text: 'a needle', ranges: [[2, 8]] }] },
  ],
  truncated: false,
};

let calls: string[];
let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  resetSearch();
  resetEditors();
  calls = stubJsonBy((url) =>
    url.pathname === '/api/search'
      ? { payload: PAYLOAD }
      : { payload: { kind: 'text', content: 'x\n'.repeat(20) } },
  );
});

afterEach(() => {
  render(null, container);
  resetSearch();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('search state', () => {
  it('敲字防抖后才发；开关进 query；清空不发请求并清掉结果', async () => {
    vi.useFakeTimers();
    setSearchQuery('ne');
    setSearchQuery('needle');
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(calls).toEqual(['/api/search?q=needle']);
    vi.useRealTimers();
    await waitFor(() => expect(searchResult.value).toEqual(PAYLOAD));

    toggleMatchCase();
    await waitFor(() => expect(calls.at(-1)).toBe('/api/search?q=needle&case=1'));

    setSearchQuery('');
    await waitFor(() => expect(searchResult.value).toBeNull());
    expect(calls).toHaveLength(2);
  });

  it('新查询作废旧的：慢的旧结果晚到时不盖掉新的', async () => {
    const resolvers: ((value: Response) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve))),
    );
    searchQuery.value = 'old';
    const first = runSearch();
    searchQuery.value = 'new';
    const second = runSearch();
    resolvers[1]?.(new Response(JSON.stringify(PAYLOAD)));
    await second;
    resolvers[0]?.(new Response(JSON.stringify({ files: [], truncated: false })));
    await first;
    expect(searchResult.value).toEqual(PAYLOAD);
  });

  it('看不见时 SSE 只记一笔，切回来补搜一次；没有查询时什么都不发', async () => {
    await refreshSearch(true);
    expect(calls).toHaveLength(0);

    searchQuery.value = 'needle';
    await refreshSearch(false);
    expect(calls).toHaveLength(0);
    ensureSearchFresh();
    await waitFor(() => expect(calls).toHaveLength(1));
    // 补过了就不再补
    ensureSearchFresh();
    await refreshSearch(true);
    expect(calls).toHaveLength(2);
  });
});

describe('SearchView', () => {
  const show = async () => {
    searchQuery.value = 'needle';
    await runSearch();
    render(<SearchView />, container);
  };
  const fileRows = () => [...container.querySelectorAll('button[aria-expanded]')];

  it('汇总行按单复数说，命中段落在 <mark> 里，行号进 title', async () => {
    await show();
    expect(container.textContent).toContain('3 results in 2 files');
    const marks = [...container.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['needle', 'needle', 'needle']);
    expect(container.querySelector('[title="src/app.ts:9"]')).not.toBeNull();
  });

  it('截断时另起一行说只给了前 2,000 条', async () => {
    stubJsonBy(() => ({ payload: { ...PAYLOAD, truncated: true } }));
    await show();
    expect(container.textContent).toContain('Showing the first 2,000 results');
  });

  it('没命中说 No results，出错说引导句加原因', async () => {
    stubJsonBy(() => ({ payload: { files: [], truncated: false } }));
    await show();
    expect(container.textContent).toContain('No results');

    stubJsonBy(() => ({
      payload: { error: { code: 'internal', message: 'grep exploded' } },
      status: 500,
    }));
    await runSearch();
    await waitFor(() => expect(container.textContent).toContain('Could not search'));
    expect(container.textContent).toContain('grep exploded');
  });

  it('点文件行只折叠 / 展开，不开文件', async () => {
    await show();
    const first = fileRows()[0] as HTMLButtonElement;
    first.click();
    await waitFor(() => expect(first.getAttribute('aria-expanded')).toBe('false'));
    expect(container.querySelector('[title="src/app.ts:3"]')).toBeNull();
    expect(activeEditor.value).toBeNull();
  });

  it('点命中行：预览打开那个文件并请求跳到那一行', async () => {
    await show();
    container.querySelector<HTMLButtonElement>('[title="src/app.ts:9"]')?.click();
    expect(activeEditor.value).toMatchObject({ kind: 'file', path: 'src/app.ts', pinned: false });
    expect(revealRequest.value).toEqual({ path: 'src/app.ts', line: 9 });
  });

  it('两枚切换钮以 aria-pressed 表态', async () => {
    await show();
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Match Case"]');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    toggle?.click();
    await waitFor(() => expect(toggle?.getAttribute('aria-pressed')).toBe('true'));
  });
});
