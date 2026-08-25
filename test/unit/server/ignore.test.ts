// 三档共用的忽略判据(src/server/watch/ignore.ts)。
//
// 这里钉的是**两种字符串写法各自的失效形态**:整份判据是纯函数,而它要替代的东西
// (`ignore: 'node_modules'` / `'node_modules/**'`)在某些平台上碰巧也能工作,
// 于是「改成字符串模式」在本机上未必红。逐条写出来,是为了让那次改动在**任何**
// 平台上都至少红一条。

import { describe, expect, test } from 'vitest';
import { createIsIgnored, isIgnored } from '../../../src/server/watch/ignore.ts';

describe('isIgnored 是逐段匹配', () => {
  test('嵌套路径命中 —— basename 模式正是在这里失效的', () => {
    // macOS / Windows 的原生 watcher 交给匹配器的是**事件的相对路径**,
    // 而 minimatch 的 matchBase 只把单段模式与 basename 比:`node_modules/.bin/foo`
    // 的 basename 是 `foo`,模式 `node_modules` 匹配不上,事件照常放行
    expect(isIgnored('node_modules/.bin/foo')).toBe(true);
    expect(isIgnored('node_modules/pkg/lib/index.js')).toBe(true);
    // monorepo 里的嵌套依赖 —— `node_modules/**` 这类含斜杠的模式在这里也落空
    expect(isIgnored('packages/web/node_modules/pkg/index.js')).toBe(true);
    // 目录自身:含斜杠的模式匹配不到它,于是会白白递归进去一层
    expect(isIgnored('node_modules')).toBe(true);
  });

  test('清单里的其余几个同样逐段生效', () => {
    for (const path of ['dist/main.js', 'a/b/target/debug/x', '.next/cache/y', 'web/build/z']) {
      expect(isIgnored(path)).toBe(true);
    }
    // `.git` 与档位无关地被排除:工作区那条递归 watch 绝不能进去(一次 gc 就是
    // 几万个条目),`.git` 侧另有目录级非递归 watch 盯着
    expect(isIgnored('.git/objects/ab/cdef')).toBe(true);
  });

  test('反斜杠路径同样切开 —— Windows 的原生 watcher 给的就是它', () => {
    expect(isIgnored('node_modules\\pkg\\index.js')).toBe(true);
    expect(isIgnored('packages\\web\\node_modules\\x')).toBe(true);
  });

  test('只匹配整段,不匹配前缀 —— 否则会误伤用户自己的文件', () => {
    // 「包含 node_modules 就忽略」这种写法会把这几个也吞掉,而它们是真实的仓库内容,
    // 症状是「改了这个文件页面死活不刷新」
    expect(isIgnored('src/node_modules_shim.ts')).toBe(false);
    expect(isIgnored('src/distribute.ts')).toBe(false);
    expect(isIgnored('my-build/x.ts')).toBe(false);
    expect(isIgnored('src/a.ts')).toBe(false);
    expect(isIgnored('README.md')).toBe(false);
  });
});

describe('大小写按平台归一', () => {
  test('macOS / Windows 归一,对齐 ignore 内部的 nocase', () => {
    for (const platform of ['darwin', 'win32']) {
      expect(createIsIgnored(platform)('Node_Modules/pkg/x.js')).toBe(true);
      expect(createIsIgnored(platform)('DIST/main.js')).toBe(true);
    }
  });

  test('Linux 原样比较 —— 那里 Node_Modules 是另一个目录', () => {
    // 归一等于把一个用户真的想看的目录悄悄屏蔽掉,而屏蔽是静默的
    expect(createIsIgnored('linux')('Node_Modules/pkg/x.js')).toBe(false);
    expect(createIsIgnored('linux')('node_modules/pkg/x.js')).toBe(true);
  });
});
