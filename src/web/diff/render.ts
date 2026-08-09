// diff2html 渲染(spec §5.5)。
//
// `html()` 本身不做语法高亮 —— 高亮在 `Diff2HtmlUI.highlightCode()`,它依赖
// highlight.js-helpers 的 closeTags / nodeStream / mergeStreams / getLanguage:
// 先把整个文件的代码合起来交给 hljs,再按 diff 的行边界切回、补齐跨行未闭合的标签。
// 自行重写这段切分逻辑不在本项目要解决的问题之列。
//
// 被排除的是三个预构建 UI bundle(-ui / -ui-slim / -ui-base),**不是** UI 层源码:
// 深导入下面的 diff2html-ui-base ESM 源码模块参与 tree-shaking、hljs 实例由我们注入,
// 是允许且推荐的。ColorSchemeType 只取类型 —— enum 作为值 import 会把整个枚举对象
// 带进产物,而我们只需要字面量 'light'(为什么是它见下面 colorScheme 那段)。

import type { ColorSchemeType } from 'diff2html/lib-esm/types.js';
import { Diff2HtmlUI } from 'diff2html/lib-esm/ui/js/diff2html-ui-base.js';

import { getHljs } from './hljs';

/**
 * 把一段 unified diff 渲染进 target 并高亮。
 *
 * 调用方必须在 Preact 的 ref/effect 之后调用 —— `draw()` 内部是 `innerHTML` 赋值
 * 加命令式事件绑定,不能与 vdom 争夺同一棵子树(spec §5.5)。
 */
export function renderDiff(target: HTMLElement, patch: string): void {
  const ui = new Diff2HtmlUI(
    target,
    patch,
    {
      // 用不到的开关一律关掉,只留 highlight
      synchronisedScroll: false,
      fileListToggle: false,
      fileContentToggle: false,
      stickyFileHeaders: false,
      highlight: true,
      drawFileList: false,
      outputFormat: 'side-by-side',
      /**
       * **必须是 'light',不能是 'auto'**(spec §5.6 / §5.5)。
       *
       * 这不是"只支持浅色"—— 恰恰相反,它是深色能按 VS Code 取值出来的前提。
       * diff2html 的深色配色由容器上的 class 门控:'auto' 输出 `.d2h-auto-color-scheme`,
       * 对应规则整块包在 d2h 自带的那个 `@media (prefers-color-scheme: dark)` 里、读的是
       * **另一套** `--d2h-dark-*`,而特异性 (0,2,0) 稳压基础规则 (0,1,0) ——
       * 于是 vscode-theme.css 覆写的那 23 个 `--d2h-*` 在深色下一条都不生效,
       * 页面只是"深色不太像 VS Code",不报错。
       *
       * 'light' 输出的 `.d2h-light-color-scheme` 在 d2h 的 CSS 里一条规则都没有(实测),
       * 全部配色因此落在无前缀的基础规则上,深浅由我们自己那套 token 承担。
       * 顺带避开 3.4.56 的一处缺口:auto 块里 `.d2h-deleted` 挂错成了
       * `.d2h-dark-color-scheme .d2h-deleted`,auto 模式下深色永远盖不到它。
       *
       * 改回 'auto' 会被 test/unit/web/render.test.ts 那条 class 断言拦下。
       */
      colorScheme: 'light' as ColorSchemeType,
    },
    getHljs(),
  );
  // highlight: true 时 draw() 内部已经调过 highlightCode(),这里不能再补一次:
  // 第二遍读到的 textContent 仍是纯文本,但 nodeStream() 拿到的已是第一遍插入的
  // hljs-* span,mergeStreams 会把两份流交织成嵌套重复的 span,开销也白付一倍。
  ui.draw();
}
