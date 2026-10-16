// 单个文件的 diff 视图(`DiffPayload`)。
//
// 补丁正文整个由 Preact 画：解析、配对、上色在 `diff/render.ts`（`prepareDiff()`），这里只把那份
// 数据排成两种版式之一。每行正文是 hljs 的 HTML 片段，经 `dangerouslySetInnerHTML` 写进去——
// 内容来自 hljs，它自己转义了正文里的一切标记。
//
// 五个 `kind` 全部在这里分支：前端不区分 binary / too-large 来自哪条路，它拿到的就是同一个
// 判别联合；图片那一支交给 `ImageView`。

import { UnfoldVertical } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DiffPayload } from '../../server/shared/protocol';
import type { Gap } from '../diff/fold';
import type { LineKind } from '../diff/parse';
import { type DiffLine, type PreparedBlock, prepareDiff } from '../diff/render';
import { splitRows, unifiedLines } from '../diff/rows';
import {
  contextOf,
  type DiffContext,
  type EditorKey,
  editorKey,
  findEditor,
} from '../state/editors';
import { commitDetails } from '../state/history';
import { diffOutputFormat } from '../state/layout';
import {
  commitDiffStates,
  type DiffRequestState,
  diffStates,
  expandContext,
  PATCH_DEFAULTS,
  type PatchRequest,
  type RenameInfo,
} from '../state/store';
import { Icon } from './Icon';
import { ImageDiff } from './ImageView';

/**
 * 提示行的统一外观——加载中、错误、二进制、超大文件共用。**导出给文件视图共用**：
 * 两边说的都是「这里没有正文可看」，各写一份的症状是同一类提示在两个面板里内边距不一样。
 * 栏里一个 tab 都没有那一路不走它（`App` 画 `PanelEmptyState`）：那是面板空着，不是某个文件
 * 出了状况。
 */
export function Notice({ children }: { children: ComponentChildren }) {
  return <p class="p-4 text-sm text-description-foreground">{children}</p>;
}

/**
 * 出错提示的第二段：原因逐字放在引导句底下，**不拼进同一句话里**。原因的来处不止一个——后端
 * `sendError` 的片段（`file no longer exists`）、浏览器自己的 `TypeError: Failed to fetch`、
 * 500 那一路转发来的 `ENOENT: …`——大小写与句点各成一派，接在「Could not load …: 」后面
 * 总有一种读起来像两句话撞在一起，而前端管不到那几个来处。同一条消息在左栏错误条与目录树里
 * 是裸着显示的，因此也不能反过来把兜底改成小写片段去迁就冒号。
 */
export function ErrorDetail({ message }: { message: string }) {
  return <span class="mt-1 block font-mono break-words">{message}</span>;
}

/**
 * 一段 unified diff。
 *
 * **解析与上色只按 `[path, patch, 两个选项]` 重算**，版式不在依赖里：两种版式共用 `prepareDiff()`
 * 的同一份结果，拖窗口跨过阈值只是换一种排法，不再重新高亮。`path` 只用来判语言（`languageOf`）。
 * 两个选项都取自**这份补丁取的时候**（请求状态里记的那一档、payload 的 `full`），不读此刻的开关。
 *
 * **整张表的 vnode 也按 `[blocks, format, 展开状态, 上下文档]` 缓存**：本组件订阅的是整个
 * `diffStates`，别的 tab 加载、关掉，以及每次 SSE 重取到逐字相同的补丁，都会让它重渲染。缓存命中
 * 时 Preact 拿到同一个 vnode 直接跳过，不必把几万行再建一遍、比一遍。
 *
 * **同一个文件拿到新补丁**（SSE 刷新）时组件留在原地，Preact 按行比对着改，滚动位置随之保留。这
 * 条路径要成立，`loadDiff` 就不能在同一个文件重新取时回退到 loading 态：一回退，子树先卸载再重
 * 挂，滚动位置随之丢失。换文件那一路走的是卸载重挂（`key` 由调用方按 path 给）。
 *
 * **展开了哪几段住在这里**（按每段的旧侧起始行认）：切 tab 是卸载重挂，回来时全部折起，与「滚动
 * 位置不保留」同一个样子；整份上下文还在缓存里，再点是即时的。
 */
