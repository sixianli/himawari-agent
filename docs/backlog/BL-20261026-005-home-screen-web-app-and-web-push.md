---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-005"
record_state: "open"
date: "2026-10-26"
updated: "2026-10-27"
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

按 ADR 0089 第 2、5 条和[网页推送实现规格](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/execution/specs/2026-10-26-web-push-design.md)：控制中心加 manifest、图标、不缓存的后台脚本，内容安全策略加 manifest-src 和 worker-src；服务端生成 VAPID 密钥、保存每台设备的订阅（一次数据库迁移）；到期记忆提醒、等待审批、任务完成或失败三类事推送，锁屏只显示提醒原文或对话标题，敏感记忆显示“你有一条私密提醒”；任何设备上页面在前台时不推；通知文字中英日三语；删掉 Bark 代码。设置页“通知”按[界面原型](https://claude.ai/artifact/E1BP6KR7gqYrXkgEcxqghv)做，等界面重构第一期合入 main 后再写。前端体积上限已由 Andy 取消。上线两周后核对推送到达情况，不可靠则按 ADR 0089 第 7 条重新评估原生 App。

## Origin

- 改动：[SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0089-web-push-only-owner-entry.md]（Andy 2026-10-26T14:39Z“直接做这个，一步到位”，15:14Z 同意锁屏规则、在看就不推、删除 Bark）。

- 决定：[SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0082-mobile-pwa-push-before-native-app.md]（Andy 2026-10-26T13:05Z 在决定卡片上同意 1–7 条）。

## Notes

- 评估文档：<https://claude.ai/artifact/Vs8dfsFfsgLNeMhSfTatoS>。
- 工程案例：[SOURCE: docs/engineering-casebook.md#case-mobile-client]。
- 2026-10-27 进展：实现已随 PR #49 合入并在第十四版上线；12:54 JST 生产入口切为 Cloudflare 邮箱验证码后推送开启，Andy 在 iPhone 主屏应用上收到测试通知。本条保持 open，只剩 2026-11-09 的到达情况核对；其余真机项见 BL-20261027-009。
