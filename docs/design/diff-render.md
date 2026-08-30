# diff 渲染：diff2html 与语法高亮

> 一份 unified diff 文本怎么变成页面上那块带高亮的 HTML。组件与骨架在 [`web.md`](web.md)，配色与层叠隔离在 [`style.md`](style.md)，选型与被排除的做法见 [`../decisions.md` 的「前端渲染与体积」](../decisions.md#前端渲染与体积)，门禁见 [`../gates.md`](../gates.md)。

[diff2html](https://github.com/rtfpessoa/diff2html) 直接解析 `git diff` 的 unified diff 文本渲染为带高亮的 HTML，配合 [highlight.js](https://highlightjs.org/) 做语法高亮。所有资源随包本地分发，**不走 CDN**——工具必须离线可用。

**按需 import + 显式注册 hljs 语言子集，不使用任何 diff2html 预构建 UI bundle**（`diff2html-ui.min.js` / `-slim` / `-base` 三个都不用）。

- `import { html } from 'diff2html'`——只引入 unified diff parser 与 renderer，其余由 tree-shaking 移除。
- **`html()` 不做语法高亮**，高亮在 `Diff2HtmlUI.highlightCode()`：先把整个文件的代码合起来交给 hljs，再按 diff 的行边界切回、补齐跨行未闭合的标签。**被排除的是三个预构建 bundle，不是 UI 层的源码**——深导入 ESM 模块 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 参与 tree-shaking、hljs 实例由我们注入，是允许且推荐的。自行重写这段切分逻辑不在本项目要解决的问题之列。
- `draw()` 内部是 `innerHTML` 赋值 + 命令式绑定事件，**必须放在 Preact 的 ref/effect 之后**，不与 vdom 争夺同一棵子树（列表由 Preact 管，单文件 diff 容器由 `Diff2HtmlUI` 管）。
- 用不到的开关一律关掉：`synchronisedScroll` / `fileListToggle` / `fileContentToggle` / `stickyFileHeaders` 全部 `false`，只留 `highlight: true`。
- **`highlight: true` 时 `draw()` 内部已经调过 `highlightCode()`，不要在 `draw()` 后再手工调一次**：第二遍读到的 `textContent` 仍是纯文本，但 `nodeStream(line)` 拿到的已是第一遍插入的 `hljs-*` span，`mergeStreams` 把两份流交织进同一行——结果是嵌套重复的 span，且高亮开销白付一倍。二选一：要么只 `draw()`，要么 `highlight: false` + 手工调。
- **`colorScheme` 传 `'light'`，不传 `'auto'`**——深浅切换由我们覆写的 `--d2h-*` 承担，理由见 [`style.md`](style.md) 的「为什么 `colorScheme` 传 `'light'`」。**顶栏那个明暗开关不改这一条**，也不进 `draw()` 的依赖数组：主题整个发生在 CSS 变量上，diff2html 不参与，为它重跑一次 `draw()` 是白付一次全量高亮。

## 文件头整条不显示

diff2html **没有**关掉自带文件头（`.d2h-file-header`）的配置项（上面那四个开关管的是同步滚动、文件列表折叠与吸顶，头照画），这件事只能落在样式那侧的一条 `display: none`（规则本身与它的三处讲究在 [`style.md`](style.md) 的「四条选择器规则的例外」）。

- 头里只有四样：文件图标、文件名、`CHANGED` / `RENAMED` 之类的标签、一个在 `fileContentToggle: false` 下已经是死的「Viewed」折叠复选框。前两样与 `DiffView` 自己那行标题重复，第三样里唯一有信息量的重命名已由 `RenameNotice` 说得更全（带完整旧路径与相似度）——**四样合起来，藏掉它页面上不掉任何信息**。
- **`+N` / `-M` 那对增删统计不在这条头里**：它属于文件列表模板，而我们传 `drawFileList: false`，那份列表从来没画过。特意写下这条是因为它太容易被想当然（GitHub 的文件头上就有那对数字）——藏掉文件头**不等于**放弃了统计，difftab 至今就没在页面上给过增删行数。

## 版式按面板宽度自动切

面板宽度 < 1024px 给 `line-by-line`，否则 `side-by-side`。**1024 是按 diff2html 的字体与行号槽宽算出来的**（约当并排每侧只剩 50 个等宽字符，正是多数源码行开始要横向滚的地方），**与 Tailwind 的 `lg` 数值相同纯属巧合**：那是视口断点，这里是面板宽度。以下几条都属「违反后不报错」：

- **判据是 diff 面板自身的宽度，不是视口宽度**。侧栏固定 `w-80`（320px）且 `shrink-0`，面板宽度恒等于「视口 − 320」；按视口判等于把这个常数在两处各写一遍，而侧栏宽度将来一改，阈值就静默错位到别的地方去了。
- **量的是 border box，不是 content box，且观察与读值两处都得显式写**（`observe(el, { box: 'border-box' })` + `entry.borderBoxSize[0].inlineSize`）。面板自己是 `overflow-auto` 的滚动容器：换格式会改变内容高度 → 竖直滚动条出现/消失 → content box 宽度抖十几个像素，阈值附近于是在两种格式之间来回重画。**滚动条是从 content box 里扣的**，border box 宽度不随它进出而变；而只在读值那侧挑，滤掉的是**已经产生的**回调噪声，指定观察 box 才是从源头不投递。
- **量法与阈值同住 `state/layout.ts` 的 `observeDiffPanel()`**，`App.tsx` 只管「量哪个元素、什么时候开始和停」：阈值的正确性全靠「送进来的是 border box」，而这件事没有任何门禁强制得了（happy-dom 没有布局引擎），拆到两个文件里就等于让其中一半失去说明。
- 格式本身是个 `computed`，靠 signals 的 `Object.is` 去重——拖窗口每像素写一次宽度，只有**真跨过阈值**那一次会通知下游。**去重封的是「每像素一次」而不是「每次跨越一次」**：贴着阈值来回蹭，每跨一次仍是一次完整的 `draw()`。不为此加迟滞或 debounce 是有意的——那要存一份「上一次是哪种版式」，把纯派生量变成第二份状态，而换来的只是一个转瞬即逝的动作下的顺滑。
- **格式必须进 `DiffView` 那个 effect 的依赖数组**。`draw()` 是命令式的，格式变了不重跑就永远停在旧格式上——**不报错，只是拖窗口没反应**。
- **两种格式共用同一套 `--d2h-*` 覆写**，无需分叉：那对 `--d2h-change-*` 与 `--d2h-empty-placeholder-*` 只被并排视图的选择器读到，逐行视图下是失效而不是漏映射。
- 首版**不做版式的手动切换开关**：自动判据已经覆盖了「放不放得下」这个唯一的真实诉求。（顶栏那个明暗开关不是这条的反例——明暗没有等价的自动判据可用，「跟随系统」只答得了系统那一半。）

## hljs 语言清单

`import hljs from 'highlight.js/lib/core'`，再**逐个显式注册**。清单为 **22 个真实语言模块**：`javascript` / `typescript` / `json` / `css` / `scss` / `xml` / `markdown` / `python` / `go` / `rust` / `java` / `kotlin` / `swift` / `c` / `cpp` / `csharp` / `bash` / `yaml` / `ini` / `sql` / `php` / `ruby`。注册清单是白名单，增删语言即增删体积，这正是放弃预构建包换来的可控性。

- **别名不是模块，不得单独 import**——`jsx` / `mjs` / `cjs` 属 `javascript`，`tsx` / `ts` 属 `typescript`，`toml` 属 **`ini`**，`html` 属 `xml`；`registerLanguage` 注册主模块时别名一并生效。`highlight.js/lib/languages/{jsx,tsx,toml}` 三个路径实际不存在，写了会在构建期 resolve 失败。
- **`plaintext` 必须与这 22 个一起注册，它是兜底而非语言。** 「未命中的语言退化为 plaintext」不是自动发生的：`highlightCode()` 对无扩展名/未知扩展名把语言改写为字面量 `'plaintext'`，随后无条件调用 `hljs.highlight()`。而 `lib/core` **不自带** plaintext，漏注册时这一步抛 `Unknown language: "plaintext"`，异常从 `highlightCode()` 冒到调用方，**整个 diff 视图渲染失败**——不是那一个文件退化。触发条件极普通：diff 里出现 `LICENSE` / `Dockerfile` / `notes.txt` / `.lua` 即可。模块本身 318 B，对体积无影响。
- **语法高亮的配色 CSS 不来自 highlight.js**：`hljs-theme.css` 是我们自己那份（色值抄自上游 github / github-dark 两套主题，写成 `light-dark()` 的单份规则），理由见 [`style.md`](style.md) 的「hljs 主题为什么变成我们自己那份」。这里这张语言清单管的是**语言模块**，与配色无关，两者增删互不影响。
- diff2html 的两个传递依赖（`diff`、`@profoundlogic/hogan`）由打包器一并处理。注意 `@profoundlogic/hogan` 只有 CJS 入口，需打包器的 CJS 互操作，不影响可行性但也别指望它被 tree-shake。

## 产物体积门禁

门禁值为预算而非承诺。**主导项是语言清单**：22 个语言模块的明文体积占了预算的大头。因此后续若要压体积，第一刀砍语言清单而不是别处；若要加语言，先看这张表还剩多少。

| 产物 | 门禁 | 当前实测 |
|---|---|---|
| 前端 JS（明文） | ≤ 350 KB | 205.0 KB |
| 前端 JS（gzip） | ≤ 120 KB | 68.5 KB |
| 前端 CSS（明文，含 `diff2html.min.css` + 自建 hljs 主题 + Tailwind 产物） | ≤ 40 KB | 30.3 KB |

**CSS 是余量最紧的一行，且它对「多写几个工具类」最敏感**——加 token 时留意。
