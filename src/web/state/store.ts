// 前端状态。signals 而非 useState:SSE 刷新要在**不丢失当前选中文件与滚动位置**的前提下
// 更新列表，状态必须活在组件树之外。
//
// **前端不内联任何 git 知识**：「这一侧算不算有改动」的判据在 `shared/protocol.ts`——
// 那三个谓词看着像 `!== '.'` 的同义反复，其实不是，`?` 与 `U` 都不能按字面读。本文件只把
// 它们组织成三组；「重命名」同理看 `oldPath` 而不比对路径。

import { computed, signal } from '@preact/signals';
import {
  type DiffPayload,
  type ErrorPayload,
  type FileEntry,
  hasStagedChange,
  hasUnstagedChange,
  isConflicted,
  isUntracked,
  type RepoState,
} from '../../server/shared/protocol';

/** `GET /api/state` 的结果。null 表示还没拿到第一份。 */
export const repoState = signal<RepoState | null>(null);

/** 取不到状态时展示给用户的一句话。后端已保证不含绝对路径。 */
export const loadError = signal<string | null>(null);

/**
 * 这次请求指向的条目是不是重命名来的，以及相似度（`null` = git 没给）。**它跟着请求走，不是
 * 在渲染时去列表里现找**：现找的写法多一份来源，而两份错位的窗口是真实存在的——`refresh`
 * 先换上新列表、`loadDiff` 还没回来的那一段里，右侧显示的仍是旧补丁。
 */
export interface RenameInfo {
  oldPath: string;
  /** `R100` → 100。git 只在识别为重命名/复制时给，取不到就不显示。 */
  score: number | null;
}

/**
 * 当前选中文件的 diff 请求状态。三态显式建模而不是「payload + 一个 loading 布尔」：后者在
 * 切换文件的那一瞬间会同时持有上一个文件的 payload 与 loading=true，而写错的症状是**在 A
 * 文件的标题下显示 B 文件的 diff**——不报错，只是不对。每一态都带着 `path`，渲染前因此能
 * 确认「这份结果属于当前选中的文件」。
 */
export type DiffRequestState =
  | { status: 'loading'; path: string; rename: RenameInfo | null }
  | { status: 'ready'; path: string; rename: RenameInfo | null; payload: DiffPayload }
  | { status: 'error'; path: string; rename: RenameInfo | null; message: string };

/**
 * `FileEntry` 的重命名两个字段 → 一个可选对象。判据是 `oldPath` 存在，**不是比对新旧路径**
 *——重命名与否是 git 的判定，前端不重写一遍。
 */
function renameOf(entry: FileEntry): RenameInfo | null {
  if (entry.oldPath === undefined) return null;
  return { oldPath: entry.oldPath, score: entry.renameScore ?? null };
}

/** null 表示还没选过任何文件。 */
export const diffState = signal<DiffRequestState | null>(null);

/**
 * 当前选中的文件路径——**派生量，不是第二份状态**。两个来源就有「谁是真的」这个问题，组件
 * 里因此长出一条防两者错位的分支，而那条分支既走不到、又得让后来的人反复确认它走不到。存
 * path 而不是 `FileEntry` 对象：列表刷新后条目是新对象，存对象等于每次刷新都丢选中。
 */
export const selectedPath = computed(() => diffState.value?.path ?? null);

export type ChangeGroupId = 'conflicted' | 'staged' | 'unstaged' | 'untracked';

export interface ChangeGroup {
  id: ChangeGroupId;
  title: string;
  files: FileEntry[];
}

/**
 * 四个分组：已暂存、未暂存、未跟踪，外加冲突一组。
 *
 * **同一个文件可以同时出现在「已暂存」和「未暂存」里**，这不是 bug:porcelain 的 XY 是两位
 * 独立状态位，`git add` 之后再改一次就是 `X=M Y=M`。强行归一到一个桶，等于在前端替用户丢掉
 * 一半信息。
 *
 * **冲突是唯一的例外，而且排在最前面**：它两侧状态位都不是 `.`，不单独成组就会同时落进上面
 * 两组，而它哪一组都不属于；排最前是因为 rebase / merge 停在半路时，它就是用户此刻唯一要
 * 处理的东西。组内顺序沿用后端给的（git 自己按路径排好的），不在前端再排一次——多一份排序
 * 意见就多一处与 `git status` 不一致的可能。
 */
