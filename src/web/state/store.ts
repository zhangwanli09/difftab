// 前端状态(spec §5.4)。signals 而非 useState:SSE 刷新要在**不丢失当前选中文件
// 与滚动位置**的前提下更新列表,状态必须活在组件树之外(§5.4 / §5.7)。
//
// 本文件是 §5.0 不变式 4 的落脚点之一:**前端不内联任何 git 知识**。
// 「这一侧算不算有改动」的判据在 `shared/protocol.ts`(`hasStagedChange` 等)——
// 那三个谓词看着像 `!== '.'` 的同义反复,其实不是,`?` 与 `U` 都不能按字面读。
// 本文件只负责把它们组织成三组;「重命名」同理看 `oldPath` 而不比对路径。

import { computed, signal } from '@preact/signals';
import {
  type DiffPayload,
  type ErrorPayload,
  type FileEntry,
  hasStagedChange,
  hasUnstagedChange,
  isUntracked,
  type RepoState,
} from '../../server/shared/protocol';

/** `GET /api/state` 的结果。null 表示还没拿到第一份。 */
export const repoState = signal<RepoState | null>(null);

/** 取不到状态时展示给用户的一句话。后端已保证不含绝对路径(§5.12)。 */
export const loadError = signal<string | null>(null);

/**
 * 当前选中文件的 diff 请求状态。
 *
 * 三态显式建模而不是「payload + 一个 loading 布尔」:后者在切换文件的那一瞬间会
 * 同时持有上一个文件的 payload 与 loading=true,渲染时到底信哪个全看写法,而写错
 * 的症状是**在 A 文件的标题下显示 B 文件的 diff** —— 不报错,只是不对。
 *
 * 每一态都带着 `path`,DiffPane 因此能在渲染前确认「这份结果属于当前选中的文件」。
 */
export type DiffRequestState =
  | { status: 'loading'; path: string }
  | { status: 'ready'; path: string; payload: DiffPayload }
  | { status: 'error'; path: string; message: string };

/** null 表示还没选过任何文件。 */
export const diffState = signal<DiffRequestState | null>(null);

/**
 * 当前选中的文件路径 —— **派生量,不是第二份状态**。
 *
 * 早先它是一个独立 signal,与 `diffState.path` 由 `selectFile` 一同写。两个来源就有
 * 「谁是真的」这个问题,组件里因此长出一条防两者错位的分支,而那条分支既走不到、
 * 又得让后来的人反复确认它走不到。派生之后错位不可表示,分支自然消失。
 *
 * 存 path 而不是 `FileEntry` 对象:列表刷新后条目是新对象,存对象等于每次刷新
 * 都丢选中。path 是 §5.12 里 `/api/diff` 的键,天然是这个身份(§5.4)。
 */
export const selectedPath = computed(() => diffState.value?.path ?? null);

export type ChangeGroupId = 'staged' | 'unstaged' | 'untracked';

export interface ChangeGroup {
  id: ChangeGroupId;
  title: string;
  files: FileEntry[];
}

/**
 * 三个分组(spec §6「变更文件列表……已暂存、未暂存、未跟踪三类文件均正确展示」)。
 *
 * **同一个文件可以同时出现在「已暂存」和「未暂存」里**,这不是 bug:porcelain 的
 * XY 是两位独立状态位,`git add` 之后再改一次就是 `X=M Y=M`(fixture 里的 c.txt)。
 * 强行归一到一个桶,等于在前端替用户丢掉一半信息 —— 而「agent 执行过 git add 后
 * 已暂存的改动仍能展示不遗漏」正是 §6 点名的验收项。
 *
 * 顺序沿用后端给的顺序(git 自己按路径排好的),不在前端再排一次:多一份排序意见
 * 就多一处与 `git status` 不一致的可能,而验收标准是「与 git status 结果一致」。
 */
export function groupFiles(files: readonly FileEntry[]): ChangeGroup[] {
  return [
    { id: 'staged', title: '已暂存', files: files.filter(hasStagedChange) },
    { id: 'unstaged', title: '未暂存', files: files.filter(hasUnstagedChange) },
    // -uall 保证这里是文件粒度,不会是折叠后的 `dir/`(§5.2)
    { id: 'untracked', title: '未跟踪', files: files.filter(isUntracked) },
  ];
}

