// 顶栏那一行字，以及它右端那个明暗开关。
//
// 钉的是**顶栏写的是项目名而不是产品名**：改回产品名不会让任何别的用例变红，而页面上
// 一排标签里的每个 difftab 实例从此长得一模一样——这一栏存在的理由正是分辨「我在看
// 哪个项目」。兜底那半条同理：退回 `PRODUCT_NAME` 与「编一个占位名出来」在类型上没差别。
//
// 顶栏变成 flex 容器之后还多钉一条**树的形状**：`truncate` 必须落在装名字的那个 span 上。
// 留在 header 上不报错、类名也还在原地，只是不起作用（子项的自动最小尺寸照样撑开它），
// 而症状是长目录名重新漫过右边框——与 change-list 那条「同住一个 truncate span」同理，
// 能自动化的是形状，「谁先被裁」归肉眼。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoState } from '../../../src/server/shared/protocol';
import { App } from '../../../src/web/components/App';
import { diffState, repoState } from '../../../src/web/state/store';
import { PRODUCT_NAME } from '../../../src/web/state/title';

const stateWith = (repoName: string): RepoState => ({
  repoName,
  branch: { head: 'main', detached: false, upstream: null },
  files: [],
  watch: { mode: 'native', tier: 'A' },
});

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  // signals 活在组件树之外，不清就会漏进下一个用例
  repoState.value = null;
  diffState.value = null;
});

const header = () => container.querySelector('header');
const headerText = () => header()?.textContent?.trim();

describe('左栏顶栏', () => {
  it('写的是项目名——不是产品名', () => {
    repoState.value = stateWith('my-app');
    render(<App />, container);
    expect(headerText()).toBe('my-app');
  });

  it('第一份 state 还没到时退回产品名——顶栏不空着一条边框', () => {
    render(<App />, container);
    expect(headerText()).toBe(PRODUCT_NAME);
  });

  it('根目录没有 basename 时同样退回产品名——不编一个占位名出来', () => {
    // 空串的含义见 protocol.ts:`/`、Windows 盘符根。与「还没到」合成同一种情况
    repoState.value = stateWith('');
    render(<App />, container);
    expect(headerText()).toBe(PRODUCT_NAME);
  });
});

describe('顶栏的形状', () => {
  it('项目名住在自己的 truncate span 里——truncate 挂在 flex 容器上是不起作用的', () => {
    repoState.value = stateWith('a-very-long-project-directory-name');
    render(<App />, container);

    const truncating = header()?.querySelector('.truncate');
    expect(truncating?.textContent).toBe('a-very-long-project-directory-name');
    // 反过来钉一次：header 自己不再是那个截断盒
    expect(header()?.classList.contains('truncate')).toBe(false);
  });

  it('右端有一个带无障碍名的主题开关——它是顶栏里唯一的另一样东西', () => {
    repoState.value = stateWith('my-app');
    render(<App />, container);

    const buttons = header()?.querySelectorAll('button') ?? [];
    expect(buttons).toHaveLength(1);
    // 只画图标，名字只能由 aria-label 给——掉了它这个按钮在读屏里就是一个无名控件
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Follow system');
  });

  it('第一份 state 还没到时开关也在——它不依赖仓库状态', () => {
    render(<App />, container);
    expect(header()?.querySelectorAll('button')).toHaveLength(1);
  });
});
