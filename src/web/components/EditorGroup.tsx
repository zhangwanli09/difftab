// 一组编辑器：标签栏 + 一个视图。右侧面板里有一到两组（分屏），左右并排。
//
// 这一层管三件与组有关、与视图无关的事：量自己的宽度（版式按组判）、被点到时成为焦点组、接住拖到
// 正文上的 tab（分屏或移到这一组）。拖到标签栏上的那一路在 `EditorTabs` 里。

import { type Signal, useComputed, useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { activeGroup, canSplit, draggingEditor, type EditorGroup, keyOf } from '../state/editors';
import { observeDiffPanel } from '../state/layout';
import { splitStyle } from '../state/sidebar';
import { moveEditorTo, splitEditorRight } from '../state/store';
import { CommitChangesView } from './CommitChangesView';
import { CommitDiffView, DiffView } from './DiffView';
import { inRightHalf, leftTarget } from './drag';
import { EditorTabs } from './EditorTabs';
import { PanelEmptyState } from './EmptyState';
import { FileView } from './FileView';
import { GroupContext } from './group-context';
import { WorktreeChangesView } from './WorktreeChangesView';

/**
 * 拖着的 tab 此刻悬在这一组正文上，放下去会怎样：`split` 是分出右组（遮罩只盖右半边），`move` 是移到
 * 这一组（遮罩盖满）。`null` 即放不下。
 */
type DropZone = 'split' | 'move' | null;

/**
 * 按指针位置判投放区。分屏只在一组、拖的是这一组的 tab、且这一组不止一个 tab 时成立（只剩一个时分出去
 * 等于原地不动），落在正文右半边才算；移动只收另一组的 tab。同组内拖到左半边什么都不做。
 */
function zoneOf(group: EditorGroup, event: DragEvent, body: HTMLElement): DropZone {
  const dragging = draggingEditor.peek();
  if (dragging === null) return null;
  if (dragging.group !== group) return 'move';
  return canSplit(group) && inRightHalf(event, body) ? 'split' : null;
}

/** 两种遮罩的几何，内联写：只有这一处用，写成类就是产物里两条只服务一处的规则。 */
const OVERLAY_STYLE: Record<Exclude<DropZone, null>, string> = {
  split: 'left:50%',
  move: 'left:0',
};

/**
 * 投放遮罩。**单独一个组件、投放区是一个 signal**：拖动开始、结束、跨过中线都会改它们，读在 `GroupBody`
 * 里时每一下都把底下那份 diff（动辄数万行）连同另一组一起重渲一遍。
 */
function DropOverlay({ zone }: { zone: Signal<DropZone> }) {
  // 没在拖时不画：拖到窗口外松手时 `dragleave` 不一定来，`dragend` 清了 signal，这里跟着撤
  const shown = draggingEditor.value === null ? null : zone.value;
  // `pointer-events: none`：遮罩盖在正文上，不能把 `dragover` 截走，否则指针一进它就判成离开
  return shown === null ? null : (
    <div
      data-drop-zone={shown}
      class="pointer-events-none absolute inset-y-0 right-0 bg-editor-group-drop-background"
      style={OVERLAY_STYLE[shown]}
    />
  );
}

function GroupBody({ group }: { group: EditorGroup }) {
  const active = group.active.value;
  const body = useRef<HTMLDivElement>(null);
  const zone = useSignal<DropZone>(null);

  if (active === null) return <PanelEmptyState />;
  return (
    // `relative` 是遮罩的锚；一列 flex + `min-h-0 flex-1`，让底下视图里那层 `Panel` 照旧撑满、自己滚
    // biome-ignore lint/a11y/noStaticElementInteractions: 只接拖放投放，不是可操作的控件，没有对应的 role
    <div
      ref={body}
      class="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => {
        const next = body.current === null ? null : zoneOf(group, event, body.current);
        zone.value = next;
        // 不 `preventDefault` 时浏览器认为这里不收，`drop` 不会来
        if (next !== null) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (leftTarget(event)) zone.value = null;
      }}
      onDrop={(event) => {
        const dragging = draggingEditor.peek();
        const next = body.current === null ? null : zoneOf(group, event, body.current);
        zone.value = null;
        if (dragging === null || next === null) return;
        event.preventDefault();
        draggingEditor.value = null;
        if (next === 'split') splitEditorRight(group, dragging.key);
        else moveEditorTo(dragging.group, dragging.key, group);
      }}
    >
      {/* 视图按 tab 键 `key` 住：只换 `path` prop 时组件不卸载，滚动容器连同 `scrollTop` 一起留着——
          在 A 里滚到三千像素再切到同种的 B，B 会从同一个偏移量打开；而切到另一种视图因为换了组件类型
          是从顶部开始，两种切法一个样子才对 */}
      {active.kind === 'file' ? (
        <FileView key={keyOf(active)} path={active.path} />
      ) : active.kind === 'changes' ? (
        <WorktreeChangesView key={keyOf(active)} />
      ) : active.kind === 'commit-changes' ? (
        <CommitChangesView key={keyOf(active)} sha={active.sha} />
      ) : active.kind === 'commit' ? (
        <CommitDiffView key={keyOf(active)} sha={active.sha} path={active.path} />
      ) : (
        <DiffView key={keyOf(active)} path={active.path} />
      )}
      <DropOverlay zone={zone} />
    </div>
  );
}

/**
 * `first`：两组时的左组。它按 `splitPercent` 定宽、右边框上叠着分屏把手（把手挂在 `App` 里）；只剩一组
 * （或右组）时 `flex-1` 吃满。组件按组的 `id` 挂载，左组合并掉之后右组不重挂、正文与滚动位置都留着。
 */
export function EditorGroupView({ group, first }: { group: EditorGroup; first: boolean }) {
  const root = useRef<HTMLDivElement>(null);

  // diff 版式的测量点，每组一个。本组件只管「量哪个元素、什么时候开始和停」——量法与阈值都在
  // `state/layout.ts`，两者是一个取舍的两半。量的是组的根元素，**既不是 DiffView 底下那个宿主 div、
  // 也不是两个视图里那层滚动容器**：这一层从挂载到卸载一直在，那两个各自会随换文件、换视图重建，
  // 观察者跟着反复拆建；而滚动条是从滚动容器的 content box 里扣的，量它等于把「换版式 → 滚动条进出
  // → 宽度抖十几像素」的回路请回来
  useEffect(() => {
    const el = root.current;
    return el === null ? undefined : observeDiffPanel(el, group.width);
  }, [group]);

  // 只订阅「有没有 tab」：`active` 每次固定、改名、换上下文档都是一个新对象，直接读时整组跟着重渲
  const hasTabs = useComputed(() => group.active.value !== null).value;

  const focus = () => {
    if (activeGroup.peek() !== group) activeGroup.value = group;
  };

  // **面板这一层自己不滚**：滚动容器在视图内部（`DiffView` 导出的 `Panel`），标签栏排在它之外。
  // 左组的宽度以 signal 本身交给 `style`（同左栏），拖分屏把手时一个组件都不重渲染
  return (
    <GroupContext.Provider value={group}>
      <div
        ref={root}
        class={
          first
            ? 'flex min-w-0 flex-col border-r border-panel-border'
            : 'flex min-w-0 flex-1 flex-col'
        }
        style={first ? splitStyle : undefined}
        onPointerDown={focus}
        onFocusIn={focus}
      >
        {hasTabs && <EditorTabs group={group} />}
        <GroupBody group={group} />
      </div>
    </GroupContext.Provider>
  );
}
