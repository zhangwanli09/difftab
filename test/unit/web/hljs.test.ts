// hljs 语言装配的回归测试。两件事：
//
// 1. **清单本身钉死。** 下面的 EXPECTED 是手写的字面量，不是从被测模块导出的东西——拿
//    REGISTERED_LANGUAGES 去遍历 REGISTERED_LANGUAGES 只能证明 registerLanguage 本身没坏。删掉
//    一个语言的 import 与它的 LANGUAGES 条目，typecheck 过、其余断言全过，体积门禁还因为变小而
//    过得更宽松，该语言的 diff 就此静默不着色。清单是白名单与 JS 预算的主导项，必须对着约定校，
//    不能对着自己校。
// 2. **补漏表只映射到注册过的模块，且只收第三道接不住的。** 映射到一个没注册的名字时 `getLanguage()` 探测不到，那个文
//    件静默退回 plaintext——与压根没映射一模一样，没有任何东西会响。
// 3. **第三道（diff2html 的 `languagesToExt`）不能丢。** 它比「补漏表 + hljs 别名」多认 88 个扩展
//    名（`pyi` / `jsonl` / `rake` …），砍掉它时那些文件在 diff 视图里从有色退回纯文本，页面上没有
//    任何提示；而它的结果同样要过 `getLanguage()`——上游认得、我们没注册的（`lua` / `dockerfile`）
//    必须继续退回 plaintext，否则 `highlight()` 当场抛。
// 4. **未命中的语言退化为 plaintext 且不报错。** 这条不是自动成立的：diff2html 的
//    highlightCode() 对未知扩展名与无扩展名文件会把语言改写成字面量 'plaintext' 再无条件调
//    hljs.highlight，而 lib/core 不自带 plaintext 模块——漏注册时异常冒到调用方，整个 diff 视图
//    渲染失败。

import { getLanguage as upstreamExtensionLanguage } from 'diff2html/lib-esm/ui/js/highlight.js-helpers.js';
import { describe, expect, it } from 'vitest';
import {
  createLineLanguage,
  EXTRA_ALIASES,
  getHljs,
  languageOf,
  REGISTERED_LANGUAGES,
} from '../../../src/web/diff/hljs';

/** 逐字列出的 22 个真实语言模块，外加兜底用的 plaintext。 */
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
  it('注册结果与清单逐字相等——多一个少一个都失败', () => {
    // listLanguages() 返回的是注册名，不含别名（已实测），所以可以直接做集合相等
    const actual = getHljs().listLanguages().slice().sort();
    expect(actual).toEqual(EXPECTED.slice().sort());
    // 导出给外部用的清单不能与实际注册的偏离
    expect(REGISTERED_LANGUAGES.slice().sort()).toEqual(actual);
  });

  it('plaintext 兜底可用——这是清单外语言不炸整个视图的前提', () => {
    const hljs = getHljs();
    expect(hljs.getLanguage('plaintext')).toBeDefined();
    expect(() =>
      hljs.highlight('LICENSE has no extension', { language: 'plaintext' }),
    ).not.toThrow();
  });

  it('别名随主模块生效，不需要也不存在单独的模块', () => {
    const hljs = getHljs();
    // 这四个是别名而非模块：highlight.js/lib/languages/{jsx,tsx,toml} 路径不存在、html 属 xml，单
    // 独 import 会在构建期 resolve 失败。上面那条集合相等已保证它们不在注册名里，这里补「别名可用」
    for (const alias of ['jsx', 'tsx', 'toml', 'html']) {
      expect(hljs.getLanguage(alias), `别名 ${alias} 未生效`).toBeDefined();
    }
  });
});

