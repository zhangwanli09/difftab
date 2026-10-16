// 解析 + 配对 + 上色（`prepareDiff()`）的回归测试。画成 DOM、两种版式、两侧联动在
// diff-view.test.tsx。
//
// **这几条是本文件存在的理由，它们全都「违反后不报错、只是静默出错」**：
//
// 1. **高亮只做一遍**。上下文行两侧共用同一份 HTML；谁把它改成两侧各上一次色、再把结果交织回
//    去，产出的是**嵌套重复**的 span（开销也翻倍），而页面看上去只是颜色略怪，不报错；
// 2. **语言由 `languageOf(path)` 判**——diff2html 那张 `languagesToExt` 里没有 `vue` / `env` /
//    `svelte`，也够不着 `.env.local` 这种多段名；而单文件组件还要**逐行**换语言
//    （`createLineLanguage()`）。判据是行上那个语言名；
// 3. `plaintext` 兜底——无扩展名文件(`LICENSE` / `Dockerfile`)三道判定全落空，漏注册时
//    `hljs.highlight()` 抛 `Unknown language`，**炸的是整个 diff 视图**，不是那一个文件；
// 4. **词级标记只给配上对的那一删一增**，而且标记与高亮交织在同一行里——标记丢了时增删行只剩整
//    行底色，页面照常渲染。
//
// **每条否定式断言都配一条正面断言**：什么都没画出来的时候，「没有重复 span」全都自动成立。

import { beforeEach, describe, expect, it } from 'vitest';
import { type DiffLine, prepareDiff } from '../../../src/web/diff/render';
import { MAX_WORD_DIFF_LENGTH, unifiedLines } from '../../../src/web/diff/rows';

// **一条 happy-dom 的坑，决定了下面的补丁必须带上下文行**：它的 `Attr.nodeName` 返回**空字符串**
// （`name` / `localName` 正常），而 diff2html 的 `mergeStreams.open()` 恰好用 `attr.nodeName` 重
// 新序列化属性。于是凡是走过 mergeStreams 的行——带 `<del>` / `<ins>` 词级标记的增删行——
// `class="hljs-keyword"` 会先变成 `="hljs-keyword"`、再被解析成裸属性，**类名丢了**。上下文行不
// 经 mergeStreams，类名完好，所以「高亮出颜色」只能压在上下文行上。这纯粹是测试环境的问题：真实
// 浏览器里 `nodeName` 就是 `class`，已在真机上实测过 177 个 hljs span / 12 类。

/**
 * 一段真实形状的 TS 补丁。
 *
 * 第一行是**上下文行**（行首空格），它是本文件里唯一能承载 hljs 类名断言的行，
 * 理由见上面那段。增删两行负责让词级 `<del>` / `<ins>` 也出现在 DOM 里。
 */
