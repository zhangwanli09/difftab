// 对**真实 git 输出**跑封装层(spec §5.2 / §5.3)。
//
// 与 status.test.ts 的分工:那边钉解析器对给定字节的行为,这边钉「git 真的会吐出
// 那些字节」。少了这一半,把 `-z` 或 `core.quotePath=false` 删掉,单测照样全绿。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DiffRequestError, readDiff } from '../../../src/server/git/diff.ts';
import { locateRepo, type RepoInfo, resolveDiffBase } from '../../../src/server/git/repo.ts';
import { GitError, runGit } from '../../../src/server/git/run.ts';
import { readStatus } from '../../../src/server/git/status.ts';
import {
  type DiffPayload,
  type FileEntry,
  hasStagedChange,
  hasUnstagedChange,
  isConflicted,
} from '../../../src/server/shared/protocol.ts';
import {
  type FixtureRepos,
  makeFixtures,
  OUTSIDE_SECRET,
  TRICKY_PATHS,
} from '../../fixtures/make.mjs';

/**
 * 断言这是一份带补丁的 payload,并把补丁正文取出来。
 *
 * `(payload as { patch: string }).patch` 是**转型不是收窄**:S4a 之后 binary /
 * too-large 两个分支都真的会回来,那个写法会安静地给出 undefined,后面的 `toContain`
 * 断言随之报一句与真正原因无关的话。这里先按判别式收窄,再取字段。
 */
function patchOf(payload: DiffPayload): string {
  if (payload.kind !== 'text' && payload.kind !== 'untracked-text') {
    throw new Error(`期望的是带补丁的 payload,拿到的是 ${payload.kind}`);
  }
  return payload.patch;
}

/**
 * fixture 目录 → 一份状态。
 *
 * `readStatus` 收的是整个 `RepoInfo` 而不是一个路径:进行中的多步操作只能从
 * **git 目录**读(§5.3),而它与工作区根在 linked worktree / submodule 下差得很远。
 * 于是每条用例走的都是「定位 → 读状态」这条完整的链,与产品里的顺序一致。
 *
 * 定位结果按目录记一次:`locateRepo` 每次要起两个 git 进程,而 fixture 建好之后就
 * 不动了 —— 十几个调用点各定位一遍等于白付三十来次进程启动。**产品里也正是定位一次
 * 之后一直用**(`start()` → `startServer(repo)`),所以这不是为了测试省事而偏离真实
 * 用法。直接断言 `locateRepo` 本身的那几条不走这里,它们要的就是新鲜的一次调用。
 */
const located = new Map<string, Promise<RepoInfo>>();
const statusOf = (dir: string) => {
  const info = located.get(dir) ?? locateRepo(dir);
  located.set(dir, info);
  return info.then(readStatus);
};

let dest: string;
let repos: FixtureRepos;

beforeAll(() => {
  dest = mkdtempSync(join(tmpdir(), 'difftab-fixtures-'));
  repos = makeFixtures(dest);
}, 60_000);

afterAll(() => {
  rmSync(dest, { recursive: true, force: true });
});

describe('路径转义(§6:不出现 \\351\\234\\200 这类残留)', () => {
  test('列表里的非 ASCII / 空格 / 引号路径原样出现', async () => {
    const { files } = await statusOf(repos.unicodePaths);
    const paths = files.map((f) => f.path);
    for (const tricky of TRICKY_PATHS) expect(paths).toContain(tricky);
    // C 风格转义的残留长这样:"docs/\351\234\200..."
    for (const path of paths) {
      expect(path).not.toMatch(/\\[0-7]{3}/);
      expect(path.startsWith('"')).toBe(false);
    }
  });

  test('补丁正文的头部行同样原样 —— `-z` 管不到这里,靠 core.quotePath=false', async () => {
    const tricky = TRICKY_PATHS[0] as string;
    const payload = await readDiff(repos.unicodePaths, { path: tricky });
    // 已跟踪文件走的是 git 自己的补丁,不是未跟踪那条手工构造的路
    expect(payload.kind).toBe('text');
    const patch = patchOf(payload);
    expect(patch).toContain(`diff --git a/${tricky} b/${tricky}`);
    expect(patch).not.toMatch(/\\[0-7]{3}/);
  });

  test('未跟踪的非 ASCII 路径也能取到 diff', async () => {
    const payload = await readDiff(repos.unicodePaths, { path: 'docs/未跟踪 文件.md' });
    expect(payload.kind).toBe('untracked-text');
    expect(payload).toHaveProperty('patch', expect.stringContaining('+brand new'));
  });
});

