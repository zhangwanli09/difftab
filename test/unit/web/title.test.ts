// 标签页标题(spec §5.4)。
//
// **能自动化的是格式与那条 wiring,压不到的是「压窄之后先没哪半」** —— 截断是浏览器
// 的排版行为,happy-dom 上没有标签栏可量。那半归 `acceptance.md` §6 的肉眼项。

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepoState } from '../../../src/server/shared/protocol';
import { repoState } from '../../../src/web/state/store';
import { syncDocumentTitle, titleFor } from '../../../src/web/state/title';

const stateWith = (repoName: string): RepoState => ({
  repoName,
  branch: { head: 'main', detached: false, upstream: null },
  files: [],
  watch: { mode: 'native', tier: 'A' },
});

// `repoState` 是模块级 signal,上一条用例写进去的快照会跨用例串味
afterEach(() => {
  repoState.value = null;
});

describe('titleFor', () => {
  it('仓库名排在产品名之前 —— 标签压窄时从尾部截断,认项目靠的是前半段', () => {
    expect(titleFor('my-app')).toBe('my-app · difftab');
  });

  it('空串退回纯产品名 —— 不编一个占位名出来', () => {
    // 空串的含义是「这个根目录没有 basename」(`/`、Windows 盘符根),见 protocol.ts
    expect(titleFor('')).toBe('difftab');
  });

  it('中文目录名原样进标题 —— 仓库名是用户数据,不受「界面文案一律英文」约束', () => {
    // 冒烟那条 CJK 门禁查的是 `dist/web/` 的产物字面量,而这是运行时才有的值
    expect(titleFor('我的项目')).toBe('我的项目 · difftab');
  });
});

describe('syncDocumentTitle', () => {
  it('第一份状态到之前保持纯产品名,到了之后带上仓库名', () => {
    const stop = syncDocumentTitle();
    try {
      // effect 首次订阅就跑一次,此时 repoState 还是 null
      expect(document.title).toBe('difftab');

      repoState.value = stateWith('my-app');
      expect(document.title).toBe('my-app · difftab');
    } finally {
      stop();
    }
  });

  it('仓库名没变的刷新不重写标题 —— computed 去重,SSE 事件密集时不白写', () => {
    // 钉的是 title.ts 里那个 computed 的存在理由:`repoState` 每次刷新都是新对象,
    // 直接订阅它会让每个 change 事件都重写一遍标题(同 layout.ts 的「每像素一次」)
    const stop = syncDocumentTitle();
    const setTitle = vi.spyOn(document, 'title', 'set');
    try {
      repoState.value = stateWith('my-app');
      expect(setTitle).toHaveBeenCalledTimes(1);

      // 同名的下一份快照:字段全等、对象不同 —— 正是 SSE 刷新的常态形态
      repoState.value = stateWith('my-app');
      expect(setTitle).toHaveBeenCalledTimes(1);
    } finally {
      setTitle.mockRestore();
      stop();
    }
  });

  it('后续每次刷新都跟着走 —— SSE 的 change 会整份换掉 repoState', () => {
    const stop = syncDocumentTitle();
    try {
      repoState.value = stateWith('my-app');
      repoState.value = stateWith('another-repo');
      expect(document.title).toBe('another-repo · difftab');

      // 取消订阅之后就不该再动它了 —— 这半条压的是 effect 真的被停掉
      stop();
      repoState.value = stateWith('ignored');
      expect(document.title).toBe('another-repo · difftab');
    } finally {
      stop();
    }
  });
});
