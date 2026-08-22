// diff2html 渲染路径的回归测试(spec §5.5 / §5.6)。
//
// **这三条是本文件存在的理由,它们全都"违反后不报错、只是静默出错"**,在
// happy-dom 进来之前(spec §5.11「DOM 测试环境」)一条都没有自动化覆盖:
//
// 1. `draw()` 之后**不得**再补一次 `highlightCode()` —— 第二遍的 `nodeStream()` 拿到的
//    已是第一遍插入的 hljs span,`mergeStreams` 把两份流交织进同一行,产出**嵌套重复**
//    的 span(开销也翻倍)。页面看上去只是颜色略怪,不报错;
// 2. `plaintext` 兜底 —— 无扩展名文件(`LICENSE` / `Dockerfile`)会让 diff2html 把语言
//    改写成字面量 `'plaintext'` 再无条件调 hljs。漏注册时异常从 `highlightCode()` 冒到
//    调用方,**炸的是整个 diff 视图**,不是那一个文件;
// 3. `colorScheme` 必须是 `'light'` —— 传 `'auto'` 会让 `.d2h-auto-color-scheme` 前缀
//    规则(特异性 0,2,0)压过基础规则、读回 diff2html 自带的 `--d2h-dark-*`,
//    vscode-theme.css 覆写的那 23 个变量在深色下一条都不生效(spec §5.6)。
//
// 4. `outputFormat` 由调用方按 diff 面板宽度给(spec §5.5)。两种版式的判据是一对正反计数:
//    并排下一个文件是**两张** `.d2h-diff-table`(各裹在一个 `.d2h-file-side-diff` 里),
//    逐行下是**一张**且 `.d2h-file-side-diff` 一个都没有。传错时页面照常渲染,只是版式不对。
//
// **每条否定式断言都配一条正面断言**:容器空着的时候,"没有重复 span""没有 auto class"
// 全都自动成立。所以每个用例都先确认 diff 真的画出来了、色真的上了。

import { beforeEach, describe, expect, it } from 'vitest';
import { renderDiff } from '../../../src/web/diff/render';

// **一条 happy-dom 的坑,决定了下面的补丁必须带上下文行**(实测 20.11.2,见 spec §10):
// 它的 `Attr.nodeName` 返回**空字符串**(`name` / `localName` 正常),而 diff2html 的
// `mergeStreams.open()` 恰好用 `attr.nodeName` 重新序列化属性。于是凡是走过 mergeStreams
// 的行 —— 带 `<del>` / `<ins>` 词级标记的增删行 —— `class="hljs-keyword"` 会先变成
// `="hljs-keyword"`、再被解析成裸属性 `hljs-keyword=""`,**类名丢了**。
// 上下文行不经 mergeStreams,类名完好,所以"高亮出颜色"只能压在上下文行上。
// 这纯粹是测试环境的问题:真实浏览器里 `nodeName` 就是 `class`,S2b 在真机上实测过
// 177 个 hljs span / 12 类。

/**
 * 一段真实形状的 TS 补丁。
 *
 * 第一行是**上下文行**(行首空格),它是本文件里唯一能承载 hljs 类名断言的行,
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
 * 重命名的补丁,**逐字取自 `git diff HEAD -M -- <新> <旧>` 的真实输出**(fixture
 * `renames` 仓库)。头四行是只有传了两个路径才拿得到的那几行(§5.2):少传一个,
 * git 给的是 `new file mode` + `--- /dev/null`,页面上看起来只是"一个全新增文件"。
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

/** 无扩展名的文件 —— diff2html 会把语言改写成字面量 'plaintext'(§5.5)。 */
const LICENSE_PATCH = `diff --git a/LICENSE b/LICENSE
index 1111111..2222222 100644
--- a/LICENSE
+++ b/LICENSE
@@ -1,2 +1,2 @@
 MIT License
-Copyright (c) 2025
+Copyright (c) 2026
`;

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
});

const hljsSpanCount = () => host.querySelectorAll('[class*="hljs-"]').length;

