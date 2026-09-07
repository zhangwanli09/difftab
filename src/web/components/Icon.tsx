// 界面上那几枚图标的**外壳**。
//
// 存在的理由与 `Badge` 一模一样：`size` 与 `aria-hidden` 原本在六处各写一遍——漏掉其中一处
// 不会报错、也不会画错，只是那一枚比旁边的大一圈（lucide 的默认尺寸是 24），或者被读屏多读
// 一遍，而这两种偏差没有任何用例看得见。
//
// 图形取自 **Lucide**（ISC，Copyright Lucide Contributors），署名就落在这里，照
// `styles/hljs-theme.css` 顶部记 hljs 主题来源的同一种做法，不另建 NOTICE 文件——已经打进
// 产物的 diff2html 与 highlight.js 也是这么处理的。
//
// 只抽外壳，不抽语义：画哪一枚由调用方传组件进来。**传组件而不是传 path 字符串**是这套图标
// 相对上一套的实质增强：状态条与侧栏 `Changes` 那个 tab 画的是同一枚 `GitBranch`，两处
// import 同一个具名标识符，拼错是编译错误；而上一套共用的是一条导出的 path 字符串，两份漂开
// 时同一个概念在页面上长成两个图形，没有任何东西会响。

import type { LucideIcon } from 'lucide-preact';

export function Icon({
  icon: Glyph,
  size = 16,
  class: className,
}: {
  icon: LucideIcon;
  /** 渲染尺寸（px）。默认 16，只有文件树那枚展开三角按 12 画。 */
  size?: number;
  class?: string;
}) {
  // aria-hidden：图标要么是旁边文字的装饰，要么名字已经由按钮的 aria-label 给了，
  // 报出来只是让同一个东西被读两次。**lucide 自己在「无 children 且没传任何 a11y prop」时也会
  // 加这一条，这里仍然显式写**：那是它的隐式默认，改掉不会惊动我们，而症状是读屏把每一枚图标
  // 都念一遍——页面上什么都看不出来，也没有任何门禁会响。一个属性换掉这份依赖，便宜。
  //
  // 颜色不在这里写：lucide 的 stroke 默认就是 `currentColor`，于是图标跟着所在处的文字色翻深浅
  return <Glyph size={size} aria-hidden="true" class={className} />;
}
