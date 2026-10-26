---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-003"
record_state: "open"
date: "2026-10-26"
updated: "2026-10-26"
priority: "normal"
item_type: "feature"
source_idea: "docs/ideas/IDEA-20261026-001-per-person-isolated-himawari.md"
review_after: "2026-11-09"
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 给家人朋友各开一个独立的 Himawari 实例（邀请制，Cloudflare Access 登录）

## Summary

按 ADR 0081：先给 Andy 的老婆开一个独立实例（独立 stateRoot、数据库、secrets、配置、系统服务、系统账号、端口），稳定两周后再给最多 2 位朋友开。只邀请，不开放注册。别人的实例用 Cloudflare Tunnel + Access（邮箱名单 + 邮箱一次性验证码），实例 identity.kind=cloudflare-access，先建 Access 规则再接网址；Andy 自己的实例保持 ssh 隧道。开工条件：第十一版事故修好、真实网页验收通过、生产连续 7 天没有用不了的事故、上线脚本能按参数自动生成。开工后要做：核对两个实例在同一台生产机上的端口、沙箱目录、系统账号、内存和磁盘不冲突；让上线和回滚脚本支持多个实例；Andy 给出别人实例的每月模型用量上限金额后另写 ADR 并实现限额（只对别人的实例生效）；开 Cloudflare 团队并打开邮箱验证码登录；为老婆的实例做真实网页验收；补工程案例库的结果数据。

## Origin

- [SOURCE: docs/ideas/IDEA-20261026-001-per-person-isolated-himawari.md]

## Notes

- 决定：[SOURCE: docs/adr/0081-isolated-instance-per-person.md]（Andy 2026-10-26T11:12Z 同意按推荐方案做）。
- 评估文档：<https://claude.ai/artifact/77cUajUv5MWWHHMH8m2g1N>。
- 2026-11-09 复查时先看开工条件是否满足；不满足就把复查日期往后推。
