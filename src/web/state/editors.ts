// 右侧那条编辑器标签栏的模型：一个有序列表 + 一个活动键，外加预览 / 固定 / 关闭 / 改名几个
// 纯列表操作。**这里不取数据**——取 diff 与全文、作废在途请求、删缓存都在 `store.ts`，它
// import 本文件，方向只有这一条；反过来 import 会成环，且「打开一个 tab 要发哪些请求」本来就
// 不是列表的知识。
//
// 单击是预览、双击是固定，照 VS Code 编辑区的惯例：预览 tab 全局只有一个，被下一次单击原位
// 顶掉；固定之后不再被顶。此刻右侧画哪种视图由活动那一项的 `kind` 派生，不另设一个
// `activePane`——两份就有「谁是真的」这个问题。

import { batch, computed, signal } from '@preact/signals';

export type EditorKind = 'diff' | 'file';

export interface Editor {
  readonly kind: EditorKind;
  readonly path: string;
  /** false 即预览 tab：标题斜体，会被下一次单击顶掉。 */
  readonly pinned: boolean;
}

/**
 * tab 的身份是「视图种类 + 路径」：同一路径从 `Changes` 点开的 diff 与从 `Files` 点开的全文是
 * 两个 tab——两处看到的是两样东西，合成一个就得再记一份「此刻显示哪种」。`kind` 是闭合的
 * union 且不含 `:`，路径里的 `:` 因此不产生歧义；键只用来比对，不反解析。
 */
export type EditorKey = `${EditorKind}:${string}`;

export const editorKey = (kind: EditorKind, path: string): EditorKey => `${kind}:${path}`;
export const keyOf = (editor: Editor): EditorKey => editorKey(editor.kind, editor.path);

/** 换掉第 `index` 项，回一份新数组。`Array.prototype.with` 是 ES2023，前端 lib 停在 ES2022。 */
const replaceAt = (list: readonly Editor[], index: number, editor: Editor): Editor[] =>
  list.map((item, i) => (i === index ? editor : item));

const indexOfKey = (list: readonly Editor[], key: EditorKey): number =>
  list.findIndex((editor) => keyOf(editor) === key);

/** 栏里的 tab，按显示顺序。**不进 `localStorage`**：端口随机，写了也活不过一次重启。 */
export const editors = signal<readonly Editor[]>([]);

/** null 即栏里一个 tab 都没有，右侧画空态。 */
export const activeEditorKey = signal<EditorKey | null>(null);

export const activeEditor = computed<Editor | null>(() => {
  const key = activeEditorKey.value;
  return key === null ? null : (editors.value[indexOfKey(editors.value, key)] ?? null);
});

/**
 * 两栏的高亮各认自己那一种：变更列表按 diff、目录树按 file。活动 tab 是 `file:src/a.ts` 时
 * 变更列表里那一行不亮——那一行说的是「这份补丁」，而此刻在读的是全文。
 */
export const activeDiffPath = computed<string | null>(() => {
  const active = activeEditor.value;
  return active?.kind === 'diff' ? active.path : null;
});

export const activeFilePath = computed<string | null>(() => {
  const active = activeEditor.value;
  return active?.kind === 'file' ? active.path : null;
});

/**
 * 打开（或切到）一个 tab。开出来的一律是预览 tab，固定归 `pinEditor`。返回**被顶掉的预览
 * tab**（没有则 null）：调用方要作废它的在途请求与缓存，而「这次会不会顶掉预览」只该在这里判
 * 一次——让调用方自己再推一遍，两处的判据会漂开。
 *
 * - 键已存在：只激活（它是预览就还是预览）
 * - 键不存在：有预览 tab 就**原位**替换它（位置不跳；预览 tab 的判据是 `pinned === false` 的那
 *   一项，不是「最后打开的」），否则追加
 */
export function openEditor(kind: EditorKind, path: string): Editor | null {
  const key = editorKey(kind, path);
  const list = editors.value;
  let replaced: Editor | null = null;
  batch(() => {
    if (indexOfKey(list, key) === -1) {
      const next: Editor = { kind, path, pinned: false };
      const previewIndex = list.findIndex((editor) => !editor.pinned);
      const preview = list[previewIndex];
      if (preview === undefined) {
        editors.value = [...list, next];
      } else {
        replaced = preview;
        editors.value = replaceAt(list, previewIndex, next);
      }
    }
    activeEditorKey.value = key;
  });
  return replaced;
}

/**
 * 固定一个 tab。**幂等地置 true，永不 toggle**：浏览器的一次双击是 click、click、dblclick 三个
 * 事件，第三个到时 tab 早已存在，写成 toggle 会让已固定的 tab 在双击时静默解开。
 */
export function pinEditor(key: EditorKey): void {
  const list = editors.value;
  const index = indexOfKey(list, key);
  const existing = list[index];
  if (existing === undefined || existing.pinned) return;
  editors.value = replaceAt(list, index, { ...existing, pinned: true });
}

/** 只切活动键，回切到的那一项。键不在栏里就什么都不做、回 null。 */
export function focusEditor(key: EditorKey): Editor | null {
  const editor = editors.value[indexOfKey(editors.value, key)];
  if (editor !== undefined) activeEditorKey.value = key;
  return editor ?? null;
}

/**
 * 移除一个 tab，返回被移除的那一项（不在栏里则 null）。移除的正是活动 tab 时**右邻居优先、
 * 没有右邻居才是左邻居**，不按最近使用顺序：MRU 要多维护一份访问序列，换来的只是关掉一个刚从
 * 别处切过来的 tab 时少切一次。
 */
export function removeEditor(key: EditorKey): Editor | null {
  const list = editors.value;
  const index = indexOfKey(list, key);
  const removed = list[index];
  if (removed === undefined) return null;
  const next = list.filter((_, i) => i !== index);
  batch(() => {
    editors.value = next;
    if (activeEditorKey.value === key) {
      const neighbour = next[index] ?? next[index - 1] ?? null;
      activeEditorKey.value = neighbour === null ? null : keyOf(neighbour);
    }
  });
  return removed;
}

/**
 * 原地改路径（重命名跟着走）：`pinned` 不变，活动键跟着走。**新路径上已经开着一个 tab 时并入
 * 它**：幸存者保位置，`pinned` 取或，活动键移过去——两个同键的 tab 并排在栏里没有意义。
 */
export function renameEditor(kind: EditorKind, from: string, to: string): void {
  const fromKey = editorKey(kind, from);
  const toKey = editorKey(kind, to);
  const list = editors.value;
  const index = indexOfKey(list, fromKey);
  const renamed = list[index];
  if (renamed === undefined) return;
  const survivorIndex = indexOfKey(list, toKey);
  const survivor = list[survivorIndex];
  batch(() => {
    if (survivor === undefined) {
      editors.value = replaceAt(list, index, { ...renamed, path: to });
    } else {
      const merged: Editor = { ...survivor, pinned: survivor.pinned || renamed.pinned };
      editors.value = replaceAt(list, survivorIndex, merged).filter((_, i) => i !== index);
    }
    if (activeEditorKey.value === fromKey) activeEditorKey.value = toKey;
  });
}
