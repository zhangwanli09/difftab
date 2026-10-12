// 分支列表：点状态条上的分支名弹出，照 VS Code 点状态栏分支名弹出的那个 quick pick——顶上一个
// 输入框，下面本地分支、远程分支、标签三组。**选中即复制名字**：checkout 属仓库写操作，只读工具
// 能给「选中」的含义只有这一种。复制本身与反馈归打开它的 `BranchStatus`：列表那时已经关了。弹层、
// 键盘与外部点击这些机制在 `QuickPick`，与 Quick Open 共用。

import { Check } from 'lucide-preact';
import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';
import type { RefEntry } from '../../server/shared/protocol';
import { shortSha } from '../state/history';
import { filterRefs, loadRefs, refList, refsError } from '../state/refs';
import { relativeTime } from './HistoryList';
import { Icon, REF_ICON } from './Icon';
import { QuickPick, type RowProps } from './QuickPick';

/** 组名画在每组第一项的右端，与 VS Code 那几条 separator 同一个形态。 */
const GROUP_LABEL: Record<RefEntry['kind'], string> = {
  local: 'branches',
  remote: 'remote branches',
  tag: 'tags',
};

export function BranchPicker({
  current,
  anchor,
  onPick,
  onClose,
}: {
  /** 当前所在的本地分支名；detached 或取不到时为 `null`。 */
  current: string | null;
  /** 打开它的那枚按钮。按在它上面不算「外面」——开关归它自己的 click。 */
  anchor: RefObject<HTMLElement>;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  // 每次打开取一次
  useEffect(() => {
    void loadRefs();
  }, []);

  const refs = refList.value;
  let status: string | null = null;
  if (refsError.value !== null) status = refsError.value;
  else if (refs === null) status = 'Loading…';
  else if (refs.length === 0) status = 'No branches or tags';

  return (
    <QuickPick<RefEntry, string | null>
      idPrefix="branch-picker"
      label="Branches and tags"
      inputLabel="Filter branches and tags"
      placeholder="Select a branch or tag to copy"
      anchor={anchor}
      match={(query) => (refList.value === null ? [] : filterRefs(refList.value, query))}
      keyOf={(ref) => `${ref.kind}:${ref.name}`}
      Row={RefRow}
      // 三组：第二组起顶上一条分隔线，组名画在每组第一项的右端，不另起组标题行
      groupOf={(ref) => ref.kind}
      context={current}
      status={status}
      noMatch={() => 'No matching branches or tags'}
      onPick={(ref) => onPick(ref.name)}
      onClose={onClose}
    />
  );
}

/**
 * 一项两行，照 VS Code：图标 + 名字 + 相对时间；`作者 • 短哈希 • 主题`。`context` 是当前所在的本地
 * 分支名，那一项末尾画 `Check`。
 */
function RefRow({ item: entry, first, context: currentBranch }: RowProps<RefEntry, string | null>) {
  const current = entry.kind === 'local' && entry.name === currentBranch;
  return (
    <>
      <div class="flex items-center gap-1.5">
        <Icon icon={REF_ICON[entry.kind]} size={14} class="shrink-0" />
        <span class="truncate">{entry.name}</span>
        {entry.time > 0 && (
          <span class="shrink-0 text-xs text-description-foreground">
            {relativeTime(entry.time)}
          </span>
        )}
        <span class="flex-1" />
        {current && <Icon icon={Check} size={14} class="shrink-0" />}
        {first && (
          <span class="shrink-0 text-xs text-description-foreground">
            {GROUP_LABEL[entry.kind]}
          </span>
        )}
      </div>
      {entry.subject !== '' && (
        <div class="truncate pl-5 text-xs text-description-foreground">
          {entry.author} • {shortSha(entry.sha)} • {entry.subject}
        </div>
      )}
    </>
  );
}
