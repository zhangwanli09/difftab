// 文件监听:`.git` 侧的目录级非递归 watch + 工作区侧的三档 + 轮询兜底。
//
// `.git` 侧与档位无关,三档都建;工作区侧 A 有 `ignore`、B 在回调里过滤、C 不建递归
// watch。**两侧共用同一个合并窗口**:各起各的等于每次提交刷两遍。

import { type FSWatcher, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { WatchState } from '../shared/protocol.ts';
import { isIgnored } from './ignore.ts';
import { initialMode, type WatchTier } from './tier.ts';

/**
 * 事件合并窗口。**Linux 上是必需项而非优化项**:用户态递归实现初次遍历时对每个条目都
 * emit 一次,启动瞬间就是一波风暴;`.git` 侧一条 `git commit` 也是五六个事件。
 */
export const DEBOUNCE_MS = 150;

/** 降级轮询的周期(1.5s)。C 档的工作区通路也是它。 */
export const POLL_MS = 1500;

/**
 * **原生档(A / B)的低频安全轮询周期**。inotify 配额在**遍历途中**耗尽时 Node 一次都
 * 不 emit,改动从此静默丢失而 `mode` 还说 `native` —— 只有拿 status 输出本身去比才看得
 * 见。30s 而非 1.5s 是为了让原生档空闲 CPU 接近零,代价是最坏 30s 滞后。
 */
export const SAFETY_POLL_MS = 30_000;

export interface WatcherOptions {
  /** `.git` 目录绝对路径。**不得假设是 `<root>/.git`** —— linked worktree 下它是文件。 */
  gitDir: string;
  /** 工作区根目录绝对路径。A / B 档的递归 watch 建在它上面。 */
  repoRoot: string;
  tier: WatchTier;
  /** 合并窗口内至少触发一次。 */
  onChange: () => void;
  /**
   * 轮询探针:返回一份「变没变」的快照,**必须是主查询
   * `git status --porcelain=v2 --branch -uall -z` 的逐字复用**,由调用方注入(git 子进程
   * 只许出现在 server/git)。漏 `-uall` 时未跟踪目录折成一行 `dir/`,在已存在的未跟踪
   * 目录里新增文件不改变输出,轮询判「无变化」。必填:选填时 C 档忘了注入会永不刷新。
   */
  pollStatus: () => Promise<string>;
  /**
   * **落到轮询兜底**时调用一次(A / B 档 watch 失败:ENOSPC / ENOSYS / 网络盘 / Docker
   * 卷)。调用方据此翻 `WatchState.mode` **并推一个 `change`** —— 前端推断不出降级,不推
   * 就要等下一次变更才重取 `/api/state`,那期间页面标着「原生监听」。C 档不走这里:轮询
   * 是它的既定形态,`initialMode` 已给成 `polling`。必填,漏传只让降级没有出口。
   */
  onDegrade: (cause: Error) => void;
  debounceMs?: number;
  pollMs?: number;
  safetyPollMs?: number;
}

export interface WatchHandle {
  close(): void;
  /**
   * **`.git` 侧**实际建起来的 watch 数量(工作区那条看 `mode`,不并进来:合并后两种反向
   * 的失效是同一个 1,而补救完全不同)。0 意味着提交与切分支只能靠轮询发现。
   */
  readonly size: number;
  /** 工作区通路当前的形态(`WatchState.mode`)。 */
  readonly mode: WatchState['mode'];
}

/**
 * `.git` 下需要盯的目录清单。**一律是目录,绝不是单个文件**:watch 绑 inode,而 git 写
 * `HEAD` / `index` 走「写临时文件 + 原子 rename」,对文件建的 watch 从此静默失效。
 *
 * **绝不递归、更绝不进 `objects`**(一次 gc 就是几万个条目)。主力是 `gitDir` 本身 ——
 * 提交、切分支、fetch 都直接写在它下面;`refs/` 那两条只补一层深的更新。
 */
export function gitWatchDirs(gitDir: string): string[] {
  const dirs: string[] = [];
  for (const rel of ['', 'refs', 'refs/heads', 'refs/remotes']) {
    const dir = rel === '' ? gitDir : join(gitDir, ...rel.split('/'));
    try {
      // 不存在(新建仓库未必有 refs/remotes)或不是目录就跳过
      if (statSync(dir).isDirectory()) dirs.push(dir);
    } catch {
      // 缺一个目录不是错误 —— 清单是「盯得到就盯」,不是前置条件
    }
  }
  return dirs;
}

/**
 * `fs.watch` 的 `ignore` 选项(Node ≥ 24.14.0),`@types/node` 钉在运行时下限 22 上还没有
 * 它。声明成本地类型而不是 `as any`:选项名写错时 TS 照样通过,而 Node **静默忽略**未知
 * 选项 —— A 档于是退化成一个没有过滤的递归 watch。
 */
type IgnoringWatchOptions = {
  recursive: true;
  persistent: false;
  ignore: (path: string) => boolean;
};

/**
 * 起监听。不自激全靠封装层那条 `GIT_OPTIONAL_LOCKS=0`:不设它时 `git status` 把 stat
 * 缓存写回 `.git/index`,于是每次刷新写一次 index、每次写 index 又触发一次刷新,而
 * status 的输出从头到尾都是对的。
 */
export function createWatcher(options: WatcherOptions): WatchHandle {
  const {
    gitDir,
    repoRoot,
    tier,
    onChange,
    pollStatus,
    onDegrade,
    debounceMs = DEBOUNCE_MS,
    pollMs = POLL_MS,
    safetyPollMs = SAFETY_POLL_MS,
  } = options;

  const gitWatchers: FSWatcher[] = [];
  let workspaceWatcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let lastSnapshot: string | null = null;
  let polling = false;
  let pollLoopStarted = false;
  let pollInFlight = false;
  let closed = false;

  /**
   * **不是「每来一个事件就把窗口往后推」的那种 debounce** —— 那一种在持续写入(agent 连
   * 着改几十个文件)下会一直不触发。这里窗口内的后续事件被第一个吞掉,风暴期间也保证每
   * `debounceMs` 至少刷新一次。
   */
  const schedule = () => {
    if (closed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
    // 监听绝不该是进程活着的理由 —— 那是 HTTP server 的职责(空闲退出)
    timer.unref();
  };

  /**
   * 轮询一拍。`setTimeout` 链而不是 `setInterval` —— 探针是一次 git 子进程,大仓库上未必
   * 1.5s 内跑得完,会叠着跑。**首拍只建立基线不刷新**;探针失败(index.lock 挡着)也不
   * 终止轮询,那是暂态,停下来就再也起不来了。
   */
  const pollOnce = async () => {
    pollInFlight = true;
    try {
      const snapshot = await pollStatus();
      if (closed) {
        pollInFlight = false;
        return;
      }
      if (lastSnapshot !== null && snapshot !== lastSnapshot) schedule();
      lastSnapshot = snapshot;
    } catch {
      // 保持上一份快照:失败不该被当成「变了」,也不该被当成「没变」
    }
    pollInFlight = false;
    if (closed) return;
    armPoll();
  };

  /**
   * 排下一拍。**同一个循环的两个周期,不是两套机制**:原生档 30s、降级后自动收到 1.5s。
   * 每次都先清掉在等的那一拍 —— 降级正是靠这一下把 30s 的等待按新周期提前。
   */
  const armPoll = () => {
    if (closed) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void pollOnce(), polling ? pollMs : safetyPollMs);
    pollTimer.unref();
  };

  /** 起轮询循环。**只起一次** —— 起两次就是两条链各自排各自的定时器。 */
  const startPolling = () => {
    if (pollLoopStarted) return;
    pollLoopStarted = true;
    void pollOnce();
  };

  /**
   * 转到轮询。**`cause` 为 null 表示这是该档位的既定形态,不是降级**(C 档一开始就走这条
   * 路)。只有一个入口而不是「起轮询」+「降级」两个,是因为 `polling` 这个闩只该在一处
   * 合上,两个入口时想错守卫顺序的症状是多推一次降级通知。
   *
   * **不可逆,而且只上报一次**:一次 ENOSPC 往往连着把几个 watcher 全打下来。也不尝试
   * 恢复原生监听 —— 轮询是功能完整的通路,唯一代价是 1.5s 延迟。
   */
  const usePolling = (cause: Error | null) => {
    if (closed || polling) return;
    polling = true;
    // 安全轮询多半已经在跑:不是再起一条,而是把在等的那一拍按新周期提前(有一拍在飞行
    // 中时它自己会在收尾时重排)
    if (!pollLoopStarted) startPolling();
    else if (!pollInFlight) armPoll();
    if (cause) onDegrade(cause);
  };

  const toError = (cause: unknown): Error =>
    cause instanceof Error ? cause : new Error(String(cause));

  /**
   * C 档的轮询要在 `.git` 侧之前起,否则那边一个 watch 失败会被当成降级上报,而 `mode`
   * 从头到尾就是 `polling`。「哪档以轮询为既定形态」只此一份判据(`initialMode`)——
   * server 那侧也读它来答 `/api/state`,各写各的会在加档位时静默分家。
   */
  if (initialMode(tier) === 'polling') {
    usePolling(null);
  } else {
    /**
     * 原生档的安全轮询**直接起循环而不经 `usePolling`**:那个闩一合上就意味着「已降级」,
     * 而这里没有任何东西坏掉,`mode` 必须还是 `native`。
     */
    startPolling();
  }

  for (const dir of gitWatchDirs(gitDir)) {
    /**
     * **只有 `gitDir` 自己那条算主力**:`refs/` 那两条失败(权限、网络盘)不值得把整个
     * 工具**不可逆地**拖进轮询 —— 那样 UI 永远标着「轮询刷新」,而实际上什么都没坏。
     */
    const primary = dir === gitDir;
    try {
      /**
       * **不传 `recursive`**;`persistent: false` 是说监听不吊住事件循环。**filename 一概
       * 不看**:它可能为 null,而非递归就是真的非递归,`objects/` 的海量写入到不了这里,
       * 没有需要按名字排除的东西。
       */
      const w = watch(dir, { persistent: false }, () => schedule());
      w.on('error', (cause: Error) => {
        /**
         * 出错的 watcher 已经不再送事件,留在数组里只会让 `size` 虚高 —— 而 `size` 正是
         * 「`.git` 侧还活着吗」的唯一依据,虚高的那份不报错,只是对着空壳答「还活着」。
         */
        const at = gitWatchers.indexOf(w);
        if (at !== -1) gitWatchers.splice(at, 1);
        // 非递归即原生 watcher,它在 emit 之前就关了 handle(工作区那条不是)。close()
        // 之后再冒出来的错误会在关服务的路上打一行「file watching degraded」
        if (!closed && primary) usePolling(cause);
      });
      gitWatchers.push(w);
    } catch (cause) {
      // 一个目录建不起来(ENOSPC / 网络盘 / 权限)不该让整个监听塌掉 —— 但 `.git`
      // 主力那条缺了就意味着提交/切分支未必看得见,轮询要顶上
      if (primary) usePolling(toError(cause));
    }
  }

  /**
   * 工作区侧,按档位分。**C 档一个递归 watch 都不建**:Node 在 Linux 上的递归实现是用户
   * 态遍历,对每个**普通文件**也注册一个 inotify watch,monorepo 下足以耗尽
   * `fs.inotify.max_user_watches` —— 之后整机依赖 inotify 的工具(含用户的编辑器)全报
   * ENOSPC,那是本工具唯一可能对用户机器造成的外部副作用。
   */
  if (tier !== 'C') {
    try {
      const handler = (_event: string, filename: string | Buffer | null) => {
        /**
         * **B 档的过滤必须在这里,也就是合并窗口之前**:放在窗口之后等于让 `node_modules`
         * 的写入噪声照样把窗口顶开。A 档由 `ignore` 过滤(Linux 上还是注册前跳过,那才是
         * 配额问题的解法)。`filename` 可能为 null,那时**放行** —— 漏刷比多刷糟得多。
         */
        if (tier === 'B' && typeof filename === 'string' && isIgnored(filename)) return;
        schedule();
      };

      /**
       * A / B 的差别**只有 `ignore` 这一个键**,所以只在选项上分叉、`watch()` 只写一次 ——
       * 两份调用各写一遍时 B 那份悄悄漂走,正是本文件反复在防的那类失效。
       */
      const options: IgnoringWatchOptions | { recursive: true; persistent: false } =
        tier === 'A'
          ? { recursive: true, persistent: false, ignore: isIgnored }
          : { recursive: true, persistent: false };
      const w = watch(repoRoot, options, handler);

      w.on('error', (cause: Error) => {
        /**
         * **必须显式 `close()`,不能只把引用丢掉。** 原生 watcher 在 emit 之前就关了自己,
         * 但 Linux 的**用户态递归实现**只 emit 一个 error,已注册的那一大批 inotify watch
         * 全都还在 —— 而这条路径最典型的触发原因正是配额耗尽,占着不放伤的是用户整机。
         */
        w.close();
        workspaceWatcher = null;
        if (!closed) usePolling(cause);
      });
      workspaceWatcher = w;
    } catch (cause) {
      // 递归 watch 建不起来的三种真实形态:Linux 上配额已满(ENOSPC)、网络盘 /
      // Docker 卷上根本不支持(ENOSYS / EPERM)、以及仓库根在监听期间被删掉
      usePolling(toError(cause));
    }
  }

  return {
    get size() {
      return gitWatchers.length;
    },
    get mode() {
      return polling ? 'polling' : 'native';
    },
    close() {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      for (const w of gitWatchers) w.close();
      gitWatchers.length = 0;
      workspaceWatcher?.close();
      workspaceWatcher = null;
    },
  };
}
