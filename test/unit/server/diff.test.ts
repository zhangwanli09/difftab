// 未跟踪文件的手工 unified diff 构造与路径边界(spec §5.2)。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DiffRequestError, resolveInRepo, untrackedDiff } from '../../../src/server/git/diff.ts';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gitglance-diff-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveInRepo', () => {
  test('仓库内的相对路径正常落地', () => {
    expect(resolveInRepo('/repo', 'src/a.ts')).toBe(resolve('/repo', 'src/a.ts'));
  });

  test('走出仓库、绝对路径、空路径、NUL 一律拒 —— 未跟踪那条路要直接读磁盘', () => {
    for (const bad of ['../etc/passwd', '../../etc/passwd', 'a/../../b', '', 'x\0y']) {
      expect(() => resolveInRepo('/repo', bad)).toThrow(DiffRequestError);
    }
    expect(() => resolveInRepo('/repo', join('/etc', 'passwd'))).toThrow(DiffRequestError);
    // 指向仓库根自身也不是一个文件
    expect(() => resolveInRepo('/repo', '.')).toThrow(DiffRequestError);
  });

  test('路径里的 `..` 只要没走出仓库就放行', () => {
    expect(resolveInRepo('/repo', 'src/../src/a.ts')).toBe(resolve('/repo', 'src/a.ts'));
  });
});

describe('untrackedDiff', () => {
  test('构造成全新增:/dev/null 一侧为空,每行加 +', async () => {
    writeFileSync(join(root, 'new.txt'), 'alpha\nbeta\n');
    const payload = await untrackedDiff(root, 'new.txt');
    expect(payload).toEqual({
      kind: 'untracked-text',
      patch:
        'diff --git a/new.txt b/new.txt\n' +
        'new file mode 100644\n' +
        '--- /dev/null\n' +
        '+++ b/new.txt\n' +
        '@@ -0,0 +1,2 @@\n' +
        '+alpha\n' +
        '+beta\n',
    });
  });

  test('末尾无换行时补上 git 自己也会写的那一行', async () => {
    writeFileSync(join(root, 'nonewline.txt'), 'only line');
    const payload = await untrackedDiff(root, 'nonewline.txt');
    expect(payload.kind).toBe('untracked-text');
    expect(payload).toHaveProperty(
      'patch',
      expect.stringContaining('\\ No newline at end of file'),
    );
  });

  test('空文件不产出 hunk', async () => {
    writeFileSync(join(root, 'empty.txt'), '');
    const payload = await untrackedDiff(root, 'empty.txt');
    expect(payload).toHaveProperty('patch', expect.not.stringContaining('@@'));
  });

  test('含 NUL 字节判为二进制 —— 未跟踪文件不在 numstat 里,只能自己探', async () => {
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    expect(await untrackedDiff(root, 'blob.bin')).toEqual({ kind: 'binary' });
  });

  test('行数上限挡住「体积不大但行数极多」的窄文件 —— 体积阈值挡不住这一头', async () => {
    // 50,001 行、总共约 100 KB,远在 5MB 之下
    writeFileSync(join(root, 'many-lines.txt'), `${'x\n'.repeat(50_001)}`);
    const payload = await untrackedDiff(root, 'many-lines.txt');
    expect(payload.kind).toBe('too-large');
  });

  test('文件不在了给明确错误,而不是抛一个 ENOENT 栈', async () => {
    await expect(untrackedDiff(root, 'gone.txt')).rejects.toThrow(DiffRequestError);
  });
});
