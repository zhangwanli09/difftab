// 变更列表树视图的建树与折叠态。
//
// 钉的是三条「不报错、只是不对」：单子目录链要合并成一个节点（不合并时 320px 里三层缩进只为放
// 一个文件）、有文件的目录不能合并（合并后那几个文件看起来属于更深的那层）、折叠键带分组 id
// （不带时折 Staged 里的 `src` 连 Unstaged 里的一起没了）。

import { afterEach, describe, expect, it } from 'vitest';
import type { FileEntry } from '../../../src/server/shared/protocol';
import {
  buildChangeTree,
  type ChangeNode,
  changeView,
  collapsedChangeDirs,
  isChangeDirCollapsed,
  toggleChangeDir,
  toggleChangeView,
} from '../../../src/web/state/change-tree';

const file = (path: string): FileEntry => ({ kind: 'tracked', staged: 'M', unstaged: '.', path });

/** 一棵树压成 `name` 的缩进文本，断言时一眼能对形状。 */
function outline(nodes: readonly ChangeNode[], depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'directory'
      ? [`${'  '.repeat(depth)}${node.name}/`, ...outline(node.children, depth + 1)]
      : [`${'  '.repeat(depth)}${node.file.path.split('/').pop()}`],
  );
}

afterEach(() => {
  changeView.value = 'list';
  collapsedChangeDirs.value = new Set();
});

describe('buildChangeTree', () => {
  it('单子目录链合并成一个节点，path 取链尾', () => {
    const nodes = buildChangeTree([file('src/web/components/App.tsx')]);
    expect(outline(nodes)).toEqual(['src/web/components/', '  App.tsx']);
    expect(nodes[0]).toMatchObject({ kind: 'directory', path: 'src/web/components' });
  });

  it('有文件的目录不合并——那几个文件就在这一层', () => {
    const nodes = buildChangeTree([file('src/index.ts'), file('src/web/App.tsx')]);
    expect(outline(nodes)).toEqual(['src/', '  web/', '    App.tsx', '  index.ts']);
  });

  it('有两个子目录的目录不合并，且链只合并到分叉处为止', () => {
    const nodes = buildChangeTree([
      file('src/web/a/x.ts'),
      file('src/web/b/y.ts'),
      file('README.md'),
    ]);
    expect(outline(nodes)).toEqual([
      'src/web/',
      '  a/',
      '    x.ts',
      '  b/',
      '    y.ts',
      'README.md',
    ]);
  });

  it('每层目录在前、文件在后，各自沿用给定顺序不再排序', () => {
    const nodes = buildChangeTree([file('b.ts'), file('z/1.ts'), file('a.ts'), file('m/2.ts')]);
    expect(outline(nodes)).toEqual(['z/', '  1.ts', 'm/', '  2.ts', 'b.ts', 'a.ts']);
  });

  it('文件节点带的是原条目本身——重命名与状态位都要从它上面取', () => {
    const entry = file('a.ts');
    const nodes = buildChangeTree([entry]);
    expect(nodes[0]).toEqual({ kind: 'file', file: entry });
  });
});

describe('折叠态', () => {
  it('默认全展开：空集，不必为任何目录登记', () => {
    expect(collapsedChangeDirs.value.size).toBe(0);
  });

  it('键带分组 id——同一目录在 Staged 与 Unstaged 里是两棵子树', () => {
    toggleChangeDir('staged', 'src');
    expect(isChangeDirCollapsed('staged', 'src')).toBe(true);
    expect(isChangeDirCollapsed('unstaged', 'src')).toBe(false);
  });

  it('再点一下就展开', () => {
    toggleChangeDir('staged', 'src');
    toggleChangeDir('staged', 'src');
    expect(isChangeDirCollapsed('staged', 'src')).toBe(false);
    expect(collapsedChangeDirs.value.size).toBe(0);
  });
});

describe('版式', () => {
  it('默认列表，切一下是树，再切回列表', () => {
    expect(changeView.value).toBe('list');
    toggleChangeView();
    expect(changeView.value).toBe('tree');
    toggleChangeView();
    expect(changeView.value).toBe('list');
  });
});
