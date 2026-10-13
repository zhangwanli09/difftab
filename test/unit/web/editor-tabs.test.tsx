// 右侧面板顶上那条编辑器标签栏。
//
// 钉的都是「不报错、只是不对」：关闭按钮是 tab 按钮的兄弟而不是孩子（套在里面时点 × 会顺带激活、
// 快速双击 × 会把滑到指针底下的邻居固定住，且读屏看不见它）；预览 tab 斜体、固定之后转正；同一
// 路径的 diff 与全文是两个 tab、图标是它们之间唯一的视觉差别；关闭按钮只在活动 tab 上常显；
// 复制全文那枚只在全文正文就绪时出现、站在 tablist 之外；版式切换那枚只在 diff / commit 的文本补丁
// 就绪时出现。
// happy-dom 没有排版引擎，横向滚、截断与透明度只能钉类名。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffPayload, FilePayload } from '../../../src/server/shared/protocol';
import { EditorTabs } from '../../../src/web/components/EditorTabs';
import {
  activeEditorKey,
  editorKey,
  editors,
  openCommitEditor,
  openEditor,
} from '../../../src/web/state/editors';
import {
  diffFormatOverride,
  diffOutputFormat,
  diffPanelWidth,
  SIDE_BY_SIDE_MIN_WIDTH,
} from '../../../src/web/state/layout';
import {
  type DiffRequestState,
  type FileRequestState,
  repoState,
} from '../../../src/web/state/store';
import {
  file,
  openPinned,
  resetEditors,
  setCommitDiffState,
  setDiffState,
  setFileState,
  stubClipboard,
  stubJson,
  waitFor,
} from './helpers';

let container: HTMLElement;
let calls: string[];

/** tab 按钮（`role="tab"`），按显示顺序。 */
const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const tabByTitle = (title: string): HTMLButtonElement => {
  const found = tabs().find((tab) => tab.title === title);
  if (!found) throw new Error(`没有画出 ${title} 这个 tab`);
  return found;
};
/** tab 的外壳：tab 按钮与关闭按钮并排住在里面。 */
const shellOf = (tab: HTMLElement) => tab.parentElement as HTMLElement;
const closeOf = (tab: HTMLElement) =>
  shellOf(tab).querySelector('button[aria-label="Close"]') as HTMLButtonElement;
/** 装 tab 的那一层（tablist），横向滚动的是它。 */
const strip = () => container.querySelector('[role="tablist"]');
/** 栏的外层：高度、分隔线归它，tablist 与动作区并排住在里面。 */
const bar = () => strip()?.parentElement ?? null;
/** 动作区那枚复制全文；静止与刚复制完两种名字都认。 */
const copyButton = () =>
  container.querySelector<HTMLButtonElement>(
    'button[aria-label="Copy file contents"], button[aria-label="Copied"]',
  );

/** 动作区那枚版式切换；两种目标版式的名字都认。 */
const formatButton = () =>
  container.querySelector<HTMLButtonElement>(
    'button[aria-label="View inline"], button[aria-label="View side by side"]',
  );

const mouse = (type: string, button = 0) => new MouseEvent(type, { bubbles: true, button });

/** signals 驱动的重画是微任务；断言 DOM 之前同步重画一次，省掉每处都 await。 */
const flush = () => render(<EditorTabs />, container);
const open = (...args: Parameters<typeof openEditor>) => {
  openEditor(...args);
  flush();
};
const pinned = (...args: Parameters<typeof openPinned>) => {
  openPinned(...args);
  flush();
};

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  resetEditors();
  diffPanelWidth.value = SIDE_BY_SIDE_MIN_WIDTH;
  diffFormatOverride.value = null;
  repoState.value = {
    repoName: 'demo',
    branch: { head: 'main', detached: false, upstream: null },
    files: [file({ path: 'src/a.ts', unstaged: 'M' }), file({ path: 'src/b.ts', unstaged: 'M' })],
    watch: { mode: 'native', tier: 'A' },
  };
  calls = stubJson({ kind: 'binary' });
  render(<EditorTabs />, container);
});

