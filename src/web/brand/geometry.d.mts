// `geometry.mjs` 的类型声明——前端 tsconfig 不开 allowJs，strict 下 import 无声明的 .mjs 报
// implicit any。形状与那边逐字对应。

import type { IconNode } from 'lucide-preact';

export const MARK: IconNode;
