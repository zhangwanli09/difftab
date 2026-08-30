# web/state

`@preact/signals` 状态。

SSE 刷新须在不丢失当前选中文件与滚动位置的前提下更新列表(按 path 的 keyed reconcile)。

- `store.ts` 的 `refresh()` 是一次 `change` 事件要重取的全部东西:列表 + **打开着的
  那个文件的 diff**(只刷列表的话右侧会停在旧补丁上,而页面看不出异样)
- `events.ts` 只管连接的开关:`change` → `refresh()`,标签重新激活 → **按静默时长**
  判连接死活(`readyState` 判不出半开的那种),死了才重连,**也只有重连了才补取**。
  档位与降级判定全在后端;心跳是前端唯一消费的监听知识,而它的周期定在
  `shared/protocol.ts`,两边不各写一份
- `layout.ts` 只有一件事:**diff 面板宽度 → 用哪种 diff2html 版式**。量的是
  面板自身的 border box 而非视口,阈值与两条「不能改成那样写」的理由都在文件里;
  `App.tsx` 那个 `ResizeObserver` 是它唯一的写入方
- `title.ts` 与 `theme.ts` 是这里**反方向**的两个:别的文件都是「外面 → 状态」的写入
  适配器,这两个是「状态 → DOM」的读出适配器。放在本目录是排除法的结果——它们既不是
  仓库状态(不进 `store.ts`)、也不是组件树的产出(不挂 `useEffect`,`document.title`
  与 `<html>` 上的属性都不该跟着某个组件的生命周期走);判据是只依赖 signals、
  除此之外与页面结构无关
- 两者的差别在于**持有不持有 signal**:`title.ts` 纯派生(标签页标题从 `repoState`
  算出来),`theme.ts` 自己持有 `themePreference` —— 它是仓库里第一份跨会话的用户偏好。
  上次的选择由 `syncDocumentTheme()` **在接线时**读进来,不在模块顶层读:import 期保持
  干净(与 `title.ts` 一致),首帧时机不受影响(`main.tsx` 在 `render()` 前调它)。
  读写各自 `try/catch`
