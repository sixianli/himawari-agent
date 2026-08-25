---
status: "archived"
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# Himawari Agent 基础平台设计 Spec

## Goal

定义 Himawari Agent 第一阶段可实施、可验证的产品基础：一个无头、单一逻辑权威的私人 Agent 服务，通过产品自有运行时端口使用 Pi，并贯通触发、上下文、记忆、模型、工具授权、Trace、主动结果和多客户端事件流。

本 Spec 不是实施 Plan。它已于 2026-08-25 由所有者确认，可以据此创建文件级 Implementation Plan。

## Source Context

- Product requirements: [SOURCE: docs/prd-v0.1.md]
- Pi runtime boundary: [SOURCE: docs/adr/0001-pi-runtime-adapter.md]
- Headless gateway: [SOURCE: docs/adr/0002-headless-agent-gateway.md]
- Single authority: [SOURCE: docs/adr/0003-single-logical-agent-authority.md]
- Authorization: [SOURCE: docs/adr/0004-deterministic-authorization.md]
- Memory boundary: [SOURCE: docs/adr/0005-replaceable-memory-boundary.md]
- Agent topology: [SOURCE: docs/adr/0006-primary-agent-scoped-workers.md]
- Model routing: [SOURCE: docs/adr/0007-policy-controlled-model-routing.md]
- Capability governance: [SOURCE: docs/adr/0008-governed-capability-registry.md]
- Self-modification trust root: [SOURCE: docs/adr/0009-protected-agent-trust-root.md]
- Session Trace: [SOURCE: docs/adr/0010-complete-session-trace.md]
- Service boundaries: [SOURCE: docs/adr/0011-composable-service-boundaries.md]
- Deployment: [SOURCE: docs/adr/0012-portable-local-first-deployment.md]
- Domain identity model: [SOURCE: docs/adr/0013-agent-thread-run-memory-model.md]
- Attention policy: [SOURCE: docs/adr/0014-central-attention-policy.md]
- Product state authority: [SOURCE: docs/adr/0015-product-state-over-pi-runtime-projection.md]
- Runtime language: [SOURCE: docs/adr/0016-typescript-node-runtime.md]
- Repository organization: [SOURCE: docs/adr/0017-workspace-monorepo.md]

当前仓库只有 Git 元数据和文档治理说明，没有已实现系统，因此尚不创建 Architecture 文档。第一批代码成为当前事实后，再创建 `architecture-v0.1.md` 描述真实实现。

## Scope

### Included

- 产品核心的依赖方向、逻辑服务边界和本地组合部署方式。
- Owner、Agent、Thread、Run、Turn、Trigger、Approval、Grant、Capability 和 Trace 的身份及关联语义。
- 所有用户消息、定时器和外部事件统一进入的触发信封。
- 产品状态权威来源与 Pi 运行时投影之间的提交边界。
- 产品自有 Agent Runtime 端口及 Pi 适配器的输入、事件和错误映射。
- 记忆、模型、授权、能力、秘密、注意力和 Trace 的产品端口。
- 一次外部副作用行动从模型提议到人工审批和结果对账的状态机。
- Session Trace 的事件信封、因果关系、敏感数据处理和删除传播。
- 单进程本地组合配置，以及以后拆分服务时不能改变的语义。
- “牛肉餐厅”端到端架构基准的可测试版本。

### Excluded

- 选择或实现具体长期记忆产品。
- 选择最终数据库、事件总线、云厂商、模型提供商或秘密管理产品。
- 创建正式网页、macOS、移动或语音 UI。
- 生产部署、高可用切换和灾难恢复 Runbook。
- 开放第三方插件市场或允许下载后自动执行代码。
- 购买、支付或其他不可逆高风险能力的正式启用。
- 完整实现所有“牛肉餐厅”外部供应商；首条基准允许使用确定性适配器或受控测试替身验证产品语义。

## Acceptance Criteria

### Product boundary

