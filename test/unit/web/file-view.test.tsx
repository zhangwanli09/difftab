// FileView 的五个 payload 分支（图片那一支的正文在 image-view.test.tsx）。
//
// 未知扩展名没退回 `plaintext` 时 `hljs.highlight` 直接抛，炸掉的是整个文件视图。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilePayload } from '../../../src/server/shared/protocol';
import { FileView } from '../../../src/web/components/FileView';
import { revealRequest, setReveal } from '../../../src/web/state/editors';
import {
  type FileRequestState,
  fileMarkStates,
  fileStates,
  wordWrap,
} from '../../../src/web/state/store';
import { setFileState, waitFor } from './helpers';

let container: HTMLElement;

/** 写这个路径的缓存，并让视图画它（产品里 `path` 由 `App` 按活动 tab 给）。 */
const set = (path: string, state: FileRequestState) => {
  setFileState(path, state);
  render(<FileView path={path} />, container);
};
const ready = (path: string, payload: FilePayload) => set(path, { status: 'ready', payload });

/** 滚动容器（视图的根），以及它里面那个「按内容撑宽」的盒子。 */
const scroller = () => container.querySelector('.overflow-auto');
const wideBox = () => scroller()?.firstElementChild ?? null;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  fileStates.value = new Map();
});

afterEach(() => {
  render(null, container);
  fileStates.value = new Map();
});

