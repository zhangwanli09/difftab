// 整次提交视图：`commit-changes` tab 的正文，照 VS Code Graph 的 `Open Changes`（多文件 diff 视图）。
//
// 一个滚动容器，提交里每个文件一段：粘性段头 + 段体。段体就是 commit tab 那份正文（`DiffContent`），
// 提示文案与 payload 的五个分支只此一份。**补丁按视口懒取**：一段进了面板可视区附近才取它那一份，
// 一个提交改几百个文件也只取看得到的那几段。文件清单是 History 展开时那份 `commitDetails`。

import { useComputed } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { CommitFileEntry } from '../../server/shared/protocol';
import { commitDetails, commitFilesOf } from '../state/history';
import {
  commitChangesStates,
  type DiffRequestState,
  ensureSegment,
  expandSegmentContext,
  ignoreWhitespace,
  segmentContextOf,
  segmentKey,
} from '../state/store';
import { StatusBadge, splitForDisplay } from './ChangeList';
import {
  DiffContent,
  ErrorDetail,
  fillsPanel,
  LOADING,
  MergeNotice,
  Notice,
  Panel,
} from './DiffView';
import { CopyPathButton, ExpandChevron } from './tree-row';

/**
 * 一个观察者给全部段共用：段挂载时登记「我进出视口时告诉我」，卸载时注销。**root 是面板那层滚动
 * 容器，不是视口**：`rootMargin` 只放大 root，祖先 `overflow` 的裁剪不跟着放——以视口为 root 时
 * 「附近」那一圈被面板裁掉，滚到哪段才开始取哪段，每段都先闪一拍 `Loading…`。上下各多一屏。
 */
interface Watcher {
  watch(el: Element, onChange: (visible: boolean) => void): () => void;
  disconnect(): void;
}

function createWatcher(root: Element): Watcher {
  const listeners = new Map<Element, (visible: boolean) => void>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
    },
    { root, rootMargin: '100% 0px' },
  );
  return {
    watch(el, onChange) {
      listeners.set(el, onChange);
      observer.observe(el);
      return () => {
        observer.unobserve(el);
        listeners.delete(el);
      };
    },
    disconnect: () => observer.disconnect(),
  };
}

/**
 * 段头：折叠三角 + 文件名 + 目录（同住一个 `truncate` span，理由同变更列表）+ 状态字母 + `Copy path`。
 * `sticky top-0`，实心底色盖住滚上去的补丁；`z-10` 让它压过段体里定位过的东西。点三角那一大块折起 /
 * 展开这一段，`Copy path` 是它的兄弟、不是孩子，理由同编辑器 tab 上那枚 ×。
 */
