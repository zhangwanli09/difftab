// 前端状态层(src/web/state/store.ts)的单测。盯的是「前端不内联任何 git 知识」的落地：分组只读
// `FileEntry` 的字段，不在前端重新推导 git 语义。这类回归不会让任何东西报错——只是列表里少一类
// 文件或多一类。

import { effect } from '@preact/signals';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  DiffPayload,
  FileEntry,
  FilePayload,
  RepoState,
} from '../../../src/server/shared/protocol';
import {
  activeDiffPath,
  activeEditorKey,
  activeFilePath,
  editors,
  keyOf,
  openEditor,
  pinEditor,
} from '../../../src/web/state/editors';
import {
  activateEditor,
  activeTab,
  closeEditor,
  diffStates,
  fileStates,
  groupFiles,
  loadDiff,
  loadError,
  loadState,
  openFile,
  refresh,
  repoState,
  selectFile,
} from '../../../src/web/state/store';
import { expandedDirs, loadDir, ROOT, treeCache } from '../../../src/web/state/tree';
import { file, openPinned, resetEditors, stubJson } from './helpers';

/** 栏里的 tab 键，按显示顺序。 */
const tabs = () => editors.value.map(keyOf);

/** 记下来的那串调用里打到某个端点的次数。 */
const count = (calls: readonly string[], endpoint: string) =>
  calls.filter((url) => url.startsWith(endpoint)).length;

const byId = (files: readonly FileEntry[]) =>
  Object.fromEntries(groupFiles(files).map((g) => [g.id, g.files.map((f) => f.path)]));

/** 请求 URL 里的 query——断言参数而不是断言字符串拼法。 */
const query = (url: string) => new URLSearchParams(url.slice(url.indexOf('?')));

/** 记下来的那串调用里那一次 `/api/diff` 的 query。没打过就是 `null`，断言会说清是哪种失败。 */
const diffQuery = (calls: readonly string[]): URLSearchParams | null => {
  const call = calls.find((url) => url.startsWith('/api/diff?'));
  return call === undefined ? null : query(call);
};