describe('languageOf', () => {
  it('补漏表的值全都在注册清单里', () => {
    // 映射到一个没注册的名字（`dockerfile` / `properties` 之类）时，那一路静默退回 plaintext，
    // 页面上与「压根没映射」分不出来
    const targets = Object.values(EXTRA_ALIASES);
    // 正面断言：表真的有内容——空表会让下面那个循环一次都不跑，断言无条件通过
    expect(targets.length).toBeGreaterThan(0);
    for (const language of targets) {
      expect(REGISTERED_LANGUAGES, `${language} 不在注册清单里`).toContain(language);
    }
  });

  it('补漏表里没有第三道已经判得对的条目', () => {
    // 收录判据是「前两道与第三道都接不住」。第三道自己就判得对的（`cfg` 上游本来就映到 `ini`）
    // 收进来只是把上游那张表抄了一行——不报错，只是那份抄件此后不跟着上游走。这条用例是那个判
    // 据的机器可检形式：人眼对着 86 条上游映射逐个核是核不动的
    for (const [ext, ours] of Object.entries(EXTRA_ALIASES)) {
      const upstream = upstreamExtensionLanguage(ext);
      const third = getHljs().getLanguage(upstream) ? upstream : 'plaintext';
      expect(third, `${ext} 交给第三道就够了，不该进补漏表`).not.toBe(ours);
    }
  });

  // 上游没有 vue / svelte / env 模块，这几条全靠补漏表；`.env.local` 那两条靠的是按文件名的规则
  // （它们的「扩展名」是 local / production）
  it.each([
    ['src/App.vue', 'xml'],
    ['Widget.svelte', 'xml'],
    ['pages/index.astro', 'xml'],
    ['.env', 'ini'],
    ['.env.local', 'ini'],
    ['apps/web/.env.production', 'ini'],
    ['gradle.properties', 'ini'],
  ])('%s → %s', (path, language) => {
    expect(languageOf(path)).toBe(language);
  });

  // 这几条一条都不该进补漏表——它们由模块自带的 aliases 命中。抄进表里不会报错，只会让那张
  // 表变成语言清单的第二份拷贝，而增删模块时没有任何东西提醒你改它
  it.each([
    ['src/a.ts', 'ts'],
    ['src/a.tsx', 'tsx'],
    ['scripts/x.mjs', 'mjs'],
    ['Cargo.toml', 'toml'],
    ['.github/workflows/ci.yml', 'yml'],
  ])('%s → %s（模块自带别名，不进补漏表）', (path, alias) => {
    expect(languageOf(path)).toBe(alias);
    expect(getHljs().getLanguage(alias)).toBeDefined();
    expect(EXTRA_ALIASES).not.toHaveProperty(alias);
  });

  // 第三道：hljs 有这个模块，只是它的 aliases 没覆盖到这个扩展名。这些**刻意不进补漏表**——
  // 抄进来的那份不会跟着上游更新，而这一道白拿（那张表随 diff2html-ui-base 早就在产物里）
  it.each([
    ['types.pyi', 'python'],
    ['data.jsonl', 'json'],
    ['tasks.rake', 'ruby'],
    ['schema.mysql', 'sql'],
    ['legacy.es6', 'javascript'],
  ])('%s → %s（上游那张 languagesToExt 兜底）', (path, language) => {
    expect(languageOf(path)).toBe(language);
  });

  // 补漏表排在第三道之前，不是之后：上游把 properties 映到同名的 properties 模块，而我们没注册
  // 它——让给上游就是静默退回 plaintext
  it('两边都认的扩展名按我们的判：gradle.properties → ini 而不是 plaintext', () => {
    expect(languageOf('gradle.properties')).toBe('ini');
  });

  // 第三道的结果同样要过 getLanguage()：上游认得、我们没注册的语言不能直接交给 highlight()
  it.each(['lua', 'dockerfile', 'r'])(
    '.%s → plaintext（上游认得，但那个模块我们没注册）',
    (ext) => {
      // 正面断言：上游确实给出了一个语言名——少了它，下面那条在任何认不出的扩展名上都通过
      expect(upstreamExtensionLanguage(ext)).not.toBe('plaintext');
      expect(getHljs().getLanguage(upstreamExtensionLanguage(ext))).toBeUndefined();
      // 于是必须被我们这道过滤挡回 plaintext：直接交给 highlight() 是当场抛
      expect(languageOf(`file.${ext}`)).toBe('plaintext');
    },
  );

  it.each(['LICENSE', 'notes.unknown-ext', 'a/b/Dockerfile'])('%s → plaintext 兜底', (path) => {
    expect(languageOf(path)).toBe('plaintext');
  });

  // 两张表都是对象字面量，`表[ext]` 会走到 Object.prototype 上去——取出来的是**函数**，而
  // hljs.getLanguage() 对它当场抛，异常冒上去炸的是整个 diff 视图 / 文件面板。而入参是文件名
  // 与文件内容，不是我们写死的字面量
  it.each(['a.constructor', 'a.toString', 'a.hasOwnProperty', 'a.__proto__'])(
    '%s 不抛，退回 plaintext（表撞上 Object.prototype 的键）',
    (path) => {
      expect(() => languageOf(path)).not.toThrow();
      expect(languageOf(path)).toBe('plaintext');
    },
  );

  it('.env 那条规则只多认一段，且那一段不含点', () => {
    // 写成 `(\..+)?` 时 `.env.d.ts` 也会被判成 ini——它是 TypeScript
    expect(languageOf('.env.d.ts')).toBe('ts');
    // 正面断言：本来要接住的那两个仍然命中
    expect(languageOf('.env.local')).toBe('ini');
    expect(languageOf('.env')).toBe('ini');
  });
});

