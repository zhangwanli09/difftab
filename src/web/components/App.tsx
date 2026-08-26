// 应用外壳:左栏一列(顶栏、错误条、变更列表、状态条),右边是 diff 容器。
//
// 顶栏与状态条都归左栏、不横跨全屏:两处画的都是「这个仓库现在怎么样」(产品名、
// 分支、监听档位),与右边看的是哪个文件无关,横跨等于在 diff 面板顶上切一条与 diff
// 无关的横杠。
//
// 两侧的所有权是分开的:列表归 Preact 的 keyed reconcile,单文件 diff 容器归
// `Diff2HtmlUI`(见 DiffView.tsx)。

import { useEffect, useRef } from 'preact/hooks';
import { observeDiffPanel } from '../state/layout';
import { loadError, repoState } from '../state/store';
import { BranchStatus } from './BranchStatus';
import { ChangeList } from './ChangeList';
import { DiffView } from './DiffView';
import { WatchBadge } from './WatchBadge';

export function App() {
  const state = repoState.value;
  const error = loadError.value;
  const diffPanel = useRef<HTMLElement>(null);

  // diff 版式的**唯一**测量点。本组件只管「量哪个元素、什么时候开始和停」——
  // 量法与阈值都在 `state/layout.ts`,两者是一个取舍的两半,拆开放会让其中一半失去说明。
  //
  // 量的是这个 `<section>` 而不是 DiffView 底下那个宿主 div:前者从挂载到卸载一直在,
  // 后者每换一个文件就重建一次(`key={state.path}`),观察者会跟着反复拆建。
  useEffect(() => {
    const panel = diffPanel.current;
    return panel === null ? undefined : observeDiffPanel(panel);
  }, []);

  // 配色一律走 VS Code token,不用 Tailwind 自带调色板:后者在深色下不会跟着
  // 翻,得给每个元素再写一遍 dark: 变体,而本项目的深浅切换发生在 token 层
  return (
    <div class="flex h-screen bg-editor-background text-editor-foreground">
      {/* 左栏自己是一列:顶栏、错误条与状态条都 shrink-0 钉住,中间那层列表独自滚 */}
      <aside class="flex w-80 shrink-0 flex-col border-r border-panel-border bg-side-bar-background">
        <header class="shrink-0 border-b border-panel-border bg-title-bar-background px-3 py-2 text-sm font-medium">
          difftab
        </header>

        {/* break-words 是搬进 320px 之后才需要的:这条文案是 git 的原话,经 sanitize
            只换掉仓库根、只留第一行,里面那截路径是一个不带断点的长词。横跨全屏时它
            总能排下,在这一列里则会漫过右边框压到 diff 面板上(没有全局的 overflow-wrap
            兜底) —— 不报错,只是错位 */}
        {error !== null && (
          <p class="shrink-0 border-b border-warning-border bg-warning-background px-3 py-2 text-sm break-words">
            {error}
          </p>
        )}

        {/* flex 的自动最小尺寸只在该轴 overflow:visible 时才解析成 min-content,所以
            `min-h-0` 与 `overflow-auto` 各自都足以把它归零 —— 两个都没有时列表会把整列
            撑高、把状态条挤出屏幕底部。并排写是既有形状(右边那个 section 同款) */}
        <nav class="min-h-0 flex-1 overflow-auto">
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

        {/* 分支状态与监听标注都只在拿到第一份 state 之后才画:没有它时整条状态条
            不画,而不是先画一个「未知分支 无上游」再被真实取值换掉 —— 后者两秒内
            说了一句假话,而「无上游」恰恰是要区分开的那个真实状态。
            **一个 guard 包住两项**,不是每项各写一次 `state !== null`:后者第三次
            出现时就该合并了,而合并前每加一项都要重新想一遍「首帧画不画」。
            状态条不给自己的底色:左栏那层已经上过,分隔靠一条 border-t */}
        {state !== null && (
          <footer class="flex shrink-0 items-baseline gap-2 border-t border-panel-border px-3 py-1">
            <BranchStatus branch={state.branch} />
            <WatchBadge watch={state.watch} />
          </footer>
        )}
      </aside>

      {/* diff 容器自己滚:列表侧的滚动位置在 SSE 刷新时要留住,
          两侧共用一个滚动容器就做不到 */}
      <section ref={diffPanel} class="min-w-0 flex-1 overflow-auto">
        <DiffView />
      </section>
    </div>
  );
}
