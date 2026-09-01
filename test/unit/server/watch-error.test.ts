// `createWatcher` 的错误路径(src/server/watch/watcher.ts)。
//
// 单独一个文件,是因为它要把 `node:fs` 的 `watch` 换成替身:`FSWatcher` 的 'error'
// 在真实文件系统上没有可移植的触发手段(删掉被 watch 的目录在 macOS / Linux 上派发的
// 是 'rename',只有 Windows 才是 'error')。而这份 mock 一旦生效,`watch.test.ts` 里
// 那些真跑文件系统的用例会整片被架空成永远绿的 —— 所以两者不合并。

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createWatcher } from '../../../src/server/watch/watcher.ts';

/** 建过的每一个替身,顺序即建立顺序。 */
const made: FakeWatcher[] = [];

class FakeWatcher extends EventEmitter {
  closed = false;
  close() {
    this.closed = true;
  }
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // statSync 保持真的:要盯哪些目录仍由真实的 .git 结构决定
    watch: () => {
      const w = new FakeWatcher();
      made.push(w);
      return w;
    },
  };
});

/** 造一个有 refs/heads 的 .git 骨架,好让 gitWatchDirs 返回不止一个目录。 */
function fakeGitDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'difftab-watch-err-')), '.git');
  mkdirSync(join(dir, 'refs', 'heads'), { recursive: true });
  return dir;
}

afterEach(() => {
  made.length = 0;
});

/** 起一个 B 档的 watcher(`.git` 侧 + 一条工作区递归 watch),轮询给恒定快照。 */
function watcherOn(gitDir: string, onDegrade: (cause: Error) => void) {
  return createWatcher({
    gitDir,
    repoRoot: join(gitDir, '..'),
    // 不用 C 档:它一开始就在轮询,而「已经在轮询了就不必再降一次」这条正确的
    // 短路会把下面两条用例要看的上报路径整个绕过去
    tier: 'B',
    onChange: () => {},
    pollStatus: async () => 'unchanged',
    pollMs: 60_000,
    onDegrade,
  });
}

describe('createWatcher 的 error 事件', () => {
  test('出错的 watcher 从 size 里摘掉 —— 它已经不送事件了', () => {
    // size 是「`.git` 侧还活着吗」的唯一依据:留着一个空壳不报错,只是判据从此对着它答「还活着」
    const degrades: Error[] = [];
    const handle = watcherOn(fakeGitDir(), (cause) => degrades.push(cause));
    const before = handle.size;
    expect(before).toBeGreaterThan(1);

    // made[0] 是第一个 `.git` 侧 watcher —— 它们建在工作区那条之前
    made[0]?.emit('error', new Error('ENOSPC'));

    expect(handle.size).toBe(before - 1);
    // `.git` 侧塌了一块同样要降级:提交与切分支从此未必看得见,轮询得顶上
    expect(degrades.map((e) => e.message)).toEqual(['ENOSPC']);
    expect(handle.mode).toBe('polling');
    handle.close();
  });

  test('refs/ 那几条锦上添花的 watch 出错不拖着整个工具降级', () => {
    /**
     * `gitWatchDirs` 里只有 `gitDir` 自己是主力:提交写 `index` 与 `COMMIT_EDITMSG`、
     * 切分支写 `HEAD`、fetch 写 `FETCH_HEAD`,全落在它下面。`refs/` 那两条失败
     * (权限、网络盘)不该把工具**不可逆地**拖进轮询 —— 那样 UI 永远标着「轮询刷新」、
     * 进程永远每 1.5s 起一次 git,而实际上什么都没坏
     */
    const degrades: Error[] = [];
    const handle = watcherOn(fakeGitDir(), (cause) => degrades.push(cause));
    const before = handle.size;

    // made[1] 是 `refs`(建立顺序即 gitWatchDirs 的顺序,gitDir 自己排第一)
    made[1]?.emit('error', new Error('EPERM'));

    expect(degrades).toEqual([]);
    expect(handle.mode).toBe('native');
    // 摘掉仍然要摘:留着空壳会让 size 虚高
    expect(handle.size).toBe(before - 1);
    handle.close();
  });

  test('close 之后再冒出来的错误不再上报', () => {
    // 否则关服务的路上会打一行「file watching degraded」,而此刻降级已经毫无意义
    const degrades: Error[] = [];
    const handle = watcherOn(fakeGitDir(), (cause) => degrades.push(cause));

    handle.close();
    made[0]?.emit('error', new Error('too late'));

    expect(degrades).toEqual([]);
  });
});
