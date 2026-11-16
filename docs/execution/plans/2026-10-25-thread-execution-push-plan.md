---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-10-25"
---

# 对话执行状态改为服务端推送实施计划

依据规格 [对话执行状态改为服务端推送](../specs/2026-10-25-thread-execution-push-design.md) [SOURCE: docs/execution/specs/2026-10-25-thread-execution-push-design.md]（用户 2026-10-24 已批准）。一个提交完成，提交信息写明实际跑过的测试层。

## 阅读导航

- [步骤](#步骤)
- [测试](#测试)
- [文档](#文档)
- [交付](#交付)

## 步骤

1. 应用层到期时刻：在 `packages/application/src/services/thread-execution-resources.ts` 导出 `nextThreadExecutionResourceChangeAt(inventory, now)`，取清单里晚于当前时间的最早到期时刻。
2. 应用层观察：`ThreadExecutionProjection.observe` 返回某个 Run 的观察指纹（Run revision 与状态、最大执行记录序号、资源清单指纹、检查点指纹、下一个到期时刻、是否已稳定）。执行记录序号只读 Trace 行，不解密载荷；只有清单指纹变化时才计算资源投影。
3. 协议：`packages/gateway-contracts/src/thread-contracts-v3.ts` 新增 `thread.execution_events` 订阅与 `thread.execution_changed` 事件；`ThreadGatewayEvent` 收窄为 `thread.event`，新增对应类型。
4. 端口与服务：读模型和 Agent 网关端口新增可选的 `watchExecution`；`AgentThreadGatewayService` 授权订阅并在每次推送前复核；`ProductThreadGatewayAdapter.watchExecution` 按规格的节奏观察并推送。
5. HTTP：`/api/gateway/thread/v3/execution-events` 路由与 SSE 序列化，运行时配置新增 `executionEventsAvailable`；生产组合打开它。
6. 页面：三个事件流（网关 v2、对话事件、执行变化）共用一个断线重连基类 `ReconnectingEventStream`，新增 `ThreadExecutionSynchronizer`；`useThreadControlCenter` 删除 2 秒定时刷新，新增执行增量读取和对话事件增量读取；`ThreadSseSynchronizer` 把事件的 `threadId` 交给页面；`app.tsx` 按事件类型分发。

## 测试

- 单元：资源到期时刻；执行观察指纹；网关服务的执行流授权；HTTP 执行流序列化；两个同步器；页面交互（无运行时零查询、按 Run 增量、按对话增量、重连补读）。
- 集成：现有 SQLite 组合测试（对话网关、执行投影）覆盖协议类型收窄后的行为；执行观察的节奏和指纹由单元测试用替身覆盖。
- 构建：`build:browser` 的 150/180 KiB 体积门槛不放宽，新增代码靠合并重复逻辑抵消。
- Hermes：第 0–2 层；协议变化单独跑第 3 层；第 4 层受影响场景。

## 文档

- 侧栏规格 `docs/execution/specs/2026-09-13-control-center-sidebar-design.md` 改写后台刷新描述。
- `docs/runbooks/hermes-control-center-upgrade-runbook.md` 里“当前可见会话每两秒重新只读核验”改为推送描述，核对其他引用本次源码的 Runbook。
- Backlog `BL-20261025-001`。

## 交付

推送到线程分支 `claude/project-thread-xf52vt`，不开 PR；Hermes 结果和生产上线另行报告。
