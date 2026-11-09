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

`DecisionInputs`（`packages/application/src/ports/decision-ledger.ts`）里，按种类：

| 字段 | 谁必须写 | 含义 |
| --- | --- | --- |
| `ruleIds` | `proactive` | 这次判断中命中的规则编号，必须登记在 `DECISION_RULE_CATALOG` |
| `floorHits` | `proactive` | 每封邮件命中的规则编号 |
| `memoryIds`、`memoryByMail`、`usedMemoryIds`、`tentativeMemoryIds` | 用到记忆的所有种类 | 实际放进上下文的记忆编号，不得只写数量 |
| `memoryRecall` | `proactive` | 找记忆的状态：`off`、`ok`、`partial`、`failed` |
| `sourceIds`、`relatedByMail`、`relatedRead` | `proactive` | 判断了哪些邮件、关联了哪些邮件、读关联邮件是否完整 |

<a id="rules"></a>

## 写法规则

1. 写的是当时真正用到的东西，不得事后补写或按现在的状态重算。
2. 只写编号，不写记忆正文、邮件正文：正文从记忆表按现在的状态读，敏感记忆由读取端隐藏。
3. 新的规则必须先登记到 `DECISION_RULE_CATALOG`（来源：你设定的或内置，以及依据文档），再写进记录；未登记的编号只会显示“未登记的规则”。
4. 字段没有这回事就不写这个键，不要写空数组冒充“检查过、没有”：读取端靠键是否存在区分“这次没有”和“无记录”。
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