- Given 任意客户端发送一个带幂等键的用户触发，when 权威服务接收两次相同请求，then 只创建一个 Run，并向两个调用返回同一结果引用。
- Given 两个客户端打开同一 Thread，when 其中一个客户端启动 Run，then 两端看到同一有序事件流，而不是各自启动 Agent。
- Given 权威租约不属于当前节点，when 节点收到会改变长期状态的命令，then 命令被转发、拒绝或排队，不能在本地独立提交。

### Pi isolation

- Given 产品启动一次 Agent Run，when Pi 执行模型和工具循环，then 产品领域层只看到产品自有事件和错误，不出现 Pi 类型。
- Given Pi 发布版本升级，when 适配器通过兼容性测试，then Gateway、领域对象和持久化契约无需随 Pi 类型改变。
- Given Pi 默认支持项目资源发现和编码工具，when Himawari 创建运行时，then 未经能力注册表批准的工具、Skills 和 Extensions 不会自动启用。

### Memory and models

- Given 新 Thread 中的“今天想出去吃饭”，when 上下文构建完成，then 相关记忆候选、最终选中内容和注入位置都产生 Trace 事件。
- Given 路由策略为任务选择模型，when 调用开始，then Trace 记录路由理由、数据等级、模型身份和允许的披露范围。
- Given 首选模型失败，when 备用模型会降低隐私等级，then Run 停止或等待批准，不能静默降级。

### Tools and approval

- Given 模型提出只读、范围明确且命中允许策略的行动，when 授权组件评估，then 工具可以执行并记录 `ALLOW` 依据。
- Given 行动需要确认，when 没有可用 UI，then Run 进入等待审批状态并可安全恢复，不能自动执行。
- Given 所有者批准一个语义行动，when 底层需要多次工具调用，then 仅在批准的资源、费用、期限和副作用范围内执行；任何变化都产生新的审批请求。
- Given 同一个不可幂等外部行动出现超时，when 系统无法确认结果，then 状态为待对账而不是盲目重试。

### Trace and secrets

- Given 任意完成或失败的 Run，when 所有者查看 Session，then 可以沿父子和因果关系查看触发、记忆、模型、工具、审批、状态提交和通知过程。
- Given 工具使用 API Key，when Trace 事件写入，then 事件只包含秘密引用、版本和用途，不包含秘密原值。
- Given 所有者删除一个 Session，when 删除流程完成，then 正文、模型负载、工具结果、索引、缓存和归档内容不可再读取，只保留最小删除墓碑。

### Reference journey

- Given “喜欢吃牛肉”已成为长期记忆，when 所有者在新 Thread 中询问外出吃饭，then Agent 主动使用该记忆形成建议。
- Given Agent 建议创建餐厅监控任务，when 所有者批准长期授权，then后续定时触发可以在范围内执行而不重复询问。
- Given 结果属于非紧急信息，when 注意力策略评估，then 结果进入收件箱、摘要或普通通知，而不是未经授权立即打断。
- Given 所有者随后要求预订，when 行动具有外部副作用且未被长期授权覆盖，then 系统在执行前请求语义级批准。

## Design

### Design principles

1. 产品领域状态、授权和协议不依赖 Pi 内部类型。
2. 模型提出建议，确定性组件决定权限、状态提交和通知交付。
3. 所有触发来源进入同一个运行管线。
4. 业务状态、完整 Trace 和被动诊断遥测是三个不同概念。
5. 进程内调用与远程调用遵守相同应用契约。
6. 任何可重试操作都必须有幂等或对账语义。
7. 凭证明文永不进入模型可见上下文或持久化 Trace。

### System context

```text
Clients and trigger adapters
          │
          ▼
    Agent Gateway
          │
          ▼
  Agent Control Plane ──────────────── Trace and Audit
     │       │       │                         ▲
     │       │       └── Attention Policy ─────┘
     │       ├────────── Scheduler and Events
     │       └────────── Permission and Grants
     ▼
  Run Coordinator
     │
     ├── Memory Port ───── Memory adapter
     ├── Model Router ──── Model runtime adapter
     ├── Capability Port ─ Execution workers and sandboxes
     ├── Secret Port ───── Secret vault
     └── Agent Runtime ─── Pi coding-agent adapter
```

