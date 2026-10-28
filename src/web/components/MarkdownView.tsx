// 文件视图里 markdown 的渲染档（`Preview` 按下时）。
//
// **marked 的输出整份过一遍白名单清洗再进页面**：README 顶上的居中 logo、徽章是原始 HTML，转义成文本
// 就是一大段标签源码，所以放行一个安全子集（照 GitHub），而不是一律转义。清洗在浏览器自带的
// `<template>` 里做：那里的内容是惰性的，脚本不跑、图不取。标签不在表里的拆掉外壳留下孩子，危险的
// 连内容一起删；属性只留表里那几个，`class` 只认我们自己发的几种——Tailwind 的工具类都在产物里，
// 放行任意 `class` 时一句 `fixed inset-0` 就能把整张页面盖掉，CSP 拦不住这个。
//
// **链接与图片的规则也在清洗这一遍里**，原始 HTML 与 markdown 语法写出来的同一套判据：
// - 链接只放行 `http(s):` / `mailto:`（新开标签页）；相对链接点了会把这张页面导航走，`#` 锚点找不到
//   目标（标题没有 `id`），都画成文本
// - **不往外发请求**：外链图片画成 alt 文本（CSP 的 `img-src 'self' data:` 本来也会拦，拦下来是一张
//   破图加一条控制台报错）；相对路径的图按 md 文件所在目录解析，走与图片视图同一条 `/api/blob`

import { Marked } from 'marked';
import { getHljs, languageOf } from '../diff/hljs';
import { blobUrl } from './ImageView';

/** 带协议头的 URL（`https:` / `javascript:` / `data:` …），以及 `//host` 这种借当前协议的写法。 */
const ABSOLUTE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;
/** 点了新开标签页的外链。其余带协议头的一律不给 `href`。 */
const EXTERNAL = /^(?:https?:|mailto:)/i;

/** 放行的标签。不在表里也不在 `DROPPED` 里的拆掉外壳、留下孩子（`<font>`、`<center>` 之类）。 */
const ALLOWED = new Set([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);

/**
 * 连内容一起删的标签：要么会执行或嵌进别的文档，要么内容不是给人读的正文。`source` 也在这里：它的
 * `srcset` 多半是外链，删掉之后 `<picture>` 退回里面那张 `<img>`。
 */
const DROPPED = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'template',
  'noscript',
  'svg',
  'math',
  'form',
  'textarea',
  'select',
  'button',
  'source',
  'video',
  'audio',
  'link',
  'meta',
  'base',
  'title',
]);

/** 放行的属性。`href` / `src` 不在这里：它们由链接与图片那两条规则单独写回。 */
const ATTRIBUTES = new Set([
  'align',
  'alt',
  'checked',
  'colspan',
  'height',
  'open',
  'rowspan',
  'start',
  'title',
  'type',
  'width',
]);

/**
 * `class` 里放行的那几种：hljs 的 token 色，连同 `class_` / `function_` / `language_` 这类修饰记号
 * （主题按 `.hljs-title.class_` 这种复合选择器配色，丢了就退回另一种颜色），都只管颜色。我们自己的
 * `md-link` / `md-image-alt` 不在表里：那两个 span 在清洗之后才造出来，不再过这一遍。
 */
const CLASS_TOKEN = /^(?:hljs-[\w-]+|[a-z]+_{1,2})$/;

/**
 * md 文件里一个相对路径按它所在目录解析成仓库相对路径。`/` 开头的按仓库根算（GitHub 也这么解析）；
 * 越过仓库根的 `..` 回 `null`，由调用方画成文本——那张图的字节后端本来也不会给。
 */
export function resolveRelative(from: string, target: string): string | null {
  const [pathPart = ''] = target.split(/[?#]/, 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  const base = decoded.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (base.length === 0) return null;
      base.pop();
    } else base.push(segment);
  }
  return base.length === 0 ? null : base.join('/');
}

/** 把 `element` 换成一个 `<span class>`，孩子原样搬过去。 */
function replaceWithSpan(element: Element, className: string): HTMLSpanElement {
  const span = element.ownerDocument.createElement('span');
  span.className = className;
  span.append(...element.childNodes);
  element.replaceWith(span);
  return span;
}

/** 一个链接：外链补 `target` / `rel`，其余（相对路径、`#` 锚点、别的协议头）换成不可点的文本。 */
function cleanLink(element: Element, href: string | null): void {
  if (href === null) return;
  if (EXTERNAL.test(href)) {
    element.setAttribute('href', href);
    element.setAttribute('target', '_blank');
    element.setAttribute('rel', 'noopener noreferrer');
  } else replaceWithSpan(element, 'md-link').title = href;
}

