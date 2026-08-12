// 三档各自**注册了什么**、以及轮询与降级(src/server/watch/watcher.ts,spec §5.7)。
//
// 单独一个文件,理由同 watch-error.test.ts:它把 `node:fs` 的 `watch` 换成替身。
// 这份 mock 一旦生效,watch.test.ts 里那些真跑文件系统的用例会整片被架空成永远绿的,
// 所以两者不合并。
//
// **分工**:真实文件系统那边证「原生 watcher 交给匹配器的路径是什么形状」——
// 那是 mock 说不上话的;这边证「C 档一个递归 watch 都不建」「A 档传的是函数不是
// 字符串」「B 档的过滤在合并窗口之前」—— 那是真实文件系统上看不出来的
// (跑在 macOS 上的用例证明不了 Linux 侧的注册行为,而 ENOSPC 正是在 Linux 上出)。

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createWatcher, type WatchHandle } from '../../../src/server/watch/watcher.ts';

interface WatchCall {
  path: string;
  options: { recursive?: boolean; ignore?: unknown } | undefined;
  listener: ((event: string, filename: string | null) => void) | undefined;
  watcher: FakeWatcher;
}

class FakeWatcher extends EventEmitter {
  closed = false;
  close() {
    this.closed = true;
  }
}

const calls: WatchCall[] = [];

/**
 * 让 `watch()` 对某些路径**同步抛**。
 *
 * 建流那一刻就失败(ENOSPC / 网络盘)与建好之后才出错是两条不同的路径,而它们的
 * 区别只有在 `createWatcher` **执行期间**才看得出来 —— 事后往替身上 emit 一个
 * 'error' 是复现不了的。
 */
let failWatch: (path: string) => boolean = () => false;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // statSync 保持真的:`.git` 侧盯哪些目录仍由真实的目录结构决定
    watch: (path: string, options: WatchCall['options'], listener: WatchCall['listener']) => {
      if (failWatch(path)) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      const watcher = new FakeWatcher();
      calls.push({ path, options, listener, watcher });
      return watcher;
    },
  };
});

const dirs: string[] = [];
const handles: WatchHandle[] = [];

afterEach(() => {
  for (const handle of handles) handle.close();
  handles.length = 0;
  calls.length = 0;
  failWatch = () => false;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  dirs.length = 0;
});

/** 一个像仓库的目录(只需要目录结构:`watch` 已经是替身了)。 */
function fakeRepo(): { root: string; gitDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'gitglance-tiers-'));
  dirs.push(root);
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  return { root, gitDir: join(root, '.git') };
}

interface StartOptions {
  tier: 'A' | 'B' | 'C';
  onChange?: () => void;
  pollStatus?: () => Promise<string>;
  onDegrade?: (cause: Error) => void;
  pollMs?: number;
  debounceMs?: number;
}

function start(options: StartOptions): WatchHandle {
  const { root, gitDir } = fakeRepo();
  const handle = createWatcher({
    gitDir,
    repoRoot: root,
    tier: options.tier,
    onChange: options.onChange ?? (() => {}),
    pollStatus: options.pollStatus ?? (async () => 'unchanged'),
    onDegrade: options.onDegrade ?? (() => {}),
    pollMs: options.pollMs ?? 60_000,
    debounceMs: options.debounceMs ?? 20,
  });
  handles.push(handle);
  return handle;
}

/** 工作区侧那条(递归的那一条)。三档里只有 A / B 有。 */
const recursiveCalls = () => calls.filter((call) => call.options?.recursive === true);

