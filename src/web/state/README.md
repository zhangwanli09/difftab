# web/state

`@preact/signals` 状态(spec §5.4)。

SSE 刷新须在不丢失当前选中文件与滚动位置的前提下更新列表(按 path 的 keyed reconcile)。

- `store.ts` 的 `refresh()` 是一次 `change` 事件要重取的全部东西:列表 + **打开着的
  那个文件的 diff**(只刷列表的话右侧会停在旧补丁上,而页面看不出异样)
- `events.ts` 只管连接的开关:`change` → `refresh()`,标签重新激活 → **按静默时长**
  判连接死活(`readyState` 判不出半开的那种),死了才重连,**也只有重连了才补取**
  (§5.8)。档位与降级判定全在后端;心跳是前端唯一消费的监听知识,而它的周期定在
  `shared/protocol.ts`,两边不各写一份
