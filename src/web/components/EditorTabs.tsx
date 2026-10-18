// 右侧面板顶上那条编辑器标签栏——面板唯一的 chrome，排在滚动区域之外。
//
// 一个 tab = 种类图标 + 文件名 +（同名时的）目录 + 关闭按钮。**关闭按钮是 tab 按钮的兄弟，不是
// 孩子**：套在里面时 tab 就不能是 `<button>`（按钮里不能套按钮），于是键盘激活、光标、以及「来自
// × 的事件不能落到 tab 的处理器上」三样都得手写，而 `role="tab"` 的子元素在无障碍树里本就只当
// 文本。并排之后 × 的事件压根不经过 tab 按钮，那三样跟着消失。「在看哪个文件」由活动 tab 回答，
// 完整路径挂在 `title` 上；栏下不再留一行路径横杠——每个文件的名字会在栏里与栏下各写一遍。
//
// **栏是两层，tablist 在里面**：右端那块编辑器动作区（SVG 的预览开关、全文 tab 的 `Copy file
// contents`、diff 与 commit tab 的忽略空白与版式切换）与 tablist 并排而不是躺在它里面，切法与侧栏那行 tab 一样——躺进去时
// 读屏把按钮报成又一个 tab，而 tablist 是横向滚动容器，按钮还会跟着 tab 滚出视野。

import { computed, useComputed } from '@preact/signals';
import { Columns2, Eye, type LucideIcon, Pilcrow, Rows2, X } from 'lucide-preact';
import { useEffect, useRef } from 'preact/hooks';
import {
  activeEditor,
  activeEditorKey,
  type Editor,
  editors,
  keyOf,
  pinEditor,
  worktreePathOf,
} from '../state/editors';
import { shortSha } from '../state/history';
import { type DiffOutputFormat, diffOutputFormat, toggleDiffOutputFormat } from '../state/layout';
import {
  activateEditor,
  closeEditor,
  codeByPath,
  commitDiffStates,
  diffStates,
  fileStates,
  ignoreWhitespace,
  previewOf,
  shownPreview,
  toggleIgnoreWhitespace,
  toggleSvgPreview,
} from '../state/store';
import { CODE_COLORS, splitForDisplay } from './ChangeList';
import { Icon, KIND_ICON } from './Icon';
import { IconButton } from './IconButton';
import { Toggle } from './Toggle';
import { CopyButton } from './tree-row';

// 外壳：下划线是自己的 `border-b`（选中 `border-editor-foreground`、未选中透明），盖在栏那条
// `divider-b` 上——tablist 被 flex 拉满栏高、外壳又被 flex 拉满 tablist（不写 `h-full`，flex
// 默认就拉），这条边于是落在栏 padding box 的最后 1px 上，与那条 inset 阴影同一个位置；不用负
// 外边距往下压，压出去的那 1px 会被滚动容器裁掉（为什么整套机制是这样，写在 `app.css` 那条
// `@utility divider-b` 上）。外加
// `bg-editor-background` 让活动 tab 与底下的正文连成一片——VS Code 活动 tab 的底色就是编辑器
// 底色。类名不与 `App.tsx` 的 `TAB_CLASS` 共用一个常量：那一套连焦点环一起写在按钮上，这里焦点
// 环归里面的 tab 按钮、底色与下划线归外壳，两处的切分不同。`shrink-0`：tab 多了往横向滚，不压
// 扁。`group`：关闭按钮的显隐跟着整个 tab 的悬停走。手型光标不在这里写：两枚都是 `<button>`，
// `app.css` 那条 `@layer base` 规则收了它们。
const TAB_CLASS = 'group flex shrink-0 items-center border-b text-sm';

/** 活动 file tab 就绪的正文，其余（diff / commit tab、加载中、出错）为 `null`。 */
const activeFilePayload = computed(() => {
  const editor = activeEditor.value;
  if (editor?.kind !== 'file') return null;
  const state = fileStates.value.get(editor.path);
  return state?.status === 'ready' ? state.payload : null;
});

/**
 * 活动 tab 可复制的全文：活动的是 file tab、且正文 `ready` 为 `text` 时是那份原文，否则 `null`。
 * 动作区画不画那枚 `Copy file contents` 由它定，活动 tab 要不要再滚一次也由它定——同一个判据
 * 只写一份。
 */
const activeFileText = computed<string | null>(() => {
  const payload = activeFilePayload.value;
  return payload?.kind === 'text' ? payload.content : null;
});