describe('工作区侧:每档注册了什么(§5.7 三档表)', () => {
  test('A 档:一条递归 watch,`ignore` 传的是**函数**', () => {
    start({ tier: 'A' });

    const recursive = recursiveCalls();
    expect(recursive).toHaveLength(1);
    const { options } = recursive[0] as WatchCall;
    // 字符串模式在 macOS / Windows 上形同虚设(basename 比对匹配不上事件的相对
    // 路径,§10),而那是静默的:watch 照建、事件照来、过滤全不生效
    expect(typeof options?.ignore).toBe('function');

    // 传的确实是那份逐段匹配器 —— 光断言「是个函数」的话,传一个 `() => false`
    // 也通过,而那正是「过滤没生效」本身
    const ignore = options?.ignore as (p: string) => boolean;
    expect(ignore('node_modules/pkg/lib/index.js')).toBe(true);
    expect(ignore('src/a.ts')).toBe(false);
  });

  test('B 档:递归 watch 不带 `ignore` —— 那个版本的 Node 会把它静默忽略', () => {
    start({ tier: 'B' });

    const recursive = recursiveCalls();
    expect(recursive).toHaveLength(1);
    // 传了也不报错、也不生效(Node < 24.14 不认这个选项),留着只会让人以为过滤在那里
    expect(recursive[0]?.options && 'ignore' in recursive[0].options).toBe(false);
  });

  test('C 档:一个递归 watch 都不建 —— 它就是本工具唯一的外部副作用', async () => {
    // Node 在 Linux 上的递归实现是用户态遍历,对每个**普通文件**也注册一个 inotify
    // watch,足以耗尽 max_user_watches,之后整机所有依赖 inotify 的工具(包括用户
    // 自己的编辑器)开始报 ENOSPC
    const changes: number[] = [];
    // 每拍都换一份快照 —— 这一条只问「轮询这条通路通不通」,「变了才触发」由下面
    // 那组单独钉
    let tick = 0;
    const handle = start({
      tier: 'C',
      onChange: () => changes.push(Date.now()),
      pollStatus: async () => {
        tick += 1;
        return `snapshot-${tick}`;
      },
      pollMs: 20,
      debounceMs: 10,
    });

    expect(recursiveCalls()).toHaveLength(0);
    // `.git` 侧照建,而且都是非递归的 —— C 档的提交与切分支仍然是即时的
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.options?.recursive).not.toBe(true);

    // 工作区通路是轮询,而且从一开始就是(不是降级)
    expect(handle.mode).toBe('polling');
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0), { timeout: 3000 });
  });
});

describe('B 档的过滤在合并窗口之前(§5.7 红线)', () => {
  /** 拿到工作区那条 watch 的回调 —— 原生 watcher 就是这样调它的。 */
  const workspaceListener = () =>
    (recursiveCalls()[0] as WatchCall).listener as (event: string, filename: string | null) => void;

  test('node_modules 的嵌套写入一片被吞掉,窗口不被顶开', async () => {
    const changes: number[] = [];
    start({ tier: 'B', onChange: () => changes.push(Date.now()), debounceMs: 30 });
    const listener = workspaceListener();

    // 过滤若放在窗口之后,这 30 条噪声照样把窗口顶开、触发一次无谓刷新 ——
    // 而 agent 跑一次装依赖就是几万条
    for (let i = 0; i < 30; i += 1) listener('change', `node_modules/pkg/lib/chunk-${i}.js`);
    await new Promise((r) => setTimeout(r, 200));
    expect(changes).toHaveLength(0);

    // 仓库里的文件照常触发 —— 否则上面那条只是「回调根本没被调过」
    listener('change', 'src/a.ts');
    await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 3000 });
  });

  test('filename 为 null 时放行 —— 漏刷一次比多刷一次糟得多', async () => {
    // Node 文档载明 filename 可能为 null,即便在支持的平台上也不保证提供(§5.7)
    const changes: number[] = [];
    start({ tier: 'B', onChange: () => changes.push(Date.now()), debounceMs: 20 });

    workspaceListener()('rename', null);
    await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 3000 });
  });
});

describe('轮询(§5.7 的 1.5s 兜底)', () => {
  test('快照变了才触发,首拍只建立基线', async () => {
    const changes: number[] = [];
    let snapshot = 'A';
    start({
      tier: 'C',
      onChange: () => changes.push(Date.now()),
      pollStatus: async () => snapshot,
      pollMs: 20,
      debounceMs: 10,
    });

    // 首拍就推一次的话,每次降级 / 每次 C 档启动都会白刷一遍页面
    await new Promise((r) => setTimeout(r, 200));
    expect(changes).toHaveLength(0);

    snapshot = 'B';
    await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 3000 });

    // 变过之后不再重复触发:判据是「与上一份不同」,不是「与第一份不同」
    await new Promise((r) => setTimeout(r, 200));
    expect(changes).toHaveLength(1);
  });

  test('探针失败不终止轮询 —— git 一时不可用是暂态', async () => {
    const changes: number[] = [];
    let snapshot = 'A';
    let failing = false;
    start({
      tier: 'C',
      onChange: () => changes.push(Date.now()),
      pollStatus: async () => {
        if (failing) throw new Error('index.lock');
        return snapshot;
      },
      pollMs: 20,
      debounceMs: 10,
    });

    await new Promise((r) => setTimeout(r, 100));
    failing = true;
    await new Promise((r) => setTimeout(r, 100));
    failing = false;
    // 停下来的话就再也起不来了,而症状只是「页面从某一刻起不再刷新」
    snapshot = 'B';
    await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 3000 });
  });

  test('close() 之后不再轮询', async () => {
    const changes: number[] = [];
    let snapshot = 'A';
    const handle = start({
      tier: 'C',
      onChange: () => changes.push(Date.now()),
      pollStatus: async () => snapshot,
      pollMs: 20,
      debounceMs: 10,
    });

    await new Promise((r) => setTimeout(r, 100));
    handle.close();
    snapshot = 'B';
    await new Promise((r) => setTimeout(r, 200));
    expect(changes).toHaveLength(0);
  });
});

