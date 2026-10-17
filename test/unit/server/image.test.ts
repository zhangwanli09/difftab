// 图片那一支：判据「二进制 ∧ 扩展名」、两侧元数据、`/api/blob` 两侧的字节，以及 `cat-file` 的边界。
// 对真实 git 跑（`images` fixture），与 `git-integration.test.ts` 同一取向——扩展名表与 `cat-file`
// 的参数都是「删掉照样全绿」的那种，只有真仓库能证伪。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readCommitDiff, readDiff } from '../../../src/server/git/diff.ts';
import { readFileContent } from '../../../src/server/git/file.ts';
import { baseBlobSize, readImageBytes } from '../../../src/server/git/image.ts';
import { locateRepo, type RepoInfo, resolveDiffBase } from '../../../src/server/git/repo.ts';
import { imageMimeOf, previewMimeOf, WorktreeError } from '../../../src/server/git/worktree.ts';
import {
  type FixtureRepos,
  makeFixtures,
  PNG_BLUE,
  PNG_GREEN,
  PNG_RED,
  SVG_BLUE,
  SVG_RED,
  tinyPng,
} from '../../fixtures/make.mjs';

let dest: string;
let repos: FixtureRepos;
let root: string;
let repo: RepoInfo;

beforeAll(() => {
  dest = mkdtempSync(join(tmpdir(), 'difftab-images-'));
  repos = makeFixtures(dest, ['images', 'empty']);
  root = repos.images;
}, 30_000);

beforeAll(async () => {
  repo = await locateRepo(root);
});

afterAll(() => {
  rmSync(dest, { recursive: true, force: true });
});

/** 抛出来的 `WorktreeError.code`；没抛就是断言失败。 */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof WorktreeError) return cause.code;
    throw cause;
  }
  throw new Error('期望抛 WorktreeError，却正常返回了');
}

describe('imageMimeOf——扩展名表', () => {
  test('八种位图扩展名各给精确 MIME，大小写不敏感', () => {
    expect(imageMimeOf('a.png')).toBe('image/png');
    expect(imageMimeOf('dir/A.JPG')).toBe('image/jpeg');
    expect(imageMimeOf('a.jpeg')).toBe('image/jpeg');
    expect(imageMimeOf('a.gif')).toBe('image/gif');
    expect(imageMimeOf('a.webp')).toBe('image/webp');
    expect(imageMimeOf('a.bmp')).toBe('image/bmp');
    expect(imageMimeOf('a.ico')).toBe('image/x-icon');
    expect(imageMimeOf('a.avif')).toBe('image/avif');
  });

  test('SVG 刻意不在表里；无扩展名、点开头、目录名带 .png 都不算', () => {
    expect(imageMimeOf('logo.svg')).toBeNull();
    expect(imageMimeOf('Dockerfile')).toBeNull();
    expect(imageMimeOf('.png')).toBeNull();
    expect(imageMimeOf('assets.png/readme')).toBeNull();
    expect(imageMimeOf('a.bin')).toBeNull();
  });
});

