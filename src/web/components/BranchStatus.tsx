// 分支状态(spec §5.12 的 `BranchState` / §6「变更列表与分支状态」)。
//
// 本文件只有一条真正的判据:**`upstream === null` 是「无上游」,不是 0/0**。
// 无上游的分支根本不输出 `# branch.ab` 行(已实测,§5.2),而最省事的写法
// (`upstream?.ahead ?? 0`)会把「没有可比对象」画成「与上游同步」——不报错、
// 不缺字段,只是说了一句假话,§6 因此把它单列成一条验收项。类型里 `upstream` 是
// `null | { … }` 正是为了让这条分支无法被漏掉(§5.12),这里顺着它写就够了。
//
// TODO(S4b):detached 时 `head` 是 git 给的字面量 `(detached)`,`operation`(rebase /
// merge 进行中)后端当前恒不填充。两者的降级标注归 §5.3 / S4b,不在本阶段就地扩展。

import type { BranchState } from '../../server/shared/protocol';

/** 为 0 的那个减淡。模块作用域:S3b1 起每个 SSE 事件都会重画这里(同 `ChangeList` 的 `CODE_*`)。 */
const dim = (n: number) => (n === 0 ? 'text-description-foreground' : '');

/**
 * ahead / behind。
 *
 * **两个数一律都画出来,包括 0** —— 验收口径是「与 `git status` 结果一致」,而
 * `# branch.ab +0 -0` 本身就是 git 对「有上游且已同步」的表述。为 0 的那个只减淡,
 * 不隐藏:隐藏之后「已同步」与「无上游」在页面上又变成同一个样子,而把这两者
 * 分开正是本组件存在的理由。
 */
function Upstream({ upstream }: { upstream: BranchState['upstream'] }) {
  if (upstream === null) {
    return (
      <span class="text-description-foreground" title="当前分支没有设置上游分支">
        无上游
      </span>
    );
  }
  // 两个数直接做父级 flex 行的子项,不包一层 wrapper:包一层就要把父级的
  // `flex items-baseline gap-2` 抄一遍,而以后改父级的 gap 时,「名字↔箭头」与
  // 「↑↔↓」两处间距会静默分家
  return (
    <>
      <span class={`font-mono ${dim(upstream.ahead)}`} title={`领先上游 ${upstream.ahead} 个提交`}>
        ↑{upstream.ahead}
      </span>
      <span
        class={`font-mono ${dim(upstream.behind)}`}
        title={`落后上游 ${upstream.behind} 个提交`}
      >
        ↓{upstream.behind}
      </span>
    </>
  );
}

export function BranchStatus({ branch }: { branch: BranchState }) {
  // `head` 为空只可能是 status 输出里没有 `# branch.head`(见 `BranchState.head`)。
  // 取不到时兜一句话,而不是在标题旁边留一段看不出所以然的空白。
  // 算一次给两处用:分开写时,空 head 那一路的 `title` 会退化成空属性、文本却是「未知分支」
  const label = branch.head || '未知分支';
  return (
    <span class="flex min-w-0 items-baseline gap-2 text-sm">
      <span class="max-w-60 truncate" title={label}>
        {label}
      </span>
      <Upstream upstream={branch.upstream} />
    </span>
  );
}
