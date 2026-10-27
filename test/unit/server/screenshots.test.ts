// README 与官网截图的门禁：手工重拍后忘了压缩，README 与官网照常显示，没有任何东西会响。
//
// 判据是 PNG 头里的色彩类型而不只是体积：pngquant 压过的一定是调色板图（类型 3），重拍后直接
// 入库的是真彩（类型 2 / 6），体积上限只兜「调色板图但尺寸拍大了」那一种。放在 server 那一档是
// 因为它要读文件系统。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const COMPRESS =
  'pngquant --quality=80-95 --speed 1 --strip --force --ext .png assets/screenshot-*.png';
const MAX_BYTES = 150 * 1024;

/** PNG 签名 8 字节之后紧跟 IHDR：长度 4 + 类型 4，宽高各 4 字节大端，再隔一字节位深就是色彩类型。 */
function header(buf: Buffer) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

function load(theme: string) {
  const path = `assets/screenshot-${theme}.png`;
  const buf = readFileSync(new URL(`../../../${path}`, import.meta.url));
  return { path, size: buf.length, ...header(buf) };
}

const light = load('light');
const dark = load('dark');

describe.each([light, dark])('$path', (shot) => {
  it('是 pngquant 压过的调色板图', () => {
    expect(shot.colorType, `未压缩，先跑：${COMPRESS}`).toBe(3);
  });

  it(`不超过 ${MAX_BYTES / 1024} KB`, () => {
    expect(shot.size, '调色板图仍超限：多半是视口或 DPR 拍大了').toBeLessThanOrEqual(MAX_BYTES);
  });
});

it('明暗两张尺寸一致——只换一张时两种主题的读者看到两个版本的界面', () => {
  expect([dark.width, dark.height]).toEqual([light.width, light.height]);
});

it('官网 <img> 的 width / height 与截图实际尺寸一致', () => {
  // 这两个属性是手写的，只决定加载前占位的宽高比：重拍换了视口而没跟着改，图照常显示，
  // 只是加载那一下版面跳动、占位比例不对——同样不会有任何东西响。
  const html = readFileSync(new URL('../../../site/index.html', import.meta.url), 'utf8');
  const img = html.match(/<img\s[^>]*?src="\.\.\/assets\/screenshot-light\.png"[^>]*>/s)?.[0] ?? '';
  const attr = (name: string) => Number(img.match(new RegExp(`\\s${name}="(\\d+)"`))?.[1]);
  expect([attr('width'), attr('height')]).toEqual([light.width, light.height]);
});
