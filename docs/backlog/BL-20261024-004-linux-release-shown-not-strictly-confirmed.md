---
status: "active"
document_type: "backlog"
record_id: "BL-20261024-004"
record_state: "open"
date: "2026-10-24"
updated: "2026-10-24"
priority: "normal"
item_type: "defect"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# Linux 上每次正常释放都显示“停止未经严格确认”

## Summary

2026-10-24 真实使用复盘第 4 项：生产上 8 次工具调用的释放全部是 `cleanup: process_group_gone`，页面每次都显示“停止未经严格确认”，提示失去区分意义。SRT 路径只写 `process_group_gone`，是 ADR 0033 有意的风险披露；但 Linux 常驻任务宿主已经证明命令跑在独立 PID 命名空间里，每条命令结束后的扫描覆盖了整个命名空间，脱离进程组的后代也逃不出去。

## Origin

- 2026-10-24 真实使用复盘第 4 项（`.ci-output/handoff/2026-10-24-real-use-review-findings.md`，git 忽略的交接文件）。

## Notes

- 2026-10-24 用户在方案文档里选了推荐方案：Linux 上扫过整个 PID 命名空间的释放显示为“已释放”，Mac 保留提示。决定写在 [ADR 0298](../adr/0298-where-tools-run.md)。用户问过“为什么不直接去掉只有旧路径会写的 confirmed”：去掉容器路径消不掉这条提示，而且它是 ADR 0033 的严格模式。
