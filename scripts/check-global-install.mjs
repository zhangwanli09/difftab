// `npm i -g difftab` 三端验收(spec §6 的全局安装项)。
//
// 打包 → 全局装 → **用装到 PATH 上的那个可执行文件**在一个真仓库里跑通 → 卸掉。
// 三件事一起证:产物清单齐全(缺文件时这里才炸,`check:pack` 只看清单)、Windows 的
// `.cmd` shim 起得来、以及全局目录里除了 difftab 自己什么都没多出来。
//
// **零依赖纯 JS,可由 `node scripts/check-global-install.mjs` 直接执行**(spec §5.11):
// 它要跑在 CI 上不装任何依赖的机器上。起进程与清理复用 `test/smoke/helpers.js`
// (同样零依赖)—— 尤其是"第一行是 URL"那个 ready 判据,不在这里再定义一遍。
// 前置条件只有两个 —— `dist/` 已就位(CI 里是下载的 artifact,本机需先 `pnpm build`),
// 以及全局尚未装着 difftab。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeDir, startDifftab, waitUntil } from '../test/smoke/helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const TARBALL = `${manifest.name}-${manifest.version}.tgz`;

/** 抛而不是 `process.exit()`:后者会跳过 `finally`,把全局包留在机器上。 */
class CheckFailed extends Error {}
function fail(message) {
  throw new CheckFailed(message);
}

/**
 * **必须 `shell: true`**:Windows 上 npm 是 `npm.cmd`,而 Node 自 CVE-2024-27980 起
 * 不再允许不经 shell 直接 spawn `.cmd`。
 *
 * 命令整条以字符串给出、**不传 args 数组**:`shell: true` 下 Node 只是把数组拼回
 * 一条命令行,还要为此打一行 DEP0190 弃用警告。拼接的活儿在这边做,引号由 `q()` 管。
 */
function run(commandLine, options = {}) {
  const r = spawnSync(commandLine, { encoding: 'utf8', shell: true, ...options });
  if (r.error) fail(`${commandLine} 起不来:${r.error.message}`);
  return r;
}

/**
 * 路径进 shell 前加引号。**不能用 `JSON.stringify`** —— 它会把 Windows 路径里的
 * `\` 转义成 `\\`,而 cmd 原样当两个反斜杠用。这些路径都来自 `os.tmpdir()`,
 * 不含引号,直接包一层双引号即可。
 */
const q = (path) => `"${path}"`;

/** 全局目录当前的条目。`.package-lock.json` 是 npm 自己的簿记,不是装进来的包。 */
function entriesOf(dir) {
  try {
    return readdirSync(dir).filter((name) => name !== '.package-lock.json');
  } catch {
    // 全新的机器上这个目录可能还不存在
    return [];
  }
}

const workdir = mkdtempSync(join(tmpdir(), 'difftab-globalinstall-'));
let installed = false;

