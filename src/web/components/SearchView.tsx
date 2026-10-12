// 侧栏 `Search` 档，照 VS Code Search 视图：顶上一个输入框带两枚切换钮，下面按文件分组列命中的行。
// 状态在 `state/search.ts`；搜什么、怎么截、命中区间怎么算都在后端（`server/git/search.ts`）。

import { useComputed } from '@preact/signals';
import { CaseSensitive, type LucideIcon, WholeWord } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { MAX_SEARCH_LINES, type SearchFile, type SearchMatch } from '../../server/shared/protocol';
import { activeEditorPath, editorKey, pinEditor } from '../state/editors';
import {
  collapsedResults,
  matchCase,
  runSearch,
  searchError,
  searchFocusRequest,
  searching,
  searchQuery,
  searchResult,
  setSearchQuery,
  toggleMatchCase,
  toggleResult,
  toggleWholeWord,
  wholeWord,
} from '../state/search';
import { openFile } from '../state/store';
import { splitForDisplay } from './ChangeList';
import { ErrorDetail } from './DiffView';
import { Icon } from './Icon';
import {
  ChevronPlaceholder,
  CopyPathButton,
  ExpandChevron,
  indent,
  ROW_BASE,
  SELECTED,
  TreeRow,
} from './tree-row';

const FILE_ROW_CLASS = `${ROW_BASE} items-center`;
const MATCH_ROW_CLASS = `${ROW_BASE} items-baseline`;

/**
 * 输入框里的切换钮。**`aria-pressed` 表态**，按下时垫选中底色并描一圈焦点色边（照 VS Code 的
 * inputOption）；边是常驻的透明边、按下时只换颜色，按下前后宽度不跳。不复用 `IconButton`：那枚
 * 没有「按下」这一态，为一处加一个可选开关就是又一个不填也不报错的参数。
 */
function Toggle({
  icon,
  label,
  pressed,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      class={`mr-0.5 shrink-0 rounded-sm border p-px focus-visible:outline-2 focus-visible:outline-focus-border ${
        pressed
          ? 'border-focus-border bg-list-active-selection-background text-editor-foreground'
          : 'border-transparent text-description-foreground hover:bg-toolbar-hover-background'
      }`}
    >
      <Icon icon={icon} />
    </button>
  );
}

function SearchBox() {
  const input = useRef<HTMLInputElement>(null);
  const request = searchFocusRequest.value;
  // 切进这一档就聚焦（照 VS Code 打开 Search 视图）；`⌘⇧F` 每按一次再聚焦一次并全选——已经在这一档
  // 时它是「我要换个词搜」
  useEffect(() => {
    input.current?.focus();
    if (request > 0) input.current?.select();
  }, [request]);

  return (
    <div class="shrink-0 px-3 py-2">
      <div class="flex items-center rounded-sm border border-panel-border bg-editor-background focus-within:border-focus-border">
        <input
          ref={input}
          type="text"
          aria-label="Search"
          placeholder="Search"
          spellcheck={false}
          autocomplete="off"
          value={searchQuery.value}
          onInput={(event) => setSearchQuery(event.currentTarget.value)}
          // Enter 不等防抖，立即搜
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runSearch();
          }}
          class="min-w-0 flex-1 bg-transparent px-2 outline-none"
        />
        <Toggle
          icon={CaseSensitive}
          label="Match Case"
          pressed={matchCase.value}
          onClick={toggleMatchCase}
        />
        <Toggle
          icon={WholeWord}
          label="Match Whole Word"
          pressed={wholeWord.value}
          onClick={toggleWholeWord}
        />
      </div>
    </div>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** 汇总行：结果数、`No results`、截断提示、在取、出错。有旧结果时在取也先留着旧的那句。 */
function Summary() {
  if (searchQuery.value === '') return null;
  const error = searchError.value;
  const result = searchResult.value;
  let text: ComponentChildren;
  if (error !== null) {
    // 引导句与原因各占一行（原因的来处不止一个，大小写与句点各成一派）
    text = (
      <>
        Could not search
        <ErrorDetail message={error} />
      </>
    );
  } else if (result === null) {
    text = searching.value ? 'Searching…' : null;
  } else {
    const count = result.files.reduce((sum, file) => sum + file.matches.length, 0);
    text =
      count === 0
        ? 'No results'
        : `${plural(count, 'result')} in ${plural(result.files.length, 'file')}`;
  }
  return (
    <div class="shrink-0 px-3 pb-1 text-xs text-description-foreground">
      <p aria-live="polite">{text}</p>
      {result?.truncated && (
        <p>
          Showing the first {MAX_SEARCH_LINES.toLocaleString('en')} results — refine your search
        </p>
      )}
    </div>
  );
}

