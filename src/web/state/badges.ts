// History 行上的 ref 徽标：当前分支与它的上游各一枚，画在各自指着的那条提交上，照 VS Code Source
// Control Graph 默认只画图里那几条 ref。全是从 `repoState` 与 `refs.ts` 那份 refs 推出来的派生量，
// 照 `title.ts` 的做法单住一处：读 store 的派生模块不让 store 反过来 import 它。

import { computed } from '@preact/signals';
import type { RefEntry } from '../../server/shared/protocol';
import { upstreamRefs } from './refs';
import { repoState } from './store';

/** 一枚徽标。标签不画，所以只有两种。 */
export interface RefBadge {
  kind: Exclude<RefEntry['kind'], 'tag'>;
  name: string;
}

/** `/api/refs` 剥掉的前缀，拼回去就是完整的 refname。 */
const REF_PREFIX: Record<RefBadge['kind'], string> = {
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
 * 哪条提交上画哪几枚徽标。**本地那枚不看 refs**——当前分支就指着 HEAD；`branch` 为空串（detached、
 * 或 status 里没有分支行）时没有分支可标。上游那枚画在它指着的那条，名字与分支列表一致（剥过前缀）。
 * 两枚落在同一条上时本地在前。
 */
export function refBadges(
  branch: string,
  oid: string,
  upstream: RefEntry | null,
): ReadonlyMap<string, readonly RefBadge[]> {
  const badges = new Map<string, RefBadge[]>();
  if (branch !== '' && oid !== '') badges.set(oid, [{ kind: 'local', name: branch }]);
  if (upstream !== null && upstream.kind !== 'tag') {
    const badge: RefBadge = { kind: upstream.kind, name: upstream.name };
    badges.set(upstream.sha, [...(badges.get(upstream.sha) ?? []), badge]);
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
  const refs = upstreamRefs.value;
  const name = upstreamName.value;
  return refs === null || name === '' ? null : findUpstream(refs, name);
});

/**
 * 整张表一份 computed，各行再各自 `useComputed` 取自己那一格：没有徽标的行前后都是 `undefined`，
 * 徽标挪了只重画挪出、挪入的那一两行。
 */
export const badgesBySha = computed(() =>
  refBadges(headBranch.value, headOid.value, upstreamTarget.value),
);
