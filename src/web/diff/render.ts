// diff2html 渲染。
//
// `html()` 本身不做语法高亮——高亮在 `Diff2HtmlUI.highlightCode()`，它依赖
// highlight.js-helpers 的 closeTags / nodeStream / mergeStreams / getLanguage：先把整个文件
// 的代码合起来交给 hljs，再按 diff 的行边界切回、补齐跨行未闭合的标签。自行重写这段切分逻辑
// 不在本项目要解决的问题之列。
//
// 被排除的是三个预构建 UI bundle(-ui / -ui-slim / -ui-base)，**不是** UI 层源码：深导入下面
// 的 diff2html-ui-base ESM 源码模块参与 tree-shaking、hljs 实例由我们注入，是允许且推荐的。
// ColorSchemeType 只取类型——enum 作为值 import 会把整个枚举对象带进产物，而我们只需要字面
// 量 'light'。OutputFormatType **不是** enum，是个普通的字符串联合，所以它不需要那样的 cast
//——别照着上一行给它也套一个。

import type { ColorSchemeType, OutputFormatType } from 'diff2html/lib-esm/types.js';
import { Diff2HtmlUI } from 'diff2html/lib-esm/ui/js/diff2html-ui-base.js';
import {
  closeTags,
  mergeStreams,
  nodeStream,
} from 'diff2html/lib-esm/ui/js/highlight.js-helpers.js';

import { createLineLanguage, getHljs } from './hljs';

/**
 * diff2html 的两种版式——**别名，不是第二份声明**：自己写一遍 `'side-by-side' |
 * 'line-by-line'` 要配一个 `as OutputFormatType` 才塞得进配置对象，而那个 cast 正好会在上游加
 * 出第三种版式时**把分叉压住不报**。名字留在这里而不搬去 `state/layout.ts`：它描述的是
 * diff2html 的配置面，而「什么时候用哪个」才是状态那侧的判据。
 */
export type DiffOutputFormat = OutputFormatType;

/**
 * 把一段 unified diff 渲染进 target 并高亮。调用方必须在 Preact 的 ref/effect 之后调用——
 * `draw()` 内部是 `innerHTML` 赋值加命令式事件绑定，不能与 vdom 争夺同一棵子树。
 *
 * **`path` 是语言判据的来源**，与文件视图共用 `languageOf()`：diff2html 自己那条判据是「文件
 * 名最后一段扩展名 → 它内置的 `languagesToExt`」，而那张表里没有 `vue` / `env` / `svelte` 之
 * 类，也够不着 `.env.local` 这种多段名——症状是这些文件在两个视图里都静默没有颜色。
 */
