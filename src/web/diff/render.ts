// 一份补丁 → 带好颜色的行。画成 DOM 归 `DiffView.tsx`，这里只产出数据与每行的 HTML 片段。
//
// **按行高亮，切分仍是 diff2html 的那三个导出**：`closeTags` / `nodeStream` / `mergeStreams` 把一行
// 的高亮结果与这一行的词级 `<del>` / `<ins>` 交织回同一行、补齐被切断的标签。自研等于维护一份更
// 易出错的等价物——它们随 `highlight.js-helpers.js` 本就在产物里（`hljs.ts` 的第三道语言判定也
// 读那个模块）。

import {
  closeTags,
  mergeStreams,
  nodeStream,
} from 'diff2html/lib-esm/ui/js/highlight.js-helpers.js';

import { foldHunks, type Gap } from './fold';
import { createLineLanguage, getHljs } from './hljs';
import { type LineKind, type PatchLine, parsePatch } from './parse';
import { type Group, groupLines, type Range, wordRanges } from './rows';

/**
 * 一行画出来需要的全部东西。**`html` 与 `language` 是惰性的**：第一次读时才跑 hljs，折起来的那几
 * 段从没被画出来就从没被上色——否则一份 4 万行的文件改一行，取了整份上下文就得先把 4 万行全部高亮
 * 一遍。上色是逐行的，跳过一行不影响别的行；要按序吃全的只有语言判定器，它在 `prepareDiff` 里照常
 * 逐行喂。
 */
export interface DiffLine {
  readonly kind: LineKind;
  readonly oldNo: number | undefined;
  readonly newNo: number | undefined;
  /** hljs 输出（已转义），词级标记已交织进去，可直接写进 `innerHTML` */
  readonly html: string;
  /** hljs 报回来的语言名，挂成正文上的 class（与 `.hljs` 一起，同上游的挂法） */
  readonly language: string | undefined;
}

/** 一串照常画的行（已配好对），或折起来的一段（只有上下文行）。 */
export type PreparedBlock = { kind: 'lines'; groups: Group<DiffLine>[] } | Gap<DiffLine>;

export interface PrepareOptions {
  /** 这份补丁是不是按 `-w` 取的。**取的时候那一档**，不是此刻开关的值。 */
  ignoreWhitespace: boolean;
  /** payload 的 `full`：补丁带不带整份上下文。 */
  full: boolean;
}

/**
 * 解析、折叠、配对、上色一次做完。**与版式无关**：两种版式共用同一份结果，切版式只是换一种排法，
 * 不重新高亮——调用方按 `[path, patch, 两个选项]` 缓存它。
 *
 * **语言判定器旧侧一个、新侧一个**，各自吃自己那一侧的连续行序（上下文行两侧都吃，折起来的也吃）。
 * 判定器是个状态机（单文件组件在 `<script>` / `<style>` 里换语言），状态属于「一条连续的行序」，而
 * 文件的旧版本与新版本各是一条。**每个文件段重新造一对**：类型变了的路径有两段，是两个文件版本。
 * 上下文行两侧判出来的语言不同时（区块边界恰好在这一段里变了）取新侧的：同一行只上一次色，并排
 * 两侧显示的是同一份 HTML。
 *
 * **忽略空白的补丁里词级区间不计空白**：一行同时改了内容与缩进时只标内容那几段。
 *
 * **`path` 是语言判据的来源**，与文件视图共用 `languageOf()`（经 `createLineLanguage()`）。
 */