export function groupFiles(files: readonly FileEntry[]): ChangeGroup[] {
  return [
    { id: 'conflicted', title: 'Conflicted', files: files.filter(isConflicted) },
    { id: 'staged', title: 'Staged', files: files.filter(hasStagedChange) },
    { id: 'unstaged', title: 'Unstaged', files: files.filter(hasUnstagedChange) },
    // -uall 保证这里是文件粒度，不会是折叠后的 `dir/`
    { id: 'untracked', title: 'Untracked', files: files.filter(isUntracked) },
  ];
}

/** 从任意失败里取一句可展示的话。永远返回非空字符串，免得 UI 出现空白的错误条。 */
function toMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : 'Unknown error';
}

/**
 * 失败响应的正文 → 一句话。**不能直接 `res.json()`**：错误正文未必是 JSON。`pnpm dev` 下后
 * 端没起来时，Vite 代理回的是纯文本 500,`json()` 会先抛 SyntaxError，于是错误条上显示的是
 * 「Unexpected token 'E'…」而不是「后端连不上」——真正的原因被解析错误盖掉了。
 */
function messageFrom(text: string, status: number): string {
  try {
    const payload = JSON.parse(text) as Partial<ErrorPayload>;
    if (payload.error?.message) return payload.error.message;
  } catch {
    // 不是 JSON——这条路径本身就是上面说的那种情况
  }
  return `Request failed (HTTP ${status}).`;
}

/**
 * 取一个 JSON 端点，失败即抛一句可展示的话。两个端点共用一份，是因为上面那条「错误正文先当
 * 文本读」的规矩必须只有一处实现：两份拷贝里有一份被「顺手简化」成 `res.json()`，只有那个
 * 端点会退回显示「Unexpected token 'E'…」，而它照样是绿的。
 *
 * 成功那一路仍走 `res.json()`：「未必是 JSON」只对错误正文成立，而 diff 的正文可以到 5MB，
 * 先 `text()` 再 `JSON.parse()` 等于把它在内存里存两份。竞态判据**不在这里**。
 */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(messageFrom(await res.text(), res.status));
  return (await res.json()) as T;
}

/**
 * 已发出的最新一次请求的序号。SSE 的每个 `change` 事件都会调一次 `loadState()`，而 agent
 * 跑动期间事件密集：两次请求重叠时先发的**可能后到**，旧快照就会盖掉新快照，列表停在过期
 * 状态直到下一次事件——不报错，只是显示的东西不对。判据放在这里而不是留给调用方，是因为
 * 调用方没有理由知道这件事。
 */
let latestRequest = 0;

/**
 * 拉一次 `/api/state`。不带任何鉴权参数：token 在生产下由启动 URL 的 302 换成了 HttpOnly
 * cookie、在 `vite dev` 下由代理注入，两条路径浏览器都会自动带上——它一旦落到 JS 能读的
 * 地方，HttpOnly 就白设了。
 *
 * 返回值是「`repoState` 这次换上新快照了吗」，给 `refresh()` 用：失败与被后一次请求顶掉都
 * 返回 false，而这两种情况下 `repoState` 里留着的都是**上一份**快照。
 */
export async function loadState(): Promise<boolean> {
  const ticket = ++latestRequest;
  try {
    const state = await getJson<RepoState>('/api/state');
    if (ticket !== latestRequest) return false;
    repoState.value = state;
    loadError.value = null;
    return true;
  } catch (cause) {
    if (ticket !== latestRequest) return false;
    loadError.value = toMessage(cause);
    return false;
  }
}

/** `loadState` 那套竞态判据的 diff 版。两条请求各有各的序号，互不影响。 */
let latestDiffRequest = 0;

/**
 * 清空右侧：置空 + **作废在途的那一次取 diff**，两件必须同时发生。成对写在这里而不是在调用
 * 方展开：漏掉作废那一半的症状是「清空偶尔不生效」——点开 X 之后、响应回来之前 X 从列表里
 * 没了，那次请求回来照旧写成 `ready`，右侧刚清掉又长回来。
 */
function clearDiff(): void {
  latestDiffRequest++;
  diffState.value = null;
}

