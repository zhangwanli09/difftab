// 分支列表：点状态条上的分支名弹出，照 VS Code 点状态栏分支名弹出的那个 quick pick——顶上一个
// 输入框，下面本地分支、远程分支、标签三组。**选中即复制名字**：checkout 属仓库写操作，只读工具
// 能给「选中」的含义只有这一种。复制本身与反馈归打开它的 `BranchStatus`：列表那时已经关了。

import { useComputed, useSignal } from '@preact/signals';
import { Check, Cloud, GitBranch, type LucideIcon, Tag } from 'lucide-preact';
import { Component, type RefObject } from 'preact';
import { useCallback, useEffect, useRef } from 'preact/hooks';
import type { RefEntry } from '../../server/shared/protocol';
import { shortSha } from '../state/history';
import { filterRefs, loadRefs, MAX_SHOWN, refList, refsError } from '../state/refs';
import { relativeTime } from './HistoryList';
import { Icon } from './Icon';
import { SELECTED } from './tree-row';

/** 本地那一枚与状态条上的是同一枚 `GitBranch`。`Record` 让加第四组时少填一格是编译错误。 */
const KIND_ICON: Record<RefEntry['kind'], LucideIcon> = {
  local: GitBranch,
  remote: Cloud,
  tag: Tag,
};

/** 组名画在每组第一项的右端，与 VS Code 那几条 separator 同一个形态。 */
const GROUP_LABEL: Record<RefEntry['kind'], string> = {
  local: 'branches',
  remote: 'remote branches',
  tag: 'tags',
};

