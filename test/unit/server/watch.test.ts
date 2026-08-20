// 监听层(src/server/watch/)的单测:档位判定 + `.git` 侧的 watch(spec §5.7)。
//
// 档位那一半是纯函数,逐档钉住;watcher 那一半是**行为**断言 —— 真的建 watch、
// 真的写文件。理由是本阶段要守的两条红线(不递归、不对单个文件建 watch)都只在
// 运行时才看得出来:写成 mock 的话,断言的是我们自己传了什么参数,而不是
// 「`.git/objects` 里的写入到底会不会把我们吵醒」。

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  detectTier,
  forcedTierWarning,
  initialMode,
  resolveTier,
  supportsIgnoreOption,
  TIER_ENV,
  type WatchTier,
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

  test('在没有 `ignore` 的 Node 上强制 A 档:提醒一句,但照样启动', () => {
    // 拒绝启动会推翻 §6 已勾的「三档均可通过内部环境变量强制指定」;沉默则更糟 ——
    // Node 对未知选项是静默忽略,这次「A 档」跑的是一个**没有任何过滤的递归 watch**,
    // 而结论会写成「我验过 A 档了」
    expect(forcedTierWarning({ [TIER_ENV]: 'A' }, '22.0.0')).toMatch(/ignore/);
    expect(forcedTierWarning({ [TIER_ENV]: ' a ' }, '24.13.0')).not.toBeNull();
    // 够新的 Node、别的档、以及没强制指定时都不该有噪声
    expect(forcedTierWarning({ [TIER_ENV]: 'A' }, '24.14.0')).toBeNull();
    expect(forcedTierWarning({ [TIER_ENV]: 'B' }, '22.0.0')).toBeNull();
    expect(forcedTierWarning({}, '22.0.0')).toBeNull();
  });

  test('取值不合法时抛错,而不是悄悄退回自动判定', () => {
    // 退回自动判定的话,`DIFFTAB_WATCH_TIER=D` 在 macOS 上照样给出 B 档,于是
    // 「我验过 B 档了」建立在一次根本没生效的强制指定上
    for (const bad of ['D', 'auto', 'native', 'AB']) {
      expect(() => resolveTier({ [TIER_ENV]: bad }, '22.0.0', 'darwin')).toThrow(WatchTierError);
    }
    expect(() => resolveTier({ [TIER_ENV]: 'D' })).toThrow(/must be one of A, B, C/);
  });
});

