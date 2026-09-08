# web/components

变更列表、分支状态、diff 容器、顶栏那个明暗开关，以及侧栏 `Files` 那一档的文件树与只读文件视图。

界面上那几枚图标一律走 `Icon`，图形由调用方传一个 Lucide 组件进来。外壳只统一 `size` 与 `aria-hidden`——与 `Badge` 同一条理由：这两样在六处各写一遍时，漏掉一处不报错、也不画错，只是那一枚比旁边的大一圈，或者被读屏多读一遍。

界面上那几枚「只画一枚图标」的按钮（顶栏的明暗开关、文件树上方那枚「全部折叠」）一律走 `IconButton`，理由与 `Badge` 一模一样。它把 `label` 收成必填参数：只画图标时 `aria-label` 是名字的唯一来源、`title` 再给一份 tooltip，摊成两个可选属性时漏掉一个不报错，页面上也什么都看不出来。侧栏那两个 tab 不走它——那两枚另有 `role="tab"` 与选中下划线，是另一种控件。

`FileView` 不走 diff2html，只用 hljs 高亮一次。**容器上不得加 `hljs` 类**：那条规则是 unlayered 的，会压过 `bg-editor-background`，症状只是「文件视图底色跟页面其余部分对不上」。

`Diff2HtmlUI.draw()` 内部是 `innerHTML` 赋值 + 命令式事件绑定，必须放在 Preact 的 ref/effect 之后，不与 vdom 争夺同一棵子树。
