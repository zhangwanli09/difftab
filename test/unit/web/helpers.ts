// 前端用例共用的那几样。**不是用例**（文件名不带 `.test`），vitest 的 include 不会把它当用例跑。
//
// 收进来的判据是「第二份出现时就得记得另一份也在」：重置标签栏那四行贴在九个文件里，给
// `editors.ts` 加一个 signal 就是九处 `afterEach` 要补，漏一处不报错、只是状态漏进下一个用例。

import { expect, onTestFinished, vi } from 'vitest';
import type {
  BranchState,
  FileEntry,
  RefEntry,
  RepoState,
} from '../../../src/server/shared/protocol';
import { ACTION_SHELL, SHELL_AT_EDGE } from '../../../src/web/components/tree-row';
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
import { resetUpstreamRefs } from '../../../src/web/state/refs';
import {
  changesCollapsed,
  historyCollapsed,
  PANE_DEFAULT_PERCENT,
  panePercent,
} from '../../../src/web/state/sidebar';
import {
  commitDiffStates,
  type DiffRequestState,
  diffStates,
  type FileRequestState,
  fileStates,
} from '../../../src/web/state/store';

/** 清空标签栏与三张缓存。用到右侧状态的用例都从这里起。 */
export function resetEditors(): void {
  editors.value = [];
  activeEditorKey.value = null;
  diffStates.value = new Map();
  fileStates.value = new Map();
  commitDiffStates.value = new Map();
}

/** 清空 `History` 那一档：列表、详情缓存、展开集合，以及上游徽标那个 ref。 */
export function resetHistory(): void {
  historyList.value = null;
  historyError.value = null;
  loadingMore.value = false;
  moreError.value = null;
  commitDetails.value = new Map();
  expandedCommits.value = new Set();
  resetUpstreamRefs();
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

/** 写一个路径的全文缓存。 */
export function setFileState(path: string, state: FileRequestState): void {
  fileStates.value = new Map(fileStates.value).set(path, state);
}

/** 写一个路径的工作区 diff 缓存。 */
export function setDiffState(path: string, state: DiffRequestState): void {
  diffStates.value = new Map(diffStates.value).set(path, state);
}

/** 写一次提交里一个文件的补丁缓存——键是 commit tab 的键，与产品里同一套。 */
export function setCommitDiffState(sha: string, path: string, state: DiffRequestState): void {
  commitDiffStates.value = new Map(commitDiffStates.value).set(
    editorKey('commit', path, sha),
    state,
  );
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

/**
 * 换回真计时器，换之前先把挂着的跑掉。Preact 的 `useEffect` 冲刷排在 rAF / setTimeout 上，且只在
 * 队列由空变非空时才排一次——假计时器下排的那一次若被丢弃，队列就一直非空，本文件之后新挂载组件的
 * effect 只进队不执行。放在 `render(null, container)` 之后调：冲刷会跳过已卸载的组件，不会在用例
 * 结束后再替它们跑一遍 effect。
 */
export function restoreRealTimers(): void {
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.useRealTimers();
}

/** 一条最小的变更条目，字段按需覆盖。 */
export const file = (partial: Partial<FileEntry> & { path: string }): FileEntry => ({
  kind: 'tracked',
  staged: '.',
  unstaged: '.',
  ...partial,
});

/** 一份分支状态：`main`、不 detached、无上游，字段按需覆盖。改 `BranchState` 的形状时只改这一处。 */
export const branch = (partial: Partial<BranchState> = {}): BranchState => ({
  head: 'main',
  detached: false,
  upstream: null,
  ...partial,
});

/** 一份 `/api/state`：分支取 `branch()`、没有改动、原生监听，字段按需覆盖。 */
export const repo = (partial: Partial<RepoState> = {}): RepoState => ({
  repoName: 'demo',
  branch: branch(),
  files: [],
  watch: { mode: 'native', tier: 'A' },
  ...partial,
});

/** `/api/refs` 里的一条，字段按需覆盖。 */
export const ref = (
  kind: RefEntry['kind'],
  name: string,
  partial: Partial<RefEntry> = {},
): RefEntry => ({
  kind,
  name,
  sha: 'a'.repeat(40),
  author: 'Ada',
  time: 1_700_000_000,
  subject: `tip of ${name}`,
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

/** 某一行的行内动作外壳：group div 里行按钮之外的那个 span。 */
export const shellOf = (row: Element | null | undefined) =>
  groupOf(row)?.querySelector(':scope > span') ?? null;

/** 行按钮里只在悬停时进流的空 span，即行内动作的占位。 */
export const revealSlotsIn = (row: Element | null | undefined) =>
  [...(row?.querySelectorAll('span') ?? [])].filter(
    (node) => node.classList.contains('hidden') && node.textContent === '',
  );

/** 行按钮里行内动作的占位：空 span 里的第一个。 */
export const spacerIn = (row: Element | null | undefined) => revealSlotsIn(row)[0];

/**
 * 断言没有状态记号的这一行，行内动作贴行骨架的右内边距：外壳取 `SHELL_AT_EDGE`，
 * 行按钮里只有占位、不补状态位宽的空槽。
 */
export function expectEdgeAnchored(row: Element | null | undefined) {
  expect(revealSlotsIn(row)).toHaveLength(1);
  expect(shellOf(row)?.className).toBe(`${ACTION_SHELL} ${SHELL_AT_EDGE}`);
}

/**
 * 层内占位（`PlaceholderRow`）的形状：目录树与提交展开后的文件列表共用一份断言，两处各抄一份时改
 * 一处不报错，只是另一处钉的已不是真骨架。只钉决定文字落点的布局类——少了 gap 文字比文件名往左
 * 差 6px，少了行首等宽占位差 18px；`ROW_BASE` 里焦点环那几样是给按钮行的，在 li 上不起作用。
 * 按 `title` 找行，于是「全文进 title」这一条也在里面。
 */
export function expectPlaceholderRow(container: Element, text: string) {
  const row = container.querySelector<HTMLLIElement>(`li[title="${text}"]`);
  if (!row) throw new Error(`没有画出占位那一行：${text}`);
  for (const cls of ['flex', 'gap-1.5', 'pr-3']) expect(row.classList.contains(cls)).toBe(true);
  expect(row.firstElementChild?.classList.contains('w-3')).toBe(true);
  expect(row.querySelector('.truncate')?.textContent).toBe(text);
}
