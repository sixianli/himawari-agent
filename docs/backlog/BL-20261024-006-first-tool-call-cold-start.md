---
status: "active"
document_type: "backlog"
record_id: "BL-20261024-006"
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
# 每个 Run 第一次用工具要等 9–16 秒

## Summary

2026-10-24 真实使用复盘第 2 项：生产运行 `de236e37` 的 edit 调用里，授权完成到沙箱开始执行花了 9.5 秒，命令本身 1.0 秒；同一 Run 后续 bash 只要 2.6–4.3 秒，说明常驻环境复用已经生效，慢在每个 Run 第一次建环境。

## Origin

- 2026-10-24 真实使用复盘第 2 项（`.ci-output/handoff/2026-10-24-real-use-review-findings.md`，git 忽略的交接文件）。

## Notes

- 2026-10-24 用户同意“先量再修”。第一步只加计时，不改行为：Worker 每次 SRT 常驻调用写一行 `sandbox.srt_call.timing`（宿主绑定、解析、工作区根、作业策略、读输入、会话、绑定、再次解析、命令开始，各段毫秒数），新建会话时常驻环境后端另写一行 `sandbox.srt_session.timing`（写状态、启动作业宿主、等待就绪，以及作业宿主心跳报告的各准备阶段）。两行都写到服务的标准错误，和已有的 `sandbox.admission.timing` 一样。
- 第二步在 Hermes 上用与生产相同的组合连跑 10 个新 Run，各做一次 edit，取各段中位数和最大值，再按结果定修法（Run 开始时预热环境，或减少依赖加载），修法另请用户确认。
