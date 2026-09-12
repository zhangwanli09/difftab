// 编辑器标签栏的列表模型。
//
// 钉的是几条「不报错、只是不对」：预览 tab 全局只有一个且被**原位**顶掉（追加时位置会跳）、固定
// 幂等不 toggle（一次双击是三个事件，toggle 会在双击时把已固定的解开）、关活动 tab 按右邻居优先、
// 改名撞上已开着的 tab 要并入而不是留两个同键的。

import { afterEach, describe, expect, it } from 'vitest';
import {
  activeDiffPath,
  activeEditor,
  activeEditorKey,
  activeFilePath,
  type Editor,
  editorKey,
  editors,
  focusEditor,
  keyOf,
  openEditor,
  pinEditor,
  removeEditor,
  renameEditor,
} from '../../../src/web/state/editors';
import { openPinned, resetEditors } from './helpers';

const keys = (): string[] => editors.value.map(keyOf);
const preview = (): Editor | undefined => editors.value.find((editor) => !editor.pinned);

afterEach(resetEditors);

describe('openEditor', () => {
  it('没有预览 tab 时追加一个预览并激活', () => {
    expect(openEditor('diff', 'a.ts')).toBeNull();
    expect(editors.value).toEqual([{ kind: 'diff', path: 'a.ts', pinned: false }]);
    expect(activeEditorKey.value).toBe('diff:a.ts');
  });

  it('再开一个预览时原位顶掉旧预览，并把被顶掉的那个交回来', () => {
    // 预览夹在两个固定 tab 中间（直接摆出这个形状：公开操作只会把预览追加在末尾）：顶掉之后
    // 新的还在中间那个位置，不跳到末尾
    editors.value = [
      { kind: 'diff', path: 'a.ts', pinned: true },
      { kind: 'diff', path: 'b.ts', pinned: false },
      { kind: 'diff', path: 'c.ts', pinned: true },
    ];
    activeEditorKey.value = 'diff:c.ts';
    const replaced = openEditor('diff', 'd.ts');
    expect(replaced).toEqual({ kind: 'diff', path: 'b.ts', pinned: false });
    expect(keys()).toEqual(['diff:a.ts', 'diff:d.ts', 'diff:c.ts']);
    expect(activeEditorKey.value).toBe('diff:d.ts');
  });

  it('键已存在时只激活、不重复、预览仍是预览', () => {
    openPinned('diff', 'b.ts');
    openEditor('diff', 'a.ts');
    focusEditor('diff:b.ts');
    expect(openEditor('diff', 'a.ts')).toBeNull();
    expect(keys()).toEqual(['diff:b.ts', 'diff:a.ts']);
    expect(preview()?.path).toBe('a.ts');
    expect(activeEditorKey.value).toBe('diff:a.ts');
  });

  it('固定之后再开别的文件是追加，不顶掉它', () => {
    openPinned('diff', 'a.ts');
    expect(openEditor('diff', 'b.ts')).toBeNull();
    expect(keys()).toEqual(['diff:a.ts', 'diff:b.ts']);
    expect(preview()?.path).toBe('b.ts');
  });

  it('同一路径的 diff 与全文是两个 tab', () => {
    openPinned('diff', 'a.ts');
    openPinned('file', 'a.ts');
    expect(keys()).toEqual(['diff:a.ts', 'file:a.ts']);
  });

  it('路径里带冒号也不会与别的键撞上', () => {
    openPinned('diff', 'a:b');
    openPinned('diff', 'a');
    expect(keys()).toEqual([editorKey('diff', 'a:b'), editorKey('diff', 'a')]);
  });
});

describe('pinEditor', () => {
  it('幂等：固定两次仍是固定，不 toggle', () => {
    openEditor('diff', 'a.ts');
    pinEditor('diff:a.ts');
    pinEditor('diff:a.ts');
    expect(editors.value[0]?.pinned).toBe(true);
  });

  it('键不存在时无操作', () => {
    openEditor('diff', 'a.ts');
    pinEditor('diff:zzz');
    expect(editors.value).toEqual([{ kind: 'diff', path: 'a.ts', pinned: false }]);
  });
});

