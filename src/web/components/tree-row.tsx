// 两棵树（变更列表的树视图、`Files` 那档的目录树）共用的一行：行的骨架、缩进量、目录行的展开
// 三角、文件行与它等宽的占位，以及一行的形状本身（`TreeRow`：group div、行内动作的占位与外壳）与
// 悬停露出的 `Copy path`。
//
// 独立成文件而不是从其中一棵导出：`FileTree` 已经 import `ChangeList` 的 `CODE_COLORS`，反向
// import 会成环。**这几样必须同住一处**：三角按 12 画、占位 `w-3`（= 12px）是同一个不变量，各写一
// 份时改其中一处不报错，只是另一棵树里文件名比同层的目录名往左挪一截；缩进量各写一个常量同样
// 不报错，只是切一次 tab 缩进跳一截；行骨架各写一份时同样不报错，只是切一次 tab 三角与名字的
// 间距跳一截；一行的形状各拼一份时同样不报错，只是占位的枚数与真画的按钮数各算各的、省略号多退或
// 少退 20px。

import { useSignal } from '@preact/signals';
import { Check, ChevronRight, Copy } from 'lucide-preact';
import { type ComponentChildren, type JSX, type Ref, toChildArray } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Icon } from './Icon';
import { IconButton } from './IconButton';

/**
 * 一行的骨架。**不给纵向内边距，字号与行高也不在这里**：行高（24px）由列表区那个 `<nav>` 的
 * `text-sm/6` 给、行靠 preflight 的 `font: inherit` 继承——一行里嵌着小一号的东西（目录段、状态字母、
 * 重命名标注都是 `text-xs`），line-height 定行高时它们共用同一个 24px 行盒；靠 `py-*` 凑时各段自带
 * 16 / 20 两种行高，基线要另行对齐。
 *
 * focus-visible 那两个类是键盘可达性的最低档：行是 <button>，而 preflight 清掉了 UA 默认焦点环，
 * 用 focus-border token 画，深浅都跟着翻。手型光标不在这里——那是所有按钮共有的一件事，
 * `styles/app.css` 里有一条 base 层规则统一给。
 *
 * **对齐方式与左内边距刻意不在这一串里**：文件行是「文件名 + 状态位」两段文字，按基线排；目录行
 * 是一枚 SVG 加一段文字，替换元素的基线是它的底边，按基线排三角会整个浮在文字上方，得
 * `items-center`——两种行各补自己那一个。左内边距一律由 `indent()` 给（见上）。
 */
export const ROW_BASE =
  'flex w-full gap-1.5 pr-3 text-left focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-border';

/** 每一层的缩进量（px）。用内联 style 按层级算——层数没有上界，而 Tailwind 只产出源码里出现过的类名。 */
const INDENT_PX = 12;

/**
 * 一行（或一句占位文案）在第 `depth` 层的左内边距。**只此一份**，两处各写一遍会让占位与行错位。
 * **平铺列表的行也走这里、取第 0 层**（= 12px，与侧栏别处的 `px-3` 同宽）：左内边距于是在三种视图
 * 里只有这一个来源，不必再给列表那档单独贴一个会被内联 style 盖掉的 `pl-*`。
 */
export const indent = (depth: number) => ({ paddingLeft: `${(depth + 1) * INDENT_PX}px` });

/**
 * 目录行的展开三角。展开时靠 `rotate-90` 转 90°，不另换一枚朝下的图标。**按 12 画**：它是行首的
 * 从属记号而不是内容，与文件名同高时会跟名字抢视线。
 */
export function ExpandChevron({ expanded }: { expanded: boolean }) {
  return <Icon icon={ChevronRight} size={12} class={`shrink-0 ${expanded ? 'rotate-90' : ''}`} />;
}

/** 文件行上与三角等宽的占位。少了它文件名会比同层的目录名往左挪一截，同一层看着像两层。 */
export function ChevronPlaceholder() {
  return <span class="w-3 shrink-0" />;
}

