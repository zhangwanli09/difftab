// `logo.mjs` 的类型声明，给 `test/unit/web/logo.test.ts` 用——那边在 strict 下 import 一个没有
// 声明的 .mjs 会报 implicit any。只声明测试用到的那两个导出。

export function faviconSvg(): string;
export function svgDataUri(svg: string): string;
