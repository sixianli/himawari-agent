---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-006"
record_state: "open"
date: "2026-10-26"
updated: "2026-10-26"
priority: "normal"
item_type: "feature"
source_idea: ""
review_after: "2026-11-16"
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 语音入口：网页按住说话和 Siri 快捷指令

## Summary

按 ADR 0082 第三步：网页里按住说话，录音上传后转成文字，作为普通消息进同一个对话；iPhone 快捷指令用 Cloudflare Access 服务令牌（只开放一个提问接口，权限小于网页登录）把说的话发给 Himawari 并朗读回答。开工前按 Pi 优先原则查 Pi 和现有模型网关的语音转文字、朗读能力，再决定接哪家。不做一直在听的唤醒词。依赖 BL-20261026-004。

## Origin

- 决定：[SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0082-mobile-pwa-push-before-native-app.md]（Andy 2026-10-26T13:05Z 在决定卡片上同意 1–7 条）。

## Notes

- 评估文档：<https://claude.ai/artifact/Vs8dfsFfsgLNeMhSfTatoS>。
- 工程案例：[SOURCE: docs/engineering-casebook.md#case-mobile-client]。
