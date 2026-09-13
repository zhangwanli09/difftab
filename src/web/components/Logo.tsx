// 品牌符号：一段 diff hunk——上下文、删除、新增三条色条。红绿是固定的品牌色，上下文那条跟
// `currentColor`。几何在 `brand/geometry.mjs`，与 `scripts/logo.mjs` 共用同一份。
//
// 由 lucide-preact 的 `createLucideIcon` 造出来，于是它与 `GitBranch` 那些是同一个类型、走同一个
// `Icon` 外壳，`size` / `aria-hidden` 不必另写一份。

import { createLucideIcon } from 'lucide-preact';
import { MARK } from '../brand/geometry.mjs';

export const DifftabMark = createLucideIcon('difftab-mark', MARK);
