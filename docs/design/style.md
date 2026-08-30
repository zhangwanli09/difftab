# 样式：Tailwind v4 + 层叠隔离

> 设计 token、diff2html 配色覆写，以及「谁压得过谁」这件事的全部机制。组件与骨架在 [`web.md`](web.md)，diff 渲染在 [`diff-render.md`](diff-render.md)，选型与被排除的做法见 [`../decisions.md` 的「样式层叠」](../decisions.md#样式层叠)，门禁见 [`../gates.md`](../gates.md)。

**Tailwind v4（CSS-first，`@tailwindcss/vite`）。** 设计 token 写进 `@theme` 块，命名与数值参照 VS Code 颜色 token（如 `editor.background`），复刻 Dark+/Light+ 主题观感，轻量优先于视觉还原度。

引入完整 preflight——它就是跨浏览器归一化那一层，不引则要自己手写一份等价物。与 diff2html 的冲突面实测下来几乎为零：表格合并、行号列盒模型、边框等关键声明 diff2html 均自带，且类选择器特异性稳压 preflight 的通配重置。

在此之上再用**层叠层**做结构性隔离——**无层（unlayered）样式在层叠中永远胜过有层样式，与特异性无关**，而 Tailwind v4 把 preflight 放在 `@layer base`：

```css
/* src/web/app.css */
@import "tailwindcss";                              /* preflight → @layer base；utilities → @layer utilities */
@import "./hljs-theme.css";                         /* unlayered，且必须排在 d2h 之前 */
@import "diff2html/bundles/css/diff2html.min.css";  /* unlayered → 结构上不可能被 preflight 压过 */
@import "./vscode-theme.css";                       /* unlayered，覆写 --d2h-* 与 VS Code token */
```

- **hljs 主题 CSS 必须排在 `diff2html.min.css` 之前**（diff2html 官方 README 的要求），否则配色被覆盖。`diff2html.min.css` 里**没有任何 hljs 配色规则**，只引 hljs 运行时与语言定义不会出颜色。
- **hljs 主题是我们自己那份**（`hljs-theme.css`），不再直接引上游的 `github.css` / `github-dark.css`，理由见下面的「hljs 主题为什么变成我们自己那份」。
- **hljs 主题与 `diff2html.min.css` 不得放进任何 `@layer`**，一旦放进去就把这层保障拆掉了。
- **diff2html 渲染出的内部元素只能通过覆写 `--d2h-*` 改配色，不得用 Tailwind 工具类去压**——无层的 diff2html CSS 同样会胜过 `@layer utilities`，写了也不生效。

## 明暗切换：只翻 `color-scheme` 一处

**页面顶栏有一个三档开关（跟随系统 / 亮 / 暗），但整个切换机制只有三条规则**，写在 `vscode-theme.css` 顶部：

```css
:root                      { color-scheme: light dark; }  /* 缺省：跟随系统 */
:root[data-theme="light"]  { color-scheme: light; }
:root[data-theme="dark"]   { color-scheme: dark; }
```

`<html>` 上有没有 `data-theme` 属性由 `state/theme.ts` 写（见 [`web.md`](web.md)），**缺省即跟随系统**——不写 `data-theme="system"`，那样等于给「跟随」也造一个需要维护的取值。

- **token 侧一个字都不用分叉**：所有深浅不同的取值写成 `light-dark(浅, 深)` 的单条声明，由上面那三条规则里的 `color-scheme` 选中哪一半。这取代了旧的写法——`@theme` 里写浅色、`vscode-theme.css` 的 `@media (prefers-color-scheme: dark)` 里再写一份 delta。旧写法在有手动档之后**必然要双写**：媒体查询切不出手动档，`[data-theme="dark"]` 又切不出跟随系统，两个块里逐字重复 19 条声明，改一处漏一处不会报错。
- **顺带修好原生控件**：滚动条、表单与默认焦点环跟的是 `color-scheme` 而不是媒体查询，手动切深色时它们会跟着翻。这不是附赠品——不翻的话深色页面上会出现一条浅色滚动条。
- **`light-dark()` 在产物里不是字面量**：Lightning CSS（Vite 8 的 CSS 处理器）按构建目标把它降级成 space-toggle 变量对 `var(--lightningcss-light,浅) var(--lightningcss-dark,深)`，并**逐选择器**为每条 `color-scheme` 声明补一份开关。上面三条规则因此在产物里各自带着那对变量，手动档在不支持 `light-dark()` 的浏览器上照样生效。查产物时**搜不到 `light-dark(`，这是正常的**，`check:css` 的断言因此两种形状都认。
- **双值 token 不能带不透明度修饰符**：降级后它的值是一段 token 流而不是一个合法的 `<color>`，`bg-editor-background/50` 这类写法会让 Tailwind 把它塞进 `color-mix()`，整条声明在解析期作废——属性静默变 unset。当前全库零使用。

## hljs 主题为什么变成我们自己那份

**上游那两份主题切不出手动档。** `github.css` 与 `github-dark.css` 都是无条件的 `.hljs { … }` 规则、自身不含任何 `@media`，平铺引入的结果是后者无条件覆盖前者、浅色直接失效；旧方案给深色那份的 `@import` 加媒体条件绕开了这一点，而**媒体条件切不出手动档**。要让上游 CSS 跟着 `data-theme` 走，只能在构建期给它的选择器批量加作用域前缀——那份构建期机器正是当初否掉手动开关的理由。

于是把它收进与 `--d2h-*` **完全相同**的机制：`hljs-theme.css` 里 15 个 `--hljs-*` token 各写一条 `light-dark(浅, 深)`，15 条规则的选择器与顺序逐条照抄上游，颜色一律写成 `var(--hljs-…)`。上游 18 条里有 3 条没抄：一条是空规则（`purposely ignored`，那几类词刻意不上色），另两条是 `code.hljs` / `pre code.hljs`——**diff2html 整包零个 `<code>` 元素**（已实测），它把 `hljs` 类加在行容器上，那两条一条都命不中。两份上游主题的选择器串实测逐条相同、顺序也相同，合并没有歧义。

- **代价是那两套色值抄进了仓库**，此后不随 highlight.js 升级。这是明码标价的取舍：换来的是零构建期机器，以及与 `--d2h-*` 同一套心智。**体积上是小幅净增而不是净减**（+922 B，见下条）：省下的一份主题抵不过 Lightning CSS 降级后那些冗长的 token 流。
- **有两个 token 在浅色下与别的同值、深色下才分叉**（`markup-heading` 之于 constant、`markup-inserted` 之于 entity-tag），**必须各自独立成 token**。照浅色就近复用会让深色悄悄错色，而浅色下看不出任何差别——13 个浅色值配出 15 个 token，多的就是这两个。
- **`--hljs-bg` 保持上游取值**（`#ffffff` / `#0d1117`），没有映射到 `--color-editor-background`。合并主题这件事本身不该顺手改观感；想让代码区底色跟编辑器底色是另一个决定。
- **门禁只能证明「都走了 `var()`」，证明不了「抄对了颜色」**：`check:css` 断言 hljs 规则里不许出现硬编码颜色、每个 `--hljs-*` 都是双值且都被引用到，但色值本身抄错只能靠人逐条对。

## 为什么 `colorScheme` 传 `'light'`

**diff2html 自带的深色方案不用。** 它的深色配色由渲染时挂在容器上的 class 门控：`colorScheme: 'auto'` 输出 `.d2h-auto-color-scheme`，对应规则整块包在一个 `@media (prefers-color-scheme: dark)` 里，读的是**另一套** `--d2h-dark-*` 变量。

- 传 `'light'` 输出 `.d2h-light-color-scheme`，而这个 class 在 diff2html 的 CSS 里**一条规则都没有**，于是全部配色都落在无前缀的基础规则上，深浅切换完全由我们覆写的同一套 `--d2h-*` 承担。**这不是「只支持浅色」**，恰恰相反——它是深色能按 VS Code 取值出来的前提。
- 传 `'auto'` 的后果是静默的：`.d2h-auto-color-scheme .d2h-xxx` 特异性 (0,2,0) 稳压基础规则 (0,1,0)，深色下读回 GitHub 那套取值，我们的 VS Code 深色一条都不生效，而页面看上去只是「深色不太像 VS Code」，不像出错。（auto 那块自己还漏了 `.d2h-deleted`，即走它的方案仍要自己补规则，收益为负。）
- 换来的好处是**深浅只声明一次**：23 个无前缀 `--d2h-*` 一律写成 `var(--color-…)` 指向 VS Code token，token 自己在 `light-dark()` 里翻。CSS 变量在**使用时**解析，因此不存在「加了浅色忘了深色」这一半。
- 但**并排视图那对「改动行」不跟着无脑映射**：diff2html 为 `.d2h-del.d2h-change` / `.d2h-ins.d2h-change` 另留了 `--d2h-change-del-color` / `--d2h-change-ins-color`（默认是琥珀与浅绿，与纯增删不同色系），而 **VS Code 的 diff 编辑器没有这一档区分**。故这两个变量**刻意指向与纯增删相同的 token**，主动放弃上游那档琥珀。**这是取舍不是遗漏，注释里必须这么写**：写成「比纯增删淡一档」会让下一个人以为区分还在。

## 覆写生效的两个条件

**unlayered **且** 排在 diff2html 之后，两条缺一不可。** 我们的 `:root` 与 diff2html 自己的 `:host,:root` 特异性同为 (0,1,0)，胜出**纯靠源码顺序**。把 `@import "./vscode-theme.css"` 挪到 `@import "diff2html/…"` 之前，23 条覆写会**整片静默失效**、配色退回 GitHub 那套，而「块是 unlayered」这条断言照样通过。

`check:css` 因此必须**同时**查三件事：声明 `--d2h-*` 的块全部 unlayered；diff2html 那块与我们那块**都存在**（缺哪一侧都说明有一份 CSS 没被打进产物，顺序断言会对着空集合通过）；且后者整个排在前者之后。

- **「哪块是我们的」由 `vscode-theme.css` 里的一条哨兵声明（`--gg-d2h-map`）认定，不按值的形状猜**：按「值里有没有 `var(--color-…)`」区分会给出**误导性红**——深色下给某个 `--d2h-*` 补一条字面量覆写（完全正当）就会被归到 diff2html 那一侧，于是门禁报「检查 `@import` 顺序」而顺序根本没问题。哨兵由我们自己写、自己控制，且它不见了本身就是一条正面断言。
- 顺带把「覆写有没有覆全」也钉住：**diff2html 声明的每一个无前缀 `--d2h-*` 都必须出现在我们那个块里**，删掉半张映射表同样是静默退色。

## `@theme` 变量会被裁掉

**Tailwind v4 会裁掉没被引用的 `@theme` 变量**：被工具类用到、或被我们自己的 CSS 以 `var()` 引用到的都会输出，两者都没有的会被丢掉。「`--d2h-*` 一律指向 VS Code token」因此是安全的——那就是一次 `var()` 引用。但**引用名写错时没有任何报错**：引用侧留下一个无定义的 `var()`，该属性变为 unset，颜色悄悄没了。故 `check:css` 断言：产物中每个不带 fallback 的 `var(--…)` 引用都必须在产物里找得到定义（`--tw-*` 除外，它们由 `@property` 声明）。

**「声明侧」的静默失效换了个形状。** 深色曾经是写在 `@media (prefers-color-scheme: dark)` 里的一份 delta，那时的坑是 delta 里的 token 名写错一个字符——上面那条查的是**引用**侧，而一条 `--color-git-modifed: …` 在语法上就是个合法的新自定义属性，连「无定义」都算不上（它反而给 `defined` 集合添了一个成员）。改用 `light-dark()` 之后这个坑整个消失了：深浅同住一条声明，没有第二个名字可写错。

取而代之的是**「把深色值写回媒体查询」**：那样写不报错，浅色也对，只有手动档对它无效——用户切到 Light 时那一个颜色仍是深的。故 `check:css` 把旧断言反过来：**产物里凡在 `@media (prefers-color-scheme: dark)` 内声明的 `--color-*` / `--hljs-*` 一律判红**。diff2html 自己那块声明的是 `--d2h-dark-*`，不受影响；Lightning CSS 降级 `light-dark()` 时补进媒体查询的是 `--lightningcss-*`，也不受影响。

## 三条选择器规则的例外

`vscode-theme.css` 末尾那三条在「只能改 `--d2h-*`」这条约束之外，**且只有这三条**：`.d2h-diff-table { font-family }`、`.d2h-file-header { display: none }` 与 `.d2h-file-wrapper { border: none; margin-bottom: 0 }`。47 个 `--d2h-*` 实测全是颜色，**字体、显不显示、有没有这个盒子、它底下那截留白都没有变量可覆**，而那条约束管的是配色。三条与 diff2html 自己的同名规则特异性同为 (0,1,0)，胜出与那 23 条变量覆写同理——**靠本文件排在 `diff2html.min.css` 之后**（preflight 的 `*{border:0 solid}` 在 `@layer base`，三条都压不过）。藏掉文件头的理由见 [`diff-render.md`](diff-render.md) 的「文件头整条不显示」。

- **被这三条架空的那几个变量仍要留在映射块里**：`--d2h-file-header-bg-color` / `--d2h-file-header-border-color`（文件头已不显示）与 `--d2h-border-color`（外框已去掉）都照旧映射。`check:css` 的覆盖率断言是从 diff2html 那块推导出全部无前缀变量名再逐一比对的，删掉即红——它们不是死代码，是那条断言的一部分。
- **补丁外框与它底下那截留白一起去掉。** `.d2h-file-wrapper` 自带 `border` + `border-radius` + `margin-bottom: 1em`。文件头藏掉之后这个盒子只剩副作用——上边与 `DiffView` 那行标题的 `border-b` 画出第二条平行线，左边紧贴侧栏的 `border-r`；那截留白则是为「一次画多个文件」分隔相邻补丁准备的，而 difftab 一次只画一个。
- **写法上的三处讲究**：不写成 `--d2h-border-color: transparent`，尽管那样看着更守「只能改 `--d2h-*`」的规矩——透明边框**仍占 1px 布局**，那个变量还被文件头与文件列表里的规则读到（谁把它们放回来就会连带静默失色），而这里要的是「没有这个盒子」不是「这个盒子的颜色」，写进配色映射表等于把一个版式决定藏在颜色里。写 `margin-bottom: 0` 而不是 `margin: 0`——diff2html 只设了这一边，写全会让人以为另有三边要压。`border-radius` 不动——没有边框也没有背景时它不可见，删它只是多一条不产生任何差别的声明。
- **三条都不加断言**：失效的症状是文件头、外框或那截留白又出现在页面上，肉眼可见，不属于门禁要防的那类静默故障。

## 行号列需要一个 positioned 祖先

**diff2html 的行号列是 `position: absolute`，滚动容器内部必须有一个 positioned 祖先。** 这与「两侧各自滚」是同一个决定的两半：diff2html 把行号做成绝对定位、偏移量全 auto，靠的是「包含块 = 初始包含块，而滚的就是整个文档」这个前提；我们为了让 SSE 刷新时留住列表侧的滚动位置，把滚动收进了内层的 `overflow-auto` 容器（见 [`web.md`](web.md) 的「页面骨架」），那个前提就不再成立——**包含块在滚动容器之外的绝对定位盒不随该容器的内容滚动**，于是一滚代码行就跑了、整列行号原地不动，页面不报任何错。

- 包含块由 `DiffView` 里交给 `Diff2HtmlUI` 的那个宿主 div 上的 `relative` 提供。**滚动容器 `<section>` 自己加 `position: relative` 同样修得好**，选宿主 div 只是因为它是**作用域最小**的那个：与 diff2html 子树同生共死，不给外壳上任何别的绝对定位埋一个意料之外的包含块。
- 它写成 Tailwind 工具类**不违反「只能改 `--d2h-*`」**：那条管的是 diff2html *渲染出来的*元素的配色，而宿主 div 是我们自己的元素，没有任何 d2h 规则命中它。
- `diff-view.test.tsx` 有一条断言钉着这个类名，`check:css` 查产物里那条规则在不在。**两者都只能钉到「类名/规则还在」**——happy-dom 没有排版引擎，滚动与错位在那里不可判定，真布局归人工。
- 两种版式都成立：`.d2h-code-linenumber` 与 `.d2h-code-side-linenumber` 都是 `position:absolute`。
