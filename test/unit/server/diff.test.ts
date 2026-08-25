// 未跟踪文件的手工 unified diff 构造、`--numstat` 解析与路径边界。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  DiffRequestError,
  parseNumstat,
  resolveInRepo,
  untrackedDiff,
} from '../../../src/server/git/diff.ts';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'difftab-diff-'));
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

describe('parseNumstat(已跟踪那一侧的二进制与行数判定)', () => {
  test('普通记录:一条占一个 NUL 段,行数是加 + 减', () => {
    expect(parseNumstat('1\t2\ta.txt\0')).toEqual([
      { binary: false, lines: 3, path: 'a.txt', oldPath: null },
    ]);
  });

  test('二进制记录是 `-\\t-`,两个计数都取不到', () => {
    expect(parseNumstat('-\t-\tassets/icon.bin\0')).toEqual([
      { binary: true, lines: 0, path: 'assets/icon.bin', oldPath: null },
    ]);
  });

  test('重命名记录占**三**段:后两段是新旧路径,不能再被当成记录去解析', () => {
    // 实测形态:`1\t0\t\0<旧>\0<新>`,路径字段是空的,且顺序与
    // porcelain 的 `2 ` 记录**相反**(那边新在前)。读反了不报错,只是标注里的
    // 「重命名自」指着新名字。
    //
    // 「后两段必须整段吞掉」这件事,只有当路径**自己长得像一条记录**时才看得出来 ——
    // 而那正是 `-z` 存在的理由:路径里除了 NUL 什么字节都可能有,包括制表符。
    // 少吞两段时,下面这个旧路径会被解析成一条 `2+3` 行的记录凭空多出来
    const renamedWithTabs = ['1\t0\t', '2\t3\tweird name.txt', 'tidy name.txt', ''].join('\0');
    expect(parseNumstat(renamedWithTabs)).toEqual([
      { binary: false, lines: 1, path: 'tidy name.txt', oldPath: '2\t3\tweird name.txt' },
    ]);
  });

  test('多条记录各自带着自己的路径 —— 调用方靠它挑,不靠下标', () => {
    // 下标是掷硬币:git 按路径排序,而「哪条属于我」与排序无关(见 readNumstat)
    const output = ['1\t2\ta.txt', '-\t-\tb.bin', '7\t7\tc.txt', ''].join('\0');
    expect(parseNumstat(output)).toEqual([
      { binary: false, lines: 3, path: 'a.txt', oldPath: null },
      { binary: true, lines: 0, path: 'b.bin', oldPath: null },
      { binary: false, lines: 14, path: 'c.txt', oldPath: null },
    ]);
  });

  test('路径里带换行也不影响 —— `-z` 之下换行只是普通字节', () => {
    expect(parseNumstat('3\t0\tweird\nname.txt\0')).toEqual([
      { binary: false, lines: 3, path: 'weird\nname.txt', oldPath: null },
    ]);
  });

  test('空输出即「不在这次差异里」,不是零改动', () => {
    expect(parseNumstat('')).toEqual([]);
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
    // reason 必须是 lines 而不是 size:体积只有约 100 KB,前端若只拿到体积就会
    // 显示「文件过大(0 MB)」这种自相矛盾的话
    expect(payload).toEqual({ kind: 'too-large', size: 100_002, reason: 'lines' });
  });

  test('文件不在了给明确错误,而不是抛一个 ENOENT 栈', async () => {
    await expect(untrackedDiff(root, 'gone.txt')).rejects.toThrow(DiffRequestError);
  });
});
