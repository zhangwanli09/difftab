// 顶栏那一行字。
//
// 钉的是**顶栏写的是项目名而不是产品名**:改回产品名不会让任何别的用例变红,而页面上
// 一排标签里的每个 difftab 实例从此长得一模一样 —— 这一栏存在的理由正是分辨「我在看
// 哪个项目」。兜底那半条同理:退回 `PRODUCT_NAME` 与「编一个占位名出来」在类型上没差别。

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
  // signals 活在组件树之外,不清就会漏进下一个用例
  repoState.value = null;
  diffState.value = null;
});

const headerText = () => container.querySelector('header')?.textContent?.trim();

describe('左栏顶栏', () => {
  it('写的是项目名 —— 不是产品名', () => {
    repoState.value = stateWith('my-app');
    render(<App />, container);
    expect(headerText()).toBe('my-app');
  });

  it('第一份 state 还没到时退回产品名 —— 顶栏不空着一条边框', () => {
    render(<App />, container);
    expect(headerText()).toBe(PRODUCT_NAME);
  });

  it('根目录没有 basename 时同样退回产品名 —— 不编一个占位名出来', () => {
    // 空串的含义见 protocol.ts:`/`、Windows 盘符根。与「还没到」合成同一种情况
    repoState.value = stateWith('');
    render(<App />, container);
    expect(headerText()).toBe(PRODUCT_NAME);
  });
});