/**
 * 活动 tab 有没有一张补丁表格可换版式：活动的是 diff 或 commit tab、且补丁 `ready` 并带着
 * `patch` 时为真。动作区画不画版式切换由它定，与 `activeFileText` 一起决定活动 tab 要不要再滚一次。
 *
 * **判据是「payload 上有没有 `patch`」，不是列一遍 kind**：`DiffView` 交给 `Patch` 的正是带
 * `patch` 的那几支，按结构判时新增一种带补丁的 kind 自动算进来，另列一张表则要与那个 switch
 * 手动保持同步。
 */
const activePatchPayload = computed(() => {
  const editor = activeEditor.value;
  if (editor === null || editor.kind === 'file') return null;
  // 两份缓存的键与 `DiffView` / `CommitDiffView` 读的同一套：diff 按路径，commit 按 tab 键
  const state =
    editor.kind === 'commit'
      ? commitDiffStates.value.get(keyOf(editor))
      : diffStates.value.get(editor.path);
  return state?.status === 'ready' && 'patch' in state.payload ? state.payload : null;
});

/** 活动 tab 有没有 SVG 预览可切：正文 `ready` 且 payload 带 `preview`，三种 tab 都算。 */
const previewToggleShown = computed<boolean>(() => {
  const file = activeFilePayload.value;
  const patch = activePatchPayload.value;
  if (file !== null) return previewOf(file) !== undefined;
  return patch !== null && previewOf(patch) !== undefined;
});

/**
 * 活动 tab 此刻按图画着，判据与视图同一个 `shownPreview`（file tab 挂着跳行时按文本画）。此时没有
 * 补丁表格，版式与忽略空白两枚都不画；复制照留——复制的仍是原文。`Preview` 的按下态也读它。
 */
const previewing = computed<boolean>(() => {
  const editor = activeEditor.value;
  const file = activeFilePayload.value;
  const patch = activePatchPayload.value;
  if (editor !== null && file !== null) return shownPreview(file, editor.path) !== undefined;
  return patch !== null && shownPreview(patch) !== undefined;
});

/** 活动 tab 有没有一张补丁表格摆在面板上：有补丁、且没在按图画。版式切换画不画由它定。 */
const formatToggleShown = computed<boolean>(
  () => activePatchPayload.value !== null && !previewing.value,
);

/**
 * 活动 tab 的补丁有没有空白差异可藏：git 出的那一份（`text`）才有。`untracked-text` 是全新增，
 * 没有旧侧可比。
 */
const whitespaceToggleShown = computed<boolean>(
  () => activePatchPayload.value?.kind === 'text' && !previewing.value,
);

/**
 * 动作区此刻画几枚。活动 tab 要不要再滚一次跟的是它而不是「画不画」：在两个都有版式按钮的 tab 之间
 * 切换（`text` ↔ `untracked-text`）时，忽略空白那一枚照样会进出，动作区宽度随之变；开关预览时
 * 版式与忽略空白两枚一起进出。
 */
const editorActionCount = computed<number>(
  () =>
    (previewToggleShown.value ? 1 : 0) +
    (activeFileText.value !== null ? 1 : 0) +
    (formatToggleShown.value ? 1 : 0) +
    (whitespaceToggleShown.value ? 1 : 0),
);

/**
 * 动作区此刻有没有一枚按钮（`EditorActions` 画不画）。**由按钮数派生**，不再把判据拼一遍：两处各拼
 * 一遍时，多一种动作只改了一处就静默漂开。
 */
const editorActionShown = computed<boolean>(() => editorActionCount.value > 0);

/**
 * 版式切换按**当前**版式查出要画的那枚。图标与文案表达的是**目标**版式，与变更列表的
 * `VIEW_TOGGLE` 同类：一个动作按钮，不是显示当前档的状态灯。写成 `Record`：多一种版式时少填一格
 * 是编译错误。
 */
const FORMAT_TOGGLE: Record<DiffOutputFormat, { icon: LucideIcon; label: string }> = {
  'side-by-side': { icon: Rows2, label: 'View inline' },
  'line-by-line': { icon: Columns2, label: 'View side by side' },
};

/**
 * 栏里有**另一条路径**与之同名的那些路径，各画哪段目录：取最短可区分的那几段尾段。没撞名的路径不在
 * 表里，根目录下的文件撞了名也是空串。
 *
 * 段数 = 1 + 与其余每个同名路径的公共尾段数的最大值，截到全长；没取全时前面写 `…/`。取尾段而不是
 * 整段目录：能区分的那段常在中间，而目录排在名字后面、整段画出来会被 `max-w-64` 从右端裁掉，裁完
 * 两个 tab 还是一个样。传进来的路径可以重复（同一路径的 diff 与全文 tab）——那不算撞名，先去重。
 */
