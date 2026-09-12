// 前端状态。signals 而非 useState:SSE 刷新要在**不丢失当前选中文件与滚动位置**的前提下
// 更新列表，状态必须活在组件树之外。右侧那条标签栏的列表模型在 `editors.ts`，本文件只管
// 「打开 / 切到 / 关掉一个 tab 要发哪些请求、缓存怎么进出」。
//
// **前端不内联任何 git 知识**：「这一侧算不算有改动」的判据在 `shared/protocol.ts`——
// 那三个谓词看着像 `!== '.'` 的同义反复，其实不是，`?` 与 `U` 都不能按字面读。本文件只把
// 它们组织成三组；「重命名」同理看 `oldPath` 而不比对路径。

import { batch, computed, type Signal, signal } from '@preact/signals';
import {
  type DiffPayload,
  type FileEntry,
  type FilePayload,
  hasStagedChange,
  hasUnstagedChange,
  isConflicted,
  isUntracked,
  type RepoState,
  type StatusCode,
} from '../../server/shared/protocol';
import {
  activeEditor,
  type Editor,
  type EditorKey,
  editors,
  focusEditor,
  keyOf,
  openEditor,
  removeEditor,
  renameEditor,
} from './editors';
import { getJson, latestWins, type Tickets, toMessage } from './http';
import { removeFrom, setIn } from './immutable';
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
 * 一个 diff tab 的请求状态。三态显式建模而不是「payload + 一个 loading 布尔」：后者在
 * 切换文件的那一瞬间会同时持有上一个文件的 payload 与 loading=true，而写错的症状是**在 A
 * 文件的标题下显示 B 文件的 diff**——不报错，只是不对。「这份结果属于哪个 tab」由它在
 * `diffStates` 里的键回答，状态自己不再带一份 `path`。
 */
export type DiffRequestState =
  | { status: 'loading'; rename: RenameInfo | null }
  | { status: 'ready'; rename: RenameInfo | null; payload: DiffPayload }
  | { status: 'error'; rename: RenameInfo | null; message: string };

/**
 * `FileEntry` 的重命名两个字段 → 一个可选对象。判据是 `oldPath` 存在，**不是比对新旧路径**
 *——重命名与否是 git 的判定，前端不重写一遍。
 */
function renameOf(entry: FileEntry): RenameInfo | null {
  if (entry.oldPath === undefined) return null;
  return { oldPath: entry.oldPath, score: entry.renameScore ?? null };
}

/**
 * 一种 tab 的按路径缓存：状态 map + 那一份「后发的说了算」的票。**按路径而不是按 tab 对象**：
 * 列表刷新后条目是新对象，存对象等于每次刷新都丢选中；而 tab 的身份本来就是路径。Map 每次写
 * 都换一份新的（signals 只认引用变化）——栏里就几个 tab，拷贝可以忽略。
 *
 * `forget` 把删缓存与**作废在途的那一次请求**成对做掉，调用方不展开：漏掉作废那一半的症状是
 * 「关掉的 tab 偶尔又长回来」——关掉 X 之后、响应回来之前，那次请求回来照旧写进缓存，下次再
 * 打开 X 先看到的就是那份过期的。票不 `release`：`latestWins` 那张表随本次会话触过的路径增长，
 * 有界，不为它加一道清理。
 */
interface PathCache<T> {
  readonly states: Signal<ReadonlyMap<string, T>>;
  readonly tickets: Tickets;
  set(path: string, state: T): void;
  forget(path: string): void;
}

function pathCache<T>(): PathCache<T> {
  const states = signal<ReadonlyMap<string, T>>(new Map());
  const tickets = latestWins();
  return {
    states,
    tickets,
    set(path, state) {
      states.value = setIn(states.value, path, state);
    },
    forget(path) {
      tickets.claim(path);
      states.value = removeFrom(states.value, path);
    },
  };
}

const diffCache = pathCache<DiffRequestState>();

/** 栏里每个 diff tab 的请求状态，按路径存。缺项即「没取过 / 已被作废」，视图按加载中画。 */
export const diffStates = diffCache.states;

/** 一个改动条目会有的状态码：`.` 不在其中——它是「这一侧没动」，不是一种改动。 */
export type ChangeCode = Exclude<StatusCode, '.'>;

/**
 * 一个条目在文件树上按哪一位上色。
 *
 * **冲突优先**：冲突条目两侧状态位都不是 `.`，挑哪一位都会说错一半，一律按 `U`。判据走
 * `isConflicted()` 而不是自己读 `conflicted`——那个字段的含义归 `shared/protocol.ts`。其余先看
 * 工作区侧（Y），它是「文件现在长什么样」，正是树上那一行说的东西；Y 干净才退回暂存侧。两侧
 * 都是 `.` 的条目不该出现在 status 里，回 `null` 只是不替解析器编一个字母。
 */
