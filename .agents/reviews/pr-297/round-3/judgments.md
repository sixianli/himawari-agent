# PR 297 第 3 轮逐条判断（线程：云端接手线程；复核提交 5360b2e）

| 意见 | 判断 | 处理 |
| --- | --- | --- |
| 1 非 RSA/EC/OPENSSH 私钥块只遮头 | 成立，会出错，中高（泄露凭据；触发：记录里引用 ENCRYPTED/DSA/PGP 完整私钥块；读 `opencode-review.mjs` 规则确认只遮开头） | 新增 `private-key-any-block`（任意标签、大小写不分，BEGIN 到 END 最多 8000 字符），补 `[round-3 R3-1]` |
| 2 改别的 PR 记录目录可借 `--accept-unreviewed` 绕过 | 成立，会出错，中 | 本 PR 之外被改动的 `.agents/reviews/` 文件也查 `record-secret-like`，放行不了；补 `[round-3 R3-2]` |
| 3 补跑比较依赖当前规则集、摘要对不上存档 | 成立但低（触发：改规则后补跑旧轮次，结果是报 `ROUND_PROMPT_MISMATCH` 拒绝，不给错结果；模型自评中低） | 未改，列给 Andy |
| 4 I-86 文档写“提示词走 maskedRecordText” | 成立，低（说明与代码不符，但不会让人做错事） | 文档已改 |
| 5 ledgerLine 遮盖 files/findings 后与真值比较会误拒 low-fix | 成立，低（触发：文件名或 id 含像密钥的子串；结果是 `files-differ` 拒绝） | 比较时把被复核一方按同样规则遮盖；未单独补用例（需要含密钥形文件名的 low-fix 夹具） |
| 6 测试缺口 | 部分成立：缺完整非标准块、跨 PR 记录用例（已补）；`record-unreadable` 在 `--accept-unreviewed` 下不可放行：它不在 `OVERRIDABLE_PROBLEMS`，未补专门用例 | 已补两条 |
