// FileView 的四个 payload 分支与那条层叠取舍。
//
// 两条钉的都是「不报错、只是不对」：容器一旦挂上 `hljs` 类，那条 unlayered 的
// `.hljs { background }` 会压过 `bg-editor-background`，页面上只是底色跟别处对不上；而
// 未知扩展名没退回 `plaintext` 时 `hljs.highlight` 直接抛，炸掉的是整个文件视图。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FilePayload } from '../../../src/server/shared/protocol';
import { FileView } from '../../../src/web/components/FileView';
import { type FileRequestState, fileStates } from '../../../src/web/state/store';
import { waitFor } from './helpers';

let container: HTMLElement;

/** 写这个路径的缓存，并让视图画它（产品里 `path` 由 `App` 按活动 tab 给）。 */
const set = (path: string, state: FileRequestState) => {
  fileStates.value = new Map(fileStates.value).set(path, state);
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
    expect(wideBox()?.className).toBe('');

    set('a.ts', { status: 'error', message: 'x' });
    await waitFor(() => expect(container.textContent).toContain('Could not load this file'));
    expect(wideBox()?.className).toBe('');
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

  it('容器上没有 `hljs` 类——那条规则是 unlayered 的，会压过 bg-editor-background', async () => {
    ready('a.ts', { kind: 'text', content: 'const x = 1;\n' });
    await waitFor(() => expect(container.textContent).toContain('const x'));

    for (const node of container.querySelectorAll('*')) {
      expect(node.classList.contains('hljs')).toBe(false);
    }
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
    ready('logo.png', { kind: 'binary' });
    await waitFor(() => expect(container.textContent).toContain('Binary file'));

    ready('huge.bin', { kind: 'too-large', size: 6 * 1024 * 1024, reason: 'size' });
    await waitFor(() => expect(container.textContent).toContain('File too large to show (6.0 MB)'));

    // 行数那一路的体积可能只有几百 KB，按 MB 取整会显示「0 MB」
    ready('wide.txt', { kind: 'too-large', size: 300 * 1024, reason: 'lines' });
    await waitFor(() =>
      expect(container.textContent).toContain('Too many lines to show (300 KB in total)'),
    );
  });

  it('换文件时新正文换掉旧的（卸载重挂那半归 App 按 tab 键给的 key，在 app.test 里钉）', async () => {
    ready('a.ts', { kind: 'text', content: 'const first = 1;\n' });
    await waitFor(() => expect(container.textContent).toContain('const first'));
    ready('b.ts', { kind: 'text', content: 'const second = 2;\n' });
    await waitFor(() => expect(container.textContent).toContain('const second'));
    expect(container.textContent).not.toContain('const first');
  });
});