describe('readDiff 的 image 分支——五种形态', () => {
  test('改写的图两侧都有，体积各取各的；version 是内容身份', async () => {
    const payload = await readDiff(root, { path: 'img/a.png' });
    expect(payload).toEqual({
      kind: 'image',
      old: { path: 'img/a.png', size: tinyPng(PNG_RED).length, version: expect.any(String) },
      new: { path: 'img/a.png', size: tinyPng(PNG_BLUE).length, version: expect.any(String) },
    });
    if (payload.kind !== 'image') throw new Error('unreachable');
    // 旧侧是基准的 oid（那个 blob 只在基准换了之后才可能变），新侧是体积 + mtime
    expect(payload.old?.version).toBe((await resolveDiffBase(root)).oid);
    const info = statSync(join(root, 'img/a.png'));
    expect(payload.new?.version).toBe(`${info.size}-${info.mtimeMs}`);
  });

  test('version 随内容变，不随取的次数变——否则每次无关的 SSE 都重下两张图', async () => {
    const first = await readDiff(root, { path: 'img/a.png' });
    const again = await readDiff(root, { path: 'img/a.png' });
    expect(again).toEqual(first);

    // 同体积改写：mtime 变了就是另一份内容
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(root, 'img/a.png'), tinyPng(PNG_GREEN));
    const changed = await readDiff(root, { path: 'img/a.png' });
    if (first.kind !== 'image' || changed.kind !== 'image') throw new Error('unreachable');
    expect(changed.new?.version).not.toBe(first.new?.version);
    expect(changed.old?.version).toBe(first.old?.version);
    writeFileSync(join(root, 'img/a.png'), tinyPng(PNG_BLUE));
  });

  test('删除的图只有旧侧', async () => {
    expect(await readDiff(root, { path: 'img/gone.png' })).toEqual({
      kind: 'image',
      old: { path: 'img/gone.png', size: tinyPng(PNG_GREEN).length, version: expect.any(String) },
      new: null,
    });
  });

  test('`git mv` 过的图：旧侧的 path 是 oldPath，前端拿它直接问 /api/blob', async () => {
    const payload = await readDiff(root, { path: 'img/moved.png', oldPath: 'img/old.png' });
    expect(payload).toEqual({
      kind: 'image',
      old: { path: 'img/old.png', size: tinyPng(PNG_BLUE).length, version: expect.any(String) },
      new: { path: 'img/moved.png', size: tinyPng(PNG_BLUE).length, version: expect.any(String) },
    });
  });

  test('未跟踪的图只有新侧——走的是 NUL 探测那条路', async () => {
    expect(await readDiff(root, { path: 'new.png' })).toEqual({
      kind: 'image',
      old: null,
      new: { path: 'new.png', size: tinyPng(PNG_GREEN).length, version: expect.any(String) },
    });
  });

  test('对照面：非图片扩展名的二进制仍是 binary，内容是文本的 .png 仍是 text', async () => {
    expect(await readDiff(root, { path: 'blob.bin' })).toEqual({ kind: 'binary' });
    const fake = await readDiff(root, { path: 'fake.png' });
    expect(fake.kind).toBe('text');
  });

  test('路径带 `./` 也归一化后再拼进 <base>:<path>——那不是 pathspec', async () => {
    const payload = await readDiff(root, { path: './img/a.png' });
    expect(payload).toMatchObject({ kind: 'image', old: { path: 'img/a.png' } });
  });
});

describe('readFileContent 的 image 分支', () => {
  test('工作区里的图给 size，判据与 diff 那侧同一条', async () => {
    expect(await readFileContent(root, 'img/a.png')).toEqual({
      kind: 'image',
      size: tinyPng(PNG_BLUE).length,
      version: expect.any(String),
    });
    expect(await readFileContent(root, 'blob.bin')).toEqual({ kind: 'binary' });
    expect((await readFileContent(root, 'fake.png')).kind).toBe('text');
  });
});

