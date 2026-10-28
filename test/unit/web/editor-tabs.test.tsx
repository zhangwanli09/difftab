// 右侧面板顶上那条编辑器标签栏。
//
// 钉的都是「不报错、只是不对」：关闭按钮是 tab 按钮的兄弟而不是孩子（套在里面时点 × 会顺带激活、
// 快速双击 × 会把滑到指针底下的邻居固定住，且读屏看不见它）；预览 tab 斜体、固定之后转正；同一
// 路径的 diff 与全文是两个 tab、图标是它们之间唯一的视觉差别；关闭按钮只在活动 tab 上常显；
// 复制全文那枚只在全文正文就绪时出现、站在 tablist 之外；版式切换那枚只在 diff / commit 的文本补丁
// 就绪时出现；目录只在撞名时画最短可区分的尾段；名字与文件树同色、commit tab 不染。
// happy-dom 没有排版引擎，横向滚、截断与透明度只能钉类名。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffPayload, FilePayload } from '../../../src/server/shared/protocol';
import { distinguishingDirs, EditorTabs } from '../../../src/web/components/EditorTabs';
import {
  activeEditorKey,
  activeGroup,
  editorKey,
  editors,
  focusEditor,
  openCommitEditor,
  openEditor,
  revealRequest,
} from '../../../src/web/state/editors';
import { diffFormatOverride, SIDE_BY_SIDE_MIN_WIDTH } from '../../../src/web/state/layout';
import {
  type DiffRequestState,
  type FileRequestState,
  ignoreWhitespace,
  markdownPreview,
  openFile,
  PATCH_DEFAULTS,
  repoState,
  svgPreview,
  wordWrap,
} from '../../../src/web/state/store';
import {
  file,
  openPinned,
  repo,
  resetEditors,
  restoreRealTimers,
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
const flush = () => render(<EditorTabs group={activeGroup.value} />, container);
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
  activeGroup.value.width.value = SIDE_BY_SIDE_MIN_WIDTH;
  diffFormatOverride.value = null;
  repoState.value = {
    repoName: 'demo',
    branch: { head: 'main', detached: false, upstream: null },
    files: [file({ path: 'src/a.ts', unstaged: 'M' }), file({ path: 'src/b.ts', unstaged: 'M' })],
    watch: { mode: 'native', tier: 'A' },
  };
  calls = stubJson({ kind: 'binary' });
  render(<EditorTabs group={activeGroup.value} />, container);
});

