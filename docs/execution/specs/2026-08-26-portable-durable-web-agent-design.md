---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 持久 Web 基础设计 Spec

## 目标

本 Spec 在已经完成的 Foundation 边界之上，设计 v0.2 的持久 Web 基础切片：把当前以进程内测试适配器为主的组合，推进为可真实启动、跨正常重启恢复、经公共 Web 安全访问，并可在 Mac 与 Hermes 之间停机迁移的单一所有者 Agent。

本 Spec 只覆盖这一基础切片，不代表完整 v0.2 已经达到生产上线条件。PRD v0.2 的其余能力现已由完整 Spec 套件分别设计；所有 Spec、跨切片旅程和完整 PRD 验收同时通过后，才能称为 v0.2 生产版。

本 Spec 提出以下首个正式适配器建议：

- 使用 SQLite 作为产品业务状态权威；首个 Node adapter 使用精确固定版本的 better-sqlite3，并以实际 sqlite_version() 和官方修复记录作为持久性准入证据。
- 使用 Mem0 OSS TypeScript adapter 作为首个真实长期记忆后端；增量提取和 Thread 稳定检查点提炼的语义由产品拥有。
- 使用 Cloudflare Tunnel 与 Cloudflare Access 作为首个公共 Web 和外部身份网关部署 adapter；产品身份上下文不依赖 Cloudflare 专有类型。
- 使用 GitHub App 作为首个私有仓库认证方式，只申请所选仓库和只读监控所需权限。
- 浏览器使用同源 HTTP 命令与查询，以及 Server-Sent Events（SSE）事件流；当前切片不需要 WebSocket。
- Agent Service 与 Execution Worker 通过本机 Unix domain socket 上的 execution.v1 HTTP/JSON transport 通信，保持独立进程与信任边界。

本 Spec 已于 2026-08-26 由所有者确认可以在核对 PRD v0.2 后继续派生文件级 Implementation Plan。该确认只通过 design-to-plan gate；不授权安装依赖、调用付费模型、更改 Cloudflare 或 GitHub 账户、修改产品代码或部署生产环境。

## 来源上下文

- 产品需求：[SOURCE: docs/prd-v0.2.md]
- v0.2 完整 Spec 套件与覆盖索引：[SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]
- 当前已实现系统：[SOURCE: docs/architecture-v0.1.md]
- Pi runtime 边界：[SOURCE: docs/adr/0001-pi-runtime-adapter.md]
- 无头 Gateway：[SOURCE: docs/adr/0002-headless-agent-gateway.md]
- 单一逻辑权威：[SOURCE: docs/adr/0003-single-logical-agent-authority.md]
- 确定性授权：[SOURCE: docs/adr/0004-deterministic-authorization.md]
- 可替换 Memory：[SOURCE: docs/adr/0005-replaceable-memory-boundary.md]
- 受限 Worker：[SOURCE: docs/adr/0006-primary-agent-scoped-workers.md]
- 模型路由：[SOURCE: docs/adr/0007-policy-controlled-model-routing.md]
- 能力治理：[SOURCE: docs/adr/0008-governed-capability-registry.md]
- 信任根：[SOURCE: docs/adr/0009-protected-agent-trust-root.md]
- 完整 Trace：[SOURCE: docs/adr/0010-complete-session-trace.md]
- 服务边界：[SOURCE: docs/adr/0011-composable-service-boundaries.md]
- 可移植部署：[SOURCE: docs/adr/0012-portable-local-first-deployment.md]
- Agent、Thread、Run 模型：[SOURCE: docs/adr/0013-agent-thread-run-memory-model.md]
- 集中 Attention：[SOURCE: docs/adr/0014-central-attention-policy.md]
- 产品状态权威：[SOURCE: docs/adr/0015-product-state-over-pi-runtime-projection.md]
- Node 与 TypeScript runtime：[SOURCE: docs/adr/0016-typescript-node-runtime.md]
- Workspace 组织：[SOURCE: docs/adr/0017-workspace-monorepo.md]
- SQLite 权威：[SOURCE: docs/adr/0018-sqlite-product-state-authority.md]
- 停机权威迁移：[SOURCE: docs/adr/0019-offline-authority-transfer.md]
- 公共 Web 身份网关：[SOURCE: docs/adr/0020-public-web-identity-gateway.md]

### 本设计采用的外部证据

