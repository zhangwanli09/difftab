// S0 spike 用的样例 diff:覆盖多种语言,用来肉眼确认 hljs 真的出颜色。
// 同时含一个非 ASCII 路径,顺带确认 §5.2 的 core.quotePath=false 在展示端的效果。
// TODO(S2):随真实数据接入后删除本文件。

export const SAMPLE_PATCH = `diff --git a/src/server/git/status.ts b/src/server/git/status.ts
index 1111111..2222222 100644
--- a/src/server/git/status.ts
+++ b/src/server/git/status.ts
@@ -1,9 +1,12 @@
 import { execFile } from 'node:child_process';

-export async function readStatus(cwd: string) {
-  const args = ['status', '--porcelain=v2', '--branch'];
-  return run(cwd, args);
+/** 唯一数据源:一次调用同时拿到状态位、重命名与分支 ahead/behind。 */
+export async function readStatus(cwd: string): Promise<StatusResult> {
+  // -uall 与 -z 都不能省(spec 5.2)
+  const args = ['status', '--porcelain=v2', '--branch', '-uall', '-z'];
+  const raw = await run(cwd, args);
+  return parsePorcelainV2(raw);
 }

 const TIMEOUT_MS = 5_000;
diff --git a/scripts/collect.py b/scripts/collect.py
index 3333333..4444444 100644
--- a/scripts/collect.py
+++ b/scripts/collect.py
@@ -1,6 +1,8 @@
 import json
+from pathlib import Path

-def load(path):
-    with open(path) as f:
+def load(path: str) -> dict:
+    """Read a JSON file and return its contents."""
+    with Path(path).open(encoding="utf-8") as f:
         return json.load(f)
diff --git a/docs/需求 文档.md b/docs/需求 文档.md
index 5555555..6666666 100644
--- a/docs/需求 文档.md
+++ b/docs/需求 文档.md
@@ -1,3 +1,4 @@
 # 需求

-一句话定位:看一眼代码变更。
+一句话定位:一眼看懂 AI 编码 Agent 改了哪些代码。
+> 路径含空格与非 ASCII 字符,不应出现 \\351\\234\\200 这类转义残留。
`;
