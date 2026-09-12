// `geometry.mjs` 的类型声明——前端 tsconfig 不开 allowJs，strict 下 import 无声明的 .mjs 报
// implicit any。形状与那边逐字对应。

import type { IconNode } from 'lucide-preact';

export const MARK_FOOT_Y: number;
export const MARK: IconNode;
export const WORDMARK_BASELINE: number;
export const WORDMARK: {
  paths: string[];
  dot: { x: number; y: number; size: number };
  width: number;
};
export const WORDMARK_X: number;
export const MARK_BASELINE_SHIFT: number;