/**
 * 第一次发的慢、第二次快——于是「先发后到」。
 *
 * 两处竞态用例都靠这 30ms 的错位成立，写两份的话调其中一份的时长，另一份会静默
 * 变得不确定（而它照样是绿的）。
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
    ).toEqual({
      conflicted: [],
      staged: ['a.txt'],
      unstaged: ['b.txt'],
      untracked: ['new.txt'],
    });
  });

  test('X=M Y=M 的文件同时出现在已暂存与未暂存里', () => {
    // `git add` 之后再改一次：归一到一个桶等于替用户丢掉一半信息
    const groups = byId([file({ path: 'c.txt', staged: 'M', unstaged: 'M' })]);
    expect(groups.staged).toEqual(['c.txt']);
    expect(groups.unstaged).toEqual(['c.txt']);
  });

  test('未跟踪文件不会漏进「未暂存」——判据是 kind 而不是状态位', () => {
    // 协议把未跟踪编码成 unstaged: '?'；按「unstaged !== '.'」分组会让它在未暂存组里再出现一次
    expect(byId([file({ path: 'new.txt', kind: 'untracked', unstaged: '?' })])).toEqual({
      conflicted: [],
      staged: [],
      unstaged: [],
      untracked: ['new.txt'],
    });
  });

  test('冲突条目自成一组，不同时进已暂存与未暂存', () => {
    // `u` 记录的 XY 两位都不是 `.`，按字面判的实现会让它同时进两组——而它哪一组都不属于。`DD` 那
    // 条同时钉住「判据不是状态位」：两位里一个 `U` 都没有，靠 `staged === 'U'` 认的实现会把它漏回
    // 那两组里去
    expect(
      byId([
        file({ path: 'both-modified.txt', staged: 'U', unstaged: 'U', conflicted: true }),
        file({ path: 'both-deleted.txt', staged: 'D', unstaged: 'D', conflicted: true }),
      ]),
    ).toEqual({
      conflicted: ['both-modified.txt', 'both-deleted.txt'],
      staged: [],
      unstaged: [],
      untracked: [],
    });
  });

  test('冲突组排在最前面——rebase 停在半路时它就是唯一要处理的东西', () => {
    const ids = groupFiles([]).map((g) => g.id);
    expect(ids[0]).toBe('conflicted');
  });

  test('重命名条目按新路径进已暂存组，oldPath 原样带着', () => {
    const entry = file({
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      staged: 'R',
      renameScore: 96,
    });
    // 按 id 找而不是按下标取：分组一多一少，按下标的写法会安静地断言到另一组上
    const staged = groupFiles([entry]).find((g) => g.id === 'staged');
    expect(staged?.files[0]?.oldPath).toBe('src/old.ts');
    expect(staged?.files[0]?.renameScore).toBe(96);
  });

  test('保留后端给的顺序，不在前端再排一次', () => {
    // 多一份排序意见就多一处与 `git status` 不一致的可能，而验收标准是「与 git status 结果一致」
    const paths = ['z.txt', 'a.txt', 'm.txt'];
    expect(byId(paths.map((path) => file({ path, unstaged: 'M' }))).unstaged).toEqual(paths);
  });

  test('工作区干净时四组都是空的，而不是缺组', () => {
    expect(groupFiles([]).map((g) => g.id)).toEqual([
      'conflicted',
      'staged',
      'unstaged',
      'untracked',
    ]);
  });
});

describe('loadState', () => {
  const state: RepoState = {
    repoName: 'demo',
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

  test('错误正文不是 JSON 时，报的是 HTTP 状态而不是解析错误', async () => {
    // `pnpm dev` 下后端没起来时，Vite 代理回的就是纯文本 500。先 json() 的写法会
    // 抛 SyntaxError，错误条上显示「Unexpected token 'E'…」，真正的原因被盖掉
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Error: connect ECONNREFUSED', { status: 500 })),
    );

    await loadState();
    expect(loadError.value).toBe('Request failed (HTTP 500).');
    expect(loadError.value).not.toContain('JSON');
  });

  test('两次请求重叠时，后发的赢——旧快照不会盖掉新快照', async () => {
    // 每个 SSE change 事件都会调一次，agent 跑动期间事件密集。先发后到时列表会停在过期状态直到下
    // 一次事件——不报错，只是显示的东西不对
    const stale: RepoState = { ...state, files: [file({ path: 'stale.txt', unstaged: 'M' })] };
    const fresh: RepoState = { ...state, files: [file({ path: 'fresh.txt', unstaged: 'M' })] };
    stubSlowThenFast(stale, fresh);

    await Promise.all([loadState(), loadState()]);
    expect(repoState.value?.files[0]?.path).toBe('fresh.txt');
  });

  test('fetch 本身失败时也给得出一句话，不是空白错误条', async () => {
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

describe('loadDiff（按文件懒加载）', () => {
  const text: DiffPayload = { kind: 'text', patch: 'diff --git a/a.txt b/a.txt\n' };
  const diffOf = (path: string) => diffStates.value.get(path);

  beforeEach(() => {
    resetEditors();
    loadError.value = null;
  });

  test('一次点击只发一个请求，且只带这一个文件的 path', async () => {
    // 禁止预取整个列表：agent 单次改 300+ 文件是常态，全仓 diff 会冻结主线程数秒到数十秒
    const calls = stubJson(text);
    await loadDiff(file({ path: 'pkg/mod001.ts', unstaged: 'M' }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.startsWith('/api/diff?')).toBe(true);
    expect([...query(calls[0] as string).keys()]).toEqual(['path']);
    expect(query(calls[0] as string).get('path')).toBe('pkg/mod001.ts');
  });

  test('重命名条目把 oldPath 一并传上——漏传会退化成一个全新增文件', async () => {
    // 只传新路径时 git 看不到另一侧、无法配对。症状不是报错：页面上是一个内容完整、只是没有
    // rename from/to 的 diff
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

  test('payload 原样落进这个路径的缓存——binary / too-large 不例外', async () => {
    // 四个分支后端都会真的返回（已跟踪那侧走 numstat，未跟踪那侧走 NUL 探测与体积），store 一律原
    // 样透传——判别原因属后端知识
    for (const payload of [
      text,
      { kind: 'untracked-text', patch: '+new\n' },
      { kind: 'binary' },
      { kind: 'too-large', size: 6 * 1024 * 1024, reason: 'size' },
      // 行数那一路的体积不大——两条都过一遍，免得 store 将来「顺手」按体积做判断
      { kind: 'too-large', size: 100 * 1024, reason: 'lines' },
    ] satisfies DiffPayload[]) {
      stubJson(payload);
      await loadDiff(file({ path: 'a.bin', unstaged: 'M' }));
      expect(diffOf('a.bin')).toEqual({ status: 'ready', rename: null, payload });
    }
  });

  test('重命名条目把旧路径与相似度一并带进状态，普通条目是 null', async () => {
    // 标注跟着请求走，而不是渲染时回列表里现找：两份来源错位的窗口是真实存在的——`refresh`
    // 先换上新列表、`loadDiff` 还没回来的那一段里，右侧显示的仍是旧补丁
    stubJson(text);
    await loadDiff(
      file({ path: 'src/new.ts', oldPath: 'src/old.ts', staged: 'R', renameScore: 87 }),
    );
    expect(diffOf('src/new.ts')?.rename).toEqual({ oldPath: 'src/old.ts', score: 87 });

    // git 没给相似度就不编一个：`?? 0` 会让页面说出「相似度 0%」这句 git 没说过的话
    await loadDiff(file({ path: 'src/new.ts', oldPath: 'src/old.ts', staged: 'R' }));
    expect(diffOf('src/new.ts')?.rename).toEqual({ oldPath: 'src/old.ts', score: null });

    await loadDiff(file({ path: 'plain.ts', unstaged: 'M' }));
    expect(diffOf('plain.ts')?.rename).toBeNull();
  });

  test('同一个路径两次请求重叠时后发的赢——先发后到不会盖掉新补丁', async () => {
    const slow: DiffPayload = { kind: 'text', patch: 'stale\n' };
    const fast: DiffPayload = { kind: 'text', patch: 'fresh\n' };
    stubSlowThenFast(slow, fast);

    await Promise.all([
      loadDiff(file({ path: 'a.txt', unstaged: 'M' })),
      loadDiff(file({ path: 'a.txt', unstaged: 'M' })),
    ]);
    expect(diffOf('a.txt')).toEqual({
      status: 'ready',
      rename: null,
      payload: fast,
    });
  });

  test('两个不同路径的请求各落各的槽，互不顶掉', async () => {
    // 票按路径计数：两个 tab 各自的请求互不相干。全局一张票的写法会让先点的那个 tab 永远停在
    // loading 上
    const slow: DiffPayload = { kind: 'text', patch: 'a\n' };
    const fast: DiffPayload = { kind: 'text', patch: 'b\n' };
    stubSlowThenFast(slow, fast);

    await Promise.all([
      loadDiff(file({ path: 'a.txt', unstaged: 'M' })),
      loadDiff(file({ path: 'b.txt', unstaged: 'M' })),
    ]);
    expect(diffOf('a.txt')).toEqual({
      status: 'ready',
      rename: null,
      payload: slow,
    });
    expect(diffOf('b.txt')).toEqual({
      status: 'ready',
      rename: null,
      payload: fast,
    });
  });

  test('一个文件取不到 diff 时不动整页的错误横幅', async () => {
    // loadError 说的是「列表取不到」。一个文件失败就把它点亮，页面看起来整个坏掉了
    stubJson({ error: { code: 'not-found', message: '文件不在了' } }, 400);

    await loadDiff(file({ path: 'gone.txt', unstaged: 'D' }));
    expect(diffOf('gone.txt')).toEqual({
      status: 'error',
      rename: null,
      message: '文件不在了',
    });
    expect(loadError.value).toBeNull();
  });

  test('请求发出前就进 loading 态，且带的是这个文件的 path', async () => {
    stubJson(text);
    const pending = loadDiff(file({ path: 'new.txt', unstaged: 'M' }));
    expect(diffOf('new.txt')).toEqual({ status: 'loading', rename: null });
    await pending;
  });

  test('同一个文件重新取时不回退到 loading——否则每次刷新都把画好的 diff 拆掉重画', async () => {
    // 回退的代价不是闪一下：ready → loading 会让渲染 diff 的子树整个卸载，滚动位置随之丢失。每个
    // SSE change 事件与每次切回这个 tab 都会走这里，而要求刷新不丢滚动位置
    diffStates.value = new Map([['a.txt', { status: 'ready', rename: null, payload: text }]]);
    const fresh: DiffPayload = { kind: 'text', patch: 'updated\n' };
    stubJson(fresh);

    const pending = loadDiff(file({ path: 'a.txt', unstaged: 'M' }));
    // 请求在飞的这段时间里，上一份仍然挂着
    expect(diffOf('a.txt')).toEqual({
      status: 'ready',
      rename: null,
      payload: text,
    });
    await pending;
    expect(diffOf('a.txt')).toEqual({
      status: 'ready',
      rename: null,
      payload: fresh,
    });
  });
});

describe('selectFile / openFile（预览与固定）', () => {
  const text: DiffPayload = { kind: 'text', patch: 'x\n' };

  beforeEach(() => {
    resetEditors();
    loadError.value = null;
  });

  test('selectFile 开一个预览 diff tab、激活它并拉 diff——组件不必知道这是三件事', async () => {
    const calls = stubJson(text);
    selectFile(file({ path: 'src/new.ts', oldPath: 'src/old.ts', staged: 'R' }));

    expect(editors.value).toEqual([{ kind: 'diff', path: 'src/new.ts', pinned: false }]);
    expect(activeDiffPath.value).toBe('src/new.ts');
    // 微任务排空，让上面那个 void 出去的请求落地
    await vi.waitFor(() => expect(diffStates.value.get('src/new.ts')?.status).toBe('ready'));
    expect(query(calls[0] as string).get('oldPath')).toBe('src/old.ts');
  });

  test('同一个文件点几次只有一个 tab；固定之后再点仍是固定', async () => {
    stubJson(text);
    selectFile(file({ path: 'a.ts', unstaged: 'M' }));
    pinEditor('diff:a.ts');
    selectFile(file({ path: 'a.ts', unstaged: 'M' }));
    expect(editors.value).toEqual([{ kind: 'diff', path: 'a.ts', pinned: true }]);
    await vi.waitFor(() => expect(diffStates.value.get('a.ts')?.status).toBe('ready'));
  });

  test('再单击别的文件顶掉预览 tab，被顶掉那份的缓存与在途结果一起作废', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('path=a.ts')) await gate;
        return new Response(JSON.stringify(text), { status: 200 });
      }),
    );
    selectFile(file({ path: 'a.ts', unstaged: 'M' }));
    selectFile(file({ path: 'b.ts', unstaged: 'M' }));
    expect(tabs()).toEqual(['diff:b.ts']);
    expect(diffStates.value.has('a.ts')).toBe(false);

    release();
    await vi.waitFor(() => expect(diffStates.value.get('b.ts')?.status).toBe('ready'));
    // a.ts 那次请求回来了，但它的 tab 早已不在栏里——不许写回缓存
    expect(diffStates.value.has('a.ts')).toBe(false);
  });

  test('openFile 开一个预览 file tab 并取内容；此时变更列表那侧不高亮', async () => {
    const calls = stubJson({ kind: 'text', content: 'hello\n' } satisfies FilePayload);
    openFile('src/app.ts');
    expect(editors.value).toEqual([{ kind: 'file', path: 'src/app.ts', pinned: false }]);
    expect(activeFilePath.value).toBe('src/app.ts');
    expect(activeDiffPath.value).toBeNull();
    await vi.waitFor(() => expect(fileStates.value.get('src/app.ts')?.status).toBe('ready'));
    expect(query(calls[0] as string).get('path')).toBe('src/app.ts');
  });

  test('同一路径从两边点开是两个 tab', async () => {
    stubJson({ kind: 'text', content: '' } satisfies FilePayload);
    selectFile(file({ path: 'a.ts', unstaged: 'M' }));
    pinEditor('diff:a.ts');
    openFile('a.ts');
    expect(tabs()).toEqual(['diff:a.ts', 'file:a.ts']);
  });

  test('取不到时错误落在右侧自己的位置上，不写进那条全局错误条', async () => {
    stubJson({ error: { code: 'not-found', message: 'file no longer exists' } }, 404);

    openFile('gone.ts');
    await vi.waitFor(() => expect(fileStates.value.get('gone.ts')?.status).toBe('error'));
    expect(loadError.value).toBeNull();
  });

  test('同一个文件重新取时不回退 loading——一回退高亮好的 DOM 连同滚动位置一起没了', async () => {
    stubJson({ kind: 'text', content: 'a\n' } satisfies FilePayload);
    openFile('a.ts');
    await vi.waitFor(() => expect(fileStates.value.get('a.ts')?.status).toBe('ready'));

    const seen: string[] = [];
    const stop = effect(() => {
      const state = fileStates.value.get('a.ts');
      if (state !== undefined) seen.push(state.status);
    });
    openFile('a.ts');
    await vi.waitFor(() => expect(fileStates.value.get('a.ts')?.status).toBe('ready'));
    stop();
    expect(seen).not.toContain('loading');
  });
});

describe('activateEditor / closeEditor', () => {
  const text: DiffPayload = { kind: 'text', patch: 'x\n' };
  const stateWith = (files: FileEntry[]): RepoState => ({
    repoName: 'demo',
    branch: { head: 'main', detached: false, upstream: null },
    files,
    watch: { mode: 'native', tier: 'A' },
  });

  beforeEach(() => {
    resetEditors();
    loadError.value = null;
    repoState.value = stateWith([
      file({ path: 'a.ts', unstaged: 'M' }),
      file({ path: 'b.ts', oldPath: 'b0.ts', staged: 'R' }),
    ]);
  });

  test('切到一个后台 diff tab 时重取它，条目从新列表里拿（oldPath 跟着）', async () => {
    openPinned('diff', 'a.ts');
    openPinned('diff', 'b.ts');
    openPinned('diff', 'a.ts');
    diffStates.value = new Map([['b.ts', { status: 'ready', rename: null, payload: text }]]);
    const calls = stubJson({ kind: 'text', patch: 'fresh\n' } satisfies DiffPayload);

    activateEditor('diff:b.ts');
    expect(activeEditorKey.value).toBe('diff:b.ts');
    // 重取期间缓存的那份照常挂着
    expect(diffStates.value.get('b.ts')?.status).toBe('ready');
    await vi.waitFor(() => expect(count(calls, '/api/diff')).toBe(1));
    expect(diffQuery(calls)?.get('oldPath')).toBe('b0.ts');
  });

  test('切到一个后台 file tab 时重取它', async () => {
    openPinned('file', 'a.ts');
    openPinned('diff', 'a.ts');
    const calls = stubJson({ kind: 'text', content: '' } satisfies FilePayload);
    activateEditor('file:a.ts');
    await vi.waitFor(() => expect(count(calls, '/api/file')).toBe(1));
  });

  test('键不在栏里时什么都不做', () => {
    openPinned('diff', 'a.ts');
    const calls = stubJson(text);
    activateEditor('diff:zzz');
    expect(activeEditorKey.value).toBe('diff:a.ts');
    expect(calls).toEqual([]);
  });

  test('关掉活动 tab：删缓存、邻居顶上并重取一次', async () => {
    openPinned('diff', 'a.ts');
    openPinned('diff', 'b.ts');
    openPinned('diff', 'a.ts');
    diffStates.value = new Map([['a.ts', { status: 'ready', rename: null, payload: text }]]);
    const calls = stubJson(text);

    closeEditor('diff:a.ts');
    expect(tabs()).toEqual(['diff:b.ts']);
    expect(activeEditorKey.value).toBe('diff:b.ts');
    expect(diffStates.value.has('a.ts')).toBe(false);
    await vi.waitFor(() => expect(count(calls, '/api/diff')).toBe(1));
    expect(diffQuery(calls)?.get('path')).toBe('b.ts');
  });

  test('关掉非活动 tab 一个请求都不发', () => {
    openPinned('diff', 'a.ts');
    openPinned('diff', 'b.ts');
    const calls = stubJson(text);
    closeEditor('diff:a.ts');
    expect(activeEditorKey.value).toBe('diff:b.ts');
    expect(calls).toEqual([]);
  });

  test('关掉之后，在途的那次请求不许把缓存写回来', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return new Response(JSON.stringify(text), { status: 200 });
      }),
    );
    openPinned('diff', 'a.ts');
    const inFlight = loadDiff(file({ path: 'a.ts', unstaged: 'M' }));
    expect(diffStates.value.get('a.ts')?.status).toBe('loading');
    closeEditor('diff:a.ts');
    expect(diffStates.value.has('a.ts')).toBe(false);

    release();
    await inFlight;
    expect(diffStates.value.has('a.ts')).toBe(false);
  });
});

describe('refresh（一次 SSE change 之后要重取什么）', () => {
  const text: DiffPayload = { kind: 'text', patch: 'old\n' };
  const fresh: DiffPayload = { kind: 'text', patch: 'new\n' };
  const ready = (path: string) => [path, { status: 'ready', rename: null, payload: text }] as const;

  const stateWith = (files: FileEntry[]): RepoState => ({
    repoName: 'demo',
    branch: { head: 'main', detached: false, upstream: null },
    files,
    watch: { mode: 'native', tier: 'A' },
  });

  /**
   * 按路径分派的 fetch 桩：refresh 会连着打两个不同的端点。
   *
   * `gate` 卡住的只有 diff 那一侧——「在途的 diff 还没回来」是这里唯一需要摆布的
   * 时序，而 state 那侧照常立刻回，`refresh` 才走得下去。
   */
  function stubEndpoints(state: RepoState, diff: DiffPayload, gate?: Promise<void>): string[] {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.startsWith('/api/state'))
          return new Response(JSON.stringify(state), { status: 200 });
        if (gate) await gate;
        return new Response(JSON.stringify(diff), { status: 200 });
      }),
    );
    return calls;
  }

  beforeEach(() => {
    resetEditors();
    repoState.value = null;
    loadError.value = null;
  });

  test('栏里没有 tab 时只重取列表', async () => {
    const calls = stubEndpoints(stateWith([file({ path: 'a.txt', unstaged: 'M' })]), fresh);

    await refresh();
    expect(calls).toEqual(['/api/state']);
    expect(diffStates.value.size).toBe(0);
  });

  test('活动的 diff tab 也重取——只刷列表的话右侧会停在旧补丁上', async () => {
    // 文件内容变了而列表条目没变（还是那个 `1 .M`）是最常见的形态，页面看不出异样
    openPinned('diff', 'a.txt');
    diffStates.value = new Map([ready('a.txt')]);
    const calls = stubEndpoints(stateWith([file({ path: 'a.txt', unstaged: 'M' })]), fresh);

    await refresh();
    expect(count(calls, '/api/diff')).toBe(1);
    expect(diffStates.value.get('a.txt')).toEqual({
      status: 'ready',
      rename: null,
      payload: fresh,
    });
  });

  test('只重取活动那一个——后台 tab 不取，切过去时再取', async () => {
    // agent 跑动期间事件密集，挂着 10 个 diff tab 时每个事件就是 10 趟 git diff
    openPinned('diff', 'a.txt');
    openPinned('diff', 'b.txt');
    openPinned('diff', 'c.txt');
    diffStates.value = new Map([ready('a.txt'), ready('b.txt'), ready('c.txt')]);
    const calls = stubEndpoints(
      stateWith([
        file({ path: 'a.txt', unstaged: 'M' }),
        file({ path: 'b.txt', unstaged: 'M' }),
        file({ path: 'c.txt', unstaged: 'M' }),
      ]),
      fresh,
    );

    await refresh();
    expect(count(calls, '/api/diff')).toBe(1);
    expect(diffQuery(calls)?.get('path')).toBe('c.txt');
    expect(tabs()).toEqual(['diff:a.txt', 'diff:b.txt', 'diff:c.txt']);
  });

  test('重取用的是新列表里的条目——oldPath 跟着变，不能拿旧条目去取', async () => {
    // 相似度与配对结果都会随改动变化。用旧条目取等于用过期的 oldPath（双路径）
    openPinned('diff', 'new.ts');
    diffStates.value = new Map([ready('new.ts')]);
    const calls = stubEndpoints(
      stateWith([file({ path: 'new.ts', oldPath: 'renamed-again.ts', staged: 'R' })]),
      fresh,
    );

    await refresh();
    expect(diffQuery(calls)?.get('oldPath')).toBe('renamed-again.ts');
  });

  test('活动 tab 的文件被改名了——跟着重命名走，不当成消失；预览仍是预览', async () => {
    // 改名后那个路径成了新列表里那一行的 `oldPath`，只按 `path` 找必然扑空——
    // 而那一行还在左栏列着，此时关掉 tab，「左栏正断言这些改动不存在」根本不成立
    openEditor('diff', 'old.ts');
    diffStates.value = new Map([ready('old.ts')]);
    const calls = stubEndpoints(
      stateWith([file({ path: 'new.ts', oldPath: 'old.ts', staged: 'R', renameScore: 100 })]),
      fresh,
    );

    await refresh();
    // 双路径都得带上，否则重命名退化成全新增
    expect(diffQuery(calls)?.get('path')).toBe('new.ts');
    expect(diffQuery(calls)?.get('oldPath')).toBe('old.ts');
    expect(editors.value).toEqual([{ kind: 'diff', path: 'new.ts', pinned: false }]);
    expect(activeEditorKey.value).toBe('diff:new.ts');
    // 旧路径上的缓存忘掉，新路径上是取回来的那份
    expect(diffStates.value.has('old.ts')).toBe(false);
    expect(diffStates.value.get('new.ts')).toEqual({
      status: 'ready',
      rename: { oldPath: 'old.ts', score: 100 },
      payload: fresh,
    });
  });

  test('后台 tab 被改名也跟着走，但不重取', async () => {
    openPinned('diff', 'old.ts');
    openPinned('diff', 'keep.ts');
    diffStates.value = new Map([ready('old.ts'), ready('keep.ts')]);
    const calls = stubEndpoints(
      stateWith([
        file({ path: 'new.ts', oldPath: 'old.ts', staged: 'R' }),
        file({ path: 'keep.ts', unstaged: 'M' }),
      ]),
      fresh,
    );

    await refresh();
    expect(tabs()).toEqual(['diff:new.ts', 'diff:keep.ts']);
    expect(count(calls, '/api/diff')).toBe(1);
    expect(diffQuery(calls)?.get('path')).toBe('keep.ts');
    expect(diffStates.value.has('old.ts')).toBe(false);
  });

  test('改名撞上已经开着的 tab 时并入它', async () => {
    openPinned('diff', 'b.ts');
    openEditor('diff', 'a.ts');
    stubEndpoints(stateWith([file({ path: 'b.ts', oldPath: 'a.ts', staged: 'R' })]), fresh);

    await refresh();
    expect(tabs()).toEqual(['diff:b.ts']);
    expect(activeEditorKey.value).toBe('diff:b.ts');
  });

  test('活动 tab 的文件从列表里消失了——关掉它、不去取，邻居顶上并只取一次', async () => {
    // 改动被撤销或被 commit 掉了。留着最后那份 diff 时，左栏正断言这些改动不存在、右栏还展示着其
    // 中一份；也不能合成一个不带 oldPath 的条目去重取——那正好是「重命名退化成全新增」那条路
    openPinned('diff', 'gone.txt');
    openPinned('diff', 'other.txt');
    openPinned('diff', 'gone.txt');
    diffStates.value = new Map([ready('gone.txt'), ready('other.txt')]);
    const calls = stubEndpoints(stateWith([file({ path: 'other.txt', unstaged: 'M' })]), fresh);

    await refresh();
    expect(tabs()).toEqual(['diff:other.txt']);
    expect(activeEditorKey.value).toBe('diff:other.txt');
    expect(diffStates.value.has('gone.txt')).toBe(false);
    expect(count(calls, '/api/diff')).toBe(1);
    expect(diffQuery(calls)?.get('path')).toBe('other.txt');
  });

  test('最后一个 tab 消失后栏空了，一个 diff 都不取', async () => {
    openPinned('diff', 'gone.txt');
    diffStates.value = new Map([ready('gone.txt')]);
    const calls = stubEndpoints(stateWith([file({ path: 'other.txt', unstaged: 'M' })]), fresh);

    await refresh();
    expect(calls).toEqual(['/api/state']);
    expect(editors.value).toEqual([]);
    expect(activeEditorKey.value).toBeNull();
  });

  test('后台 tab 的文件消失了也要关掉——只看活动 tab 时它会一直挂着一份不再刷新的补丁', async () => {
    openPinned('diff', 'gone.txt');
    openPinned('diff', 'a.txt');
    diffStates.value = new Map([ready('gone.txt'), ready('a.txt')]);
    const calls = stubEndpoints(stateWith([file({ path: 'a.txt', unstaged: 'M' })]), fresh);

    await refresh();
    expect(tabs()).toEqual(['diff:a.txt']);
    expect(diffStates.value.has('gone.txt')).toBe(false);
    expect(count(calls, '/api/diff')).toBe(1);
  });

  test('file tab 不在变更列表里也留着——目录树列的是整棵仓库', async () => {
    openPinned('file', 'untouched.ts');
    fileStates.value = new Map([
      ['untouched.ts', { status: 'ready', payload: { kind: 'binary' } }],
    ]);
    stubEndpoints(stateWith([]), fresh);

    await refresh();
    expect(tabs()).toEqual(['file:untouched.ts']);
  });

  test('关掉之后，在途的那次取 diff 不许把缓存写回来', async () => {
    /**
     * 点开 X 之后、响应回来之前 X 从列表里没了。不作废那次在途请求的话，它回来
     * 照旧写进缓存——**不报错**，而复现要正好卡在一次请求的往返窗口里，肉眼几乎撞不上。
     */
    let releaseDiff!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseDiff = resolve;
    });
    stubEndpoints(stateWith([file({ path: 'other.txt', unstaged: 'M' })]), fresh, pending);

    openPinned('diff', 'gone.txt');
    const inFlight = loadDiff(file({ path: 'gone.txt', unstaged: 'M' }));
    expect(diffStates.value.get('gone.txt')?.status).toBe('loading');
    await refresh();
    expect(diffStates.value.has('gone.txt')).toBe(false);

    releaseDiff();
    await inFlight;
    expect(diffStates.value.has('gone.txt')).toBe(false);
  });

  test('列表取不到时不动 tab 也不取 diff——手上那份列表已经是过期的了', async () => {
    /**
     * **`repoState` 必须先有一份旧快照**，否则这条用例是假绿的：`loadState()` 失败
     * 时它保持原值，只有原值非 null 才走得到「照着旧列表找条目」那一步——而生产里
     * 它一直是非 null（第一帧就取过了）。旧列表的 oldPath 是过期的，拿它取 diff 正是
     * 重命名退化成全新增那条路。
     */
    repoState.value = stateWith([file({ path: 'a.txt', oldPath: 'stale.txt', staged: 'R' })]);
    openPinned('diff', 'a.txt');
    diffStates.value = new Map([ready('a.txt')]);
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
    expect(loadError.value).toBe('Request failed (HTTP 500).');
    expect(tabs()).toEqual(['diff:a.txt']);
    expect(diffStates.value.get('a.txt')).toEqual({
      status: 'ready',
      rename: null,
      payload: text,
    });
  });
});

