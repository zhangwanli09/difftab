# web/components

变更列表、分支状态、diff 容器、顶栏那个明暗开关。

`Diff2HtmlUI.draw()` 内部是 `innerHTML` 赋值 + 命令式事件绑定，必须放在 Preact 的 ref/effect 之后，不与 vdom 争夺同一棵子树。
