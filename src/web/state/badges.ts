// History 行上的 ref 徽标，照 VS Code Source Control Graph 的 `scm.graph.badges: all`：当前分支与它的上游
// 各一枚、带色，其余分支与标签按种类合成中性色的几枚。全是从 `repoState` 与 `refs.ts` 那份 refs 推出来
// 的派生量，照 `title.ts` 的做法单住一处：读 store 的派生模块不让 store 反过来 import 它。

import { computed } from '@preact/signals';
import type { RefEntry } from '../../server/shared/protocol';
import { graphRefs } from './refs';
import { repoState } from './store';

/**
 * 一枚徽标，按角色判别。**角色不是 `kind`**：上游可以是本地分支（`git branch -u base`），那时它的
 * `kind` 也是 `local`，却照样只画图标。
 * - `head`：当前分支，印名字；
 * - `upstream`：它的上游，只画图标——要回答的「哪几条还没推送」只需要位置；
 * - `group`：其余同一种的 ref 合成一枚，只画图标与条数，名字只进提示。逐个印名字时一条挂着一个远程
 *   分支和两三个标签的提交，主题就被挤没了。
 */
export type RefBadge =
  | { role: 'head'; kind: 'local'; name: string }
  | { role: 'upstream'; kind: BranchKind; name: string }
  | { role: 'group'; kind: RefEntry['kind']; names: string[] };

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
 * 哪条提交上画哪几枚徽标。**当前分支那枚不看 refs**——它就指着 HEAD；`branch` 为空串（detached、
 * 或 status 里没有分支行）时没有分支可标。上游那枚画在它指着的那条，名字与分支列表一致（剥过前缀）。
 * 其余的 ref 按种类合成，次序本地、远程、标签（即 `refs` 本来的分组次序）。
 *
 * **与当前分支、上游同名的那条从其余里去掉**——它们已经以带色那枚画过了。判据是名字不是 sha：refs
 * 是早些时候取的，当前分支在里面的 sha 可能已经落后于 status 给的 HEAD，按 sha 去重会在旧位置上多
 * 画一枚它自己。
 */
export function refBadges(
  branch: string,
  oid: string,
  upstream: RefEntry | null,
  refs: readonly RefEntry[],
): ReadonlyMap<string, readonly RefBadge[]> {
  const badges = new Map<string, RefBadge[]>();
  const push = (sha: string, badge: RefBadge) => {
    const list = badges.get(sha);
    if (list === undefined) badges.set(sha, [badge]);
    else list.push(badge);
  };
  if (branch !== '' && oid !== '') push(oid, { role: 'head', kind: 'local', name: branch });
  if (upstream !== null && upstream.kind !== 'tag')
    push(upstream.sha, { role: 'upstream', kind: upstream.kind, name: upstream.name });
  for (const ref of refs) {
    if (ref.kind === 'local' && ref.name === branch) continue;
    if (upstream !== null && ref.kind === upstream.kind && ref.name === upstream.name) continue;
    // `refs` 按种类排好（本地、远程、标签），同一种的必然挨着：并进这条提交上最后那一枚就够了
    const last = badges.get(ref.sha)?.at(-1);
    if (last?.role === 'group' && last.kind === ref.kind) last.names.push(ref.name);
    else push(ref.sha, { role: 'group', kind: ref.kind, names: [ref.name] });
  }
  return badges;
}

/**
 * 徽标只看分支状态里的这三样，**各自取成字符串**：computed 按值去重，而 `repoState` 每个 SSE 都换一份
 * ——直接依赖它时，agent 改一个文件整张表就重建一次、带徽标的那一两行就重画一次。
 */
const headBranch = computed(() => {
  const branch = repoState.value?.branch;
  return branch === undefined || branch.detached ? '' : branch.head;
});
const headOid = computed(() => repoState.value?.branch.oid ?? '');
const upstreamName = computed(() => repoState.value?.branch.upstream?.name ?? '');

/** 上游此刻指着哪个 ref。拿**此刻的**上游名去推，切了分支、新的 refs 还没回来时也对不错名字。 */
const upstreamTarget = computed(() => {
  const refs = graphRefs.value;
  const name = upstreamName.value;
  return refs === null || name === '' ? null : findUpstream(refs, name);
});

/**
 * 把这一次算出来的表里与上一次内容相同的格子换回上一次的数组，全都相同时整张表换回上一次那张。
 * `refBadges` 每次都造新数组，而各行 `useComputed` 按身份比：不换回去时 refs 每取一次（History 每现身
 * 一次就取一次）、HEAD 每挪一次，每一条挂着标签或分支的行都重画，哪怕它的徽标一枚没变。一条提交上
 * 至多几枚，逐格序列化比较的开销可以忽略。
 */
export function reuseUnchanged(
  previous: ReadonlyMap<string, readonly RefBadge[]>,
  next: ReadonlyMap<string, readonly RefBadge[]>,
): ReadonlyMap<string, readonly RefBadge[]> {
  let changed = previous.size !== next.size;
  const merged = new Map<string, readonly RefBadge[]>();
  for (const [sha, badges] of next) {
    const old = previous.get(sha);
    const same = old !== undefined && JSON.stringify(old) === JSON.stringify(badges);
    merged.set(sha, same ? old : badges);
    if (!same) changed = true;
  }
  return changed ? merged : previous;
}

let lastBadges: ReadonlyMap<string, readonly RefBadge[]> = new Map();

/**
 * 整张表一份 computed，各行再各自 `useComputed` 取自己那一格：没有徽标的行前后都是 `undefined`，
 * 徽标挪了只重画挪出、挪入的那一两行（见 `reuseUnchanged`）。
 */
export const badgesBySha = computed(() => {
  lastBadges = reuseUnchanged(
    lastBadges,
    refBadges(headBranch.value, headOid.value, upstreamTarget.value, graphRefs.value ?? []),
  );
  return lastBadges;
});
