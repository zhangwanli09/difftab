// 多文件 diff 视图的段：整次提交视图（`commit-changes` tab）与工作区改动视图（`changes` tab）共用，照
// VS Code 的 multi-diff editor。
//
// 一个滚动容器，每个文件一段：粘性段头 + 段体。段体就是 diff / commit tab 那份正文（`DiffContent`），
// 提示文案与 payload 的五个分支只此一份。**补丁按视口懒取**：一段进了面板可视区附近才取它那一份，
// 改几百个文件也只取看得到的那几段。两种视图只在「段从哪来、什么时候算过期」上不同，那两样由调用方交进来。

import type { ComponentChildren, Ref } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DiffContext } from '../state/editors';
import { type DiffRequestState, ignoreWhitespace } from '../state/store';
import { splitForDisplay } from './ChangeList';
import { DiffContent, fillsPanel } from './DiffView';
import { CopyPathButton, ExpandChevron } from './tree-row';

/**
 * 一个观察者给全部段共用：段挂载时登记「我进出视口时告诉我」，卸载时注销。**root 是面板那层滚动
 * 容器，不是视口**：`rootMargin` 只放大 root，祖先 `overflow` 的裁剪不跟着放——以视口为 root 时
 * 「附近」那一圈被面板裁掉，滚到哪段才开始取哪段，每段都先闪一拍 `Loading…`。上下各多一屏。
 */
export interface Watcher {
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
 * 视图那层：交出滚动容器的 ref（挂到 `Panel` 上）与建在它上面的观察者。layout effect：与滚动层同一次
 * 提交就建好，首帧之后段们拿到观察者，紧接着各自登记。
 */
export function useSegmentWatcher(): { scroller: Ref<HTMLDivElement>; watcher: Watcher | null } {
  const scroller = useRef<HTMLDivElement>(null);
  const [watcher, setWatcher] = useState<Watcher | null>(null);
  useLayoutEffect(() => {
    const root = scroller.current;
    if (root === null) return;
    const created = createWatcher(root);
    setWatcher(created);
    return () => created.disconnect();
  }, []);
  return { scroller, watcher };
}

/**
 * 段头：折叠三角 + 文件名 + 目录（同住一个 `truncate` span，理由同变更列表）+ 状态字母 + `Copy path`。
 * `sticky top-0`，实心底色盖住滚上去的补丁；`z-10` 让它压过段体里定位过的东西。点三角那一大块折起 /
 * 展开这一段，`Copy path` 是它的兄弟、不是孩子，理由同编辑器 tab 上那枚 ×。
 */
function SegmentHeader({
  path,
  badge,
  collapsed,
  onToggle,
}: {
  path: string;
  badge: ComponentChildren;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { dir, name } = splitForDisplay(path);
  return (
    <div
      class="sticky top-0 z-10 flex h-8 items-center gap-1.5 border-b border-panel-border bg-side-bar-section-header-background pr-1.5 pl-2 text-sm"
      title={path}
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
      {badge}
      <CopyPathButton path={path} />
    </div>
  );
}

/**
 * 段体那一层带什么类，`undefined` 即不带。
 *
 * - **还没取到（`loading`）占半屏高**：只画一行 `Loading…` 时一段才八十多像素，首次挂载时面板加上下
 *   边距里塞得下二三十段，一打开就是二三十趟 `git diff`；撑高之后首屏先取三四段（取回来缩短了还会再带进
 *   来几段），其余随滚动进入边距再取。手上已有一份、正在按新的一档重取的段是 `ready`（带 `pending`），不受影响
 * - **图片与 SVG 预览限高**：它们在 diff / commit tab 里占满面板；段里没有「剩余高度」可吃，给一块定高的
 *   一列 flex 当基准——不限高时 `ImageRow` 高为 0、退回只限宽，一张高图就把后面几段推出好几屏
 */
function bodyClass(state: DiffRequestState): string | undefined {
  if (state.status === 'loading') return 'min-h-[50vh]';
  return fillsPanel(state) ? 'flex h-96 flex-col' : undefined;
}

/**
 * 一个文件那一段。进了视口附近（且没折起）才问 `ensure` 要不要取；切了忽略空白、点开了折叠行、或
 * `source` 换了一个（工作区那一侧是「手上那份过期了没有」）时，可见的这一段再问一次，看不见的等进
 * 视口再问。要不要取只在 `ensure` 里判。调用方各自把状态与上下文档包成 computed 再交进来：直接读整张
 * 表时任何一段落地，几百段一起重画。
 */
export function Segment({
  path,
  badge,
  state,
  context,
  sha,
  watcher,
  source,
  ensure,
  onExpand,
}: {
  path: string;
  badge: ComponentChildren;
  state: DiffRequestState;
  context: DiffContext;
  /** 提交里的那一版才有：段体里的图片 URL 要带它。 */
  sha?: string | undefined;
  watcher: Watcher | null;
  /** 这一段的数据来源，换了一个即要再问一次 `ensure`；只比身份。 */
  source: unknown;
  ensure: () => void;
  onExpand: () => void;
}) {
  const self = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  // 折叠态住在段自己身上：记在视图上一张集合里时，折一段就换一份集合、几百段跟着重画
  const [collapsed, setCollapsed] = useState(false);
  const whitespace = ignoreWhitespace.value;
  // `ensure` 每次渲染都是新闭包，放进依赖就是每次重画都问一遍；放进 ref，effect 只随下面那几样重跑
  const ensureRef = useRef(ensure);
  ensureRef.current = ensure;

  useEffect(() => {
    const el = self.current;
    if (watcher === null || el === null) return;
    return watcher.watch(el, setVisible);
  }, [watcher]);

  // 两个档位与 `source` 进依赖：它们一变，可见的这一段就要再判一次（`ensure` 自己读此刻的值）
  useEffect(() => {
    if (visible && !collapsed) ensureRef.current();
  }, [visible, collapsed, whitespace, context, source]);

  // 段体恒套一层、只换类名：按有无外层二选一时，状态一换外层进出，`DiffContent` 整棵卸载重挂
  return (
    <section ref={self} class="border-b border-panel-border">
      <SegmentHeader
        path={path}
        badge={badge}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      {!collapsed && (
        <div class={bodyClass(state)}>
          <DiffContent path={path} state={state} sha={sha} context={context} onExpand={onExpand} />
        </div>
      )}
    </section>
  );
}
