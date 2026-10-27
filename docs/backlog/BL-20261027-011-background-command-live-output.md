---
status: "active"
document_type: "backlog"
record_id: "BL-20261027-011"
record_state: "open"
date: "2026-10-27"
updated: "2026-10-27"
priority: "normal"
item_type: "feature"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 后台命令运行中就能看到已有输出

## Summary

ADR 0097 让超过等待时间的 bash 命令转入后台，但前台沙箱命令只在结束时交回结果（apps/agent-service/src/capability-programs/pi-coding-request.ts 的 streamOutput 对 foreground 直接返回），所以转后台那一刻和运行期间，模型读不到已经打印的输出，分不清“安静地跑”和“卡住了”。Claude Code 和 Codex 都在转后台时给出已有输出。要做的是让沙箱里的前台 bash 把命令输出按段写到单独的输出通道，常驻会话路径（production-sandbox-execution-v2.ts 的 runInSrtEnvironment）把它存成可分页的记录，execution_task_output 在命令运行中就能读；注意不能和前台结果信封混在同一个 stdout 通道，也不能破坏丢结果后的恢复。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
