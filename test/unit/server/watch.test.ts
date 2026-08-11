// 监听层(src/server/watch/)的单测:档位判定 + `.git` 侧的 watch(spec §5.7)。
//
// 档位那一半是纯函数,逐档钉住;watcher 那一半是**行为**断言 —— 真的建 watch、
// 真的写文件。理由是本阶段要守的两条红线(不递归、不对单个文件建 watch)都只在
// 运行时才看得出来:写成 mock 的话,断言的是我们自己传了什么参数,而不是
// 「`.git/objects` 里的写入到底会不会把我们吵醒」。

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  detectTier,
  initialMode,
  resolveTier,
  supportsIgnoreOption,
  TIER_ENV,
  WatchTierError,
} from '../../../src/server/watch/tier.ts';
import {
  createWatcher,
  gitWatchDirs,
  type WatchHandle,
} from '../../../src/server/watch/watcher.ts';

describe('档位判定(§5.7)', () => {
  test('`ignore` 的分界线正好在 24.14.0', () => {
    // 低于它就没有 `ignore`,Linux 上的递归 watch 会逐个注册 inotify watch 直到
    // 耗尽配额 —— 判错一档的代价是用户整机的编辑器开始报 ENOSPC
    expect(supportsIgnoreOption('24.14.0')).toBe(true);
    expect(supportsIgnoreOption('24.13.99')).toBe(false);
    expect(supportsIgnoreOption('24.9.0')).toBe(false);
    // 版本号按数值比,不按字典序:'24.9.0' > '24.14.0' 的字符串比较正是这里最容易
    // 静默错掉的地方
    expect(supportsIgnoreOption('23.99.99')).toBe(false);
    expect(supportsIgnoreOption('25.0.0')).toBe(true);
    expect(supportsIgnoreOption('26.4.1')).toBe(true);
  });

  test('预发布版按 semver 算作低于同版本正式版', () => {
    // 24.14.0-rc.1 正处在选项刚合入、行为还可能变的窗口
    expect(supportsIgnoreOption('24.14.0-rc.1')).toBe(false);
    expect(supportsIgnoreOption('24.15.0-nightly20260101abc')).toBe(true);
  });

  test('版本号解析不出来时倒向「没有 ignore」那一侧', () => {
    // 两种误判的代价差着一个数量级:误判成没有 → Linux 上退化为轮询(功能完整);
    // 误判成有 → 无 ignore 的递归 watch → ENOSPC
    for (const weird of ['', 'v24', 'unknown', '24.x.0']) {
      expect(supportsIgnoreOption(weird)).toBe(false);
    }
  });

  test('三档按「有没有 ignore」× 平台分', () => {
    expect(detectTier('24.14.0', 'linux')).toBe('A');
    expect(detectTier('24.14.0', 'darwin')).toBe('A');
    expect(detectTier('24.14.0', 'win32')).toBe('A');
    // 没有 ignore 时,只有 Linux 才是危险的那个 —— macOS / Windows 走原生
    // FSEvents / ReadDirectoryChangesW,单句柄监听整棵树,本就没有配额问题
    expect(detectTier('22.0.0', 'darwin')).toBe('B');
    expect(detectTier('22.0.0', 'win32')).toBe('B');
    expect(detectTier('22.0.0', 'linux')).toBe('C');
  });

  test('C 档的工作区通路一开始就是轮询,A / B 是原生监听', () => {
    expect(initialMode('C')).toBe('polling');
    expect(initialMode('A')).toBe('native');
    expect(initialMode('B')).toBe('native');
  });
});

