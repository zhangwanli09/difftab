// 前端状态层(src/web/state/store.ts)的单测。
//
// 盯的是 §5.0 不变式 4 的落地:分组只读 `FileEntry` 的字段,不在前端重新推导
// git 语义。这类回归不会让任何东西报错 —— 只是列表里少一类文件或多一类。

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DiffPayload, FileEntry, RepoState } from '../../../src/server/shared/protocol';
import {
  diffState,
  groupFiles,
  loadDiff,
  loadError,
  loadState,
  refresh,
  repoState,
  selectedPath,
  selectFile,
} from '../../../src/web/state/store';

const file = (partial: Partial<FileEntry> & { path: string }): FileEntry => ({
  kind: 'tracked',
  staged: '.',
  unstaged: '.',
  ...partial,
});

const byId = (files: readonly FileEntry[]) =>
  Object.fromEntries(groupFiles(files).map((g) => [g.id, g.files.map((f) => f.path)]));

/**
 * 把 fetch 换成一个只回这一份正文的桩,并把它收到的 URL 全部记下来。
 *
 * 两个 describe 共用一份:`new Response(JSON.stringify(…))` 抄第五遍的时候,改一处
 * 请求头或错误形状就得记得另外四处也在。
 */
function stubJson(payload: unknown, status = 200): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(payload), { status });
    }),
  );
  return calls;
}

/**
 * 第一次发的慢、第二次快 —— 于是「先发后到」。
 *
 * 两处竞态用例都靠这 30ms 的错位成立,写两份的话调其中一份的时长,另一份会静默
 * 变得不确定(而它照样是绿的)。
 */
