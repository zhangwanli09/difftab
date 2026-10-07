// 分支列表的状态：`/api/refs` 的那一份，外加纯函数的过滤。**只在列表打开时取**，不跟 SSE——ref
// 只在 fetch / 建分支 / 打标签时变，而 agent 跑动时每个文件事件都推一次 SSE。

import { signal } from '@preact/signals';
import type { RefEntry, RefList } from '../../server/shared/protocol';
import { getJson, latestWins, toMessage } from './http';

/** 上一次取到的列表；`null` 即还没取到过。再次打开时先画它、回来再换掉。 */
export const refList = signal<RefEntry[] | null>(null);
export const refsError = signal<string | null>(null);

const tickets = latestWins();

/** 取一次。两次打开的请求重叠时后发的说了算——先发的那份可能是 fetch 之前的。 */
export async function loadRefs(): Promise<void> {
  const ticket = tickets.claim();
  try {
    const { refs } = await getJson<RefList>('/api/refs');
    if (!tickets.isCurrent(ticket)) return;
    refList.value = refs;
    refsError.value = null;
  } catch (cause) {
    if (tickets.isCurrent(ticket)) refsError.value = toMessage(cause);
  } finally {
    tickets.release(ticket);
  }
}

/**
 * 一次最多画多少条。几千个标签的仓库里整份列表同时挂进 DOM 是一次可感知的卡顿，而这份列表本来
 * 就是拿来搜的。
 */
export const MAX_SHOWN = 200;

/** 只按名字、不区分大小写的子串匹配。后端排好的次序原样保留。 */
export function filterRefs(refs: readonly RefEntry[], query: string): RefEntry[] {
  const needle = query.trim().toLowerCase();
  return needle === '' ? [...refs] : refs.filter((ref) => ref.name.toLowerCase().includes(needle));
}
