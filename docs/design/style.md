# 样式：Tailwind v4 + 层叠隔离

> 设计 token、diff2html 配色覆写，以及「谁压得过谁」这件事的全部机制。组件与骨架在 [`web.md`](web.md)，diff 渲染在 [`diff-render.md`](diff-render.md)，选型与被排除的做法见 [`../decisions.md` 的「样式层叠」](../decisions.md#样式层叠)，门禁见 [`../gates.md`](../gates.md)。

**Tailwind v4（CSS-first，`@tailwindcss/vite`）。** 设计 token 写进 `@theme`，命名与数值参照 VS Code 颜色 token（如 `editor.background`），复刻 Dark+/Light+ 观感，轻量优先于还原度。引入完整 preflight——与 diff2html 的冲突面实测几乎为零，diff2html 的类选择器稳压 preflight 的通配重置。

在此之上用**层叠层**做结构性隔离——**无层（unlayered）样式永远胜过有层样式，与特异性无关**，而 Tailwind v4 把 preflight 放在 `@layer base`：

```css
/* src/web/app.css */
@import "tailwindcss";                              /* preflight → @layer base；utilities → @layer utilities */
@import "./hljs-theme.css";                         /* unlayered，且必须排在 d2h 之前 */
@import "diff2html/bundles/css/diff2html.min.css";  /* unlayered → 结构上不可能被 preflight 压过 */
@import "./vscode-theme.css";                       /* unlayered，覆写 --d2h-* 与 VS Code token */
```

- **hljs 主题必须排在 `diff2html.min.css` 之前**（diff2html 官方要求）。`diff2html.min.css` 里没有任何 hljs 配色。
- **hljs 主题是我们自己那份 `hljs-theme.css`**，不直接引上游两份（见下文）。
- **hljs 主题与 `diff2html.min.css` 不得放进任何 `@layer`**，否则这层保障就拆掉了。
- **diff2html 渲染出的元素只能通过覆写 `--d2h-*` 改配色，不得用 Tailwind 工具类去压**——无层的 diff2html CSS 胜过 `@layer utilities`，写了也不生效。

## 明暗切换：只翻 `color-scheme` 一处

**顶栏有一个三档开关，但整个切换机制只有三条规则**，写在 `vscode-theme.css` 顶部，必须 unlayered 且进产物（`check:css` 拦）：

```css
:root                      { color-scheme: light dark; }  /* 缺省：跟随系统 */
:root[data-theme="light"]  { color-scheme: light; }
:root[data-theme="dark"]   { color-scheme: dark; }
```

`data-theme` 由 `state/theme.ts` 写（见 [`web.md`](web.md)），**缺省即跟随系统**，不写 `"system"`——那样两条属性选择器一条都不命中。

- **深浅不同的取值一律写成 `light-dark(浅, 深)` 的单条声明**，由 `color-scheme` 选中哪一半。旧写法（`@theme` 写浅色、`@media (prefers-color-scheme: dark)` 写 delta）在有手动档之后必然双写：媒体查询切不出手动档，`[data-theme]` 又切不出跟随系统。
- **顺带修好原生控件**：滚动条、表单与默认焦点环跟的是 `color-scheme`，手动切深色时跟着翻——否则深色页面上出现一条浅色滚动条。
- **`light-dark()` 在产物里不是字面量**：Lightning CSS 把它降级成 `var(--lightningcss-light,浅) var(--lightningcss-dark,深)`，并逐选择器为每条 `color-scheme` 补开关。查产物时搜不到 `light-dark(` 是正常的，`check:css` 两种形状都认。
- **双值 token 不能带不透明度修饰符**（`bg-editor-background/50`）：降级后的值不是合法 `<color>`，塞进 `color-mix()` 会让整条声明作废、属性静默变 unset。当前全库零使用。

## hljs 主题为什么变成我们自己那份

**上游 `github.css` / `github-dark.css` 切不出手动档**：两份都是无条件的 `.hljs` 规则，旧方案靠给深色那份的 `@import` 加媒体条件——而媒体条件切不出手动档；要跟着 `data-theme` 走只能在构建期给选择器加作用域前缀。

于是收进与 `--d2h-*` **相同**的机制：15 个 `--hljs-*` token 各写一条 `light-dark()`，15 条规则的选择器与顺序逐条照抄上游，颜色一律 `var(--hljs-…)`。没抄的 3 条：一条空规则，以及 `code.hljs` / `pre code.hljs`——diff2html 整包没有 `<code>` 元素。

- **代价是色值抄进了仓库**，不随 highlight.js 升级。体积小幅净增（Lightning CSS 降级后的 token 流更长）。
- **两个 token 浅色下与别的同值、深色下才分叉**（`markup-heading`、`markup-inserted`），**必须各自独立**——就近复用时深色悄悄错色，浅色下看不出。
- **`--hljs-bg` 保持上游取值**，不映射到编辑器底色：合并主题不该顺手改观感。
- **`check:css` 只能证明「都走了 `var()`」**（无硬编码颜色、每个 `--hljs-*` 双值且被引用），证明不了色值抄对了。

## 文件视图与 `.hljs`

我们那份主题里的 `.hljs { color; background }` 是 **unlayered** 的，diff2html 把 `hljs` 类加在行容器上，那正是 diff 视图代码区底色的来源。

**文件视图的容器不得加这个类**：unlayered 规则胜过 `@layer utilities`，`class="hljs bg-editor-background"` 里赢的是 `.hljs`——症状只是文件视图底色跟页面对不上。不加也不损失什么：15 条 token 规则是独立选择器，不挂容器类照样命中。

## 为什么 `colorScheme` 传 `'light'`

**diff2html 自带的深色方案不用**：`colorScheme: 'auto'` 输出 `.d2h-auto-color-scheme`，对应规则包在 `@media (prefers-color-scheme: dark)` 里、读另一套 `--d2h-dark-*`。

- 传 `'light'` 输出的 `.d2h-light-color-scheme` 在 diff2html 的 CSS 里**一条规则都没有**，全部配色落在无前缀的基础规则上，深浅由我们覆写的 `--d2h-*` 承担。**这是深色能按 VS Code 取值出来的前提**，不是「只支持浅色」。
- 传 `'auto'` 的后果是静默的：`.d2h-auto-color-scheme .d2h-xxx`（0,2,0）稳压基础规则，深色下读回 GitHub 那套，页面只是「深色不太像 VS Code」。
- **深浅只声明一次**：23 个无前缀 `--d2h-*` 一律 `var(--color-…)` 指向 VS Code token，token 自己在 `light-dark()` 里翻。
- **并排视图那对「改动行」变量（`--d2h-change-del-color` / `--d2h-change-ins-color`）刻意指向与纯增删相同的 token**，放弃上游那档琥珀：VS Code 的 diff 编辑器没有这一档区分。**这是取舍不是遗漏，注释里必须这么写**。

## 覆写生效的两个条件

**unlayered 且排在 diff2html 之后，缺一不可。** 我们的 `:root` 与 diff2html 的 `:host,:root` 特异性同为 (0,1,0)，胜出**纯靠源码顺序**——挪到前面时 23 条覆写整片静默失效，而「块是 unlayered」那条断言照样通过。

`check:css` 因此同时查三件事：声明 `--d2h-*` 的块全部 unlayered；diff2html 那块与我们那块**都存在**（否则顺序断言对着空集合通过）；后者排在前者之后。

- **「哪块是我们的」由哨兵声明 `--gg-d2h-map` 认定，不按值的形状猜**：按「值里有没有 `var(--color-…)`」区分时，给某个变量补一条正当的字面量覆写就会误报「检查 `@import` 顺序」。
- **diff2html 声明的每一个无前缀 `--d2h-*` 都必须出现在我们那个块里**，删掉半张映射表同样是静默退色。

## `@theme` 变量会被裁掉

**Tailwind v4 会裁掉没被引用的 `@theme` 变量**（工具类用到或 `var()` 引用到的才输出）。**引用名写错时没有报错**：留下无定义的 `var()`，属性变 unset。故 `check:css` 断言产物里每个不带 fallback 的 `var(--…)` 都找得到定义（`--tw-*` 除外）。

声明侧的静默失效换成了**「把深色值写回媒体查询」**：不报错、浅色也对，只是手动档对它无效。故 `check:css` 把**产物里在 `@media (prefers-color-scheme: dark)` 内声明的 `--color-*` / `--hljs-*` 一律判红**（diff2html 的 `--d2h-dark-*` 与降级补进的 `--lightningcss-*` 不受影响）。

## 四条选择器规则的例外

`vscode-theme.css` 末尾四条在「只能改 `--d2h-*`」之外，**且只有这四条**：`.d2h-diff-table { font-family }`、`.d2h-file-header { display: none }`、`.d2h-file-wrapper { border: none; margin-bottom: 0 }`、最左那列行号的 `border-left: none`。`--d2h-*` 全是颜色，字体、显隐、盒子、留白、某一条边框都没有变量可覆。四条胜出同样**靠排在 `diff2html.min.css` 之后**。藏掉文件头的理由见 [`diff-render.md`](diff-render.md)。

- **被架空的变量仍要留在映射块里**（`--d2h-file-header-*`、`--d2h-border-color`）：覆盖率断言从 diff2html 那块推导全部变量名，删掉即红。
- **补丁外框与底下留白一起去掉**：文件头藏掉后外框只剩副作用（与标签栏下沿画出第二条平行线），留白是为「一次画多个文件」准备的。**不写成 `--d2h-border-color: transparent`**：透明边框仍占 1px，那个变量还被别的规则读到，且等于把版式决定藏在颜色映射里。
- **最左那列行号的左边框不画**：它与侧栏 `border-r` 同色贴在一起叠成 2px，同一条分隔线上粗下细（实测见 [`../decisions.md` 的「样式层叠」](../decisions.md#样式层叠)）。**只关最左那一列**：右边框与并排第二栏的左边框仍有分隔作用，所以不能动 `--d2h-line-border-color`。行号列是 `border-box` + 固定宽度 + 右对齐，去掉左边框零位移。
- **四条都不加断言**：失效症状肉眼可见，不属于门禁要防的静默故障。

## 按钮的手型光标只写一条

**Tailwind v4 的 preflight 不再把 `<button>` 改成手型**，UA 默认是箭头——整页可点的东西悬停起来与死文字无异，门禁也拦不住。

- **一条 `@layer base { button:not(:disabled) { cursor: pointer } }` 收全部**，不逐个贴 `cursor-pointer`（每加一个按钮就要记得再贴）。工具类仍压得过它。diff2html 子树里没有 `<button>`，不会越界。

## 滚动条变细只写一条

**原生滚动条的粗细由一条 `@layer base { * { scrollbar-width: thin } }` 收全部**——`scrollbar-width` 不继承，逐个贴类每加一个滚动容器就要记得再贴。

- **必须落在 `@layer base`，不能 unlayered**：否则压过编辑器标签栏的 `scrollbar-none`（`@layer utilities`），标签栏画出滚动条、被撑高、与顶栏错开，而测试只钉得到类名。
- 只管粗细，颜色跟 `color-scheme`。
- **刻意不写 `::-webkit-scrollbar`**：一旦出现，macOS 的 overlay 滚动条被强制成常显、占宽度的经典滚动条；而 Chrome 121+ 设了 `scrollbar-width` 后本就忽略它。更旧的 Safari 退回默认宽度，不加兜底。
- 不加断言：失效肉眼可见。

## 行号列需要一个 positioned 祖先

**diff2html 的行号列是 `position: absolute`，滚动容器内部必须有一个 positioned 祖先。** diff2html 假定滚的是整个文档；我们把滚动收进了内层 `overflow-auto` 容器（SSE 刷新要留住各栏滚动位置），**包含块在滚动容器之外的绝对定位盒不随内容滚动**——一滚代码行走了、整列行号原地不动。

- 包含块由 `DiffView` 交给 `Diff2HtmlUI` 的宿主 div 上的 `relative` 提供：作用域最小，与 diff2html 子树同生共死。它是我们自己的元素，写 Tailwind 类不违反「只能改 `--d2h-*`」。
- `diff-view.test.tsx` 钉类名、`check:css` 查规则在不在；真布局归人工。两种版式的行号类都是 `position:absolute`。
