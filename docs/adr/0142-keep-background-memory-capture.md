---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md
date: "2026-10-31"
---

# ADR 0142：长期记忆继续用每轮后台抽取，不改成主模型自己调工具，也不加规则预筛

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

现在每轮对话结束后，`apps/agent-service/src/production-memory-capture.ts` 会多调一次模型（后台抽取，`memory-capture:v5`），判断这轮有没有值得长期记住的话。Andy 在 2026-10-30 问：若像 Anthropic 那样不额外多调一次，而是让主模型自己调工具存记忆，值不值得改。他同意建一套“该记的话有没有被记下”的评测来回答，数据集用手写合成数据，花费上限 0.5 美元。

评测用 120 条手写合成的话（60 条该记、60 条不该记），模型是网关上的 `deepseek/deepseek-v4.1-flash`，打分是代码按关键词匹配，不用模型当裁判。三种做法：A 现在的后台抽取；B 主模型调 `memory_remember` 工具；C 先用规则筛一遍再走 A。结果见 `evals/memory-capture/` 和 `/mnt/project-files/memory-capture-eval/report.md`。

| 指标 | A（1 遍） | B（2 遍） | C（由 A 的结果算出） |
| --- | --- | --- | --- |
| 该记的整条记下 | 90% | 93%、92% | 67% |
| 嵌在任务里的 | 67% | 83%、67% | 17% |
| 不该记的却记了 | 0% | 6.7%、5% | 0% |
| 密钥被记下 | 0 | 2、1 | 0 |
| 实际花费 | 0.127 美元 | 约 0.055 美元/遍（用量折算） | 不额外花钱 |

[返回目录](#contents)

<a id="decision"></a>

## 决定

1. 长期记忆继续使用每轮后台抽取（A），不改动抽取流程。Andy 在 2026-10-31 23:43 JST 说：“那就把这个评测结果记下来，然后不用换，用 A 就行了”。
2. 不加规则预筛（C）：它让 120 条里 68 条免调模型，但该记的话只剩 67%。
3. 不改成主模型调工具（B）：B 省约一半调用费，但会把密钥和助手自己说的话记下来。若以后重新评估 B，先在它前面加上生产里 A 已有的密钥扫描 `scanMachineSecrets`，再测。
4. 评测脚本、数据集和结果留在仓库，供以后换抽取方式或换模型时重跑：`scripts/evals/memory-capture-live.eval.ts`，需 `EVAL_CONFIRM_COST` 才会运行。

[返回目录](#contents)

<a id="options"></a>

## 放弃的做法

- **B 主模型调工具：** 成本低一半，但这次数据里有密钥被记下，且“记不记”取决于主模型当时想不想起来。
- **C 规则预筛：** 规则是随手写的，未调优；即使调优，嵌在任务里和不带“我”的话也难靠规则识别。
- **用真实聊天补题：** 需要 Andy 挑选并涉及他的数据，本次没做。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

结论的可信度有限，原因写在这里，避免以后当成绝对数字用：

- 120 条题和标准答案都由 Claude 一人手写，写题时读过 A 的提示词，可能对 A 偏有利；句子比真实聊天干净。
- A 只有 1 遍有效结果（第一次因脚本把输出上限设成 1500 token、模型思考吃光额度而作废，重跑上限 4096，仍有 2 次被截断），B 有 2 遍；每个数字只有 120 条样本，差几个百分点不算差别。
- 模型是网关上的 DeepSeek，不是生产 Magpie 背后的来源；Hermes 上没有 Magpie，无法在那里测。

[返回目录](#contents)

<a id="references"></a>

## 关联文档

- [案例 78](../engineering-casebook.md#case-memory-capture-eval)
- [ADR 0129](0129-compaction-summary-not-fed-to-memory-engine.md)
- 评测数据：`evals/memory-capture/`，数据集 `test/fixtures/memory-capture-eval/dataset.json`
- PR #157

[返回目录](#contents)
