// 提交历史：`log` 的解析与锚点分页、`--name-status -z` 的三段重命名、第一父与根提交、提交里
// 单个文件的补丁与图片两侧。对真实 git 跑（`history` fixture）——解析器的结构与「对比端是谁」都
// 只有真仓库能证伪。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readCommitDiff, readDiff } from '../../../src/server/git/diff.ts';
import {
  assertOid,
  isPartialCloneConfig,
  listCommits,
  PAGE_SIZE,
  parseLog,
  parseNameStatus,
  readCommit,
} from '../../../src/server/git/history.ts';
import { readImageBytes } from '../../../src/server/git/image.ts';
import { locateRepo, type RepoInfo } from '../../../src/server/git/repo.ts';
import { WorktreeError } from '../../../src/server/git/worktree.ts';
import {
  type FixtureRepos,
  makeFixtures,
  PNG_BLUE,
  PNG_RED,
  tinyPng,
} from '../../fixtures/make.mjs';

let dest: string;
let repos: FixtureRepos;
let root: string;
let repo: RepoInfo;

beforeAll(() => {
  dest = mkdtempSync(join(tmpdir(), 'difftab-history-'));
  repos = makeFixtures(dest, ['history', 'empty', 'driverTraps']);
  root = repos.history;
}, 30_000);

beforeAll(async () => {
  repo = await locateRepo(root);
});

/** HEAD 此刻的完整 sha。 */
const headOf = (cwd: string) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

afterAll(() => {
  rmSync(dest, { recursive: true, force: true });
});

/** 提交主题 → 完整 sha。 */
function shaOf(subject: string): string {
  const out = execFileSync('git', ['log', '--format=%H %s'], { cwd: root, encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.slice(41) === subject);
  if (!line) throw new Error(`fixture 里没有提交「${subject}」`);
  return line.slice(0, 40);
}

describe('解析器', () => {
  test('parseLog 六段一条，根提交的空 %P 是空段不是缺段，正文去掉末尾换行', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const out = `${a}\0${b}\0Ann Lee\x001700000000\0fix: x\0line 1\n\nline 2\n\0\n${b}\0\0Bob\x001600000000\0root\0\0`;
    expect(parseLog(out)).toEqual([
      {
        sha: a,
        parents: [b],
        author: 'Ann Lee',
        time: 1700000000,
        subject: 'fix: x',
        body: 'line 1\n\nline 2',
      },
      { sha: b, parents: [], author: 'Bob', time: 1600000000, subject: 'root', body: '' },
    ]);
  });

  test('parseNameStatus：重命名占三段且旧在前，平铺切分会错位', () => {
    const out = 'M\0a.txt\0R087\0old/x.ts\0new/x.ts\0D\0gone.md\0A\0added.png\0';
    expect(parseNameStatus(out)).toEqual([
      { path: 'a.txt', status: 'M' },
      { path: 'new/x.ts', oldPath: 'old/x.ts', status: 'R' },
      { path: 'gone.md', status: 'D' },
      { path: 'added.png', status: 'A' },
    ]);
  });

  test('assertOid 只认完整十六进制对象名', () => {
    expect(assertOid('a'.repeat(40))).toBe('a'.repeat(40));
    expect(assertOid('b'.repeat(64))).toBe('b'.repeat(64));
    for (const bad of ['HEAD', 'abc1234', `${'a'.repeat(40)}~1`, '--output=x', 'A'.repeat(40)]) {
      expect(() => assertOid(bad)).toThrow(WorktreeError);
    }
  });
});

