---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0025-pi-tools-and-managed-execution-lifecycles.md"
date: "2026-09-07"
---

# ADR 0024：通过 SRT 统一宿主执行边界

## Context

Owner 否决继续建设签名 Mac 文件访问 helper，要求采用 Sandbox Runtime，让 Agent 不必针对 macOS 与 Linux 维护执行业务逻辑。现有代码分别存在 Capability program/stdio MCP 隔离和工作区命令沙箱；只替换读文件入口会保留多套生命周期与旁路。

SRT `0.0.75` 提供跨平台受限进程启动，但 manager 具有进程级共享状态，Mac/Linux 仍有不同实现与保证。ADR 0022 要求的 Mac 原生 helper/Apple container 双层路线和禁止生产使用 sandbox-exec 的决定，与 SRT 在 Mac 上使用 Seatbelt 的路线存在实质冲突，不能把新方案描述为等价替换名称。

Owner 已确认 SRT 方向和首批产品范围：文件读取、原项目内编辑/写入/搜索、受限 Shell、MCP、授权联网、Web Search，以及向 GitHub 推送已有 commit。默认直接操作已授权的原目录，删除等高风险动作继续确认。实现方式由工程侧负责；本决定正式采纳，统一承接 ADR 0021 的平台隔离责任并替代 ADR 0022 的 Mac 分层路线，两份旧记录的当前替代指针均指向本文。历史上 ADR 0022 曾替代 ADR 0021，该过程及旧实现和验收事实保留在历史正文与引用中。accepted 表示采用该方向，不表示代码或真实平台验收已完成。

## Decision

1. Agent 与应用层只依赖产品执行合同。Pi 保留 AgentSession、工具工厂与 Operations，Himawari 保留授权、主机绑定、预算、持久状态、结果与披露。SRT 不成为第二套 Agent runtime。
2. 所有模型可触发的宿主文件、工作区命令、程序和 stdio MCP，经现有动作接纳、Capability 和 Worker 流程进入同一 `SandboxExecutionPort`。迁移后移除无调用方的旧执行分路，不保留未声明的 fallback。
3. 可信长驻 Execution Worker 监督作业；每作业独立可信 Node Job Host 使用一个固定 SRT manager/策略，再启动受限工具进程树。新权限必须经过产品审批并创建新作业，不就地修改共享策略。
4. 将 SRT 依赖集中在拟新增 `packages/runtime-sandbox`，只在 Job Host 内使用。平台差异限于该适配及主机监督/资格，业务层只接收稳定状态与保证集合。
5. 首批同时交付 `host-readonly.v1` 与授权项目执行能力，并支持经过授权的联网、依赖安装和下载。默认直接修改已授权原项目，独立工作区为可选模式。普通任务进程使用私有 HOME/tmp/cache，不继承宿主凭据；网络规则、项目授权、删除等高风险动作和数据披露分别检查。
6. 复用 ADR 0023 的通用 HITL 和持久恢复。新增作业、清理和核查子状态，但不另写一套审批或 Agent 状态机；副作用未知时不自动重放。
7. MCP、Web Search 和已授权 GitHub push 属于首批能力。复用现有 Web 搜索/页面读取端口和 MCP 协议客户端，补齐真实 provider、工具注册及生产组合。浏览器自动化与其他外部 API 分别定义实际执行边界；公共搜索不以控制日常浏览器为前提。首批必需能力未取得资格时必须报告该批交付未完成，不能静默移到后续范围。
8. 将 Mac 的目标隔离要求从原 VM/helper 分层改为经验证的 SRT 进程沙箱，明确共享宿主内核、上游 Beta 和平台差异。要求更强保证而 SRT/监督器无法满足的动作必须不可用，不能降低宣称的资源或网络保证以通过资格。
9. GitHub push 使用专用受治理动作，绑定具体仓库、目标分支及已有 commit OID，由可信凭据服务向专用 Git 传输委托最小权限短期凭据。模型、普通 Shell、工作区脚本和通用 MCP 不取得通用 token。保留 GitHub 监控的只读权限，写能力单独授权；不隐含授权实际推送本仓库、修改 GitHub App 权限、创建 commit、强推或发布。

## Options Considered

### 继续原生 helper 与 Apple container 双层路线

具有原方案的类型化入口及 VM 隔离价值，但需分别维护平台执行路径，且已被 Owner 否决为当前方向，不再作为本轮实现目标。

### 只给 bash 或文件读取加一层 SRT 命令包装

改动局部，但其他文件工具、MCP、Git 导入导出仍可能独立启动；launch-only 接口也不能持有 SRT 代理、清理和恢复生命周期，不采用。

### 将整个 Agent Service 放进 SRT

会混合模型密钥、产品数据库与不可信工具，持续变化的工具权限又要求更换策略；无法清楚隔离执行层与权威控制状态，不采用。

### 统一产品执行合同与每作业 SRT

复用成熟上游执行机制和 Pi 工具机制，把产品责任保留在现有系统中；代价是需要迁移全部可达执行入口、增加完整作业监督，并验证真实平台保证。采用这一目标设计。

## Consequences

- Agent 的工具业务逻辑不随 OS 改变；Worker 主机身份、远程路由和实际平台资格仍不可省略。
- 已完成的两阶段文件授权、保护结果及 Pi 恢复继续复用；原生产资格不会自动转成 SRT 资格。
- 当前签名 helper 占位、Mac tier 路由、Apple container 与自建 bwrap 后端在新调用方迁移完成后退出目标执行路径，历史结果与文档保留。
- 同一工作区初期串行，每作业重建 manager 有启动成本；正确隔离优先于共享实例优化。
- 直接操作原项目会真实修改用户工作树；必须保护已有改动，写前检查冲突，禁止自动回滚覆盖用户修改，删除及其他命中高风险策略的操作经过通用 HITL。
- 首批完成标准包括真实搜索来源、授权联网、本地 MCP 和 GitHub 已有 commit 推送；具体搜索 provider、GitHub 凭据来源及外部验收目标在实施时核实，不能用模拟响应代表交付。
- SRT 不提供完整 hard quota、绝对零外联或不可逃逸的 VM 保证。平台监督、数据保护和网络保证必须可验证，不满足要求时拒绝动作。
- 本 ADR 未改变代码、依赖、安装包或 Runbook 合同；不表示真实模型、Mac 文件和浏览器流程已验收。

## Links

- [SOURCE: docs/execution/specs/2026-09-07-srt-unified-execution-design.md]
- [SOURCE: docs/architecture-v0.1.md]
- [SOURCE: docs/adr/0021-platform-capability-runtime-isolation.md]
- [SOURCE: docs/adr/0022-mac-tiered-command-sandbox.md]
- [SOURCE: docs/adr/0023-durable-hitl-execution.md]
- [SRT 固定版本源码](https://github.com/anthropics/sandbox-runtime/tree/v0.0.75)