describe('降级为轮询(§5.7 的兜底)', () => {
  test('工作区 watch 出错 → mode 翻成 polling,轮询接上,只上报一次', async () => {
    const degrades: Error[] = [];
    const changes: number[] = [];
    let snapshot = 'A';
    const handle = start({
      tier: 'A',
      onChange: () => changes.push(Date.now()),
      onDegrade: (cause) => degrades.push(cause),
      pollStatus: async () => snapshot,
      pollMs: 20,
      debounceMs: 10,
    });

    expect(handle.mode).toBe('native');
    (recursiveCalls()[0] as WatchCall).watcher.emit('error', new Error('ENOSPC'));

    // mode 是前端唯一的判据(§5.12):不翻的话页面会一直标着「原生监听」,
    // 而它自己无从推断降级这件事
    expect(handle.mode).toBe('polling');
    expect(degrades.map((e) => e.message)).toEqual(['ENOSPC']);

    // 一次 ENOSPC 往往连着把几个 watcher 全打下来 —— 每个都上报等于前端收到一串
    // 重复的降级通知,而降级本身不可逆
    (calls[0] as WatchCall).watcher.emit('error', new Error('ENOSPC again'));
    expect(degrades).toHaveLength(1);

    // 真的接上了:轮询发现的变化照样推得出去
    snapshot = 'B';
    await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 3000 });
  });

  test('出错的工作区 watcher 被显式关掉,不是只把引用丢掉', () => {
    /**
     * 原生 watcher(macOS / Windows)确实在 emit 之前就关了自己,但 Linux 的**用户态
     * 递归实现**不是:`internal/fs/recursive_watch.js` 的 `#watchFolder` catch 里
     * 只有一句 `emit('error', …)`,已注册的那一大批 inotify watch 得靠显式 `close()`
     * 才放得掉(已核对 Node 24.14.1 源码)。丢掉引用 = 它们活到进程结束,
     * 而这条路径最典型的触发原因**正是配额耗尽** —— 那时还占着配额不放,
     * 伤的是用户整机的其他工具,且没有任何报错
     */
    const handle = start({ tier: 'A', onDegrade: () => {} });
    const workspace = (recursiveCalls()[0] as WatchCall).watcher;

    workspace.emit('error', new Error('ENOSPC'));
    expect(workspace.closed).toBe(true);

    // close() 也不该再去碰它一次以外的东西 —— 关服务时照常收尾
    handle.close();
  });

  test('C 档下 `.git` watch 建不起来也不上报降级 —— 它本来就在轮询', () => {
    /**
     * 上报会 stderr 打一行、再往刚连上的客户端推一个 `change`,而 `mode` 从头到尾
     * 就是 `polling`,没有任何东西真的变过。
     *
     * **必须让它在建流那一刻就失败**:事后 emit 一个 'error' 时轮询早就起来了,
     * `degrade()` 的短路会替我们把这条挡掉 —— 那样这条用例对「C 档的 startPolling
     * 排在 `.git` 循环之前还是之后」一个字都说不上(第一版正是这么写的,把顺序
     * 改回去照样绿)。
     */
    failWatch = (path) => path.endsWith('.git');
    const degrades: Error[] = [];
    const handle = start({ tier: 'C', onDegrade: (cause) => degrades.push(cause) });

    expect(degrades).toEqual([]);
    expect(handle.mode).toBe('polling');
  });

  test('同一个失败在 B 档照样上报 —— 上一条不是「反正什么都不报」', () => {
    // 没有这条,把 onDegrade 整个删掉也能让上一条通过
    failWatch = (path) => path.endsWith('.git');
    const degrades: Error[] = [];
    const handle = start({ tier: 'B', onDegrade: (cause) => degrades.push(cause) });

    expect(degrades.map((e) => e.message)).toEqual(['ENOSPC']);
    expect(handle.mode).toBe('polling');
  });
});