describe(`${TIER_ENV}(S3b2 六条验收项的自查前提)`, () => {
  test('三档都能强制指定,盖过运行时判定', () => {
    // 一台机器只有一个 Node 版本、一个平台,而三档正是按这两者分的
    for (const tier of ['A', 'B', 'C'] as const) {
      expect(resolveTier({ [TIER_ENV]: tier }, '22.0.0', 'linux')).toBe(tier);
    }
  });

  test('大小写与空白不计较', () => {
    expect(resolveTier({ [TIER_ENV]: ' b ' }, '26.0.0', 'linux')).toBe('B');
  });

  test('没设或空串时按运行时判定', () => {
    expect(resolveTier({}, '22.0.0', 'linux')).toBe('C');
    expect(resolveTier({ [TIER_ENV]: '  ' }, '26.0.0', 'darwin')).toBe('A');
  });

  test('取值不合法时抛错,而不是悄悄退回自动判定', () => {
    // 退回自动判定的话,`GITGLANCE_WATCH_TIER=D` 在 macOS 上照样给出 B 档,于是
    // 「我验过 B 档了」建立在一次根本没生效的强制指定上
    for (const bad of ['D', 'auto', 'native', 'AB']) {
      expect(() => resolveTier({ [TIER_ENV]: bad }, '22.0.0', 'darwin')).toThrow(WatchTierError);
    }
    expect(() => resolveTier({ [TIER_ENV]: 'D' })).toThrow(/must be one of A, B, C/);
  });
});

