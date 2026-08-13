// 后端入口(spec §5.1)。由 bin/gitglance.js 在版本守卫通过后动态 import。
//
// 本文件只做「解析参数 → 分派」,启动流程本身在 cli/start.ts ——
// 依赖方向是 bin → server/cli → server/http → {server/git, server/watch}(spec §5.0)。

import { readFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CliUsageError, HELP_TEXT, parseCliArgs } from './cli/args.ts';
import { start } from './cli/start.ts';
import { PreflightError } from './git/repo.ts';
import { IdleConfigError } from './http/idle.ts';
import { WatchTierError } from './watch/tier.ts';

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

/** 一句话友好报错,不是 Node 异常栈(spec §5.2 的启动前置检查)。 */
function fail(message: string): never {
  // **`writeSync` 而不是 `process.stderr.write`**:后者写到**管道**时在 Windows 上
  // 是异步的,紧跟着 `process.exit()` 会把还在缓冲区里的内容整条丢掉 —— 而冒烟测试
  // 正是用管道 spawn 去断言这句提示的。丢了之后的症状是 stderr 全空,跟真正的病因
  // (退出太快)毫无相似之处。
  writeSync(2, `gitglance: ${message}\n`);
  process.exit(1);
}

export async function main(argv: string[]): Promise<void> {
  let options: ReturnType<typeof parseCliArgs>;
  try {
    options = parseCliArgs(argv);
  } catch (cause) {
    if (cause instanceof CliUsageError) fail(`${cause.message}\n\n${HELP_TEXT}`);
    throw cause;
  }

  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (options.version) {
    process.stdout.write(`gitglance ${readVersion()}\n`);
    return;
  }

  try {
    await start({ cwd: process.cwd(), noOpen: options.noOpen });
  } catch (cause) {
    // 三者都是「还没开始干活就发现参数不对」,收成同一句话友好报错。
    // 后两个只可能来自内部环境变量写错,但它们同样不该甩一屏 Node 栈 —— 而且那种
    // 场合下栈顶是 resolveTier / resolveIdleMs,读起来像产品坏了
    if (
      cause instanceof PreflightError ||
      cause instanceof WatchTierError ||
      cause instanceof IdleConfigError
    ) {
      fail(cause.message);
    }
    throw cause;
  }
}
