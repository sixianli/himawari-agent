---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
---

# ADR 0216：聊天找记忆时嵌入失败，退回关键词和实体，不让整轮失败

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [验证](#verification)

<a id="context"></a>

## 背景

按意思找记忆，要先把文字送到模型服务变成向量（这一步叫嵌入，embedding）。嵌入走外网，会失败：断网、网关没报费用、额度用完（HTTP 402）。

同一个系统遇到这种失败有两种表现：Gmail 主动检查和模型主动调用的回忆工具会退回关键词和实体继续找，并写一条“检索降级”的决策记录（决策记录是表 `decision_ledger` 的一行，Andy 可以在网页上逐条评价，见 [ADR 0143](0143-decision-ledger-for-model-gate-decisions.md)）；聊天时每轮自动找记忆这条路径却把整轮记为失败，网页显示“查找相关记忆时，连接模型服务失败”。这是实施清单 P3-2 要修的问题。

ChatGPT 和 Claude 的记忆或检索出问题时，对话照常回答，不会整轮报错。

<a id="premises"></a>

## 前提

1. 检索层自己会退化：`packages/memory-engine/src/hybrid-memory-provider.ts` 的 `search` 在 `embedder.embed` 抛错时调用 `onVectorFailure`，然后用 `embedding = null` 继续按关键词（`terms`）和实体查索引。
2. 生产把 `onVectorFailure` 接到 `retrievalDegradeRecorder`（`apps/agent-service/src/service-main.ts`，`apps/agent-service/src/production-decision-ledger.ts`），写一行 `kind = retrieval_degrade`、`outcome = degraded`、`reason_code = vector_search_unavailable`。
3. 聊天路径整轮失败有两个原因，都在 `apps/agent-service/src/production-run-memory.ts`：
   - 检索层已经降级、拿到了关键词结果，这一层仍按记下的失败抛出 `CONTEXT_MEMORY_UNAVAILABLE` / `CONTEXT_MEMORY_QUOTA_EXCEEDED`，`run-coordinator.ts` 把它记为整轮失败（提交 e7d735cc 引入）。
   - 嵌入请求已经发出、结果不明时，记成“结果未知”（`markUnknown("transport_unresolved")`），整轮的预算账户随之变成 `reconcile_required`，后面回答主人的模型调用会被预算拒绝。提交 030f81f5 的说明原话：“a request that already started leaves the Run budget account in reconcile_required, so the next generation call is refused”。
4. 同一文件里已有按预估上限记账的先例：Gmail 检查路径的 `markUnknown` 把预估费用记进本次检查；嵌入 3 秒没回、重发之前，第一次请求按预估上限结清（[ADR 0119](0119-conversation-speed-prewarm-on-tool-call-and-embedding-retry.md)）。

<a id="decision"></a>

## 决定

1. **聊天路径不再自己抛错。**`production-run-memory.ts` 的 `search` 直接返回检索层的结果。嵌入失败时，检索层退回关键词和实体，并写一条检索降级的决策记录，和 Gmail 检查、回忆工具一样。
2. **聊天路径的嵌入请求发出后失败，按预估上限结清，不再标成“结果未知”。**预估上限是一次嵌入最长输入（16384 token）乘以嵌入模型的输入单价，金额很小；这样预算账户保持 `active`，这一轮能继续调用对话模型。主人取消（运行被中止）时保持原来的做法。
3. **删掉因此用不到的代码：**`CONTEXT_MEMORY_UNAVAILABLE`、`CONTEXT_MEMORY_QUOTA_EXCEEDED` 两个失败码、`RunCoordinator` 里处理它们的分支、执行记录里的映射，以及网页上“查找相关记忆时连接模型服务失败”的三语文案。旧对话里留下的这两个失败码，网页按通用的失败说明显示（Andy 2026-11-09 定：做方案不用顾及旧数据兼容）。
4. **保留的：**每次嵌入失败仍写一行 `memory.embedding_failed` 诊断日志，带 HTTP 状态、网关错误类型和原文，`failure` 字段写 `quota_exceeded` 或 `unavailable`。额度被拒仍能从日志看出来，不会被说成网络问题。

这条决定部分取代 [ADR 0109](0109-paid-eval-runs-need-cost-cap-and-preflight.md) 决定 4 里嵌入的那一部分。对话模型自己返回 402 时的 `PI_MODEL_QUOTA_EXCEEDED` 不变。

依据的原则：产品愿景里的“记忆可靠性”和“主动性与效率”之间，这里没有冲突：记忆照样能找到（关键词和实体），只是少了按意思找的那一路；整轮失败对主人没有任何好处。

<a id="options"></a>

## 放弃的做法

- **只删掉抛错那几行。**预算账户仍会被“结果未知”锁住，这一轮换成一个更含糊的 `RUNTIME_EXECUTION_FAILED` 失败，问题没解决。
- **把嵌入调用放到单独的预算账户，“结果未知”不影响对话模型。**能保留“未知”状态，但要改预算表的账户结构和核对流程，范围远大于这次的问题；嵌入的单次金额很小，按上限记账多记的钱可以忽略。
- **聊天时额度被拒仍整轮失败，只有断网才降级。**额度被拒时关键词和实体照样能找到记忆，整轮失败只会让主人看到一个他当场做不了什么的错误；额度问题由日志和 Vercel 的预算通知告诉 Andy。

<a id="consequences"></a>

## 后果

- 嵌入失败时，聊天照常回答，回答里能用上关键词或实体找到的记忆；按意思才能找到的记忆这一轮找不到。
- 决策记录里会多出“记忆搜索没生效”的行，Andy 可以在网页上看到并评价。
- 嵌入请求失败、结果不明时，按预估上限记账，可能比实际多记一点钱。
- 网页不再有“查找相关记忆时连接模型服务失败”这条说明。

<a id="verification"></a>

## 验证

- `test/integration/production-http-composition-process.test.ts` 的 `[P3-2]` 用例：真实安装的服务，先让它记住一条记忆，再在断网、网关不报费用、402 额度被拒三种情况下发一轮问题。每种情况都验证：这一轮完成；发给对话模型的请求里带着关键词找到的那条记忆；有检索降级的决策记录；嵌入调用已结清、预算账户为 `active`。反向：嵌入正常的第一轮没有检索降级记录。
- `test/integration/decision-ledger.test.ts` 已有“嵌入失败写一行、正常时不写”的用例，这次不改。
