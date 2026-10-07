// 拖拽把手（VS Code 叫 sash），左栏右边缘那把竖的与 `Changes` 档两个分区之间那把横的共用这一份。
// 绝对定位叠在一条既有的边框上：不占布局尺寸、不替换那条边——做成一个 flex 子项时它的 4px 会从
// 邻居身上扣，还得另画一条线。
//
// 两把之间不同的只有轴向与单位（左栏是像素、分区是百分比），由调用方给；pointer capture、收尾、
// 双击复位、键盘、握把这些容易写漏的机制只在这里写一次——两份副本时修了一把，另一把静默地坏着。

import type { ReadonlySignal } from '@preact/signals';
import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { sashDragging } from '../state/sidebar';

export type SashAxis = 'x' | 'y';

/**
 * **固定几何一律写内联样式、不写 Tailwind 类**：前端 CSS 贴着 `size` 门禁，而这几条只有把手
 * 用，每个类都是一条新规则；内联样式不进产物。会随状态变的（悬停、焦点）才用类，且挑的都是
 * 别处已经产出过的那几个。
 *
 * 外壳是贴着边框、4px 厚的透明命中区，跨在边框两侧各 2px。`touch-action: none`：不带时触屏 /
 * 手写笔一按下浏览器就把手势认作滚动、发 `pointercancel`，拖几个像素就断。
 */
const SHELL_STYLE: Record<SashAxis, JSX.CSSProperties> = {
  x: { top: 0, bottom: 0, right: '-2px', width: '4px', cursor: 'col-resize', touchAction: 'none' },
  y: { left: 0, right: 0, top: '-2px', height: '4px', cursor: 'row-resize', touchAction: 'none' },
};

/**
 * **显出来的只有这一小段握把**：沿边框居中（绝对定位、两端为 0、长度定死时 `margin: auto` 就居中）、
 * 32px 长、3px 厚（命中区扣掉远离边框那侧的 1px）、圆头，压在边框上。整条边变色比它标示的那条边
 * 还显眼，握把只说「这里能拖」。颜色取次要前景色——`focus-border` 留给键盘焦点那一档（外壳上
 * 的 outline）。**显隐走 opacity**：底色常驻、只渐变透明度，悬停时淡入；切 background 没有
 * 中间值可插。
 */
const GRIP_BASE: JSX.CSSProperties = {
  background: 'var(--color-description-foreground)',
  transition: 'opacity 200ms',
};
const GRIP_STYLE: Record<SashAxis, JSX.CSSProperties> = {
  x: { ...GRIP_BASE, top: 0, bottom: 0, left: '1px', right: 0, height: '32px', margin: 'auto 0' },
  y: { ...GRIP_BASE, left: 0, right: 0, top: '1px', bottom: 0, width: '32px', margin: '0 auto' },
};

/** 两个方向键各让取值减 / 增一步；`x` 轴是左右，`y` 轴是上下。 */
const KEYS: Record<SashAxis, readonly [string, string]> = {
  x: ['ArrowLeft', 'ArrowRight'],
  y: ['ArrowUp', 'ArrowDown'],
};

export function Sash({
  axis,
  label,
  value,
  min,
  max,
  step,
  initial,
  current,
  unitsPerPx,
  set,
}: {
  axis: SashAxis;
  label: string;
  /** `aria-valuenow`。**传 signal 本身**：属性由 `@preact/signals` 直接改（异步落地），拖动时本组件不重渲染 */
  value: ReadonlySignal<number>;
  min: number;
  max: number;
  /** 方向键一次走多少，单位同取值 */
  step: number;
  /** 双击复位到的值 */
  initial: number;
  /** 拖动与键盘的起点：**屏幕上此刻的**取值，不一定等于 `value`（左栏会被视口压住） */
  current: () => number;
  /** 一像素合多少单位，按下那一刻量一次（拖动途中不再量 DOM） */
  unitsPerPx: (el: HTMLElement) => number;
  set: (next: number) => void;
}) {
  // 按下那一刻的指针坐标、取值与换算比；`null` 即不在拖。取值 = 起始值 + 位移 × 换算比，不是逐帧
  // 累加——累加时被夹住的那一段位移会丢掉，指针回头时把手不跟着指针走
  const drag = useRef<{ at: number; value: number; scale: number } | null>(null);
  const coordinate = (event: PointerEvent) => (axis === 'x' ? event.clientX : event.clientY);

  const end = () => {
    drag.current = null;
    sashDragging.value = null;
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> 不能获得焦点、也不接受指针拖动；可聚焦的 separator 只能这样写
    <div
      role="separator"
      // ARIA 的方向说的是分隔线本身：左栏那条线是竖的
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      class="group absolute z-10 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-border"
      style={SHELL_STYLE[axis]}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // capture 让指针越过邻居、甚至离开窗口时 move 仍投给这里，不必往 document 上挂监听
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          at: coordinate(event),
          value: current(),
          scale: unitsPerPx(event.currentTarget),
        };
        sashDragging.value = axis;
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        // 换算比不是有限数（容器还没排版、高度为 0）时无从换算，不动
        if (start === null || !Number.isFinite(start.scale)) return;
        set(start.value + (coordinate(event) - start.at) * start.scale);
      }}
      onPointerUp={end}
      // capture 被别的原因收走（窗口失焦、元素被移除）时 pointerup 不一定来；这条兜住收尾
      onLostPointerCapture={end}
      onDblClick={() => set(initial)}
      onKeyDown={(event) => {
        const [less, more] = KEYS[axis];
        const next =
          event.key === less
            ? current() - step
            : event.key === more
              ? current() + step
              : event.key === 'Home'
                ? min
                : event.key === 'End'
                  ? max
                  : null;
        // 不是这四个键时交给浏览器照常处理
        if (next === null) return;
        event.preventDefault();
        set(next);
      }}
    >
      {/* 拖动中常亮：capture 下指针会离开把手的盒子，单靠 `group-hover:` 那一刻就灭了 */}
      <span
        class={`absolute rounded-full ${sashDragging.value === axis ? '' : 'opacity-0 group-hover:opacity-100'}`}
        style={GRIP_STYLE[axis]}
      />
    </div>
  );
}
