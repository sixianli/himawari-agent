# PR 523 材料：主人意图核对的 Jev 适配器、接线和评测（ADR 0257 第 3 步第二批）

问题：对话里读过外来内容（网页、邮件等）之后，模型要做有后果的小事（例如设提醒）时，必须确认是主人自己要的，而不是外来内容夹带的指令。第一批（PR 513，已合并）做了端口、严格解析、OwnerIntentGate、规则。本批接上真模型。

改了什么：
- packages/platform-node/src/owner-intent-decision.ts：Jev（Vercel AI Gateway /v1/decisions）适配器，一道 explicit/not_explicit 选择题，发出前遮盖敏感内容，zeroDataRetention，请求 32 KB、响应 1 MB 上限。
- packages/application/src/services/owner-intent-answer.ts：judgeOwnerIntent 放宽为引用原话可选（有就必须逐字出自主人原话）；新增 parseOwnerIntentDecision（要求 body.model 与请求的模型一致、恰好一个名为 owner_intent 的 choice 答案）。
- packages/prompt-catalog/src/authorization.ts + prompt-manifest.json：新提示词。
- apps/agent-service/src/production-owner-intent.ts + service-main.ts：取主人原话（只取本轮 user_message 运行、主人自己的、已提交、公开/私密、最近 6 条、跳过确定性敏感文本、2000 字上限）；装配只在配置写了且密钥来源适合生产时进行。
- 配置键 runPolicy.ownerIntentCheck{enabled,minConfidence,timeoutMs,model,secretRef}。
- 评测集 test/fixtures/owner-intent-eval/dataset.json 和 scripts/evals/owner-intent-live.eval.ts；评测结果在 evals/owner-intent-check/。

约束：失败（超时、出错、没有主人原话、答案不合格）一律不放行，走卡片；重放不重新调用模型；生产配置不写这组键，所以合并后行为不变。DeepSeek 只在评测里用，不在生产路径。

重点查：
1. 发给 Jev 的内容里有没有任何来自外来内容或工具结果的文字（只能有主人原话和动作的工具名、操作、参数）。
2. 取主人原话的过滤有没有可能把外来内容当成主人的话。
3. parseOwnerIntentDecision 对异常响应（多个答案、概率缺失、模型名不符、概率和不为 1）是否都不放行。
4. 把握换算（permille）和 minConfidence 比较的边界。
5. 密钥只在需要时解析、不进日志和审计。
