// 应用外壳:左侧变更列表,右侧 diff 容器(spec §5.4)。
//
// 本阶段(S2a)只接 `/api/state`。右侧是占位:diff2html 的深导入、hljs 注册与
// 按文件懒加载全部属 S2b —— 那几条「违反后不报错、只是静默出错」的约束(draw()
// 后不得补调 highlightCode()、plaintext 必须注册)需要整会话的上下文,提前拼一半
// 只会把它们埋在别的改动里(spec §7 拆分 S2 的理由)。

import { loadError, repoState, selectedPath } from '../state/store';
import { ChangeList } from './ChangeList';

function DiffPane() {
  const path = selectedPath.value;
  return (
    <section class="flex-1 overflow-auto p-4">
      {path === null ? (
        <p class="text-sm text-neutral-500">从左侧选一个文件。</p>
      ) : (
        <div>
          <h2 class="font-mono text-sm break-all">{path}</h2>
          {/* TODO(S2b):换成 /api/diff + diff2html 渲染容器 */}
          <p class="mt-2 text-sm text-neutral-500">diff 渲染在 S2b 接入。</p>
        </div>
      )}
    </section>
  );
}

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
        <DiffPane />
      </div>
    </div>
  );
}
