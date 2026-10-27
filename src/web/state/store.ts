// 前端状态。signals 而非 useState:SSE 刷新要在**不丢失当前选中文件与滚动位置**的前提下
// 更新列表，状态必须活在组件树之外。右侧那条标签栏的列表模型在 `editors.ts`，本文件只管
// 「打开 / 切到 / 关掉一个 tab 要发哪些请求、缓存怎么进出」。
//
// **前端不内联任何 git 知识**：「这一侧算不算有改动」的判据在 `shared/protocol.ts`——
// 那三个谓词看着像 `!== '.'` 的同义反复，其实不是，`?` 与 `U` 都不能按字面读。本文件只把
// 它们组织成三组；「重命名」同理看 `oldPath` 而不比对路径。

import { batch, computed, type ReadonlySignal, type Signal, signal } from '@preact/signals';
import {
  type CommitFileEntry,
  type CommitSummary,
  type DiffPayload,
  type FileEntry,
  type FilePayload,
  type FilePreview,
  hasStagedChange,
  hasUnstagedChange,
  type ImagePreview,
  isAbsentFromHead,
  isConflicted,
  isUntracked,
  type RepoState,
  type StatusCode,
} from '../../server/shared/protocol';
import { type LineMark, marksOf } from '../diff/marks';
import { parsePatch } from '../diff/parse';
import {
  activeEditor,
  activeGroup,
  contextOf,
  type DiffContext,
  type Editor,
  type EditorGroup,
  type EditorKey,
  editorKey,
  findEditor,
  focusEditor,
  groups,
  isOpenAnywhere,
  isPatchEditor,
  keyOf,
  moveEditor,
  openChangesEditor,
  openCommitChangesEditor,
  openCommitEditor,
  openEditor,
  removeEditor,
  renameEditor,
  revealPending,
  type SplitSide,
  setEditorContext,
  setReveal,
  splitEditor,
  visibleEditors,
} from './editors';
import { ensureCommitDetail, ensureHistory } from './history';
import { getJson, latestWins, type Tickets, toMessage } from './http';
import { removeFrom, setIn } from './immutable';
import { refreshSearch } from './search';
import { historyCollapsed } from './sidebar';
import { ancestorDirs, refreshTree } from './tree';

/** `GET /api/state` 的结果。null 表示还没拿到第一份。 */
export const repoState = signal<RepoState | null>(null);

/** 取不到状态时展示给用户的一句话。后端已保证不含绝对路径。 */
export const loadError = signal<string | null>(null);

/**
 * 这次请求指向的条目是不是重命名来的。**它跟着请求走，不是
 * 在渲染时去列表里现找**：现找的写法多一份来源，而两份错位的窗口是真实存在的——`refresh`
 * 先换上新列表、`loadDiff` 还没回来的那一段里，右侧显示的仍是旧补丁。
 */
export interface RenameInfo {
  oldPath: string;
}

/**
 * 一个 diff tab 的请求状态。三态显式建模而不是「payload + 一个 loading 布尔」：后者在
 * 切换文件的那一瞬间会同时持有上一个文件的 payload 与 loading=true，而写错的症状是**在 A
 * 文件的标题下显示 B 文件的 diff**——不报错，只是不对。「这份结果属于哪个 tab」由它在
 * `diffStates` 里的键回答，状态自己不再带一份 `path`。
 */
export type DiffRequestState =
  | { status: 'loading'; rename: RenameInfo | null; options: PatchRequest }
  | {
      status: 'ready';
      rename: RenameInfo | null;
      payload: DiffPayload;
      /**
       * **这份 payload 是什么**，不是请求里问了什么：忽略空白取自请求，整份上下文取自 payload（带着
       * `fullContext=1` 却被退回 3 行时记成关）。视图按它渲染，不读此刻的开关；commit tab 的
       * `refetch` 拿它与此刻要的那一档比。
       */
      options: PatchRequest;
      /**
       * 一次按这一档的重取正在路上，而画面上留着的仍是上面那份。只有 commit tab 用：它的 `refetch`
       * 要靠这个判「已经在取了」，否则 SSE 每来一次就新发一趟、新票作废旧票，慢补丁永远落不了地。
       */
      pending?: PatchRequest;
    }
  | { status: 'error'; rename: RenameInfo | null; message: string };

/** 一次补丁请求带的两个开关。 */
export interface PatchRequest {
  ignoreWhitespace: boolean;
  fullContext: boolean;
}

/** 两样都关：起步那一档。 */
export const PATCH_DEFAULTS: PatchRequest = { ignoreWhitespace: false, fullContext: false };

const samePatchRequest = (a: PatchRequest, b: PatchRequest) =>
  a.ignoreWhitespace === b.ignoreWhitespace && a.fullContext === b.fullContext;

/**
 * 一份提交补丁要不要（再）取：没取过、上次失败了，或取的那一档与此刻要的不同。**在途也算取过**——
 * 状态是 `loading`、或 `ready` 带着 `pending` 即有一次在途，判的是在途那一档：每次都重发时新票作废
 * 旧票，一份几百毫秒才回来的补丁永远落不了地。commit tab 的 `refetch` 与整次提交视图的分段共用它。
 */
function needsFetch(state: DiffRequestState | undefined, wanted: PatchRequest): boolean {
  // 在途的那一档优先：`ready` 带着 `pending` 时画面上是旧的、路上是新的
  const settledAs = inFlightRequest(state) ?? (state?.status === 'ready' ? state.options : null);
  return settledAs === null || !samePatchRequest(settledAs, wanted);
}

/** 在途那一趟按哪一档在取：`loading`，或 `ready` 带着 `pending`；没有在途回 `null`。 */
function inFlightRequest(state: DiffRequestState | undefined): PatchRequest | null {
  if (state?.status === 'loading') return state.options;
  return state?.status === 'ready' ? (state.pending ?? null) : null;
}