箭头表示调用或事件方向，不表示必须跨网络。可信组件在本地配置中可以同进程组合；执行不可信代码的 Worker 和 Secret Vault 始终保持独立信任边界。

### Component responsibilities

| Boundary | Owns | Must not own |
| --- | --- | --- |
| Agent Gateway | 客户端认证后的命令、查询、流式订阅、协议版本和幂等入口 | 模型选择、权限判断、长期状态业务规则 |
| Agent Control Plane | Agent、Thread、Run、授权、目标和权威协调 | Pi 内部 Session 格式、供应商凭证原值 |
| Run Coordinator | 一次 Run 的状态机、上下文形成、运行时调用、暂停与恢复 | 跨 Run 的长期业务真相 |
| Permission and Grants | 行动分类、`ALLOW/ASK/DENY`、审批、长期授权和撤销 | 模型推理和工具实现 |
| Memory Port | 产品级检索、写入建议、纠正、删除和来源语义 | 供应商专有存储对象 |
| Model Router | 候选模型、数据等级、路由、降级和调用计量 | 主 Agent 的业务授权 |
| Capability Registry | 能力来源、版本、完整性、权限声明和生命周期 | 运行中自行批准权限扩大 |
| Execution Plane | 在授予的能力范围内执行工具和工作单元 | 长期授权和所有者身份真相 |
| Attention Policy | 结果优先级、去重、安静时间、频率和交付请求 | 客户端特有渲染 |
| Trace Store | 完整可观察事件、因果关系、归档和删除状态 | 凭证明文、业务状态写入决策 |
| Audit Ledger | 状态变更、审批和外部行动的最小不可篡改记录 | 完整模型负载和秘密 |
| Secret Vault | 凭证原值、版本、受限使用和撤销 | 模型上下文或通用日志 |

### Dependency direction

产品领域定义身份、状态和不变量。应用层编排用例并依赖端口。Pi、记忆供应商、模型供应商、数据库、消息系统和 UI 都是端口外侧的适配器。

允许的依赖方向为：

```text
entrypoints/adapters → application → domain
infrastructure adapters → application ports
Pi adapter → Agent Runtime port + Pi packages
```

领域层和应用用例不能导入 Pi、数据库驱动、Web 框架或 UI 类型。

### Core identities

| Identity | Authority and lifetime |
| --- | --- |
| Owner | 私人 Agent 的唯一所有者和最高授权主体 |
| Agent | 长期存在；关联所有者、策略版本和当前权威租约 |
| Thread | 长期或可关闭；保存一项对话或任务的短期上下文边界 |
| Session | 面向交互与 Trace 的连续活动视图，可关联一个 Thread 和多个 Run |
| Run | 一次触发导致的推理、工具和状态提交；具有终态 |
| Turn | Run 中一次模型响应以及其工具调用和结果 |
| Trigger | 导致 Run 的用户消息、定时器或外部事件；必须可去重 |
| Worker Run | Run 的受限子运行；继承 Trace 关系，不继承未委派权限 |
| Approval Request | 一个等待人类判断的语义行动快照 |
| Grant | 一次性或长期授权；包含范围、期限、预算和撤销状态 |
| Capability | 可调用能力的版本化声明，不等同于一次授权 |

身份必须使用不依赖数据库或传输的稳定标识。显示名称可以改变，标识不能因部署迁移而改变。

### Trigger admission

所有触发适配器提交统一语义：触发标识、幂等键、所有者、Agent、来源、发生时间、数据等级、可选 Thread、负载引用和来源证明。

接收流程：

1. 验证来源主体是否有权触发目标 Agent。
2. 使用幂等键去重。
3. 确认当前节点持有 Agent 权威租约。
4. 创建或关联 Thread 和 Session。
5. 创建 Run，并立即写入首个 Trace 事件。
6. 把 Run 交给 Run Coordinator。

触发负载中的大型或敏感内容使用受访问控制的 Payload 引用；事件信封不重复嵌入全部内容。

