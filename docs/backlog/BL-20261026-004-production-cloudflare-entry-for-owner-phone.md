---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-004"
record_state: "done"
date: "2026-10-26"
updated: "2026-10-27"
priority: "high"
item_type: "feature"
source_idea: ""
review_after: "2026-11-02"
promoted_to: ""
result: "2026-10-27 已在 Mac 远程会话线程里由 Andy 打字授权完成：Hermes 改用 himawari-test.siyi.win；生产装 cloudflared 隧道，https://himawari.siyi.win 指向生产机 127.0.0.1:8400；Cloudflare Access 只放行 Andy 的邮箱、会话 1 个月，manifest、sw.js 和图标从外网取得 200；12:54 JST 生产登录切为只用 Cloudflare 邮箱验证码（identity.kind cloudflare-access）。11:53 第一次切换失败停服约 9 分钟，见工程案例 30 和 BL-20261027-008。Andy 已在 iPhone 主屏应用上登录并收到测试通知。iPhone 上对话、搜索、记忆页、设置页的逐项走查转到 BL-20261027-009；Hermes 测试服务启动失败和 Runbook 网址更新由 Mac 线程跟进。"
reason: ""
supersedes: ""
superseded_by: ""
---
# 给生产开 Cloudflare 入口，让 Andy 的手机直接打开 Himawari

## Summary

按 ADR 0089 第 3、4 条：生产装 Cloudflare Tunnel，把 `himawari.siyi.win` 转到本机 127.0.0.1:8400；Hermes 先改用新域名（推荐 `himawari-test.siyi.win`）让出旧域名，并改 Hermes 控制中心升级 Runbook 里的网址。Access 规则只放行 Andy 的邮箱，会话 30 天；生产 `identity.kind` 改为 `cloudflare-access`，把 Cloudflare 身份绑定到现有 Owner，`publicOrigin` 改为 `https://himawari.siyi.win`，手机和电脑都用这个网址（ssh 隧道打开网页的方式停用，Cloudflare 故障时由 Mac 远程会话临时切回内置登录）。前提：Andy 的 Gmail 开两步验证。先建 Access 规则再把网址接到服务器。开工条件：第十三版上线后稳定运行、Hermes 上没有测试在跑；生产改配置和重启要 Andy 在远程会话线程里打字授权。验收：Andy 在 iPhone Safari 上真实打开、登录、对话、搜索、记忆页、设置页各走一遍。

## Origin

- 改动：[SOURCE: docs/adr/0089-web-push-only-owner-entry.md]（Andy 2026-10-26T15:11Z、15:12Z 在设计文档上批注）。

- 决定：[SOURCE: docs/adr/0082-mobile-pwa-push-before-native-app.md]（Andy 2026-10-26T13:05Z 在决定卡片上同意 1–7 条）。

## Notes

- 评估文档：<https://claude.ai/artifact/Vs8dfsFfsgLNeMhSfTatoS>。
- 工程案例：[SOURCE: docs/engineering-casebook.md#case-mobile-client]。
