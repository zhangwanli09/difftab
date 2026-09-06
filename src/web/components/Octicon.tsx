// Octicons 那套 16px 图标的**外壳**。
//
// 存在的理由与 `Badge` 一模一样：状态条那枚分支图标与侧栏 `Changes` 那个 tab 画的是同一枚
// `git-branch-16`，两处的 `viewBox` / 尺寸 / `fill` 原本是两份逐字相同的 JSX——改其中一处不会
// 报错、也不会画错，只是同一个概念从此在两个地方长得不一样，而两处的用例都只查 `<svg>` 在不在。
//
// 只抽外壳，不抽语义：画哪一条 path、要不要额外的类名，各归各家。`ThemeToggle` 不走这里——那三
// 枚是 Heroicons 的 24 + stroke，与这套 16 + fill 是两种版式，凑到一个组件里就得开分支。

export function Octicon({ path, class: className }: { path: string; class?: string }) {
  return (
    // aria-hidden：图标要么是旁边文字的装饰，要么名字已经由按钮的 aria-label 给了，
    // 报出来只是让同一个东西被读两次。fill="currentColor" 让它跟着所在处的文字色翻深浅
    <svg
      aria-hidden="true"
      class={className}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
    >
      <path d={path} />
    </svg>
  );
}
