# web/state

`@preact/signals` 状态。

SSE 刷新须在不丢失当前选中文件与滚动位置的前提下更新列表（按 path 的 keyed reconcile）。

- `editors.ts` 是右侧那条标签栏的模型：有序的 `editors` 列表 + `activeEditorKey`，外加预览 / 固定 / 关闭 / 改名几个**纯列表操作**——不取数据、不 import `store.ts`（方向只有 `store` → `editors` 一条）。预览 tab 的判据是 `pinned === false` 的那一项；`pinEditor` 幂等不 toggle（一次双击是 click、click、dblclick 三个事件）
- `store.ts` 的 `refresh()` 是一次 `change` 事件要重取的全部东西：列表 + **收编栏里全部 diff tab**（消失的关、改名的跟）+ **只重取活动那一个 tab**（后台 tab 切过去时再取）+ 树（只刷列表的话右侧会停在旧补丁上，而页面看不出异样）。diff 与全文的缓存按路径存在两张 map 里，作废在途请求与删缓存成对写在 `forget()`
- `tree.ts` 是文件浏览器那一档的状态：按目录缓存、按目录取（后端一次只回一层）。刷新时**只重取「根 + 展开着的、且真的取过的那几层」**——少了最后半条，从没点开过 `Files` 的会话每收到一个 `change` 都要白跑一趟 `ls-files`
- `change-tree.ts` 是变更列表那档的版式（列表 / 树）与树的折叠态，外加从路径纯算出树的 `buildChangeTree`。折叠态记 **collapsed** 集合（空集即全展开，SSE 新冒出来的目录零登记）、键带分组 id（同一目录在 Staged 与 Unstaged 里是两棵子树）；**不复用 `tree.ts` 的 `expandedDirs`**——那份默认收起且 `refreshTree` 按它发请求。版式不进 `localStorage`：端口随机，写了也活不过一次重启
- `immutable.ts` 是 `ReadonlyMap` 的两个不可变写法（`setIn` / `removeFrom`），目录树与两份 tab 缓存共用；各写一份时漏掉「键不在就原样返回」那半条的那一份会在删一个不存在的键时也唤醒全部订阅者
- `http.ts` 只装那一份 `getJson`：四个端点共用它，是为了「错误正文先当文本读」这条规矩不出现第二份（拷贝里被顺手简化成 `res.json()` 的那一份照样是绿的，只是错误条上显示的是解析错误而不是真正的原因）
- `events.ts` 只管连接的开关：`change` → `refresh()`，标签重新激活 → **按静默时长**判连接死活（`readyState` 判不出半开的那种），死了才重连，**也只有重连了才补取**。档位与降级判定全在后端；心跳是前端唯一消费的监听知识，而它的周期定在 `shared/protocol.ts`，两边不各写一份
- `layout.ts` 只有一件事：**diff 面板宽度 → 用哪种 diff2html 版式**。量的是面板自身的 border box 而非视口，阈值与两条「不能改成那样写」的理由都在文件里；`App.tsx` 那个 `ResizeObserver` 是它唯一的写入方
- `title.ts` 与 `theme.ts` 是这里**反方向**的两个：别的文件都是「外面 → 状态」的写入适配器，这两个是「状态 → DOM」的读出适配器。放在本目录是排除法的结果——它们既不是仓库状态（不进 `store.ts`）、也不是组件树的产出（不挂 `useEffect`，`document.title` 与 `<html>` 上的属性都不该跟着某个组件的生命周期走）；判据是只依赖 signals、除此之外与页面结构无关
- 两者的差别在于**持有不持有 signal**：`title.ts` 纯派生（标签页标题从 `repoState` 算出来），`theme.ts` 自己持有 `themePreference`——它是仓库里第一份跨会话的用户偏好。上次的选择由 `syncDocumentTheme()` **在接线时**读进来，不在模块顶层读：import 期保持干净（与 `title.ts` 一致），首帧时机不受影响（`main.tsx` 在 `render()` 前调它）。读写各自 `try/catch`
