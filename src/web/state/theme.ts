// 明暗主题的偏好档位。与 `title.ts` 同一类东西:自己持有一个 signal,再把它接到 document
// 上 —— 它既不是仓库状态(不进 `store.ts`)、也不是组件树的产出(`<html>` 上那个属性不该跟
// 着某个组件的生命周期走)。
//
// CSS 那侧只有三条 `color-scheme` 规则,所有取值都是 `light-dark(浅, 深)` 的单条声明。
// **本文件唯一要做的就是维护 <html> 上那个属性**。

import { effect, signal } from '@preact/signals';

/**
 * 三档。`'system'` 是缺省,也是加这个开关之前的全部行为。**不做成两档**:两档开关一旦点过就
 * 再也回不到「跟随系统」,而系统在日夜之间切换时页面不再跟 —— 那恰恰是从前唯一的行为。
 */
export type ThemePreference = 'system' | 'light' | 'dark';

/**
 * 点一下走到下一档。回到 `'system'` 是这个环闭合的地方,不是「重置」。写成一张表而不是「数组
 * + 取模」:后者要为 `indexOf` 落空补一个**永远走不到**的兜底分支。这张表还让「加第四档」
 * 变成编译错误 —— 少填一格 `Record` 就不完整。
 */
const NEXT: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

/**
 * `localStorage` 的键。仓库里**第一份跨会话的用户偏好**,加第二份之前先想清楚它
 * 是不是也该走同一套(读写各自 try/catch、脏值退回缺省)。
 */
const STORAGE_KEY = 'difftab:theme';

/**
 * 存的只有 `'light'` / `'dark'` 两个值 —— **`'system'` 是「这一项不存在」**。不写 `"system"`:
 * 那样等于给「跟随」也造一个取值,于是 CSS 那侧要多一条规则、这里要多一个合法值,而它们表达
 * 的是同一件事(什么都不覆写)。
 */
const isStored = (value: string | null): value is 'light' | 'dark' =>
  value === 'light' || value === 'dark';

/**
 * 读回上次的选择。**读本身就要 try/catch** —— Safari 隐私模式下光是取值就抛,而那时页面还没
 * 画,抛出去就是整页白屏。脏值(别的版本写的、被人手改的)一律当作「跟随系统」,不修也不清:
 * 清掉是一次写,而这条路径上我们对存储的唯一诉求是「别让它把页面搞坏」。
 */
function readStored(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isStored(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/**
 * 当前档位。初值是缺省档 —— **上次的选择由 `syncDocumentTheme()` 灌进来**,不在这里读。读放
 * 在接线口里而不是模块顶层,是为了让本模块的 import 期干净;反过来写的代价是模块的初值取决于
 * 谁先 import 它,而测试为此要对每条用例 `vi.resetModules()` + 动态 import。
 */
export const themePreference = signal<ThemePreference>('system');

/** 走到下一档:system → light → dark → system。 */
export function cycleTheme(): void {
  themePreference.value = NEXT[themePreference.value];
}

/**
 * 把档位接到 `<html>` 的 `data-theme` 上并落盘,返回取消订阅的函数。**属性与持久化同住一个
 * effect**:它们是同一次状态变更的两半,拆开会出现「切了但没记住」,而那件事只在刷新之后才看
 * 得见。写也要 try/catch,理由同 `readStored`;抛了就只在内存里生效。
 */
export function syncDocumentTheme(): () => void {
  // 存里已经是什么。用它挡住 effect **首次订阅那一跑**的无谓写。它还是「脏值不修也不清」那句
  // 话成立的前提 —— 没有这道 guard 时,脏值会让档位落到 `system`,首跑随即 `removeItem` 把它
  // 清掉,与 `readStored` 上面那段注释相反
  let persisted = readStored();
  themePreference.value = persisted;

  return effect(() => {
    const preference = themePreference.value;
    const root = document.documentElement;

    if (preference === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', preference);
    }

    if (preference === persisted) return;

    try {
      if (preference === 'system') {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, preference);
      }
      // **写成功之后**才记账:抛了就保持原值,下一次切换会再试一遍
      persisted = preference;
    } catch {
      // 存不下就只在这一次会话里生效
    }
  });
}
