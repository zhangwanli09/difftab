// `ReadonlyMap` 的两个不可变写法。signals 只认引用变化，按键缓存的那几份状态（目录树的每一层、
// 每个 tab 的 diff 与全文）每次写都得换一份新 Map——这两行在三处各写一份时，漏掉「键不在就原样
// 返回」那半条的那一份会在删一个不存在的键时也唤醒全部订阅者，不报错。

export function setIn<V>(
  map: ReadonlyMap<string, V>,
  key: string,
  value: V,
): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

export function removeFrom<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}
