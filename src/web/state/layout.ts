// 布局派生状态(`outputFormat` 那条)。不放进 `store.ts`:那份装的是仓库状态,而面板宽度
// 不是仓库的事,是页面自己的量。

import { computed, signal } from '@preact/signals';
import type { DiffOutputFormat } from '../diff/render';

/**
 * 低于这个宽度就不并排。**量的是 diff 面板自己的宽度,不是视口宽度**:侧栏固定 `w-80`
 * (320px)且 `shrink-0`,面板宽度恒等于「视口 − 320」。按视口判等于把这个常数在 CSS 之外再
 * 写一遍,而侧栏宽度将来一改,切换点就静默错位到别的宽度上。
 *
 * **1024 这个数是算出来的,不是抄 Tailwind 的 `lg`**:diff2html 的表是 13px Menlo,并排每侧
 * 留 `9em` 给行号槽、逐行留 `8em`。于是面板 1024 时并排每侧只剩约 395px(约 50 个等宽字符),
 * 而同一宽度下逐行有 920px(约 118 个)。50 列是绝大多数源码行开始需要横向滚动的地方,阈值
 * 就落在这里。要改它,回来重算这两行,别凭手感调。
 */
export const SIDE_BY_SIDE_MIN_WIDTH = 1024;

/**
 * diff 面板的 **border-box** 宽度。写入方只有下面的 `observeDiffPanel`。初值取阈值本身,于是
 * 「还没量过」与「够宽」不可区分 —— 这是有意的:两者本来就该走并排,建模成 `number | null`
 * 只会多一个所有下游都要收窄一次、却永远走不到的分支。观察者在首帧就投递一次真实尺寸。
 */
export const diffPanelWidth = signal(SIDE_BY_SIDE_MIN_WIDTH);

/**
 * 当前该用哪种版式 —— **派生量,不是第二份状态**。`computed` 自带 `Object.is` 去重:拖窗口时
 * 每一像素都会写一次 `diffPanelWidth`,而下游只在**真的跨过阈值**那一次收到通知。**它封的是
 * 「每像素一次」,不是「每次跨越一次」** —— 贴着阈值来回蹭,每跨一次仍是一次完整的 `draw()`
 * (解析 + 全量高亮,同步)。没为此加迟滞或 debounce:同一次 `draw()` 的代价 SSE 刷新每来一
 * 个事件就要付一遍,而贴着边界反复拖是个转瞬即逝的动作,不值得把这个纯派生量变成第二份状态。
 */
export const diffOutputFormat = computed<DiffOutputFormat>(() =>
  diffPanelWidth.value < SIDE_BY_SIDE_MIN_WIDTH ? 'line-by-line' : 'side-by-side',
);

/**
 * 把一个元素的宽度接到 `diffPanelWidth` 上,返回取消订阅的函数。
 *
 * **「怎么量」和「量出来算窄还是宽」必须待在同一个文件里**:上面那个阈值的正确性全靠「送进
 * 来的是 border box」,而这件事没有任何东西强制得了 —— 调用方随手改成 `entry.contentRect
 * .width`(那是更眼熟的 ResizeObserver 写法),抖动回路就回来了,而 `tsc` / `check:css` /
 * 单测没有一个会红(happy-dom 没有布局引擎,量不出宽度)。
 *
 * 两处都显式写 border box:`{ box: 'border-box' }` 让**投递本身**按 border box 判有没有变
 * (默认的 content-box 观察会在滚动条进出时各推一次回调,而那正是我们要滤掉的东西);
 * `borderBoxSize` 读的是观察阶段就算好的那个值,不像 `getBoundingClientRect()` 要另走一次脏
 * 检查,也不带 transform 缩放。`?.` 只是 `noUncheckedIndexedAccess` 要求的写法。
 */
export function observeDiffPanel(panel: HTMLElement): () => void {
  const observer = new ResizeObserver((entries) => {
    const size = entries[0]?.borderBoxSize[0];
    if (size !== undefined) diffPanelWidth.value = size.inlineSize;
  });
  observer.observe(panel, { box: 'border-box' });
  return () => observer.disconnect();
}
