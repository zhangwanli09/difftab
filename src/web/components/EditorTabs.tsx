// 右侧面板顶上那条编辑器标签栏——面板唯一的 chrome，排在滚动区域之外。
//
// 一个 tab = 种类图标 + 文件名 +（同名时的）目录 + 关闭按钮。**关闭按钮是 tab 按钮的兄弟，不是
// 孩子**：套在里面时 tab 就不能是 `<button>`（按钮里不能套按钮），于是键盘激活、光标、以及「来自
// × 的事件不能落到 tab 的处理器上」三样都得手写，而 `role="tab"` 的子元素在无障碍树里本就只当
// 文本。并排之后 × 的事件压根不经过 tab 按钮，那三样跟着消失。「在看哪个文件」由活动 tab 回答，
// 完整路径挂在 `title` 上；栏下不再留一行路径横杠——每个文件的名字会在栏里与栏下各写一遍。
//
// **栏是两层，tablist 在里面**：右端那块编辑器动作区（SVG 的预览开关、全文 tab 的自动换行与 `Copy file
// contents`、diff / commit / 整次提交 tab 的忽略空白与版式切换）与 tablist 并排而不是躺在它里面，切法与侧栏那行 tab 一样——躺进去时
// 读屏把按钮报成又一个 tab，而 tablist 是横向滚动容器，按钮还会跟着 tab 滚出视野。
//
// 分屏时每组一条栏，栏里的一切（tab、同名目录、动作区）都只看自己那一组。tab 可拖：拖到另一组的栏上
// 插到指针所在的位置，拖到正文上由 `EditorGroup` 接。

import { computed, type ReadonlySignal, useComputed, useSignal } from '@preact/signals';
import { Columns2, Eye, type LucideIcon, Pilcrow, Rows2, TextWrap, X } from 'lucide-preact';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import {
  activeGroup,
  draggingEditor,
  type Editor,
  type EditorGroup,
  filePathOf,
  keyOf,
  pinEditor,
  worktreePathOf,
} from '../state/editors';
import { commitDetails, commitFilesOf, shortSha } from '../state/history';
import { type DiffOutputFormat, toggleDiffOutputFormat } from '../state/layout';
import {
  activateEditor,
  changesStates,
  closeEditor,
  codeByPath,
  commitChangesStates,
  commitDiffStates,
  type DiffRequestState,
  diffStates,
  fileStates,
  ignoreWhitespace,
  isMarkdown,
  isSegmentOf,
  moveEditorTo,
  previewOf,
  repoState,
  shownMarkdown,
  shownPreview,
  svgPreview,
  toggleIgnoreWhitespace,
  togglePreview,
  toggleWordWrap,
  wordWrap,
} from '../state/store';
import { CODE_COLORS, splitForDisplay } from './ChangeList';
import { inRightHalf, leftTarget } from './drag';
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

/** 动作区此刻画哪几枚。 */
interface EditorActionState {
  /** `Copy file contents` 复制的那份原文；不画则 `null`。 */
  copyText: string | null;
  /** 画不画 `Preview`。 */
  preview: boolean;
  /** 此刻按图画着（`Preview` 的按下态）。 */
  previewing: boolean;
  /** 画不画版式切换。 */
  format: boolean;
  /** 画不画忽略空白。 */
  whitespace: boolean;
  /** 画不画自动换行。 */
  wrap: boolean;
}

const NO_ACTIONS: EditorActionState = {
  copyText: null,
  preview: false,
  previewing: false,
  format: false,
  whitespace: false,
  wrap: false,
};

