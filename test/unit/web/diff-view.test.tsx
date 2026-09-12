// DiffView 的四个 payload 分支与容器所有权。
//
// store 那份用例盯的是「取 diff 时状态怎么转」，本文件盯的是「同一份状态渲染成什么」——「同一个
// 文件重新取时回退 loading」在 store 层已经钉住了，但**回退之外还有一条同样丢滚动位置的路**：换
// key 让子树卸载重挂。那只在 DOM 上看得见。空态不在这里：栏里没有 tab 时由 `App` 画，归 app.test。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiffPayload } from '../../../src/server/shared/protocol';
import { DiffView } from '../../../src/web/components/DiffView';
import { diffPanelWidth, SIDE_BY_SIDE_MIN_WIDTH } from '../../../src/web/state/layout';
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
});

afterEach(() => {
  render(null, container);
  diffStates.value = new Map();
  diffPanelWidth.value = SIDE_BY_SIDE_MIN_WIDTH;
});

describe('DiffView', () => {
  it('缓存里还没有这个路径时画一行加载中，不渲染空的 diff 容器', async () => {
    show('a.ts');
    await waitFor(() => expect(container.textContent).toContain('Loading…'));
    expect(container.querySelector('.d2h-file-wrapper')).toBeNull();
    // 提示行在滚动层里、贴左上（`Notice`），不是居中的空态——面板不是空着，是这个文件还没来
    expect(scroller()?.textContent).toContain('Loading…');
  });

  it('text / untracked-text 都走 diff2html', async () => {
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

      // 三条一起等：高亮是 draw() 内部同一次调用里做的，容器出现时 span 必然已经在了
      await waitFor(() => {
        expect(container.textContent).toContain(marker);
        expect(container.querySelector('.d2h-file-wrapper')).not.toBeNull();
        expect(container.querySelector('[class*="hljs-"]')).not.toBeNull();
      });
    }
  });

  it('视图只有滚动那一层，不再画路径横杠——「在看哪个文件」由标签栏答', async () => {
    ready('a.ts', { kind: 'text', patch: patchFor('const x = 1;') });
    show('a.ts');
    await waitFor(() => expect(container.querySelector('.d2h-file-wrapper')).not.toBeNull());

    // 滚动层是视图的根：它与标签栏在 `App` 那个 `<section>` 里是两个兄弟，类名两个视图必须
    // 逐字相同（`Panel` 只此一份）——漂开的症状是其中一个面板底下那半屏不跟着滚
    expect(container.querySelector('h2')).toBeNull();
    expect(container.firstElementChild).toBe(scroller());
    expect(scroller()?.className).toBe('min-h-0 flex-1 overflow-auto');
  });

  it('diff2html 的宿主容器带着 relative——行号列的包含块', async () => {
    ready('a.ts', { kind: 'text', patch: patchFor('const x = 1;') });
    show('a.ts');
    await waitFor(() => expect(container.querySelector('.d2h-file-wrapper')).not.toBeNull());

    // 少了这个包含块，右侧一滚整列行号就原地钉死、与代码行错开。**断言只能压在类名上**：
    // happy-dom 没有排版引擎，「滚动后行号还对得上」在这里不可判定，这条钉的是「那个类名还在」，
    // 防的是有人把它当成多余的工具类顺手删掉。等 diff2html 画完再断言不是白等——`draw()` 是往这
    // 个元素上赋 `innerHTML`，顺带钉住它没把我们的 class 冲掉。类名换成拼出来的这条照样绿，而
    // Tailwind 扫不到字面量、产物里就没有那条规则——那一半由 `pnpm check:css` 直接查产物
    expect(payloadNode()).toHaveProperty('className', 'relative');
  });

  it('binary 只提示，不画 diff', async () => {
    ready('logo.png', { kind: 'binary' });
    show('logo.png');
    await waitFor(() => expect(container.textContent).toContain('Binary file'));

    expect(container.querySelector('.d2h-file-wrapper')).toBeNull();
  });

  it('too-large 的两个触发口给出不同的话，小文件不会被说成 MB', async () => {
    // 体积那一路：5MB 出头，按 MB 说得通
    ready('huge.log', { kind: 'too-large', size: 6 * 1024 * 1024, reason: 'size' });
    show('huge.log');
    await waitFor(() => expect(container.textContent).toContain('File too large'));
    const bySize = container.textContent ?? '';

    // 行数那一路：100 KB 的窄文件
    ready('many-lines.txt', { kind: 'too-large', size: 100 * 1024, reason: 'lines' });
    show('many-lines.txt');
    await waitFor(() => expect(container.textContent).toContain('Too many lines'));
    const byLines = container.textContent ?? '';

    expect(bySize).toContain('6.0 MB');
    expect(byLines).toContain('100 KB');
    // 少了 reason（或 formatSize 选错量级）时，100 KB 那条会被说成「File too large to preview
    // (0 MB)」。判据钉在「这条里根本不该出现 MB」上——早先那版把标点也抄进断言里(`'0 MB,'`)，
    // **一次都不可能失败**：模板里那两个字符之间还隔着别的东西
    expect(byLines).not.toContain('MB');
  });

  it('重命名条目标注旧路径与相似度（点开后要标注为重命名）', async () => {
    ready('src/new name.ts', { kind: 'text', patch: patchFor('const x = 1;') }, {
      oldPath: 'src/old name.ts',
      score: 95,
    } satisfies RenameInfo);
    show('src/new name.ts');

    await waitFor(() => expect(container.textContent).toContain('Renamed from'));
    expect(container.textContent).toContain('src/old name.ts');
    expect(container.textContent).toContain('95%');
  });

  it('相似度取不到时只说旧路径，不编一个百分比出来', async () => {
    ready('b.ts', { kind: 'binary' }, { oldPath: 'a.ts', score: null });
    show('b.ts');
    await waitFor(() => expect(container.textContent).toContain('Renamed from'));
    // 「相似度 null%」「相似度 0%」都是在说一件 git 没说过的事；而 binary 这一路
    // 压根没有补丁头，标注要是也跟着丢，页面上就再没有任何地方提过它是重命名
    expect(container.textContent).not.toContain('similar');
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
    await waitFor(() => expect(container.textContent).toContain('File too large'));
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

    // 元素**同一个**是这条验收的全部内容：换成新元素就意味着 diff2html 画好的 DOM
    // 连同滚动位置一起被丢掉，而要求刷新不丢这两样——每个 change 事件都会走这条路
    expect(payloadNode()).toBe(before);
    expect(container.textContent).not.toContain('const first');
  });

  it('面板变窄变宽：版式跟着换，容器仍留在原地', async () => {
    // 这条钉的是那句「格式必须进 effect 的依赖数组」。漏了不报错、页面照常有 diff，只是拖窗口时版
    // 式纹丝不动。走的是直接写 `diffPanelWidth`，不经 ResizeObserver:happy-dom 的 ResizeObserver
    // 是个空壳、也没有布局引擎，那一段归肉眼项
    diffPanelWidth.value = 700;
    ready('a.ts', { kind: 'text', patch: patchFor('const first = 1;') });
    show('a.ts');
    await waitFor(() => expect(container.querySelectorAll('.d2h-diff-table')).toHaveLength(1));
    const before = payloadNode();
    expect(container.querySelectorAll('.d2h-file-side-diff')).toHaveLength(0);

    diffPanelWidth.value = 1400;
    await waitFor(() => expect(container.querySelectorAll('.d2h-file-side-diff')).toHaveLength(2));

    // 补丁没变，重画的理由只可能是版式——而且是**就地**重画：换成新元素等于把
    // diff2html 画好的 DOM 连同滚动位置一起丢掉（同上一条用例的判据）
    expect(payloadNode()).toBe(before);
    expect(container.textContent).toContain('const first');
  });
});