describe('FileView', () => {
  it('缓存里还没有这个路径时画一行加载中', async () => {
    // 这一路在产品里到不了（`openEditor` 与写 loading 同一个 tick），钉的只是「本组件对缺项也
    // 有答案」，且答案是提示行不是空态——面板不是空着，是这个文件还没来
    render(<FileView path="src/app.ts" />, container);
    await waitFor(() => expect(container.textContent).toContain('Loading…'));
    expect(container.querySelector('svg')).toBeNull();
  });

  it('loading 与 error 各说各的', async () => {
    set('src/app.ts', { status: 'loading' });
    await waitFor(() => expect(container.textContent).toContain('Loading…'));

    set('src/app.ts', { status: 'error', message: 'file no longer exists' });
    await waitFor(() => expect(container.textContent).toContain('Could not load this file'));
    expect(container.textContent).toContain('file no longer exists');
  });

  it('提示行那几路不给 w-max——`max-content` 下 break-all 一次都不生效', async () => {
    // symlink 那句里的目标路径带着 `break-all` 正是为长路径写的。外层一旦是 `max-content`，
    // 那条 `break-all` 只把 min-content 降到一个字符、max-content 仍是整句不断，实测把这一层
    // 撑到 1977px（面板 960px）——提示语横着跑出面板，而没有任何门禁看得见
    ready('link', { kind: 'symlink', target: `${'../'.repeat(60)}target.txt` });
    await waitFor(() => expect(container.textContent).toContain('Symbolic link to'));
    expect(wideBox()?.classList.contains('w-max')).toBe(false);

    set('a.ts', { status: 'error', message: 'x' });
    await waitFor(() => expect(container.textContent).toContain('Could not load this file'));
    expect(wideBox()?.classList.contains('w-max')).toBe(false);
  });

  it('滚动时留在原处的那几样：视图只有滚动那一层、外层 w-max、行号槽', async () => {
    ready('a.ts', { kind: 'text', content: 'const x = 1;\n' });
    await waitFor(() => expect(container.textContent).toContain('const x = 1;'));

    // 视图的根就是滚动层，没有自己的标题栏：「在看哪个文件」由标签栏答，它在 `App` 里是滚动层
    // 的兄弟，因此既不竖向滚也不横向滚。滚动层的类名与 diff 那侧逐字相同（`Panel` 只此一份）
    expect(container.querySelector('h2')).toBeNull();
    expect(container.firstElementChild).toBe(scroller());
    expect(scroller()?.className).toBe('min-h-0 flex-1 overflow-auto');

    // 横向滚动发生在标签栏底下那层容器上，而这一层若只有面板那么宽，行号槽那条 `sticky` 的
    // 滑动余量就是 0——粘不粘一个样。happy-dom 没有排版引擎，能断言的只有类名在不在
    //（同 branch-status）
    expect(wideBox()?.classList.contains('w-max')).toBe(true);

    // 行号槽：余量给够之后它才真的留在左边，否则整列跟着内容滑出视口
    const gutter = container.querySelector('pre');
    expect(gutter?.classList.contains('sticky')).toBe(true);
    expect(gutter?.classList.contains('left-0')).toBe(true);
  });

  it('文本文件高亮出颜色，且行号与代码行数对得上', async () => {
    ready('a.ts', { kind: 'text', content: 'const x = 1;\nconst y = 2;\n' });
    await waitFor(() => expect(container.textContent).toContain('const x = 1;'));

    // hljs 真的跑过了：keyword 那一档有独立选择器，不依赖容器上的 hljs 类
    expect(container.querySelector('.hljs-keyword')).not.toBeNull();
    // 末尾那个换行不算一行——否则每个正常结尾的文件都多出一个空行号
    const gutter = container.querySelectorAll('pre')[0];
    expect(gutter?.textContent).toBe('1\n2');
  });

  it('未知扩展名与无扩展名都退回 plaintext，不抛', async () => {
    for (const path of ['notes.zzz', 'LICENSE', 'Dockerfile']) {
      ready(path, { kind: 'text', content: 'plain text here\n' });
      await waitFor(() => expect(container.textContent).toContain('plain text here'));
    }
  });

  it('符号链接说的是「指向哪」，不是目标的内容', async () => {
    ready('link', { kind: 'symlink', target: '../outside.txt' });
    await waitFor(() => expect(container.textContent).toContain('Symbolic link to'));
    expect(container.textContent).toContain('../outside.txt');
  });

  it('二进制与两个 too-large 分支各说一句不同的话', async () => {
    ready('logo.bin', { kind: 'binary' });
    await waitFor(() => expect(container.textContent).toContain('Binary file'));

    ready('huge.bin', { kind: 'too-large', size: 6 * 1024 * 1024, reason: 'size' });
    await waitFor(() => expect(container.textContent).toContain('File too large to show (6.0 MB)'));

    // 行数那一路的体积可能只有几百 KB，按 MB 取整会显示「0 MB」
    ready('wide.txt', { kind: 'too-large', size: 300 * 1024, reason: 'lines' });
    await waitFor(() => expect(container.textContent).toContain('Too many lines to show (300 KB)'));
  });

  it('换文件时新正文换掉旧的（卸载重挂那半归 App 按 tab 键给的 key，在 app.test 里钉）', async () => {
    ready('a.ts', { kind: 'text', content: 'const first = 1;\n' });
    await waitFor(() => expect(container.textContent).toContain('const first'));
    ready('b.ts', { kind: 'text', content: 'const second = 2;\n' });
    await waitFor(() => expect(container.textContent).toContain('const second'));
    expect(container.textContent).not.toContain('const first');
  });
});

describe('跳到行', () => {
  const band = () => container.querySelector<HTMLElement>('[data-reveal-line]');

  const original = HTMLElement.prototype.scrollIntoView;

  afterEach(() => {
    revealRequest.value = null;
    HTMLElement.prototype.scrollIntoView = original;
  });

  it('键对得上时按行号 × 行高画一条高亮带，并把它滚进视野', async () => {
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    setReveal('src/app.ts', 5);
    ready('src/app.ts', { kind: 'text', content: 'a\nb\nc\nd\ne\nf\n' });
    await waitFor(() => expect(band()).not.toBeNull());
    // 第 5 行：上内边距 8px + 4 × 20px
    expect(band()?.style.top).toBe('88px');
    expect(band()?.style.height).toBe('20px');
    expect(scrolled).toHaveBeenCalledTimes(1);

    // 再点同一行（新的请求对象）要重滚一次
    setReveal('src/app.ts', 5);
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2));
  });

  // 高亮带的位置是按 `leading-5`（20px）与 `py-2`（8px）手算的：改了这两个类而没改 `LINE_HEIGHT` /
  // `PAD_TOP` 时，高亮静默落到别的行上——这条把两头钉在一起
  it('正文那一层仍是 leading-5、正文 <pre> 仍是 py-2——跳行位置的算法依赖这两个值', async () => {
    ready('src/app.ts', { kind: 'text', content: 'a\n' });
    await waitFor(() => expect(container.querySelectorAll('pre')).toHaveLength(2));
    const [gutter, text] = [...container.querySelectorAll('pre')];
    expect(gutter?.parentElement?.classList.contains('leading-5')).toBe(true);
    expect(text?.classList.contains('py-2')).toBe(true);
  });

  it('别的文件的跳行与这里无关；不带行号地重开即清掉', async () => {
    setReveal('other.ts', 2);
    ready('src/app.ts', { kind: 'text', content: 'a\n' });
    await waitFor(() => expect(container.textContent).toContain('a'));
    expect(band()).toBeNull();

    setReveal('src/app.ts', 1);
    await waitFor(() => expect(band()).not.toBeNull());
    setReveal('src/app.ts');
    await waitFor(() => expect(band()).toBeNull());
  });
});

