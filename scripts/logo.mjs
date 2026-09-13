#!/usr/bin/env node
// logo 资产生成。几何在 `src/web/brand/geometry.mjs`（与 `components/Logo.tsx` 共用同一份），本
// 文件只管把它拼成文件：`assets/` 下的 SVG、社交预览 PNG、`index.html` 里的两条 favicon。
//
// 零依赖纯 JS，可由 `node scripts/logo.mjs` 直接执行。不是 pnpm script。
//
// 用法：
//   node scripts/logo.mjs        重写 assets/*.svg；本机找得到 Chrome 时再渲出社交预览 PNG
//                                与 favicon 的 PNG 兜底，并回写 index.html 两个标记之间那段
//   CHROME=<path> node …         指定 Chrome 可执行文件（默认只认 macOS 的安装位置）
//
// PNG 那两份是截图，不是确定性输出：换一台机器或换一个 Chrome 版本重跑，`social-preview.png` 与
// index.html 里那条 PNG data URI 的字节会变，diff 里像是改了什么，其实几何一字未动——判据看 SVG
// 那半（`logo.test.ts` 钉的也是它）。几何没改就别重跑。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MARK } from '../src/web/brand/geometry.mjs';

const repoRoot = resolve(import.meta.dirname, '..');

/**
 * 颜色从 `app.css` 的 token 里读，不另抄一份：抄本改了 token 不会跟着变，而 `logo.test.ts` 钉着
 * 「index.html 里的 favicon 就是脚本此刻会生成的那条」——于是改了 token 没重跑脚本，红的是它。
 * 红绿不在这里：它们是固定的品牌色，写在几何自己身上，这里只管跟主题走的那几个。
 */
function tokenColors() {
  const css = readFileSync(join(repoRoot, 'src', 'web', 'styles', 'app.css'), 'utf8');
  const pair = (name) => {
    const m = css.match(
      new RegExp(`--color-${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`),
    );
    if (!m) throw new Error(`app.css 里找不到 --color-${name} 的 light-dark() 声明`);
    return { light: m[1], dark: m[2] };
  };
  const fg = pair('editor-foreground');
  return {
    light: fg.light,
    dark: fg.dark,
    darkBg: pair('editor-background').dark,
    darkMuted: pair('description-foreground').dark,
  };
}
const COLORS = tokenColors();

const XMLNS = 'xmlns="http://www.w3.org/2000/svg"';

/** 独立 SVG 文件里的明暗切换：只有上下文那条走 `currentColor`，切的是根元素的 `color`。 */
const darkStyle = `<style>@media(prefers-color-scheme:dark){svg{color:${COLORS.dark}}}</style>`;

/** 几何原样序列化：每个产出的 SVG 与前端渲的是同一份属性。 */
const markShapes = () =>
  MARK.map(
    ([tag, attrs]) =>
      `<${tag} ${Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ')}/>`,
  ).join('');

/**
 * 符号单独一份（24 viewBox）。`assets/mark.svg` 带尺寸与 title；favicon 那条不带——它要压成一行塞进
 * data URI，而 `<link rel="icon">` 自己就是可访问名的载体。两处只差这两样，共用一个函数。
 */
export function markSvg({ standalone = true } = {}) {
  const head = standalone ? 'width="96" height="96" ' : '';
  return `<svg ${XMLNS} viewBox="0 0 24 24" ${head}color="${COLORS.light}">${standalone ? '<title>difftab</title>' : ''}${darkStyle}${markShapes()}</svg>`;
}
export const faviconSvg = () => markSvg({ standalone: false });

