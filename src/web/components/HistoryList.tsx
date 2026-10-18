// `History` 那一档：HEAD 可达的近期提交，照 VS Code Source Control Graph 的形态——一条提交一行，
// 单击原地展开它改了哪些文件，点文件在右侧开一个 commit tab。
//
// 行骨架复用两棵树那一套（`TreeRow` + 展开三角 + `StatusBadge`）：同一列状态字母在三档之间切换
// 时落在同一个位置、同一个颜色。

import { useComputed } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { CommitFileEntry, CommitSummary } from '../../server/shared/protocol';
import { badgesBySha, type RefBadge } from '../state/badges';
import { activeEditorKey, editorKey, pinEditor } from '../state/editors';
import {
  commitDetails,
  expandedCommits,
  historyError,
  historyList,
  incomingError,
  incomingList,
  type LoadedHistory,
  loadingMore,
  loadMore,
  moreError,
  shortSha,
  toggleCommit,
} from '../state/history';
import type { BranchKind } from '../state/refs';
import { repoState, selectCommitFile } from '../state/store';
import { GROUP_HEADING, StatusBadge, splitForDisplay } from './ChangeList';
import { SidebarPlaceholder } from './EmptyState';
import { Icon, REF_ICON } from './Icon';
import {
  ChevronPlaceholder,
  CopyButton,
  CopyPathButton,
  ExpandChevron,
  indent,
  PlaceholderRow,
  ROW_BASE,
  SELECTED,
  TreeRow,
} from './tree-row';

const COMMIT_ROW_CLASS = `${ROW_BASE} items-center`;
const FILE_ROW_CLASS = `${ROW_BASE} items-baseline`;

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const STEPS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/**
 * 「3 hours ago」。**不随时钟自己跳**：下一次渲染（SSE、展开、翻页）时才更新——为「刚才」变
 * 「1 分钟前」挂一个计时器不值。一分钟以内一律 `now`，未来的时间（时钟漂移）同样。
 */
export function relativeTime(seconds: number, now = Date.now()): string {
  const delta = seconds - Math.floor(now / 1000);
  // 未来的时间只可能是时钟漂移（提交那台机器的钟快了），说「in 10 minutes」是在复述一个错
  if (delta > 0) return 'now';
  for (const [unit, size] of STEPS) {
    if (-delta >= size) return RELATIVE.format(Math.trunc(delta / size), unit);
  }
  return 'now';
}

/**
 * 提交行的悬停提示：主题、正文，末尾一行是哈希连同作者与时间，段与段之间空一行；没有正文就连那一段
 * 带它的空行一起不画。元信息收成一行垫底，读的人第一眼落在主题上。仍是原生 `title`——正文是纯文本，
 * 自绘卡片换不来多少东西。
 */
