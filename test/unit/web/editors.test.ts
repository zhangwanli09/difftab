// 编辑器标签栏的列表模型。
//
// 钉的是几条「不报错、只是不对」：预览 tab 每组只有一个且被**原位**顶掉（追加时位置会跳）、固定
// 幂等不 toggle（一次双击是三个事件，toggle 会在双击时把已固定的解开）、关活动 tab 按右邻居优先、
// 改名撞上已开着的 tab 要并入而不是留两个同键的。

import { afterEach, describe, expect, it } from 'vitest';
import {
  activeEditor,
  activeEditorKey,
  activeEditorPath,
  activeGroup,
  contextOf,
  type Editor,
  type EditorGroup,
  editorKey,
  editors,
  findEditor,
  focusEditor,
  groups,
  isOpenAnywhere,
  keyOf,
  moveEditor,
  openEditor,
  pinEditor,
  removeEditor,
  renameEditor,
  setEditorContext,
  splitEditor,
  visibleEditors,
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
    activeGroup.value.editors.value = [
      { kind: 'diff', path: 'a.ts', pinned: true },
      { kind: 'diff', path: 'b.ts', pinned: false },
      { kind: 'diff', path: 'c.ts', pinned: true },
    ];
    focusEditor('diff:c.ts');
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

  it('固定档：键不存在时追加一个固定 tab、现有预览不动；键存在时就地固定', () => {
    openEditor('diff', 'a.ts');
    expect(openEditor('file', 'b.ts', true)).toBeNull();
    expect(editors.value).toEqual([
      { kind: 'diff', path: 'a.ts', pinned: false },
      { kind: 'file', path: 'b.ts', pinned: true },
    ]);
    expect(activeEditorKey.value).toBe('file:b.ts');

    // 预览 a.ts 再以固定档打开：不追加、就地转正、切过去
    expect(openEditor('diff', 'a.ts', true)).toBeNull();
    expect(editors.value).toEqual([
      { kind: 'diff', path: 'a.ts', pinned: true },
      { kind: 'file', path: 'b.ts', pinned: true },
    ]);
    expect(activeEditorKey.value).toBe('diff:a.ts');
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

  it('上下文档跟着改名走；并入同名 tab 时取靠后的那档', () => {
    openPinned('diff', 'a.ts');
    setEditorContext('diff:a.ts', 'full');
    renameEditor('diff', 'a.ts', 'a2.ts');
    expect(contextOf(editors.value[0] as Editor)).toBe('full');

    openPinned('diff', 'b.ts');
    setEditorContext('diff:b.ts', 'unavailable');
    renameEditor('diff', 'a2.ts', 'b.ts');
    expect(keys()).toEqual(['diff:b.ts']);
    expect(contextOf(editors.value[0] as Editor)).toBe('unavailable');

    // 反过来也一样：幸存者是 hunks、并进来的是 full
    openPinned('diff', 'c.ts');
    openPinned('diff', 'd.ts');
    setEditorContext('diff:d.ts', 'full');
    renameEditor('diff', 'd.ts', 'c.ts');
    expect(contextOf(editors.value.find((e) => e.path === 'c.ts') as Editor)).toBe('full');
  });

  it('被顶掉的预览 tab 不把上下文档留给顶替它的那个', () => {
    openEditor('diff', 'a.ts');
    setEditorContext('diff:a.ts', 'full');
    openEditor('diff', 'b.ts');
    expect(keys()).toEqual(['diff:b.ts']);
    expect(contextOf(editors.value[0] as Editor)).toBe('hunks');
  });

  it('只改这一种 kind 的 tab', () => {
    openPinned('file', 'a.ts');
    renameEditor('diff', 'a.ts', 'b.ts');
    expect(keys()).toEqual(['file:a.ts']);
  });
});

describe('两栏的高亮路径', () => {
  it('是活动 tab 的路径，不看它是 diff 还是全文；没有 tab 时为空', () => {
    expect(activeEditorPath.value).toBeNull();
    openPinned('diff', 'a.ts');
    expect(activeEditorPath.value).toBe('a.ts');
    openPinned('file', 'b.ts');
    expect(activeEditorPath.value).toBe('b.ts');
    focusEditor('diff:a.ts');
    expect(activeEditorPath.value).toBe('a.ts');
  });
});

describe('分屏（编辑器组）', () => {
  const keysOf = (group: EditorGroup | undefined): string[] =>
    group?.editors.value.map(keyOf) ?? [];
  const findEditorIn = (group: EditorGroup, key: string): Editor | undefined =>
    group.editors.value.find((editor) => keyOf(editor) === key);

  /** 一组里开着 a、b 两个固定 tab，把 b 分到右组。回左右两组。 */
  function splitAB(): [EditorGroup, EditorGroup] {
    openPinned('diff', 'a.ts');
    openPinned('diff', 'b.ts');
    const left = activeGroup.value;
    splitEditor(left, 'diff:b.ts');
    const right = groups.value[1];
    if (right === undefined) throw new Error('没分出来');
    return [left, right];
  }

  it('分出右组：tab 移过去、焦点跟过去，左组少了它', () => {
    const [left, right] = splitAB();
    expect(groups.value).toEqual([left, right]);
    expect(keysOf(left)).toEqual(['diff:a.ts']);
    expect(keysOf(right)).toEqual(['diff:b.ts']);
    expect(activeGroup.value).toBe(right);
    expect(activeEditorKey.value).toBe('diff:b.ts');
  });

  it('只有一个 tab 的组不能再分：分出去等于原地不动', () => {
    openPinned('diff', 'a.ts');
    expect(splitEditor(activeGroup.value, 'diff:a.ts')).toBeNull();
    expect(groups.value).toHaveLength(1);
  });

  it('封顶两组', () => {
    const [left] = splitAB();
    openPinned('diff', 'c.ts');
    focusEditor('diff:a.ts', left);
    openPinned('diff', 'd.ts');
    expect(splitEditor(left, 'diff:d.ts')).toBeNull();
    expect(groups.value).toHaveLength(2);
  });

  it('拖到另一组即固定——留成预览会被那一组下一次单击顶掉', () => {
    const [left, right] = splitAB();
    focusEditor('diff:a.ts', left);
    openEditor('diff', 'p.ts');
    const moved = moveEditor(left, 'diff:p.ts', right, 0);
    expect(moved?.pinned).toBe(true);
    expect(keysOf(right)).toEqual(['diff:p.ts', 'diff:b.ts']);
    expect(activeGroup.value).toBe(right);
  });

  it('目标组已开着同键时不并排第二个，只切过去；上下文档两组本来同档，照旧', () => {
    const [left, right] = splitAB();
    openPinned('diff', 'a.ts');
    setEditorContext('diff:a.ts', 'unavailable');
    moveEditor(left, 'diff:a.ts', right);
    expect(keysOf(right)).toEqual(['diff:b.ts', 'diff:a.ts']);
    expect(contextOf(right.editors.value[1])).toBe('unavailable');
  });

  it('组被拖空、关空即合并，焦点落到剩下那组', () => {
    const [left, right] = splitAB();
    moveEditor(left, 'diff:a.ts', right);
    expect(groups.value).toEqual([right]);
    expect(activeGroup.value).toBe(right);

    const [l2, r2] = splitAB();
    focusEditor('diff:b.ts', r2);
    removeEditor('diff:b.ts', r2);
    expect(groups.value).toEqual([l2]);
    expect(activeGroup.value).toBe(l2);
  });

  it('只剩一组时关空不合并：空着就画空态', () => {
    openPinned('diff', 'a.ts');
    const only = activeGroup.value;
    removeEditor('diff:a.ts');
    expect(groups.value).toEqual([only]);
  });

  it('预览 tab 每组各一个', () => {
    const [left, right] = splitAB();
    openEditor('diff', 'p.ts');
    focusEditor('diff:a.ts', left);
    openEditor('diff', 'q.ts');
    expect(keysOf(right)).toEqual(['diff:b.ts', 'diff:p.ts']);
    expect(keysOf(left)).toEqual(['diff:a.ts', 'diff:q.ts']);
  });

  it('同一个 tab 两组各开一份：上下文档一起改，关掉一份另一份还在', () => {
    const [left, right] = splitAB();
    openPinned('diff', 'a.ts');
    expect(isOpenAnywhere('diff:a.ts')).toBe(true);
    setEditorContext('diff:a.ts', 'full');
    expect(contextOf(left.editors.value[0])).toBe('full');
    expect(contextOf(right.editors.value[1])).toBe('full');

    removeEditor('diff:a.ts', right);
    expect(isOpenAnywhere('diff:a.ts')).toBe(true);
    expect(findEditor('diff:a.ts')).toBeDefined();
    removeEditor('diff:a.ts', left);
    expect(isOpenAnywhere('diff:a.ts')).toBe(false);
  });

  it('另一组新开同键 tab 时接过已有的上下文档，不从 hunks 起步', () => {
    const [left, right] = splitAB();
    setEditorContext('diff:a.ts', 'full');
    focusEditor('diff:b.ts', right);
    openEditor('diff', 'a.ts');
    expect(contextOf(right.editors.value[1])).toBe('full');
    expect(contextOf(left.editors.value[0])).toBe('full');
  });

  it('逐组改名并入后两组同档：取靠后的那档', () => {
    const [left, right] = splitAB();
    // 左组：a（hunks）、b（full）；右组：b 移走后只开着 a（hunks）
    openPinned('diff', 'a.ts');
    moveEditor(right, 'diff:b.ts', left);
    focusEditor('diff:a.ts', right);
    setEditorContext('diff:b.ts', 'full');
    renameEditor('diff', 'a.ts', 'b.ts', left);
    renameEditor('diff', 'a.ts', 'b.ts', right);
    expect(contextOf(findEditorIn(left, 'diff:b.ts'))).toBe('full');
    expect(contextOf(findEditorIn(right, 'diff:b.ts'))).toBe('full');
  });

  it('看得见的是每组的活动 tab，同键只算一次', () => {
    const [left] = splitAB();
    expect(visibleEditors.value.map(keyOf)).toEqual(['diff:a.ts', 'diff:b.ts']);
    focusEditor('diff:a.ts', left);
    openPinned('diff', 'b.ts');
    expect(visibleEditors.value.map(keyOf)).toEqual(['diff:b.ts']);
  });

  it('左栏的高亮跟焦点组', () => {
    const [left] = splitAB();
    expect(activeEditorPath.value).toBe('b.ts');
    focusEditor('diff:a.ts', left);
    expect(activeEditorPath.value).toBe('a.ts');
    expect(activeEditor.value?.path).toBe('a.ts');
  });
});