/**
 * 活动 tab 的动作区，**按 `kind` 在这一处分派**：各枚按钮各写一个 computed、再各自拼一遍 kind 判据时，
 * 多一种 tab 要改四处，漏一处只是那一枚静默不画。
 *
 * - **file**：正文 `ready` 才有。`text` 时画复制（缓存里那份原文），没按图或按渲染画着时再画自动换行；
 *   带 `preview` 或 `markdown` 时画 `Preview`（一个文件不会两者都带），按下态同视图的 `shownPreview` /
 *   `shownMarkdown`（挂着跳行时按文本画）。
 * - **diff / commit**：补丁 `ready` 且带 `patch` 时才有——判据是 payload 上有没有 `patch`，不列 kind：
 *   `DiffView` 交给 `Patch` 的正是那几支。按图画着时没有补丁表格，版式与忽略空白都不画；忽略空白只给
 *   `text`（`untracked-text` 是全新增，没有旧侧可比）。
 * - **commit-changes**：详情就绪且有文件即画版式与忽略空白，**不看已取到的段里有没有 `text`**——段是
 *   懒加载的，按此刻取到的几段判时按钮会随滚动进出。`Preview` 只能看已取到的段（前端不判扩展名），
 *   所以在第一段 SVG 落地时才出现；这种 tab 没有跳行请求可压它，按下态就是开关本身。按图画着的只是
 *   SVG 那几段，其余段照样是表格，版式与忽略空白不因它撤掉。
 * - **changes**：同 commit-changes，「有文件」看的是变更列表此刻那份。
 */
function actionsOf(editor: Editor | null): EditorActionState {
  switch (editor?.kind) {
    case undefined:
      return NO_ACTIONS;
    case 'file': {
      const state = fileStates.value.get(editor.path);
      if (state?.status !== 'ready') return NO_ACTIONS;
      const { payload } = state;
      const markdown = isMarkdown(payload);
      const previewing = markdown
        ? shownMarkdown(payload, editor.path)
        : shownPreview(payload, editor.path) !== undefined;
      return {
        ...NO_ACTIONS,
        copyText: payload.kind === 'text' ? payload.content : null,
        preview: markdown || previewOf(payload) !== undefined,
        previewing,
        // 按图画着时没有正文可折，按渲染画着时正文自己折
        wrap: payload.kind === 'text' && !previewing,
      };
    }
    case 'diff':
    case 'commit': {
      // 两份缓存的键与 `DiffView` / `CommitDiffView` 读的同一套：diff 按路径，commit 按 tab 键
      const state =
        editor.kind === 'commit'
          ? commitDiffStates.value.get(keyOf(editor))
          : diffStates.value.get(editor.path);
      if (state?.status !== 'ready' || !('patch' in state.payload)) return NO_ACTIONS;
      const { payload } = state;
      const previewing = shownPreview(payload) !== undefined;
      return {
        ...NO_ACTIONS,
        preview: previewOf(payload) !== undefined,
        previewing,
        format: !previewing,
        whitespace: payload.kind === 'text' && !previewing,
      };
    }
    case 'commit-changes': {
      if (commitFilesOf(commitDetails.value.get(editor.sha)).kind !== 'files') return NO_ACTIONS;
      return multiDiffActions(commitChangesStates.value, (key) => isSegmentOf(editor.sha, key));
    }
    case 'changes': {
      if ((repoState.value?.files.length ?? 0) === 0) return NO_ACTIONS;
      return multiDiffActions(changesStates.value, () => true);
    }
  }
}

/**
 * 两种多文件视图的动作区：版式与忽略空白恒画，`Preview` 看已取到的段里（键满足 `owned` 的那几格）有没有
 * 一份带预览的。
 */
function multiDiffActions(
  states: ReadonlyMap<string, DiffRequestState>,
  owned: (key: string) => boolean,
): EditorActionState {
  let preview = false;
  for (const [key, state] of states) {
    if (owned(key) && state.status === 'ready' && previewOf(state.payload)) {
      preview = true;
      break;
    }
  }
  return {
    ...NO_ACTIONS,
    preview,
    previewing: preview && svgPreview.value,
    format: true,
    whitespace: true,
  };
}

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