/**
 * 忽略空白的开关。**全局一份，不分 tab**（照 VS Code，那是一个全局设置）；**不进 `localStorage`**：
 * 端口随机，记了也跨不了实例，理由同版式 override。写入方只有 `toggleIgnoreWhitespace`。
 */
export const ignoreWhitespace = signal(false);

/**
 * SVG 预览的开关。全局一份、默认开、不进 `localStorage`，理由同忽略空白。写入方只有
 * `toggleSvgPreview`。
 */
export const svgPreview = signal(true);

/**
 * 文件视图的自动换行。全局一份、默认关、不进 `localStorage`，理由同忽略空白；diff 表格不跟它（两张表
 * 逐行对齐全靠固定行高）。写入方只有 `toggleWordWrap`。
 */
export const wordWrap = signal(false);

/**
 * payload 上那份 SVG 预览，不看开关。**判据只认字段**，不判扩展名——那张表只在后端。动作区画不画
 * `Preview` 由它定。
 */
export function previewOf(payload: DiffPayload): ImagePreview | undefined;
export function previewOf(payload: FilePayload): FilePreview | undefined;
export function previewOf(
  payload: DiffPayload | FilePayload,
): ImagePreview | FilePreview | undefined;
export function previewOf(
  payload: DiffPayload | FilePayload,
): ImagePreview | FilePreview | undefined {
  return 'preview' in payload ? payload.preview : undefined;
}

/**
 * 此刻要按图画的那份预览：payload 带着、开关开着，且（file tab）这个文件没挂着跳行请求——那一行
 * 要在文本里才看得见。视图画什么、`Panel` 要不要 `fill`、文件视图套不套宽盒、`Preview` 按没按下
 * 都读它——几处各判时，开着预览的面板会不居中，或宽图把滚动区撑到原始像素宽。
 */
export function shownPreview(payload: DiffPayload): ImagePreview | undefined;
export function shownPreview(payload: FilePayload, path: string): FilePreview | undefined;
export function shownPreview(
  payload: DiffPayload | FilePayload,
  path?: string,
): ImagePreview | FilePreview | undefined {
  // 先看 payload：不带预览的 tab（绝大多数）就不订阅开关与跳行请求
  const preview = previewOf(payload);
  if (preview === undefined || !svgPreview.value) return undefined;
  return path !== undefined && revealPending(path) ? undefined : preview;
}

/** 这个 tab 此刻该按哪一档取：开关是全局的，上下文档是 tab 自己的。 */
const patchRequestOf = (editor: Editor | undefined): PatchRequest => ({
  ignoreWhitespace: ignoreWhitespace.value,
  fullContext: contextOf(editor) === 'full',
});

/** 两个开关写进 query。关着的不写——后端缺省即关，且只认 `1`。 */
function setPatchQuery(query: URLSearchParams, options: PatchRequest): void {
  if (options.ignoreWhitespace) query.set('ignoreWhitespace', '1');
  if (options.fullContext) query.set('fullContext', '1');
}

/** 按 `request` 取回来的 `payload` 是哪一档：整份上下文只认 payload 的 `full`。 */
const fetchedAs = (request: PatchRequest, payload: DiffPayload): PatchRequest => ({
  ignoreWhitespace: request.ignoreWhitespace,
  fullContext: payload.kind === 'text' && payload.full,
});

/**
 * 带着 `fullContext=1` 取回来的却不是整份上下文：后端说过不了闸。这个 tab（整次提交视图里是这一段）
 * 从此记成 `unavailable`、退回 3 行上下文。`too-large` 同样记：文件长过了字节闸时后端先按整份上下文
 * 撞一次、退回 3 行再撞一次，留在 `full` 就是每个 SSE 白跑两趟 git。二进制与图片不记——它们与上下文
 * 无关，文件变回文本时照常能展开。
 */
const unavailableAfter = (request: PatchRequest, payload: DiffPayload): boolean =>
  request.fullContext &&
  ((payload.kind === 'text' && !payload.full) || payload.kind === 'too-large');

/**
 * 取一份补丁要知道的：路径、重命名的旧路径；带 `sha` 即那次提交里的那一版（`/api/commit-diff`），不带即
 * 工作区（`/api/diff`）。`FileEntry`、`CommitFileEntry` 与 commit tab 都直接满足它。
 */
interface PatchTarget {
  path: string;
  oldPath?: string | undefined;
  sha?: string | undefined;
}

/**
 * `oldPath` → 一个可选对象。判据是 `oldPath` 存在，**不是比对新旧路径**——重命名与否是 git 的判定，
 * 前端不重写一遍。
 */
function renameOf(target: PatchTarget): RenameInfo | null {
  return target.oldPath === undefined ? null : { oldPath: target.oldPath };
}

/**
 * 补丁请求的 query：路径，重命名时再带 `oldPath`，提交里的那一版再带 `sha`。**只此一处拼**：漏带 `oldPath`
 * 时 git 只看到一侧、把重命名退化成全新增，而页面上不像出错。
 */
function patchQueryOf({ path, oldPath, sha }: PatchTarget): URLSearchParams {
  const query = new URLSearchParams({ path });
  if (oldPath) query.set('oldPath', oldPath);
  if (sha !== undefined) query.set('sha', sha);
  return query;
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
  /**
   * 整批忘掉键满足 `owned` 的那几格，成对的规矩同 `forget`。**表只换一次**：逐键 `forget` 时每删一格就
   * 复制一遍整张表，几百段就是几百次整表复制。状态里没有的键不会有在途请求——每次取都先写一格。
   */
  forgetWhere(owned: (path: string) => boolean): void;
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
    forgetWhere(owned) {
      // 工作区那一侧每个 SSE 都来剪一次，多半一格都不剪：先扫一遍键，不为「什么都不删」复制整张表
      if (!someKey(states.value, owned)) return;
      const kept = [...states.value].filter(([path]) => !owned(path));
      for (const path of states.value.keys()) if (owned(path)) tickets.claim(path);
      states.value = new Map(kept);
    },
  };
}

