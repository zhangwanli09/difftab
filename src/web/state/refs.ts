// `/api/refs` 的两个消费者：分支列表（整份列表 + 过滤）与 History 的 ref 徽标（徽标怎么从它推出来在
// `badges.ts`）。两边共用端点、**不共用状态**（理由见 `graphRefs`）。**都不跟 SSE**——ref 只在
// 提交、push、fetch、建分支、打标签时变，而 agent 跑动时每个文件事件都推一次 SSE。分支列表在打开时
// 取；徽标在分支状态变了、或 History 变得可见时取（`ensureGraphRefs`）。

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
 * 去推，切了分支、新的一次还没回来时也不会拿上一个上游的名字去对；其余分支与标签也读这同一份。
 */
export const graphRefs = signal<readonly RefEntry[] | null>(null);

const graphTickets = latestWins();

/** 上一次为徽标取 refs 时的分支状态；`null` 即还没取过、那一次失败了、或判据被作废了。 */
let fetchedFor: string | null = null;

/**
 * 分支状态与上一次取时对不上才取。**判据是 HEAD oid / 上游名 / ahead / behind 四样，不是「来过
 * SSE」**，也**不能只看 HEAD**——push 只挪上游、不挪 HEAD，ahead 那一项就是它在 status 里看得见的
 * 地方。**没有上游也取**：标签与其余分支的徽标要它。上游名以空串进判据，`--unset-upstream` 之后再
 * 设回同一个时判据因此必然变过一次，不会拿当初那份 refs 去画一个可能已经挪过的上游。调用方只有
 * `ensureHistory`。
 *
 * 两次重叠时后发的说了算（自己一份 `latestWins`，与分支列表的互不作废）。**失败即清掉
 * `fetchedFor`，但只在这一次仍是最新的时候**：被后一次顶掉的那次，成败由后一次说了算。失败不在
 * History 里报，没取到只是不画那几枚，下一次判即重试——与提交列表「上次失败也算对不上」同一条。
 */
export async function ensureGraphRefs(state: RepoState | null): Promise<void> {
  if (state === null) return;
  const { oid, upstream } = state.branch;
  const key = [oid ?? '', upstream?.name ?? '', upstream?.ahead ?? 0, upstream?.behind ?? 0].join(
    '\0',
  );
  if (key === fetchedFor) return;
  fetchedFor = key;
  const ticket = graphTickets.claim();
  try {
    const { refs } = await getJson<RefList>('/api/refs');
    if (graphTickets.isCurrent(ticket)) graphRefs.value = refs;
  } catch {
    if (!graphTickets.isCurrent(ticket)) return;
    graphRefs.value = null;
    fetchedFor = null;
  } finally {
    graphTickets.release(ticket);
  }
}

/**
 * 作废判据，下一次 `ensureGraphRefs` 必取。History 每次变得看不见时调，于是再现身时必重取：别处打了
 * 标签、或挪了一条不是当前分支的分支时，四样一样都不变，没有这一下就要等到 HEAD 或上游再动。已取到
 * 的那份留着照画，回来再换。
 */
export function invalidateGraphRefs(): void {
  fetchedFor = null;
}

/** 只给用例：模块级的「上一次取时」在用例之间清掉。 */
export function resetGraphRefs(): void {
  invalidateGraphRefs();
  graphRefs.value = null;
}
