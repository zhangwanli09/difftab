// 启动流程:前置检查 → 起 server → 写注册表 → 打印 URL → 拉起浏览器(spec §5.1 / §5.8)。

import { locateRepo } from '../git/repo.ts';
import { startServer } from '../http/server.ts';
import { openBrowser } from './browser.ts';
import { removeRegistry, writeRegistry } from './registry.ts';

export interface StartOptions {
  cwd: string;
  noOpen: boolean;
}

export async function start(options: StartOptions): Promise<void> {
  // 前置检查失败(git 不在 PATH、不是仓库、版本过低、bare)抛 PreflightError,
  // 由 main() 收成一句话友好报错,而不是 Node 异常栈(spec §5.2)
  const repo = await locateRepo(options.cwd);

  const server = await startServer(repo);

  writeRegistry({
    pid: process.pid,
    port: server.port,
    token: server.token,
    repoRoot: repo.root,
    startedAt: Date.now(),
  });

  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => {
      // 注册表清理不在这里做:process.exit() 会同步触发下面那个 'exit' 处理器,
      // 那一条已经覆盖了本路径
      // 复现默认的信号语义:装了监听器就得自己退,否则 Ctrl+C 之后进程还在
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // 唯一的清理点,覆盖全部退出路径 —— 信号、未捕获异常、正常结束。
  // TODO(S3c):有了探活复用之后,陈旧条目不再是死结,但清理照旧要做
  process.on('exit', () => removeRegistry(repo.root));

  // **stdout 的第一行是且只是 URL** —— scripts/bench-startup.mjs 以它作为 ready 的
  // 判据(spec §6「ready 的口径:监听成功并打印 URL」)。首次 `git status` 交由
  // 第一个 HTTP 请求惰性执行、不计入,否则该指标会随被测仓库规模漂移
  process.stdout.write(`${server.url}\n`);
  process.stdout.write('gitglance: read-only view of this repository. Press Ctrl+C to stop.\n');

  if (!options.noOpen) openBrowser(server.url);
}
