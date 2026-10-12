// 全仓搜索与 Quick Open 的文件列表。解析与区间计算用手写输出钉形态，其余对真实 git 跑——「配了
// `grep.column` 时记录多一段」「`submodule.recurse` 让 `--untracked` fatal」这类事只有真仓库能证伪。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  grepArgs,
  parseGrep,
  type SearchOptions,
  searchRepo,
} from '../../../src/server/git/search.ts';
import { listFiles } from '../../../src/server/git/tree.ts';
import { MAX_SEARCH_LINES } from '../../../src/server/shared/protocol.ts';
import { type FixtureRepos, makeFixtures } from '../../fixtures/make.mjs';

let dest: string;
let repos: FixtureRepos;

beforeAll(() => {
  dest = mkdtempSync(join(tmpdir(), 'difftab-search-'));
  repos = makeFixtures(dest, ['ignoredTree', 'submoduleParent']);
}, 60_000);

afterAll(() => {
  rmSync(dest, { recursive: true, force: true });
});

const plain = (query: string, extra: Partial<SearchOptions> = {}): SearchOptions => ({
  query,
  matchCase: false,
  wholeWord: false,
  ...extra,
});

describe('grepArgs', () => {
  test('除 -i / -w 与查询外整条是字面量，查询落在 -e 之后', () => {
    const head = ['grep', '--no-color', '--no-textconv', '-I', '-z', '-n', '-F', '--untracked'];
    expect(grepArgs(plain('-n'))).toEqual([...head, '-i', '-e', '-n', '--']);
    expect(grepArgs(plain('x', { matchCase: true }))).toEqual([...head, '-e', 'x', '--']);
    expect(grepArgs(plain('x', { wholeWord: true }))).toEqual([
      ...head,
      '-i',
      '-w',
      '-e',
      'x',
      '--',
    ]);
  });
});

describe('parseGrep', () => {
  test('按 NUL → NUL → 换行顺序切：路径里的换行不切断记录，同一个文件的命中归一组', () => {
    const out = 'a\nb.txt\x001\x00hello\nc.txt\x002\x00Hello\nc.txt\x009\x00x hello\n';
    expect(parseGrep(out, plain('hello'), false)).toEqual({
      files: [
        { path: 'a\nb.txt', matches: [{ line: 1, text: 'hello', ranges: [[0, 5]] }] },
        {
          path: 'c.txt',
          matches: [
            { line: 2, text: 'Hello', ranges: [[0, 5]] },
            { line: 9, text: 'x hello', ranges: [[2, 7]] },
          ],
        },
      ],
      truncated: false,
    });
  });

  test('截断时丢掉最后那条半截记录，并如实标 truncated', () => {
    const out = 'a.txt\x001\x00hello\na.txt\x002\x00hel';
    const payload = parseGrep(out, plain('hello'), true);
    expect(payload.files[0]?.matches.map((m) => m.line)).toEqual([1]);
    expect(payload.truncated).toBe(true);
  });

  test('超过行数上限即截、标 truncated', () => {
    const out = Array.from({ length: MAX_SEARCH_LINES + 5 }, (_, i) => `f\x00${i + 1}\x00x\n`).join(
      '',
    );
    const payload = parseGrep(out, plain('x'), false);
    expect(payload.files[0]?.matches).toHaveLength(MAX_SEARCH_LINES);
    expect(payload.truncated).toBe(true);
  });

  test('区间：大小写、全词按 git 的字词集，正则元字符按字面量', () => {
    const line = (text: string, options: SearchOptions) =>
      parseGrep(`f\x001\x00${text}\n`, options, false).files[0]?.matches[0]?.ranges;
    expect(line('Foo foo', plain('foo', { matchCase: true }))).toEqual([[4, 7]]);
    expect(line('Foo foo', plain('foo'))).toEqual([
      [0, 3],
      [4, 7],
    ]);
    expect(line('foo_bar foo', plain('foo', { wholeWord: true }))).toEqual([[8, 11]]);
    expect(line('a.b axb', plain('a.b'))).toEqual([[0, 3]]);
    expect(line('Äpfel', plain('äPFEL'))).toEqual([[0, 5]]);
  });

  test('行首空白与行尾 \\r 剥掉，区间跟着平移', () => {
    const match = parseGrep('f\x003\x00\t    return hit;\r\n', plain('hit'), false).files[0]
      ?.matches[0];
    expect(match).toEqual({ line: 3, text: 'return hit;', ranges: [[7, 10]] });
  });

  test('长行裁成命中附近一截、两端补 …，区间指向的仍是命中本身', () => {
    const text = `${'x'.repeat(1000)}NEEDLE${'y'.repeat(1000)}`;
    const match = parseGrep(`f\x001\x00${text}\n`, plain('needle'), false).files[0]?.matches[0];
    expect(match).toBeDefined();
    if (!match) return;
    expect(match.text.startsWith('…')).toBe(true);
    expect(match.text.endsWith('…')).toBe(true);
    expect(match.text.length).toBeLessThanOrEqual(302);
    const [[from, to]] = match.ranges as [[number, number]];
    expect(match.text.slice(from, to)).toBe('NEEDLE');
  });
});