const TS_PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 export function greet(name: string): string {
-  return 'hi ' + name;
+  const prefix = \`hello \`;
+  return prefix + name;
 }
`;

/**
 * 重命名的补丁，**逐字取自 `git diff HEAD -M -- <新> <旧>` 的真实输出**（fixture
 * `renames` 仓库）。头四行是只有传了两个路径才拿得到的那几行：少传一个，
 * git 给的是 `new file mode` + `--- /dev/null`，页面上看起来只是"一个全新增文件"。
 */
const RENAME_PATCH = `diff --git a/src/kept.txt b/src/kept-renamed.txt
similarity index 88%
rename from src/kept.txt
rename to src/kept-renamed.txt
index af8a489..3d3aa51 100644
--- a/src/kept.txt
+++ b/src/kept-renamed.txt
@@ -1,3 +1,3 @@
 line 0
-line 3
+line three, edited
 line 4
`;

/** 无扩展名的文件——三道判定全落空，走 `plaintext` 兜底。 */
const LICENSE_PATCH = `diff --git a/LICENSE b/LICENSE
index 1111111..2222222 100644
--- a/LICENSE
+++ b/LICENSE
@@ -1,2 +1,2 @@
 MIT License
-Copyright (c) 2025
+Copyright (c) 2026
`;

/**
 * Vue SFC 的补丁，三个区块齐全。**highlight.js 上游没有 vue 模块**，diff2html 的
 * `languagesToExt` 里也没有 `vue` 这个键——两侧都认不出时整份文件是没有颜色的纯文本；而只把它
 * 判成 `xml` 时，`<script>` / `<style>` 那两段仍旧一个 span 都拿不到（逐行高亮，跨行状态不保
 * 留），页面上就是「模板有色、另外两段整块白」。
 *
 * 每段都留了上下文行——增删行的类名在 happy-dom 下会丢（理由见文件头）。
 */
const VUE_PATCH = `diff --git a/src/App.vue b/src/App.vue
index 1111111..2222222 100644
--- a/src/App.vue
+++ b/src/App.vue
@@ -1,12 +1,12 @@
 <script setup lang="ts">
 import { ref } from 'vue'
-const msg = ref('hi')
+const msg = ref('hello')
 </script>
 
 <template>
   <p class="card">{{ msg }}</p>
 </template>
 
 <style scoped>
 .card { color: red; }
 </style>
`;

/** `.env` 的补丁。两条上下文行分别承载 `hljs-comment` 与 `hljs-attr`。 */
const ENV_PATCH = `diff --git a/.env b/.env
index 1111111..2222222 100644
--- a/.env
+++ b/.env
@@ -1,3 +1,3 @@
 # local overrides
 API_URL=http://localhost:3000
-DEBUG=false
+DEBUG=true
`;

/** `.pyi` 走的是第三道（hljs 的 python 模块没有 `pyi` 这个别名，diff2html 那张表有）。 */
const PYI_PATCH = `diff --git a/stubs/api.pyi b/stubs/api.pyi
index 1111111..2222222 100644
--- a/stubs/api.pyi
+++ b/stubs/api.pyi
@@ -1,3 +1,3 @@
 from typing import Any
 
-def get(url: str) -> Any: ...
+def get(url: str, timeout: float) -> Any: ...
`;

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
});

/** 全部行，按 hunk、组的顺序摊平（一组里先删后增）。 */
const allLines = (path: string, patch: string): DiffLine[] =>
  prepareDiff(path, patch).flatMap((hunk) => unifiedLines(hunk.groups));

/** 把每行的 HTML 照 DiffView 的挂法写进 host，好用选择器数。 */
const paint = (path: string, patch: string) => {
  host.innerHTML = allLines(path, patch)
    .map((line) => `<span class="hljs ${line.language ?? ''}">${line.html}</span>`)
    .join('\n');
};

const hljsSpanCount = () => host.querySelectorAll('[class*="hljs-"]').length;

