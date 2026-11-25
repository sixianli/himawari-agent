---
status: "active"
document_type: "backlog"
record_id: "BL-20261028-002"
record_state: "open"
date: "2026-10-28"
updated: "2026-10-28"
priority: "high"
item_type: "enhancement"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 后台任务和无人值守推进要带按任务的费用、token 和时间预算

## Summary

愿景原则 8 要求无人值守推进受成本、资源与时间预算约束，超限即停。Andy 2026-10-28 定：保留成本上限，理由是后台任务无限期跑会耗光模型 token 额度和费用。做法是每个后台命令和无人值守任务各带自己的费用、token 和时间上限，超限即停并汇报；这不是 ADR 0076 删掉的全局累计上限。默认值待定，上线前问 Andy。

## Origin

- 来自[产品愿景](../product-vision.md#principles)原则 8 的评审和 [ADR 0101](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0101-adopt-product-vision-v2-1.md#per-task-budget)。Andy 2026-10-28 14:11（日本时间）原话：“我的意思是，这里还是要加一个成本上限，不然的话，一个后台任务如果无限期跑的话，我的那个模型的 token 额度，还有模型 token 的这个费用，我可能接受不了。”

## Notes

- 现状：后台命令（bash）已有每条 30 分钟的时间上限（[ADR 0098](../adr/0098-move-long-bash-commands-to-background.md)），但命令跑完后系统另起的汇报轮、以及以后的无人值守任务，都没有按任务的费用或 token 上限；全局累计上限已按 [ADR 0297](../adr/0297-how-model-calls-work.md) 删除，只留用量账本。
- 要做的：每个任务开始时定下自己的费用、token 和时间上限；用量账本按任务累计；任一项超限就停止该任务并汇报“停在哪、已完成什么、还剩什么”，不影响其他对话。
- 待 Andy 定：各项默认值，以及能否在单个任务上临时放宽。上线前问他。
