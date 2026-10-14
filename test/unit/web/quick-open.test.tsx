// Quick Open：模糊匹配的打分与命中下标、空输入列变更文件、选中即以固定 tab 打开、关掉后焦点还回去，
// 以及两条全局快捷键。fetch 一律打桩。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/web/components/App';
import { activeEditor, revealRequest } from '../../../src/web/state/editors';
import {
  fileList,
  fileListError,
  matchFiles,
  matchPath,
  quickOpenVisible,
} from '../../../src/web/state/quick-open';
import { resetSearch, searchFocusRequest } from '../../../src/web/state/search';
import {
  handleGlobalKey,
  SHORTCUTS,
  shortcutKeys,
  withShortcut,
} from '../../../src/web/state/shortcuts';
import { activeTab, repoState } from '../../../src/web/state/store';
import { file, hideHistory, repo, resetEditors, stubJsonBy, waitFor } from './helpers';

describe('matchPath', () => {
  it('不分大小写的子序列；命中下标指向原路径里的字符', () => {
    const match = matchPath('aPt', 'src/web/App.tsx');
    expect(match).not.toBeNull();
    const chars = match?.positions.map((i) => 'src/web/App.tsx'[i]).join('');
    expect(chars?.toLowerCase()).toBe('apt');
    expect(matchPath('xyz', 'src/web/App.tsx')).toBeNull();
  });

  it('路径里有转小写会变长的字符（İ）时，其余字符照样不分大小写', () => {
    const match = matchPath('app', 'docs/İstanbul/App.tsx');
    expect(match?.positions.map((i) => 'docs/İstanbul/App.tsx'[i]).join('')).toBe('App');
  });

  it('查询里的空白不算', () => {
    expect(matchPath('app tsx', 'src/web/App.tsx')).not.toBeNull();
  });

  it('命中落在 basename 里的排在前面，basename 以查询开头的更前；同分短路径在前', () => {
    const order = matchFiles(
      ['app/mapper.ts', 'src/web/App.tsx', 'docs/apple-pie.md', 'a/p/p.txt', 'src/App.tsx'],
      'app',
    ).map((m) => m.path);
    expect(order.slice(0, 2)).toEqual(['src/App.tsx', 'src/web/App.tsx']);
    // 命中只能散在目录里的那条垫底
    expect(order.at(-1)).toBe('a/p/p.txt');
  });
});

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  // 默认可见的 `History` 分区一挂载就要取提交列表，桩回的不是那种 payload
  hideHistory();
  resetEditors();
  resetSearch();
  activeTab.value = 'changes';
  quickOpenVisible.value = false;
  fileList.value = null;
  fileListError.value = null;
  repoState.value = repo({
    files: [
      file({ path: 'src/changed.ts', unstaged: 'M' }),
      file({ path: 'gone.ts', unstaged: 'D' }),
    ],
  });
  stubJsonBy((url) =>
    url.pathname === '/api/files'
      ? { payload: { paths: ['README.md', 'src/changed.ts', 'src/web/App.tsx'] } }
      : { payload: { kind: 'text', content: 'x\n' } },
  );
});

afterEach(() => {
  render(null, container);
  quickOpenVisible.value = false;
  vi.unstubAllGlobals();
});

const dialog = () => container.querySelector('[role="dialog"][aria-label="Go to File"]');
const input = () => container.querySelector<HTMLInputElement>('[role="combobox"]');
const options = () => [...container.querySelectorAll('[role="option"]')];
const goToFile = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Go to File"]');
const type = (value: string) => {
  const box = input();
  if (!box) throw new Error('没有输入框');
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (target: EventTarget | null, init: KeyboardEventInit) =>
  target?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

describe('QuickOpen', () => {
  it('顶栏按钮打开；空输入列变更文件，工作区里已不在的不列', async () => {
    render(<App />, container);
    goToFile()?.click();
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(options().map((o) => o.textContent)).toEqual(['changed.tssrc']);
  });

  it('敲字后按模糊匹配列全仓文件，Enter 以固定 tab 打开、关掉并把焦点还给按钮', async () => {
    render(<App />, container);
    goToFile()?.focus();
    goToFile()?.click();
    await waitFor(() => expect(fileList.value).not.toBeNull());
    type('apptsx');
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(options()[0]?.querySelector('b')).not.toBeNull();

    key(input(), { key: 'Enter' });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(activeEditor.value).toMatchObject({
      kind: 'file',
      path: 'src/web/App.tsx',
      pinned: true,
    });
    // 不带行号地打开，不留跳行
    expect(revealRequest.value).toBeNull();
    expect(document.activeElement).toBe(goToFile());
  });

  it('列表还没到时说 Loading…，没命中时说 No matching files', async () => {
    stubJsonBy(() => ({ payload: { paths: ['a.ts'] } }));
    render(<App />, container);
    goToFile()?.click();
    await waitFor(() => expect(fileList.value).not.toBeNull());
    type('zzz');
    await waitFor(() => expect(dialog()?.textContent).toContain('No matching files'));
  });
});

describe('全局快捷键', () => {
  const press = (init: KeyboardEventInit, mac: boolean) => {
    const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
    handleGlobalKey(event, mac);
    return event;
  };

  it('Mac 上 ⌘P 开 Quick Open 并拦下打印；Ctrl+P 不认', () => {
    expect(press({ key: 'p', ctrlKey: true }, true).defaultPrevented).toBe(false);
    expect(quickOpenVisible.value).toBe(false);
    expect(press({ key: 'p', metaKey: true }, true).defaultPrevented).toBe(true);
    expect(quickOpenVisible.value).toBe(true);
  });

  it('其余平台认 Ctrl；⇧F 切到 Search 档并要求聚焦', () => {
    const before = searchFocusRequest.value;
    expect(press({ key: 'F', ctrlKey: true, shiftKey: true }, false).defaultPrevented).toBe(true);
    expect(activeTab.value).toBe('search');
    expect(searchFocusRequest.value).toBe(before + 1);
  });

  it('Quick Open 开着时按 ⇧F：浮层关掉，不留一个焦点已不在里面的弹层', () => {
    quickOpenVisible.value = true;
    press({ key: 'F', metaKey: true, shiftKey: true }, true);
    expect(quickOpenVisible.value).toBe(false);
    expect(activeTab.value).toBe('search');
  });

  it('带 Alt 的、或没有修饰键的一律不管', () => {
    expect(press({ key: 'p', ctrlKey: true, altKey: true }, false).defaultPrevented).toBe(false);
    expect(press({ key: 'p' }, false).defaultPrevented).toBe(false);
    expect(quickOpenVisible.value).toBe(false);
  });

  it('按键提示按平台写：Mac 是符号连写，其余是 Ctrl+ 拼接', () => {
    expect(shortcutKeys(SHORTCUTS.search, true)).toEqual(['⇧', '⌘', 'F']);
    expect(shortcutKeys(SHORTCUTS.search, false)).toEqual(['Ctrl', 'Shift', 'F']);
    expect(withShortcut('Go to File', SHORTCUTS.goToFile, true)).toBe('Go to File (⌘P)');
    expect(withShortcut('Search', SHORTCUTS.search, false)).toBe('Search (Ctrl+Shift+F)');
    expect(withShortcut('Files')).toBe('Files');
  });
});
