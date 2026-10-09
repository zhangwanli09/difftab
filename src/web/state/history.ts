// `History` 那一档的状态：分页的提交列表、按 sha 缓存的提交详情、展开集合。取单个文件的提交
// diff 在 `store.ts`——那是 tab 的事，与 diff / file 两种 tab 同住一处。
//
// **翻页锚在一个固定的提交上**：每一页都带着 `anchor` 再 `skip`，agent 在两次翻页之间提交一次也
// 不会让第二页重复第一页的最后一条。新提交由「HEAD 挪了 → 重取第一页 → 接在顶上」长出来。

import { signal } from '@preact/signals';
import type {
  CommitDetail,
  CommitPage,
  CommitSummary,
  RepoState,
} from '../../server/shared/protocol';
import { getJson, singleFlight, toMessage } from './http';
import { setIn } from './immutable';
import { ensureUpstreamRefs } from './refs';

export interface LoadedHistory {
  /** 列表顶上那条是哪个 HEAD 时取的。null 即空仓库。 */
  head: string | null;
  commits: readonly CommitSummary[];
  hasMore: boolean;
  /**
   * 翻页的锚点与它在 `commits` 里的位置：下一页问的是「从 `anchor` 起跳过 `commits.length -
   * offset` 条」。新提交接在顶上时锚点不动、`offset` 加上新长出来的条数——锚点一换，已翻到的
   * 那几页就得按新锚点重数一遍。
   */
  anchor: string | null;
  offset: number;
}

/** 已加载的那一串提交。null 即还没取过第一页。 */
export const historyList = signal<LoadedHistory | null>(null);

/** 第一页取不到时的那句话。翻页失败另记在 `moreError`，不让已加载的列表整个变成错误。 */
export const historyError = signal<string | null>(null);

/** 翻页在途。同一时刻只翻一页：哨兵在取的途中再次可见也不重发。 */
export const loadingMore = signal(false);
export const moreError = signal<string | null>(null);

const fresh = (page: CommitPage): LoadedHistory => ({ ...page, anchor: page.head, offset: 0 });

/**
 * 新的第一页与已加载的列表合起来。**新 HEAD 只是在旧 HEAD 之上又长了几条**（agent 最常见的那种
 * 提交）时，把新长出来的那几条接在顶上，已翻到的页与滚动位置都留着；判据是旧 HEAD 出现在新的
 * 第一页里、且它往下那一截与已加载的逐条相同。其余（amend、reset、rebase、一次长出 50 条以上、
 * 合并把旧提交排进了中间）一律以新的第一页整体替换——拼一份对不上的列表比少几页更糟。
 */
export function mergeFirstPage(list: LoadedHistory | null, page: CommitPage): LoadedHistory {
  if (list === null || list.head === null || page.head === null) return fresh(page);
  if (list.head === page.head) return list;
  const at = page.commits.findIndex((commit) => commit.sha === list.head);
  if (at <= 0) return fresh(page);
  const overlap = page.commits.slice(at);
  if (overlap.some((commit, i) => list.commits[i]?.sha !== commit.sha)) return fresh(page);
  return {
    ...list,
    head: page.head,
    commits: [...page.commits.slice(0, at), ...list.commits],
    offset: list.offset + at,
  };
}

/**
 * 重取第一页，并与已加载的那一串合起来（见 `mergeFirstPage`）。**同一时刻只有一次在途，在途期间又被
 * 叫过就回来后补跑一次**（`singleFlight`）：第一页回来之前列表顶上仍是旧 HEAD，每个 SSE 都会判「对不
 * 上」——每次都新发、后发的作废先发的，在 agent 跑动期间就是一串永远落不了地的 `git log`；而只搭车
 * 不补跑时，在途那一次若是 HEAD 挪动之前发出去的，最后那个 SSE 就白来了。
 */
export const refreshHistory = singleFlight(fetchFirstPage);

async function fetchFirstPage(): Promise<void> {
  try {
    const page = await getJson<CommitPage>('/api/commits');
    historyError.value = null;
    const merged = mergeFirstPage(historyList.value, page);
    if (merged === historyList.value) return;
    if (merged.anchor !== historyList.value?.anchor) moreError.value = null;
    historyList.value = merged;
  } catch (cause) {
    historyError.value = toMessage(cause);
  }
}

/**
 * 这份列表还对得上仓库此刻的 HEAD 吗。**判据是 `/api/state` 带来的 HEAD oid，不是「来过 SSE」**：
 * agent 改工作区时每个文件事件都会推一次 SSE，而能让提交列表变的只有 HEAD 挪动——按事件重取等于
 * 每个事件一次 `rev-parse` + `log`。上一次取失败了（`historyError` 还在）也算对不上，切过来即重试。
 */
function historyIsCurrent(state: RepoState): boolean {
  const list = historyList.value;
  if (list === null || historyError.value !== null) return false;
  return list.head === (state.branch.oid ?? null);
}

/**
 * `History` 分区变得可见、或它可见时来了一次 SSE：提交列表对不上 HEAD 才取，上游徽标的 refs 对不上
 * 分支状态才取（`ensureUpstreamRefs`）。两样是这一个分区要的数据，从这一个入口进——调用方有两处
 * （`refresh` 与 `SourceControl` 的可见性 effect），各写一遍时将来加第三样漏一处不报错，只是那一样
 * 在某一种时机下不刷新。
 */
export async function ensureHistory(state: RepoState | null): Promise<void> {
  // HEAD 还不知道就无从比对：此刻去取，state 一到又判一次「对不上」，`singleFlight` 补跑成两遍 `git log`
  if (state === null) return;
  await Promise.all([
    historyIsCurrent(state) ? undefined : refreshHistory(),
    ensureUpstreamRefs(state),
  ]);
}

/**
 * 翻一页。带着锚点与「锚点之下已加载几条」去问；回来时**列表已经换过就丢掉**——中途第一页被整体
 * 替换了，这一页是按旧锚点数的。只是顶上接了新提交（锚点没变）的话，这一页照样接在末尾。
 */
export async function loadMore(): Promise<void> {
  const current = historyList.value;
  if (current === null || current.anchor === null || !current.hasMore || loadingMore.value) return;
  loadingMore.value = true;
  moreError.value = null;
  const { anchor } = current;
  const skip = current.commits.length - current.offset;
  try {
    const query = new URLSearchParams({ head: anchor, skip: String(skip) });
    const page = await getJson<CommitPage>(`/api/commits?${query}`);
    const latest = historyList.value;
    if (
      latest === null ||
      latest.anchor !== anchor ||
      latest.commits.length - latest.offset !== skip
    )
      return;
    historyList.value = {
      ...latest,
      commits: [...latest.commits, ...page.commits],
      hasMore: page.hasMore,
    };
  } catch (cause) {
    if (historyList.value?.anchor === anchor) moreError.value = toMessage(cause);
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

/** 展示用的短哈希：前 7 位，与 `git log --oneline` 的默认一致。完整 sha 只经复制按钮给出。 */
export const shortSha = (sha: string): string => sha.slice(0, 7);
