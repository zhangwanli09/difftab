#!/usr/bin/env node
// difftab CLI 入口 —— 版本守卫。
//
// 本文件手写维护,不参与 TypeScript 编译、不作为任何打包入口。
// 一旦它进了构建管线,就可能被注入超出 Node 22 的语法或被合并进主模块,
// 低于下限的用户拿到的将是解析期 SyntaxError —— 守卫在解析期即失效。
//
// 因此这里只用「保守语法」:ES2015 之内,不使用可选链 / 空值合并 /
// 顶层 await / class 字段等更晚的语法。守卫通过后,才动态 import 主模块。
//
// `node:fs` 是**内建模块**,静态 import 它不违反上面那条 —— 守卫要防的是「解析期就
// 炸掉」与「把主模块的新语法拖进来」,而内建模块两条都不沾,且在 Node 12 起就支持
// `node:` 前缀。写成静态 import 而不是在分支里动态 import:那条路要么 `await`
// (顶层 await 正是禁项),要么把报错塞进 `.then()` 回调里,而回调里的 `process.exit()`
// 与本文件要修的问题是同一类。

import { writeSync } from 'node:fs';

/**
 * 退出前的报错**一律 `writeSync(2, …)`**(红线)。
 *
 * `process.stderr.write(…)` + `process.exit()` 在 Windows 上写**管道**时是异步的,
 * 整条消息会被丢掉 —— 症状是 stderr 全空、只剩一个退出码。而**文件重定向看不出
 * 区别**(那条是同步写),所以门禁那侧必须经管道取回 stderr,见 CI 的 old-node-guard。
 *
 * try/catch 是因为读端可能先走(`difftab | head -1`):此刻要报的是别的事,
 * 不该被一个 EPIPE 顶掉。
 */
function writeStderr(message) {
  try {
    writeSync(2, message);
  } catch (_cause) {
    // 报不出来就算了 —— 退出码仍然是对的。
    // 绑定写成 `_cause` 而不是省略:可选 catch 绑定是 ES2019,本文件只用 ES2015
  }
}

// 下限只写一次。写成两个常量时,把 MIN_MAJOR 提到 24 却忘了改 MIN_VERSION,
// 结果是守卫正确地拒掉 Node 22、却告诉用户「requires Node.js 22.0.0 or newer,
// but this is v22.5.0」—— 没有任何门禁会因此变红。
// 与 package.json 的 engines.node 对齐由冒烟测试断言。
const MIN_MAJOR = 22;
const MIN_VERSION = `${MIN_MAJOR}.0.0`;

const raw = process.versions.node;
const major = parseInt(raw.split('.')[0], 10);

// 写成 !(major >= MIN_MAJOR) 而非 major < MIN_MAJOR:解析失败得到 NaN 时同样报错。
if (!(major >= MIN_MAJOR)) {
  writeStderr(
    'difftab: requires Node.js ' +
      MIN_VERSION +
      ' or newer, but this is v' +
      raw +
      '.\n' +
      'Please upgrade Node.js and try again: https://nodejs.org/\n',
  );
  process.exit(1);
}

import('../dist/server/main.js')
  .then((mod) => mod.main(process.argv.slice(2)))
  .catch((err) => {
    const detail = err && err.stack ? err.stack : String(err);
    writeStderr(`difftab: failed to start.\n${detail}\n`);
    process.exit(1);
  });
