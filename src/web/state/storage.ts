// `localStorage` 的读写外壳。落盘的偏好（主题、把手尺寸）共用这一份：**读与写都可能抛**——
// Safari 隐私模式下光是取值就抛，配额满了写也抛——而那时页面可能还没画，抛出去就是整页白屏。
// 解析与脏值怎么退回缺省各自留在调用方：只有它们知道合法值长什么样。

/** 取一个键，取不到或抛了都是 `null`。 */
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * 写一个键，`null` 即删掉。返回写没写成：调用方**写成功之后**才记账，抛了就只在内存里生效，
 * 下一次改动会再试一遍。
 */
export function writeStorage(key: string, value: string | null): boolean {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
    return true;
  } catch {
    return false;
  }
}
