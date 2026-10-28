// 单个文件的只读全文（`FilePayload`）。
//
// **这不是 diff**：每一行前面不挂 `+`、底色不是新增绿——「看项目整体面貌」正是要摆脱补丁
// 视角。因此它不走 diff 的表格，只用 hljs 高亮一次，行号另起一栏。文件在变更列表里时行号槽右缘
// 多一列 3px 的改动标记（照 VS Code 的 quick diff），那是点缀，不把文件读成补丁。
//
// 五个 `kind` 全部在这里分支，提示行与 DiffView 共用同一个 `Notice`，图片与 SVG 预览与它共用
// `ImageView`；markdown 按渲染画时交给 `MarkdownView`。

import { Component } from 'preact';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import type { FilePayload, FilePreview } from '../../server/shared/protocol';
import { getHljs, languageOf } from '../diff/hljs';
import type { LineMark, MarkKind } from '../diff/marks';
import { lineCountOf, splitHighlighted } from '../diff/render';
import { revealRequest } from '../state/editors';
import { fileMarkStates, fileStates, shownMarkdown, shownPreview, wordWrap } from '../state/store';
import { ErrorDetail, Notice, Panel, tooLargeNotice } from './DiffView';
import { ImageFile } from './ImageView';
import { MarkdownView } from './MarkdownView';

/**
 * 正文 + 行号（不换行档）。
 *
 * **行号是兄弟元素，不按行切高亮输出**：行高固定时两个 `<pre>` 共用同一个 `leading-5` 就对齐了，
 * 不必为此付一行一个元素的 DOM（那是自动换行档 `WrappedContent` 不得不付的）。行号槽
 * `sticky left-0`，横向滚代码时它留在左边。
 *
 * 容器上不挂 `hljs` 类，也用不着：15 条 token 规则（`.hljs-keyword` 之类）是独立选择器，不挂容
 * 器类照样命中。
 */
/**
 * 正文与行号共用的行高（px），即 `leading-5`。跳到第 N 行按 `(N - 1) × 行高` 算位置：正文是一整块 hljs
 * 输出、不按行切（理由见下），没有「第 N 行」这个元素可找。改 `leading-*` 或 `py-*` 时这里跟着改（`file-view.test.tsx` 钉着两头）。
 */
const LINE_HEIGHT = 20;
/** 正文那层的上内边距（px），即 `py-2`：第 1 行从它下面起排。 */
const PAD_TOP = 8;

/** 第 `line` 行（1 起）顶边距正文那层顶边的像素。跳行高亮带与改动标记共用，两处各算一遍会错开。 */
const lineTop = (line: number): number => PAD_TOP + (line - 1) * LINE_HEIGHT;

/**
 * 三种标记各自的类名。**写成字面量表**，不按 kind 拼：Tailwind 只扫字面量，拼出来的类名不进产物，
 * 标记静默变成透明。删除点是一枚朝右的三角（左边框实心、上下边框透明），尖指向正文。
 */
const MARK_CLASS: Record<MarkKind, string> = {
  added: 'w-[3px] bg-editor-gutter-added-background',
  modified: 'w-[3px] bg-editor-gutter-modified-background',
  deleted:
    'size-0 border-y-4 border-l-4 border-y-transparent border-l-editor-gutter-deleted-background',
};

/** 删除三角的半高（px，`border-y-4`）：三角的中线压在两行之间那条线上。 */
const DELETED_HALF = 4;

/**
 * 行号槽右缘的改动标记。位置与跳行高亮带同一套算法——正文不按行切，没有「第 N 行」可挂。挂在行号
 * `<pre>` 里（它 `sticky`，是这些绝对定位子元素的包含块），横向滚时跟着行号槽留在左边。
 */
function Marks({ marks }: { marks: readonly LineMark[] }) {
  return marks.map(({ kind, line, count }) => {
    const top = lineTop(line);
    return (
      <span
        key={`${kind}:${line}`}
        data-mark={kind}
        // `right-1`：落在行号槽的右内边距里，与正文隔开一点——贴着 `right-0` 时条子压在第一个字上
        class={`absolute right-1 ${MARK_CLASS[kind]}`}
        style={
          count === 0
            ? { top: `${top - DELETED_HALF}px` }
            : { top: `${top}px`, height: `${count * LINE_HEIGHT}px` }
        }
      />
    );
  });
}

