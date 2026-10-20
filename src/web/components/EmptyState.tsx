// 两侧**空着**时画的那几块，都居中在各自的区域正中：右侧面板一列快捷键，左栏一句。
//
// 右侧那块只给「没选文件」这一个状态用。loading / error / binary / too-large / symlink 那几路
// 仍是 `Notice` 贴左上——它们在标签栏底下的 `Panel` 里，说的是「这个文件怎么了」而不是「面板
// 空着」，居中反而让它们看着像整个面板坏了。**不做成 `Notice` 的一个 `centered` 开关**：那是
// 一个不填也不报错的可选参数，每个调用点都得再想一遍。
//
// **居中成立的前提是撑满宿主，两侧各有各的手段**：宿主是 flex 列时给 `flex-1 min-h-0`，是普
// 通块盒时给 `h-full`。不撑满时居中只发生在自己那点内容高度里——页面上仍然贴顶，不报错
// （happy-dom 没有排版引擎，用例能钉的只有类名在不在）。

import { type ComponentChildren, Fragment } from 'preact';
import { SHORTCUTS, shortcutKeys } from '../state/shortcuts';

/**
 * 左栏列表区的占位：`Loading…` 与「取不到列表」两句共用。**两句一起居中**：它们轮流占同一个
 * `<nav>`，各摆各的位置时，首次加载失败就是「Loading…」贴左上、随即跳到正中——不报错，只是闪
 * 一下。`History` 分区的 `Loading…` / 取不到 / `No commits yet` 同理也用它。不配图标：320px 里
 * 那枚比一行字更抢。
 */
export function SidebarPlaceholder({ children }: { children: ComponentChildren }) {
  return (
    // 宿主 `<nav>` 是普通块盒（`min-h-0 flex-1 overflow-auto`），撑满靠 `h-full`；它能解析是因为
    // `<nav>` 自己是定高 flex 列里的一项
    <p class="flex h-full items-center justify-center px-3 text-center text-description-foreground">
      {children}
    </p>
  );
}

/**
 * 栏里一个 tab 都没有时右侧画的那一块，由 `App` 按「没有活动 tab」判一次。两个视图自己不再
 * 有空态分支：它们拿到的永远是一个存在的 tab。
 *
 * 照 VS Code 的空编辑区列一列全局快捷键，**不说「点左边一个文件」**——左栏就在旁边，这句不带
 * 信息。VS Code 在列表上方还有一枚大号 logo 水印，这里不画：放在这个面板里看着突兀。
 *
 * 也不说「工作区干净」：左栏 `Changes` 档空着已经答了「为什么没得看」。
 */
export function PanelEmptyState() {
  return (
    // 宿主（`EditorGroupView` 的根元素）是一列 flex，撑满靠 `flex-1 min-h-0`——后者与面板里别的直接子项
    // 同款，flex 的自动最小尺寸在这里一样会作怪。
    //
    // **居中靠里层的 `m-auto`，不靠外层的 `justify-center`**：面板比这一块矮时 `justify-center`
    // 往上下两头等量溢出，顶上那截落在滚动原点之前、滚不到；auto margin 在放不下时归零，内容从顶
    // 上排起、外层 `overflow-auto` 照常能滚。
    <div class="flex min-h-0 flex-1 flex-col overflow-auto p-4 text-sm text-description-foreground">
      {/* 两列 grid、宽度随内容：名字靠左、按键靠右，中间只隔一段 `gap-x-8`。定宽时两列之间空出
          一大截，名字与它的按键看着不像一行 */}
      <dl class="m-auto grid grid-cols-[auto_auto] items-center gap-x-8 gap-y-2">
        {Object.values(SHORTCUTS).map((shortcut) => (
          <Fragment key={shortcut.label}>
            <dt>{shortcut.label}</dt>
            {/* 按键只给眼睛看：读屏把 `⇧⌘F` 逐个念成符号名，没有意义——与按钮 tooltip 里快捷键
              不进无障碍名同一条理由 */}
            <dd aria-hidden="true" class="flex justify-end gap-1">
              {shortcutKeys(shortcut).map((key) => (
                <kbd
                  key={key}
                  class="min-w-5 rounded border border-keybinding-label-border border-b-keybinding-label-bottom-border bg-keybinding-label-background px-1 text-center font-sans text-xs"
                >
                  {key}
                </kbd>
              ))}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
