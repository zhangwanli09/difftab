// 顶栏那个明暗开关。点一下走一档：跟随系统 → 亮 → 暗 → 跟随系统。档位与持久化在
// `state/theme.ts`，本文件只负责「画成什么样、点了调谁」。
//
// **只画图标不写字**：侧栏 320px，那三个词（`Follow system` 之类）会跟项目名抢宽度，而抢输的
// 一定是项目名——它才是这一栏存在的理由。文字落在 title / aria-label 上。

import { type LucideIcon, Monitor, Moon, Sun } from 'lucide-preact';
import { cycleTheme, type ThemePreference, themePreference } from '../state/theme';
import { IconButton } from './IconButton';

/**
 * 三档各自的文案与图标。**合成一份而不是两个并列的 `Record`**：键集合相同、每次都按同一个
 * `preference` 一起查，拆成两处等于让「三档对应什么」这一份知识在两个地方各维护一遍——写法
 * 与 `App.tsx` 的 `TABS` 一致。
 *
 * 文案同时用作 tooltip 与无障碍名，说的是**当前处在哪一档**而不是「点了会变成什么」：这个按钮
 * 的第一职责是回答「现在跟不跟系统」。三枚图标都不写颜色——lucide 的 stroke 默认是
 * `currentColor`，而按钮自己的文字色由 token 给，于是图标跟着深浅翻。
 */
const MODES: Record<ThemePreference, { label: string; icon: LucideIcon }> = {
  system: { label: 'Follow system', icon: Monitor },
  light: { label: 'Light', icon: Sun },
  dark: { label: 'Dark', icon: Moon },
};

export function ThemeToggle() {
  // 直接在组件体里读，**不学变更列表那行包 computed 传 prop**——那条优化的理由是「换选中时
  // 320 行里 318 行产出逐字相同的 vnode」（有实测数据），而这里是一个按钮、一枚图标
  const { label, icon } = MODES[themePreference.value];
  return <IconButton icon={icon} label={label} onClick={cycleTheme} />;
}
