# 样式：Tailwind v4 + 层叠隔离

> 设计 token、diff 行的底色，以及「谁压得过谁」这件事的全部机制。组件与骨架在 [`web.md`](web.md)，diff 渲染在 [`diff-render.md`](diff-render.md)，选型与被排除的做法见 [`../decisions/style.md`](../decisions/style.md)，门禁见 [`../gates.md`](../gates.md)。

**Tailwind v4（CSS-first，`@tailwindcss/vite`）。** 设计 token 写进 `@theme`，命名与数值参照 VS Code 颜色 token（如 `editor.background`），复刻 VS Code 默认主题 Light 2026 / Dark 2026 的观感，轻量优先于还原度。引入完整 preflight。

在此之上用**层叠层**做结构性隔离——**无层（unlayered）样式永远胜过有层样式，与特异性无关**，而 Tailwind v4 把 preflight 放在 `@layer base`：

```css
/* src/web/app.css */
@import "tailwindcss";                              /* preflight → @layer base；utilities → @layer utilities */
@import "./hljs-theme.css";                         /* unlayered */
@import "./vscode-theme.css";                       /* unlayered，明暗开关的三条 color-scheme 规则 */
```

- **hljs 主题是我们自己那份 `hljs-theme.css`**，不直接引上游两份（见下文）。
- **hljs 主题不得放进任何 `@layer`**，否则这层保障就拆掉了。
- **页面上没有第三方 CSS**：diff 表格由我们自己的组件画，配色全走 token 与工具类（见下文「diff 行的底色」）。

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

于是收进与 VS Code token **相同**的机制：每个 `--hljs-*` token 各写一条 `light-dark()`，15 条规则的选择器与顺序逐条照抄上游，颜色一律走 `var()`——漏一条写成硬编码时，另一档下那一处静默停在错的颜色上（`check:css` 拦）。没抄的 3 条：一条空规则，以及 `code.hljs` / `pre code.hljs`——页面上没有 `<code>` 元素。

- **色值取自 VS Code 2026 两份主题的 `tokenColors`**，不再是 highlight.js 的 github / github-dark：两者同属 GitHub Primer 一系，深色几乎逐值相同，浅色是 Primer 新一版。代价是色值抄进了仓库，不随 VS Code 或 highlight.js 升级。体积小幅净增（Lightning CSS 降级后的 token 流更长）。
- **`heading` 与 `constant`、`list` 与 `variable`、`inserted` 与 `entity-tag` 眼下深浅两档都同值，但必须各自独立**：它们是不同的语义，上游 highlight.js 那版就有浅色同值、深色分叉的——就近复用之后一旦再分叉，错色只出现在一档里。
- **`check:css` 只能证明「都走了 `var()`」**（无硬编码颜色、每个 `--hljs-*` 双值且被引用），证明不了色值抄对了。

## 文件视图与 `.hljs`

**`.hljs` 只管 `color`，不管底色**。diff 视图把 `hljs` 类挂在每行正文的 `<span>` 上，而那一行的增删底色画在外面那格上（`diff-code`）。`hljs-theme.css` unlayered，上游那条 `background` 抄进来会无条件盖住它，增删行看起来就成了上下文行，故不抄。

文件视图的容器不挂 `hljs` 类，也用不着：token 规则是独立选择器，不挂容器类照样命中；底色走容器自己的 `bg-editor-background`。

## diff 行的底色：两个变量、两个工具类

**`DiffView` 只在每个 `<tr>` 上标 `data-line`，`app.css` 把它翻成两个变量，再由两个 `@utility` 读**：`--diff-tint` 是行底色，`--diff-edge` 是行号槽右边那条线；缺省即上下文行（没有 tint、线用 `--color-panel-border`）。删除行取 `--color-diff-removed-*`，插入行取 `--color-diff-inserted-*`，hunk 头取 `--color-side-bar-background`，并排的空位取 `--color-diff-diagonal-fill`。