function stubSlowThenFast(slow: unknown, fast: unknown): void {
  let first = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const slowest = first;
      first = false;
      await new Promise((r) => setTimeout(r, slowest ? 30 : 0));
      return new Response(JSON.stringify(slowest ? slow : fast), { status: 200 });
    }),
  );
}

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
    stubJson(state);

    await loadState();
    expect(repoState.value).toEqual(state);
    expect(loadError.value).toBeNull();
  });

  test('后端返回错误体时展示它的 message', async () => {
    stubJson({ error: { code: 'forbidden', message: 'forbidden' } }, 403);

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
    stubSlowThenFast(stale, fresh);

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

describe('loadDiff(§5.2 的按文件懒加载)', () => {
  const text: DiffPayload = { kind: 'text', patch: 'diff --git a/a.txt b/a.txt\n' };

  /** 请求 URL 里的 query —— 断言参数而不是断言字符串拼法。 */
  const query = (url: string) => new URLSearchParams(url.slice(url.indexOf('?')));

  beforeEach(() => {
    // selectedPath 由 diffState 派生,清掉后者即可
    diffState.value = null;
    loadError.value = null;
  });

  test('一次点击只发一个请求,且只带这一个文件的 path', async () => {
    // 禁止预取整个列表:agent 单次改 300+ 文件是常态,全仓 diff 会冻结主线程数秒到
    // 数十秒(§5.2 / §6 的 300+ 文件验收项)
    const calls = stubJson(text);
    await loadDiff(file({ path: 'pkg/mod001.ts', unstaged: 'M' }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.startsWith('/api/diff?')).toBe(true);
    expect([...query(calls[0] as string).keys()]).toEqual(['path']);
    expect(query(calls[0] as string).get('path')).toBe('pkg/mod001.ts');
  });

  test('重命名条目把 oldPath 一并传上 —— 漏传会退化成一个全新增文件', async () => {
    // 只传新路径时 git 看不到另一侧、无法配对(已实测,§5.2)。症状不是报错:
    // 页面上是一个内容完整、只是没有 rename from/to 的 diff
    const calls = stubJson(text);
    await loadDiff(file({ path: 'src/new.ts', oldPath: 'src/old.ts', staged: 'R' }));

    expect(query(calls[0] as string).get('path')).toBe('src/new.ts');
    expect(query(calls[0] as string).get('oldPath')).toBe('src/old.ts');
  });

  test('非 ASCII / 空格 / 引号的路径经编码后原样到达后端', async () => {
    const path = "docs/需求 文档 it's.md";
    const calls = stubJson(text);
    await loadDiff(file({ path, unstaged: 'M' }));

    expect(calls[0]).not.toContain(' ');
    expect(query(calls[0] as string).get('path')).toBe(path);
  });

  test('payload 原样落进 diffState —— binary / too-large 不例外', async () => {
    // 四个分支自 S4a 起后端都会真的返回(已跟踪那侧走 numstat,未跟踪那侧走 NUL
    // 探测与体积),store 一律原样透传 —— 判别原因属后端知识(§5.12 / §5.0 不变式 4)
    for (const payload of [
      text,
      { kind: 'untracked-text', patch: '+new\n' },
      { kind: 'binary' },
      { kind: 'too-large', size: 6 * 1024 * 1024, reason: 'size' },
      // 行数那一路的体积不大 —— 两条都过一遍,免得 store 将来「顺手」按体积做判断
      { kind: 'too-large', size: 100 * 1024, reason: 'lines' },
    ] satisfies DiffPayload[]) {
      stubJson(payload);
      await loadDiff(file({ path: 'a.bin', unstaged: 'M' }));
      expect(diffState.value).toEqual({ status: 'ready', path: 'a.bin', rename: null, payload });
    }
  });

  test('重命名条目把旧路径与相似度一并带进状态,普通条目是 null', async () => {
    // 标注跟着请求走,而不是渲染时回列表里现找:选中的文件随时可能从下一份列表里
    // 消失(改动被撤销 / 被 commit),那时右侧刻意留着最后那份 diff,现找的写法会让
    // 标注单独消失 —— 补丁里还带着 rename from/to,标题却说这是个普通文件
    stubJson(text);
    await loadDiff(
      file({ path: 'src/new.ts', oldPath: 'src/old.ts', staged: 'R', renameScore: 87 }),
    );
    expect(diffState.value?.rename).toEqual({ oldPath: 'src/old.ts', score: 87 });

    // git 没给相似度就不编一个:`?? 0` 会让页面说出「相似度 0%」这句 git 没说过的话
    await loadDiff(file({ path: 'src/new.ts', oldPath: 'src/old.ts', staged: 'R' }));
    expect(diffState.value?.rename).toEqual({ oldPath: 'src/old.ts', score: null });

    await loadDiff(file({ path: 'plain.ts', unstaged: 'M' }));
    expect(diffState.value?.rename).toBeNull();
  });

  test('两次点击重叠时后点的赢 —— 先发后到不会盖掉当前文件的 diff', async () => {
    const slow: DiffPayload = { kind: 'text', patch: 'stale\n' };
    const fast: DiffPayload = { kind: 'text', patch: 'fresh\n' };
    stubSlowThenFast(slow, fast);

    await Promise.all([
      loadDiff(file({ path: 'stale.txt', unstaged: 'M' })),
      loadDiff(file({ path: 'fresh.txt', unstaged: 'M' })),
    ]);
    // 状态里的 path 与 payload 必须是同一个文件的:错位的症状是标题写着 A、
    // 底下渲染的是 B
    expect(diffState.value).toEqual({
      status: 'ready',
      path: 'fresh.txt',
      rename: null,
      payload: fast,
    });
  });

  test('一个文件取不到 diff 时不动整页的错误横幅', async () => {
    // loadError 说的是「列表取不到」。一个文件失败就把它点亮,页面看起来整个坏掉了
    stubJson({ error: { code: 'not-found', message: '文件不在了' } }, 400);

    await loadDiff(file({ path: 'gone.txt', unstaged: 'D' }));
    expect(diffState.value).toEqual({
      status: 'error',
      path: 'gone.txt',
      rename: null,
      message: '文件不在了',
    });
    expect(loadError.value).toBeNull();
  });

  test('请求发出前就进 loading 态,且带的是新文件的 path', async () => {
    // 切换文件的那一瞬间若还留着上一个文件的 payload,渲染出来就是张冠李戴
    diffState.value = { status: 'ready', path: 'old.txt', rename: null, payload: text };
    stubJson(text);
    const pending = loadDiff(file({ path: 'new.txt', unstaged: 'M' }));
    expect(diffState.value).toEqual({ status: 'loading', path: 'new.txt', rename: null });
    await pending;
  });

  test('同一个文件重新取时不回退到 loading —— 否则每次刷新都把画好的 diff 拆掉重画', async () => {
    // 回退的代价不是闪一下:ready → loading 会让渲染 diff 的子树整个卸载,滚动位置
    // 随之丢失。S3b1 起每个 SSE change 事件都会走这里,而 §5.4 要求刷新不丢滚动位置
    diffState.value = { status: 'ready', path: 'a.txt', rename: null, payload: text };
    const fresh: DiffPayload = { kind: 'text', patch: 'updated\n' };
    stubJson(fresh);

    const pending = loadDiff(file({ path: 'a.txt', unstaged: 'M' }));
    // 请求在飞的这段时间里,上一份仍然挂着
    expect(diffState.value).toEqual({
      status: 'ready',
      path: 'a.txt',
      rename: null,
      payload: text,
    });
    await pending;
    expect(diffState.value).toEqual({
      status: 'ready',
      path: 'a.txt',
      rename: null,
      payload: fresh,
    });
  });

  test('selectFile 同时更新选中态并拉 diff —— 组件不必知道这是两件事', async () => {
    const calls = stubJson(text);
    selectFile(file({ path: 'src/new.ts', oldPath: 'src/old.ts', staged: 'R' }));

    expect(selectedPath.value).toBe('src/new.ts');
    // 微任务排空,让上面那个 void 出去的请求落地
    await vi.waitFor(() => expect(diffState.value?.status).toBe('ready'));
    expect(query(calls[0] as string).get('oldPath')).toBe('src/old.ts');
  });
});

describe('refresh(一次 SSE change 之后要重取什么)', () => {
  const text: DiffPayload = { kind: 'text', patch: 'old\n' };
  const fresh: DiffPayload = { kind: 'text', patch: 'new\n' };

  const stateWith = (files: FileEntry[]): RepoState => ({
    branch: { head: 'main', detached: false, upstream: null },
    files,
    watch: { mode: 'native', tier: 'A' },
  });

  /** 按路径分派的 fetch 桩:refresh 会连着打两个不同的端点。 */
  function stubEndpoints(state: RepoState, diff: DiffPayload): string[] {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        const body = url.startsWith('/api/state') ? state : diff;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    return calls;
  }

  beforeEach(() => {
    repoState.value = null;
    diffState.value = null;
    loadError.value = null;
  });

  test('没有选中文件时只重取列表', async () => {
    const calls = stubEndpoints(stateWith([file({ path: 'a.txt', unstaged: 'M' })]), fresh);

    await refresh();
    expect(calls).toEqual(['/api/state']);
    expect(diffState.value).toBeNull();
  });

  test('打开着的 diff 也重取 —— 只刷列表的话右侧会停在旧补丁上', async () => {
    // 文件内容变了而列表条目没变(还是那个 `1 .M`)是最常见的形态,页面看不出异样
    diffState.value = { status: 'ready', path: 'a.txt', rename: null, payload: text };
    const calls = stubEndpoints(stateWith([file({ path: 'a.txt', unstaged: 'M' })]), fresh);

    await refresh();
    expect(calls.some((url) => url.startsWith('/api/diff?'))).toBe(true);
    expect(diffState.value).toEqual({
      status: 'ready',
      path: 'a.txt',
      rename: null,
      payload: fresh,
    });
  });

  test('重取用的是新列表里的条目 —— oldPath 跟着变,不能拿旧条目去取', async () => {
    // 相似度与配对结果都会随改动变化。用旧条目取等于用过期的 oldPath(§5.2 双路径)
    diffState.value = { status: 'ready', path: 'new.ts', rename: null, payload: text };
    const calls = stubEndpoints(
      stateWith([file({ path: 'new.ts', oldPath: 'renamed-again.ts', staged: 'R' })]),
      fresh,
    );

    await refresh();
    const diffCall = calls.find((url) => url.startsWith('/api/diff?')) ?? '';
    expect(new URLSearchParams(diffCall.slice(diffCall.indexOf('?'))).get('oldPath')).toBe(
      'renamed-again.ts',
    );
  });

  test('选中的文件从列表里消失了就不去取它,右侧保留最后那份 diff', async () => {
    // 改动被撤销或被 commit 掉了。把右侧突然清空比留着更让人困惑,而且合成一个
    // 不带 oldPath 的条目去取,正好是「重命名退化成全新增」那条路
    diffState.value = { status: 'ready', path: 'gone.txt', rename: null, payload: text };
    const calls = stubEndpoints(stateWith([file({ path: 'other.txt', unstaged: 'M' })]), fresh);

    await refresh();
    expect(calls).toEqual(['/api/state']);
    expect(diffState.value).toEqual({
      status: 'ready',
      path: 'gone.txt',
      rename: null,
      payload: text,
    });
  });

  test('列表取不到时不去取 diff —— 手上那份列表已经是过期的了', async () => {
    /**
     * **`repoState` 必须先有一份旧快照**,否则这条用例是假绿的:`loadState()` 失败
     * 时它保持原值,只有原值非 null 才走得到「照着旧列表找条目」那一步 —— 而生产里
     * 它一直是非 null(第一帧就取过了)。第一版把它留在 null 上,拿掉产品里的
     * 提前返回照样全绿。旧列表的 oldPath 是过期的,拿它取 diff 正是重命名退化成
     * 全新增那条路(§5.2)。
     */
    repoState.value = stateWith([file({ path: 'a.txt', oldPath: 'stale.txt', staged: 'R' })]);
    diffState.value = { status: 'ready', path: 'a.txt', rename: null, payload: text };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response('boom', { status: 500 });
      }),
    );

    await refresh();
    expect(calls).toEqual(['/api/state']);
    expect(loadError.value).toBe('请求失败(HTTP 500)');
    expect(diffState.value).toEqual({
      status: 'ready',
      path: 'a.txt',
      rename: null,
      payload: text,
    });
  });
});
