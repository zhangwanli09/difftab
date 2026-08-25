// `dist/web` 的静态托管:按内存清单白名单式映射,不做路径拼接。
//
// **按内存清单白名单式映射**,不得用 `path.join(root, req.url)` 之类的路径拼接读文件
// —— 那是一条路径穿越。构建产物的文件名因此固定、不加 hash:服务端本就对所有响应
// 发 `Cache-Control: no-store`,内容哈希没有意义(见 vite.config.ts 的 rollupOptions)。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface Asset {
  /** `dist/web/` 下的文件名。清单是白名单,不接受任何来自请求的拼接。 */
  file: string;
  contentType: string;
}

/**
 * 产物目录。
 *
 * 口径是**打包后**的位置:`dist/server/main.js` → `dist/web/`。本文件在 src 下的
 * 相对位置与此无关 —— 它只作为 tsdown 的输入存在,运行时永远是那个单文件 ESM。
 */
const WEB_ROOT = new URL('../web/', import.meta.url);

export const ASSETS: ReadonlyMap<string, Asset> = new Map([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/app.css', { file: 'app.css', contentType: 'text/css; charset=utf-8' }],
]);

/**
 * 读过一次就留在内存里。
 *
 * `dist/web/` 在进程生命周期内不会变(产物由构建产生,服务端不监听它),而所有响应
 * 都带 `Cache-Control: no-store`,浏览器那侧也不缓存 —— 不留的话每次刷新都要把三个
 * 文件重新读一遍磁盘。三份加起来两百多 KB,常驻的代价可以忽略。
 */
const cache = new Map<string, Buffer>();

export async function readAsset(asset: Asset): Promise<Buffer> {
  const cached = cache.get(asset.file);
  if (cached) return cached;
  const buffer = await readFile(fileURLToPath(new URL(asset.file, WEB_ROOT)));
  cache.set(asset.file, buffer);
  return buffer;
}