- **翻译规则是 `@layer components` 里的普通规则，不是组件里的 arbitrary-property 类**：行的种类只有 `data-line` 一份来源；普通规则也不靠 Tailwind 扫字面量，一定进产物。比工具类低一层，组件上真要压一条颜色照样压得过。

- **`diff-gutter`（行号槽）必须是实心色**：它 `sticky left-0`，横滚时正文从它底下滑过去，半透明就透字。所以底色是 `--color-editor-background`，tint 作为两层 `background-image` 叠在上面。**叠两层是照旧的观感**：diff2html 的行号格是半透明 tint、`absolute` 压在同样带 tint 的正文格上，比整行深一档。
- **`diff-code`（正文格）只叠一层 tint**。两处读同一个变量，同一行的颜色只写一次。
- **行号槽只画右边线**：左边线会与侧栏的 `border-r` 同色贴在一起叠成 2px，同一条分隔线上粗下细（实测见 [`../decisions/style.md`](../decisions/style.md)）。并排两栏之间那条由右半栏自己的 `border-l` 画。
- **为什么经变量而不是各挂一个 `bg-*`**：同一个颜色两种用法（实心叠加 / 半透明），各挂各的就得每种行写两遍颜色，改一处漏一处。
- **配上对的一删一增与纯增删同色**：只有词级标记多一档，整行不另起一种「改动行」底色（diff2html 有一档琥珀，我们从来没用过）——VS Code 的 diff 编辑器没有这一档区分。**这是取舍不是遗漏**。
- **词级标记**是 `<del>` / `<ins>`，UA 样式是删除线与下划线，preflight 不撤它们；换成圆角底色（`--color-diff-*-text-background`）。
- **词级标记的样式挂在表上**（`[&_del]` / `[&_ins]` 是后代选择器），一份类名管全表，不在每一格上重复。
- `check:css` 查 `.sticky`、`.diff-gutter`、`.diff-code` 三条规则在产物里（类名改成拼出来的，Tailwind 扫不到字面量，规则就静默消失）；真布局归人工。

## `@theme` 变量会被裁掉

**Tailwind v4 会裁掉没被引用的 `@theme` 变量**（工具类用到或 `var()` 引用到的才输出）。**引用名写错时没有报错**：留下无定义的 `var()`，属性变 unset。故 `check:css` 断言产物里每个不带 fallback 的 `var(--…)` 都找得到定义（`--tw-*` 除外）。

声明侧的静默失效换成了**「把深色值写回媒体查询」**：不报错、浅色也对，只是手动档对它无效。故 `check:css` 把**产物里在 `@media (prefers-color-scheme: dark)` 内声明的 `--color-*` / `--hljs-*` 一律判红**（降级补进的 `--lightningcss-*` 不受影响）。

## 按钮的手型光标只写一条

**Tailwind v4 的 preflight 不再把 `<button>` 改成手型**，UA 默认是箭头——整页可点的东西悬停起来与死文字无异，门禁也拦不住。

- **一条 `@layer base { button:not(:disabled) { cursor: pointer } }` 收全部**，不逐个贴 `cursor-pointer`（每加一个按钮就要记得再贴）。工具类仍压得过它。

## 滚动条变细只写一条

**原生滚动条的粗细由一条 `@layer base { * { scrollbar-width: thin } }` 收全部**——`scrollbar-width` 不继承，逐个贴类每加一个滚动容器就要记得再贴。

- **必须落在 `@layer base`，不能 unlayered**：否则压过编辑器标签栏的 `scrollbar-none`（`@layer utilities`），标签栏画出滚动条、被撑高、与顶栏错开，而测试只钉得到类名。
- 只管粗细，颜色跟 `color-scheme`。
- **刻意不写 `::-webkit-scrollbar`**：一旦出现，macOS 的 overlay 滚动条被强制成常显、占宽度的经典滚动条；而 Chrome 121+ 设了 `scrollbar-width` 后本就忽略它。更旧的 Safari 退回默认宽度，不加兜底。
- 不加断言：失效肉眼可见。
