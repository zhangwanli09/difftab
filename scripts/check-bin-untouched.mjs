#!/usr/bin/env node
// bin/difftab.js 以 100755 入库,且未被构建管线触碰。
//
// 一旦它进了构建管线,就可能被注入超出 Node 22 的语法、或被合并进主模块,低于下限的用户拿到
// 的将是解析期 SyntaxError —— 版本守卫在解析期即失效,而这**不报错**,只有在一台老 Node 的机
// 器上才会暴露。三项断言:该文件在 HEAD 与 index 两侧都以 100755 入库(理由见下方
// assertExecutableBit);跑完完整构建后与构建前逐字节一致;守卫的特征串没有出现在 dist/ 的任
// 何产物里 —— 若它被当作打包入口或被合并进主模块,那段文本必然会跟着进产物。
//
// 需要 pnpm(要跑构建),只在 CI 的 build 作业执行,不进 matrix 档。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const binPath = join(repoRoot, 'bin', 'difftab.js');
const distDir = join(repoRoot, 'dist');

/** 守卫里独一无二的一段文本;改这行文案时同步改这里。 */
const GUARD_MARKER = 'difftab: requires Node.js ';

const hash = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 断言 bin/difftab.js 以 100755 入库。
 *
 * npm 装 bin 时的 fixBin 会把 bin 目标 chmod 0755。在**本仓库目录里**跑 `npx difftab` 时,
 * npm exec 认出 cwd 的 package.json 自己就叫 difftab、带同名 bin,于是装的是一条指回工作区的
 * `file:` 链接 —— 被 chmod 的就是仓库里这个真文件。工作区因此冒出一个「内容零差异」的纯 mode
 * 变更;把它 discard 掉,下一次执行就是 `Permission denied`。
 *
 * 已有的门禁一条都看不见它:本脚本另外两项比的是**内容字节**(mode 不是内容),check:pack /
 * check:global 走的是 tarball —— 而 pnpm pack 会把 bin 归一成 0755,发出去的那份始终是对的。
 * 所以这里钉的是**仓库自己记的 mode**,不是 tarball 里的 mode。
 *
 * **HEAD 与 index 两侧都要查,只查 index 是不够的**:`git update-index --chmod=+x` 只写暂存
 * 区,而 fresh clone 拿到的是 HEAD 那份 —— 只查 index 时,一个「chmod 过、看见 PASS、但那次改
 * 动始终没进提交」的本机就绿了,而 CI 上 index 恒等于 HEAD,于是这道门禁会恰好在它唯一要保护
 * 的地方(开发者本机)最弱。
 */
function readGitMode(args, what) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  // 拿不到记录一律 FAIL,不得跳过 —— 否则 mode 断言会对着一个空字符串静默通过(`git ls-files
  // -s` 对未跟踪路径就是 exit 0 + 空 stdout),与主门禁那条「确实记到了东西」同一条道理。
  if (r.status !== 0 || typeof r.stdout !== 'string' || r.stdout.trim() === '') {
    // git 压根起不来时 status / stdout / stderr 全是 null,病因只在 r.error 里 ——
    // 不带上它,报错会长成"读不到 index 记录",把人支去查一个根本不缺的条目。
    const why = [r.error?.message, (r.stderr ?? '').trim()].filter(Boolean).join('\n');
    console.error(
      `check-bin-untouched: 读不到 bin/difftab.js 的 ${what} 记录(git exit ${r.status})。` +
        (why ? `\n${why}` : ''),
    );
    process.exit(1);
  }
  return r.stdout.trim().split(/\s+/)[0];
}

function assertExecutableBit() {
  const headMode = readGitMode(['ls-tree', 'HEAD', '--', 'bin/difftab.js'], 'HEAD');
  const indexMode = readGitMode(['ls-files', '-s', '--', 'bin/difftab.js'], 'index');

  if (headMode === '100755' && indexMode === '100755') {
    console.log('PASS  bin/difftab.js 以 100755 入库(HEAD 与 index 两侧一致)');
    return;
  }

  const staged = headMode !== '100755' && indexMode === '100755';
  console.error(
    `FAIL bin/difftab.js 缺可执行位(HEAD=${headMode} / index=${indexMode})。\n` +
      '      在本仓库目录里跑 `npx difftab` 时,npm 会 chmod 工作区里的这个文件,\n' +
      '      于是冒出一个内容零差异的变更;把它 discard 掉,下一次执行就是 Permission denied。\n' +
      (staged
        ? '      可执行位只到了暂存区 —— 提交之后 clone 下来的人才拿得到,所以这里仍然红。'
        : '      修法:chmod +x bin/difftab.js && git update-index --chmod=+x bin/difftab.js'),
  );
  process.exit(1);
}

assertExecutableBit();

const before = readFileSync(binPath);
if (!before.includes(GUARD_MARKER)) {
  console.error(
    `check-bin-untouched: bin/difftab.js 里找不到守卫特征串 "${GUARD_MARKER}"。\n` +
      '文案改了就把本脚本的 GUARD_MARKER 一并改掉 —— 否则第 3 项断言会静默失效。',
  );
  process.exit(1);
}

const build = spawnSync('pnpm', ['run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.status !== 0) {
  console.error('check-bin-untouched: 构建失败。');
  process.exit(1);
}

const after = readFileSync(binPath);
if (hash(before) !== hash(after)) {
  console.error('FAIL 构建改动了 bin/difftab.js —— 它进了构建管线,版本守卫已不可信。');
  process.exit(1);
}
console.log('PASS  构建前后 bin/difftab.js 逐字节一致');

const leaked = readdirSync(distDir, { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name))
  .filter((f) => readFileSync(f, 'utf8').includes(GUARD_MARKER));

if (leaked.length > 0) {
  console.error(
    `FAIL  守卫代码出现在构建产物里:${leaked.map((f) => relative(repoRoot, f)).join(', ')}\n` +
      '      说明 bin/difftab.js 被当作了打包入口或被合并进主模块。',
  );
  process.exit(1);
}
console.log('PASS  守卫代码未出现在 dist/ 的任何产物中');