describe('searchRepo（真 git）', () => {
  test('未跟踪的搜得到，被忽略的与二进制的搜不到；没有命中不是错误', async () => {
    const root = repos.ignoredTree;
    const fresh = await searchRepo(root, plain('fresh'));
    expect(fresh.files.map((f) => f.path)).toEqual(['src/new.ts']);
    expect(await searchRepo(root, plain('module.exports'))).toEqual({
      files: [],
      truncated: false,
    });
    expect(await searchRepo(root, plain('zz-no-such-text-zz'))).toEqual({
      files: [],
      truncated: false,
    });
  });

  test('以 - 开头的查询是查询，不是选项', async () => {
    const root = repos.ignoredTree;
    writeFileSync(join(root, 'dash.txt'), 'run with -n please\n');
    try {
      const payload = await searchRepo(root, plain('-n'));
      expect(payload.files.find((f) => f.path === 'dash.txt')?.matches[0]?.text).toBe(
        'run with -n please',
      );
    } finally {
      rmSync(join(root, 'dash.txt'));
    }
  });

  test('用户配了 grep.column 与 submodule.recurse 也照常工作', async () => {
    const root = repos.submoduleParent;
    const config = (...args: string[]) => execFileSync('git', ['config', ...args], { cwd: root });
    config('grep.column', 'true');
    config('submodule.recurse', 'true');
    try {
      const payload = await searchRepo(root, plain('p1'));
      expect(payload.files).toEqual([
        { path: 'parent.txt', matches: [{ line: 1, text: 'p1', ranges: [[0, 2]] }] },
      ]);
    } finally {
      config('--unset', 'grep.column');
      config('--unset', 'submodule.recurse');
    }
  });
});

describe('listFiles', () => {
  test('已跟踪 + 未跟踪，不含被忽略的；未跟踪目录展开到文件', async () => {
    const { paths } = await listFiles(repos.ignoredTree);
    expect(paths).toContain('src/app.ts');
    expect(paths).toContain('src/new.ts');
    expect(paths).toContain('fresh/deep/deeper/v.ts');
    expect(paths.some((p) => p.startsWith('vendor/') || p === '.env' || p.endsWith('.log'))).toBe(
      false,
    );
    expect(paths).toEqual([...paths].sort());
  });

  test('未跟踪的内嵌仓库不列——它只会以一条 `sub/` 出现，打不开', async () => {
    const root = repos.ignoredTree;
    const nested = join(root, 'cloned');
    execFileSync('git', ['init', '-q', nested]);
    writeFileSync(join(nested, 'inner.txt'), 'x\n');
    try {
      const { paths } = await listFiles(root);
      expect(paths.some((p) => p.endsWith('/'))).toBe(false);
      expect(paths.some((p) => p.startsWith('cloned'))).toBe(false);
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  test('submodule 不列——它打不开', async () => {
    const { paths } = await listFiles(repos.submoduleParent);
    expect(paths).toContain('parent.txt');
    expect(paths).not.toContain('vendor/child');
  });
});