function Patch({
  path,
  patch,
  full,
  ignoreWhitespace,
  tab,
}: {
  path: string;
  patch: string;
  full: boolean;
  ignoreWhitespace: boolean;
  /** 这份补丁属于哪个 tab：上下文档住在 tab 上，手上只有 3 行上下文时点开一段要按它去取整份。 */
  tab: EditorKey;
}) {
  const blocks = useMemo(
    () => prepareDiff(path, patch, { ignoreWhitespace, full }),
    [path, patch, ignoreWhitespace, full],
  );
  const digits = useMemo(() => maxDigits(blocks), [blocks]);
  /**
   * 展开了哪几段，**连同记下它们时补丁是不是按 `-w` 取的**：一段的身份是它的旧侧起始行，而 `-w`
   * 一翻 hunk 就挪位，记着的行号会落到另一段上、让它没点就展开。所以档位对不上时一律当作全部折起
   *——派生出来，不另起 effect 去清（effect 晚一拍，中间那一帧照样会错开）。
   */
  const [opened, setOpened] = useState<{ ignoreWhitespace: boolean; ids: ReadonlySet<number> }>({
    ignoreWhitespace,
    ids: NONE_EXPANDED,
  });
  const expanded = opened.ignoreWhitespace === ignoreWhitespace ? opened.ids : NONE_EXPANDED;
  const format = diffOutputFormat.value;
  // 在渲染体里读：理由同 `DiffView` 读 map——prop 换了而 signal 没写时 `useComputed` 会停在上一个
  const context = contextOf(findEditor(tab));
  const table = useMemo(() => {
    const fold: Fold = {
      expanded,
      context,
      full,
      expand: (id) => {
        setOpened({ ignoreWhitespace, ids: new Set(expanded).add(id) });
        if (!full) expandContext(tab);
      },
    };
    return format === 'side-by-side' ? (
      <SplitPatch blocks={blocks} fold={fold} />
    ) : (
      <UnifiedPatch blocks={blocks} fold={fold} />
    );
  }, [blocks, format, expanded, context, full, ignoreWhitespace, tab]);
  // 没有 hunk：只改了权限位、一个空的新文件，或忽略空白之后什么都不剩。不是错误，也没有正文可画。
  // 只有 git 一个字节都没给（`-w` 下只改了空白）才说是空白：`-w` 下只改权限位的仍有文件头、没有 hunk
  if (blocks.length === 0) {
    return (
      <Notice>
        {ignoreWhitespace && patch === '' ? 'Only whitespace changes.' : 'File without changes.'}
      </Notice>
    );
  }
  // 外面这层在两种版式之间不换：换版式、SSE 刷新都落在同一个元素里
  return (
    <div class="font-mono text-[13px] leading-5" style={{ '--diff-digits': digits }}>
      {table}
    </div>
  );
}

const NONE_EXPANDED: ReadonlySet<number> = new Set();

/** 这份补丁里最大的行号有几位（折着的行也算：展开时格宽不该再跳）。行号格据此定宽，见 `NUMBER_WIDTH`。 */
function maxDigits(blocks: readonly PreparedBlock[]): number {
  let max = 0;
  const see = (line: DiffLine) => {
    max = Math.max(max, line.oldNo ?? 0, line.newNo ?? 0);
  };
  for (const block of blocks) {
    if (block.kind === 'gap') {
      block.lines.forEach(see);
      continue;
    }
    for (const group of block.groups) {
      if (group.kind === 'context') see(group.line);
      else {
        group.deleted.forEach(see);
        group.inserted.forEach(see);
      }
    }
  }
  return String(max).length;
}

/**
 * 一个行号格的宽度：**照旧是 3.5em（并排 4em），放不下才按位数撑宽**。13px 等宽下 3.5em 去掉左右
 * 各 0.5em 的内边距只剩约 4 个字符，第 10000 行起五位数就溢进旁边那格、两个号叠成一团。diff2html
 * 的做法是裁掉（`overflow:hidden`），我们宁可让槽变宽：行号被裁就是错的行号。位数由 `Patch` 写在
 * `--diff-digits` 上，同一份补丁里所有格子（并排两侧）一起变，两侧仍等宽。撑宽之后
 * `state/layout.ts` 那条 1024 的推导在这份补丁上少算了几个字符，阈值不跟着动。
 */
const NUMBER_WIDTH = {
  split:
    'w-[max(4em,calc(var(--diff-digits,4)*1ch_+_1em))] min-w-[max(4em,calc(var(--diff-digits,4)*1ch_+_1em))]',
  unified: 'w-[max(3.5em,calc(var(--diff-digits,4)*1ch_+_1em))]',
} as const;