afterEach(() => {
  render(null, container);
  restoreRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('EditorTabs', () => {
  it('一个 editor 一个 tab、按顺序，title 是完整路径；没有同名时只画文件名、不画目录', () => {
    pinned('diff', 'src/a.ts');
    pinned('file', 'docs/b.md');
    expect(tabs().map((tab) => tab.title)).toEqual(['src/a.ts', 'docs/b.md']);
    const label = tabByTitle('src/a.ts').querySelector('.truncate');
    expect(label?.textContent).toBe('a.ts');
    expect(label?.querySelector('span')).toBeNull();
  });

  it('同名不同路径时画最短可区分的目录后缀，关掉一个后另一个的目录跟着消失', () => {
    pinned('diff', 'packages/foo/src/index.ts');
    pinned('file', 'packages/bar/src/index.ts');
    const dirOf = (title: string) =>
      tabByTitle(title).querySelector('.truncate > span')?.textContent ?? null;
    expect(dirOf('packages/foo/src/index.ts')).toBe('…/foo/src');
    expect(dirOf('packages/bar/src/index.ts')).toBe('…/bar/src');
    closeOf(tabByTitle('packages/bar/src/index.ts')).click();
    flush();
    expect(dirOf('packages/foo/src/index.ts')).toBeNull();
  });

  it('同一路径的 diff、全文与 commit tab 不算撞名——目录一样，画了也分不开', () => {
    pinned('diff', 'src/a.ts');
    pinned('file', 'src/a.ts');
    openCommitEditor('a'.repeat(40), 'src/a.ts', undefined, true);
    flush();
    for (const tab of tabs()) {
      expect(tab.querySelector('.truncate')?.textContent).not.toContain('src');
    }
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

    focusEditor(editorKey('file', 'src/a.ts'));
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
    focusEditor(editorKey('file', 'src/a.ts'));
    await waitFor(() => expect(labelOf()).toBe('Copy file contents'));

    copyButton()?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(labelOf()).toBe('Copied');

    // 1.5s 远没到：此刻换回 `Copy file contents` 只能是按键重挂，不是计时器到点
    focusEditor(editorKey('file', 'src/b.ts'));
    await waitFor(() => expect(labelOf()).toBe('Copy file contents'));
  });
});

describe('版式切换', () => {
  const SHA = 'a'.repeat(40);
  const PATCH: DiffPayload = {
    kind: 'text',
    patch: 'diff --git a/src/a.ts b/src/a.ts\n',
    full: false,
  };
  /** 一份就绪的补丁状态（只造值、不写缓存，写由 `setDiffState` / `setCommitDiffState` 做）。 */
  const readyDiff = (payload: DiffPayload): DiffRequestState => ({
    status: 'ready',
    rename: null,
    options: PATCH_DEFAULTS,
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
    // diff tab 上没有复制全文
    expect(copyButton()).toBeNull();

    button?.click();
    expect(activeGroup.value.format.value).toBe('line-by-line');
    await waitFor(() => expect(labelOf()).toBe('View side by side'));
    formatButton()?.click();
    expect(activeGroup.value.format.value).toBe('side-by-side');
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
      { status: 'loading', rename: null, options: PATCH_DEFAULTS },
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

describe('自动换行', () => {
  const ready = (path: string, payload: FilePayload) =>
    setFileState(path, { status: 'ready', payload });
  const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-label="Word Wrap"]');

  it('全文 tab 的文本就绪时画在复制左边；按图画着的 SVG、diff tab 都不画', async () => {
    pinned('file', 'src/a.ts');
    expect(toggle()).toBeNull();
    ready('src/a.ts', { kind: 'text', content: 'x\n' });
    await waitFor(() => expect(toggle()).not.toBeNull());
    expect(toggle()?.nextElementSibling).toBe(copyButton());

    // 预览开着时面板上是图，没有正文可折；复制照留
    ready('src/a.ts', { kind: 'text', content: '<svg/>', preview: { size: 6, version: 'v1' } });
    await waitFor(() => expect(toggle()).toBeNull());
    expect(copyButton()).not.toBeNull();

    pinned('diff', 'src/b.ts');
    setDiffState('src/b.ts', {
      status: 'ready',
      rename: null,
      options: PATCH_DEFAULTS,
      payload: { kind: 'text', patch: 'diff --git a/src/b.ts b/src/b.ts\n', full: false },
    });
    await waitFor(() => expect(formatButton()).not.toBeNull());
    expect(toggle()).toBeNull();
  });

  it('是一枚带按下态的开关，文案恒定；点一下翻全局开关、不发请求', async () => {
    pinned('file', 'src/a.ts');
    ready('src/a.ts', { kind: 'text', content: 'x\n' });
    await waitFor(() => expect(toggle()?.getAttribute('aria-pressed')).toBe('false'));
    const before = calls.length;

    toggle()?.click();
    expect(wordWrap.value).toBe(true);
    await waitFor(() => expect(toggle()?.getAttribute('aria-pressed')).toBe('true'));
    expect(toggle()?.getAttribute('aria-label')).toBe('Word Wrap');
    expect(calls.length).toBe(before);
  });
});

describe('忽略空白', () => {
  const SHA = 'a'.repeat(40);
  const PATCH: DiffPayload = {
    kind: 'text',
    patch: 'diff --git a/src/a.ts b/src/a.ts\n',
    full: false,
  };
  const readyDiff = (payload: DiffPayload): DiffRequestState => ({
    status: 'ready',
    rename: null,
    options: PATCH_DEFAULTS,
    payload,
  });
  const toggle = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Hide whitespace changes"]');

  it('git 出的补丁（diff 与 commit tab）就绪时画，排在版式按钮左边；全新增的补丁不画', async () => {
    pinned('diff', 'src/a.ts');
    expect(toggle()).toBeNull();
    setDiffState('src/a.ts', readyDiff(PATCH));
    await waitFor(() => expect(toggle()).not.toBeNull());
    expect(toggle()?.nextElementSibling).toBe(formatButton());

    // 版式按钮照画，忽略空白不画：全新增的文件没有旧侧可比
    setDiffState('src/a.ts', readyDiff({ kind: 'untracked-text', patch: PATCH.patch }));
    await waitFor(() => expect(toggle()).toBeNull());
    expect(formatButton()).not.toBeNull();

    openCommitEditor(SHA, 'src/b.ts', undefined, true);
    setCommitDiffState(SHA, 'src/b.ts', readyDiff(PATCH));
    await waitFor(() => expect(toggle()).not.toBeNull());
  });

  it('是一枚带按下态的开关，文案恒定；点一下翻全局开关并只重取活动 tab', async () => {
    // 重取回来的仍是一份 git 补丁：桩缺省回的 binary 会让按钮随之消失
    calls = stubJson(PATCH);
    pinned('diff', 'src/a.ts');
    setDiffState('src/a.ts', readyDiff(PATCH));
    await waitFor(() => expect(toggle()?.getAttribute('aria-pressed')).toBe('false'));
    const before = calls.length;

    toggle()?.click();
    expect(ignoreWhitespace.value).toBe(true);
    await waitFor(() => expect(toggle()?.getAttribute('aria-pressed')).toBe('true'));
    expect(toggle()?.getAttribute('aria-label')).toBe('Hide whitespace changes');
    await waitFor(() => expect(calls.length).toBe(before + 1));
    expect(calls.at(-1)).toContain('/api/diff?');
    expect(calls.at(-1)).toContain('ignoreWhitespace=1');
  });

  it('按钮数变了活动 tab 再滚一次：从全新增的补丁切到 git 的补丁，多出忽略空白那一枚', async () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    pinned('diff', 'src/a.ts');
    setDiffState('src/a.ts', readyDiff({ kind: 'untracked-text', patch: PATCH.patch }));
    // 打开一次、版式按钮挤进来一次
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2));

    setDiffState('src/a.ts', readyDiff(PATCH));
    await waitFor(() => expect(toggle()).not.toBeNull());
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(3));
  });
});

describe('SVG 预览', () => {
  const SHA = 'a'.repeat(40);
  const SIDE = { path: 'logo.svg', size: 120, version: 'v1' };
  const PATCH: DiffPayload = {
    kind: 'text',
    patch: 'diff --git a/logo.svg b/logo.svg\n',
    full: false,
    preview: { old: SIDE, new: SIDE },
  };
  const readyDiff = (payload: DiffPayload): DiffRequestState => ({
    status: 'ready',
    rename: null,
    options: PATCH_DEFAULTS,
    payload,
  });
  const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-label="Preview"]');
  const whitespace = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Hide whitespace changes"]');

  it('判据只认 payload 上的 preview：diff、commit、file 三种 tab 都画，排在最左', async () => {
    // 关着预览起步：开着时 diff tab 上没有忽略空白那一枚，排序就无从断言
    svgPreview.value = false;
    pinned('diff', 'logo.svg');
    setDiffState(
      'logo.svg',
      readyDiff({ kind: 'text', patch: 'diff --git a/logo.svg b/logo.svg\n', full: false }),
    );
    await waitFor(() => expect(formatButton()).not.toBeNull());
    expect(toggle()).toBeNull();

    setDiffState('logo.svg', readyDiff(PATCH));
    await waitFor(() => expect(toggle()).not.toBeNull());
    expect(toggle()?.nextElementSibling).toBe(whitespace());

    openCommitEditor(SHA, 'logo.svg', undefined, true);
    setCommitDiffState(SHA, 'logo.svg', readyDiff(PATCH));
    await waitFor(() => expect(toggle()).not.toBeNull());

    pinned('file', 'logo.svg');
    setFileState('logo.svg', {
      status: 'ready',
      payload: { kind: 'text', content: '<svg/>', preview: { size: 6, version: 'v1' } },
    });
    // 开关此刻关着、按文本画：自动换行夹在预览与复制之间
    const wrap = () => container.querySelector('button[aria-label="Word Wrap"]');
    await waitFor(() => expect(toggle()?.nextElementSibling).toBe(wrap()));
    expect(wrap()?.nextElementSibling).toBe(copyButton());
    setFileState('logo.svg', { status: 'ready', payload: { kind: 'text', content: '<svg/>' } });
    await waitFor(() => expect(toggle()).toBeNull());
    expect(copyButton()).not.toBeNull();
  });

  it('默认按下，此时版式与忽略空白两枚不画；切换不重取', async () => {
    calls = stubJson(PATCH);
    pinned('diff', 'logo.svg');
    setDiffState('logo.svg', readyDiff(PATCH));
    await waitFor(() => expect(toggle()?.getAttribute('aria-pressed')).toBe('true'));
    expect(formatButton()).toBeNull();
    expect(whitespace()).toBeNull();
    const before = calls.length;

    toggle()?.click();
    expect(svgPreview.value).toBe(false);
    await waitFor(() => expect(toggle()?.getAttribute('aria-pressed')).toBe('false'));
    expect(formatButton()).not.toBeNull();
    expect(whitespace()).not.toBeNull();
    expect(calls.length).toBe(before);

    toggle()?.click();
    await waitFor(() => expect(formatButton()).toBeNull());
    expect(whitespace()).toBeNull();
  });

  it('跳到某一行（全仓搜索的命中）只让那个 file tab 按文本画，全局开关不动；按下即清掉跳行', async () => {
    const svg: FilePayload = {
      kind: 'text',
      content: '<svg/>',
      preview: { size: 6, version: 'v1' },
    };
    stubJson(svg);
    openFile('logo.svg', { line: 3 });
    setFileState('logo.svg', { status: 'ready', payload: svg });
    flush();
    await waitFor(() => expect(toggle()?.getAttribute('aria-pressed')).toBe('false'));
    expect(svgPreview.value).toBe(true);

    toggle()?.click();
    expect(revealRequest.value).toBeNull();
    expect(svgPreview.value).toBe(true);
    await waitFor(() => expect(toggle()?.getAttribute('aria-pressed')).toBe('true'));

    toggle()?.click();
    expect(svgPreview.value).toBe(false);
  });

  it('按钮数变了活动 tab 再滚一次：关预览时版式与忽略空白一起进场', async () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    pinned('diff', 'logo.svg');
    setDiffState('logo.svg', readyDiff(PATCH));
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2));

    toggle()?.click();
    await waitFor(() => expect(formatButton()).not.toBeNull());
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(3));
  });
});

