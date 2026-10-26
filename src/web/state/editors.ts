// 右侧编辑器标签栏的模型：一到两组（分屏），每组一个有序列表 + 一个活动键，外加预览 / 固定 /
// 关闭 / 改名 / 跨组移动几个纯列表操作。**这里不取数据**——取 diff 与全文、作废在途请求、删缓存都在 `store.ts`，它
// import 本文件，方向只有这一条；反过来 import 会成环，且「打开一个 tab 要发哪些请求」本来就
// 不是列表的知识。
//
// 单击是预览、双击是固定，照 VS Code 编辑区的惯例：预览 tab 每组只有一个，被下一次单击原位
// 顶掉；固定之后不再被顶。此刻右侧画哪种视图由活动那一项的 `kind` 派生，不另设一个
// `activePane`——两份就有「谁是真的」这个问题。

import { batch, computed, type ReadonlySignal, type Signal, signal } from '@preact/signals';
import { type DiffOutputFormat, outputFormatOf, SIDE_BY_SIDE_MIN_WIDTH } from './layout';

interface EditorBase {
  readonly path: string;
  /** false 即预览 tab：标题斜体，会被下一次单击顶掉。 */
  readonly pinned: boolean;
}

/**
 * 一个补丁 tab 要多少上下文：`hunks` 是 3 行（起步）；`full` 是用户点开过一段折叠行，此后每次重取都
 * 带 `fullContext=1`；`unavailable` 是带着它取回来的补丁说过不了闸，此后退回 3 行、折叠行不可点。
 * **住在 tab 上，不住在缓存里**：缓存每次 `forget` 都会把「用户点开过」一并忘掉。`unavailable` 不会
 * 自己回到 `full`——否则每个 SSE 都要先撞一次闸再退回；文件后来变小了要关掉重开。
 */
export type DiffContext = 'hunks' | 'full' | 'unavailable';

/** 补丁 tab 才有的那一格。缺省即 `hunks`：新开的 tab 都从这里起，不必每个构造点都写一遍。 */
interface PatchEditor {
  readonly context?: DiffContext;
}

/**
 * 按 `kind` 判别的联合：`commit` 才有、且一定有 `sha`。写成「`sha?` 挂在所有种类上」时类型允许
 * 没有 sha 的 commit tab 与带 sha 的 diff tab，每个消费者只好自己挑一个判别字段去守，挑法还不一致。
 */
export type Editor =
  | (EditorBase & { readonly kind: 'file' })
  | (EditorBase & PatchEditor & { readonly kind: 'diff' })
  | (EditorBase &
      PatchEditor & {
        readonly kind: 'commit';
        /**
         * 这个文件是哪次提交里的那一版。**单独一个字段而不是拼进 `path`**——`path` 的消费者（两栏
         * 高亮、tab 上的名字与目录、`title`）照旧读文件路径，不必学会拆一个复合字符串。
         */
        readonly sha: string;
        /** 重命名的旧路径。取补丁要带上它（只传新路径会退化成全新增），所以跟着 tab 走。 */
        readonly oldPath?: string | undefined;
      })
  | (EditorBase & {
      /**
       * 一次提交的全部文件排在一个 tab 里。`path` 存的也是 sha，只用于比对；上下文档按段记在
       * `store.ts`，不挂在这里——点开一段的折叠行不该让其余几百段都按整份上下文取。
       */
      readonly kind: 'commit-changes';
      readonly sha: string;
      /** tab 上的主题。打开时从 History 那一行带进来：详情可能还没取，现找就是先画一拍空名字。 */
      readonly subject: string;
    })
  | (EditorBase & {
      /**
       * 工作区此刻的全部改动排在一个 tab 里，全局只此一个。`path` 恒为空串，只用于比对；段的缓存与上下文档
       * 按路径记在 `store.ts`，理由同 commit-changes。
       */
      readonly kind: 'changes';
    });

export type EditorKind = Editor['kind'];

/**
 * tab 的身份是「视图种类 + 路径」：同一路径从 `Changes` 点开的 diff 与从 `Files` 点开的全文是
 * 两个 tab——两处看到的是两样东西，合成一个就得再记一份「此刻显示哪种」。`kind` 是闭合的
 * union 且不含 `:`，路径里的 `:` 因此不产生歧义；键只用来比对，不反解析。
 */
