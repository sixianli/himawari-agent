---
status: "active"
document_type: "backlog"
record_id: "BL-20261028-005"
record_state: "open"
date: "2026-10-28"
updated: "2026-10-28"
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
# Jarvis Test 其余七条等能力具备后再加进评测

## Summary

产品愿景第 3.7 节 Jarvis Test 十条里，第一批只做了 #1、#6、#8（BL-20261028-003）。其余七条每条都缺一项产品能力，能力做出来后再按同样方式（预置数据、固定日期、代码判分优先、模型裁判兜底）加进 test/fixtures/jarvis-test/cases.json。

## Origin

- Andy 2026-10-28 14:40（日本时间）对《Jarvis Test 自动评测集方案》的审核结论：“剩余 7 条按依赖表进 Backlog”。方案网页 <https://claude.ai/artifact/D8yqNywjecV3fEzMvRaN1y>，决定见 [ADR 0103](../adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md)。

## Notes

每条还缺的产品能力（场景编号和通过标准见[产品愿景的 Jarvis Test 表](../product-vision.md#jarvis-test)）：

| # | 场景 | 还缺什么才能自动测 |
|---|---|---|
| 2 | 跨表面连续性 | 第二个接入面（现在只有 Himawari 网页；手机网页是同一个界面，不算第二个）。 |
| 3 | 主动拦截 | 邮件和日程的接入。现在 Himawari 读不到这两样，评测没法预置“将要出错的事”。 |
| 4 | 长尾自造工具 | 工具登记表和工具版本：造出来的工具要能登记、复用，评测才能检查“复用”这一步。 |
| 5 | 权限不扩大 | 一份能导出的权限清单：评测要比较自造工具前后的权限集合，现在没有地方列出全部权限。 |
| 7 | 不在场推进 | 按规则定时执行的任务入口：评测要能放一条“夜里做某事，到某条件就停”的规则，再检查停没停、汇报了没有。 |
| 9 | 遗忘与纠正传播 | 记忆之间的“由谁推出来”字段：删掉一条记忆后，要能找到由它推出的其他记忆。 |
| 10 | 打扰校准 | 30 天的推送反馈数据，由 [BL-20261028-004](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/backlog/BL-20261028-004-proactive-notification-feedback-log.md) 开始记录。 |

- 每加一条，先确认对应能力已经上线，再按第一批的做法写用例：编造的演示数据、固定“今天”、能用代码判的先用代码判。