### Run state machine

```text
accepted
  → building_context
  → running
  → awaiting_approval ── approved → running
                       ├─ denied ──→ cancelled
                       └─ expired ─→ cancelled
  → reconciling_external_result
  → completed | failed | cancelled
```

Run 可以多次进入 `awaiting_approval`。暂停前必须持久化恢复所需状态，不能依赖进程内 Promise。`completed` 只表示该 Run 结束，不表示通知已经被所有客户端交付。

### Context formation

Run Coordinator 从产品状态构建上下文：

1. Thread 的有效消息和压缩摘要。
2. 当前触发负载。
3. Owner 和 Agent 的适用策略。
4. Memory Port 返回的候选记忆及来源。
5. 根据数据等级和预算选择的最终记忆片段。
6. 本 Run 可用的能力清单和授权摘要。

候选检索、筛选理由和最终注入内容分别记录，防止只能看到最终 prompt 而无法判断检索发生了什么。记忆写入由 Run 完成后的产品策略决定；Pi 运行时不能直接写供应商记忆后端。

### Agent Runtime port

产品运行时端口接收一个已准备好的运行请求，包含稳定的模型路由结果、系统指令、消息、允许能力、运行预算、Trace 上下文和取消信号。它以产品事件流返回：模型开始和增量、工具意图、工具结果、Turn 完成、Run 运行时完成和错误。

端口不暴露 Pi 的 `AgentSession`、`AgentEvent`、`Model`、`ToolDefinition` 或 Session 文件路径。Pi 适配器负责双向映射，并把无法无损映射的上游变化转化为显式兼容性错误。

### Pi coding-agent adapter

首个适配器使用 `createAgentSession()` 和 `AgentSession`，原因是它已经整合模型运行时、会话生命周期、上下文压缩、工具、Skills 和 Extensions。适配规则如下：

- 默认编码工具不自动启用；运行时只注册 Capability Registry 为本 Run 授权的工具包装器。
- 默认项目资源发现不成为产品能力安装渠道；ResourceLoader 只能加载经过注册和批准的资源。
- 产品 Model Router 先选择模型和数据策略，再由 Pi ModelRuntime 完成具体提供商调用。
- 产品从 `AgentSession.subscribe()` 和扩展事件获取模型、消息、工具和 settled 生命周期信号。
- Pi 的工具前置钩子和 `tool_call` 事件是 Permission 结果的最终运行时执行点，不是授权事实来源。
- provider request/response 钩子用于记录实际发送和收到的可观察信息；写入前执行秘密和敏感字段处理。
- Pi 的 context 变换可用于执行期消息转换，但长期记忆检索和选择由产品 Context Builder 完成。
- Pi Telemetry 用于被动性能诊断；产品 Trace 另外持久化。
- Pi experimental protocol/client/server 不作为 Agent Gateway。
- 当前仍包含未实现路径的 AgentHarness 不作为第一阶段产品入口。

### Product state and Pi projection

产品状态是唯一业务事实来源，Pi Session 是一次 Run 的受控运行时投影。

产品提交协议至少保证：

- Run 状态改变与对应业务事件原子可见。
- 工具结果先形成 Trace，再影响下一次模型上下文。
- Pi 返回的消息、压缩摘要和工具结果只有通过产品提交协议后才成为 Thread 当前状态。
- 进程崩溃后恢复依据产品 Run 状态和事件，不依据某个进程遗留的 Pi Session 文件。
- 外部副作用使用幂等键或进入待对账状态，不能因恢复而盲目重复。

具体数据库和消息系统保持未定，但适配器必须提供事务性状态写入和可靠事件发布语义；可以通过事务性 outbox、等价原子日志或其他可验证机制实现。

### Authorization and tools

模型产生的是 Action Intent，而不是直接执行权。Intent 至少描述能力、操作、目标资源、数据等级、预期副作用、费用和频率估计、幂等键以及是否可撤销。

Permission 评估返回：

