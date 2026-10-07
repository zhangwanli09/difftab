// 左栏右边缘那条拖拽把手。绝对定位叠在 `<aside>` 的 `border-r` 上；机制在 `Sash` 里，这里只给轴向
// 与单位（像素）。

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  setSidebarWidth,
  shownSidebarWidth,
  sidebarWidth,
} from '../state/sidebar';
import { Sash } from './Sash';

/** 方向键一次走多少像素。 */
const KEY_STEP = 16;

const onePx = () => 1;

export function SidebarSash() {
  return (
    <Sash
      axis="x"
      label="Resize sidebar"
      value={sidebarWidth}
      min={SIDEBAR_MIN_WIDTH}
      max={SIDEBAR_MAX_WIDTH}
      step={KEY_STEP}
      initial={SIDEBAR_DEFAULT_WIDTH}
      // 从屏幕上的宽度起算：窄窗口里左栏被压在用户选的宽度之下，从选的那个算起时前一段拖动 /
      // 按键全落在看不见的区间里，把手一动不动
      current={shownSidebarWidth}
      unitsPerPx={onePx}
      set={setSidebarWidth}
    />
  );
}
