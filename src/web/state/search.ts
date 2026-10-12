// 侧栏 `Search` 档的状态：查询、两枚开关、结果与折叠态。**全是模块级 signal**：切去别的档再回来，
// 输入与结果原样都在（照 VS Code）。不进 `localStorage`，理由同其余页面状态（见 `theme.ts`）。
//
// 本文件不 import `store.ts`：档位可见与否由调用方告诉它（`refreshSearch(visible)`），否则 `store`
// 的 `refresh` 要调这里、这里又要读 `store` 的 `activeTab`，两边成环。

import { signal } from '@preact/signals';
import type { SearchPayload } from '../../server/shared/protocol';
import { getJson, latestWins, singleFlight, toMessage } from './http';
import { toggleIn } from './immutable';

export const searchQuery = signal('');
export const matchCase = signal(false);
export const wholeWord = signal(false);

/**
 * 上一次搜到的结果；`null` 即没有查询、还没回来过、或上一次失败了。**在取时先留着旧的**，回来再换
 * ——每敲一个字都把结果清空再画，列表就跟着一闪一闪。失败即清空：错误与一份旧结果并排时看不出哪
 * 一样才是现在的。
 */
export const searchResult = signal<SearchPayload | null>(null);
export const searchError = signal<string | null>(null);
export const searching = signal(false);

/**
 * 折起来的文件，记 collapsed 而不是 expanded：默认全展开，重搜后新冒出来的文件不用登记就是展开的
 * ——记 expanded 时漏登记的那些默认收起，页面上只是「新命中的文件没摊开」。陈旧的键不清理。
 */
export const collapsedResults = signal<ReadonlySet<string>>(new Set());

export function toggleResult(path: string): void {
  collapsedResults.value = toggleIn(collapsedResults.value, path);
}

/** `⌘⇧F` 要输入框聚焦并全选：数一下，`SearchView` 看到它变了就照做。 */
export const searchFocusRequest = signal(0);

export function focusSearch(): void {
  searchFocusRequest.value += 1;
}

/** 敲字之后等多久再发。不等的话每个字一次全仓 `grep`，回来时多半已经不是最新的那个查询。 */
export const DEBOUNCE_MS = 300;

const tickets = latestWins();
let timer: ReturnType<typeof setTimeout> | undefined;
/** 上一次写进 `searchResult` 的那份的序列化，用来判「这次回来的是不是一模一样」。 */
let lastBody = '';

/** 输入框变了：防抖后再搜；清空时立即清掉结果、作废在途的那一次。 */
export function setSearchQuery(value: string): void {
  searchQuery.value = value;
  clearTimeout(timer);
  if (value === '') {
    void runSearch();
    return;
  }
  timer = setTimeout(() => void runSearch(), DEBOUNCE_MS);
}

/** 两枚开关变了：不防抖，立即重搜——那是一次明确的点击，不是一串按键。 */
export function toggleMatchCase(): void {
  matchCase.value = !matchCase.value;
  void runSearch();
}

export function toggleWholeWord(): void {
  wholeWord.value = !wholeWord.value;
  void runSearch();
}

/**
 * 按此刻的查询与开关搜一次。**新的一次作废旧的**（`latestWins`）：慢的旧查询晚到时不得盖掉新的。
 * 查询为空时不发请求，只清结果——这一次同样领一张票，把在途的那次作废掉。
 */
export async function runSearch(): Promise<void> {
  clearTimeout(timer);
  const ticket = tickets.claim();
  const query = searchQuery.value;
  if (query === '') {
    searchResult.value = null;
    searchError.value = null;
    searching.value = false;
    tickets.release(ticket);
    return;
  }
  searching.value = true;
  try {
    const params = new URLSearchParams({ q: query });
    if (matchCase.value) params.set('case', '1');
    if (wholeWord.value) params.set('word', '1');
    const payload = await getJson<SearchPayload>(`/api/search?${params}`);
    if (!tickets.isCurrent(ticket)) return;
    // **结果没变就不写**：agent 跑动时每个 SSE 都重搜一次，而多数写入碰不到命中的那几行——每次都换
    // 一份新对象，结果区最多 2,000 行就跟着整片重画一遍。序列化一份几百 KB 的 JSON 比那便宜得多
    const body = JSON.stringify(payload);
    if (body !== lastBody || searchResult.value === null) {
      lastBody = body;
      searchResult.value = payload;
    }
    searchError.value = null;
  } catch (cause) {
    if (!tickets.isCurrent(ticket)) return;
    searchResult.value = null;
    searchError.value = toMessage(cause);
  } finally {
    if (tickets.isCurrent(ticket)) searching.value = false;
    tickets.release(ticket);
  }
}

/**
 * SSE 那一路：**同一时刻只有一次在途，在途期间又被叫过就回来后补跑一次**。每个事件都新发并作废
 * 前一次时，agent 跑动期间（事件每 150ms 一个，大仓库上 `grep` 要几百毫秒）每份结果回来时都已不是
 * 最新的，一份都落不了地。
 */
const refreshOnce = singleFlight(runSearch);

/**
 * 看不见时不搜，只记一笔，切回来时补搜（`ensureSearchFresh`）——照 History 的「看不见不判，切过来
 * 补判」。不可见时也按事件重搜，等于 agent 每写一个文件就把全仓 `grep` 一遍。
 */
let stale = false;

export function refreshSearch(visible: boolean): Promise<void> {
  if (searchQuery.value === '') return Promise.resolve();
  if (!visible) {
    stale = true;
    return Promise.resolve();
  }
  stale = false;
  return refreshOnce();
}

/** 切到 `Search` 档时调：期间来过 SSE 就补搜一次。 */
export function ensureSearchFresh(): void {
  if (!stale) return;
  stale = false;
  if (searchQuery.value !== '') void refreshOnce();
}

/** 只给用例：模块级状态在用例之间清掉。 */
export function resetSearch(): void {
  clearTimeout(timer);
  tickets.claim();
  stale = false;
  lastBody = '';
  searchQuery.value = '';
  matchCase.value = false;
  wholeWord.value = false;
  searchResult.value = null;
  searchError.value = null;
  searching.value = false;
  collapsedResults.value = new Set();
}
