// 顶栏那个明暗开关。点一下走一档:跟随系统 → 亮 → 暗 → 跟随系统。
//
// 档位与持久化在 `state/theme.ts`,CSS 那侧的三条 `color-scheme` 规则在
// `styles/vscode-theme.css` —— 本文件只负责「画成什么样、点了调谁」。
//
// **只画图标不写字**:侧栏 320px,那三个词(`Follow system` 之类)会跟项目名抢宽度,
// 而抢输的一定是项目名 —— 它才是这一栏存在的理由。文字落在 title / aria-label 上。

import { cycleTheme, type ThemePreference, themePreference } from '../state/theme';

/**
 * 三档各一句英文,同时用作 tooltip 与无障碍名。
 *
 * 说的是**当前处在哪一档**而不是「点了会变成什么」:这个按钮的第一职责是回答
 * 「现在跟不跟系统」,而三档循环里「下一档是什么」只要看一眼图标就知道。
 */
const LABELS: Record<ThemePreference, string> = {
  system: 'Theme: follow system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

// 三个图标各画一档:显示器 / 太阳 / 月亮。内联 SVG 而不是图标库 —— 为三个 16px 的
// 形状引一套资源要顶产物体积门禁,而这三个各自只有一两条路径。
//
// 一律 `currentColor` + `stroke`:按钮自己的文字色由 token 给,于是图标跟着深浅翻,
// 不必在这里再写一遍配色(也就没有「加了浅色忘了深色」那一半)。
const ICON_PATHS: Record<ThemePreference, string> = {
  system: 'M3 5.5h14v8H3z M7.5 17h5 M10 13.5V17',
  light:
    'M10 6.25a3.75 3.75 0 100 7.5 3.75 3.75 0 000-7.5z M10 2v2 M10 16v2 M2 10h2 M16 10h2 M4.2 4.2l1.4 1.4 M14.4 14.4l1.4 1.4 M15.8 4.2l-1.4 1.4 M5.6 14.4l-1.4 1.4',
  dark: 'M16 11.7A6.5 6.5 0 018.3 4a6.5 6.5 0 107.7 7.7z',
};

// preflight 清掉了 UA 默认焦点环,键盘可达性得自己画回来。用的 token 与变更列表那行
// (ChangeList 的 ROW_CLASS)是同一个,但**不带它那个 -outline-offset-2**:列表项是通栏的、
// 环画在里侧才不被邻行盖住,而这个按钮四周有空隙,环画在外面
const BUTTON_CLASS =
  'shrink-0 rounded-sm p-0.5 text-description-foreground hover:bg-list-hover-background focus-visible:outline-2 focus-visible:outline-focus-border';

export function ThemeToggle() {
  // 直接在组件体里读,**不学变更列表那行包 computed 传 prop** —— 那条优化的理由是
  // 「换选中时 320 行里 318 行产出逐字相同的 vnode」(有实测数据),而这里是一个按钮、
  // 一条 path,只在用户点击时重渲一次。照抄过来是把一条有实测支撑的局部优化
  // 当成了无差别的组件写法
  const preference = themePreference.value;
  const label = LABELS[preference];
  return (
    <button
      type="button"
      onClick={cycleTheme}
      class={BUTTON_CLASS}
      title={label}
      aria-label={label}
    >
      {/* aria-hidden:名字已经由 aria-label 给了,图标再报一遍就是同一个按钮读两次 */}
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d={ICON_PATHS[preference]} />
      </svg>
    </button>
  );
}
