// 文件浏览器的目录树状态。
//
// 与 `store.ts` 同一条理由用 signals 而非 useState：SSE 刷新要在**不丢展开态与滚动位置**的
// 前提下换数据，状态必须活在组件树之外。
//
// **按目录缓存、按目录取**：后端一次只回一层（见 `server/git/tree.ts`），前端这边的一棵树
// 就是「已经取回来的那几层」的并集，展开态单独记一份。

import { signal } from '@preact/signals';
import type { TreeEntry, TreePayload } from '../../server/shared/protocol';
import { getJson, latestWins, toMessage } from './http';

/** 仓库根那一层的键。空串就是后端的口径，不另造一个 `'/'`。 */
export const ROOT = '';

/** 目录路径 → 它的直接子项。没有这个键即「还没取过」。 */
export const treeCache = signal<ReadonlyMap<string, TreeEntry[]>>(new Map());

/** 展开着的目录。根永远算展开，不进这个集合。 */
export const expandedDirs = signal<ReadonlySet<string>>(new Set());

/** 目录路径 → 取它那一层时的错误。**按目录记而不是一个全局错误条**：一层取不到不该让整棵树看起来坏掉。 */
export const treeErrors = signal<ReadonlyMap<string, string>>(new Map());

/**
 * 每个目录各一份「后发的说了算」（机制在 `http.ts`，四个加载器共用）。**不能改成「已经在取
 * 就直接不取」**——那样一次 `change` 引出的刷新会在上一次还没回来时被整个丢掉，而若它正是
 * agent 那一串写入的最后一个事件，这一层就一直停在旧内容上，直到用户手动收起再展开。
 */
const dirTickets = latestWins();

function setIn<V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function removeFrom<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

/**
 * 取一层。
 *
 * `force` 是刷新用的，它同时决定两件事：正常展开时缓存里已经有、或已经在取，就不必再发一次；
 * 而刷新**必须**绕过这两条判据——它要的正是一份新的。重叠时靠序号决胜负（见 `inFlight`），
 * 不靠丢弃。
 */
export async function loadDir(path: string, force = false): Promise<void> {
  if (!force && (treeCache.value.has(path) || dirTickets.pending(path))) return;
  const ticket = dirTickets.claim(path);
  try {
    const query = new URLSearchParams({ path });
    const payload = await getJson<TreePayload>(`/api/tree?${query}`);
    // 已经被后一次请求顶掉——这份结果是过期的那一个
    if (!dirTickets.isCurrent(ticket, path)) return;
    treeCache.value = setIn(treeCache.value, path, payload.entries);
    treeErrors.value = removeFrom(treeErrors.value, path);
  } catch (cause) {
    if (!dirTickets.isCurrent(ticket, path)) return;
    treeErrors.value = setIn(treeErrors.value, path, toMessage(cause));
  } finally {
    dirTickets.release(ticket, path);
  }
}

/** 展开 / 收起一个目录。收起**不丢缓存**：再展开时不该又空一拍。 */
export function toggleDir(path: string): void {
  const next = new Set(expandedDirs.value);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
    void loadDir(path);
  }
  expandedDirs.value = next;
}

/**
 * 一次 SSE `change` 之后重取树。
 *
 * 两道收窄，都是「不为没人看的东西付钱」：
 *
 * - **只重取「根 + 当前展开着的那几层」**，不是整个缓存——收起过的那些层用户此刻看不见，而
 *   它们的缓存留着也不会被画出来，下次展开时这里已经重取过一轮；
 * - **只重取真的取过的那几层**。少了这一条，从没点开过 `Files` 的会话每收到一个 `change`
 *   都要白跑一趟 `ls-files`，而 agent 跑动期间这些事件是密集的——不报错，只是凭空多出一串
 *   谁也不会去看的请求。
 */
export function refreshTree(): void {
  for (const path of [ROOT, ...expandedDirs.value]) {
    if (treeCache.value.has(path)) void loadDir(path, true);
  }
}
