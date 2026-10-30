// `Changes` 档的内容：上 `Changes`（变更列表）、下 `History`（提交历史）两个分区，照 VS Code
// Source Control 视图里排在 Changes 底下的 Graph。两块各自滚动——共用一个滚动容器时历史一长就把
// 变更列表整个滚出视野，而变更列表才是这一档存在的理由。
//
// 上面那块叫 `Changes`，与里面的组标题 `Changes` 同名——分区标题大写、组标题不大写，两层分得开。
// 下面那块不叫 `Graph`：这里只有提交行、没有图形列。

import type { ReadonlySignal, Signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { DISCONNECTED, disconnected } from '../state/connection';
import { ensureHistory } from '../state/history';
import { invalidateGraphRefs } from '../state/refs';
import {
  changesCollapsed,
  historyCollapsed,
  PANE_DEFAULT_PERCENT,
  PANE_MAX_PERCENT,
  PANE_MIN_PERCENT,
  panePercent,
  paneStyle,
  setPanePercent,
} from '../state/sidebar';
import { historyVisible, loadError, openChanges, repoState } from '../state/store';
import { ChangeList } from './ChangeList';
import { SidebarPlaceholder } from './EmptyState';
import { HistoryList } from './HistoryList';
import { KIND_ICON } from './Icon';
import { IconButton } from './IconButton';
import { percentOfGrandparent, Sash } from './Sash';
import { ExpandChevron } from './tree-row';

/** 方向键一次走多少个百分点。 */
const KEY_STEP = 5;

/**
 * 一个分区：标题按钮 + 展开时下面那层滚动容器。**标题排在滚动容器之外**，不跟着内容滚走。
 *
 * 标题与组标题同高（`text-xs/6`，`/6` 不能省——`text-xs` 会把继承来的 line-height 一并重设）；
 * 大写照 VS Code 的分区标题，组标题不大写，两层于是一眼分得开。
 *
 * 在那列 flex 里怎么分高度由折叠态定：展开 `flex-1`、折起只剩标题（`shrink-0`）。两块都展开时上面
 * 那块另带 `style`（一个百分比的 `flex: 0 0 X%`）——内联样式压过 `flex-1` 类，不必再分一支。
 *
 * `actions` 站在标题行右端，照 VS Code 视图标题栏的动作。**它们是标题按钮的兄弟、不是孩子**（按钮里
 * 不能套按钮），点它们不折叠分区；`pr-3` 与 tab 行一致，两处的 `IconButton` 落在同一条竖线上。
 */
function Pane({
  title,
  collapsed,
  style,
  actions,
  children,
}: {
  title: string;
  collapsed: Signal<boolean>;
  style?: ReadonlySignal<string> | undefined;
  actions?: ComponentChildren;
  children: ComponentChildren;
}) {
  const open = !collapsed.value;
  return (
    <div class={`flex min-h-0 flex-col ${open ? 'flex-1' : 'shrink-0'}`} style={style}>
      <h2 class={`flex shrink-0 items-center ${actions ? 'pr-3' : ''}`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            collapsed.value = open;
          }}
          class="flex min-w-0 flex-1 items-center gap-1 px-1 text-xs/6 font-medium text-description-foreground uppercase hover:text-editor-foreground focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-border"
        >
          <ExpandChevron expanded={open} />
          {title}
        </button>
        {actions}
      </h2>
      {/* 字号与行高从 `<nav>` 那一层继承，这里只管滚。**折起是隐藏不是卸载**：卸载时滚动容器连同
          `scrollTop` 一起没了，在 History 里翻了三页、折一下再展开就回到顶上 */}
      <div class={`min-h-0 flex-1 overflow-auto ${open ? '' : 'hidden'}`}>{children}</div>
    </div>
  );
}

const currentPercent = () => panePercent.peek();

/** 一像素合多少个百分点：量的是那一列的高度（分隔条 → 分隔线 → 那一列）。 */
const percentPerPx = percentOfGrandparent('y');

/**
 * 两块之间的分隔条。名字与取值说的是同一块：数值是上面 `Changes` 那块的占比，↓ 让它变大。
 */
function PaneSash() {
  return (
    <Sash
      name="pane"
      axis="y"
      label="Resize changes"
      value={panePercent}
      min={PANE_MIN_PERCENT}
      max={PANE_MAX_PERCENT}
      step={KEY_STEP}
      initial={PANE_DEFAULT_PERCENT}
      current={currentPercent}
      unitsPerPx={percentPerPx}
      set={setPanePercent}
    />
  );
}

function Changes() {
  const state = repoState.value;
  const error = loadError.value;
  if (state !== null) return <ChangeList files={state.files} />;
  // 第一次就失败时不能继续说「读取中」——那份加载态永远不会结束，
  // 页面看上去像卡住了，而错误条其实已经把原因写在上面了。断线时不劝人刷新：刷新只会换来
  // 浏览器的错误页（端口随进程走，旧标签页连不回新实例）
  return (
    <SidebarPlaceholder>
      {error === null
        ? 'Loading…'
        : disconnected.value
          ? DISCONNECTED
          : 'Could not load the change list. Reload the page to retry.'}
    </SidebarPlaceholder>
  );
}

/**
 * 两块各自按折叠态分高度（见 `Pane`）；都折起时两个标题叠在顶上。中间那条分隔线是一个零高、带
 * `border-t` 的兄弟，分隔条绝对定位叠在它上面、只在两块都展开时画。
 */
export function SourceControl() {
  const both = !changesCollapsed.value && !historyCollapsed.value;

  // 提交历史只给看得见的时候付钱：没取过、上次没取到、或看不见期间 HEAD 挪过，变回看得见（切到
  // 这一档、展开 `History` 分区、第一份 state 到了）那一刻才判一次。看得见期间的判定在 `store.ts`
  // 的 `refresh`。effect 挂在这里而不是 `App`：`App` 是整棵树，订阅分区折叠就是每点一下标题整页重画。
  // 徽标的 refs 在变得看不见那一刻作废判据，回来时必重取：别处打了标签、挪了别的分支时分支状态一样
  // 都不变，判据看不见。作废放在藏起时而不是现身时：第一份 state 经 `refresh` 到达时它已经取过一次，
  // 现身那一刻再作废就是同一份 refs 取两遍
  const showHistory = historyVisible.value;
  useEffect(() => {
    if (!showHistory) {
      invalidateGraphRefs();
      return;
    }
    void ensureHistory(repoState.peek());
  }, [showHistory]);

  return (
    <div class="flex h-full flex-col">
      {/* `Open Changes` 把工作区全部改动排进一个 tab。**工作区干净时照画**，点开说 `No changes`：随改动
          忽有忽无比常亮更难扫；分区折起时也照画 */}
      <Pane
        title="Changes"
        collapsed={changesCollapsed}
        style={both ? paneStyle : undefined}
        actions={<IconButton icon={KIND_ICON.changes} label="Open Changes" onClick={openChanges} />}
      >
        <Changes />
      </Pane>
      <div class="relative shrink-0 border-t border-panel-border">{both && <PaneSash />}</div>
      <Pane title="History" collapsed={historyCollapsed}>
        <HistoryList />
      </Pane>
    </div>
  );
}
