#!/usr/bin/env node
// GitGlance CLI 入口 —— 版本守卫。
//
// 本文件手写维护,不参与 TypeScript 编译、不作为任何打包入口(spec §5.1 / §10)。
// 一旦它进了构建管线,就可能被注入超出 Node 22 的语法或被合并进主模块,
// 低于下限的用户拿到的将是解析期 SyntaxError —— 守卫在解析期即失效。
//
// 因此这里只用「保守语法」:ES2015 之内,不使用可选链 / 空值合并 /
// 顶层 await / class 字段等更晚的语法。守卫通过后,才动态 import 主模块。

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
  process.stderr.write(
    'gitglance: requires Node.js ' +
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
    process.stderr.write(`gitglance: failed to start.\n${detail}\n`);
    process.exit(1);
  });
