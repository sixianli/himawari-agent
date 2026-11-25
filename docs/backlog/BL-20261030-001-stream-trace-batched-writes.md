---
status: "active"
document_type: "backlog"
record_id: "BL-20261030-001"
record_state: "open"
date: "2026-10-30"
updated: "2026-10-30"
priority: "normal"
item_type: "enhancement"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 流式过程记录批量写与进度走内存推送

## Summary

Andy 10-30 09:46（日本时间）说“立项”。13 轮生产对话里，写过程记录 1316 次、平均 83 毫秒、合计 109 秒，用户能感觉到的写盘相关等待约 23 秒（模型说完后网页晚约 0.5 秒、工具开工前等记录写完 0.36 秒）。第一步只加分段计时（加密、数据库排队、数据库执行），上线后用一天数据确认 83 毫秒花在哪；之后按数据做：流式片段攒 100–200 毫秒写一次、网页实时进度走内存推送、SQLite 检查点放到空闲时做。不引入 Redis（理由和一手资料见 https://claude.ai/artifact/Se5rECdDc9JFPHn42DMkuR ）。

## Origin

- Captured directly.

## Notes

- 2026-10-30 第一步（只加计时，不改行为）：每轮的 `run.timing` 日志新增 `trace.protect`（加密过程记录）、`trace.append`（写过程事件）、`trace.audit`（写审计）和 `db.queue`（数据库请求在单个数据库线程前排队）、`db.run`（数据库线程实际执行，含等硬盘确认）。读法：`trace.record` 约等于 `trace.protect` + `payload.commit` + `trace.append` + `trace.audit`；如果 `db.run` 小而 `db.queue` 大，慢在排队而不是磁盘；如果 `trace.protect` 大，慢在加密。
- 背景：[ADR 0306](../adr/0306-database-access-and-concurrent-conversations.md) 已让过程记录提交时不等硬盘确认（生产机每次确认 11.5–18.7 毫秒），所以按理每条应远小于 83 毫秒，这正是要先测清楚的原因。
- 不选 Redis 的理由：对话过程要长期保存，Redis 默认也要每秒同步磁盘，再写进 SQLite 等于写两遍；单机自部署的同类产品（Open WebUI、LibreChat）只在多实例时才用。
- 2026-10-30 第二十一版第一批数据（`/mnt/project-files/startup-db-v21.txt`，事故清单 I-36）：重启后第一条消息 `db.queue` 合计 13.8 秒、`db.run` 3.6 秒，之后两条排队 0.9 秒、2.4 秒，说明慢在排队而不是磁盘。排队的主要来源不是过程记录，而是每个网页请求的权限检查、会话活跃时间写入和审批全量读，已在 I-36 的修复里先处理。过程记录攒批要等这批修复上线后，用新的 `db.queue` 数据再判断还值不值得做。
