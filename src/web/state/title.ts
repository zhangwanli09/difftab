// 浏览器标签页标题。不放进 `store.ts`（那份装的是仓库状态），也不挂在组件的 `useEffect` 上
//——标题不是组件树的产出。**格式与接线同住一处**：仓库名排在产品名之前是一个取舍，而它只有
// 和「谁来写 document.title」放在一起才说得清。

import { computed, effect } from '@preact/signals';
import { repoState } from './store';

/**
 * 拿不到仓库名时的标题，**也是顶栏在同一情形下的兜底**。与 `index.html` 里那个 `<title>` 是
 * 同一串（那一份是 JS 跑起来之前的兜底），两者对不上的症状是首帧标题闪一下换成另一个词。导出
 * 而不是让顶栏再写一份字面量：两处对不上时页面与标签页各说一个名字，而没有任何东西会响。
 *
 * **共用到这一串为止，「空串退回它」那一步两边各写一次**：两处的组合本就不同（标题要拼
 * `<仓库名> · difftab`，顶栏就是那个名字本身）。
 */
export const PRODUCT_NAME = 'difftab';

/**
 * `<仓库名> · difftab`。**仓库名排在前面**：标签被压窄时浏览器从**尾部**截断，产品名在前时
 * 一排标签压窄后长得一模一样——而分辨「这个标签属于哪个项目」正是这条标题存在的理由。空串
 * 退回纯产品名，不画占位符：那意思是「这个根目录没有 basename」，编一个名字出来比少一段更糟。
 */
export function titleFor(repoName: string): string {
  return repoName ? `${repoName} · ${PRODUCT_NAME}` : PRODUCT_NAME;
}

/**
 * 当前仓库名——**「第一份状态还没到」与「根目录没有 basename」在这里合成同一种情况**：两者
 * 本来就走同一条展示路径（纯产品名），分开建模只会多一个下游都要收窄一次、而两侧行为完全相同
 * 的分支。空串的兜底因此只由 `titleFor` 判一次。
 *
 * `computed` 在这里不是摆设：`repoState` 每次刷新都是一个**新对象**，而 SSE 的 `change` 在
 * agent 跑动期间事件密集——直接订阅它会让每一次刷新都重写一遍标题，而仓库名在一个进程里根本
 * 不会变。
 */
const repoName = computed(() => repoState.value?.repoName ?? '');

/** 把 `repoName` 接到 `document.title` 上，返回取消订阅的函数。 */
export function syncDocumentTitle(): () => void {
  return effect(() => {
    document.title = titleFor(repoName.value);
  });
}