afterEach(() => {
  render(null, container);
  // 用了 fake timers 的用例要在换回真计时器之前把挂着的计时器跑掉：Preact 的 `useEffect` 排在
  // rAF / setTimeout 上，且只在队列由空变非空时才排一次——假计时器下排的那一次永远不触发，队列
  // 就一直非空，之后用例里的 effect 只进队不执行（症状是下一条「活动 tab 再滚一次」等不到调用）
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('EditorTabs', () => {
  it('一个 editor 一个 tab、按顺序，title 是完整路径，名字与目录各一段', () => {
    pinned('diff', 'src/a.ts');
    pinned('file', 'docs/b.md');
    expect(tabs().map((tab) => tab.title)).toEqual(['src/a.ts', 'docs/b.md']);
    const label = tabByTitle('src/a.ts').querySelector('.truncate');
    expect(label?.textContent).toBe('a.tssrc');
    expect(label?.querySelector('span')?.textContent).toBe('src');
  });

  it('同一路径的 diff 与全文是两个 tab，图标按 kind 区分', () => {
    pinned('diff', 'src/a.ts');
    pinned('file', 'src/a.ts');
    expect(tabs()).toHaveLength(2);
    expect(tabs()[0]?.querySelector('svg.lucide-file-diff')).not.toBeNull();
    expect(tabs()[1]?.querySelector('svg.lucide-file-code')).not.toBeNull();
  });

  it('tab 与关闭按钮是并排的两枚 <button>，关闭不套在 tab 里', () => {
    pinned('diff', 'src/a.ts');
    const tab = tabByTitle('src/a.ts');
    expect(tab.tagName).toBe('BUTTON');
    expect(tab.querySelector('button')).toBeNull();
    expect(closeOf(tab).parentElement?.parentElement).toBe(shellOf(tab));
    expect(strip()?.getAttribute('aria-label')).toBe('Open editors');
  });

  it('aria-selected 跟着活动键走', () => {
    pinned('diff', 'src/a.ts');
    pinned('diff', 'src/b.ts');
    expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true']);
  });

  it('预览 tab 斜体，固定之后转正', () => {
    const italic = () =>
      tabByTitle('src/a.ts').querySelector('.truncate')?.classList.contains('italic');
    open('diff', 'src/a.ts');
    expect(italic()).toBe(true);
    pinned('diff', 'src/a.ts');
    expect(italic()).toBe(false);
  });

  it('单击切过去并重取', async () => {
    pinned('diff', 'src/a.ts');
    pinned('diff', 'src/b.ts');
    calls.length = 0;

    tabByTitle('src/a.ts').click();
    flush();
    expect(activeEditorKey.value).toBe('diff:src/a.ts');
    await waitFor(() => expect(calls.filter((url) => url.includes('src%2Fa.ts'))).toHaveLength(1));
  });

  it('双击把 tab 固定，且是幂等的', () => {
    open('diff', 'src/a.ts');
    tabByTitle('src/a.ts').dispatchEvent(mouse('dblclick'));
    flush();
    expect(editors.value[0]?.pinned).toBe(true);
    tabByTitle('src/a.ts').dispatchEvent(mouse('dblclick'));
    expect(editors.value[0]?.pinned).toBe(true);
  });

  it('点关闭按钮只关、不激活——关一个后台 tab 不该先把它切到前台', () => {
    pinned('diff', 'src/a.ts');
    pinned('diff', 'src/b.ts');
    calls.length = 0;
    closeOf(tabByTitle('src/a.ts')).click();
    expect(editors.value.map((editor) => editor.path)).toEqual(['src/b.ts']);
    expect(activeEditorKey.value).toBe('diff:src/b.ts');
    // 一个请求都没发：没激活过 a.ts，b.ts 也没换人
    expect(calls).toEqual([]);
  });

  it('双击关闭按钮不会把邻居固定住', () => {
    pinned('diff', 'src/a.ts');
    open('diff', 'src/b.ts');
    // 第一下 click 把 a.ts 关掉，后面两个事件落在滑过来的 b.ts 的 × 上——它不在 tab 按钮里
    closeOf(tabByTitle('src/a.ts')).click();
    flush();
    expect(tabs()).toHaveLength(1);
    closeOf(tabByTitle('src/b.ts')).dispatchEvent(mouse('dblclick'));
    expect(editors.value[0]?.pinned).toBe(false);
  });

  it('中键关闭，别的键不关', () => {
    pinned('diff', 'src/a.ts');
    pinned('diff', 'src/b.ts');
    tabByTitle('src/a.ts').dispatchEvent(mouse('auxclick', 2));
    flush();
    expect(tabs()).toHaveLength(2);
    tabByTitle('src/a.ts').dispatchEvent(mouse('auxclick', 1));
    expect(editors.value.map((editor) => editor.path)).toEqual(['src/b.ts']);
  });

  it('关闭按钮只在活动 tab 上常显，其余悬停才露出来（透明度藏、位置留着）', () => {
    pinned('diff', 'src/a.ts');
    pinned('diff', 'src/b.ts');
    const wrapperOf = (title: string) => closeOf(tabByTitle(title)).parentElement;
    // 非活动：默认透明，悬停 / 焦点在 tab 内时显示——happy-dom 没有 :hover，能钉的只有类名
    for (const cls of ['opacity-0', 'group-hover:opacity-100', 'group-focus-within:opacity-100']) {
      expect(wrapperOf('src/a.ts')?.classList.contains(cls)).toBe(true);
    }
    expect(shellOf(tabByTitle('src/a.ts')).classList.contains('group')).toBe(true);
    // 活动：常显，且按钮仍在 DOM 里（不是不渲染）
    expect(wrapperOf('src/b.ts')?.classList.contains('opacity-0')).toBe(false);
    expect(closeOf(tabByTitle('src/b.ts'))).not.toBeNull();
    // 切过去之后两边对调
    tabByTitle('src/a.ts').click();
    flush();
    expect(wrapperOf('src/a.ts')?.classList.contains('opacity-0')).toBe(false);
    expect(wrapperOf('src/b.ts')?.classList.contains('opacity-0')).toBe(true);
  });

  it('活动 tab 自己滚进视野——溢出之后新开的那个在屏幕外，栏上看不出变化', async () => {
    // effect 在提交之后才跑，每一步都得等一拍
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    pinned('diff', 'src/a.ts');
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
    expect(scrolled.mock.instances[0]).toBe(shellOf(tabByTitle('src/a.ts')));
    // 已经在视野里就一个像素都不动：交给 nearest，不用 start / center
    expect(scrolled.mock.calls[0]?.[0]).toMatchObject({ inline: 'nearest' });

    pinned('diff', 'src/b.ts');
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2));
    expect(scrolled.mock.instances[1]).toBe(shellOf(tabByTitle('src/b.ts')));

    // 切回去：a.ts 再滚一次，b.ts 变成非活动不滚
    tabByTitle('src/a.ts').click();
    flush();
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(3));
    expect(scrolled.mock.instances[2]).toBe(shellOf(tabByTitle('src/a.ts')));
  });

  it('tablist 横向滚但不画滚动条、tab 不压扁——happy-dom 里只能钉类名', () => {
    pinned('diff', 'src/a.ts');
    // 栏高与顶栏相等那条在 app.test.tsx 里钉，这里不重复钉一个字面量
    expect(bar()?.classList.contains('shrink-0')).toBe(true);
    // `min-w-0 flex-1`：tablist 吃掉动作区以外的宽度、溢出时自己滚，不把动作区挤出栏外
    for (const cls of ['min-w-0', 'flex-1', 'overflow-x-auto', 'scrollbar-none']) {
      expect(strip()?.classList.contains(cls)).toBe(true);
    }
    expect(shellOf(tabByTitle('src/a.ts')).classList.contains('shrink-0')).toBe(true);
  });

  it('分隔线是外层的 divider-b，tab 不 -mb-px——tablist 是滚动容器，伸进 border 带的那 1px 会被裁掉', () => {
    pinned('diff', 'src/a.ts');
    // 按教科书写法「修回去」（栏 border-b + tab -mb-px）时下划线看不见，还多出 1px 纵向可滚溢出
    expect(bar()?.classList.contains('divider-b')).toBe(true);
    expect(bar()?.classList.contains('border-b')).toBe(false);
    expect(strip()?.classList.contains('border-b')).toBe(false);
    const shell = shellOf(tabByTitle('src/a.ts'));
    expect(shell.classList.contains('border-b')).toBe(true);
    expect(shell.classList.contains('-mb-px')).toBe(false);
  });
});

