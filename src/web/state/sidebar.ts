// 左栏宽度。与 `layout.ts` 同一类东西——页面自己的量，不是仓库状态，不进 `store.ts`。
//
// **不跨会话记忆**，与变更列表的版式开关同一个结论：后端端口随机，`localStorage` 按 origin
// 隔离，写了也只活到同一实例的刷新。

import { computed, signal } from '@preact/signals';

export const SIDEBAR_DEFAULT_WIDTH = 320;

/** 下限：tab 行三枚图标 + 右端按钮、顶栏符号 + 开关之后，名字还剩得下几个字。 */
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
 * 正在拖。`App` 拿它给整页挂 `cursor-col-resize select-none`——不挂时指针一离开 4px 的把手光标
 * 就闪回箭头、沿途的 diff 文字被拖选成一片蓝；把手拿它保持握把常亮（capture 下指针会离开把手
 * 的盒子，单靠 `hover:` 那一刻就灭了）。一次拖动只翻两次，读它的组件重渲染两次无所谓。
 */
export const sidebarDragging = signal(false);
