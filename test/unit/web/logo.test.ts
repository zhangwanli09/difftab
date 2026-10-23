// favicon 是 `scripts/logo.mjs` 从几何与 `app.css` 的 token 生成后写死进 `index.html` 的一段——改了
// 几何或改了 token 却没重跑脚本，页面上什么都不会响：标签页图标只是与顶栏那枚「看着有点不一样」。
// 官网 `site/index.html` 里是同一段，脚本两份一起回写，所以两份一起钉；官网页眉那枚内联符号同理。
//
// 本文件拿 `index.html` 里现成的那段与脚本此刻会产出的那段比。PNG 那条是截图、不确定，只钉 SVG。

import { describe, expect, it } from 'vitest';
import { faviconSvg, siteMarkSvg, svgDataUri } from '../../../scripts/logo.mjs';
import siteHtml from '../../../site/index.html?raw';
import indexHtml from '../../../src/web/index.html?raw';

describe.each([
  ['src/web/index.html', indexHtml],
  ['site/index.html', siteHtml],
])('%s 的 favicon 与生成脚本同步', (_, html) => {
  it('SVG 那条就是脚本此刻会生成的那条', () => {
    expect(html).toContain(`href="${svgDataUri(faviconSvg())}"`);
  });

  it('PNG 兜底排在 SVG 之前——浏览器取靠后的那条合适的', () => {
    expect(html.indexOf('href="data:image/png;base64,')).toBeLessThan(
      html.indexOf('href="data:image/svg+xml,'),
    );
  });
});

describe('site/index.html 的页眉符号与生成脚本同步', () => {
  it('就是脚本此刻会从几何生成的那枚', () => {
    expect(siteHtml).toContain(siteMarkSvg());
  });
});