/**
 * 文件行上行内动作的显隐：悬停整行或键盘焦点落在行内时才进流，其余时刻 `display: none`。
 * **走 `display` 不走透明度**（编辑器 tab 上那枚 × 用透明度是为了留住位置）：这里按钮悬在文字
 * 上方，透明就是一块看不见却能点的死区，点到目录段的尾巴会误开文件。`group-has-focus-visible`
 * 那半条给键盘——Tab 从行按钮移过去时它得先显示出来才接得住焦点。**是 `focus-visible` 不是
 * `focus-within`**：鼠标点一下按钮，Chrome / Firefox 会把焦点留在它身上，`:focus-within` 于是一直
 * 成立，鼠标移开后按钮还钉在行上，直到点别处把焦点带走；鼠标点出来的焦点不算 focus-visible，
 * Tab 过来的才算，正好是「键盘要它常亮、鼠标走了就收」这两条。不在点击后 `blur()`：键盘用户
 * 按 Enter 之后焦点就没了。
 *
 * **`pointer-coarse:flex` 给触屏常驻显示**：Tailwind v4 把 `group-hover:*` 包在 `@media (hover: hover)`
 * 里，触屏上那半条从不成立；而触摸来的焦点也不算 focus-visible（iOS Safari 更是根本不给按钮焦点），
 * 少了这条触屏上两枚按钮永远 `display: none`——页面照常，只是从来没人见过它们。
 *
 * **占位与按钮外壳共用这一个常量，且两处都只在 `TreeRow` 里画**：占位在行按钮里、把文字挤开，按钮
 * 绝对定位在它上面，两处的显隐必须是同一对变体。导出只为让用例钉住那几个变体。
 */
export const REVEAL = 'hidden group-hover:flex group-has-focus-visible:flex pointer-coarse:flex';

/**
 * 行按钮与它的行内动作外壳同住的那个 `<div>`：`group` 让显隐跟着它走，`relative` 让外壳以它为包含
 * 块。**是 `<li>` 里的内层 `<div>`，不是 `<li>` 本身**：目录行的 `<li>` 里还套着子 `<ul>`，group 挂在
 * `<li>` 上时悬停任一后代整段目录行都会亮出按钮、底色一起变。
 *
 * **行的悬停底色也画在这里，不画在行按钮上**：指针从行上移到行内动作上时已经离开了 `<button>`，
 * 底色挂在按钮上（`hover:`）那一刻就消失、按钮悬在一块没底色的行上。按钮是这个 div 唯一的在流子
 * 项且通宽，选中行自己的底色照常盖在上面。导出只为让用例钉住它不在行按钮上。
 */
export const ROW_GROUP = 'group relative hover:bg-list-hover-background';

/**
 * 行内动作的外壳：绝对定位在状态位左侧（那道 `right-9.5` 的加法见 `TreeRow`），**并把站进来的每一枚
 * 按钮静止时淡到 `opacity-75`、指针悬到或键盘焦点落到那一枚上时恢复满色**。lucide 2px 描边在
 * 16px 下比同色文字看着重，满色时比旁边那枚同样 `opacity-75` 的状态字母（`STATUS_SLOT`）抢眼；
 * 同值同机制，一行里的从属记号于是只有一档淡。
 *
 * **淡化画在外壳上、按子选择器逐枚生效，不做成 `IconButton` 的一档**：「与状态字母同档」是这个
 * 槽位的不变量——凡站进来的都得如此、站在别处的（顶栏开关、`Collapse all`、编辑器 tab 的 ×）都
 * 不该如此，写成按钮的 prop 时第三枚动作忘传不报错，只是比邻居重一档。**恢复是逐枚的**
 * （`[&>*:hover]` 而不是外壳自己的 `hover:`）：两枚并排时悬停的那一枚亮、旁边那枚仍淡。
 * **是 `opacity` 不是 token 的 `/75` 修饰符**，理由与 `STATUS_SLOT` 那处一字不差。导出只为让用例钉住。
 */
export const ACTION_SHELL = `${REVEAL} absolute inset-y-0 right-9.5 items-center [&>*]:opacity-75 [&>*:hover]:opacity-100 [&>*:focus-visible]:opacity-100`;

/**
 * 行按钮里、状态位之前的占位宽度，按外壳里真画的枚数取（`IconButton` 是 p-0.5 + 16px 图标 = 20px
 * 一枚）：悬停时进流把前面的截断盒挤开——省略号于是提前，文字是真的重排，照 VS Code。不常驻预留：
 * 那是每行永久少几十像素文字宽度，320px 侧栏里是一到两成。写成一张表而不是算：Tailwind 只产出源码
 * 里出现过的类名，第三枚动作出现时在这里补一格。
 */
const SPACER_WIDTH = ['', 'w-5', 'w-10'];