export function distinguishingDirs(paths: readonly string[]): Map<string, string> {
  const byName = new Map<string, { path: string; segments: string[] }[]>();
  for (const path of new Set(paths)) {
    const { name } = splitForDisplay(path);
    const entry = { path, segments: path.split('/').slice(0, -1) };
    const group = byName.get(name);
    if (group === undefined) byName.set(name, [entry]);
    else group.push(entry);
  }
  const dirs = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length === 1) continue;
    for (const { path, segments } of group) {
      // 与其余每个同名路径从末尾往前数有几段相同，取最大
      let shared = 0;
      for (const other of group) {
        if (other.path === path) continue;
        let n = 0;
        while (n < segments.length && segments.at(-1 - n) === other.segments.at(-1 - n)) n++;
        shared = Math.max(shared, n);
      }
      const count = Math.min(shared + 1, segments.length);
      const tail = segments.slice(segments.length - count).join('/');
      dirs.set(path, count < segments.length ? `…/${tail}` : tail);
    }
  }
  return dirs;
}

/**
 * 整栏一张表：撞不撞名要看邻居，单个 tab 自己算不出来——关掉一个同名 tab 时，另一个的目录得跟着
 * 消失。
 */
const tabDirs = computed(() => distinguishingDirs(editors.value.map((editor) => editor.path)));