function codeOf(entry: FileEntry): ChangeCode | null {
  if (isConflicted(entry)) return 'U';
  if (entry.unstaged !== '.') return entry.unstaged;
  if (entry.staged !== '.') return entry.staged;
  return null;
}

/**
 * 同一个路径收到多个状态码时的归并优先级，小的赢。冲突最先——那是用户此刻唯一要处理的东西；
 * 其后修改一档（含改类型、重命名、复制）是绝大多数情形；未跟踪是最弱的主张，排最后。**这是展示
 * 上的取舍**：混合目录取哪个都对不了所有人，判据只求稳定。写成 `Record` 而不是数组：漏一个码时
 * 编译器报错，而数组的 `indexOf` 回 -1 会让漏掉的那个静默排到冲突前面。
 */
const CODE_RANK: Record<ChangeCode, number> = { U: 0, M: 1, T: 1, R: 1, C: 1, D: 2, A: 3, '?': 4 };

/**
 * `路径 → 状态码`，文件树上每一行按自己的路径查这一张表。每个改动条目把状态码记到**自己的路径
 * 与所有祖先目录**上，同一个键按 `CODE_RANK` 归并——于是一张表同时回答文件行（自己那一格）、
 * 目录行（后代归并）与 submodule（在树上是一条 `directory`，而改动记在它自己的路径上、不在任何
 * 后代；「自己的路径也算一份」正是让它不需要特判的那一条）。
 *
 * **建一次，不在每一行里现找**：SSE 每换一份 `files` 数组，文件树上每个可见行都会重算自己那份
 * computed，各自扫一遍 `files` 就是 O(行数 × 变更数)——300 个变更、200 行可见时每个文件系统
 * 事件要跑六万次字符串比较，而这条路每次变更都走。这里是几百个条目乘上三五层，一次可以忽略。
 */
export const codeByPath = computed(() => {
  const codes = new Map<string, ChangeCode>();
  const claim = (path: string, code: ChangeCode) => {
    const current = codes.get(path);
    if (current === undefined || CODE_RANK[code] < CODE_RANK[current]) codes.set(path, code);
  };
  for (const file of repoState.value?.files ?? []) {
    const code = codeOf(file);
    if (code === null) continue;
    claim(file.path, code);
    for (
      let slash = file.path.indexOf('/');
      slash !== -1;
      slash = file.path.indexOf('/', slash + 1)
    ) {
      claim(file.path.slice(0, slash), code);
    }
  }
  return codes;
});

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

/** 一个 tab 归哪份缓存，按 `kind` 分派——这是 `kind` 在本文件里唯一要分支的地方。 */
const cacheOf = (editor: Editor): PathCache<DiffRequestState> | PathCache<FileRequestState> =>
  editor.kind === 'diff' ? diffCache : fileCache;

const forget = (editor: Editor): void => cacheOf(editor).forget(editor.path);

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
  const { path } = entry;
  const ticket = diffCache.tickets.claim(path);
  const rename = renameOf(entry);
  /**
   * **同一个文件重新取时不回退到 loading 态**：`ready` 变 `loading` 会让渲染 diff 的那棵子树
   * 整个卸载，diff2html 画好的 DOM 连同滚动位置一起没了，补丁回来后从零重画。每个 SSE
   * `change` 事件与每次切回这个 tab 都会走这里，而要求刷新**不丢选中文件与滚动位置**。
   */
  if (diffStates.value.get(path)?.status !== 'ready')
    diffCache.set(path, { status: 'loading', rename });
  try {
    const query = new URLSearchParams({ path });
    if (entry.oldPath) query.set('oldPath', entry.oldPath);
    const payload = await getJson<DiffPayload>(`/api/diff?${query}`);
    // 这个路径上又发了一次、或 tab 已被关掉——这份结果已经是过期的那一个
    if (!diffCache.tickets.isCurrent(ticket, path)) return;
    diffCache.set(path, { status: 'ready', rename, payload });
  } catch (cause) {
    if (!diffCache.tickets.isCurrent(ticket, path)) return;
    diffCache.set(path, { status: 'error', rename, message: toMessage(cause) });
  }
}

/**
 * 在变更列表上点一个文件：开（或切到）它的 diff tab 并拉 diff。列表只把 `FileEntry` 交回来，
 * 「取 diff 要带哪些参数」留在本文件——组件里再写一遍就等于把双路径要求复制了一份，而两份里
 * 漏改一份是不会报错的。
 *
 * 开出来的一律是预览 tab；固定归 `pinEditor`，双击那一路只调它、不再取一趟——双击是 click、
 * click、dblclick 三个事件，前两个已经各取过一次。被顶掉的预览 tab 由 `openEditor` 交回来，这
 * 里把它忘掉——「这次会不会顶掉预览」只在那一处判。diff 的错误**不写进 `loadError`**：那条横
 * 幅说的是「列表取不到」，一个文件的 diff 失败不该让整个页面看起来坏掉，它显示在右侧自己的位
 * 置上。点当前这一行照样重新取，上面那条「同一个 path 不回退 loading」正好让它不闪。
 */