describe('Markdown 预览', () => {
  const MD: FilePayload = { kind: 'text', content: '# Title\n', markdown: true };
  const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-label="Preview"]');
  const wrap = () => container.querySelector('button[aria-label="Word Wrap"]');

  it('判据只认 payload 上的 markdown：默认未按下，自动换行与复制照画', async () => {
    pinned('file', 'README.md');
    setFileState('README.md', { status: 'ready', payload: { kind: 'text', content: '# Title\n' } });
    await waitFor(() => expect(copyButton()).not.toBeNull());
    expect(toggle()).toBeNull();

    setFileState('README.md', { status: 'ready', payload: MD });
    await waitFor(() => expect(toggle()?.getAttribute('aria-pressed')).toBe('false'));
    expect(toggle()?.nextElementSibling).toBe(wrap());
    expect(wrap()?.nextElementSibling).toBe(copyButton());
  });

  it('按下翻的是 markdown 那个开关，不碰 SVG 的；按渲染画时自动换行撤掉、复制照留', async () => {
    pinned('file', 'README.md');
    setFileState('README.md', { status: 'ready', payload: MD });
    await waitFor(() => expect(toggle()).not.toBeNull());

    toggle()?.click();
    expect(markdownPreview.value).toBe(true);
    expect(svgPreview.value).toBe(true);
    await waitFor(() => expect(toggle()?.getAttribute('aria-pressed')).toBe('true'));
    expect(wrap()).toBeNull();
    expect(copyButton()).not.toBeNull();

    toggle()?.click();
    expect(markdownPreview.value).toBe(false);
    await waitFor(() => expect(wrap()).not.toBeNull());
  });

  it('挂着跳行请求时按源码画、全局开关不动；按下即清掉跳行', async () => {
    markdownPreview.value = true;
    stubJson(MD);
    openFile('README.md', { line: 3 });
    setFileState('README.md', { status: 'ready', payload: MD });
    flush();
    await waitFor(() => expect(toggle()?.getAttribute('aria-pressed')).toBe('false'));
    expect(markdownPreview.value).toBe(true);

    toggle()?.click();
    expect(revealRequest.value).toBeNull();
    expect(markdownPreview.value).toBe(true);
    await waitFor(() => expect(toggle()?.getAttribute('aria-pressed')).toBe('true'));
  });
});

