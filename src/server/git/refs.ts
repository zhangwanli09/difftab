// 分支列表：本地分支、远程分支、标签。**只读白名单为这里只加了 `for-each-ref` 一条**——不用
// `branch --list` / `tag -l`：那两个子命令本身就会写（建、删、改名、打标签），而白名单只看子命令。

import type { RefEntry, RefList } from '../shared/protocol.ts';
import { runGitStrict } from './run.ts';

/**
 * 十段，**每段都以 `%00` 收尾（含最后一段）**：`for-each-ref` 没有 `-z`，记录之间是换行，于是
 * 整份输出按 NUL 切开后恰好十段一组、下一条的 refname 前面多一个换行。后四段是前四样的解引用
 * 形态——附注标签的本体是标签对象，作者与时间为空、主题是标签说明，`%(*…)` 才是它指向的提交。
 * 只用 git 2.11 已有的 atom：`refname:lstrip` 更晚，前缀在下面剥。
 */
const REF_FORMAT =
  '--format=%(refname)%00%(symref)%00%(objectname)%00%(authorname)%00%(committerdate:unix)%00' +
  '%(subject)%00%(*objectname)%00%(*authorname)%00%(*committerdate:unix)%00%(*subject)%00';
const FIELDS = 10;

/**
 * `for-each-ref` 的 argv，**整条是字面量**，冒烟逐段钉着它：atom 里有 `%(signature)` 一族，用上就
 * 是每条 ref 起一次 gpg，而白名单只看子命令。不带 `--sort`——三组本来就要在 JS 里分，排序一起做，
 * 不多一段要钉的参数面。
 */
const REF_ARGS = ['for-each-ref', REF_FORMAT, 'refs/heads', 'refs/remotes', 'refs/tags'] as const;

/** 前缀 → 组。次序就是三组在列表里的次序。 */
const KINDS: readonly [prefix: string, kind: RefEntry['kind']][] = [
  ['refs/heads/', 'local'],
  ['refs/remotes/', 'remote'],
  ['refs/tags/', 'tag'],
];

/** `REF_FORMAT` 的解析：十段一组切，滤掉 symref，附注标签取解引用那几段。 */
export function parseRefs(output: string): RefEntry[] {
  const segments = output.split('\0');
  const refs: RefEntry[] = [];
  for (let i = 0; i + FIELDS <= segments.length; i += FIELDS) {
    const [
      rawName = '',
      symref = '',
      sha = '',
      author = '',
      time = '',
      subject = '',
      peeledSha = '',
      peeledAuthor = '',
      peeledTime = '',
      peeledSubject = '',
    ] = segments.slice(i, i + FIELDS);
    // 克隆出来的仓库有一条 `refs/remotes/origin/HEAD` → `origin/main`：画出来就是同一个提交的
    // 两行，VS Code 也不列它
    if (symref !== '') continue;
    // 换行只可能是记录之间的那一个，refname 本身不能含控制字符
    const refname = rawName.replace(/^\n/, '');
    const match = KINDS.find(([prefix]) => refname.startsWith(prefix));
    if (match === undefined) continue;
    const [prefix, kind] = match;
    // 轻量标签与分支的解引用段全空，用本体；附注标签用它指向的那一条
    const peeled = peeledSha !== '';
    refs.push({
      kind,
      name: refname.slice(prefix.length),
      sha: peeled ? peeledSha : sha,
      author: peeled ? peeledAuthor : author,
      time: Number(peeled ? peeledTime : time) || 0,
      subject: peeled ? peeledSubject : subject,
    });
  }
  const order = (kind: RefEntry['kind']) => KINDS.findIndex(([, k]) => k === kind);
  return refs.sort((a, b) => order(a.kind) - order(b.kind) || b.time - a.time);
}

/** 本地、远程、标签三组。空仓库与没有任何 ref 时 git 输出为空、exit 0，回一个空列表。 */
export async function listRefs(root: string): Promise<RefList> {
  return { refs: parseRefs(await runGitStrict(REF_ARGS, root)) };
}
