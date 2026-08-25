// 浏览器标签页标题。
//
// 不放进 `store.ts`:那份装的是仓库状态,这里是一个 document 级副作用。也不挂在组件的
// `useEffect` 上 —— 标题不是组件树的产出,跟着某个组件的生命周期走只是碰巧现在成立。
//
// **格式与接线同住一处**(同 `state/layout.ts` 的量法与阈值):仓库名排在产品名之前是
// 一个取舍,而它只有和「谁来写 document.title」放在一起才说得清。

import { computed, effect } from '@preact/signals';
import { repoState } from './store';

/**
 * 拿不到仓库名时的标题。
 *
 * 与 `index.html` 里那个 `<title>` 是同一串 —— 那一份是 JS 跑起来之前的兜底,
 * 两者对不上的症状是首帧标题闪一下换成另一个词。
 */
const PRODUCT_NAME = 'difftab';

/**
 * `<仓库名> · difftab`。
 *
 * **仓库名排在前面**:标签被压窄时浏览器从**尾部**截断,产品名在前时一排标签压窄后
 * 长得一模一样 —— 而分辨「这个标签属于哪个项目」正是这条标题存在的理由。
 *
 * 空串退回纯产品名,不画占位符:`repoName` 的空串意思是「这个根目录没有 basename」
 * (`/`、Windows 盘符根,见 `shared/protocol.ts`),编一个名字出来比少一段更糟。
 */
export function titleFor(repoName: string): string {
  return repoName ? `${repoName} · ${PRODUCT_NAME}` : PRODUCT_NAME;
}

/**
 * 当前仓库名 —— **「第一份状态还没到」与「根目录没有 basename」在这里合成同一种情况**。
 *
 * 两者本来就走同一条展示路径(纯产品名),分开建模只会多一个下游都要收窄一次、
 * 而两侧行为完全相同的分支(同 `layout.ts` 那个「还没量过」与「够宽」不可区分)。
 * 空串的兜底因此只由 `titleFor` 判一次。
 *
 * `computed` 在这里不是摆设:`repoState` 每次刷新都是一个**新对象**,而 SSE 的
 * `change` 在 agent 跑动期间事件密集(见 `store.ts` 的 `latestRequest`)——直接订阅
 * `repoState` 会让每一次刷新都重写一遍标题,而仓库名在一个进程里根本不会变。
 * `Object.is` 去重之后,下面那个 effect 一次会话里只跑第一次和真的换了名字那次。
 */
const repoName = computed(() => repoState.value?.repoName ?? '');

/** 把 `repoName` 接到 `document.title` 上,返回取消订阅的函数。 */
export function syncDocumentTitle(): () => void {
  return effect(() => {
    document.title = titleFor(repoName.value);
  });
}
