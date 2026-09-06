// 前端状态。signals 而非 useState:SSE 刷新要在**不丢失当前选中文件与滚动位置**的前提下
// 更新列表，状态必须活在组件树之外。
//
// **前端不内联任何 git 知识**：「这一侧算不算有改动」的判据在 `shared/protocol.ts`——
// 那三个谓词看着像 `!== '.'` 的同义反复，其实不是，`?` 与 `U` 都不能按字面读。本文件只把
// 它们组织成三组；「重命名」同理看 `oldPath` 而不比对路径。

import { computed, signal } from '@preact/signals';
import {
  type DiffPayload,
  type FileEntry,
  type FilePayload,
  hasStagedChange,
  hasUnstagedChange,
  isConflicted,
  isUntracked,
  type RepoState,
} from '../../server/shared/protocol';
import { getJson, latestWins, toMessage } from './http';
import { refreshTree } from './tree';

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

/**
 * `path → 条目`。**建一次，不在每一行里现找**：SSE 每换一份 `files` 数组，文件树上每个可见
 * 行都会重算自己那份 computed，各自 `find` 一遍就是 O(行数 × 变更数)——300 个变更、200 行
 * 可见时每个文件系统事件要跑六万次字符串比较，而这条路每次变更都走。
 */
export const fileByPath = computed(
  () => new Map((repoState.value?.files ?? []).map((file) => [file.path, file])),
);

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

/**
 * 「后发的说了算」。SSE 的每个 `change` 事件都会调一次 `loadState()`，而 agent 跑动期间事件
 * 密集：两次请求重叠时先发的**可能后到**，旧快照就会盖掉新快照，列表停在过期状态直到下一次
 * 事件——不报错，只是显示的东西不对。判据放在这里而不是留给调用方，是因为调用方没有理由知道
 * 这件事；**机制则只有 `http.ts` 那一份**，四个加载器共用它。
 */
const stateTickets = latestWins();

/**
 * 拉一次 `/api/state`。不带任何鉴权参数：token 在生产下由启动 URL 的 302 换成了 HttpOnly
 * cookie、在 `vite dev` 下由代理注入，两条路径浏览器都会自动带上——它一旦落到 JS 能读的
 * 地方，HttpOnly 就白设了。
 *
 * 返回值是「`repoState` 这次换上新快照了吗」，给 `refresh()` 用：失败与被后一次请求顶掉都
 * 返回 false，而这两种情况下 `repoState` 里留着的都是**上一份**快照。
 */
export async function loadState(): Promise<boolean> {
  const ticket = stateTickets.claim();
  try {
    const state = await getJson<RepoState>('/api/state');
    if (!stateTickets.isCurrent(ticket)) return false;
    repoState.value = state;
    loadError.value = null;
    return true;
  } catch (cause) {
    if (!stateTickets.isCurrent(ticket)) return false;
    loadError.value = toMessage(cause);
    return false;
  }
}

/** diff 那一份。三份各有各的计数，互不影响。 */
const diffTickets = latestWins();

/**
 * 清空右侧：置空 + **作废在途的那一次取 diff**，两件必须同时发生。成对写在这里而不是在调用
 * 方展开：漏掉作废那一半的症状是「清空偶尔不生效」——点开 X 之后、响应回来之前 X 从列表里
 * 没了，那次请求回来照旧写成 `ready`，右侧刚清掉又长回来。
 */
