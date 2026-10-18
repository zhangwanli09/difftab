// 图片那一支（`ImageView`），两个面板共用。
//
// 三条都是「不报错、只是不对」：`v=` 戳不随 payload 变时 SSE 后停在旧图上；前端若自己按扩展名判
// 图片，与后端那张表就是两份事实来源；`NEEDS_WIDE_BOX.image` 写成 true 时宽图把滚动区撑到原始
// 像素宽。happy-dom 没有排版引擎也不真的去取图，能断言的是 `src` / 类名 / 文案。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiffPayload, FilePayload } from '../../../src/server/shared/protocol';
import { DiffView } from '../../../src/web/components/DiffView';
import { FileView } from '../../../src/web/components/FileView';
import { revealRequest } from '../../../src/web/state/editors';
import { diffPanelWidth, SIDE_BY_SIDE_MIN_WIDTH } from '../../../src/web/state/layout';
import { diffStates, PATCH_DEFAULTS, svgPreview } from '../../../src/web/state/store';
import { resetEditors, setFileState, waitFor } from './helpers';

let container: HTMLElement;

const readyDiff = (path: string, payload: DiffPayload) => {
  diffStates.value = new Map(diffStates.value).set(path, {
    status: 'ready',
    rename: null,
    options: PATCH_DEFAULTS,
    payload,
  });
};
const readyFile = (path: string, payload: FilePayload) =>
  setFileState(path, { status: 'ready', payload });

const images = () => [...container.querySelectorAll('img')];
const srcOf = (img: HTMLImageElement) => new URL(img.getAttribute('src') ?? '', 'http://x');

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  resetEditors();
  diffPanelWidth.value = SIDE_BY_SIDE_MIN_WIDTH;
});

afterEach(() => {
  render(null, container);
});

