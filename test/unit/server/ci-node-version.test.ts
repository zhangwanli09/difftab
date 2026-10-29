// CI 里「构建用的 Node」那几处版本号的门禁：build、inotify-quota、release.yml 的 publish 三处
// 各写一个 `node-version` 字面量，换版本时漏改一处、或换成一个在 Linux 上判到 C 档的版本，都不会
// 让任何作业变红。
//
// 仓库没有 YAML 解析器，作业按缩进从文本里切；**切不到作业、或作业里的 `node-version` 不是恰好
// 一条时一律变红**，否则作业改名后这里会对着空结果通过。放在 server 那一档是因为它要读文件系统。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectTier } from '../../../src/server/watch/tier.ts';

const repoRoot = new URL('../../../', import.meta.url);

/** 要求同一个 Node 的那几个作业：哪份 workflow、哪个作业键。 */
const JOBS = [
  { file: '.github/workflows/ci.yml', job: 'build' },
  { file: '.github/workflows/ci.yml', job: 'inotify-quota' },
  { file: '.github/workflows/release.yml', job: 'publish' },
] as const;

/**
 * 某个作业那一段的文本：从 `jobs:` 底下两格缩进的 `<job>:` 起，到下一个同级或更浅的键为止。
 * 注释行（`  # …`）与更深的缩进都不会被当成下一个键。
 */
function jobSection(workflow: string, job: string): string {
  const lines = workflow.split(/\r?\n/);
  const jobsAt = lines.indexOf('jobs:');
  if (jobsAt === -1) throw new Error('workflow 里找不到顶层的 jobs:');
  const start = lines.findIndex((line, i) => i > jobsAt && line === `  ${job}:`);
  if (start === -1) throw new Error(`找不到作业 ${job}——改了作业键的话这里的 JOBS 跟着改`);
  const next = lines.findIndex((line, i) => i > start && /^ {0,2}[\w-]+:/.test(line));
  return lines.slice(start, next === -1 ? undefined : next).join('\n');
}

/**
 * 作业里那一条 `node-version` 的取值，去掉引号与行尾注释（`26 # LTS` 取 `26`——否则报的是
 * 「不认识的写法」，指错了方向）。不是恰好一条就抛。
 */
function nodeVersionOf(file: string, job: string): string {
  const section = jobSection(readFileSync(new URL(file, repoRoot), 'utf8'), job);
  const values = [...section.matchAll(/^\s+node-version:\s*(.+?)\s*(?:\s#.*)?$/gm)].map((m) =>
    String(m[1]).replace(/^(['"])(.*)\1$/, '$2'),
  );
  if (values.length !== 1) {
    throw new Error(`${file} 的 ${job} 作业里应恰好有一条 node-version，实际 ${values.length} 条`);
  }
  return String(values[0]);
}

/**
 * setup-node 的版本写法 → 它可能解析到的**最低**版本：`26` 按 `26.0.0` 算，`24.14` 按
 * `24.14.0` 算。只认这种纯数字的前缀写法；`lts/*`、范围、`26.x` 之类解析不出确定的下界，
 * 直接变红，而不是猜一个。
 */
function lowestVersion(spec: string): string {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(spec);
  if (!m) throw new Error(`本断言不认识的 node-version 写法：${spec}`);
  return `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}`;
}

describe('构建用的 Node 版本', () => {
  it('build、inotify-quota、publish 三处是同一个字面量', () => {
    const found = JOBS.map(({ file, job }) => ({ file, job, version: nodeVersionOf(file, job) }));
    const listed = found
      .map(({ file, job, version }) => `${file} · ${job} = ${version}`)
      .join('；');
    expect(
      new Set(found.map(({ version }) => version)).size,
      `三处的 node-version 漂开了，要一起换：${listed}`,
    ).toBe(1);
  });

  it('这个版本在 Linux 上判到监听 A 档——否则 inotify-quota 打印 SKIP 后照样变绿', () => {
    const spec = nodeVersionOf('.github/workflows/ci.yml', 'inotify-quota');
    expect(detectTier(lowestVersion(spec), 'linux'), `node-version: ${spec}`).toBe('A');
    // 对照：`24` 的下界是 24.0.0，判到 C 档——「写 24 就够了」那个直觉错在这里
    expect(detectTier(lowestVersion('24'), 'linux')).toBe('C');
  });
});