/** 表里有没有一个键满足 `owned`。 */
function someKey(map: ReadonlyMap<string, unknown>, owned: (key: string) => boolean): boolean {
  for (const key of map.keys()) if (owned(key)) return true;
  return false;
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
export function codeOf(entry: FileEntry): ChangeCode | null {
  if (isConflicted(entry)) return 'U';
  if (entry.unstaged !== '.') return entry.unstaged;
  if (entry.staged !== '.') return entry.staged;
  return null;
}

/**
 * 同一个路径收到多个状态码时的归并优先级，小的赢。冲突最先——那是用户此刻唯一要处理的东西；
 * 其后修改一档（改类型同档、重命名与复制紧随）是绝大多数情形；未跟踪是最弱的主张，排最后。
 * **这是展示上的取舍**：混合目录取哪个都对不了所有人，判据只求稳定。**每个码各占一档、不许
 * 并列**：并列时先到的赢，一旦两者颜色不同，目录的颜色就随 porcelain 的条目顺序变——各占一档就
 * 不必去管哪两个码此刻恰好同色。写成 `Record` 而不是数组：漏一个码时编译器报错，而数组的
 * `indexOf` 回 -1 会让漏掉的那个静默排到冲突前面。
 */
const CODE_RANK: Record<ChangeCode, number> = { U: 0, M: 1, T: 2, R: 3, C: 4, D: 5, A: 6, '?': 7 };

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
    for (const dir of ancestorDirs(file.path)) claim(dir, code);
  }
  return codes;
});

export type ChangeGroupId = 'conflicted' | 'staged' | 'unstaged';

export interface ChangeGroup {
  id: ChangeGroupId;
  title: string;
  files: FileEntry[];
}

/**
 * 段内的比较照 VS Code `compareFileNames`：numeric（`file2` 在 `file10` 前）、不分大小写。
 * `undefined` locale 即运行时默认——VS Code 也是按用户 locale 排的。
 */
const segmentCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * 照 VS Code Source Control 列表视图的 `comparePaths`：按 `/` 逐段比，**同一层里文件排在子目录
 * 之前**，段内用上面那个 collator。不沿用 git 的字节序：那样 `src/pages-x/a.vue` 排在
 * `src/pages.json` 前面（`-` 0x2D < `.` 0x2E），与读者在编辑器里看的那份对不上。collator 判平
 * （只差大小写）时**在这一段上**退回码元序（同 VS Code），同一份输入每次排出同一个顺序；留到整条
 * 路径才判的话，`Docs/` 与 `docs/` 两个目录下的文件会按下一段交错成一锅。
 *
 * 树视图不另排：它按传入顺序插入目录与文件，喂进来的已是这个顺序，同层目录与同层文件就各自是
 * collator 序。
 */
export function comparePaths(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  const lastLeft = left.length - 1;
  const lastRight = right.length - 1;
  for (let k = 0; ; k++) {
    const endLeft = k === lastLeft;
    const endRight = k === lastRight;
    if (endLeft !== endRight) return endLeft ? -1 : 1;
    const l = left[k] ?? '';
    const r = right[k] ?? '';
    const order = segmentCollator.compare(l, r) || (l < r ? -1 : l > r ? 1 : 0);
    if (order !== 0) return order;
    if (endLeft) return 0;
  }
}

const sortedByPath = (files: readonly FileEntry[]): FileEntry[] =>
  [...files].sort((a, b) => comparePaths(a.path, b.path));

/**
 * 三个分组，照 VS Code Source Control 的默认：冲突、已暂存、工作区改动（含未跟踪）。
 *
 * **同一个文件可以同时出现在「已暂存」和「Changes」里**，这不是 bug:porcelain 的 XY 是两位
 * 独立状态位，`git add` 之后再改一次就是 `X=M Y=M`。强行归一到一个桶，等于在前端替用户丢掉
 * 一半信息。
 *
 * **冲突是唯一的例外，而且排在最前面**：它两侧状态位都不是 `.`，不单独成组就会同时落进上面
 * 两组，而它哪一组都不属于；排最前是因为 rebase / merge 停在半路时，它就是用户此刻唯一要
 * 处理的东西。
 *
 * **未跟踪混在 `Changes` 里**（VS Code `git.untrackedChanges` 的默认值 `mixed`）。porcelain v2
 * 先吐全部已跟踪记录、再吐 `?` 记录，每组按 `comparePaths` 整组重排，未跟踪于是落回各自的位置。
 */
export function groupFiles(files: readonly FileEntry[]): ChangeGroup[] {
  return [
    { id: 'conflicted', title: 'Merge Changes', files: sortedByPath(files.filter(isConflicted)) },
    { id: 'staged', title: 'Staged Changes', files: sortedByPath(files.filter(hasStagedChange)) },
    {
      id: 'unstaged',
      title: 'Changes',
      // -uall 保证未跟踪那侧是文件粒度，不会是折叠后的 `dir/`
      files: sortedByPath(files.filter((f) => hasUnstagedChange(f) || isUntracked(f))),
    },
  ];
}

/**
 * 工作区改动视图里的段：变更列表自上而下的次序（冲突、已暂存、工作区改动），**同一个文件只留第一次
 * 出现的那一个**——一段是一份 `git diff HEAD`，两组里的同一个文件是同一份补丁。
 */
