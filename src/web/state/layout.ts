// 布局状态（`outputFormat` 那条）：面板宽度派生出的版式，加上用户手动固定的那一档。不放进
// `store.ts`：那份装的是仓库状态，而面板宽度与版式偏好不是仓库的事，是页面自己的量。

import { computed, signal } from '@preact/signals';

/** diff 的两种版式。什么时候用哪个，就是本文件的事。 */
export type DiffOutputFormat = 'side-by-side' | 'line-by-line';

/**
 * 低于这个宽度就不并排。**量的是 diff 面板自己的宽度，不是视口宽度**：面板宽度是「视口 −
 * 侧栏宽度」，而侧栏可拖（`sidebar.ts`）。按视口判等于另算一遍侧栏宽度，漏了它切换点就静默
 * 错位到别的宽度上。
 *
 * **1024 这个数是算出来的，不是抄 Tailwind 的 `lg`**：diff 表是 13px 等宽，并排每侧留 `9em`
 * （左边 4em 行号槽 + 0.5em 间距，右边 4.5em 留白）、逐行留 `8em`（7.5em 行号槽 + 0.5em）——
 * 这几个数照抄的是 diff2html 当年的版面。于是面板 1024 时并排每侧只剩约 395px（约 50 个等宽
 * 字符），而同一宽度下逐行有 920px（约 118 个）。50 列是绝大多数源码行开始需要横向滚动的地方，
 * 阈值就落在这里。要改它，回来重算这两行，别凭手感调。
 */
export const SIDE_BY_SIDE_MIN_WIDTH = 1024;

/**
 * diff 面板的 **border-box** 宽度。写入方只有下面的 `observeDiffPanel`。初值取阈值本身，于是
 * 「还没量过」与「够宽」不可区分——这是有意的：两者本来就该走并排，建模成 `number | null`
 * 只会多一个所有下游都要收窄一次、却永远走不到的分支。观察者在首帧就投递一次真实尺寸。
 */
export const diffPanelWidth = signal(SIDE_BY_SIDE_MIN_WIDTH);

/**
 * 宽度判据给出的版式——**派生量，不是第二份状态**。`computed` 自带 `Object.is` 去重：拖窗口时
 * 每一像素都会写一次 `diffPanelWidth`，而下游只在**真的跨过阈值**那一次收到通知。**它封的是
 * 「每像素一次」，不是「每次跨越一次」**——贴着阈值来回蹭，每跨一次仍是一次整表重排（高亮结果
 * 按补丁缓存，不重算）。没为此加迟滞或 debounce：贴着边界反复拖是个转瞬即逝的动作，不值得把
 * 这个纯派生量变成第二份状态。
 */
const autoFormat = computed<DiffOutputFormat>(() =>
  diffPanelWidth.value < SIDE_BY_SIDE_MIN_WIDTH ? 'line-by-line' : 'side-by-side',
);

/**
 * 用户手动固定的版式，`null` 是「跟宽度走」。写入方只有 `toggleDiffOutputFormat`。与宽度那半
 * 不同，它是用户的显式选择，不是派生量。**不进 `localStorage`**：端口随机，记了也活不过一次
 * 重启；也因此刷新就回到自动，两态按钮不会把「跟宽度走」永久换掉。
 */
export const diffFormatOverride = signal<DiffOutputFormat | null>(null);

/**
 * 当前该用哪种版式。**override 与宽度判据合在这一个 `computed` 里**：`DiffView` 只订阅它，另开
 * 一条通路时固定之后拖窗口照样换版式。固定之后观察者照写宽度，`autoFormat` 变了这里也不变，
 * `Object.is` 去重让下游收不到通知。
 */
export const diffOutputFormat = computed<DiffOutputFormat>(
  () => diffFormatOverride.value ?? autoFormat.value,
);

/** 翻到当前版式的另一种并固定下来——无论此刻是自动给的还是上次手动选的。 */
export function toggleDiffOutputFormat(): void {
  diffFormatOverride.value =
    diffOutputFormat.value === 'side-by-side' ? 'line-by-line' : 'side-by-side';
}

/**
 * 把一个元素的宽度接到 `diffPanelWidth` 上，返回取消订阅的函数。
 *
 * **「怎么量」和「量出来算窄还是宽」必须待在同一个文件里**：上面那个阈值的正确性全靠「送进
 * 来的是 border box」，而这件事没有任何东西强制得了——调用方随手改成 `entry.contentRect
 * .width`（那是更眼熟的 ResizeObserver 写法），抖动回路就回来了，而 `tsc` / `check:css` /
 * 单测没有一个会红（happy-dom 没有布局引擎，量不出宽度）。
 *
 * 两处都显式写 border box:`{ box: 'border-box' }` 让**投递本身**按 border box 判有没有变
 * （默认的 content-box 观察会在滚动条进出时各推一次回调，而那正是我们要滤掉的东西）；
 * `borderBoxSize` 读的是观察阶段就算好的那个值，不像 `getBoundingClientRect()` 要另走一次脏
 * 检查，也不带 transform 缩放。`?.` 只是 `noUncheckedIndexedAccess` 要求的写法。
 */
export function observeDiffPanel(panel: HTMLElement): () => void {
  const observer = new ResizeObserver((entries) => {
    const size = entries[0]?.borderBoxSize[0];
    if (size !== undefined) diffPanelWidth.value = size.inlineSize;
  });
  observer.observe(panel, { box: 'border-box' });
  return () => observer.disconnect();
}
