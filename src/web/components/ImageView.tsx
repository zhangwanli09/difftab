// `DiffPayload` / `FilePayload` 的 `image` 支，以及文本 payload 上的 SVG 预览，两个面板共用。
//
// **前端不判「这是不是图片」，只认 `payload.kind === 'image'` 与 `payload.preview`**：判据（二进制 ∧ 扩展名）与扩展名
// 表都在后端，页面上没有第二份——与 `languageOf` 必须只有一份是同一条取向，两份表漂开的症状
// 是后端说这是图、前端按二进制画一句提示。
//
// 字节走同源 `<img src="/api/blob?…">`：cookie 自动带、CSP 的 `img-src 'self'` 现成放行。不
// `fetch` 再 `createObjectURL`（要给 CSP 开 `blob:`），不内联 base64。

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { FilePreview, ImagePreview, ImageSide } from '../../server/shared/protocol';
import { formatSize, Notice } from './DiffView';

/**
 * `v=` 是后端给的**内容身份**（`ImageSide.version`），不是时间戳。URL 字串相同时 Preact 不改
 * `src` 属性、浏览器不重新请求——所以它必须随内容变（否则「图改了、页面上还是旧的那张」，不报
 * 错）；但也**只能**随内容变：按「取过一次」换戳的写法会让每一次无关文件的 SSE 都重下两张图，
 * 而 `loadDiff` 在每个 `change` 事件上都跑。后端对 `v` 视而不见。
 */
export function blobUrl(path: string, which: 'old' | 'new', version: string, sha?: string): string {
  const query = new URLSearchParams({ path, side: which, v: version });
  // 提交里的图：两侧都读对象库（第一父 / 提交本身），不是「基准 / 工作区」
  if (sha !== undefined) query.set('commit', sha);
  return `/api/blob?${query}`;
}

/**
 * 一侧的图。**图底下垫棋盘（`checkerboard`）**：透明 PNG 直接压在编辑器底色上看不出透明区，
 * 而棋盘正是所有图片工具的惯例；格子色复用 `--color-diff-diagonal-fill`——那本就是「叠在编辑器
 * 底色上、明暗两档都成立」的半透明 token。图外一圈 `border-panel-border`，让一张与底色同色的图
 * 有边界可辨。图按宽高一起缩进面板、只缩不放（照 VS Code 的「Whole Image」）：宽 `max-w-full`，
 * 高是 `ImageRow` 那个 size 容器的 `100cqh` 减去内层 `p-4`（2rem）、figure 的 `gap-1` 与一行
 * `text-xs` 的 caption（1.25rem）、上下边框（2px）——`h-auto` 下两条上限按比例取紧的那条。只限宽
 * 时高图要往下滚才看得全。不做缩放、滑块、洋葱皮。
 *
 * **容器矮于 8rem 时 `max-h` 撤掉、退回只限宽**：那条 calc 在矮容器里是负数、钳成 0，图整张
 * 消失；而容器高为 0 正是「调用方的 `Panel` 没带 `fill`」的样子——`flex-1` 在非 flex 的父级里
 * 不生效，size 容器又不由内容撑高。两种都退成往下滚，而不是一张看不见的图。门槛离 calc 归零的点
 * （约 3.4rem）留足余量：贴着它定，略高于门槛的容器会把图压成十几像素的一条。
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
  sha,
}: {
  side: ImageSide;
  which: 'old' | 'new';
  label: string | null;
  sha?: string | undefined;
}) {
  const [failed, setFailed] = useState(false);
  const [dimensions, setDimensions] = useState<string | null>(null);
  const size = side.size > 0 ? formatSize(side.size, true) : null;

  // 说明文字挂在图的**右下角**：figure 是一列 flex、宽度由图撑，caption `self-end` 贴右；排在
  // 图上方会把两张并排的图顶得不齐（caption 宽度随文字变）。侧别与尺寸之间用「·」隔开，尺寸与
  // 体积之间不加点、只隔一段空（caption 自己是一行 flex，`gap-2`）——`320 × 240 · 1.59 KB` 里
  // 那个点把两个数字读成并列的两项，而它们说的是同一张图的两个维度。**棋盘那层同样 `self-end`**：
  // figure 的宽取图与 caption 里宽的那个，图比 caption 窄（小图、按高缩过的高图）时 stretch 会把
  // 棋盘拉到 caption 那么宽，图右边多出一截空格子；两样都贴右，caption 才仍在图的右下角
  const lead = [label, dimensions].filter((part) => part !== null).join(' · ');

  return (
    <figure class="flex min-w-0 max-w-full flex-col gap-1">
      {failed ? (
        <Notice>Could not load the image.</Notice>
      ) : (
        <div class="checkerboard inline-block max-w-full self-end border border-panel-border">
          {/* alt 留空：文件名已在标签栏与标题上，读屏再念一遍是噪音 */}
          <img
            src={blobUrl(side.path, which, side.version, sha)}
            alt=""
            class="block h-auto max-h-[calc(100cqh-3.25rem-2px)] max-w-full [@container(height<8rem)]:max-h-none"
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
 * 放图的那一行，**两个视图共用，一张图也走它**。图在面板里水平、垂直都居中。
 *
 * 外层 `flex-1` 吃掉面板里提示行之外的剩余高度——前提是调用方的 `Panel` 带 `fill`、成一列 flex。
 * 它同时是 size 容器（`@container-size`），给图的 `max-h` 一个 `cqh` 基准：百分比高度要求
 * 从面板到 `<img>` 每一层都有确定高度，而 figure 在居中的 flex 行里恰恰没有。size 容器的高不再
 * 由内容撑，正好——它本来就该是面板给多少是多少。
 *
 * **居中靠内层 `m-auto`，不靠 `items-center`**：两张缩完仍并排不下时上下排，内容比面板高；auto
 * margin 遇到负的剩余空间归零、从顶部起排，溢出的那截往下由 `Panel` 滚，而 `items-center` 会把
 * 溢出均分到上下两头，顶上那截滚不到。两张 `flex-wrap`，与 diff 的版式切换不联动（那道量的是
 * 文本两列够不够宽，对图没有意义）。**单张那侧不能退成普通块盒**：块盒下 figure 铺满面板宽，
 * caption 的 `self-end` 贴的是面板右边而不是图的右下角。
 */
function ImageRow({ children }: { children: ComponentChildren }) {
  return (
    <div class="@container-size flex flex-1">
      <div class="m-auto flex flex-wrap items-start justify-center gap-4 p-4">{children}</div>
    </div>
  );
}

/**
 * diff 那侧：`Before` / `After` 各一张，`null` 的那侧不画——新增只有右、删除只有左。`key` 是
 * 内容身份：内容没变的那一侧不重挂、不重取。收的是两侧而不是整份 `image` payload：SVG 预览的
 * 两侧挂在文本 payload 上，形状相同。
 */
export function ImageDiff({
  sides,
  sha,
}: {
  sides: ImagePreview;
  /** 提交历史里的那份 diff：两侧的字节都按这次提交去取。 */
  sha?: string | undefined;
}) {
  return (
    <ImageRow>
      {sides.old && (
        <ImageFigure
          key={sides.old.version}
          side={sides.old}
          which="old"
          label="Before"
          sha={sha}
        />
      )}
      {sides.new && (
        <ImageFigure key={sides.new.version} side={sides.new} which="new" label="After" sha={sha} />
      )}
    </ImageRow>
  );
}

/** 文件视图那侧：工作区那一张，不带标题。`payload` 是 `image` 那支或文本上的 SVG 预览。 */
export function ImageFile({ path, payload }: { path: string; payload: FilePreview }) {
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