describe('readImageBytes——/api/blob 两侧', () => {
  test('new 侧是工作区的字节，old 侧是基准里的 blob，MIME 按表', async () => {
    const fresh = await readImageBytes(repo, 'img/a.png', 'new');
    expect(fresh.mime).toBe('image/png');
    expect(fresh.buffer.equals(tinyPng(PNG_BLUE))).toBe(true);

    const base = await readImageBytes(repo, 'img/a.png', 'old');
    expect(base.mime).toBe('image/png');
    // 逐字节相等——`toString('utf8')` 一次就再也拼不回原图，这条钉的正是 runGitRaw 那层
    expect(base.buffer.equals(tinyPng(PNG_RED))).toBe(true);
  });

  test('删除的图 old 侧读得到、new 侧 not-found；新增的反过来', async () => {
    expect((await readImageBytes(repo, 'img/gone.png', 'old')).buffer.length).toBeGreaterThan(0);
    expect(await codeOf(readImageBytes(repo, 'img/gone.png', 'new'))).toBe('not-found');
    expect((await readImageBytes(repo, 'new.png', 'new')).buffer.length).toBeGreaterThan(0);
    expect(await codeOf(readImageBytes(repo, 'new.png', 'old'))).toBe('not-found');
  });

  test('非图片扩展名一律 invalid-path——它不是「下载任意文件」的端点', async () => {
    expect(await codeOf(readImageBytes(repo, 'blob.bin', 'new'))).toBe('invalid-path');
    expect(await codeOf(readImageBytes(repo, 'README.md', 'old'))).toBe('invalid-path');
  });

  test('new 侧走的是 inspectFile 那条链：内容是文本的 .png 与 payload 一样不算图', async () => {
    // 只查扩展名的副本会把它当 image/png 发出去，而 /api/diff 与 /api/file 都说它是文本
    expect(await codeOf(readImageBytes(repo, 'fake.png', 'new'))).toBe('invalid-path');
  });

  test('穿越路径在扩展名之后、落盘之前被拒', async () => {
    expect(await codeOf(readImageBytes(repo, '../outside.png', 'new'))).toBe('invalid-path');
    expect(await codeOf(readImageBytes(repo, '../outside.png', 'old'))).toBe('invalid-path');
  });

  test('new 侧超过 5MB 以 too-large 收尾，不读进内存', async () => {
    writeFileSync(join(root, 'big.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
    expect(await codeOf(readImageBytes(repo, 'big.png', 'new'))).toBe('too-large');
    // payload 那一步同样按侧卡：整个回 too-large，size 是超限那一侧的
    expect(await readDiff(root, { path: 'big.png' })).toEqual({
      kind: 'too-large',
      size: 5 * 1024 * 1024 + 1,
      reason: 'size',
    });
  });

  test('old 侧超过 5MB 时 too-large 报的是旧侧的体积，不是工作区那份小的', async () => {
    // 提交一张超限的图，再在工作区换成一张小的：固定报工作区体积时提示会说「file is 1 KB」
    const big = mkdtempSync(join(tmpdir(), 'difftab-bigimg-'));
    try {
      execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: big });
      writeFileSync(join(big, 'huge.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
      execFileSync('git', ['add', '-A'], { cwd: big });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], {
        cwd: big,
      });
      writeFileSync(join(big, 'huge.png'), tinyPng(PNG_RED));
      expect(await readDiff(big, { path: 'huge.png' })).toEqual({
        kind: 'too-large',
        size: 5 * 1024 * 1024 + 1,
        reason: 'size',
      });
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });
});

describe('baseBlobSize——cat-file -s', () => {
  test('基准里有的给字节数，没有的给 null 而不是抛', async () => {
    const { ref } = await resolveDiffBase(root);
    expect(await baseBlobSize(root, ref, 'img/a.png')).toBe(tinyPng(PNG_RED).length);
    expect(await baseBlobSize(root, ref, 'new.png')).toBeNull();
  });

  test('空仓库的基准是空树，任何路径都是 null', async () => {
    const { ref } = await resolveDiffBase(repos.empty);
    expect(await baseBlobSize(repos.empty, ref, 'anything.png')).toBeNull();
  });
});

describe('SVG 预览——文本那一支上挂的两侧元数据', () => {
  test('previewMimeOf 是图片表并上 svg；imageMimeOf 照旧不认 svg', () => {
    expect(previewMimeOf('img/Logo.SVG')).toBe('image/svg+xml');
    expect(previewMimeOf('a.png')).toBe('image/png');
    expect(previewMimeOf('a.txt')).toBeNull();
    expect(imageMimeOf('a.svg')).toBeNull();
  });

  test('改写的 SVG 仍是文本补丁，另带两侧预览，口径与图片同一份', async () => {
    const payload = await readDiff(root, { path: 'img/logo.svg' });
    if (payload.kind !== 'text') throw new Error(`期望 text，拿到 ${payload.kind}`);
    expect(payload.patch).toContain('+<rect width="4" height="4" fill="blue"/>');
    const info = statSync(join(root, 'img/logo.svg'));
    expect(payload.preview).toEqual({
      old: {
        path: 'img/logo.svg',
        size: SVG_RED.length,
        version: (await resolveDiffBase(root)).oid,
      },
      new: { path: 'img/logo.svg', size: SVG_BLUE.length, version: `${info.size}-${info.mtimeMs}` },
    });
  });

  test('整份上下文与忽略空白那两档同样带预览', async () => {
    const payload = await readDiff(root, {
      path: 'img/logo.svg',
      fullContext: true,
      ignoreWhitespace: true,
    });
    expect(payload).toMatchObject({ kind: 'text', full: true, preview: { old: {}, new: {} } });
  });

  test('未跟踪的 SVG 只有新侧', async () => {
    const payload = await readDiff(root, { path: 'new.svg' });
    expect(payload).toMatchObject({
      kind: 'untracked-text',
      preview: { old: null, new: { path: 'new.svg', size: SVG_RED.length } },
    });
  });

  test('对照面：非 svg 文本不带 preview；含 NUL 的 .svg 仍是 binary', async () => {
    expect(await readDiff(root, { path: 'fake.png' })).not.toHaveProperty('preview');
    expect(await readDiff(root, { path: 'binary.svg' })).toEqual({ kind: 'binary' });
    expect(await readFileContent(root, 'binary.svg')).toEqual({ kind: 'binary' });
  });

  test('文件视图：text 照旧给原文，另带工作区那份的 size / version', async () => {
    const info = statSync(join(root, 'img/logo.svg'));
    expect(await readFileContent(root, 'img/logo.svg')).toEqual({
      kind: 'text',
      content: SVG_BLUE,
      preview: { size: SVG_BLUE.length, version: `${info.size}-${info.mtimeMs}` },
    });
    expect(await readFileContent(root, 'README.md')).not.toHaveProperty('preview');
  });

  test('/api/blob 两侧给 svg 的字节与 image/svg+xml；含 NUL 的 .svg 不当图发', async () => {
    const fresh = await readImageBytes(repo, 'img/logo.svg', 'new');
    expect(fresh).toEqual({ buffer: Buffer.from(SVG_BLUE), mime: 'image/svg+xml' });
    const base = await readImageBytes(repo, 'img/logo.svg', 'old');
    expect(base.buffer.toString('utf8')).toBe(SVG_RED);
    expect(await codeOf(readImageBytes(repo, 'binary.svg', 'new'))).toBe('invalid-path');
  });

  test('任一侧超过 5MB 时补丁照给、只是不带预览', async () => {
    const big = mkdtempSync(join(tmpdir(), 'difftab-bigsvg-'));
    try {
      execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: big });
      // 6MB、四万行，只改最后一行：补丁只有几行、过得了全部三道闸，而两侧都过不了 /api/blob
      const body = `<!-- ${'padding '.repeat(18)}-->\n`.repeat(40_000);
      const svg = (fill: string) => `<svg>\n${body}<rect fill="${fill}"/>\n</svg>\n`;
      writeFileSync(join(big, 'huge.svg'), svg('red'));
      execFileSync('git', ['add', '-A'], { cwd: big });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], {
        cwd: big,
      });
      writeFileSync(join(big, 'huge.svg'), svg('blue'));
      expect(statSync(join(big, 'huge.svg')).size).toBeGreaterThan(5 * 1024 * 1024);
      const payload = await readDiff(big, { path: 'huge.svg' });
      expect(payload.kind).toBe('text');
      expect(payload).not.toHaveProperty('preview');
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });

  test('五万行以上、只改几行的 SVG：带预览，新侧的字节端点也不数行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'difftab-longsvg-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
    try {
      git('init', '--quiet', '--initial-branch=main');
      const svg = (fill: string) =>
        `<svg>\n${'<g/>\n'.repeat(60_000)}<rect fill="${fill}"/>\n</svg>\n`;
      writeFileSync(join(dir, 'long.svg'), svg('red'));
      git('add', '-A');
      git('commit', '-qm', 'i');
      writeFileSync(join(dir, 'long.svg'), svg('blue'));
      expect(await readDiff(dir, { path: 'long.svg' })).toMatchObject({
        kind: 'text',
        preview: { old: {}, new: {} },
      });
      const longRepo = await locateRepo(dir);
      expect((await readImageBytes(longRepo, 'long.svg', 'new')).buffer.toString('utf8')).toBe(
        svg('blue'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('符号链接的 .svg 不带预览：两侧取到的都是链接目标字符串', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'difftab-linksvg-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
    try {
      git('init', '--quiet', '--initial-branch=main');
      writeFileSync(join(dir, 'a.svg'), SVG_RED);
      writeFileSync(join(dir, 'b.svg'), SVG_BLUE);
      symlinkSync('a.svg', join(dir, 'logo.svg'));
      git('add', '-A');
      git('commit', '-qm', 'i');
      rmSync(join(dir, 'logo.svg'));
      symlinkSync('b.svg', join(dir, 'logo.svg'));
      const payload = await readDiff(dir, { path: 'logo.svg' });
      expect(payload.kind).toBe('text');
      expect(payload).not.toHaveProperty('preview');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('提交里的 SVG：两侧都读对象库，version 是两端的对象名', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'difftab-commitsvg-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: dir,
        encoding: 'utf8',
      }).trim();
    try {
      git('init', '--quiet', '--initial-branch=main');
      writeFileSync(join(dir, 'a.svg'), SVG_RED);
      git('add', '-A');
      git('commit', '-qm', 'add');
      writeFileSync(join(dir, 'a.svg'), SVG_BLUE);
      git('commit', '-qam', 'recolor');
      const [sha, parent] = [git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD~1')];
      const commitRepo = await locateRepo(dir);
      expect(await readCommitDiff(commitRepo, sha, { path: 'a.svg' })).toMatchObject({
        kind: 'text',
        preview: {
          old: { path: 'a.svg', size: SVG_RED.length, version: parent },
          new: { path: 'a.svg', size: SVG_BLUE.length, version: sha },
        },
      });
      const bytes = await readImageBytes(commitRepo, 'a.svg', 'old', sha);
      expect(bytes.buffer.toString('utf8')).toBe(SVG_RED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
