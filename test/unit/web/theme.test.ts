// 明暗档位与它在 <html> 上的落点。
//
// **能自动化的是档位循环、属性的写与删、持久化，以及 localStorage 抛异常那条路径**；
// 压不到的是「切了之后页面真的变色」——那由 CSS 的三条 color-scheme 规则承担，
// happy-dom 没有层叠计算，判据在 `pnpm check:css` 与肉眼。
//
// 上次的选择由 `syncDocumentTheme()` 读进来（不在模块顶层读），因此这里不必
// `vi.resetModules()`：每条用例只要在装好存储之后调一次接线口。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cycleTheme, syncDocumentTheme, themePreference } from '../../../src/web/state/theme';

const STORAGE_KEY = 'difftab:theme';

/** effect 的取消订阅句柄。不收的话上一条用例的 effect 会跟着下一条一起写属性 */
let dispose: (() => void) | undefined;

/** 接上线，并保证用例结束时收掉。返回值是当前档位，方便直接断言初值。 */
function wire(): void {
  dispose = syncDocumentTheme();
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  // 模块级 signal 会跨用例串味
  themePreference.value = 'system';
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('档位循环', () => {
  it('system → light → dark → system——三档闭环，点得回「跟随系统」', () => {
    expect(themePreference.value).toBe('system');
    cycleTheme();
    expect(themePreference.value).toBe('light');
    cycleTheme();
    expect(themePreference.value).toBe('dark');
    cycleTheme();
    // 这一步是三档存在的全部理由：两档开关点过之后再也回不到跟随系统
    expect(themePreference.value).toBe('system');
  });
});

describe('落到 <html> 上', () => {
  it('跟随系统时 data-theme 属性不存在——缺省即跟随，不写 "system"', () => {
    wire();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('手动档写成 data-theme=light / dark', () => {
    wire();

    themePreference.value = 'light';
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    themePreference.value = 'dark';
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('切回跟随系统时属性被删掉，不是留一个空值', () => {
    wire();
    themePreference.value = 'dark';

    themePreference.value = 'system';
    // 留一个 data-theme="" 的话 CSS 那两条属性选择器都不命中，看着「像」是跟随系统了
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('跨会话保持', () => {
  it('手动档落盘，跟随系统则把那一项删掉', () => {
    wire();

    themePreference.value = 'dark';
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');

    themePreference.value = 'system';
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('下次打开读回上次的选择', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    wire();
    expect(themePreference.value).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('接线时不写存储——读回来的值没必要再写一遍', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    const setItem = vi.spyOn(localStorage, 'setItem');
    const removeItem = vi.spyOn(localStorage, 'removeItem');

    wire();

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('脏值退回跟随系统，而且不清掉它——这条路径对存储的唯一诉求是别把页面搞坏', () => {
    localStorage.setItem(STORAGE_KEY, 'midnight');
    wire();

    expect(themePreference.value).toBe('system');
    // 少了那道 `preference === persisted` 的 guard 时，effect 首跑会把它 removeItem 掉
    expect(localStorage.getItem(STORAGE_KEY)).toBe('midnight');
  });

  it('存的是 "system" 这种旧写法同样退回跟随系统', () => {
    // 合法值只有两个；"system" 落盘过就说明有人给缺省档也造了一个取值
    localStorage.setItem(STORAGE_KEY, 'system');
    wire();
    expect(themePreference.value).toBe('system');
  });
});

// happy-dom 的 localStorage 不是从 Storage.prototype 上取方法的，spy 打在原型上**拦不到**
//——而那样写时两条用例都变成空转（读不到照样是 system、写不抛照样不抛）。打在实例上。
describe('localStorage 不可用', () => {
  it('读抛异常时退回跟随系统，而不是整页白屏', () => {
    // 存的是 `'dark'`：**一个读得到就会生效的值**，否则读不读得到都是 system，这条会空转
    localStorage.setItem(STORAGE_KEY, 'dark');
    // Safari 隐私模式下光是取值就抛
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    // 没有那层 try/catch 时，wire() 本身就会抛——页面在挂载前白屏
    expect(() => wire()).not.toThrow();
    expect(themePreference.value).toBe('system');
  });

  it('写抛异常时属性照常落下——按钮还能用，只是刷新后不记得', () => {
    wire();
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => {
      themePreference.value = 'dark';
    }).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
