// 右侧面板顶上那条编辑器标签栏——面板唯一的 chrome，排在滚动区域之外。
//
// 一个 tab = 种类图标 + 文件名 + 目录 + 关闭按钮。**关闭按钮是 tab 按钮的兄弟，不是孩子**：套在
// 里面时 tab 就不能是 `<button>`（按钮里不能套按钮），于是键盘激活、光标、以及「来自 × 的事件
// 不能落到 tab 的处理器上」三样都得手写，而 `role="tab"` 的子元素在无障碍树里本就只当文本。并排
// 之后 × 的事件压根不经过 tab 按钮，那三样跟着消失。「在看哪个文件」由活动 tab 回答，完整路径
// 挂在 `title` 上；栏下不再留一行路径横杠——每个文件的名字会在栏里与栏下各写一遍。
//
// **栏是两层，tablist 在里面**：右端那块编辑器动作区（全文 tab 的 `Copy file contents`）与
// tablist 并排而不是躺在它里面，切法与侧栏那行 tab 一样——躺进去时读屏把按钮报成又一个 tab，
// 而 tablist 是横向滚动容器，按钮还会跟着 tab 滚出视野。

import { computed } from '@preact/signals';
import { X } from 'lucide-preact';
import { useEffect, useRef } from 'preact/hooks';
import {
  activeEditor,
  activeEditorKey,
  type Editor,
  editors,
  keyOf,
  pinEditor,
} from '../state/editors';
import { shortSha } from '../state/history';
import { activateEditor, closeEditor, fileStates } from '../state/store';
import { splitForDisplay } from './ChangeList';
import { Icon, KIND_ICON } from './Icon';
import { IconButton } from './IconButton';
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

/**
 * 活动 tab 可复制的全文：活动的是 file tab、且正文 `ready` 为 `text` 时是那份原文，否则 `null`。
 * 动作区画不画那枚 `Copy file contents` 由它定，活动 tab 要不要再滚一次也由它定——同一个判据
 * 只写一份。
 */
const activeFileText = computed<string | null>(() => {
  const editor = activeEditor.value;
  if (editor?.kind !== 'file') return null;
  const state = fileStates.value.get(editor.path);
  return state?.status === 'ready' && state.payload.kind === 'text' ? state.payload.content : null;
});

function Tab({ editor, active }: { editor: Editor; active: boolean }) {
  const key = keyOf(editor);
  const { dir, name } = splitForDisplay(editor.path);
  const self = useRef<HTMLDivElement>(null);
  // 短路求值：只有活动那一个 tab 订阅 `activeFileText`，其余 tab 不因缓存变化重画
  const actionsShown = active && activeFileText.value !== null;

  // 活动 tab 要在栏里看得见：tablist `overflow-x-auto`、新 tab 追加在末尾，溢出之后新开的那个就在
  // 屏幕外——正文换了而栏上看不出任何变化。`nearest`：已经看得见就一个像素都不动。
  //
  // **动作区出现或消失时也再滚一次**：新开的全文 tab 先以 `loading` 激活、滚到 tablist 末端，正文
  // 就绪后那枚复制按钮才挤进来，tablist 窄了一截而 `scrollLeft` 不动，活动 tab 的右端（连同它的 ×）
  // 就被裁在视野外
  useEffect(() => {
    if (active) self.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, actionsShown]);

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
        <span class={`max-w-64 min-w-0 truncate${editor.pinned ? '' : ' italic'}`}>
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
 * 栏右端的编辑器动作区。眼下只有一枚：活动 tab 是全文、且正文已就绪时的 `Copy file contents`。
 *
 * 复制的是缓存里那份 `payload.content` 原文——不是 hljs 输出，也不带行号。其余几路（加载中、出错、
 * 二进制、图片、符号链接、过大）以及 diff / commit tab 都不画：没有正文可复制，灰着一枚按钮只是一块
 * 死区。按钮**按 tab 键 `key`**：`useCopied` 的状态跟着组件走，不重挂时切到另一个文件，那枚 ✓ 会
 * 把上一个文件的「已复制」挂在这一个上。
 */
function EditorActions() {
  const editor = activeEditor.value;
  const text = activeFileText.value;
  if (editor === null || text === null) return null;
  // `px-1.5` 与 tab 上那枚 × 的外壳同一个值：两枚 `IconButton` 离各自邻边一样远
  return (
    <span class="flex shrink-0 items-center px-1.5">
      <CopyButton key={keyOf(editor)} text={text} label="Copy file contents" />
    </span>
  );
}

export function EditorTabs() {
  const active = activeEditorKey.value;
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
          return <Tab key={key} editor={editor} active={key === active} />;
        })}
      </div>
      <EditorActions />
    </div>
  );
}