describe('路径是字面量而不是通配模式(§5.2 的 GIT_LITERAL_PATHSPECS)', () => {
  // Windows 上文件名不许带 `*`,fixture 因此只在 POSIX 上放这两个样本
  const posixOnly = process.platform === 'win32' ? test.skip : test;

  posixOnly('名字里带 `*` 的文件只回它自己的补丁,不捎带邻居', async () => {
    // `--` 后面的路径默认按 wildmatch 解释(已实测),于是 `docs/star*.md` 会连
    // `docs/starlight.md` 一起匹配。症状不是报错:页面在 A 的标题下多出 B 的补丁
    const payload = await readDiff(repos.unicodePaths, { path: 'docs/star*.md' });
    const patch = patchOf(payload);
    expect(patch).toContain('docs/star*.md');
    expect(patch).not.toContain('MATCHED-BY-WILDCARD-NOT-BY-NAME');
    expect(patch.match(/^diff --git /gm)).toHaveLength(1);
  });

  posixOnly('纯模式取不到任何东西 —— `*` 不该变成一份整仓 diff', async () => {
    // 路径来自 URL query,是外部输入。`path=*` 在通配语义下会让 `git diff -- '*'`
    // 回一份整仓 diff,直接撞上「禁止一次性获取全仓 diff」那条(§5.2):
    // 300+ 文件的补丁一次性发给浏览器,主线程冻上数秒到数十秒
    await expect(readDiff(repos.unicodePaths, { path: '*' })).rejects.toThrow(DiffRequestError);
    await expect(readDiff(repos.unicodePaths, { path: 'docs/*' })).rejects.toThrow(
      DiffRequestError,
    );
  });
});

describe('未跟踪(§6:展开到文件粒度,不折叠成 `dir/`)', () => {
  test('整个目录未跟踪时,列表里是里面的每个文件', async () => {
    // 这条钉的是 `-uall`。少了它,git 只报一行 `? 未跟踪目录/`,列表里就是一个
    // 点不开的目录条目 —— 而 agent 新建一整个目录是最常见的形态之一
    const { files } = await statusOf(repos.unicodePaths);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('未跟踪目录/a.md');
    expect(paths).toContain('未跟踪目录/sub/b.md');
    expect(paths.filter((p) => p.endsWith('/'))).toEqual([]);
  });

  test('这些文件点得开 —— 未跟踪那条路读磁盘构造补丁', async () => {
    const payload = await readDiff(repos.unicodePaths, { path: '未跟踪目录/sub/b.md' });
    expect(payload.kind).toBe('untracked-text');
    expect(payload).toHaveProperty('patch', expect.stringContaining('+nested two'));
  });
});

