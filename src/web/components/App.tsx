// 应用外壳:左侧变更列表,右侧 diff 容器(spec §5.4)。
//
// 两侧的所有权是分开的:列表归 Preact 的 keyed reconcile,单文件 diff 容器归
// `Diff2HtmlUI`(§5.5,见 DiffView.tsx)。

import { loadError, repoState } from '../state/store';
import { ChangeList } from './ChangeList';
import { DiffView } from './DiffView';

export function App() {
  const state = repoState.value;
  const error = loadError.value;

  return (
    <div class="flex h-screen flex-col bg-white text-neutral-900">
      <header class="flex shrink-0 items-baseline gap-3 border-b border-neutral-200 px-3 py-2">
        <span class="text-sm font-medium">GitGlance</span>
        {/* TODO(S3a):当前分支与 ahead/behind;TODO(S3b2):监听降级标注 */}
      </header>

      {error !== null && (
        <p class="shrink-0 border-b border-neutral-200 bg-amber-50 px-3 py-2 text-sm">{error}</p>
      )}

      <div class="flex min-h-0 flex-1">
        <nav class="w-80 shrink-0 overflow-auto border-r border-neutral-200">
          {state === null ? (
            // 第一次就失败时不能继续说「读取中」—— 那份加载态永远不会结束,
            // 页面看上去像卡住了,而错误条其实已经把原因写在上面了
            <p class="px-3 py-2 text-sm text-neutral-500">
              {error === null ? '读取中…' : '取不到变更列表,刷新页面重试。'}
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
