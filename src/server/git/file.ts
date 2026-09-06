// 文件浏览器右侧那一份只读全文。
//
// **直接读磁盘，不经 git**：树上点得到的路径包含未跟踪与被忽略的文件，它们在对象库里根本
// 没有对应的对象；而已跟踪文件要看的也是**工作区**那一份，不是 index 或 HEAD 那一份。
//
// 边界、`lstat` 而非 `stat`、两道闸与二进制探测全归 `worktree.ts`——本文件只把它给的分类
// 翻译成 `FilePayload`。这条链先前在这里和 `untrackedDiff` 里各写了一遍，两份在第一次提交
// 时就已经漂开（行数口径差一），正是「阈值不得写两份」那条红线说的那种漂移。

import type { FilePayload } from '../shared/protocol.ts';
import { inspectFile } from './worktree.ts';

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
    case 'text':
      return { kind: 'text', content: file.buffer.toString('utf8') };
  }
}
