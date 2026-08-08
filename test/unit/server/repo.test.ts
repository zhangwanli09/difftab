// 前置检查里的纯解析部分(spec §5.2)。

import { expect, test } from 'vitest';
import { parseGitVersion } from '../../../src/server/git/repo.ts';

test('从 `git --version` 的各种发行版变体里取出主次版本号', () => {
  expect(parseGitVersion('git version 2.50.1 (Apple Git-155)\n')).toEqual({ major: 2, minor: 50 });
  expect(parseGitVersion('git version 2.11.0\n')).toEqual({ major: 2, minor: 11 });
  expect(parseGitVersion('git version 2.45.2.windows.1\n')).toEqual({ major: 2, minor: 45 });
});

test('取不到版本号时返回 null —— 由调用方决定「不确定就不拒绝」', () => {
  // 判据是 rev-parse 跑不跑得通,而不是这行字符串长什么样。
  // 在这里硬要解析出个数字来,等于让某个包装过的 git 被误拒
  expect(parseGitVersion('')).toBe(null);
  expect(parseGitVersion('not a version string')).toBe(null);
});
