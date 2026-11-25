---
status: "active"
document_type: "backlog"
record_id: "BL-20261027-009"
record_state: "open"
date: "2026-10-27"
updated: "2026-10-27"
priority: "high"
item_type: "verification"
source_idea: ""
review_after: "2026-11-03"
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# iPhone 上核对三类真实推送、点开位置、角标和在看不推

## Summary

2026-10-27 Andy 在 iPhone 主屏应用上只确认了测试通知（“收到了”）。网页推送实现规格“验证”一节里的其余真机项还没有人看过：到期记忆提醒、等待审批、任务完成或失败三类真实推送各到一条；锁屏文字符合规则（普通提醒显示原文、任务和审批显示对话标题、敏感记忆只显示“你有一条私密提醒”）；点开通知进到对应的对话或记忆页；主屏图标角标数字随未读变化；任何设备上开着 Himawari 页面时不推。同时补走 BL-20261026-004 原定的 iPhone 上对话、搜索、记忆页、设置页各一遍。做法：Andy 日常使用中遇到就在线程里说一句，或由线程安排一次 10 分钟的对照检查；不需要改代码时以 Andy 的确认关闭，发现问题另开 Backlog。登录后还要再点一次“登录”的问题由界面重构线程处理，不在本条。

## Origin

- 来源：[SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/execution/specs/2026-10-26-web-push-design.md]（“验证”一节最后一条真机检查），以及 [SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0089-web-push-only-owner-entry.md]（“后果”一节的未验证项）。

## Notes

- 已验证的部分：Andy 2026-10-27 在 iPhone 上开启通知并点“发送一条测试通知”，回复“收到了”（长任务 `.agents/tasks/web-push` 的 G7）。
- 上线两周后的到达率核对仍在 BL-20261026-005（2026-11-09 复查）。
