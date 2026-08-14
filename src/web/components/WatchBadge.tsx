// 监听降级标注(spec §5.7 / §5.12 的 `WatchState`)。
//
// §6 有三条验收项写着「UI 明确标注降级模式」。降级有两个来源 —— C 档的既定形态
// (Node < 24.14 × Linux,不建递归 watch)与 A / B 档运行中落到轮询兜底(ENOSPC /
// 网络盘 / Docker 卷)—— **前端一律不区分**:后端给的 `mode` 就是判据,而「C 档 =
// 既定形态、A/B + polling = 出过错」这个映射是监听知识,写进前端就是 §5.0 不变式 4
// 说的第二份实现(而第二份不受任何门禁覆盖)。
//
// 文案上因此也不说原因,只说**当前的行为**:刷新靠定时轮询、可能慢一两秒。这是
// 用户唯一需要据以调整预期的事实。

import type { WatchState } from '../../server/shared/protocol';
import { Badge } from './Badge';

export function WatchBadge({ watch }: { watch: WatchState }) {
  /**
   * 原生监听时**什么都不画**(§5.7 三档表里 A / B 的「UI 标注」列就是「无」)。
   *
   * 反过来写(常驻一个标签,原生时写「实时」)会让常态多出一块永远正确、因此永远
   * 不被读的字 —— 而降级那一次就淹在里面了。
   */
  if (watch.mode !== 'polling') return null;
  return (
    <Badge
      tone="text-description-foreground"
      title="未使用原生文件监听,工作区改动靠定时轮询发现,可能慢一两秒"
    >
      轮询刷新
    </Badge>
  );
}