/**
 * 两棵树共用的一行：`<li>` 里一个 `ROW_GROUP` div 装行按钮与它的行内动作，子层（`sublevel`）在
 * div 之外。行按钮的属性（点击、`title`、`class`、`style`、`aria-expanded`）原样透传，`class` 可以是
 * signal——signals 把它直接绑到 `<button>` 上，每行只改自己那两个类。
 *
 * **占位的枚数从 `actions` 算出来，不另给参数**：占位与外壳里真画的枚数各写一份时漂开不报错，
 * 只是省略号多退或少退 20px；由同一个组件从同一份列表画两处，这一条就不需要有人记得了。
 *
 * 外壳是行按钮的**兄弟**，不套在里面：按钮里不能套按钮，理由与编辑器 tab 上那枚 × 一字不差；它的
 * 事件压根不经过行按钮，点它不会顺带开一个 tab、也不会折叠目录。绝对定位在状态位左侧：
 * `right-9.5`（38px）= ROW_BASE 的 `pr-3`（12）+ 状态位 `w-5`（20）+ `gap-1.5`（6），与枚数无关。
 * 文字被截断的行里占位正好在它底下；短行里占位贴着文字、按钮悬在空白上，两种情况都盖不到字
 * ——改行骨架的间距或状态位宽度时这道加法要跟着改，症状只是与字母挨着或错开几像素。几枚之间
 * 不加 gap：各自的 `p-0.5` 已隔出 4px，照 VS Code 的 action bar。没有状态记号的行（没改动的文件、
 * 目录）里占位落在外壳右侧 26px 处：外壳锚在状态位左侧不随记号有无变（一列按钮才对得齐），占位
 * 只保证「文字末端在按钮左缘之左」，那条在两种行里都成立。
 */
export function TreeRow({
  actions,
  badge,
  sublevel,
  buttonRef = null,
  children,
  ...button
}: {
  /** 行内动作那几枚 `IconButton`，`false` / `null` 会被剔掉，剩下几枚占位就几枚宽。 */
  actions: ComponentChildren;
  /** 行按钮的 ref。显式命名：Preact 会把 `ref` 从 props 里剥掉，靠 `...button` 透传不到。 */
  buttonRef?: Ref<HTMLButtonElement>;
  /** 行尾的状态记号，排在占位之后、靠右。 */
  badge?: ComponentChildren;
  /** 展开的子层 `<ul>`，画在 group div 之外。 */
  sublevel?: ComponentChildren;
  children: ComponentChildren;
} & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'>) {
  const list = toChildArray(actions);
  return (
    <li>
      <div class={ROW_GROUP}>
        <button type="button" ref={buttonRef} {...button}>
          {children}
          {list.length > 0 && <span class={`${REVEAL} shrink-0 ${SPACER_WIDTH[list.length]}`} />}
          {badge}
        </button>
        <span class={ACTION_SHELL}>{list}</span>
      </div>
      {sublevel}
    </li>
  );
}

/** `Copied` 那一档停留多久。取 GitHub 代码块上那枚复制按钮的档位——够看清一眼、不至于挡住下一次。 */
const COPIED_MS = 1500;

/**
 * `Copy path`：把仓库相对路径（页面上现成的 `path`，`/` 分隔）写进剪贴板。贴给 agent 与 git 子命令
 * 要的都是这一种，绝对路径要给协议加 `root`。
 *
 * **反馈画在按钮自己身上**：写成功后图标换 `Check`、名字换 `Copied`，1.5s 后复原；320px 侧栏里
 * 没地方放 toast，而反馈本就该出现在手指底下。写失败静默不换——服务绑定 `127.0.0.1`，loopback
 * 是 secure context，`navigator.clipboard` 一定在，失败只剩用户拒了权限这一种，一条错误在侧栏里
 * 没地方落。计时器随卸载清掉：SSE 刷新可能在 1.5s 内把这一行换掉，之后再写一个已卸载组件的
 * signal 虽不报错，但也不该留着。
 */
export function CopyPathButton({ path }: { path: string }) {
  const copied = useSignal(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () =>
    navigator.clipboard.writeText(path).then(
      () => {
        copied.value = true;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          copied.value = false;
        }, COPIED_MS);
      },
      () => {},
    );
  return (
    <IconButton
      icon={copied.value ? Check : Copy}
      label={copied.value ? 'Copied' : 'Copy path'}
      onClick={copy}
    />
  );
}
