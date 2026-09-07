// 应用外壳：左栏一列（顶栏、错误条、变更列表、状态条），右边是 diff 容器。
//
// 顶栏与状态条都归左栏、不横跨全屏：两处画的都是「这个仓库现在怎么样」(项目名、分支、监听
// 档位)，与右边看的是哪个文件无关，横跨等于在 diff 面板顶上切一条与 diff 无关的横杠。
// 两侧的所有权是分开的：列表归 Preact 的 keyed reconcile，单文件 diff 容器归 `Diff2HtmlUI`。

import { Folder, GitBranch } from 'lucide-preact';
import { useEffect, useRef } from 'preact/hooks';
import { observeDiffPanel } from '../state/layout';
import { activePane, activeTab, loadError, repoState } from '../state/store';
import { PRODUCT_NAME } from '../state/title';
import { loadDir, ROOT, refreshTree } from '../state/tree';
import { BranchStatus } from './BranchStatus';
import { ChangeList } from './ChangeList';
import { DiffView } from './DiffView';
import { FileTree } from './FileTree';
import { FileView } from './FileView';
import { Icon } from './Icon';
import { ThemeToggle } from './ThemeToggle';
import { WatchBadge } from './WatchBadge';

/**
 * 侧栏那两个 tab。位置对应 VS Code 的 activity bar，**画成两枚紧挨着靠左的图标，但仍是横排
 * 一行、不切一列竖排**：竖排要再占一列宽，而 320px 里那一列是从文件名身上扣的，两个视图也用
 * 不着一整列。
 *
 * `Changes` 那枚**与状态条上分支名前的是同一枚 `GitBranch`**（对应 VS Code activity bar 上的
 * Source Control）。两处 import 同一个具名组件，**「同一枚」这件事因此由编译器保证**——拼错标
 * 识符是编译错误，而共用一条 path 字符串的老做法里，两份漂开之后同一个概念在页面上就是两个
 * 图形，没有任何东西会响。`Files` 那枚是 `Folder`。
 *
 * `label` 不再进 DOM 文本，改作 `aria-label` 与 tooltip：只画图标时它是这个按钮名字的**唯一**
 * 来源，掉了之后读屏里就是两个无名控件，而页面上什么都看不出来（同 `ThemeToggle`）。
 */
const TABS = [
  { id: 'changes', label: 'Changes', icon: GitBranch },
  { id: 'files', label: 'Files', icon: Folder },
] as const;

// **不给 `flex-1`**：两枚各按自身宽度排、紧挨着靠左，平分整栏时选中那条下划线有半栏宽，看着
// 不像指示器像第二条分隔线。`px-3 py-1.5` 留着当点击热区（约 40×28px 一枚）。`flex` 只为把图标
// 从行内排版里摘出来（免掉替换元素在基线下方那点空隙），**不写居中类**：按钮的两个方向都由内容
// 精确撑满，没有多余空间可分，写了只会让人以为这里在补偿什么。
//
// 选中那条短线走 `border-editor-foreground`（照 VS Code 经典 Dark+ 的 activity bar 活动边框），
// **不用 `focus-border`**：后者是「键盘焦点在这里」那件事的颜色，而这一行的 focus-visible 轮廓
// 正用着它——两处同色时，「选中的是哪个 tab」与「焦点在哪个 tab 上」在页面上化成同一种蓝。
// 与选中图标本身同色，一枚图标加它底下那条线于是连成一体。
//
// **`-mb-px` 让这条边压在容器那条 `border-b` 上**：两条边本来上下相邻而不是重叠（按钮的画在
// 自己 border box 内、容器的画在其外），于是选中那一段是 1px 前景色 + 1px 分隔线的双线，比未
// 选中处厚一倍——不报错，只是那条线看着没做细
const TAB_CLASS =
  '-mb-px flex border-b px-3 py-1.5 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-border';

function SideBarTabs() {
  const active = activeTab.value;
  return (
    // tablist/tab 三件套：两个按钮控制的是同一片区域，只靠视觉差异说不清这件事。
    // 这一层的 border-b 横贯整栏，选中下划线是画在它上面的一小段
    <div class="flex shrink-0 border-b border-panel-border" role="tablist">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          aria-label={tab.label}
          title={tab.label}
          /**
           * **只改 `activeTab`，绝不碰 `activePane`**：换的是左栏在列什么，不是用户此刻在读
           * 什么——写成「切到 Files 就清空右侧」时页面看着完全正常，只是每瞄一眼目录树就丢掉
           * 正在读的那份 diff。
           */
          onClick={() => {
            activeTab.value = tab.id;
          }}
          class={`${TAB_CLASS} ${
            active === tab.id
              ? 'border-editor-foreground text-editor-foreground'
              : 'border-transparent text-description-foreground hover:bg-list-hover-background'
          }`}
        >
          <Icon icon={tab.icon} />
        </button>
      ))}
    </div>
  );
}

