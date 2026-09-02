// 拉起浏览器。
//
// 这是产品代码中**唯一一处非 git 的子进程调用**，也是只读性主门禁需要显式开的那一个口子
//——fake git wrapper 劫持不到它，因此测试里单独断言：被调命令来自下面这张固定映射、参数
// 只有 URL 一项。零运行时依赖的前提下没有现成库可用，只能按平台调系统命令。

import { spawn } from 'node:child_process';

export interface BrowserCommand {
  command: string;
  args: string[];
}

/**
 * 平台 → 命令的固定映射。**纯函数，便于测试逐条钉住**。Windows 那串里的空串不是笔误：
 * 它是 `start` 的窗口标题占位，少了它，带引号的 URL 会被当作标题吞掉，浏览器根本不开。
 */
export function browserCommand(platform: NodeJS.Platform, url: string): BrowserCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * CI 与冷启动测量里必须能关掉这个调用，否则每跑一次测试就弹一次浏览器。这不是「为开发
 * 便利而放宽的分支」——它不改变任何校验，只决定要不要多起一个进程。
 */
export function browserDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DIFFTAB_NO_OPEN);
}

/**
 * 返回是否真的尝试了拉起。失败（没有 `xdg-open`、headless 环境）只打印 URL 让用户自行
 * 访问，**不作为启动失败**；URL 在调用本函数之前已经打印过了。
 */
export function openBrowser(url: string): boolean {
  if (browserDisabled()) return false;
  const { command, args } = browserCommand(process.platform, url);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    // 子进程的失败是异步到达的（ENOENT 走 'error' 事件），没有这个监听会变成
    // 未捕获异常把整个服务带走——而它本该是「无所谓」的一类失败
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
