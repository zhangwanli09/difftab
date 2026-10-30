// 「后端还在不在」这一个状态。
//
// 回环上取数失败在网络层（`fetch` 本身 reject）只有一个原因：进程不在了。这个原因只由左栏
// 错误条讲一次，别处的原因槽位只留 `DISCONNECTED` 这个短标签——浏览器原话三家各一种，原样
// 摆出来时同一屏六处各说一遍，哪一处都没说出原因。
//
// 单独成文件是因为用它的有三方（`http.ts` 改写原因、`events.ts` 写断线态、组件读它），放进
// 前两者任一方都会多出一条不自然的 import。

import { signal } from '@preact/signals';

/** 各处原因槽位用的短标签。标签式片段，不加句点。 */
export const DISCONNECTED = 'Disconnected';

/**
 * 错误条上那一句。**不说「刷新 / 重试」**：端口由内核随机分配，旧标签页永远敲不到新实例，
 * 刷新只会换来浏览器的错误页。
 */
export const DISCONNECTED_NOTICE =
  'difftab has stopped. Run difftab again in the terminal to reopen this repository.';

/** 只由 SSE 写：`error` 置真、`open` 置回。取数失败只改写原因，不碰它。 */
export const disconnected = signal(false);
