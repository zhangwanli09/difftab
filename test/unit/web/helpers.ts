// 前端用例共用的那几样。**不是用例**（文件名不带 `.test`），vitest 的 include 不会把它当用例跑。
//
// 收进来的判据是「第二份出现时就得记得另一份也在」：重置标签栏那四行贴在九个文件里，给
// `editors.ts` 加一个 signal 就是九处 `afterEach` 要补，漏一处不报错、只是状态漏进下一个用例。

import { expect, onTestFinished, vi } from 'vitest';
import type { FileEntry } from '../../../src/server/shared/protocol';
import { STATUS_WIDTH } from '../../../src/web/components/tree-row';
import {
  activeEditorKey,
  type EditorKind,
  editorKey,
  editors,
  openEditor,
  pinEditor,
} from '../../../src/web/state/editors';
import {
  commitDetails,
  expandedCommits,
  historyError,
  historyList,
  loadingMore,
  moreError,
} from '../../../src/web/state/history';
import {
  changesCollapsed,
  historyCollapsed,
  PANE_DEFAULT_PERCENT,
  panePercent,
} from '../../../src/web/state/sidebar';
import { commitDiffStates, diffStates, fileStates } from '../../../src/web/state/store';

/** 清空标签栏与三张缓存。用到右侧状态的用例都从这里起。 */
export function resetEditors(): void {
  editors.value = [];
  activeEditorKey.value = null;
  diffStates.value = new Map();
  fileStates.value = new Map();
  commitDiffStates.value = new Map();
}

/** 清空 `History` 那一档：列表、详情缓存、展开集合。 */
export function resetHistory(): void {
  historyList.value = null;
  historyError.value = null;
  loadingMore.value = false;
  moreError.value = null;
  commitDetails.value = new Map();
  expandedCommits.value = new Set();
}

/** 两个分区回到默认：都展开、对半分。 */
export function resetPanes(): void {
  changesCollapsed.value = false;
  historyCollapsed.value = false;
  panePercent.value = PANE_DEFAULT_PERCENT;
}

/**
 * 折起 `History` 分区，用例结束时自己复原。给**测的不是提交历史**的那些用例：分区默认可见，不折起
 * 时每次 `refresh` / 挂载 `App` 都多发一趟 `/api/commits`——桩回的是别的 payload，那一趟还可能挂着
 * 不回来、把下一个用例的请求搭进 `singleFlight` 里。
 */
export function hideHistory(): void {
  historyCollapsed.value = true;
  onTestFinished(resetPanes);
}

/** 开一个固定 tab——产品里开出来的一律是预览，固定是双击那一下另做的，用例里合成一步。 */
export function openPinned(kind: Exclude<EditorKind, 'commit'>, path: string): void {
  openEditor(kind, path);
  pinEditor(editorKey(kind, path));
}

/**
 * 等到「某个断言成立」，而不是等一个固定的毫秒数。`interval` 调小：默认 50ms 的轮询格子比实际
 * 就绪时间（happy-dom 的 rAF 实测约 1ms）粗得多，走 effect 的用例各睡满一格就是白等几百毫秒；
 * 不动 `timeout`，慢机器的余量分毫不减。
 */
export const waitFor = (assert: () => void) => vi.waitFor(assert, { interval: 5 });

/** 一条最小的变更条目，字段按需覆盖。 */
export const file = (partial: Partial<FileEntry> & { path: string }): FileEntry => ({
  kind: 'tracked',
  staged: '.',
  unstaged: '.',
  ...partial,
});

/**
 * 把 fetch 换成一个只回这一份正文的桩，并把它收到的 URL 全部记下来。`new Response(
 * JSON.stringify(…))` 抄第五遍的时候，改一处请求头或错误形状就得记得另外四处也在。
 */
export function stubJson(payload: unknown, status = 200): string[] {
  return stubJsonBy(() => ({ payload, status }));
}

/** 同上，但正文按 URL 定——按目录回不同一层、或只让其中一条路径 404 的用例用这个。 */
export function stubJsonBy(respond: (url: URL) => { payload: unknown; status?: number }): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const { payload, status = 200 } = respond(new URL(url, 'http://localhost'));
      return new Response(JSON.stringify(payload), { status });
    }),
  );
  return calls;
}

/**
 * 把 `navigator.clipboard.writeText` 换成一个只记参数的桩并返回它。happy-dom 自带这个对象，于是
 * 走仓库里给浏览器 API 打桩的惯例 `vi.spyOn`——由 `afterEach` 的 `vi.restoreAllMocks()` 恢复，
 * 不像 `defineProperty` 那样把整个对象换掉后没人放回去。
 */
export function stubClipboard(error?: Error) {
  // 每次调用才造 promise：预先造好一个 rejected 的，在没人接住之前就是一条 unhandledRejection
  return vi
    .spyOn(navigator.clipboard, 'writeText')
    .mockImplementation(() => (error ? Promise.reject(error) : Promise.resolve()));
}

/**
 * 下面三个都在描述 `TreeRow` 的 DOM 形状（`<li><div class="group"><button 行/>…<span 外壳>动作
 * 按钮</span></div>子层</li>`），两棵树的用例共用：形状一改，改这里一处，而不是两份文件里四种
 * 各自推导的查找一起坏、各报一句不同的错。
 */

/** 一行的 group div：行按钮与它的行内动作同住的那个 `<div>`。按类名往上找，不按层数数。 */
export const groupOf = (node: Element | null | undefined) => node?.closest('.group') ?? null;

/** 某一行的某枚行内动作按钮（按 `aria-label` 挑），没有即 `null`。 */
export const actionOf = (row: Element | null | undefined, label: string) =>
  groupOf(row)?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? null;

/**
 * 行按钮里只在悬停时进流的空 span：先是行内动作的占位，没有状态记号的行再跟一个状态位宽的空槽。
 */
export const revealSlotsIn = (row: Element | null | undefined) =>
  [...(row?.querySelectorAll('span') ?? [])].filter(
    (node) => node.classList.contains('hidden') && node.textContent === '',
  );

/** 行按钮里行内动作的占位：空 span 里的第一个。 */
export const spacerIn = (row: Element | null | undefined) => revealSlotsIn(row)[0];

/** 断言这一行悬停时补了状态位宽的空槽：占位之后紧跟一个 `STATUS_WIDTH`。 */
export function expectStatusGap(row: Element | null | undefined) {
  const slots = revealSlotsIn(row);
  expect(slots).toHaveLength(2);
  expect(slots[1]?.classList.contains(STATUS_WIDTH)).toBe(true);
}
