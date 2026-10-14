// 全局快捷键，**只有两条**：`⌘P` / `Ctrl+P` 开 Quick Open，`⌘⇧F` / `Ctrl+Shift+F` 切到 `Search`
// 档并聚焦输入框。挂在 `document` 的 `keydown` 上（`App` 接线）。

import { quickOpenVisible } from './quick-open';
import { focusSearch } from './search';
import { activeTab } from './store';

/**
 * Mac 判 `metaKey`、其余判 `ctrlKey`，**不两个都认**：两个都认时会吃掉 macOS 输入框里 `Ctrl+P`
 * （光标上移一行）这条系统级 Emacs 键位。`navigator.platform` 已标弃用，但这里要的恰恰是它答的
 * 那件事（宿主是不是 Mac），`userAgentData` 只有 Chromium 有。
 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export interface Shortcut {
  label: string;
  key: string;
  shift?: boolean;
}

/**
 * 两条快捷键连同名字的**唯一一份清单**：`handleGlobalKey` 按它认键，按钮 `title` 与右侧空态的
 * 列表按它写字。各写一份时改了键，提示还写着旧的那个，不报错。
 */
export const SHORTCUTS = {
  goToFile: { label: 'Go to File', key: 'P' },
  search: { label: 'Search', key: 'F', shift: true },
} as const satisfies Record<string, Shortcut>;

/** 逐个按键：`['⇧', '⌘', 'F']` 或 `['Ctrl', 'Shift', 'F']`。空态里每个画成一枚 `<kbd>`。 */
export function shortcutKeys({ key, shift = false }: Shortcut, mac = IS_MAC): string[] {
  return mac ? [...(shift ? ['⇧'] : []), '⌘', key] : ['Ctrl', ...(shift ? ['Shift'] : []), key];
}

/**
 * tooltip 的格式 `Go to File (⌘P)` / `Go to File (Ctrl+P)`，图标按钮与侧栏 tab 共用这一处：各拼
 * 一份时改了括号或间距，两种 tooltip 从此长得不一样，不报错。
 */
export function withShortcut(label: string, shortcut?: Shortcut, mac = IS_MAC): string {
  if (shortcut === undefined) return label;
  return `${label} (${shortcutKeys(shortcut, mac).join(mac ? '' : '+')})`;
}

const matches = (event: KeyboardEvent, { key, shift = false }: Shortcut): boolean =>
  event.key.toLowerCase() === key.toLowerCase() && event.shiftKey === shift;

/**
 * 命中即 `preventDefault`：`⌘P` 拦下的是浏览器打印，这个页面没有要打印的东西。带 `Alt` 的不认
 * ——那是另一组组合键。
 */
export function handleGlobalKey(event: KeyboardEvent, mac = IS_MAC): void {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey) return;
  if (matches(event, SHORTCUTS.goToFile)) {
    event.preventDefault();
    quickOpenVisible.value = true;
  } else if (matches(event, SHORTCUTS.search)) {
    event.preventDefault();
    // Quick Open 开着时一并关掉：焦点要去搜索框，留着它就是一层盖在页面上、键盘却已不在里面的浮层
    quickOpenVisible.value = false;
    activeTab.value = 'search';
    focusSearch();
  }
}
