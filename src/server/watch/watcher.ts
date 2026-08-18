// 文件监听(spec §5.7):`.git` 侧的目录级非递归 watch + 工作区侧的三档 + 轮询兜底。
//
// `.git` 侧与档位无关:三档都要对 `HEAD`、`index`、`refs/`、`MERGE_HEAD` / `rebase-*`
// 所在**目录**单独建**非递归** watch,提交与切分支才是即时的(C 档尤其依赖这条 ——
// 它的工作区通路是 1.5s 轮询,只有 `.git` 侧是实时的)。
//
// 工作区侧按档位分(§5.7 的三档表):A 有 `ignore`、B 在回调里过滤、C 不建递归 watch。
// **两侧共用同一个合并窗口**:一条 `git commit` 会同时惊动两侧,各起各的窗口等于
// 每次提交刷两遍。

import { type FSWatcher, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { WatchState } from '../shared/protocol.ts';
import { isIgnored } from './ignore.ts';
import { initialMode, type WatchTier } from './tier.ts';

/**
 * 事件合并窗口(spec §5.7 建议 100-200ms)。
 *
 * **在 Linux 上这是必需项而非优化项**:用户态递归实现初次遍历目录树时会对遍历到的
 * 每个条目 emit 一次事件,启动瞬间即产生一波与实际变更无关的风暴。`.git` 侧同样需要:
 * 一条 `git commit` 会连着写 index.lock、index、COMMIT_EDITMSG、HEAD 的 reflog、
 * refs/heads/<分支>,五六个事件是常态。
 */
export const DEBOUNCE_MS = 150;

/** 降级轮询的周期(spec §5.7「1.5s 轮询」)。C 档的工作区通路也是它。 */
export const POLL_MS = 1500;

/**
 * **原生档(A / B)的低频安全轮询周期**(spec §5.7)。
 *
 * 它补的是一个没有任何信号的缺口:Linux 上 inotify 配额在**遍历途中**耗尽时,Node
 * 一次都不 emit(2026-08-18 实测,推翻了此前的源码推断,见 §10)—— 没轮上注册的那些
 * 目录里,改一个**启动前就存在**的文件从此静默丢失,`mode` 还一直说 `native`。
 * 原生监听少报了什么是没法从监听那一侧知道的,只有拿 status 输出本身去比才看得见。
 *
 * **取 30s 而不是 1.5s**:§6 要求「原生监听模式下空闲 CPU 接近零」,一次 status 几十
 * 毫秒,30s 一拍的占空比是千分之几;代价是那个病态场景下最坏 30s 的滞后。
 */
export const SAFETY_POLL_MS = 30_000;

export interface WatcherOptions {
  /** `.git` 目录绝对路径。**不得假设是 `<root>/.git`** —— linked worktree 下它是文件(§5.2)。 */
  gitDir: string;
  /** 工作区根目录绝对路径。A / B 档的递归 watch 建在它上面。 */
  repoRoot: string;
  tier: WatchTier;
  /** 合并窗口内至少触发一次。 */
  onChange: () => void;
  /**
   * 轮询探针:返回一份「变没变」的快照。
   *
   * **必须是 §5.2 主查询 `git status --porcelain=v2 --branch -uall -z` 的逐字复用**,
   * 由调用方注入(注入点在 http/server.ts,git 子进程只许出现在 server/git,§5.0
   * 不变式 1)。裁剪参数的后果是静默的:漏 `-uall` 时 git 把未跟踪目录折成一行
   * `dir/`,于是在一个**已存在的**未跟踪目录里新增文件根本不改变输出,轮询判定
   * 「无变化」、页面不刷新 —— 而那正是 agent 边跑边生成文件时最常见的形态。
   *
   * 必填而不是选填:给它一个默认的「没有探针就不轮询」,C 档在忘记注入时会安静地
   * 永不刷新,而进程照常启动、页面照常打开。
   */
  pollStatus: () => Promise<string>;
  /**
   * **落到轮询兜底**时调用一次(A / B 档的 watch 失败:ENOSPC / ENOSYS / 网络盘 /
   * Docker 卷)。调用方据此把 `WatchState.mode` 翻成 `polling` **并推一个 `change`**
   * —— 前端无从自己推断降级这件事(§5.12),不推事件的话它要等到下一次变更才会
   * 重取 `/api/state`,而那期间页面上标着的是「原生监听」。
   *
   * C 档不走这里:它的轮询是既定形态而不是降级,`initialMode` 已经把 `mode` 给成
   * `polling` 了。
   *
   * 必填,理由同 `pollStatus`:漏传不会报错,只会让降级从此**没有出口** ——
   * 页面一直标着「原生监听」,而实际上早就在轮询了。
   */
  onDegrade: (cause: Error) => void;
  debounceMs?: number;
  pollMs?: number;
  safetyPollMs?: number;
}

export interface WatchHandle {
  close(): void;
  /**
   * **`.git` 侧**实际建起来的 watch 数量(工作区那条不算在内)。
   *
   * 0 意味着 `.git` 侧整个没生效 —— 提交与切分支从此只能靠轮询发现。工作区侧的
   * 死活看 `mode`,两件事不合并成一个数:合并之后「`.git` 没了但工作区还在」与
   * 「工作区没了但 `.git` 还在」是同一个 1,而这两种情况的补救完全不同。
   */
  readonly size: number;
  /** 工作区通路当前的形态(§5.12 的 `WatchState.mode`)。 */
  readonly mode: WatchState['mode'];
}

/**
 * `.git` 下需要盯的目录清单。
 *
 * **一律是目录,绝不是单个文件**:Linux / macOS 上 watch 绑的是 inode,而 git 写
 * `HEAD` / `index` 走的是「写临时文件 + 原子 rename」,新文件是新 inode,对文件建的
 * watch 从此静默失效(spec §5.7)。
 *
 * **绝不递归、更绝不进 `objects`**:一次 gc 就是几万个条目,既是配额灾难,也会把
 * 与展示无关的写入变成事件风暴。清单之所以短得像不够用,是因为主力其实是 `gitDir`
 * 本身 —— 提交写 `index` 与 `COMMIT_EDITMSG`、切分支写 `HEAD`、fetch 写 `FETCH_HEAD`,
 * 全都直接落在它下面。`refs/` 那两条是补 `refs/heads/<分支>` 这种一层深的更新,
 * 属于锦上添花;`refs/heads/feature/x` 这类嵌套分支名照样只由 `index` 那一路兜住,
 * 而那一路本来就够。
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
 * `fs.watch` 的 `ignore` 选项(Node ≥ 24.14.0)。
 *
 * `@types/node` 钉在运行时下限 22 那条线上(§5.1),而那个版本还没有这个选项 ——
 * 类型里因此没有它。声明成本地类型而不是 `as any`:写错选项名的话(`ignores`)
 * TS 照样通过,而 Node 会把未知选项**静默忽略**,于是 A 档在 Linux 上退化成
 * 一个没有过滤的递归 watch —— 正是 §5.7 判档要防的那件事。
 */
type IgnoringWatchOptions = {
  recursive: true;
  persistent: false;
  ignore: (path: string) => boolean;
};

/**
 * 起监听。
 *
 * 关于「我们自己会不会把自己触发起来」:不会,而且这件事全靠封装层那条
 * `GIT_OPTIONAL_LOCKS=0`(§5.2 红线)。不设它的话 `git status` 会把 stat 缓存写回
 * `.git/index`,于是每次刷新都写一次 index、每次写 index 都触发一次刷新 —— 一个不报错、
 * 只是 CPU 常年 1% 的自激循环,而 status 的输出从头到尾都是对的。轮询那条路上这
 * 一点更要命:它每 1.5s 主动跑一次 status。
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
   * **不是「每来一个事件就把窗口往后推」的那种 debounce**。
   *
   * 那一种在持续写入下会一直不触发 —— 而 agent 连着改几十个文件、跑一次装依赖,
   * 正是持续写入。这里是「第一个事件起一个窗口,窗口内的后续事件被它吞掉」,
   * 于是风暴期间也保证每 `debounceMs` 至少刷新一次。
   *
   * `.git` 侧、工作区侧与轮询共用这一个窗口(见文件头)。
   */
  const schedule = () => {
    if (closed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
    // 监听绝不该是进程活着的理由 —— 那是 HTTP server 的职责(§5.8 的空闲退出)
    timer.unref();
  };

  /**
   * 轮询一拍:取一份快照,与上一份不同就当作一次变更。
   *
   * 用 `setTimeout` 链而不是 `setInterval`:探针是一次 git 子进程,大仓库上未必
   * 1.5s 内跑得完,`setInterval` 会让它们叠着跑。
   *
   * **首拍只建立基线,不触发刷新**(`lastSnapshot === null`):降级那一刻页面刚
   * 重取过,再推一次纯属白刷。探针失败(仓库正被 index.lock 挡住、git 一时不可用)
   * 也不终止轮询 —— 那是暂态,停下来就再也起不来了。
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
   * 排下一拍。**同一个循环的两个周期,不是两套机制**:原生档跑 `safetyPollMs`(30s)
   * 的安全轮询,降级之后自动收到 `pollMs`(1.5s)。两个定时器各排各的话,降级那一刻
   * 要记得把前一个停掉 —— 忘了不报错,只是从此每 30s 白跑一次 git。
   *
   * 每次都先清掉在等的那一拍:降级时正是靠这一下把 30s 的等待按新周期提前,否则
   * 「已降级」之后最长还要再等 30s 才有第一次轮询,而页面上标的已经是轮询了。
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
   * 转到轮询。**`cause` 为 null 表示这是该档位的既定形态,不是降级** —— C 档一开始
   * 就走这条路,没有任何东西坏掉,自然也不该上报。
   *
   * 只有一个入口(而不是「起轮询」+「降级」两个),是因为 `polling` 这个闩只该在
   * 一处合上:两个入口各带一份 `closed || polling` 判断时,「谁先谁后、谁的守卫
   * 拦住了谁」就成了调用点必须自己想清楚的事,而想错的症状是多推一次降级通知。
   *
   * **不可逆,而且只上报一次**:一次 ENOSPC 往往连着把几个 watcher 全打下来,
   * 每个都上报的话前端会收到一串重复的降级通知。也**不尝试恢复原生监听** ——
   * 恢复要么靠定期重试(在真的没有配额时就是每隔一会儿遍历一次整棵树)、要么靠猜,
   * 而轮询已经是功能完整的通路,唯一代价是 1.5s 延迟。
   */
  const usePolling = (cause: Error | null) => {
    if (closed || polling) return;
    polling = true;
    // 原生档的安全轮询多半已经在跑了(见下面起循环那处):此时要做的不是再起一条,
    // 而是把在等的那一拍按新周期提前。有一拍正在飞行中时它自己会在收尾时重排
    if (!pollLoopStarted) startPolling();
    else if (!pollInFlight) armPoll();
    if (cause) onDegrade(cause);
  };

  const toError = (cause: unknown): Error =>
    cause instanceof Error ? cause : new Error(String(cause));

  /**
   * C 档的轮询要在 `.git` 侧之前起,否则那边一个 watch 失败会被当成降级上报:
   * stderr 打一行、再往刚连上的客户端推一个 `change`,而 `mode` 从头到尾就是
   * `polling`,没有任何东西真的变过。
   *
   * 「哪档以轮询为既定形态」只此一份判据(`initialMode`)—— server 那侧在监听还没
   * 懒起时也读它来答 `/api/state`,各写各的话两边会在加档位时静默分家。
   */
  if (initialMode(tier) === 'polling') {
    usePolling(null);
  } else {
    /**
     * 原生档的低频安全轮询(§5.7)。**直接起循环而不经 `usePolling`**:那个闩一合上
     * 就意味着「已降级」,而这里没有任何东西坏掉 —— `mode` 必须还是 `native`,
     * 否则页面会把一次完全正常的运行标成降级。首拍照例只建立基线。
     */
    startPolling();
  }

  for (const dir of gitWatchDirs(gitDir)) {
    /**
     * **只有 `gitDir` 自己那条算主力**(见 gitWatchDirs 的注释):提交写 `index` 与
     * `COMMIT_EDITMSG`、切分支写 `HEAD`、fetch 写 `FETCH_HEAD`,全都直接落在它下面。
     * `refs/` 那两条是锦上添花,它们失败(权限、网络盘)不值得把整个工具**不可逆地**
     * 拖进轮询 —— 那样 UI 会永远标着「轮询刷新」、进程永远每 1.5s 起一次 git,
     * 而实际上什么都没坏。
     */
    const primary = dir === gitDir;
    try {
      /**
       * **不传 `recursive`**(见 gitWatchDirs 的注释);`persistent: false` 是说
       * 监听不吊住事件循环。
       *
       * **filename 一概不看**。它可能为 null(§5.7),而这几个目录里的任何写入都
       * 值得刷新一次:非递归就是真的非递归 —— macOS 已实测(2026-08-11,见 spec §10),
       * Linux 的 inotify 与 Windows 的 `bWatchSubtree=FALSE` 按机制如此 —— 于是
       * `objects/` 的海量写入根本到不了这里,没有需要按名字排除的东西。曾按
       * 「macOS 会漏过来」加过一个顶层段过滤,那是把**建流窗口的补报**(建流前一刻的
       * 写入会被补进来一两条)误读成了嵌套事件。
       */
      const w = watch(dir, { persistent: false }, () => schedule());
      w.on('error', (cause: Error) => {
        /**
         * 出错的 watcher 已经不再送事件了(Node 在 emit 之前就把 handle 关了),
         * 留在数组里只会让 `size` 虚高 —— 而 `size` 正是调用方判断「`.git` 侧还
         * 活着吗」的唯一依据。虚高的那份不会报错,只是判据从此对着一个空壳返回
         * 「还活着」。
         */
        const at = gitWatchers.indexOf(w);
        if (at !== -1) gitWatchers.splice(at, 1);
        // 这几条一律非递归,也就是原生 watcher —— 它在 emit 之前就把 handle 关了
        // (工作区那条不是,见那边的注释)。close() 之后再冒出来的错误不该再打扰
        // 调用方:那会在关服务的路上打一行「file watching degraded」
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
   * 工作区侧,按档位分(§5.7 的三档表)。
   *
   * **C 档一个递归 watch 都不建**:Node 在 Linux 上的递归实现是用户态遍历,对遍历到的
   * 每个**普通文件**也注册一个 inotify watch,monorepo 下足以耗尽
   * `fs.inotify.max_user_watches` —— 之后整机所有依赖 inotify 的工具(包括用户自己的
   * 编辑器)开始报 ENOSPC。那是本工具唯一可能对用户机器造成的外部副作用。
   */
  if (tier !== 'C') {
    try {
      const handler = (_event: string, filename: string | Buffer | null) => {
        /**
         * **B 档的过滤必须在这里,也就是合并窗口之前**(§5.7 红线)。放在窗口之后
         * 等于让 `node_modules` 的写入噪声照样把窗口顶开、触发无谓刷新 —— 而
         * §6 那条「`node_modules` 的嵌套子目录里批量写文件不触发刷新」正是钉这件事。
         *
         * A 档不在这里过滤:`ignore` 已经过滤过了(Linux 上还是**注册前跳过**,
         * 那才是配额问题的解法)。
         *
         * `filename` 可能为 null(§5.7,Node 文档载明即便在支持的平台上也不保证提供),
         * 那时**放行**:漏刷一次比多刷一次糟得多。
         */
        if (tier === 'B' && typeof filename === 'string' && isIgnored(filename)) return;
        schedule();
      };

      /**
       * A / B 的差别**只有 `ignore` 这一个键**,所以只在选项上分叉、`watch()` 只写
       * 一次:两份调用各写一遍时,`persistent` / `recursive` / 回调都得改两处,
       * 而 B 那份悄悄漂走正是本文件反复在防的那类失效。
       */
      const options: IgnoringWatchOptions | { recursive: true; persistent: false } =
        tier === 'A'
          ? { recursive: true, persistent: false, ignore: isIgnored }
          : { recursive: true, persistent: false };
      const w = watch(repoRoot, options, handler);

      w.on('error', (cause: Error) => {
        /**
         * **必须显式 `close()`,不能只把引用丢掉。**
         *
         * 原生 watcher(macOS / Windows,以及非递归那条)确实在 emit 之前就关了自己,
         * 但 Linux 的**用户态递归实现**不是:核对 `internal/fs/recursive_watch.js`,
         * `#watchFolder` 的 catch 里只有一句 `this.emit('error', …)`,已经注册的那一
         * 大批 inotify watch 全都还在,只有显式 `close()` 才放得掉。丢掉引用等于
         * 让它们活到进程结束 —— 而这条路径最典型的触发原因**正是 inotify 配额耗尽**,
         * 那时候还占着一堆配额不放,伤的是用户整机的其他工具。
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