describe('distinguishingDirs', () => {
  it('取最短可区分的尾段，没取全时前面写 …/；没撞名的不在表里', () => {
    expect(
      distinguishingDirs(['packages/foo/src/index.ts', 'packages/bar/src/index.ts', 'README.md']),
    ).toEqual(
      new Map([
        ['packages/foo/src/index.ts', '…/foo/src'],
        ['packages/bar/src/index.ts', '…/bar/src'],
      ]),
    );
  });

  it('根目录下的文件没有目录段，画空；另一边一段就够', () => {
    expect(distinguishingDirs(['index.ts', 'src/index.ts'])).toEqual(
      new Map([
        ['index.ts', ''],
        ['src/index.ts', 'src'],
      ]),
    );
  });

  it('三个同名时按与每个邻居的最大公共尾段取，取到了全长就不写 …/', () => {
    expect(distinguishingDirs(['a/x/m.ts', 'b/x/m.ts', 'c/y/m.ts'])).toEqual(
      new Map([
        ['a/x/m.ts', 'a/x'],
        ['b/x/m.ts', 'b/x'],
        ['c/y/m.ts', '…/y'],
      ]),
    );
  });
});

describe('按 git 状态染色', () => {
  const labelOf = (title: string) => tabByTitle(title).querySelector('.truncate') as HTMLElement;

  it('diff 与全文 tab 的名字与文件树同色，不在改动里的不染', () => {
    pinned('diff', 'src/a.ts');
    pinned('file', 'src/b.ts');
    pinned('file', 'docs/c.md');
    expect(labelOf('src/a.ts').classList).toContain('text-git-modified');
    expect(labelOf('src/b.ts').classList).toContain('text-git-modified');
    expect(labelOf('docs/c.md').className).not.toMatch(/text-git-/);
  });

  it('commit tab 不染——那是历史补丁，工作区的状态说的不是它', () => {
    const sha = 'a'.repeat(40);
    openCommitEditor(sha, 'src/a.ts', undefined, true);
    flush();
    expect(labelOf(`src/a.ts @ ${sha}`).className).not.toMatch(/text-git-/);
  });

  it('状态变了颜色跟着变', async () => {
    pinned('diff', 'src/a.ts');
    repoState.value = repo({
      files: [file({ path: 'src/a.ts', staged: 'U', unstaged: 'U', conflicted: true })],
    });
    // tab 自己订阅 `codeByPath`，这一下是 signals 调度的异步重画，根上那次同步 `flush()` 不带它
    await waitFor(() => {
      expect(labelOf('src/a.ts').classList).toContain('text-git-conflicting');
      expect(labelOf('src/a.ts').classList).not.toContain('text-git-modified');
    });
  });
});
