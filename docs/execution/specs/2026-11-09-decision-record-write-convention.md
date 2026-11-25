---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-11-09"
---

# 决策记录写入约定

**审阅状态：已批准。** 2026-11-09，Andy 同意任务块 P1-3 的整合方案，本约定是其中一页。

<a id="contents"></a>

## 阅读导航

- [这份约定管什么](#scope)
- [必须写的字段](#fields)
- [写法规则](#rules)
- [缺项怎么显示](#missing)

<a id="scope"></a>

## 这份约定管什么

决策记录是表 `decision_ledger` 的一行，种类有 `proactive`、`memory_candidate`、`consolidation`、`context_truncation`、`retrieval_degrade`、`external_read`、`rule_review`（硬规则因来源记忆变了而待重审，由数据库触发器写，见 [ADR 0211](../../adr/0211-hard-rule-points-back-to-its-rule-memory.md)；自动核对的结果和 Andy 在待重审清单上的选择由 `sqlite-correction-review-operations.ts` 写，见 [ADR 0232](../../adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md)）、`memory_review`（改了记忆后标出推出来的记忆、Andy 在清单上的处理和他指出的漏标，同样由 `sqlite-correction-review-operations.ts` 经 `insertLedgerRow` 写，只落 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds` 四个键，见 ADR 0232）、`web_push`（一条推送被主人的“静默延后”规则延后，结果固定为 `deferred`，见 [ADR 0244](../../adr/0244-hard-rules-step4-unified-push-gate.md)）。控制中心的“依据”抽屉（[ADR 0195](../../adr/0195-show-the-whole-chain-of-one-decision-record.md)）只读这些行，所以写入方写什么，Andy 就只能看到什么。新增写入决策记录的代码，必须照下面写。

<a id="fields"></a>

## 必须写的字段

`DecisionInputs`（`packages/application/src/ports/decision-ledger.ts`）有两条写入路径，落盘的字段不同：

- **系统主动提醒的检查**（`kind` 为 `proactive`，`sqlite-proactive-operations.ts` 的写入路径）：落盘完整字段，除下表的字段外还有 `memoryInjected`、`relatedStats`、`relatedFailedSteps` 等；下表只列抽屉会读的字段。
- **其他种类**（`memory_candidate`、`consolidation`、`context_truncation`、`retrieval_degrade`、`external_read`，经 `DecisionLedgerPort.append`，`sqlite-decision-ledger-operations.ts` 的 `insertLedgerRow`）：目前只落 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds` 四个键（没提供 `batchId`、`resultMemoryIds` 时也会写默认值，所以这四个键永远在；`rule_review` 的“待重审”记录由迁移 0095 的触发器直接写表（迁移 0087 的两个旧触发器已删），也写这四个键，`ruleIds` 是待重审的规则编号，`memoryIds` 是来源记忆；`web_push` 由出站表的延后操作和出站表更新放在同一个事务里写，`ruleIds` 是让它延后的规则“规则 id@修订号”，`memoryIds` 为空，`subject_ref` 是推送的来源键，决策记录的编号由主人、实例、来源键和延后到的时刻算出，同一次延后只会有一条；延后到几点不进记录，只在出站表里，主人收到推送后这条记录就是“当时被拦过”的证据），其余字段在入库前被丢掉。例外有两个：`external_read` 可以多带下表的 summary 六项（见 [ADR 0219](../../adr/0291-external-agents-and-the-memory-hub.md) 决定 7，六项一起写或一起不写，别的种类带了就拒绝，`insertLedgerRow` 自己也拒绝）；`context_truncation` 可以多带一个 `profileBudget`（`{limit, used, pinned}`，档案块的字数上限、实际用掉的字数、置顶条目占的字数，只在档案块放不下时写，见 [ADR 0214](../../adr/0214-record-profile-truncation-and-keep-pinned-memories.md)）。档案块的截断记录不走 `append`，走 `DecisionLedgerPort.appendIfChanged`：同一主人最近一条同类原因码的记录，原因码相同、编号集合也相同时就不写。要让这些种类也记下别的字段，先改 `insertLedgerRow` 和它的校验，再改这份约定。

| 字段 | 谁写 | 含义 |
| --- | --- | --- |
| `ruleIds` | `proactive` 写真正起了作用的规则，格式是“规则 id@修订号”（[ADR 0215](../../adr/0215-decision-record-points-at-the-rule-version.md)），只有底线命中的规则不在这次检查的规则手册里时才写裸 id，抽屉对它显示“这一版的规则内容查不到”；`rule_review` 只写规则 id，抽屉显示当前版本；`memory_candidate` 写空数组，丢弃原因只放 `reasonCode`；其他种类写空数组，抽屉显示“这类记录不涉及” | 规则 id 必须是规则手册里的 id |
| `floorHits` | `proactive` | 每封邮件命中的规则编号 |
| `memoryIds` | 所有种类 | 实际放进上下文或被这次判断用到的记忆编号，不得只写数量；`context_truncation` 例外，写的是这一轮没带上的记忆编号 |
| `memoryByMail`、`usedMemoryIds`、`tentativeMemoryIds` | `proactive` | 每封邮件对应的记忆、模型实际用到的记忆、待确认的记忆；其他种类现在没有这三个键，所以不会显示“模型用到了” |
| `memoryRecall` | `proactive` | 找记忆的状态：`off`、`ok`、`partial`、`failed` |
| `sourceIds`、`relatedByMail`、`relatedRead` | `proactive` | 判断了哪些邮件、关联了哪些邮件、读关联邮件是否完整 |
| `summaryInjected`、`summaryIds`、`summaryDays`、`summaryCharacters`、`summaryRead`、`summaryGenerated` | `proactive` 只在 Gmail 检查接上了对话日摘要读取时写；`external_read` 只在外部读取的 `today_context` 或 `start_here`（它的 today 段同样读摘要）接上了摘要读取时写，`summaryGenerated` 固定为 0，抽屉不显示这六项（依据链只给 Gmail 检查列 `mails.summaries`），只在记录的输入字段里能查到。六项一起写或一起不写 | 是否真的把最近两天的对话日摘要发给了模型、发了哪些段、哪几天、多少字、读取状态（`off`、`ok`、`partial`、`failed`）、这次补生成了几段（[ADR 0216](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/docs/adr/0216-gmail-check-reads-recent-day-summaries.md)） |

<a id="rules"></a>

## 写法规则

1. 写的是当时真正用到的东西，不得事后补写或按现在的状态重算。
2. 只写编号，不写记忆正文、邮件正文：正文从记忆表按现在的状态读，受限（模型也看不到的那档）记忆由读取端隐藏。
3. 规则只写规则手册里的 id 和当时的修订号（用 `ruleRef` 生成），抽屉按修订号去规则手册查那一版的内容、出处和例子；不在规则手册里的编号只会显示“未登记的规则”。不得把原因代码写进 `ruleIds`。
4. 系统主动提醒的检查：字段没有这回事就不写这个键，不要写空数组冒充“检查过、没有”，读取端靠键是否存在区分“这次没有”和“无记录”。其他种类经 `append`，四个键永远在，抽屉只对 `memoryIds` 显示“这次没有”或列表。
5. 改写入方时同时补测试：读取端的 `test/integration/decision-chain.test.ts` 必须能列出新字段。

<a id="missing"></a>

## 缺项怎么显示

| 状态 | 抽屉显示 |
| --- | --- |
| 键存在且为空 | 这次没有 |
| 键不存在（老记录或写入方没写） | 无记录 |
| 这类记录不涉及（例如整理记忆没有规则） | 这类记录不涉及 |
| 记忆已被删除 | 这条记忆已不存在 |
| 记忆是受限档的 | 受限记忆，模型也看不到，内容不在这里显示 |
