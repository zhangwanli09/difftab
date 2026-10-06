// `History` 那一档的状态：分页的提交列表、按 sha 缓存的提交详情、展开集合。取单个文件的提交
// diff 在 `store.ts`——那是 tab 的事，与 diff / file 两种 tab 同住一处。
//
// **列表锚在第一页那次的 HEAD 上**：之后每一页都带着 `head` 再 `skip`，agent 在两次翻页之间提交
// 一次也不会让第二页重复第一页的最后一条。新提交由 SSE 之后重取第一页长出来。

import { signal } from '@preact/signals';
import type { CommitDetail, CommitPage, CommitSummary } from '../../server/shared/protocol';
import { getJson, latestWins, toMessage } from './http';
import { setIn } from './immutable';

export interface HistoryList {
  /** 分页的锚点。null 即空仓库。 */
  head: string | null;
  commits: readonly CommitSummary[];
  hasMore: boolean;
}

/** 已加载的那一串提交。null 即还没取过第一页。 */
export const historyList = signal<HistoryList | null>(null);

/** 第一页取不到时的那句话。翻页失败另记在 `moreError`，不让已加载的列表整个变成错误。 */
export const historyError = signal<string | null>(null);

/** `Load more` 在途。按钮据此写 `Loading…` 并 disabled，同一时刻只翻一页。 */
export const loadingMore = signal(false);
export const moreError = signal<string | null>(null);

/**
 * 看不见时 SSE 不取，只记一笔；切过来再取。与 `Files` 档同一取向：看不见的东西不为它付
 * `git log`。初值为 true——第一次切过来本来就要取。
 */
let stale = true;

const pageTickets = latestWins();

/**
 * 重取第一页。**`head` 没变就什么都不换**：已翻到的页、展开的提交都留着——agent 改的是工作区
 * 时每个文件事件都会走到这里，而提交列表根本没变。变了就以新的第一页整体替换：新提交长在顶上，
 * 而旧的那串页是以旧锚点数的，接着用会让 skip 错位。
 */
export async function refreshHistory(): Promise<void> {
  stale = false;
  const ticket = pageTickets.claim();
  try {
    const page = await getJson<CommitPage>('/api/commits');
    if (!pageTickets.isCurrent(ticket)) return;
    historyError.value = null;
    if (historyList.value?.head === page.head) return;
    historyList.value = page;
    moreError.value = null;
  } catch (cause) {
    if (!pageTickets.isCurrent(ticket)) return;
    historyError.value = toMessage(cause);
  }
}

/** 切到 `History` 那一档时调：没取过、或离开期间来过 SSE，就取一次。 */
export function ensureHistory(): void {
  if (stale || historyList.value === null) void refreshHistory();
}

/** 不可见时的 SSE：只记一笔。 */
export function markHistoryStale(): void {
  stale = true;
}

/**
 * 翻一页。带着锚点与已加载的条数去问；回来时**锚点或条数变了就丢掉**——中途第一页被换掉了
 * （新提交），这一页是按旧的那串数的。
 */
export async function loadMore(): Promise<void> {
  const current = historyList.value;
  if (current === null || current.head === null || !current.hasMore || loadingMore.value) return;
  loadingMore.value = true;
  moreError.value = null;
  try {
    const query = new URLSearchParams({ head: current.head, skip: String(current.commits.length) });
    const page = await getJson<CommitPage>(`/api/commits?${query}`);
    if (historyList.value !== current) return;
    historyList.value = {
      head: current.head,
      commits: [...current.commits, ...page.commits],
      hasMore: page.hasMore,
    };
  } catch (cause) {
    if (historyList.value === current) moreError.value = toMessage(cause);
  } finally {
    loadingMore.value = false;
  }
}

/**
 * 一次提交的详情（元数据 + 改了哪些文件）的请求状态。**按 sha 缓存、永不失效**：提交不可变，
 * SSE 说的「工作区变了」与它无关。
 */
export type CommitDetailState =
  | { status: 'loading' }
  | { status: 'ready'; detail: CommitDetail }
  | { status: 'error'; message: string };

export const commitDetails = signal<ReadonlyMap<string, CommitDetailState>>(new Map());

/**
 * 展开着的提交。**记 expanded 而不是 collapsed**，与变更列表的树刻意相反：那边默认全展开、新冒
 * 出来的目录也要展开；这里默认全收起，新长出来的提交不该自己摊开一列文件。键是 sha，第一页被
 * 整体换掉时旧提交展开着照样展开着。
 */
export const expandedCommits = signal<ReadonlySet<string>>(new Set());

async function loadCommit(sha: string): Promise<void> {
  commitDetails.value = setIn(commitDetails.value, sha, { status: 'loading' });
  try {
    const detail = await getJson<CommitDetail>(`/api/commit?${new URLSearchParams({ sha })}`);
    commitDetails.value = setIn(commitDetails.value, sha, { status: 'ready', detail });
  } catch (cause) {
    commitDetails.value = setIn(commitDetails.value, sha, {
      status: 'error',
      message: toMessage(cause),
    });
  }
}

/** 展开 / 收起一条提交。第一次展开才去取详情；上次失败了，再展开一次就重试。 */
export function toggleCommit(sha: string): void {
  const next = new Set(expandedCommits.value);
  if (next.delete(sha)) {
    expandedCommits.value = next;
    return;
  }
  next.add(sha);
  expandedCommits.value = next;
  const state = commitDetails.value.get(sha);
  if (state === undefined || state.status === 'error') void loadCommit(sha);
}

/** 展示用的短哈希：前 7 位，与 `git log --oneline` 的默认一致。完整 sha 挂在 `title` 上。 */
export const shortSha = (sha: string): string => sha.slice(0, 7);
