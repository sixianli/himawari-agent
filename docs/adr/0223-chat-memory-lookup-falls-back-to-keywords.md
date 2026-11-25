---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
amends: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0109-paid-eval-runs-need-cost-cap-and-preflight.md"
superseded_by: ""
date: "2026-11-11"
covers: "apps/agent-service/src/production-decision-ledger.ts, apps/agent-service/src/production-run-memory.ts, apps/agent-service/src/service-main.ts, apps/agent-service/test/production-model-composition.unit.test.ts, packages/memory-engine/src/hybrid-memory-provider.ts, packages/persistence-sqlite/src/sqlite-model-budget-operations.ts, test/integration/decision-ledger.test.ts, test/integration/production-http-composition-process.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0223：聊天找记忆时嵌入失败，退回关键词和实体，不让整轮失败

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
3. 聊天路径整轮失败的直接原因在 `apps/agent-service/src/production-run-memory.ts`：检索层已经降级、拿到了关键词结果，这一层仍按记下的失败抛出 `CONTEXT_MEMORY_UNAVAILABLE` / `CONTEXT_MEMORY_QUOTA_EXCEEDED`，`run-coordinator.ts` 把它记为整轮失败（提交 e7d735cc 引入）。
4. 同一文件里，运行内的嵌入请求（聊天每轮找记忆，以及模型调用的回忆工具，两者都在运行的作用域里）开始之后失败，记成“结果未知”（`markUnknown("transport_unresolved")`），整轮的预算账户随之变成 `reconcile_required`（`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts` 的 `markUnknownWithinTransaction`）。提交 030f81f5 的说明说这会让同一次执行里接下来的对话模型调用被拒；实测不是这样：只删掉抛错、保留“结果未知”时，`[P3-2]` 用例里这一轮照样完成。真正受影响的是这次运行之后要重新领取执行权的时候：`sqlite-run-dispatch-operations.ts` 的 `assertRunBudgetDispatchable` 和待领取运行的查询都跳过账户为 `reconcile_required` 的运行，所以这一轮如果之后要等主人批准、或有排队的工具批次、或进程重启后要恢复，就再也领不到执行权，停在半路。
5. 同一文件里已有按预估上限记账的先例：Gmail 检查路径的 `markUnknown` 把预估费用记进本次检查；嵌入 3 秒没回、重发之前，第一次请求按预估上限结清（[ADR 0119](0119-conversation-speed-prewarm-on-tool-call-and-embedding-retry.md)）。

<a id="decision"></a>

## 决定

1. **聊天路径不再自己抛错。**`production-run-memory.ts` 的 `search` 直接返回检索层的结果。嵌入失败时，检索层退回关键词和实体，并写一条检索降级的决策记录，和 Gmail 检查、回忆工具一样。
2. **运行内的嵌入请求（聊天每轮找记忆和回忆工具）开始之后失败，按预估上限结清，不再标成“结果未知”。**“开始之后”指已经在预算里登记开始（`markStarted`），请求不一定真的离开了本机。预估上限是嵌入输入的上限 16384（代码按 UTF-8 字节限制输入，结清时按 16384 个输入 token 记，token 数不会超过字节数，所以只会偏多）乘以嵌入模型的输入单价，金额很小。这样预算账户保持 `active`，这一轮之后等批准、跑排队的工具或重启恢复时都能重新领取执行权。传了取消信号且运行已被取消时（目前只有每轮找记忆这条路径传了），仍记“结果未知”，和原来一样；回忆工具没有传取消信号，取消时也按预估结清。结清本身失败时（例如磁盘余量不足、主人或 Agent 的授权已经变了），先写一行 `memory.embedding_settle_failed` 日志，再试着改记“结果未知”；改记也失败时再写一行 `memory.embedding_unknown_failed` 日志（取消时和投影路径直接改记“结果未知”，失败时同样写这行日志）。不论哪种，向上抛出的都是原来的嵌入错误。改记“结果未知”成功时，预算账户会变成 `reconcile_required`，这一轮之后同样领不到执行权，要人工核对；只有记账本身出错时才会走到这一步，这时库里的账本来就需要核对。
3. **删掉因此用不到的代码：**`CONTEXT_MEMORY_UNAVAILABLE`、`CONTEXT_MEMORY_QUOTA_EXCEEDED` 两个失败码、`RunCoordinator` 里处理它们的分支、执行记录里的映射，以及网页上“查找相关记忆时连接模型服务失败”的三语文案。旧对话里留下的这两个失败码，网页按通用的失败说明显示（Andy 2026-11-09 定：做方案不用顾及旧数据兼容）。
4. **保留的：**嵌入请求本身出错（发送失败、网关返回错误、响应不合格）时仍写一行 `memory.embedding_failed` 诊断日志，带 HTTP 状态、网关错误类型和原文，`failure` 字段写 `quota_exceeded` 或 `unavailable`；收到响应之后才发现截止时间已过、执行权已失效这类情况不写这行日志，和原来一样。额度被拒仍能从日志看出来，不会被说成网络问题。

