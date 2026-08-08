// 拉起浏览器的单点断言(spec §5.10「唯一的非 git 子进程豁免」)。
//
// fake git wrapper 劫持不到这一处调用,所以它必须在这里单独被钉住:
// 命令来自固定映射、参数只有 URL 一项。「产品代码里只有这一处非 git 子进程」
// 那一半在 test/smoke/readonly.test.js 里做静态断言。

import { describe, expect, test } from 'vitest';
import { browserCommand, browserDisabled } from '../../../src/server/cli/browser.ts';

const URL_ = 'http://127.0.0.1:51234/?token=51234.abc';

describe('browserCommand', () => {
  test('三个平台各自的固定命令', () => {
    expect(browserCommand('darwin', URL_)).toEqual({ command: 'open', args: [URL_] });
    expect(browserCommand('linux', URL_)).toEqual({ command: 'xdg-open', args: [URL_] });
    expect(browserCommand('win32', URL_)).toEqual({
      command: 'cmd',
      // 空串是 `start` 的窗口标题占位。少了它,带引号的 URL 会被当作标题吞掉,
      // 浏览器根本不开(spec §5.1)—— 而这是一个只在 Windows 上出现的静默失败
      args: ['/c', 'start', '', URL_],
    });
  });

  test('已知平台之外一律走 xdg-open,不会落到某个「什么都不做」的分支', () => {
    for (const platform of ['freebsd', 'openbsd', 'sunos', 'aix'] as const) {
      expect(browserCommand(platform, URL_).command).toBe('xdg-open');
    }
  });

  test('参数里除 URL 外没有别的东西 —— Windows 的三个是固定前缀,不含任何输入', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const { args } = browserCommand(platform, URL_);
      expect(args.filter((a) => a === URL_)).toHaveLength(1);
      expect(args.every((a) => a === URL_ || ['/c', 'start', ''].includes(a))).toBe(true);
    }
  });
});

test('CI 与冷启动测量里能关掉拉起浏览器', () => {
  expect(browserDisabled({ GITGLANCE_NO_OPEN: '1' })).toBe(true);
  expect(browserDisabled({})).toBe(false);
});
