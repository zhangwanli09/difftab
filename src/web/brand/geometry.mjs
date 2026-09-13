// logo 的几何：符号，**唯一的一份**。`components/Logo.tsx` 与 `scripts/logo.mjs` 都从这里
// import——前者拿符号喂给 `createLucideIcon`，后者拼成 `assets/` 下的 SVG 与 favicon。
//
// 写成 .mjs 而不是 .ts：脚本是零依赖纯 JS、由 `node scripts/logo.mjs` 直接跑，import 不了 TS；
// 而反过来让组件 import 脚本，等于把一个会拉起 Chrome 的模块打进前端产物。类型在旁边的
// `geometry.d.mts`。本文件只有数据与纯函数，没有 Node API。
//
// 坐标系是 Lucide 的 24 网格，但由填充不由描边：16px 下 2 单位描边的线稿糊成一团，色块还是
// 三条。没有字标——界面只用符号，README 与社交预览里的名字是文字。

/**
 * 红绿是固定的品牌色，明暗两档不切；选的是在纯白与 `#1f1f1f` 上对比都够的中等明度。
 *
 * 不读 `app.css` 的 `--color-git-*`：那两个 token 是给文件名文字调的，铺成色块亮档偏泥、暗档
 * 偏粉。也不另立 token：`@theme` 里 CSS 没引用的 token 会被 Tailwind 裁掉，而这两个值恰恰不该
 * 随主题切。
 */
const MARK_COLORS = { removed: '#e5484d', added: '#30a46c' };

/**
 * 符号：一段 diff hunk——上下文、删除、新增三条圆角色条，左缘齐在 x=3，整体 4..20 以 12 为中心。
 * 形状与 lucide 的 IconNode 一致（`[tag, attrs][]`），可直接喂给 `createLucideIcon`。
 *
 * 每条自带 `stroke: 'none'`：Lucide 把 `stroke="currentColor" stroke-width="2"` 写在 `<svg>` 上
 * 给描边图标用，rect 会继承它、被描上一圈 2 单位的边，而这一圈在 16px 下只是「色条比预想的
 * 胖、颜色发暗」。上下文那条 `currentColor` 叠 35% 不透明度，跟着所在处的文字色翻深浅。
 */
const bar = (y, width, fill) => [
  'rect',
  { x: '3', y: String(y), width: String(width), height: '4', rx: '1.5', ...fill, stroke: 'none' },
];

export const MARK = [
  bar(4, 10, { fill: 'currentColor', 'fill-opacity': '0.35' }),
  bar(10, 15, { fill: MARK_COLORS.removed }),
  bar(16, 12, { fill: MARK_COLORS.added }),
];