describe('ImageDiff', () => {
  it('两侧都有时画 Before / After 两张，src 指向 /api/blob 的对应侧', async () => {
    readyDiff('img/a.png', {
      kind: 'image',
      old: { path: 'img/a.png', size: 1024, version: 'v1' },
      new: { path: 'img/a.png', size: 2 * 1024, version: 'v1' },
    });
    render(<DiffView path="img/a.png" />, container);
    await waitFor(() => expect(images()).toHaveLength(2));

    const [before, after] = images().map(srcOf);
    expect(before?.pathname).toBe('/api/blob');
    expect(before?.searchParams.get('side')).toBe('old');
    expect(before?.searchParams.get('path')).toBe('img/a.png');
    expect(after?.searchParams.get('side')).toBe('new');
    expect(container.textContent).toContain('Before');
    expect(container.textContent).toContain('After');
    expect(container.textContent).toContain('1.00 KB');
    expect(container.textContent).toContain('2.00 KB');
    // 图片不走补丁表格
    expect(container.querySelector('[data-diff-layout]')).toBeNull();
    // 两张一组在面板里水平居中
    const row = images()[0]?.closest('figure')?.parentElement;
    expect(row?.className.split(' ')).toContain('justify-center');
    // diff 那侧同样铺满面板的高
    expect(container.querySelector('.overflow-auto')?.className.split(' ')).toContain('flex-col');
  });

  it('删除只有 Before、新增只有 After；重命名的旧侧 path 原样用 payload 给的', async () => {
    readyDiff('gone.png', {
      kind: 'image',
      old: { path: 'gone.png', size: 10, version: 'v1' },
      new: null,
    });
    render(<DiffView path="gone.png" />, container);
    await waitFor(() => expect(images()).toHaveLength(1));
    expect(srcOf(images()[0] as HTMLImageElement).searchParams.get('side')).toBe('old');
    expect(container.textContent).toContain('Before');
    expect(container.textContent).not.toContain('After');

    render(null, container);
    readyDiff('img/moved.png', {
      kind: 'image',
      old: { path: 'img/old.png', size: 10, version: 'v1' },
      new: { path: 'img/moved.png', size: 10, version: 'v1' },
    });
    render(<DiffView path="img/moved.png" />, container);
    await waitFor(() => expect(images()).toHaveLength(2));
    // 前端不自己拼旧路径——它没有 status 的 `2 ` 记录语义
    expect(srcOf(images()[0] as HTMLImageElement).searchParams.get('path')).toBe('img/old.png');
  });

  it('v= 是后端给的内容身份：version 不变时重取不换 URL、不重挂，变了才换', async () => {
    const payload = (version: string): DiffPayload => ({
      kind: 'image',
      old: null,
      new: { path: 'new.png', size: 10, version },
    });
    readyDiff('new.png', payload('a'));
    render(<DiffView path="new.png" />, container);
    await waitFor(() => expect(images()).toHaveLength(1));
    const first = images()[0] as HTMLImageElement;
    expect(srcOf(first).searchParams.get('v')).toBe('a');

    // 无关文件的 SSE：loadDiff 落进一个新对象，内容身份没变——同一个 <img>、同一个 URL，
    // 浏览器不会再下一次
    readyDiff('new.png', payload('a'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(images()[0]).toBe(first);

    // 图真的改了：身份变了，URL 跟着变
    readyDiff('new.png', payload('b'));
    await waitFor(() =>
      expect(srcOf(images()[0] as HTMLImageElement).searchParams.get('v')).toBe('b'),
    );
    expect(images()[0]).not.toBe(first);
  });

  it('体积精确到两位小数，1 KB 以下不套整 KB 那档的下限', async () => {
    readyDiff('a.png', {
      kind: 'image',
      old: { path: 'a.png', size: 69, version: 'v1' },
      new: null,
    });
    render(<DiffView path="a.png" />, container);
    await waitFor(() => expect(container.textContent).toContain('0.07 KB'));

    render(null, container);
    readyDiff('b.png', {
      kind: 'image',
      old: null,
      new: { path: 'b.png', size: Math.round(1.5 * 1024 * 1024), version: 'v1' },
    });
    render(<DiffView path="b.png" />, container);
    await waitFor(() => expect(container.textContent).toContain('1.50 MB'));
  });

  it('图底下垫棋盘、图自己缩到面板宽；体积为 0 时不编一个数', async () => {
    readyDiff('a.png', {
      kind: 'image',
      old: { path: 'a.png', size: 0, version: 'v1' },
      new: null,
    });
    render(<DiffView path="a.png" />, container);
    await waitFor(() => expect(images()).toHaveLength(1));
    const img = images()[0] as HTMLImageElement;
    expect(img.className.split(' ')).toContain('max-w-full');
    expect(img.parentElement?.className.split(' ')).toContain('checkerboard');
    // 图比 caption 窄时 stretch 会把棋盘拉到 caption 宽：贴右、不拉伸
    expect(img.parentElement?.className.split(' ')).toContain('self-end');
    expect(container.textContent).not.toContain('KB');
  });

  it('图到了之后 caption 补上像素尺寸：侧别 · 尺寸一段，体积另一段', async () => {
    readyDiff('a.png', {
      kind: 'image',
      old: null,
      new: { path: 'a.png', size: 2 * 1024, version: 'v1' },
    });
    render(<DiffView path="a.png" />, container);
    await waitFor(() => expect(images()).toHaveLength(1));
    const img = images()[0] as HTMLImageElement;
    // happy-dom 不真的解码，尺寸得自己钉上去再派发 load——产品里这两个值来自浏览器的解码结果
    Object.defineProperty(img, 'naturalWidth', { value: 320 });
    Object.defineProperty(img, 'naturalHeight', { value: 240 });
    img.dispatchEvent(new Event('load'));
    // 尺寸与体积是 caption 里并排的两个 span（中间只隔 gap，不加点）
    await waitFor(() =>
      expect(
        [...(container.querySelector('figcaption')?.children ?? [])].map((el) => el.textContent),
      ).toEqual(['After · 320 × 240', '2.00 KB']),
    );
  });

  it('上一次取图失败不会钉死：内容变了就重挂一个干净的 <img>', async () => {
    const payload = (version: string): DiffPayload => ({
      kind: 'image',
      old: null,
      new: { path: 'a.png', size: 10, version },
    });
    readyDiff('a.png', payload('half-written'));
    render(<DiffView path="a.png" />, container);
    await waitFor(() => expect(images()).toHaveLength(1));
    images()[0]?.dispatchEvent(new Event('error'));
    await waitFor(() => expect(container.textContent).toContain('Could not load the image.'));

    // 文件写完了：新的 mtime → 新的 version，得重新去请求一次
    readyDiff('a.png', payload('complete'));
    await waitFor(() => expect(images()).toHaveLength(1));
    expect(container.textContent).not.toContain('Could not load the image.');
  });

  it('图取不回来时本侧换成一句提示，另一侧照画', async () => {
    readyDiff('a.png', {
      kind: 'image',
      old: { path: 'a.png', size: 10, version: 'v1' },
      new: { path: 'a.png', size: 10, version: 'v1' },
    });
    render(<DiffView path="a.png" />, container);
    await waitFor(() => expect(images()).toHaveLength(2));
    images()[0]?.dispatchEvent(new Event('error'));
    await waitFor(() => expect(container.textContent).toContain('Could not load the image.'));
    expect(images()).toHaveLength(1);
  });
});

describe('ImageFile', () => {
  it('文件视图画工作区那一张：side=new、不带 Before / After，且不套 w-max', async () => {
    readyFile('img/a.png', { kind: 'image', size: 3 * 1024, version: 'v1' });
    render(<FileView path="img/a.png" />, container);
    await waitFor(() => expect(images()).toHaveLength(1));
    const src = srcOf(images()[0] as HTMLImageElement);
    expect(src.searchParams.get('side')).toBe('new');
    expect(src.searchParams.get('path')).toBe('img/a.png');
    expect(container.textContent).not.toContain('Before');
    expect(container.textContent).not.toContain('After');
    expect(container.textContent).toContain('3.00 KB');
    // `NEEDS_WIDE_BOX.image` 必须是 false：写 true 时 max-w-full 形同虚设
    const box = container.querySelector('.overflow-auto')?.firstElementChild;
    expect(box?.className).not.toContain('w-max');
    // 单张也走同一条居中的 flex 行：退成普通块盒时 figure 铺满面板宽，caption 贴的是面板右边不是图
    const root = images()[0]?.closest('figure')?.parentElement?.className.split(' ');
    expect(root).toContain('flex');
    expect(root).toContain('justify-center');
  });

  it('图那一支铺满面板的高：滚动层成一列 flex、外层 size 容器 flex-1、内层 m-auto 上下居中', async () => {
    readyFile('img/a.png', { kind: 'image', size: 10, version: 'v1' });
    render(<FileView path="img/a.png" />, container);
    await waitFor(() => expect(images()).toHaveLength(1));
    const img = images()[0] as HTMLImageElement;
    // 只限宽时高图要往下滚：高的上限以放图那一层（size 容器）为基准
    expect(img.className).toContain('max-h-[calc(100cqh');
    // 拿不到高（漏带 fill、面板太矮）时退回只限宽，不让 calc 钳成 0 把图整张吞掉
    expect(img.className).toContain('[@container(height<8rem)]:max-h-none');
    const inner = img.closest('figure')?.parentElement;
    // 居中靠 auto margin：内容比面板高时归零、从顶部起排，不像 items-center 把顶上那截切掉
    expect(inner?.className.split(' ')).toContain('m-auto');
    const outer = inner?.parentElement?.className.split(' ');
    expect(outer).toContain('flex-1');
    expect(outer).toContain('@container-size');
    // 高得一路传下来：滚动层是一列 flex，放图那层直接是它的子项、不再隔一层包裹
    const scroller = container.querySelector('.overflow-auto');
    expect(scroller?.className.split(' ')).toContain('flex-col');
    expect(inner?.parentElement?.parentElement).toBe(scroller);
  });
});

describe('SVG 预览', () => {
  const SVG_PATCH = [
    'diff --git a/logo.svg b/logo.svg',
    '--- a/logo.svg',
    '+++ b/logo.svg',
    '@@ -1 +1 @@',
    '-<svg fill="red"/>',
    '+<svg fill="blue"/>',
    '',
  ].join('\n');

  it('开关关着画补丁表格；开着按 Before / After 画成图、铺满面板的高，不重取', async () => {
    svgPreview.value = false;
    readyDiff('logo.svg', {
      kind: 'text',
      patch: SVG_PATCH,
      full: false,
      preview: {
        old: { path: 'logo.svg', size: 18, version: 'base' },
        new: { path: 'logo.svg', size: 19, version: 'v2' },
      },
    });
    render(<DiffView path="logo.svg" />, container);
    await waitFor(() => expect(container.querySelector('[data-diff-layout]')).not.toBeNull());
    expect(images()).toHaveLength(0);

    svgPreview.value = true;
    await waitFor(() => expect(images()).toHaveLength(2));
    expect(container.querySelector('[data-diff-layout]')).toBeNull();
    const [before, after] = images().map(srcOf);
    expect([before?.searchParams.get('side'), before?.searchParams.get('v')]).toEqual([
      'old',
      'base',
    ]);
    expect([after?.searchParams.get('side'), after?.searchParams.get('v')]).toEqual(['new', 'v2']);
    expect(container.querySelector('.overflow-auto')?.className.split(' ')).toContain('flex-col');
  });

  it('不带 preview 的文本补丁，开关开着也照画补丁', async () => {
    readyDiff('a.ts', {
      kind: 'text',
      patch: SVG_PATCH.replaceAll('logo.svg', 'a.ts'),
      full: false,
    });
    render(<DiffView path="a.ts" />, container);
    await waitFor(() => expect(container.querySelector('[data-diff-layout]')).not.toBeNull());
    expect(images()).toHaveLength(0);
  });

  it('文件视图：开着时画工作区那一张、不套 w-max；关上回到正文', async () => {
    readyFile('logo.svg', {
      kind: 'text',
      content: '<svg fill="blue"/>\n',
      preview: { size: 19, version: 'v2' },
    });
    render(<FileView path="logo.svg" />, container);
    await waitFor(() => expect(images()).toHaveLength(1));
    expect(srcOf(images()[0] as HTMLImageElement).searchParams.get('side')).toBe('new');
    expect(container.querySelector('.w-max')).toBeNull();
    expect(container.querySelector('.overflow-auto')?.className.split(' ')).toContain('flex-col');

    svgPreview.value = false;
    await waitFor(() => expect(images()).toHaveLength(0));
    expect(container.querySelector('.w-max')).not.toBeNull();
  });

  it('文件视图：这个文件挂着跳行请求时按文本画，别的文件的跳行不算', async () => {
    readyFile('logo.svg', {
      kind: 'text',
      content: '<svg fill="blue"/>\n',
      preview: { size: 19, version: 'v2' },
    });
    revealRequest.value = { path: 'other.ts', line: 1 };
    render(<FileView path="logo.svg" />, container);
    await waitFor(() => expect(images()).toHaveLength(1));

    revealRequest.value = { path: 'logo.svg', line: 1 };
    await waitFor(() => expect(images()).toHaveLength(0));
    expect(container.querySelector('.w-max')).not.toBeNull();
  });
});