- Mem0 的 Node SDK 文档提供 mem0ai/oss 的 Memory API、添加、检索和完整 CRUD 能力，同时说明默认配置可能选择模型、嵌入和历史存储。实现必须精确配置所有 provider、模型、维度和路径，并在选定版本上重新验证。参见 [Node SDK Quickstart](https://docs.mem0.ai/open-source/node-quickstart) 与 [上游仓库](https://github.com/mem0ai/mem0)。
- Cloudflare 文档要求 origin 验证 Cf-Access-Jwt-Assertion 的签名、issuer 和应用 audience；Tunnel 可让 origin 保持出站连接。参见 [Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) 与 [Tunnel 连接方式](https://developers.cloudflare.com/cloudflare-one/networks/connectivity-options/)。
- GitHub 文档说明 installation access token 可以限制到选定仓库和权限，并在一小时后过期。参见 [GitHub App installation 认证](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)。
- SQLite 文档说明 WAL 依赖同机共享内存、不能跨网络文件系统，并且同一时刻只有一个 writer。官方发布记录显示 WAL-reset corruption 修复进入 3.51.3 及后续分支；实现仍须按发布时的官方记录重新设定最低安全版本。参见 [WAL](https://www.sqlite.org/wal.html)、[Backup API](https://www.sqlite.org/backup.html) 与 [Release History](https://www.sqlite.org/changes.html)。
- Node.js 22.19.0 中的 node:sqlite 仍是 active development 且接口同步。本设计因此保持 repository 与 driver 解耦，并先评估固定版本 better-sqlite3；最终选择必须通过 Mac 与 Hermes 的兼容性、持久性和事件循环隔离验证。参见 [Node 22.19 SQLite 文档](https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html) 与 [better-sqlite3 releases](https://github.com/WiseLibs/better-sqlite3/releases)。
- OpenViking 只保留为后续评估候选，不作为并行生产依赖。采用前必须单独审查版本成熟度、许可证、部署和数据模型。参见 [上游仓库](https://github.com/volcengine/OpenViking)。

## 范围

### 本 Spec 包含

- v0.2 基础旅程所需的产品自有 SQLite schema、migration 和生产 repository adapters。
- 生产 Payload 加密，以及 Mac 与 Hermes 的 host secret material source adapters。
- 可运行的 Agent Service 与 Execution Worker 入口、真实本机 transport、健康状态、drain 和 service-manager 包装。
- 公共 Web 应用壳、受认证 Gateway HTTP adapter、可恢复 SSE 和持久 read model。
- 持久 Thread、消息、审批、Trace、收件箱和后台任务恢复。
- 本基础切片所拥有数据的 Trash、永久删除、删除传播、恢复点清除和存储压力保护。
- Mem0 OSS conformance spike、产品 adapter、非敏感增量自动记忆、敏感记忆逐项审批、Thread 稳定检查点提炼、检索、纠正、删除和重建。
- 通过既有产品 router 与 Pi runtime 边界接入一个云端主要生成模型、一个固定云端备用生成模型和独立嵌入模型。
- GitHub App 配置、签名 webhook 在线入口和只读仓库监控，不进行离线事件补拉。
- Mac 与 Hermes 之间的停机加密权威迁移，以及活动主机同一存储边界内的日常恢复点。
- 本基础切片需要的安全、重启、崩溃、迁移、浏览器和真实 adapter 验证门槛。

### 本 Spec 不设计，但仍属于 v0.2 硬性范围

- Owner 可见 Thread 生命周期、Fork、压缩、回答语言和对话上下文：[SOURCE: docs/execution/specs/2026-08-26-owner-thread-conversation-design.md]
- 完整 Web 控制面、中英日三语、响应式和 WCAG 2.2 AA：[SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]
- ActionKind、风险、Grant 以及 Tools、Skills、MCP、本地程序、第三方 API 和 adapter 生命周期：[SOURCE: docs/execution/specs/2026-08-26-authorization-capability-governance-design.md]
- 公共 Web 研究与受控认证 Web 操作：[SOURCE: docs/execution/specs/2026-08-26-web-research-browser-actions-design.md]
- 主机文件、授权代码工作区、命令和本地 commit gate：[SOURCE: docs/execution/specs/2026-08-26-host-files-code-workspaces-design.md]
- Apple/iCloud Calendar 读取、个人事件写入和参与人保护：[SOURCE: docs/execution/specs/2026-08-26-apple-calendar-integration-design.md]
- 周期反思、主动建议、内部专业 Worker 和自我改进候选：[SOURCE: docs/execution/specs/2026-08-26-proactivity-workers-self-improvement-design.md]
- 完整浏览器/无障碍/规模/长期运行验收与手动核心升级：[SOURCE: docs/execution/specs/2026-08-26-production-qualification-upgrade-design.md]

这些 active Specs 与本基础 Spec 共同覆盖完整 v0.2。它们不能因为本 Spec 已确认而被删除、降级或吸收到未经确认的实施范围，也不能在它们未完成时把产品称为生产版。

### PRD 已明确排除

- active-active、多主写入、共享网络 SQLite、在线状态复制、自动跨机器 failover 和零停机迁移。
- 多用户注册、团队授权、计费和面向公众的自助 API。
- 原生应用、站外 IM 投递、语音客户端、移动 push 和离线接纳浏览器命令。
- GitHub 写操作或通用仓库编码自动化。
- v0.2 本地生成模型；只保留未来适配边界。
- Memory backend federation、产品自建向量数据库、任意不可信包执行和公共能力市场。
- 主机与其存储同时损毁后的异机灾难恢复、跨设备备份、RPO 和 RTO 保证。
- 人类可读或通用机器可读导出；迁移包只用于受控权威迁移。

## 验收标准

### 可运行部署

- 给定配置和 secret references 已准备好的全新 Mac 或 Hermes，安装并启动正式产物后，Agent Service 与 Execution Worker 不依赖源码 checkout 即可启动，并分别报告 liveness 与 readiness。
- schema、authority、Payload key、Memory 初始化或 Worker handshake 任一失败时，readiness 必须为 false，并返回稳定机器码而不泄漏秘密。
- 服务收到关闭信号时，必须先停止接纳新 Trigger 和调度，在有界 deadline 内完成、取消或持久化检查点，再有序关闭 Memory、SQLite 和 runtime socket。

### 受认证 Web 对话与身份

- 活动权威首次启动时，Owner 只能通过本机一次性初始化绑定一个外部身份；成功后初始化入口关闭。
- 公网访问必须通过启用 MFA 的外部身份网关；origin 对每个静态、API 和 SSE 请求验证签名断言并映射到唯一 Owner。
- 缺失、伪造或过期断言，错误 issuer、audience 或 Owner mapping，必须在进入 Control Plane 前 fail closed，且不得调用模型或能力。
- Owner 可以查看并撤销产品会话和设备；关键操作需要近期重新认证。本机 break-glass 可以修复 Owner mapping、撤销会话或关闭公网入口，并留下审计。
- 同一 idempotency key 的消息重复提交只能创建一个 Trigger 与 Run；SSE 断线后使用持久 cursor 恢复，不重复产生业务结果。
- 浏览器关闭或主机正常重启后，原 Thread、消息、待审批、已完成结果、Trace 和收件箱仍然存在；Thread 不因空闲、重连或上下文压缩自动结束。

### 持久后台工作

- 已授权计划任务或在线仓库事件到达时，即使没有浏览器在线，权威也必须创建持久 occurrence 与 Run，保存检查点并形成持久 Attention/Delivery 结果。
- Agent Service 或 Worker 在已在线接纳工作后崩溃，恢复必须沿用同一稳定工作身份；重复结果通过幂等键消除，未知外部副作用先对账而不是盲目重做。
- 权威 epoch 变化或 deployment 进入 retired 后，旧 scheduler tick、Gateway 命令和 Worker 结果都不能提交。
- 主机离线期间错过的周期任务直接跳过；一次性任务标记 MISSED；外部事件不追赶、不补拉，并记录可见 coverage gap。

### 自动与敏感 Memory

- 完成的 Run 包含具有长期价值的非敏感偏好、事实、目标、项目、决定、习惯、承诺或纠正时，策略可以自动创建零条或多条带来源的产品 Memory。
- 发现敏感个人信息时，交互式 Thread 必须同步逐项询问，在批准前不保存候选正文；“请记住”只批准该项明确内容。
- 同一轮发现多个敏感候选时，Web UI 必须允许逐项批准、编辑或拒绝。后台任务只保存指向原始加密来源的最小引用，不能持久化提取后的敏感正文。
- 检测到密码、API Key、访问令牌、Cookie、私钥、恢复码或同类机器秘密时，必须在任何提取、嵌入或模型调用前排除；拒绝记录不得复制秘密值。
- Thread 到达明确操作、受控空闲、上下文压缩或来源大小阈值形成的内部稳定检查点时，可以生成一个带来源的摘要，以及零条或多条去重的长期 Memory、可复用经验和未解决承诺候选，但不得结束或替换 Thread。
- 相同 ThreadId、source watermark 和 policy version 的检查点重试必须复用同一 job 与 generation identity，不重复创建摘要、Memory、经验或候选。
- 未解决承诺如果没有持续有效授权，只能形成可见候选，不能自动创建任务或外部行动。
- Mem0 只提出新增、更新、合并或不变等候选；产品状态决定活动记录。Mem0 projection 丢失后可以从产品记录重建，不改变产品 ID、来源或删除状态。

### 模型路由

- 正式配置只能启用一个云端主要生成模型和一个固定云端备用生成模型；嵌入模型作为独立 descriptor 管理，不允许隐藏的第三个生成模型。
- 每次调用必须记录准确 provider、model identity 或 snapshot、披露等级、purpose、tokens、费用和终态。
- 非 GitHub 任务只有在备用模型已批准、能力满足、预算允许且不扩大披露时，才能自动降级一次。策略拒绝、授权失败和数据不兼容不得借备用模型绕过。
- GitHub 仓库默认只授权当前主要模型；任何把仓库内容发送给备用模型的尝试都必须逐次 ASK。
- Mem0 提取或嵌入不得使用隐藏默认 provider。精确模型身份、配置和 secret reference 必须由产品注入。
- v0.2 不下载或接入本地生成模型；adapter contract 必须保持 provider 和部署位置中立，以便未来新增本地模型时不改变授权、Trace 与数据分类语义。

### GitHub 在线只读监控

- Owner 连接公开仓库或明确选择的私有仓库时，GitHub App 只申请只读监控所需的仓库与权限，不存在写权限。
- 连接确认界面必须展示当前主要模型、provider，以及排除机器秘密后整个仓库内容可以发送给该主要模型；明确确认同时授权仓库和这一披露范围。
- 默认事件固定包含默认分支 push、Pull Request 创建、更新或合并、Release 和 GitHub Actions failure；每个仓库可以调整启用项。
- webhook 必须先验证 X-Hub-Signature-256、body size、content type、installation 与 repository scope，再持久化 delivery ID；重复在线投递只形成一个 occurrence。
- 所有通过签名与范围验证的在线事件都交给模型判断相关性和 Attention，不用确定性语义预过滤替代模型。
- 服务离线期间不轮询、不补拉、不进行恢复对账。恢复后 Web UI 展示 coverage gap 的起止和“期间可能遗漏事件”。
- 已在线接纳但受预算阻塞的事件进入有界 BUDGET_BLOCKED 队列；不能因为浏览器关闭或服务内部重试而静默丢弃。
- installation token 只在内存中短期使用；App private key、webhook secret 和 token 不进入产品 Payload、Memory、迁移包或可读 Trace。

### 同机恢复点和跨主机迁移

- 日常恢复点必须在当前活动权威主机的同一存储边界内创建、加密并实际验证恢复；它不承诺主机或存储完全损毁后的恢复。
- Mac 迁移到 Hermes 或反向迁移时，源必须停止接纳新工作、处理在途 Run、关闭全部 state stores，并创建带版本 manifest、完整性摘要和身份信息的加密迁移包。
- 迁移包包含权威 SQLite、受保护 Payload、Memory 产品记录与必要 projection、非秘密配置元数据；明确排除 host secrets、cache、logs 和 sockets。
- 目标必须在 stopped 且空的 state root 中导入。认证标签、digest、schema、adapter、Agent identity、authority epoch 或 Payload 验证任一失败，都不得留下部分活动状态。
- 目标在 secret references 单独重配、doctor 与 readiness 全部通过后，才以更高 authority epoch 激活，并保持同一个公共 URL。
- 目标激活后，源保持不可启动并保留加密副本 7 天，到期删除。回切必须从当前活动目标发起新的反向 transfer，不能直接启动旧副本。

### 删除与存储压力

- 普通删除本基础切片拥有的 Thread、任务或 Memory 时，记录必须立即退出上下文、检索、调度和投递，并进入可恢复 7 天 Trash；Owner 也可以选择立即永久删除。
- 删除 Thread 前必须列出关联活动任务，并由 Owner 取消、暂停或重新绑定；Thread 永久删除级联其消息、内部 Session、Run、Trace、私人 Payload、审批和 Thread 专属 inbox，但不自动删除已经形成的长期 Memory。
- 保留的 Memory 如果来源 Thread 已删除，只能保留非正文来源标识并显示“来源已删除”；不得保留已经删除的原始来源正文。
- 删除任务必须级联任务定义、Run、checkpoint、Trace 和任务 inbox；已发生外部副作用只保留不含原始内容的最小审计墓碑。
- 删除 Memory 时，产品活动记录先立即失活，并可靠清理 Mem0 projection、search/cache 和可恢复副本；provider cleanup 失败不得让旧内容重新进入检索。
- 永久删除的数据必须在 30 天内退出本机可恢复 snapshot。严重磁盘不足时停止新的高容量接纳，同时保留只读、transfer export 和人工清理；不得自动删除 Owner 内容。

### 本 Spec 收口

- 本 Spec 的实现只有在上述基础旅程通过真实 Mac 与 Hermes、真实公共认证路径和真实 adapters 的验证后才能关闭。
- 关闭本 Spec 不等于 v0.2 上线。完整 PRD 中由其他 Spec 承担的能力、三语和无障碍等硬性验收也全部通过后，才允许称为 v0.2 生产版。

## 设计

### 当前状态与目标拓扑

当前 v0.1 已实现产品边界和确定性恢复语义，但组合仍以进程内和 memory test adapters 为主：

~~~text
测试或程序调用方
        │ 进程内 gateway.v1
        ▼
┌────────────────────────────────────────┐
│ apps/agent-service composition object  │
│                                        │
│ Gateway → Run Coordinator → Pi adapter │
│    │          ├→ Worker client object  │
│    │          └→ Memory/Model 等 ports │
│    └→ in-memory read model             │
│                                        │
│ testing adapters: state、trace、       │
│ payload、authorization、scheduler、    │
│ memory、delivery                       │
└────────────────────────────────────────┘
        │ 进程内 execution.v1
        ▼
apps/execution-worker service object

没有公共 listener、daemon 入口或持久数据库
没有生产 secrets、真实 Memory/model/GitHub adapter
~~~

目标部署保留 domain/application contracts，只替换外层 adapters 与 entrypoints：

~~~text
公共浏览器
    │ HTTPS + 外部登录与 MFA
    ▼
Cloudflare Access + Tunnel
    │ signed identity assertion
    ▼
┌───────────────────────────────────────────────────────┐
│ Agent Service                                         │
│                                                       │
│ HTTP/SSE Gateway → Control Plane / Read Model         │
│        │                    │                          │
│        │                    ├→ Run/Scheduler/Attention │
│        │                    ├→ Model Router → Pi       │
│        │                    ├→ MemoryPort → Mem0 OSS   │
│        │                    └→ Reliable event/outbox   │
│        │                                               │
│        ├→ encrypted Payload + product state → SQLite  │
│        └→ secret handles → host secret source         │
└────────────────────────────┬──────────────────────────┘
                             │ execution.v1 over UDS
                             ▼
                  ┌──────────────────────────┐
                  │ Execution Worker process│
                  │ GitHub/read-only tools  │
                  │ bounded work directories│
                  └──────────────────────────┘

GitHub webhook ── provider-signed narrow route ──→ durable Trigger

本地持久状态
  ├─ product.sqlite       产品业务权威
  ├─ protected payloads   加密并由 product.sqlite 索引
  └─ mem0 projection      可替换、可重建的 adapter state

非活动主机
  └─ stopped + retired；只接收停机加密迁移
~~~

Pi 仍是内部 Agent runtime library，不提供也不替代公共 Gateway、身份系统、SQLite 产品库、后台 daemon、迁移协议或 Worker transport。

### 部署单元与生命周期

| 单元 | 职责 | 禁止事项 |
| --- | --- | --- |
| himawari-agent-service | 持有权威、提供 Web/Gateway、拥有 repositories、调度 Run、路由 model/Memory、发布事件并投递 Web 结果 | 执行任意不可信包、暴露 secret、在无权威时接纳写入 |
| himawari-execution-worker | 在资源和 deadline 边界内执行已注册只读或已授权能力与 Worker Run | 直接写 product.sqlite、授予权限、决定 Attention、成为 Agent 权威 |
| himawari admin CLI | doctor、schema migration、同机恢复点、transfer、secret-reference diagnosis 和离线 integrity checks | 启动两个权威、打印 secret、无独占管理锁修改生产状态 |

两个服务都提供明确 main entrypoint 和 package start script。macOS launchd 与 Hermes systemd 使用专用或 Owner 受限账户，配置 restart policy、state/config path、file descriptor limit 和 graceful-stop deadline。正式产物不得依赖 sibling pi-mono checkout。

Agent Service 启动顺序：

1. 解析并严格验证非秘密配置。
2. 解析必需 secret references，但不记录值。
3. 获取 deployment directory lock，并验证 active/retired authority state。
4. 打开 SQLite，验证实际版本、pragmas、migration digests 和 quick_check。
5. 在创建一致 pre-migration snapshot 后，只执行已授权 forward migrations。
6. 初始化 Payload keyring、repositories 和 outbox。
7. 使用显式配置初始化 model registry 与 Mem0，不允许隐藏默认值。
8. 完成 Worker handshake 和 scheduler recovery。
9. 绑定 loopback HTTP，最后才报告 ready。

关闭顺序反向执行：先使 public readiness 为 false，停止 admission 和 scheduling，完成 drain 或 checkpoint，停止 publisher，关闭 Mem0 与 SQLite，释放 authority 和 runtime socket。

### 状态与配置布局

每台主机使用显式 state root，生产路径不得从当前工作目录推断：

~~~text
state-root/
├── authority.json
├── product.sqlite
├── payload/
├── memory/mem0/
│   ├── vector.sqlite
│   └── history.sqlite
├── runtime/
│   ├── execution-worker.sock
│   └── locks/
└── cache/
    └── repositories/
~~~

product.sqlite 始终是权威。即使大 Payload 使用 content-addressed ciphertext file，每个文件也必须有 SQLite ownership row、digest 和 lifecycle state；无引用文件是 garbage，有引用但 ciphertext 缺失是 integrity failure。实现可以先把有界 Payload 存为 SQLite BLOB，超过经测量阈值后再 spill，但两条路径必须通过同一 PayloadStore conformance。

非秘密配置使用严格、版本化文件，记录 IDs、bind paths、public origin、Memory/model descriptors、repository allowlist 和 secret references，不嵌入 secret values。cache 与临时 work directories 单独设上限，并且可重建。

### SQLite schema 与事务边界

| 分组 | 代表记录 |
| --- | --- |
| 权威 | Owner、Agent、deployment、authority epoch/lease/fence、transfer history |
| 对话 | Thread、内部 Trace group、message reference、Trigger、Run、Turn、Run checkpoint |
| 治理 | approval request、Grant、authorization usage、capability declaration/version/handle |
| 可靠性 | idempotent command result、reliable event outbox、publication、delivery claim |
| 可观察性 | Trace envelope、Payload metadata/ciphertext reference、audit ledger、deletion state |
| 后台 | scheduled job、occurrence、work item、retry/deadline、Attention decision、inbox delivery |
| Memory | Thread checkpoint job/watermark、summary generation、product Memory、experience、commitment candidate、provenance、provider link、projection job |
| 集成 | GitHub installation metadata、repository monitor、webhook receipt、coverage gap |
| 治理元数据 | schema migration ledger、migration digest、backup/restore marker |

所有 contract boundary 使用稳定 product IDs，不暴露 auto-increment ID。foreign keys 和 unique constraints 强制 Owner/Agent scope、event identity、command idempotency 与 provider delivery dedupe。可变记录使用 revision 做 compare-and-swap。

首个 adapter 使用专用 persistence execution context 独占 SQLite connection，使同步 driver 调用不阻塞 HTTP/model event loop，并串行化写入。repository ports 对应用层保持 async。任何网络、模型或 Memory 长操作都不得持有 SQLite transaction。

生产配置至少包含：

- PRAGMA foreign_keys = ON。
- 本地磁盘 journal_mode = WAL，并有明确且经过测试的 checkpoint policy。
- authority 与 product commit 默认 synchronous = FULL；改变持久性契约必须另立 ADR。
- 有界 busy_timeout、transaction duration metrics 和 disk headroom checks。
- 启动 quick_check；doctor、恢复点和 transfer 使用离线 full integrity_check。
- 启动与发布记录实际 sqlite_version()，并拒绝未包含已知 WAL-reset 修复或新发现阻断性问题的 build。

Migration 是带 sequence、name 与 SHA-256 digest 的不可变 SQL。ledger 记录已应用 digest；修改历史 migration 必须阻止启动。破坏性 schema evolution 使用 expand、backfill、verify、contract，且先建立同机 pre-migration snapshot。应用回滚不自动意味着数据库 downgrade。

### 产品状态、outbox 与重启恢复

现有 ProductStateRepository 原子边界映射为一笔 SQLite transaction：

~~~text
验证 authority fence、command idempotency、expected revision
  → 写入下一产品状态
  → 写入稳定 command result
  → 写入 pending reliable event/outbox
  → COMMIT
~~~

publisher 使用 revision/state claim pending rows，以稳定 event ID 投递并记录 acknowledgment。若投递后、确认前崩溃，会用相同 ID replay，由 consumer dedupe。transaction 内不得发出外部网络调用。

启动恢复以下项目：

- 已 accepted、building、running、awaiting 或对账中的 Run 与产品 checkpoints；
- pending outbox events；
- due occurrences 与 expired work leases；
- pending 或 interrupted Thread checkpoint jobs；
- 未完成 Memory projection、correction 与 deletion jobs；
- 已持久化但尚未规范化的在线 webhook receipts；
- lease 已过期的 Attention 与 Delivery claims。

Pi Session 只从产品 messages、context references 和 checkpoints 重建为 runtime projection。它不是用户可见生命周期，也不是恢复权威。

### Web Gateway 与浏览器协议

Agent Service 从同一 origin 提供编译后的 Web 应用和 versioned Gateway API。命令与查询使用 HTTP，服务端到浏览器的事件使用 SSE：

~~~text
POST /api/gateway/v1/commands
GET  /api/gateway/v1/query
GET  /api/gateway/v1/events
GET  /health/live
GET  /health/ready
POST /integrations/github/webhook
~~~

最终 query route 可以继续拆分，但不能绕过 gateway.v1 parsing、GatewayAuthenticationContext、access policy、Control Plane 或 Read Model ports。

每个 SSE event 带 durable cursor、event ID 与 product scope。浏览器重连时提交最后接受的 cursor，检测 heartbeat timeout；若服务器已丢弃该 cursor 范围，则执行 bounded snapshot refresh。WebSocket 只在未来真正 full-duplex 的功能需要时再引入。

本 Spec 的首个 Web UI 覆盖：

- 受认证 Thread list 与持久 chat；
- streaming Run state、cancel 与 pending approval response；
- background task 与 repository monitor 的 pause/revoke 和 last result；
- persistent inbox 与 result detail；
- Memory list/search/source/correct/archive/delete，以及敏感候选逐项审批；
- Thread checkpoint generation/status 和 Thread/Run Trace timeline；
- product sessions/devices、recent re-auth 与 deployment health；
- active host、authority epoch 和不泄漏 secrets 的 degraded dependency 状态。

浏览器本地只保存 UI 偏好、未发送草稿和 last cursor。长期 messages、approvals、Memory、sessions、devices 与 tasks 都留在 authority service。

### 外部身份网关与 origin 安全

首个部署 adapter 使用 Cloudflare Tunnel 与 Cloudflare Access self-hosted application：

~~~text
Browser → Cloudflare public hostname → Access + MFA
        → outbound Tunnel → 127.0.0.1 Agent Service
~~~

不需要 router port-forward 或公网 listener。Cloudflare credentials 单独配置在活动主机，不能进入产品状态或迁移包。

本机一次性初始化使用仅 loopback 可达、短时有效且默认关闭的 bootstrap route。它创建唯一 Owner、绑定一个稳定外部 subject，并写入审计；完成后 route 永久关闭，除非通过受审计 break-glass 明确重置。

每个人类请求的 origin adapter：

1. 读取 Cf-Access-Jwt-Assertion，不信任 caller 提供的 email header。
2. 按 kid 从 Cloudflare JWKS 获取签名键，使用有界 cache 与 refresh。
3. 验证 algorithm、signature、issuer、application audience、exp、nbf 与 clock skew。
4. 把稳定 subject 映射到唯一 Owner，并检查产品 session、device 与 recent-auth 状态。
5. 只向内传递产品自有 GatewayAuthenticationContext。

所有 mutation endpoint 验证 allowed Origin、same-origin Fetch Metadata 或 CSRF token、bounded body、content type 和 product idempotency key。安全响应头包含 restrictive CSP、edge HSTS、禁止 framing 和 no MIME sniffing。rate limit 只做 defense in depth，不能替代 authorization。

产品 session 记录稳定 session ID、device label、首次与最近活动时间、authentication reference、撤销状态和 recent-auth 时间。Owner 可以逐个撤销；关键行动若 recent-auth 过期则重新认证。

break-glass 只在活动主机本地、独立恢复凭据与独占管理锁下可用，所有动作进入受保护审计。它可以撤销 sessions、修复 Owner mapping 或关闭公网入口，但不能绕过行动授权或读取普通秘密值。

### Execution Worker 与本机 transport

Worker 是活动主机上的独立进程。首个 transport 把 execution.v1 envelopes 映射为 Unix domain socket 上的 HTTP/JSON。runtime directory 权限为 0700，socket 为 0600；per-service scoped token 在文件权限之外提供额外认证。

代表操作包括：

- 提交 work.execute 并取得稳定 Worker Run identity；
- 提交 work.cancel；
- 对已经在线接纳、结果未知的工作提交 work.reconcile；
- 按 cursor 订阅或恢复 Worker events；
- 查询最小 readiness 和支持的 schema version。

请求与响应有大小限制、严格解析和版本。大输入与结果只传 Payload reference。handshake 验证 execution.v1 compatibility、worker instance identity 与当前 boot token。Agent Service 持久化 parent checkpoints/events；Worker local state 不能成为 Agent 权威。

首个 Worker 只执行产品拥有且已经注册的 adapters，例如有界 work directory 中的 GitHub read operations。MCP/package 的完整治理和隔离由行动授权与能力治理 Spec 定义；本切片提供真实 process boundary、deadline、cancellation、resource ceilings 和 handle validation。

### Thread 稳定检查点与自动 Memory

Automatic Memory 只能在权威 conversation 或 Run result 已提交后运行。提炼失败不能回滚对话。产品拥有两个互补阶段：

~~~text
committed Run
  → machine-secret exclusion
  → classification 与 sensitive approval gate
  → incremental durable-memory extraction
  → product candidate decision
  → reliable Mem0 projection

committed Thread messages + Runs + previous watermark
  → Thread internal stable checkpoint
  → source slice 与 secret exclusion
  → classification 与 sensitive approval gate
  → one summary generation
  → zero-or-more Memory / experience / commitment candidates
  → product commit
  → reliable Mem0 projection
~~~

每次 committed Run 后执行增量提取；Thread 稳定检查点用于跨轮关系、纠正、摘要和未解决承诺。检查点可由以下条件形成：

- Owner 的明确 Thread 操作，但不是隐式“关闭 Session”；
- 所有 admitted Runs 达到稳定终态或等待态后的受控 idle checkpoint；
- context compaction 前；
- 长 Thread 达到配置的 source-size threshold。

这些条件只形成内部处理边界，不结束、不归档、不替换 Thread。job identity 由 ThreadId、source watermark 与 distillation policy version 派生，状态为 pending → running → completed、retry_wait 或 failed_terminal。重试复用同一 job 与 generation。

每个 derivative record 保存 source message/Run references、classification、policy/model version 与 creation Trace。summary、experience 和 commitment candidate 是产品自有 SQLite 状态；只有符合资格且通过审批的长期 Memory 才投影到 Mem0。summary 可以进入 context builder，但不能替代可恢复 transcript。

初始正向类别包括稳定偏好、个人事实、长期目标、持续项目、重要决定、经常性习惯、承诺和明确纠正。寒暄、一次性请求 mechanics 与只服务当前 Run 的 tool output 默认排除。非敏感高置信推断可保存，但必须标记 inference、source 和 confidence。

敏感信息规则在 model 与 Memory backend 之外强制：

- 交互式发现敏感候选时，在当前 Thread 同步逐项 ASK；批准前不保存候选正文。
- “请记住”只批准其中明确指向的一项内容。
- 后台发现时，只保存指向原始加密 source 的最小 reference，等 Owner 在线后重新提取或询问。
- 第三方敏感信息继续逐项审批，并记录 subject 与 source。
- 只有 approved sensitive record 才能成为活动产品 Memory 和 provider projection。

machine-secret detector 结合结构化来源、已知 key/token/private-key formats 与 versioned rules。命中值不复制到 rejection event；Trace 只记录 rule ID、count、source reference 与 outcome。不确定时保守排除。

首个 provider adapter 位于 packages/memory-mem0，并精确固定 mem0ai/oss。所有 provider、model、dimension、path 与 custom instruction 都显式配置；不能允许隐藏 OpenAI call、in-memory vector store 或临时目录成为生产默认。兼容性 spike 必须在 Mac 与 Hermes 验证：

- add、search、update、delete 与 history；
- filter、metadata 与 provider ID round-trip；
- configured LLM/embedder/vector/history adapters；
- restart persistence、concurrent access、correction 和 deletion；
- 没有 telemetry 或 policy 外 provider call。

product memory_records 保存 protected content reference、provenance、classification、revision/status、extraction policy version 和 provider link。Mem0 vector/history stores 只是 projection。跨数据库通过 reliable projection job 协调；retrieval 必须把 Mem0 hits 与 active product records 取交集，使产品删除立即不可检索。

若固定 Mem0 版本未通过 mandatory conformance 或 durability gate，实施停止并修订本 Spec，不能静默切到 Mem0 Cloud、Postgres、Qdrant 或 OpenViking。

### 模型配置与 Pi runtime

生产配置保存三个相互独立 descriptor：

~~~text
primary:  provider + model + exact version/snapshot + capabilities
          + disclosure scope + cost boundary + secret ref
fallback: provider + model + exact version/snapshot + capabilities
          + disclosure scope + cost boundary + secret ref
embedding: provider + model + exact version + dimensions
           + disclosure scope + cost boundary + secret ref
~~~

本 Spec 不选择精确身份。首次 live call 前，Plan 必须展示 provider、model/version、capabilities、披露范围、费用结构、预计成本和有上限测试预算，取得 Owner 对实际调用与成本边界的批准。产品不要求 Owner 审批 provider 的 retention/training policy，也不能据此承诺删除或“不用于训练”。

Model Router 总是先选 primary。只有配置为 retryable 的 transport/provider failure 才可能路由到 fixed fallback；authorization failure、invalid input、policy rejection 和 data incompatibility 不可通过另一模型重试。不得动态搜索 marketplace 或第三生成模型。

非 GitHub 自动 fallback 还必须同时满足：fallback 已批准、能力足够、费用在预算内、披露不扩大。GitHub content 每次发送 fallback 都创建独立 ASK。模型变化按 PRD 的 whitelist、provider、披露和费用规则执行。

Thread checkpoint、Mem0 extraction 和 embedding 都只能使用显式 descriptor；没有隐式 model。v0.2 不实现本地生成模型，也不静默安装或下载任何本地模型。

Pi adapter 只接收产品为单个 Run 选择的 model binding、context references 与 authorized tools。Pi 自有 model selection、Session persistence、Skills discovery 与 built-in tools 都不能绕过产品 routing 或 capability governance。

### GitHub 仓库在线监控

首个集成使用 private GitHub App，由 Owner 只安装到选定 repositories。权限从实际只读操作反推，所有 write permissions 为 none。

App private key 与 webhook secret 位于 host secret source。trusted adapter 按需生成 installation token，限制到选定仓库和权限，只保存在内存，并在过期前更新。

Webhook ingestion 是狭窄 machine route：

1. 限制 body size、content type 与 source rate。
2. 只在签名验证需要的 protected transient handling 中保留 raw bytes。
3. 使用 webhook secret 对 X-Hub-Signature-256 做 constant-time verification。
4. 验证 event、action、repository allowlist 与 installation identity。
5. 在返回成功前，把 delivery ID 与 protected payload reference 写入 SQLite。
6. 规范化为带稳定幂等身份的 external-event Trigger。

默认 event allowlist 固定为 default branch push、Pull Request create/update/merge、Release 和 GitHub Actions failure。未知或未配置事件按 provider retry semantics 安全确认或拒绝，但不得触发任意工作。

通过签名与 scope 验证的每个在线事件都进入 model relevance 与 Attention classification。不得加入会绕开这一规则的确定性语义预过滤。

系统不做 periodic reconciliation，不用 cursor/ETag 补拉离线事件，也不扫描历史。authority 从 offline 变为 online 时，只记录 coverage gap；已在线持久化的 delivery 继续恢复并使用同一 idempotency identity。

repository mirror 是 protected local read-only cache。Owner 撤销仓库后，立即停止读取并删除 mirror/cache；历史摘要、Trace 与任务历史按 PRD 保留或由 Owner 选择全部删除。初始能力不能 push、comment、merge、dispatch workflow 或执行其他 GitHub 写操作。

### 后台任务状态机

Repository monitors 与未来 schedules 共用持久 job model：

~~~text
active ── due/online event ─→ occurrence queued
  │                              │
  │                              ├→ admitted → running → completed
  │                              ├→ retry_wait → queued（有界）
  │                              ├→ blocked_credentials
  │                              ├→ blocked_approval
  │                              ├→ BUDGET_BLOCKED / CAPACITY_BLOCKED
  │                              └→ failed_terminal / MISSED
  ├→ paused
  └→ revoked
~~~

每个 occurrence 有由 job 与 provider occurrence identity 派生的 stable key、当前 authority fence、attempt count、next retry、deadline 和 Run reference。retry 使用分类后的有界 exponential backoff 与 jitter；没有无限 tight loop。重启只 claim expired leases，不回退 completed occurrence。

计划使用 IANA timezone；DST 不存在时刻跳过，重复时刻只执行一次。离线错过的 periodic occurrence 跳过，一次性 occurrence 标记 MISSED，只有 Owner 可手动 rerun。外部事件不补拉。

Web UI 显示 job scope、repository、authorization、last/next run、coverage gap、degraded reason 与 delivery policy。pause 阻止新 occurrence 但保留历史；revoke 还会使未来 capability handles 与 credential use 失效。

### Payload 加密与机器秘密

所有 model messages、tool inputs/results、Memory content 与 sensitive integration bodies 在持久保存前进入 PayloadProtectorPort。首个 protector 使用 versioned envelope encryption：

- 每个 Payload 使用唯一 nonce 和 authenticated encryption；AAD 绑定 Owner、Agent、Payload ID、classification 与 algorithm version。
- versioned DEK 由 host KEK 包装。
- ciphertext、authentication tag、digest、classification 与 key reference 存入产品状态。
- master KEK 只从 host secret material source 获取，不进入 SQLite、logs、Trace 或 transfer package。
- key rotation 创建新 DEK/KEK version，并能 rewrap 而不在 trusted adapter 外暴露 plaintext。

加密实现必须使用维护中的 platform/library primitives，并通过 known-answer 与 tamper tests；test-xor-v1 禁止进入 production config。

机器秘密至少包括 password、API Key、access/refresh/session token、Cookie、private key、recovery code、webhook secret、tunnel credential 和 Worker service token：

- macOS 使用 Keychain-backed secret material。
- Hermes 使用 systemd credential/encrypted credential，或由 service manager 提供且权限等价受限的 secret file。
- development-only adapter 可以使用 environment/in-memory，但 public deployment 选择它时 readiness 必须失败。

产品状态只保存稳定 secret reference、version、allowed purpose/scope 和 last validation result。trusted adapter 在调用前即时解析，并在使用后丢弃值。

### 数据生命周期、Trash 与删除传播

本基础切片中可删除对象使用产品拥有的 lifecycle state，而不是依赖 adapter 的物理删除结果：

~~~text
active → trashed → restored
             └→ deletion_pending → deleted_verified
active ────────────────→ deletion_pending → deleted_verified
~~~

`trashed` 记录立即退出 Context Formation、Memory retrieval、Scheduler、Attention 与普通 Read Model。Trash 默认保留 7 天；Owner 选择立即永久删除或 Trash 到期后，Deletion Coordinator 创建稳定 deletion job，并为 product rows、Payload、Trace/search/cache、Mem0 projection 与 recovery snapshots 分别记录 attempt、结果和验证水位线。

只有所有适用目标都回读不存在，状态才成为 `deleted_verified`。任一 adapter cleanup 失败时，产品记录仍保持不可见且旧版本不能重新激活，cleanup 以有界退避继续；Audit 只保存对象引用、删除原因、时间和不含正文的外部副作用墓碑。

Thread 删除必须先解决关联 active jobs。保留的长期 Memory 不随 Thread 自动删除，但来源关系改为不含原文的 deleted-source marker。backup retention 和 snapshot compaction 必须读取 deletion watermark，保证永久删除内容在 30 天内退出全部本机可恢复副本。

存储保护按 headroom 进入 normal、warning 和 write-restricted。write-restricted 停止新的高容量 Payload、mirror 和后台 admission，但保留认证只读查询、删除/人工清理、doctor 和 transfer export。系统不得为了恢复空间自行删除 Owner 内容。

### 同机恢复点、导出与导入

日常恢复点和 authority transfer 是不同操作：

- 日常恢复点在当前活动主机的同一存储边界内，对在线状态创建加密、一致且可恢复的 snapshot，并验证到临时目录。它不形成可启动的第二权威，也不是 off-host backup。
- transfer 改变哪一个 deployment 可以成为 active，要求 stopped/drained source，并写 authority/transfer records 阻止旧 deployment 普通启动。

Transfer export：

1. 验证 target intent、current deployment identity 与 disk space，创建 transfer ID。
2. readiness 置 false，停止 admission/scheduling，drain 或 checkpoint in-flight Runs。
3. 关闭 Agent Service、Worker、SQLite 与 Memory connections，取得 exclusive offline admin lock。
4. 执行 SQLite checkpoint 与 full integrity checks。
5. 按声明的 manifest allowlist 枚举数据，排除 cache、logs、sockets 和全部 host secrets。
6. 为迁移包 recipient rewrap Payload DEK keyring，但不导出 host KEK。
7. 创建 canonical manifest，包含 product/schema/adapter versions、Owner/Agent、source deployment、authority epoch、transfer ID、file size/digest 与 excluded secret references。
8. 使用维护中的 authenticated encryption 实现流式加密；passphrase/private key 只从交互输入或 recipient secret source 获取。
9. 解密到临时位置验证完整包，随后把 source 标记 retired_pending_transfer。

Import：

1. 要求 stopped services、empty target state root 与 exclusive admin lock。
2. 解密到新临时目录，验证 authentication、manifest schema、所有 digests 和兼容版本。
3. 验证 Owner/Agent、monotonic authority epoch 与未消费 transfer ID。
4. 在副本上执行 integrity checks 和允许的 forward migrations，不修改 encrypted source package。
5. 配置 target host secret references，并用 target KEK rewrap imported DEKs。
6. 执行 Payload authentication、Memory conformance/rebuild 与只读 product diagnostics。
7. 原子 rename validated state directory，记录新 deployment/epoch 为 inactive-ready。
8. 不切换公网入口启动服务，doctor/readiness 通过后再显式 activate target 与同一 public URL。
9. 记录 transfer completion；source 标记 retired，保持不可启动并保留 encrypted copy 7 天，到期删除。

临时 plaintext 必须最小化、限制权限并在成功或失败后清理。Runbook 必须明确：copy-on-write 或 SSD 上的文件删除不等于可靠 cryptographic erasure，主要保护依赖 encryption 与 key disposal。

迁移包不是一般导出，也不是主机损毁恢复介质。目标激活后的任何回切都必须执行新的 reverse transfer。

### 健康、可观察性与运维

Liveness 只证明 process/event loop 响应。Readiness 还要求：

- active 且非 retired 的 authority epoch、state-root lock 与 fence；
- compatible schema、healthy SQLite connection 与安全 sqlite_version()；
- Payload keyring 和 required secret references 可用；
- Worker transport compatible/ready；
- primary model descriptor 合法；provider live reachability 可以作为 degraded signal，避免完全锁死启动；
- Mem0 adapter 初始化且 production paths 持久；
- outbox 与 scheduler recovery 完成；
- public mode 下 identity、MFA、Owner mapping、bootstrap closure 与 break-glass 配置完整。

详细 dependency status 需要认证并脱敏。structured logs 包含 correlation、Run、event IDs、adapter/version、latency 和 stable error code，不含 Payload 或 secret values。metrics 至少覆盖 DB latency/queue、WAL/disk、outbox lag、job backlog、Worker、Memory retry/delete lag、model failure/fallback/cost 和 SSE reconnect/cursor errors。

实施后需要的 CLI：

~~~text
himawari doctor
himawari db status
himawari backup create|verify|restore
himawari transfer export|inspect|import|activate|abandon
himawari memory status|rebuild
himawari integrations github status
himawari identity sessions|devices|break-glass
~~~

对应实现存在后才创建并实测 Runbook；不能为未实现操作提前伪造可执行 Runbook。

## 错误处理

| 失败 | 必需行为 |
| --- | --- |
| 外部身份断言缺失或无效 | 在 Control Plane 前拒绝；不信任 forwarded identity text |
| Owner mapping、session 或 device 无效 | fail closed，允许本机受审计 break-glass 修复 |
| SSE 断线或 cursor replay | 保留状态并从 cursor 恢复；超出 retention 时执行 bounded snapshot refresh |
| authority 丢失或 stale fence | 停止新写入和任务，尽量 checkpoint，拒绝 stale result，并报告 not-ready |
| SQLite busy | 有界等待，只重试安全 transaction；显示 contention，不无限循环 |
| SQLite corruption、schema digest mismatch 或不安全 runtime | 拒绝 readiness 与写入，保留证据，要求已验证 restore/migration |
| disk full | 终止 transaction，停止高容量 admission，保留只读、迁移导出和人工清理 |
| Worker unavailable | 保持 queued 或 waiting 并遵守 deadline；不在 Agent Service 内静默执行 |
| Worker result 重复 | 用 worker/run/message identity 去重并返回既有结果 |
| primary model 可重试失败 | 仅在规则允许时使用 fixed fallback；否则进入稳定 fail/wait |
| model authorization 或 policy failure | 不用 fallback 绕过；等待配置或 Owner |
| Mem0 unavailable | 对话保持 committed；写入 durable retry；retrieval 明确降级 |
| Thread checkpoint 中断 | 保留 transcript 与 watermark；有界重试，不发布 partial generation |
| 敏感候选未审批 | 不保存候选正文、不投影 provider；交互式同步 ASK 或后台仅保存 source pointer |
| secret detector 不确定 | 保守排除 automatic Memory，只记录 rule/outcome |
| Memory provider delete failure | 产品记录立即不可检索；provider cleanup 保持 retrying 直到验证 |
| GitHub 签名、重放或 scope 失败 | 按 retry semantics 拒绝或安全确认，不创建 Trigger |
| GitHub credential 失效或 rate limit | monitor degraded，provider-aware bounded retry，并脱敏通知 |
| GitHub offline gap | 不补拉；记录 gap 起止和可能遗漏 |
| export 中断 | source 保持 stopped/pending；incomplete package 不可用 |
| import 中断 | 只修改临时目录；不存在 active partial target |
| target 在激活前失败 | 不切 public ingress；repair/reimport 或显式 abandon，source 不自动启动 |

## 验证策略

未来 Implementation Plan 必须包含以下证据，不能只依赖 unit tests。

### 静态与契约检查

- 保持现有 package dependency direction，只允许 packages/runtime-pi 引用 earendil-works/pi packages。
- 运行 npm run check、相关 unit/contract/integration/e2e、Pi compatibility 和 strict document validation。
- 用 production adapter harness 运行 persistence、authorization、Memory、Trace、deletion、scheduler、Gateway 与 Worker conformance suites。
- 验证 direct dependencies 精确固定，lockfile 不包含 local ../pi-mono link。

### SQLite 持久性

- 在 Mac 与 Hermes 断言实际 sqlite_version()，按实施时官方记录拒绝已知不安全版本。
- 对 transaction/outbox 每个 crash point 使用真实 child-process kill/restart。
- 验证 WAL recovery、busy/lock contention、long-reader checkpoint、disk-full 与 migration digest mismatch。
- 创建并恢复同机 snapshots，验证 quick_check、full integrity_check、row counts、Payload authentication 与 outbox continuity。

### 进程与恢复

- 把 Agent Service 与 Worker 作为真实 child processes 启动，验证 health、socket permissions、handshake、cancellation、drain 和 service-manager restart。
- 在 context formation、model stream、approval wait、Worker result、outbox publication、Thread checkpoint、Memory projection 和 delivery 各阶段 kill process，验证稳定恢复。
- 验证 inactive/retired host 不能写入，stale Worker/Gateway message 不能通过新 authority fence。
- 验证离线 missed schedules 与 external coverage gaps 不被补跑。

### Web 与身份

- Browser E2E 覆盖 local bootstrap、MFA login redirect、Thread/chat、streaming、cursor reconnect、approval、inbox、Memory correction/delete、Trace、sessions/devices 和 recent re-auth。
- Security tests 覆盖 forged/missing JWT、wrong issuer/audience、JWKS rotation、expired token、header spoofing、CSRF/cross-origin、oversized body、CSP 与 direct-origin bypass。
- 验证 bootstrap 成功后不可再访问，break-glass 需要本机独立凭据、管理锁与审计。
- staging Cloudflare Access/Tunnel smoke test 验证真实 public path、SSE heartbeat/reconnect 和最小 public route set。

### Memory

- 固定 Mem0 release，先在 Mac 与 Hermes 运行 compatibility spike。
- 建立受治理的 multi-turn golden dataset，覆盖 durable facts、transient chatter、corrections、contradictions、cross-turn decisions、commitments、experiences、sensitive personal facts 与 machine-secret formats。
- 分别测量 incremental 与 Thread-checkpoint extraction precision/recall、summary faithfulness/source coverage、retrieval relevance、false secret retention、correction/delete propagation、restart persistence 与 rebuild equivalence。
- 触发 explicit Thread action、idle checkpoint、compaction 和 size threshold，验证每个 Thread/source-watermark/policy-version 只有一个 generation，且不结束 Thread。
- 验证交互式敏感候选逐项同步审批、多个候选逐项编辑/拒绝、“请记住”只批准指定项，以及后台只保存最小 encrypted source pointer。
- 在 model response 前后和 product commit 前后中断提炼，验证无 partial generation，重试保持 exactly-once product semantics。
- 验证 unresolved commitments 无授权时只形成候选，不能创建 job、capability 或 external action。
- 验证没有 hidden LLM/embedder、telemetry 或临时目录 durability path。
- 任何 machine secret 进入 Memory 或 provider input 都是 release blocker。

### 删除与存储压力

- 对 Thread、任务、Memory 和 Payload 运行 Trash、restore、立即永久删除、Trash 到期、adapter cleanup failure/retry 和 restart recovery。
- 验证删除对象立即退出 context、search、scheduler、inbox 和 read model；保留 Memory 的来源只显示 deleted-source marker。
- 创建包含待删除内容的多个 snapshot，推进 deletion watermark 与 retention，证明 30 天边界内所有可恢复副本都不再包含正文。
- 注入 Mem0/search/cache/Payload cleanup 失败，验证产品状态持续不可检索，重试后只有全部回读不存在才能报告 `deleted_verified`。
- 注入 warning、write-restricted 与 disk-full，验证高容量接纳停止而认证只读、删除、doctor 和 transfer export 保持可用，且不会自动删除 Owner 数据。

### 模型

- paid/live call 前，展示精确 primary、fallback、embedding identity、capabilities、披露范围、费用结构、预计成本与 capped test budget，取得 Owner 对调用和费用的批准。
- 不要求 Owner 审批 provider retention/training policy，也不做相应产品保证。
- 批准后运行有界 live smoke/eval，覆盖 streaming、tool calls、cancellation、primary failure/fallback、GitHub fallback ASK、disclosure rejection、token/cost accounting 与 secret redaction。
- deterministic provider tests 与 fault injection 仍是恢复证据；一次 live success 不能替代它们。

### GitHub

- 使用 dedicated test GitHub App 与 repositories，验证 exact read-only permission manifest。
- 验证 short-lived token refresh、public/private read、webhook signature/replay、default event set、全部有效在线事件进入模型、rate limit、revoked installation 与 selected-repository removal。
- 验证离线期间没有 polling/reconciliation/history scan，Web UI 产生准确 coverage gap。
- 验证连接时整仓 primary-model disclosure confirmation，以及每次 fallback disclosure 都单独 ASK。
- 断言任何初始 capability 都无法访问 write endpoint 或 Git credential。

### 跨平台迁移

- 执行 Mac→Hermes 与 Hermes→Mac transfer drill，包含非空 Thread、pending/complete Runs、Thread checkpoint summaries、水位线、Payload classifications、Memory/experience/candidates、background jobs 与 GitHub monitor state。
- 比较 transfer 前后 manifest、identities、authority epoch、schema、row counts、Payload authentication、Memory retrieval 与 Trace causality。
- 验证 decrypted archive 不含 machine secrets，target readiness 明确列出必须重配的每个 secret。
- 在每个 export/import step 后注入失败，证明不会激活 partial target，也不会普通启动 source。
- 验证 target 激活后 source 不可启动、encrypted copy 保留 7 天后删除，回切只能通过 reverse transfer。

### Spec 收口

- 对已经实现的 install/start/stop、同机 backup/restore、transfer、secret rotation、GitHub setup、identity gateway 和 incident diagnosis 创建并执行 Runbooks。
- 记录 immutable release identity、package checksums、config/schema versions、live process identity、public endpoint health 和 rollback boundary。
- 只有本 Spec 的基础旅程全部通过，才可关闭本 Spec；只有其余 v0.2 Specs 和完整 PRD 验收也通过，才可宣称 v0.2 production-ready。

## 确认记录

- 确认人：Owner
- 确认日期：2026-08-26
- 确认范围：本 Spec 的基础切片、验收边界和首选 adapters，包括 SQLite 加固定 better-sqlite3、产品拥有的增量 Memory 与 Thread 稳定检查点提炼、Mem0 OSS、Cloudflare Access/Tunnel、GitHub App、HTTP+SSE Web Gateway、本机 UDS Worker transport、host-specific secret sources，以及停机加密 authority transfer。
- 授权边界：允许从本 Spec 派生详细 Implementation Plan；不授权外部账户变更、付费模型调用、依赖安装、产品实现或生产部署。精确模型身份、费用与 live-call budget 仍须在 Plan preflight 中单独批准。
