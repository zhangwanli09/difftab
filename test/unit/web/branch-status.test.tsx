// 分支状态展示的单测(spec §6「变更列表与分支状态」的 `[S3a]` 那条)。
//
// 守的是一件**不会报错、只会说假话**的事:无上游的分支不输出 `# branch.ab` 行
// (已实测,§5.2),后端因此把 `upstream` 给成 `null`;而 `upstream?.ahead ?? 0`
// 这种写法会把它画成「↑0 ↓0」,页面上看起来一切正常,只是把「没有可比对象」
// 说成了「与上游同步」。
//
// **两个方向都要断言**:只断言「无上游那份里没有箭头」时,组件整个画空也是绿的;
// 只断言「有上游那份画出了数字」时,退化成 0/0 也是绿的。前两条用例合起来才是那条
// 验收项的完整形态 —— 任何把两种状态画成同一个样子的退化,都会让其中一条红。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchState } from '../../../src/server/shared/protocol';
import { App } from '../../../src/web/components/App';
import { BranchStatus } from '../../../src/web/components/BranchStatus';
import { diffState, loadError, repoState } from '../../../src/web/state/store';

const branch = (partial: Partial<BranchState> = {}): BranchState => ({
  head: 'main',
  detached: false,
  upstream: null,
  ...partial,
});

let container: HTMLElement;

/**
 * 等到断言成立,而不是等固定的毫秒数。
 *
 * 只有 App 那条用得上:`render()` 的首次挂载是同步的,而「写 signal → 重画」隔着
 * 一个微任务。`interval` 调小的理由同 diff-view.test.tsx —— 默认 50ms 一格比实际
 * 就绪时间粗得多,`timeout` 不动,慢机器的余量分毫不减。
 */
const waitFor = (assert: () => void) => vi.waitFor(assert, { interval: 5 });

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  // signals 活在组件树之外(§5.4),不清就会漏进下一个用例
  repoState.value = null;
  loadError.value = null;
  diffState.value = null;
});

/** 渲染后的可见文本,空白归一 —— 断言压的是「用户看到什么」,不是 DOM 结构。 */
function textOf(node: Element | null): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('BranchStatus', () => {
  it('无上游时展示「无上游」,而不是 0/0', () => {
    render(<BranchStatus branch={branch({ head: 'feature/no-upstream' })} />, container);
    const text = textOf(container);

    // 正面:分支名与「无上游」都真的画出来了(缺了这条,下面那条对空 DOM 也成立)
    expect(text).toContain('feature/no-upstream');
    expect(text).toContain('no upstream');
    // 反面:一个箭头都不许出现 —— ahead/behind 在这里根本无从谈起。
    // 只钉箭头不钉数字:分支名本身可以含数字(`release/1.0`),把数字也禁掉等于给
    // fixture 加一条看不见的约束,改个名字就会以一个与验收项无关的理由变红
    expect(text).not.toMatch(/[↑↓]/);
  });

  it('有上游时 ahead/behind 与 `git status` 的 `# branch.ab +2 -1` 一致', () => {
    render(<BranchStatus branch={branch({ upstream: { ahead: 2, behind: 1 } })} />, container);
    const text = textOf(container);

    expect(text).toContain('main');
    expect(text).toContain('↑2');
    expect(text).toContain('↓1');
    expect(text).not.toContain('no upstream');
  });

  it('有上游且已同步时展示 ↑0 ↓0,两个 0 都不省', () => {
    render(<BranchStatus branch={branch({ upstream: { ahead: 0, behind: 0 } })} />, container);
    const text = textOf(container);

    // 这一条与第一条合起来才是那条验收项:两种状态画成同一个样子(都成 0/0、
    // 都说「无上游」、或把 0 省掉变回一片空白)必然先让其中一条红
    expect(text).toContain('↑0');
    expect(text).toContain('↓0');
    expect(text).not.toContain('no upstream');
  });

  it('取不到分支名时给一句话,不是一段空白', () => {
    // `head` 为空是解析器在没有 `# branch.head` 时的初值(见 `BranchState.head`)
    render(<BranchStatus branch={branch({ head: '' })} />, container);
    expect(textOf(container)).toContain('Unknown branch');
  });
});

