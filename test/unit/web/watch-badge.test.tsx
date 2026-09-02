// 监听降级标注（三条「UI 明确标注降级模式」）。
//
// 两个方向都要断言，理由同 branch-status.test.tsx：只断言「降级时画出来了」时，
// 常驻一个标签也是绿的（于是降级那一次淹在里面）；只断言「原生时什么都没画」时，
// 组件整个画空也是绿的。
//
// 第三条是判据本身：**降级与否只看 `mode`，不看 `tier`**。C 档的轮询是既定形态、A/B 档的轮询
// 是出过错，两者的区别属后端知识，前端拿 tier 去猜就是第二份实现——而它不受任何门禁覆盖。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchState } from '../../../src/server/shared/protocol';
import { App } from '../../../src/web/components/App';
import { WatchBadge } from '../../../src/web/components/WatchBadge';
import { diffState, loadError, repoState } from '../../../src/web/state/store';

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  repoState.value = null;
  loadError.value = null;
  diffState.value = null;
});

const textOf = (node: Element | null): string =>
  (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('WatchBadge', () => {
  it('降级为轮询时标注出来', () => {
    render(<WatchBadge watch={{ mode: 'polling', tier: 'C' }} />, container);
    expect(textOf(container)).toContain('Polling');
  });

  it('原生监听时什么都不画', () => {
    // A / B 档的「UI 标注」列就是「无」。反过来常驻一个「实时」标签，等于让常态多出一块永远正确、
    // 因此永远不被读的字
    render(<WatchBadge watch={{ mode: 'native', tier: 'A' }} />, container);
    expect(textOf(container)).toBe('');
  });

  it('判据是 mode 不是 tier', () => {
    // 这两份的 tier 恰好与「常见搭配」相反：C 档不一定在轮询（强制指定 + 别的平台），A 档也可能落
    // 到轮询兜底。按 tier 猜的写法会把两份都判反，而页面上只是「标注偶尔不见 / 偶尔多出来」
    render(<WatchBadge watch={{ mode: 'native', tier: 'C' } as WatchState} />, container);
    expect(textOf(container)).toBe('');

    render(<WatchBadge watch={{ mode: 'polling', tier: 'A' }} />, container);
    expect(textOf(container)).toContain('Polling');
  });
});

describe('App 的状态条', () => {
  it('降级标注真的挂在状态条上，且跟着 state 变', async () => {
    // 组件本身全绿、却压根没被挂进 App——单测组件的用例一条都盖不到这种失效
    render(<App />, container);
    // 状态条随第一份 state 一起出现，故每次断言都重新取
    const footer = () => container.querySelector('footer');

    repoState.value = {
      repoName: 'demo',
      branch: { head: 'main', detached: false, upstream: null },
      files: [],
      watch: { mode: 'native', tier: 'A' },
    };
    await vi.waitFor(() => expect(textOf(footer())).toContain('main'), { interval: 5 });
    expect(textOf(footer())).not.toContain('Polling');

    // 降级是**运行中**发生的：后端推一个 change、前端重取 /api/state 才看得见，这里就是那次重取
    repoState.value = {
      repoName: 'demo',
      branch: { head: 'main', detached: false, upstream: null },
      files: [],
      watch: { mode: 'polling', tier: 'A' },
    };
    await vi.waitFor(() => expect(textOf(footer())).toContain('Polling'), { interval: 5 });
  });
});
