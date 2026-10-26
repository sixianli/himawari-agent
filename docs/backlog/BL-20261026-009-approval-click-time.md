---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-009"
record_state: "open"
date: "2026-10-26"
updated: "2026-10-26"
priority: "normal"
item_type: "enhancement"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 记录你点允许的时刻，把恢复运行从等你确认里拆出来

## Summary

过程区的“等你确认”现在从暂停记录一直算到模型重新开始，里面混着你点允许之后的恢复运行（读回进度、重连模型，生产上约 1–2 秒）。原因是执行记录里没有“你点了允许”的时间，确认卡片何时出现也没有记录。要做：在批准时写一条带时间的执行记录，时间线据此把“等你确认”和“恢复运行（准备与衔接）”分开；同时查清 10-26 trace 里确认卡片比暂停晚出现约 3.6 秒的原因。来源：ADR 0087 的已知限制。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
