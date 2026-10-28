// markdown 的渲染档：白名单清洗、URL 规则、图片改写，以及 FileView 什么时候走这一路。
//
// 清洗那几条钉的是「进页面的只剩白名单里的标签、属性与 URL」——漏了不报错，CSP 也只拦得住脚本。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FilePayload } from '../../../src/server/shared/protocol';
import { FileView } from '../../../src/web/components/FileView';
import { renderMarkdown, resolveRelative } from '../../../src/web/components/MarkdownView';
import { setReveal } from '../../../src/web/state/editors';
import { markdownPreview } from '../../../src/web/state/store';
import { resetEditors, setFileState, waitFor } from './helpers';

/** 渲染进一个游离的容器再查 DOM：断言结构，不断言 marked 的空白与换行。 */
function dom(markdown: string, path = 'docs/guide.md'): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(path, markdown);
  return host;
}

describe('renderMarkdown', () => {
  it('GFM：标题、表格、删除线、任务列表（勾选框只读）', () => {
    const host = dom(
      '# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~gone~~\n\n- [x] done\n- [ ] todo\n',
    );
    expect(host.querySelector('h1')?.textContent).toBe('Title');
    expect(host.querySelectorAll('td')).toHaveLength(2);
    expect(host.querySelector('del')?.textContent).toBe('gone');
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
  });

  it('原始 HTML 放行白名单子集：居中的标题、徽章照画，align / width 留下', () => {
    const host = dom(
      '<h1 align="center"><img src="assets/mark.svg" width="40" alt=""> difftab</h1>\n\n<p align="center"><a href="https://npmjs.com"><img src="https://img.shields.io/x" alt="npm"></a></p>\n',
      'README.md',
    );
    const heading = host.querySelector('h1');
    expect(heading?.getAttribute('align')).toBe('center');
    expect(heading?.querySelector('img')?.getAttribute('src')).toBe(
      '/api/blob?path=assets%2Fmark.svg&side=new&v=0',
    );
    expect(heading?.querySelector('img')?.getAttribute('width')).toBe('40');
    const badge = host.querySelector('p[align="center"] a');
    expect(badge?.getAttribute('href')).toBe('https://npmjs.com');
    // 外链徽章不加载，画成 alt 文本
    expect(badge?.querySelector('img')).toBeNull();
    expect(badge?.querySelector('.md-image-alt')?.textContent).toBe('npm');
  });

  it('危险的标签连内容删掉，事件属性、style、任意 class 一律不留', () => {
    const host = dom(
      '<script>alert(1)</script>\n\n<div class="fixed inset-0 hljs-keyword" style="color:red" onclick="x()">kept <iframe src="https://x.test"></iframe><font color="red">font</font></div>\n\ntext <img src="a.png" onerror="alert(1)" srcset="https://x.test/a.png"> <input type="text" value="x">\n',
    );
    expect(host.querySelector('script, iframe, font')).toBeNull();
    expect(host.textContent).not.toContain('alert(1)');
    const div = host.querySelector('div');
    expect(div?.getAttribute('class')).toBe('hljs-keyword');
    expect(div?.hasAttribute('style')).toBe(false);
    expect(div?.hasAttribute('onclick')).toBe(false);
    // 不在表里的标签拆掉外壳、留下孩子
    expect(div?.textContent).toBe('kept font');
    const img = host.querySelector('img');
    expect(img?.hasAttribute('onerror')).toBe(false);
    expect(img?.hasAttribute('srcset')).toBe(false);
    expect(host.querySelector('input')).toBeNull();
  });

  it('<picture> 的 <source> 删掉，退回里面那张 <img>', () => {
    const host = dom(
      '<picture><source media="(prefers-color-scheme: dark)" srcset="https://x.test/dark.png"><img src="shot.png" alt="shot"></picture>\n',
    );
    expect(host.querySelector('source')).toBeNull();
    expect(host.querySelector('picture img')?.getAttribute('src')).toBe(
      '/api/blob?path=docs%2Fshot.png&side=new&v=0',
    );
  });

  it('链接：外链新开标签页带 rel；相对链接、# 锚点与 javascript: 都不给 href', () => {
    const host = dom(
      '[ext](https://example.com) [mail](mailto:a@b.c) [top](#title) [rel](./other.md) [bad](javascript:alert(1))\n',
    );
    const anchors = [...host.querySelectorAll('a')];
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com',
      'mailto:a@b.c',
    ]);
    expect(anchors[0]?.getAttribute('target')).toBe('_blank');
    expect(anchors[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    // 标题没有 `id`，锚点放行了也只改地址栏不滚动
    expect([...host.querySelectorAll('.md-link')].map((span) => span.textContent)).toEqual([
      'top',
      'rel',
      'bad',
    ]);
  });

  it('图片：相对路径按 md 所在目录解析成 /api/blob，外链与越过仓库根的画成 alt 文本', () => {
    const host = dom(
      '![shot](../assets/a.png) ![root](/logo.svg) ![far](https://x.test/a.png) ![out](../../a.png) ![data](data:image/png;base64,AA)\n',
    );
    const sources = [...host.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(sources).toEqual([
      '/api/blob?path=assets%2Fa.png&side=new&v=0',
      '/api/blob?path=logo.svg&side=new&v=0',
    ]);
    expect([...host.querySelectorAll('.md-image-alt')].map((span) => span.textContent)).toEqual([
      'far',
      'out',
      'data',
    ]);
  });

  it('代码块按围栏语言高亮，认不出的语言转义后原样显示', () => {
    const host = dom('```ts\nconst x = 1;\n```\n\n```nope\n<b>hi</b>\n```\n');
    const [ts, unknown] = [...host.querySelectorAll('pre code')];
    expect(ts?.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(unknown?.querySelector('b')).toBeNull();
    expect(unknown?.textContent).toBe('<b>hi</b>');
  });
  it('围栏信息串只取第一个词认语言；hljs 的修饰记号（class_ 之类）随 token 色留下', () => {
    const host = dom('```ts title="a.ts"\nclass Foo {}\n```\n');
    expect(host.querySelector('pre code .hljs-keyword')?.textContent).toBe('class');
    expect(host.querySelector('pre code .hljs-title')?.getAttribute('class')).toBe(
      'hljs-title class_',
    );
  });

  it('没有 alt 的外链图直接拿掉，不留空框', () => {
    const host = dom('<p><img src="https://x.test/a.png" alt=""> text</p>\n');
    expect(host.querySelector('img, .md-image-alt')).toBeNull();
    expect(host.textContent?.trim()).toBe('text');
  });
});

describe('resolveRelative', () => {
  it('按所在目录解析，`/` 开头按仓库根，query 与片段丢掉、百分号解码', () => {
    expect(resolveRelative('docs/a.md', 'img/x.png')).toBe('docs/img/x.png');
    expect(resolveRelative('docs/a.md', './../x.png?raw=1#top')).toBe('x.png');
    expect(resolveRelative('docs/a.md', '/x%20y.png')).toBe('x y.png');
    expect(resolveRelative('a.md', '../x.png')).toBeNull();
    expect(resolveRelative('a.md', '%E0')).toBeNull();
  });
});

describe('FileView 的 markdown 渲染档', () => {
  const MD: FilePayload = { kind: 'text', content: '# Title\n', markdown: true };
  let container: HTMLElement;
  const show = (path: string, payload: FilePayload) => {
    setFileState(path, { status: 'ready', payload });
    render(<FileView path={path} />, container);
  };
  const article = () => container.querySelector('article.markdown-body');

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    resetEditors();
  });

  afterEach(() => {
    render(null, container);
  });

  it('开关默认关：按源码画；开着时换成渲染档，且不套 w-max', async () => {
    show('README.md', MD);
    await waitFor(() => expect(container.textContent).toContain('# Title'));
    expect(article()).toBeNull();

    markdownPreview.value = true;
    show('README.md', MD);
    await waitFor(() => expect(article()?.querySelector('h1')?.textContent).toBe('Title'));
    expect(container.querySelector('.w-max')).toBeNull();
  });

  it('不带 markdown 字段的文本开关开着也按源码画——前端不判扩展名', async () => {
    markdownPreview.value = true;
    show('README.md', { kind: 'text', content: '# Title\n' });
    await waitFor(() => expect(container.textContent).toContain('# Title'));
    expect(article()).toBeNull();
  });

  it('挂着跳行请求的那个文件按源码画', async () => {
    markdownPreview.value = true;
    setReveal('README.md', 1);
    show('README.md', MD);
    await waitFor(() => expect(container.querySelector('[data-reveal-line="1"]')).not.toBeNull());
    expect(article()).toBeNull();
  });
});