/** 一组的标签栏要的几个派生量。按组记住：每次渲染新建 `computed` 时去重就无从谈起。 */
interface GroupView {
  /** 活动 tab 的动作区画哪几枚。 */
  actions: ReadonlySignal<EditorActionState>;
  /**
   * 动作区此刻画几枚。活动 tab 要不要再滚一次跟的是它而不是「画不画」：在两个都有版式按钮的 tab 之间
   * 切换（`text` ↔ `untracked-text`）时，忽略空白那一枚照样会进出，动作区宽度随之变；开关预览时
   * 版式与忽略空白两枚一起进出。单独一个 computed：数不变时不通知，tab 不因缓存变化重画。
   */
  actionCount: ReadonlySignal<number>;
  /**
   * 整栏一张同名目录表：撞不撞名要看邻居，单个 tab 自己算不出来——关掉一个同名 tab 时，另一个的目录
   * 得跟着消失。只看这一组：另一组里的同名 tab 不在这条栏上，拿它来区分只会让目录无端变长。
   */
  dirs: ReadonlySignal<Map<string, string>>;
}

const views = new WeakMap<EditorGroup, GroupView>();

function viewOf(group: EditorGroup): GroupView {
  let view = views.get(group);
  if (view === undefined) {
    const actions = computed(() => actionsOf(group.active.value));
    view = {
      actions,
      actionCount: computed(() => {
        const state = actions.value;
        return (
          Number(state.preview) +
          Number(state.copyText !== null) +
          Number(state.format) +
          Number(state.whitespace) +
          Number(state.wrap)
        );
      }),
      dirs: computed(() =>
        distinguishingDirs(
          // 两种多文件 tab 没有文件名可撞（`filePathOf` 回 null），拿 sha 或空串去比只会白占一格
          group.editors.value.flatMap((editor) => {
            const path = filePathOf(editor);
            return path === null ? [] : [path];
          }),
        ),
      ),
    };
    views.set(group, view);
  }
  return view;
}

/**
 * tab 的 `title`：完整路径；提交里的那两种带上完整 sha（整次提交 tab 以主题代路径）；工作区改动 tab
 * 说清它是哪一份——tab 上只有 `Changes` 一个词。
 */
function tabTitle(editor: Editor): string {
  switch (editor.kind) {
    case 'changes':
      return 'Working tree changes';
    case 'commit':
      return `${editor.path} @ ${editor.sha}`;
    case 'commit-changes':
      return `${editor.subject} @ ${editor.sha}`;
    default:
      return editor.path;
  }
}

/**
 * tab 上的名字，按种类穷举：多一种 tab 时漏一支是编译错误，而不是落进「拆路径取文件名」那一支、把 sha
 * 或空串画成名字。
 */
function TabLabel({ editor }: { editor: Editor }) {
  switch (editor.kind) {
    case 'diff':
    case 'file':
      return <>{splitForDisplay(editor.path).name}</>;
    case 'commit':
      // 名后跟一个短哈希：同一个文件在两次提交里是两个 tab，没有它两个长得一样
      return (
        <>
          {splitForDisplay(editor.path).name}
          <span class="ml-1.5 font-mono text-xs text-description-foreground">
            {shortSha(editor.sha)}
          </span>
        </>
      );
    case 'commit-changes':
      // 没有文件名：短哈希在前、主题在后，照 History 那一行把主题当名字
      return (
        <>
          <span class="mr-1.5 font-mono text-xs text-description-foreground">
            {shortSha(editor.sha)} ·
          </span>
          {editor.subject}
        </>
      );
    case 'changes':
      return <>Changes</>;
  }
}

/** 拖动时写进 `dataTransfer` 的类型。内容不读（见 `draggingEditor`），只为 Firefox 不写数据不起拖。 */
const DRAG_TYPE = 'application/x-difftab-editor';

