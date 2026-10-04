---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-10-04"
---

# 准备登记确认丢失后的启动与停止仲裁

Codex 根据用户 G39 独立规划授权，自审本方案。本文规定 R2-D4 的内部修复；实施和运行证据另行记录，方案批准不代表测试通过。

## 阅读导航

- [目标与来源](#目标与来源)
- [方案选择](#方案选择)
- [数据和执行顺序](#数据和执行顺序)
- [重复调用与中断](#重复调用与中断)
- [兼容和权限边界](#兼容和权限边界)
- [验收](#验收)

## 目标与来源

Agent 已持久接受准备控制登记、Worker 未收到确认且尚未取得启动权时，停止流程必须能够禁止晚到的 Worker 创建 Host。Agent 独立读回禁止启动记录后，才可以释放预留并交付一次 `SANDBOX_TOOL_NOT_STARTED`。确认消息缺失本身不能作为未启动证明。

来源：[准备控制恢复设计](2026-09-28-sandbox-preparation-control-recovery-design.md#第二轮-a2准备登记之前的封锁) [SOURCE: docs/execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md]、[确定结果恢复合同](2026-09-28-sandbox-tool-result-resumption-design.md) [SOURCE: docs/execution/specs/2026-09-28-sandbox-tool-result-resumption-design.md]、[工具执行排查计划](../plans/2026-09-28-tool-execution-audit-plan.md) [SOURCE: docs/execution/plans/2026-09-28-tool-execution-audit-plan.md]。

## 方案选择

| 方案 | 可以覆盖的条件 | 未覆盖的条件和代价 |
| --- | --- | --- |
| 重复发送原准备登记 | 后续确认成功时，Worker 可以继续正常准备 | 持续丢失确认仍无法释放；失败业务请求不能自动重放 |
| 新增一次启动许可 RPC | 收到许可的 Worker 才准备 Host | 许可确认仍会丢失，把原问题移到第二次 RPC |
| 共用一份不可覆盖的启动决定 | 禁止启动先写入时，晚到确认不能启动；启动先写入时保留原 Host 认证路径 | 增加一个有版本的私有文件协议；取得启动权后、创建 Host 前的崩溃仍保持 UNKNOWN |

选择第三项。两个进程在同一个私有控制目录内，使用同一个文件名争用一次启动决定。不存在重放工具或重新获得执行权限的路径。

## 数据和执行顺序

新建 SRT 计划冻结 `preparationProtocol: "launch-or-block.v2"`。已有 `register-before-host.v1` 与没有字段的计划保留原值，不补写或自动升级。

`runtime-sandbox` 提供共用的私有文件协议实现。Worker 的 SDK 入口只负责申请启动；Agent 的 `control` 入口只负责禁止启动和读回，不引入 SRT 或启动代码。

决定绑定完整 Job 身份、环境、语义指纹、执行租约、协议、准备登记的 policy digest、控制 session，以及目录设备和 inode。正文用原控制 token 作 HMAC 认证；文件不保存 token。决定只有两个分支：`launch`，或带原始 `stopRequestedAt` 的 `blocked`。

写者先在经过验证的 0700、当前用户拥有、规范且非符号链接目录中创建独占 0600 临时文件，写完整正文并同步文件，再用不覆盖已有目标的硬链接发布到固定名称，移除自己的临时文件，最后同步目录。两个写者竞争同一个目标，只有一个发布成功。读取只接纳完整、大小受限、当前用户拥有的普通文件，拒绝符号链接、目录变化、错误 HMAC 和身份变化。

Worker 在发送原准备登记前固定控制目录设备和 inode；后续申请必须与该原目录一致。Worker 在原准备登记 RPC 成功后、`prepareSandboxJobHost` 之前申请 `launch`。只有本次发布成功可以创建 Host；已有 `launch` 不授权第二次创建。已有 `blocked`、校验失败、取消或期限到达均不得创建 Host。

Agent 在预留已被原停止时间中断后，验证原准备登记、安装 Host 和机器 boot。对新协议计划，若还没有完整 Host 控制登记，先申请 `blocked`。禁止启动成功后，在原 Run 的受保护 trace Artifact 中写入不可变禁止启动证据。验证释放时必须再次读回目录、原登记、禁止启动文件和保护 Artifact；不只相信停止方法返回成功。

新释放依据为 `preparation_launch_blocked`。SQLite 在原释放事务内核对 SRT、新协议、reserved、没有 `started_at`、原停止时间、同 Run trace Artifact 的唯一 key、Payload ref 和 digest，以及既有 authority、lease、recovery revision 条件。共享的 TypeScript 和 SQL“确定未启动”判断接纳这个依据，交付仍沿用既有固定失败和一次交付合同。数据库结构不变。

## 重复调用与中断

- 禁止启动重复调用只接受同一原停止时间和相同绑定；保护 Artifact 原 key、正文和 digest 不变。
- Agent 发布禁止启动后、保存 Artifact 前崩溃：后续恢复读回相同禁止启动文件并补存同一 Artifact，Worker 仍不能启动。
- 释放事务回滚：禁止启动文件和保护 Artifact 保留；占用和释放 receipt 保持原子事务结果，下一次恢复重新验证。
- Worker 取得启动权后崩溃、尚无 Host：不能推断未启动，保持 UNKNOWN 和占用。禁止启动不能覆盖已经发布的启动决定。
- 任一确认晚到：Worker 必须读取决定；原期限、取消和 authority 门禁仍生效。
- 跨机器 boot、目录替换、错误控制身份、错误租约或错误 digest：禁止释放，保留诊断和占用。

## 兼容和权限边界

旧 Worker 的严格计划解析拒绝新协议，发生在创建 Host 前。新 Worker 保留旧协议的原执行路径；旧已登记而确认丢失的计划仍不能使用新释放依据。准备登记之前的原封锁同时支持两种已知协议，语义仍是登记未获准。

禁止启动只属于当前 Run 的原控制目录，不能跨环境或跨 Run。恢复不能使用过期 Grant 来执行工具；安装 Host 身份检查沿用现有独立清理权限。Himawari 负责准备授权、持久证据和一次交付；Pi 的工具调用与 Agent Loop 保持原职责，无新 Pi 实现或依赖。

## 验收

先通过现有安装产品路径注入“Agent 实际接受登记后，确认丢失”，从公开聊天入口触发一次读取并保留 SQLite、服务日志和模型请求读回。修复前应因没有释放证明而不能完成；修复后须在原 Run 期限前完成、无 Host 启动、无操作 intent、占用释放、单次固定失败交付。

针对产品路径难以稳定调度的原子竞争，用真实文件、真实 SQLite 和公开停止/释放入口补测：停止先赢阻止后续启动、启动先赢拒绝无 Host 释放、同时竞争只有一个决定、Agent 重建和释放回滚、重复启动申请不获得权限，以及身份、目录、HMAC、旧协议反例。测试先于对应生产实现。

Worker 生命周期测试另行控制准备登记回复的顺序：先在真实控制目录发布禁止启动，再返回原登记确认，断言 Worker 不调用 Host 创建、不绑定执行，重复执行也不重新登记。这里复用真实启动决定实现，仅替代 Host 创建这个进程边界；它覆盖安装路径的确认丢失异常无法稳定触发的迟到确认。

在 Hermes 运行第 0–2 层；因为改变 Agent/Worker 内部协议，D4 提交前还需第 3 层。运行受影响 Linux 产品路径，不放宽任何期限或测试时限。Mac 和生产平台仍未验证。