export type EditorKey = `${EditorKind}:${string}`;

/**
 * `commit` 的键是 `commit:<sha>:<path>`：同一个文件在两次提交里是两个 tab。sha 是固定长度的
 * 十六进制、不含 `:`，夹在中间也不产生歧义。
 */
export function editorKey(kind: 'diff' | 'file', path: string): EditorKey;
export function editorKey(kind: 'commit', path: string, sha: string): EditorKey;
/** `commit-changes` 的键是 `commit-changes:<sha>`：一次提交只有一个这种 tab。 */
export function editorKey(kind: 'commit-changes', sha: string): EditorKey;
/** `changes` 的键是 `changes:`：整个工作区只有一个这种 tab。 */
export function editorKey(kind: 'changes'): EditorKey;
// 重载把「commit 必须带 sha、diff / file 不许带」钉在类型上：漏传 sha 的 `editorKey('commit', path)`
// 编得过时，得到的是一个谁都不匹配的键，高亮与关闭静默失效
export function editorKey(kind: EditorKind, path = '', sha?: string): EditorKey {
  return sha === undefined ? `${kind}:${path}` : `${kind}:${sha}:${path}`;
}
export function keyOf(editor: Editor): EditorKey {
  switch (editor.kind) {
    case 'commit':
      return editorKey(editor.kind, editor.path, editor.sha);
    case 'commit-changes':
      return editorKey(editor.kind, editor.sha);
    case 'changes':
      return editorKey(editor.kind);
    default:
      return editorKey(editor.kind, editor.path);
  }
}

/**
 * 这个 tab 显示的是不是工作区里 `path` 那一份：是就回 `path`，不是回 `null`。**commit 与
 * commit-changes 两种是「不是」**——它们是历史上的某一版，与左栏同名那一行、与工作区此刻的状态说的
 * 都不是同一份内容（commit-changes 的 `path` 更是一个 sha）。changes 也是「不是」：它不是某一个文件。
 * 两栏高亮（`activeEditorPath`）与 tab 名染色都按它判：各写一遍 `kind === 'commit'` 时，多一种显示
 * 非工作区内容的 tab 只改了一处，症状是 tab 染着工作区的色、左栏却不亮，或者反过来。
 */
export const worktreePathOf = (editor: Editor): string | null =>
  editor.kind === 'diff' || editor.kind === 'file' ? editor.path : null;

/**
 * 这个 tab 有没有一个文件名：有就回那个文件的路径（commit tab 也算，它是提交里的那一个文件），没有回
 * `null`。**两种多文件 tab 是「没有」**——它们的 `path` 是 sha 或空串，当成文件名拿去做同名消歧、拆出名字，
 * 只会把 sha 画成一个文件名。写成穷举的 `switch`：多一种 tab 时漏判是编译错误，而不是又一处手写的
 * `kind === …` 静默漏掉。
 */
export function filePathOf(editor: Editor): string | null {
  switch (editor.kind) {
    case 'diff':
    case 'file':
    case 'commit':
      return editor.path;
    case 'commit-changes':
    case 'changes':
      return null;
  }
}

/** 换掉第 `index` 项，回一份新数组。`Array.prototype.with` 是 ES2023，前端 lib 停在 ES2022。 */
const replaceAt = (list: readonly Editor[], index: number, editor: Editor): Editor[] =>
  list.map((item, i) => (i === index ? editor : item));

const indexOfKey = (list: readonly Editor[], key: EditorKey): number =>
  list.findIndex((editor) => keyOf(editor) === key);

/**
 * 一组编辑器：一条标签栏 + 一个视图。分屏时右侧面板里有两组，左右并排（**封顶两组**，照 VS Code
 * 的 editor group 但不做网格）。每组各有自己的 tab 列表、活动键与预览 tab；缓存不分组，按路径共用。
 */