- `ALLOW`：附带命中的策略或 Grant，以及精确执行范围。
- `ASK`：创建 Approval Request，冻结待批准的语义行动快照。
- `DENY`：记录规则、原因和是否允许提出替代方案。

批准后签发仅对该 Action Intent 或长期授权范围有效的临时能力。工具包装器在执行前再次验证能力、当前时间、资源、预算和撤销状态。模型不能看到可以复用的原始凭证。

### Capability execution

Capability Registry 区分声明、安装和授权：

1. 声明描述能力及所需权限。
2. 安装确认来源、版本、完整性和隔离方式。
3. 授权决定某个 Owner、Agent、任务或 Run 可以怎样使用它。
4. 执行获得短期、范围受限的能力句柄。

本地可执行代码和不可信 MCP Server 默认位于独立 Worker 或沙箱。纯远程 API 也必须通过统一包装器，以获得同样的授权、Trace、超时和错误语义。

### Model routing

模型路由分为两步：

1. 策略阶段根据任务能力、数据等级、可用性、延迟和费用产生允许候选及不可降级约束。
2. 执行阶段从允许候选中选择具体模型，并固定本次调用的提供商、模型、版本和披露范围。

主 Agent 的最终回答默认回到主要推理模型。专业 Worker 可以使用其他模型，但只能获得委派上下文。重试和备用选择必须产生独立模型调用事件。

### Session Trace model

每个 Trace 事件至少包含：事件标识、schema 版本、Session、Agent、可选 Thread、Run、Turn、父事件、因果事件、相关事件、严格单调的 Run 内序号、事件时间、写入时间、主体、数据等级、事件类型和负载引用。

主要事件族：

- trigger admission and deduplication
- context and memory retrieval
- model routing, request, streaming, response and retry
- worker delegation and settlement
- tool intent, authorization, execution and reconciliation
- human approval request and response
- state commit and outbox publication
- attention decision and delivery
- cancellation, failure, compensation and deletion

模型 prompt、完整工具结果等大型负载进入加密 Payload Store，事件只持有内容寻址或不可猜测引用。Trace 查询在授权后组装时间线。删除流程清理 Payload、搜索索引、缓存和归档；Audit Ledger 保留最小墓碑。

### Secret handling

Secret Vault 返回受限操作能力或短期句柄，而不是把原值交给模型。若第三方 SDK 只能接收原始凭证，凭证只在受信任执行适配器内存中解析，并禁止进入事件、异常文本和通用日志。

Trace redaction 是写入前的强制步骤。若无法确认负载不含秘密，事件写入失败必须阻止敏感负载持久化，但不能吞掉业务操作结果；系统记录一个不含原负载的 redaction failure 安全事件。

### Attention flow

Run 完成后产生 Result Candidate。Attention Policy 结合任务授权、紧急度、置信度、重复键、安静时间、设备状态和频率预算生成 Delivery Request。

交付失败不回滚已完成 Run；Delivery Request 独立重试并在所有客户端间去重。`INTERRUPT` 必须携带命中的明确授权依据。

### Deployment profiles

本地组合配置允许 Gateway、Control Plane、Run Coordinator、Memory/Model/Trace 适配器在一个受信任前台进程内运行。Execution Worker 和 Secret Vault 保持可隔离。

云端配置可以分别扩展 Gateway、Control Plane、Worker、Scheduler 和 Trace Store，但必须保持：

- 同一个 Agent 的单一逻辑权威。
- 相同命令和事件语义。
- 相同授权和秘密边界。
- 相同 Session Trace 可见性。
- 相同幂等和恢复要求。

### Reference journey trace

“牛肉餐厅”基准至少产生以下可关联事件：

1. 偏好记忆写入及来源。
2. 新 Thread 用户触发。
3. 记忆查询、候选和选择。
4. 主模型路由和回答。
5. 持续任务建议。
6. 人工批准和长期 Grant。
7. Scheduler 触发。
8. 研究 Worker 委派。
9. 搜索或地图工具授权与结果。
10. Attention Policy 决策和交付。
11. 预订 Action Intent。
12. 人工审批、Secret 使用和外部结果对账。
13. 另一个客户端继续同一 Thread 并读取完整 Trace。