/** 从任意失败里取一句可展示的话。永远返回非空字符串,免得 UI 出现空白的错误条。 */
function toMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : '未知错误';
}

/**
 * 失败响应的正文 → 一句话。
 *
 * **不能直接 `res.json()`**:错误正文未必是 JSON。`pnpm dev` 下后端没起来时,
 * Vite 代理回的是纯文本 500,`json()` 会先抛 SyntaxError,于是错误条上显示的是
 * 「Unexpected token 'E'…」而不是「后端连不上」—— 真正的原因被解析错误盖掉了。
 */
function messageFrom(text: string, status: number): string {
  try {
    const payload = JSON.parse(text) as Partial<ErrorPayload>;
    if (payload.error?.message) return payload.error.message;
  } catch {
    // 不是 JSON —— 这条路径本身就是上面说的那种情况
  }
  return `请求失败(HTTP ${status})`;
}

/**
 * 取一个 JSON 端点,失败即抛一句可展示的话。
 *
 * 两个端点共用一份,是因为上面那条「错误正文先当文本读」的规矩必须只有一处实现:
 * 两份拷贝里有一份被「顺手简化」成 `res.json()`,只有那个端点会退回显示
 * 「Unexpected token 'E'…」,而它照样是绿的 —— 现有那条单测只盖 `/api/state`。
 *
 * 成功那一路仍走 `res.json()`:「未必是 JSON」只对错误正文成立,而 diff 的正文可以
 * 到 5MB(§5.2 的阈值),先 `text()` 再 `JSON.parse()` 等于把它在内存里存两份。
 *
 * 竞态判据**不在这里**:两个调用方各有各的序号,且要在拿到结果后才比对(见下)。
 */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(messageFrom(await res.text(), res.status));
  return (await res.json()) as T;
}

/**
 * 已发出的最新一次请求的序号。
 *
 * S3b1 起 SSE 的每个 `change` 事件都会调一次 `loadState()`,而 agent 跑动期间事件
 * 密集:两次请求重叠时先发的**可能后到**,旧快照就会盖掉新快照,列表停在过期
 * 状态直到下一次事件 —— 不报错,只是显示的东西不对。判据放在这里而不是留给调用方,
 * 是因为调用方没有理由知道这件事。
 */
let latestRequest = 0;

/**
 * 拉一次 `/api/state`。
 *
 * 不带任何鉴权参数:token 在生产下由启动 URL 的 302 换成了 HttpOnly cookie、在
 * `vite dev` 下由代理注入(§5.9 / §5.11),两条路径浏览器都会自动带上。前端因此
 * 完全不接触 token —— 它一旦落到 JS 能读的地方,HttpOnly 就白设了。
 *
 * 返回值是「`repoState` 这次换上新快照了吗」,给 `refresh()` 用:失败与被后一次请求
 * 顶掉都返回 false,而这两种情况下 `repoState` 里留着的都是**上一份**快照。
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

/** `loadState` 那套竞态判据的 diff 版。两条请求各有各的序号,互不影响。 */
let latestDiffRequest = 0;

/**
 * 取**一个**文件的 diff(spec §5.2 的按文件懒加载)。
 *
 * 两处不能省的细节:
 *
 * - **重命名条目必须把 `oldPath` 一并传给后端**。只传新路径时 git 只看到一侧、无法
 *   配对,会把重命名退化成一个全新增文件(已实测,§5.2),「重命名识别并标注」随之
 *   落空 —— 而页面上看到的是一个内容完整、只是少了 rename from/to 的 diff,不像出错。
 *   判据是 `oldPath` 存在,不是自己比对路径(§5.0 不变式 4)
 * - **一次点击只发一个请求**。禁止预取整个列表:agent 单次改 300+ 文件是常态,
 *   全仓 diff 会冻结浏览器主线程数秒到数十秒(§5.2 / §6 的 300+ 文件验收项)
 */