export function App() {
  const state = repoState.value;
  const error = loadError.value;
  const tab = activeTab.value;
  const pane = activePane.value;
  const diffPanel = useRef<HTMLElement>(null);

  /**
   * 切到 `Files` 那一档时把树接上，**两件一起做**：
   *
   * - `loadDir(ROOT)` 取根那一层。**不在挂载时预取**：冷启动门禁量的是「监听成功并打印
   *   URL」，而这条请求要跑一趟 `ls-files`，预取等于把一个多数会话根本用不到的开销摆进首屏。
   *   它自带「取过就不再取」，所以这里不必自己记。
   * - `refreshTree()` 把展开着的层刷新一遍。**这是「刷新只给看得见的那一半付钱」的另一半**
   *   （见 `store.ts` 的 `refresh`）：不看这一档时 SSE 不重取树，切回来时就得补上，否则页面
   *   上是一份停在离开那一刻的旧目录。
   */
  useEffect(() => {
    if (tab !== 'files') return;
    void loadDir(ROOT);
    refreshTree();
  }, [tab]);

  // diff 版式的**唯一**测量点。本组件只管「量哪个元素、什么时候开始和停」——量法与阈值都在
  // `state/layout.ts`，两者是一个取舍的两半。量的是这个 `<section>` 而不是 DiffView 底下那个
  // 宿主 div：前者从挂载到卸载一直在，后者每换一个文件就重建一次，观察者会跟着反复拆建
  useEffect(() => {
    const panel = diffPanel.current;
    return panel === null ? undefined : observeDiffPanel(panel);
  }, []);

  // 配色一律走 VS Code token，不用 Tailwind 自带调色板：后者在深色下不会跟着
  // 翻，得给每个元素再写一遍 dark: 变体，而本项目的深浅切换发生在 token 层
  return (
    <div class="flex h-screen bg-editor-background text-editor-foreground">
      {/* 左栏自己是一列：顶栏、错误条与状态条都 shrink-0 钉住，中间那层列表独自滚 */}
      <aside class="flex w-80 shrink-0 flex-col border-r border-panel-border bg-side-bar-background">
        {/* 顶栏写的是项目名（工作区根目录名），不是产品名——这一栏回答的是「我在看哪个
            项目」。**`truncate` 落在装名字的那个 span 上，不是 header 上**：顶栏是 flex 容器，
            而 `truncate` 写在容器上不起作用，子项的自动最小尺寸照样把它撑开（长名漫过右边框
            压到 diff 面板上），而 `truncate` 字样还在原地、看着像是已经处理过了。
            `min-w-0` 是那个 span 能真的裁的前提；开关 `shrink-0`，被裁的永远是名字 */}
        <header class="flex shrink-0 items-center gap-2 border-b border-panel-border bg-title-bar-background px-3 py-2 text-sm font-medium">
          <span class="min-w-0 flex-1 truncate">{state?.repoName || PRODUCT_NAME}</span>
          <ThemeToggle />
        </header>

        <SideBarTabs />

        {/* break-words 是搬进 320px 之后才需要的：这条文案是 git 的原话，里面那截路径是一个
            不带断点的长词，在这一列里会漫过右边框压到 diff 面板上——不报错，只是错位 */}
        {error !== null && (
          <p class="shrink-0 border-b border-warning-border bg-warning-background px-3 py-2 text-sm break-words">
            {error}
          </p>
        )}

        {/* 两个视图**共用这一层滚动容器**：左右两栏各一个滚动容器是既有约定（SSE 刷新要留住
            列表的滚动位置），tab 不是第三个。flex 的自动最小尺寸只在该轴 overflow:visible 时
            才解析成 min-content，所以 `min-h-0` 与 `overflow-auto` 各自都足以把它归零——两个
            都没有时列表会把整列撑高、把状态条挤出屏幕底部 */}
        <nav class="min-h-0 flex-1 overflow-auto">
          {tab === 'files' ? (
            <FileTree />
          ) : state === null ? (
            // 第一次就失败时不能继续说「读取中」——那份加载态永远不会结束，
            // 页面看上去像卡住了，而错误条其实已经把原因写在上面了
            <p class="px-3 py-2 text-sm text-description-foreground">
              {error === null
                ? 'Loading…'
                : 'Could not load the change list. Reload the page to retry.'}
            </p>
          ) : (
            <ChangeList files={state.files} />
          )}
        </nav>

        {/* 分支状态与监听标注都只在拿到第一份 state 之后才画：没有它时整条状态条不画，而不是
            先画一个「未知分支 无上游」再被真实取值换掉——后者两秒内说了一句假话，而「无上游」
            恰恰是要区分开的那个真实状态。**一个 guard 包住两项**，不是每项各写一次。
            状态条不给自己的底色：左栏那层已经上过，分隔靠一条 border-t */}
        {state !== null && (
          <footer class="flex shrink-0 items-baseline gap-2 border-t border-panel-border px-3 py-1">
            <BranchStatus branch={state.branch} />
            <WatchBadge watch={state.watch} />
          </footer>
        )}
      </aside>

      {/* diff 容器自己滚：列表侧的滚动位置在 SSE 刷新时要留住，
          两侧共用一个滚动容器就做不到 */}
      <section ref={diffPanel} class="min-w-0 flex-1 overflow-auto">
        {pane === 'file' ? <FileView /> : <DiffView />}
      </section>
    </div>
  );
}
