---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-004"
record_state: "open"
date: "2026-10-26"
updated: "2026-10-26"
priority: "high"
item_type: "feature"
source_idea: ""
review_after: "2026-11-02"
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 给生产开 Cloudflare 入口，让 Andy 的手机直接打开 Himawari

## Summary

按 ADR 0082 第一步：用 Cloudflare Tunnel 加 Cloudflare Access（邮箱名单）给生产开 HTTPS 入口，Andy 的手机走这个入口，电脑仍可用 ssh 隧道。服务端 identity 需核对 Access 登录凭证或继续用内置账号加 TOTP，二选一在开工时定。先建 Access 规则再把网址接到服务器。开工条件：第十三版上线后稳定运行。验收：Andy 在 iPhone Safari 上真实打开、登录、对话、搜索、记忆页、设置页各走一遍。

## Origin

- 决定：[SOURCE: docs/adr/0082-mobile-pwa-push-before-native-app.md]（Andy 2026-10-26T13:05Z 在决定卡片上同意 1–7 条）。

## Notes

- 评估文档：<https://claude.ai/artifact/Vs8dfsFfsgLNeMhSfTatoS>。
- 工程案例：[SOURCE: docs/engineering-casebook.md#case-mobile-client]。
