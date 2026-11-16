---
status: "active"
document_type: "backlog"
record_id: "BL-20261025-001"
record_state: "open"
date: "2026-10-25"
updated: "2026-10-25"
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

# 打开过 Run 的对话每 2 秒整页重读

## 问题

真实使用复盘第 8.4 项（2026-10-24）：只要打开的对话里有过 Run，页面每 2 秒重读侧栏列表、整段消息、每个 Run 的执行记录与执行状态、执行环境和待审批列表，对话已结束时也一样。长对话打开慢、“这段对话加载较慢”提示和文字跳动都与此有关。

## 决定

用户在 2026-10-24 的下一次生产变更方案文档里选择完整方案 C，并同意规格：[对话执行状态改为服务端推送](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-10-25-thread-execution-push-design.md)，实施计划见 [实施计划](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/plans/2026-10-25-thread-execution-push-plan.md)。

## 状态

代码已在线程分支 `claude/project-thread-xf52vt` 实现，云端单元测试和 `npm run check` 通过；Hermes 第 0–4 层和生产上线待执行。
