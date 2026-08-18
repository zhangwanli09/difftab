// 冒烟测试:纯 JS,跑 dist/ 产物(spec §5.11 CI 分层)。
//
// 由 CI 的 matrix 作业用 `node --test test/smoke/` 直接打到本文件 ——
// 那一档完全不执行安装、也没有 pnpm,因此这里不得 import 任何依赖。
//
// 本文件管的是**进不去产品之前**的那几件事:版本守卫、产物形态,以及 bare 仓库
// 那条拒绝(「不是仓库」那条在 server.test.js,两者共用 helpers 的
// `expectStartupRefusal`)。起得来之后的行为归 server.test.js,只读性两层归
// readonly*.test.js,生命周期归 lifecycle.test.js。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeFixtures } from '../fixtures/make.mjs';
import { BIN, cleanupOnExit, expectStartupRefusal, REPO_ROOT } from './helpers.js';

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

/** 下限的唯一事实来源是 package.json 的 engines.node;守卫的文案必须与它一致。 */
const MIN_VERSION = /(\d+\.\d+\.\d+)/.exec(manifest.engines.node)?.[1];

test('CLI 在当前 Node 上正常启动并退出 0,且报的版本就是 package.json 的版本', () => {
  const r = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);

  // 只断言形状的话,版本号漂移(改了 package.json 忘了改代码)照样能过 ——
  // 必须钉到同一个值上,否则这条测试守不住它唯一该守的东西
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.equal(r.stdout.trim(), `gitglance ${manifest.version}`);
});

test('版本守卫:低于下限时打印友好提示并以非 0 退出,而不是 SyntaxError', () => {
  // 直接改写 process.versions.node(descriptor 为 configurable),
  // 比在 CI 上真的装一个过期 Node 更可控。
  // 注意这只能证「守卫执行后的行为」—— 本进程跑在 ≥22 上,bin 早已解析成功。
  // 「在真正的低版本 Node 上不是 SyntaxError」由 CI 的 old-node-guard 作业断言。
  assert.ok(MIN_VERSION, `engines.node 里读不出下限版本:${manifest.engines?.node}`);
  const belowFloor = `${Number(MIN_VERSION.split('.')[0]) - 1}.19.0`;

  const spoof = [
    `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(belowFloor)} });`,
    `await import(${JSON.stringify(pathToFileURL(BIN).href)});`,
  ].join('\n');

  const r = spawnSync(process.execPath, ['--input-type=module', '-e', spoof], {
    encoding: 'utf8',
  });

  assert.equal(r.status, 1, `期望以 1 退出;stdout: ${r.stdout} stderr: ${r.stderr}`);
  // 文案里的版本号必须与 engines.node 一致 —— 硬编码 22.0.0 的话,
  // 提下限时守卫拒对了人却报错了版本,而这条断言照样绿
  assert.match(
    r.stderr,
    new RegExp(`requires Node\\.js ${MIN_VERSION.replace(/\./g, '\\.')} or newer`),
  );
  assert.doesNotMatch(r.stderr, /SyntaxError/);
  // 守卫必须先于主模块加载执行:不能出现主模块的任何输出
  assert.equal(r.stdout, '');
});

test('后端产物只 import 标准库 —— dependencies 为空这条在产物侧的对应断言', () => {
  // package.json 侧由 scripts/check-pack.mjs 查(那个要 pnpm、只在 build 作业跑);
  // 这里查真正发给用户的那个文件,不依赖 manifest 是否诚实。
  const source = readFileSync(join(REPO_ROOT, 'dist', 'server', 'main.js'), 'utf8');

  const specifiers = [
    ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);

  assert.ok(specifiers.length > 0, '一个 import 都没扫到,正则多半失配了 —— 这条断言等于没跑');

  const external = specifiers.filter((s) => !s.startsWith('node:'));
  assert.deepEqual(
    external,
    [],
    `dist/server/main.js 引用了非标准库模块:${external.join(', ')}。后端只用标准库(CLAUDE.md §5 红线)`,
  );
});

let workdir;
cleanupOnExit(() => workdir);

test('bare 仓库:一句话说清没有工作区,而不是 Node 异常栈', () => {
  // §6 的 `[S4b]`。**必须在产物上端到端验**:`rev-parse --show-toplevel` 在 bare 下
  // 以 128 退出(已实测),而「128 退出」既可能被收成这句话,也可能一路冒成一屏栈 ——
  // 单测里那条 `rejects.toMatchObject({ code: 'bare-repo' })` 证到的是前一半
  workdir = mkdtempSync(join(tmpdir(), 'gitglance-bare-'));
  const repos = makeFixtures(join(workdir, 'repos'), ['bare']);

  // 「退出码 / 空 stdout / 不带栈」三条归 helpers(不是仓库那条用的是同一份),
  // 这里只断言 bare 自己那句话 —— 两者的提示完全不同,合并成一句会误导用户
  assert.match(expectStartupRefusal(assert, repos.bare), /bare repository/);
});

/**
 * 只留下**代码行**:整行的 `//`、`/*`、`*`(JSDoc 续行)一律剔掉。
 *
 * 下面两条都是对源码做正则扫描,而本文件的注释里**恰好写满了它要禁的东西** ——
 * 「为什么不用 `process.stderr.write`」那段说明就含着那个字面量。不剔注释的话,
 * 越是把理由写清楚的文件越容易假红。
 *
 * 不用"砍掉行内 `//` 之后的部分"那种写法:`https://nodejs.org/` 就在一个字符串里,
 * 那样会把半行代码一起砍掉,而砍掉的部分正是可能藏着违规写法的地方 —— 假绿比假红糟。
 */
function codeLines(source) {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

test('bin/gitglance.js 退出前的报错一律 writeSync(2, …)', () => {
  /**
   * spec §5.8 的红线:`process.stderr.write` + `process.exit()` 在 Windows 上写**管道**
   * 时是异步的,整条消息会被丢掉,症状是 stderr 全空。
   *
   * **静态扫描而不是跑一遍**:本文件里两个出口(版本守卫、动态 import 失败)只有前者
   * 在 CI 上被真的执行过(`old-node-guard` 那一档),后者要构造一个坏掉的 `dist/` 才
   * 走得到 —— 而红线对两者一视同仁。一条正则同时罩住它们,以及将来添的第三个。
   */
  assert.doesNotMatch(
    codeLines(readFileSync(BIN, 'utf8')),
    /process\.stderr\.write|console\.error/,
    'bin/gitglance.js 出现了 process.stderr.write / console.error —— 退出前的报错必须走 writeSync(2, …)',
  );
});

test('bin/gitglance.js 保持保守语法:不含守卫之后才安全的语法', () => {
  const source = codeLines(readFileSync(BIN, 'utf8'));
  // 逐条对应 spec §5.1:守卫与新语法同处一个模块时,低于下限的用户拿到的是
  // 解析期 SyntaxError,守卫根本来不及执行
  const forbidden = [
    [/\?\./, '可选链 ?.'],
    [/\?\?/, '空值合并 ??'],
    [/^\s*await\s/m, '顶层 await'],
    [/#[A-Za-z_]/, 'class 私有字段 #x'],
    [/\|\|=|&&=/, '逻辑赋值 ||= / &&='],
  ];
  for (const [pattern, name] of forbidden) {
    assert.equal(pattern.test(source), false, `bin/gitglance.js 出现了${name}`);
  }
});