export interface EditorGroup {
  /** 自增，只作组件的 `key` 与比对。 */
  readonly id: number;
  /** 栏里的 tab，按显示顺序。**不进 `localStorage`**：端口随机，写了也活不过一次重启。 */
  readonly editors: Signal<readonly Editor[]>;
  /** null 即这一组一个 tab 都没有。两组时不会出现：组空即合并（`removeEditor`）。 */
  readonly activeKey: Signal<EditorKey | null>;
  readonly active: ReadonlySignal<Editor | null>;
  /**
   * 这一组根元素的 border-box 宽度，版式按它判。**每组一份**：按整个右侧面板量时，分屏后两组各只剩
   * 一半宽，却仍被判成并排。初值同 `layout.ts` 那条说明。
   */
  readonly width: Signal<number>;
  /** 这一组的 diff 版式（`layout.ts` 的 `outputFormatOf`）。 */
  readonly format: ReadonlySignal<DiffOutputFormat>;
}

let nextGroupId = 0;

function createGroup(): EditorGroup {
  const editors = signal<readonly Editor[]>([]);
  const activeKey = signal<EditorKey | null>(null);
  const width = signal(SIDE_BY_SIDE_MIN_WIDTH);
  return {
    id: nextGroupId++,
    editors,
    activeKey,
    active: computed(() => {
      const key = activeKey.value;
      return key === null ? null : (editors.value[indexOfKey(editors.value, key)] ?? null);
    }),
    width,
    format: outputFormatOf(width),
  };
}

const firstGroup = createGroup();

/** 右侧面板里的组，自左向右；长度 1 或 2。 */
export const groups = signal<readonly EditorGroup[]>([firstGroup]);

/**
 * 焦点组：左栏的点击、Quick Open、搜索命中都开在这一组，左栏的高亮也跟它。组的根元素
 * `pointerdown` / `focusin` 时换过来，切到某一组的 tab 时也换过来。
 */
export const activeGroup = signal<EditorGroup>(firstGroup);

/** 至多几组。 */
const MAX_GROUPS = 2;

/**
 * 能不能从 `group` 分出新的一组（左右都一样）：还没到两组，且这一组不止一个 tab——只剩一个时分出去
 * 等于原地不动（源组移空即合并）。投放区亮不亮与 `splitEditor` 做不做都按它判，两处各写一遍时会漂开：
 * 遮罩亮了、放下去什么都不发生。
 */
export const canSplit = (group: EditorGroup): boolean =>
  groups.value.length < MAX_GROUPS && group.editors.value.length > 1;

/**
 * 焦点组的 tab 列表与活动键，**只读**：写入一律走下面那几个带 `group` 的操作。照旧以这两个名字导出，
 * 只关心「此刻在看什么」的消费者（两栏高亮、`Files` 树的定位）不必学会组。
 */
export const editors = computed<readonly Editor[]>(() => activeGroup.value.editors.value);
export const activeEditorKey = computed<EditorKey | null>(() => activeGroup.value.activeKey.value);
export const activeEditor = computed<Editor | null>(() => activeGroup.value.active.value);

/**
 * 此刻在屏幕上的那几个 tab：每组的活动 tab，**同键只算一次**。SSE 后重取、忽略空白切换后重取都按它：
 * 分屏时两组的活动 tab 都看得见，只取焦点组那一个时另一组停在旧内容上；两组开着同一个 diff 时只发
 * 一趟。
 */
export const visibleEditors = computed<readonly Editor[]>(() => {
  const seen = new Map<EditorKey, Editor>();
  for (const group of groups.value) {
    const editor = group.active.value;
    if (editor !== null && !seen.has(keyOf(editor))) seen.set(keyOf(editor), editor);
  }
  return [...seen.values()];
});

/**
 * 两栏（变更列表、目录树）高亮的判据：活动 tab 的路径，**不看它是 diff 还是全文**。从前按种类
 * 各认各的——活动 tab 是 `file:src/a.ts` 时变更列表里那一行不亮，理由是「那一行说的是这份补丁」
 *——直接的症状是点了行内 `Open file` 之后那一行就熄了：用户刚从这一行出发、右侧正显示着这个
 * 文件，左栏却说「你没在看它」。高亮回答的是「右侧此刻是哪个文件」，两栏各拿自己的路径去比
 * 同一个值；VS Code 的列表选中态同样不随编辑器种类变。分屏时跟焦点组。
 */
export const activeEditorPath = computed<string | null>(() => {
  const editor = activeEditor.value;
  // commit tab 不亮：两栏里同名的那一行说的是工作区那一份，照亮它是在说一件不成立的事
  return editor === null ? null : worktreePathOf(editor);
});