/**
 * 栏右端的 `Copy file contents`：全文 tab 的正文就绪时才有，复制的是缓存里的原文。它是 tablist
 * 的兄弟——躺进去时读屏把它报成又一个 tab，且会随 tab 横向滚走。
 */
describe('Copy file contents', () => {
  // 动作区自己订阅缓存，缓存一变它是 signals 调度的异步重画——根上那次同步 `flush()` 不
  // 带它，断言前得等一拍
  const ready = (path: string, payload: FilePayload) =>
    setFileState(path, { status: 'ready', payload });
  const labelOf = () => copyButton()?.getAttribute('aria-label') ?? null;

  it('全文 tab 的正文就绪时画在 tablist 之外；点它写入原文、换成 Copied 再复原', async () => {
    vi.useFakeTimers();
    const writeText = stubClipboard();
    pinned('file', 'src/a.ts');
    expect(copyButton()).toBeNull();

    // 原文带末尾换行、带要转义的字符：写进剪贴板的是它本身，不是 hljs 的 HTML，也没有行号
    const content = 'const a = 1 < 2;\n';
    ready('src/a.ts', { kind: 'text', content });
    await waitFor(() => expect(labelOf()).toBe('Copy file contents'));
    const button = copyButton();
    expect(strip()?.contains(button ?? null)).toBe(false);
    expect(bar()?.contains(button ?? null)).toBe(true);

    button?.click();
    expect(writeText).toHaveBeenCalledWith(content);
    // 反馈等 writeText 的 promise 落定才画
    await vi.advanceTimersByTimeAsync(0);
    expect(labelOf()).toBe('Copied');
    await vi.advanceTimersByTimeAsync(1500);
    expect(labelOf()).toBe('Copy file contents');
  });

  it('没有正文可复制时不画：加载中、出错、二进制、图片、符号链接、过大', async () => {
    pinned('file', 'src/a.ts');
    const noText: FileRequestState[] = [
      { status: 'loading' },
      { status: 'error', message: 'gone' },
      { status: 'ready', payload: { kind: 'binary' } },
      { status: 'ready', payload: { kind: 'image', size: 10, version: 'v1' } },
      { status: 'ready', payload: { kind: 'symlink', target: 'b.ts' } },
      { status: 'ready', payload: { kind: 'too-large', size: 6_000_000, reason: 'size' } },
    ];
    // 每一档都从「按钮在」起步：只断言 null 的话，一次没发生的重画也是绿的
    for (const state of noText) {
      ready('src/a.ts', { kind: 'text', content: 'x\n' });
      await waitFor(() => expect(copyButton()).not.toBeNull());
      setFileState('src/a.ts', state);
      await waitFor(() => expect(copyButton()).toBeNull());
    }
  });

  it('diff 与 commit tab 不画——哪怕同一路径的全文就在缓存里', async () => {
    ready('src/a.ts', { kind: 'text', content: 'x\n' });
    pinned('file', 'src/a.ts');
    await waitFor(() => expect(copyButton()).not.toBeNull());

    pinned('diff', 'src/a.ts');
    await waitFor(() => expect(copyButton()).toBeNull());

    activeEditorKey.value = editorKey('file', 'src/a.ts');
    await waitFor(() => expect(copyButton()).not.toBeNull());
    openCommitEditor('a'.repeat(40), 'src/a.ts', undefined, true);
    await waitFor(() => expect(copyButton()).toBeNull());
  });

  it('正文就绪、动作区挤进来之后，活动 tab 再滚进视野一次——不然 tablist 窄了一截，它的右端被裁掉', async () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    pinned('file', 'src/a.ts');
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));

    ready('src/a.ts', { kind: 'text', content: 'x\n' });
    await waitFor(() => expect(copyButton()).not.toBeNull());
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2));
    expect(scrolled.mock.instances[1]).toBe(shellOf(tabByTitle('src/a.ts')));
    expect(scrolled.mock.calls[1]?.[0]).toMatchObject({ inline: 'nearest' });
  });

  it('切到另一个全文 tab 时 Copied 归零，不把上一个文件的「已复制」带过来', async () => {
    vi.useFakeTimers();
    stubClipboard();
    ready('src/a.ts', { kind: 'text', content: 'a\n' });
    ready('src/b.ts', { kind: 'text', content: 'b\n' });
    pinned('file', 'src/a.ts');
    pinned('file', 'src/b.ts');
    activeEditorKey.value = editorKey('file', 'src/a.ts');
    await waitFor(() => expect(labelOf()).toBe('Copy file contents'));

    copyButton()?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(labelOf()).toBe('Copied');

    // 1.5s 远没到：此刻换回 `Copy file contents` 只能是按键重挂，不是计时器到点
    activeEditorKey.value = editorKey('file', 'src/b.ts');
    await waitFor(() => expect(labelOf()).toBe('Copy file contents'));
  });
});