describe('改动标记', () => {
  const marks = () => [...container.querySelectorAll<HTMLElement>('[data-mark]')];

  afterEach(() => {
    fileMarkStates.value = new Map();
  });

  it('按行号 × 行高画在行号槽里，三种各一个样子', async () => {
    fileMarkStates.value = new Map([
      [
        'a.ts',
        [
          { kind: 'added', line: 1, count: 2 },
          { kind: 'modified', line: 4, count: 1 },
          { kind: 'deleted', line: 6, count: 0 },
        ],
      ],
    ]);
    ready('a.ts', { kind: 'text', content: 'a\nb\nc\nd\ne\nf\n' });
    await waitFor(() => expect(marks()).toHaveLength(3));
    const [added, modified, deleted] = marks();
    // 挂在行号 `<pre>` 里：它 sticky，横向滚时标记跟着行号槽留在左边
    expect(added?.parentElement).toBe(container.querySelector('pre'));
    expect(added?.dataset.mark).toBe('added');
    expect(added?.style.top).toBe('8px');
    expect(added?.style.height).toBe('40px');
    expect(modified?.style.top).toBe('68px');
    // 删除点是三角，中线压在第 5、6 行之间那条线上（8 + 5 × 20 − 4）
    expect(deleted?.style.top).toBe('104px');
    expect(deleted?.style.height).toBe('');
    expect(added?.getAttribute('class')).toContain('bg-editor-gutter-added-background');
    expect(modified?.getAttribute('class')).toContain('bg-editor-gutter-modified-background');
    expect(deleted?.getAttribute('class')).toContain('border-l-editor-gutter-deleted-background');
  });

  it('没有标记（文件不在变更列表里）时一个都不画，行号槽照旧', async () => {
    ready('a.ts', { kind: 'text', content: 'a\nb\n' });
    await waitFor(() => expect(container.textContent).toContain('a'));
    expect(marks()).toEqual([]);
    expect(container.querySelector('pre')?.textContent).toBe('1\n2');
  });

  it('别的文件的标记与这里无关', async () => {
    fileMarkStates.value = new Map([['other.ts', [{ kind: 'added', line: 1, count: 1 }]]]);
    ready('a.ts', { kind: 'text', content: 'a\n' });
    await waitFor(() => expect(container.textContent).toContain('a'));
    expect(marks()).toEqual([]);
  });
});