/**
 * 正在拖的 tab（拖到另一组或分屏），`null` 即没在拖。**拖的是谁只记在这里，不从 `dataTransfer` 里读**：
 * `dataTransfer` 的内容在 `dragover` 时读不到，而判投放区恰恰在 `dragover`。
 */
export const draggingEditor = signal<{
  readonly group: EditorGroup;
  readonly key: EditorKey;
} | null>(null);

/**
 * 要把 DOM 焦点交给哪一组的活动 tab（`EditorGroupView` 接）。**只改 `activeGroup` 不够**：键盘焦点还留在
 * 源组，下一次 Tab 落在源组里，`focusin` 就把焦点组换了回去。每次请求都是一个新对象，理由同 `revealRequest`。
 */
export const groupFocusRequest = signal<{ readonly group: EditorGroup } | null>(null);

/** 回到一组、空栏。给用例的重置用：模块级状态不随用例归零。 */
export function resetGroups(): void {
  const group = createGroup();
  batch(() => {
    groups.value = [group];
    activeGroup.value = group;
    draggingEditor.value = null;
    groupFocusRequest.value = null;
  });
}

/**
 * 文件视图要跳到的那一行（全仓搜索点了一条命中）。**单独一份 signal，不挂在 `Editor` 上**：tab 的
 * 身份、预览与固定都与「此刻要看哪一行」无关，挂上去时改名、并入、顶掉预览各处都得学会搬它。
 * **每次请求都是一个新对象**，`FileView` 的跳行 effect 就依赖它的身份——再点同一行也重新滚一次；
 * `FileView` 只认路径对得上的那一份。
 */
export const revealRequest = signal<{ readonly path: string; readonly line: number } | null>(null);

/**
 * 带 `line` 即请求跳到那一行；不带即「不带行号地打开了这个文件」，清掉它上一次的跳行与高亮——否则
 * 从树上再点开它时又滚回、又高亮那一行。
 */
export function setReveal(path: string, line?: number): void {
  if (line !== undefined) revealRequest.value = { path, line };
  else if (revealPending(path)) revealRequest.value = null;
}

/** 这个文件挂着跳行请求。挂着时它的 file tab 按文本画（那一行要在文本里才看得见）。 */
export const revealPending = (path: string): boolean => revealRequest.value?.path === path;

/**
 * 打开（或切到）一个 tab，开在 `group`（缺省焦点组）。缺省开出来的是预览 tab，固定归双击那一路的
 * `pinEditor`。返回**被顶掉的预览 tab**（没有则 null）：调用方要作废它的在途请求与缓存，而「这次会不会
 * 顶掉预览」只该在这里判一次——让调用方自己再推一遍，两处的判据会漂开。
 *
 * 预览档（`pinned` 缺省）：
 * - 键已存在：只激活（它是预览就还是预览）
 * - 键不存在：有预览 tab 就**原位**替换它（位置不跳；预览 tab 的判据是这一组里 `pinned === false` 的
 *   那一项，不是「最后打开的」），否则追加
 *
 * 固定档（`pinned: true`，VS Code `git.openFile` 的 `preview: false`）：
 * - 键已存在：固定它并激活
 * - 键不存在：**追加一个固定 tab，不碰现有的预览 tab**——「先开预览再 pin」会先顶掉一个无辜的
 *   预览 tab、再把顶掉它的那个固定住，两步都在这里判才不会那样
 */
export function openEditor(kind: 'diff' | 'file', path: string, pinned = false): Editor | null {
  return open({ kind, path, pinned }, activeGroup.value);
}

/** 同 `openEditor`，开的是一次提交里的一个文件。 */
export function openCommitEditor(
  sha: string,
  path: string,
  oldPath?: string,
  pinned = false,
): Editor | null {
  return open({ kind: 'commit', path, pinned, sha, oldPath }, activeGroup.value);
}

/** 同 `openEditor`，开的是一次提交的全部文件。 */
export function openCommitChangesEditor(
  sha: string,
  subject: string,
  pinned = false,
): Editor | null {
  return open({ kind: 'commit-changes', path: sha, pinned, sha, subject }, activeGroup.value);
}

