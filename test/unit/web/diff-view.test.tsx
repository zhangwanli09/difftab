// DiffView 的四个 payload 分支与容器所有权(spec §5.5 / §5.12 / §5.4)。
//
// store 那份用例盯的是「取 diff 时状态怎么转」,本文件盯的是「同一份状态渲染成什么」——
// 两件事分开:S2b 那个坑(同一个文件重新取时回退 loading)在 store 层已经钉住了,
// 但**回退之外还有一条同样丢滚动位置的路**:换 key 让子树卸载重挂。那只在 DOM 上看得见。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffPayload } from '../../../src/server/shared/protocol';
import { DiffView } from '../../../src/web/components/DiffView';
import { diffState } from '../../../src/web/state/store';

/**
 * **那行上下文(`export const keep`)不是凑数的**:happy-dom 的 `Attr.nodeName` 返回空串
 * (实测,见 render.test.ts 与 spec §10),于是凡是走过 diff2html `mergeStreams` 的行
 * —— 也就是带 `<del>` / `<ins>` 词级标记的增删行 —— 类名会被写坏。上下文行不走那条路,
 * 类名完好,所以"高亮出颜色"这条断言只能压在它身上。删掉它,断言会以一个与产品无关的
 * 理由变红。
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

/**
 * 等到"某个断言成立",而不是等一个固定的毫秒数。
 *
 * 为什么要等:一个微任务不够 —— signals 触发重渲染是微任务,但 `useEffect` 里的
 * `renderDiff` 由 Preact 排到 `requestAnimationFrame`(happy-dom 实现成约 16ms 的
 * 定时器),另有一条 35ms 的 `RAF_TIMEOUT` 兜底(preact 10.29.8 的 `afterNextFrame`
 * 是 rAF 与 setTimeout 竞速)。等得不够只能看到 `<h2>` 那半个 DiffView、diff 容器还是空的。
 *
 * 为什么不写死等 50ms:那样对 35ms 的兜底只剩 15ms 余量,CI worker 被压住时就会以
 * "渲染没发生"这个**误导性理由**变红 —— 正是 S1/S2a 那两次"下限档红,原因不在产品
 * 代码"的形状。`vi.waitFor` 轮询到成立为止,慢机器只是多等几轮。
 *
 * `interval` 必须调小:默认 50ms 的轮询格子比实际就绪时间(happy-dom 的 rAF 实测约
 * 1ms)粗得多,五个走 effect 的用例于是各睡满一格 —— 白等约 250ms,占 web 那档测试
 * 时间的一多半。调 interval 不动 `timeout`(仍是默认 1000ms),慢机器的余量分毫不减。
 */
const waitFor = (assert: () => void) => vi.waitFor(assert, { interval: 5 });

const ready = (path: string, payload: DiffPayload) => {
  diffState.value = { status: 'ready', path, payload };
};

/** DiffView 的最外层 div 下,最后一个元素就是 payload 那一档(提示行或 diff 容器)。 */
const payloadNode = () => container.firstElementChild?.lastElementChild ?? null;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  diffState.value = null;
  // 只挂载一次,之后各用例只写 state。**别在用例里补 render()**:DiffView 在渲染体里
  // 订阅 diffState,状态一变自己就重画 —— 手动补一次 render 会把"状态变了会不会重画"
  // 这件事替它做掉,而下面最后两条用例正是要证这个,补了就等于自己把断言绕过去。
  render(<DiffView />, container);
});

afterEach(() => {
  render(null, container);
  diffState.value = null;
});

describe('DiffView', () => {
  it('没选文件时给一句提示,不渲染空的 diff 容器', async () => {
    await waitFor(() => expect(container.textContent).toContain('从左侧选一个文件'));

    expect(container.querySelector('.d2h-file-wrapper')).toBeNull();
  });

  it('text / untracked-text 都走 diff2html', async () => {
    // 两轮**换不同的 path**,并各等自己那行代码出现:同一个 path 的话,第二轮开头
    // 容器与 hljs span 还是上一轮留下的,"渲染成功了"这条断言会立刻通过而什么都没验
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

      // 三条一起等:高亮是 draw() 内部同一次调用里做的,容器出现时 span 必然已经在了
      await waitFor(() => {
        expect(container.textContent).toContain(marker);
        expect(container.querySelector('.d2h-file-wrapper')).not.toBeNull();
        expect(container.querySelector('[class*="hljs-"]')).not.toBeNull();
      });
    }
  });

  it('binary 只提示,不画 diff', async () => {
    ready('logo.png', { kind: 'binary' });
    await waitFor(() => expect(container.textContent).toContain('二进制文件'));

    expect(container.querySelector('.d2h-file-wrapper')).toBeNull();
  });

  it('too-large 的两个触发口给出不同的话,小文件不会被说成 MB', async () => {
    // 体积那一路:5MB 出头,按 MB 说得通
    ready('huge.log', { kind: 'too-large', size: 6 * 1024 * 1024, reason: 'size' });
    await waitFor(() => expect(container.textContent).toContain('文件过大'));
    const bySize = container.textContent ?? '';

    // 行数那一路:100 KB 的窄文件
    ready('many-lines.txt', { kind: 'too-large', size: 100 * 1024, reason: 'lines' });
    await waitFor(() => expect(container.textContent).toContain('行数过多'));
    const byLines = container.textContent ?? '';

    expect(bySize).toContain('6.0 MB');
    expect(byLines).toContain('100 KB');
    // 少了 reason(或 formatSize 选错量级)时,100 KB 那条会被说成「文件过大(0 MB)」。
    // 判据钉在"这条里根本不该出现 MB"上 —— 早先写的 `not.toContain('0 MB,')`
    // **一次都不可能失败**:模板在尺寸与逗号之间还有个 `)`,那个逗号永远挨不上
    expect(byLines).not.toContain('MB');
  });

  it('同一个文件换补丁:容器留在原地,不卸载重挂', async () => {
    ready('a.ts', { kind: 'text', patch: patchFor('const first = 1;') });
    await waitFor(() => expect(container.textContent).toContain('const first'));
    const before = payloadNode();

    ready('a.ts', { kind: 'text', patch: patchFor('const second = 2;') });
    await waitFor(() => expect(container.textContent).toContain('const second'));

    // 元素**同一个**是这条验收的全部内容:换成新元素就意味着 diff2html 画好的 DOM
    // 连同滚动位置一起被丢掉,而 §5.4 要求刷新不丢这两样。S3b1 起每个 change 事件
    // 都会走这条路
    expect(payloadNode()).toBe(before);
    expect(container.textContent).not.toContain('const first');
  });

  it('换文件:容器换新的,不会在新标题下留着上一个文件的 DOM', async () => {
    ready('a.ts', { kind: 'text', patch: patchFor('const first = 1;') });
    await waitFor(() => expect(container.textContent).toContain('const first'));
    const before = payloadNode();

    ready('b.ts', { kind: 'text', patch: patchFor('const other = 9;') });
    await waitFor(() => expect(container.textContent).toContain('const other'));

    expect(payloadNode()).not.toBe(before);
  });
});
