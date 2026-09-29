---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-29"
---

# 执行事件有界分页设计

[目标与范围](#目标与范围) · [协议](#协议) · [错误处理](#错误处理) · [验证与限制](#验证与限制)

## 目标与范围

长期运行的 Worker 会累计执行事件。TE-11 的真实安装失败表明，单条事件都合法时，全部历史组成的响应仍可能超过 UDS 单次正文上限，使后续工具结果无法读回。本设计按已批准的 reply-14 至 reply-16 合同分割传输页，保持单次上限和原权限、期限，不删除历史或重放工具。

权威来源：[隔离工具执行设计](2026-09-24-isolated-tool-execution-design.md#backend) [SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#backend]；[工具执行审核计划](../plans/2026-09-28-tool-execution-audit-plan.md) [SOURCE: docs/execution/plans/2026-09-28-tool-execution-audit-plan.md]。

这是 Himawari 自有 Agent/Worker UDS 的传输修复。Pi 工具定义、执行批次和模型运行接口保持原合同；不增加模型侧工具协议。事件历史内存保留和服务端历史扫描成本不属于本修复，另行记录后续工作。准备失败后的预约恢复 A2 也不包含在 TE-11 中。

## 协议

`GET /execution/v2/events` 保持 `afterCursor` 和 NDJSON 事件结构，增加以下固定头。Agent 与 Worker 必须来自同一安装产物，成对升级；不支持一端旧版的静默兼容。

|位置|字段|含义|
|---|---|---|
|请求和响应|`x-himawari-events-pagination: 1`|明确使用分页版本 1|
|响应|`x-himawari-events-page: more` 或 `complete`|当前页之后是否还需要请求|
|非空响应|`x-himawari-events-next-cursor`|最后一条事件 `payload.cursor` 的 `encodeURIComponent` 值|

服务端按完整序列化行（包含换行）的 UTF-8 字节数组页；每页正文不超过既有 `maximumBodyBytes`。不能把一条事件拆开。恰好达到上限的完整事件允许发送；单条本身超限则拒绝。空页只能是 `complete`，且不能携带 next-cursor。服务端拒绝重复游标及与请求位置相同的游标。

客户端仍暴露 `events(afterCursor)` 异步迭代器，内部按需逐页读取，不预取下一页。先验证整页的格式、版本、结束标记和游标，再交给调用者。它记住初始位置及本次迭代所有已读游标，拒绝页内和跨页重复，并核对响应头等于末条事件游标的编码值。

一次迭代的所有页面共享原 `requestTimeoutMs` 总期限，调用者处理事件的时间也计入；下一页只能使用剩余时间。通用 UDS 客户端仅允许缩短单请求期限。迭代器 `return` 或 `throw` 会取消等待中的 HTTP 请求；提前退出不会继续请求后页。现有身份认证、正文大小检查保持不变。

环境操作结果轮询 A1 每次独立 `result()` 从 null 开始，同一次等待读过的全部事件均推进游标，包括与当前操作无关的事件。后续轮询从最后位置继续；匹配仍核对请求、因果、关联、操作和 scope，不能仅靠游标接受结果。

## 错误处理

缺少请求分页版本返回 400；单事件超限返回 413 / `EXECUTION_UDS_BODY_TOO_LARGE`。缺失或错误的响应分页版本、页标记、非法正文以及不一致游标均拒绝交付，不将截断内容当作成功。不要通过提高正文上限或延长期限规避错误。

A1 将非 `RemoteExecutionBackendError` 的读取异常归为 `EXECUTION_ENVIRONMENT_RESULT_UNKNOWN`，匹配的 Worker 失败码保留。修改前原始传输异常向上传播，环境协调器的能力查询将其归为不可用，创建将其记为响应丢失并检查实际环境，停止将其归为未确认。修改后仍走这些失败路径，不把传输异常视为成功。

## 验证与限制

验收包括：累计历史超限而单条合法；UTF-8 与字节边界；空尾页、缺页、错误版本；页内/跨页重复及不推进游标；中途失败；总期限；等待中取消和提前退出；环境轮询推进、未知错误与明确失败。精确故障窗口通过真实 UDS 的合同测试和受控环境操作测试覆盖，不用模拟传输绕过正文限制。

真实安装必须在同一服务保留前置调用后连续读取 30 次，独立读回每次完成、认证释放和唯一模型消费，并保留完整报告、数据库和服务日志。已运行证据与可复跑命令见 [TE-11 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te11-verification.md)。该局部场景通过不代替整轮最终无筛选 Mac 产品资格及性能验收。

升级操作参见[安装与启停](../../runbooks/install-start-stop-runbook.md#procedure)和[Hermes 升级](../../runbooks/hermes-control-center-upgrade-runbook.md#procedure)。协议变更没有数据库迁移，不授权生产升级或重启。