export function renderDiff(
  target: HTMLElement,
  path: string,
  patch: string,
  format: DiffOutputFormat,
): void {
  const ui = new Diff2HtmlUI(
    target,
    patch,
    {
      // 用不到的开关一律关掉，留下的是紧随其后那条 synchronisedScroll
      fileListToggle: false,
      fileContentToggle: false,
      stickyFileHeaders: false,
      /**
       * **高亮整个归 `highlightLines()`（见文件末），这里必须关掉。**
       *
       * `highlightCode()` 对一个文件只认一个语言（每个 `.d2h-file-wrapper` 上的 `data-lang`），
       * 而单文件组件一份文件里有三种。开着它就是**两遍高亮**：第二遍读到的 `textContent` 仍是
       * 纯文本，但 `nodeStream()` 拿到的已是第一遍插入的 hljs span，`mergeStreams` 把两份流交
       * 织成嵌套重复的 span，开销也白付一倍。
       */
      highlight: false,
      drawFileList: false,
      /**
       * **并排两侧的横向联动**。两半各是一个独立的滚动容器（`.d2h-file-side-diff` 自带
       * `overflow-x: scroll`），关掉这一条时横向拖一侧去看长行、另一侧原地不动，同一行的新旧
       * 内容错开成两个列位置——并排存在的理由正好在需要横滚时失效。逐行版式下这一步是空操
       * 作，两种版式因此共用同一份配置；绑定发生在 `draw()` 刚写出来的节点上，而它整片覆盖
       * `innerHTML`，重画不叠加，也不必自己解绑。
       *
       * **已知取舍**：互相回写 `scrollLeft` 时分不出「用户滚的」与「回写引起的」，越过窄侧上
       * 限的那一下会把宽侧拽回窄侧的上限——边界处顿一下，之后继续正常滚。
       */
      synchronisedScroll: true,
      /**
       * **由调用方给，且必填、不给默认值**：漏传时要的是 `tsc` 当场报错，而不是静默退回并排
       *——后者的症状是「这个视图怎么不跟着窗口变」。判据本身归 `state/layout.ts`。
       */
      outputFormat: format,
      /**
       * **必须是 'light'，不能是 'auto'**——这不是"只支持浅色"，恰恰相反，它是深色能按
       * VS Code 取值出来的前提。diff2html 的深色配色由容器上的 class 门控：'auto' 输出
       * `.d2h-auto-color-scheme`，对应规则整块包在它自带的那个 `@media (prefers-color-scheme:
       * dark)` 里、读的是**另一套** `--d2h-dark-*`，而特异性 (0,2,0) 稳压基础规则 (0,1,0)——
       * 于是 vscode-theme.css 覆写的那 23 个 `--d2h-*` 在深色下一条都不生效，页面只是"深色不
       * 太像 VS Code"，不报错。
       *
       * 'light' 输出的 `.d2h-light-color-scheme` 在 d2h 的 CSS 里一条规则都没有，全部配色因此
       * 落在无前缀的基础规则上，深浅由我们自己那套 token 承担。顺带避开 3.4.56 的一处缺口：
       * auto 块里 `.d2h-deleted` 挂错成了 `.d2h-dark-color-scheme .d2h-deleted`。
       */
      colorScheme: 'light' as ColorSchemeType,
    },
    getHljs(),
  );
  // draw() 只写 innerHTML 与绑那对滚动联动，不高亮（highlight: false，理由见上）
  ui.draw();
  highlightLines(target, path);
}

/**
 * 逐行上色。**替掉的是 `Diff2HtmlUI.highlightCode()` 的那个 `forEach`，不是它的切分逻辑**——
 * `closeTags` / `nodeStream` / `mergeStreams` 三个仍是 diff2html 的导出，原样调用：把一行的高亮
 * 结果与这一行已有的 `<del>` / `<ins>` 词级标记合流、补齐被切断的标签，是它们的活，自研等于维
 * 护一份更易出错的等价物。
 *
 * **自研的只有「这一行用哪个语言」**：上游那个循环对整个文件只取一次 `data-lang`，而单文件组件
 * 一份文件里有三种语言（模板 / 脚本 / 样式）。判定器由 `createLineLanguage()` 给，状态机住在
 * `hljs.ts`——语言的事继续只在那一个文件里。
 *
 * **一张表一个判定器**：状态属于「一条连续的行序」，而并排版式下 `.d2h-diff-table` 有两张（左
 * 旧右新），各自内部才连续。共用一个的话，右栏开头继承的是左栏末尾的状态——两栏行数相同时它
 * 恰好总被右栏的上下文行重置回来（试出来的：这条**造不出失败用例**，所以没有配测试），但那是
 * 巧合不是判据，两栏内容一错开就不成立。
 */
function highlightLines(target: HTMLElement, path: string): void {
  const hljs = getHljs();
  for (const table of target.querySelectorAll('.d2h-diff-table')) {
    const languageAt = createLineLanguage(path);
    for (const line of table.querySelectorAll('.d2h-code-line-ctn')) {
      const text = line.textContent;
      if (text === null) continue;
      const result = closeTags(
        // ignoreIllegals：补丁给的是片段，一行代码在语法上「不合法」是常态
        hljs.highlight(text, { language: languageAt(text), ignoreIllegals: true }),
      );
      const original = nodeStream(line);
      if (original.length) {
        // 这一行里已经有 diff2html 画的词级 <del> / <ins>，两份流得交织回一行
        const rendered = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
        rendered.innerHTML = result.value;
        result.value = mergeStreams(original, nodeStream(rendered), text);
      }
      line.classList.add('hljs');
      if (result.language) line.classList.add(result.language);
      line.innerHTML = result.value;
    }
  }
}
