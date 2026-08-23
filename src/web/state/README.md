# web/state

`@preact/signals` 状态(spec §5.4)。

SSE 刷新须在不丢失当前选中文件与滚动位置的前提下更新列表(按 path 的 keyed reconcile)。

- `store.ts` 的 `refresh()` 是一次 `change` 事件要重取的全部东西:列表 + **打开着的
  那个文件的 diff**(只刷列表的话右侧会停在旧补丁上,而页面看不出异样)
- `events.ts` 只管连接的开关:`change` → `refresh()`,标签重新激活 → **按静默时长**
  判连接死活(`readyState` 判不出半开的那种),死了才重连,**也只有重连了才补取**
  (§5.8)。档位与降级判定全在后端;心跳是前端唯一消费的监听知识,而它的周期定在
  `shared/protocol.ts`,两边不各写一份
- `layout.ts` 只有一件事:**diff 面板宽度 → 用哪种 diff2html 版式**(§5.5)。量的是
  面板自身的 border box 而非视口,阈值与两条「不能改成那样写」的理由都在文件里;
  `App.tsx` 那个 `ResizeObserver` 是它唯一的写入方
- `title.ts` 是这里唯一**反方向**的一个:别的文件都是「外面 → 状态」的写入适配器,
  它是「状态 → DOM」的读出适配器,自己不持有任何 signal(§5.4 的标签页标题)。
  放在本目录是排除法的结果——它既不是仓库状态(不进 `store.ts`)、也不是组件树的
  产出(不挂 `useEffect`);判据是它只依赖 signals,除此之外与页面结构无关
