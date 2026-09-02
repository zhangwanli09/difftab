// 启动流程：前置检查 → 探活复用 → 起 server → 写注册表 → 打印 URL → 拉起浏览器。

import { writeSync } from 'node:fs';
import { locateRepo } from '../git/repo.ts';
import { startServer } from '../http/server.ts';
import { openBrowser } from './browser.ts';
import { findLiveInstance } from './probe.ts';
import { removeRegistry, writeRegistry } from './registry.ts';

export interface StartOptions {
  cwd: string;
  noOpen: boolean;
}

export async function start(options: StartOptions): Promise<void> {
  /**
   * 「可以看了」的唯一出口：**stdout 的第一行是且只是 URL**，随后一行说明，最后拉起浏览器。
   * 复用与新起两条路各写一遍的话，只有新起那条天天在跑——改了第一行的形状（加前缀、换写
   * 法）会在复用那条上静默漂走，而 `scripts/bench-startup.mjs` 与冒烟套件的 ready 判据都
   * 压在这一行上。
   */
  function announce(url: string, note: string): void {
    process.stdout.write(`${url}\n`);
    process.stdout.write(`${note}\n`);
    if (!options.noOpen) openBrowser(url);
  }

  // 前置检查失败（git 不在 PATH、不是仓库、版本过低、bare）抛 PreflightError，
  // 由 main() 收成一句话友好报错，而不是 Node 异常栈
  const repo = await locateRepo(options.cwd);

  /**
   * **同一个仓库已经有实例在跑，就把用户送去那一个**。判活是 HTTP 探活而不是 pid。命中这
   * 条路之后**什么都不写**：不写注册表（那条目属于对面那个进程）、不装信号与 exit 处理器
   * （装了会在本进程退出时替对面清理掉它的条目）。
   */
  const existing = await findLiveInstance(repo.root);
  if (existing) {
    announce(
      existing.url,
      `difftab: reusing the instance already serving this repository (pid ${existing.pid}).`,
    );
    return;
  }

  const server = await startServer(repo, {
    /**
     * 空闲宽限期走满。**「怎么退」归这一层**：http/ 那边只知道
     * 「没人了」，退出码、提示语、以及退出前要不要先 close 都是启动流程的事。
     */
    onIdle: () => stop(0, 'difftab: no tabs left — exiting.\n'),
  });

  writeRegistry({
    pid: process.pid,
    port: server.port,
    token: server.token,
    repoRoot: repo.root,
    startedAt: Date.now(),
  });

  let closing = false;
  /**
   * 唯一的退出路径。信号与空闲退出共用它——两者完全可能撞在一起（Ctrl+C 恰好落在宽限期
   * 走满的同一拍），各写一份的话 `server.close()` 会跑两次，第二次撞上已经 destroy 的 socket。
   */
  const stop = (code: number, note?: string) => {
    if (closing) return;
    closing = true;
    /**
     * **`writeSync` 而不是 `process.stdout.write`**：后者写到**管道**时在 Windows 上是异步
     * 的，紧跟着的 `process.exit()` 会把还在缓冲区里的内容整条丢掉（与 main.ts 那条报错同
     * 一个规避手法），而这句提示正是自动化验证「它是自己走的、不是被 kill 的」的判据。
     *
     * **而它得能失败**：读端已经走了(`difftab --no-open | head -1`)时 `writeSync` 抛
     * EPIPE，抛在这个回调里时 `closing` 已经合上，于是 `server.close()` 不再执行，进程带着
     * 一屏 Node 栈以 1 退出——而这条路承诺的是干净的 0。
     */
    if (note) {
      try {
        writeSync(1, note);
      } catch {
        // 读端已经关了
      }
    }
    void server.close().finally(() => {
      // 注册表清理不在这里做：process.exit() 会同步触发下面那个 'exit' 处理器，
      // 那一条已经覆盖了本路径
      process.exit(code);
    });
  };

  // 复现默认的信号语义：装了监听器就得自己退，否则 Ctrl+C 之后进程还在
  process.on('SIGINT', () => stop(130));
  process.on('SIGTERM', () => stop(143));
  // 唯一的清理点，覆盖全部退出路径——信号、空闲退出、未捕获异常、正常结束
  process.on('exit', () => removeRegistry(repo.root));

  announce(server.url, 'difftab: read-only view of this repository. Press Ctrl+C to stop.');
}
