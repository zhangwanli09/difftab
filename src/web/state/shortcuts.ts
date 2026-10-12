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

/** 按钮 `title` 里写的那一串：`⌘P` 或 `Ctrl+P`。 */
export function shortcutLabel(key: string, { shift = false } = {}): string {
  return IS_MAC ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

/**
 * 命中即 `preventDefault`：`⌘P` 拦下的是浏览器打印，这个页面没有要打印的东西。带 `Alt` 的不认
 * ——那是另一组组合键。
 */
export function handleGlobalKey(event: KeyboardEvent, mac = IS_MAC): void {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'p' && !event.shiftKey) {
    event.preventDefault();
    quickOpenVisible.value = true;
  } else if (key === 'f' && event.shiftKey) {
    event.preventDefault();
    // Quick Open 开着时一并关掉：焦点要去搜索框，留着它就是一层盖在页面上、键盘却已不在里面的浮层
    quickOpenVisible.value = false;
    activeTab.value = 'search';
    focusSearch();
  }
}
