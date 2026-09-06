// 目录树与只读读文件，跑**真实 git 输出**与真实磁盘。
//
// 这里钉的两件事都不报错：那两条 `ls-files` 的参数漏一个（`--directory` 漏了整个
// `node_modules` 会展开成逐个文件，git 照常 exit 0），以及读文件那条路写成 `stat` 而不是
// `lstat`（一个指向仓库外的链接就能把外部文件的内容当正文吐出来）。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFileContent } from '../../../src/server/git/file.ts';
import { readTree } from '../../../src/server/git/tree.ts';
import { WorktreeError } from '../../../src/server/git/worktree.ts';
import type { TreePayload } from '../../../src/server/shared/protocol.ts';
import { type FixtureRepos, makeFixtures, OUTSIDE_SECRET } from '../../fixtures/make.mjs';

const WINDOWS = process.platform === 'win32';

let dest: string;
let repos: FixtureRepos;
let root: string;

beforeAll(() => {
  dest = mkdtempSync(join(tmpdir(), 'difftab-tree-'));
  repos = makeFixtures(dest, ['ignoredTree', 'manyFiles', 'deletions', 'submoduleParent']);
  root = repos.ignoredTree;
}, 60_000);

afterAll(() => {
  rmSync(dest, { recursive: true, force: true });
});

/** 一层的条目按名字索引。`readTree` 回的是完整 payload（`path` + `entries`）。 */
const byName = (payload: TreePayload) => new Map(payload.entries.map((e) => [e.name, e]));

