// 带「按下」这一态的图标切换钮：搜索框里那两枚（`Match Case` / `Match Whole Word`）与编辑器动作区
// 那枚 `Hide whitespace changes`。
//
// **`aria-pressed` 表态**，按下时垫选中底色并描一圈焦点色边（照 VS Code 的 inputOption）；边是常驻
// 的透明边、按下时只换颜色，按下前后宽度不跳。`p-px` 加 1px 边与 `IconButton` 的 `p-0.5` 占地相同，
// 两种按钮并排时一样大。不复用 `IconButton`：那枚没有「按下」这一态，为一处加一个可选开关就是又一个
// 不填也不报错的参数。`mr-0.5` 是它与右边邻居（另一枚切换钮、或版式按钮）之间的那道缝。

import type { LucideIcon } from 'lucide-preact';
import { Icon } from './Icon';

export function Toggle({
  icon,
  label,
  pressed,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      class={`mr-0.5 shrink-0 rounded-sm border p-px focus-visible:outline-2 focus-visible:outline-focus-border ${
        pressed
          ? 'border-focus-border bg-list-active-selection-background text-editor-foreground'
          : 'border-transparent text-description-foreground hover:bg-toolbar-hover-background'
      }`}
    >
      <Icon icon={icon} />
    </button>
  );
}