describe('重命名', () => {
  test('status 给出新旧两个路径与相似度', async () => {
    const { files } = await statusOf(repos.renames);
    const renamed = files.find((f) => f.path === 'src/kept-renamed.txt');
    expect(renamed?.oldPath).toBe('src/kept.txt');
    expect(renamed?.renameScore).toBe(100);
  });

  test('传两个路径才拿得到 rename from/to;只传新路径会退化成全新增', async () => {
    const both = await readDiff(repos.renames, {
      path: 'src/kept-renamed.txt',
      oldPath: 'src/kept.txt',
    });
    expect(both).toHaveProperty('patch', expect.stringContaining('rename from src/kept.txt'));
    expect(both).toHaveProperty('patch', expect.stringContaining('similarity index'));

    // 这条是**反面证据**:红线说的「重命名必须传新旧两个路径」不是风格偏好。
    // 少传一个,git 看不到另一侧、无法配对,输出的是 new file mode
    const onlyNew = await readDiff(repos.renames, { path: 'src/kept-renamed.txt' });
    expect(onlyNew).toHaveProperty('patch', expect.stringContaining('new file mode'));
    expect(onlyNew).toHaveProperty('patch', expect.not.stringContaining('rename from'));
  });

  test('status 说是重命名、diff 配不上对时,行数按两条记录**合计**算', async () => {
    // `git mv` 之后把内容全部重写、留在工作区不 add:index 里仍是纯改名,status 照报
    // `R100`(§10),所以条目带着 oldPath;而 `diff -M` 比的是 HEAD → 工作区,配不上,
    // 于是 numstat 拆成「删旧 20 行」+「增新 60,000 行」两条,**按路径排序**。
    //
    // 取 `[0]` 的写法在这里拿到的是那条 20 行的删除 —— 行数闸放行,一份 6 万行的
    // 补丁照旧发给浏览器,而这正是本阶段存在的理由。判据只能压在合计上
    const { files } = await statusOf(repos.renames);
    const entry = files.find((f) => f.path === 'src/unpaired-z.txt');
    expect(entry?.oldPath).toBe('src/unpaired-a.txt');

    const payload = await readDiff(repos.renames, {
      path: 'src/unpaired-z.txt',
      oldPath: 'src/unpaired-a.txt',
    });
    expect(payload).toMatchObject({ kind: 'too-large', reason: 'lines' });
  });

  test('相似度阈值之下的改名被 git 拆成删除 + 新增,不带 oldPath', async () => {
    const { files } = await statusOf(repos.renames);
    const added = files.find((f) => f.path === 'src/rewritten-renamed.txt');
    const deleted = files.find((f) => f.path === 'src/rewritten.txt');
    expect(added?.staged).toBe('A');
    expect(added?.oldPath).toBeUndefined();
    expect(deleted?.staged).toBe('D');
  });
});

describe('已暂存改动', () => {
  test('双状态位与 git status 一致', async () => {
    const { files } = await statusOf(repos.staged);
    const byPath = Object.fromEntries(files.map((f) => [f.path, [f.staged, f.unstaged]]));
    expect(byPath).toEqual({
      'a.txt': ['M', '.'],
      'b.txt': ['.', 'M'],
      'c.txt': ['M', 'M'],
      'd.txt': ['A', '.'],
    });
  });

  test('基准是 `git diff HEAD`:已 add 的改动仍在 diff 里,不遗漏', async () => {
    const payload = await readDiff(repos.staged, { path: 'a.txt' });
    expect(payload).toHaveProperty('patch', expect.stringContaining('+a1 staged'));
  });
});

