// logo 的几何：符号与字标，**唯一的一份**。`components/Logo.tsx` 与 `scripts/logo.mjs` 都从这里
// import——前者拿符号喂给 `createLucideIcon`，后者拼成 `assets/` 下的 SVG 与 favicon。
//
// 写成 .mjs 而不是 .ts：脚本是零依赖纯 JS、由 `node scripts/logo.mjs` 直接跑，import 不了 TS；
// 而反过来让组件 import 脚本，等于把一个会拉起 Chrome 的模块打进前端产物。类型在旁边的
// `geometry.d.mts`。本文件只有数据与纯函数，没有 Node API。
//
// 坐标系是 Lucide 的 24 网格、2 单位描边。方头（`square`）、尖角（`miter`）、零圆角——刻意比 Lucide
// 硬一档：圆头 + 圆角 + 圆 bowl 三样叠起来整套就软了。

/** 方头尖角写在每条 path 自己身上——Lucide 把圆头写在 `<svg>` 上，元素属性压过继承值。 */
const CAP = { 'stroke-linecap': 'square', 'stroke-linejoin': 'miter' };

/** 符号的脚落在这条线上。视觉边界 4.5..19.5 正好以 12 为中心：顶栏与 favicon 靠盒子对齐，图形
 * 在盒子里偏下时 `items-center` 对齐出来的就是「看着没居中」。 */
export const MARK_FOOT_Y = 18.5;

/**
 * 符号：直角的标签页剪影（身体 3..21 × 5.5..18.5）里一短一长两行。形状与 lucide 的 IconNode 一致
 * （`[tag, attrs][]`），可直接喂给 `createLucideIcon`。
 */
export const MARK = [
  ['path', { d: `M1 ${MARK_FOOT_Y}h2V${MARK_FOOT_Y - 13}h18v13h2`, ...CAP }],
  ['path', { d: 'M7 10.5h6', ...CAP }],
  ['path', { d: 'M7 14.5h10', ...CAP }],
];

/**
 * 字标「difftab」：基线 y=21、x-height 顶 y=11、ascender 顶 y=6，bowl 10×10 圆角 1。
 * d/a/b = bowl + 竖，i = 竖 + 方点，f f t 三根横笔连成一条贯穿的横线。x 从 0 起。
 *
 * 只有脚本用它，前端只 import `MARK`。`@__PURE__` 让 Rollup 敢把这个顶层调用连同整段字标一起
 * 摇掉——没有它，产物里多出一段没人引用的 path 字符串（实测 +0.4 KB），而 `size` 门禁离顶还远、
 * 不会响。
 */
/** 字标的基线。单独导出：组合版的平移量由它算，而那条算式不能去读 `WORDMARK` 的属性——顶层的
 * 成员访问在 Rollup 眼里可能是 getter、有副作用，整段字标就又摇不掉了。 */
export const WORDMARK_BASELINE = 21;

export const WORDMARK = /* @__PURE__ */ (() => {
  const BASE = WORDMARK_BASELINE,
    XH = 11,
    ASC = 6,
    R = 5,
    RX = 1,
    W = 2 * R - 2 * RX;
  const bowl = (cx) =>
    `M${cx - R + RX} ${XH}h${W}a${RX} ${RX} 0 0 1 ${RX} ${RX}v${W}a${RX} ${RX} 0 0 1-${RX} ${RX}h-${W}a${RX} ${RX} 0 0 1-${RX}-${RX}v-${W}a${RX} ${RX} 0 0 1 ${RX}-${RX}z`;
  const F1 = 19.5,
    F2 = 26,
    T = 32.5,
    AC = 44.5,
    BX = 54;
  const paths = [
    // d
    bowl(R),
    `M10 ${ASC}v${BASE - ASC}`,
    // i（点在下面 dot）
    `M14.5 ${XH}v${BASE - XH}`,
    // f f t：竖笔各自带直角的钩，三根横笔合成一条从 f1 左 3 到 t 右 3 的线
    `M${F1} ${BASE}V${ASC}h4`,
    `M${F2} ${BASE}V${ASC}h4`,
    `M${T} ${ASC + 2}V${BASE}h4`,
    `M${F1 - 3} ${XH}H${T + 3}`,
    // a
    bowl(AC),
    `M${AC + R} ${XH}v${BASE - XH}`,
    // b
    `M${BX} ${ASC}v${BASE - ASC}`,
    bowl(BX + R),
  ];
  return { paths, dot: { x: 14.5, y: ASC + 1, size: 2.5 }, width: BX + 2 * R };
})();

/** 组合版里字标的起点：符号 24 宽 + 6 间距。 */
export const WORDMARK_X = 24 + 6;

/** 组合版里符号往下平移这么多，脚才落在字标的基线上。 */
export const MARK_BASELINE_SHIFT = WORDMARK_BASELINE - MARK_FOOT_Y;