describe('watch:`.git` 侧与工作区侧(§5.7,跑真实文件系统)', () => {
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
    const root = mkdtempSync(join(tmpdir(), 'difftab-watch-'));
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

  /**
   * 起一个 watcher 并登记好收尾。**默认 `tier: 'C'`,也就是只起 `.git` 侧** ——
   * C 档一个递归 watch 都不建(§5.7),于是那一组断言的每一次回调都只能来自
   * `.git` 侧那几个非递归 watch。换成 A / B 的话「objects 里的写入不触发」那条会红,
   * 而红的原因是工作区那条递归 watch 也看得见它,与被测的东西无关。
   *
   * 两个轮询周期(降级的与原生档的安全轮询)一律给恒定快照 + 一分钟 = 关掉它们:
   * 本文件测的是 `fs.watch` 那条路,轮询由 watch-tiers.test.ts 用假探针单独钉。
   */
  const watchFor = (
    gitDir: string,
    calls: number[],
    {
      debounceMs = 200,
      tier = 'C',
      repoRoot = dirname(gitDir),
    }: { debounceMs?: number; tier?: WatchTier; repoRoot?: string } = {},
  ): WatchHandle => {
    const handle = createWatcher({
      gitDir,
      repoRoot,
      tier,
      pollStatus: async () => 'unchanged',
      pollMs: 60_000,
      safetyPollMs: 60_000,
      debounceMs,
      onChange: () => calls.push(Date.now()),
      onDegrade: () => {},
    });
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
  async function armed(probe: string, calls: number[], debounceMs = 200): Promise<void> {
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
    const root = mkdtempSync(join(tmpdir(), 'difftab-watch-'));
    dirs.push(root);
    // 连 refs/ 都没有的目录:gitWatchDirs 只返回它自己,createWatcher 照样起得来
    expect(gitWatchDirs(root)).toEqual([root]);
    expect(gitWatchDirs(join(root, 'does-not-exist'))).toEqual([]);
  });

  test('改 HEAD 会触发一次刷新', async () => {
    const gitDir = fakeGitDir();
    const calls: number[] = [];
    watchFor(gitDir, calls);
    await armed(join(gitDir, 'difftab-arm-probe'), calls);

    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/feature\n');
    await vi.waitFor(() => expect(calls.length).toBe(1), { timeout: 3000, interval: 20 });
  }, 15_000);

  test('一串写入被合并成一次刷新 —— 一条 git commit 就是五六个事件', async () => {
    const gitDir = fakeGitDir();
    const calls: number[] = [];
    watchFor(gitDir, calls);
    await armed(join(gitDir, 'difftab-arm-probe'), calls);

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
    watchFor(gitDir, calls, { debounceMs: 50 });
    await armed(join(gitDir, 'difftab-arm-probe'), calls, 50);

    writeFileSync(join(gitDir, 'objects', 'ab', 'cdef0123'), 'object payload');
    mkdirSync(join(gitDir, 'objects', 'cd'), { recursive: true });
    writeFileSync(join(gitDir, 'objects', 'cd', 'ef456789'), 'another');
    await new Promise((r) => setTimeout(r, 600));
    expect(calls).toHaveLength(0);

    // 同一个 watcher 对 `.git` 本身仍然是灵的 —— 否则上面那条断言只是「什么都没在听」
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/other\n');
    await vi.waitFor(() => expect(calls.length).toBe(1), { timeout: 3000, interval: 20 });
  }, 15_000);

  /**
   * 工作区侧,**跑真实文件系统**(§5.7 三档表 + §6「B 档:`node_modules` 的嵌套
   * 子目录里批量写文件不触发刷新」)。
   *
   * 这一组不能写成 mock:要证伪的恰恰是「原生 watcher 到底把什么形状的路径交给
   * 匹配器」—— macOS / Windows 给的是**事件的相对路径**(`node_modules/.bin/foo`),
   * 按 basename 比对匹配不上,过滤完全失效(§10)。断言我们传了什么参数的用例
   * 对这条一个字都说不上。
   */
  describe('工作区侧的三档(§5.7)', () => {
    /** 在 `fakeGitDir` 那个骨架旁边补出工作区:`src/` + 一层嵌套的 `node_modules/`。 */
    function watchRepo(tier: 'A' | 'B', calls: number[]): string {
      const root = dirname(fakeGitDir());
      for (const rel of ['src', 'node_modules/pkg/lib']) {
        mkdirSync(join(root, ...rel.split('/')), { recursive: true });
      }
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(root, 'node_modules', 'pkg', 'lib', 'index.js'), 'module.exports = 1;\n');
      watchFor(join(root, '.git'), calls, { debounceMs: 100, tier, repoRoot: root });
      return root;
    }

    for (const tier of ['A', 'B'] as const) {
      /**
       * A 档的过滤靠 `fs.watch` 的 `ignore`,而它自 Node 24.14.0 才有 —— 在更低的
       * 版本上强制指定 A 档,Node 会把这个未知选项**静默忽略**,于是这条用例会以
       * 「过滤没生效」变红,而那正是 §5.7 判档要防的运行时行为,不是产品缺陷。
       * 跳过而不是假装通过:跑在 24.14+ 上的 CI build 作业照样把它盖住。
       */
      const runs = tier === 'B' || supportsIgnoreOption(process.versions.node);
      test.skipIf(!runs)(
        `${tier} 档:node_modules 的嵌套子目录里批量写文件不触发刷新`,
        async () => {
          // 只写顶层目录本身证伪不了 basename 写法的缺陷(§6 明写了这一点):
          // 那种写法在 Linux 上碰巧成立,只有嵌套路径才把它分开
          const calls: number[] = [];
          const repoRoot = watchRepo(tier, calls);
          // 探针写在 `src/` 里:它不在忽略清单内,所以「响了」证明的正是工作区
          // 那条递归 watch 已经在收事件
          await armed(join(repoRoot, 'src', 'arm-probe.txt'), calls, 100);

          const deep = join(repoRoot, 'node_modules', 'pkg', 'lib');
          for (let i = 0; i < 20; i += 1) {
            writeFileSync(join(deep, `chunk-${i}.js`), `module.exports = ${i};\n`);
          }
          mkdirSync(join(deep, 'nested'), { recursive: true });
          writeFileSync(join(deep, 'nested', 'deeper.js'), 'module.exports = 2;\n');
          await new Promise((r) => setTimeout(r, 600));
          expect(calls).toHaveLength(0);

          // 同一个 watcher 对仓库里的普通文件仍然是灵的 —— 否则上面那条断言只是
          // 「什么都没在听」
          writeFileSync(join(repoRoot, 'src', 'a.ts'), 'export const a = 2;\n');
          await vi.waitFor(() => expect(calls.length).toBe(1), { timeout: 5000, interval: 20 });
        },
        20_000,
      );
    }
  });

  test('close() 之后不再有回调', async () => {
    const gitDir = fakeGitDir();
    const calls: number[] = [];
    const handle = watchFor(gitDir, calls, { debounceMs: 50 });
    // 先确认它本来是灵的,否则下面那条「没有回调」可能只是因为流还没起来
    await armed(join(gitDir, 'difftab-arm-probe'), calls, 50);

    // 写完立刻关:合并窗口里那发定时器也必须被一并取消
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/x\n');
    handle.close();
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toHaveLength(0);
    expect(handle.size).toBe(0);
  }, 15_000);
});
