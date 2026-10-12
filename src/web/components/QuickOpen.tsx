// Quick Open：`⌘P` / `Ctrl+P` 或顶栏 `Go to File` 弹出，照 VS Code——按文件名模糊匹配全仓文件，
// 选中即以**固定** tab 打开全文（VS Code `workbench.editor.enablePreviewFromQuickOpen` 默认 `false`）。
// 外壳是与分支列表共用的 `QuickPick`；匹配与打分在 `state/quick-open.ts`。

import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { isAbsentFromWorktree } from '../../server/shared/protocol';
import {
  fileList,
  fileListError,
  loadFileList,
  matchFiles,
  type PathMatch,
  quickOpenVisible,
} from '../state/quick-open';
import { openFile, repoState } from '../state/store';
import { splitForDisplay } from './ChangeList';
import { QuickPick, type RowProps } from './QuickPick';

/**
 * 空输入列当前的变更文件：VS Code 在这里列「最近打开」，本工具最常要跳的是 agent 刚改过的那批。
 * 工作区里已不存在的不列——它唯一能打开的是一条错误（判据同 `Open file`）。
 */
function changedPaths(): PathMatch[] {
  const files = repoState.value?.files ?? [];
  return files
    .filter((file) => !isAbsentFromWorktree(file))
    .map((file) => ({ path: file.path, score: 0, positions: [] }));
}

export function QuickOpen({ anchor }: { anchor: RefObject<HTMLElement> }) {
  // 打开前焦点在哪，关掉时就还给哪：取的是第一次渲染那一刻，`QuickPick` 把焦点挪进输入框之前
  const returnFocus = useRef(document.activeElement as HTMLElement | null);

  useEffect(() => {
    void loadFileList();
  }, []);

  const close = () => {
    quickOpenVisible.value = false;
    returnFocus.current?.focus?.();
  };

  return (
    <QuickPick<PathMatch, null>
      idPrefix="quick-open"
      label="Go to File"
      inputLabel="Search files by name"
      placeholder="Search files by name"
      anchor={anchor}
      match={(query) => {
        if (query.trim() === '') return changedPaths();
        const paths = fileList.value;
        return paths === null ? [] : matchFiles(paths, query);
      }}
      keyOf={(match) => match.path}
      Row={PathRow}
      context={null}
      status={fileListError.value}
      noMatch={(query) =>
        query.trim() === ''
          ? 'No changed files — type to search by name'
          : fileList.value === null
            ? 'Loading…'
            : 'No matching files'
      }
      onPick={(match) => openFile(match.path, { pinned: true })}
      onClose={close}
    />
  );
}

/** 一行 = 文件名 + 目录，两段同住一个 `truncate` span（理由同变更列表），命中的字符加粗。 */
function PathRow({ item }: RowProps<PathMatch, null>) {
  const { dir, name } = splitForDisplay(item.path);
  const hit = new Set(item.positions);
  const nameStart = item.path.length - name.length;
  return (
    <div class="truncate" title={item.path}>
      {emphasize(name, nameStart, hit)}
      {dir && (
        <span class="ml-2 text-xs text-description-foreground">{emphasize(dir, 0, hit)}</span>
      )}
    </div>
  );
}

/** 把 `text`（在整条路径里从 `offset` 起）切成普通段与命中段，命中段加粗。 */
function emphasize(text: string, offset: number, hit: ReadonlySet<number>): ComponentChildren {
  if (hit.size === 0) return text;
  const parts: ComponentChildren[] = [];
  let run = '';
  let bold = false;
  const flush = () => {
    if (run === '') return;
    parts.push(bold ? <b class="font-semibold text-editor-foreground">{run}</b> : run);
    run = '';
  };
  for (let i = 0; i < text.length; i += 1) {
    const isHit = hit.has(offset + i);
    if (isHit !== bold) {
      flush();
      bold = isHit;
    }
    run += text[i];
  }
  flush();
  return parts;
}
