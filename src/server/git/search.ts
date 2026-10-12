// 全仓内容搜索。**只读白名单为这里只加了 `grep` 一条**，搜的是**工作区此刻**的内容——已跟踪文件
// 读工作区那一份，不是 index 或 HEAD，agent 刚写下的字节立刻搜得到。

import {
  MAX_SEARCH_LINES,
  type SearchFile,
  type SearchMatch,
  type SearchPayload,
} from '../shared/protocol.ts';
import { GitError, runGit } from './run.ts';

/** 查询的长度上限（UTF-16 码元）。再长就不是「搜一个东西」了，而它整条进 argv。 */
export const MAX_QUERY_LENGTH = 1000;

// 行数上限 `MAX_SEARCH_LINES` 在协议里（前端的截断提示要说出这个数）。**它与下面的字节上限任一
// 触发即 `truncated`**：git 2.38 才有 `-m`，靠不住，只能在 JS 里截；而一个字母的查询在大仓库里是
// 几十万行，全挂进侧栏 DOM 是可感知的卡顿。

/**
 * stdout 的上限，到了即掐断 git、**收下已到的部分**（`truncate` 档）。不靠它时，一个字母的查询在
 * 大仓库里要等 git 把整仓读完才回得来，而前 2,000 行早就到了。
 */
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;

/**
 * 预览文本的长度上限。超过时裁成首个命中前 `PREVIEW_LEAD` 个字符起的一截：一份压缩过的 JS 一行
 * 就是整个文件，原样回传时一次搜索的 payload 就是几 MB。
 */
const MAX_PREVIEW = 300;
const PREVIEW_LEAD = 40;
const ELLIPSIS = '…';

export interface SearchOptions {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
}

/**
 * `grep` 的 argv，**除 `-i` / `-w` 两个可选位与 `-e` 后那个值外整条是字面量**，冒烟逐段钉着。两条
 * `-c`（`grep.column` 与 `submodule.recurse`）由 `run.ts` 注入，不写在这里。
 *
 * - `-I` **不能省**：不带时二进制文件吐的是一行 `Binary file <路径> matches`，没有 NUL 段，解析器会
 *   把它与下一条粘成一条；
 * - `--no-textconv`：与 `diff` 同一道外部程序闸。**禁 `-O`（起 pager）、`-f`（读文件当模式）、
 *   `--no-index`（搜仓库外）、`--textconv`**——白名单只看子命令；
 * - `-F -e <查询>`：字面量（`grep.patternType` 被命令行的 `-F` 盖过），`-e` 让以 `-` 开头的查询
 *   不被当成选项；
 * - `--untracked`：agent 新建、还没 add 的文件也搜得到，仍尊重 `.gitignore`。
 */
export function grepArgs({ query, matchCase, wholeWord }: SearchOptions): string[] {
  return [
    'grep',
    '--no-color',
    '--no-textconv',
    '-I',
    '-z',
    '-n',
    '-F',
    '--untracked',
    ...(matchCase ? [] : ['-i']),
    ...(wholeWord ? ['-w'] : []),
    '-e',
    query,
    '--',
  ];
}

/** 退出码 1 是「没有命中」，不是错误；其余非零照常是错误。 */
export async function searchRepo(root: string, options: SearchOptions): Promise<SearchPayload> {
  const args = grepArgs(options);
  const result = await runGit(args, root, { maxStdoutBytes: MAX_SEARCH_BYTES, truncate: true });
  if (!result.truncated) {
    if (result.code === 1) return { files: [], truncated: false };
    if (result.code !== 0) throw new GitError('exit', args, result.stderr, result.code);
  }
  return parseGrep(result.stdout, options, result.truncated === true);
}

/**
 * `-z -n` 的记录是 `<路径>\0<行号>\0<内容>\n`，**按「读到 NUL → 读到 NUL → 读到换行」顺序解析**，
 * 不先按换行切：路径可以含换行；`-I` 只看前 8000 字节，之后的内容里可能有 NUL。
 *
 * `truncated` 时最后一条多半是半截（也可能正好是整条），找不齐三个分隔符就丢掉——半截的那条连
 * 路径都可能是 utf8 解码到一半的。同一个文件的记录是连续的（git 按文件逐个输出）。
 */
export function parseGrep(
  output: string,
  options: SearchOptions,
  truncated: boolean,
): SearchPayload {
  const pattern = patternOf(options);
  const files: SearchFile[] = [];
  let current: SearchFile | undefined;
  let lines = 0;
  let cut = truncated;
  let at = 0;
  while (at < output.length) {
    const afterPath = output.indexOf('\0', at);
    const afterLine = afterPath === -1 ? -1 : output.indexOf('\0', afterPath + 1);
    const end = afterLine === -1 ? -1 : output.indexOf('\n', afterLine + 1);
    if (end === -1) break;
    if (lines === MAX_SEARCH_LINES) {
      cut = true;
      break;
    }
    lines += 1;
    const path = output.slice(at, afterPath);
    if (current?.path !== path) {
      current = { path, matches: [] };
      files.push(current);
    }
    current.matches.push(
      previewOf(
        Number(output.slice(afterPath + 1, afterLine)),
        output.slice(afterLine + 1, end),
        pattern,
      ),
    );
    at = end + 1;
  }
  return { files, truncated: cut };
}

/**
 * 命中区间在 JS 里**拿同一个字面量重找一次**：`--column` 要 git 2.19、且只给每行第一个命中。`-i` 对
 * `i` 标志；`-w` 对 git 的字词集 `[A-Za-z0-9_]`——不用 `\b`：带 `iu` 标志时它把 `ſ`、`K`（开尔文
 * 符号）也算进单词字符。找不出区间的行照常返回、只是不高亮。
 */
function patternOf({ query, matchCase, wholeWord }: SearchOptions): RegExp {
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = wholeWord ? `(?<![A-Za-z0-9_])${literal}(?![A-Za-z0-9_])` : literal;
  return new RegExp(body, matchCase ? 'gu' : 'giu');
}

/**
 * 一行的预览：剥掉行尾 `\r` 与行首空白（缩进深的代码在 320px 里否则只剩一截空白），过长时裁成
 * 首个命中附近的一截、两端补 `…`；`ranges` 全程跟着平移。
 */
function previewOf(line: number, raw: string, pattern: RegExp): SearchMatch {
  const trimmed = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  const text = trimmed.trimStart();
  const long = text.length > MAX_PREVIEW;
  // 窗口由首个命中定，区间只收窗口里的：`matchAll` 是惰性的，一行 1MB 的压缩文件里出了窗口就停，
  // 不为几万个随后就丢的命中各造一个元组
  let start = 0;
  let end = long ? clampToCodePoint(text, MAX_PREVIEW) : text.length;
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(pattern)) {
    if (long && ranges.length === 0) {
      start = clampToCodePoint(text, Math.max(0, match.index - PREVIEW_LEAD));
      end = clampToCodePoint(text, Math.min(text.length, start + MAX_PREVIEW));
    }
    if (match.index + match[0].length > end) break;
    ranges.push([match.index, match.index + match[0].length]);
  }
  if (!long) return { line, text, ranges };

  const head = start > 0 ? ELLIPSIS : '';
  const shift = head.length - start;
  return {
    line,
    text: `${head}${text.slice(start, end)}${end < text.length ? ELLIPSIS : ''}`,
    ranges: ranges.map(([from, to]) => [from + shift, to + shift]),
  };
}

/** 落在代理对中间的下标往前挪一格：切开的半个代理对在页面上是一个替换字符。 */
function clampToCodePoint(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return index > 0 && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}