/**
 * 行首记号，**后面带一个空格**：照旧的观感——diff2html 模板里记号与正文是两个兄弟 span，中间那
 * 个换行在 `nowrap` 下折成一个空格。少了它 `-const` 贴在一起，缩进为 0 的行读起来像一个运算符。
 */
const PREFIX: Record<LineKind, string> = { context: '  ', delete: '- ', insert: '+ ' };

/**
 * 两种版式共用的表格外观。
 *
 * - **`w-max min-w-full`**：行号槽 `sticky left-0` 的滑动余量来自包含块，表格只有面板那么宽时
 *   余量为 0，粘性与 static 一模一样（文件视图踩过同一个坑）。`min-w-full` 的另一面是行都比面
 *   板短时表格有富余，自动布局会把富余分给每一列——所以正文格一律 `w-full`，富余全归它。
 * - **`border-separate`**：合并边框模式下边框属于表格而不是格子，`sticky` 的格子会把自己的右边线
 *   留在原地。
 * - **词级标记**：`<del>` / `<ins>` 的 UA 样式是删除线与下划线，preflight 不撤它们；换成一块圆角
 *   底色，取 VS Code 词级高亮那一档。挂在表上而不是每一格上：后代选择器，一份类名管全表。
 *
 * 每行的底色不在这里：`<tr>` 的 `data-line` 由 `app.css` 的 `@layer components` 读。
 */
const TABLE =
  'w-max min-w-full border-separate border-spacing-0 ' +
  '[&_del]:rounded-[0.2em] [&_del]:bg-diff-removed-text-background [&_del]:no-underline ' +
  '[&_ins]:rounded-[0.2em] [&_ins]:bg-diff-inserted-text-background [&_ins]:no-underline';

/**
 * 行号槽。`h-5`（与行高同为 20px）是空位那一行的高度来源：它两格都没有字，不给最小高度就塌
 * 成 0，与对面那侧错开一行。`whitespace-nowrap`：逐行版式的槽里是两个 inline-block 的号，正文格
 * `w-full` 把槽压到最窄时它们会折成两行、整行变高。`select-none`：拖选正文时不该把行号一起选进
 * 剪贴板。
 */
const GUTTER =
  'diff-gutter sticky left-0 h-5 whitespace-nowrap text-right text-description-foreground select-none';

/** 两种版式各自的行号槽与正文格。右侧留白照抄 diff2html 的版面，`state/layout.ts` 的阈值按它算。 */
const CELLS = {
  split: {
    gutter: `${GUTTER} px-[0.5em] ${NUMBER_WIDTH.split}`,
    code: 'diff-code w-full whitespace-pre pr-[4.5em] pl-[0.5em]',
  },
  unified: {
    gutter: GUTTER,
    code: 'diff-code w-full whitespace-pre pr-[8em] pl-[0.5em]',
  },
} as const;

const UNIFIED_NUMBER = `inline-block px-[0.5em] ${NUMBER_WIDTH.unified}`;
const UNIFIED_NEW_NUMBER = `ml-[0.5em] ${UNIFIED_NUMBER}`;

/**
 * 表里的一行：一行代码、并排时的空位（`line: null`），或一段折叠行。**`key` 跟着行号走，不跟下标**：
 * SSE 刷新时文件开头多一行，按下标比对会让其后每一行的正文都换一遍（`innerHTML` 先序列化再解析），
 * 按行号比对时没变的行原样留着。上下文与删除行认旧行号、插入行认新行号；并排时的空位认对面那一行；
 * 折叠行认它的旧侧起始行（`g<行>`）。
 */
type Row = { key: string; line: DiffLine | null } | { key: string; gap: Gap<DiffLine> };

const keyOf = (line: DiffLine) =>
  line.kind === 'insert' ? `i${line.newNo}` : `${line.kind[0]}${line.oldNo}`;

/** 两种版式共用的折叠状态：展开了哪几段、tab 的上下文档、这份补丁是不是整份上下文，以及点开一段。 */
interface Fold {
  expanded: ReadonlySet<number>;
  context: DiffContext;
  full: boolean;
  expand: (id: number) => void;
}