describe('readTree', () => {
  test('根那一层：已跟踪、未跟踪、被忽略的三类都在，且各自的 kind 与 ignored 都对', async () => {
    const entries = byName(await readTree(root, ''));

    expect(entries.get('src')).toEqual({
      name: 'src',
      path: 'src',
      kind: 'directory',
      ignored: false,
    });
    expect(entries.get('README.md')?.kind).toBe('file');
    expect(entries.get('README.md')?.ignored).toBe(false);
    // 被忽略的单文件——漏掉 `--ignored` 时这一档整个不出现
    expect(entries.get('.env')).toEqual({
      name: '.env',
      path: '.env',
      kind: 'file',
      ignored: true,
    });
  });

  test('被忽略的整目录折叠成一条——这是 `--directory` 唯一能被证伪的形态', async () => {
    const entries = byName(await readTree(root, ''));
    const vendor = entries.get('vendor');
    expect(vendor).toEqual({ name: 'vendor', path: 'vendor', kind: 'directory', ignored: true });
    // 折叠的证据在下一层：整个 vendor/ 只被提到过一次，展开它才知道里面有什么
    expect([...entries.keys()]).not.toContain('a.js');
  });

  test('展开被折叠的那个目录：git 答不出内层，靠读一层磁盘兜底，且整棵子树继承 ignored', async () => {
    const entries = byName(await readTree(root, 'vendor'));
    expect([...entries.keys()].sort()).toEqual(['a.js', 'nested']);
    expect(entries.get('nested')).toEqual({
      name: 'nested',
      path: 'vendor/nested',
      kind: 'directory',
      ignored: true,
    });
    expect(entries.get('a.js')?.ignored).toBe(true);
  });

  test('被折叠区域的**更深处**同样答得出——`--directory` 折叠在最高那一层', async () => {
    // 问 `vendor/nested` 时 git 回的是 `vendor/`（不是 `vendor/nested/`）。判据只认「正好等于
    // 本层」的话，这一条既不相等、又过不了 startsWith，这一层于是两手空空——页面上就是一个
    // 展开后写着 Empty 的目录，而里面明明有东西
    const entries = byName(await readTree(root, 'vendor/nested'));
    expect([...entries.keys()]).toEqual(['b.js']);
    expect(entries.get('b.js')).toEqual({
      name: 'b.js',
      path: 'vendor/nested/b.js',
      kind: 'file',
      ignored: true,
    });
  });

  test('一层只回直接子项——更深处的路径只贡献它的第一段', async () => {
    const entries = byName(await readTree(root, 'src'));
    expect([...entries.keys()].sort()).toEqual(['app.log', 'app.ts', 'new.ts']);
    expect(entries.get('app.ts')?.path).toBe('src/app.ts');
  });

  test('目录里既有可见文件又有被忽略的文件时，这个目录本身不灰显', async () => {
    // src/ 底下 app.ts 可见、app.log 被忽略。去重时把可见那条也标成灰的是最容易写出来的错
    expect(byName(await readTree(root, '')).get('src')?.ignored).toBe(false);
    const inSrc = byName(await readTree(root, 'src'));
    expect(inSrc.get('app.ts')?.ignored).toBe(false);
    expect(inSrc.get('new.ts')?.ignored).toBe(false);
    expect(inSrc.get('app.log')?.ignored).toBe(true);
  });

  test('整目录未跟踪且未被忽略时，折叠兜底继承的是「不灰显」', async () => {
    // `--others` 那条同样会折叠。兜底只在被忽略那一侧写对的话，这里整片会错标成灰的
    expect(byName(await readTree(root, '')).get('fresh')?.ignored).toBe(false);
    const deep = byName(await readTree(root, 'fresh/deep'));
    expect(deep.get('u.ts')).toEqual({
      name: 'u.ts',
      path: 'fresh/deep/u.ts',
      kind: 'file',
      ignored: false,
    });
  });

  test('submodule 是目录不是文件，且展开得进去', async () => {
    // gitlink 在普通 ls-files 输出里就是一条不带尾斜杠的路径，与文件长得一模一样——照文件
    // 画的话树上那一行没有展开箭头，点下去还会以「不是普通文件」告终。判据是 `--stage`
    // 给的 mode 160000
    const entries = byName(await readTree(repos.submoduleParent, ''));
    expect(entries.get('vendor')?.kind).toBe('directory');
    expect(byName(await readTree(repos.submoduleParent, 'vendor')).get('child')).toEqual({
      name: 'child',
      path: 'vendor/child',
      kind: 'directory',
      ignored: false,
    });
    // 父仓库的 ls-files 看不进 submodule，靠那条兜底读一层
    const inside = byName(await readTree(repos.submoduleParent, 'vendor/child'));
    expect(inside.get('child.txt')?.kind).toBe('file');
    // `.git` 由兜底自己滤掉——git 的输出里它从来不出现，submodule 底下那个还是文件
    expect(inside.has('.git')).toBe(false);
  });

  test('目录在前，各自按名字排序', async () => {
    const kinds = (await readTree(root, '')).entries.map((entry) => entry.kind);
    expect(kinds.indexOf('file')).toBeGreaterThan(kinds.lastIndexOf('directory'));
  });

  test('工作区已删、但仍在 index 里的文件仍列出（`--cached` 给的是 index）', async () => {
    const entries = byName(await readTree(repos.deletions, ''));
    expect(entries.has('worktree-deleted.txt')).toBe(true);
  });

  test('走出仓库的路径被挡下；尾斜杠一类的拼法归一而不是拒绝', async () => {
    await expect(readTree(root, '../..')).rejects.toBeInstanceOf(WorktreeError);
    // 归一化归 `resolveInRepo`（见 worktree.test.ts），这里只确认 readTree 用的是它那份：
    // 回的 `path` 与不带尾斜杠时逐字相同
    expect((await readTree(root, 'src/')).path).toBe('src');
  });

  test('把一个文件或不存在的路径当目录问，是错误而不是「空目录」', async () => {
    // 判据换成正面证据之前，这两条都落进「一条子项都没有 → 读磁盘 → 抛了被咽掉」那条
    // catch-all，页面上是一个展开后空空如也的目录
    await expect(readTree(root, 'README.md')).rejects.toBeInstanceOf(WorktreeError);
    await expect(readTree(root, 'does-not-exist')).rejects.toBeInstanceOf(WorktreeError);
  });

  test.skipIf(WINDOWS)('指向仓库外的符号链接目录列不出来——字面量那道边界挡不住它', async () => {
    // `linkdir` 在字面上老实待在仓库内，而 `readdir` 会顺着它走出去。少了 realpath 那道，
    // 这里回的是仓库外那个目录的清单
    await expect(readTree(root, 'linkdir')).rejects.toBeInstanceOf(WorktreeError);
  });

  test('根那一层的兜底真的走得到（空仓库不会把 `.git` 画出来）', async () => {
    // `resolveInRepo` 刻意把「解析到根自己」判为非法，兜底若照用它，根那一层永远走不到，
    // 连带它那条 `.git` 过滤成了死代码
    const bare = mkdtempSync(join(tmpdir(), 'difftab-bare-'));
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: bare });
    try {
      expect((await readTree(bare, '')).entries).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('readFileContent', () => {
  test('普通文本文件给的是工作区那一份正文', async () => {
    expect(await readFileContent(root, 'src/app.ts')).toEqual({
      kind: 'text',
      content: 'export const app = 1;\n',
    });
  });

  test('被忽略的文件照样读得到——树上点得到，就得看得到', async () => {
    expect(await readFileContent(root, '.env')).toEqual({ kind: 'text', content: 'SECRET=1\n' });
  });

  test('二进制走 NUL 字节探测，不返回正文', async () => {
    expect(await readFileContent(root, 'logo.png')).toEqual({ kind: 'binary' });
  });

  test.skipIf(WINDOWS)('符号链接给的是**目标字符串**，不是目标内容', async () => {
    const payload = await readFileContent(root, 'link-to-outside');
    expect(payload.kind).toBe('symlink');
    // 写成 stat 的话这里拿到的会是 { kind: 'text' }，正文正是仓库外那份内容
    expect(JSON.stringify(payload)).not.toContain(OUTSIDE_SECRET);
  });

  test('超过体积上限只报大小，不读进内存', async () => {
    writeFileSync(join(root, 'huge.bin'), Buffer.alloc(6 * 1024 * 1024, 0x61));
    const payload = await readFileContent(root, 'huge.bin');
    expect(payload).toEqual({ kind: 'too-large', size: 6 * 1024 * 1024, reason: 'size' });
  });

  test('体积没超、行数超了——`reason` 区分的就是这条路径', async () => {
    writeFileSync(join(root, 'many-lines.txt'), 'x\n'.repeat(50_001));
    const payload = await readFileContent(root, 'many-lines.txt');
    expect(payload.kind === 'too-large' && payload.reason).toBe('lines');
  });

  test('路径穿越与不存在的文件各自被挡下', async () => {
    for (const bad of ['../outside-secret.txt', '/etc/passwd', 'a\0b']) {
      await expect(readFileContent(root, bad)).rejects.toBeInstanceOf(WorktreeError);
    }
    await expect(readFileContent(root, 'nope.txt')).rejects.toThrow(/no longer exists/);
  });

  test.skipIf(WINDOWS)('中间段是符号链接同样走不出去——`lstat` 只保护最后一段', async () => {
    // `linkdir/secret.txt` 在字面上待在仓库内，少了 realpath 那道，读到的是仓库外那份内容
    await expect(readFileContent(root, 'linkdir/secret.txt')).rejects.toBeInstanceOf(WorktreeError);
    // 而链接自己照常展示成 symlink——挡的是穿越，不是符号链接
    expect((await readFileContent(root, 'linkdir')).kind).toBe('symlink');
  });
});
