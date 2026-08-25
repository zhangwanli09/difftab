// 用例目录布局的门禁。
//
// 守的是一件**只会静默出错**的事:`vitest.config.ts` 按目录分了两个 project
// (server=node / web=happy-dom),include 因此是几条**具体路径**,不是笼统的
// `test/unit/**`。于是往 `test/unit/` 底下(或任何第三个子目录里)放一个用例文件时,
// vitest 既不报错也不警告 —— 它只是**不属于任何 project、压根不会被跑**,而套件照常
// 全绿,症状是"我明明写了断言,怎么改坏了也不红"。
//
// 反过来也不能把 include 改成一条 `test/unit/**`:那会把前端用例塞进 node 环境
// (没有 DOM)、或把后端用例套上一层 DOM 全局,后者是把"前端拿不到也不该拿到
// Node API"那条边界反向捅一刀。正确的修法是**新目录要在 vitest.config.ts 里补一个
// project**,本条断言就是来提醒这件事的。
//
// **判据直接读 `vitest.config.ts` 的 include,不在这里抄一份目录清单。** 抄清单守不住
// 它自己声称的不变式:`server` 那档的 include 只收 `*.test.ts`,新建一个
// `test/unit/server/foo.test.tsx` 同样不属于任何 project,而"目录名在白名单里"这种
// 代理判据是绿的 —— 恰好是它想防的那个症状。include 被改窄(比如改成 `*.spec.ts`)、
// 或某档 project 整个删掉,同理。
//
// 放在 server 那一档是因为它要读文件系统(web 档是 happy-dom,不该碰 fs)。

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import vitestConfig from '../../../vitest.config.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const unitRoot = join(repoRoot, 'test', 'unit');

/** 相对仓库根的 posix 路径 —— include pattern 就是这个坐标系(Windows 上 `\` 要归一化)。 */
const rel = (absolute: string) => relative(repoRoot, absolute).split(sep).join('/');

/**
 * 把 include pattern 编成正则。只需覆盖 vitest.config.ts 实际用到的那几种写法:
 * `**​/`(零或多层目录)、`*`(不跨目录)、`{a,b}`(择一)。写成通用 glob 引擎是
 * 过度设计,但**必须支持花括号** —— 否则哪天 include 收成 `*.test.{ts,tsx}`,
 * 这里会一条都匹配不上,于是全部文件被判成"孤儿",以一个错误的理由变红。
 */
function globToRegExp(glob: string): RegExp {
  let source = '';
  // charAt 而不是下标:下标在 noUncheckedIndexedAccess 下是 `string | undefined`,
  // 而这里越界读(`i + 2`)是正常控制流的一部分
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob.charAt(i);
    if (char === '*') {
      if (glob.charAt(i + 1) === '*' && glob.charAt(i + 2) === '/') {
        source += '(?:[^/]+/)*';
        i += 2;
      } else if (glob.charAt(i + 1) === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '{') {
      const close = glob.indexOf('}', i);
      const alts = glob.slice(i + 1, close).split(',');
      source += `(?:${alts.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
      i = close;
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** vitest.config.ts 里全部 project 的 include pattern,拍平成一张表。 */
function includePatterns(): string[] {
  const projects: unknown[] = vitestConfig.test?.projects ?? [];
  return projects.flatMap((project) => {
    // projects 的类型是个宽联合(还允许字符串与函数形态)。我们只写对象形态,
    // 遇到别的形态就让断言红掉,而不是静默当成"没有 include"。
    if (typeof project !== 'object' || project === null || !('test' in project)) {
      throw new Error(`vitest.config.ts 出现了本断言不认识的 project 形态:${String(project)}`);
    }
    const include = (project as { test?: { include?: string[] } }).test?.include;
    return include ?? [];
  });
}

it('test/unit 下的每个用例文件都落在某个 vitest project 的 include 里', () => {
  const patterns = includePatterns();
  const matchers = patterns.map(globToRegExp);

  // 递归交给 readdirSync 自己做,不手写一份遍历(与 scripts/size.mjs 同一个写法;
  // withFileTypes 下 parentPath 给出所在目录,Node 20.12+,下限 22.0.0 上可用)
  const files = readdirSync(unitRoot, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.test\.tsx?$/.test(entry.name))
    .map((entry) => rel(join(entry.parentPath, entry.name)));

  // 反空断言:遍历或 glob 编译坏掉时(路径写错、include 读成空、正则编错),
  // 上面那条会对着空集合通过 —— 而这条门禁的全部价值就在于"别空转"
  expect(patterns.length).toBeGreaterThan(0);
  expect(files.length).toBeGreaterThan(5);
  expect(files).toContain(rel(fileURLToPath(import.meta.url)));

  const orphans = files.filter((file) => !matchers.some((re) => re.test(file)));
  expect(
    orphans,
    `这些用例文件不匹配 vitest.config.ts 里任何一条 include,永远不会被跑:` +
      `${orphans.join(', ')}。现有 include:${patterns.join(', ')}。` +
      '要么挪进已覆盖的目录、要么在 vitest.config.ts 里给它补一个 project',
  ).toEqual([]);
});