/** 这一段此刻画成什么：展开成行，或一行折叠行。展开要有正文，3 行上下文时得先等整份上下文回来。 */
const isOpen = (gap: Gap<DiffLine>, fold: Fold) =>
  fold.expanded.has(gap.id) && gap.lines.length > 0;

/**
 * 一行折叠行里写什么、点不点得动。**`unavailable` 时所有折叠行都只是文本**（后端说整份上下文过不了
 * 闸）；点过、而整份上下文还没回来的那一行是 `Loading…`。
 */
function gapLabel(gap: Gap<DiffLine>, fold: Fold): { text: string; clickable: boolean } {
  const lines =
    gap.count === null
      ? 'Show remaining lines'
      : `${gap.count} hidden ${gap.count === 1 ? 'line' : 'lines'}`;
  if (fold.context === 'unavailable') {
    return {
      text: `${gap.count === null ? 'Remaining lines' : lines} · too large to expand`,
      clickable: false,
    };
  }
  if (fold.expanded.has(gap.id) && !fold.full) return { text: 'Loading…', clickable: false };
  return { text: lines, clickable: true };
}

/** 折叠行的正文格。**并排时只在旧侧画**，新侧那一行留空占高（`h-5` 来自行号槽）。 */
function GapCell({ gap, fold }: { gap: Gap<DiffLine>; fold: Fold }) {
  const { text, clickable } = gapLabel(gap, fold);
  const body = (
    <>
      <Icon icon={UnfoldVertical} size={14} />
      {text}
    </>
  );
  // 整宽的 `<button>`：正文格里哪儿都点得到，键盘也够得着。悬停时字色升到正文色，告诉人这一行能点
  return clickable ? (
    <button
      type="button"
      onClick={() => fold.expand(gap.id)}
      class="flex w-full items-center gap-1.5 text-left hover:text-editor-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-border"
    >
      {body}
    </button>
  ) : (
    <span class="flex items-center gap-1.5">{body}</span>
  );
}