export function prepareDiff(
  path: string,
  patch: string,
  { ignoreWhitespace, full }: PrepareOptions,
): PreparedBlock[] {
  return parsePatch(patch).flatMap((section) => {
    const oldLanguageAt = createLineLanguage(path);
    const newLanguageAt = createLineLanguage(path);
    const context = (line: PatchLine): DiffLine => {
      oldLanguageAt(line.text);
      return toLine(line, newLanguageAt(line.text));
    };
    return foldHunks(section, full).map((block): PreparedBlock => {
      if (block.kind === 'gap') return { ...block, lines: block.lines.map(context) };
      return {
        kind: 'lines',
        groups: groupLines(block.lines).map((group): Group<DiffLine> => {
          if (group.kind === 'context') return { kind: 'context', line: context(group.line) };
          // 只有配上对的那几行有词级差异；多出来的那侧整行就是差异本身。两侧各自按序 map，判定器
          // 吃到的仍是自己那一侧的连续行序
          const ranges = group.deleted.map((line, i) => {
            const partner = group.inserted[i];
            return partner ? wordRanges(line.text, partner.text, ignoreWhitespace) : null;
          });
          return {
            kind: 'change',
            deleted: group.deleted.map((line, i) =>
              toLine(line, oldLanguageAt(line.text), ranges[i]?.deleted, 'del'),
            ),
            inserted: group.inserted.map((line, i) =>
              toLine(line, newLanguageAt(line.text), ranges[i]?.inserted, 'ins'),
            ),
          };
        }),
      };
    });
  });
}

/** 词级标记：`marks` 为空即没有（上下文行、没配上对的那侧）。上色留到第一次读 `html` 时。 */
function toLine(
  line: PatchLine,
  language: string,
  marks: readonly Range[] = NO_MARKS,
  tag: 'del' | 'ins' = 'del',
): DiffLine {
  return new LazyLine(line, language, marks, tag);
}

const NO_MARKS: readonly Range[] = [];

/**
 * `DiffLine` 的实现。**getter 放在原型上、只拷要用的那几格**，不写成对象字面量加闭包：一行一份的
 * 闭包是三个函数对象加一个作用域，而整份上下文的补丁动辄几万行、每个改了内容的 SSE 都重建一遍。上色
 * 之后正文与标记都用不着了，一并放掉，只留结果。
 */
class LazyLine implements DiffLine {
  readonly kind: LineKind;
  readonly oldNo: number | undefined;
  readonly newNo: number | undefined;
  #text: string;
  #language: string;
  #marks: readonly Range[];
  #tag: 'del' | 'ins';
  #result: { html: string; language: string | undefined } | undefined;

  constructor(line: PatchLine, language: string, marks: readonly Range[], tag: 'del' | 'ins') {
    this.kind = line.kind;
    this.oldNo = line.oldNo;
    this.newNo = line.newNo;
    this.#text = line.text;
    this.#language = language;
    this.#marks = marks;
    this.#tag = tag;
  }

  #highlighted() {
    if (this.#result === undefined) {
      this.#result = highlightLine(this.#text, this.#language, this.#marks, this.#tag);
      this.#text = '';
      this.#marks = NO_MARKS;
    }
    return this.#result;
  }

  get html(): string {
    return this.#highlighted().html;
  }

  get language(): string | undefined {
    return this.#highlighted().language;
  }
}

type NodeEvent = Parameters<typeof mergeStreams>[0][number];

/**
 * 给一行代码上色，词级标记（若有）交织进去。返回可直接写进 `innerHTML` 的 HTML。
 *
 * 词级标记的事件流**直接由区间造**，与 `nodeStream` 对一个搭好 `<del>` / `<ins>` 的元素取出来的
 * 逐条同形——不必为每一对改动行先搭一棵 DOM 再拆回来。`mergeStreams` 按字符偏移把它与 hljs 的流
 * 合并，两份流的偏移都按同一个 `text` 计。hljs 那一侧仍要经 `innerHTML` 解析一次：它给的是字符
 * 串，事件流只能从节点里取。
 */
function highlightLine(
  text: string,
  language: string,
  marks: readonly Range[],
  tag: 'del' | 'ins',
): { html: string; language: string | undefined } {
  const result = closeTags(
    // ignoreIllegals：补丁给的是片段，一行代码在语法上「不合法」是常态
    getHljs().highlight(text, { language, ignoreIllegals: true }),
  );
  if (marks.length) {
    // 一行一个标记元素就够：`mergeStreams` 只读它的标签名与（空的）属性表
    const node = document.createElement(tag);
    const stream = marks.flatMap(({ start, end }): NodeEvent[] => [
      { event: 'start', offset: start, node },
      { event: 'stop', offset: end, node },
    ]);
    const rendered = document.createElement('div');
    rendered.innerHTML = result.value;
    result.value = mergeStreams(stream, nodeStream(rendered), text);
  }
  return { html: result.value, language: result.language };
}
