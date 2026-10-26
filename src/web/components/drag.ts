// 拖 tab 的两处投放目标（组的正文、组的标签栏）用到的几条几何判据。

import type { SplitSide } from '../state/editors';

/**
 * `dragleave` 是不是真的离开了 `currentTarget`：指针进入子元素时它也会来，这时不该撤掉投放底色。
 */
export const leftTarget = (event: DragEvent): boolean =>
  !(event.currentTarget as Node).contains(event.relatedTarget as Node | null);

/** 指针落在 `el` 的右半边。 */
export function inRightHalf(event: DragEvent, el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return event.clientX > rect.left + rect.width / 2;
}

/**
 * 指针贴着 `el` 的哪条竖边：落在左右各 1/3 宽之内算贴边，中间那 1/3 回 null。中间留空照 VS Code：拖出
 * tab 后反悔、在本组正文上松手时什么都不该发生，左右两半都分屏时就没有这块地方。
 */
export function edgeOf(event: DragEvent, el: Element): SplitSide | null {
  const rect = el.getBoundingClientRect();
  if (event.clientX < rect.left + rect.width / 3) return 'left';
  if (event.clientX > rect.right - rect.width / 3) return 'right';
  return null;
}
