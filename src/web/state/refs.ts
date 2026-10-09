// `/api/refs` 的两个消费者：分支列表（整份列表 + 过滤）与 History 的上游徽标（徽标怎么从它推出来在
// `badges.ts`）。两边共用端点、**不共用状态**（理由见 `upstreamRefs`）。**都不跟 SSE**——ref 只在
// 提交、push、fetch、建分支、打标签时变，而 agent 跑动时每个文件事件都推一次 SSE。分支列表在打开时
// 取；徽标在分支状态变了时取（`ensureUpstreamRefs`）。

import { signal } from '@preact/signals';
import type { RefEntry, RefList, RepoState } from '../../server/shared/protocol';
import { getJson, latestWins, toMessage } from './http';

/**
 * 上一次取到的列表；`null` 即还没取到过、或上一次取失败了。再次打开时先画它、回来再换掉。**取失败
 * 即清空**：错误与一份旧列表并排时看不出哪一样才是现在的，这一条在这里定一次，视图不必再判。
 */
export const refList = signal<RefEntry[] | null>(null);
export const refsError = signal<string | null>(null);

const tickets = latestWins();

/** 取一次。两次打开的请求重叠时后发的说了算——先发的那份可能是 fetch 之前的。 */
export async function loadRefs(): Promise<void> {
  const ticket = tickets.claim();
  // 上一次的错误不留到这一次：否则再打开时先看到的是那句旧错误，而不是 `Loading…` 或上一份列表
  refsError.value = null;
  try {
    const { refs } = await getJson<RefList>('/api/refs');
    if (!tickets.isCurrent(ticket)) return;
    refList.value = refs;
  } catch (cause) {
    if (!tickets.isCurrent(ticket)) return;
    refList.value = null;
    refsError.value = toMessage(cause);
  } finally {
    tickets.release(ticket);
  }
}

/**
 * 一次最多画多少条。几千个标签的仓库里整份列表同时挂进 DOM 是一次可感知的卡顿，而这份列表本来
 * 就是拿来搜的。
 */
export const MAX_SHOWN = 200;

/** 只按名字、不区分大小写的子串匹配。后端排好的次序原样保留；没有输入时原样返回，不复制。 */
export function filterRefs(refs: readonly RefEntry[], query: string): readonly RefEntry[] {
  const needle = query.trim().toLowerCase();
  return needle === '' ? refs : refs.filter((ref) => ref.name.toLowerCase().includes(needle));
}

/**
 * History 徽标那半最近一次取到的整份 refs；`null` 即还没取到、或上一次取失败了。**与分支列表的
 * `refList` / `refsError` 分开存**，两边只共用 `/api/refs` 这个端点：共用状态时一边失败会抹掉另一边
 * ——徽标那次取失败把用户正翻着的列表换成一句错误，列表那次取失败把徽标清掉，而徽标这边的判据没
 * 变、再也不会重取。存原样的列表而不是找好的那一个：上游是哪一个由 `badges.ts` 拿**此刻的**上游名
 * 去推，切了分支、新的一次还没回来时也不会拿上一个上游的名字去对。
 */
export const upstreamRefs = signal<readonly RefEntry[] | null>(null);

const upstreamTickets = latestWins();

/** 上一次为徽标取 refs 时的分支状态；`null` 即还没取过、那一次失败了、或此后没了上游。 */
let fetchedFor: string | null = null;

/**
 * 分支状态与上一次取时对不上才取。**判据是 HEAD oid / 上游名 / ahead / behind 四样，不是「来过
 * SSE」**，也**不能只看 HEAD**——push 只挪上游、不挪 HEAD，ahead 那一项就是它在 status 里看得见的
 * 地方。无上游时不取（本地那枚用不着 refs），并忘掉上一次：`--unset-upstream` 之后再设回同一个，四
 * 样可能与当初一字不差，而这期间上游可能已经挪过。调用方只有 `ensureHistory`。
 *
 * 两次重叠时后发的说了算（自己一份 `latestWins`，与分支列表的互不作废）。**失败即清掉
 * `fetchedFor`，但只在这一次仍是最新的时候**：被后一次顶掉的那次，成败由后一次说了算。失败不在
 * History 里报，没取到只是不画上游那枚，下一次判即重试——与提交列表「上次失败也算对不上」同一条。
 */
export async function ensureUpstreamRefs(state: RepoState | null): Promise<void> {
  // `state` 还没到不算「没有上游」，不清判据
  if (state === null) return;
  const { oid, upstream } = state.branch;
  if (!upstream?.name) {
    fetchedFor = null;
    return;
  }
  const key = [oid ?? '', upstream.name, upstream.ahead, upstream.behind].join('\0');
  if (key === fetchedFor) return;
  fetchedFor = key;
  const ticket = upstreamTickets.claim();
  try {
    const { refs } = await getJson<RefList>('/api/refs');
    if (upstreamTickets.isCurrent(ticket)) upstreamRefs.value = refs;
  } catch {
    if (!upstreamTickets.isCurrent(ticket)) return;
    upstreamRefs.value = null;
    fetchedFor = null;
  } finally {
    upstreamTickets.release(ticket);
  }
}

/** 只给用例：模块级的「上一次取时」在用例之间清掉。 */
export function resetUpstreamRefs(): void {
  fetchedFor = null;
  upstreamRefs.value = null;
}
