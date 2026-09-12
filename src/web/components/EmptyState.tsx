// 两侧**空着**时画的那几块，都居中在各自的区域正中：右侧面板一枚图标 + 一句提示，左栏一句。
//
// 右侧那块只给「没选文件」这一个状态用。loading / error / binary / too-large / symlink 那几路
// 仍是 `Notice` 贴左上——它们在标签栏底下的 `Panel` 里，说的是「这个文件怎么了」而不是「面板
// 空着」，居中反而让它们看着像整个面板坏了。**不做成 `Notice` 的一个 `centered` 开关**：那是
// 一个不填也不报错的可选参数，每个调用点都得再想一遍。
//
// **居中成立的前提是撑满宿主，两侧各有各的手段**：宿主是 flex 列时给 `flex-1 min-h-0`，是普
// 通块盒时给 `h-full`。不撑满时 `items-center` / `justify-center` 只在自己那点内容高度里居
// 中——页面上仍然贴顶，不报错（happy-dom 没有排版引擎，用例能钉的只有这几个类名在不在）。
// 两块**不合成一个带可选 `icon` 的组件**：那又是一个不填也不报错的开关，且合成之后它得同时
// 带两种撑满手段，看不出自己在哪种宿主里。

import { CircleCheck, FileCode, FileDiff, type LucideIcon } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { activeTab, repoState } from '../state/store';
import { Icon } from './Icon';

/**
 * 左栏列表区的占位：`Loading…`、「取不到列表」与「工作区干净」三句共用。**三句一起居中而不是只
 * 居中干净那句**：它们轮流占同一个 `<nav>`，各摆各的位置时，干净仓库一启动就是「Loading…」贴
 * 左上、几百毫秒后跳到正中——不报错，只是每次启动闪一下。不配图标：320px 里那枚比一行字更抢，
 * 而右侧面板同一时刻已经画着一个 ✓。
 */
export function SidebarPlaceholder({ children }: { children: ComponentChildren }) {
  return (
    // 宿主 `<nav>` 是普通块盒（`min-h-0 flex-1 overflow-auto`），撑满靠 `h-full`；它能解析是因为
    // `<nav>` 自己是定高 flex 列里的一项
    <p class="flex h-full items-center justify-center px-3 text-center text-sm text-description-foreground">
      {children}
    </p>
  );
}

function EmptyState({ icon, children }: { icon: LucideIcon; children: ComponentChildren }) {
  return (
    // 宿主 `<section>`（`App`）是一列 flex，撑满靠 `flex-1 min-h-0`——后者与面板里别的直接子项
    // 同款，flex 的自动最小尺寸在这里一样会作怪
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-sm text-description-foreground">
      {/* 图标只是装饰，走同一个 `Icon` 外壳拿 `aria-hidden`。48px 下 lucide 默认的 2px 描边显
          得粗，`stroke-1` 收细（CSS 属性压过 SVG 的 presentation attribute）；`opacity-60` 与被
          忽略文件灰显同一档——它不该比旁边的文案更抢。颜色不写：`currentColor` 跟着文字色翻深浅 */}
      <Icon icon={icon} size={48} class="stroke-1 opacity-60" />
      <p class="text-center">{children}</p>
    </div>
  );
}

/**
 * 栏里一个 tab 都没有时右侧画的那一块，由 `App` 画，**判据只在这里写一次**。两个视图自己不再
 * 有空态分支：它们拿到的永远是一个存在的 tab。
 *
 * 说哪句、配哪枚**按侧栏此刻列的是哪一档定**：空着时右侧没有「此刻是哪个视图」可言，而侧栏
 * 档位说的正是「用户接下来会点开哪种东西」。
 *
 * - `Changes` 档且工作区干净：`Working tree clean.` 配一个 ✓。「没得选」与「还没选」是两件
 *   事——干净时「点左边一个文件」指着的是一个空列表。与左栏那句 `No changes.` 刻意不逐字相
 *   同：一句说的是列表，一句说的是仓库；✓ 已经把「没得看」带上，不再另说一遍。
 * - 其余一律 `Select a file on the left.`：**`Files` 档下即使干净也走这句**，那一档列的是整棵
 *   目录树，「Working tree clean」对着一列能点的文件答非所问。图标跟着档走：`Changes` 是一份
 *   diff（`FileDiff`），`Files` 是一份全文（`FileCode`）——两档打开同一个文件看到的是两样东
 *   西，图标在空着时就把这一点说出来。
 * - 第一份 state 还没到（`repoState` 为 null）时走「还没选」那句——左栏此时写的正是
 *   `Loading…`，两栏说的是同一件事。
 */
export function PanelEmptyState() {
  const tab = activeTab.value;
  if (tab === 'changes' && repoState.value?.files.length === 0) {
    return <EmptyState icon={CircleCheck}>Working tree clean.</EmptyState>;
  }
  return (
    <EmptyState icon={tab === 'files' ? FileCode : FileDiff}>Select a file on the left.</EmptyState>
  );
}
