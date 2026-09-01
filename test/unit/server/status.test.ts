// `porcelain=v2 -z` 解析器的单测。
//
// 这里的原始输入都是从真实 git 抄下来的(见 test/fixtures/make.mjs 生成的仓库),
// 不是凭想象拼的 —— 两个陷阱(重命名占两个 NUL 段、无上游时不输出 `# branch.ab`)
// 恰恰是「凭想象写出来的解析器一定踩中」的地方。

import { describe, expect, test } from 'vitest';
import { parseStatus, STATUS_ARGS } from '../../../src/server/git/status.ts';

/** 把可读的记录数组拼成 `-z` 输出:每条记录后跟一个 NUL。 */
const z = (...records: string[]) => records.map((r) => `${r}\0`).join('');

describe('parseStatus', () => {
  test('重命名记录占两个 NUL 段,旧路径不能被当成下一条记录', () => {
    const raw = z(
      '# branch.oid 9f9500cb',
      '# branch.head main',
      // 一条记录,两段:`2 ... R100 <新路径>\0<旧路径>`
      '2 RM N... 100644 100644 100644 af8a489d af8a489d R100 src/kept-renamed.txt',
      'src/kept.txt',
      '1 A. N... 000000 100644 100644 00000000 2d155f2d src/rewritten-renamed.txt',
    );

    const { files } = parseStatus(raw);

    // 无状态平铺切分的话,这里会多出一条 path 为 'src/kept.txt' 的假记录
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({
      path: 'src/kept-renamed.txt',
      oldPath: 'src/kept.txt',
      kind: 'tracked',
      staged: 'R',
      unstaged: 'M',
      renameScore: 100,
    });
    expect(files[1]?.path).toBe('src/rewritten-renamed.txt');
  });

  test('无上游时没有 `# branch.ab` 行 —— upstream 为 null,不是 0/0', () => {
    const raw = z('# branch.oid 277e9d6a', '# branch.head feature/no-upstream');
    expect(parseStatus(raw).branch).toEqual({
      head: 'feature/no-upstream',
      detached: false,
      upstream: null,
    });
  });

  test('有上游时解出 ahead / behind', () => {
    const raw = z(
      '# branch.oid a6650872',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
    );
    expect(parseStatus(raw).branch.upstream).toEqual({ ahead: 2, behind: 1 });
  });

  test('detached HEAD 由字面量 `(detached)` 判定', () => {
    const raw = z('# branch.oid a6650872', '# branch.head (detached)');
    const { branch } = parseStatus(raw);
    expect(branch.detached).toBe(true);
    expect(branch.head).toBe('(detached)');
  });

  test('双状态位的四种组合各自落到 staged / unstaged', () => {
    const raw = z(
      '# branch.head main',
      '1 M. N... 100644 100644 100644 da0f8ed9 64c33da8 a.txt',
      '1 .M N... 100644 100644 100644 c9c6af7f c9c6af7f b.txt',
      '1 MM N... 100644 100644 100644 ae930457 eb51ac65 c.txt',
      '1 A. N... 000000 100644 100644 00000000 5e338b89 d.txt',
    );
    expect(parseStatus(raw).files.map((f) => [f.path, f.staged, f.unstaged])).toEqual([
      ['a.txt', 'M', '.'],
      ['b.txt', '.', 'M'],
      ['c.txt', 'M', 'M'],
      ['d.txt', 'A', '.'],
    ]);
  });

  test('路径里的空格不会把字段切错 —— 段内是空格分隔,路径是最后一段的剩余全部', () => {
    const raw = z(
      '# branch.head main',
      '1 .M N... 100644 100644 100644 4cb29ea3 4cb29ea3 docs/she "said" it\'s 需求 文档.md',
      '? docs/未跟踪 文件.md',
    );
    const { files } = parseStatus(raw);
    expect(files[0]?.path).toBe('docs/she "said" it\'s 需求 文档.md');
    expect(files[1]).toEqual({
      path: 'docs/未跟踪 文件.md',
      kind: 'untracked',
      staged: '.',
      unstaged: '?',
    });
  });

  test('未合并记录(u)有 10 个前置字段,不按 1 的 8 个切', () => {
    const raw = z(
      '# branch.head main',
      '1 .M N... 100644 100644 100644 c9c6af7f c9c6af7f after.txt',
      'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict me.txt',
    );
    const { files } = parseStatus(raw);
    const conflict = files.find((f) => f.staged === 'U');
    expect(conflict?.path).toBe('conflict me.txt');
    expect(conflict?.unstaged).toBe('U');
  });

  test('`u` 记录一律带 conflicted,`DD` 这种两位都不是 U 的也不例外', () => {
    // **判据是「这条来自 `u` 段」,不是状态位**:`DD`(双方都删)与 `AA`(双方都新增)两位里一个
    // `U` 都没有,靠状态位认的实现会把它们漏掉,于是它们同时落进两组 —— 而两组都不是它们的处境
    const raw = z(
      '# branch.head main',
      'u DD N... 100644 100644 100644 100644 aaaa bbbb cccc both-deleted.txt',
      'u AA N... 100644 100644 100644 100644 aaaa bbbb cccc both-added.txt',
      '1 .M N... 100644 100644 100644 c9c6af7f c9c6af7f plain.txt',
    );
    const { files } = parseStatus(raw);
    const conflicted = files.filter((f) => f.conflicted);
    expect(conflicted.map((f) => f.path)).toEqual(['both-deleted.txt', 'both-added.txt']);
    // 反面:普通记录**不带**这个字段(而不是带一个 false),判据只有「有没有」一种形态
    expect(files.find((f) => f.path === 'plain.txt')).not.toHaveProperty('conflicted');
  });

  test('空输出不崩溃,分支退化为「无上游」', () => {
    expect(parseStatus('')).toEqual({
      branch: { head: '', detached: false, upstream: null },
      files: [],
    });
  });
});

test('主查询的参数逐字固定 —— S3b 的降级轮询要复用同一条', () => {
  // 漏 `-uall` 会让已存在的未跟踪目录里新增文件静默不刷新;漏 `--branch` 会丢掉提交与切分支的检
  // 测。钉死在这里,改的人至少会看到红
  expect([...STATUS_ARGS]).toEqual(['status', '--porcelain=v2', '--branch', '-uall', '-z']);
});