describe('listCommits——锚点分页', () => {
  test('第一页 50 条、最新的在前，head 是 HEAD 的 oid', async () => {
    const page = await listCommits(root, { skip: 0 });
    const head = headOf(root);
    expect(page.head).toBe(head);
    expect(page.commits).toHaveLength(PAGE_SIZE);
    expect(page.hasMore).toBe(true);
    expect(page.commits[0]).toMatchObject({
      sha: head,
      subject: 'step 51',
      author: 'difftab Fixture',
    });
  });

  test('第二页钉在锚点上：之后再提交也不与第一页重叠', async () => {
    const first = await listCommits(root, { skip: 0 });
    const anchor = first.head as string;
    // 用一个临时克隆模拟「翻页之间 agent 又提交了一次」，不动共享的 fixture
    const clone = join(dest, 'history-clone');
    execFileSync('git', ['clone', '--quiet', root, clone]);
    execFileSync(
      'git',
      [
        '-c',
        'user.name=x',
        '-c',
        'user.email=x@x',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'late',
      ],
      { cwd: clone },
    );
    const second = await listCommits(clone, { head: anchor, skip: PAGE_SIZE });
    expect(second.head).toBe(anchor);
    expect(second.hasMore).toBe(false);
    expect(second.commits.map((c) => c.subject)).toEqual([
      'step 1',
      'step 0',
      'merge side',
      'main work',
      'side work',
      'recolor png',
      'rename a to b',
      'edit a',
      'root commit',
    ]);
    const seen = new Set(first.commits.map((c) => c.sha));
    expect(second.commits.some((c) => seen.has(c.sha))).toBe(false);
  });

  test('正文随列表一起回来：多段说明原样保留，没有正文的提交是空串', async () => {
    const clone = join(dest, 'history-body');
    execFileSync('git', ['clone', '--quiet', root, clone]);
    const message = ['feat: x', 'first paragraph\nwraps here', 'Co-authored-by: A <a@a>'];
    execFileSync(
      'git',
      [
        '-c',
        'user.name=x',
        '-c',
        'user.email=x@x',
        'commit',
        '--quiet',
        '--allow-empty',
        ...message.flatMap((m) => ['-m', m]),
      ],
      { cwd: clone },
    );
    const [latest, previous] = (await listCommits(clone, { skip: 0 })).commits;
    expect(latest).toMatchObject({ subject: 'feat: x', body: message.slice(1).join('\n\n') });
    expect(previous).toMatchObject({ subject: 'step 51', body: '' });
  });

  test('正文里夹着 NUL：git 在 NUL 处截断，之后的记录照样六段一条、不错位', async () => {
    // `git commit` 拒绝含 NUL 的说明，只有手造对象才有；造一条 NUL 之后正好是一个 sha 的，
    // 若 git 不截断，那个 sha 会被当成下一条记录的开头
    const clone = join(dest, 'history-nul');
    execFileSync('git', ['clone', '--quiet', root, clone]);
    const git = (args: string[], input?: string) =>
      execFileSync('git', args, { cwd: clone, encoding: 'utf8', input }).trim();
    const parent = git(['rev-parse', 'HEAD']);
    const raw = [
      `tree ${git(['rev-parse', 'HEAD^{tree}'])}`,
      `parent ${parent}`,
      'author x <x@x> 1700000000 +0000',
      'committer x <x@x> 1700000000 +0000',
      '',
      'subj',
      '',
      `Reverts\0${parent}\0tail`,
      '',
    ].join('\n');
    const nul = git(['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], raw);
    git(['update-ref', 'HEAD', nul]);
    const { commits } = await listCommits(clone, { skip: 0 });
    expect(commits.slice(0, 2).map((c) => [c.sha, c.subject, c.body])).toEqual([
      [nul, 'subj', 'Reverts'],
      [parent, 'step 51', ''],
    ]);
    expect(commits).toHaveLength(PAGE_SIZE);
  });

  test('空仓库是一页空列表，不是错误', async () => {
    expect(await listCommits(repos.empty, { skip: 0 })).toEqual({
      head: null,
      commits: [],
      hasMore: false,
    });
  });

  test('head 不是完整对象名 → invalid-path；不存在的提交 → not-found', async () => {
    await expect(listCommits(root, { head: 'HEAD', skip: 0 })).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(listCommits(root, { head: 'f'.repeat(40), skip: 0 })).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});

describe('readCommit——元数据与文件清单', () => {
  test('根提交对空树求 diff，全部是新增', async () => {
    const detail = await readCommit(repo, shaOf('root commit'));
    expect(detail.parents).toEqual([]);
    expect(detail.files).toEqual([
      { path: 'README.md', status: 'A' },
      { path: 'img/p.png', status: 'A' },
      { path: 'src/a.txt', status: 'A' },
    ]);
  });

  test('git mv 是一条 R，带旧路径', async () => {
    const detail = await readCommit(repo, shaOf('rename a to b'));
    expect(detail.files).toEqual([{ path: 'src/b.txt', oldPath: 'src/a.txt', status: 'R' }]);
  });

  test('合并提交只对第一父求 diff：带进来的是 side 那侧', async () => {
    const detail = await readCommit(repo, shaOf('merge side'));
    expect(detail.parents).toHaveLength(2);
    expect(detail.parents[0]).toBe(shaOf('main work'));
    expect(detail.files).toEqual([{ path: 'side.txt', status: 'A' }]);
  });

  test('附注标签的对象名 → not-found：log 会把它剥到提交上，而回来的那条不是问的这个', async () => {
    execFileSync(
      'git',
      ['-c', 'user.name=x', '-c', 'user.email=x@x', 'tag', '-a', 'v1', '-m', 'v1'],
      {
        cwd: root,
      },
    );
    const tag = execFileSync('git', ['rev-parse', 'v1'], { cwd: root, encoding: 'utf8' }).trim();
    await expect(readCommit(repo, tag)).rejects.toMatchObject({ code: 'not-found' });
  });

  test('树对象、标签以外的对象名 → not-found', async () => {
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' });
    await expect(readCommit(repo, tree.trim())).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('readCommitDiff——提交里单个文件的补丁', () => {
  test('修改：补丁相对第一父', async () => {
    const payload = await readCommitDiff(repo, shaOf('edit a'), { path: 'src/a.txt' });
    expect(payload.kind).toBe('text');
    if (payload.kind !== 'text') return;
    expect(payload.patch).toContain('-line 3');
    expect(payload.patch).toContain('+changed');
  });

  test('重命名传两个路径：不退化成全新增', async () => {
    const payload = await readCommitDiff(repo, shaOf('rename a to b'), {
      path: 'src/b.txt',
      oldPath: 'src/a.txt',
    });
    expect(payload.kind).toBe('text');
    if (payload.kind !== 'text') return;
    expect(payload.patch).toContain('rename from src/a.txt');
    expect(payload.patch).not.toContain('+line 0');
  });

  test('这次提交没动的文件 → not-found；路径走出仓库 → invalid-path', async () => {
    await expect(
      readCommitDiff(repo, shaOf('edit a'), { path: 'README.md' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(readCommitDiff(repo, shaOf('edit a'), { path: '../x' })).rejects.toMatchObject({
      code: 'invalid-path',
    });
  });

  test('图片：两侧都来自对象库，version 是两端的对象名', async () => {
    const sha = shaOf('recolor png');
    const parent = shaOf('rename a to b');
    const payload = await readCommitDiff(repo, sha, { path: 'img/p.png' });
    expect(payload).toEqual({
      kind: 'image',
      old: { path: 'img/p.png', size: tinyPng(PNG_RED).length, version: parent },
      new: { path: 'img/p.png', size: tinyPng(PNG_BLUE).length, version: sha },
    });
    expect((await readImageBytes(repo, 'img/p.png', 'old', sha)).buffer).toEqual(tinyPng(PNG_RED));
    expect((await readImageBytes(repo, 'img/p.png', 'new', sha)).buffer).toEqual(tinyPng(PNG_BLUE));
  });

  test('根提交里的图片只有新侧', async () => {
    const payload = await readCommitDiff(repo, shaOf('root commit'), { path: 'img/p.png' });
    expect(payload).toMatchObject({ kind: 'image', old: null });
  });
});

describe('读一下就写库的两个陷阱（driverTraps：partial clone + cachetextconv）', () => {
  const objects = (cwd: string) =>
    execFileSync('git', ['count-objects', '-v'], { cwd, encoding: 'utf8' });
  const notes = (cwd: string) =>
    execFileSync('git', ['for-each-ref', 'refs/notes'], { cwd, encoding: 'utf8' });

  test('旧提交的 blob 不在本地：以 missing-object 失败（HTTP 层译成 unsupported），不去 promisor remote 取', async () => {
    const cwd = repos.driverTraps;
    const before = objects(cwd);
    const sha = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd, encoding: 'utf8' }).trim();
    await expect(readCommitDiff(await locateRepo(cwd), sha, { path: 'f.x' })).rejects.toMatchObject(
      {
        kind: 'missing-object',
      },
    );
    expect(objects(cwd)).toBe(before);
  });

  test('配了 cachetextconv 的驱动：工作区 diff 不跑它，也不写 refs/notes', async () => {
    const cwd = repos.driverTraps;
    const payload = await readDiff(cwd, { path: 'f.x' });
    expect(payload.kind).toBe('text');
    expect(notes(cwd)).toBe('');
  });
});

test('isPartialCloneConfig：promisor 的每一种真值写法都认，假值不认', () => {
  for (const config of [
    '[extensions]\n\tpartialClone = origin\n',
    '[remote "origin"]\n\tpromisor = true\n',
    '[remote "origin"]\n\tpromisor = Yes\n',
    '[remote "origin"]\n\tpromisor = on\n',
    '[remote "origin"]\n\tpromisor = 1\n',
    '[remote "origin"]\n\tpromisor\n',
  ]) {
    expect(isPartialCloneConfig(config), config).toBe(true);
  }
  for (const config of ['[remote "origin"]\n\tpromisor = false\n', '[core]\n\tbare = false\n']) {
    expect(isPartialCloneConfig(config), config).toBe(false);
  }
});

describe('不是根提交的「没有父」', () => {
  test('浅克隆的边界：不拿空树去比——文件清单为空并标 shallow，补丁明确拒绝', async () => {
    const clone = join(dest, 'history-shallow');
    execFileSync('git', ['clone', '--quiet', '--depth', '1', pathToFileURL(root).href, clone]);
    const head = headOf(clone);
    const detail = await readCommit(await locateRepo(clone), head);
    expect(detail).toMatchObject({ files: [], shallow: true });
    await expect(
      readCommitDiff(await locateRepo(clone), head, { path: 'README.md' }),
    ).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  test('HEAD 指着一个读不出来的提交：是错误，不是「没有提交」', async () => {
    const broken = join(dest, 'history-broken');
    execFileSync('git', ['clone', '--quiet', root, broken]);
    // `update-ref` 不肯指向不存在的对象，直接写 HEAD 文件——与中断的 fetch 留下的形态一样
    writeFileSync(join(broken, '.git', 'HEAD'), `${'f'.repeat(40)}\n`);
    await expect(listCommits(broken, { skip: 0 })).rejects.toThrow(/cannot be read/);
  });
});

test('提交 diff 被行数闸拒绝时照样报体积——与工作区那份同一个文件说同一个数', async () => {
  const sha = shaOf('step 0');
  const size = Number(
    execFileSync('git', ['cat-file', '-s', `${sha}:wide.txt`], { cwd: root, encoding: 'utf8' }),
  );
  expect(await readCommitDiff(repo, sha, { path: 'wide.txt' })).toEqual({
    kind: 'too-large',
    size,
    reason: 'lines',
  });
});