function clearDiff(): void {
  diffTickets.claim();
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
  const ticket = diffTickets.claim();
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
    if (!diffTickets.isCurrent(ticket)) return;
    diffState.value = { status: 'ready', path: entry.path, rename, payload };
  } catch (cause) {
    if (!diffTickets.isCurrent(ticket)) return;
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
  // 与 `openFile` 对称：点变更列表就把右侧切回 diff。少了这一句，从文件视图点一条变更
  // 时列表高亮动了而右边纹丝不动——不报错，只是像点空了
  activePane.value = 'diff';
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
  /**
   * 树与右侧那份全文**不依赖新列表**，所以不等 `loadState()` 的结果、也不受它失败的影响：
   * 它们的数据源是工作区本身，而 `loadState()` 失败只说明 status 这一次没取到。
   *
   * **但只给看得见的那一半付钱。** 两处都不是白省：树那一次是 `1 + 展开层数` 个请求、每个
   * 再起三个 `ls-files` 子进程；文件那一次是一次磁盘读加最多 5MB 的 JSON 往返。而 agent
   * 跑动期间这条路每次文件变更都走一遍。看不见时不取也不会留下陈旧内容——切回 `Files` 由
   * `App` 那个 tab effect 补一次，而右侧要换成文件视图只有 `openFile()` 一条路，它自己就取。
   */
  if (activeTab.value === 'files') refreshTree();
  const openFile = fileState.value;
  // **打开着的文件也要重取**，与「打开着的 diff 也要重取」同源：内容变了而树没变是最常见的
  // 形态，只刷树的话右侧停在旧内容上，而页面看不出任何异样
  if (openFile !== null && activePane.value === 'file') void loadFile(openFile.path);

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

/**
 * 右侧面板此刻在展示哪一种东西。**它与侧栏在列什么是两件事**：切 tab 换的是「左边列什么」，
 * 不是「用户此刻在读什么」——VS Code 里换侧栏视图同样不会换掉编辑器。写成「切到 Files 就
 * 清空右侧」时页面看着完全正常，只是每瞄一眼目录树就丢掉正在读的那份 diff。
 */
export const activePane = signal<'diff' | 'file'>('diff');

/**
 * 侧栏此刻列的是哪一档。默认 `changes`——工具存在的理由仍是「瞥一眼改了什么」，目录树是顺带
 * 能做到的第二件事。**不进 `localStorage`**：跨会话保持的偏好目前只有主题一份，加第二份之前
 * 先想清楚它是不是也该有那一节（见 `theme.ts`）。
 */
export const activeTab = signal<'changes' | 'files'>('changes');

/**
 * 只读文件内容的请求状态。形状与 `DiffRequestState` 逐字同构，理由也一样：三态显式建模而不是
 * 「payload + 一个 loading 布尔」，每一态都带着 `path`，渲染前因此能确认「这份结果属于当前
 * 打开的文件」——写错的症状是**在 A 文件的标题下显示 B 文件的内容**，不报错，只是不对。
 */
export type FileRequestState =
  | { status: 'loading'; path: string }
  | { status: 'ready'; path: string; payload: FilePayload }
  | { status: 'error'; path: string; message: string };

/** null 表示还没在树上点过任何文件。 */
export const fileState = signal<FileRequestState | null>(null);

/** 只读全文那一份。 */
const contentTickets = latestWins();

/**
 * 取一个文件的只读全文。
 *
 * **同一个文件重新取时不回退到 loading 态**，与 `loadDiff` 一字不差：一回退，渲染那棵子树整个
 * 卸载，高亮好的 DOM 连同滚动位置一起没了。每个 SSE `change` 事件都会走这里。
 */
export async function loadFile(path: string): Promise<void> {
  const ticket = contentTickets.claim();
  if (fileState.value?.status !== 'ready' || fileState.value.path !== path) {
    fileState.value = { status: 'loading', path };
  }
  try {
    const query = new URLSearchParams({ path });
    const payload = await getJson<FilePayload>(`/api/file?${query}`);
    // 用户在等待期间点了别的文件——这份结果已经是过期的那一个
    if (!contentTickets.isCurrent(ticket)) return;
    fileState.value = { status: 'ready', path, payload };
  } catch (cause) {
    if (!contentTickets.isCurrent(ticket)) return;
    fileState.value = { status: 'error', path, message: toMessage(cause) };
  }
}

/**
 * 在树上点开一个文件：取它的内容，并**把右侧切到文件视图**。两件必须同时发生——只取不切的
 * 症状是点了没反应（内容取回来了，右边还画着上一份 diff）。
 *
 * 与 `selectFile` 分开而不是合成一个：同一个文件从两处点进去看到的是两样东西（补丁 / 全文），
 * 合成一个就得再补一条「这次是从哪点进来的」，而那与 `activePane` 是同一个信息的两处实现。
 */
export function openFile(path: string): void {
  activePane.value = 'file';
  void loadFile(path);
}