describe('focusEditor', () => {
  it('只切活动键并回切到的那一项；键不存在时无操作、回 null', () => {
    openPinned('diff', 'a.ts');
    openPinned('diff', 'b.ts');
    expect(focusEditor('diff:a.ts')).toMatchObject({ path: 'a.ts' });
    expect(activeEditor.value?.path).toBe('a.ts');
    expect(focusEditor('diff:zzz')).toBeNull();
    expect(activeEditor.value?.path).toBe('a.ts');
  });
});

describe('removeEditor', () => {
  const three = (): void => {
    openPinned('diff', 'a.ts');
    openPinned('diff', 'b.ts');
    openPinned('diff', 'c.ts');
  };

  it('关掉活动 tab 切到右邻居', () => {
    three();
    focusEditor('diff:b.ts');
    expect(removeEditor('diff:b.ts')).toEqual({ kind: 'diff', path: 'b.ts', pinned: true });
    expect(keys()).toEqual(['diff:a.ts', 'diff:c.ts']);
    expect(activeEditorKey.value).toBe('diff:c.ts');
  });

  it('活动 tab 在末尾时切到左邻居', () => {
    three();
    removeEditor('diff:c.ts');
    expect(activeEditorKey.value).toBe('diff:b.ts');
  });

  it('关掉最后一个 tab 后活动键为空', () => {
    openPinned('diff', 'a.ts');
    removeEditor('diff:a.ts');
    expect(editors.value).toEqual([]);
    expect(activeEditorKey.value).toBeNull();
    expect(activeEditor.value).toBeNull();
  });

  it('关掉非活动 tab 不动活动键', () => {
    three();
    removeEditor('diff:a.ts');
    expect(activeEditorKey.value).toBe('diff:c.ts');
  });

  it('键不存在时回 null、什么都不动', () => {
    three();
    expect(removeEditor('diff:zzz')).toBeNull();
    expect(keys()).toHaveLength(3);
  });
});

describe('renameEditor', () => {
  it('原地改路径，pinned 保留、活动键跟着走', () => {
    openPinned('diff', 'a.ts');
    openEditor('diff', 'b.ts');
    renameEditor('diff', 'b.ts', 'b2.ts');
    expect(editors.value[1]).toEqual({ kind: 'diff', path: 'b2.ts', pinned: false });
    expect(activeEditorKey.value).toBe('diff:b2.ts');
  });

  it('非活动 tab 改名不动活动键', () => {
    openPinned('diff', 'a.ts');
    openPinned('diff', 'b.ts');
    renameEditor('diff', 'a.ts', 'a2.ts');
    expect(activeEditorKey.value).toBe('diff:b.ts');
  });

  it('新路径上已有 tab 时并入它：幸存者保位置、pinned 取或、活动键移过去', () => {
    openEditor('diff', 'a.ts');
    openPinned('diff', 'b.ts');
    openPinned('diff', 'c.ts');
    focusEditor('diff:a.ts');
    renameEditor('diff', 'a.ts', 'c.ts');
    expect(keys()).toEqual(['diff:b.ts', 'diff:c.ts']);
    expect(activeEditorKey.value).toBe('diff:c.ts');
    // 预览并入固定，结果是固定
    openPinned('diff', 'd.ts');
    openEditor('diff', 'e.ts');
    renameEditor('diff', 'd.ts', 'e.ts');
    expect(editors.value.find((editor: Editor) => editor.path === 'e.ts')?.pinned).toBe(true);
  });

  it('只改这一种 kind 的 tab', () => {
    openPinned('file', 'a.ts');
    renameEditor('diff', 'a.ts', 'b.ts');
    expect(keys()).toEqual(['file:a.ts']);
  });
});

describe('两栏的高亮路径', () => {
  it('按活动 tab 的 kind 恰有一个非空', () => {
    openPinned('diff', 'a.ts');
    expect(activeDiffPath.value).toBe('a.ts');
    expect(activeFilePath.value).toBeNull();
    openPinned('file', 'a.ts');
    expect(activeDiffPath.value).toBeNull();
    expect(activeFilePath.value).toBe('a.ts');
  });
});
