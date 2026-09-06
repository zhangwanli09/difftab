// 仓库边界那两道门与行数口径。
//
// 这两样先前住在 `diff.ts` 里，而 `tree.ts` / `file.ts` 反向 import 它——于是「只读读磁盘」
// 这个 concern 没有 owner。搬进 `worktree.ts` 之后用例也跟着搬到这里。

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { countLines, resolveInRepo, WorktreeError } from '../../../src/server/git/worktree.ts';

const WINDOWS = process.platform === 'win32';

let dest: string;
let root: string;

beforeAll(() => {
  dest = mkdtempSync(join(tmpdir(), 'difftab-worktree-'));
  root = join(dest, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'x\n');
  mkdirSync(join(dest, 'outside'), { recursive: true });
  writeFileSync(join(dest, 'outside', 'secret.txt'), 'SECRET\n');
  if (!WINDOWS) symlinkSync(join(dest, 'outside'), join(root, 'linkdir'));
});
afterAll(() => {
  rmSync(dest, { recursive: true, force: true });
});

const file = { follow: false } as const;
const dir = { follow: true, allowRoot: true } as const;

describe('resolveInRepo（两道边界只此一个入口）', () => {
  test('仓库内的相对路径正常落地，并回一份归一化的仓库相对路径', async () => {
    expect(await resolveInRepo(root, 'src/a.ts', file)).toEqual({
      abs: resolve(root, 'src/a.ts'),
      path: 'src/a.ts',
    });
  });

  test('走出仓库、绝对路径、空路径、NUL 一律拒——读磁盘那条路要直接落盘', async () => {
    for (const bad of ['../etc/passwd', '../../etc/passwd', 'a/../../b', '', 'x\0y']) {
      await expect(resolveInRepo(root, bad, file)).rejects.toBeInstanceOf(WorktreeError);
    }
    await expect(resolveInRepo(root, join('/etc', 'passwd'), file)).rejects.toBeInstanceOf(
      WorktreeError,
    );
    // 指向仓库根自身也不是一个文件
    await expect(resolveInRepo(root, '.', file)).rejects.toBeInstanceOf(WorktreeError);
  });

  test('`allowRoot` 才让空串通过——目录树的第一层就是根，读文件时那是坏请求', async () => {
    expect(await resolveInRepo(root, '', dir)).toEqual({ abs: resolve(root), path: '' });
    await expect(resolveInRepo(root, '', file)).rejects.toBeInstanceOf(WorktreeError);
  });

  test('路径里的 `..` 只要没走出仓库就放行，且归一化后不留 `..`', async () => {
    expect(await resolveInRepo(root, 'src/../src/a.ts', file)).toEqual({
      abs: resolve(root, 'src/a.ts'),
      path: 'src/a.ts',
    });
  });

  test('尾斜杠与 `./` 前缀归一到同一份——收敛逻辑靠这份路径做前缀匹配', async () => {
    for (const shape of ['src/', './src', 'src//']) {
      expect((await resolveInRepo(root, shape, dir)).path).toBe('src');
    }
  });

  test.skipIf(WINDOWS)('中间段是符号链接时被第二道挡下，末段跟不跟随由调用方定', async () => {
    // 字面量那道放行（`linkdir/secret.txt` 看着老实待在仓库内），realpath 那道才挡得住
    await expect(resolveInRepo(root, 'linkdir/secret.txt', file)).rejects.toBeInstanceOf(
      WorktreeError,
    );
    // 列目录那侧连末段也要展开——`readdir` 本来就跟
    await expect(resolveInRepo(root, 'linkdir', dir)).rejects.toBeInstanceOf(WorktreeError);
    // 而读文件那侧末段不跟：链接自己是合法的展示对象
    expect((await resolveInRepo(root, 'linkdir', file)).path).toBe('linkdir');
  });
});

describe('countLines（全仓唯一一份行数口径）', () => {
  test('空文件 0 行，末尾那个换行不另算一行', () => {
    expect(countLines(Buffer.from(''))).toBe(0);
    expect(countLines(Buffer.from('a\n'))).toBe(1);
    expect(countLines(Buffer.from('a\nb\n'))).toBe(2);
    // 没有末尾换行时最后那截照样算一行
    expect(countLines(Buffer.from('a\nb'))).toBe(2);
  });
});
