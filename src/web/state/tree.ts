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
import { removeFrom, setIn } from './immutable';

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

/**
 * 取一层。
 *
 * **每次调用都真的去取**：「缓存里已经有就不必再发」不在这里——展开与刷新两条路要的都是一份
 * 新的（理由各见 `toggleDir` 与 `refreshTree`），只有 `App` 切到 `Files` 时取根那一处要「取过
 * 就不再取」，那条判据因此写在它自己那里。当过所有人的默认时，它以「展开后少几行」的形式还
 * 债，而那既不报错也不空白。
 *
 * `force` 于是只剩一个意思：**连「已经在飞」也要再发一趟**。刷新要的正是这个——「已经在取就
 * 直接不取」会把一次 `change` 引出的刷新整个丢掉，而若它正是 agent 那一串写入的最后一个事件，
 * 这一层就一直停在旧内容上。重叠时靠序号决胜负（见 `dirTickets`），不靠丢弃。
 */
export async function loadDir(path: string, force = false): Promise<void> {
  if (!force && dirTickets.pending(path)) return;
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

/**
 * 展开 / 收起一个目录。收起**不丢缓存**：再展开时不该又空一拍。
 *
 * **展开一律去取一份新的**：收起期间这一层不在 `refreshTree` 的范围里，缓存停在收起那一刻，而
 * agent 正在往里写文件——直接拿缓存交差，页面上就是一份陈旧的目录，一直旧到下一个 `change` 到
 * 达，不报错、也不空白，只是少了几行。手上那份仍然照画（旧行留在原处、不空一拍），新的回来再
 * 换掉。
 *
 * **不传 `force`**：连点两下时后一次搭在前一次那趟上就够了，一次展开与一次 SSE 刷新撞上时也只
 * 发一趟。绕过防重是刷新那侧才需要的事。
 */
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
 * 全部折叠：树回到只剩根那一层。
 *
 * **只清展开态、不动 `treeCache`**——与 `toggleDir` 收起那一半逐字同一条理由：再展开时不该又
 * 空一拍，而陈旧由展开那侧重取兜底。
 *
 * **已经是空集时不必自己短路**：`Row` 那份 computed 是记忆化的，空集换空集重算出同一个 `false`、
 * 一行都不会重画，写下去是真的无操作。这一下把整棵树移出 `refreshTree` 的范围，而它恰恰是用户
 * 准备回头继续翻树时按的——**「展开一律重取」那条因此是这枚按钮成立的前提**，见 `toggleDir`。
 */
export function collapseAll(): void {
  expandedDirs.value = new Set();
}

/**
 * 一次 SSE `change` 之后重取树。
 *
 * 两道收窄，都是「不为没人看的东西付钱」：
 *
 * - **只重取「根 + 当前展开着的那几层」**，不是整个缓存——收起过的那些层用户此刻看不见，它们
 *   的缓存留着也不会被画出来。**这条收窄不欠债**：再展开时 `toggleDir` 自己会去取一份新的，所
 *   以这里省掉的那一趟不会以「展开后少几行」的形式冒出来；
 * - **只重取真的取过的那几层**。少了这一条，从没点开过 `Files` 的会话每收到一个 `change`
 *   都要白跑一趟 `ls-files`，而 agent 跑动期间这些事件是密集的——不报错，只是凭空多出一串
 *   谁也不会去看的请求。
 */
export function refreshTree(): void {
  for (const path of [ROOT, ...expandedDirs.value]) {
    if (treeCache.value.has(path)) void loadDir(path, true);
  }
}
