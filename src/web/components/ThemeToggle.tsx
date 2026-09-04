// 顶栏那个明暗开关。点一下走一档：跟随系统 → 亮 → 暗 → 跟随系统。档位与持久化在
// `state/theme.ts`，本文件只负责「画成什么样、点了调谁」。
//
// **只画图标不写字**：侧栏 320px，那三个词（`Follow system` 之类）会跟项目名抢宽度，而抢输的
// 一定是项目名——它才是这一栏存在的理由。文字落在 title / aria-label 上。

import { cycleTheme, type ThemePreference, themePreference } from '../state/theme';

/**
 * 三档各一句英文，同时用作 tooltip 与无障碍名。说的是**当前处在哪一档**而不是「点了会变成
 * 什么」：这个按钮的第一职责是回答「现在跟不跟系统」。
 */
const LABELS: Record<ThemePreference, string> = {
  system: 'Follow system',
  light: 'Light',
  dark: 'Dark',
};

// 三个图标各画一档：显示器 / 太阳 / 月亮。图形取自 **Heroicons v2 的 24/outline**
// (`computer-desktop` / `sun` / `moon`,MIT,Copyright Tailwind Labs)——署名就落在这里，照
// `styles/hljs-theme.css` 顶部记 hljs 主题来源的同一种做法，不另建 NOTICE 文件。
//
// **复制 path 数据而不装包**：包里是逐图标的组件或 SVG 文件，而这里要的只是下面三条字符串。
// 一律 `currentColor` + `stroke`：按钮自己的文字色由 token 给，于是图标跟着深浅翻。
const ICON_PATHS: Record<ThemePreference, string> = {
  system:
    'M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25',
  light:
    'M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z',
  dark: 'M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z',
};

// preflight 清掉了 UA 默认焦点环，键盘可达性得自己画回来。用的 token 与变更列表那行
// （ChangeList 的 ROW_CLASS）是同一个，但**不带它那个 -outline-offset-2**：列表项是通栏的、
// 环画在里侧才不被邻行盖住，而这个按钮四周有空隙，环画在外面
const BUTTON_CLASS =
  'shrink-0 rounded-sm p-0.5 text-description-foreground hover:bg-list-hover-background focus-visible:outline-2 focus-visible:outline-focus-border';

export function ThemeToggle() {
  // 直接在组件体里读，**不学变更列表那行包 computed 传 prop**——那条优化的理由是「换选中时
  // 320 行里 318 行产出逐字相同的 vnode」（有实测数据），而这里是一个按钮、一条 path
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
      {/* aria-hidden：名字已经由 aria-label 给了，图标再报一遍就是同一个按钮读两次 */}
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d={ICON_PATHS[preference]} />
      </svg>
    </button>
  );
}
