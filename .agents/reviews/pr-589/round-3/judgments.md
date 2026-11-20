# PR 589 第 3 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1（中高）改了 `propose_memory` 工具说明，却没有更新 prompt 清单，自动检查会失败。已核实：运行 prompt-catalog.unit.test.ts 报 PROMPT_MANIFEST_STALE mcp.propose-memory；已重算清单摘要并改 changedIn/reason，测试通过；触发：跑 npm test 或 CI 的 prompt 清单检查；后果：合并检查失败，阻止合并
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2（中高）上轮“敏感内容可被自定义分类绕过”仍未在代码里修好，工具说明反而把保护说成由外部 agent 自己选分类决定。proposalClassification 只认 health、finance 与正文标识符（production-mcp-memory-writer.ts:94-101）；与第 1、2 轮同一缺口，Andy 2026-11-15 14:33Z 选先接受缺口再合并，沿用原判（andy-decision）；工具说明里“证件”分类确实不存在，已改为“健康或财务的内容，或正文里含证件号、银行卡号”，与代码一致；触发：外部 agent 把健康或财务内容标成 other 或 identity，接入设了直接存；后果：敏感内容以 private 不经确认入库并被使用
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3（低）ADR 说“直接存的条目不占待确认和暂存上限”，与提交端先计入待确认再保存的代码不符。ADR 0281:75 写“不占待确认和暂存上限”，而提交端先占 pending 再保存（sqlite-external-memory-proposal-operations.ts:158-172）；文字不准，不误导操作；第 3 轮起低问题不修（low-deferred），且避免动正在被 plan-claims 读取的 ADR；触发：待确认已满 1000 条时再直接存；后果：该条回 full 而 ADR 说不受限，仅文字不准
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4（低）“去重不进批次”的修复没有被新测试真正覆盖，回退该行测试仍会通过。全重复批次用例在 submit 阶段就回 already_saved，走不到 #keep 的 same 分支，回退 batchId:null 该用例仍过；只影响测试覆盖；第 3 轮起低问题不修（low-deferred）；触发：以后有人把去重分支的 batchId:null 改回去；后果：回归时测试不报错，记忆页出现空操作的可撤销批次，不丢数据
- 5（deepseek-v4.1-flash）成立，会出错，低：### 5（低）ADR 的自动检查数量已过时。ADR 0281:76 写四个 [direct] 用例，实际 grep 有多个；纯文字漂移；第 3 轮起低问题不修（low-deferred）；触发：读 ADR 的人核对用例数；后果：数量说法过时，不影响行为
