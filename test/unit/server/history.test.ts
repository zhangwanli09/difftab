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

beforeAll(() => {
  dest = mkdtempSync(join(tmpdir(), 'difftab-history-'));
  repos = makeFixtures(dest, ['history', 'empty', 'driverTraps']);
  root = repos.history;
}, 30_000);

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
  test('parseLog 按五段一组切，根提交的空 %P 是空段不是缺段', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const out = `${a}\0${b}\0Ann Lee\x001700000000\0fix: x\0${b}\0\0Bob\x001600000000\0root\0`;
    expect(parseLog(out)).toEqual([
      { sha: a, parents: [b], author: 'Ann Lee', time: 1700000000, subject: 'fix: x' },
      { sha: b, parents: [], author: 'Bob', time: 1600000000, subject: 'root' },
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
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
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
    const detail = await readCommit(root, shaOf('root commit'));
    expect(detail.parents).toEqual([]);
    expect(detail.files).toEqual([
      { path: 'README.md', status: 'A' },
      { path: 'img/p.png', status: 'A' },
      { path: 'src/a.txt', status: 'A' },
    ]);
  });

  test('git mv 是一条 R，带旧路径', async () => {
    const detail = await readCommit(root, shaOf('rename a to b'));
    expect(detail.files).toEqual([{ path: 'src/b.txt', oldPath: 'src/a.txt', status: 'R' }]);
  });

  test('合并提交只对第一父求 diff：带进来的是 side 那侧', async () => {
    const detail = await readCommit(root, shaOf('merge side'));
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
    await expect(readCommit(root, tag)).rejects.toMatchObject({ code: 'not-found' });
  });

  test('树对象、标签以外的对象名 → not-found', async () => {
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' });
    await expect(readCommit(root, tree.trim())).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('readCommitDiff——提交里单个文件的补丁', () => {
  test('修改：补丁相对第一父', async () => {
    const payload = await readCommitDiff(root, shaOf('edit a'), { path: 'src/a.txt' });
    expect(payload.kind).toBe('text');
    if (payload.kind !== 'text') return;
    expect(payload.patch).toContain('-line 3');
    expect(payload.patch).toContain('+changed');
  });

  test('重命名传两个路径：不退化成全新增', async () => {
    const payload = await readCommitDiff(root, shaOf('rename a to b'), {
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
      readCommitDiff(root, shaOf('edit a'), { path: 'README.md' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(readCommitDiff(root, shaOf('edit a'), { path: '../x' })).rejects.toMatchObject({
      code: 'invalid-path',
    });
  });

  test('图片：两侧都来自对象库，version 是两端的对象名', async () => {
    const sha = shaOf('recolor png');
    const parent = shaOf('rename a to b');
    const payload = await readCommitDiff(root, sha, { path: 'img/p.png' });
    expect(payload).toEqual({
      kind: 'image',
      old: { path: 'img/p.png', size: tinyPng(PNG_RED).length, version: parent },
      new: { path: 'img/p.png', size: tinyPng(PNG_BLUE).length, version: sha },
    });
    expect((await readImageBytes(root, 'img/p.png', 'old', sha)).buffer).toEqual(tinyPng(PNG_RED));
    expect((await readImageBytes(root, 'img/p.png', 'new', sha)).buffer).toEqual(tinyPng(PNG_BLUE));
  });

  test('根提交里的图片只有新侧', async () => {
    const payload = await readCommitDiff(root, shaOf('root commit'), { path: 'img/p.png' });
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
    await expect(readCommitDiff(cwd, sha, { path: 'f.x' })).rejects.toMatchObject({
      kind: 'missing-object',
    });
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
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: clone,
      encoding: 'utf8',
    }).trim();
    const detail = await readCommit(clone, head);
    expect(detail).toMatchObject({ files: [], shallow: true });
    await expect(readCommitDiff(clone, head, { path: 'README.md' })).rejects.toMatchObject({
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
  const repo = join(dest, 'history-wide');
  execFileSync('git', ['init', '--quiet', repo]);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'x',
    GIT_AUTHOR_EMAIL: 'x@x',
    GIT_COMMITTER_NAME: 'x',
    GIT_COMMITTER_EMAIL: 'x@x',
  };
  const body = `${Array.from({ length: 60_000 }, (_, i) => `l${i}`).join('\n')}\n`;
  writeFileSync(join(repo, 'wide.txt'), body);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '--quiet', '-m', 'wide'], { cwd: repo, env });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  expect(await readCommitDiff(repo, sha, { path: 'wide.txt' })).toEqual({
    kind: 'too-large',
    size: Buffer.byteLength(body),
    reason: 'lines',
  });
});