const optionId = (index: number) => `branch-picker-option-${index}`;
const LISTBOX_ID = 'branch-picker-listbox';

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
  const query = useSignal('');
  const active = useSignal(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  // 宿主每次重画都给一个新的 `onClose`（agent 跑动时 SSE 每 150ms 一次）；放进 ref，下面那条
  // document 监听就只挂一次，不随每次重画拆了又装
  const close = useRef(onClose);
  close.current = onClose;

  // 每次打开取一次；`autoFocus` 在 Preact 里不可靠（挂载时元素还不在文档里），这里手动给
  useEffect(() => {
    input.current?.focus();
    void loadRefs();
  }, []);

  // 按在浮层之外任何地方即关。挂在 document 上而不是垫一层透明遮罩：遮罩会吞掉那一下，用户点左栏
  // 一个文件得点两次
  useEffect(() => {
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (dialog.current?.contains(target) || anchor.current?.contains(target)) return;
      close.current();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [anchor]);

  const refs = refList.value;
  // 只随列表与输入框变：鼠标在行间移动每一步都重画，几千个标签时不该每步重新过滤一遍
  const matches = useComputed(() =>
    refList.value === null ? [] : filterRefs(refList.value, query.value),
  ).value;
  const shown = matches.slice(0, MAX_SHOWN);
  const activeIndex = Math.min(active.value, Math.max(shown.length - 1, 0));

  // 键盘移动时把活动项滚进视野；鼠标悬停设的活动项本来就在视野里，`nearest` 不会动它
  useEffect(() => {
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const pick = (ref: RefEntry | undefined) => {
    if (ref === undefined) return;
    onClose();
    onPick(ref.name);
  };
  // 交给行的两个回调**身份不变**，`RefRow` 的 memo 才挡得住：宿主每次 SSE 重画都给新的
  // `onPick` / `onClose`，悬停每换一行都改 `active`，两者都不该让 200 行全部重画
  const latestPick = useRef(pick);
  latestPick.current = pick;
  const pickRow = useCallback((ref: RefEntry) => latestPick.current(ref), []);
  const hoverRow = useCallback(
    (index: number) => {
      if (active.value !== index) active.value = index;
    },
    [active],
  );
  const latestKeyDown = useRef<(event: KeyboardEvent) => void>(() => {});
  const keyDownRow = useCallback((event: KeyboardEvent) => latestKeyDown.current(event), []);

  const onKeyDown = (event: KeyboardEvent) => {
    const count = shown.length;
    // 读 signal 而不是渲染时那份 `activeIndex`：两次按键之间未必重画过，按闭包里的值算时连按三下
    // 只走一格，`↓` 紧跟 `Enter` 复制的是上一项
    const current = Math.min(active.value, count - 1);
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(shown[current]);
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count > 0) {
      event.preventDefault();
      // 首尾相接，与 quick pick 一致
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active.value = (current + step + count) % count;
    }
  };
  latestKeyDown.current = onKeyDown;

  let status: string | null = null;
  if (refsError.value !== null) status = refsError.value;
  else if (refs === null) status = 'Loading…';
  else if (refs.length === 0) status = 'No branches or tags';
  else if (shown.length === 0) status = 'No matching branches or tags';

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-label="Branches and tags"
      class="fixed top-2 left-1/2 z-50 flex w-150 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col rounded-md border border-panel-border bg-side-bar-background p-1 text-sm shadow-lg"
    >
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={LISTBOX_ID}
        aria-activedescendant={shown.length > 0 ? optionId(activeIndex) : undefined}
        aria-label="Filter branches and tags"
        placeholder="Select a branch or tag to copy"
        spellcheck={false}
        autocomplete="off"
        value={query.value}
        onInput={(event) => {
          query.value = event.currentTarget.value;
          active.value = 0;
        }}
        onKeyDown={onKeyDown}
        class="mb-1 rounded-sm border border-focus-border bg-editor-background px-2 py-1 outline-none"
      />
      {status !== null && <p class="px-2 py-1 text-description-foreground">{status}</p>}
      <div id={LISTBOX_ID} role="listbox" class="max-h-110 overflow-auto">
        {shown.map((ref, index) => (
          <RefRow
            key={`${ref.kind}:${ref.name}`}
            entry={ref}
            index={index}
            selected={index === activeIndex}
            first={index === 0 || shown[index - 1]?.kind !== ref.kind}
            current={ref.kind === 'local' && ref.name === current}
            onHover={hoverRow}
            onPick={pickRow}
            onKeyDown={keyDownRow}
          />
        ))}
      </div>
      {matches.length > shown.length && (
        <p class="px-2 py-1 text-xs text-description-foreground">
          {matches.length - shown.length} more — type to filter
        </p>
      )}
    </div>
  );
}

interface RefRowProps {
  entry: RefEntry;
  index: number;
  selected: boolean;
  /** 本组第一项：右端画组名，第二组起顶上一条分隔线。 */
  first: boolean;
  /** 当前所在的本地分支。 */
  current: boolean;
  onHover: (index: number) => void;
  onPick: (ref: RefEntry) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

/**
 * 一项。**props 逐个浅比较、都没变就不重画**：props 全是值或身份不变的回调，于是 SSE 重画与悬停换行
 * 只重画真变了的那一两行，`relativeTime` / `shortSha` 也不随之对 200 行各算一遍。不用
 * `preact/compat` 的 `memo`——为它整个 compat 层进产物要多 6 KB。
 */
class RefRow extends Component<RefRowProps> {
  override shouldComponentUpdate(next: RefRowProps): boolean {
    const keys = Object.keys(next) as (keyof RefRowProps)[];
    return keys.some((key) => next[key] !== this.props[key]);
  }

  override render() {
    const { entry, index, selected, first, current, onHover, onPick, onKeyDown } = this.props;
    return (
      <div
        id={optionId(index)}
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        class={`cursor-pointer rounded-sm px-2 py-0.5 ${selected ? SELECTED : ''} ${first && index > 0 ? 'mt-1 border-t border-panel-border' : ''}`}
        onMouseMove={() => onHover(index)}
        onClick={() => onPick(entry)}
        // 焦点平时留在输入框里（`aria-activedescendant`），单击的那一瞬才落到这一项上；
        // 那时键盘照样按输入框那一套走
        onKeyDown={onKeyDown}
      >
        <div class="flex items-center gap-1.5">
          <Icon icon={KIND_ICON[entry.kind]} size={14} class="shrink-0" />
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
      </div>
    );
  }
}
