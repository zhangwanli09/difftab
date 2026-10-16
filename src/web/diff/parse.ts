// unified diff → hunk 与行。**diff2html 在这条路上只剩解析器**：渲染、词级 diff、两侧联动都
// 归我们自己（`rows.ts` / `render.ts` / `DiffView.tsx`）。
//
// 深导入 `diff-parser.js` 而不是包入口：入口 `diff2html.js` 连带引入两个 renderer 与 hogan 模板，
// 这里一个都用不着。`LineType` 只取类型——enum 作为值 import 会把整个枚举对象带进产物。

import { parse } from 'diff2html/lib-esm/diff-parser.js';
import type { LineType } from 'diff2html/lib-esm/types.js';

/** 一行属于哪一侧：`context` 两侧都有，`delete` 只在旧侧，`insert` 只在新侧。 */
export type LineKind = `${LineType}`;

export interface PatchLine {
  kind: LineKind;
  oldNo: number | undefined;
  newNo: number | undefined;
  /** 去掉行首 `+` / `-` / 空格之后的正文 */
  text: string;
}

export interface Hunk {
  /** `@@ -a,b +c,d @@ …` 那一行，原样 */
  header: string;
  lines: PatchLine[];
}

/**
 * 解析一份补丁，**一个文件段一个数组**。调用方给的是单个路径的补丁，但它可以有两段：类型变了
 * 的路径（符号链接换成普通文件）git 给的是一段删除加一段新增。两段是两个文件版本，语言判定的
 * 状态不能从前一段带进后一段，所以段界留给调用方。
 *
 * 没有 hunk 是正常结果（只改了权限位、二进制补丁头），不是错误——由调用方决定画什么。
 * `\ No newline at end of file` 由上游解析器丢掉，这里看不见。
 */
export function parsePatch(patch: string): Hunk[][] {
  return parse(patch).map((file) =>
    file.blocks.map((block) => ({
      header: block.header,
      lines: block.lines.map((line) => ({
        kind: line.type as LineKind,
        oldNo: line.oldNumber,
        newNo: line.newNumber,
        // 我们的补丁全是两方 diff（组合 diff 不做），前缀恒为一个字符
        text: line.content.slice(1),
      })),
    })),
  );
}