/** 两种版式共用的表格骨架：逐行，折叠行在其间。行号格里画什么由调用方给。 */
function PatchTable({
  rows,
  fold,
  cells,
  numbers,
  side,
}: {
  rows: Row[];
  fold: Fold;
  cells: (typeof CELLS)[keyof typeof CELLS];
  numbers: (line: DiffLine) => ComponentChildren;
  side?: 'old' | 'new';
}) {
  return (
    <table data-diff-side={side} class={TABLE}>
      <tbody>
        {rows.map((row) =>
          'gap' in row ? (
            <tr key={row.key} data-line="hunk">
              <td class={cells.gutter} />
              <td class={cells.code}>{side !== 'new' && <GapCell gap={row.gap} fold={fold} />}</td>
            </tr>
          ) : row.line ? (
            <tr key={row.key} data-line={row.line.kind}>
              <td class={cells.gutter}>{numbers(row.line)}</td>
              {/* 前缀 `select-none`，复制出来的是代码本身 */}
              <td class={cells.code}>
                <span class="select-none">{PREFIX[row.line.kind]}</span>
                <span
                  data-code
                  class={row.line.language ? `hljs ${row.line.language}` : 'hljs'}
                  dangerouslySetInnerHTML={{ __html: row.line.html }}
                />
              </td>
            </tr>
          ) : (
            <tr key={row.key} data-line="empty">
              <td class={cells.gutter} />
              <td class={cells.code} />
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

const unifiedNumbers = (line: DiffLine) => (
  <>
    <span class={UNIFIED_NUMBER}>{line.oldNo}</span>
    <span class={UNIFIED_NEW_NUMBER}>{line.newNo}</span>
  </>
);
const oldNumber = (line: DiffLine) => line.oldNo;
const newNumber = (line: DiffLine) => line.newNo;

/** 一段折叠行在表里占的行：展开了就是那几行上下文，否则一行折叠行。两种版式共用。 */
const gapRows = (gap: Gap<DiffLine>, fold: Fold): Row[] =>
  isOpen(gap, fold)
    ? gap.lines.map((line) => ({ key: keyOf(line), line }))
    : [{ key: `g${gap.id}`, gap }];

/**
 * 逐行版式：一张表，行号槽里新旧两个号并列。外层自己横向滚动（不交给 `Panel`），让改名标注之类
 * 排在补丁上面的东西不跟着横滚出去。
 */
function UnifiedPatch({ blocks, fold }: { blocks: PreparedBlock[]; fold: Fold }) {
  const rows = blocks.flatMap((block): Row[] => {
    if (block.kind === 'lines') {
      return unifiedLines(block.groups).map((line) => ({ key: keyOf(line), line }));
    }
    return gapRows(block, fold);
  });
  return (
    <div data-diff-layout="line-by-line" class="overflow-x-auto">
      <PatchTable rows={rows} fold={fold} cells={CELLS.unified} numbers={unifiedNumbers} />
    </div>
  );
}

/**
 * 并排版式：左旧右新两张表，各自是一个横向滚动容器，行数相同、行高相同，于是竖直方向天然对齐。
 * 折叠行两侧各占一行，文案与按钮只在旧侧。
 *
 * **两侧横向联动**：横滚一侧看长行时另一侧跟到同一个 `scrollLeft`，否则同一行的新旧内容错开成两
 * 个列位置——并排存在的理由正好在需要横滚时失效。**与 diff2html 的 `synchronisedScroll` 同语义、
 * 不做回声抑制**：两侧滚动上限不等时，越过窄侧上限的那一下会把宽侧拽回窄侧的上限，边界处顿一下，
 * 之后继续正常滚。两个元素在本组件挂着期间不换（换版式是卸载），监听器只绑一次；用 layout
 * effect 是为了与元素同一次提交就绑上，中间没有一帧「滚了不跟」。
 */
function SplitPatch({ blocks, fold }: { blocks: PreparedBlock[]; fold: Fold }) {
  const left: Row[] = [];
  const right: Row[] = [];
  for (const block of blocks) {
    if (block.kind === 'gap') {
      // 上下文行与折叠行两侧各占一行、同一个 key；折叠行的文案只在旧侧画（`PatchTable` 按 `side` 判）
      const rows = gapRows(block, fold);
      left.push(...rows);
      right.push(...rows);
      continue;
    }
    for (const row of splitRows(block.groups)) {
      // 空位认对面那一行的 key：它就是为那一行占的位
      const anchor = (row.left ?? row.right) as DiffLine;
      left.push({ key: row.left ? keyOf(row.left) : `e${keyOf(anchor)}`, line: row.left });
      right.push({ key: row.right ? keyOf(row.right) : `e${keyOf(anchor)}`, line: row.right });
    }
  }
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const a = leftRef.current;
    const b = rightRef.current;
    if (!a || !b) return;
    const unbind = (
      [
        [a, b],
        [b, a],
      ] as const
    ).map(([from, to]) => {
      const sync = () => {
        to.scrollLeft = from.scrollLeft;
      };
      from.addEventListener('scroll', sync);
      return () => from.removeEventListener('scroll', sync);
    });
    return () => {
      for (const off of unbind) off();
    };
  }, []);
  // overflow-x-scroll 而不是 auto：两侧总带着同样的横向滚动条，底边才对得齐
  const half = 'w-1/2 overflow-x-scroll overflow-y-hidden';
  return (
    <div data-diff-layout="side-by-side" class="flex">
      <div ref={leftRef} class={half}>
        <PatchTable rows={left} fold={fold} cells={CELLS.split} numbers={oldNumber} side="old" />
      </div>
      <div ref={rightRef} class={`${half} border-l border-panel-border`}>
        <PatchTable rows={right} fold={fold} cells={CELLS.split} numbers={newNumber} side="new" />
      </div>
    </div>
  );
}

/**
 * 体积的可读写法。**不能一律按 MB 取整**：`reason: 'lines'` 那一路的文件可能只有几百 KB，按
 * MB 取整会显示「0 MB」。**导出给文件视图与图片视图共用**——两份拷贝在第一次提交时就已经漂开
 * 过一次（那边漏掉了 `size > 0` 那道）。
 *
 * `precise` 是两档的唯一开关：提示句里的体积是「大概多大」，整 KB / 一位小数的 MB 够用；图片
 * caption 里的体积是元数据，两位小数。**粗略档下限 1 KB**：一个 200 字节的文件说「0 KB」像是在
 * 说它是空的，而精确档的 `0.20 KB` 自己就说清了，不需要这道下限。
 */
export function formatSize(bytes: number, precise = false): string {
  const kb = bytes / 1024;
  const mb = kb / 1024;
  if (mb >= 1) return `${mb.toFixed(precise ? 2 : 1)} MB`;
  return precise ? `${kb.toFixed(2)} KB` : `${Math.max(1, Math.round(kb))} KB`;
}

/**
 * 拒绝渲染的原因(`reason`)。两个触发口的文案必须不同：行数那一路的体积可能只有几百 KB，单说
 * 「文件过大」会让用户对着一个不大的数字发愣。**具体阈值（5MB / 50,000 行）刻意不写在这里**
 *——它属 server/git 那一侧的判据，复述一遍就是第二份事实来源。
 *
 * `view` 是两个面板唯一的差别，而且差在**主语**不在动词：diff 那侧 5MB 卡的是**补丁字节**，
 * `size` 却是文件体积——一个 3 MB 的文件整个重写，补丁 6 MB 被掐断，说「File too large (3 MB)」
 * 的同时 Files 档里同一个文件照常显示，用户看到的是自相矛盾。所以 diff 那侧说的是「这份 diff
 * 太大」，括号里注明「文件是多大」；文件视图说的才是「这个文件太大」。**其余（含 `size > 0`
 * 那道）必须共用**——各写一份时漂开的正是那一道。
 */
export function tooLargeNotice(
  payload: Extract<DiffPayload, { kind: 'too-large' }>,
  view: 'diff' | 'file',
): string {
  // 体积可能压根取不到：已被删除的文件在工作区已经没有了，后端给的是 0。那时不能照着
  // formatSize 报一个「1 KB」——编一个数出来比不说更糟。两个 reason 都会遇上，判据只写一次
  const size = payload.size > 0 ? formatSize(payload.size) : null;
  const lines = payload.reason === 'lines';
  const head = lines
    ? `Too many lines to ${view === 'diff' ? 'diff' : 'show'}`
    : `${view === 'diff' ? 'Diff' : 'File'} too large to show`;
  // 行数那一路括号里仍是体积（payload 没有行数），所以不写「in total」那种像在汇总前文的
  // 说法——前面没有分项可汇总
  const detail = !lines && view === 'diff' ? `file is ${size}` : size;
  return size ? `${head} (${detail}).` : `${head}.`;
}

/**
 * 重命名标注。补丁正文里的 `rename from/to` 我们不画（文件头整条不画）；binary / too-large 那
 * 几路更是压根没有补丁头——少了这一行，页面上就再没有任何地方说它是改名来的。**只说旧路径，不
 * 印相似度**（照 VS Code）：status 的 `R<score>` 量的是 HEAD→index，而这份补丁是 HEAD→工作区，
 * `RM` 时两者对不上。
 */
function RenameNotice({ rename }: { rename: RenameInfo }) {
  return (
    <p class="border-b border-panel-border px-4 py-1 text-xs text-description-foreground">
      Renamed from <span class="font-mono break-all">{rename.oldPath}</span>
    </p>
  );
}

/**
 * 面板里唯一滚的那一层。**两个视图共用**，理由与 `Notice` 一字不差——它是 `App` 那个
 * `<section>`（一列 flex：标签栏 `shrink-0` 占第一行，这一层 `min-h-0 flex-1 overflow-auto`）
 * 的直接子项，类名必须逐字相同：各写一份时漂开的症状是「其中一个面板底下那半屏不跟着滚」，
 * 不报错。滚动区里放什么由调用方给：diff 那侧是补丁与提示行，文件视图那侧还要多一层按内容
 * 撑宽的盒子。
 *
 * 面板的 chrome 只有 `EditorTabs` 那一条，它排在滚动区域之外，因此这里既不需要 `sticky top-0`
 * 也不需要 `z-10`：补丁里那些 `sticky` 的行号格被滚动容器的 `overflow` 裁掉，够不着标签栏。
 *
 * **`fill` 只给图片那一支**：成一列 flex，让 `ImageRow` 用 `flex-1` 拿到面板剩余的高、把图按高缩、
 * 上下居中。正文与提示行不带它，滚动层的类名照旧。
 */
export function Panel({ children, fill = false }: { children: ComponentChildren; fill?: boolean }) {
  return (
    <div class={`${fill ? 'flex flex-col ' : ''}min-h-0 flex-1 overflow-auto`}>{children}</div>
  );
}

/**
 * 这一路要不要 `Panel` 的 `fill`。按 kind 穷举成 `Record`，理由同 `FileView` 的
 * `NEEDS_WIDE_BOX`：与 `Payload` 各判各的 kind，加第六个 kind 时漏改这边会是编译错误而不是
 * 静默退回不居中。
 */
const FILLS_PANEL: Record<DiffPayload['kind'], boolean> = {
  text: false,
  'untracked-text': false,
  binary: false,
  image: true,
  'too-large': false,
};

function Payload({
  path,
  payload,
  sha,
  options,
  tab,
}: {
  path: string;
  payload: DiffPayload;
  sha?: string | undefined;
  options: PatchRequest;
  tab: EditorKey;
}) {
  const patch = (text: string, full: boolean) => (
    <Patch
      path={path}
      patch={text}
      full={full}
      ignoreWhitespace={options.ignoreWhitespace}
      tab={tab}
    />
  );
  switch (payload.kind) {
    case 'text':
      return patch(payload.patch, payload.full);
    // 未跟踪的补丁按构造就是整份文件
    case 'untracked-text':
      return patch(payload.patch, true);
    case 'binary':
      return <Notice>Binary file — contents are not compared.</Notice>;
    case 'image':
      return <ImageDiff payload={payload} sha={sha} />;
    case 'too-large':
      return <Notice>{tooLargeNotice(payload, 'diff')}</Notice>;
  }
}

/**
 * 活动 diff tab 的视图。`path` 由 `App` 从活动 tab 给，本组件按它读缓存。**在渲染体里读 map，
 * 不用 `useComputed` 包一层**：`useComputed` 只在 signal 依赖变了时重算，`path` prop 换了而
 * map 没写时它停在上一个 tab 的正文上——页面上就是「切了 tab 标题变了正文没变」。本组件只是
 * 一个订阅者，每次 map 写入重渲染一次，代价可以忽略。
 */
export function DiffView({ path }: { path: string }) {
  // 缓存里没有这一项就按加载中画：`openEditor` 与写 loading 在同一个同步 tick 里，产品里到不了，
  // 兜底只为让组件对每个状态都有答案
  return (
    <DiffBody
      path={path}
      state={diffStates.value.get(path) ?? LOADING}
      tab={editorKey('diff', path)}
    />
  );
}

/**
 * commit tab 的视图：同一个 `DiffBody`。**只有合并提交顶上多一行说明对比端**：补丁是相对第一父
 * 算的，而这件事只在看补丁时才需要知道。是不是合并读 `History` 里展开时取到的详情——tab 只能从
 * 展开的那一列点出来，详情必然在；万一不在（不该发生）就按普通提交处理。
 */
export function CommitDiffView({ sha, path }: { sha: string; path: string }) {
  const key = editorKey('commit', path, sha);
  const state = commitDiffStates.value.get(key) ?? LOADING;
  const detail = commitDetails.value.get(sha);
  const merge = detail?.status === 'ready' && detail.detail.parents.length > 1;
  return (
    <DiffBody path={path} state={state} sha={sha} tab={key}>
      {merge && (
        <p class="border-b border-panel-border px-4 py-1 text-xs text-description-foreground">
          Merge commit · compared with first parent
        </p>
      )}
    </DiffBody>
  );
}

const LOADING: DiffRequestState = { status: 'loading', rename: null, options: PATCH_DEFAULTS };

function DiffBody({
  path,
  state,
  sha,
  tab,
  children,
}: {
  path: string;
  state: DiffRequestState;
  sha?: string;
  tab: EditorKey;
  children?: ComponentChildren;
}) {
  return (
    <Panel fill={state.status === 'ready' && FILLS_PANEL[state.payload.kind]}>
      {children}
      {/* 三个状态下都标注：标注属于「选了哪个条目」，与补丁取到没有无关。它跟着补丁一起滚
          ——这一行说的是这份补丁的来历，不是「我在看哪个文件」，后者由标签栏答 */}
      {state.rename && <RenameNotice rename={state.rename} />}
      {state.status === 'loading' && <Notice>Loading…</Notice>}
      {state.status === 'error' && (
        <Notice>
          Could not load the diff
          <ErrorDetail message={state.message} />
        </Notice>
      )}
      {/* 换文件走的是卸载重挂——`App` 按 tab 键给本组件 `key`，本组件挂着期间 `path` 不会变，
          一个文件的表格因此不会就地改画成另一个文件的 */}
      {state.status === 'ready' && (
        <Payload path={path} payload={state.payload} sha={sha} options={state.options} tab={tab} />
      )}
    </Panel>
  );
}