describe('自动换行', () => {
  /** 一行一个元素：行号格与代码格同住一行。 */
  const rows = () => [...(container.querySelector('.leading-5')?.children ?? [])] as HTMLElement[];
  const marks = () => [...container.querySelectorAll<HTMLElement>('[data-mark]')];
  const band = () => container.querySelector<HTMLElement>('[data-reveal-line]');
  const original = HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    wordWrap.value = true;
  });

  afterEach(() => {
    wordWrap.value = false;
    revealRequest.value = null;
    fileMarkStates.value = new Map();
    HTMLElement.prototype.scrollIntoView = original;
  });

  it('一行一个元素、行号与代码同住一行；不套 w-max，代码格会折行', async () => {
    ready('a.ts', { kind: 'text', content: 'const x = 1;\n\nconst y = 2;\n' });
    await waitFor(() => expect(container.textContent).toContain('const y = 2;'));
    // `max-content` 下一行都折不了
    expect(wideBox()?.classList.contains('w-max')).toBe(false);
    expect(container.querySelector('pre')).toBeNull();
    // 末尾那个换行不算一行，空行照样占一行
    expect(rows().map((row) => row.firstElementChild?.textContent)).toEqual(['1', '2', '3']);
    const code = rows()[0]?.lastElementChild;
    expect(code?.classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(code?.classList.contains('wrap-anywhere')).toBe(true);
    expect(code?.querySelector('.hljs-keyword')).not.toBeNull();
  });

  it('跨行的 span 每行各自闭合：多行注释的每一行都还是注释色', async () => {
    ready('a.ts', { kind: 'text', content: '/*\n * one\n */\nlet z;\n' });
    await waitFor(() => expect(rows()).toHaveLength(4));
    for (const row of rows().slice(0, 3)) {
      expect(row.lastElementChild?.querySelector('.hljs-comment')).not.toBeNull();
    }
    expect(rows()[3]?.lastElementChild?.querySelector('.hljs-comment')).toBeNull();
  });

  it('关掉即回到两个 <pre>', async () => {
    ready('a.ts', { kind: 'text', content: 'a\nb\n' });
    await waitFor(() => expect(rows()).toHaveLength(2));
    wordWrap.value = false;
    await waitFor(() => expect(container.querySelectorAll('pre')).toHaveLength(2));
    expect(wideBox()?.classList.contains('w-max')).toBe(true);
  });

  it('改动标记挂到行上：竖条逐行画，删除点落在那一行顶边，越过末行时画在末行底边', async () => {
    fileMarkStates.value = new Map([
      [
        'a.ts',
        [
          { kind: 'added', line: 1, count: 2 },
          { kind: 'deleted', line: 3, count: 0 },
          { kind: 'modified', line: 4, count: 1 },
          { kind: 'deleted', line: 5, count: 0 },
        ],
      ],
    ]);
    ready('a.ts', { kind: 'text', content: 'a\nb\nc\nd\n' });
    await waitFor(() => expect(marks()).toHaveLength(5));
    const kindsIn = (line: number) =>
      [...(rows()[line - 1]?.querySelectorAll<HTMLElement>('[data-mark]') ?? [])].map(
        (mark) => mark.dataset.mark,
      );
    expect(kindsIn(1)).toEqual(['added']);
    expect(kindsIn(2)).toEqual(['added']);
    expect(kindsIn(3)).toEqual(['deleted']);
    expect(kindsIn(4)).toEqual(['modified', 'deleted']);
    const [top, bottom] = marks().filter((mark) => mark.dataset.mark === 'deleted');
    expect(top?.style.top).toBe('-4px');
    expect(bottom?.style.bottom).toBe('-4px');
    expect(marks()[0]?.getAttribute('class')).toContain('bg-editor-gutter-added-background');
  });

  it('末行之前与文件末尾各删过一段时，末行顶边与底边各一个删除点', async () => {
    fileMarkStates.value = new Map([
      [
        'a.ts',
        [
          { kind: 'deleted', line: 2, count: 0 },
          { kind: 'deleted', line: 3, count: 0 },
        ],
      ],
    ]);
    ready('a.ts', { kind: 'text', content: 'a\nb\n' });
    await waitFor(() => expect(marks()).toHaveLength(2));
    const inLast = [...(rows()[1]?.querySelectorAll<HTMLElement>('[data-mark]') ?? [])];
    expect(inLast.map((mark) => [mark.style.top, mark.style.bottom])).toEqual([
      ['-4px', ''],
      ['', '-4px'],
    ]);
  });

  it('跳行：那一行的代码格垫高亮底色并滚进视野', async () => {
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    setReveal('src/app.ts', 2);
    ready('src/app.ts', { kind: 'text', content: 'a\nb\nc\n' });
    await waitFor(() => expect(band()).not.toBeNull());
    expect(band()).toBe(rows()[1]?.lastElementChild);
    expect(band()?.classList.contains('bg-editor-range-highlight-background')).toBe(true);
    expect(scrolled).toHaveBeenCalledTimes(1);
  });
});