describe('BranchStatus 的降级标注(§5.3 / §6 的 `[S4b]`)', () => {
  it('detached 时不把 git 的字面量 `(detached)` 当分支名画出去', () => {
    // 后端**不替它编一个名字**(那是在事实来源那一层说假话,见 `BranchState.head`),
    // 所以「画什么」这件事就落在这里。原样画出去的症状是页面上凭空多出一个
    // 叫「(detached)」的分支 —— 不报错,只是没有这样一个分支
    render(<BranchStatus branch={branch({ head: '(detached)', detached: true })} />, container);
    const text = textOf(container);

    expect(text).not.toContain('(detached)');
    expect(text).toContain('Detached HEAD');
    // 也不该退回「无上游」:detached 时根本谈不上上游,而那句话是留给
    // 「有分支但没设上游」的(S3a 那条验收项要区分的正是它)
    expect(text).not.toContain('no upstream');
    expect(text).not.toMatch(/[↑↓]/);
  });

  it('detached 但确实有 ahead/behind 时照样画出来', () => {
    // `detached` 是拿 `# branch.head` 与字面量 `(detached)` 比出来的 —— porcelain v2
    // 给不出别的判据,而 git 允许真有一个分支叫这个名字。只按 `detached` 藏计数的
    // 写法会让那个分支的 ahead/behind 静默消失,所以判据连 upstream 一起看
    render(
      <BranchStatus
        branch={branch({ head: '(detached)', detached: true, upstream: { ahead: 1, behind: 2 } })}
      />,
      container,
    );
    const text = textOf(container);
    expect(text).toContain('↑1');
    expect(text).toContain('↓2');
  });

  it.each([
    ['rebase', 'Rebasing'],
    ['merge', 'Merging'],
    ['am', 'Applying patches'],
    ['cherry-pick', 'Cherry-picking'],
    ['revert', 'Reverting'],
    ['bisect', 'Bisecting'],
  ] as const)('operation=%s 标成「%s」', (operation, label) => {
    render(<BranchStatus branch={branch({ operation })} />, container);
    expect(textOf(container)).toContain(label);
  });

  it('没有进行中的操作时一个标签都不画', () => {
    // 反面证据。与 `WatchBadge` 同一条理由:常驻一个「正常」标签会让唯一要紧的
    // 那一次淹在一片永远正确的字里
    render(<BranchStatus branch={branch()} />, container);
    const text = textOf(container);
    for (const label of [
      'Rebasing',
      'Merging',
      'Applying patches',
      'Cherry-picking',
      'Reverting',
      'Bisecting',
    ]) {
      expect(text).not.toContain(label);
    }
  });

  it('rebase 停在半路时,detached 与「变基中」同时画出来', () => {
    // 两者是同时出现的两件事,不是二选一:rebase 期间 status 报的就是 `(detached)`
    // (已实测)。少画哪一个,用户都看不全自己的处境
    render(
      <BranchStatus branch={branch({ head: '(detached)', detached: true, operation: 'rebase' })} />,
      container,
    );
    const text = textOf(container);
    expect(text).toContain('Detached HEAD');
    expect(text).toContain('Rebasing');
  });
});

describe('App 的 header', () => {
  it('拿到 state 之后才画分支,且画的是 state 里的那一份', async () => {
    // 组件本身全绿、却压根没被挂进 App —— 这是上面四条一条都盖不到的失效方式。
    // **只挂载一次,之后只写 signal**:App 在渲染体里读 `repoState`,状态一变自己就
    // 重画;手动补一次 `render()` 会把「状态变了会不会重画」替它做掉(同 diff-view.test.tsx)
    render(<App />, container);
    const header = container.querySelector('header');

    // 判据是 header 里**只有**标题,而不是「没出现『无上游』」那类写法:后者与文案
    // 字面量耦合,改一次文案就永远真空通过 —— 而这条恰恰是来防「先画一个占位分支」的,
    // 写死 main、画成 0/0、画成「未知分支」都是同一种退化,这里一次全盖住
    expect(textOf(header)).toBe('GitGlance');

    repoState.value = {
      branch: branch({ head: 'release/1.0', upstream: { ahead: 3, behind: 0 } }),
      files: [],
      watch: { mode: 'native', tier: 'A' },
    };
    await waitFor(() => {
      const text = textOf(header);
      expect(text).toContain('release/1.0');
      expect(text).toContain('↑3');
      expect(text).toContain('↓0');
    });
  });
});
