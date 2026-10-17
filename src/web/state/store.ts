// 前端状态。signals 而非 useState:SSE 刷新要在**不丢失当前选中文件与滚动位置**的前提下
// 更新列表，状态必须活在组件树之外。右侧那条标签栏的列表模型在 `editors.ts`，本文件只管
// 「打开 / 切到 / 关掉一个 tab 要发哪些请求、缓存怎么进出」。
//
// **前端不内联任何 git 知识**：「这一侧算不算有改动」的判据在 `shared/protocol.ts`——
// 那三个谓词看着像 `!== '.'` 的同义反复，其实不是，`?` 与 `U` 都不能按字面读。本文件只把
// 它们组织成三组；「重命名」同理看 `oldPath` 而不比对路径。

import { batch, computed, type Signal, signal } from '@preact/signals';
import {
  type CommitFileEntry,
  type DiffPayload,
  type FileEntry,
  type FilePayload,
  type FilePreview,
  hasStagedChange,
  hasUnstagedChange,
  type ImagePreview,
  isConflicted,
  isUntracked,
  type RepoState,
  type StatusCode,
} from '../../server/shared/protocol';
import {
  activeEditor,
  contextOf,
  type Editor,
  type EditorKey,
  editorKey,
  editors,
  findEditor,
  focusEditor,
  keyOf,
  openCommitEditor,
  openEditor,
  removeEditor,
  renameEditor,
  setEditorContext,
  setReveal,
} from './editors';
import { ensureHistory } from './history';
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
 * 忽略空白的开关。**全局一份，不分 tab**（照 VS Code，那是一个全局设置）；**不进 `localStorage`**：
 * 端口随机，记了也跨不了实例，理由同版式 override。写入方只有 `toggleIgnoreWhitespace`。
 */
export const ignoreWhitespace = signal(false);

/**
 * SVG 预览的开关。全局一份、不进 `localStorage`，理由同忽略空白。写入方只有 `toggleSvgPreview`。
 */
export const svgPreview = signal(false);

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
 * 此刻要按图画的那份预览：payload 带着、且开关开着。视图画什么、`Panel` 要不要 `fill`、文件视图套
 * 不套宽盒都读它——几处各判时，开着预览的面板会不居中，或宽图把滚动区撑到原始像素宽。
 */