describe('删除与符号链接 —— 决定「已跟踪 / 未跟踪」的分流判据(§7 末段)', () => {
  test('两种删除都进变更列表,状态位一暂存一未暂存', async () => {
    const { files } = await statusOf(repos.deletions);
    const byPath = Object.fromEntries(files.map((f) => [f.path, [f.staged, f.unstaged]]));
    expect(byPath['staged-deleted.txt']).toEqual(['D', '.']);
    expect(byPath['worktree-deleted.txt']).toEqual(['.', 'D']);
  });

  test('已暂存的删除给出删除补丁 —— 它已不在 index 里,但仍是已跟踪文件', async () => {
    // 回归点:分流判据曾经只查 `git ls-files`,而 `git rm` 之后它对这条路径输出为空,
    // 于是文件被误判成未跟踪、进而去读磁盘,以「文件不存在」告终 —— 而它明明在
    // 上一条断言的变更列表里点得到
    const payload = await readDiff(repos.deletions, { path: 'staged-deleted.txt' });
    expect(payload.kind).toBe('text');
    expect(payload).toHaveProperty('patch', expect.stringContaining('deleted file mode'));
    expect(payload).toHaveProperty('patch', expect.stringContaining('-gone from the index'));
  });

  test('未暂存的删除同样给出删除补丁(index 里还在,走的是另一半判据)', async () => {
    const payload = await readDiff(repos.deletions, { path: 'worktree-deleted.txt' });
    expect(payload.kind).toBe('text');
    expect(payload).toHaveProperty('patch', expect.stringContaining('deleted file mode'));
  });

  test.skipIf(process.platform === 'win32')(
    '未跟踪的符号链接按 mode 120000 + 链接目标展示,绝不吐出目标文件的内容',
    async () => {
      const { files } = await statusOf(repos.deletions);
      // 前提:git 确实把它报成未跟踪,所以它进列表、用户点得到
      expect(files.find((f) => f.path === 'link-to-outside')?.unstaged).toBe('?');

      const payload = await readDiff(repos.deletions, { path: 'link-to-outside' });
      const patch = patchOf(payload);
      // 这条是安全断言:读磁盘那条路一旦用回跟随链接的 stat,
      // 仓库外那个文件的内容就会原样出现在补丁里
      expect(patch).not.toContain(OUTSIDE_SECRET);
      expect(patch).toContain('new file mode 120000');
      expect(patch).toContain('outside-secret.txt');
    },
  );
});

describe('分支状态', () => {
  test('无上游 → upstream 为 null', async () => {
    const { branch } = await statusOf(repos.noUpstream);
    expect(branch.head).toBe('feature/no-upstream');
    expect(branch.detached).toBe(false);
    expect(branch.upstream).toBe(null);
  });

  test('有上游 → ahead / behind 与 git 一致', async () => {
    const { branch } = await statusOf(repos.upstreamTracking);
    expect(branch.upstream).toEqual({ ahead: 2, behind: 1 });
  });
});

describe('空仓库(§5.3)', () => {
  test('列表与分支状态正常,不崩溃', async () => {
    const { branch, files } = await statusOf(repos.empty);
    expect(branch.head).toBe('main');
    expect(branch.upstream).toBe(null);
    expect(files.map((f) => f.path).sort()).toEqual([
      'staged-before-first-commit.txt',
      'untracked.txt',
    ]);
  });

  test('diff 基准降级为空树哈希,而不是 fatal 在 HEAD 上', async () => {
    expect(await resolveDiffBase(repos.empty)).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    // 有提交的仓库照旧用 HEAD
    expect(await resolveDiffBase(repos.staged)).toBe('HEAD');
  });

  test('SHA-256 仓库取的是另一个常量,而且它真的当得了基准', async () => {
    // 两个常量都只能实测取(§5.3)。**光比对常量不够**:写错一位时这条照样绿,
    // 而症状是空仓库下 diff 全部 fatal —— 所以下面那半必须真的拿它取一次补丁
    const base = await resolveDiffBase(repos.sha256Empty);
    expect(base).toBe('6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321');

    const payload = await readDiff(repos.sha256Empty, { path: 'staged-before-first-commit.txt' });
    expect(payload.kind).toBe('text');
    expect(payload).toHaveProperty('patch', expect.stringContaining('+no commits yet'));
  });

  test('空仓库里已 add 的文件能取到 diff', async () => {
    const payload = await readDiff(repos.empty, { path: 'staged-before-first-commit.txt' });
    expect(payload.kind).toBe('text');
    expect(payload).toHaveProperty('patch', expect.stringContaining('+no commits yet'));
  });
});

