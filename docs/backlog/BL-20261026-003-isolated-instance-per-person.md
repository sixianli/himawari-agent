---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-003"
record_state: "deferred"
date: "2026-10-26"
updated: "2026-11-16"
priority: "normal"
item_type: "feature"
source_idea: "docs/ideas/IDEA-20261026-001-per-person-isolated-himawari.md"
review_after: "2026-11-23"
promoted_to: ""
result: ""
reason: "2026-11-16 复查：含 #282、#312 的版本 `dd563b30` 按上线线程 11-15 的小结已上线（没有现场核实），但“生产连续 7 天没有用不了级别事故”最早 11-22 之后才能满足；Andy 2026-11-14 已叫停多人任务，等他口令再开。2026-11-11：ADR 0234 取代 ADR 0083，做法改为一个程序、每人一个数据库文件。"
supersedes: ""
superseded_by: ""
---
# 给家人朋友开通各自的 Himawari（邀请制，一个程序、每人一个数据库文件）

## Summary

2026-11-11 更新：ADR 0234 取代 ADR 0083，做法改为一个程序、每人一个数据库文件，不再每人一套实例；所有人的模型用 Andy 已有的套餐（对话模型按 ADR 0117 的顺序走），不用 Vercel key；每人每月上限由 Andy 在管理页配置，代码不写固定数字。实现顺序见 [SOURCE: docs/adr/0234-one-program-per-person-database-file.md]；下面的原文是 ADR 0083 时代的记录，其中独立实例、独立端口、每个实例一把 Vercel key 和每月 10 美元的部分作废。

按 ADR 0083（取代 ADR 0081）：先给 Andy 的老婆开一个独立实例（独立 stateRoot、数据库、secrets、配置、系统服务、系统账号、端口），稳定两周后再给最多 2 位朋友开。只邀请，不开放注册。别人的实例用 Cloudflare Tunnel + Access（邮箱名单 + 邮箱一次性验证码），实例 identity.kind=cloudflare-access，先建 Access 规则再接网址；Andy 自己的实例也接同样的入口，由 BL-20261026-004 单独先做，电脑仍可用 ssh 隧道。开工条件：第十一版事故修好、真实网页验收通过、生产连续 7 天没有用不了的事故、上线脚本能按参数自动生成。开工后要做：核对两个实例在同一台生产机上的端口、沙箱目录、系统账号、内存和磁盘不冲突；让上线和回滚脚本支持多个实例；给每个别人的实例单独开一把 Vercel AI Gateway API key，设每月 10 美元、按月重置的预算和 100% 用量邮件提醒（Andy 2026-10-26 定的金额），核对对话、记忆嵌入、联网搜索等收费调用都走这把 key，并让页面在网关返回 402 时明确显示“本月额度已用完”；开 Cloudflare 团队并打开邮箱验证码登录；为老婆的实例做真实网页验收；补工程案例库的结果数据。

## Origin

- [SOURCE: docs/ideas/IDEA-20261026-001-per-person-isolated-himawari.md]

## Notes

