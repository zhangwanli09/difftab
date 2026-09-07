# web/components

变更列表、分支状态、diff 容器、顶栏那个明暗开关，以及侧栏 `Files` 那一档的文件树与只读文件视图。

界面上那几枚图标一律走 `Icon`，图形由调用方传一个 Lucide 组件进来。外壳只统一 `size` 与 `aria-hidden`——与 `Badge` 同一条理由：这两样在六处各写一遍时，漏掉一处不报错、也不画错，只是那一枚比旁边的大一圈，或者被读屏多读一遍。

`FileView` 不走 diff2html，只用 hljs 高亮一次。**容器上不得加 `hljs` 类**：那条规则是 unlayered 的，会压过 `bg-editor-background`，症状只是「文件视图底色跟页面其余部分对不上」。

`Diff2HtmlUI.draw()` 内部是 `innerHTML` 赋值 + 命令式事件绑定，必须放在 Preact 的 ref/effect 之后，不与 vdom 争夺同一棵子树。