export function selectFile(entry: FileEntry): void {
  const replaced = openEditor('diff', entry.path);
  if (replaced !== null) forget(replaced);
  void loadDiff(entry);
}

/**
 * 一次 SSE `change` 之后要重取的东西。四条不显然的地方：
 *
 * - **活动的 diff tab 也要重取**，不能只刷列表：文件内容变了而列表条目没变（还是那个 `1 .M`）
 *   是最常见的形态，只刷列表的话右侧停在旧补丁上，而页面看不出任何异样
 * - **先 state 后 diff，且用新列表里的条目**：重命名条目取 diff 必须带 `oldPath`，而相似度
 *   是会变的。**列表没换上新的就整个不取**——`loadState()` 失败时 `repoState` 留着的是上一
 *   份快照，照着它找条目取 diff 就是用过期的 `oldPath`（重命名退化成全新增），而它不报错
 * - **收编要过一遍栏里全部 diff tab，不只活动那一个**：改动被撤销、或被 commit 掉了的 tab
 *   关掉——判据是左栏此刻正在断言这些改动不存在，而右栏还挂着其中一份；只看活动 tab 时后台
 *   tab 里那份补丁照样留着，切过去看到的是一份左栏已经说不存在的东西，且它再也不会被刷新。
 *   **重命名不算消失**：那一行还在左栏列着，跟着它走到新路径上即可
 * - **只重取活动那一个 tab，其余切过去时再取**（`activateEditor` 每次都真的去取）：agent 跑动
 *   期间事件密集，挂着 10 个 diff tab 时每个事件就是 10 趟 `git diff`
 */
export async function refresh(): Promise<void> {
  /**
   * 树与右侧那份全文**不依赖新列表**，所以不等 `loadState()` 的结果、也不受它失败的影响：
   * 它们的数据源是工作区本身，而 `loadState()` 失败只说明 status 这一次没取到。
   *
   * **但只给看得见的那一半付钱。** 两处都不是白省：树那一次是 `1 + 展开层数` 个请求、每个
   * 再起三个 `ls-files` 子进程；文件那一次是一次磁盘读加最多 5MB 的 JSON 往返。而 agent
   * 跑动期间这条路每次文件变更都走一遍。看不见时不取也不会留下陈旧内容——切回 `Files` 由
   * `App` 那个 tab effect 补一次，而后台的 file tab 切过去时 `activateEditor` 自己就取。
   */
  if (activeTab.value === 'files') refreshTree();
  const before = activeEditor.value;
  // **活动的文件也要重取**，与「活动的 diff 也要重取」同源：内容变了而树没变是最常见的
  // 形态，只刷树的话右侧停在旧内容上，而页面看不出任何异样
  if (before?.kind === 'file') void loadFile(before.path);

  if (!(await loadState())) return;
  const files = repoState.value?.files ?? [];
  /**
   * 对着**收编之前那份列表**走一遍（`editors.value` 在循环开始时就取定了，改名并入掉的 tab 不会
   * 被再访一次）。第二次 find 是**跟着重命名走**：改名之后那个路径成了新列表里那一行的
   * `oldPath`，按 `path` 找必然扑空，而改动并没有消失。拿到的是**新条目**，双路径齐全，不会
   * 走到「重命名退化成全新增」那条路。**两趟而不是一趟带 `||` 的谓词**：A→B 改名之后又在 A
   * 位置新建一个文件时，两条都能命中同一个 `path`，而该跟的是路径就是 A 的那条。
   */
  batch(() => {
    for (const editor of editors.value) {
      if (editor.kind !== 'diff') continue;
      const entry =
        files.find((file) => file.path === editor.path) ??
        files.find((file) => file.oldPath === editor.path);
      if (entry === undefined) {
        // 用列表层的 `removeEditor` 而不是 `closeEditor`：后者会顺手重取新邻居，而下面本来
        // 就要取一次活动 tab，两处各取一趟就是一次事件两趟请求
        forget(editor);
        removeEditor(keyOf(editor));
      } else if (entry.path !== editor.path) {
        // 旧路径上的缓存与在途请求一并忘掉，新路径由下面（活动时）或切过去时再取
        forget(editor);
        renameEditor('diff', editor.path, entry.path);
      }
    }
  });

  // 活动的 file tab 上面已经取过：收编只动 diff tab，活动的 file tab 前后是同一个。其余（活动的
  // diff tab；活动的 diff tab 被关、file tab 顶上）都要取一次
  const after = activeEditor.value;
  if (after === null || (after.kind === 'file' && before?.kind === 'file')) return;
  await refetch(after);
}

