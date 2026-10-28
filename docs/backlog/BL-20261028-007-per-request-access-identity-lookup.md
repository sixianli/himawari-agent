---
status: "active"
document_type: "backlog"
record_id: "BL-20261028-007"
record_state: "open"
date: "2026-10-28"
updated: "2026-10-28"
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
# 网关每个请求都去问一次 Cloudflare 身份接口：先在生产量出耗时，再决定只在需要时问

## Summary

网页发的每个请求（读列表、读对话、上传文字、发命令）在服务端认证时，都会顺带向 Cloudflare Access 的 get-identity 接口发一次 HTTPS 请求（超时 2 秒），只为拿“最近登录时间”；而这个时间只有删除对话、改设置等少数高风险操作要用。本地实测服务端处理一个请求只要 3–8 毫秒，生产里每个请求多出来的外部调用耗时还没量过。先在生产加按请求的分段计时量出来，再决定改成只在高风险操作时才问，或按登录凭据缓存结果。

## Origin

- 线程“消除发送消息后的两秒卡顿”（2026-10-28，日本时间 18:3x）查发送链路时发现，见[工程案例库案例 41](../engineering-casebook.md#case-optimistic-send)。

## Notes

- 代码位置：`packages/platform-node/src/identity-gateway.ts` 的 `ProductSessionAuthenticationService.authenticate()`，每次都调用 `recentAuthenticationProvider.read()`；同一个函数每次还会写一次会话的 `lastActiveAt`（一次等硬盘确认的数据库写入）。
- 本地实测（`apps/agent-service/test/production-http-composition.unit.test.ts` 的临时计时副本，身份接口换成本地假接口）：每个请求 `identityCalls=1`，服务端耗时 2.7–7.5 毫秒。
- 用这个“最近登录时间”的地方：`RecentAuthenticationService.assertRecentAuthentication()`（删除对话、工作区授权、治理设置）和 `/api/control-center/v1/config` 返回的 `recentAuthenticationRef`。
- 先量再改：生产服务没有请求日志（`logger: false`），需要先加一行按请求的计时（或 `Server-Timing` 响应头）。
