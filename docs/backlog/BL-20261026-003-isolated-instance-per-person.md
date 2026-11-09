---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-003"
record_state: "deferred"
date: "2026-10-26"
updated: "2026-11-09"
priority: "normal"
item_type: "feature"
source_idea: "docs/ideas/IDEA-20261026-001-per-person-isolated-himawari.md"
review_after: "2026-11-16"
promoted_to: ""
result: ""
reason: "2026-11-09 复查：生产连续 7 天没有用不了级别事故这一条没满足（I-72、I-73 在 11-02，I-84 在 11-07，I-84 的修复 #282 已合进 main 但还没上线）；其余三条已满足。"
supersedes: ""
superseded_by: ""
---
# 给家人朋友各开一个独立的 Himawari 实例（邀请制，Cloudflare Access 登录）

## Summary

按 ADR 0083（取代 ADR 0081）：先给 Andy 的老婆开一个独立实例（独立 stateRoot、数据库、secrets、配置、系统服务、系统账号、端口），稳定两周后再给最多 2 位朋友开。只邀请，不开放注册。别人的实例用 Cloudflare Tunnel + Access（邮箱名单 + 邮箱一次性验证码），实例 identity.kind=cloudflare-access，先建 Access 规则再接网址；Andy 自己的实例也接同样的入口，由 BL-20261026-004 单独先做，电脑仍可用 ssh 隧道。开工条件：第十一版事故修好、真实网页验收通过、生产连续 7 天没有用不了的事故、上线脚本能按参数自动生成。开工后要做：核对两个实例在同一台生产机上的端口、沙箱目录、系统账号、内存和磁盘不冲突；让上线和回滚脚本支持多个实例；给每个别人的实例单独开一把 Vercel AI Gateway API key，设每月 10 美元、按月重置的预算和 100% 用量邮件提醒（Andy 2026-10-26 定的金额），核对对话、记忆嵌入、联网搜索等收费调用都走这把 key，并让页面在网关返回 402 时明确显示“本月额度已用完”；开 Cloudflare 团队并打开邮箱验证码登录；为老婆的实例做真实网页验收；补工程案例库的结果数据。

## Origin

- [SOURCE: docs/ideas/IDEA-20261026-001-per-person-isolated-himawari.md]

## Notes

- 决定：[SOURCE: docs/adr/0083-isolated-instance-per-person-with-owner-entry.md]，取代 [SOURCE: docs/adr/0081-isolated-instance-per-person.md]（Andy 2026-10-26T11:12Z 同意按推荐方案做；2026-10-26T13:05Z 同意 Andy 的手机也走 Cloudflare 入口，见 ADR 0082）。
- 评估文档：<https://claude.ai/artifact/77cUajUv5MWWHHMH8m2g1N>。
- 2026-11-09 复查时先看开工条件是否满足；不满足就把复查日期往后推。
- 2026-11-09 复查结果（读 main 的 `71d986b8`）：
  - 第十一版事故已修好，之后的版本已在真实网页上验收：满足。
  - 上线脚本能按参数自动生成：满足，上线包由 `scripts/delivery-mode/make-packet.py` 按 `scripts/delivery-mode/instances/andy-production.json` 这类实例参数文件生成（[ADR 0086](../adr/0086-generate-release-packets-from-parameters.md)）。
  - 生产连续 7 天没有“用不了”级别的事故：不满足。[事故清单](../incidents-and-gates.md#incidents)里 I-72（11-02，回滚卡住，生产停了约 3 小时）、I-73（11-02，消息发不出去）、I-84（11-07，一轮对话停在“结果未确认”约 31 分钟、停止按钮一直转）。I-84 的修复（PR #282、#312）已合进 main，但生产还是旧版本 `bc380a6e`，要等下一次上线。
  - 复查日期推到 2026-11-16。到时看：包含 #282 的新版本是否已上线，上线后是否连续 7 天没有“用不了”级别的事故。
