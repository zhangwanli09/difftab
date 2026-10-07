// 左栏右边缘那条拖拽把手（VS Code 叫 sash）。绝对定位叠在 `<aside>` 的 `border-r` 上：不占布局
// 宽度、不替换那条边——做成第三个 flex 子项时它的 4px 会从面板身上扣，还得另画一条线。

import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  setSidebarWidth,
  shownSidebarWidth,
  sidebarDragging,
  sidebarWidth,
} from '../state/sidebar';

/** 方向键一次走多少像素。 */
const KEY_STEP = 16;

/**
 * **固定几何一律写内联样式、不写 Tailwind 类**：前端 CSS 贴着 `size` 门禁，而这几条只有把手
 * 用，每个类都是一条新规则；内联样式不进产物。会随状态变的（悬停、焦点）才用类，且挑的都是
 * 别处已经产出过的那几个。
 *
 * 外壳是整列高、4px 宽的透明命中区，跨在 aside 边缘两侧各 2px。`touch-action: none`：不带时
 * 触屏 / 手写笔一按下浏览器就把手势认作滚动、发 `pointercancel`，拖几个像素就断。
 */
const SASH_STYLE: JSX.CSSProperties = {
  right: '-2px',
  width: '4px',
  cursor: 'col-resize',
  touchAction: 'none',
};

/**
 * **显出来的只有这一小段握把**：竖直居中（绝对定位、上下为 0、高度定死时 `margin: auto` 就居中）、
 * 32px 高、3px 宽（命中区扣掉左边 1px）、圆头，压在 `border-r` 上。整条边变色比它标示的那条边
 * 还显眼，握把只说「这里能拖」。颜色取次要前景色——`focus-border` 留给键盘焦点那一档（外壳上
 * 的 outline）。**显隐走 opacity**：底色常驻、只渐变透明度，悬停时淡入；切 background 没有
 * 中间值可插。
 */
const GRIP_STYLE: JSX.CSSProperties = {
  left: '1px',
  right: 0,
  height: '32px',
  margin: 'auto 0',
  background: 'var(--color-description-foreground)',
  transition: 'opacity 200ms',
};

export function SidebarSash() {
  // 按下那一刻的指针 x 与宽度；`null` 即不在拖。宽度 = 起始宽度 + 位移，不是逐帧累加——累加时
  // 被夹住的那一段位移会丢掉，指针回头时把手不跟着指针走
  const drag = useRef<{ x: number; width: number } | null>(null);

  const end = () => {
    drag.current = null;
    sidebarDragging.value = false;
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> 不能获得焦点、也不接受指针拖动；可聚焦的 separator 只能这样写
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      // 传 signal 本身而不是 `.value`：属性由 `@preact/signals` 直接改（异步落地），拖动时本组件不重渲染
      aria-valuenow={sidebarWidth}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      class="group absolute inset-y-0 z-10 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-border"
      style={SASH_STYLE}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // capture 让指针越过 diff 面板、甚至离开窗口时 move 仍投给这里，不必往 document 上挂监听
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: shownSidebarWidth() };
        sidebarDragging.value = true;
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start !== null) setSidebarWidth(start.width + event.clientX - start.x);
      }}
      onPointerUp={end}
      // capture 被别的原因收走（窗口失焦、元素被移除）时 pointerup 不一定来；这条兜住收尾
      onLostPointerCapture={end}
      onDblClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={(event) => {
        const next = keyTarget(event.key, shownSidebarWidth());
        if (next === null) return;
        event.preventDefault();
        setSidebarWidth(next);
      }}
    >
      {/* 拖动中常亮：capture 下指针会离开把手的盒子，单靠 `group-hover:` 那一刻就灭了 */}
      <span
        class={`absolute inset-y-0 rounded-full ${sidebarDragging.value ? '' : 'opacity-0 group-hover:opacity-100'}`}
        style={GRIP_STYLE}
      />
    </div>
  );
}

/** 按键 → 目标宽度；不是这四个键时为 `null`，交给浏览器照常处理。 */
function keyTarget(key: string, width: number): number | null {
  switch (key) {
    case 'ArrowLeft':
      return width - KEY_STEP;
    case 'ArrowRight':
      return width + KEY_STEP;
    case 'Home':
      return SIDEBAR_MIN_WIDTH;
    case 'End':
      return SIDEBAR_MAX_WIDTH;
    default:
      return null;
  }
}