// 逐行判定器。**这是 diff 视图里 SFC 有没有颜色的全部机制**：diff2html 一行一次
// hljs.highlight()，跨行状态一律不保留——`<script>` 里的 `import { ref } from 'vue'` 按 xml 高亮
// 出来一个 span 都没有（实测），页面上就是那一段整块白。
describe('createLineLanguage', () => {
  /** 一份 SFC 的行序，按顺序喂给判定器。 */
  const SFC_LINES = [
    ['<script setup lang="ts">', 'xml'],
    // `ts` 是 typescript 模块的别名，hljs.highlight() 直接吃得下——这里不做名字归一化：
    // 归一化要么写第二张「别名 → 注册名」的表，要么落到 getLanguage()?.name（那是显示名）
    ["import { ref } from 'vue'", 'ts'],
    ['const n = ref(0)', 'ts'],
    ['</script>', 'xml'],
    ['', 'xml'],
    ['<template>', 'xml'],
    ['  <div :class="c">{{ n }}</div>', 'xml'],
    ['</template>', 'xml'],
    ['<style scoped>', 'xml'],
    ['.card { color: red; }', 'css'],
    ['</style>', 'xml'],
  ] as const;

  it('.vue：按区块换语言，标签行自己仍是 xml', () => {
    const languageAt = createLineLanguage('src/App.vue');
    // 区块标签行自己按 xml 判——它是标签，不是被它括起来的那段代码
    for (const [text, language] of SFC_LINES) {
      expect(languageAt(text), `「${text}」判错了`).toBe(language);
    }
  });

  it('lang 属性走同一条 languageOf；判不出来时退回区块默认值而不是 plaintext', () => {
    const ts = createLineLanguage('a.vue');
    ts('<script lang="ts">');
    expect(ts('const x = 1')).toBe('ts');

    const scss = createLineLanguage('a.vue');
    scss('<style lang="scss">');
    expect(scss('.a { .b { color: red } }')).toBe('scss');

    // pug 我们没注册：退回 plaintext 会把一段本来还能按 xml 上色的模板整个抹白
    const pug = createLineLanguage('a.vue');
    pug('<template lang="pug">');
    expect(pug('div.card')).toBe('xml');

    // script 没写 lang 就是 javascript，不是 typescript
    const js = createLineLanguage('a.vue');
    js('<script setup>');
    expect(js('const x = 1')).toBe('javascript');
  });

  it('一行开闭的区块不进入那个区块——外置块写法之后不能整份变 JS', () => {
    const languageAt = createLineLanguage('a.vue');
    // Vue 的外置块：`<script src>` / `<template src>` 都是一行开闭。漏判时状态再也回不来，
    // 那之后的每一行（模板、样式全在内）都按 JS 高亮，页面上不报错、只是一整片乱着色
    expect(languageAt('<script src="./App.js"></script>')).toBe('xml');
    expect(languageAt('<div>x</div>')).toBe('xml');

    expect(languageAt('<style scoped>.a { color: red }</style>')).toBe('xml');
    expect(languageAt('<p>y</p>')).toBe('xml');

    // 正面断言：真正跨行的区块照常进得去——否则上面两条在一个「永远返回 base」的实现上也过
    languageAt('<script setup>');
    expect(languageAt('const x = 1')).toBe('javascript');
  });

  it('看不见起始标签的 hunk 保守停在 base——猜错语言比没颜色更糟', () => {
    // 只改了 <script> 中间几行的 hunk：判定器从头到尾没见过 <script>
    const languageAt = createLineLanguage('a.vue');
    expect(languageAt('  const x = 1')).toBe('xml');
    expect(languageAt('  return x')).toBe('xml');
  });

  // 三个 SFC 扩展名是一份名单：补漏表里的 `→ xml` 由它展开，状态机的开关也用它。逐字列在这里
  // 而不是 import 那个 Set——拿被测代码去校被测代码只能证明展开语句本身没坏
  it.each(['a.vue', 'a.svelte', 'a.astro'])('%s 启用区块状态机', (path) => {
    const languageAt = createLineLanguage(path);
    expect(languageAt('<template>')).toBe('xml');
    languageAt('<style>');
    expect(languageAt('.a { color: red }')).toBe('css');
  });

  it('xaml 同样映射到 xml，但不进状态机——它不是三段式组件', () => {
    expect(languageOf('Window.xaml')).toBe('xml');
    const languageAt = createLineLanguage('Window.xaml');
    languageAt('<style>');
    // 状态机没启用：`<style>` 之后仍是 xml，而不是 css
    expect(languageAt('.a { color: red }')).toBe('xml');
  });

  it('非 SFC 的文件从头到尾一个语言——不为它跑状态机', () => {
    const languageAt = createLineLanguage('src/a.ts');
    // `<script>` 出现在一个 .ts 文件里（字符串、注释里都可能）不该切走语言
    for (const text of ['const a = 1', '<script setup>', 'const b = 2']) {
      expect(languageAt(text)).toBe('ts');
    }
  });
});
