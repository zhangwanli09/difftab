// `Changes` 档里的两个分区：折叠、分隔条的键盘 / 双击 / aria，以及「`History` 折着就不取」。
//
// **拖动本身与两块真的按比例分高度归肉眼**：happy-dom 没有布局引擎，`flex-basis` 不生效、
// `getBoundingClientRect` 回 0。能自动化的是比例的夹界、交给 CSS 的那串样式，与按键之后的取值。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoState } from '../../../src/server/shared/protocol';
import { App } from '../../../src/web/components/App';
import { SourceControl } from '../../../src/web/components/SourceControl';
import {
  historyCollapsed,
  PANE_DEFAULT_PERCENT,
  PANE_MAX_PERCENT,
  PANE_MIN_PERCENT,
  panePercent,
  paneStyle,
  setPanePercent,
} from '../../../src/web/state/sidebar';
import { activeTab, repoState } from '../../../src/web/state/store';
import { resetHistory, resetPanes, waitFor } from './helpers';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  // 提交列表那一趟用例里不需要真回来
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
});

// 模块级 signal 会跨用例串味
afterEach(() => {
  render(null, container);
  container.remove();
  resetPanes();
  activeTab.value = 'changes';
  repoState.value = null;
  resetHistory();
  vi.unstubAllGlobals();
});

const header = (title: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('h2 > button')].find(
    (node) => node.textContent === title,
  );
  if (!found) throw new Error(`没有画出 ${title} 这个分区`);
  return found as HTMLButtonElement;
};
const sash = () => container.querySelector<HTMLElement>('[role="separator"]');
const press = (key: string) =>
  sash()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('比例', () => {
  it('夹进上下界', () => {
    setPanePercent(0);
    expect(panePercent.value).toBe(PANE_MIN_PERCENT);
    setPanePercent(100);
    expect(panePercent.value).toBe(PANE_MAX_PERCENT);
    // 取到一位小数：读屏念出来的不该是一长串小数
    setPanePercent(42.345);
    expect(panePercent.value).toBe(42.3);
  });

  it('上面那块的高度是一个百分比的 flex-basis——存比例，窗口拉高拉矮时两块一起伸缩', () => {
    setPanePercent(30);
    expect(paneStyle.value).toBe('flex:0 0 30%');
  });
});

describe('两个分区', () => {
  beforeEach(() => {
    render(<SourceControl />, container);
  });

  it('默认都展开，中间一条分隔条', () => {
    expect(header('Changes').getAttribute('aria-expanded')).toBe('true');
    expect(header('History').getAttribute('aria-expanded')).toBe('true');
    expect(sash()).not.toBeNull();
  });

  it('点标题折起那一块，分隔条跟着撤掉——只剩一块时没有可分的高度', async () => {
    header('History').click();
    await waitFor(() => expect(header('History').getAttribute('aria-expanded')).toBe('false'));
    expect(historyCollapsed.value).toBe(true);
    expect(sash()).toBeNull();

    header('History').click();
    await waitFor(() => expect(sash()).not.toBeNull());
  });

  it('折起是隐藏不是卸载——滚动容器连同 scrollTop 留着，再展开时回到原处', async () => {
    const body = () => header('History').closest('h2')?.nextElementSibling as HTMLElement;
    const before = body();
    header('History').click();
    await waitFor(() => expect(body().classList.contains('hidden')).toBe(true));
    // Changes 那块照常
    expect(header('Changes').closest('h2')?.nextElementSibling?.classList.contains('hidden')).toBe(
      false,
    );
    header('History').click();
    await waitFor(() => expect(body().classList.contains('hidden')).toBe(false));
    expect(body()).toBe(before);
  });

  it('分隔条是一个可聚焦、带取值范围的横向 separator', () => {
    const el = sash();
    expect(el?.getAttribute('aria-orientation')).toBe('horizontal');
    expect(el?.getAttribute('aria-label')).toBe('Resize changes');
    expect(el?.tabIndex).toBe(0);
    expect(el?.getAttribute('aria-valuemin')).toBe('15');
    expect(el?.getAttribute('aria-valuemax')).toBe('85');
    expect(el?.getAttribute('aria-valuenow')).toBe('50');
    expect(el?.style.touchAction).toBe('none');
  });

  it('↑/↓ 一次 5%，aria-valuenow 跟着走', async () => {
    press('ArrowDown');
    expect(panePercent.value).toBe(55);
    await waitFor(() => expect(sash()?.getAttribute('aria-valuenow')).toBe('55'));
    press('ArrowUp');
    press('ArrowUp');
    expect(panePercent.value).toBe(45);
  });

  it('Home / End 到两端，双击复位到一半', () => {
    press('End');
    expect(panePercent.value).toBe(PANE_MAX_PERCENT);
    press('Home');
    expect(panePercent.value).toBe(PANE_MIN_PERCENT);
    sash()?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(panePercent.value).toBe(PANE_DEFAULT_PERCENT);
  });
});

describe('History 看得见时才取', () => {
  // 立刻失败而不是永远挂着：提交列表同一时刻只有一次在途（`singleFlight`），上一个用例里挂着不回来
  // 的那趟会让下一个用例的请求直接搭上它、一趟都不新发
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
  });

  const STATE: RepoState = {
    repoName: 'demo',
    branch: { head: 'main', detached: false, upstream: null },
    files: [],
    watch: { mode: 'native', tier: 'A' },
  };

  const commitCalls = () =>
    vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/commits')).length;

  it('第一份 state 到之前一趟都不发，到了只发一趟——挂载时就判必然对不上，补跑成两遍 git log', async () => {
    render(<App />, container);
    await waitFor(() => expect(header('History')).toBeDefined());
    expect(commitCalls()).toBe(0);

    repoState.value = STATE;
    await waitFor(() => expect(commitCalls()).toBe(1));
  });

  it('分区折着时挂载一趟都不发，展开那一刻补取', async () => {
    historyCollapsed.value = true;
    repoState.value = STATE;
    render(<App />, container);
    // 给 effect 一个跑的机会，再断言它没发
    await waitFor(() => expect(header('History')).toBeDefined());
    expect(commitCalls()).toBe(0);

    header('History').click();
    await waitFor(() => expect(commitCalls()).toBe(1));
  });

  it('停在 Files 档时不发，切回 Changes 档才取', async () => {
    activeTab.value = 'files';
    repoState.value = STATE;
    render(<App />, container);
    expect(commitCalls()).toBe(0);

    activeTab.value = 'changes';
    await waitFor(() => expect(commitCalls()).toBe(1));
  });
});
