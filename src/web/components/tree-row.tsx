// 两棵树（变更列表的树视图、`Files` 那档的目录树）共用的一行：行的骨架、缩进量、目录行的展开
// 三角、文件行与它等宽的占位。
//
// 独立成文件而不是从其中一棵导出：`FileTree` 已经 import `ChangeList` 的 `CODE_COLORS`，反向
// import 会成环。**四样必须同住一处**：三角按 12 画、占位 `w-3`（= 12px）是同一个不变量，各写一
// 份时改其中一处不报错，只是另一棵树里文件名比同层的目录名往左挪一截；缩进量各写一个常量同样
// 不报错，只是切一次 tab 缩进跳一截；行骨架各写一份时同样不报错，只是切一次 tab 三角与名字的
// 间距跳一截。

import { ChevronRight } from 'lucide-preact';
import { Icon } from './Icon';

/**
 * 一行的骨架。**不给纵向内边距，字号与行高也不在这里**：行高（24px）由列表区那个 `<nav>` 的
 * `text-sm/6` 给、行靠 preflight 的 `font: inherit` 继承——一行里嵌着小一号的东西（目录段、状态字母、
 * 重命名标注都是 `text-xs`），line-height 定行高时它们共用同一个 24px 行盒；靠 `py-*` 凑时各段自带
 * 16 / 20 两种行高，基线要另行对齐。
 *
 * focus-visible 那两个类是键盘可达性的最低档：行是 <button>，而 preflight 清掉了 UA 默认焦点环，
 * 用 focus-border token 画，深浅都跟着翻。手型光标不在这里——那是所有按钮共有的一件事，
 * `styles/app.css` 里有一条 base 层规则统一给。
 *
 * **对齐方式与左内边距刻意不在这一串里**：文件行是「文件名 + 状态位」两段文字，按基线排；目录行
 * 是一枚 SVG 加一段文字，替换元素的基线是它的底边，按基线排三角会整个浮在文字上方，得
 * `items-center`——两种行各补自己那一个。左内边距一律由 `indent()` 给（见上）。
 */
export const ROW_BASE =
  'flex w-full gap-1.5 pr-3 text-left focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-border';

/** 每一层的缩进量（px）。用内联 style 按层级算——层数没有上界，而 Tailwind 只产出源码里出现过的类名。 */
const INDENT_PX = 12;

/**
 * 一行（或一句占位文案）在第 `depth` 层的左内边距。**只此一份**，两处各写一遍会让占位与行错位。
 * **平铺列表的行也走这里、取第 0 层**（= 12px，与侧栏别处的 `px-3` 同宽）：左内边距于是在三种视图
 * 里只有这一个来源，不必再给列表那档单独贴一个会被内联 style 盖掉的 `pl-*`。
 */
export const indent = (depth: number) => ({ paddingLeft: `${(depth + 1) * INDENT_PX}px` });

/**
 * 目录行的展开三角。展开时靠 `rotate-90` 转 90°，不另换一枚朝下的图标。**按 12 画**：它是行首的
 * 从属记号而不是内容，与文件名同高时会跟名字抢视线。
 */
export function ExpandChevron({ expanded }: { expanded: boolean }) {
  return <Icon icon={ChevronRight} size={12} class={`shrink-0 ${expanded ? 'rotate-90' : ''}`} />;
}

/** 文件行上与三角等宽的占位。少了它文件名会比同层的目录名往左挪一截，同一层看着像两层。 */
export function ChevronPlaceholder() {
  return <span class="w-3 shrink-0" />;
}
