---
status: "active"
document_type: "backlog"
record_id: "BL-20261028-004"
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
# 记录每次系统主动提醒和 Andy 的反应，为打扰校准积累数据

## Summary

按产品愿景 Jarvis Test #10 和护城河第 3 样，每条系统主动提醒都存一条记录：发出时间、类型、内容摘要、送达渠道，以及 Andy 的反应（点开、忽略、关闭、回复）和反应时延。#10 要连续 30 天数据，所以尽早开始。先定义命中和多余提醒，再按记录算命中率和多余提醒率。

## Origin

- 来自[产品愿景 Jarvis Test](../product-vision.md#jarvis-test)的评审（[ADR 0101](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0101-adopt-product-vision-v2-1.md)，评审网页 <https://claude.ai/artifact/G7qKTu3gw38PFGpWVzohZF>）。Andy 2026-10-28 14:12（日本时间）原话：“同意”（对评审建议“马上开始记录系统主动提醒和反应”）。

## Notes

- 设计和实现由“把产品愿景定稿放进项目”线程在 PR #67 合并后接着做，另开 PR；数据库迁移号 0061，决策记录 [ADR 0102](../adr/0102-record-push-notification-feedback.md)。
- 2026-10-28：记录部分已实现（表 `web_push_feedback`、命令 `push.feedback.record`、Service Worker 回报），尚未上线。剩下：上线后在 iPhone 上实测点开能否记录；30 天后按 ADR 0102 的定义算命中率和多余提醒率，并复核定义；统计页面先出原型给 Andy 批。