function Tab({
  editor,
  active,
  dir,
}: {
  editor: Editor;
  active: boolean;
  dir: string | undefined;
}) {
  const key = keyOf(editor);
  const { name } = splitForDisplay(editor.path);
  const self = useRef<HTMLDivElement>(null);
  // 短路求值：只有活动那一个 tab 订阅这个 computed，其余 tab 不因缓存变化重画
  const actionCount = active ? editorActionCount.value : 0;
  // 名字按 git 状态染色，与文件树同一张 `codeByPath`、同一张 `CODE_COLORS`；commit tab 不染（判据在
  // `worktreePathOf`）。**包成 `computed`**：`codeByPath` 每个 SSE 都换一份，直接读时每次刷新整栏
  // tab 都重画，包了只在这个 tab 自己的状态码变了才重画。闭包捕获挂载时的 `editor` 不会过期——tab
  // 按 `keyOf` 挂载，路径与种类都在键里，改名即重挂
  const code = useComputed(() => {
    const path = worktreePathOf(editor);
    return path === null ? undefined : codeByPath.value.get(path);
  }).value;
  const color = code === undefined ? '' : CODE_COLORS[code];

  // 活动 tab 要在栏里看得见：tablist `overflow-x-auto`、新 tab 追加在末尾，溢出之后新开的那个就在
  // 屏幕外——正文换了而栏上看不出任何变化。`nearest`：已经看得见就一个像素都不动。
  //
  // **动作区的按钮数变了也再滚一次**：新开的全文或 diff tab 先以 `loading` 激活、滚到 tablist 末端，
  // 正文就绪后按钮才挤进来，tablist 窄了一截而 `scrollLeft` 不动，活动 tab 的右端（连同它的 ×）
  // 就被裁在视野外
  useEffect(() => {
    if (active) self.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, actionCount]);

  return (
    <div
      ref={self}
      class={`${TAB_CLASS} ${
        active
          ? 'border-editor-foreground bg-editor-background text-editor-foreground'
          : 'border-transparent text-description-foreground hover:bg-list-hover-background'
      }`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={editor.kind === 'commit' ? `${editor.path} @ ${editor.sha}` : editor.path}
        onClick={() => activateEditor(key)}
        // 幂等的固定：一次双击是 click、click、dblclick 三个事件，前两个已经把 tab 开好并激活
        onDblClick={() => pinEditor(key)}
        // 中键关闭，照 VS Code。`auxclick` 的 button 1 是中键
        onAuxClick={(event) => {
          if (event.button === 1) closeEditor(key);
        }}
        // `self-stretch` 不是 `py-*`：点击区要铺满整栏高度，外壳 div 自己不接事件，按钮矮一截
        // 就是上下各一条点不到的死区
        class="flex items-center gap-1.5 self-stretch pl-3 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-border"
      >
        {/* 种类图标是同一路径几个 tab 之间唯一的视觉差别，与空态那几枚同一张表 */}
        <Icon icon={KIND_ICON[editor.kind]} class="shrink-0" />
        {/* 文件名与目录同住一个 truncate span（名在前、目录作它的行内子元素），理由与变更列表
            那一行一字不差：省略号在右端天然先吃掉目录。预览 tab 斜体，固定之后转正 */}
        <span class={`max-w-64 min-w-0 truncate ${editor.pinned ? '' : 'italic'} ${color}`}>
          {name}
          {/* commit tab 在名后跟一个短哈希：同一个文件在两次提交里是两个 tab，没有它两个长得一样 */}
          {editor.kind === 'commit' && (
            <span class="ml-1.5 font-mono text-xs text-description-foreground">
              {shortSha(editor.sha)}
            </span>
          )}
          {dir && <span class="ml-1.5 text-xs text-description-foreground">{dir}</span>}
        </span>
      </button>
      {/* 关闭按钮只在活动 tab 上常显，其余 tab 悬停（或键盘焦点落在 tab 内）时才露出来，照
          VS Code：一排 × 常亮就是一排随时会误点的按钮，而此刻在看的那个是最可能要关的。**用透
          明度而不是不渲染**：位置留着，悬停时 tab 宽度才不跳。`IconButton` 不收 class，外面裹一层 */}
      <span
        class={
          active
            ? 'flex px-1.5'
            : 'flex px-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
        }
      >
        <IconButton icon={X} label="Close" onClick={() => closeEditor(key)} />
      </span>
    </div>
  );
}

/**
 * 栏右端的编辑器动作区，按活动 tab 的种类画：全文 tab 正文就绪时是 `Copy file contents`，diff /
 * commit tab 补丁就绪为文本时是忽略空白与版式切换（点了就固定，语义在 `state/layout.ts`）；带
 * SVG 预览的 tab 最左边再多一枚 `Preview`。版式切换
 * 不按 tab 键 `key`：它不带局部状态，版式本来就是全页面一份。
 *
 * 复制的是缓存里那份 `payload.content` 原文——不是 hljs 输出，也不带行号。其余几路（加载中、出错、
 * 二进制、图片、符号链接、过大）都不画复制：没有正文可复制，灰着一枚按钮只是一块死区。按钮**按
 * tab 键 `key`**：`useCopied` 的状态跟着组件走，不重挂时切到另一个文件，那枚 ✓ 会把上一个文件的
 * 「已复制」挂在这一个上。
 */
function EditorActions() {
  const editor = activeEditor.value;
  if (editor === null || !editorActionShown.value) return null;
  const text = activeFileText.value;
  // 忽略空白是一枚**带按下态的开关、文案恒定**，与版式按钮「文案写目标版式」刻意不同：版式是什么
  // 一眼看得出，空白藏没藏看不出——开着而认不出来时，用户只会觉得 diff 少了几处改动
  // 预览与忽略空白同为带按下态的开关：开着时面板上是图而不是文本，一眼认得出，但认不出「这个 tab
  // 能切回文本」——按下态答的正是这一句
  const preview = previewToggleShown.value && (
    <Toggle
      icon={Eye}
      label="Preview"
      pressed={previewing.value}
      onClick={() => toggleSvgPreview(previewing.value)}
    />
  );
  const actions =
    text !== null ? (
      <CopyButton key={keyOf(editor)} text={text} label="Copy file contents" />
    ) : (
      <>
        {whitespaceToggleShown.value && (
          <Toggle
            icon={Pilcrow}
            label="Hide whitespace changes"
            pressed={ignoreWhitespace.value}
            onClick={toggleIgnoreWhitespace}
          />
        )}
        {formatToggleShown.value && (
          <IconButton {...FORMAT_TOGGLE[diffOutputFormat.value]} onClick={toggleDiffOutputFormat} />
        )}
      </>
    );
  // `px-1.5` 与 tab 上那枚 × 的外壳同一个值：两枚 `IconButton` 离各自邻边一样远
  return (
    <span class="flex shrink-0 items-center px-1.5">
      {preview}
      {actions}
    </span>
  );
}

export function EditorTabs() {
  const active = activeEditorKey.value;
  const dirs = tabDirs.value;
  // 外层：`h-9` 与左栏顶栏同一个值（理由写在那边）；通栏那条分隔线是这一层的 `divider-b`，tab 自己
  // 的 `border-b` 盖在它上面（见 TAB_CLASS）——tablist 被 flex 拉满这一层的高度，两条线才在同一个
  // 位置。里层 tablist：`min-w-0 flex-1` 让它吃掉动作区以外的全部宽度、溢出时自己滚而不是把动作区挤
  // 出去；`scrollbar-none`：横向滚照旧、只是不画滚动条——画出来会把栏撑高
  return (
    <div class="flex h-9 shrink-0 divider-b bg-title-bar-background">
      <div
        role="tablist"
        aria-label="Open editors"
        class="flex min-w-0 flex-1 overflow-x-auto scrollbar-none"
      >
        {editors.value.map((editor) => {
          const key = keyOf(editor);
          return (
            <Tab key={key} editor={editor} active={key === active} dir={dirs.get(editor.path)} />
          );
        })}
      </div>
      <EditorActions />
    </div>
  );
}
