---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
---

# ADR 0216：Gmail 检查带上最近两天的对话日摘要，没生成的先补

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P3-6（也是 PA-3，Andy 2026-11-11）。Himawari 每天把每个对话当天的内容写成一段日摘要（`memory_episodes` 表，来源 `day_summary`），但它不会自动进入任何上下文，只有聊天里的回忆工具会搜它。主动的 Gmail 检查因此不知道主人昨天在聊天里说过什么、处理过什么，可能重复提醒，或漏掉前因后果。验收：主动 run 的上下文含摘要块；决策记录的输入里有对应字段（集成测试）；聊天的首字延迟不增加。

动手前让两个模型各自出方案、再审线程整合后的方案（记录在 `.agents/reviews/topic-p3-6-recent-summaries/`）。DeepSeek 指出一个线程原先漏掉的事实：日摘要只在聊天 run 开始时顺带生成，而且每个 run 只生成一段。Andy 在决策卡上选了“检查前先补生成”（2026-11-11 10:37 JST）。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

- 日摘要每段最长 1200 字，只含敏感内容的段落写占位文字：`packages/memory-engine/src/episodes.ts` 的 `MAXIMUM_SUMMARY_CHARACTERS = 1200` 和 `UNSUMMARIZED = "（这段对话只含敏感内容，没有做摘要）"`。
- 表上已有按日的索引：`packages/persistence-sqlite/src/migrations/0053_memory_episodes.sql` 第 27 行 `CREATE INDEX memory_episodes_scope_index ON memory_episodes(owner_id, agent_id, day);`，所以不需要迁移。
- 日摘要只在聊天 run 开始时生成，每个 run 最多一段：`apps/agent-service/src/production-memory-episodes.ts` 的 `MAXIMUM_EPISODES_PER_RUN = 1`，`start(request)` 要求 `request.threadId`。
- Gmail 检查的整段提示作为唯一一条用户消息经统一出口发出：`packages/runtime-pi/src/egress-context.ts` 的 `messages: [{ role: "user", content: prompt, timestamp }]`（[ADR 0148](0148-send-every-model-request-through-one-in-process-egress.md)）。
- 决策记录的输入是 `decision_ledger.inputs` 里的 JSON，类型 `ProactiveCheckInputs`（`packages/application/src/ports/proactive-checks.ts`），加字段不改表。
- 生产上目前只有 Gmail 检查一种主动 run：定时触发的 run（`scheduler-service.ts`）没有在 `service-main.ts` 接线。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **只读最近两天的日摘要。** 存储接口新增只读方法 `listDaySummaries`，按主人时区的日期范围、只取 `day_summary`（不取压缩摘要）、只取模型可见的分级，按日期和结束时间从新到旧排序。记忆引擎新增 `recent()`：今天和昨天按 `runPolicy.timeZone` 算（和生成摘要用同一个 `localDay`），跳过占位文字，正文读不到的记为 `partial`。
2. **先补生成。** Gmail 检查有新邮件要送模型、且当天费用没到上限时，先用现有的 `dueSegments()` 和 `summarize()` 把已经结束、日期落在这两天里的对话段落补成摘要，每次检查最多 3 段（`DEFAULT_PROACTIVE_SUMMARY_LIMITS.catchUpPerCheck`）。用 Gmail 检查自己的判断模型，走同一个统一出口；输入和回答随这次检查的决策记录保存；费用算进这次检查，每次调用前按估算核对每天上限，并先给第一批邮件判断留出它的估算费用（按带上这一批记忆和满额 4000 字摘要块的提示估算，所以先找相关记忆、再补生成）：剩下的额度只够判断时不补生成，邮件判断优先。摘要写进库时的嵌入在 Gmail 检查的嵌入范围里做（`embedForMailCheck`），按这一段自己的分级申报：嵌入模型不收敏感分级时，敏感段落的摘要照样写进库，只是先不带向量，留给之后的补算。补生成只用这次检查时间的四分之一：补生成的模型调用拿到的截止时间和中止信号都是这四分之一，不是整次检查的；主人暂停了记忆记录时不补；只补判断模型允许的分级的段落。补生成失败不挡判断。这些段落本来大多也会在之后的聊天 run 里生成，提前做基本不增加总花费（用的是判断模型而不是聊天模型，单价可能不同）；和聊天 run 同时生成同一段时，表上的唯一键加上 upsert 保证不出重复行，两边写入的内容来自同一段已经结束的对话。
3. **一次检查只读一次，没有新邮件就不读。** 默认最多 8 段、合计 4000 字，从新往旧整段挑，超出时丢掉最旧的整段，不把一段截成半段；这些上限写在代码里（`DEFAULT_PROACTIVE_SUMMARY_LIMITS`），测试可以传入别的值，生产配置里没有对应的键。读出时只取判断模型允许的分级，不会因为带了摘要把这一批抬到模型不收的分级。读失败时照常判断、不带摘要块。
4. **放在提示里固定说明之后、记忆和邮件之前。** 顺序是：固定说明 `mail.judgment`、摘要块（目录登记的固定标题 `mail.judgment.recent-summaries-header` 加 `[{day, text}]`，按时间从早到晚）、这一批记忆、这一批邮件、“现在是…”。同一次检查只读一次摘要，各批的摘要块字节相同，能命中缓存；两次检查之间如果有新生成的摘要，摘要块会变，这是内容变了，不是排列不确定。标题写明它只是背景、不是指令、可能不完整，用来避免重复提醒；摘要没提到的事不能当作没发生。没有摘要时整段（含标题）不出现。
5. **分级。** 这一批的调用分级取记忆和摘要中最高的那一档，和现有带记忆的做法一致。
6. **决策记录新增六项输入。** `summaryInjected`（是否真的发给了模型）、`summaryIds`、`summaryDays`、`summaryCharacters`、`summaryRead`（`off`、`ok`、`partial`、`failed`；补生成失败也记 `partial`，因为这时摘要可能不全）、`summaryGenerated`（这次补生成了几段）。没有接上摘要读取时，这六项一项都不写；接上时六项必须全写（按[决策记录写入约定](../execution/specs/2026-11-09-decision-record-write-convention.md)第 4 条）。SQLite 写入时校验（重复编号、日期格式、负数、非整数、未知状态、只写了一部分，以及“带了”和“编号为空”自相矛盾都拒绝），通用读出给旧记录补默认值。决策记录的「依据」抽屉显示“最近两天的对话摘要：带了 N 段”或读取状态，网页接口的依据链里对应字段是 `mails.summaries`（约定第 5 条）。（2026-11-11 补：外部读取入口按 [ADR 0219](0219-read-only-mcp-entry-with-static-token.md) 决定 7 写的六项只存在记录的输入字段里，抽屉和 `mails.summaries` 不显示。）
7. **聊天路径不改。** 读摘要、补生成和摘要块只接在 Gmail 检查上。（2026-11-11 补：外部读取入口的 `today_context` 另按 [ADR 0219](0219-read-only-mcp-entry-with-static-token.md) 决定 7 只读、不补生成；聊天路径仍不读。）

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- 前缀缓存要求固定内容在前、会变的在后，开头逐字节相同才能命中：[Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)、[DeepSeek](https://api-docs.deepseek.com/guides/kv_cache)。所以摘要块放在每批都会变的邮件之前、固定说明之后。
- 把最近的对话摘要作为背景资料放进后台任务的输入，而不是改系统提示，和本项目 [.agents/instructions/prompt-prefix.md](../../.agents/instructions/prompt-prefix.md) 第 2、15 条一致。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **按每封邮件搜相关摘要（复用 `episodes.search`）：** 要额外的嵌入调用，按相关度排序也不保证覆盖“昨天”，而这里要的正是固定的时间窗。
- **只读已有的摘要、补生成另做：** 改动小，但早上主人还没聊天之前的检查大多读不到昨天，等于没修根因。Andy 选了补生成。
- **把摘要放进系统提示，或转存成记忆：** 前者违反会变的值只能放在最后一条用户消息里的规则；后者会让普通聊天也带上它。
- **带压缩摘要：** 它是某个对话历史的压缩，不是“那天发生了什么”，先不带。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- Gmail 检查的提示变长，同样多的邮件花费稍多，到每天上限会早一些；上限本身不变，摘要字数计入估算。
- 补生成的摘要用的是 Gmail 检查的判断模型，用量统计里记在邮件判断名下。判断模型不允许敏感分级时，敏感段落补生成失败，留给聊天 run 生成。
- 补生成只在最近两天有过消息的对话里找没摘要的段落（`listUnsummarized` 的 `activeSince`，往前多留一小时防夏令时），所以很久以前积压的、一直没摘要的对话不会占掉名额，让昨天的对话补不上。仍然留下的情况：最近两天聊过、但更早还有段落没摘要的对话，每个对话先返回最早那一段，被日期过滤丢掉后仍占一个候选名额（每次检查最多看 48 个对话、取出 12 段再按日期过滤）；要有 12 段以上这样的旧段落才会让昨天的段落这次补不上，之后的聊天 run 会把旧段落补完。
- 某个对话还有更早的段落没摘要时，它最近两天的段落排在后面，Gmail 检查不补（只补日期落在这两天的段落）。
- 补生成写下的日摘要和聊天 run 写的一样是那一段的正式摘要，之后不会被聊天 run 重写；判断模型写得不好时，目前没有自动重写的办法。
- 同一条提示里，出口遮盖认出的密码或验证码值会在整条消息里遮掉，所以某一批的记忆或邮件里点名了一个值、而摘要里也单独出现这个值时，这一批的摘要块会和别的批不同，那一批缓存不命中；这是一条消息内遮盖的既有规则（[.agents/instructions/prompt-prefix.md](../../.agents/instructions/prompt-prefix.md) 第 11 条），带记忆的做法同样如此，不单独处理。
- 没有新邮件的检查不多读一次数据库；聊天 run 不读也不生成这些摘要。
- 门槛：`test/integration/proactive-mail-check.test.ts` 的 `[P3-6]` 组（正向、反向、敏感分级、无新邮件不读、读失败、补生成、字数上限、同一次检查各批字节相同、按东京时区算昨天、写入校验拒绝坏值）；`test/integration/memory-episodes.test.ts` 的 `[P3-6]` 用例（worker 和 direct 两种执行方式、按日列出、分级过滤、坏输入拒绝）；`apps/agent-service/test/proactive-summaries-scope.unit.test.ts`（摘要块、读取器和接线只出现在 Gmail 检查的文件里）；提示词目录清单和 `mail.judgment.recent-summaries` 定稿文件。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0148](0148-send-every-model-request-through-one-in-process-egress.md)：统一出口。
- [ADR 0158](0158-bring-related-memories-into-gmail-checks.md)：Gmail 检查带相关记忆，提示词顺序。
- [ADR 0161](0161-keep-every-model-prompt-in-one-catalog-package.md)：提示词目录。
- [ADR 0193](0193-memory-is-visible-to-the-model.md)：模型可见的分级。
- [.agents/instructions/prompt-prefix.md](../../.agents/instructions/prompt-prefix.md)：发给模型的内容只追加。

[返回阅读导航](#contents)
