---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0119-conversation-speed-prewarm-on-tool-call-and-embedding-retry.md"
date: "2026-10-30"
covers: "apps/agent-service/src/production-run-memory.ts, packages/runtime-pi/src/pi-runtime-adapter.ts, packages/runtime-pi/test/model-accounting.unit.test.ts, test/integration/sqlite-model-budget-operations.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0123：找记忆时被 3 秒掐断的那次向量请求按费用上限记账，重发用新的调用编号

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [与 ADR 0119 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

第二十版和第二十一版验收时出现了 3 次“本轮执行失败”（Mac 线程解密的错误字段：`Model invocation admission failed`，Magpie 没收到主对话请求），每次都发生在找记忆的向量请求第一次 3 秒超时、自动重发（`memory.embedding_retried`）之后。

根因（真实 SQLite 测试复现，见[事故清单 I-37](../incidents-and-gates.md#incidents)）：

1. [ADR 0119 第 2 条](0119-conversation-speed-prewarm-on-tool-call-and-embedding-retry.md#decision)把被掐断的那次请求记为“结果不确定”（`markUnknown`）。预算记账会因此把这一轮的预算账户（`model_budget_accounts`，按轮记账）标成“待对账”（`reconcile_required`）。
2. 重发用的是同一个调用位置（`logicalSlot`）。调用记录（`model_invocation_identities`）看到同一位置上有一条没结清的记录，就要求先对账（`replay`），重发直接失败（`EMBEDDING_RESULT_REQUIRES_RECONCILIATION`）。所以 #116 的“重发一次”在生产上从未成功过。
3. 主对话随后申请模型调用，预算账户已是“待对账”，拒绝新的预留（`PORT_CONFLICT`：`Budget account is not available for a new allocation`）。Pi 运行适配器（`packages/runtime-pi/src/pi-runtime-adapter.ts`）把这个异常吞掉，只返回“准入失败”，日志里没有原因。

#116 的单元测试用的是总是放行的假准入，所以没测出来。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

2026-10-30 实际打开的一手资料：

- LiteLLM（开源模型网关）v1.106.2 发布说明：请求到达模型服务后超时的，“Its spend row now prices the estimated prompt tokens at the input rate and deducts that from key, team and user budgets”；从未到达的连接超时记 0 元；重试时每一次“gets its own spend row (`<request_id>-attempt-<n>`)”。https://docs.litellm.ai/release_notes/v1.106.2/v1-106-2
- OpenAI Agents SDK（模型调用的重试设置）：超时“covers the complete attempt”，超时的那次会被取消，“Each permitted retry receives a new per-attempt timeout”；但凡重放不安全（输出已经开始、带会话状态的请求）就不重试，“fail closed when replay safety is unknown”。https://openai.github.io/openai-agents-python/models/
- Stripe 幂等请求：同一个幂等键的重试返回第一次保存的结果；要发新请求就用新键。https://docs.stripe.com/api/idempotent_requests

共同点：被自己掐断的请求，按可能花掉的上限记账，不让它卡住后面的事；每次重试是一条独立的记录；只有重放可能产生副作用时才停下来等人对账。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **找记忆时被 3 秒掐断的那次向量请求，按费用上限结清。** 只限这一种情况：我们自己的 3 秒计时到点而取消（`EMBEDDING_ATTEMPT_TIMED_OUT`）。这时按 16384 个输入 token（向量请求输入最多 16384 字节，token 数不会更多）乘以输入单价结清，和预留时的估算相同（`apps/agent-service/src/production-run-memory.ts`）。向量请求只读，没有副作用，多记的是上限，预算不会少算。其他原因中断的请求照旧记为“结果不确定”，等对账。
2. **重发用新的调用位置。** 第二次的调用位置是 `<原位置>:attempt:2`，在调用记录和预算里各是一条独立的记录，和 LiteLLM 的 `attempt-<n>` 一样。
3. **准入失败写日志。** Pi 运行适配器把准入时抛出的错误码（例如 `PORT_CONFLICT`）和端口错误的固定说明交给服务，服务写诊断 `model.admission_failed`（带 `runId`、`code`、`reason`），不再只有“本轮执行失败”。只记错误码和端口错误的固定说明文字，不记用户内容。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0119 的关系

本 ADR 修改 [ADR 0119 第 2 条](0119-conversation-speed-prewarm-on-tool-call-and-embedding-retry.md#decision)中“超时就把这次记为‘结果不确定’”和“用新的调用序号（`ordinal` 2）重新登记”：改为按上限结清，并用新的调用位置。3 秒的时限、只重发一次、后台记忆整理不重发，这几点不变。2026-11-26 起，每轮回答前自动找记忆这条路径超时后不再重发，直接改用关键词和实体（见 [ADR 0119 后续](0119-conversation-speed-prewarm-on-tool-call-and-embedding-retry.md#follow-up)）；本条的按上限结清对它照样适用，新调用位置只用于回忆工具等仍会重发的路径。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **准入不计向量请求，或给向量请求单独开预算账户**：能让主对话不受影响，但重发本身仍然会被同一位置上没结清的记录挡住；单独账户还要改表结构。放弃。
- **超时那次按 0 元结清**：LiteLLM 的做法说明，请求已经到达模型服务后超时，服务方照样会收费，记 0 会少算。放弃。
- **保持“待对账”，等后台对账程序处理完再继续**：符合最谨慎的做法，但这一轮主对话就只能失败，而向量请求没有副作用，不需要等。放弃。
- **从网关查回实际费用再结清**：最准，但要等网关的账单接口返回，3 秒掐断本来就是为了不等。可以以后作为对账时的补充，现在不做。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 每次重发多记的费用最多是一次向量请求的上限，即预留时的估算（16384 × 输入单价）；按测试配置的单价（每 token 0.01 微美元）约 164 微美元，也就是 0.000164 美元。生产上实际是多少，取决于配置里的单价。
- 主对话、标题、记忆整理等真正可能有副作用或输出已经开始的调用，仍然按原规则记“结果不确定”。
- 测试：`test/integration/sqlite-model-budget-operations.test.ts` 用真实 SQLite 准入复现“回忆工具的第一次超时 → 重发 → 主对话申请调用”，改前重发失败、主对话被拒，改后都通过；`packages/runtime-pi/test/model-accounting.unit.test.ts` 验证准入失败的错误码会交给服务。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0119：工具调用时预热沙箱、找记忆 3 秒重发](0119-conversation-speed-prewarm-on-tool-call-and-embedding-retry.md)
- [事故与门槛清单 I-37](../incidents-and-gates.md)
- [工程案例库：案例 63](../engineering-casebook.md#case-conversation-speed)
- PR #128

[↑ 返回阅读导航](#contents)