这条决定部分取代 [ADR 0109](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0109-paid-eval-runs-need-cost-cap-and-preflight.md) 决定 4 里嵌入的那一部分。对话模型自己返回 402 时的 `PI_MODEL_QUOTA_EXCEEDED` 不变。

依据的原则：产品愿景里的“记忆可靠性”和“主动性与效率”之间，这里没有冲突：记忆照样能找到（关键词和实体），只是少了按意思找的那一路；整轮失败对主人没有任何好处。

<a id="options"></a>

## 放弃的做法

- **只删掉抛错那几行。**这一轮能完成，但预算账户停在 `reconcile_required`：这一轮之后只要要重新领取执行权（等批准、排队的工具批次、重启恢复）就领不到，运行会停在半路。
- **把嵌入调用放到单独的预算账户，“结果未知”不影响对话模型。**能保留“未知”状态，但要改预算表的账户结构和核对流程，范围远大于这次的问题；嵌入的单次金额很小，按上限记账多记的钱可以忽略。
- **聊天时额度被拒仍整轮失败，只有断网才降级。**额度被拒时关键词和实体照样能找到记忆，整轮失败只会让主人看到一个他当场做不了什么的错误；额度问题由日志和 Vercel 的预算通知告诉 Andy。

<a id="consequences"></a>

## 后果

- 嵌入失败时，聊天照常回答，回答里能用上关键词或实体找到的记忆；按意思才能找到的记忆这一轮找不到。
- 决策记录里会多出“记忆搜索没生效”的行，Andy 可以在网页上看到并评价。
- 嵌入请求失败、结果不明时，按预估上限记账，可能比实际多记一点钱。
- 网页不再有“查找相关记忆时连接模型服务失败”这条说明。
- 已知没有处理的：检索层对任何嵌入错误（包括运行被取消引起的）都会写一条检索降级记录，取消时这条记录不准确。这是改动前就有的行为，要修得把取消信号传进检索层，和并行进行的 P3-1（本机向量模型）改的是同一处，留给后续。
- 记账本身出错（结清失败）时，这一轮的预算账户仍会变成 `reconcile_required`，之后领不到执行权，要人工核对；两步记账都失败时，这次嵌入的预算记录停在“已开始”，只留两行日志。
- 记忆组装的 `onVectorFailure` 改为必填，生产代码、测试和测试替身都必须显式接上，类型检查会拦住漏接。

<a id="verification"></a>

## 验证

- `test/integration/production-http-composition-process.test.ts` 的 `[P3-2]` 用例：真实安装的服务，先让它记住一条记忆，再在断网、网关不报费用、402 额度被拒三种情况下发一轮问题。每种情况都验证：这一轮完成；发给对话模型的请求里带着关键词找到的那条记忆；恰好一条检索降级的决策记录；嵌入调用已结清、预算账户为 `active`。反向：嵌入正常的第一轮没有检索降级记录；用改动前的代码跑，三条都因这一轮失败而不过；只删抛错、保留“结果未知”时，三条都因嵌入调用停在 `unknown` 而不过。
- `apps/agent-service/test/production-model-composition.unit.test.ts`：运行内嵌入失败按预估结清，投影路径和取消仍记“结果未知”，结清失败时改记“结果未知”并抛出原来的嵌入错误。
- `test/integration/decision-ledger.test.ts` 已有“嵌入失败写一行、正常时不写”的用例，这次不改。