## Error Handling

### Admission and authority

- 重复触发返回已有 Run，不创建第二个副作用链。
- 权威租约缺失时不执行写入或工具；返回可重试的非权威结果。
- 身份或授权验证失败时不暴露 Agent 是否存在以外的敏感信息。

### Runtime and models

- Pi 适配器映射失败属于兼容性错误，停止 Run 并保存安全诊断，不把未知 Pi 对象写入产品状态。
- 模型流中断时记录已观察到的增量和失败；只有满足路由与隐私策略时才重试。
- 上下文过长时可以使用受控压缩，但压缩输入、输出和适用范围必须可追踪。

### Tools and external effects

- 工具参数验证失败不进入执行阶段。
- Permission 组件故障采用 fail-closed；需要确认或未知行动不得执行。
- 可幂等行动按稳定键重试；不可幂等行动超时进入 `reconciling_external_result`。
- Worker 崩溃不会扩大权限，恢复后重新验证临时能力是否仍有效。

### Persistence and Trace

- 业务状态已提交但事件未发布时，由可靠发布机制补发，不能重新执行业务行动。
- Trace Payload 写入失败时保留不含敏感负载的结构化失败事件，并明确标记 Session 细节不完整。
- 删除过程中部分存储失败时，删除状态保持未完成并持续重试；UI 显示尚未验证清理的存储范围。

### Human-in-the-Loop

- 审批超时、撤销或用户拒绝都形成明确终态。
- 审批后的 Action Intent 若目标、费用、范围或数据等级变化，旧批准失效并创建新请求。
- 没有 UI 的 `ASK` 只能排队，不能由模型替用户回答。

## Verification Strategy

未来 Plan 必须包含以下验证层次：

### Contract verification

- TypeScript 编译验证领域层不依赖 Pi、Web 框架或基础设施类型。
- Agent Runtime 适配器契约测试覆盖所有 Pi 事件、错误和取消映射。
- Gateway 命令和事件 schema 兼容性测试。
- Memory、Model、Capability、Secret 和 Attention 端口的适配器契约测试。

### State-machine verification

- Run 所有合法和非法状态转换。
- `ALLOW/ASK/DENY`、审批、过期、撤销和恢复。
- 单一权威租约丢失、切换和重复命令。
- 不可幂等外部行动的未知结果与对账。

### Security verification

- 未批准能力无法进入 Pi 工具清单。
- Tool preflight 在策略故障时 fail-closed。
- 模型输入、Trace、错误和普通日志中不存在凭证明文。
- Worker 只能读取委派的数据和短期能力。
- 模型降级不会违反数据等级约束。

### Trace verification

- 每个基准 Run 的事件序号、父子、因果和相关关系完整。
- 模型重试、工具失败、审批等待和 Worker 委派可从 Trace 还原。
- Session 删除覆盖正文、Payload、索引、缓存和归档，并留下最小墓碑。
- Pi Telemetry 缺失或 exporter 故障不会改变业务行为或产品 Trace。

### End-to-end verification

- 使用确定性模型和工具替身完整运行“牛肉餐厅”基准。
- 从两个客户端测试适配器订阅同一 Thread 和 Run。
- 在审批等待、工具执行后、状态提交后和通知交付前分别模拟进程崩溃并验证恢复语义。
- 对 `pi-coding-agent` 固定版本运行兼容性测试，并对相邻源码调试配置运行一次非发布验证。

### Documentation gate

- 本 Spec 已于 2026-08-25 获得所有者确认。
- ADR 0015、0016 和 0017 已于 2026-08-25 被接受。
- 之后才从 Plan 模板创建实施 Plan。
- 代码落地后创建或更新 Architecture，只描述已验证的当前状态。
- 运行 `document-governance` 严格验证并解决全部错误。

## Confirmation

- Confirmed by: Owner
- Confirmed on: 2026-08-25
- Confirmed scope: 本 Spec 的设计、验收边界和验证策略，以及 ADR 0015、0016、0017。
