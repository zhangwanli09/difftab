// header 里那种「一句话状态标签」的外观(spec §5.6)。
//
// 存在的理由只有一个:`WatchBadge`(轮询刷新)与 `BranchStatus` 的 `Operation`
// (变基中 / 合并中 / …)**并排画在同一行**里,而它们的圆角、内边距、字号原本是
// 两份逐字相同的类名串。改其中一处不会报错、也不会画错,只是两个挨着的标签从此
// 高矮不一 —— 而这种偏差没有任何用例看得见。
//
// 只抽外观,不抽语义:每个标签自己决定文案、tooltip 与颜色 token(`tone`),
// 「什么时候画」也各归各家(两者都是「没事发生时一个字都不画」)。

import type { ComponentChildren } from 'preact';

export function Badge({
  tone,
  title,
  children,
}: {
  /** 文字颜色的 token 类名,如 `text-git-conflicting`。 */
  tone: string;
  title: string;
  children: ComponentChildren;
}) {
  return (
    <span
      class={`shrink-0 rounded-sm bg-warning-background px-1.5 py-0.5 text-xs ${tone}`}
      title={title}
    >
      {children}
    </span>
  );
}