describe('renderDiff', () => {
  it('画出 diff 表格并给代码上色', () => {
    renderDiff(host, TS_PATCH, 'side-by-side');

    // 正面断言:下面几条否定式断言的前提
    expect(host.querySelector('.d2h-diff-table')).not.toBeNull();
    expect(host.textContent).toContain('greet');
    expect(hljsSpanCount()).toBeGreaterThan(3);
  });

  it('高亮只做一遍 —— 没有一模一样的 span 套一层', () => {
    renderDiff(host, TS_PATCH, 'side-by-side');

    // 在 `draw()` 后补一次 `highlightCode()`(即被禁的那个写法)时,**先炸的是这一条**:
    // 第二遍让上下文行也走一次 mergeStreams,于是连它的类名都被写坏(机制见文件头),
    // span 数从 20+ 掉到 0 —— 已把那一行真加回 render.ts 验证过。
    // 真实浏览器里表现是 spec §5.5 说的"嵌套重复 span",由下面那条字符串判据接住。
    expect(hljsSpanCount()).toBeGreaterThan(3);

    // 嵌套判据按**字符串**写而不是遍历 DOM,正是为了同时盖住上面那两种形态:
    // 浏览器下重复的是 `<span class="hljs-x"><span class="hljs-x">`,happy-dom 下是
    // `<span hljs-x=""><span hljs-x="">`,而按 `[class*=hljs-]` 遍历在后者上找不到东西。
    //
    // 判据不能只是"存在嵌套 span":hljs 自身的语法嵌套本来就有(params > attr、
    // string > subst,S2b 在真实 TS diff 上实测过)。重复的特征是**属性逐字相同**的
    // 同名标签直接套一层 —— 那只可能来自两份 node stream 交织。
    const doubled = /<span([^>]*)><span\1>/.exec(host.innerHTML);
    expect(doubled).toBeNull();

    // 另一半:文字本身没有被复制一遍
    expect(host.textContent?.match(/const prefix/g) ?? []).toHaveLength(1);
  });

  it('无扩展名文件走 plaintext 兜底,不抛异常也不空白', () => {
    // 漏注册 plaintext 时这里抛的是 `Unknown language: "plaintext"`,而整个 diff
    // 视图(不只这个文件)都渲染不出来
    expect(() => renderDiff(host, LICENSE_PATCH, 'side-by-side')).not.toThrow();
    expect(host.querySelector('.d2h-diff-table')).not.toBeNull();
    expect(host.textContent).toContain('MIT License');
  });

  it('重命名的补丁画成一个文件、新旧两个名字都在(§6:不退化成全新增)', () => {
    renderDiff(host, RENAME_PATCH, 'side-by-side');

    // 一个文件而不是两个:diff2html 把 `rename from/to` 认成同一个文件的两侧
    expect(host.querySelectorAll('.d2h-file-wrapper')).toHaveLength(1);
    // diff2html 把公共目录前缀提出来,写成 `src/{kept.txt → kept-renamed.txt}`(实测)。
    // 那是**紧凑形式而不是完整旧路径**,DiffView 那条「重命名自 <旧路径>」因此不是重复
    const header = host.querySelector('.d2h-file-name')?.textContent ?? '';
    expect(header).toContain('kept.txt');
    expect(header).toContain('kept-renamed.txt');
    expect(header).toContain('→');
    // 正文照常有内容 —— 只标注不渲染同样是坏的
    expect(host.textContent).toContain('line three, edited');
  });

  it('容器上没有 d2h 自己那套深色 class —— 深浅归我们的 --d2h-* 覆写', () => {
    renderDiff(host, TS_PATCH, 'side-by-side');

    // 正面断言:colorScheme 确实生效了,只是生效成那个空 class
    expect(host.querySelector('.d2h-light-color-scheme')).not.toBeNull();

    // 这两个一旦出现,vscode-theme.css 里 23 个 --d2h-* 覆写在深色下会被整块旁路,
    // 而页面只是"深色不太像 VS Code",测试和 CI 都不会红 —— 所以钉在这里(§5.6)
    expect(host.querySelectorAll('.d2h-auto-color-scheme')).toHaveLength(0);
    expect(host.querySelectorAll('.d2h-dark-color-scheme')).toHaveLength(0);
  });

  // 两种版式的全部可断言差别就是这两个计数(其余断言两边同真,写了也不区分版式)。
  // `.d2h-file-side-diff` 那列是否定式的一半,`.d2h-diff-table` 那列是配套的正面断言 ——
  // 少了后者,一个什么都没画出来的容器同样能让「并排容器为 0」通过
  it.each([
    ['side-by-side', 2, 2],
    ['line-by-line', 1, 0],
  ] as const)('outputFormat=%s:%i 张表、%i 个并排容器', (format, tables, sideDiffs) => {
    renderDiff(host, TS_PATCH, format);

    expect(host.querySelectorAll('.d2h-diff-table')).toHaveLength(tables);
    expect(host.querySelectorAll('.d2h-file-side-diff')).toHaveLength(sideDiffs);
    expect(host.textContent).toContain('const prefix');
  });

  it('同一个容器重画一次不会叠加两份 diff', () => {
    // S3b1 起同一个文件拿到新补丁就走这条路(DiffView 的 effect 按 [patch] 重跑),
    // 靠的是 draw() 内部整片覆盖 innerHTML
    renderDiff(host, TS_PATCH, 'side-by-side');
    renderDiff(host, TS_PATCH, 'side-by-side');

    // 数的是「几个文件」而不是「几张表」:并排视图下一个文件本来就是左右两张
    // `.d2h-diff-table`(实测),按表数会得到一个与叠加无关的 2
    expect(host.querySelectorAll('.d2h-file-wrapper')).toHaveLength(1);
    expect(host.textContent?.match(/const prefix/g) ?? []).toHaveLength(1);
  });
});
