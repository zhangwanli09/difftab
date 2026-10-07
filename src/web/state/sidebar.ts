// 左栏宽度。与 `layout.ts` 同一类东西——页面自己的量，不是仓库状态，不进 `store.ts`。
//
// **不跨会话记忆**，与变更列表的版式开关同一个结论：后端端口随机，`localStorage` 按 origin
// 隔离，写了也只活到同一实例的刷新。

import { computed, signal } from '@preact/signals';

export const SIDEBAR_DEFAULT_WIDTH = 320;

/** 下限：tab 行两枚图标 + 右端按钮、顶栏符号 + 开关之后，名字还剩得下几个字。 */
export const SIDEBAR_MIN_WIDTH = 200;

/** 上限：笔记本屏上再宽，diff 面板就只剩行号槽了。 */
export const SIDEBAR_MAX_WIDTH = 640;

/** 无论左栏多宽，至少给 diff 面板留这么多。`<aside>` 是 `shrink-0`，不留时窄窗口里面板被挤到 0。 */
const PANEL_MIN_WIDTH = 320;

/**
 * 用户选的宽度，夹在静态上下界里。**随视口收的那道上限不在这里，在 `sidebarStyle` 的
 * `max-width` 上**：交给 CSS 时窗口缩窄再拉宽，左栏自己回到这个宽度，不必监听 `resize`、
 * 也不必把「选的」与「生效的」拆成两个量。代价是二者可能不等——要「屏幕上多宽」的地方
 * （拖动与键盘的起点）读 `shownSidebarWidth()`，不读这里。
 */
export const sidebarWidth = signal(SIDEBAR_DEFAULT_WIDTH);

export function setSidebarWidth(width: number): void {
  // 取整是为了让 `aria-valuenow` 是整数像素
  sidebarWidth.value = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

/**
 * `<aside>` 的内联样式，**以 signal 本身交给 `style`**：`@preact/signals` 直接改 DOM 属性，
 * 拖动时每个 pointermove 一个组件都不重渲染。写成 `style={{ width: sidebarWidth.value }}` 时读
 * 它的组件每次都重跑，而 `App` 里那一层是整棵树。`min-width` 压过 `max-width`（CSS 规定），
 * 于是视口窄到连下限都放不下时左栏仍是 200。
 *
 * 这条绑定是**异步落到 DOM 上的**（实测：写入之后同一个调用栈里属性还是旧值），所以别处不能靠量
 * `<aside>` 的 `offsetWidth` 拿刚写进去的宽度。
 */
export const sidebarStyle = computed(
  () =>
    `width:${sidebarWidth.value}px;min-width:${SIDEBAR_MIN_WIDTH}px;max-width:min(${SIDEBAR_MAX_WIDTH}px,calc(100vw - ${PANEL_MIN_WIDTH}px))`,
);

/**
 * 左栏此刻在屏幕上多宽——上面 `max-width` 那道式子在 JS 里的同一份。**拖动与键盘都从这里起算**：
 * 窄窗口里左栏被压在用户选的宽度之下，从选的那个算起时，前一段拖动 / 按键全落在看不见的区间里，
 * 把手一动不动。不量 DOM（绑定是异步的，连发的方向键会读到上一次之前的宽度），按需读一次
 * `innerWidth`、不挂 `resize` 监听。`100vw` 与 `innerWidth` 都含滚动条，两边对得上。
 */
export function shownSidebarWidth(): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(sidebarWidth.peek(), window.innerWidth - PANEL_MIN_WIDTH),
  );
}

/**
 * 哪一把把手正在拖（`x` 是左栏那把、`y` 是分区之间那把），`null` 即没在拖。把手拿它保持握把常亮
 * （capture 下指针会离开把手的盒子，单靠 `hover:` 那一刻就灭了）；`App` 拿 `dragStyle` 给整页挂光标
 * 与 `user-select: none`——不挂时指针一离开 4px 的把手光标就闪回箭头、沿途的 diff 文字被拖选成一片蓝。
 * 两把不会同时在拖，所以是一个三态 signal 而不是两个布尔。
 */
export const sashDragging = signal<'x' | 'y' | null>(null);

/**
 * 整页的拖动样式，**以 signal 本身交给 `style`**：`App` 不订阅它，一次拖动不必把整棵树重渲染两遍。
 * 光标写内联不写 `cursor-*` 类——那两条只有这里用，进产物就是两条新规则。
 */
export const dragStyle = computed(() => {
  const axis = sashDragging.value;
  return axis === null ? '' : `cursor:${axis === 'x' ? 'col' : 'row'}-resize;user-select:none`;
});

// ---- `Changes` 档里的两个分区（上 `Changes`、下 `History`）----

/** 两个分区各自折没折。默认都展开：打开页面时两样都该一眼看得见。 */
export const changesCollapsed = signal(false);
export const historyCollapsed = signal(false);

export const PANE_DEFAULT_PERCENT = 50;
/** 上面那块占可用高度的百分比的上下界：再往外，另一块就只剩标题加一两行。 */
export const PANE_MIN_PERCENT = 15;
export const PANE_MAX_PERCENT = 85;

/**
 * 两块都展开时上面那块占多少（百分比）。**存比例不存像素**：窗口拉高拉矮时两块一起伸缩，不必监听
 * `resize`，也不会出现「上面那块比整列还高」。单位就是百分比：`flex-basis` 与 `aria-valuenow`
 * 直接用它，不必各自换算。
 */
export const panePercent = signal(PANE_DEFAULT_PERCENT);

export function setPanePercent(percent: number): void {
  // 取到一位小数：拖动要细（1% 在高屏上是七八个像素），读屏念出来的又不该是一长串小数
  panePercent.value =
    Math.round(Math.min(PANE_MAX_PERCENT, Math.max(PANE_MIN_PERCENT, percent)) * 10) / 10;
}

/** 上面那块的内联样式，同 `sidebarStyle` 以 signal 本身交给 `style`：拖动时一个组件都不重渲染。 */
export const paneStyle = computed(() => `flex:0 0 ${panePercent.value}%`);
