// 拖 tab 的两处投放目标（组的正文、组的标签栏）共用的两条几何判据。

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
