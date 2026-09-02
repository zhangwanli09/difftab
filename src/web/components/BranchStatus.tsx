// 分支状态(`BranchState`)。
//
// 本文件只有一条真正的判据：**`upstream === null` 是「无上游」，不是 0/0**。无上游的分支根本
// 不输出 `# branch.ab` 行，而最省事的写法(`upstream?.ahead ?? 0`)会把「没有可比对象」画成
// 「与上游同步」——不报错、不缺字段，只是说了一句假话。类型里 `upstream` 是 `null | { … }`
// 正是为了让这条分支无法被漏掉。
//
// 另外两条降级标注：**detached** 时 `head` 是 git 给的字面量 `(detached)`，不能当分支名画出
// 去；**进行中的多步操作**(rebase / merge / …)后端从 git 目录读来，由 `operation` 承载。

import type { BranchState } from '../../server/shared/protocol';
import { Badge } from './Badge';

/** 为 0 的那个减淡。模块作用域：每个 SSE 事件都会重画这里（同 `ChangeList` 的 `CODE_*`）。 */
const dim = (n: number) => (n === 0 ? 'text-description-foreground' : '');

/** tooltip 里的「N 个提交」。单复数分开是因为 `1 commits` 这种字读起来就是没做完。 */
const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

/**
 * ahead / behind。**两个数一律都画出来，包括 0**——口径是「与 `git status` 结果一致」，而
 * `# branch.ab +0 -0` 本身就是 git 对「有上游且已同步」的表述。为 0 的那个只减淡不隐藏：隐藏
 * 之后「已同步」与「无上游」在页面上又变成同一个样子，而把这两者分开正是本组件存在的理由。
 *
 * **排版照 VS Code status bar 的 `${behind}↓ ${ahead}↑`**：用户是拿这一栏对照另一个窗口看的，
 * 两边的两个数一左一右反过来，每看一眼都要在心里翻一次。
 */
function Upstream({ upstream }: { upstream: BranchState['upstream'] }) {
  if (upstream === null) {
    return (
      <span class="text-description-foreground" title="The current branch has no upstream">
        no upstream
      </span>
    );
  }
  // 两个数直接做父级 flex 行的子项，不包一层 wrapper：包一层就要把父级的
  // `flex items-baseline gap-2` 抄一遍，而以后改父级的 gap 时两处间距会静默分家
  return (
    <>
      <span
        class={`font-mono ${dim(upstream.behind)}`}
        title={`${commits(upstream.behind)} behind upstream`}
      >
        {upstream.behind}↓
      </span>
      <span
        class={`font-mono ${dim(upstream.ahead)}`}
        title={`${commits(upstream.ahead)} ahead of upstream`}
      >
        {upstream.ahead}↑
      </span>
    </>
  );
}

/**
 * 进行中的多步操作的**展示文案**。判据不在这里——哪些状态文件对应哪个操作是 git 知识，住在
 * `server/git/operation.ts`。`am` 与 `rebase` 分成两条正是因为后端把它们分开了：两者共用同一
 * 个 `rebase-apply/` 目录，合并成一句话等于对着一个正在 `git am` 的用户说他在变基。
 */
const OPERATION_LABELS: Record<NonNullable<BranchState['operation']>, string> = {
  rebase: 'Rebasing',
  am: 'Applying patches',
  merge: 'Merging',
  'cherry-pick': 'Cherry-picking',
  revert: 'Reverting',
  bisect: 'Bisecting',
};

/**
 * 「你现在处在一个没走完的操作里」。与 `WatchBadge` 一样：没有操作时**什么都不画**，而不是常
 * 驻一个「正常」标签——后者会让唯一要紧的那一次淹在一片永远正确的字里。
 */
function Operation({ operation }: { operation: BranchState['operation'] }) {
  if (operation === undefined) return null;
  return (
    <Badge
      tone="text-git-conflicting"
      title="This repository is in the middle of an unfinished multi-step git operation. difftab is read-only and will neither continue nor abort it."
    >
      {OPERATION_LABELS[operation]}
    </Badge>
  );
}

export function BranchStatus({ branch }: { branch: BranchState }) {
  /**
   * 三种情况一句话定下要画什么：
   *
   * - **detached**:git 在 `# branch.head` 里给的是字面量 `(detached)`，原样画出去等于在页面
   *   上凭空多出一个叫「(detached)」的分支。判据取 `branch.detached` 而不是比对那个字面量——
   *   后者是 git 的输出细节，协议已经把它翻译成布尔了；
   * - `head` 为空只可能是 status 输出里没有 `# branch.head`，兜一句话，而不是在标题旁边留一段
   *   看不出所以然的空白；
   * - 其余就是分支名。
   *
   * 算一次给两处用：分开写时，前两路的 `title` 会退化成空属性、文本却已经换了。
   */
  const label = branch.detached ? 'Detached HEAD' : branch.head || 'Unknown branch';
  const title = branch.detached ? 'Not on any branch (detached HEAD)' : label;
  /**
   * 「与上游差多少」这一栏**只在没什么可说的时候省掉**：detached 时既没有分支、upstream 也必然
   * 是 null，画出来就是一句「无上游」的废话。判据写成「有上游就画」而不是「不 detached 才画」，
   * 是因为 `detached` 是拿 `# branch.head` 的值与字面量 `(detached)` 比出来的，而 git 的
   * refname 规则允许真有一个分支就叫这个名字——名字那一栏在那种仓库里已经没救了，但计数还救
   * 得回来。
   */
  const showsUpstream = branch.upstream !== null || !branch.detached;
  return (
    <span class="flex min-w-0 items-baseline gap-2 text-sm">
      <span class="max-w-60 truncate" title={title}>
        {label}
      </span>
      {showsUpstream && <Upstream upstream={branch.upstream} />}
      <Operation operation={branch.operation} />
    </span>
  );
}