/** 一份最小的 `/api/state` 正文，给下面那个 describe 里那些不关心列表内容的用例用。 */
const emptyState: RepoState = {
  repoName: 'demo',
  branch: { head: 'main', detached: false, upstream: null },
  files: [],
  watch: { mode: 'native', tier: 'A' },
};

describe('refresh 对树与文件视图那一半', () => {
  const treeCalls = (calls: readonly string[]) =>
    calls.filter((url) => url.startsWith('/api/tree')).map((url) => query(url).get('path'));

  beforeEach(() => {
    resetEditors();
    treeCache.value = new Map();
    expandedDirs.value = new Set();
    repoState.value = null;
    loadError.value = null;
    activeTab.value = 'changes';
  });

  test('不看 Files 那一档时一次 `/api/tree` 都不发——看不见的面板不付钱', async () => {
    treeCache.value = new Map([[ROOT, []]]);
    const calls = stubJson(emptyState);
    await refresh();
    // 少了这条收窄，瞄过一眼 Files 之后每个 change 都要白跑「1 + 展开层数」个请求、
    // 每个再起三个 ls-files 子进程——而那一档此刻根本不在屏幕上
    expect(treeCalls(calls)).toEqual([]);
  });

  test('看着 Files 时才重取，且只取「根 + 展开着的、且真的取过的」那几层', async () => {
    activeTab.value = 'files';
    treeCache.value = new Map([
      [ROOT, []],
      ['src', []],
      ['docs', []],
    ]);
    // docs 取过但此刻收起着——用户看不见，重取它只是白发一个请求
    expandedDirs.value = new Set(['src']);
    const calls = stubJson(emptyState);

    await refresh();
    expect(treeCalls(calls).sort()).toEqual(['', 'src']);
  });

  test('重叠的刷新不被丢弃，且后发的那份说了算', async () => {
    // 「已经在取就直接不取」的写法会把一次 change 引出的刷新整个丢掉；若它正是 agent 那一串
    // 写入的最后一个事件，这一层就一直停在旧内容上，直到用户手动收起再展开
    stubSlowThenFast(
      { path: ROOT, entries: [{ name: 'old.ts', path: 'old.ts', kind: 'file', ignored: false }] },
      { path: ROOT, entries: [{ name: 'new.ts', path: 'new.ts', kind: 'file', ignored: false }] },
    );
    const slow = loadDir(ROOT, true);
    const fast = loadDir(ROOT, true);
    await Promise.all([slow, fast]);
    expect(treeCache.value.get(ROOT)?.map((item) => item.name)).toEqual(['new.ts']);
  });

  test('活动的是 diff tab 时不重取后台那份全文——最多 5MB 的往返，而它此刻不在屏幕上', async () => {
    openPinned('file', 'a.ts');
    openPinned('diff', 'b.ts');
    fileStates.value = new Map([
      ['a.ts', { status: 'ready', payload: { kind: 'text', content: 'old' } }],
    ]);
    // b.ts 得还在列表里，否则那个 diff tab 会被收编关掉、file tab 顶上——那是另一条用例
    const calls = stubJson({ ...emptyState, files: [file({ path: 'b.ts', unstaged: 'M' })] });

    await refresh();
    expect(calls.some((url) => url.startsWith('/api/file'))).toBe(false);
  });

  test('活动的就是那份全文时才重取——内容变了而树没变是最常见的形态', async () => {
    openPinned('file', 'a.ts');
    fileStates.value = new Map([
      ['a.ts', { status: 'ready', payload: { kind: 'text', content: 'old' } }],
    ]);
    const calls = stubJson(emptyState);

    await refresh();
    await vi.waitFor(() => expect(count(calls, '/api/file')).toBe(1));
  });

  test('活动的 diff tab 被关掉、顶上来的是 file tab 时补取那份全文，且只取一次', async () => {
    openPinned('file', 'a.ts');
    openPinned('diff', 'gone.ts');
    const calls = stubJson(emptyState);

    await refresh();
    expect(activeEditorKey.value).toBe('file:a.ts');
    await vi.waitFor(() => expect(count(calls, '/api/file')).toBe(1));
  });
});
