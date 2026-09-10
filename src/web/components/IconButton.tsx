// 侧栏里那种「只画一枚图标」的按钮的外壳。
//
// 存在的理由与 `Badge` 一模一样：顶栏那个明暗开关与 tab 行右端那枚「全部折叠」原本是两段逐字
// 相同的 JSX——圆角、内边距、次要色、悬停底色、焦点环，改其中一处不会报错、也不会画错，只是
// 两枚本该落在同一条竖线上的图标从此高矮不一或深浅不同，而这种偏差没有任何用例看得见。
//
// **`label` 一并收进来，因为它不是外观**：只画图标时 `aria-label` 是这个按钮名字的唯一来源，
// `title` 再给一份 tooltip，两者必须同时给、且给同一个词。摊成两个可选属性时漏掉一个不报错，
// 页面上也什么都看不出来，只有读屏里多出一个无名控件——收成一个必填参数，编译器就管住了。
//
// 只抽外观与命名，不抽语义：画哪一枚、点了做什么，仍归调用方。

import type { LucideIcon } from 'lucide-preact';
import { Icon } from './Icon';

export function IconButton({
  icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  /** 同时用作 tooltip 与无障碍名。 */
  label: string;
  onClick: () => void;
}) {
  // preflight 清掉了 UA 默认焦点环，键盘可达性得自己画回来。用的 token 与变更列表那行
  // （ChangeList 的 ROW_CLASS）是同一个，但**不带它那个 -outline-offset-2**：列表项是通栏的、
  // 环画在里侧才不被邻行盖住，而这几枚按钮四周有空隙，环画在外面
  return (
    <button
      type="button"
      onClick={onClick}
      class="shrink-0 rounded-sm p-0.5 text-description-foreground hover:bg-list-hover-background focus-visible:outline-2 focus-visible:outline-focus-border"
      title={label}
      aria-label={label}
    >
      <Icon icon={icon} />
    </button>
  );
}
