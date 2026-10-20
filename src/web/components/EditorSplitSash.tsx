// 分屏时两组编辑器之间那条拖拽把手。挂在 `App` 里两组之间那个零宽的 `relative` 槽里、叠在左组的
// `border-r` 上——不挂进左组：挂进去时左组的 `pointerdown` / `focusin` 会把「拖把手」当成「要在左组里
// 操作」，焦点组跟着跳。机制在 `Sash` 里，这里只给轴向与单位（百分比）。

import {
  SPLIT_DEFAULT_PERCENT,
  SPLIT_MAX_PERCENT,
  SPLIT_MIN_PERCENT,
  setSplitPercent,
  splitPercent,
} from '../state/sidebar';
import { percentOfGrandparent, Sash } from './Sash';

/** 方向键一次走几个百分点。 */
const KEY_STEP = 2;

const currentPercent = () => splitPercent.peek();

/** 一像素合多少个百分点：量的是右侧面板的宽度（把手 → 槽 → 面板）。 */
const percentPerPx = percentOfGrandparent('x');

export function EditorSplitSash() {
  return (
    <Sash
      name="split"
      axis="x"
      label="Resize editor groups"
      value={splitPercent}
      min={SPLIT_MIN_PERCENT}
      max={SPLIT_MAX_PERCENT}
      step={KEY_STEP}
      initial={SPLIT_DEFAULT_PERCENT}
      current={currentPercent}
      unitsPerPx={percentPerPx}
      set={setSplitPercent}
    />
  );
}