/** 预览文本按 `ranges` 切成普通段与高亮段；区间由后端给，这里只切不找。 */
function highlight(match: SearchMatch): ComponentChildren {
  const parts: ComponentChildren[] = [];
  let at = 0;
  for (const [from, to] of match.ranges) {
    if (from > at) parts.push(match.text.slice(at, from));
    parts.push(
      <mark class="rounded-xs bg-editor-find-match-highlight-background text-inherit">
        {match.text.slice(from, to)}
      </mark>,
    );
    at = to;
  }
  if (at < match.text.length) parts.push(match.text.slice(at));
  return parts;
}

/**
 * 一条命中行：缩进一层，单击预览打开文件并跳到那一行，双击固定（同其余列表）。打开的是 file tab
 * 而不是 diff：搜到的是工作区此刻的全文，那一行在 diff 里未必出现。行号不上行，进 `title`。
 */
function MatchRow({ path, match }: { path: string; match: SearchMatch }) {
  return (
    <TreeRow
      actions={null}
      onClick={() => openFile(path, { line: match.line })}
      onDblClick={() => pinEditor(editorKey('file', path))}
      title={`${path}:${match.line}`}
      class={MATCH_ROW_CLASS}
      style={indent(1)}
    >
      <ChevronPlaceholder />
      <span class="min-w-0 truncate">{highlight(match)}</span>
    </TreeRow>
  );
}

/**
 * 一个文件的那一组：文件行（展开三角 + 文件名 + 目录 + 命中数，悬停露出 `Copy path`）与它底下的命中
 * 行。点文件行只折叠 / 展开，不开文件。选中态同按 `activeEditorPath`，包成 computed 的理由同变更列表。
 * **命中数排在行按钮里、`ml-auto` 靠右，不走 `badge`**：行内动作的外壳按 `badge` 锚在一格定宽的状态位
 * 左侧，而三位数的计数比那一格宽，会被按钮压住；排在行按钮里时悬停露出的占位把它往左挤开。
 */
function FileGroup({ file }: { file: SearchFile }) {
  const collapsed = collapsedResults.value.has(file.path);
  const { dir, name } = splitForDisplay(file.path);
  const rowClass = useComputed(
    () => `${FILE_ROW_CLASS} ${activeEditorPath.value === file.path ? SELECTED : ''}`,
  );
  return (
    <TreeRow
      actions={<CopyPathButton path={file.path} />}
      onClick={() => toggleResult(file.path)}
      title={file.path}
      aria-expanded={!collapsed}
      class={rowClass}
      style={indent(0)}
      sublevel={
        !collapsed && (
          <ul>
            {file.matches.map((match) => (
              <MatchRow key={match.line} path={file.path} match={match} />
            ))}
          </ul>
        )
      }
    >
      <ExpandChevron expanded={!collapsed} />
      <span class="min-w-0 truncate">
        {name}
        {dir && <span class="ml-2 text-xs text-description-foreground">{dir}</span>}
      </span>
      <span class="ml-auto shrink-0 text-xs text-description-foreground">
        {file.matches.length}
      </span>
    </TreeRow>
  );
}

export function SearchView() {
  // **只读结果、不读查询**：读了查询这一层就订阅每一次按键，结果区最多 2,000 行跟着每个字重画一遍，
  // 而结果在防抖之后才变。清空输入时 `runSearch` 已同步把结果置成 `null`
  const result = searchResult.value;
  return (
    <div class="flex h-full flex-col">
      <SearchBox />
      <Summary />
      {/* 结果独自滚：输入框与汇总行钉在上面，滚到几百行之后照样能改查询 */}
      <div class="min-h-0 flex-1 overflow-auto">
        {result !== null && (
          <ul aria-label="Search results">
            {result.files.map((file) => (
              <FileGroup key={file.path} file={file} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