/** 同 `openEditor`，开的是工作区此刻的全部改动。 */
export function openChangesEditor(pinned = false): Editor | null {
  return open({ kind: 'changes', path: '', pinned }, activeGroup.value);
}

function open(next: Editor, group: EditorGroup): Editor | null {
  const key = keyOf(next);
  const { pinned } = next;
  const list = group.editors.value;
  let replaced: Editor | null = null;
  batch(() => {
    if (indexOfKey(list, key) === -1) {
      const previewIndex = pinned ? -1 : list.findIndex((editor) => !editor.pinned);
      const preview = list[previewIndex];
      if (preview === undefined) {
        group.editors.value = [...list, next];
      } else {
        replaced = preview;
        group.editors.value = replaceAt(list, previewIndex, next);
      }
      // 另一组已开着同键时新开的这份从 `hunks` 起步，不对齐就是两组各持一档：这一份按 3 行重取、
      // 改写共用的那格缓存，另一组的 tab 仍说 `full`，点折叠行时 `expandContext` 认为已经有了而不响应
      syncContext(key);
    } else if (pinned) {
      pinEditor(key, group);
    }
    group.activeKey.value = key;
    activeGroup.value = group;
  });
  return replaced;
}

/**
 * 固定一个 tab。**幂等地置 true，永不 toggle**：浏览器的一次双击是 click、click、dblclick 三个
 * 事件，第三个到时 tab 早已存在，写成 toggle 会让已固定的 tab 在双击时静默解开。
 */
export function pinEditor(key: EditorKey, group = activeGroup.value): void {
  const list = group.editors.value;
  const index = indexOfKey(list, key);
  const existing = list[index];
  if (existing === undefined || existing.pinned) return;
  group.editors.value = replaceAt(list, index, { ...existing, pinned: true });
}

/** 切活动键，这一组顺带成为焦点组；回切到的那一项。键不在这一组就什么都不做、回 null。 */
export function focusEditor(key: EditorKey, group = activeGroup.value): Editor | null {
  const editor = group.editors.value[indexOfKey(group.editors.value, key)];
  if (editor !== undefined) {
    batch(() => {
      group.activeKey.value = key;
      activeGroup.value = group;
    });
  }
  return editor ?? null;
}

/**
 * 移除一个 tab，返回被移除的那一项（不在这一组则 null）。移除的正是活动 tab 时**右邻居优先、
 * 没有右邻居才是左邻居**，不按最近使用顺序：MRU 要多维护一份访问序列，换来的只是关掉一个刚从
 * 别处切过来的 tab 时少切一次。**移走的是两组里某一组的最后一个 tab 时这一组随之合并掉**：两组时
 * 空组只是一块什么都做不了的白地。
 */
export function removeEditor(key: EditorKey, group = activeGroup.value): Editor | null {
  const list = group.editors.value;
  const index = indexOfKey(list, key);
  const removed = list[index];
  if (removed === undefined) return null;
  const next = list.filter((_, i) => i !== index);
  batch(() => {
    group.editors.value = next;
    if (group.activeKey.value === key) {
      const neighbour = next[index] ?? next[index - 1] ?? null;
      group.activeKey.value = neighbour === null ? null : keyOf(neighbour);
    }
    if (next.length === 0) closeGroup(group);
  });
  return removed;
}

/** 摘掉一组（只剩一组时不摘），焦点落到剩下那组。 */
function closeGroup(group: EditorGroup): void {
  const rest = groups.value.filter((g) => g !== group);
  const survivor = rest[0];
  if (survivor === undefined || rest.length === groups.value.length) return;
  batch(() => {
    groups.value = rest;
    if (activeGroup.value === group) activeGroup.value = survivor;
  });
}

/**
 * 把 `from` 里的 `key` 移到 `to`，插在 `index` 前（缺省追加）。**移过去即固定**：拖动是明确的「我要在
 * 那边看它」，留成预览会被那一组下一次单击静默顶掉（VS Code 同样如此）。`to` 里已开着同键时不并排
 * 第二个，只切过去（上下文档两组本来同档，见 `syncContext`）。`from` 移空即合并。回移过去的那一项，没移回 null。
 */