function Tab({
  group,
  editor,
  index,
  active,
  focused,
  dir,
}: {
  group: EditorGroup;
  editor: Editor;
  /** 在栏里第几个：拖到这一格上时按它算插入位置 */
  index: number;
  active: boolean;
  /** 所在那一组是焦点组 */
  focused: boolean;
  dir: string | undefined;
}) {
  const key = keyOf(editor);
  const self = useRef<HTMLDivElement>(null);
  // 短路求值：只有活动那一个 tab 订阅这个 computed，其余 tab 不因缓存变化重画
  const actionCount = active ? viewOf(group).actionCount.value : 0;
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
      data-tab-index={index}
      // 非焦点组的活动 tab 用次要前景色：分屏时看得出左栏的高亮与点击此刻跟的是哪一组
      class={`${TAB_CLASS} ${
        active
          ? `border-editor-foreground bg-editor-background ${focused ? 'text-editor-foreground' : 'text-description-foreground'}`
          : 'border-transparent text-description-foreground hover:bg-list-hover-background'
      }`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={tabTitle(editor)}
        draggable
        onDragStart={(event) => {
          event.dataTransfer?.setData(DRAG_TYPE, key);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
          draggingEditor.value = { group, key };
        }}
        // 投放成功与否都会来；`drop` 那一侧也清，两边谁先到都行
        onDragEnd={() => {
          draggingEditor.value = null;
        }}
        onClick={() => activateEditor(key, group)}
        // 幂等的固定：一次双击是 click、click、dblclick 三个事件，前两个已经把 tab 开好并激活
        onDblClick={() => pinEditor(key, group)}
        // 中键关闭，照 VS Code。`auxclick` 的 button 1 是中键
        onAuxClick={(event) => {
          if (event.button === 1) closeEditor(key, group);
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
          <TabLabel editor={editor} />
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
        <IconButton icon={X} label="Close" onClick={() => closeEditor(key, group)} />
      </span>
    </div>
  );
}

/**
 * 栏右端的编辑器动作区，按活动 tab 的种类画：全文 tab 正文就绪时是自动换行与 `Copy file contents`，diff /
 * commit tab 补丁就绪为文本时是忽略空白与版式切换（点了就固定，语义在 `state/layout.ts`）；带
 * SVG / markdown 预览的 tab 最右边再多一枚 `Preview`——开着预览时撤掉的几枚都在它左边，它就不随开关
 * 挪位。版式切换不按 tab 键 `key`：它不带局部状态，显示的是这一组的版式（分屏时两组可以不同）。
 *
 * 复制的是缓存里那份 `payload.content` 原文——不是 hljs 输出，也不带行号。其余几路（加载中、出错、
 * 二进制、图片、符号链接、过大）都不画复制：没有正文可复制，灰着一枚按钮只是一块死区。按钮**按
 * tab 键 `key`**：`useCopied` 的状态跟着组件走，不重挂时切到另一个文件，那枚 ✓ 会把上一个文件的
 * 「已复制」挂在这一个上。
 */
function EditorActions({ group }: { group: EditorGroup }) {
  const view = viewOf(group);
  const editor = group.active.value;
  if (editor === null || view.actionCount.value === 0) return null;
  const { copyText, preview, previewing, format, whitespace, wrap } = view.actions.value;
  // 忽略空白是一枚**带按下态的开关、文案恒定**，与版式按钮「文案写目标版式」刻意不同：版式是什么
  // 一眼看得出，空白藏没藏看不出——开着而认不出来时，用户只会觉得 diff 少了几处改动
  // 预览与忽略空白同为带按下态的开关：开着时面板上是图而不是文本，一眼认得出，但认不出「这个 tab
  // 能切回文本」——按下态答的正是这一句
  const previewToggle = preview && (
    <Toggle
      icon={Eye}
      label="Preview"
      pressed={previewing}
      onClick={() => togglePreview(previewing, editor)}
    />
  );
  const actions =
    copyText !== null ? (
      <>
        {wrap && (
          <Toggle
            icon={TextWrap}
            label="Word Wrap"
            pressed={wordWrap.value}
            onClick={toggleWordWrap}
          />
        )}
        <CopyButton key={keyOf(editor)} text={copyText} label="Copy file contents" />
      </>
    ) : (
      <>
        {whitespace && (
          <Toggle
            icon={Pilcrow}
            label="Hide whitespace changes"
            pressed={ignoreWhitespace.value}
            onClick={toggleIgnoreWhitespace}
          />
        )}
        {format && (
          <IconButton
            {...FORMAT_TOGGLE[group.format.value]}
            onClick={() => toggleDiffOutputFormat(group.format)}
          />
        )}
      </>
    );
  // `px-1.5` 与 tab 上那枚 × 的外壳同一个值：两枚 `IconButton` 离各自邻边一样远
  return (
    <span class="flex shrink-0 items-center px-1.5">
      {actions}
      {previewToggle}
    </span>
  );
}

/**
 * 拖到这条栏上的 tab 插在第几个之前：落在某个 tab 的左半边插在它前面，右半边插在它后面；落在栏里
 * tab 以外的空白处追加到末尾。
 */
function dropIndex(event: DragEvent): number | undefined {
  const target = event.target instanceof Element ? event.target.closest('[data-tab-index]') : null;
  if (!(target instanceof HTMLElement)) return undefined;
  const index = Number(target.dataset.tabIndex);
  return inRightHalf(event, target) ? index + 1 : index;
}

/** 拖着的是另一组的 tab：只有它能投在这一组上。同组内拖动不排序。 */
const draggedFromOther = (group: EditorGroup) => {
  const dragging = draggingEditor.peek();
  return dragging !== null && dragging.group !== group ? dragging : null;
};

export function EditorTabs({ group }: { group: EditorGroup }) {
  const active = group.activeKey.value;
  // 包成 computed：焦点在两组间换时，只有答案真变了的那条栏重画
  const focused = useComputed(() => activeGroup.value === group).value;
  const dirs = viewOf(group).dirs.value;
  // 另一组的 tab 正悬在这条栏上：整条栏垫一层投放底色。没在拖时不垫，理由同正文那层遮罩
  const over = useSignal(false);
  const highlighted = useComputed(() => over.value && draggingEditor.value !== null).value;
  const onDragOver = (event: JSX.TargetedDragEvent<HTMLDivElement>) => {
    if (draggedFromOther(group) === null) return;
    // 不 `preventDefault` 时浏览器认为这里不收，`drop` 不会来
    event.preventDefault();
    over.value = true;
  };
  const onDragLeave = (event: JSX.TargetedDragEvent<HTMLDivElement>) => {
    if (leftTarget(event)) over.value = false;
  };
  const onDrop = (event: JSX.TargetedDragEvent<HTMLDivElement>) => {
    over.value = false;
    const dragging = draggedFromOther(group);
    if (dragging === null) return;
    event.preventDefault();
    // 冒泡到组的根元素时那边别再按正文的投放区处理一遍
    event.stopPropagation();
    draggingEditor.value = null;
    moveEditorTo(dragging.group, dragging.key, group, dropIndex(event));
  };
  // 外层：`h-9` 与左栏顶栏同一个值（理由写在那边）；通栏那条分隔线是这一层的 `divider-b`，tab 自己
  // 的 `border-b` 盖在它上面（见 TAB_CLASS）——tablist 被 flex 拉满这一层的高度，两条线才在同一个
  // 位置。里层 tablist：`min-w-0 flex-1` 让它吃掉动作区以外的全部宽度、溢出时自己滚而不是把动作区挤
  // 出去；`scrollbar-none`：横向滚照旧、只是不画滚动条——画出来会把栏撑高
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 只接拖放投放，不是可操作的控件，没有对应的 role
    <div
      class={`flex h-9 shrink-0 divider-b ${highlighted ? 'bg-editor-group-drop-background' : 'bg-title-bar-background'}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        role="tablist"
        aria-label="Open editors"
        class="flex min-w-0 flex-1 overflow-x-auto scrollbar-none"
      >
        {group.editors.value.map((editor, index) => {
          const key = keyOf(editor);
          return (
            <Tab
              key={key}
              group={group}
              editor={editor}
              index={index}
              active={key === active}
              focused={focused}
              dir={dirs.get(editor.path)}
            />
          );
        })}
      </div>
      <EditorActions group={group} />
    </div>
  );
}
