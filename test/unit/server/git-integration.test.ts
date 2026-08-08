// 对**真实 git 输出**跑封装层(spec §5.2 / §5.3)。
//
// 与 status.test.ts 的分工:那边钉解析器对给定字节的行为,这边钉「git 真的会吐出
// 那些字节」。少了这一半,把 `-z` 或 `core.quotePath=false` 删掉,单测照样全绿。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readDiff } from '../../../src/server/git/diff.ts';
import { locateRepo, resolveDiffBase } from '../../../src/server/git/repo.ts';
import { readStatus } from '../../../src/server/git/status.ts';
import {
  type FixtureRepos,
  makeFixtures,
  OUTSIDE_SECRET,
  TRICKY_PATHS,
} from '../../fixtures/make.mjs';

let dest: string;
let repos: FixtureRepos;

beforeAll(() => {
  dest = mkdtempSync(join(tmpdir(), 'gitglance-fixtures-'));
  repos = makeFixtures(dest);
}, 60_000);

afterAll(() => {
  rmSync(dest, { recursive: true, force: true });
});

describe('路径转义(§6:不出现 \\351\\234\\200 这类残留)', () => {
  test('列表里的非 ASCII / 空格 / 引号路径原样出现', async () => {
    const { files } = await readStatus(repos.unicodePaths);
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
    expect(payload.kind).toBe('text');
    const patch = (payload as { patch: string }).patch;
    expect(patch).toContain(`diff --git a/${tricky} b/${tricky}`);
    expect(patch).not.toMatch(/\\[0-7]{3}/);
  });

  test('未跟踪的非 ASCII 路径也能取到 diff', async () => {
    const payload = await readDiff(repos.unicodePaths, { path: 'docs/未跟踪 文件.md' });
    expect(payload.kind).toBe('untracked-text');
    expect(payload).toHaveProperty('patch', expect.stringContaining('+brand new'));
  });
});

describe('重命名', () => {
  test('status 给出新旧两个路径与相似度', async () => {
    const { files } = await readStatus(repos.renames);
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

  test('相似度阈值之下的改名被 git 拆成删除 + 新增,不带 oldPath', async () => {
    const { files } = await readStatus(repos.renames);
    const added = files.find((f) => f.path === 'src/rewritten-renamed.txt');
    const deleted = files.find((f) => f.path === 'src/rewritten.txt');
    expect(added?.staged).toBe('A');
    expect(added?.oldPath).toBeUndefined();
    expect(deleted?.staged).toBe('D');
  });
});

describe('已暂存改动', () => {
  test('双状态位与 git status 一致', async () => {
    const { files } = await readStatus(repos.staged);
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
    const { files } = await readStatus(repos.deletions);
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
      const { files } = await readStatus(repos.deletions);
      // 前提:git 确实把它报成未跟踪,所以它进列表、用户点得到
      expect(files.find((f) => f.path === 'link-to-outside')?.unstaged).toBe('?');

      const payload = await readDiff(repos.deletions, { path: 'link-to-outside' });
      const patch = (payload as { patch: string }).patch;
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
    const { branch } = await readStatus(repos.noUpstream);
    expect(branch.head).toBe('feature/no-upstream');
    expect(branch.detached).toBe(false);
    expect(branch.upstream).toBe(null);
  });

  test('有上游 → ahead / behind 与 git 一致', async () => {
    const { branch } = await readStatus(repos.upstreamTracking);
    expect(branch.upstream).toEqual({ ahead: 2, behind: 1 });
  });
});

describe('空仓库(§5.3)', () => {
  test('列表与分支状态正常,不崩溃', async () => {
    const { branch, files } = await readStatus(repos.empty);
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
    const outside = mkdtempSync(join(tmpdir(), 'gitglance-not-a-repo-'));
    try {
      await expect(locateRepo(outside)).rejects.toMatchObject({ code: 'not-a-repo' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('300+ 文件变更的仓库能一次列全', async () => {
  const { files } = await readStatus(repos.manyFiles);
  expect(files.length).toBeGreaterThanOrEqual(300);
});
