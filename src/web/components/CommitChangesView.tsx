// 整次提交视图：`commit-changes` tab 的正文，照 VS Code Graph 的 `Open Changes`（多文件 diff 视图）。
//
// 段的骨架、按视口懒取与段体都在 `MultiDiff.tsx`，与工作区改动视图共用。这里只回答两件事：段从哪来——
// 文件清单是 History 展开时那份 `commitDetails`；怎么取——`/api/commit-diff`，取到过就不再取（提交不可变）。

import { useComputed } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import type { CommitFileEntry } from '../../server/shared/protocol';
import { commitDetails, commitFilesOf } from '../state/history';
import {
  commitChangesStates,
  ensureSegment,
  expandSegmentContext,
  segmentContextOf,
  segmentKey,
} from '../state/store';
import { StatusBadge } from './ChangeList';
import { ErrorDetail, LOADING, MergeNotice, Notice, Panel } from './DiffView';
import { Segment, useSegmentWatcher, type Watcher } from './MultiDiff';

/**
 * 一次提交里一个文件那一段。状态与上下文档各自包成 computed：直接读整张表时任何一段落地，几百段一起
 * 重画。`source` 是 `file`：一次提交的文件清单取到就不变，再问只随可见性与两个档位。
 */
function CommitSegment({
  sha,
  file,
  watcher,
}: {
  sha: string;
  file: CommitFileEntry;
  watcher: Watcher | null;
}) {
  const key = segmentKey(sha, file.path);
  const state = useComputed(() => commitChangesStates.value.get(key)).value ?? LOADING;
  const context = useComputed(() => segmentContextOf(key)).value;
  return (
    <Segment
      path={file.path}
      badge={<StatusBadge code={file.status} />}
      state={state}
      context={context}
      sha={sha}
      watcher={watcher}
      source={file}
      ensure={() => ensureSegment(sha, file)}
      onExpand={() => expandSegmentContext(sha, file)}
    />
  );
}

/**
 * `commit-changes` tab 的视图。`App` 按 tab 键给它 `key`，挂着期间 `sha` 不变。**各段的折叠态住在段
 * 组件里**：切 tab 是卸载重挂，回来时全部展开，与「滚动位置不保留」同一个样子。
 */
export function CommitChangesView({ sha }: { sha: string }) {
  const detail = useComputed(() => commitDetails.value.get(sha)).value;
  const { scroller, watcher } = useSegmentWatcher();

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
      <CommitSegment key={file.path} sha={sha} file={file} watcher={watcher} />
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
