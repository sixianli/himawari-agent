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

决策记录是表 `decision_ledger` 的一行，种类有 `proactive`、`memory_candidate`、`consolidation`、`context_truncation`、`retrieval_degrade`、`external_read`。控制中心的“依据”抽屉（[ADR 0193](../../adr/0193-show-the-whole-chain-of-one-decision-record.md)）只读这些行，所以写入方写什么，Andy 就只能看到什么。新增写入决策记录的代码，必须照下面写。

<a id="fields"></a>

## 必须写的字段

`DecisionInputs`（`packages/application/src/ports/decision-ledger.ts`）有两条写入路径，落盘的字段不同：

- **系统主动提醒的检查**（`kind` 为 `proactive`，`sqlite-proactive-operations.ts` 的写入路径）：落盘完整字段，除下表的字段外还有 `memoryInjected`、`relatedStats`、`relatedFailedSteps` 等；下表只列抽屉会读的字段。
- **其他种类**（`memory_candidate`、`consolidation`、`context_truncation`、`retrieval_degrade`、`external_read`，经 `DecisionLedgerPort.append`，`sqlite-decision-ledger-operations.ts` 的 `insertLedgerRow`）：目前只落 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds` 四个键（没提供 `batchId`、`resultMemoryIds` 时也会写默认值，所以这四个键永远在），其余字段在入库前被丢掉。要让这些种类也记下别的字段，先改 `insertLedgerRow` 和它的校验，再改这份约定。

| 字段 | 谁写 | 含义 |
| --- | --- | --- |
| `ruleIds` | `proactive` 写命中的规则编号；其他种类现在有的写原因代码，有的写空数组，抽屉对它们一律显示“这类记录不涉及” | 规则编号必须登记在 `DECISION_RULE_CATALOG` |
| `floorHits` | `proactive` | 每封邮件命中的规则编号 |
| `memoryIds` | 所有种类 | 实际放进上下文或被这次判断用到的记忆编号，不得只写数量 |
| `memoryByMail`、`usedMemoryIds`、`tentativeMemoryIds` | `proactive` | 每封邮件对应的记忆、模型实际用到的记忆、待确认的记忆；其他种类现在没有这三个键，所以不会显示“模型用到了” |
| `memoryRecall` | `proactive` | 找记忆的状态：`off`、`ok`、`partial`、`failed` |
| `sourceIds`、`relatedByMail`、`relatedRead` | `proactive` | 判断了哪些邮件、关联了哪些邮件、读关联邮件是否完整 |

<a id="rules"></a>

## 写法规则

1. 写的是当时真正用到的东西，不得事后补写或按现在的状态重算。
2. 只写编号，不写记忆正文、邮件正文：正文从记忆表按现在的状态读，敏感记忆由读取端隐藏。
3. 新的规则必须先登记到 `DECISION_RULE_CATALOG`（来源：你设定的或内置，以及依据文档），再写进记录；未登记的编号只会显示“未登记的规则”。
4. 主动提醒的检查：字段没有这回事就不写这个键，不要写空数组冒充“检查过、没有”，读取端靠键是否存在区分“这次没有”和“无记录”。其他种类经 `append`，四个键永远在，抽屉只对 `memoryIds` 显示“这次没有”或列表。
5. 改写入方时同时补测试：读取端的 `test/integration/decision-chain.test.ts` 必须能列出新字段。

<a id="missing"></a>

## 缺项怎么显示

| 状态 | 抽屉显示 |
| --- | --- |
| 键存在且为空 | 这次没有 |
| 键不存在（老记录或写入方没写） | 无记录 |
| 这类记录不涉及（例如整理记忆没有规则） | 这类记录不涉及 |
| 记忆已被删除 | 这条记忆已不存在 |
| 记忆是敏感的 | 敏感记忆，内容不在这里显示 |
