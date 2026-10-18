// 单个文件的只读全文（`FilePayload`）。
//
// **这不是 diff**：每一行前面不挂 `+`、底色不是新增绿——「看项目整体面貌」正是要摆脱补丁
// 视角。因此它不走 diff 的表格，只用 hljs 高亮一次，行号另起一栏。
//
// 五个 `kind` 全部在这里分支，提示行与 DiffView 共用同一个 `Notice`，图片与 SVG 预览与它共用
// `ImageView`。

import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import type { FilePayload, FilePreview } from '../../server/shared/protocol';
import { getHljs, languageOf } from '../diff/hljs';
import { revealRequest } from '../state/editors';
import { fileStates, shownPreview } from '../state/store';
import { ErrorDetail, Notice, Panel, tooLargeNotice } from './DiffView';
import { ImageFile } from './ImageView';

/**
 * 正文 + 行号。
 *
 * **行号是兄弟元素，不按行切高亮输出**：hljs 的 span 会跨行，切开要自己重开标签补齐——那正是
 * diff 那侧明令禁止自己重写的事（切分交给 diff2html 的三个辅助函数），换个地方做不会变得更
 * 容易。两个 `<pre>` 共用同一个 `leading-5`，对齐就成立；行号槽 `sticky left-0`，横向滚代码
 * 时它留在左边。
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

function Content({
  path,
  content,
  reveal,
}: {
  path: string;
  content: string;
  /** 要跳到并高亮的那一行（全仓搜索点进来的）；每次请求一个新对象，再点同一行也重新滚一次。 */
  reveal: { readonly line: number } | null;
}) {
  /**
   * 高亮一份 5MB 的正文不便宜，而每次重渲染（换主题、换选中）都会走到这里。**行号槽也在同
   * 一个 memo 里**：它同样要按 `\n` 切一遍整份正文，留在 memo 外的话 SSE 刷新时正文逐字节
   * 没变也照样重算一遍——而高亮那半正确地跳过了。
   */
  const { html, gutter } = useMemo(() => {
    const hljs = getHljs();
    // 末尾那个换行不算一行——否则每个正常结尾的文件都会多出一个空行号
    const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
    return {
      html: hljs.highlight(content, { language: languageOf(path) }).value,
      gutter: lines.map((_, index) => index + 1).join('\n'),
    };
  }, [path, content]);

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
            top: `${PAD_TOP + (reveal.line - 1) * LINE_HEIGHT}px`,
            height: `${LINE_HEIGHT}px`,
          }}
        />
      )}
      {/* select-none：拖选正文时不该把行号一起选进剪贴板 */}
      <pre class="sticky left-0 shrink-0 bg-editor-background px-3 py-2 text-right text-description-foreground select-none">
        {gutter}
      </pre>
      {/* dangerouslySetInnerHTML 的内容来自 hljs——它自己转义了正文里的一切标记 */}
      <pre class="min-w-0 py-2 pr-4" dangerouslySetInnerHTML={{ __html: html }} />
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
}: {
  path: string;
  payload: FilePayload;
  preview: FilePreview | undefined;
}) {
  if (preview !== undefined) return <ImageFile path={path} payload={preview} />;
  switch (payload.kind) {
    case 'text': {
      // 只认路径对得上的那一份：别的文件的跳行与这里无关
      const request = revealRequest.value;
      const reveal = request?.path === path ? request : null;
      return <Content path={path} content={payload.content} reveal={reveal} />;
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
  const wide = payload !== null && NEEDS_WIDE_BOX[payload.kind] && !previewing;
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
        <Payload path={path} payload={state.payload} preview={preview} />
      )}
    </>
  );

  // 按内容撑宽的那个盒子在滚动容器**里面**（滚动那一层由 `Panel` 给），它只管正文，**别的几路
  // 不套这一层**：图片那一支要的高从 `Panel` 直接给到 `ImageRow`，中间多一层就得多一层 flex 转手
  return <Panel fill={fill}>{wide ? <div class="w-max">{body}</div> : body}</Panel>;
}
