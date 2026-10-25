---
status: "active"
document_type: "backlog"
record_id: "BL-20261024-002"
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
# 会话命令在启动前被取消时整个作业宿主以 host_failure 结束

## Summary

packages/runtime-sandbox 的作业宿主（job-host-main.ts，常驻会话模式下逐条执行 run 命令的进程）在一条 run 命令读启动前基线快照（最长 5 秒的 ps）期间收到 run_cancel 或宿主 cancel 时，settleCommand 给这条从未启动的命令生成 taskProcessExited: false、stdioClosed: false、namespace: "unknown" 的 command_result，协议函数 jobHostCommandSettled（判断命令是否妥善结束、宿主能否回到 ready 的共用判定）返回假，宿主随即 stop("host_failure") 结束整个会话；Worker 侧 job-host-session.ts 用同一判定把 settled 记为假。后果：一次正常的取消让常驻会话报宿主故障并重建，而不是回到 ready 继续服务。2026-10-24 R2-D31 第三轮 opencode 审核（.ci-output/handoff/2026-10-24-r2d31-review-oc-stop-3.md 发现 1）指出，Hermes r2d31-l012-06 的新用例失败证实；这是 958fe61b 就有的行为，不是 R2-D31 引入的，修它要同时改宿主和 Worker 两端对“未启动即取消”的结算语义，所以没有在第六次上线前改。要做的：为 residentSequence 为空且已取消的命令定义单独的妥善结束条件（常驻 runner 仍完好即可回 ready），两端一致，并给 job-host-main.unit.test.ts 的用例“[R2-D31] sends no baseline diagnostic for a command cancelled while ps was running”补上宿主继续接受下一条命令的断言。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
- 2026-10-24 发布决定（按用户授权 G176 由 Claude 决定）：第六次上线接受这个窗口内的会话失败，不在上线前修。理由：它在 revision-06 之前的生产版本里就存在，不是本次修订带来的；受影响的只是常驻会话模式里命令读基线快照（最长 5 秒）期间收到取消的情形，Worker 侧把它当宿主故障重建会话，是一次可用性降级而不是数据或权限问题；第六次上线验收用的读取探针走一次性 `start` 路径，不经过这个判定；修它要同时改宿主和 Worker 两端共用的妥善结束判定 `jobHostCommandSettled` 并重跑第 3、4 层，会再推迟上线。第四轮 opencode 审核（`.ci-output/handoff/2026-10-24-r2d31-review-oc-stop-4.md` 发现 1、2）要求把这个决定写明，并提醒：对应用例“[R2-D31] sends no baseline diagnostic for a command cancelled while ps was running”的通过只证明命令级取消结果正确，不证明宿主继续服务。上线记录见 `.ci-output/handoff/2026-10-24-sixth-revision-06-handoff.md`（git 忽略的交接文件）和 `.agents/tasks/round2-tool-execution/plan.md` 的 R2-D31 条目。
