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

/** 能当上游的那两种 ref。 */
export type BranchKind = Exclude<RefEntry['kind'], 'tag'>;

/** `/api/refs` 剥掉的前缀，拼回去就是完整的 refname。 */
const REF_PREFIX: Record<BranchKind, string> = {
  local: 'refs/heads/',
  remote: 'refs/remotes/',
};

/**
 * git 把一个缩写的 refname 解析回完整名字的次序（`ref_rev_parse_rules`），去掉标签与
 * `refs/remotes/%s/HEAD` 两条——上游不会是它们。`# branch.upstream` 的值是 git 按同一套规则缩写
 * 出来的，**名字有歧义时会带上前缀**（实测 2.54：有个标签也叫 `main` 时写 `heads/main`，有个本地
 * 分支也叫 `origin/main` 时写 `remotes/origin/main`，全有歧义时是完整的 `refs/…`），按这几条依次
 * 拼回去就对得上，不必一种前缀写一个特例。
 */
const PARSE_RULES = ['', 'refs/', 'refs/heads/', 'refs/remotes/'];

/** 上游在 refs 里是哪一个：按 git 的解析次序找，标签不算。 */
export function findUpstream(refs: readonly RefEntry[], upstream: string): RefEntry | null {
  for (const rule of PARSE_RULES) {
    const full = rule + upstream;
    const ref = refs.find((r) => r.kind !== 'tag' && REF_PREFIX[r.kind] + r.name === full);
    if (ref !== undefined) return ref;
  }
  return null;
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
 * `graphRefs` 此刻那份是按哪一个分支状态取回来的。与 `fetchedFor` 分开：后者在发请求时就记上，在途
 * 期间它已是新的、而 `graphRefs` 还是旧的那份。
 */
let arrivedFor: string | null = null;

/** 分支状态的判据：HEAD oid / 上游名 / ahead / behind 四样。 */
function branchKey(state: RepoState): string {
  const { oid, upstream } = state.branch;
  return [oid ?? '', upstream?.name ?? '', upstream?.ahead ?? 0, upstream?.behind ?? 0].join('\0');
}

/**
 * 按 `state` 这一份分支状态取回来的 refs；还在途、或手里那份是别的分支状态时取的，就是 `null`。
 * 要拿上游 sha 去发请求的一方读它而不是 `graphRefs`：fetch 之后 behind 已变、新 refs 还在途时，旧的
 * 那份里的上游还指着 fetch 之前那条。
 */
export function graphRefsFor(state: RepoState): readonly RefEntry[] | null {
  return arrivedFor === branchKey(state) ? graphRefs.value : null;
}

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
  const key = branchKey(state);
  if (key === fetchedFor) return;
  fetchedFor = key;
  const ticket = graphTickets.claim();
  try {
    const { refs } = await getJson<RefList>('/api/refs');
    if (!graphTickets.isCurrent(ticket)) return;
    graphRefs.value = refs;
    arrivedFor = key;
  } catch {
    if (!graphTickets.isCurrent(ticket)) return;
    graphRefs.value = null;
    fetchedFor = null;
    arrivedFor = null;
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
  arrivedFor = null;
}
