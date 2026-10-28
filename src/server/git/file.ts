// 文件浏览器右侧那一份只读全文。
//
// **直接读磁盘，不经 git**：树上点得到的路径包含未跟踪与被忽略的文件，它们在对象库里根本
// 没有对应的对象；而已跟踪文件要看的也是**工作区**那一份，不是 index 或 HEAD 那一份。
//
// 边界、`lstat` 而非 `stat`、两道闸与二进制探测全归 `worktree.ts`——本文件只把它给的分类
// 翻译成 `FilePayload`。这条链先前在这里和 `untrackedDiff` 里各写了一遍，两份在第一次提交
// 时就已经漂开（行数口径差一），正是「阈值不得写两份」那条红线说的那种漂移。

import type { FilePayload } from '../shared/protocol.ts';
import { inspectFile, isMarkdown, isSvg } from './worktree.ts';

/** 读一个文件用于只读展示。 */
export async function readFileContent(root: string, path: string): Promise<FilePayload> {
  const file = await inspectFile(root, path);
  switch (file.kind) {
    // 给的是**链接目标字符串本身**，不是目标文件的内容
    case 'symlink':
      return { kind: 'symlink', target: file.target };
    case 'binary':
    case 'too-large':
      return file;
    // 与 text 一样只把元数据带出去，字节由 /api/blob 再走一遍同一条链
    case 'image':
      return { kind: 'image', size: file.size, version: file.version };
    // SVG 与 markdown 照旧是文本，前者另带一份预览元数据；体积已过 5MB 那道闸，`/api/blob` 不会拒它
    case 'text':
      return {
        kind: 'text',
        content: file.buffer.toString('utf8'),
        ...(isSvg(path) && { preview: { size: file.size, version: file.version } }),
        // markdown 只带一个标记：渲染要的就是这份正文，不必另取字节
        ...(isMarkdown(path) && { markdown: true }),
      };
  }
}
