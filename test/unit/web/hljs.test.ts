// hljs 语言装配的回归测试。两件事:
//
// 1. **清单本身钉死。** 下面的 EXPECTED 是手写的字面量,不是从被测模块导出的东西 —— 拿
//    REGISTERED_LANGUAGES 去遍历 REGISTERED_LANGUAGES 只能证明 registerLanguage 本身没坏。删掉
//    一个语言的 import 与它的 LANGUAGES 条目,typecheck 过、其余断言全过,体积门禁还因为变小而
//    过得更宽松,该语言的 diff 就此静默不着色。清单是白名单与 JS 预算的主导项,必须对着约定校,
//    不能对着自己校。
// 2. **未命中的语言退化为 plaintext 且不报错。** 这条不是自动成立的:diff2html 的
//    highlightCode() 对未知扩展名与无扩展名文件会把语言改写成字面量 'plaintext' 再无条件调
//    hljs.highlight,而 lib/core 不自带 plaintext 模块 —— 漏注册时异常冒到调用方,整个 diff 视图
//    渲染失败。

import { describe, expect, it } from 'vitest';
import { getHljs, REGISTERED_LANGUAGES } from '../../../src/web/diff/hljs';

/** 逐字列出的 22 个真实语言模块,外加兜底用的 plaintext。 */
const EXPECTED = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'go',
  'ini',
  'java',
  'javascript',
  'json',
  'kotlin',
  'markdown',
  'php',
  'plaintext',
  'python',
  'ruby',
  'rust',
  'scss',
  'sql',
  'swift',
  'typescript',
  'xml',
  'yaml',
];

describe('hljs 语言装配', () => {
  it('注册结果与清单逐字相等 —— 多一个少一个都失败', () => {
    // listLanguages() 返回的是注册名,不含别名(已实测),所以可以直接做集合相等
    const actual = getHljs().listLanguages().slice().sort();
    expect(actual).toEqual(EXPECTED.slice().sort());
    // 导出给外部用的清单不能与实际注册的偏离
    expect(REGISTERED_LANGUAGES.slice().sort()).toEqual(actual);
  });

  it('plaintext 兜底可用 —— 这是清单外语言不炸整个视图的前提', () => {
    const hljs = getHljs();
    expect(hljs.getLanguage('plaintext')).toBeDefined();
    expect(() =>
      hljs.highlight('LICENSE has no extension', { language: 'plaintext' }),
    ).not.toThrow();
  });

  it('别名随主模块生效,不需要也不存在单独的模块', () => {
    const hljs = getHljs();
    // 这四个是别名而非模块:highlight.js/lib/languages/{jsx,tsx,toml} 路径不存在、html 属 xml,单
    // 独 import 会在构建期 resolve 失败。上面那条集合相等已保证它们不在注册名里,这里补「别名可用」
    for (const alias of ['jsx', 'tsx', 'toml', 'html']) {
      expect(hljs.getLanguage(alias), `别名 ${alias} 未生效`).toBeDefined();
    }
  });
});
