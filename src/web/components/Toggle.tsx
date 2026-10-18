// 带「按下」这一态的图标切换钮：搜索框里那两枚（`Match Case` / `Match Whole Word`）与编辑器动作区
// 那枚 `Hide whitespace changes`。
//
// **`aria-pressed` 表态**，按下时只垫选中底色、不描边：焦点色那一档留给键盘焦点的 outline，若按下
// 态再描一圈同色边，鼠标点过的开关看上去就像一直被聚焦着。外壳取 `ICON_BUTTON_SHELL`，与
// `IconButton` 并排时一样大。不复用 `IconButton`：那枚没有「按下」这一态，为一处加一个可选开关
// 就是又一个不填也不报错的参数。`mr-0.5` 是它与右边邻居（另一枚切换钮、或版式按钮）之间的那道缝。

import type { LucideIcon } from 'lucide-preact';
import { Icon } from './Icon';
import { ICON_BUTTON_SHELL } from './IconButton';

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
      class={`mr-0.5 ${ICON_BUTTON_SHELL} ${
        pressed
          ? 'bg-list-active-selection-background text-editor-foreground'
          : 'text-description-foreground hover:bg-toolbar-hover-background'
      }`}
    >
      <Icon icon={icon} />
    </button>
  );
}
