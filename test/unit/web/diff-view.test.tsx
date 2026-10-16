// DiffView 的五个 payload 分支与容器所有权（图片那一支的正文在 image-view.test.tsx）。
//
// store 那份用例盯的是「取 diff 时状态怎么转」，本文件盯的是「同一份状态渲染成什么」——「同一个
// 文件重新取时回退 loading」在 store 层已经钉住了，但**回退之外还有一条同样丢滚动位置的路**：换
// key 让子树卸载重挂。那只在 DOM 上看得见。空态不在这里：栏里没有 tab 时由 `App` 画，归 app.test。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiffPayload } from '../../../src/server/shared/protocol';
import { DiffView } from '../../../src/web/components/DiffView';
import {
  diffFormatOverride,
  diffPanelWidth,
  SIDE_BY_SIDE_MIN_WIDTH,
  toggleDiffOutputFormat,
} from '../../../src/web/state/layout';
import { diffStates, type RenameInfo } from '../../../src/web/state/store';
import { waitFor } from './helpers';

/**
 * **那行上下文(`export const keep`)不是凑数的**：happy-dom 的 `Attr.nodeName` 返回空串（机制见
 * render.test.ts 抬头），于是凡是走过 diff2html `mergeStreams` 的行——也就是带 `<del>` /
 * `<ins>` 词级标记的增删行——类名会被写坏。上下文行不走那条路，类名完好，所以「高亮出颜色」这
 * 条断言只能压在它身上。
 */
const patchFor = (line: string) => `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 export const keep = true;
-const old = 1;
+${line}
`;

let container: HTMLElement;

/** 把这个路径的缓存写成 ready。**不重新 render**：视图在渲染体里订阅 map，写了它自己会重画。 */
const ready = (path: string, payload: DiffPayload, rename: RenameInfo | null = null) => {
  diffStates.value = new Map(diffStates.value).set(path, {
    status: 'ready',
    rename,
    payload,
  });
};

/** 让视图画这个路径——产品里由 `App` 按活动 tab 给 `path`，这里直接换 prop。 */
const show = (path: string) => render(<DiffView path={path} />, container);

/** 唯一滚的那一层；它的最后一个元素就是 payload 那一档（提示行或 diff 容器）。 */
const scroller = () => container.querySelector('.overflow-auto');
const payloadNode = () => scroller()?.lastElementChild ?? null;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  diffStates.value = new Map();
  // 面板宽度也要复位：它是模块级 signal，上一个用例写进去的值会跨用例串味，而串味的表现是「某条
  // 用例单跑绿、整档跑红」
  diffPanelWidth.value = SIDE_BY_SIDE_MIN_WIDTH;
  diffFormatOverride.value = null;
});

afterEach(() => {
  render(null, container);
  diffStates.value = new Map();
  diffPanelWidth.value = SIDE_BY_SIDE_MIN_WIDTH;
  diffFormatOverride.value = null;
});