/** 一张图：工作区里的改写成 `/api/blob`，外链与解析不出来的换成 alt 文本。 */
function cleanImage(element: Element, src: string | null, path: string): void {
  const local = src === null || ABSOLUTE.test(src) ? null : resolveRelative(path, src);
  if (local === null) {
    const alt = element.getAttribute('alt') ?? '';
    // 没有 alt 的外链图（徽章、装饰图常见）画成一个空虚线框只是噪音，直接拿掉
    if (alt === '') element.remove();
    else replaceWithSpan(element, 'md-image-alt').textContent = alt;
    return;
  }
  // `v=` 恒为 0：这份 payload 里没有那张图的身份。**已知取舍**：图改了、md 没改时 HTML 字串不变，
  // Preact 不碰 `<img>`、浏览器不重新请求，预览停在旧图——`no-store` 管不到没发出去的请求。按渲染
  // 换戳则每个 SSE 都重下全部图片，正是 `blobUrl` 注释里排除的那种写法
  element.setAttribute('src', blobUrl(local, 'new', '0'));
}

/** 自底向上清洗一棵子树：先清孩子，再按自己的标签决定留、拆还是删。 */
function cleanTree(parent: Node, path: string): void {
  for (const child of [...parent.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    if (!(child instanceof Element)) continue;
    const tag = child.localName;
    if (DROPPED.has(tag)) {
      child.remove();
      continue;
    }
    cleanTree(child, path);
    if (!ALLOWED.has(tag)) {
      child.replaceWith(...child.childNodes);
      continue;
    }
    // 链接与图片的地址先取下来，属性清空之后再按规则写回
    const href = child.getAttribute('href');
    const src = child.getAttribute('src');
    // hljs 的 span 成千上万，多数元素却根本没有 class：先问一句再切
    const classes = child.hasAttribute('class')
      ? (child.getAttribute('class') ?? '').split(/\s+/).filter((name) => CLASS_TOKEN.test(name))
      : [];
    for (const { name } of [...child.attributes]) {
      if (!ATTRIBUTES.has(name)) child.removeAttribute(name);
    }
    if (classes.length > 0) child.setAttribute('class', classes.join(' '));
    if (tag === 'input') {
      // 只留任务列表的勾选框，而且点不动
      if (child.getAttribute('type') !== 'checkbox') child.remove();
      else child.setAttribute('disabled', '');
    } else if (tag === 'a') cleanLink(child, href);
    else if (tag === 'img') cleanImage(child, src, path);
  }
}

/** 白名单清洗 marked 的输出。`path` 是 md 文件自己的路径，相对图片以它所在目录为基准。 */
function sanitize(html: string, path: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  cleanTree(template.content, path);
  return template.innerHTML;
}

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      // `lang` 是整条围栏信息串（```ts title="a.ts"），语言只是第一个词
      const [word = ''] = (lang ?? '').split(/\s/, 1);
      // 认不出的围栏语言 `languageOf` 回 `plaintext`，它是注册过的，按它高亮即是转义
      const language = word === '' ? 'plaintext' : languageOf(`x.${word}`);
      return `<pre><code>${getHljs().highlight(text, { language }).value}</code></pre>\n`;
    },
  },
});

/**
 * 最近一份渲染结果，**模块里只记一份**，理由同 `FileView` 的 `highlightFile`：开关 `Preview`、切 tab
 * 都是卸载重挂，组件里的 memo 跟着丢，不记时每按一次就把整篇从头解析、高亮、清洗一遍，而正文一个
 * 字节都没变。
 */
let lastRender: { path: string; content: string; html: string } | null = null;

/** 渲染成清洗过的 HTML 字串。导出给测试：组件只是把它塞进容器。 */
export function renderMarkdown(path: string, content: string): string {
  if (lastRender?.path !== path || lastRender.content !== content) {
    lastRender = { path, content, html: sanitize(marked.parse(content, { async: false }), path) };
  }
  return lastRender.html;
}

/** markdown 的渲染档。正文自己折行、铺满面板，横向不滚。 */
export function MarkdownView({ path, content }: { path: string; content: string }) {
  const html = renderMarkdown(path, content);
  // 内容已过 `sanitize`：标签、属性、class 与 URL 都只剩白名单里的
  return <article class="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