export function changesFilesOf(files: readonly FileEntry[]): FileEntry[] {
  const seen = new Set<string>();
  const ordered: FileEntry[] = [];
  for (const group of groupFiles(files)) {
    for (const file of group.files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      ordered.push(file);
    }
  }
  return ordered;
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

/**
 * 忘掉一个 tab 的缓存与在途请求，按 `kind` 分派到它那份缓存。键：diff / file 按路径，commit 直接用
 * tab 的键——同一个文件在两次提交里是两份，而 tab 的身份本来就把 sha 编进去了，不另编一套；
 * commit-changes 是整组（这次提交的每一段）一起忘。
 *
 * **另一组还开着同键时什么都不做**：缓存两组共用，删了另一组那份就退回 `Loading…`，在途的那趟被作废
 * 后再也不来。所以调用方都在把 tab 从组里摘掉**之后**才调。
 */
function forget(editor: Editor): void {
  if (isOpenAnywhere(keyOf(editor))) return;
  switch (editor.kind) {
    case 'diff':
      diffCache.forget(editor.path);
      return;
    case 'file':
      fileCache.forget(editor.path);
      fileMarksCache.forget(editor.path);
      return;
    case 'commit':
      commitDiffCache.forget(keyOf(editor));
      return;
    case 'commit-changes':
      forgetCommitChanges(editor.sha);
      return;
    case 'changes':
      changeSegments.forgetWhere(() => true);
      return;
  }
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
  const { path } = entry;
  const ticket = diffCache.tickets.claim(path);
  const rename = renameOf(entry);
  const key = editorKey('diff', path);
  const options = patchRequestOf(findEditor(key));
  /**
   * **同一个文件重新取时不回退到 loading 态**：`ready` 变 `loading` 会让渲染 diff 的那棵子树
   * 整个卸载，画好的 DOM 连同滚动位置一起没了，补丁回来后从零重画。每个 SSE
   * `change` 事件与每次切回这个 tab 都会走这里，而要求刷新**不丢选中文件与滚动位置**。
   */
  if (diffStates.value.get(path)?.status !== 'ready')
    diffCache.set(path, { status: 'loading', rename, options });
  try {
    const query = patchQueryOf(entry);
    setPatchQuery(query, options);
    const payload = await getJson<DiffPayload>(`/api/diff?${query}`);
    // 这个路径上又发了一次、或 tab 已被关掉——这份结果已经是过期的那一个
    if (!diffCache.tickets.isCurrent(ticket, path)) return;
    batch(() => {
      diffCache.set(path, {
        status: 'ready',
        rename,
        payload,
        options: fetchedAs(options, payload),
      });
      if (unavailableAfter(options, payload)) setEditorContext(key, 'unavailable');
    });
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
 * - **先 state 后 diff，且用新列表里的条目**：重命名条目取 diff 必须带 `oldPath`，而配对
 *   是会变的。**列表没换上新的就整个不取**——`loadState()` 失败时 `repoState` 留着的是上一
 *   份快照，照着它找条目取 diff 就是用过期的 `oldPath`（重命名退化成全新增），而它不报错
 * - **收编要过一遍栏里全部 diff tab，不只活动那一个**：改动被撤销、或被 commit 掉了的 tab
 *   关掉——判据是左栏此刻正在断言这些改动不存在，而右栏还挂着其中一份；只看活动 tab 时后台
 *   tab 里那份补丁照样留着，切过去看到的是一份左栏已经说不存在的东西，且它再也不会被刷新。
 *   **重命名不算消失**：那一行还在左栏列着，跟着它走到新路径上即可
 * - **只重取看得见的那几个 tab（每组的活动 tab），其余切过去时再取**（`activateEditor` 每次都真的
 *   去取）：agent 跑动期间事件密集，挂着 10 个 diff tab 时每个事件就是 10 趟 `git diff`
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
  // 搜索同理：看得见才重搜，看不见只记一笔、切回来时补（`App` 那个 tab effect）。它也不依赖新列表
  const search = refreshSearch(activeTab.value === 'search');
  const before = visibleEditors.value;
  // **看得见的文件也要重取**，与「活动的 diff 也要重取」同源：内容变了而树没变是最常见的
  // 形态，只刷树的话右侧停在旧内容上，而页面看不出任何异样
  for (const editor of before) if (editor.kind === 'file') void loadFile(editor.path);

  if (!(await loadState())) return;
  // 改动标记要等新列表：这个文件还在不在列表里、`oldPath` 是哪个，都得按新的一份判
  // 同一个文件两组各开一份时只取一趟
  const filePaths = new Set(before.filter((editor) => editor.kind === 'file').map((e) => e.path));
  const marks = [...filePaths].map(loadFileMarks);
  // 提交列表要等新列表：判据是新 state 里的 HEAD oid——HEAD 没挪就一条请求都不发。看不见时不判，
  // 变回看得见时 `SourceControl` 那个 effect 拿当时的 state 再判一次（ref 徽标的 refs 同一个入口）
  const history = historyVisible.value ? ensureHistory(repoState.value) : null;
  const files = repoState.value?.files ?? [];
  /**
   * 对着**收编之前那份列表**逐组走一遍（每组的 `editors.value` 在循环开始时就取定了，改名并入掉的 tab
   * 不会被再访一次）。第二次 find 是**跟着重命名走**：改名之后那个路径成了新列表里那一行的
   * `oldPath`，按 `path` 找必然扑空，而改动并没有消失。拿到的是**新条目**，双路径齐全，不会
   * 走到「重命名退化成全新增」那条路。**先查 `path` 再查 `oldPath`，而不是一趟带 `||` 的谓词**：A→B 改名之后又在 A
   * 位置新建一个文件时，两条都能命中同一个 `path`，而该跟的是路径就是 A 的那条。
   *
   * **两组都收编完才 `forget`**：同一个 diff 两组各开一份时，先收编的那组忘掉时另一组还开着它，
   * `forget` 会认为它还在用而什么都不做。
   */
  // 两张索引各建一次：逐个 tab 去 `find` 是「组 × tab × 文件」，agent 一次改几百个文件时每个 SSE 都要扫
  const byPath = new Map(files.map((file) => [file.path, file]));
  const byOldPath = new Map(
    files.flatMap((file) => (file.oldPath === undefined ? [] : [[file.oldPath, file] as const])),
  );
  batch(() => {
    const dropped: Editor[] = [];
    for (const group of groups.value) {
      for (const editor of group.editors.value) {
        if (editor.kind !== 'diff') continue;
        const entry = byPath.get(editor.path) ?? byOldPath.get(editor.path);
        if (entry === undefined) {
          // 用列表层的 `removeEditor` 而不是 `closeEditor`：后者会顺手重取新邻居，而下面本来
          // 就要取一次看得见的 tab，两处各取一趟就是一次事件两趟请求
          removeEditor(keyOf(editor), group);
          dropped.push(editor);
        } else if (entry.path !== editor.path) {
          // 旧路径上的缓存与在途请求一并忘掉，新路径由下面（看得见时）或切过去时再取
          renameEditor('diff', editor.path, entry.path, group);
          dropped.push(editor);
        }
      }
    }
    for (const editor of dropped) forget(editor);
    // 工作区改动视图不收编（不关），只剪掉已不在列表里的段；留着的段要不要重取由视图里的段自己判
    if (isOpenAnywhere(editorKey('changes')))
      changeSegments.forgetWhere((path) => !byPath.has(path));
  });

  // 看得见的 file tab 上面已经取过：收编只动 diff tab，它们前后是同一个。其余（看得见的 diff tab；
  // 被关的 diff tab 让出位置、顶上来的 file tab）都要取一次
  const fetched = new Set(before.filter((editor) => editor.kind === 'file').map(keyOf));
  const fetches = visibleEditors.value
    .filter((editor) => !fetched.has(keyOf(editor)))
    .map((editor) => refetch(editor));
  await Promise.all([history, ...marks, ...fetches, search]);
}

/**
 * 切到栏里的一个 tab，并**重取它**：后台 tab 在 SSE 时不重取，切过去时它手上那份是离开那一刻
 * 的旧内容。缓存的那份照常显示、新的回来再换掉——「同一个 path 已 ready 不回退 loading」那条
 * 让它不闪。diff 那一路要在新列表里找条目（`oldPath` 要从那里拿），找不到就不取——收编那一步
 * 已经把消失的 tab 关掉了，这里找不到只能是两次刷新之间的窗口，下一次 SSE 会关掉它。
 */
export function activateEditor(key: EditorKey, group = activeGroup.value): void {
  const editor = focusEditor(key, group);
  if (editor !== null) void refetch(editor);
}

/**
 * 重取一个 tab。diff 那一路条目取不到时什么都不发，回一个已完成的 promise；changes 什么都不发。
 * **commit tab 只在没取到时重取**：一次提交不可变，`ready` 的那份就是它的全部；而上次失败了（网络抖
 * 一下、后端重启）的话，切过来就是重试的时机——不然唯一的重试路径是回 `History` 重新展开再点一次。
 * commit-changes 同理，只补取详情；各段由视图按可见性自己取。
 */
function refetch(editor: Editor): Promise<void> {
  // 工作区改动视图的各段由视图按可见性自己取，这里没有要补的
  if (editor.kind === 'changes') return Promise.resolve();
  if (editor.kind === 'commit-changes') {
    ensureCommitDetail(editor.sha);
    return Promise.resolve();
  }
  if (editor.kind === 'commit') {
    // 取到了就不再取，在途也不再取（`needsFetch`）：每次 SSE 都重发一次时，补丁在 agent 跑动期间永远
    // 轮不到落地，tab 就一直停在 `Loading…`。**例外是取的那一档与此刻不同**（切了忽略空白、点开了
    // 折叠行）：这两样只在用户点了什么时才变，不会有 SSE 那种饿死
    return needsFetch(commitDiffStates.value.get(keyOf(editor)), patchRequestOf(editor))
      ? loadCommitDiff(editor)
      : Promise.resolve();
  }
  if (editor.kind === 'file') return loadFileTab(editor.path);
  const entry = entryOf(editor);
  return entry === undefined ? Promise.resolve() : loadDiff(entry);
}

/** diff tab 在当前列表里的那一行；不在（两次刷新之间的窗口）时 `refetch` 什么都不发。 */
const entryOf = (editor: Editor): FileEntry | undefined =>
  repoState.value?.files.find((file) => file.path === editor.path);

/**
 * 关掉一个 tab：从栏里移除、忘掉它的缓存与在途请求；关的是活动 tab 时顶上来的邻居也要重取
 *——它是后台 tab，手上那份是旧的（理由同 `activateEditor`）。判据是「活动键换了人」，与
 * `refresh()` 同一个写法；写成「活动键 ≠ 被关的键」时关一个后台 tab 也会白取一趟。
 */
export function closeEditor(key: EditorKey, group = activeGroup.value): void {
  const before = group.active.value;
  const removed = removeEditor(key, group);
  if (removed === null) return;
  forget(removed);
  // 关空了的那组已经合并掉，`active` 是 null：剩下那组的活动 tab 一直看得见，不用重取
  const after = group.active.value;
  if (after !== null && after !== before) void refetch(after);
}

/**
 * 把一个 tab 拖到另一组（`index` 是插在标签栏的第几个之前）。拖过去的那份切过去即取，理由同
 * `activateEditor`；源组的活动 tab 被拖走时顶上来的邻居同样要取。
 */
export function moveEditorTo(
  from: EditorGroup,
  key: EditorKey,
  to: EditorGroup,
  index?: number,
): void {
  refetchAfterMove(from, () => moveEditor(from, key, to, index));
}

/** 把一个 tab 拖到唯一那组正文贴左 / 右的那一边：在那一边分出新组，取法同 `moveEditorTo`。 */
export function splitEditorTo(from: EditorGroup, key: EditorKey, side: SplitSide): void {
  refetchAfterMove(from, () => splitEditor(from, key, side));
}

function refetchAfterMove(from: EditorGroup, move: () => Editor | null): void {
  const before = from.active.value;
  const landed = move();
  if (landed === null) return;
  // 拖的正是源组看得见的那个时，它手上那份是新的（缓存两组共用），不再取一趟
  if (before === null || keyOf(before) !== keyOf(landed)) void refetch(landed);
  const after = from.active.value;
  if (after !== null && after !== before) void refetch(after);
}

/**
 * 侧栏此刻列的是哪一档。默认 `changes`——工具存在的理由仍是「瞥一眼改了什么」，目录树是顺带
 * 能做到的第二件事。**不进 `localStorage`**：落盘的只有主题与把手尺寸，理由同列表版式（见
 * `change-tree.ts`）。
 */
export const activeTab = signal<'changes' | 'files' | 'search'>('changes');

/**
 * 提交历史此刻该不该判：`Changes` 档、`History` 分区展开着、且第一份 state 已经到了。看不见时 SSE
 * 不判 HEAD，变回看得见那一刻由 `SourceControl` 补判一次——与树「只给看得见的那一半付钱」同一条。
 *
 * **state 没到时不算**：分区默认可见，挂载那一刻 HEAD 未知、必判「对不上」而先发一趟；那趟还没回来
 * 时 state 一到又判一次，`singleFlight` 补跑——每开一次页面两遍 `git log`。
 */
export const historyVisible = computed(
  () => activeTab.value === 'changes' && !historyCollapsed.value && repoState.value !== null,
);

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
 * 点开一个文件的全文：开（或切到）它的 file tab 并取内容。两件必须同时发生——只取不切的症状
 * 是点了没反应（内容取回来了，右边还画着上一份 diff）。目录树上单击走缺省的预览档；变更列表
 * 那枚 `Open file` 走 `pinned`（VS Code `git.openFile` 是 `preview: false`），开出来就是固定 tab、
 * 不顶掉现有的预览——两档的差别全在 `openEditor` 里，这里只透传。
 *
 * 与 `selectFile` 分开而不是合成一个：同一个文件从两处点进去看到的是两样东西（补丁 / 全文），
 * 在栏里是两个 tab；合成一个就得再补一条「这次是从哪点进来的」，而那与 tab 的 `kind` 是同一个
 * 信息的两处实现。
 */
export function openFile(
  path: string,
  { pinned = false, line }: { pinned?: boolean; line?: number } = {},
): void {
  const replaced = openEditor('file', path, pinned);
  if (replaced !== null) forget(replaced);
  setReveal(path, line);
  void loadFileTab(path);
}

const fileMarksCache = pathCache<readonly LineMark[]>();

/**
 * 栏里每个 file tab 行号旁的改动标记，按路径存。**缺项即不画**：文件不在变更列表里、补丁不是文本、
 * 取失败，三种都是「没有可标的」，不另设状态——标记是全文上的点缀，它的错误不该占面板一行。
 */
export const fileMarkStates = fileMarksCache.states;

/**
 * 取一个 file tab 的改动标记：这个路径此刻在变更列表里、且 HEAD 里有它（`isAbsentFromHead`）才取
 * 它的 `/api/diff`（与 diff tab 同一条，`oldPath` 取此刻那一行的），否则清掉。按 `PATCH_DEFAULTS` 取、
 * 不跟忽略空白：标记回答「这行动过没有」，空白改动也是改动。`AM` 也不标：VS Code 在那里对着暂存区画
 * 剩下的改动，而 `/api/diff` 只有 HEAD 一个基准，标出来仍是整份绿条。重取期间照常留着旧的一份，理由同
 * `loadFile`；标记与手上那份逐项相同时不写，不为没变的标记唤醒每个看得见的文件视图。
 */
async function loadFileMarks(path: string): Promise<void> {
  const entry = entryByPath.value.get(path);
  // `forget` 连同在途那一趟一起作废：文件刚撤销回干净时，上一份 state 发出的那趟不许落地
  if (entry === undefined || isAbsentFromHead(entry)) return fileMarksCache.forget(path);
  const ticket = fileMarksCache.tickets.claim(path);
  try {
    const payload = await getJson<DiffPayload>(`/api/diff?${patchQueryOf(entry)}`);
    if (!fileMarksCache.tickets.isCurrent(ticket, path)) return;
    if (payload.kind !== 'text') return fileMarksCache.forget(path);
    const marks = marksOf(parsePatch(payload.patch));
    if (!sameMarks(fileMarkStates.value.get(path), marks)) fileMarksCache.set(path, marks);
  } catch {
    if (fileMarksCache.tickets.isCurrent(ticket, path)) fileMarksCache.forget(path);
  }
}

const sameMarks = (a: readonly LineMark[] | undefined, b: readonly LineMark[]): boolean =>
  a?.length === b.length &&
  a.every((m, i) => m.kind === b[i]?.kind && m.line === b[i]?.line && m.count === b[i]?.count);

/**
 * 一个 file tab 要的两样：全文与改动标记。打开、切过去都走这里——两处各写一对时，下一个入口只记得
 * `loadFile`，标记就静默停在旧的那份上。SSE 那一路例外（`refresh`）：标记要等新列表。
 */
function loadFileTab(path: string): Promise<void> {
  return Promise.all([loadFile(path), loadFileMarks(path)]).then(() => {});
}

const commitDiffCache = pathCache<DiffRequestState>();

/** 栏里每个 commit tab 的请求状态，按 tab 的键存。 */
export const commitDiffStates = commitDiffCache.states;

/**
 * 按 `options` 取 `target` 那一份补丁，写进 `cache` 的 `key` 那一格。commit tab 与两种多文件视图的段
 * 共用这一份：请求、票、「不回退 loading」都只写一遍。整份上下文过不了闸时调 `markUnavailable`——上下
 * 文档住在哪（tab 上 / 按段）归调用方。
 */
async function loadPatch(
  cache: PathCache<DiffRequestState>,
  key: string,
  target: PatchTarget,
  options: PatchRequest,
  markUnavailable: () => void,
): Promise<void> {
  const ticket = cache.tickets.claim(key);
  const rename = renameOf(target);
  // 已有一份时照常显示它、记一笔「在取」，不回退 loading：回退会让表格卸载重挂，点开折叠行的那一刻
  // 展开状态（住在组件里）跟着没了
  const current = cache.states.value.get(key);
  cache.set(
    key,
    current?.status === 'ready'
      ? { ...current, pending: options }
      : { status: 'loading', rename, options },
  );
  try {
    const query = patchQueryOf(target);
    setPatchQuery(query, options);
    const endpoint = target.sha === undefined ? '/api/diff' : '/api/commit-diff';
    const payload = await getJson<DiffPayload>(`${endpoint}?${query}`);
    if (!cache.tickets.isCurrent(ticket, key)) return;
    batch(() => {
      cache.set(key, { status: 'ready', rename, payload, options: fetchedAs(options, payload) });
      if (unavailableAfter(options, payload)) markUnavailable();
    });
  } catch (cause) {
    if (!cache.tickets.isCurrent(ticket, key)) return;
    cache.set(key, { status: 'error', rename, message: toMessage(cause) });
  }
}

function loadCommitDiff(editor: Extract<Editor, { kind: 'commit' }>): Promise<void> {
  const key = keyOf(editor);
  return loadPatch(commitDiffCache, key, editor, patchRequestOf(editor), () =>
    setEditorContext(key, 'unavailable'),
  );
}

/**
 * 在 `History` 里点一次提交的一个文件：开（或切到）它的 commit tab 并按需取补丁。「要不要取」只在
 * `refetch` 判一次——取到过（`ready`）就不再取，与 diff / file 两种 tab「点一次取一次」刻意不同：
 * 那两种的内容随工作区变，这一种不会。
 */
export function selectCommitFile(sha: string, entry: CommitFileEntry): void {
  const replaced = openCommitEditor(sha, entry.path, entry.oldPath);
  if (replaced !== null) forget(replaced);
  const opened = activeEditor.value;
  if (opened !== null) void refetch(opened);
}

/**
 * 多文件视图（整次提交、工作区改动）的段：缓存、按段的上下文档、「要不要取」与整批忘掉，两种视图各建一份。
 * 上下文档**按段记、不挂在 tab 上**：点开一段的折叠行不该让同一个 tab 里其余几百段此后都按整份上下文取；
 * 随整组 `forgetWhere` 归零。
 *
 * 两份只差 `generation`：工作区那份给，段手上那份是对着更早的一份 state 取的（且没有在途）即过期；提交不可
 * 变，不给即永不过期。
 */
interface SegmentStore {
  /** 每一段的请求状态，键由调用方定。 */
  readonly states: Signal<ReadonlyMap<string, DiffRequestState>>;
  /** 每一段的上下文档，缺项即 `hunks`。 */
  readonly contexts: Signal<ReadonlyMap<string, DiffContext>>;
  contextOf(key: string): DiffContext;
  /**
   * 这一段手上那份已经落后于此刻的 state，且没有一趟在途：段的视图拿它当「再问一次」的信号。只在 state
   * 换上新的一份、或一趟请求落地时变。**落地后不在这里直接补发**：那一刻没有可见性可问，滚出视口或 tab
   * 退到后台的段会在 agent 跑动期间一趟接一趟地取下去。出错的段落地时 state 没换就仍是 false，不会原地
   * 重试成一个环。
   */
  outdated(key: string): boolean;
  /**
   * 一段进了视口（或它可见时 state 换了一份、切了忽略空白、点开了折叠行）：按需取它的补丁。要取的是
   * `needsFetch` 那几条（没取过、`error`、取的那一档不对）与 `outdated`。在途时后者不成立——每个 SSE 都重发
   * 时新票作废旧票，慢补丁在 agent 跑动期间永远落不了地。
   */
  ensure(key: string, target: PatchTarget): void;
  /** 点开一段的折叠行而这一段只有 3 行上下文：从此要整份上下文，立刻重取。规则同 `expandContext`。 */
  expand(key: string, target: PatchTarget): void;
  /** 缓存、在途请求（`forget` 成对作废）、上下文档与「对着第几份 state 取的」一起忘掉。 */
  forgetWhere(owned: (key: string) => boolean): void;
}

function segmentStore(generation?: ReadonlySignal<number>): SegmentStore {
  const cache = pathCache<DiffRequestState>();
  const contexts = signal<ReadonlyMap<string, DiffContext>>(new Map());
  // 每一段最近一次请求对着第几份 state 发的。不是 signal：它变的那一刻缓存也写了一格，`outdated` 照样重算
  const requestedAt = new Map<string, number>();
  const contextOf = (key: string): DiffContext => contexts.value.get(key) ?? 'hunks';
  const setContext = (key: string, context: DiffContext) => {
    contexts.value = setIn(contexts.value, key, context);
  };
  const outdated = (key: string): boolean =>
    generation !== undefined &&
    inFlightRequest(cache.states.value.get(key)) === null &&
    requestedAt.get(key) !== generation.value;
  function ensure(key: string, target: PatchTarget): void {
    const wanted: PatchRequest = {
      ignoreWhitespace: ignoreWhitespace.value,
      fullContext: contextOf(key) === 'full',
    };
    if (!needsFetch(cache.states.value.get(key), wanted) && !outdated(key)) return;
    if (generation !== undefined) requestedAt.set(key, generation.value);
    void loadPatch(cache, key, target, wanted, () => setContext(key, 'unavailable'));
  }
  return {
    states: cache.states,
    contexts,
    contextOf,
    outdated,
    ensure,
    expand(key, target) {
      if (contextOf(key) !== 'hunks') return;
      setContext(key, 'full');
      ensure(key, target);
    },
    forgetWhere(owned) {
      batch(() => {
        cache.forgetWhere(owned);
        if (someKey(contexts.value, owned))
          contexts.value = new Map([...contexts.value].filter(([key]) => !owned(key)));
      });
      for (const key of [...requestedAt.keys()]) if (owned(key)) requestedAt.delete(key);
    },
  };
}

const commitSegments = segmentStore();

/**
 * 整次提交视图里每一段的请求状态与上下文档，键是 `segmentKey`。tab 关掉、或作为预览被顶掉时整组忘掉；
 * 不跟 SSE（提交不可变）。
 */
export const commitChangesStates = commitSegments.states;
export const segmentContexts = commitSegments.contexts;
export const segmentContextOf = commitSegments.contextOf;

/** 一段的键：`<sha>:<path>`。sha 定长、不含 `:`，路径里的 `:` 不产生歧义。 */
export const segmentKey = (sha: string, path: string): string => `${sha}:${path}`;

/** 这个键是不是 `sha` 那次提交的一段。 */
export const isSegmentOf = (sha: string, key: string): boolean =>
  key.startsWith(segmentKey(sha, ''));

export const ensureSegment = (sha: string, file: CommitFileEntry): void =>
  commitSegments.ensure(segmentKey(sha, file.path), { ...file, sha });

export const expandSegmentContext = (sha: string, file: CommitFileEntry): void =>
  commitSegments.expand(segmentKey(sha, file.path), { ...file, sha });

/** 一次提交的整组分段一起忘掉。 */
function forgetCommitChanges(sha: string): void {
  commitSegments.forgetWhere((key) => isSegmentOf(sha, key));
}

/**
 * History 提交行上那枚 `Open Changes`：开（或切到）这次提交的整次提交 tab，按需取详情（文件清单）。
 * 各段的补丁不在这里取——视图按可见性逐段取。被顶掉的预览 tab 照常忘掉。
 */
export function openCommitChanges(commit: CommitSummary): void {
  const replaced = openCommitChangesEditor(commit.sha, commit.subject);
  if (replaced !== null) forget(replaced);
  ensureCommitDetail(commit.sha);
}

let stateSeq = 0;

/**
 * 每换上一份 `repoState` 加一。工作区改动视图的段记「对着第几份取的」，不记快照本身：各段在不同的 SSE
 * 之间取，记快照就是每段各留住一整份旧列表，活到这一段被忘掉为止。
 */
const stateGeneration = computed(() => {
  void repoState.value;
  return ++stateSeq;
});

const changeSegments = segmentStore(stateGeneration);

/**
 * 工作区改动视图里每一段的请求状态与上下文档，键是路径。**不与 diff tab 的 `diffStates` 共用**：两边
 * 取的时机与上下文档的归属都不同，共用一格时按各自那档轮流改写。
 */
export const changesStates = changeSegments.states;
export const changesContexts = changeSegments.contexts;
export const changesContextOf = changeSegments.contextOf;
export const changesOutdated = changeSegments.outdated;

/** 变更列表此刻的条目，按路径。段只认路径：条目每份 state 都是新对象，按它比就是每个 SSE 全部段重画。 */
const entryByPath = computed(
  () => new Map((repoState.value?.files ?? []).map((file) => [file.path, file])),
);

/** 变更列表此刻那一行；不在（两次刷新之间的窗口）时 `undefined`。 */
export const changesEntryOf = (path: string): FileEntry | undefined => entryByPath.value.get(path);

/** 工作区改动视图的一段按需取补丁，`oldPath` 取此刻那一行的。那一行已不在时什么都不发。 */
export function ensureChangesSegment(path: string): void {
  const entry = changesEntryOf(path);
  if (entry !== undefined) changeSegments.ensure(path, entry);
}

export function expandChangesContext(path: string): void {
  const entry = changesEntryOf(path);
  if (entry !== undefined) changeSegments.expand(path, entry);
}

/**
 * `Changes` 档 tab 行上那枚 `Open Changes`：开（或切到）工作区改动 tab。各段的补丁不在这里取——视图按
 * 可见性逐段取。被顶掉的预览 tab 照常忘掉。
 */
export function openChanges(): void {
  const replaced = openChangesEditor();
  if (replaced !== null) forget(replaced);
}

/**
 * 切换忽略空白，**只重取看得见的 tab**（每组的活动 tab）：后台的 diff tab 切过去时本来就重取，commit
 * tab 切过去时按「取的那一档与此刻不同」重取。重取期间照常显示旧补丁、不回退 loading，与 SSE 刷新
 * 同一条。两种多文件视图不在这里取：它们的每一段订阅着开关，可见的那几段自己重取（`ensureSegment` /
 * `ensureChangesSegment`）。
 */
export function toggleIgnoreWhitespace(): void {
  ignoreWhitespace.value = !ignoreWhitespace.value;
  for (const editor of visibleEditors.value) if (isPatchEditor(editor)) void refetch(editor);
}

/** 切换自动换行。**不重取**：同一份正文换一种排法。 */
export function toggleWordWrap(): void {
  wordWrap.value = !wordWrap.value;
}

/**
 * 切换 SVG 预览。**不重取**：`preview` 本来就在已到的 payload 上，开关只换一种画法。`editor` 是按钮
 * 所在那一组的活动 tab，不读焦点组：点下去之前焦点不一定已经过来。
 *
 * **翻的是那个 tab 此刻画着的那一种（`shown`，即按钮的按下态），不是开关本身**：file tab 正因跳行
 * 按文本画着时开关可能本就开着，照常取反会把它关掉、按钮却仍显示未按下。要看图时顺带清掉这个文件的
 * 跳行请求，它不再压着预览。
 */
export function toggleSvgPreview(shown: boolean, editor: Editor): void {
  batch(() => {
    if (!shown && editor.kind === 'file') setReveal(editor.path);
    svgPreview.value = !shown;
  });
}

/**
 * 点开一段折叠行而手上只有 3 行上下文：这个 tab 从此要整份上下文，立刻重取一次。`full` /
 * `unavailable` 时什么都不做——前者已经有了（或在路上），后者说过展开不了。
 */
export function expandContext(key: EditorKey): void {
  const editor = findEditor(key);
  if (!isPatchEditor(editor) || contextOf(editor) !== 'hunks') return;
  // 这一下发不出请求（diff tab 的那一行已不在列表里，下一次 SSE 会关掉它）就不改档：改了时点的那一段
  // 停在 `Loading…`，而什么都不会来
  if (editor.kind === 'diff' && entryOf(editor) === undefined) return;
  setEditorContext(key, 'full');
  const updated = findEditor(key);
  if (updated !== undefined) void refetch(updated);
}
