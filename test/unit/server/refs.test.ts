// 分支列表：`for-each-ref` 的十段解析、symref 过滤、附注标签解引用、三组次序。对真实 git 跑
// （`history` fixture 带着每种 ref 形态）——「附注标签的本体字段是空的」这类事只有真仓库能证伪。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { listRefs, parseRefs } from '../../../src/server/git/refs.ts';
import { type FixtureRepos, makeFixtures } from '../../fixtures/make.mjs';

let dest: string;
let repos: FixtureRepos;

beforeAll(() => {
  dest = mkdtempSync(join(tmpdir(), 'difftab-refs-'));
  repos = makeFixtures(dest, ['history', 'empty']);
}, 30_000);

afterAll(() => {
  rmSync(dest, { recursive: true, force: true });
});

const revOf = (rev: string) =>
  execFileSync('git', ['rev-parse', rev], { cwd: repos.history, encoding: 'utf8' }).trim();

test('三组依次排列、名字剥掉前缀，origin/HEAD 那条 symref 不列', async () => {
  const { refs } = await listRefs(repos.history);
  expect(refs.map((r) => `${r.kind}:${r.name}`)).toEqual([
    'local:main',
    'local:side',
    'remote:origin/main',
    'tag:v1.0',
    'tag:light',
    'tag:tree-tag',
  ]);
});

test('附注标签给的是它指向的提交，不是标签对象', async () => {
  const { refs } = await listRefs(repos.history);
  const tag = refs.find((r) => r.name === 'v1.0');
  expect(tag).toMatchObject({
    sha: revOf('HEAD~1'),
    subject: 'step 50',
    author: 'difftab Fixture',
  });
  expect(tag?.time).toBeGreaterThan(0);
});

test('轻量标签与分支直接用本体；指向树的标签没有提交信息', async () => {
  const { refs } = await listRefs(repos.history);
  expect(refs.find((r) => r.name === 'light')).toMatchObject({
    sha: revOf('side'),
    subject: 'side work',
  });
  expect(refs.find((r) => r.name === 'origin/main')).toMatchObject({ sha: revOf('HEAD~2') });
  expect(refs.find((r) => r.name === 'tree-tag')).toMatchObject({
    sha: revOf('HEAD^{tree}'),
    author: '',
    subject: '',
    time: 0,
  });
});

test('空仓库：一条 ref 都没有，回空列表而不是错误', async () => {
  expect(await listRefs(repos.empty)).toEqual({ refs: [] });
});

test('parseRefs：记录之间的换行不进名字，组内按时间降序', () => {
  const record = (name: string, time: number, subject: string) =>
    `${[name, '', 'a'.repeat(40), 'A', String(time), subject, '', '', '', ''].join('\0')}\0\n`;
  const output =
    record('refs/tags/old', 1, 't1') +
    record('refs/heads/b', 5, 'b') +
    record('refs/heads/a', 9, 'a') +
    record('refs/notes/x', 9, 'ignored');
  expect(parseRefs(output).map((r) => r.name)).toEqual(['a', 'b', 'old']);
});
