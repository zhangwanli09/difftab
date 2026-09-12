// 右侧面板顶上那条编辑器标签栏。
//
// 钉的都是「不报错、只是不对」：关闭按钮是 tab 按钮的兄弟而不是孩子（套在里面时点 × 会顺带激活、
// 快速双击 × 会把滑到指针底下的邻居固定住，且读屏看不见它）；预览 tab 斜体、固定之后转正；同一
// 路径的 diff 与全文是两个 tab、图标是它们之间唯一的视觉差别；关闭按钮只在活动 tab 上常显。
// happy-dom 没有排版引擎，横向滚、截断与透明度只能钉类名。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorTabs } from '../../../src/web/components/EditorTabs';
import { activeEditorKey, editors, openEditor } from '../../../src/web/state/editors';
import { repoState } from '../../../src/web/state/store';
import { file, openPinned, resetEditors, stubJson, waitFor } from './helpers';

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
  vi.unstubAllGlobals();
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
    expect(container.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(
      'Open editors',
    );
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
    scrolled.mockRestore();
  });

  it('栏横向滚、tab 不压扁——happy-dom 里只能钉类名', () => {
    pinned('diff', 'src/a.ts');
    const strip = container.querySelector('[role="tablist"]');
    for (const cls of ['shrink-0', 'overflow-x-auto']) {
      expect(strip?.classList.contains(cls)).toBe(true);
    }
    expect(shellOf(tabByTitle('src/a.ts')).classList.contains('shrink-0')).toBe(true);
  });
});
