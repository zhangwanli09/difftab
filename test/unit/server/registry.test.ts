// 单实例注册表。
//
// 这里钉的两条都属于「错了也不报错、只是静默出错」：键归一化对不上时 dev proxy
// 说「没找到后端」，而后端明明起着；清理误删时被删的实例还活着、只是从此没有记录。

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  readRegistry,
  registryPath,
  removeRegistry,
  writeRegistry,
} from '../../../src/server/cli/registry.ts';

const cleanup: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'difftab-registry-'));
  cleanup.push(dir);
  return dir;
}

function entryFor(repoRoot: string, pid = process.pid) {
  return { pid, port: 45678, token: '45678.secret', repoRoot, startedAt: Date.now() };
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(registryPath(dir), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('键归一化', () => {
  test('同一个目录的不同写法落到同一个文件', () => {
    const dir = tempRepo();
    // 写入侧给的是 `git rev-parse --show-toplevel`，读取侧(dev proxy)给的是 process.cwd()——两
    // 者指向同一个目录时字面量仍可能不同。不归一的话 sha256 各算各的，dev proxy 永远找不到后端
    expect(registryPath(`${dir}${sep}`)).toBe(registryPath(dir));
    expect(registryPath(join(dir, '.'))).toBe(registryPath(dir));
  });

  test('写入后用另一种写法读得回来', () => {
    const dir = tempRepo();
    writeRegistry(entryFor(dir));
    expect(readRegistry(`${dir}${sep}`)?.port).toBe(45678);
  });
});

describe('写入', () => {
  test('文件权限是 0o600——里面存着本次会话的 token', () => {
    if (process.platform === 'win32') return; // Windows 没有等价的位语义
    const dir = tempRepo();
    const path = writeRegistry(entryFor(dir));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('已存在的陈旧条目被覆盖，而不是让第二次启动直接失败', () => {
    const dir = tempRepo();
    writeRegistry({ ...entryFor(dir, 999_999), port: 1111 });
    writeRegistry(entryFor(dir));
    expect(readRegistry(dir)?.port).toBe(45678);
  });
});

describe('清理', () => {
  test('删自己写的那一条', () => {
    const dir = tempRepo();
    writeRegistry(entryFor(dir));
    removeRegistry(dir);
    expect(readRegistry(dir)).toBe(null);
  });

  test('别人的条目原样留着', () => {
    const dir = tempRepo();
    writeRegistry(entryFor(dir, process.pid + 1));
    removeRegistry(dir);
    expect(readRegistry(dir)?.port).toBe(45678);
  });

  test('解析不出来的条目也留着——解析失败不等于是自己的', () => {
    // 回归点：守卫曾经是 `entry && entry.pid !== process.pid`，readRegistry 返回 null(写到一半的
    // 截断 JSON、或将来换了格式)时会短路失败、直接删掉——被删的那个实例还活着，只是没了记录
    const dir = tempRepo();
    const path = registryPath(dir);
    writeRegistry(entryFor(dir));
    writeFileSync(path, '{"pid": 12', { mode: 0o600 });

    removeRegistry(dir);
    expect(readFileSync(path, 'utf8')).toBe('{"pid": 12');
  });
});
