// 右侧面板顶上那条编辑器标签栏——面板唯一的 chrome，排在滚动区域之外。
//
// 一个 tab = 种类图标 + 文件名 + 目录 + 关闭按钮。**关闭按钮是 tab 按钮的兄弟，不是孩子**：套在
// 里面时 tab 就不能是 `<button>`（按钮里不能套按钮），于是键盘激活、光标、以及「来自 × 的事件
// 不能落到 tab 的处理器上」三样都得手写，而 `role="tab"` 的子元素在无障碍树里本就只当文本。并排
// 之后 × 的事件压根不经过 tab 按钮，那三样跟着消失。「在看哪个文件」由活动 tab 回答，完整路径
// 挂在 `title` 上；栏下不再留一行路径横杠——每个文件的名字会在栏里与栏下各写一遍。

import { FileCode, FileDiff, X } from 'lucide-preact';
import { useEffect, useRef } from 'preact/hooks';
import { activeEditorKey, type Editor, editors, keyOf, pinEditor } from '../state/editors';
import { activateEditor, closeEditor } from '../state/store';
import { splitForDisplay } from './ChangeList';
import { Icon } from './Icon';
import { IconButton } from './IconButton';

// 外壳：下划线机制与侧栏那两枚 tab 同一套（`-mb-px border-b` 压在栏的 `border-b` 上，选中
// `border-editor-foreground`），外加 `bg-editor-background` 让活动 tab 与底下的正文连成一片
// ——VS Code 活动 tab 的底色就是编辑器底色。类名不与 `App.tsx` 的 `TAB_CLASS` 共用一个常量：
// 那一套连焦点环一起写在按钮上，这里焦点环归里面的 tab 按钮、底色与下划线归外壳，两处的切分
// 不同。`shrink-0`：tab 多了往横向滚，不压扁。`group`：关闭按钮的显隐跟着整个 tab 的悬停走。
// 手型光标不在这里写：两枚都是 `<button>`，`app.css` 那条 `@layer base` 规则收了它们。
const TAB_CLASS = 'group -mb-px flex shrink-0 items-center border-b text-sm';

function Tab({ editor, active }: { editor: Editor; active: boolean }) {
  const key = keyOf(editor);
  const { dir, name } = splitForDisplay(editor.path);
  const self = useRef<HTMLDivElement>(null);

  // 活动 tab 要在栏里看得见：栏 `overflow-x-auto`、新 tab 追加在末尾，溢出之后新开的那个就在
  // 屏幕外——正文换了而栏上看不出任何变化。`nearest`：已经看得见就一个像素都不动
  useEffect(() => {
    if (active) self.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

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
        title={editor.path}
        onClick={() => activateEditor(key)}
        // 幂等的固定：一次双击是 click、click、dblclick 三个事件，前两个已经把 tab 开好并激活
        onDblClick={() => pinEditor(key)}
        // 中键关闭，照 VS Code。`auxclick` 的 button 1 是中键
        onAuxClick={(event) => {
          if (event.button === 1) closeEditor(key);
        }}
        class="flex items-center gap-1.5 py-1.5 pl-3 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-border"
      >
        {/* 种类图标是同一路径两个 tab 之间唯一的视觉差别，与空态那两枚同源 */}
        <Icon icon={editor.kind === 'diff' ? FileDiff : FileCode} class="shrink-0" />
        {/* 文件名与目录同住一个 truncate span（名在前、目录作它的行内子元素），理由与变更列表
            那一行一字不差：省略号在右端天然先吃掉目录。预览 tab 斜体，固定之后转正 */}
        <span class={`max-w-64 min-w-0 truncate${editor.pinned ? '' : ' italic'}`}>
          {name}
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

export function EditorTabs() {
  const active = activeEditorKey.value;
  return (
    <div
      role="tablist"
      aria-label="Open editors"
      class="flex shrink-0 overflow-x-auto border-b border-panel-border bg-title-bar-background"
    >
      {editors.value.map((editor) => {
        const key = keyOf(editor);
        return <Tab key={key} editor={editor} active={key === active} />;
      })}
    </div>
  );
}
