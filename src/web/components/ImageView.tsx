// `DiffPayload` / `FilePayload` 的 `image` 支，两个面板共用。
//
// **前端不判「这是不是图片」，只认 `payload.kind === 'image'`**：判据（二进制 ∧ 扩展名）与扩展名
// 表都在后端，页面上没有第二份——与 `languageOf` 必须只有一份是同一条取向，两份表漂开的症状
// 是后端说这是图、前端按二进制画一句提示。
//
// 字节走同源 `<img src="/api/blob?…">`：cookie 自动带、CSP 的 `img-src 'self'` 现成放行。不
// `fetch` 再 `createObjectURL`（要给 CSP 开 `blob:`），不内联 base64。

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { DiffPayload, FilePayload, ImageSide } from '../../server/shared/protocol';
import { formatSize, Notice } from './DiffView';

type ImageDiffPayload = Extract<DiffPayload, { kind: 'image' }>;
type ImageFilePayload = Extract<FilePayload, { kind: 'image' }>;

/**
 * `v=` 是后端给的**内容身份**（`ImageSide.version`），不是时间戳。URL 字串相同时 Preact 不改
 * `src` 属性、浏览器不重新请求——所以它必须随内容变（否则「图改了、页面上还是旧的那张」，不报
 * 错）；但也**只能**随内容变：按「取过一次」换戳的写法会让每一次无关文件的 SSE 都重下两张图，
 * 而 `loadDiff` 在每个 `change` 事件上都跑。后端对 `v` 视而不见。
 */
function blobUrl(path: string, which: 'old' | 'new', version: string): string {
  return `/api/blob?${new URLSearchParams({ path, side: which, v: version })}`;
}

/**
 * 一侧的图。**图底下垫棋盘（`checkerboard`）**：透明 PNG 直接压在编辑器底色上看不出透明区，
 * 而棋盘正是所有图片工具的惯例；格子色复用 `--color-diff-diagonal-fill`——那本就是「叠在编辑器
 * 底色上、明暗两档都成立」的半透明 token。图外一圈 `border-panel-border`，让一张与底色同色的图
 * 有边界可辨。图自己 `max-w-full h-auto` 缩到面板宽，不做缩放、滑块、洋葱皮。
 *
 * **`onError` 落成本侧一句提示**：`/api/blob` 在 payload 之后才被问，中间文件可以被删、被改成
 * 非图片、长过 5MB；旧侧在基准里是 symlink / gitlink 时 `cat-file blob` 给的是目标字串，浏览器
 * 解不出来也是这一条。不为这些形态各写判定。**但这份 `failed` 必须随内容变化归零**——调用方按
 * `version` 给本组件 `key`，内容变了即重挂：agent 非原子地改写图片时，某次 SSE 刷新撞上半写的
 * 文件，`<img>` 一失败就不再渲染，之后没有东西去重新请求，那一侧永远停在提示上；写完的那份
 * 有新的 mtime，`version` 随之变，重挂的实例重新去取。
 *
 * 体积走 `formatSize` 的精确档，0 不画——与 `too-large` 那句同一条口径（已删除的文件工作区
 * 没有体积）。**像素尺寸从 `<img>` 的 `onLoad` 读 `naturalWidth × naturalHeight`**，不让后端解析
 * 图片头：浏览器反正要解码这张图，尺寸是解码的副产品，后端再为八种格式各写一份头解析只是第二
 * 份事实来源。图还没到时尺寸不画，到了再补进 caption。
 */
function ImageFigure({
  side,
  which,
  label,
}: {
  side: ImageSide;
  which: 'old' | 'new';
  label: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const [dimensions, setDimensions] = useState<string | null>(null);
  const size = side.size > 0 ? formatSize(side.size, true) : null;

  // 说明文字挂在图的**右下角**：figure 是一列 flex、宽度由图撑，caption `self-end` 贴右；排在
  // 图上方会把两张并排的图顶得不齐（caption 宽度随文字变）。侧别与尺寸之间用「·」隔开，尺寸与
  // 体积之间不加点、只隔一段空（caption 自己是一行 flex，`gap-2`）——`320 × 240 · 1.59 KB` 里
  // 那个点把两个数字读成并列的两项，而它们说的是同一张图的两个维度
  const lead = [label, dimensions].filter((part) => part !== null).join(' · ');

  return (
    <figure class="flex min-w-0 max-w-full flex-col gap-1">
      {failed ? (
        <Notice>Could not load the image.</Notice>
      ) : (
        <div class="checkerboard inline-block max-w-full border border-panel-border">
          {/* alt 留空：文件名已在标签栏与标题上，读屏再念一遍是噪音 */}
          <img
            src={blobUrl(side.path, which, side.version)}
            alt=""
            class="block h-auto max-w-full"
            onLoad={(event) => {
              const img = event.currentTarget;
              // 0 × 0 是「解码失败但没走 error」那种形态（SVG 无尺寸之类），不画一个 0 出来
              if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                setDimensions(`${img.naturalWidth} × ${img.naturalHeight}`);
              }
            }}
            onError={() => setFailed(true)}
          />
        </div>
      )}
      {(lead || size) && (
        <figcaption class="flex gap-2 self-end text-xs text-description-foreground">
          {lead && <span>{lead}</span>}
          {size && <span>{size}</span>}
        </figcaption>
      )}
    </figure>
  );
}

/**
 * 放图的那一行，**两个视图共用，一张图也走它**。图在面板里水平居中、从顶部起排：只做水平——
 * 垂直居中要把容器撑到面板高，`FileView` 的 wrapper 与 `RenameNotice` 都得跟着改。两张
 * `flex-wrap`，放不下并排时上下排；与 diff 的版式切换不联动（那道量的是文本两列够不够宽，对图
 * 没有意义）。**单张那侧不能退成普通块盒**：块盒下 figure 铺满面板宽，caption 的 `self-end` 贴
 * 的是面板右边而不是图的右下角。
 */
function ImageRow({ children }: { children: ComponentChildren }) {
  return <div class="flex flex-wrap items-start justify-center gap-4 p-4">{children}</div>;
}

/**
 * diff 那侧：`Before` / `After` 各一张，`null` 的那侧不画——新增只有右、删除只有左。`key` 是
 * 内容身份：内容没变的那一侧不重挂、不重取。
 */
export function ImageDiff({ payload }: { payload: ImageDiffPayload }) {
  return (
    <ImageRow>
      {payload.old && (
        <ImageFigure key={payload.old.version} side={payload.old} which="old" label="Before" />
      )}
      {payload.new && (
        <ImageFigure key={payload.new.version} side={payload.new} which="new" label="After" />
      )}
    </ImageRow>
  );
}

/** 文件视图那侧：工作区那一张，不带标题。 */
export function ImageFile({ path, payload }: { path: string; payload: ImageFilePayload }) {
  return (
    <ImageRow>
      <ImageFigure
        key={payload.version}
        side={{ path, size: payload.size, version: payload.version }}
        which="new"
        label={null}
      />
    </ImageRow>
  );
}
