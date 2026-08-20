// 后端入口(spec §5.1)。由 bin/difftab.js 在版本守卫通过后动态 import。
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
  //
  // **裹 try/catch**:读端可能先走(`difftab 2>&1 | head -0`),那时 `writeSync`
  // **同步抛** EPIPE —— 下面那两个 `ignoreBrokenPipe` 监听的是流上的 `'error'` 事件,
  // 接不住这一种。抛出去的结果是「一句话友好报错」变成一屏 Node 栈,恰好推翻本函数
  // 存在的理由。cli/start.ts 里那次 `writeSync(1, …)` 同理,两处写法必须一致。
  try {
    writeSync(2, `difftab: ${message}\n`);
  } catch {
    // 没人在听就算了 —— 退出码仍然是对的
  }
  process.exit(1);
}

/**
 * 读端先走了不算错误(`difftab --no-open | head -1`:用户只想要那行 URL)。
 *
 * 之后每一次写都以 EPIPE 失败,而**在 Windows 上管道写是异步的**(POSIX 上同步),
 * 失败因此以一个 `'error'` 事件到达 —— 零监听器的流收到 `'error'` 就是整个进程带着
 * 裸栈以 1 退出。已在 CI 的 windows × Node 24 档实测到:`head` 一退,紧接着那句
 * 「read-only view of this repository」就把服务打死了,而 macOS / Linux 上同一条路
 * 一声不响(见 spec §10)。
 *
 * 服务本身没坏 —— 浏览器照常用得上,45 秒没人连再自己退,所以这里只是把 EPIPE
 * 咽掉。**非 EPIPE 的错误照旧抛**:那是真出事了,不该借这条路一起被吞掉。
 */
function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'EPIPE') throw cause;
  });
}

export async function main(argv: string[]): Promise<void> {
  ignoreBrokenPipe(process.stdout);
  ignoreBrokenPipe(process.stderr);

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
    process.stdout.write(`difftab ${readVersion()}\n`);
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
