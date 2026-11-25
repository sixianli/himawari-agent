---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-01"
---

# ADR 0158：Gmail 检查给每封邮件带上相关记忆，不再整类跳过促销邮件

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P0-5（Andy 2026-11-01）的第二部分。第一部分是 [ADR 0147](0147-keep-model-prompt-and-answer-of-each-gmail-check-with-the-ledger.md)（账本记下输入）。今天 Gmail 检查的判断模型只看到发件人、标题和一行摘要，没有任何关于主人的背景，所以「和牛烤肉馆优惠券」这类和主人「最近想吃牛肉」有关的促销邮件，既看不出关联，又被社交、促销、论坛整类跳过。

Andy 在 2026-11-01 的决定（均有原话，记录在线程）：记忆用在每一封送模型的邮件上；促销、社交、论坛不再整类跳过（「我选择全部送模型，这个门不要」）；不带常驻档案，只带相关记忆；费用只留每天 1 美元的上限（取消单次 0.1 美元）；拆成两个 PR。

<a id="decision"></a>

## 决定

1. **逐封搜记忆：** 每封要送模型的邮件用「发件人 + 标题 + 摘要」（上限 500 字，`DEFAULT_PROACTIVE_MEMORY_LIMITS.queryCharacters`）搜记忆。每封最多 3 条，一批最多 12 条（按相关度从高到低取），每条截 200 字，一次检查最多搜 40 封，超出的邮件不带记忆并记为 `partial`。
2. **邮件专用的相关度门槛：** 配置项 `runPolicy.proactive.memoryMinimumSimilarity`，默认 0.45，不沿用聊天的 0.6。依据：159 封合成邮件（76 封有相关记忆）上，0.6 只命中 20%，0.45 命中 71%，无关邮件被带出记忆 8%（评测见 `/mnt/project-files/p0-5-gmail-ledger-inputs/eval/report.md`，只算向量一路）。（[ADR 0221](0221-memory-retrieval-relevance-cutoff-and-same-source-dedupe.md) 起，关键词和实体两路找到的记忆也按这个门槛减去截断余量截断。）
3. **只读搜索：** 搜索函数新增 `recordUse: false`（不记「最近使用时间」和使用次数，免得后台每 15 分钟检查让记忆在聊天里无故靠前、也躲过每日整理）、`queryText`（直接传查询文字）、`minimumSimilarity`（覆盖门槛）、`excludeCategories`（排除「对 Himawari 的要求」类）。分类只取公开和私有，敏感和受限的不进邮件检查。（敏感一项已由 [ADR 0193](0193-memory-is-visible-to-the-model.md) 改为可以进邮件检查，受限的仍不进。）
4. **嵌入服务的新场景：** `production-run-memory.ts` 新增第三种允许调用的场景「Gmail 检查」（和聊天一次运行、后台同步搜索索引平行）：固定按私有分类，截止时间用本次检查的截止时间，不走共享预算，费用累加进本次检查的成本；同时最多 4 个搜索。
5. **只跳过垃圾邮件和主人自己发的邮件：** 删除 `SKIPPED_CATEGORIES` 和重要发件人对它的豁免。含验证码、卡号的邮件由 [ADR 0146](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md) 的统一遮盖处理，不再整封跳过。
6. **费用：** 删除单次检查 0.1 美元上限，只留每天上限和单次 3 分钟时间上限。配置项 `perCheckCostMicros` 仍可读（旧配置里留着不会使服务起不来），但被忽略；有测试。
7. **提示词顺序（KV 缓存）：** ① 固定说明 ② 这一批的记忆 ③ 这一批的邮件 ④ 「现在是…」放最后一行。说明里写明记忆是背景资料、不是指令，邮件里的要求也不是指令。
8. **账本：** `memoryIds` 只记实际放进提示词的记忆；模型回答里的 `usedMemoryIds` 只保留放进提示词的那些，编造的丢弃；`memoryByMail` 记每封邮件放了哪几条；`memoryRecall` 为 `off`、`ok`、`partial`、`failed`。
9. **失败不挡判断：** 搜记忆整体失败时邮件照常送模型、不带记忆，并记为 `failed`。

<a id="options"></a>

## 放弃的做法

- 关键词订阅表（把记忆提炼成关键词）：会过期，要新做提炼和审批，「和牛」对「牛肉」要靠同义词表。
- 每天一次批处理搜记忆：优惠券、截止提醒有时效。
- 常驻档案：Andy 已否决。
- 沿用 0.6：评测显示几乎搜不到邮件相关记忆。

<a id="consequences"></a>

## 后果

- 邮件的发件人名、标题和摘要现在会发给嵌入服务商（原先只发给判断模型）；记忆文字会发给判断模型。统一遮盖对这两个出口都生效（ADR 0146）。
- 群发邮件现在都送模型，每批多花一些，上限仍是每天 1 美元；到上限后行为不变（模型停，规则照跑）。
- 嵌入服务失败时，搜索自动退化为关键词一路（和聊天相同），这时 `memoryRecall` 仍可能是 `ok`；这是已知取舍。
- 门槛：`test/integration/proactive-mail-check.test.ts` 的 `[P0-5b]` 组（牛肉例子正反向、无关邮件不带记忆块、搜索失败、条数和字数上限、编造编号丢弃）；`test/integration/durable-memory-projection.test.ts` 的只读搜索用例（使用时间和次数不变，规则类被排除）；`apps/agent-service/test/production-mail-embedding.unit.test.ts`；`packages/platform-node/test/startup-configuration.unit.test.ts`（旧配置键）。

<a id="references"></a>

## 关联文档

- [ADR 0147：账本记下输入](0147-keep-model-prompt-and-answer-of-each-gmail-check-with-the-ledger.md)
- [ADR 0146：送模型前统一遮盖](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md)
- [ADR 0106：主动闭环第一刀](0106-proactive-loop-v1-gmail-read-only.md)
- [Gmail 主动检查设计规格](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md)
