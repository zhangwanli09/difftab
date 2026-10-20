// 工作区改动视图：`changes` tab 的正文，工作区此刻的全部改动依次排在一个 tab 里（照 VS Code Source
// Control 的多文件 diff 视图）。
//
// 段的骨架、按视口懒取与段体都在 `MultiDiff.tsx`，与整次提交视图共用。这里只回答两件事：段从哪来——变更
// 列表此刻那份 `repoState.files`，次序同左栏自上而下；什么时候算过期——每换上一份新 state 都算，可见的段
// 当场重取、看不见的等进了视口再取（判据在 `ensureChangesSegment`）。

import { useComputed } from '@preact/signals';
import { Component, type ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import {
  changesContextOf,
  changesEntryOf,
  changesFilesOf,
  changesOutdated,
  changesStates,
  codeOf,
  ensureChangesSegment,
  expandChangesContext,
  repoState,
} from '../state/store';
import { StatusBadge } from './ChangeList';
import { LOADING, Notice, Panel } from './DiffView';
import { Segment, useSegmentWatcher, type Watcher } from './MultiDiff';

/**
 * 工作区里一个文件那一段，**只收路径**：条目每份 state 都是新对象，按它传 prop 就是每个 SSE 全部段连同
 * 补丁表格重画一遍。条目在用到时按路径现取（`changesEntryOf`），状态字母包成 computed，字母不变就不重画。
 *
 * `source` 是 `changesOutdated`：换上新 state、或在途那趟落地时发现 state 已换过，它都翻成 true，可见的段
 * 再问一次 `ensureChangesSegment`；看不见的段等进了视口再问。状态字母按 `codeOf` 归并成一枚（冲突印 `!`）：
 * 一段是一份 `git diff HEAD`，分不出是哪一组的改动。
 */
function ChangesSegment({ path, watcher }: SegmentProps) {
  const state = useComputed(() => changesStates.value.get(path)).value ?? LOADING;
  const context = useComputed(() => changesContextOf(path)).value;
  const outdated = useComputed(() => changesOutdated(path)).value;
  const code = useComputed(() => {
    const entry = changesEntryOf(path);
    return entry === undefined ? null : codeOf(entry);
  }).value;
  return (
    <Segment
      path={path}
      badge={code !== null && <StatusBadge code={code} />}
      state={state}
      context={context}
      watcher={watcher}
      source={outdated}
      ensure={() => ensureChangesSegment(path)}
      onExpand={() => expandChangesContext(path)}
    />
  );
}

interface SegmentProps {
  path: string;
  watcher: Watcher | null;
}

/**
 * 段的外壳：**props 没变就不重画**，视图每个 SSE 重排一次清单时几百段都停在原处，只有自己那几个 computed
 * 变了的段重画。不用 `preact/compat` 的 `memo`，理由同 `QuickPick` 的 `Option`。
 */
class ChangesSegmentShell extends Component<SegmentProps> {
  override shouldComponentUpdate(next: SegmentProps): boolean {
    return next.path !== this.props.path || next.watcher !== this.props.watcher;
  }

  override render() {
    return <ChangesSegment path={this.props.path} watcher={this.props.watcher} />;
  }
}

/**
 * `changes` tab 的视图。各段的折叠态住在段组件里，切 tab 回来全部展开，同整次提交视图。**改动清空时
 * 说 `No changes`、不关 tab**：它看的是整个工作区，下一批改动来了照常排出来。
 */
export function WorktreeChangesView() {
  const files = repoState.value?.files;
  const { scroller, watcher } = useSegmentWatcher();
  // 排序与去重只在 `files` 换新时做：`changesFilesOf` 每次都回新数组
  const ordered = useMemo(() => (files === undefined ? null : changesFilesOf(files)), [files]);

  let body: ComponentChildren;
  if (ordered === null) body = <Notice>Loading…</Notice>;
  else if (ordered.length === 0) body = <Notice>No changes</Notice>;
  else {
    body = ordered.map((file) => (
      <ChangesSegmentShell key={file.path} path={file.path} watcher={watcher} />
    ));
  }
  return <Panel scrollRef={scroller}>{body}</Panel>;
}