/** SVG → data URI。只转会撞上 HTML 属性或 URL 语法的那几个字符，其余留明文便于 diff。 */
export const svgDataUri = (svg) =>
  `data:image/svg+xml,${svg.replace(/"/g, "'").replace(/[<>#%{}]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

/**
 * 社交预览 1280×640：深底、符号 + 产品名并排居中、一句 tagline。文字走系统 sans，只在 PNG 里
 * 定型——「SVG `<text>` 在 GitHub 的 `<img>` 沙箱里拿不到字体」那条限制不作用于截图。
 */
export function socialSvg() {
  const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', 'Noto Sans', sans-serif";
  // 符号 24 网格 ×8 = 192px，与 132px 的粗体产品名之间留 40px，整组水平居中
  const scale = 8,
    markW = 24 * scale,
    gap = 40,
    nameW = 410,
    x0 = (1280 - (markW + gap + nameW)) / 2,
    y0 = 180;
  return (
    `<svg ${XMLNS} viewBox="0 0 1280 640" width="1280" height="640">` +
    '<title>difftab — See what your AI coding agent changed, in one tab</title>' +
    `<rect width="1280" height="640" fill="${COLORS.darkBg}"/>` +
    `<g transform="translate(${x0} ${y0}) scale(${scale})" color="${COLORS.dark}">${markShapes()}</g>` +
    `<text x="${x0 + markW + gap}" y="${y0 + 142}" fill="${COLORS.dark}" font-family="${FONT}" font-weight="700" font-size="132" letter-spacing="-4">difftab</text>` +
    `<text x="640" y="470" text-anchor="middle" fill="${COLORS.darkMuted}" font-family="${FONT}" font-size="30">See what your AI coding agent changed — in one tab.</text>` +
    '</svg>\n'
  );
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** 用 headless Chrome 把一个 file:// 页面截成 PNG。窗口尺寸即输出尺寸，底色透明。 */
function screenshot(chrome, url, out, w, h) {
  const r = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--window-size=${w},${h}`,
      `--screenshot=${out}`,
      url,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0 || !existsSync(out))
    throw new Error(`Chrome 截图失败（exit ${r.status}）：${r.stderr}`);
}

/** favicon 的 PNG 兜底：32×32、透明底——红绿照常，上下文那条给中灰，两档底色上都看得见。 */
function faviconPngUri(chrome) {
  const tmp = mkdtempSync(join(tmpdir(), 'difftab-favicon-'));
  try {
    const page = join(tmp, 'favicon.html');
    const svg32 = `<svg ${XMLNS} viewBox="0 0 24 24" width="32" height="32" color="#808080">${markShapes()}</svg>`;
    writeFileSync(
      page,
      `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent">${svg32}`,
    );
    const png = join(tmp, 'favicon.png');
    screenshot(chrome, pathToFileURL(page).href, png, 32, 32);
    return `data:image/png;base64,${readFileSync(png).toString('base64')}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const assets = join(repoRoot, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'mark.svg'), `${markSvg()}\n`);
  writeFileSync(join(assets, 'social-preview.svg'), socialSvg());
  console.log('logo: 已写 assets/mark.svg、social-preview.svg');

  const chrome = findChrome();
  if (!chrome) {
    console.log(
      'logo: 没找到 Chrome，跳过 social-preview.png 与 favicon PNG（CHROME=<path> 可指定）',
    );
    return;
  }
  screenshot(
    chrome,
    pathToFileURL(join(assets, 'social-preview.svg')).href,
    join(assets, 'social-preview.png'),
    1280,
    640,
  );
  console.log('logo: 已渲 assets/social-preview.png');

  const indexPath = join(repoRoot, 'src', 'web', 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  const start = '<!-- favicon: generated by scripts/logo.mjs -->',
    end = '<!-- /favicon -->';
  const a = html.indexOf(start),
    b = html.indexOf(end);
  if (a === -1 || b === -1) throw new Error('index.html 里找不到 favicon 标记');
  // SVG 那条排在后面：Chrome / Firefox 取靠后的那条合适的，Safari 不认 SVG favicon、退到 PNG
  const block =
    `${start}\n` +
    `    <link rel="icon" href="${faviconPngUri(chrome)}" sizes="32x32" />\n` +
    `    <link rel="icon" href="${svgDataUri(faviconSvg())}" type="image/svg+xml" />\n` +
    `    ${end}`;
  writeFileSync(indexPath, html.slice(0, a) + block + html.slice(b + end.length));
  console.log('logo: 已回写 src/web/index.html 的 favicon');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
