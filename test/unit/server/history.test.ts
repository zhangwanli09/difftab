// 提交历史：`log` 的解析与锚点分页、`--name-status -z` 的三段重命名、第一父与根提交、提交里
// 单个文件的补丁与图片两侧。对真实 git 跑（`history` fixture）——解析器的结构与「对比端是谁」都
// 只有真仓库能证伪。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readCommitDiff } from '../../../src/server/git/diff.ts';
import {
  assertOid,
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
  repos = makeFixtures(dest, ['history', 'empty']);
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

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof WorktreeError) return cause.code;
    throw cause;
  }
  throw new Error('期望抛 WorktreeError，却正常返回了');
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
    const second = await listCommits(clone, { from: anchor, skip: PAGE_SIZE });
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

  test('from 不是完整对象名 → invalid-path；不存在的提交 → not-found', async () => {
    expect(await codeOf(listCommits(root, { from: 'HEAD', skip: 0 }))).toBe('invalid-path');
    expect(await codeOf(listCommits(root, { from: 'f'.repeat(40), skip: 0 }))).toBe('not-found');
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

  test('树对象、标签以外的对象名 → not-found', async () => {
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' });
    expect(await codeOf(readCommit(root, tree.trim()))).toBe('not-found');
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
    expect(await codeOf(readCommitDiff(root, shaOf('edit a'), { path: 'README.md' }))).toBe(
      'not-found',
    );
    expect(await codeOf(readCommitDiff(root, shaOf('edit a'), { path: '../x' }))).toBe(
      'invalid-path',
    );
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