describe('DiffView', () => {
  it('缓存里还没有这个路径时画一行加载中，不渲染空的 diff 容器', async () => {
    show('a.ts');
    await waitFor(() => expect(container.textContent).toContain('Loading…'));
    expect(container.querySelector('[data-diff-layout]')).toBeNull();
    // 提示行在滚动层里、贴左上（`Notice`），不是居中的空态——面板不是空着，是这个文件还没来
    expect(scroller()?.textContent).toContain('Loading…');
  });

  it('text / untracked-text 都画成 diff', async () => {
    // 两轮**换不同的 path**，并各等自己那行代码出现：同一个 path 的话，第二轮开头容器与 hljs span
    // 还是上一轮留下的，「渲染成功了」会立刻通过而什么都没验
    for (const { path, marker, payload } of [
      {
        path: 'tracked.ts',
        marker: 'const tracked',
        payload: { kind: 'text', patch: patchFor('const tracked = 2;') },
      },
      {
        path: 'untracked.ts',
        marker: 'const untracked',
        payload: { kind: 'untracked-text', patch: patchFor('const untracked = 3;') },
      },
    ] satisfies { path: string; marker: string; payload: DiffPayload }[]) {
      ready(path, payload);
      show(path);

      // 三条一起等：上色与画表是同一次渲染，表出现时 span 必然已经在了
      await waitFor(() => {
        expect(container.textContent).toContain(marker);
        expect(container.querySelector('[data-diff-layout]')).not.toBeNull();
        expect(container.querySelector('[class*="hljs-"]')).not.toBeNull();
      });
    }
  });

  it('视图只有滚动那一层，不再画路径横杠——「在看哪个文件」由标签栏答', async () => {
    ready('a.ts', { kind: 'text', patch: patchFor('const x = 1;') });
    show('a.ts');
    await waitFor(() => expect(container.querySelector('[data-diff-layout]')).not.toBeNull());

    // 滚动层是视图的根：它与标签栏在 `App` 那个 `<section>` 里是两个兄弟，类名两个视图必须
    // 逐字相同（`Panel` 只此一份）——漂开的症状是其中一个面板底下那半屏不跟着滚
    expect(container.querySelector('h2')).toBeNull();
    expect(container.firstElementChild).toBe(scroller());
    expect(scroller()?.className).toBe('min-h-0 flex-1 overflow-auto');
  });

  it.each([
    ['side-by-side', 1400],
    ['line-by-line', 700],
  ] as const)('%s：行号槽 sticky，表格按内容撑宽——横滚时行号留在左边', async (_, width) => {
    diffPanelWidth.value = width;
    ready('a.ts', { kind: 'text', patch: patchFor('const x = 1;') });
    show('a.ts');
    await waitFor(() => expect(container.querySelector('[data-diff-layout]')).not.toBeNull());

    // **断言只能压在类名上**：happy-dom 没有排版引擎，「横滚后行号还在」在这里不可判定。两半缺
    // 一不可：少了 `sticky` 行号跟着正文滚走；表格只有面板那么宽时 sticky 的滑动余量为 0，与
    // static 一模一样。类名换成拼出来的这条照样绿，而 Tailwind 扫不到字面量、产物里就没有那条规
    // 则——那一半肉眼看
    const tables = [...container.querySelectorAll('table')];
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(table.className).toContain('w-max');
      const gutter = table.querySelector('tr[data-line] > td');
      expect(gutter?.className).toContain('sticky');
      expect(gutter?.className).toContain('left-0');
    }
  });

  it('行号的位数写在 --diff-digits 上，五位数的槽跟着撑宽', async () => {
    ready('big.ts', {
      kind: 'text',
      patch:
        'diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -12345 +12345 @@\n-a\n+b\n',
    });
    show('big.ts');
    await waitFor(() => expect(container.querySelector('[data-diff-layout]')).not.toBeNull());

    // 断言只能压在变量与类名上（happy-dom 不排版）：漏写变量时格宽回落到 4 位的默认值，第
    // 10000 行起号溢进旁边那格，页面不报错
    const host = container.querySelector('[data-diff-layout]')?.parentElement;
    expect(host?.style.getPropertyValue('--diff-digits')).toBe('5');
    const gutter = container.querySelector('tr[data-line] > td');
    expect(gutter?.className).toContain('var(--diff-digits');
    expect(gutter?.className).toContain('whitespace-nowrap');
  });

  it('没有 hunk（只改了权限位）：一句提示，不画空表', async () => {
    ready('run.sh', {
      kind: 'text',
      patch: 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n',
    });
    show('run.sh');
    await waitFor(() => expect(container.textContent).toContain('File without changes.'));

    expect(container.querySelector('table')).toBeNull();
  });

  it('并排两侧横向联动——滚一侧，另一侧跟到同一个 scrollLeft', async () => {
    diffPanelWidth.value = 1400;
    ready('a.ts', { kind: 'text', patch: patchFor('const x = 1;') });
    show('a.ts');
    await waitFor(() => expect(container.querySelectorAll('[data-diff-side]')).toHaveLength(2));

    // 两个滚动容器是两张表的父元素
    const sides = [...container.querySelectorAll('[data-diff-side]')].map(
      (table) => table.parentElement as HTMLElement,
    );
    // 两个方向各来一次：只绑一侧的症状是「拖左边管用、拖右边不管用」。happy-dom 的 `scrollLeft`
    // 是纯属性——赋值既不派发 scroll 事件也不做 clamp，所以这里手工派发一次浏览器本来会派发的那
    // 个事件，断言也因此不受布局影响（真实的滚动与两侧上限不等时的回弹都只能上真机看）
    for (const [index, from] of sides.entries()) {
      const scrollLeft = 40 * (index + 1);
      from.scrollLeft = scrollLeft;
      from.dispatchEvent(new Event('scroll'));

      expect(sides.map((side) => side.scrollLeft)).toEqual([scrollLeft, scrollLeft]);
    }
  });

  it('binary 只提示，不画 diff', async () => {
    ready('logo.bin', { kind: 'binary' });
    show('logo.bin');
    await waitFor(() => expect(container.textContent).toContain('Binary file'));

    expect(container.querySelector('[data-diff-layout]')).toBeNull();
  });

  it('too-large 的两个触发口给出不同的话，小文件不会被说成 MB', async () => {
    // 体积那一路：5MB 出头，按 MB 说得通
    ready('huge.log', { kind: 'too-large', size: 6 * 1024 * 1024, reason: 'size' });
    show('huge.log');
    await waitFor(() => expect(container.textContent).toContain('Diff too large'));
    const bySize = container.textContent ?? '';

    // 行数那一路：100 KB 的窄文件
    ready('many-lines.txt', { kind: 'too-large', size: 100 * 1024, reason: 'lines' });
    show('many-lines.txt');
    await waitFor(() => expect(container.textContent).toContain('Too many lines'));
    const byLines = container.textContent ?? '';

    expect(bySize).toContain('6.0 MB');
    expect(byLines).toContain('100 KB');
    // 少了 reason（或 formatSize 选错量级）时，100 KB 那条会被说成「Diff too large to show
    // (file is 0 MB)」。判据钉在「这条里根本不该出现 MB」上——早先那版把标点也抄进断言里(`'0 MB,'`)，
    // **一次都不可能失败**：模板里那两个字符之间还隔着别的东西
    expect(byLines).not.toContain('MB');
  });

  it('重命名条目只标注旧路径，不印相似度（照 VS Code）', async () => {
    ready('src/new name.ts', { kind: 'text', patch: patchFor('const x = 1;') }, {
      oldPath: 'src/old name.ts',
    } satisfies RenameInfo);
    show('src/new name.ts');

    await waitFor(() => expect(container.textContent).toContain('Renamed from'));
    expect(container.textContent).toContain('src/old name.ts');
    expect(container.textContent).not.toContain('similar');
  });

  it('没有补丁头的那几路也标注：binary 时标注丢了，页面上就再没有地方提过它是重命名', async () => {
    ready('b.ts', { kind: 'binary' }, { oldPath: 'a.ts' });
    show('b.ts');
    await waitFor(() => expect(container.textContent).toContain('Renamed from'));
    expect(container.textContent).toContain('Binary file');
  });

  it('普通文件不出现重命名标注——判据是 rename 而不是路径长得像', async () => {
    ready('a.ts', { kind: 'text', patch: patchFor('const x = 1;') });
    show('a.ts');
    await waitFor(() => expect(container.textContent).toContain('const x'));
    expect(container.textContent).not.toContain('Renamed');
  });

  it('体积取不到时（已删除的文件）不把 0 说成 1 KB——两个 reason 都是', async () => {
    // 已被删除的文件在工作区没有体积，后端给的是 0;`Math.max(1, …)` 会把它说成「1 KB」——编出来
    // 的一个数
    ready('gone.txt', { kind: 'too-large', size: 0, reason: 'lines' });
    show('gone.txt');
    await waitFor(() => expect(container.textContent).toContain('Too many lines'));
    expect(container.textContent).not.toContain('KB');

    ready('also-gone.txt', { kind: 'too-large', size: 0, reason: 'size' });
    show('also-gone.txt');
    await waitFor(() => expect(container.textContent).toContain('Diff too large'));
    expect(container.textContent).not.toContain('KB');
    expect(container.textContent).not.toContain('MB');
  });

  it('同一个文件换补丁：容器留在原地，不卸载重挂', async () => {
    ready('a.ts', { kind: 'text', patch: patchFor('const first = 1;') });
    show('a.ts');
    await waitFor(() => expect(container.textContent).toContain('const first'));
    const before = payloadNode();

    // **只写 map、不补 render**：视图在渲染体里订阅 map，状态一变自己就重画——手动补一次会把
    // 「状态变了会不会重画」替它做掉，而这条与下一条正是要证这个
    ready('a.ts', { kind: 'text', patch: patchFor('const second = 2;') });
    await waitFor(() => expect(container.textContent).toContain('const second'));

    // 元素**同一个**是这条验收的全部内容：换成新元素就意味着画好的 DOM 连同滚动位置一起被丢
    // 掉，而要求刷新不丢这两样——每个 change 事件都会走这条路
    expect(payloadNode()).toBe(before);
    expect(container.textContent).not.toContain('const first');
    // 也没有叠出第二份：并排下一个文件本来就是左右两张表
    expect(container.querySelectorAll('table')).toHaveLength(2);
  });

  it('面板变窄变宽：版式跟着换，容器仍留在原地', async () => {
    // 这条钉的是「版式在渲染体里订阅」。漏了不报错、页面照常有 diff，只是拖窗口时版式纹丝不动。
    // 走的是直接写 `diffPanelWidth`，不经 ResizeObserver:happy-dom 的 ResizeObserver 是个空壳、
    // 也没有布局引擎，那一段归肉眼项
    diffPanelWidth.value = 700;
    ready('a.ts', { kind: 'text', patch: patchFor('const first = 1;') });
    show('a.ts');
    await waitFor(() => expect(container.querySelectorAll('table')).toHaveLength(1));
    const before = payloadNode();
    expect(container.querySelectorAll('[data-diff-side]')).toHaveLength(0);

    diffPanelWidth.value = 1400;
    await waitFor(() => expect(container.querySelectorAll('[data-diff-side]')).toHaveLength(2));

    // 补丁没变，重画的理由只可能是版式——而且是**就地**重画：外层换成新元素等于把面板里的这一
    // 档整个卸载重挂（同上一条用例的判据）
    expect(payloadNode()).toBe(before);
    expect(container.textContent).toContain('const first');
  });

  it('手动切版式：就地重画成另一种，容器仍留在原地', async () => {
    // 手动档走的是同一个 `diffOutputFormat`，所以不用另补依赖——这条钉的就是「没有另开一条通路」。
    // 「固定之后拖宽度不再换」由 layout.test 按「下游一次通知都收不到」钉住，比在这里睡一拍再看 DOM 更硬
    diffPanelWidth.value = 1400;
    ready('a.ts', { kind: 'text', patch: patchFor('const first = 1;') });
    show('a.ts');
    await waitFor(() => expect(container.querySelectorAll('[data-diff-side]')).toHaveLength(2));
    const before = payloadNode();

    toggleDiffOutputFormat();
    await waitFor(() => expect(container.querySelectorAll('table')).toHaveLength(1));
    expect(container.querySelectorAll('[data-diff-side]')).toHaveLength(0);
    expect(payloadNode()).toBe(before);
  });
});
