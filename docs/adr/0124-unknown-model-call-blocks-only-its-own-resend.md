---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0076-no-model-cost-budget-limits.md"
date: "2026-10-30"
covers: "packages/persistence-sqlite/src/sqlite-model-budget-operations.ts, scripts/delivery-mode/browser-acceptance-gate.py, test/integration/durable-memory-projection.test.ts, test/integration/product-path-browser.test.ts, test/integration/sqlite-model-budget-operations.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0124：结果不确定的模型调用只挡它自己的重发，不再挡同一轮的其他调用

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [与 ADR 0076 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

预算账本（`model_budget_accounts` 按一轮对话记一个账户，`model_budget_allocations` 按每次模型调用记一笔）里，一次调用发出后结果不确定（例如连接中断、不知道服务方收没收费），这笔记为 `unknown`，整个账户随之变成“待对账”（`reconcile_required`）。改前，账户处于“待对账”时，预算账本拒绝这一轮里任何新的预留和开始（`PORT_CONFLICT`：`Budget account is not available for a new allocation`）。

[事故 I-37](../incidents-and-gates.md#incidents) 说明了这把锁的代价：找记忆的向量请求出了一次不确定，同一轮的主对话也被拒，用户看到“本轮执行失败”。[ADR 0123](0123-cut-off-embedding-attempt-charged-at-its-ceiling.md) 只修了“被自己 3 秒掐断的向量请求”这一种情况；其他原因造成的不确定，仍然会挡住整轮。

这把锁的由来：迁移 0022 建预算账本时有费用上限，花费不确定就无法判断是否超限，所以锁住整个账户。[ADR 0076 第 3 条](0076-no-model-cost-budget-limits.md#decision)取消了上限，但保留了锁，理由改为“阻止同一调用被重复发出”。这件事调用记录（`model_invocation_identities`，按调用位置 `logicalSlot` 各记一条）已经在做：同一调用位置上有没结清的记录，再申请就返回“先对账”（`replay`），不会再发出去。锁整个账户比需要的范围大。Andy 在 2026-10-30 定了“改只挡同一次”。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

2026-10-30 实际打开的一手资料：

- Stripe 幂等请求：幂等键（客户端给每个请求起的唯一编号）是“a unique key that the server uses to recognize subsequent retries of the same request”，同一个键的重试返回第一次保存的结果；防重复是按每个请求的键做的，不会因为一个请求出错就拒绝同一账户的其他请求。https://docs.stripe.com/api/idempotent_requests
- Temporal（开源的工作流引擎）活动定义：建议用“a combination of the Workflow Run ID and the Activity ID as an idempotency key”，因为它“guaranteed to be consistent across retry attempts but unique among Workflow Executions”。也就是说，防重复的单位是“这一轮里的这一个步骤”，不是整轮。https://docs.temporal.io/activity-definition
- LiteLLM（开源模型网关）v1.106.2 发布说明：每次重试“gets its own spend row (`<request_id>-attempt-<n>`)”，账单按每次尝试记，不是按整个请求锁。https://docs.litellm.ai/release_notes/v1.106.2/v1-106-2

共同点：防重复发出按“哪一次调用”来判断；一次调用结果不确定，只影响这一次调用的重发。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **预算账户处于“待对账”时，仍然接受同一轮里其他调用的预留和开始**（`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts` 的 `reserveWithinTransaction`、`markStarted`）。挡重发只靠调用记录：同一调用位置上有 `unknown` 的那一笔，再申请仍然返回 `replay`。
2. **账户状态不因新的预留而回到 `active`。** 只要还有一笔 `unknown` 没对账，账户就保持“待对账”，对账程序和日志照样能看到它。
3. **保留整轮级别的两处门禁。** 账户“待对账”时，这一轮不会被重新派发（run dispatch），后台任务的这一次也不会被恢复重跑（`reserveOccurrenceWithinTransaction`）。原因：重新派发或恢复会把整轮从头再跑一遍，里面就包括那次不确定的调用，属于“同一次重发”，按 Andy 的决定仍要挡。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0076 的关系

本 ADR 修改 [ADR 0076 第 3 条](0076-no-model-cost-budget-limits.md#decision)中“结果未知时账户仍置为 `reconcile_required`，阻止同一调用被重复发出”的做法：账户照样置为“待对账”，但不再因此拒绝同一轮里其他调用；阻止同一调用重发改由调用记录按调用位置完成。ADR 0076 其他决定（不设费用上限、保留账本记账、不改数据库结构）不变。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **保持整轮锁住，等对账程序处理完**：最谨慎，但事故 I-37 已经说明，向量请求这种没有副作用的调用出一次不确定，就会让整轮失败；而不确定的那次本身已经被调用记录挡住，不会重发。放弃。
- **整轮的派发和恢复也放开**：放开后，重启或恢复会把不确定的那次调用再发一遍，这正是 Andy 要挡的“同一次”。放弃。
- **按调用的种类分别处理（只放开向量请求）**：要给每种调用定规则，而按调用位置挡重发已经对所有种类都成立，不需要再分。放弃。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 一轮里某次调用结果不确定时，这一轮的其他调用照常进行；那次调用本身不会再发，等对账。
- 账户是“待对账”时仍然可以有新的花费记进来，对账时要按每一笔看，不能只看账户总数。
- 测试（都走真实 SQLite 准入）：`test/integration/sqlite-model-budget-operations.test.ts` 新增“同一调用重发被挡（`replay`）、同一轮其他调用照常结清、账户保持待对账”；`test/integration/durable-memory-projection.test.ts` 改为同时验证同一调用被挡和其他调用可以预留。改前这些用例报 `Budget account is not available for a new allocation`，改后通过。
- 出包走查新增必过场景 `accept-slow-memory-search`（`test/integration/product-path-browser.test.ts`）：让找记忆的向量请求故意晚 3.5 秒返回，主回答必须正常出来、页面不出现“本轮执行失败”、向量请求至少发了 2 次（第一次被掐断，第二次重发）。`scripts/delivery-mode/browser-acceptance-gate.py` 把它列为必过场景，走查结果里缺这一项就不能上线。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0076：模型调用不设费用上限，预算账本只记账](0076-no-model-cost-budget-limits.md)
- [ADR 0123：被 3 秒掐断的向量请求按费用上限记账](0123-cut-off-embedding-attempt-charged-at-its-ceiling.md)
- [事故与门槛清单 I-37](../incidents-and-gates.md#incidents)
- [工程案例库：案例 63](../engineering-casebook.md#case-conversation-speed)

[↑ 返回阅读导航](#contents)
