// 左栏宽度：夹界、交给 CSS 的那道视口上限，以及把手那一侧的键盘 / 双击 / aria。
//
// **拖动本身（pointer capture + move）与「窄窗口里左栏真的被压住」归肉眼**：happy-dom 没有布局
// 引擎，`max-width` 不生效。能自动化的是「给定视口，一次调节之后宽度与 aria 是否一致」。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarSash } from '../../../src/web/components/SidebarSash';
import {
  PANE_DEFAULT_PERCENT,
  PANE_MAX_PERCENT,
  panePercent,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SPLIT_DEFAULT_PERCENT,
  sashDragging,
  setPanePercent,
  setSidebarWidth,
  setSplitPercent,
  sidebarStyle,
  sidebarWidth,
  splitPercent,
  syncPanelSizes,
} from '../../../src/web/state/sidebar';
import { waitFor } from './helpers';

// 模块级 signal 会跨用例串味
afterEach(() => {
  setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  vi.restoreAllMocks();
});

describe('宽度', () => {
  it('夹进静态上下界并取整', () => {
    setSidebarWidth(0);
    expect(sidebarWidth.value).toBe(SIDEBAR_MIN_WIDTH);
    setSidebarWidth(10_000);
    expect(sidebarWidth.value).toBe(SIDEBAR_MAX_WIDTH);
    setSidebarWidth(400.6);
    expect(sidebarWidth.value).toBe(401);
  });

  it('随视口收的上限写在 max-width 上，总给 diff 面板留 320px', () => {
    setSidebarWidth(480);
    // 少了 max-width 时窄窗口里面板被挤到 0；少了 min-width 时视口极窄时左栏也跟着缩到 200 以下
    expect(sidebarStyle.value).toBe(
      'width:480px;min-width:200px;max-width:min(960px,calc(100vw - 320px))',
    );
  });
});

describe('SidebarSash', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    render(<SidebarSash />, container);
  });

  afterEach(() => {
    render(null, container);
    container.remove();
  });

  const sash = () => container.querySelector<HTMLElement>('[role="separator"]');
  const press = (key: string) =>
    sash()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

  it('是一个可聚焦、带取值范围的竖向 separator', () => {
    const el = sash();
    expect(el?.getAttribute('aria-orientation')).toBe('vertical');
    expect(el?.getAttribute('aria-label')).toBe('Resize sidebar');
    expect(el?.tabIndex).toBe(0);
    expect(el?.getAttribute('aria-valuemin')).toBe(String(SIDEBAR_MIN_WIDTH));
    expect(el?.getAttribute('aria-valuemax')).toBe(String(SIDEBAR_MAX_WIDTH));
    expect(el?.getAttribute('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT_WIDTH));
  });

  it('不让浏览器把触屏拖动认作滚动', () => {
    expect(sash()?.style.touchAction).toBe('none');
  });

  it('方向键一次 16px，aria-valuenow 跟着走', async () => {
    press('ArrowRight');
    expect(sidebarWidth.value).toBe(SIDEBAR_DEFAULT_WIDTH + 16);
    // aria 是以 signal 绑上去的、异步落到 DOM 上，得等
    await waitFor(() =>
      expect(sash()?.getAttribute('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT_WIDTH + 16)),
    );

    press('ArrowLeft');
    expect(sidebarWidth.value).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('连发的方向键在绑定落地之前也逐次累加', () => {
    // 两次 keydown 之间不等：量 DOM 起算的写法在这里只走 16px
    press('ArrowRight');
    press('ArrowRight');
    expect(sidebarWidth.value).toBe(SIDEBAR_DEFAULT_WIDTH + 32);
  });

  it('从屏幕上的宽度起算：窄窗口里被压住时，第一下就看得见', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
    setSidebarWidth(600);
    // 视口 800 时屏幕上是 480。从选的 600 算起是 584，仍被 max-width 压在 480——按了等于没按
    press('ArrowLeft');
    expect(sidebarWidth.value).toBe(464);
  });

  it('Home / End 到两端', () => {
    press('End');
    expect(sidebarWidth.value).toBe(SIDEBAR_MAX_WIDTH);
    press('Home');
    expect(sidebarWidth.value).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('双击复位到默认', () => {
    setSidebarWidth(500);
    sash()?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(sidebarWidth.value).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('刷新后保留', () => {
  /** effect 的取消订阅句柄。不收的话上一条用例的 effect 会跟着下一条一起写 */
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    sashDragging.value = null;
    setPanePercent(PANE_DEFAULT_PERCENT);
    setSplitPercent(SPLIT_DEFAULT_PERCENT);
    localStorage.clear();
  });

  it('接线时读回三把把手存着的取值', () => {
    localStorage.setItem('difftab:sidebar-width', '480');
    localStorage.setItem('difftab:pane-percent', '30.5');
    localStorage.setItem('difftab:split-percent', '65');
    dispose = syncPanelSizes();
    expect(sidebarWidth.value).toBe(480);
    expect(panePercent.value).toBe(30.5);
    expect(splitPercent.value).toBe(65);
  });

  it('越界的存值经 setter 夹回界内，且首跑不为它写一次', () => {
    localStorage.setItem('difftab:sidebar-width', '5000');
    localStorage.setItem('difftab:pane-percent', '99');
    dispose = syncPanelSizes();
    expect(sidebarWidth.value).toBe(SIDEBAR_MAX_WIDTH);
    expect(panePercent.value).toBe(PANE_MAX_PERCENT);
    expect(localStorage.getItem('difftab:sidebar-width')).toBe('5000');
  });

  it('脏值留在缺省，也不被清掉', () => {
    localStorage.setItem('difftab:sidebar-width', 'abc');
    localStorage.setItem('difftab:pane-percent', '');
    dispose = syncPanelSizes();
    expect(sidebarWidth.value).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(panePercent.value).toBe(PANE_DEFAULT_PERCENT);
    expect(localStorage.getItem('difftab:sidebar-width')).toBe('abc');
  });

  it('什么都没存时接线不写任何东西', () => {
    dispose = syncPanelSizes();
    expect(localStorage.length).toBe(0);
  });

  it('不在拖动时改了即写（键盘、双击复位走这条）', () => {
    dispose = syncPanelSizes();
    setSidebarWidth(400);
    setSplitPercent(70);
    expect(localStorage.getItem('difftab:sidebar-width')).toBe('400');
    expect(localStorage.getItem('difftab:split-percent')).toBe('70');
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    expect(localStorage.getItem('difftab:sidebar-width')).toBe(String(SIDEBAR_DEFAULT_WIDTH));
  });

  it('拖动中不写，松手写一次最终值', () => {
    dispose = syncPanelSizes();
    const setItem = vi.spyOn(localStorage, 'setItem');
    sashDragging.value = { name: 'pane', axis: 'y' };
    setPanePercent(40);
    setPanePercent(35);
    expect(setItem).not.toHaveBeenCalled();
    sashDragging.value = null;
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('difftab:pane-percent')).toBe('35');
  });

  it('读写抛异常时不抛出，只在内存里生效', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    dispose = syncPanelSizes();
    expect(sidebarWidth.value).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(() => setSidebarWidth(500)).not.toThrow();
    expect(sidebarWidth.value).toBe(500);
  });
});