describe('版式切换', () => {
  const SHA = 'a'.repeat(40);
  const PATCH: DiffPayload = { kind: 'text', patch: 'diff --git a/src/a.ts b/src/a.ts\n' };
  /** 一份就绪的补丁状态（只造值、不写缓存，写由 `setDiffState` / `setCommitDiffState` 做）。 */
  const readyDiff = (payload: DiffPayload): DiffRequestState => ({
    status: 'ready',
    rename: null,
    payload,
  });
  const labelOf = () => formatButton()?.getAttribute('aria-label') ?? null;

  it('diff tab 的文本补丁就绪时画在 tablist 之外；文案是目标版式，点一下翻过去', async () => {
    pinned('diff', 'src/a.ts');
    expect(formatButton()).toBeNull();

    setDiffState('src/a.ts', readyDiff(PATCH));
    await waitFor(() => expect(labelOf()).toBe('View inline'));
    const button = formatButton();
    expect(strip()?.contains(button ?? null)).toBe(false);
    expect(bar()?.contains(button ?? null)).toBe(true);
    // 同一时刻动作区至多一枚：diff tab 上没有复制全文
    expect(copyButton()).toBeNull();

    button?.click();
    expect(diffOutputFormat.value).toBe('line-by-line');
    await waitFor(() => expect(labelOf()).toBe('View side by side'));
    formatButton()?.click();
    expect(diffOutputFormat.value).toBe('side-by-side');
    await waitFor(() => expect(labelOf()).toBe('View inline'));
  });

  it('untracked-text 与 commit tab 的文本补丁同样画', async () => {
    pinned('diff', 'src/a.ts');
    setDiffState('src/a.ts', readyDiff({ kind: 'untracked-text', patch: PATCH.patch }));
    await waitFor(() => expect(formatButton()).not.toBeNull());

    openCommitEditor(SHA, 'src/b.ts', undefined, true);
    await waitFor(() => expect(formatButton()).toBeNull());
    setCommitDiffState(SHA, 'src/b.ts', readyDiff(PATCH));
    await waitFor(() => expect(formatButton()).not.toBeNull());
  });

  it('没有补丁表格时不画：加载中、出错、二进制、图片、过大，以及全文 tab', async () => {
    pinned('diff', 'src/a.ts');
    const noPatch: DiffRequestState[] = [
      { status: 'loading', rename: null },
      { status: 'error', rename: null, message: 'gone' },
      readyDiff({ kind: 'binary' }),
      readyDiff({ kind: 'image', old: null, new: null }),
      readyDiff({ kind: 'too-large', size: 6_000_000, reason: 'size' }),
    ];
    // 每一档都从「按钮在」起步，理由同复制全文那条
    for (const state of noPatch) {
      setDiffState('src/a.ts', readyDiff(PATCH));
      await waitFor(() => expect(formatButton()).not.toBeNull());
      setDiffState('src/a.ts', state);
      await waitFor(() => expect(formatButton()).toBeNull());
    }

    // 同一路径的补丁就在缓存里，切到全文 tab 也不画
    setDiffState('src/a.ts', readyDiff(PATCH));
    await waitFor(() => expect(formatButton()).not.toBeNull());
    pinned('file', 'src/a.ts');
    await waitFor(() => expect(formatButton()).toBeNull());
  });

  it('补丁就绪、动作区挤进来之后，活动 tab 再滚进视野一次', async () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    pinned('diff', 'src/a.ts');
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));

    setDiffState('src/a.ts', readyDiff(PATCH));
    await waitFor(() => expect(formatButton()).not.toBeNull());
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2));
    expect(scrolled.mock.instances[1]).toBe(shellOf(tabByTitle('src/a.ts')));
  });
});
