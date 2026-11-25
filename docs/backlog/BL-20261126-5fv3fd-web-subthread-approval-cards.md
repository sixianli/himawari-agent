---
status: "active"
document_type: "backlog"
record_id: "BL-20261126-5fv3fd"
record_state: "open"
date: "2026-11-26"
updated: "2026-11-26"
priority: "low"
item_type: "feature"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 网页主对话显示子线程发起的同意卡片

## Summary

子线程运行停下等主人同意时，iPhone 的同意列表已经能看到卡片并显示来自主对话；网页端仍按运行把卡片放在发起它的对话里，而子线程是隐藏的，所以网页上看不到这张卡片。以后做网页时，在主对话里显示来源指向主对话的待同意卡片（approval.detail 的 display.origin），并按项目规则做正向和反向的真实网页验收。2026-11-26 协调者转达：Andy 现在只做 iPhone，网页这块先不补。

## Origin

- Always On 第 3 步 3f（PR 682）把子线程发起的审批来源改成主对话，iPhone 同意列表因此显示“来自主对话”；网页端没有跟着改。
- 设计依据：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md` 权限和审批一节，“同意卡片出现在主对话里”。

## Notes

- 网页现在的做法：`apps/control-center/src/thread-control-center.tsx` 用运行编号把同意卡片挂在发起它的对话里。
