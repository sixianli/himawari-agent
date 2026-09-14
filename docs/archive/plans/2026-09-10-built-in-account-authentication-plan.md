---
status: "archived"
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-10"
---

# 内置账号登录实施计划

**来源：** [SOURCE: docs/archive/specs/2026-09-10-built-in-account-authentication-design.md]

1. [x] 记录用户否决仅本机登录、选择内置账号；核对当前身份、会话、配置与持久化边界。
2. [x] 实现凭据、第二因素、挑战和会话认证事务，验证重复消费、撤销与重启。
3. [x] 接入配置与正式 HTTP 身份适配器，保留外部身份回归，验证 Origin/CSRF 和流式会话撤销。
4. [x] 实现账号初始化/恢复入口与多语言登录、再次认证和会话管理页面。
5. [x] 更新 PRD、替代 ADR 和运行说明，执行完整检查、安装包受控回归与真实浏览器登录验证。
6. [x] 保存本任务验收证据，关闭账号实施范围；完整日常服务剩余工作保留在原验收计划。

原完整测试结果继续保留。本计划不以引入登录页面代替真实认证，也不将测试资格或模拟模型作为正式服务证据。

## 验证与后续工作归属

完整测试 185 个文件、1,921 项通过，tooling 23 个文件、565 项通过，均无失败、跳过和自动重试。浏览器补验修正了 Unicode 密码输入长度，保存先失败后通过证据。详细结果与验证限制见 `test/qualification/evidence/built-in-account-2026-09-10/acceptance.md`。

首次安装、正式主机资格和真实模型、工具、审批、恢复仍未完成，继续保留 [SOURCE: docs/execution/plans/2026-09-10-control-center-local-acceptance-plan.md] 为 active。本计划关闭仅指内置账号实现，不表示原控制中心完整验收通过。
