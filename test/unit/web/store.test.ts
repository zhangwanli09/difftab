// 前端状态层(src/web/state/store.ts)的单测。
//
// 盯的是 §5.0 不变式 4 的落地:分组只读 `FileEntry` 的字段,不在前端重新推导
// git 语义。这类回归不会让任何东西报错 —— 只是列表里少一类文件或多一类。

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { FileEntry, RepoState } from '../../../src/server/shared/protocol';
import { groupFiles, loadError, loadState, repoState } from '../../../src/web/state/store';

const file = (partial: Partial<FileEntry> & { path: string }): FileEntry => ({
  kind: 'tracked',
  staged: '.',
  unstaged: '.',
  ...partial,
});

const byId = (files: readonly FileEntry[]) =>
  Object.fromEntries(groupFiles(files).map((g) => [g.id, g.files.map((f) => f.path)]));

describe('groupFiles', () => {
  test('三类文件各就各位', () => {
    expect(
      byId([
        file({ path: 'a.txt', staged: 'M' }),
        file({ path: 'b.txt', unstaged: 'M' }),
        file({ path: 'new.txt', kind: 'untracked', unstaged: '?' }),
      ]),
    ).toEqual({ staged: ['a.txt'], unstaged: ['b.txt'], untracked: ['new.txt'] });
  });

  test('X=M Y=M 的文件同时出现在已暂存与未暂存里', () => {
    // `git add` 之后再改一次。归一到一个桶等于替用户丢掉一半信息,而 §6 点名要求
    // 「agent 执行过 git add 后,已暂存的改动仍能展示不遗漏」
    const groups = byId([file({ path: 'c.txt', staged: 'M', unstaged: 'M' })]);
    expect(groups.staged).toEqual(['c.txt']);
    expect(groups.unstaged).toEqual(['c.txt']);
  });

  test('未跟踪文件不会漏进「未暂存」—— 判据是 kind 而不是状态位', () => {
    // 协议把未跟踪编码成 unstaged: '?'(§5.12)。若按「unstaged !== '.'」分组,
    // 每个未跟踪文件都会在未暂存组里再出现一次
    expect(byId([file({ path: 'new.txt', kind: 'untracked', unstaged: '?' })])).toEqual({
      staged: [],
      unstaged: [],
      untracked: ['new.txt'],
    });
  });

  test('重命名条目按新路径进已暂存组,oldPath 原样带着', () => {
    const entry = file({
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      staged: 'R',
      renameScore: 96,
    });
    const [staged] = groupFiles([entry]);
    expect(staged?.files[0]?.oldPath).toBe('src/old.ts');
    expect(staged?.files[0]?.renameScore).toBe(96);
  });

  test('保留后端给的顺序,不在前端再排一次', () => {
    // 多一份排序意见就多一处与 `git status` 不一致的可能,而验收标准是「与
    // git status 结果一致」
    const paths = ['z.txt', 'a.txt', 'm.txt'];
    expect(byId(paths.map((path) => file({ path, unstaged: 'M' }))).unstaged).toEqual(paths);
  });

  test('工作区干净时三组都是空的,而不是缺组', () => {
    expect(groupFiles([]).map((g) => g.id)).toEqual(['staged', 'unstaged', 'untracked']);
  });
});

describe('loadState', () => {
  const state: RepoState = {
    branch: { head: 'main', detached: false, upstream: null },
    files: [file({ path: 'a.txt', staged: 'M' })],
    watch: { mode: 'native', tier: 'A' },
  };

  beforeEach(() => {
    repoState.value = null;
    loadError.value = null;
  });

  test('成功时填 repoState 并清掉上一次的错误', async () => {
    loadError.value = '上一次失败了';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(state), { status: 200 })),
    );

    await loadState();
    expect(repoState.value).toEqual(state);
    expect(loadError.value).toBeNull();
  });

  test('后端返回错误体时展示它的 message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'forbidden', message: 'forbidden' } }), {
            status: 403,
          }),
      ),
    );

    await loadState();
    expect(loadError.value).toBe('forbidden');
    expect(repoState.value).toBeNull();
  });

  test('错误正文不是 JSON 时,报的是 HTTP 状态而不是解析错误', async () => {
    // `pnpm dev` 下后端没起来时,Vite 代理回的就是纯文本 500。先 json() 的写法会
    // 抛 SyntaxError,错误条上显示「Unexpected token 'E'…」,真正的原因被盖掉
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Error: connect ECONNREFUSED', { status: 500 })),
    );

    await loadState();
    expect(loadError.value).toBe('请求失败(HTTP 500)');
    expect(loadError.value).not.toContain('JSON');
  });

  test('两次请求重叠时,后发的赢 —— 旧快照不会盖掉新快照', async () => {
    // S3b1 起每个 SSE change 事件都会调一次,agent 跑动期间事件密集。先发后到时
    // 列表会停在过期状态直到下一次事件 —— 不报错,只是显示的东西不对
    const stale: RepoState = { ...state, files: [file({ path: 'stale.txt', unstaged: 'M' })] };
    const fresh: RepoState = { ...state, files: [file({ path: 'fresh.txt', unstaged: 'M' })] };
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // 第一次发的慢、第二次快 —— 于是「先发后到」
        const slowest = first;
        first = false;
        await new Promise((r) => setTimeout(r, slowest ? 30 : 0));
        return new Response(JSON.stringify(slowest ? stale : fresh), { status: 200 });
      }),
    );

    await Promise.all([loadState(), loadState()]);
    expect(repoState.value?.files[0]?.path).toBe('fresh.txt');
  });

  test('fetch 本身失败时也给得出一句话,不是空白错误条', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await loadState();
    expect(loadError.value).toBe('Failed to fetch');
  });
});
