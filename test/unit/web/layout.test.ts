// 面板宽度 → diff 版式的映射。
//
// **这里测的是判据,不是那条 wiring**:`App.tsx` 里 `ResizeObserver` → `diffPanelWidth`
// 那一段在 happy-dom 上盖不到 —— 它的 `ResizeObserver` 是个 `observe()` 什么都不做的
// 空壳,而且它本来也没有布局引擎、量不出宽度(实测)。那一段归
// 的肉眼项;能自动化的是「给定宽度该出哪种版式」与「版式变了会不会
// 重画」(后者在 diff-view.test.tsx)。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  diffOutputFormat,
  diffPanelWidth,
  SIDE_BY_SIDE_MIN_WIDTH,
} from '../../../src/web/state/layout';

// 复位成模块自己的初值 —— 它是个模块级 signal,上一条用例写进去的宽度会跨用例串味
beforeEach(() => {
  diffPanelWidth.value = SIDE_BY_SIDE_MIN_WIDTH;
});

describe('diffOutputFormat', () => {
  it('窄于阈值走逐行', () => {
    diffPanelWidth.value = SIDE_BY_SIDE_MIN_WIDTH - 1;
    expect(diffOutputFormat.value).toBe('line-by-line');

    // 手机尺寸那一头同样成立(上一条只证了阈值下沿)
    diffPanelWidth.value = 320;
    expect(diffOutputFormat.value).toBe('line-by-line');
  });

  it('阈值本身及以上走并排 —— 边界归并排那一侧', () => {
    diffPanelWidth.value = SIDE_BY_SIDE_MIN_WIDTH;
    expect(diffOutputFormat.value).toBe('side-by-side');

    diffPanelWidth.value = SIDE_BY_SIDE_MIN_WIDTH + 1;
    expect(diffOutputFormat.value).toBe('side-by-side');
  });

  it('同一侧内改宽度不改版式 —— computed 自己去重,拖窗口不会每像素重画一次', () => {
    // 这条钉的是 layout.ts 里「不需要 debounce」那句的前提:值没变就不通知下游。
    // 换成 `signal<DiffOutputFormat>` 由调用方每次 resize 写一遍,这里就会红。
    diffPanelWidth.value = 1400;
    const first = diffOutputFormat.value;

    let notifications = 0;
    const stop = diffOutputFormat.subscribe(() => {
      notifications += 1;
    });
    // subscribe 会立刻投递一次当前值,先扣掉
    notifications = 0;

    for (const width of [1399, 1300, 1200, 1100, 1024]) {
      diffPanelWidth.value = width;
    }
    expect(diffOutputFormat.value).toBe(first);
    expect(notifications).toBe(0);

    // 正面那半:真跨过去时确实通知了一次 —— 少了它,一个永不通知的实现也能全绿
    diffPanelWidth.value = 1023;
    expect(notifications).toBe(1);
    expect(diffOutputFormat.value).toBe('line-by-line');

    stop();
  });
});
