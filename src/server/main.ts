// 后端入口(spec §5.1)。由 bin/gitglance.js 在版本守卫通过后动态 import。
//
// S0 只到「产物形态成立 + 冷启动测量脚本有东西可量」为止:
// TODO(S1) 仓库定位与前置检查、node:http server(§5.9 三道校验的最终形态)、
//          注册表文件写入(port + token,0o600 + O_EXCL)、git 封装层、拉起浏览器。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 版本号只有 package.json 一个来源。
 *
 * 不把它硬编码在这里,也不在构建期 define 进去:硬编码会在第一次发版改号时
 * 静默漂移(`--version` 报旧号,没有任何东西会失败);构建期注入则让 `dist/` 与
 * 源码对不上、调试时更难看清。运行时读一次的代价只落在 `--version` 这条路径上。
 * dist/server/main.js → 包根的 package.json;`files` 之外 npm 总会带上它。
 */
function readVersion(): string {
  const manifestPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  // 不给 version 兜底:package.json 没有 version 是坏掉了,该让它响亮地失败,
  // 而不是安静地报一个 '0.0.0'
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };
  return manifest.version;
}

export async function main(argv: string[]): Promise<void> {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`gitglance ${readVersion()}\n`);
    return;
  }

  process.stdout.write('gitglance: S0 scaffolding — the server lands in S1.\n');
}