function Content({
  path,
  content,
  reveal,
  marks,
}: {
  path: string;
  content: string;
  /** 要跳到并高亮的那一行（全仓搜索点进来的）；每次请求一个新对象，再点同一行也重新滚一次。 */
  reveal: { readonly line: number } | null;
  /** 相对 HEAD 的改动标记；文件不在变更列表里时为空。 */
  marks: readonly LineMark[];
}) {
  /**
   * 高亮一份 5MB 的正文不便宜，而每次重渲染（换主题、换选中）都会走到这里。**行号槽也在同
   * 一个 memo 里**：它同样要按 `\n` 切一遍整份正文，留在 memo 外的话 SSE 刷新时正文逐字节
   * 没变也照样重算一遍——而高亮那半正确地跳过了。
   */
  const { html, gutter } = useMemo(
    () => ({
      html: highlightFile(path, content),
      gutter: Array.from({ length: lineCountOf(content) }, (_, index) => index + 1).join('\n'),
    }),
    [path, content],
  );

  /**
   * 跳行：把高亮带滚到面板竖直居中。**只随请求本身跑**，不随正文：SSE 刷新换了内容时不该又把用户
   * 拽回那一行。`scrollIntoView` 滚的是最近的滚动祖先（`Panel`），`inline: 'nearest'` 不动横向。
   */
  const band = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (reveal !== null) band.current?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  }, [reveal]);

  return (
    // `relative isolate`：高亮带以这一层为包含块；`isolate` 起一个层叠上下文，带子的 `-z-10` 才落在
    // 正文之下而不是落到页面底色之下——绝对定位的元素默认画在在流内容之上，会把字盖淡
    <div class="relative isolate flex font-mono text-xs leading-5">
      {reveal !== null && (
        <div
          ref={band}
          aria-hidden="true"
          data-reveal-line={reveal.line}
          class="pointer-events-none absolute inset-x-0 -z-10 bg-editor-range-highlight-background"
          style={{
            top: `${lineTop(reveal.line)}px`,
            height: `${LINE_HEIGHT}px`,
          }}
        />
      )}
      {/* select-none：拖选正文时不该把行号一起选进剪贴板 */}
      <pre class="sticky left-0 shrink-0 bg-editor-background px-3 py-2 text-right text-description-foreground select-none">
        {gutter}
        <Marks marks={marks} />
      </pre>
      {/* dangerouslySetInnerHTML 的内容来自 hljs——它自己转义了正文里的一切标记 */}
      <pre class="min-w-0 py-2 pr-4" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/** 一行身上的一枚改动标记：竖条撑满这一行的高；删除点贴着这一行的顶边或底边。 */
interface RowMark {
  kind: MarkKind;
  edge?: 'top' | 'bottom';
}

/** 没有标记时的那份空表：每次渲染现造一个 `[]` 会让下游按 `marks` 记住的行表回回重算。 */
const NO_MARKS: readonly LineMark[] = [];

/**
 * 把按行号区间记的标记摊到每一行上（自动换行档用）。删除点落在第 `line` 行的顶边；`line` 比最后一行大一
 * （删的是文件末尾那几行）时没有那一行，改画在最后一行的底边——末行之前与文件末尾各删过一段时，末行上
 * 顶边、底边各一枚。
 */
function rowMarksOf(marks: readonly LineMark[], lineCount: number): Map<number, RowMark[]> {
  const rows = new Map<number, RowMark[]>();
  const push = (line: number, mark: RowMark) => {
    const row = rows.get(line);
    if (row === undefined) rows.set(line, [mark]);
    else row.push(mark);
  };
  for (const { kind, line, count } of marks) {
    if (kind !== 'deleted') {
      for (let n = line; n < line + count && n <= lineCount; n++) push(n, { kind });
    } else if (line <= lineCount) push(line, { kind, edge: 'top' });
    else if (lineCount > 0) push(lineCount, { kind, edge: 'bottom' });
  }
  return rows;
}

/**
 * 整份正文的 hljs 输出，**模块里只记最近一份**：切换自动换行是两种视图卸载重挂，各自的 `useMemo` 跟着
 * 丢，不记时每按一次开关就把一份 5MB 的正文从头高亮一遍，而正文一个字节都没变。只记一份是刻意的：
 * 它关掉 tab 后仍占着，多记就是多占。
 */
let lastHighlight: { path: string; content: string; html: string } | null = null;

function highlightFile(path: string, content: string): string {
  if (lastHighlight?.path !== path || lastHighlight.content !== content) {
    lastHighlight = {
      path,
      content,
      html: getHljs().highlight(content, { language: languageOf(path) }).value,
    };
  }
  return lastHighlight.html;
}

interface RowProps {
  line: number;
  html: string;
  marks: readonly RowMark[] | undefined;
  revealed: boolean;
  gutterWidth: string;
}

/**
 * 自动换行档的一行。**props 没变就不重画**（不用 `preact/compat` 的 `memo`，理由同 `QuickPick` 的
 * `Option`）：跳到另一行时真正变的只有新旧两行，标记换了也只是那几行，其余几万行停在原处。
 */
class Row extends Component<RowProps> {
  override shouldComponentUpdate(next: RowProps): boolean {
    const { props } = this;
    return (
      next.html !== props.html ||
      next.marks !== props.marks ||
      next.revealed !== props.revealed ||
      next.gutterWidth !== props.gutterWidth
    );
  }

  override render() {
    const { line, html, marks, revealed, gutterWidth } = this.props;
    return (
      // `content-visibility: auto`：视口外的行不排版不绘制——换行后行高随宽度变，拖一下分栏就是整篇
      // 重排；20px 是一行不折时的高，没量过的行先按它占位
      <div class="flex [contain-intrinsic-size:auto_20px] [content-visibility:auto]">
        <span
          class="relative shrink-0 px-3 text-right text-description-foreground select-none"
          style={{ width: gutterWidth }}
        >
          {line}
          {marks?.map(({ kind, edge }) => (
            <span
              key={`${kind}:${edge}`}
              data-mark={kind}
              class={`absolute right-1 ${edge === undefined ? 'inset-y-0' : ''} ${MARK_CLASS[kind]}`}
              style={edge === undefined ? undefined : { [edge]: `${-DELETED_HALF}px` }}
            />
          ))}
        </span>
        {/* 内容来自 hljs，理由同 `Content`；`wrap-anywhere`：一长串没有断点的字符（压缩过的 JS、
            base64）也要折，不然它把这一行撑出面板 */}
        <span
          data-reveal-line={revealed ? line : undefined}
          class={`min-w-0 flex-1 pr-4 whitespace-pre-wrap wrap-anywhere${revealed ? ' bg-editor-range-highlight-background' : ''}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );
  }
}

/**
 * 自动换行档的正文：**一行一个元素，行号与代码同住一行**。折出来的几行由那一行自己撑高，行号于是落在
 * 逻辑行的第一行上——两个 `<pre>` 的写法靠固定行高对齐，换行后行高不再固定，只能这样。改动标记与跳行
 * 高亮带也随之挂到行上，不再按行号乘行高算。
 *
 * 不套 `w-max`、行号槽不 `sticky`：一行都不会比面板宽，没有横向滚动。这一档的 DOM 是不换行时的几十
 * 倍，所以只在开着时才走这里。
 */
function WrappedContent({
  path,
  content,
  reveal,
  marks,
}: {
  path: string;
  content: string;
  reveal: { readonly line: number } | null;
  marks: readonly LineMark[];
}) {
  const lines = useMemo(
    () => splitHighlighted(highlightFile(path, content), lineCountOf(content)),
    [path, content],
  );
  const rowMarks = useMemo(() => rowMarksOf(marks, lines.length), [marks, lines]);
  const revealLine = reveal?.line ?? null;

  const root = useRef<HTMLDivElement>(null);
  // 跳行只随请求本身跑，理由同 `Content`
  useLayoutEffect(() => {
    if (reveal === null) return;
    root.current
      ?.querySelector('[data-reveal-line]')
      ?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  }, [reveal]);

  // 行号槽每行同宽：按总行数的位数，`px-3` 两侧的内边距算在 border box 里
  const gutterWidth = `calc(${String(lines.length).length}ch + 1.5rem)`;
  return (
    <div ref={root} class="py-2 font-mono text-xs leading-5">
      {lines.map((html, index) => (
        <Row
          key={index + 1}
          line={index + 1}
          html={html}
          marks={rowMarks.get(index + 1)}
          revealed={index + 1 === revealLine}
          gutterWidth={gutterWidth}
        />
      ))}
    </div>
  );
}

/**
 * 这一路要不要一个「按内容撑宽」的盒子（`w-max`，理由见 `FileView`）。
 *
 * **写成按 kind 穷举的 `Record` 而不是 `payload.kind === 'text'` 一句**：那样写它就是第二处独立
 * 判定 kind 的地方，与紧挨着的 `Payload` 各写各的——将来加进第六个 kind 时只改 `Payload`、忘了
 * 这边，粘性会静默退回 static（余量为 0 时与 static 一模一样），页面上什么都不会响。`Record` 的
 * 键是穷举的，漏一个就是编译错误。
 */
const NEEDS_WIDE_BOX: Record<FilePayload['kind'], boolean> = {
  // 只有正文那一路会有长行；提示那三路都是散文，撑不出横向溢出
  text: true,
  symlink: false,
  binary: false,
  // 图自己 `max-w-full` 缩到面板宽；写 `true` 时宽图把滚动区撑到原始像素宽，缩放形同虚设
  image: false,
  'too-large': false,
};

/**
 * 这一路要不要铺满面板的高（`Panel` 的 `fill` + 包裹那层 `flex-1`），给图片按高缩、上下居中。
 * 穷举成 `Record` 的理由同上。
 */
const FILLS_PANEL: Record<FilePayload['kind'], boolean> = {
  text: false,
  symlink: false,
  binary: false,
  image: true,
  'too-large': false,
};

function Payload({
  path,
  payload,
  preview,
  rendered,
  wrap,
}: {
  path: string;
  payload: FilePayload;
  preview: FilePreview | undefined;
  /** 按渲染画这份 markdown（`shownMarkdown`）。 */
  rendered: boolean;
  wrap: boolean;
}) {
  if (preview !== undefined) return <ImageFile path={path} payload={preview} />;
  switch (payload.kind) {
    case 'text': {
      if (rendered) return <MarkdownView path={path} content={payload.content} />;
      // 只认路径对得上的那一份：别的文件的跳行与这里无关
      const request = revealRequest.value;
      const reveal = request?.path === path ? request : null;
      const marks = fileMarkStates.value.get(path) ?? NO_MARKS;
      const View = wrap ? WrappedContent : Content;
      return <View path={path} content={payload.content} reveal={reveal} marks={marks} />;
    }
    case 'symlink':
      // 说的是「这是一个指向 X 的链接」而不是「这是 X 的内容」——我们刻意没有跟随它
      return (
        <Notice>
          Symbolic link to <span class="font-mono break-all">{payload.target}</span>
        </Notice>
      );
    case 'binary':
      return <Notice>Binary file — contents are not shown.</Notice>;
    case 'image':
      return <ImageFile path={path} payload={payload} />;
    case 'too-large':
      return <Notice>{tooLargeNotice(payload, 'file')}</Notice>;
  }
}

/** 活动 file tab 的视图。按 `path` 在渲染体里读缓存，不用 `useComputed`——理由在 `DiffView`。 */
export function FileView({ path }: { path: string }) {
  // 缓存里没有这一项就按加载中画：产品里到不了（`openEditor` 与写 loading 同一个 tick），兜底只
  // 为让本组件对每个状态都有答案
  const state = fileStates.value.get(path) ?? { status: 'loading' };

  /**
   * **`w-max` 是行号槽留在原地的前提，不是排版偏好。** 长行会把正文撑得比面板宽，而横向滚动
   * 发生在标签栏底下那层滚动容器上。这一层若是普通块盒，它的宽度只有面板那么宽：行号槽的
   * `sticky left-0` 于是一点滑动余量都没有（粘不粘都是同一个位置），横向一滚整列行号跟着内容
   * 滑出视口。`w-max` 让这一层长到与最长那行齐平，它才有地方可粘。**从前与它并写的
   * `min-w-full` 已经去掉**：那半条挡的是「短文件下标题栏缩成半截」，而标题栏搬出滚动区之后
   * 宽度不再来自这一层，正文这一路自己没有任何要铺满面板的底色或边框。
   *
   * **但它只能给正文那一路**（`NEEDS_WIDE_BOX`）：`max-content` 下文本一律不折行，而提示行那
   * 几路是散文——套进去之后整句排成一行横着跑出面板，要横向滚才看得全。symlink 那句里的目标路
   * 径带着 `break-all` 也救不了：`break-all` 只把 min-content 降到一个字符，max-content 仍是整
   * 句不断。
   */
  const payload = state.status === 'ready' ? state.payload : null;
  // 只在这里判一次，交给 `Payload`：两处各判时宽盒与正文可能各按一种画
  const preview = payload === null ? undefined : shownPreview(payload, path);
  const previewing = preview !== undefined;
  // 同理只判一次：渲染档自己折行，套进宽盒就是一整段排成一行
  const rendered = payload !== null && shownMarkdown(payload, path);
  // 与 `preview` 同理只读一次交给 `Payload`：自动换行时正文不该比面板宽，`max-content` 下一行都折不了
  const wrap = wordWrap.value;
  const wide =
    payload !== null && NEEDS_WIDE_BOX[payload.kind] && !previewing && !rendered && !wrap;
  const fill = payload !== null && (FILLS_PANEL[payload.kind] || previewing);

  const body = (
    <>
      {state.status === 'loading' && <Notice>Loading…</Notice>}
      {state.status === 'error' && (
        <Notice>
          Could not load this file
          <ErrorDetail message={state.message} />
        </Notice>
      )}
      {/* 换文件走的是卸载重挂——`App` 按 tab 键给本组件 `key`，两份正文因此不可能落在同一棵
          子树上 */}
      {state.status === 'ready' && (
        <Payload
          path={path}
          payload={state.payload}
          preview={preview}
          rendered={rendered}
          wrap={wrap}
        />
      )}
    </>
  );

  // 按内容撑宽的那个盒子在滚动容器**里面**（滚动那一层由 `Panel` 给），它只管正文，**别的几路
  // 不套这一层**：图片那一支要的高从 `Panel` 直接给到 `ImageRow`，中间多一层就得多一层 flex 转手
  return <Panel fill={fill}>{wide ? <div class="w-max">{body}</div> : body}</Panel>;
}
