// 补丁的两个可选档（忽略空白、整份上下文）对**真实 git** 的行为，外加 HTTP 层那道参数解析。
//
// 每条都对着真 git 跑：这里钉的是「git 真的会吐出那些字节」——用户配置能不能改掉 hunk 的切法、`-w`
// 下只改了空白的文件是不是空输出、整份上下文过不了闸时是不是退回 3 行——单测拿手写补丁验不出来。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readCommitDiff, readDiff } from '../../../src/server/git/diff.ts';
import { locateRepo } from '../../../src/server/git/repo.ts';
import { MAX_LINES } from '../../../src/server/git/worktree.ts';
import { patchOptionsOf } from '../../../src/server/http/server.ts';
import type { DiffPayload } from '../../../src/server/shared/protocol.ts';

let root: string;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** 1..n 每行一个数字，末尾带换行。 */
const numbered = (n: number, edit: (line: number) => string = String) =>
  `${Array.from({ length: n }, (_, i) => edit(i + 1)).join('\n')}\n`;

/** 断言是 git 出的那份补丁，取出正文与 `full`。 */
function textOf(payload: DiffPayload): { patch: string; full: boolean } {
  if (payload.kind !== 'text') throw new Error(`期望 text，拿到的是 ${payload.kind}`);
  return payload;
}

const hunkHeaders = (patch: string) => patch.split('\n').filter((line) => line.startsWith('@@'));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'difftab-patch-options-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  // 两条会改掉 hunk 切法的配置：后端必须在命令行上显式盖过它们
  git('config', 'diff.context', '0');
  git('config', 'diff.interHunkContext', '5');
  writeFileSync(join(root, 'ws.py'), 'a\nb\nif x:\n  foo()\n  bar()\nc\n');
  writeFileSync(join(root, 'only-ws.txt'), 'one\ntwo\n');
  writeFileSync(join(root, 'long.txt'), numbered(40));
  writeFileSync(join(root, 'huge.txt'), numbered(MAX_LINES + 10));
  git('add', '.');
  git('commit', '-qm', 'init');

  writeFileSync(join(root, 'ws.py'), 'a\nb\nif x:\n    foo()\n    bar()\nC\n');
  writeFileSync(join(root, 'only-ws.txt'), 'one  \n  two\n');
  // 相隔 7 行的两处改动：`-U3` 之下是两个 hunk、中间隔 1 行；`diff.interHunkContext=5` 会把它们并成一个
  writeFileSync(
    join(root, 'long.txt'),
    numbered(40, (n) => (n === 5 ? 'five' : n === 13 ? 'thirteen' : String(n))),
  );
  writeFileSync(
    join(root, 'huge.txt'),
    numbered(MAX_LINES + 10, (n) => (n === 1 ? 'one' : String(n))),
  );
}, 30_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('默认档：3 行上下文显式写进 argv', () => {
  test('用户配的 diff.context / diff.interHunkContext 盖不过命令行', async () => {
    const { patch, full } = textOf(await readDiff(root, { path: 'long.txt' }));
    expect(full).toBe(false);
    // 照配置给时这里是一个 `@@ -5 +5 @@` 之类没有上下文的 hunk，或者被并成一个 `-2,15`
    expect(hunkHeaders(patch)).toEqual(['@@ -2,7 +2,7 @@', '@@ -10,7 +10,7 @@']);
  });
});

describe('忽略空白（-w）', () => {
  test('只改了空白的文件：照常是 text，补丁为空（git 连 `diff --git` 头都不给）', async () => {
    const payload = await readDiff(root, { path: 'only-ws.txt', ignoreWhitespace: true });
    expect(payload).toEqual({ kind: 'text', patch: '', full: false });
  });

  test('不开时照常给出空白的改动', async () => {
    const { patch } = textOf(await readDiff(root, { path: 'only-ws.txt' }));
    expect(patch).toContain('+  two');
  });

  test('缩进与内容一起改：只剩内容那一行，缩进的那几行成了上下文（正文取自新侧）', async () => {
    const { patch } = textOf(await readDiff(root, { path: 'ws.py', ignoreWhitespace: true }));
    const body = patch
      .split('\n')
      .filter((line) => /^[-+ ]/.test(line) && !/^(---|\+\+\+)/.test(line));
    expect(body).toEqual([' if x:', '     foo()', '     bar()', '-c', '+C']);
  });

  test('提交 diff 同一套', async () => {
    git('add', 'only-ws.txt');
    git('commit', '-qm', 'whitespace only');
    try {
      const repo = await locateRepo(root);
      const sha = git('rev-parse', 'HEAD').trim();
      const payload = await readCommitDiff(repo, sha, {
        path: 'only-ws.txt',
        ignoreWhitespace: true,
      });
      expect(payload).toEqual({ kind: 'text', patch: '', full: false });
    } finally {
      git('reset', '-q', '--soft', 'HEAD~1');
    }
  });
});

describe('整份上下文', () => {
  test('放得下时整个文件一个 hunk，标 full', async () => {
    const { patch, full } = textOf(await readDiff(root, { path: 'long.txt', fullContext: true }));
    expect(full).toBe(true);
    expect(hunkHeaders(patch)).toEqual(['@@ -1,40 +1,40 @@']);
  });

  test('与忽略空白一起开', async () => {
    const payload = await readDiff(root, {
      path: 'ws.py',
      ignoreWhitespace: true,
      fullContext: true,
    });
    const { patch, full } = textOf(payload);
    expect(full).toBe(true);
    expect(hunkHeaders(patch)).toEqual(['@@ -1,6 +1,6 @@']);
  });

  test('补丁超过行数上限：退回 3 行上下文、标 full: false，而不是说太大', async () => {
    const { patch, full } = textOf(await readDiff(root, { path: 'huge.txt', fullContext: true }));
    expect(full).toBe(false);
    expect(hunkHeaders(patch)).toEqual(['@@ -1,4 +1,4 @@']);
  });

  test('未跟踪文件不理会这两个开关', async () => {
    writeFileSync(join(root, 'fresh.txt'), 'x\n');
    try {
      const payload = await readDiff(root, {
        path: 'fresh.txt',
        ignoreWhitespace: true,
        fullContext: true,
      });
      expect(payload.kind).toBe('untracked-text');
    } finally {
      rmSync(join(root, 'fresh.txt'));
    }
  });
});

describe('patchOptionsOf（HTTP 层的参数解析）', () => {
  const parse = (query: string) => patchOptionsOf(new URLSearchParams(query));

  test('缺省即关，`1` 即开', () => {
    expect(parse('')).toEqual({ ignoreWhitespace: false, fullContext: false });
    expect(parse('ignoreWhitespace=1&fullContext=1')).toEqual({
      ignoreWhitespace: true,
      fullContext: true,
    });
  });

  test('其余值一律拒绝——`true` 在宽松解析下是一个静默不生效的开关', () => {
    for (const query of [
      'ignoreWhitespace=true',
      'fullContext=0',
      'fullContext=',
      'ignoreWhitespace=-w',
    ]) {
      expect(parse(query)).toBeNull();
    }
  });
});
