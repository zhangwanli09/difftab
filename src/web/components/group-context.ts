// 视图属于哪一组编辑器。补丁表格的版式按**所在那一组**的宽度判（分屏时两组各量各的），而 `Patch` 埋在
// 视图好几层底下，逐层透传一个 prop 时每个中间组件都得学会它。

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { activeGroup, type EditorGroup } from '../state/editors';

export const GroupContext = createContext<EditorGroup | null>(null);

/** 所在那一组；不在任何组里（单独挂载一个视图的用例）时退回焦点组。 */
export function useGroup(): EditorGroup {
  return useContext(GroupContext) ?? activeGroup.value;
}
