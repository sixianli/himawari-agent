---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 主动建议、内部 Worker 与自我改进设计 Spec

## 目标

定义 Agent 如何从长期上下文产生可追溯、受预算和数量约束的主动建议，如何运行周期反思，如何把复杂子任务委派给临时内部 Worker，以及如何在隔离工作区验证自我改进候选。任何候选都不能自行变成任务、长期权限、提交、部署或信任根变化。

## 来源上下文

- 产品目标与范围：[SOURCE: docs/prd-v0.2.md#产品目标]
- 后台任务与结果：[SOURCE: docs/prd-v0.2.md#后台任务与结果]
- 主动建议、反思与 Worker：[SOURCE: docs/prd-v0.2.md#主动建议周期反思与内部-worker]
- 后台任务边界：[SOURCE: docs/prd-v0.2.md#后台任务计划与恢复]
- 注意力与投递：[SOURCE: docs/prd-v0.2.md#注意力与-web-投递]
- 主动建议验收：[SOURCE: docs/prd-v0.2.md#注意力与提醒]
- 受限 Worker：[SOURCE: docs/adr/0006-primary-agent-scoped-workers.md]
- 受保护信任根：[SOURCE: docs/adr/0009-protected-agent-trust-root.md]
- 完整 Trace：[SOURCE: docs/adr/0010-complete-session-trace.md]
- 确定性授权：[SOURCE: docs/adr/0004-deterministic-authorization.md]
- 持久基础设计：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- 授权与能力治理：[SOURCE: docs/execution/specs/2026-08-26-authorization-capability-governance-design.md]
- 代码工作区设计：[SOURCE: docs/execution/specs/2026-08-26-host-files-code-workspaces-design.md]
- v0.2 Spec 总纲：[SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

## 范围

### 本 Spec 包含

- 从对话、长期记忆、长期目标、未解决承诺、重复行为、近期变化和任务结果产生建议候选。
- 受周期、上下文、费用、运行时间和每日数量限制的全局反思。
- 建议的证据、语义去重、排序、Web 收件箱投递、过期、拒绝和转为任务。
- 临时内部 Worker 的创建、最小上下文/能力委派、预算、结果汇总、终止和 Trace。
- 隔离工作区中的代码、配置或能力自我改进候选生成、验证、比较和 Owner 审查。
- 主 Agent、Worker、建议、任务和改进候选之间的稳定身份与恢复语义。

### 本 Spec 不包含

- 未经 Owner 明确批准自动创建或执行主动任务。
- 根据预测替 Owner 发送消息、购买、提交代码、变更账户、修改 Calendar 或执行其他外部行动。
- 独立 Worker Agent、Worker 直接面向 Owner 投递、Worker 独立长期私人记忆或 Worker 永久继承权限。
- Agent 自行 commit、push、deploy、restart、升级核心、启用能力或放宽身份、授权、秘密、审计和升级信任根。
- 隐藏的自主循环、无限自我复制、无限 token/费用消耗或把未确认候选合并进生产状态。

## 验收标准

### 主动建议与反思

- 主动建议必须保存稳定 ID、类型、标题、理由、最小证据 refs、来源时间范围、相关 Owner 目标、拟议任务范围、预计能力/费用、置信度、去重 key、expiry 和生成 Run。
- 建议只能进入统一持久结果系统，默认注意力为 `INBOX`；不能绕过注意力规则创建任务或直接执行。
- 默认每个 Owner 本地日最多接纳 3 条新主动建议；Owner 可调整上限。已确认的紧急外部事件不是“新建议”，不占该额度。
- 同义建议、同一未解决承诺或相同目标/行动在未发生实质变化时必须语义去重；被拒绝建议只有出现新证据或 Owner 改变范围后才能重新出现。
- Owner 明确批准建议后，系统创建一个普通后台 Task，重新冻结目标、触发方式、能力、Grant、预算、时区、超时和撤销方式；原建议本身不携带隐式执行权。
- 全局反思必须有显式 schedule、IANA 时区、输入水位、最大上下文、最大费用、超时和最大候选数；它只输出候选/无变化，不能调用外部副作用能力。

### 内部 Worker

- Worker 必须绑定同一个 Agent、parent Run、Trace 和具体 subtask，具有稳定 `WorkerRunId`、deadline、预算、允许模型、context refs、capability handles 和 output contract。
- Worker 只接收完成子任务所需的最小消息、Memory、文件和能力；不能默认读取整个 Thread、所有 Memory、home 或其他 workspace。
- Worker 的授权上限是 parent Run 与 Owner Grant 的交集。扩大文件、数据、工具、模型披露、费用、目标或收件人时，Worker 返回 proposal，由主 Agent 走普通授权流程。
- Worker 结果先回到主 Agent，由主 Agent验证来源、合并冲突并向 Owner 交付；Worker 不创建独立 Thread/Agent 身份或直接发送 Web 结果。
- Worker 结束后，短期 Handles 撤销；需要长期保留的事实仍由主 Agent 的正常 Memory candidate 流程决定。

### 自我改进候选

- Agent 可以在隔离、可销毁的候选 workspace 中生成对自身代码、配置或能力的建议改动，但输入版本、目标、权限、数据、工具、模型、预算和测试必须冻结。
- 每个候选保存 base revision/artifact digest、完整 diff、原因、风险、验证命令与结果、失败项、性能/质量比较、受影响信任边界和可复现 artifact。
- 候选运行不得访问生产 secret、生产写端点、Owner 未授予目录或真实外部副作用；需要真实数据时使用脱敏 fixture 或明确授权的只读 snapshot。
- 候选成功验证仍保持 `review_required`，不能自动 commit、push、merge、deploy、restart、安装或切换 active version。
- 涉及身份、授权、秘密、审计、模型披露、升级信任根或能力范围的候选必须被标记为 protected-root change，不能由产生候选的 Agent/Worker批准。

## 设计

### SuggestionCandidate

~~~text
suggestion_id、Owner/Agent、kind
title/body protected refs、evidence refs、source watermark
goal/commitment refs、proposed task draft
confidence、novelty、semantic dedupe key
estimated capabilities/data/cost/frequency
created/expires/status、generation Run/Trace
~~~

状态为 `candidate → delivered → approved | rejected | expired | superseded`。只有 `approved` transition 可以调用 Task creation command，而且 Task 必须独立通过授权和持久提交。

### 周期反思

反思使用单一全局 Task definition，默认每日一次，由 Owner 配置具体时间、IANA 时区、建议上限和费用预算。输入按水位选择长期目标、未解决承诺、近期 Thread/Memory 变化、任务结果和当前未关闭建议的最小摘要，不发送全部历史。

反思输出先经过 schema validation、secret exclusion、evidence validation 和 semantic dedupe。没有新价值时提交 `no_change` checkpoint，不为填满额度产生建议。主机离线错过的反思直接跳过，不补跑。

### 每日配额与去重

配额按 Owner 配置时区的 civil day 原子消耗。候选在进入结果系统时才计数；生成但被确定性去重/拒绝的不计数。多 Run 并发时通过 compare-and-swap 保证不超过上限。

semantic key 由建议 kind、目标实体、拟议 action 和证据 fingerprint 组成，模型相似度只提供候选；最终由产品状态检查 active/rejected/superseded 关系。紧急事件使用既有 Event/Attention identity，不伪装成 suggestion 绕过或占用配额。

### Worker 委派

~~~text
Primary Run
  └─ Delegation
       ├─ immutable subtask + output schema
       ├─ selected context refs
       ├─ scoped capability handles
       ├─ model/data/cost/time budgets
       └─ Worker Run → evidence-backed result
~~~

Delegation 先由主 Agent 产生计划，再由确定性 policy 对 context、模型披露与 capability Handle 求交集。Worker runtime 不能访问 Grant store 的写接口或 capability registry 的启用接口。

Worker 输出包含结论、引用、生成 artifact、未决问题、实际模型/用量/费用和执行记录。主 Agent 不得把未验证 Worker 输出当作外部事实；引用失败或冲突保持可见。

### ImprovementCandidate

自我改进遵循 propose → isolate → patch → validate → compare → review：

1. propose 说明可观察问题、目标和不变量。
2. isolate 从已验证 base 创建候选 workspace，不连接 active runtime 写端点。
3. patch 只产生候选 diff，不修改 active checkout。
4. validate 运行声明测试、静态检查、安全/边界检查和适用 eval。
5. compare 保存 base 与 candidate 的相同输入结果、回归和资源差异。
6. review 在 Web 展示完整证据，由 Owner 决定拒绝、要求修改或发起独立实施/升级流程。

候选 artifact 有期限和空间预算，过期清理由受控生命周期执行；原始 Owner 数据遵守其自身删除与保留规则，不能被候选副本延长。

## 错误处理

| 失败 | 必需行为 |
| --- | --- |
| 反思模型或 Memory 不可用 | 有限重试后可观察失败；不补造建议 |
| 建议缺证据或范围不明确 | 丢弃或标记不可批准，不创建任务 |
| 每日额度已满 | 不再投递新建议；保存聚合计数而非敏感正文 |
| 去重服务不确定 | fail closed 到待重新评估，不重复打扰 Owner |
| Worker 请求扩大上下文/能力 | 暂停该 subtask，交由主 Agent 形成 Approval |
| Worker 超时/崩溃 | 终止 Handles，保留 partial evidence，主 Run 决定失败或新委派 |
| Worker 结果相互冲突 | 主 Agent 展示冲突和来源，不静默选择 |
| 候选 workspace 隔离失效 | 立即停止并标记 security failure，候选不可批准 |
| 自我改进验证失败 | 保留失败证据，状态 `rejected_by_validation` |
| 候选尝试修改信任根或自激活 | 确定性拒绝并提高审计/注意力等级 |

## 验证策略

- 用固定历史集验证建议证据、无变化、语义去重、拒绝抑制、新证据重开和默认每日 3 条原子配额。
- 覆盖反思 schedule、IANA 时区、DST、离线跳过、预算/超时、模型阻塞和 checkpoint 幂等。
- 通过 context/capability canary 证明 Worker 看不到未委派 Thread、Memory、文件、secret 或工具。
- 构造 Worker 扩大范围、递归委派、直接投递、独立 Memory、过期 Handle 和并发取消攻击。
- 在 Worker 创建、执行、结果提交和主 Agent 合并边界 kill process，验证 identity/Trace 可恢复且不重复副作用。
- 对自我改进运行隔离逃逸、生产端点、secret scan、base tamper、测试伪造、信任根修改和自激活负面测试。
- Browser E2E 覆盖建议查看/批准/拒绝/过期、配额设置、Worker Trace 和候选 diff/eval review。
- 运行 unit、contract、integration/security、eval reproducibility、`npm run check` 和 strict document validation。

## 确认状态

本 Spec 已按 PRD v0.2 完整编写，当前等待 Owner 对主动建议/反思边界、每日配额、Worker 最小委派和自我改进候选不可自激活规则整体确认。确认前不从本 Spec 创建 Implementation Plan。
