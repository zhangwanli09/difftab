# server/watch

三档监听(A/B/C)+ debounce + 轮询兜底(spec §5.7)。

**边界**:不得反向 import `http/` 或 `cli/`。
档位判定用 `process.versions.node` 的 semver 比对,禁用特性探测;
`ignore` 传逐段匹配函数,禁字符串模式;B 档过滤必须在 debounce 之前。