export function moveEditor(
  from: EditorGroup,
  key: EditorKey,
  to: EditorGroup,
  index?: number,
): Editor | null {
  if (from === to) return null;
  const moved = from.editors.value[indexOfKey(from.editors.value, key)];
  if (moved === undefined) return null;
  return batch(() => {
    const landed = land(moved, to, index);
    removeEditor(key, from);
    return landed;
  });
}

/**
 * 把 `editor` 固定着放进 `to`、设为活动项并让 `to` 成为焦点组，插在 `index` 前（缺省追加）。`to` 里已开着
 * 同键时不并排第二个，只切过去、留那一份的位置与上下文档。移动与复制两路共用这一处：各写一份时「落地即
 * 固定」「同键只切过去」改了一边，另一边静默照旧。调用方自己包 `batch`。
 */
function land(editor: Editor, to: EditorGroup, index?: number): Editor {
  const key = keyOf(editor);
  const list = to.editors.value;
  const existingIndex = indexOfKey(list, key);
  const existing = list[existingIndex];
  const landed: Editor = { ...(existing ?? editor), pinned: true };
  const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
  to.editors.value =
    existing === undefined
      ? [...list.slice(0, at), landed, ...list.slice(at)]
      : replaceAt(list, existingIndex, landed);
  to.activeKey.value = key;
  activeGroup.value = to;
  return landed;
}

/** 分屏时新组开在哪一边。 */
export type SplitSide = 'left' | 'right';

/**
 * 把 `from` 里的 `key` 分到 `side` 那边新开的一组，成立条件见 `canSplit`。回移过去的那一项（同
 * `moveEditor`），没分回 null。
 */
export function splitEditor(from: EditorGroup, key: EditorKey, side: SplitSide): Editor | null {
  if (!canSplit(from) || indexOfKey(from.editors.value, key) === -1) return null;
  return batch(() => moveEditor(from, key, addGroup(side)));
}

/**
 * 在 `side` 那边新开一组并回它。拖动与键盘两路分屏共用：建组时要多做的事只写这一处。开在左边时原来那组
 * 退到右边，按 `id` 挂载、不重挂。
 */
function addGroup(side: SplitSide): EditorGroup {
  const group = createGroup();
  groups.value = side === 'left' ? [group, ...groups.value] : [...groups.value, group];
  return group;
}

/**
 * 键盘那一路的分屏（`⌘\` / `Ctrl+\`）：焦点组的活动 tab 在另一组**再开一份**并固定，焦点跟过去；只有
 * 一组时先分出右组，已有两组时就开在另一组。**是复制，不是 `splitEditor` 那种移动**：只开着一个 tab
 * 时移走即源组空、合并回去，按了等于没按——而那正是键盘用户最常见的起点。另一组已开着同键时只切
 * 过去，同 `moveEditor`。DOM 焦点也跟过去（`groupFocusRequest`）。回另一组里的那一项，焦点组空着时回 null。
 *
 * 不经 `store.ts` 取数据：源组那份正在屏幕上，缓存两组共用，新开的这份拿到的就是最新的。
 */
export function splitActiveEditor(): Editor | null {
  const from = activeGroup.value;
  const editor = from.active.value;
  if (editor === null) return null;
  return batch(() => {
    const to = groups.value.find((group) => group !== from) ?? addGroup('right');
    groupFocusRequest.value = { group: to };
    return land(editor, to);
  });
}

/**
 * 原地改路径（重命名跟着走）：`pinned` 与上下文档不变，活动键跟着走。**新路径上已经开着一个 tab
 * 时并入它**：幸存者保位置，`pinned` 取或，上下文档取靠后的那档，活动键移过去——两个同键的 tab
 * 并排在栏里没有意义。只动 `group` 这一组，两组都开着时调用方逐组调。
 */
export function renameEditor(
  kind: 'diff' | 'file',
  from: string,
  to: string,
  group = activeGroup.value,
): void {
  const fromKey = editorKey(kind, from);
  const toKey = editorKey(kind, to);
  const list = group.editors.value;
  const index = indexOfKey(list, fromKey);
  const renamed = list[index];
  if (renamed === undefined) return;
  const survivorIndex = indexOfKey(list, toKey);
  const survivor = list[survivorIndex];
  batch(() => {
    if (survivor === undefined) {
      group.editors.value = replaceAt(list, index, { ...renamed, path: to });
    } else {
      const pinned = survivor.pinned || renamed.pinned;
      const merged: Editor =
        survivor.kind === 'diff'
          ? { ...survivor, pinned, context: laterContext(survivor, renamed) }
          : { ...survivor, pinned };
      group.editors.value = replaceAt(list, survivorIndex, merged).filter((_, i) => i !== index);
    }
    if (group.activeKey.value === fromKey) group.activeKey.value = toKey;
    // 并入只看这一组的两份：另一组可能只开着新路径（档位较高）或只开着旧路径，逐组改名后档位会分叉
    syncContext(toKey);
  });
}

