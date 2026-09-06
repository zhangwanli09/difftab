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