function SegmentHeader({
  file,
  collapsed,
  onToggle,
}: {
  file: CommitFileEntry;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { dir, name } = splitForDisplay(file.path);
  return (
    <div
      class="sticky top-0 z-10 flex h-8 items-center gap-1.5 border-b border-panel-border bg-side-bar-section-header-background pr-1.5 pl-2 text-sm"
      title={file.path}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        class="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-border"
      >
        <ExpandChevron expanded={!collapsed} />
        <span class="min-w-0 truncate">
          {name}
          {dir && <span class="ml-2 text-xs text-description-foreground">{dir}</span>}
        </span>
      </button>
      <StatusBadge code={file.status} />
      <CopyPathButton path={file.path} />
    </div>
  );
}

/**
 * 段体那一层带什么类，`undefined` 即不带。
 *
 * - **还没取到（`loading`）占半屏高**：只画一行 `Loading…` 时一段才八十多像素，首次挂载时面板加上下
 *   边距里塞得下二三十段，一打开就是二三十趟 `git diff`；撑高之后首屏先取三四段（取回来缩短了还会再带进
 *   来几段），其余随滚动进入边距再取。手上已有一份、正在按新的一档重取的段是 `ready`（带 `pending`），不受影响
 * - **图片与 SVG 预览限高**：它们在 commit tab 里占满面板；段里没有「剩余高度」可吃，给一块定高的一列
 *   flex 当基准——不限高时 `ImageRow` 高为 0、退回只限宽，一张高图就把后面几段推出好几屏
 */
function bodyClass(state: DiffRequestState): string | undefined {
  if (state.status === 'loading') return 'min-h-[50vh]';
  return fillsPanel(state) ? 'flex h-96 flex-col' : undefined;
}

/**
 * 一个文件那一段。进了视口附近（且没折起）才取补丁；切了忽略空白、点开了折叠行时可见的段重取，看不见
 * 的等进视口再取——要不要取只在 `ensureSegment` 判，这里只在「可见、折叠态、两个档位」变了时问它一次。
 * 状态与上下文档各自包成 computed：直接读整张表时任何一段落地，几百段一起重画。
 */
function Segment({
  sha,
  file,
  watcher,
}: {
  sha: string;
  file: CommitFileEntry;
  watcher: Watcher | null;
}) {
  const key = segmentKey(sha, file.path);
  const self = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  // 折叠态住在段自己身上：记在视图上一张集合里时，折一段就换一份集合、几百段跟着重画
  const [collapsed, setCollapsed] = useState(false);
  const state = useComputed(() => commitChangesStates.value.get(key)).value ?? LOADING;
  const context = useComputed(() => segmentContextOf(key)).value;
  const whitespace = ignoreWhitespace.value;

  useEffect(() => {
    const el = self.current;
    if (watcher === null || el === null) return;
    return watcher.watch(el, setVisible);
  }, [watcher]);

  // 两个档位进依赖：它们一变，可见的这一段就要按新的一档重取（`ensureSegment` 自己读此刻的值）
  useEffect(() => {
    if (visible && !collapsed) ensureSegment(sha, file);
  }, [visible, collapsed, whitespace, context, sha, file]);

  // 段体恒套一层、只换类名：按有无外层二选一时，状态一换外层进出，`DiffContent` 整棵卸载重挂
  return (
    <section ref={self} class="border-b border-panel-border">
      <SegmentHeader file={file} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      {!collapsed && (
        <div class={bodyClass(state)}>
          <DiffContent
            path={file.path}
            state={state}
            sha={sha}
            context={context}
            onExpand={() => expandSegmentContext(sha, file)}
          />
        </div>
      )}
    </section>
  );
}

/**
 * `commit-changes` tab 的视图。`App` 按 tab 键给它 `key`，挂着期间 `sha` 不变。**各段的折叠态住在段
 * 组件里**：切 tab 是卸载重挂，回来时全部展开，与「滚动位置不保留」同一个样子。
 */
export function CommitChangesView({ sha }: { sha: string }) {
  const detail = useComputed(() => commitDetails.value.get(sha)).value;
  const scroller = useRef<HTMLDivElement>(null);
  const [watcher, setWatcher] = useState<Watcher | null>(null);

  // layout effect：与滚动层同一次提交就建好，首帧之后段们拿到观察者，紧接着各自登记
  useLayoutEffect(() => {
    const root = scroller.current;
    if (root === null) return;
    const created = createWatcher(root);
    setWatcher(created);
    return () => created.disconnect();
  }, []);

  // 没有文件可画时的那几句与 History 展开那一层同一份（`commitFilesOf`）；出错照 commit tab 写引导句 + 原因
  const view = commitFilesOf(detail);
  let body: ComponentChildren;
  if (view.kind === 'notice') body = <Notice>{view.text}</Notice>;
  else if (view.kind === 'error') {
    body = (
      <Notice>
        Could not load the commit
        <ErrorDetail message={view.message} />
      </Notice>
    );
  } else {
    body = view.files.map((file) => (
      <Segment key={file.path} sha={sha} file={file} watcher={watcher} />
    ));
  }
  const merge = detail?.status === 'ready' && detail.detail.parents.length > 1;
  return (
    <Panel scrollRef={scroller}>
      {merge && <MergeNotice />}
      {body}
    </Panel>
  );
}