export function shownPreview(payload: DiffPayload): ImagePreview | undefined;
export function shownPreview(payload: FilePayload): FilePreview | undefined;
export function shownPreview(
  payload: DiffPayload | FilePayload,
): ImagePreview | FilePreview | undefined {
  return svgPreview.value ? previewOf(payload) : undefined;
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
 * 带着 `fullContext=1` 取回来的却不是整份上下文：后端说过不了闸。这个 tab 从此记成 `unavailable`、
 * 退回 3 行上下文。`too-large` 同样记：文件长过了字节闸时后端先按整份上下文撞一次、退回 3 行再撞一
 * 次，留在 `full` 就是每个 SSE 白跑两趟 git。二进制与图片不记——它们与上下文无关，文件变回文本时照常
 * 能展开。
 */
function noteUnavailable(key: EditorKey, request: PatchRequest, payload: DiffPayload): void {
  if (!request.fullContext) return;
  if ((payload.kind === 'text' && !payload.full) || payload.kind === 'too-large') {
    setEditorContext(key, 'unavailable');
  }
}

/**
 * `FileEntry` 的 `oldPath` → 一个可选对象。判据是 `oldPath` 存在，**不是比对新旧路径**——
 * 重命名与否是 git 的判定，前端不重写一遍。
 */
function renameOf(entry: FileEntry): RenameInfo | null {
  return entry.oldPath === undefined ? null : { oldPath: entry.oldPath };
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
  editor.kind === 'diff' ? diffCache : editor.kind === 'file' ? fileCache : commitDiffCache;

/**
 * 缓存里的键：diff / file 按路径，commit 直接用 tab 的键——同一个文件在两次提交里是两份，而 tab 的
 * 身份本来就把 sha 编进去了，不另编一套。
 */
const cacheKeyOf = (editor: Editor): string =>
  editor.kind === 'commit' ? keyOf(editor) : editor.path;

const forget = (editor: Editor): void => cacheOf(editor).forget(cacheKeyOf(editor));

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
    const query = new URLSearchParams({ path });
    if (entry.oldPath) query.set('oldPath', entry.oldPath);
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
      noteUnavailable(key, options, payload);
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
  // 搜索同理：看得见才重搜，看不见只记一笔、切回来时补（`App` 那个 tab effect）。它也不依赖新列表
  const search = refreshSearch(activeTab.value === 'search');
  const before = activeEditor.value;
  // **活动的文件也要重取**，与「活动的 diff 也要重取」同源：内容变了而树没变是最常见的
  // 形态，只刷树的话右侧停在旧内容上，而页面看不出任何异样
  if (before?.kind === 'file') void loadFile(before.path);

  if (!(await loadState())) return;
  // 提交列表要等新列表：判据是新 state 里的 HEAD oid——HEAD 没挪就一条请求都不发。看不见时不判，
  // 变回看得见时 `SourceControl` 那个 effect 拿当时的 state 再判一次（上游徽标的 refs 同一个入口）
  const history = historyVisible.value ? ensureHistory(repoState.value) : null;
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
  const editor =
    after === null || (after.kind === 'file' && before?.kind === 'file') ? null : refetch(after);
  await Promise.all([history, editor, search]);
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

/**
 * 重取一个 tab。diff 那一路条目取不到时什么都不发，回一个已完成的 promise。**commit tab 只在
 * 没取到时重取**：一次提交不可变，`ready` 的那份就是它的全部；而上次失败了（网络抖一下、后端
 * 重启）的话，切过来就是重试的时机——不然唯一的重试路径是回 `History` 重新展开再点一次。
 */
function refetch(editor: Editor): Promise<void> {
  if (editor.kind === 'commit') {
    // 取到了就不再取；**在途也不再取**——每次 SSE 都重发一次时，新票作废旧票，一份几百毫秒才回来的
    // 补丁在 agent 跑动期间永远轮不到落地，tab 就一直停在 `Loading…`。状态是 `loading` 即有一次在
    // 途：作废一次请求的唯一途径是 `forget`，而它连状态一起删了
    //
    // **例外是取的那一档与此刻不同**（切了忽略空白、点开了折叠行）：这两样只在用户点了什么时才变，
    // 不会有 SSE 那种饿死。已经按此刻这一档在取（`pending`）也算「在途」
    const state = commitDiffStates.value.get(keyOf(editor));
    const wanted = patchRequestOf(editor);
    // 在途的那一档优先：`ready` 带着 `pending` 时画面上是旧的、路上是新的
    const settledAs =
      state?.status === 'ready'
        ? (state.pending ?? state.options)
        : state?.status === 'loading'
          ? state.options
          : null;
    return settledAs !== null && samePatchRequest(settledAs, wanted)
      ? Promise.resolve()
      : loadCommitDiff(editor);
  }
  if (editor.kind === 'file') return loadFile(editor.path);
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
  // 跳到某一行要看的是文本：预览开着时那一行根本不在面板上，而跳行请求会一直挂着、等关掉预览时
  // 冷不丁滚过去
  if (line !== undefined) svgPreview.value = false;
  void loadFile(path);
}

const commitDiffCache = pathCache<DiffRequestState>();

/** 栏里每个 commit tab 的请求状态，按 tab 的键存。 */
export const commitDiffStates = commitDiffCache.states;

/**
 * 取一次提交里一个文件的补丁。重命名同样要把 `oldPath` 带上（只传新路径时退化成全新增）。
 */
async function loadCommitDiff(editor: Extract<Editor, { kind: 'commit' }>): Promise<void> {
  const { sha, path, oldPath } = editor;
  const key = keyOf(editor);
  const ticket = commitDiffCache.tickets.claim(key);
  const rename = oldPath === undefined ? null : { oldPath };
  const options = patchRequestOf(editor);
  // 已有一份时照常显示它、记一笔「在取」，不回退 loading：回退会让表格卸载重挂，点开折叠行的那一刻
  // 展开状态（住在组件里）跟着没了
  const current = commitDiffStates.value.get(key);
  commitDiffCache.set(
    key,
    current?.status === 'ready'
      ? { ...current, pending: options }
      : { status: 'loading', rename, options },
  );
  try {
    const query = new URLSearchParams({ sha, path });
    if (oldPath) query.set('oldPath', oldPath);
    setPatchQuery(query, options);
    const payload = await getJson<DiffPayload>(`/api/commit-diff?${query}`);
    if (!commitDiffCache.tickets.isCurrent(ticket, key)) return;
    batch(() => {
      commitDiffCache.set(key, {
        status: 'ready',
        rename,
        payload,
        options: fetchedAs(options, payload),
      });
      noteUnavailable(key, options, payload);
    });
  } catch (cause) {
    if (!commitDiffCache.tickets.isCurrent(ticket, key)) return;
    commitDiffCache.set(key, { status: 'error', rename, message: toMessage(cause) });
  }
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
 * 切换忽略空白，**只重取活动 tab**：后台的 diff tab 切过去时本来就重取，commit tab 切过去时按「取的
 * 那一档与此刻不同」重取。重取期间照常显示旧补丁、不回退 loading，与 SSE 刷新同一条。
 */
export function toggleIgnoreWhitespace(): void {
  ignoreWhitespace.value = !ignoreWhitespace.value;
  const editor = activeEditor.value;
  if (editor !== null && editor.kind !== 'file') void refetch(editor);
}

/**
 * 切换 SVG 预览。**不重取**：`preview` 本来就在已到的 payload 上，开关只换一种画法。
 */
export function toggleSvgPreview(): void {
  svgPreview.value = !svgPreview.value;
}

/**
 * 点开一段折叠行而手上只有 3 行上下文：这个 tab 从此要整份上下文，立刻重取一次。`full` /
 * `unavailable` 时什么都不做——前者已经有了（或在路上），后者说过展开不了。
 */
export function expandContext(key: EditorKey): void {
  const editor = findEditor(key);
  if (editor === undefined || contextOf(editor) !== 'hunks') return;
  // 这一下发不出请求（diff tab 的那一行已不在列表里，下一次 SSE 会关掉它）就不改档：改了时点的那一段
  // 停在 `Loading…`，而什么都不会来
  if (editor.kind === 'diff' && entryOf(editor) === undefined) return;
  setEditorContext(key, 'full');
  const updated = findEditor(key);
  if (updated !== undefined) void refetch(updated);
}