describe('仓库定位', () => {
  test('子目录下启动也能定位到工作区根', async () => {
    const fromSubdir = await locateRepo(join(repos.renames, 'src'));
    const fromRoot = await locateRepo(repos.renames);
    expect(fromSubdir.root).toBe(fromRoot.root);
    // gitDir 一律绝对路径 —— 仓库根下 `--git-dir` 返回的是相对的 `.git`
    expect(fromRoot.gitDir).toContain('.git');
    expect(fromRoot.gitDir).not.toBe('.git');
  });

  test('不是仓库的目录给出 PreflightError 而不是 Node 异常栈', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'difftab-not-a-repo-'));
    try {
      await expect(locateRepo(outside)).rejects.toMatchObject({ code: 'not-a-repo' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('diff 边界(§6:二进制只提示、超大不预览、新文件展示为全新增)', () => {
  test('已跟踪的二进制变更只回 binary —— 判定来自 git 自己而不是我们探 NUL', async () => {
    // 与未跟踪那条路的分工:已跟踪一律以 `--numstat` 的 `-\t-` 为准(git 自身含
    // .gitattributes 的判定),NUL 探测只用于未跟踪(§5.2)
    const payload = await readDiff(repos.diffEdges, { path: 'assets/icon.bin' });
    expect(payload).toEqual({ kind: 'binary' });
  });

  test('未跟踪的二进制走 NUL 探测,同样只回 binary', async () => {
    const payload = await readDiff(repos.diffEdges, { path: 'untracked.bin' });
    expect(payload).toEqual({ kind: 'binary' });
  });

  test('补丁超过 5MB 时按体积拒绝,补丁一个字节都不发出去', async () => {
    // huge.txt 是「一行 6MB」:numstat 只报 1/1 行,行数阈值对它毫无作用;
    // 而它的补丁有 12MB 上下 —— 拦住它的只能是取补丁那次调用自己带的字节上限
    const payload = await readDiff(repos.diffEdges, { path: 'huge.txt' });
    expect(payload).toMatchObject({ kind: 'too-large', reason: 'size' });
    if (payload.kind === 'too-large') expect(payload.size).toBeGreaterThan(5 * 1024 * 1024);
  });

  test('超限时以 overflow 收尾,而不是 kill 自己引发的那个错误', async () => {
    // `too-large` 那条分支全靠 `kind === 'overflow'` 认路,而掐断 git 之后到达的
    // 错误会把它盖成 `exit`(实测 CI run 31755485278 的 windows × Node 22.0.x 档)。
    //
    // **这条在 POSIX 上不论有没有那道 guard 都是绿的** —— 那里 `'error'` 根本不触发。
    // 留着它有两个理由:CI 的三个 Windows 档会真的执行到;以及它把判据压在**封装层**
    // 而不是 6MB 那条端到端用例上,坏掉时给的是「kind 不对」而不是「接口回了 500」
    const failure = await runGit(['diff', 'HEAD', '--', 'bulky.txt'], repos.diffEdges, {
      maxStdoutBytes: 1024,
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(GitError);
    expect((failure as GitError).kind).toBe('overflow');
  });

  test('6MB 的文件只改一行照样看得见 —— 卡的是补丁不是文件', async () => {
    // 这条与上一条是同一道闸的两面:按「文件多大」拒绝的写法在这里会把一份几 KB 的
    // 补丁挡掉,而 agent 改一行数据文件是常事(S4a 的代码评审提出)
    const payload = await readDiff(repos.diffEdges, { path: 'bulky.txt' });
    expect(payload.kind).toBe('text');
    const patch = patchOf(payload);
    expect(patch).toContain('+3000: after');
    expect(patch).toContain('-3000: before');
    // 补丁本身必须是小的,否则这条只是「碰巧没超」
    expect(patch.length).toBeLessThan(64 * 1024);
  });

  test('已跟踪的超多行文件按行数拒绝 —— 它的体积远不到 5MB', async () => {
    // wide.txt 约 700KB:体积那道闸放它过去,只有行数拦得住。两个 reason 因此
    // 必须都能被单独触发,否则前端拿到的 size 解释不了拒绝的原因(§5.12)
    const payload = await readDiff(repos.diffEdges, { path: 'wide.txt' });
    expect(payload).toMatchObject({ kind: 'too-large', reason: 'lines' });
    if (payload.kind === 'too-large') expect(payload.size).toBeLessThan(5 * 1024 * 1024);
  });

  test('未跟踪的超大文件同样按体积拒绝,而不是读进内存', async () => {
    const payload = await readDiff(repos.diffEdges, { path: 'untracked-huge.txt' });
    expect(payload).toMatchObject({ kind: 'too-large', reason: 'size' });
  });

  test('已暂存的新文件是一份完整的新增补丁(走 git diff,不是手工构造)', async () => {
    const payload = await readDiff(repos.diffEdges, { path: 'added-staged.txt' });
    expect(payload.kind).toBe('text');
    const patch = patchOf(payload);
    expect(patch).toContain('new file mode');
    expect(patch).toContain('+brand new line one');
    expect(patch).toContain('+brand new line two');
  });

  test('二进制与超大都不该在列表里消失 —— 点不开与看不见是两回事', async () => {
    const { files } = await statusOf(repos.diffEdges);
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'assets/icon.bin',
        'huge.txt',
        'wide.txt',
        'untracked.bin',
        'untracked-huge.txt',
        'added-staged.txt',
      ]),
    );
  });
});

describe('300+ 文件变更(§6:列表列全,单个文件的 diff 及时)', () => {
  test('列表一次列全', async () => {
    const { files } = await statusOf(repos.manyFiles);
    expect(files.length).toBeGreaterThanOrEqual(300);
  });

  test('取一个文件的 diff 就只回这一个文件 —— 懒加载的判据在补丁内容上', async () => {
    // 「按文件懒加载」在前端是「一次点击一个请求」,在这里是「一个请求一个文件」。
    // 少了这条,一个漏了 pathspec 的 `git diff` 会把 320 个文件的补丁一次性回给
    // 浏览器:功能看起来完全正常,只是主线程冻上几秒(§5.2 / §6)
    const payload = await readDiff(repos.manyFiles, { path: 'pkg/mod001.ts' });
    expect(payload.kind).toBe('text');
    const patch = patchOf(payload);
    expect(patch.match(/^diff --git /gm)).toHaveLength(1);
    expect(patch).toContain('pkg/mod001.ts');
  });
});

describe('git 异常状态(§5.3 / §6 的两条 `[S4b]`)', () => {
  test('detached HEAD:标成 detached,而分支名那一栏是 git 的字面量', async () => {
    const { branch, files } = await statusOf(repos.detachedHead);
    // git 在 `# branch.head` 里给的就是这个字面量(已实测)。**解析器不替它编一个
    // 名字出来**(§5.12 的 `BranchState.head`):那是在事实来源这一层说假话,
    // 「取不到分支名时画什么」是展示决定,归前端
    expect(branch.detached).toBe(true);
    expect(branch.head).toBe('(detached)');
    expect(branch.upstream).toBe(null);
    // 另一半:除了分支那一栏,别的照常 —— 验收项要的是「不崩溃 + 降级标注」,
    // 而一个空列表同样满足「不崩溃」
    expect(files.map((f) => f.path).sort()).toEqual(['a.txt', 'untracked-while-detached.txt']);
  });

  test('没有进行中的操作时,`operation` 这个字段压根不出现', async () => {
    // 反面证据。少了它,一个恒返回 `'merge'` 的实现会让下面几条全绿 ——
    // 而页面上是每个仓库都挂着「合并中」
    const { branch } = await statusOf(repos.staged);
    expect('operation' in branch).toBe(false);
  });

  test('merge 冲突:标成 merge,冲突条目自成一类而不是同时进两组', async () => {
    const { branch, files } = await statusOf(repos.mergeConflict);
    expect(branch.operation).toBe('merge');

    const entry = files.find((f) => f.path === 'conflict.txt') as FileEntry;
    expect(entry?.conflicted).toBe(true);
    expect(entry.staged).toBe('U');
    expect(entry.unstaged).toBe('U');
    // 判据压在**谓词**上而不是状态位上:XY 两位都不是 `.`,按字面读的实现会让
    // 这个文件同时出现在「已暂存」与「未暂存」里,而它哪一组都不属于(§5.3)
    expect(hasStagedChange(entry)).toBe(false);
    expect(hasUnstagedChange(entry)).toBe(false);
    expect(isConflicted(entry)).toBe(true);
    // 没冲突的那个文件不受牵连:merge 停下时它已经干干净净地在 index 里
    expect(files.some((f) => f.path === 'kept.txt')).toBe(false);
  });

  test('冲突文件照常出补丁,正文里就是冲突标记 —— 不需要特殊分支', async () => {
    const payload = await readDiff(repos.mergeConflict, { path: 'conflict.txt' });
    expect(payload.kind).toBe('text');
    const patch = patchOf(payload);
    expect(patch).toContain('<<<<<<<');
    expect(patch).toContain('>>>>>>>');
  });

  test('rebase 进行中:标成 rebase 而不是 merge,且此时同时是 detached', async () => {
    // 这条钉的是判据表的**顺序**:rebase 停下时 git 目录里同时躺着 `rebase-merge/`
    // 与 `MERGE_MSG` / `AUTO_MERGE`(已实测,§10),先判 merge 的写法在这里会把
    // 用户正在做的事说错 —— 而它不报错,只是标了个错的词
    const { branch, files } = await statusOf(repos.rebaseInProgress);
    expect(branch.operation).toBe('rebase');
    // 两件事同时成立,不是二选一:rebase 期间 status 报的就是 `(detached)`
    expect(branch.detached).toBe(true);
    expect(files.find((f) => f.path === 'conflict.txt')?.conflicted).toBe(true);
  });

  test('linked worktree:gitDir 落在主仓库的 worktrees/ 下,列表照常', async () => {
    const repo = await locateRepo(repos.linkedWorktree);
    // 判据是**末段**而不是与 fixture 路径逐字相等:macOS 的 `/var` 是指向
    // `/private/var` 的符号链接,而 git 回的是解析后的那一份(注册表那条红线说的
    // 「同一目录字面量未必相同」正是这件事)
    expect(repo.root.endsWith('worktree-linked')).toBe(true);
    // `.git` 在这里是**文件**不是目录,所以 gitDir 不可能是 `<root>/.git`(§5.2)
    expect(repo.gitDir).toContain(join('.git', 'worktrees'));
    expect(repo.gitDir.startsWith(repo.root)).toBe(false);

    const { branch, files } = await readStatus(repo);
    expect(branch.head).toBe('wt');
    expect('operation' in branch).toBe(false);
    expect(files.map((f) => f.path).sort()).toEqual(['only-here.txt', 'shared.txt']);
  });

  test('submodule:gitDir 落在父仓库的 modules/ 下,列表照常', async () => {
    const repo = await locateRepo(repos.submodule);
    expect(repo.gitDir).toContain(join('.git', 'modules'));
    expect(repo.gitDir.startsWith(repo.root)).toBe(false);

    const { files } = await readStatus(repo);
    expect(files.map((f) => f.path).sort()).toEqual(['child.txt', 'untracked-in-submodule.txt']);
    const payload = await readDiff(repo.root, { path: 'child.txt' });
    expect(payload).toHaveProperty(
      'patch',
      expect.stringContaining('+changed inside the submodule'),
    );
  });

  test('bare 仓库给的是「没有工作区」这句话,不是「不是仓库」', async () => {
    // 两者的提示完全不同,合并成一句会把用户指向错误的方向 —— 而 `--show-toplevel`
    // 在 bare 下就是以 128 退出(已实测),分不开的实现看起来一样「不崩溃」
    await expect(locateRepo(repos.bare)).rejects.toMatchObject({ code: 'bare-repo' });
  });
});
