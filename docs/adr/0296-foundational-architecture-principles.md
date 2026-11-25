---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0001-pi-runtime-adapter.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0002-headless-agent-gateway.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0003-single-logical-agent-authority.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0004-deterministic-authorization.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0005-replaceable-memory-boundary.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0006-primary-agent-scoped-workers.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0007-policy-controlled-model-routing.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0008-governed-capability-registry.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0009-protected-agent-trust-root.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0010-complete-session-trace.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0011-composable-service-boundaries.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0013-agent-thread-run-memory-model.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0014-central-attention-policy.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0015-product-state-over-pi-runtime-projection.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0016-typescript-node-runtime.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0017-workspace-monorepo.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0018-sqlite-product-state-authority.md"
superseded_by: ""
date: "2026-11-26"
covers: "packages/domain, packages/application, packages/runtime-pi, packages/gateway-contracts, packages/persistence-sqlite/src/migration-engine.ts, docs/architecture-v0.1.md"
verified_at: "7d0ffcd52cbb69d4941871cf9bf08d93f3843da8"
---

# ADR 0296：Himawari 的基础架构原则

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [运行时和接入](#runtime)
  - [权威和状态](#authority)
  - [授权、能力和信任根](#trust)
  - [记忆、模型和注意力](#memory-models-attention)
  - [记录和服务边界](#trace-boundaries)
  - [语言和仓库](#language-repo)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

项目开始时（2026-08 下旬）定下的十七条基础架构原则，原来各占一份很短的 ADR（0001 到 0011、0013 到 0018），每份只有一两段决定。它们至今仍然成立，具体怎么落地写在[架构文档](../architecture-v0.1.md)里。这份 ADR 把它们合成一份，方便一次读完；每条后面的括号是原来的编号，旧文全文（含当时比较过的方案）在 `supersedes` 列的固定提交链接里。原则之间冲突时，按[产品愿景](../product-vision.md)的顺序裁决。

<a id="decision"></a>

## 决定

<a id="runtime"></a>

### 运行时和接入

1. **经产品自有的运行时端口用 Pi（0001）。** 通过产品自己的 Agent 运行时端口和 Pi 适配器使用 `pi-coding-agent`，领域层不直接依赖 Pi 类型；正式发布固定到明确的 Pi 版本，只有对上游通用的改动才改 `pi-mono`。在 Pi 上怎么开发见 [ADR 0294](0294-building-on-pi.md)。
2. **产品状态是权威，Pi 会话只是投影（0015）。** Agent、Thread、Run、消息、授权和业务事件的权威记录在产品状态存储里；每次执行由适配器从产品状态构建上下文，把 Pi 事件映射回产品事件和记录。Pi 的压缩、消息转换可以复用，但不能绕过产品提交协议改变权威状态。
3. **所有客户端只连产品自己的网关（0002）。** 网关定义稳定的命令、查询、事件流、审批和记录读取契约；客户端不持有权威状态，也不依赖 Pi 类型。换传输方式（HTTP、WebSocket、语音）不改领域语义。

<a id="authority"></a>

### 权威和状态

4. **每个 Agent 任一时刻只有一个逻辑权威（0003）。** 只有当前权威实例能提交长期状态和外部副作用；其他设备是客户端、缓存或输入队列。将来要离线自治时，另开有独立身份和权限的从属 Agent，不做同一身份多主写入。
5. **领域里分开 Agent、Thread、Run 和 Memory（0013）。** 一个 Thread 可以有多个 Run；后台触发也要建可识别的 Run。Session 只是面向交互和记录的视图。
6. **SQLite 是产品状态的唯一权威数据库（0018）。** 产品状态、幂等命令结果和可靠事件发件箱在同一个事务里提交；数据库在权威主机的本地磁盘上，写入经过单一串行化边界；迁移不可变、带校验和，服务只在结构、完整性和权威检查通过后才就绪；启动时核对实际的 `sqlite_version()`；日常恢复点只放在同一主机。数据库驱动和迁移只在基础设施适配器里。跨机器迁移权威的做法见 [ADR 0019](0019-offline-authority-transfer.md)。

<a id="trust"></a>

### 授权、能力和信任根

7. **授权在模型之外（0004）。** 每个行动执行前由确定性的授权组件判为 `ALLOW`、`ASK` 或 `DENY`；模型只能提出行动和理由，不能批准自己、改生效策略，也不能把没有界面的 `ASK` 自动升级为允许。批准形成范围明确、可过期、可撤销、可审计的授权。
8. **能力统一登记，扩权要主人批准（0008）。** 所有可执行或外部能力登记在产品的能力注册表里，记来源、固定版本、完整性、权限、网络和文件范围、凭据需求、隔离方式和批准记录；安装、首次授权、来源变化、权限扩大和新增可执行代码都要主人批准。Pi 扩展、MCP、普通 API 只是不同的适配器，不是权限边界。
9. **自我改进和生效的信任根分开（0009）。** Agent 可以分析、写候选补丁、在隔离环境测试，但候选版本要主人批准才能进入正式运行。身份认证、授权策略、密钥管理、审计记录、系统级约束和升级机制是 Agent 无权自己改或绕过的信任根。
10. **一个主 Agent 加受限的工作单元（0006）。** 主人只看到一个持续存在的主 Agent；它可以为具体任务委派临时的工作单元，工作单元只拿任务需要的上下文、工具、时间、费用和数据，不默认有自己的长期记忆，不能自己扩权，外部行动仍走统一授权。

<a id="memory-models-attention"></a>

### 记忆、模型和注意力

11. **长期记忆经产品自己的记忆端口（0005）。** 端口表达写入、检索、纠正、删除、来源和上下文选择，不暴露供应商的对象；所有触发源走同一个上下文形成流程，注入了什么、来自哪里都进记录。现在端口背后是自研的记忆引擎（[ADR 0075](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0075-self-built-memory-engine.md)）。
12. **模型按策略路由（0007）。** 一个主要推理模型负责主 Agent 的判断和最终回答；受限子任务可以由产品的路由策略选别的模型。候选要经系统批准；故障降级不能悄悄降低隐私等级或扩大数据发送范围；每次选择和调用都进记录。
13. **注意力由一处统一决定（0014）。** 权威服务把结果分成 `SILENT`、`INBOX`、`DIGEST`、`NOTIFY`、`INTERRUPT`；Agent 可以提出相关性、紧急度和把握，最终级别由确定性的注意力策略结合授权、安静时间、设备状态、重复程度和频率决定。立即打断只用于主人明确授权的高优先级情况。

<a id="trace-boundaries"></a>

### 记录和服务边界

14. **保存完整可观察的会话记录（0010）。** 每个会话按 `Session → Turn → Run → Span/Event` 记下触发、上下文、记忆、模型、工具、委派、策略、审批、状态写入、外部行动、错误和重试之间的因果关系。不保存服务方内部看不见的思考；密钥在写入前换成引用；主人删除内容后只留不含原文的最小审计墓碑。诊断遥测不能代替这份记录。
15. **先定逻辑服务边界，再决定拆不拆进程（0011）。** 逻辑边界包括客户端网关、Agent 控制面、执行面、模型网关、记忆网关、调度和事件、记录和审计、密钥管理；可信的控制面组件可以合在一个进程里，不可信的执行和密钥管理从一开始就隔离。边界之间用产品契约，不共享上游的内部对象。

<a id="language-repo"></a>

### 语言和仓库

16. **服务用 TypeScript 和 Node.js（0016）。** 只用可以直接擦除的 TypeScript 语法；Node 版本跟随 Pi 的要求和生产实际版本。原生客户端用各自合适的技术，经网关接入。
17. **仓库是 TypeScript 工作区单仓（0017）。** 领域契约、应用服务、基础设施适配器和可部署入口各是一个工作区包；逻辑服务是否单独部署，不由它在不在同一仓库决定。

<a id="rejected"></a>

## 放弃的做法

- 同一 Agent 多主写入：行动、授权、定时任务和记忆的冲突没法普遍自动合并。
- 让模型自己批准行动或改策略：模型会被外来内容带偏，授权必须在模型之外。
- 把 Pi 的会话文件当事实来源：多端产品需要自己的权威状态和提交协议。
- 一开始就把每个逻辑服务拆成独立进程：个人部署不需要，按信任和故障边界再拆。

<a id="consequences"></a>

## 后果

- 架构文档里引用这些原则的地方，现在都指向这一份。
- 新设计和这些原则冲突时，先另开 ADR 改原则，不能在实现里悄悄偏离。
