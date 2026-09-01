// highlight.js 的按需装配。
//
// 只引 lib/core,再逐个显式注册语言 —— 清单即白名单,增删语言就是增删体积,这正是放弃
// diff2html 预构建 bundle 换来的可控性。JS 体积门禁的主导项就是这张表(22 个模块 ESM 明文
// 合计 225.6 KB),要压体积第一刀砍这里。
//
// 别名不是模块,不得单独 import:jsx / mjs / cjs → javascript,tsx / ts → typescript,
// toml → ini,html → xml。`registerLanguage` 注册主模块时别名一并生效;而
// highlight.js/lib/languages/{jsx,tsx,toml} 三个路径实际不存在,写了会在构建期 resolve 失败。
//
// plaintext 是兜底、不是语言,但**必须一起注册**:diff2html 对未知扩展名(以及 LICENSE /
// Dockerfile 这类无扩展名文件)会把语言改写成字面量 'plaintext' 再无条件调 hljs.highlight;
// lib/core 不自带它,漏注册就抛 Unknown language,异常冒到调用方后**整个 diff 视图渲染失败**,
// 而不是那一个文件退化。

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  plaintext,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
} as const;

let registered = false;

/** 返回注册好语言子集的 hljs 实例;清单外的语言退化为 plaintext(见上,该退化依赖显式注册)。 */
export function getHljs(): typeof hljs {
  if (!registered) {
    for (const [name, definition] of Object.entries(LANGUAGES)) {
      hljs.registerLanguage(name, definition);
    }
    hljs.configure({ ignoreUnescapedHTML: true });
    registered = true;
  }
  return hljs;
}

/** 注册清单,供单测对着校验(体积门禁是零依赖 JS,读不到这里)。 */
export const REGISTERED_LANGUAGES = Object.keys(LANGUAGES);
