---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-005"
record_state: "open"
date: "2026-10-26"
updated: "2026-10-26"
priority: "high"
item_type: "feature"
source_idea: ""
review_after: "2026-11-09"
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 控制中心做成可加到主屏幕的网页应用，并加网页推送

## Summary

按 ADR 0082 第二步：加 manifest（display=standalone、图标用 assets/brand/himawari/v1）、内容安全策略加 manifest-src 'self'、服务端生成推送密钥并保存订阅（一次数据库迁移）、到期记忆提醒、任务完成、等待审批三类事件触发推送，优先用声明式网页推送（iOS 18.4 起），设置页加开启推送按钮（必须由用户点按触发）。锁屏显示多少正文设计时问 Andy；界面改动先出原型给 Andy 审。开工条件：BL-20261026-004 入口在 iPhone 上实测可登录；前端 gzip 总体积先省出约 1–2 KB，或经 Andy 同意调高上限。上线两周后核对推送到达情况，不可靠则按 ADR 0082 第 6 条重新评估原生 App。

## Origin

- 决定：[SOURCE: docs/adr/0082-mobile-pwa-push-before-native-app.md]（Andy 2026-10-26T13:05Z 在决定卡片上同意 1–7 条）。

## Notes

- 评估文档：<https://claude.ai/artifact/Vs8dfsFfsgLNeMhSfTatoS>。
- 工程案例：[SOURCE: docs/engineering-casebook.md#case-mobile-client]。