describe('`.git` 侧的 watch(§5.7)', () => {
  const dirs: string[] = [];
  const handles: WatchHandle[] = [];

  afterEach(() => {
    for (const handle of handles) handle.close();
    handles.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    dirs.length = 0;
  });

  /** 一个够用的 `.git`:HEAD、index、refs/heads,外加一个装满对象的 objects/。 */
  function fakeGitDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'gitglance-watch-'));
    dirs.push(root);
    const gitDir = join(root, '.git');
    for (const rel of ['refs/heads', 'refs/remotes/origin', 'objects/ab', 'logs']) {
      mkdirSync(join(gitDir, ...rel.split('/')), { recursive: true });
    }
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(gitDir, 'index'), 'binary-ish');
    writeFileSync(join(gitDir, 'refs', 'heads', 'main'), `${'0'.repeat(40)}\n`);
    return gitDir;
  }

  const watchFor = (gitDir: string, calls: number[], debounceMs = 200): WatchHandle => {
    const handle = createWatcher({ gitDir, debounceMs, onChange: () => calls.push(Date.now()) });
    handles.push(handle);
    return handle;
  };

  /**
   * 等到这个 watcher **真的开始收事件**,然后把计数清零。
   *
   * `watch()` 返回不等于流已经起来:macOS 走 FSEvents,而 libuv 在有 watcher 反复
   * 开关时会重启那条流,重启窗口内的写入整个丢掉(实测:本文件单跑时 15 条全绿,
   * 跟着前面几条一起跑时「一串写入」偶发收到 0 个事件 —— 而产品代码一个字没变)。
   * 用探针写到它响为止,是唯一不依赖具体延迟数值的写法;`await` 一个固定毫秒数
   * 只是把不确定性挪到另一台更慢的机器上。
   */
  async function armed(gitDir: string, calls: number[], debounceMs = 200): Promise<void> {
    const probe = join(gitDir, 'gitglance-arm-probe');
    await vi.waitFor(
      () => {
        writeFileSync(probe, String(Date.now()));
        expect(calls.length).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 50 },
    );
    // 最后一发探针可能还压着一个没到期的合并窗口,等它过去再清零
    await new Promise((r) => setTimeout(r, debounceMs * 2));
    calls.length = 0;
  }

  test('盯的全是目录,且绝不包含 objects', () => {
    // 对单个文件建 watch 会在 git 的「写临时文件 + 原子 rename」之后静默失效
    // (新 inode);进 objects 则是一次 gc 就几万个条目的配额灾难
    const gitDir = fakeGitDir();
    const watched = gitWatchDirs(gitDir);

    expect(watched).toContain(gitDir);
    expect(watched).toContain(join(gitDir, 'refs'));
    expect(watched).toContain(join(gitDir, 'refs', 'heads'));
    for (const dir of watched) {
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(dir).not.toContain(join(gitDir, 'objects'));
      expect(dir).not.toContain(join(gitDir, 'logs'));
    }
  });

  test('清单里缺目录不算错误 —— 有几个盯几个', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitglance-watch-'));
    dirs.push(root);
    // 连 refs/ 都没有的目录:gitWatchDirs 只返回它自己,createWatcher 照样起得来
    expect(gitWatchDirs(root)).toEqual([root]);
    expect(gitWatchDirs(join(root, 'does-not-exist'))).toEqual([]);
  });

  test('改 HEAD 会触发一次刷新', async () => {
    const gitDir = fakeGitDir();
    const calls: number[] = [];
    watchFor(gitDir, calls);
    await armed(gitDir, calls);

    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/feature\n');
    await vi.waitFor(() => expect(calls.length).toBe(1), { timeout: 3000, interval: 20 });
  }, 15_000);

  test('一串写入被合并成一次刷新 —— 一条 git commit 就是五六个事件', async () => {
    const gitDir = fakeGitDir();
    const calls: number[] = [];
    watchFor(gitDir, calls);
    await armed(gitDir, calls);

    // index.lock → index → COMMIT_EDITMSG → HEAD 的 reflog → refs/heads/main
    writeFileSync(join(gitDir, 'index.lock'), '');
    writeFileSync(join(gitDir, 'index'), 'updated');
    rmSync(join(gitDir, 'index.lock'));
    writeFileSync(join(gitDir, 'COMMIT_EDITMSG'), 'msg\n');
    writeFileSync(join(gitDir, 'refs', 'heads', 'main'), `${'1'.repeat(40)}\n`);

    await vi.waitFor(() => expect(calls.length).toBe(1), { timeout: 3000, interval: 20 });
    // 窗口过去之后也不该补一发:合并窗口是「第一个事件起一个窗口」,不是每个事件
    // 各起一个
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toHaveLength(1);
  }, 15_000);

  test('objects/ 里的写入不触发刷新 —— 这条钉的就是「不递归」', async () => {
    // 一次 gc 会在这底下写几万个文件,症状不是报错而是刷新风暴 + 配额耗尽,
    // 而 `.git` 本身照样监听得好好的。把 `recursive: true` 加回去,这条立刻红
    // (已弄红验证过);后半段那个 HEAD 写入不能省 —— 否则「收到 0 个事件」也可能
    // 只是因为什么都没在听
    const gitDir = fakeGitDir();
    const calls: number[] = [];
    watchFor(gitDir, calls, 50);
    await armed(gitDir, calls, 50);

    writeFileSync(join(gitDir, 'objects', 'ab', 'cdef0123'), 'object payload');
    mkdirSync(join(gitDir, 'objects', 'cd'), { recursive: true });
    writeFileSync(join(gitDir, 'objects', 'cd', 'ef456789'), 'another');
    await new Promise((r) => setTimeout(r, 600));
    expect(calls).toHaveLength(0);

    // 同一个 watcher 对 `.git` 本身仍然是灵的 —— 否则上面那条断言只是「什么都没在听」
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/other\n');
    await vi.waitFor(() => expect(calls.length).toBe(1), { timeout: 3000, interval: 20 });
  }, 15_000);

  test('close() 之后不再有回调', async () => {
    const gitDir = fakeGitDir();
    const calls: number[] = [];
    const handle = watchFor(gitDir, calls, 50);
    // 先确认它本来是灵的,否则下面那条「没有回调」可能只是因为流还没起来
    await armed(gitDir, calls, 50);

    // 写完立刻关:合并窗口里那发定时器也必须被一并取消
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/x\n');
    handle.close();
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toHaveLength(0);
    expect(handle.size).toBe(0);
  }, 15_000);
});