describe('prepareDiff', () => {
  it('给代码上色', () => {
    paint('src/a.ts', TS_PATCH);

    // 正面断言：下面几条否定式断言的前提
    expect(host.textContent).toContain('greet');
    expect(hljsSpanCount()).toBeGreaterThan(3);
  });

  it('高亮只做一遍——没有一模一样的 span 套一层', () => {
    paint('src/a.ts', TS_PATCH);
    expect(hljsSpanCount()).toBeGreaterThan(3);

    // 嵌套判据按**字符串**写而不是遍历 DOM：浏览器下重复的是 `<span class="hljs-x"><span
    // class="hljs-x">`，happy-dom 下是 `<span hljs-x=""><span hljs-x="">`，按 `[class*=hljs-]`
    // 遍历在后者上找不到东西。判据也不能只是「存在嵌套 span」：hljs 自身的语法嵌套本来就有
    // (params > attr、string > subst)，重复的特征是**属性逐字相同**的同名标签直接套一层——那只
    // 可能来自两份 node stream 交织
    expect(/<span([^>]*)><span\1>/.exec(host.innerHTML)).toBeNull();

    // 另一半：文字本身没有被复制一遍
    expect(host.textContent?.match(/const prefix/g) ?? []).toHaveLength(1);
  });

  it('无扩展名文件走 plaintext 兜底，不抛异常也不空白', () => {
    // 漏注册 plaintext 时这里抛 `Unknown language: "plaintext"`，而整个 diff 视图都渲染不出来
    expect(() => paint('LICENSE', LICENSE_PATCH)).not.toThrow();
    expect(host.textContent).toContain('MIT License');
  });

  // 三段各自的语言 + 各自真上了色。**只断言「模板有色」是抓不到这次回归的**——那一段在只判 xml
  // 的写法下本来就有色，白的是另外两段
  it.each([
    ['xml', '.hljs-name', 'template'],
    ['ts', '.hljs-keyword', 'script'],
    ['css', '.hljs-attribute', 'style'],
  ])('.vue 的 %s 段落到 %s（区块：%s）', (language, token) => {
    paint('src/App.vue', VUE_PATCH);

    // 判据的两半：行上落了这个语言，且这一段真的上了色。只断言前者时，一个高亮没跑起来的行照样
    // 通过；只断言后者时，别的语言碰巧也能给这段文本上点色
    expect(host.querySelectorAll(`.hljs.${language}`).length).toBeGreaterThan(0);
    expect(host.querySelectorAll(token).length).toBeGreaterThan(0);
  });

  // 语言只由 path 判、与补丁头无关，所以同一段 `.env` 补丁换个 path 就能盖住多段名那条规则：
  // `.env.production` 的「扩展名」是 `production`，只有按文件名的规则接得住
  it.each(['.env', '.env.local', 'apps/web/.env.production'])('%s 走 ini', (path) => {
    paint(path, ENV_PATCH);

    expect(host.querySelectorAll('.hljs.ini').length).toBeGreaterThan(0);
    // `API_URL` 那行是上下文行，ini 把等号左边判成 attr
    expect(host.querySelectorAll('.hljs-attr').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('.hljs-comment').length).toBeGreaterThan(0);
  });

  it('.pyi 走 python——语言判据的第三道（上游那张 languagesToExt）也在这条路上', () => {
    paint('stubs/api.pyi', PYI_PATCH);

    expect(host.querySelectorAll('.hljs.python').length).toBeGreaterThan(0);
    // `from typing import Any` 是上下文行，python 把 from / import 判成关键字
    expect(host.querySelectorAll('.hljs-keyword').length).toBeGreaterThan(0);
  });

  it('重命名的补丁是一份 hunk，正文照常（不退化成全新增）', () => {
    const hunks = prepareDiff('src/kept-renamed.txt', RENAME_PATCH);

    expect(hunks).toHaveLength(1);
    // 全新增的样子是一组只有插入、没有上下文：这里两行上下文都在
    expect(hunks[0]?.groups.filter((g) => g.kind === 'context')).toHaveLength(2);
    paint('src/kept-renamed.txt', RENAME_PATCH);
    expect(host.textContent).toContain('line three, edited');
  });

  it('配上对的一删一增带词级标记，多出来的那行不带', () => {
    const [hunk] = prepareDiff('src/a.ts', TS_PATCH);
    const change = hunk?.groups.find((g) => g.kind === 'change');
    if (change?.kind !== 'change') throw new Error('补丁里应当有一组改动');

    // 一删对两增：第一对有标记，第二个插入行没有可对的，整行就是差异本身
    expect(change.deleted).toHaveLength(1);
    expect(change.inserted).toHaveLength(2);
    // `<del >` 带一个空格：mergeStreams 重新序列化开标签的写法
    expect(change.deleted[0]?.html).toMatch(/<del\b/);
    expect(change.inserted[0]?.html).toMatch(/<ins\b/);
    expect(change.inserted[1]?.html).not.toMatch(/<ins\b/);
    // 标记交织进了同一行，没有把正文复制一份：去掉全部标签后逐字等于原文
    const plain = (html = '') => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");
    expect(plain(change.deleted[0]?.html)).toBe("  return 'hi ' + name;");
  });

  it('超长的一对不算词级差异，只有整行底色', () => {
    const long = 'x'.repeat(MAX_WORD_DIFF_LENGTH + 1);
    const patch = `--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-${long}
+${long}y
`;
    const [line] = allLines('a.txt', patch);

    // 正面断言：这一行确实画出来了
    expect(line?.kind).toBe('delete');
    expect(line?.html).not.toMatch(/<del\b/);
  });
});