/**
 * 切到栏里的一个 tab，并**重取它**：后台 tab 在 SSE 时不重取，切过去时它手上那份是离开那一刻
 * 的旧内容。缓存的那份照常显示、新的回来再换掉——「同一个 path 已 ready 不回退 loading」那条
 * 让它不闪。diff 那一路要在新列表里找条目（`oldPath` 要从那里拿），找不到就不取——收编那一步
 * 已经把消失的 tab 关掉了，这里找不到只能是两次刷新之间的窗口，下一次 SSE 会关掉它。
 */
export function activateEditor(key: EditorKey): void {
  const editor = focusEditor(key);
  if (editor !== null) void refetch(editor);
}

/** 重取一个 tab。diff 那一路条目取不到时什么都不发，回一个已完成的 promise。 */
function refetch(editor: Editor): Promise<void> {
  if (editor.kind === 'file') return loadFile(editor.path);
  const entry = repoState.value?.files.find((file) => file.path === editor.path);
  return entry === undefined ? Promise.resolve() : loadDiff(entry);
}

/**
 * 关掉一个 tab：从栏里移除、忘掉它的缓存与在途请求；关的是活动 tab 时顶上来的邻居也要重取
 *——它是后台 tab，手上那份是旧的（理由同 `activateEditor`）。判据是「活动键换了人」，与
 * `refresh()` 同一个写法；写成「活动键 ≠ 被关的键」时关一个后台 tab 也会白取一趟。
 */
export function closeEditor(key: EditorKey): void {
  const before = activeEditor.value;
  const removed = removeEditor(key);
  if (removed === null) return;
  forget(removed);
  const after = activeEditor.value;
  if (after !== null && after !== before) void refetch(after);
}

/**
 * 侧栏此刻列的是哪一档。默认 `changes`——工具存在的理由仍是「瞥一眼改了什么」，目录树是顺带
 * 能做到的第二件事。**不进 `localStorage`**：跨会话保持的偏好目前只有主题一份，加第二份之前
 * 先想清楚它是不是也该有那一节（见 `theme.ts`）。
 */
export const activeTab = signal<'changes' | 'files'>('changes');

/**
 * 只读文件内容的请求状态。形状与 `DiffRequestState` 同构，理由也一样：三态显式建模而不是
 * 「payload + 一个 loading 布尔」——写错的症状是**在 A 文件的标题下显示 B 文件的内容**，不报错，
 * 只是不对。
 */
export type FileRequestState =
  | { status: 'loading' }
  | { status: 'ready'; payload: FilePayload }
  | { status: 'error'; message: string };

const fileCache = pathCache<FileRequestState>();

/** 栏里每个 file tab 的请求状态，按路径存；形状与 `diffStates` 同，理由同。 */
export const fileStates = fileCache.states;

/**
 * 取一个文件的只读全文。
 *
 * **同一个文件重新取时不回退到 loading 态**，与 `loadDiff` 一字不差：一回退，渲染那棵子树整个
 * 卸载，高亮好的 DOM 连同滚动位置一起没了。每个 SSE `change` 事件与每次切回这个 tab 都会走这里。
 */
export async function loadFile(path: string): Promise<void> {
  const ticket = fileCache.tickets.claim(path);
  if (fileStates.value.get(path)?.status !== 'ready') fileCache.set(path, { status: 'loading' });
  try {
    const query = new URLSearchParams({ path });
    const payload = await getJson<FilePayload>(`/api/file?${query}`);
    // 这个路径上又发了一次、或 tab 已被关掉——这份结果已经是过期的那一个
    if (!fileCache.tickets.isCurrent(ticket, path)) return;
    fileCache.set(path, { status: 'ready', payload });
  } catch (cause) {
    if (!fileCache.tickets.isCurrent(ticket, path)) return;
    fileCache.set(path, { status: 'error', message: toMessage(cause) });
  }
}

/**
 * 在树上点开一个文件：开（或切到）它的 file tab 并取内容。两件必须同时发生——只取不切的症状
 * 是点了没反应（内容取回来了，右边还画着上一份 diff）。
 *
 * 与 `selectFile` 分开而不是合成一个：同一个文件从两处点进去看到的是两样东西（补丁 / 全文），
 * 在栏里是两个 tab；合成一个就得再补一条「这次是从哪点进来的」，而那与 tab 的 `kind` 是同一个
 * 信息的两处实现。
 */
export function openFile(path: string): void {
  const replaced = openEditor('file', path);
  if (replaced !== null) forget(replaced);
  void loadFile(path);
}
