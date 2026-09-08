// FileView 的四个 payload 分支与那条层叠取舍。
//
// 两条钉的都是「不报错、只是不对」：容器一旦挂上 `hljs` 类，那条 unlayered 的
// `.hljs { background }` 会压过 `bg-editor-background`，页面上只是底色跟别处对不上；而
// 未知扩展名没退回 `plaintext` 时 `hljs.highlight` 直接抛，炸掉的是整个文件视图。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilePayload } from '../../../src/server/shared/protocol';
import { FileView } from '../../../src/web/components/FileView';
import { fileState } from '../../../src/web/state/store';

let container: HTMLElement;

const waitFor = (assert: () => void) => vi.waitFor(assert, { interval: 5 });

const ready = (path: string, payload: FilePayload) => {
  fileState.value = { status: 'ready', path, payload };
};

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  fileState.value = null;
  // 只挂载一次，之后各用例只写 state——手动补 render 会把「状态变了会不会重画」替它做掉
  render(<FileView />, container);
});

afterEach(() => {
  render(null, container);
  fileState.value = null;
});

describe('FileView', () => {
  it('还没点过文件时是那句空态', async () => {
    await waitFor(() => expect(container.textContent).toContain('Select a file on the left.'));
  });

  it('loading 与 error 各说各的，且标题上始终是当前那个路径', async () => {
    fileState.value = { status: 'loading', path: 'src/app.ts' };
    await waitFor(() => expect(container.textContent).toContain('Loading…'));
    expect(container.querySelector('h2')?.textContent).toBe('src/app.ts');

    fileState.value = { status: 'error', path: 'src/app.ts', message: 'file no longer exists' };
    await waitFor(() => expect(container.textContent).toContain('Could not load this file'));
    expect(container.textContent).toContain('file no longer exists');
  });

  it('提示行那几路不给 w-max——`max-content` 下 break-all 一次都不生效', async () => {
    // symlink 那句里的目标路径带着 `break-all` 正是为长路径写的。外层一旦是 `max-content`，
    // 那条 `break-all` 只把 min-content 降到一个字符、max-content 仍是整句不断，实测把这一层
    // 撑到 1977px（面板 960px）——提示语横着跑出面板，而没有任何门禁看得见
    ready('link', { kind: 'symlink', target: `${'../'.repeat(60)}target.txt` });
    await waitFor(() => expect(container.textContent).toContain('Symbolic link to'));
    expect(container.firstElementChild?.className).toBe('');

    fileState.value = { status: 'error', path: 'a.ts', message: 'x' };
    await waitFor(() => expect(container.textContent).toContain('Could not load this file'));
    expect(container.firstElementChild?.className).toBe('');
  });

  it('横向滚动下留在左边的那几样：外层 w-max、行号槽、标题栏里那段路径', async () => {
    ready('a.ts', { kind: 'text', content: 'const x = 1;\n' });
    await waitFor(() => expect(container.textContent).toContain('const x = 1;'));

    // 横向滚动发生在外面那个面板上，而这一层若只有面板那么宽，下面这几处 `sticky` 的滑动
    // 余量就都是 0——粘不粘一个样。`min-w-full` 那半条挡的是反面：短文件下这一层比面板还
    // 窄，标题栏缩成半截。happy-dom 没有排版引擎，能断言的只有类名在不在（同 branch-status）
    const box = container.firstElementChild;
    expect(box?.classList.contains('w-max')).toBe(true);
    expect(box?.classList.contains('min-w-full')).toBe(true);

    // 行号槽：余量给够之后它才真的留在左边，否则整列跟着内容滑出视口
    const gutter = container.querySelector('pre');
    expect(gutter?.classList.contains('sticky')).toBe(true);
    expect(gutter?.classList.contains('left-0')).toBe(true);

    // 路径那段同理：横杠铺满整条可滚宽度、字留在左边，两件事分给 `<h2>` 与里面那个 span。
    // **`px-4` 必须与 `sticky` 同住那个 span**——留在 `<h2>` 上时这条得改写成 `left-4` 去抵消
    // 它，而那两个数字从此必须一直相等
    const label = container.querySelector('h2 span');
    for (const cls of ['sticky', 'left-0', 'inline-block', 'px-4']) {
      expect(label?.classList.contains(cls)).toBe(true);
    }

    const bar = container.querySelector('h2');
    expect([...(bar?.classList ?? [])].some((cls) => cls.startsWith('px-'))).toBe(false);
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

  it('换文件走卸载重挂——两份正文不会落在同一棵子树上', async () => {
    ready('a.ts', { kind: 'text', content: 'const first = 1;\n' });
    await waitFor(() => expect(container.textContent).toContain('const first'));
    ready('b.ts', { kind: 'text', content: 'const second = 2;\n' });
    await waitFor(() => expect(container.textContent).toContain('const second'));
    expect(container.textContent).not.toContain('const first');
  });
});