export function commitTooltip(commit: CommitSummary, now = Date.now()): string {
  const when = new Date(commit.time * 1000).toLocaleString();
  return [
    commit.subject,
    commit.body,
    // 只放短哈希：完整 sha 在提示里只是一行噪音，要拿去用的是行内那枚复制按钮
    `${shortSha(commit.sha)} · ${commit.author} · ${relativeTime(commit.time, now)} (${when})`,
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}

/**
 * 带色两枚的色相，照 VS Code 的 `scmGraph.historyItemRefColor` / `historyItemRemoteRefColor`：**只给图标
 * 上色、底色是同一色相的 20%**，文字跟着行走。实心底 + 白字是 VS Code 的画法，在这一栏里它比主题
 * 还抢眼，而徽标是附带的那一样。两个 token 都是单值，`/20` 修饰符在这里是合法的 `<color>`。按 `kind`
 * 取色：上游是本地分支时与当前分支同色。
 */
const BADGE_COLOR: Record<BranchKind, { bg: string; icon: string }> = {
  local: { bg: 'bg-scm-graph-history-item-ref/20', icon: 'text-scm-graph-history-item-ref' },
  remote: {
    bg: 'bg-scm-graph-history-item-remote-ref/20',
    icon: 'text-scm-graph-history-item-remote-ref',
  },
};

/**
 * 合成的那几枚是中性色。VS Code 给它们 `badge.background`，而 2026 两份主题里那是一块实心蓝，与当前
 * 分支那枚同色相、分不出谁是谁。底色借列表悬停那一档：它本就是半透明叠加，叠在悬停着的行上照样深
 * 一档。
 */
const NEUTRAL_COLOR = { bg: 'bg-list-hover-background', icon: 'text-description-foreground' };

const colorOf = (badge: RefBadge) =>
  badge.role === 'group' ? NEUTRAL_COLOR : BADGE_COLOR[badge.kind];

/** 提示与读屏器念的那一句：合成的那枚列出每个名字，提示里一行一个。 */
const labelOf = (badge: RefBadge, separator: string) =>
  badge.role === 'group' ? badge.names.join(separator) : badge.name;

/**
 * 一枚 ref 徽标。`shrink-0` 排在 `truncate` span 之后——省略号先吃作者、再吃主题，徽标不被裁；当前
 * 分支的名字太长时它自己 `max-w` 截断，完整名进 `title`。`h-4` 让它比 24px 行盒矮一截、底色不顶满
 * 整行；高度钉死而不靠行高撑，只剩图标的那几枚才不会矮成 12px。
 *
 * **只有当前分支那枚印名字**：上游那枚回答的是「哪几条还没推送」，要的只是位置；合成的那枚照 VS Code
 * 在图标前印条数（只有一条时不印），名字只进 `title`。读屏器那侧一律 `role="img"` + `aria-label`：
 * `title` 读屏器不一定念，无 role 的 `span` 又不许挂 `aria-label`。
 */
function RefBadgeLabel({ badge }: { badge: RefBadge }) {
  const color = colorOf(badge);
  return (
    <span
      class={`flex h-4 max-w-32 shrink-0 items-center gap-0.5 rounded-sm px-1 text-xs ${color.bg}`}
      title={labelOf(badge, '\n')}
      role="img"
      aria-label={labelOf(badge, ', ')}
    >
      {badge.role === 'group' && badge.names.length > 1 && <span>{badge.names.length}</span>}
      <Icon icon={REF_ICON[badge.kind]} size={12} class={`shrink-0 ${color.icon}`} />
      {badge.role === 'head' && <span class="truncate">{badge.name}</span>}
    </span>
  );
}

/** 一条提交展开后的一个文件。单击开预览 tab、双击固定，与另两栏同一条惯例。 */
function CommitFileRow({ sha, file }: { sha: string; file: CommitFileEntry }) {
  const { dir, name } = splitForDisplay(file.path);
  const key = editorKey('commit', file.path, sha);
  // 选中态包成 computed 作为 prop 传下去，理由与变更列表那一行一字不差：在组件体里读等于每换一次
  // 选中，展开着的每一行都重画
  const rowClass = useComputed(
    () => `${FILE_ROW_CLASS} ${activeEditorKey.value === key ? SELECTED : ''}`,
  );
  return (
    <TreeRow
      onClick={() => selectCommitFile(sha, file)}
      onDblClick={() => pinEditor(key)}
      title={file.path}
      class={rowClass}
      style={indent(1)}
      badge={<StatusBadge code={file.status} />}
      // 只有 `Copy path`：**不画 `Open file`**——那枚打开的是工作区此刻的全文，而这一行说的是
      // 历史上的某一版，两者并排是在暗示一件不成立的事
      actions={<CopyPathButton path={file.path} />}
    >
      <ChevronPlaceholder />
      <span class="min-w-0 truncate">
        {name}
        {dir && <span class="ml-2 text-xs text-description-foreground">{dir}</span>}
      </span>
      {file.oldPath && (
        <span class="min-w-0 truncate text-xs text-description-foreground">← {file.oldPath}</span>
      )}
    </TreeRow>
  );
}

/** 展开之后那一层：加载中 / 错误 / 文件列表。 */
function CommitFiles({ sha }: { sha: string }) {
  // 只订阅自己这一条：在组件体里读整张 map 时，任何一条提交的详情落地都会把每个展开着的文件列表
  // 整个重画一遍
  const state = useComputed(() => commitDetails.value.get(sha)).value;
  const placeholder = (text: string) => (
    <ul>
      <PlaceholderRow text={text} depth={1} />
    </ul>
  );
  if (state === undefined || state.status === 'loading') return placeholder('Loading…');
  if (state.status === 'error') return placeholder(state.message);
  // 浅克隆的边界：父提交不在本地，比不出这次改了什么——如实说，而不是画一列「全部新增」
  if (state.detail.shallow) return placeholder('Shallow clone — parent not available');
  if (state.detail.files.length === 0) return placeholder('No file changes');
  return (
    <ul>
      {state.detail.files.map((file) => (
        <CommitFileRow key={file.path} sha={sha} file={file} />
      ))}
    </ul>
  );
}

/**
 * 一条提交：主题 + 作者，照 VS Code Source Control Graph。**两段同住一个 `truncate` span**（主题在
 * 前、作者作它的行内子元素），与变更列表「文件名 + 目录」同一个结构：省略号在右端先吃掉作者，主题
 * 留到最后；拆成两个平级 flex 子项会让两段按底边对齐。短哈希与时间不上行（320px 里放不下），进
 * `title`——短哈希是拿去与终端里 `git log --oneline` 对照的那把钥匙；要拿去用的是行内那枚复制按钮。
 * 有 ref 指着这条时，行尾跟着它们的徽标（见 `RefBadgeLabel`）。**`truncate` span 带 `grow`**：
 * 把徽标推到行右缘、各行对成一列，照 VS Code；紧跟主题时徽标随主题长短左右乱跳。
 */
function CommitRow({ commit }: { commit: CommitSummary }) {
  const expanded = useComputed(() => expandedCommits.value.has(commit.sha)).value;
  const badges = useComputed(() => badgesBySha.value.get(commit.sha)).value;
  return (
    <TreeRow
      onClick={() => toggleCommit(commit.sha)}
      title={commitTooltip(commit)}
      aria-expanded={expanded}
      class={COMMIT_ROW_CLASS}
      style={indent(0)}
      // 复制完整 sha 而不是短哈希：短哈希在仓库长大后可能有歧义，贴给 agent 的东西不该要它再去消歧
      actions={<CopyButton text={commit.sha} label="Copy commit hash" />}
      sublevel={expanded && <CommitFiles sha={commit.sha} />}
    >
      <ExpandChevron expanded={expanded} />
      <span class="min-w-0 grow truncate">
        {commit.subject}
        <span class="ml-2 text-xs text-description-foreground">{commit.author}</span>
      </span>
      {badges?.map((badge) => (
        <RefBadgeLabel key={`${badge.role}:${badge.kind}`} badge={badge} />
      ))}
    </TreeRow>
  );
}

/**
 * 列表末尾的哨兵：一进入可视区就取下一页，照 VS Code。root 取默认视口——祖先那层 `overflow-auto`
 * 照样参与裁剪，滚出侧栏可视区的哨兵不算可见。DOM 的增长仍由用户驱动：每一页都要有人滚到底才取。
 *
 * **列表每变一次就换一个观察者**：新观察者一 `observe` 就报一次初始状态，高屏上一页填不满时就接着
 * 取。只靠一个观察者时，哨兵一直可见、交叉状态没变，它不再回调，列表就停在半截——一页回来、列表
 * 被整体换成新的第一页都是这样。换观察者而不是按某几个字段 `key` 住整行重挂：后者要逐一列出
 * 「列表怎么变了」，漏一种就卡住，而重挂还会把按钮上的键盘焦点丢回 `body`。
 *
 * 空闲时它是一枚 `Load more` 按钮，只有在取时才写 `Loading…`——两种状态写成同一句时，观察者万一
 * 不回调，页面上就是一个永远不结束、也点不动的加载态；按钮同时是键盘那条路。**失败后不自动
 * 重试**——哨兵一直可见时那就是一串打不停的失败请求；原地换成错误文案，点一下才重试。
 */
function LoadMore({ list }: { list: LoadedHistory }) {
  const sentinel = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (el === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && moreError.value === null) {
        void loadMore();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [list]);
  const busy = loadingMore.value;
  const error = moreError.value;
  return (
    <li ref={sentinel}>
      <button
        type="button"
        disabled={busy}
        onClick={() => void loadMore()}
        class={`${ROW_BASE} text-description-foreground hover:bg-list-hover-background hover:text-editor-foreground disabled:cursor-default`}
        style={indent(0)}
      >
        <span class="min-w-0 truncate">
          {busy ? 'Loading…' : error === null ? 'Load more' : `${error} — click to retry`}
        </span>
      </button>
    </li>
  );
}

/**
 * 落后上游时排在列表顶上的那一段：上游有、HEAD 走不到的提交，照 VS Code Graph 把 incoming 画在最上面。
 * 小标题不可点，`↓N` 与状态条同一个数（status 的 `behind`），提示说明这是上次 fetch 时的样子——不替
 * 用户 fetch。下面的行与主列表是同一个 `CommitRow`，展开、复制照常；上游那枚徽标按 sha 自然落在这里。
 * **不翻页**：还有更多时末尾一行 `+M more`。`behind` 包成 computed 只订阅这一个数：直接读 `repoState`
 * 时 agent 每改一个文件这一段就重画一次。
 */
function Incoming() {
  const behind = useComputed(() => repoState.value?.branch.upstream?.behind ?? 0).value;
  const list = incomingList.value;
  const error = incomingError.value;
  if (list === null && error === null) return null;
  const more = list?.hasMore ? behind - list.commits.length : 0;
  return (
    <section class="border-b border-panel-border">
      <h3 class={GROUP_HEADING} title="As of the last fetch">
        Incoming · ↓{behind}
      </h3>
      <ul>
        {error !== null && <PlaceholderRow text={error} depth={0} />}
        {list?.commits.map((commit) => (
          <CommitRow key={commit.sha} commit={commit} />
        ))}
        {more > 0 && <PlaceholderRow text={`+${more} more`} depth={0} />}
      </ul>
    </section>
  );
}

export function HistoryList() {
  const list = historyList.value;
  const error = historyError.value;
  if (list === null) {
    return (
      <SidebarPlaceholder>
        {error === null ? 'Loading…' : `Could not load the history. ${error}`}
      </SidebarPlaceholder>
    );
  }
  if (list.commits.length === 0) return <SidebarPlaceholder>No commits yet</SidebarPlaceholder>;
  return (
    <>
      <Incoming />
      <ul>
        {list.commits.map((commit) => (
          <CommitRow key={commit.sha} commit={commit} />
        ))}
        {list.hasMore && <LoadMore list={list} />}
      </ul>
    </>
  );
}
