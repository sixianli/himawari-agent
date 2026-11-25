---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-29"
covers: "test/tooling/jarvis-test-history.test.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0109：花钱的评测要先定费用上限、先做一次网关试探，Vercel 预算按 key 设

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-29 上午（日本时间），“评估把问答切到 Claude 模型”线程想对比 DeepSeek V4.1 Flash、Claude Haiku 5.5、Claude Sonnet 5.5 三个模型，同时跑了三轮 Jarvis Test 真模型评测（[ADR 0103](0103-jarvis-test-live-evaluation-and-two-tier-judge.md)）。每条用例跑 3 次，裁判还要先过校准。开跑前没有报预计费用，也没有等 Andy 同意。

10:58 左右，三轮评测都被 Vercel AI Gateway（Vercel 的模型网关，Himawari 经它调用模型）拒绝，原文是 `User budget exceeded. Current spend: $3.16, limit: $3.00`，HTTP 402。这条“用户预算”按人算：Andy 本人建的所有 API key，花费都记在同一个额度里。11:25 Andy 发现生产对话报“查找相关记忆时，连接模型服务失败”，事故 [I-11](../incidents-and-gates.md#incidents)。

Vercel 文档原文（[Budgets 页 User budgets 一节](https://vercel.com/docs/ai-gateway/observability-and-spend/budgets#user-budgets)）：“A user budget caps how much a single team member can spend, across every API key attributed to that member”。同一页还写明，一个请求要同时通过所有适用的预算，任何一个超了就拒绝。

本次评测实际花了约 1.0 美元：评测期间网关余额从 21.40 降到 20.53 美元，减少 0.88；开跑前的单条试跑另花约 0.15 美元（按记录估算）。用户预算里剩下的 2.1 美元左右，是 10 月 28 日的 4 轮评测（评测记录合计 1.15 美元）和其他调用花的。

<a id="decision"></a>

## 决定

1. **不定费用上限就不开跑。** `npm run eval:jarvis:live` 必须带 `--confirm-cost=<美元>`，否则退出码 2，报 `JARVIS_LIVE_COST_APPROVAL_REQUIRED`，同时打印上一轮完整跑花了多少钱，方便先报预计费用。这个数要先经 Andy 同意。评测过程中，被测模型加裁判的花费一到上限，就不再开始新的调用（和原来的 token 上限并列，记录里写 `costLimitMicros`）。
2. **开跑前先试探一次网关。** 脚本先发一个只要 1 个 token 的请求。网关拒绝时（例如预算已经超了）退出码 2，报 `JARVIS_LIVE_GATEWAY_REFUSED`，并贴出网关原文，不开跑。
3. **Vercel 的预算按 key 设，不按人设（要 Andy 操作）。** 删掉或调高 Andy 的“用户预算”。给评测 key 单独设上限（例如每月 3 美元），生产 key 不设上限或设宽一些。这样评测花超了只拦住评测 key，不会再影响生产。Vercel 文档也建议这样给实验用的 key 设上限：“To bound spend in time as well as amount, pair the budget with an expiration … this is how you cap a contractor or experiment key”。
4. **额度被拒要说清楚。** 生产这次只记下“传输未确认”（`transport_unresolved`）和“记忆不可用”（`CONTEXT_MEMORY_UNAVAILABLE`），网关返回的 402 原文没有保存，页面显示的是“连接模型服务失败”，看上去像网络问题。改为：
   - 向量化（嵌入）请求失败时，服务写一行 `memory.embedding_failed` 诊断日志，带 HTTP 状态、网关错误类型和原文（最多 300 字）。
   - 状态码是 402，或网关错误类型是 `quota_for_entity_exceeded` 时，失败码记为 `CONTEXT_MEMORY_QUOTA_EXCEEDED`。对话模型返回 402 时，失败码记为 `PI_MODEL_QUOTA_EXCEEDED`。
   - 网页用中英日三语说明“模型服务的费用额度已用完，请求被拒绝了，不是网络问题”，不显示错误码。
   - 调用记录表（`model_invocation_identities`）的结构不改，要改得加数据库迁移，这次不做，以日志为准。
   - 后续：嵌入部分（第二、三小条里的 `CONTEXT_MEMORY_QUOTA_EXCEEDED` 和网页说明）已被 [ADR 0223](0223-chat-memory-lookup-falls-back-to-keywords.md) 取代：聊天时嵌入失败不再让整轮失败，改为按关键词和实体继续找记忆，并写一条检索降级的决策记录；`memory.embedding_failed` 日志照旧。对话模型的 `PI_MODEL_QUOTA_EXCEEDED` 不变。本条原文不改。
5. **评测不换被测模型。** 线程早先加过把被测模型换成 Claude 的开关（`--subject`），已从 PR #95 删掉：Andy 在 2026-10-29 13:31（日本时间）定下任何场景都不调用 Claude、OpenAI 等贵模型，代码和评测脚本不写死这类模型名。真模型评测只测生产用的 DeepSeek V4.1 Flash。

<a id="options"></a>

## 比较过的方案

### 只写规则“花钱前先问”

- 好处：不用写代码。
- 代价：[ADR 0107](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0107-every-incident-gets-an-automatic-gate.md) 规定只写文档不算关闭事故；这次本来就有“先报费用”的习惯，照样没做到。

### 开跑前读 Vercel 预算余量

- 好处：能在快到上限时就停，而不是等到超了。
- 代价：读预算要 Vercel 的账户 token，云端线程没有，也不该有。1 个 token 的试探请求只能发现“已经超了”，但它不需要任何新凭据。

### 检查评测用的不是生产 key

- 好处：直觉上能隔开。
- 代价：这次两个 key 本来就不同。出问题的是按人汇总的预算，换 key 也躲不开，真正的修法是第 3 条。

<a id="consequences"></a>

## 后果

- 好处：评测不能在没有费用上限的情况下开跑；预算已经超了的时候也不会再开跑。花费上限由 Andy 同意。
- 代价：每次开跑多一个参数，多一次 1 个 token 的请求（费用小于 0.0001 美元）。
- 没解决的：评测花费仍可能把共用的用户预算推过上限，因为试探只能发现“已经超了”。这要等 Andy 完成第 3 条才算根治，所以 I-11 的状态是“等 Andy”。
- 门槛：`test/tooling/jarvis-test-history.test.mjs` 里的两条测试，在 `npm run check` 里自动运行。在改动前的脚本上，这两条测试都失败（不带参数时脚本直接开始评测；网关返回 402 时脚本照样开跑）。

<a id="references"></a>

## 关联文档

- [ADR 0103：Jarvis Test 的真模型层](0103-jarvis-test-live-evaluation-and-two-tier-judge.md)
- [ADR 0107：每个事故落一道自动检查](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0107-every-incident-gets-an-automatic-gate.md)
- [事故与门槛清单 I-11](../incidents-and-gates.md#incidents)
- [工程案例库案例 48](../engineering-casebook.md#case-eval-budget-outage)

[返回阅读导航](#contents)