try {
  if (!existsSync(join(REPO_ROOT, 'dist'))) {
    fail('dist/ 不存在 —— CI 里应先下载 artifact,本机先 pnpm build');
  }

  const rootQuery = run('npm root -g');
  if (rootQuery.status !== 0) fail(`npm root -g 失败:${rootQuery.stderr}`);
  const globalRoot = rootQuery.stdout.trim();
  const before = entriesOf(globalRoot);
  if (before.includes(manifest.name)) {
    fail(`全局已经装着 ${manifest.name} —— 先 npm rm -g 再跑,否则「多出了什么」无从判断`);
  }

  // `--ignore-scripts`:本仓库的 `prepublishOnly` 会调 pnpm,而这台机器上没有
  console.log('# npm pack');
  const packed = run(`npm pack --ignore-scripts --pack-destination ${q(workdir)}`, {
    cwd: REPO_ROOT,
  });
  if (packed.status !== 0) fail(`npm pack 失败:${packed.stderr}`);
  const tarball = join(workdir, TARBALL);
  // 名字自己拼、只验存在,不解析 npm 的输出 —— 那个格式随 npm 版本变,而 matrix 的
  // 三个 Node 自带三个不同的 npm
  if (!existsSync(tarball)) fail(`没打出 ${TARBALL}(${packed.stdout} ${packed.stderr})`);

  console.log('# npm i -g');
  const install = run(`npm i -g ${q(tarball)} --ignore-scripts`);
  if (install.status !== 0) fail(`npm i -g 失败:${install.stdout}\n${install.stderr}`);
  installed = true;

  /**
   * **零传递依赖的正面判据,两条对应依赖的两种落法**:npm 默认把传递依赖**提升**到
   * 全局根目录、与 difftab 平级(目录 diff 抓这一种),版本冲突时则**嵌套**进
   * `difftab/node_modules`(第二条抓这一种)。只写目录 diff 会漏掉嵌套那种,
   * 只看 `node_modules` 存不存在会漏掉提升那种 —— 而提升才是常态。
   *
   * manifest 那一侧另有 `check:pack` 盯着,与这里互补:manifest 干净而 `dist/` 里
   * import 了外部包时,只有真装一次才看得见。
   */
  const added = entriesOf(globalRoot).filter((name) => !before.includes(name));
  if (added.length !== 1 || added[0] !== manifest.name) {
    fail(`全局目录多出了 ${JSON.stringify(added)},期望只有 ["${manifest.name}"]`);
  }
  if (existsSync(join(globalRoot, manifest.name, 'node_modules'))) {
    fail(`${manifest.name}/node_modules 存在 —— 装进来了传递依赖`);
  }

  console.log('# difftab --version');
  const version = run(`${manifest.name} --version`);
  if (version.status !== 0) fail(`--version 以 ${version.status} 退出:${version.stderr}`);
  if (!version.stdout.includes(manifest.version)) {
    fail(`--version 没打印 ${manifest.version},实际是 ${JSON.stringify(version.stdout)}`);
  }

  /**
   * 真跑一次。**用的是 PATH 上那个名字**,不是 `node bin/difftab.js` —— Windows 上
   * 两者差着一个 `.cmd` shim,而冒烟套件走的全是后者,shim 坏了没有任何东西会响。
   *
   * 起进程与"第一行是 URL"这个 ready 判据都来自 `test/smoke/helpers.js`:自己再写一遍
   * 就等于给那个判据加了第三个定义(另外两个在 helpers 与 `scripts/bench-startup.mjs`),
   * 而 CLI 一旦在 URL 之前多打一行,三处会以三种完全不同的样子失败。
   */
  const repo = join(workdir, 'repo');
  mkdirSync(repo);
  for (const args of ['init --quiet', 'config user.email ci@example.com', 'config user.name ci']) {
    const r = run(`git ${args}`, { cwd: repo });
    if (r.status !== 0) fail(`git ${args} 失败:${r.stderr}`);
  }

  console.log('# 在一个真仓库里跑起来');
  const server = await startDifftab({
    cwd: repo,
    command: manifest.name,
    args: [],
    // Windows 上 `difftab` 是个 `.cmd` shim,不经 shell 起不来
    shell: true,
    // 没有客户端来连,让它按空闲退出自己收场(spec §5.8)—— 见下面为什么不 kill
    env: { DIFFTAB_IDLE_MS: '1000' },
  });

  /**
   * **不用 `server.stop()`,也不等 `'close'`**(2026-08-18 实测,CI 的 ubuntu 与
   * windows 两档):经 shell 起来时被 spawn 的是 shell,产品是它的**孙进程**,而
   * `'close'` 要等所有 stdio 管道关闭 —— 孙进程还攥着管道,于是杀掉 shell 之后
   * `'close'` 永远不来。症状是脚本停在这一行,Node 以「unsettled top-level await」
   * 退出码 13 收场,与"全局安装坏了"毫无相似之处(macOS 上 shell 直接 exec 掉自己,
   * 所以本机怎么跑都是绿的)。
   *
   * 改成等它自己按空闲退出、轮询 `exitCode`:`'exit'` 不依赖管道,而轮询的定时器
   * 顺便把事件循环撑着(ready 之后 helpers 会 unref 掉子进程)。
   */
  await waitUntil(() => server.child.exitCode !== null, 30_000, '全局装的那个 difftab 自行退出');
  if (server.child.exitCode !== 0) {
    fail(`空闲退出的退出码是 ${server.child.exitCode},期望 0。stderr=${server.stderr}`);
  }

  console.log(`PASS 全局安装可用(${process.platform} · Node ${process.versions.node})`);
} catch (cause) {
  console.error(cause instanceof CheckFailed ? `FAIL ${cause.message}` : cause);
  process.exitCode = 1;
} finally {
  // 卸干净:本机跑完不该留下一个全局包,CI 上则是让「多出了什么」这条判断下次仍成立。
  // **收尾的失败只警告**:`run()` 起不来会抛,而从 `finally` 抛出去会顶掉 catch 里
  // 正在报的那条真失败,变成一句莫名其妙的「npm rm -g 起不来」
  try {
    if (installed) run(`npm rm -g ${manifest.name}`);
  } catch (cause) {
    console.error(`# 卸载没成功(不影响上面的结论):${cause.message}`);
  }
  removeDir(workdir);
}
