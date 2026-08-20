// 应用外壳:左侧变更列表,右侧 diff 容器(spec §5.4)。
//
// 两侧的所有权是分开的:列表归 Preact 的 keyed reconcile,单文件 diff 容器归
// `Diff2HtmlUI`(§5.5,见 DiffView.tsx)。

import { loadError, repoState } from '../state/store';
import { BranchStatus } from './BranchStatus';
import { ChangeList } from './ChangeList';
import { DiffView } from './DiffView';
import { WatchBadge } from './WatchBadge';

export function App() {
  const state = repoState.value;
  const error = loadError.value;

  // 配色一律走 §5.6 的 VS Code token,不用 Tailwind 自带调色板:后者在深色下不会跟着
  // 翻,得给每个元素再写一遍 dark: 变体,而本项目的深浅切换发生在 token 层
  return (
    <div class="flex h-screen flex-col bg-editor-background text-editor-foreground">
      <header class="flex shrink-0 items-baseline gap-3 border-b border-panel-border bg-title-bar-background px-3 py-2">
        <span class="shrink-0 text-sm font-medium">difftab</span>
        {/* 分支状态与监听标注都只在拿到第一份 state 之后才画:没有它时 header 里
            少一段,而不是先画一个「未知分支 无上游」再被真实取值换掉 —— 后者两秒内
            说了一句假话,而「无上游」恰恰是 S3a 要区分开的那个真实状态。
            **一个 guard 包住两项**,不是每项各写一次 `state !== null`:后者第三次
            出现时就该合并了,而合并前每加一项都要重新想一遍「首帧画不画」 */}
        {state !== null && (
          <>
            <BranchStatus branch={state.branch} />
            <WatchBadge watch={state.watch} />
          </>
        )}
      </header>

      {error !== null && (
        <p class="shrink-0 border-b border-warning-border bg-warning-background px-3 py-2 text-sm">
          {error}
        </p>
      )}

      <div class="flex min-h-0 flex-1">
        <nav class="w-80 shrink-0 overflow-auto border-r border-panel-border bg-side-bar-background">
          {state === null ? (
            // 第一次就失败时不能继续说「读取中」—— 那份加载态永远不会结束,
            // 页面看上去像卡住了,而错误条其实已经把原因写在上面了
            <p class="px-3 py-2 text-sm text-description-foreground">
              {error === null
                ? 'Loading…'
                : 'Could not load the change list. Reload the page to retry.'}
            </p>
          ) : (
            <ChangeList files={state.files} />
          )}
        </nav>
        {/* diff 容器自己滚:列表侧的滚动位置在 SSE 刷新时要留住(§5.4),
            两侧共用一个滚动容器就做不到 */}
        <section class="min-w-0 flex-1 overflow-auto">
          <DiffView />
        </section>
      </div>
    </div>
  );
}
