---
status: "active"
document_type: "backlog"
record_id: "BL-20261028-006"
record_state: "open"
date: "2026-10-28"
updated: "2026-11-15"
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
# 给 Jarvis Test 第 1 条补反例：只在一次行程有效的偏好不该改长期记忆

## Summary

第 1 条（跨时间记忆纠正）现有用例只测“新说法要盖过旧说法”。还要测反方向：用户说的是临时情况（例如“这次出差住哪儿都行”），Himawari 不该把它当成长期偏好去覆盖旧记忆。

## Origin

- Andy 2026-10-28 14:40（日本时间）审核《Jarvis Test 自动评测集方案》时的建议：#1 要有反例。决定见 [ADR 0103](../adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md)。

## Notes

- 这类用例要检查两件事：回答里不把临时说法当成长期偏好；记忆层不因为这句话把旧偏好标成被替代。后者要等记忆写入路径能在评测里观察到。
- 2026-11-15：前一半做了。`test/fixtures/jarvis-test/cases.json` 加了两条反例 `1g`（这次出差住哪儿都行）和 `1h`（某天要 5 点起），标 `counterExample`，只检查回答不把一次性的说法当成长期要求。后一半（记忆层不把旧偏好标成被替代）仍然测不了：评测里的记忆是直接写进去的，不经过从对话里记下记忆的那一步。
