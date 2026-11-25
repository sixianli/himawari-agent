---
status: "active"
document_type: "idea"
record_id: "IDEA-20261026-001"
record_state: "promoted"
date: "2026-10-26"
updated: "2026-11-11"
project: "Himawari Agent"
promoted_to: "docs/backlog/BL-20261026-003-isolated-instance-per-person.md"
supersedes: ""
superseded_by: ""
---
# 让 Himawari 给家人朋友各用一份，数据和记忆互相隔离

**Context/Project:** Himawari Agent

## Core Ideas

> 2026-11-11 更新：这份记录写于 ADR 0081/0083 时代，下面的“每人一个独立实例”已被 [SOURCE: https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0234-one-program-per-person-database-file.md] 取代，现行做法是一个程序、每人一个数据库文件，跟踪在 [SOURCE: docs/backlog/BL-20261026-003-isolated-instance-per-person.md]。

Andy 想把 Himawari 分享给老婆、朋友，最终可能是任何人使用，每个人的对话、记忆和个人数据彼此完全隔离（常说的多租户，即一套系统服务多个互相隔离的用户）。评估结论（2026-10-26）：做成“每人一个只属于自己的 Himawari”，而不是多人共用一份记忆；与 PRD v0.1 的“如果未来提供多用户托管服务，每位用户拥有彼此隔离的私人 Agent”一致。建议分步：先为老婆和 1-2 位朋友各开一个独立实例（每人独立的 stateRoot、数据库文件、密钥目录、服务进程和登录账号，业界称 silo 模型）；用户超过约 5 人或分别上线成为负担时，再把单实例改为按 owner_id 隔离（pool 模型）；对陌生人开放注册的 SaaS 暂不做。评估文档：https://claude.ai/artifact/77cUajUv5MWWHHMH8m2g1N

## Thought Trajectory

代码现状：数据库几乎每张产品表已带 owner_id 和 agent_id；写死单人的是配置里唯一的 ownerId/agentId、内置账号登录总是返回配置里的那个主人、Cloudflare 登录只允许绑定第一个身份、全局 secrets/ 目录、按配置主人计算的联网搜索授权键、只为配置主人运行的整理记忆与提醒推送、全局 totalRuns 和单行 authority_revision。业界：Mem0 与 Zep 都按用户标识分记忆，Mem0 文档提醒没传的标识不做限制；AWS SaaS Lens 区分 silo/pool/bridge；Azure 说共用部署靠应用代码和租户标识分开数据；Cloudflare D1 与 Turso 推荐每用户一个 SQLite 库。生产当前连续两版上线出事故，所以开工要等稳定。

## Verbatim Quotes

> "后面这一个 AI agent，嗯，需要做成多租户的……我会分享给我的老婆用，我会分享给我的朋友用，我还会分享给其他任何人用。"
> "他们的数据和记忆，就是个人数据是隔离的"
> "我不知道我这个需求是不是一个好的需求。"

## Open Questions

1. 是否开一个不用 ssh 隧道的 HTTPS 登录入口（Cloudflare Access 或内置账号加两步验证）？2. 给别人的实例设多少每月模型用量上限？3. 第二个实例与现有实例在同一台生产机上能否共存（端口、沙箱目录、系统账号、内存和磁盘）未验证。4. 方案 B 的触发条件是否定为“用户超过约 5 人”？5. 何时改 PRD v0.2 的“不承诺多租户”条款并写 ADR 取代 ADR 0027、ADR 0020？