/**
 * 取**一个**文件的 diff（按文件懒加载）。两处不能省的细节：
 *
 * - **重命名条目必须把 `oldPath` 一并传给后端**：只传新路径时 git 只看到一侧、无法配对，会
 *   把重命名退化成一个全新增文件——而页面上看到的是一个内容完整、只是少了 rename from/to
 *   的 diff，不像出错。判据是 `oldPath` 存在，不是自己比对路径
 * - **一次点击只发一个请求**。禁止预取整个列表：agent 单次改 300+ 文件是常态，全仓 diff 会
 *   冻结浏览器主线程数秒到数十秒
 */
export async function loadDiff(entry: FileEntry): Promise<void> {
  const ticket = ++latestDiffRequest;
  const current = diffState.value;
  const rename = renameOf(entry);
  /**
   * **同一个文件重新取时不回退到 loading 态**：`ready` 变 `loading` 会让渲染 diff 的那棵子树
   * 整个卸载，diff2html 画好的 DOM 连同滚动位置一起没了，补丁回来后从零重画。每个 SSE
   * `change` 事件都会走这里，而要求刷新**不丢选中文件与滚动位置**。换文件才必须清空：留着
   * 上一个文件的 payload，新标题下会短暂挂着旧 diff。
   */
  if (current?.status !== 'ready' || current.path !== entry.path) {
    diffState.value = { status: 'loading', path: entry.path, rename };
  }
  try {
    const query = new URLSearchParams({ path: entry.path });
    if (entry.oldPath) query.set('oldPath', entry.oldPath);
    const payload = await getJson<DiffPayload>(`/api/diff?${query}`);
    // 用户在等待期间点了别的文件——这份结果已经是过期的那一个
    if (ticket !== latestDiffRequest) return;
    diffState.value = { status: 'ready', path: entry.path, rename, payload };
  } catch (cause) {
    if (ticket !== latestDiffRequest) return;
    diffState.value = { status: 'error', path: entry.path, rename, message: toMessage(cause) };
  }
}

/**
 * 选中一个文件并拉它的 diff。列表只把 `FileEntry` 交回来，「取 diff 要带哪些参数」留在本文件
 *——组件里再写一遍就等于把双路径要求复制了一份，而两份里漏改一份是不会报错的。
 *
 * diff 的错误**不写进 `loadError`**：那条横幅说的是「列表取不到」，一个文件的 diff 失败不该
 * 让整个页面看起来坏掉，它显示在右侧自己的位置上。点当前这一行照样重新取，上面那条「同一个
 * path 不回退 loading」正好让它不闪。
 */
export function selectFile(entry: FileEntry): void {
  void loadDiff(entry);
}

/**
 * 一次 SSE `change` 之后要重取的东西。三条不显然的地方：
 *
 * - **打开着的 diff 也要重取**，不能只刷列表：文件内容变了而列表条目没变（还是那个 `1 .M`）
 *   是最常见的形态，只刷列表的话右侧停在旧补丁上，而页面看不出任何异样
 * - **先 state 后 diff，且用新列表里的条目**：重命名条目取 diff 必须带 `oldPath`，而相似度
 *   是会变的。**列表没换上新的就整个不取**——`loadState()` 失败时 `repoState` 留着的是上一
 *   份快照，照着它找条目取 diff 就是用过期的 `oldPath`（重命名退化成全新增），而它不报错
 * - **选中的文件从列表里消失了（改动被撤销、或被 commit 掉了），就连选中态一起清空**：判据是
 *   左栏此刻正在断言这些改动不存在，而右栏还在展示其中一份——工作区整个变干净时最刺眼。
 *   **重命名不算消失**：那一行还在左栏列着，跟着它走到新路径上即可
 */
export async function refresh(): Promise<void> {
  if (!(await loadState())) return;
  const path = selectedPath.value;
  if (path === null) return;
  const files = repoState.value?.files ?? [];
  // 第二次 find 是**跟着重命名走**：改名之后选中的那个路径成了新列表里那一行的 `oldPath`，
  // 按 `path` 找必然扑空，而改动并没有消失。拿到的是**新条目**，双路径齐全，不会走到「重命名
  // 退化成全新增」那条路。**两趟而不是一趟带 `||` 的谓词**：A→B 改名之后又在 A 位置新建一个
  // 文件时，两条都能命中同一个 `path`，而该选的是路径就是 A 的那条
  const entry =
    files.find((file) => file.path === path) ?? files.find((file) => file.oldPath === path);
  if (entry === undefined) return clearDiff();
  await loadDiff(entry);
}
