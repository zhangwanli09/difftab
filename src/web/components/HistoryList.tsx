// `History` 那一档：HEAD 可达的近期提交，照 VS Code Source Control Graph 的形态——一条提交一行，
// 单击原地展开它改了哪些文件，点文件在右侧开一个 commit tab。
//
// 行骨架复用两棵树那一套（`TreeRow` + 展开三角 + `StatusBadge`）：同一列状态字母在三档之间切换
// 时落在同一个位置、同一个颜色。

import { useComputed } from '@preact/signals';
import type { CommitFileEntry, CommitSummary } from '../../server/shared/protocol';
import { activeEditorKey, editorKey, pinEditor } from '../state/editors';
import {
  commitDetails,
  expandedCommits,
  historyError,
  historyList,
  loadingMore,
  loadMore,
  moreError,
  shortSha,
  toggleCommit,
} from '../state/history';
import { selectCommitFile } from '../state/store';
import { StatusBadge, splitForDisplay } from './ChangeList';
import { SidebarPlaceholder } from './EmptyState';
import {
  ChevronPlaceholder,
  CopyPathButton,
  ExpandChevron,
  indent,
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
    <li class="truncate pr-3 text-description-foreground" style={indent(1)}>
      {text}
    </li>
  );
  if (state === undefined || state.status === 'loading') return <ul>{placeholder('Loading…')}</ul>;
  if (state.status === 'error') return <ul>{placeholder(state.message)}</ul>;
  if (state.detail.files.length === 0) return <ul>{placeholder('No file changes')}</ul>;
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
 * `title`——短哈希是拿去与终端里 `git log --oneline` 对照的那把钥匙。
 */
function CommitRow({ commit }: { commit: CommitSummary }) {
  const expanded = useComputed(() => expandedCommits.value.has(commit.sha)).value;
  const when = new Date(commit.time * 1000);
  return (
    <TreeRow
      onClick={() => toggleCommit(commit.sha)}
      title={`${shortSha(commit.sha)} · ${commit.sha}\n${commit.subject}\n${commit.author} · ${relativeTime(commit.time)} (${when.toLocaleString()})`}
      aria-expanded={expanded}
      class={COMMIT_ROW_CLASS}
      style={indent(0)}
      actions={null}
      sublevel={expanded && <CommitFiles sha={commit.sha} />}
    >
      <ExpandChevron expanded={expanded} />
      <span class="min-w-0 truncate">
        {commit.subject}
        <span class="ml-2 text-xs text-description-foreground">{commit.author}</span>
      </span>
    </TreeRow>
  );
}

/**
 * 列表末尾那枚 `Load more`。**不做无限滚动**：滚到底自动取，在边跑边看的场景下会在不经意间把
 * 列表拉到几百条，而每条提交都是一行 DOM。失败时原地换成错误文案，再点一次就重试。
 */
function LoadMore() {
  const busy = loadingMore.value;
  const error = moreError.value;
  return (
    <li>
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
    <ul>
      {list.commits.map((commit) => (
        <CommitRow key={commit.sha} commit={commit} />
      ))}
      {list.hasMore && <LoadMore />}
    </ul>
  );
}
