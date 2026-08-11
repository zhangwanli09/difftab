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
  const dir = join(mkdtempSync(join(tmpdir(), 'gitglance-watch-err-')), '.git');
  mkdirSync(join(dir, 'refs', 'heads'), { recursive: true });
  return dir;
}

afterEach(() => {
  made.length = 0;
});

describe('createWatcher 的 error 事件', () => {
  test('出错的 watcher 从 size 里摘掉 —— 它已经不送事件了', () => {
    // size 是 S3b2 判断「.git 侧还活着吗、要不要降级」的唯一依据。留着一个空壳
    // 不会报错,只是降级判据从此对着它回答「还活着」
    const errors: Error[] = [];
    const handle = createWatcher({
      gitDir: fakeGitDir(),
      onChange: () => {},
      onError: (cause) => errors.push(cause),
    });
    const before = handle.size;
    expect(before).toBeGreaterThan(1);

    made[0]?.emit('error', new Error('ENOSPC'));

    expect(handle.size).toBe(before - 1);
    expect(errors.map((e) => e.message)).toEqual(['ENOSPC']);
    handle.close();
  });

  test('close 之后再冒出来的错误不再上报', () => {
    // 否则关服务的路上会打一行「file watching degraded」,而此刻降级已经毫无意义
    const errors: Error[] = [];
    const handle = createWatcher({
      gitDir: fakeGitDir(),
      onChange: () => {},
      onError: (cause) => errors.push(cause),
    });

    handle.close();
    made[0]?.emit('error', new Error('too late'));

    expect(errors).toEqual([]);
  });
});
