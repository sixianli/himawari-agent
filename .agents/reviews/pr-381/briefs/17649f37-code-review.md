# PR 381 第 7 轮：按第 6 轮意见的修改

上一轮复核的提交是 586a7171。本轮看之后的提交 a8a34638 和 17649f37（逐条判断见 `.agents/reviews/pr-381/round-6/judgments.md`）：

- `packages/memory-engine/src/episodes.ts`：只有超长、向量不合法、服务方 400/413/422 才记“这一条算不出来”并让它等（1 小时起、加倍、最长 24 小时，最多记 1 万条，等待超过 24 小时视为到期）；其余失败直接抛出、不记等待；去掉每次 3 条的失败名额。
- `packages/persistence-sqlite/src/sqlite-memory-operations.ts`：校验 `after` 的形状；分发类型带上 `after`。
- `scripts/embedding-models/build-artifact.py`：上游摘要改写成 (摘要, 文件名) 对，生成的映射不变。
- `ci/rules/gitleaks.toml`、`ci/toolchain-lock.json`、`test/tooling/gitleaks-allowlist.test.mjs`：出包脚本那条白名单改成只按值 `^[0-9a-f]{64}$`、只对那一个文件（仓库主人已同意），条数测试改为 16。

## 请重点核对
- 失败分类会不会把整体性失败（例如网关 400 因为模型名错）记到每一条头上，造成大面积等待；反过来会不会把单条问题当成整体失败而让补算永远停在同一条。
- 白名单是否只放行那一个文件里的 64 位十六进制值。
