// 文件监听(spec §5.7)。**本阶段只有 `.git` 侧**,工作区那一半(A/B 递归 watch、
// C 档轮询、通用轮询兜底)是 S3b2。
//
// `.git` 侧与档位无关:三档都要对 `HEAD`、`index`、`refs/`、`MERGE_HEAD` / `rebase-*`
// 所在**目录**单独建**非递归** watch,提交与切分支才是即时的(C 档尤其依赖这条 ——
// 它的工作区通路是 1.5s 轮询,只有 `.git` 侧是实时的)。

import { type FSWatcher, statSync, watch } from 'node:fs';
import { join } from 'node:path';

/**
 * 事件合并窗口(spec §5.7 建议 100-200ms)。
 *
 * **在 Linux 上这是必需项而非优化项**:用户态递归实现初次遍历目录树时会对遍历到的
 * 每个条目 emit 一次事件,启动瞬间即产生一波与实际变更无关的风暴(S3b2 接上工作区
 * watch 后就会撞上)。`.git` 侧同样需要:一条 `git commit` 会连着写 index.lock、
 * index、COMMIT_EDITMSG、HEAD 的 reflog、refs/heads/<分支>,五六个事件是常态。
 */
export const DEBOUNCE_MS = 150;

export interface WatcherOptions {
  /** `.git` 目录绝对路径。**不得假设是 `<root>/.git`** —— linked worktree 下它是文件(§5.2)。 */
  gitDir: string;
  /** 合并窗口内至少触发一次。 */
  onChange: () => void;
  debounceMs?: number;
  /** 建 watch 失败时的去处。**TODO(S3b2)**:这里正是降级为轮询的挂点。 */
  onError?: (cause: Error) => void;
}

export interface WatchHandle {
  close(): void;
  /** 实际建起来的 watch 数量。0 意味着 `.git` 侧整个没生效 —— 调用方据此决定要不要降级。 */
  readonly size: number;
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
 * 起 `.git` 侧的监听。
 *
 * 关于「我们自己会不会把自己触发起来」:不会,而且这件事全靠封装层那条
 * `GIT_OPTIONAL_LOCKS=0`(§5.2 红线)。不设它的话 `git status` 会把 stat 缓存写回
 * `.git/index`,于是每次刷新都写一次 index、每次写 index 都触发一次刷新 —— 一个不报错、
 * 只是 CPU 常年 1% 的自激循环,而 status 的输出从头到尾都是对的。
 */
export function createWatcher(options: WatcherOptions): WatchHandle {
  const { gitDir, onChange, debounceMs = DEBOUNCE_MS, onError } = options;
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  /**
   * **不是「每来一个事件就把窗口往后推」的那种 debounce**。
   *
   * 那一种在持续写入下会一直不触发 —— 而 agent 连着改几十个文件、跑一次装依赖,
   * 正是持续写入。这里是「第一个事件起一个窗口,窗口内的后续事件被它吞掉」,
   * 于是风暴期间也保证每 `debounceMs` 至少刷新一次。
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

  for (const dir of gitWatchDirs(gitDir)) {
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
         * 活着吗、要不要降级」的唯一依据(S3b2)。虚高的那份不会报错,只是降级
         * 判据从此对着一个空壳返回「还活着」。
         */
        const at = watchers.indexOf(w);
        if (at !== -1) watchers.splice(at, 1);
        // close() 之后再冒出来的错误不该再打扰调用方:那会在关服务的路上打一行
        // 「file watching degraded」
        if (!closed) onError?.(cause);
      });
      watchers.push(w);
    } catch (cause) {
      // 一个目录建不起来(ENOSPC / 网络盘 / 权限)不该让整个监听塌掉
      onError?.(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  return {
    get size() {
      return watchers.length;
    },
    close() {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      for (const w of watchers) w.close();
      watchers.length = 0;
    },
  };
}