/** 三档的先后：并入同名 tab 时取靠后的那个——「用户点开过」与「试过、展开不了」都不该被并没了。 */
const CONTEXT_RANK: Record<DiffContext, number> = { hunks: 0, full: 1, unavailable: 2 };

/**
 * 按键找那个 tab，焦点组优先、再找另一组，都不在回 `undefined`。两组里的同键 tab 只有 `pinned` 可能
 * 不同（上下文档跨组同步，见 `setEditorContext`），调用方要的都是与组无关的那几格。
 */
export function findEditor(key: EditorKey): Editor | undefined {
  const preferred = activeGroup.value;
  for (const group of [preferred, ...groups.value.filter((g) => g !== preferred)]) {
    const editor = group.editors.value[indexOfKey(group.editors.value, key)];
    if (editor !== undefined) return editor;
  }
  return undefined;
}

/**
 * 任一组里开着这个键。关掉一份、或预览被顶掉时，另一组还开着同键就不能 `forget`：缓存与在途请求两组
 * 共用，删了另一组那份就退回 `Loading…`、再也不取。
 */
export const isOpenAnywhere = (key: EditorKey): boolean =>
  groups.value.some((group) => indexOfKey(group.editors.value, key) !== -1);

/**
 * 补丁 tab：diff 与 commit 两种，上下文档挂在 tab 上、忽略空白切换时按 tab 重取的就是它们。各处各写
 * 一遍 `kind === 'diff' || kind === 'commit'` 时，多一种补丁 tab 只改了几处，漏掉的那处静默不响应。
 */
export const isPatchEditor = (
  editor: Editor | null | undefined,
): editor is Extract<Editor, { kind: 'diff' | 'commit' }> =>
  editor?.kind === 'diff' || editor?.kind === 'commit';

/** 一个 tab 的上下文档。不在栏里（`undefined`）与没有这一格的 tab（file、commit-changes）都按 `hunks`。 */
export const contextOf = (editor: Editor | undefined): DiffContext =>
  isPatchEditor(editor) ? (editor.context ?? 'hunks') : 'hunks';

function laterContext(a: Editor, b: Editor): DiffContext {
  const [x, y] = [contextOf(a), contextOf(b)];
  return CONTEXT_RANK[y] > CONTEXT_RANK[x] ? y : x;
}

/**
 * 改一个补丁 tab 的上下文档，**所有组里同键的那一项一起改**：缓存按路径（commit 按键）存、不分组，两组
 * 各持一档时每次重取都按自己那档改写同一格。键不在栏里、不是补丁 tab、或档位没变时什么都不做。
 */
export function setEditorContext(key: EditorKey, context: DiffContext): void {
  batch(() => {
    for (const group of groups.value) {
      const list = group.editors.value;
      const index = indexOfKey(list, key);
      const editor = list[index];
      if (!isPatchEditor(editor) || contextOf(editor) === context) continue;
      group.editors.value = replaceAt(list, index, { ...editor, context });
    }
  });
}

/**
 * 把所有组里 `key` 那一项的上下文档对齐到其中靠后的那档（理由同 `laterContext`）。只开在一组、或不是
 * 补丁 tab 时什么都不做。新开同键 tab、逐组改名并入之后各调一次，守住「同键各组同档」。
 */
function syncContext(key: EditorKey): void {
  let context: DiffContext | null = null;
  for (const group of groups.value) {
    const editor = group.editors.value[indexOfKey(group.editors.value, key)];
    if (!isPatchEditor(editor)) continue;
    const own = contextOf(editor);
    if (context === null || CONTEXT_RANK[own] > CONTEXT_RANK[context]) context = own;
  }
  if (context !== null) setEditorContext(key, context);
}
