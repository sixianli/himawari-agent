---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-007"
record_state: "open"
date: "2026-10-26"
updated: "2026-10-26"
priority: "high"
item_type: "ops"
source_idea: ""
review_after: "2026-10-27"
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 在生产打开已写好的 Bark 记忆提醒推送

## Summary

按 ADR 0082 第 5 条：Bark 推送代码（提交 f73b0b7）已随第十次上线进入生产但未配置。步骤：Andy 在 iPhone 装 Bark，首页推送地址里取设备 key；在 Bark 的推送加密里选 AES256、CBC，填 32 位密钥（IV 不用填，服务器每条随机生成并随请求发送）；密钥由 Andy 的 Mac 上远程会话随机生成并只放进 Mac 剪贴板，不经聊天；Claude 先备份 /etc/himawari/config.json，写入 reminder-push 密钥（值为 {"deviceKey","encryptionKey"}）和 runPolicy.reminderPush {channel: bark, secretRef}，重启服务，用一条测试提醒验证锁屏收到，日志出现 reminder-push.sent。生产改配置和重启要 Andy 在远程会话线程里打字确认。

## Origin

- 决定：[SOURCE: docs/adr/0082-mobile-pwa-push-before-native-app.md]（Andy 2026-10-26T13:05Z 在决定卡片上同意 1–7 条）。

## Notes

- 评估文档：<https://claude.ai/artifact/Vs8dfsFfsgLNeMhSfTatoS>。
- 工程案例：[SOURCE: docs/engineering-casebook.md#case-mobile-client]。
