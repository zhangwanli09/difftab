// 两棵树（变更列表的树视图、`Files` 那档的目录树）共用的行首：缩进量、目录行的展开三角、文件行
// 与它等宽的占位。
//
// 独立成文件而不是从其中一棵导出：`FileTree` 已经 import `ChangeList` 的 `CODE_COLORS`，反向
// import 会成环。**三样必须同住一处**：三角按 12 画、占位 `w-3`（= 12px）是同一个不变量，各写一
// 份时改其中一处不报错，只是另一棵树里文件名比同层的目录名往左挪一截；缩进量各写一个常量同样
// 不报错，只是切一次 tab 缩进跳一截。

import { ChevronRight } from 'lucide-preact';
import { Icon } from './Icon';

/** 每一层的缩进量（px）。用内联 style 按层级算——层数没有上界，而 Tailwind 只产出源码里出现过的类名。 */
const INDENT_PX = 12;

/** 一行（或一句占位文案）在第 `depth` 层的左内边距。**只此一份**，两处各写一遍会让占位与行错位。 */
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
