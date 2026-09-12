// 品牌符号：直角的标签页剪影里一短一长两行。几何在 `brand/geometry.mjs`，与 `scripts/logo.mjs`
// 共用同一份。
//
// 由 lucide-preact 的 `createLucideIcon` 造出来，于是它与 `GitBranch` 那些是同一个类型、走同一个
// `Icon` 外壳，`size` / `aria-hidden` 不必另写一份。

import { createLucideIcon } from 'lucide-preact';
import { MARK } from '../brand/geometry.mjs';

export const DifftabMark = createLucideIcon('difftab-mark', MARK);