- 现行决定：[SOURCE: docs/adr/0234-one-program-per-person-database-file.md]，取代 [SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0083-isolated-instance-per-person-with-owner-entry.md]（Andy 2026-11-11T10:27Z 同意一个程序、每人一个数据库文件；11:05Z 要求只用 OpenCode Go 套餐、上限由他配置）。
- ADR 0083 时代的决定：[SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0083-isolated-instance-per-person-with-owner-entry.md]，取代 [SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0081-isolated-instance-per-person.md]（Andy 2026-10-26T11:12Z 同意按推荐方案做；2026-10-26T13:05Z 同意 Andy 的手机也走 Cloudflare 入口，见 ADR 0082）。
- 评估文档：<https://claude.ai/artifact/77cUajUv5MWWHHMH8m2g1N>。
- 2026-11-09 复查时先看开工条件是否满足；不满足就把复查日期往后推。
- 2026-11-09 复查结果（读 main 的 `71d986b8`）：
  - 第十一版事故已修好、新版用真实网页验收通过：满足。依据：[教训记录](../lessons.md)里第十一次上线那条写明修好的 `470b6d30` 在真实浏览器里六项全部通过；之后每次上线，`deploy.sh` 都要先过 `scripts/delivery-mode/browser-acceptance-gate.py`，它的必过场景 `REQUIRED_SCENARIOS` 包含首页登录、搜索审批、设置里的联网搜索开关、新闻搜索、长回答、记忆页等；生产此后已经跑到第二十六版（I-84）。
  - 上线脚本能按参数自动生成：满足，上线包由 `scripts/delivery-mode/make-packet.py` 按 `scripts/delivery-mode/instances/andy-production.json` 这类实例参数文件生成（[ADR 0086](../adr/0086-generate-release-packets-from-parameters.md)）。
  - 生产连续 7 天没有“用不了”级别的事故：不满足。[事故清单](../incidents-and-gates.md#incidents)没有单独的严重度列，这里按 ADR 0083 的“用不了”口径，把下面三条都算进去：I-72（11-02，回滚卡住，生产停了约 3 小时）、I-73（11-02，消息发不出去）、I-84（11-07，一轮对话页面显示“结果未确认 4 分 4 秒”，停止按钮一直转，要到开始后约 31 分钟的原始期限才收尾）。I-84 的修复（PR #282、#312）已合进 main，但还没上线：按仓库里最新的上线记录 I-81，11-07 上线 `f0478c4d` 时在生产验收步骤被拦下，生产仍是旧版本 `bc380a6e`；仓库里没有之后的上线记录，这次复查按要求不碰生产机，没有现场核实。
  - 复查日期推到 2026-11-16。到时看：包含 #282、#312 的新版本是否已上线，上线后是否连续 7 天没有“用不了”级别的事故。
- 2026-11-16 复查结果（读 main 的 `56545603a`）：
  - 第十一版事故修好、新版用真实网页验收通过：仍满足。`scripts/delivery-mode/browser-acceptance-gate.py` 的必过场景还在，包含搜索审批、设置里的联网搜索开关、记忆页。
  - 上线包按参数自动生成：仍满足。`scripts/delivery-mode/make-packet.py` 和 `scripts/delivery-mode/instances/andy-production.json` 都在。
  - 包含 #282、#312 的新版本已上线：`dd563b30`（PR #575 的合并提交，11-15 19:39 JST）按 git 祖先核对，包含 #282（`0f468696`）和 #312（`71d986b8`）；上线线程 11-15 的交付小结写生产跑的是 `dd563b30`。这是上线线程的说法，这次复查按要求不碰生产机，没有现场核实。
  - 生产连续 7 天没有“用不了”级别的事故：还不满足。上线当天（11-15）事故清单记了三次上线失败：I-105 和 I-108 在停服后失败并自动回滚，生产有一段时间没有服务（时长记录里没写）；I-107 在停服前停下，旧版本一直在运行。最后一次上线成功之后，事故清单里没有新的生产事故（I-110 是心跳告警装不上，服务本身不受影响），但“没有记录”不等于没发生。上线时间同样取自上线线程的小结（11-15），仓库里没有部署记录；从上线算起满 7 天，最早是 11-22 之后，11-23 复查时按实际部署时间重新算。
  - 多人任务现在被叫停：Andy 2026-11-14T02:27Z 在项目聊天里说“把多人需求的这些任务先暂停掉，什么时候开等我口令。现在先把 Claude Code 的 token 用于开发 Himawari 单人的，单人的开发得差不多了，然后再来做多人的”。所以这次不请协调者开实现线程，等 Andy 的口令。ADR 0234 第 14 条把这四条条件缩窄了：前文写的是继续约束“把 Andy 的数据迁进新结构并上线”这一步和给别人开通，后文写的是“只约束碰生产机和给别人开通的步骤”；第一步“在生产机上做只读测量”算不算碰生产机，ADR 没有明说。
  - 复查日期推到 2026-11-23。到时看：11-15 上线之后生产是否连续 7 天没有“用不了”级别的事故，以及 Andy 是否已给口令。