export async function loadDiff(entry: FileEntry): Promise<void> {
  const ticket = ++latestDiffRequest;
  const current = diffState.value;
  /**
   * **同一个文件重新取时不回退到 loading 态**。
   *
   * 回退的代价不是闪一下:`ready` 变 `loading` 会让渲染 diff 的那棵子树整个卸载,
   * diff2html 画好的 DOM 连同滚动位置一起没了,补丁回来后从零重画。今天的表现是
   * 「再点一次当前行(或它在另一组里的那一行)整个面板闪空」;到 S3b1 之后,每个
   * SSE `change` 事件都会走这里,而 §5.4 要求刷新**不丢选中文件与滚动位置** ——
   * 那正是不自己写 reconcile、改用框架的理由,在这里回退等于把它退掉。
   *
   * 换文件才必须清空:留着上一个文件的 payload,新标题下会短暂挂着旧 diff。
   */
  if (current?.status !== 'ready' || current.path !== entry.path) {
    diffState.value = { status: 'loading', path: entry.path };
  }
  try {
    const query = new URLSearchParams({ path: entry.path });
    if (entry.oldPath) query.set('oldPath', entry.oldPath);
    const payload = await getJson<DiffPayload>(`/api/diff?${query}`);
    // 用户在等待期间点了别的文件 —— 这份结果已经是过期的那一个
    if (ticket !== latestDiffRequest) return;
    diffState.value = { status: 'ready', path: entry.path, payload };
  } catch (cause) {
    if (ticket !== latestDiffRequest) return;
    diffState.value = { status: 'error', path: entry.path, message: toMessage(cause) };
  }
}

/**
 * 选中一个文件并拉它的 diff。
 *
 * 列表只把 `FileEntry` 交回来,「取 diff 要带哪些参数」留在本文件 —— 组件里再写一遍
 * 就等于把 §5.2 的双路径要求复制了一份,而两份里漏改一份是不会报错的。
 *
 * diff 的错误**不写进 `loadError`**:那条横幅说的是「列表取不到」,一个文件的 diff
 * 失败不该让整个页面看起来坏掉,它显示在右侧自己的位置上。
 *
 * 点当前这一行**照样重新取**,这是有意的:在 S3b1 的自动刷新到位之前,再点一次是
 * 用户唯一的手动刷新手段。上面那条「同一个 path 不回退 loading」正好让它不闪。
 */
export function selectFile(entry: FileEntry): void {
  void loadDiff(entry);
}

/**
 * 一次 SSE `change` 之后要重取的东西(spec §5.7 / §5.8)。
 *
 * 三条不显然的地方:
 *
 * - **打开着的 diff 也要重取**,不能只刷列表:文件内容变了而列表条目没变(还是那个
 *   `1 .M`)是最常见的形态,只刷列表的话右侧停在旧补丁上,而页面看不出任何异样。
 *   `loadDiff` 里那条「同一个 path 不回退 loading」正是为这条路准备的 —— 否则每个
 *   事件都会把 diff2html 画好的 DOM 连同滚动位置一起卸载重挂(§5.4)
 * - **先 state 后 diff,且用新列表里的条目**:重命名条目取 diff 必须带 `oldPath`
 *   (§5.2 的双路径),而相似度是会变的,拿旧条目去取等于用过期的 `oldPath`。
 *   **列表没换上新的就整个不取**:`loadState()` 失败时 `repoState` 留着的是上一份
 *   快照,照着它找条目取 diff,恰好就是上面那句要避免的事 —— 而它不报错,只是
 *   `oldPath` 过期(重命名退化成全新增)。被后一次 `refresh` 顶掉时同理:那一次
 *   自己会接着取,这一次没有理由再拿旧列表补一枪
 * - **选中的文件从列表里消失了就不动它**(改动被撤销、或被 commit 掉了)。留着最后
 *   那份 diff,比把右侧突然清空更接近用户的心智 —— 他刚才在读的东西还在,只是
 *   左侧不再高亮。切换文件自然会把它换掉
 */
export async function refresh(): Promise<void> {
  if (!(await loadState())) return;
  const path = selectedPath.value;
  if (path === null) return;
  const entry = repoState.value?.files.find((file) => file.path === path);
  if (entry) await loadDiff(entry);
}
