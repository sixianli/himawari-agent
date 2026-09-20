---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-16"
---

# 工作区占用、授权与执行状态协同实施计划

**来源 Spec：** [SOURCE: docs/execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md]

**设计入口：** [第三稿已确认方案摘要](../specs/2026-09-16-workspace-authorization-lifecycle-design.md#review-summary)。用户于 2026-09-16 在本次会话明确确认该 Spec 审核通过，并授权编写本 Plan。

**目标：** 修复结束后残留占用，按实际资源协调并发，把已确认的授权连续性、自动审查、异常恢复和真实页面状态接入现有产品。

**架构：** 继续复用 Pi 工具与 Agent Loop、Anthropic Sandbox Runtime、现有 Agent/Worker 和 SQLite。Himawari 接好持久权限、资源身份、文件提交、恢复及页面投影；不重建工具协议、沙箱或工作流系统。

**当前范围：** 用户已授权实施本 Plan，并确认 P0 的 r3 新增交互。多个局部实现已通过验证并保存为本地提交，完整 P0～P7 与 68 项产品验收尚未完成；见[当前实施进展](#implementation-progress)与[本次实施记录](#implementation-record)。自动审查真实配置、生产迁移和部署尚未执行。

<a id="contents"></a>

## 阅读导航

- [本次实施记录与待审核交互](#implementation-record)

- [一、先看实施顺序与交付结果](#roadmap)：[当前实施进展](#implementation-progress)
- [二、已经核对的代码与测试基础](#baseline)：[当前身份与持久化合同](#identity-contract)
- [三、修改、新建与保留的文件边界](#files)
- [四、分阶段实施任务](#tasks)：[P0 基线与合同](#p0)、[P1 释放与恢复](#p1)、[P2 授权连续性](#p2)、[P3 文件并发与保存](#p3)、[P4 执行方式](#p4)、[P5 自动审查](#p5)、[P6 页面与端到端](#p6)、[P7 迁移与交付](#p7)
- [五、68 项验收要求如何验证](#acceptance)
- [六、验证命令、环境与证据](#verification)
- [七、待确定的配置与停止条件](#decisions)
- [八、交付与结束条件](#closure)

<a id="roadmap"></a>

## 一、先看实施顺序与交付结果

[↑ 返回阅读导航](#contents)

| 阶段 | 完成后解决什么问题 | 前置条件 |
| --- | --- | --- |
| [P0 基线与合同](#p0) | 确定真实差距、故障复现、数据兼容和验证入口 | 已通过的 Spec；进入实施前重新核对工作区 |
| [P1 释放与恢复](#p1) | 已结束任务不再因通知迟到占住工作区，未知结果能够得到明确处理 | P0 中对应合同与复现完成 |
| [P2 授权连续性](#p2) | 排队、断线、重复决定不导致重复确认或执行 | P0；与 P1 的持久身份合同一致 |
| [P3 文件并发与保存](#p3) | 不同文件并行，同文件不丢修改，目录改名有明确次序 | P1、P2 |
| [P4 执行方式](#p4) | 普通命令在受限当前目录运行，隔离副本按需使用，普通目录不依赖 Git | P3；真实平台限制验证 |
| [P5 自动审查](#p5) | 已有授权直接处理，符合条件的请求自动审查，其余在会话内确认 | P2；真实启用另需选定配置，不能阻塞 P1～P4 |
| [P6 页面与端到端](#p6) | 状态、动作和时长反映真实执行；新增交互通过审核并有持久测试 | UI 合同和原型在 P0 开始准备；各阶段同步接入，最后联合验收 |
| [P7 迁移与交付](#p7) | 历史记录有证据地恢复，新旧版本兼容，可验证并可回退 | 对应阶段和整体验收完成；实际生产操作须有具体授权 |

优先完成 P1 的故障修复及对应页面状态。测试随每阶段建立，不延后到最后一次性补写。P5 的真实模型选择不影响先完成资源释放与文件并发。分阶段交付可以报告部分完成，但未执行的阶段不能被称为已完成，也不能把全部 Spec 标为关闭。

<a id="implementation-progress"></a>

### 当前实施进展

下表区分已经验证的局部实现与尚未完成的阶段任务；不按提交数或测试数推算完成百分比。最近一次已完成的[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-recovery-01/standard-ci-result.json)为 3,709 项全部通过，环境为本机 macOS。

| 阶段 | 已实现并验证的部分 | 仍需完成的重点 |
| --- | --- | --- |
| [P0](#p0) | r3 交互已确认；身份和持久化合同已记录；四项首次加载立即发送回归已接入原浏览器入口 | 完整基线、全部合同和 68 项联合验收仍不能划为已完成 |
| [P1](#p1) | 永久释放事实、结果交接不反锁；未绑定预约停止隔离与启动发现；停止目标与同 Run 跨页资源独立派发、清理等待上限及完成输出保留；未启动宿主退出后的预约释放凭据与原停止隔离；恢复写入的事务内归属检查、超时回调隔离和并发结果保留 | 已启动进程及后代资格、迟到矛盾证据、完整恢复错误分类与调度 |
| [P2](#p2) | 审批摘要与重复决定、额度预约、排队身份、工具执行前检查点及取消传播 | 跨 boot/fence 的执行权重新绑定、执行中撤销及所有生产路径联合覆盖 |
| [P3](#p3) | 文件路径槽位/身份/祖先协调、公平队列、固定目标合同、暂存发布与保存恢复记录；合同 3 的并行候选准备、可停止计算、原队列提交与安装入口；确定未派发的冲突重放、新 intent 关联与有限重生成已通过本地验收 | 目录改名协议、Worker 执行后的冲突处理、跨 Worker 与多文件完整验收；合同 3 的平台资格与部署未执行 |
| [P4](#p4) | 纯联网私有范围、无用户目录 Grant/挂载/claim；本机越界拒绝探针 | 任意命令的更窄可强制范围、可选副本与逐文件应用、Linux 平台资格 |
| [P5](#p5) | 默认关闭的审查持久化、宿主批准校验、现有模型边界适配、预算/取消和来源事件 | 替代方案建立新 intent 的完整路径；具体配置获确认后的真实模型、披露和费用验收 |
| [P6](#p6) | 自动审查来源与真实起止计时、终态工具结果未确认、首次加载和多语言窄屏持久浏览器回归 | 后端统一状态/原因/动作/效果投影、全部阶段计时、真实网关至 Worker 文件操作和页面恢复联合路径 |
| [P7](#p7) | 历史只读清单、Schema 28～41 的只读兼容及相关迁移回归 | 有现场证明的逐条修复候选、备份恢复演练、完整兼容矩阵与目标平台切换验收 |

原型、受控端口、隔离 HTTP 夹具与本机构建各有证据范围；它们不替代真实模型、真实 Worker 联合路径或目标部署资格。[本次实施记录](#implementation-record)保留具体命令、失败与通过结果及局部限制。

<a id="baseline"></a>

## 二、已经核对的代码与测试基础

[↑ 返回阅读导航](#contents)

编写时仓库 HEAD 为 `753fb63`，未提交内容包括本次会话修改的 `AGENTS.md` 与 Spec，以及已存在的原型和资格证据。实施前重新盘点，不假定这些未提交文件归当前实施任务所有。下面是静态源码核查，不是生产环境复测。

| 核对结果 | 现有入口 | 对实施的影响 |
| --- | --- | --- |
| Pi 依赖固定为 0.84.2，沙箱运行库固定为 0.0.75 | [Pi manifest](../../../packages/runtime-pi/package.json)、[沙箱 manifest](../../../packages/runtime-sandbox/package.json) | 本计划不预设升级或替换依赖 |
| 工具定义可注入受治理 Operations | [Pi 工具适配](../../../packages/runtime-pi/src/governed-coding-tools.ts)、[受控文件操作](../../../packages/platform-node/src/files/sandboxed-coding-operations.ts) | 复用工具参数、执行与结果形状，接入宿主授权和文件协议 |
| Pi 已有同路径文件变更队列；安装版与 canonical 源码均已查阅 | canonical `pi-mono/packages/coding-agent/src/core/tools/file-mutation-queue.ts`；安装包 `dist/core/tools/file-mutation-queue.js` | 队列在单进程内存中，不覆盖跨 Worker、崩溃恢复、目录改名和所有文件别名；保留 Pi 能力，宿主仅补这些产品责任 |
| 释放计算使用当前投影，失败分支可清空 `released_at` | [SQLite 执行记录](../../../packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts)、[结果投影](../../../packages/application/src/services/sandbox-execution-projection.ts) | 建立可永久验证的释放事实，分开控制消息与结果交接 |
| 启动恢复跳过 released/lost，单次核验对 released 提前返回 | [启动恢复](../../../packages/application/src/services/sandbox-startup-recovery.ts)、[执行核验](../../../packages/application/src/services/sandbox-execution-reconciliation.ts) | 查出“资源已结束、占用仍残留”等不一致；不能只扩大超时 |
| 占用范围从目录根和 grant 的操作集合推导 | [宿主范围核验](../../../packages/platform-node/src/capabilities/sandbox-host-verifier.ts) | 权限范围与本次协调范围拆开；不能直接把授权根当文件提交锁 |
| 新建文件直接写最终路径，替换已有文件已有准备与版本检查 | [ConstrainedHostFileSystem](../../../packages/platform-node/src/files/constrained-file-system.ts) | 补完整暂存后无覆盖发布，复用已有检查并验证崩溃边界 |
| 实际 ActionPolicy 先检查禁止，再复用 grant/允许规则，随后申请人工审批 | [ActionPolicy](../../../packages/application/src/services/action-policy-service.ts) | 自动审查接在此路径，不能另建执行旁路；单次额度消费位置需与排队合同一起调整 |
| 一个已有测试要求释放后恢复旧占用 | [SQLite 集成测试](../../../test/integration/sqlite-sandbox-execution-v2.test.ts) | 按新 Spec 改为“旧释放事实不变；确有新风险才建立相应保护”，保留阻止危险并发的断言 |
| `test:browser` 使用 Node 环境，不启动浏览器；真实浏览器脚本使用 Playwright，但现有主入口报告 `fixture-only` | [测试配置](../../../vitest.workspace.ts)、[CI 浏览器入口](../../../scripts/ci/browser.mjs) | 单元、浏览器模拟网关、真实服务/Worker、真实模型是四类不同证据 |

已核对 canonical Pi 源码路径 `/Users/triggerjames/Documents/sxl_code_work_space/pi-mono` 以及安装版 Write/Edit Operations；只作上游参考，不修改它、不建立本地依赖链接。规划依据以本产品锁定依赖为准。

当前 `.agents/skills/` 未发现项目验证 skill，因此不自动创建或声称执行维护流程；继续复用仓库现有 scripts、CI policy 和测试。若实施开始时已有相关 skill，再按其实际适用范围使用。

<a id="identity-contract"></a>

### 当前身份与持久化合同

下表将 Spec 的逻辑名称对应到当前代码。身份相同只允许查询或幂等重放；是否可以执行还要核对当前权限、Run 租约、期限和对象版本。不同阶段使用不同身份，不能因为字符串相似而互换。

| 对象 | 当前身份及关联 | 首次持久化点与重放规则 |
| --- | --- | --- |
| 逻辑工具操作 | `runId + toolCallId` 的稳定摘要；内部文件阶段再带阶段名并记录父工具调用 | Pi 在进入工具前保存 `tool-batch-recovery.v1`；生产工具以 `runtime-tool-intent:<key>` 冻结请求和语义摘要。新内容必须是新请求，不能覆盖原快照 |
| 权限请求和审批 | `GovernedActionIntent.id`、规范化 `semanticSnapshotHash`、`ApprovalRequest.id/revision` | 原授权入口保存完整 intent；决定用审批 revision 和原摘要比较后写入。批准历史与当前是否可执行分开 |
| 一次额度 | `AuthorizationReservation.id` 关联 Grant、完整 intent、Handle 和 invocation | Schema 34 在签发 Handle 前预约；准入与调用回执一起承诺。仅明确尚未派发才可释放，不确定调用不得退款 |
| 实际 Worker 调用 | `invocationId` 等于 `work.execute.messageId`；`receiptRef` 绑定被消费的 Handle；保留原 `idempotencyKey` | 同一准入事务保存 `capability_invocation_receipts`，重复返回原回执，不生成第二条可执行消息 |
| 执行尝试和环境 | `SandboxJobIdentity` 的 `jobId/attemptId/receiptRef/invocationId`，另绑定 `environmentId`、Agent/Worker boot 与执行租约 | 在调用准入时冻结；`reserved` 先保存未绑定预约，核验真实 Job Host 后由唯一 `bindAndStart` 比较写入运行环境。换 boot/fence 不是普通重放 |
| 公平排队 | `sandbox_admission_queue.job_id` 唯一，`sequence` 为排序号；保存完整原请求、资源集合和原期限 | Schema 35 入队时无共享占用和调用回执；出队同事务比较原快照、全部资源及当前授权，再准入。取消条目保留身份，不能删除后插队 |
| 文件协调资源 | 每个 Job 的 claim `ref`；目录 inode 祖先链、目标名称槽位和目标 inode | `sandbox_workspace_occupancy` 与准入同事务保存；全部相交资源一次取得。当前固定文件合同仍覆盖整个工具调用，短时提交权尚待实施 |
| 文件准备及发布 | `PreparedFileOperation.id/revision/canonicalHash`；发布前的暂存 inode、摘要及父目录身份 | 受保护操作记录与 Job 发布日志先于最终路径副作用；恢复只核验原候选身份，不能仅凭内容相同推断本次成功。Schema 37 的恢复 artifact 关联原 invocation |
| 永久释放事实 | `sandbox_release_receipts.job_id` 唯一，关联具体资源 sequence 与接纳时有效的核验证据 | Schema 33 同事务保存回执并结束原 occupancy；临时凭证随后过期不撤销历史释放 |
| 后续风险保护 | `job_id + barrier_id`；当前已实现 `control_unacknowledged` | 可执行控制派发未确认时独立保存 barrier；只交付结果的 ACK 不建立新占用。其他迟到矛盾证据类型尚未扩展 |
| 有界恢复 | 原 Job 内 `recovery.revision/owner/attempts`，独立 action、开始时间、期限及终点 | `beginRecovery` 取得有限期处理权，恢复 `append` 携带 `expectedRecoveryRevision` 并在事务内检查 owner/revision/运行状态；期限到达后仅可记录未知。`finishRecovery` 比较 owner/revision 后结束；`unresolved` 不代表后台自动重试。启动只登记旧尝试未知，不自动运行工具 |
| 结果交付 | `sandbox_execution_intents.intent_id`、`kind=tool_result`，绑定原 Job 和结果版本 | 准备、派发、确认分开记录；重试仅补原受保护交付回执，不能重跑工具。`kind=continue` 仍属于能够变更资源的控制 |
| 自动审查 | 唯一 `reviewId/intentId`，绑定策略、模型配置和请求摘要 | Schema 39 先登记再调用模型，完成与审批、精确 Grant 和执行观察同事务；重复/迟到结果不产生第二次授权或步骤 |

源码依据：[工具身份与派发](../../../apps/agent-service/src/production-runtime-tools.ts)、[执行日志合同](../../../packages/application/src/ports/sandbox-execution-journal.ts)、[调用回执](../../../packages/application/src/ports/capability-invocations.ts)、[授权合同](../../../packages/application/src/ports/authorization.ts)、[文件准备](../../../packages/application/src/ports/host-files.ts)。以上是当前静态合同及已有局部测试的对应关系，不代表跨 boot 自动续接、所有风险保护或真实平台资格已完成。

兼容顺序仍为：先核对目标和备份，再迁移数据库和升级唯一 writer，最后接入理解相应版本的 Worker/合同。当前 Schema 41 使用 migration ledger 与 `minimum_writer_sequence` 阻止旧 writer；固定文件合同 2 和无目录网络 Scope v2 不能交给仅理解旧合同的 Worker。旧记录保持原含义，不由迁移补造释放证明。Schema 40 新增未绑定预约的停止标记，Schema 41 独立保存未启动宿主释放回执；目录改名原语与短时提交阶段还需分别确定最小数据扩展及 reader/Worker 组合回归，故 P0 的完整兼容条目仍未勾选。

[↑ 返回阅读导航](#contents)

<a id="files"></a>

## 三、修改、新建与保留的文件边界

[↑ 返回阅读导航](#contents)

下表是已存在的主要修改入口。实施时沿调用链补必要消费者，不因为这张表而对未受影响的文件做清理。

| 责任 | 主要现有文件或目录 | 所属阶段 |
| --- | --- | --- |
| 状态、资源与权限合同 | [执行合同](../../../packages/execution-contracts/src/sandbox-execution-v2.ts)、[journal 端口](../../../packages/application/src/ports/sandbox-execution-journal.ts)、[执行端口](../../../packages/application/src/ports/sandbox-execution.ts)、[授权端口](../../../packages/application/src/ports/authorization.ts) | P0～P5 |
| 授权与审批 | `packages/application/src/services/action-policy-service.ts`、`approval-service.ts`、`grant-service.ts`；`apps/agent-service/src/production-coding-workflow.ts`、`production-file-read-services.ts` | P2、P5 |
| 释放与恢复 | `packages/application/src/services/sandbox-execution-projection.ts`、`sandbox-execution-reconciliation.ts`、`sandbox-startup-recovery.ts`；`apps/agent-service/src/production-runtime-tools.ts`、`production-sandbox-tool-result.ts`、`production-run-reconciler.ts` | P1、P2 |
| 持久化与迁移 | `packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts`、`sqlite-capability-invocation-operations.ts`、`sqlite-run-dispatch-operations.ts`、`migration-engine.ts`、`migrations/` | P1～P5、P7 |
| 文件、命令与范围约束 | `packages/platform-node/src/files/`、`capabilities/sandbox-host-verifier.ts`、`workspaces/`；`packages/runtime-sandbox/src/policy.ts`、`job-host-main.ts` | P3、P4 |
| Pi 与 Worker 衔接 | `packages/runtime-pi/src/governed-coding-tools.ts`、`sandboxed-coding-executor.ts`；`apps/execution-worker/`；`capability-programs/pi-coding-main.ts` | P2～P5 |
| 页面与事件合同 | `packages/application/src/services/thread-execution-projection.ts`、`packages/gateway-contracts/`；`apps/control-center/src/execution-view.ts`、`run-approval.ts`、`components/execution-process.tsx`、`components/run-approval-card.tsx` | 各阶段、P6 |
| 验证接入 | `test/integration/`、相关包的 `test/`、`scripts/test-execution-chain-browser.mjs`、`scripts/test-authorization-feedback-browser.mjs`、`scripts/qualify-control-center-browser.mjs`、`ci/policy.json` | 全阶段 |

**计划内新增：** 现有记录无法表达时所需的最小 migration/状态类型；自动审查的产品端口和适配；跨 Worker 并发、恢复、自动审查与真实浏览器服务路径的持久测试。迁移编号按实施时实际序列分配；不先冻结重复文件名或另建整套框架。

**保留：** 已确认的 v4 原型和品牌资源、其他任务的未提交文件、生产数据、Pi 上游源码、现有 ADR 的历史决策。增加测试不能顺带恢复独立审批页、通用详情栏或删除会话。

<a id="tasks"></a>

## 四、分阶段实施任务

每个阶段按“确认预期 → 建立能检测该行为的测试 → 修改 → 同一路径验证 → 检查消费者”完成。实际进度以下方勾选和[实施记录](#implementation-record)为准；未勾选项目未完成。模块/文件边界见上一节；具体断言分配见[验收映射](#acceptance)。

<a id="p0"></a>

### P0：建立可执行的基线与合同

[↑ 返回阅读导航](#contents)

- [x] 重新读取当前工作树、源 Spec、依赖与既有调用链；保存相关文件摘要和既有失败，不覆盖父任务正在修改的内容。
- [x] 在既有 SQLite/journal 测试中复现凭证过期与 ACK 延迟 11ms/151ms 的边界，用可控时钟证明故障；该数字是历史复现输入，不是等待时间配置。见[复现日志](../../../test/qualification/evidence/workspace-authorization-lifecycle/p0-local-01/reproduction-red.log)。
- [x] 明确 operation、attempt、invocation、审批、额度预约、文件占用、恢复任务与交付消息的身份关系和各自持久化点，见[当前身份与持久化合同](#identity-contract)。复用现有字段；尚未实现的跨 boot 续接与短时提交不被当成已具备能力。
- [ ] 列出 release receipt（永久释放记录）、新风险保护、排队与文件提交阶段所需数据；确定迁移、reader、writer 和 Worker 的兼容顺序。没有可靠平台证据的安全原语列为后续资格检查，不能假定可用。
- [x] 按既有 ADR 治理记录必须新增的持久决策；[ADR 0030](../../adr/0030-durable-workspace-release-facts.md) 仅记录本 Spec 已确认的释放事实与风险保护原则，不改变历史 ADR。
- [x] 对照冻结 v4 原型补出新增场景并保存 r3；用户于 2026-09-16 明确确认，允许用于对应 UI 实现。冻结原型内“待审核”文字保留，批准事实以本条为准。
- [x] 检查现有真实浏览器路径的就绪条件；首次打开立即输入、慢配置/失败重试、连接未就绪时发送和重复 Enter 已加入原浏览器入口，断线完成继续复用执行链回归，见[首次加载证据](../../../test/qualification/evidence/workspace-authorization-lifecycle/p0-local-02/browser/immediate-startup.json)。这些是隔离 HTTP 夹具回归，真实服务验收仍由 P6 负责。

**出口：** 故障复现、字段/事件兼容方案和测试接入点具体可用。未定模型配置不阻塞其他阶段；新交互审核只影响相关 UI，不把后台必要准备全部挂起。发现与已通过 Spec 矛盾的事实时先说明差异，不擅自重写产品规则。

<a id="p1"></a>

### P1：修复资源释放与可恢复状态

[↑ 返回阅读导航](#contents)

- [x] 在新观察接纳时验证凭证时效、身份、序号与执行权；核验成功后以 SQLite 短事务同时保存永久释放记录并结束对应占用。未来读取验证历史记录真实性，不重新使用当前时间推翻已释放事实。
- [x] 将能启动/变更资源的控制消息与只交付结果的消息分开；结果 ACK 迟到、丢失或重复不使资源重新被占用，也不重新执行工具。
- [ ] 停止后确认进程及后代不可再写；对可能迟到的派发保留 fencing。迟到矛盾证据按实际风险建立新 incident/barrier，不能抹掉原释放记录。修改对应旧测试时保留风险拦截要求并记录合同变更原因。
- [ ] 修复 pending 查询、startup/reconcile 的盲区：查出 released 残留 claim、已结束 Run 仍有资源、派发结果丢失和结果未交接等情况；恢复任务有 owner、下次动作、次数/期限和终点。
- [ ] 拆开准入错误、明确未派发、已执行失败、部分修改和效果未知；替换吞掉具体原因的大范围 catch，保留受保护诊断与安全 reasonCode。
- [ ] 工具超时、无进展检测、停止宽限与重试分别处理；按证据选择 inspect/stop、可安全重试、已知失败或 unresolved。权限过期仍可受限清理，不恢复旧执行或披露权限。
- [ ] 同步修正页面错误分类：未派发不显示正在写入，核验无结论不无限转圈，已停止不抹掉已产生的修改。

**出口：** 原复现先失败后通过；延迟通知不反锁，真实旧 writer 未被隔离前仍拦住冲突请求。重启和数据库独立读回证明资源、结果、交付记录一致，不能只看页面成功提示。

<a id="p2"></a>

### P2：实现审批、额度与执行的连续性

[↑ 返回阅读导航](#contents)

- [ ] 直接覆盖生产使用的 `ActionPolicyService`、Approval/Grant 装配；不能仅凭旧 Permission 测试同名就判定生产路径已验证。
- [ ] 统一不可变请求快照、版本和幂等身份；两设备决定、批准与拒绝/过期/取消按持久顺序决定，错主体与跨会话请求被拒绝。
- [ ] 将一次额度预约、实际派发承诺和明确未派发时释放分别处理；同操作排队/恢复不消耗第二次额度，可能已派发的不确定额度不能退给另一请求。
- [ ] 出队与派发前重新检查期限、撤销、预算、目标、硬拒绝和取消；批准是历史事实，有效执行权限另判。
- [ ] 区分具体内容单次批准与已有范围授权。新内容建立新 intent，确有覆盖的有效范围授权才复用；策略放宽不自动复活过去拒绝。
- [ ] 执行中撤销阻止后续派发/披露，并进入受控停止与核实；已提交效果如实保留。沿用同会话确认与红点，不创建新的汇总入口。

**出口：** 准入前副作用为零，重复批准不产生第二次执行，排队/断线不用重新索要同一批准；权限真实失效仍阻止启动。新增事件同步送入 P6 的单一页面投影。

<a id="p3"></a>

### P3：细化文件占用并安全保存

[↑ 返回阅读导航](#contents)

- [ ] 宿主按本次具体操作生成资源集合，分别表达目标路径槽位、文件身份与兼容的祖先路径稳定要求；不能继续从整个目录 grant 的操作列表推导文件排他范围。
- [ ] 在既有持久存储中一次取得全部相交资源或全部不取，支持取消、公平队列和出队重验。读读、无依赖的不同文件并行；同文件提交互斥；新冲突请求不能饿死旧请求，无关资源不被队首阻塞。
- [ ] 实现目录改名协议：等待当前相关文件操作，阻止新冲突操作插队，改名前检查源/目标，改名后重新解析身份和授权。跨文件系统移动不伪装成原子改名。
- [ ] 复用受控文件接口：准备完整内容，保存时再拿短时提交权；新建不覆盖发布、替换前检查身份和内容版本。验证同文件系统暂存、文件权限、链接、大小写别名和崩溃持久性。
- [ ] 文件提交前后持久记录阶段和效果，覆盖文件系统与 SQLite 之间的失败间隙；多文件中断明确部分结果，禁止用整批回滚覆盖新编辑。
- [ ] 冲突后保留候选，释放不再需要的锁；已有授权覆盖时经 Pi 现有循环读取最新内容重新生成，保留前后请求关联；无法判断意图、超范围、超预算或持续冲突时暂停并明确说明。
- [ ] 验证原子替换时读取可得完整旧/新版本，依赖最新写入时等待前序；原地写入期间不允许相关稳定读取看到半成品。手工外部写者不受产品锁控制时，只承诺已验证的检测能力，不声称严格 CAS。

**出口：** 两个不同文件可真实同时推进；同一文件无静默丢失更新。Mac 与 Linux 的目标文件系统分别有实际证据，缺失平台证明不得标记该平台完成。

<a id="p4"></a>

### P4：接好当前目录执行与可选工作副本

[↑ 返回阅读导航](#contents)

- [ ] 复用工具描述、命令 profile 和 Pi Operations，按受控文件工具、任意程序、远程服务确定执行方式。模型自报与工具注解不是权限凭据。
- [ ] 将 Bash 的当前目录、读写及网络上限落实到现有沙箱；协调范围与真实可强制的上限一致。当前适配器禁止把部分写授权升级为任意 Shell 的检查必须保留，除非已有可强制的更窄执行路径和相应测试。
- [ ] 平台无法精确限制时，给出更窄方案、明确的真实共享范围或按任务需要选择私有环境；禁止只登记文件 A 却允许命令写整个目录，也不强制所有命令使用副本。
- [ ] 纯联网搜索与用户目录授权/挂载/claim 脱钩，私有临时区单独管理；将搜索结果保存成文件是另一个获准文件操作。
- [ ] 复用已具备资格的候选环境/Git 适配能力。普通目录采用受限内容/身份基线；Git worktree 需明确未提交与未跟踪输入的处理，不把 HEAD 误当用户当前状态。不修改 Pi 上游、不自动切换产品 Git 工作方式。
- [ ] 可选副本只应用本次授权差异：检查基线/现状、必要时重生成、受控逐文件提交、独立读回；不整目录覆盖。候选结果等待确认不占共享锁，唯一结果不因超时被清理。
- [ ] 端口、Git index、数据库与远端效果分别协调；长运行任务/服务显式保留 owner，启动返回不等于资源结束。

**出口：** 同一文件任务不因 Git 存在与否改变权限语义；真实沙箱限制经过尝试越界的测试。工作副本保持可选，无效隔离不回退到无约束执行。

<a id="p5"></a>

### P5：把自动审查接入原权限入口

[↑ 返回阅读导航](#contents)

- [x] 在现有 ActionPolicy 中增加可选审查调用：硬拒绝 → 有效授权/允许规则 → 符合委托范围才自动审查 → 必要人工确认/拒绝。未配置时保留现有人工处理路径。
- [x] 定义结构化审查请求/结果并绑定请求摘要、政策版本、模型配置版本与决策来源。批准范围由宿主校验，审查模型的自由文本不能直接创建广泛 grant 或命令执行。
- [ ] 通过现有 runtime-pi 模型访问边界、披露与预算治理接入选定服务；先用受控替身验证分支，不能为了测试擅自新增 provider 或付费调用。
- [ ] 覆盖审查通过、建议安全替代、需要人工决定、拒绝、超时、无效输出和注入文本。安全替代产生新请求并重新准入；不确定/故障不默认放行。
- [ ] 审查等待期间无本次文件 claim。重启/重复结果不再派发；迟到审查不能覆盖撤销、取消、过期或新请求。自动批准不展示成“用户已确认”。
- [ ] 提交[具体启用建议](#decisions)，配置获确认后验证真实模型的请求、决策、执行和费用记录，再启用自动审查。真实效果验证不足时仅报告接入/替身测试结果。

**出口：** 自动审查与人工批准使用同一受限执行入口。既有授权场景不额外调用审查模型；硬拒绝不能绕过；真实服务未验证前不能宣称 Auto-review 已可生产使用。

<a id="p6"></a>

### P6：同步页面状态，并验证完整用户路径

[↑ 返回阅读导航](#contents)

本阶段贯穿 P1～P5，最后做跨阶段验收。前端以已确认的 v4 基准与 P0 新场景审核结果为准，不用演示时间或固定输出替代真实数据。

- [ ] 由后端统一投影提供 phase、reason、actions、effect、timing、revision 与 needsAttention；顶部、工具行、Stop 和会话红点消费相同事实。
- [ ] 默认显示当前状态、必要动作和结果，步骤细节可展开；待确认卡片在窄屏保持可达。无用户行动需求时不点红点，保持无独立审批页/通用详情栏/删除会话。
- [ ] 分别记录审查、用户确认、冲突等待、准备、执行、核验、清理与可观察模型输出。并行执行用区间并集；断线外推明确边界，最终时长由执行记录校正。
- [ ] 扩展已有 Playwright 脚本与 fixture 服务验证新增状态、键盘、明暗、320/390/1024/1440 宽度、长路径与 200% 缩放；保留真实工具语义图标和中性焦点。
- [ ] 独立验证首次访问/刷新/恢复历史会话，按钮刚出现立即点击、等待后点击、慢配置/连接失败/恢复，重复发送、创建中切换会话。不得先全局等待连接成功再宣称覆盖首次加载。
- [ ] 在同一测试体系中增加真实网关→ActionPolicy→SQLite→Worker→受限文件操作→页面恢复的路径。模型输入可先受控，但关键权限、占用、文件修改和结果回传不得模拟；真实 provider 验收单列。
- [ ] 每条路径检查可见反馈、持久结果、失败后可继续方式、重复/串会话/内容丢失；批准前零效果，批准后一次效果，拒绝后零效果。用独立文件和数据库读回，不能只断言卡片消失。
- [ ] 给真实服务路径补可重复的启动、就绪、隔离数据、取消和清理步骤，并接入已有 CI policy；新增测试文件必须被 runner 收集。fixture-only 浏览器结果不能冒充真实端到端结果。

**出口：** 审核原型和实际页面一致，截图/trace 可追溯；批准、断线恢复、并发写、取消、结果未知和自动审查都有相应真实边界证据。停止清理验证包含子进程与 claim，不只结束浏览器。

<a id="p7"></a>

### P7：迁移演练、部署准备与受控交付

[↑ 返回阅读导航](#contents)

- [ ] 在隔离数据库副本上验证扩展迁移、旧记录读回、新旧 reader/writer/Worker 组合；不理解新状态的旧 writer 必须阻止写入，不可静默降级。
- [ ] 编写历史恢复的只读清单与 dry-run：列出旧 claim、派发、资源、回执和恢复原因。只有现场证明旧资源与迟到派发不能再写，才生成逐条修复候选；不得把过期历史凭证伪造为新证明。
- [ ] 演练备份及恢复、写入调度暂停、逐条 CAS 修复和恢复后 read/search→write。对未派发的原失败请求明确结束，不替用户重新生成或保存文件。
- [ ] 制定具体构建、兼容、切换、观测和回退 Runbook；新决策按 ADR 治理记录，实际完成后同步 Architecture/README。部署前核对目标、构建摘要与新请求授权，不把历史临时 sudo 当作当前权限。
- [ ] 涉及 Hermes 大量写入前读取主机操作规范，核实数据盘和资源；历史数据备份、迁移与证据不得误写拥挤的根盘。共享主机测试使用隔离路径/端口，不清理无关任务。
- [ ] 在实际部署授权成立后，按 Runbook 做当次只读 preflight、备份、切换和独立读回；缺少现场资源/权限证据时停止对应上线步骤，不声称生产完成。
- [ ] 回退保留新消息、审批与效果事实；不理解新 schema 的旧程序不得直接接管 writer，不以恢复旧数据库覆盖上线后用户数据。

**出口：** 迁移/回退演练和实际部署证据分开记录；只有实际生产验证通过才能报告上线。仍被保护的资源有明确原因和后续责任，不能靠强制解锁清空指标。

<a id="acceptance"></a>

## 五、68 项验收要求如何验证

[↑ 返回阅读导航](#contents)

验收语义以来源 Spec 的矩阵为准。下面逐项分配实施责任、测试入口和必须检查的证据；**完整产品验收仍待完成；已有局部验证的范围与限制见[本次实施记录](#implementation-record)**。一个场景可能需要多个用例，68 行不代表恰好只写 68 个测试。失败前证据适用于可复现缺陷，不伪造新增功能的历史失败。

<a id="test-entries"></a>

### 测试入口索引

下列代号只为减少表格重复，链接指向已存在的测试。它们是当前扩展入口；仅列出测试路径不代表已经覆盖整项要求，实际执行结果见[本次实施记录](#implementation-record)。

- **J**：[SQLite 执行记录](../../../test/integration/sqlite-sandbox-execution-v2.test.ts)、[执行准备](../../../test/integration/sandbox-execution-preparation.test.ts)、[Worker 生命周期](../../../test/integration/sandbox-v2-worker-lifecycle.test.ts)。
- **A**：[权限额度](../../../test/integration/permission-grants.test.ts)、[生产审批订阅](../../../test/integration/production-approval-subscription.test.ts)；补充生产 ActionPolicy 的直接集成断言。
- **F**：[受控文件](../../../packages/platform-node/test/constrained-file-system.unit.test.ts)、[Pi 文件操作适配](../../../packages/platform-node/test/sandboxed-coding-operations.unit.test.ts)、[宿主身份](../../../packages/platform-node/test/sandbox-host-verifier.unit.test.ts)；新增跨 Worker 文件协调集成测试。
- **S**：[生产范围](../../../test/integration/production-sandbox-scope.test.ts)、[运行库策略](../../../packages/runtime-sandbox/test/policy.unit.test.ts)、[候选工作区](../../../packages/platform-node/test/qualified-candidate-workspace.unit.test.ts)、[Git 适配](../../../packages/platform-node/test/git-workspace-adapter.unit.test.ts)。
- **T**：[运行时工具](../../../apps/agent-service/test/production-runtime-tools.unit.test.ts)、[运行历史](../../../test/integration/runtime-history.test.ts)、[外部效果核验](../../../test/integration/external-action-reconciliation.test.ts)。
- **B**：[页面投影](../../../apps/control-center/test/execution-view.unit.test.ts)、[Playwright 执行链](../../../scripts/test-execution-chain-browser.mjs)、[授权反馈](../../../scripts/test-authorization-feedback-browser.mjs)、[浏览器主入口](../../../scripts/qualify-control-center-browser.mjs)；P6 补真实服务路径，不能仅用 fixture。
- **R**：[自动审查与持久化](../../../test/integration/automatic-action-review.test.ts)；复用 A/T/S。真实配置资格测试仍待配置获确认后执行。
- **M（拟扩展）**：既有 migration engine 与 J 的旧数据库 fixture，加兼容、只读修复预览、逐条恢复及回退测试。

| Spec ID | 主责阶段 | 测试入口 | 必须读回或证明的结果 |
| --- | --- | --- | --- |
| A01 | [P2](#p2) | [A/S](#test-entries) | 硬拒绝优先；有效授权执行一次 |
| A02 | [P2](#p2) / [P6](#p6) | [A/J/B](#test-entries) | 批准前无 invocation、文件效果或本次占用 |
| A03 | [P2](#p2) / [P6](#p6) | [A/J/B](#test-entries) | 两设备仅一个决定和一个逻辑执行 |
| A04 | [P2](#p2) / [P6](#p6) | [A/B](#test-entries) | 边界时刻以服务端为准，过期零派发 |
| A05 | [P2](#p2) / [P5](#p5) | [A/R](#test-entries) | 新内容新 intent；只有真实范围覆盖可复用 |
| A06 | [P2](#p2) | [A/J](#test-entries) | 取消先提交时迟到批准不启动 |
| A07 | [P2](#p2) / [P3](#p3) | [A/J](#test-entries) | 出队失效后不执行，预约按事实释放 |
| A08 | [P2](#p2) / [P6](#p6) | [A/J/S/B](#test-entries) | 撤销无后续派发；真实停止和已有效果分别记录 |
| A09 | [P1](#p1) / [P2](#p2) | [J/S](#test-entries) | 旧 grant 失效仍可 inspect/stop，不获得新业务权限 |
| A10 | [P2](#p2) / [P6](#p6) | [A/B](#test-entries) | 搜索记住选择范围保持不变，拒绝不产生长期 grant |
| A11 | [P2](#p2) | [A](#test-entries) | 未生效/收紧阻止，放宽不复活已拒绝请求 |
| A12 | [P2](#p2) / [P6](#p6) | [A/B](#test-entries) | 错误主体与串会话零决定；重新认证只读回现状 |
| A13 | [P2](#p2) / [P3](#p3) | [A/F](#test-entries) | 目标替换后拒绝旧提交，不覆盖不同对象 |
| W01 | [P3](#p3) | [F/J](#test-entries) | 用可控并发屏障证明两读同时在执行 |
| W02 | [P3](#p3) | [F/J](#test-entries) | 冲突区间不重叠，排队可取消且无饥饿 |
| W03 | [P3](#p3) | [F/J](#test-entries) | 两个不同文件可同时推进，无全目录串行 |
| W04 | [P3](#p3) | [J/F](#test-entries) | 相反申请次序也不会各持部分资源死等 |
| W05 | [P3](#p3) | [J/F](#test-entries) | 持续新 reader 不越过先到冲突 writer |
| W06 | [P1](#p1) / [P3](#p3) | [J/S](#test-entries) | 无进程且派发已撤销才释放；迟到派发被阻止 |
| W07 | [P3](#p3) | [F/S](#test-entries) | 真实链接/挂载/身份变化不绕开协调 |
| W08 | [P4](#p4) | [S/T](#test-entries) | 搜索无用户目录 grant/挂载/claim，保存另行准入 |
| W09 | [P1](#p1) | [J](#test-entries) | 11ms/151ms 及等于到期边界；历史释放不反锁 |
| W10 | [P1](#p1) / [P6](#p6) | [J/T/B](#test-entries) | 丢失与重复 ACK 只重交结果，执行计数不增 |
| W11 | [P1](#p1) | [J/S](#test-entries) | 实际后代仍可写时，第二个冲突 writer 被拦住 |
| W12 | [P1](#p1) | [S/J](#test-entries) | PID/boot/fence 变化不接管或误杀无关进程 |
| W13 | [P1](#p1) / [P4](#p4) | [J/S](#test-entries) | 服务启动返回后仍有 owner 和必要 claim |
| W14 | [P1](#p1) / [P3](#p3) | [J/F](#test-entries) | 已停稳定部分文件可获准诊断读取，不全区冻结 |
| W15 | [P1](#p1) | [J](#test-entries) | 新风险另记保护；旧 released_at/凭据不被抹掉 |
| W16 | [P3](#p3) | [F](#test-entries) | 真实并发读取只有完整版本；依赖最新值时等提交 |
| W17 | [P3](#p3) | [F/J](#test-entries) | 中断无正式半成品，新建同名竞争不覆盖 |
| W18 | [P3](#p3) | [F/J](#test-entries) | 同基线两个 writer 一个提交、另一个冲突 |
| W19 | [P3](#p3) | [F/J](#test-entries) | 硬链接/大小写/目录别名正确协调，不同文件仍并行 |
| W20 | [P4](#p4) / [P6](#p6) | [S/F/B](#test-entries) | 候选环境耗时或等待确认不占主目录；普通命令无强制副本 |
| W21 | [P3](#p3) / [P4](#p4) | [F/J](#test-entries) | 逐文件部分结果持久；恢复不覆盖之后外部编辑 |
| W22 | [P3](#p3) | [F/S](#test-entries) | 双平台 no-replace/跨盘条件不支持时明确阻止 |
| W23 | [P1](#p1) | [T/J](#test-entries) | 只读安全重试有界；非幂等未知不重发 |
| W24 | [P3](#p3) | [F/J](#test-entries) | 改名等待当前冲突操作；新冲突排后，无关继续 |
| W25 | [P3](#p3) | [F/J](#test-entries) | 改名后身份/目标重验，跨盘操作不冒充原子改名 |
| W26 | [P4](#p4) | [S/J](#test-entries) | 真实尝试越界失败；协调范围覆盖可写上限 |
| W27 | [P3](#p3) / [P4](#p4) | [F/S](#test-entries) | 非 Git 与有未提交/未跟踪内容的 Git 均不丢现有输入 |
| W28 | [P4](#p4) | [S/T](#test-entries) | 虚假工具注解及间接子进程不能绕过宿主限制 |
| W29 | [P3](#p3) / [P6](#p6) | [A/F/T/B](#test-entries) | 新 intent 重新检查版本；模型生成时不持提交锁 |
| W30 | [P3](#p3) | [A/F/T](#test-entries) | 确切批准不扩大；持续冲突/预算耗尽有明确终点 |
| R01 | [P5](#p5) | [R/A/S](#test-entries) | 模型建议通过也不能越过硬拒绝 |
| R02 | [P5](#p5) | [R/A](#test-entries) | 已有覆盖授权时审查调用次数为零 |
| R03 | [P5](#p5) | [R/T/S](#test-entries) | 审查决定绑定并经原 Pi/Worker/沙箱执行，范围不扩大 |
| R04 | [P5](#p5) / [P6](#p6) | [R/A/B](#test-entries) | 各结果分支准确；安全替代重新准入，故障不默认放行 |
| R05 | [P5](#p5) | [R/A/J](#test-entries) | 迟到和重复结果不复活失效请求或重复执行 |
| R06 | [P5](#p5) | [R/T](#test-entries) | 未配置/超委托范围无外发和费用，回到合法人工/拒绝路径 |
| R07 | [P5](#p5) | [R/A](#test-entries) | 不可信文本无法更改授权规则或指令来源 |
| E01 | [P1](#p1) / [P2](#p2) | [J/A](#test-entries) | 事务中断不丢额度、不产生孤儿占用 |
| E02 | [P1](#p1) / [P2](#p2) | [J/T](#test-entries) | 崩溃后区分未发送和可能发送；不盲重发 |
| E03 | [P1](#p1) | [J/T/F](#test-entries) | 真实修改后结果丢失，按原身份核验且不重复修改 |
| E04 | [P1](#p1) / [P6](#p6) | [S/T/B](#test-entries) | 实际非零退出带部分修改，不能显示未执行 |
| E05 | [P1](#p1) / [P2](#p2) / [P6](#p6) | [J/A/B](#test-entries) | 取消和完成竞争保留真实效果和停止意图 |
| E06 | [P1](#p1) / [P3](#p3) | [J/F/S](#test-entries) | 故障注入前后分别验证阻止或证据恢复；不损伤真实工作目录 |
| E07 | [P1](#p1) / [P2](#p2) | [J/T](#test-entries) | 服务重启、旧 epoch、事件乱序重复无倒退或重跑 |
| E08 | [P1](#p1) / [P6](#p6) | [J/S/B](#test-entries) | 核验达到边界显示待确认，不假解锁或无限转圈 |
| E09 | [P1](#p1) | [T/J](#test-entries) | 未知非幂等接口调用计数不增加 |
| U01 | [P6](#p6) | [B/T](#test-entries) | 首次打开立即操作也有反馈、草稿与归属正确 |
| U02 | [P6](#p6) | [B/J/A](#test-entries) | 断线完成/审批后快照恢复，不重复提交 |
| U03 | [P6](#p6) | [B/T](#test-entries) | 顶部、工具行、红点与按钮反映同一后端事实 |
| U04 | [P6](#p6) | [B/T/J](#test-entries) | 真实分段及并行区间；60 秒等待不计入 2 秒写入 |
| U05 | [P6](#p6) | [B](#test-entries) | 四档宽度、明暗、缩放、键盘与可访问性有截图/断言 |
| U06 | [P4](#p4) / [P6](#p6) | [B/J/S](#test-entries) | 停止目标后台服务不取消无关会话或偷换 owner |
| U07 | [P5](#p5) / [P6](#p6) | [B/R](#test-entries) | 主信息简洁、细节可展开、需用户行动才点红点 |
| M01 | [P7](#p7) | [M/J/S](#test-entries) | 只读预览→新核验证据→逐条修复；未证实不释放 |
| M02 | [P0](#p0) / [P7](#p7) | [M/J/S](#test-entries) | 旧 reader/writer/Worker 遇不兼容合同明确阻止而非降级 |

在对应状态的持久化前后注入崩溃、重复、乱序和相反决定。采用可控时钟/调度屏障，不用任意 sleep 制造“通过”；重复执行必须独立计数。对仍未覆盖或环境不具备的场景逐项标明原因，不以“已有同名测试”代替验证。

<a id="verification"></a>

## 六、验证命令、环境与证据

[↑ 返回阅读导航](#contents)

### 6.1 先核对运行环境

项目要求 Node `>=22.19.0`，固定包管理器 `npm@11.8.0`。命令来自当前 `package.json`、`vitest.workspace.ts` 和脚本参数；下列都是后续实施命令，本次编写 Plan 没有运行它们。使用已安装的依赖，不让命令隐式下载其他版本。

本地标准 CI 入口需要有效 `.ci-output/tools/installation.json` 或明确指定的工具目录。缺少时按仓库既有工具安装流程处理，不把工具缺失报告为产品缺陷，也不跳过要求后宣称全部通过。

### 6.2 开发期间的最小测试

优先选本阶段受影响文件，不在每次小改后跑全套。下面入口均已存在；新增测试写成被当前 runner 收集的文件，再将其路径加入对应运行命令。

```sh
npm run test:integration -- test/integration/sqlite-sandbox-execution-v2.test.ts test/integration/sandbox-execution-preparation.test.ts
npm run test:integration -- test/integration/permission-grants.test.ts test/integration/production-approval-subscription.test.ts
npm run test:unit -- packages/platform-node/test/constrained-file-system.unit.test.ts packages/platform-node/test/sandboxed-coding-operations.unit.test.ts packages/platform-node/test/sandbox-host-verifier.unit.test.ts
npm run test:services -- apps/agent-service/test/production-runtime-tools.unit.test.ts
npm run test:browser -- apps/control-center/test/execution-view.unit.test.ts
npm run check:pi-compat
```

其中 `test:browser` 是 UI 逻辑单元测试，`test:e2e` 的名字也不保证使用真实浏览器。须检查实际执行路径，不能依名称报告覆盖范围。

### 6.3 真实浏览器与真实服务

先构建再使用仓库的 Playwright 主入口，例如：

```sh
npm run build
node scripts/qualify-control-center-browser.mjs chromium --report-directory test/qualification/evidence/workspace-authorization-lifecycle/local-chromium-01
```

报告目录是建议的独立运行位置，执行时使用新的 run 标识，不覆盖旧证据。上述现有入口使用 fixture 服务；Firefox/WebKit 按当前 CI policy 同样验证，缺浏览器需报告环境缺口。P6 增加的真实服务路径应接在现有启动/测试体系并注册 CI；**该路径目前尚未实现，不能虚构一条已经可运行的完整 E2E 命令**。实现时将其准确命令、依赖、就绪条件和清理方式补回本 Plan。

fixture 测试可控制网关响应来覆盖展示，但真正的审批与文件安全验收必须使用真实权限、SQLite、Worker、沙箱和独立文件读回。真实模型资格在选定且获授权的配置下单独执行，费用与接收方可追溯。

### 6.4 阶段交付与最终验证

实施批次按可验收行为组织，不按单个补丁或提交拆分。同一批次内先完成相关实现并运行定向测试；共享端口修改后立即检查调用方和测试替身，新运行模块先验证加载与类型。源码稳定后集中执行本节要求的交付验证，并一次更新相关文档；已有结果仅在输入与环境未受影响时复用。进展以原验收条件和剩余证据报告，不以提交数或测试总数估算完成度。

当前批次为 P1 的恢复尝试隔离：超时回调不再进入核验或写入，被接管的旧任务不能提交释放证明或结束新任务，并发操作结果与永久释放事实保持。服务入口、真实 SQLite 事务、生产存储端口及重开读回一起验收；不将此批通过等同于已启动进程及后代的完整资格。

```sh
npm run check
npm run test
npm run build
python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .
```

`npm run test` 通过标准本地 CI 工具链运行；按影响补足 contracts、integration、Pi compatibility 与真实浏览器，重复结果只在代码与环境未失效时复用。Mac/Linux 实际平台、安装包与生产验证分别报告，不能用当前电脑单平台通过代替其他平台。

### 6.5 证据应保存什么

每次执行保存 commit/相关未提交文件摘要、平台与依赖身份、命令、场景 ID、预期/实际、结果和未验证范围。问题复现保留修复前后结果；浏览器保留脱敏网络错误、截图与必要 trace；文件/资源测试保留独立读回、调用计数和清理结果。

建议放在 `test/qualification/evidence/workspace-authorization-lifecycle/<run>/` 或既有 CI 专用证据目录，不能放在测试结束必删的临时目录。临时数据库/工作区与证据分离，清理后确认日志仍在。公开 CI 不保存令牌、原始私密文件、未脱敏请求或模型隐私内容。

<a id="decisions"></a>

## 七、待确定的配置与停止条件

[↑ 返回阅读导航](#contents)

| 待确定事项 | 下一步由实施者准备什么 | 阻塞范围 |
| --- | --- | --- |
| 自动审查模型/服务、资料披露、费用与时延预算 | 核对当前可复用配置，提出具体身份、输入最小集合、目的地和成本建议 | 真实服务调用与启用；不阻塞 P1～P4 或本地替身测试 |
| 自动批准类别、范围与额度 | 给出各类操作能自动批准/必须询问/禁止的具体表，不把模糊风险标签当授权 | 自动批准启用 |
| 新增状态交互 | 在原 v4 基础上补 P0 所列原型，明确按钮效果与真实计时来源 | 对应新增 UI 实现；不重开已通过的后台原则讨论 |
| 工具期限、停止宽限、重试与候选保留参数 | 按 provider/工具合同、平台能力与测量给出依据 | 对应策略定值；无统一两分钟，不自动扩大费用/权限或删除唯一结果 |
| 实际部署和历史记录修改 | 构建摘要、备份、逐条 dry-run、目标环境与回退方案 | 生产切换/数据写入，须具体授权 |

无法强制执行的文件/网络范围、目标身份无法确认、旧 writer 仍可写、迁移不兼容、必要测试失败，是停止对应危险动作的条件。它们不意味着把整工作区永久锁住；无关已授权任务保持可用。需要改变已通过的设计时提出最小差异及依据，不在 Plan 中偷换方案。

<a id="closure"></a>

## 八、交付与结束条件

[↑ 返回阅读导航](#contents)

- [ ] 各阶段实现与全部验收 ID 有对应证据，失败、跳过和未具备环境的项目明确列出；没有用增加重试/超时或弱化断言掩盖问题。
- [ ] 原始残留占用缺陷有失败前/通过后证据；释放后延迟事件不反锁，旧资源仍可写时不误放行。
- [ ] 原型、页面状态与真实执行一致；审批和工具效果有独立读回，分段耗时真实，正常情况不暴露冗余内部状态。
- [ ] 迁移、恢复、兼容、回退和资源清理已验证；真实部署状态与本地完成状态分开报告。
- [ ] 架构/运行文档只写已落地事实，ADR 保留历史；更新受影响的操作说明及文档导航，严格治理校验通过。
- [ ] 交付前检查是否已有项目验证 skill；存在且本次核心路径变化使其过时时按维护规则处理，不存在则不自动另建验证体系。
- [ ] 完成的独立开发变更按项目规则验证并形成范围清晰的本地提交；保护其他任务变更。推送/部署另按实际授权执行。本次编写待审核 Plan 不提交尚未实施的产品工作。
- [ ] 后续若获准缩减交付范围，剩余事项明确进入 Backlog；不得仅因本地一部分测试通过就将整个 Spec/Plan 归档。
- [ ] 只有实际工作完成并完成文档治理结束检查后，使用治理脚本归档 Spec/Plan；设计审核通过本身不是归档条件。

### 本次计划编写的验证边界

编写 Plan 时仅核对代码入口、锁定依赖、Pi 可复用能力、现有测试与 runner、治理模板及批准的 Spec；当时未运行上述产品验证命令。后续实施进度以[本次实施记录](#implementation-record)为准。本次交付执行文档治理、链接/锚点、68 项验收映射完整性与格式检查。对源码的静态判断不冒充生产复测或平台资格。


<a id="implementation-record"></a>

## 本次实施记录：P0 交互已确认，实施进行中

[↑ 返回阅读导航](#contents)

### 基线和实际实验

基线为 `753fb63c56417de3b480705701c45602f83f9967`，当前分支 `codex/ux-fixes`。保留原有 `AGENTS.md` 修改、Plan/Spec、r1/r2 原型和历史资格证据。当前机器为 macOS arm64；Node 22.22.3，实验明确使用 `.ci-output/tools/npm/package/bin/npm-cli.js` 的 npm 11.8.0（shell 默认 npm 是 10.9.8）。未发现项目验证 skill。此记录不代表 Linux、真实 Worker/沙箱或生产资格。

- [工作区及相关源码摘要](../../../test/qualification/evidence/workspace-authorization-lifecycle/p0-local-01/baseline.json)。
- [原有基线结果](../../../test/qualification/evidence/workspace-authorization-lifecycle/p0-local-01/baseline.log)：`sqlite-sandbox-execution-v2.test.ts` 与 `sandbox-execution-preparation.test.ts`，共 84 项通过。
- [新增故障复现](../../../test/qualification/evidence/workspace-authorization-lifecycle/p0-local-01/reproduction-red.log)：直连与数据库 Worker 两种执行路径；各自到期前 1ms 通过，恰好到期、晚 11ms、晚 151ms 失败，共 2 通过、6 失败。失败来自释放记录仍为空，不是环境或依赖错误。
- 失败后独立查询显示 `supervision=released`、`cleanup=confirmed`，ACK 已落库，`listPending` 却为空，下一写入仍被 `Workspace remains occupied` 拒绝。查询日志保留在上述复现输出中。
- [可重复实验脚本](../../../test/qualification/evidence/workspace-authorization-lifecycle/p0-local-01/reproduce-release.mjs) 与 [测试源](../../../test/qualification/evidence/workspace-authorization-lifecycle/p0-local-01/release-reproduction.test.ts.txt) 保留。脚本临时将用例放到现有 integration runner 收集位置，拒绝覆盖同名文件，结束后删除自己创建的用例；所有数据库由原有 fixture 隔离并清理。正式修复时将回归纳入常规测试，不能把当前已知失败解释为修复完成。

复现命令（当前基线预期退出码为 1）：

```sh
node test/qualification/evidence/workspace-authorization-lifecycle/p0-local-01/reproduce-release.mjs
```

### P1/P2 所需身份与持久化边界核查

下表记录实现入口与约束。Schema 33 已加入永久释放表、独立保护与恢复记录，其他协议仍按未完成项处理。完整合同和兼容组合仍需随实现验证，P0 对应任务暂不勾选。

| 对象 | 可复用的现有身份 / 存储点 | 实施时必须保持或补足 |
| --- | --- | --- |
| 逻辑操作与审批 | `GovernedActionIntent.id/idempotencyKey`；`ApprovalRequest.intentId/revision/semanticSnapshotHash` | 相同请求重放使用原身份；内容或目标变化建立关联的新请求；批准的历史事实不能替代当前执行许可 |
| 授权额度 | `GrantRecord.id/revision`；`ConsumeGrantInput.usageId=authorization-usage:<intent.id>` | 当前 ActionPolicy 已按 intent 幂等消费；仍须拆开预约、实际派发承诺与明确未派发后的释放 |
| 实际调用 | `FrozenCapabilityInvocationReceipt.invocationId/receiptRef/semanticFingerprint` | 沿现有原子消费事务；不因排队或恢复再生成一次调用来规避限额 |
| 执行尝试与资源 | `SandboxJobIdentity.jobId/attemptId`；`environmentId/resourceRef`；`sequence/operationRevision` | 记录绑定原 Run、Worker boot 和 authority fence；资源观察与结果版本各自 CAS |
| 工作区占用 | `sandbox_workspace_occupancy(job_id,scope_ref)`；宿主 inode/device lineage | 当前为目录粒度；新增文件身份、路径槽位与祖先稳定要求时，不直接把目录 grant 当提交锁 |
| 永久释放凭据（P1 已实现并定向验证） | 关联原 job、attempt、环境、观察序号和原始宿主验证 | 保留被接纳事实、证据摘要、接纳时刻与权威身份；新观察必须在有效期内验证；历史读不重验当前 TTL |
| 新风险保护（待实现） | 关联原操作与实际冲突资源 | 独立风险身份、原因、证据、owner 和后续动作；禁止将旧 `released_at` 改回空值表达新风险 |
| 结果交接 | `sandbox_execution_intents.intent_id/kind/sequence/operation_revision` | `tool_result` 与可能引起执行的控制消息分开；ACK 只结束交接，不恢复旧占用 |
| 恢复任务（待补全） | 既有 Run checkpoint、执行 journal 和 Agent authority | owner、下次动作、次数/期限与明确终点；恢复不得具备重新启动未知非幂等操作的旁路 |

迁移顺序：先扩展 reader/存储与验证入口，在隔离数据库演练；再接新 writer 和相应 Worker 版本检查；然后开放调度与新 UI 投影。当前 migration engine 已有 `assertWritableSchema` 和 `minimum_writer_sequence`，应复用并补新旧组合测试。现有记录没有可追溯的新释放凭据时不得自动回填；只读列出修复候选，在新的现场证据和具体授权成立后逐条更新。此处没有运行迁移或修改生产记录。

Pi 复用已核对：固定依赖仍为 0.84.2；canonical `file-mutation-queue.ts` 只有单进程路径队列；`createGovernedPiCodingTools()` 已提供 Operations 注入。跨 Worker 持久占用、授权和恢复属于宿主责任，不改 Pi 源码或依赖链接。沙箱依赖仍为 0.0.75。

### 新增交互审核稿

- [打开 r3 交互原型](../../assets/control-center/2026-09-16-state-review-r3/index.html)：直接从冻结 v4 扩展，保留原布局、品牌、设置和输入区；新增 21 个状态，未覆盖 r1/r2 或 v4 文件。
- 重点审核：自动审查中/通过/故障转人工、替代方案重新准入、根据最新版调整修改、持续冲突待决定、目录目标变化确认、受限当前目录执行、停止保留修改、核验无结论和结果交接。
- 默认仅展示当前状态、必要动作和结果；过程、阶段时长及说明可展开。原型的审核栏与说明不是正式产品控件。全部文字、时间、路径与文件预览均为演示数据。
- [原型验证报告](../../assets/control-center/2026-09-16-state-review-r3/verification.json) 与 [Playwright 验证脚本](../../assets/control-center/2026-09-16-state-review-r3/verify.cjs)。此报告仅证明静态原型，不能用于 A/W/R/E/U/M 产品验收。
- [桌面重新生成场景](../../assets/control-center/2026-09-16-state-review-r3/desktop-regenerate.png)、[320px 确认卡片](../../assets/control-center/2026-09-16-state-review-r3/mobile-320-manual.png)。

P0 原文要求“新增交互先交用户审核，再用于对应 UI 实现”。该审核点只决定本稿新增交互是否可用于产品页面，不重新讨论已确认的后台原则，也不批准自动审查服务或生产操作。用户随后对该审核请求明确回复“已确认”。r3 新增交互审核通过，继续实施；该授权不包括真实自动审查模型启用或生产操作。

### 已实现身份与持久化点

下表记录当前代码的责任边界，供后续恢复使用。它不把尚未实现的跨启动续接写成已完成能力。

| 对象 | 当前身份与存储位置 | 何时保存，允许恢复什么 |
| --- | --- | --- |
| 逻辑操作 | `GovernedActionIntent.id`；编码工作流以 Run、toolCallId、工具参数和绑定生成 `coding:` 摘要 | 审批或额度预约保存完整快照；参数、目标或披露主体改变必须作为新请求 |
| 审批 | `approval_requests.id`、快照中的 `intentId`、版本化 `semantic_snapshot_hash` | 人工决定只改变原审批状态并关联 Grant；重复相同决定读回历史，不制造第二个 Grant |
| 额度预约 | `authorization-reservation:<intent.id>`，存于 `authorization_reservations` | 先预约，Handle 绑定后仍未消费；调用回执承诺时同事务转 committed；可能派发后不退款 |
| 执行 Handle | `capability_handles.id`、revision、authorityFence | 当前权限交给一次具体执行的受限凭据；到期或换执行权不能仅凭历史审批继续使用 |
| 工具调用 | `runtime-tool:<Run/toolCallId 摘要>` 与 idempotencyKey；受保护的 `runtime-tool-intent:` artifact | 在准入前保存原 `work.execute`；原参数、期限和受保护输入可独立读回，不以日志文本猜测请求 |
| 排队与尝试 | `sandbox_admission_queue.job_id` 和自增 sequence；计划保留 attemptId、invocationId、receiptRef | 入队不创建占用或消费回执；出队比较同一完整快照。队列位置不能成为新的执行权限 |
| 准入承诺 | `capability_invocation_receipts` 与 `sandbox_execution_records` | 同事务承诺额度、Handle 使用和资源占用；重入只返回一个既有回执，不能第二次发 executable message |
| 资源占用 | `sandbox_workspace_occupancy` 的 jobId/scopeRef 与具体目录链、文件槽位/身份 | 只协调实际声明资源；当前仍持有整个工具调用期间的 claim，短时提交锁尚未实现 |
| 永久释放与新保护 | `sandbox_release_receipts`；独立 `sandbox_workspace_barriers` | 新证据接纳时核验并与释放占用同事务保存；晚到交付 ACK 不撤销旧释放 |
| 文件发布 | 私有 Job 发布日志和候选身份；原调用的 `pi-file-recovery:` 受保护结果 | 固定文件合同 2 按原候选和父目录核实效果；恢复不重新发布，不覆盖后续编辑 |
| 资源恢复 | 执行记录 `recovery_json` 的 owner/revision/attempts/deadline/status | 当前服务只读核查或受限 stop；记录 resolved/unresolved，不借恢复重新获得业务执行权 |
| 结果交接 | `sandbox-tool-result:<semanticFingerprint 摘要>`；`runtime-sandbox-delivery:` artifact | 复用原结果与交接回执，当前披露权限另验；不消费第二次额度，不重跑工具 |

仍需补充的持久关系：当前 Pi 工具批次已在执行前保存受保护检查点，执行 intent 也保存原批次引用；`RunCheckpoint.suspension` 的自动续接仍以审批等待为主，运行中的工具批次中断仍进入 Run 结果核对。跨 Agent/Worker boot 的续排还需把已保存批次与队列调度接通，并以新执行权原子接替**明确未准入**的旧绑定。旧调用可能已准入时只能核对结果。现有 Pi 0.84.2 的自定义工具边界和受保护 continuation 可复用；当前产品自定义工具显式设置 `executionMode: sequential`，现有批次恢复依赖已完成的顺序前缀。后续若改变工具调度模式，必须同时验证该恢复合同。

### P1 当前代码与验证记录

- 新释放观察在接纳时验证，Schema 33 同事务保存不可变回执并结束占用；迟到/重复 ACK 不回写释放时间。直连 SQLite 与数据库 Worker 路径均有到期边界回归。
- 旧 released 残留占用进入 pending 查询。inspect/stop 恢复保存 owner、revision、次数、期限与终点；验证服务超过期限的迟到证据不能解锁。新回执不恢复执行或披露权限。
- Worker 可执行消息发出前重新检查权限和期限；明确未派发的错误保存安全原因码与受保护诊断，页面区分“尚未派发”和“结果未确认”。
- [释放与消费者回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-01/release-consumers.log)：106 项通过。[恢复最终定向回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-01/recovery-final.log)：146 项通过。[派发修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-01/dispatch-red.log) 2 项失败，[修复后](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-01/dispatch-green.log) 52 项通过。
- [真实 Chrome 回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-01/browser-fixed.log)：中文桌面、中文 320px、日文 393px、英文 430px 四组通过；使用受控测试网关，不替代真实 Worker 验收。首次英文窄屏溢出证据保留于同目录 `browser`，修复后截图位于 `browser-fixed`。
- 构建通过，标准本地 CI 随后通过。第一次 CI 构建期间继续编辑源码导致 `ARTIFACT_BUILD_INPUT_MISMATCH`；随后冻结源码重跑。第二次产物发布检查命中安装依赖的示例凭据和重复文件，保留脱敏命中路径与规则，未关闭扫描。类型检查中的测试不可达条件已修正并通过重验。

结果交接中断重试、通用 unknown 不新建保护，以及 Run 停止读回释放事实已补入代码。完整 Run 恢复、P2～P7 和真实平台验收尚未完成；上述局部通过不能作为全计划完成证据。

- [交接回归修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-01/handoff-red.log)：3 项失败；[修复后](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-01/handoff-green.log)：158 项通过。后续确认结果使用独立恢复结果 artifact，保留原未知事实，不重发 executable message；[迟到结果修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-01/late-delivery-red.log) 1 项失败，[修复后](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-01/late-delivery-green.log) 150 项通过。
- [消费者最终回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-01/consumers-final.log)：9 文件、264 项通过，包括 Run 停止、真实 SQLite、受控生产沙箱组合和 runtime tools。[类型检查](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-01/typecheck-final2.log) 通过。
- 第一轮完整测试执行 3,387 项：3,384 通过，3 失败。一个安装断言仍预期 schema 32；两个失败来自 admit/bind 初次返回缺少 `workspaceBlocked`，已修正创建入口并通过独立读回回归。按原锁文件重新安装依赖，移除安装目录中的重复副本；锁文件和依赖版本未变。清理后的标准本地 CI 已通过：[3,389 项全部通过](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-01/standard-ci-result.json)，包括安装产物的本地服务测试；hosted gate 未执行。

### P2 授权连续性与额度预约（局部实现）

生产路径仍为 `ActionPolicyService.evaluate` → `CapabilityHandleService.issue` → `WorkerDelegationAdmissionService.admit` → SQLite invocation receipt → Worker executable message。P2 已加入以下代码，尚未完成整个阶段：

- 新 v2 请求使用带域标识的 canonical SHA-256，旧 FNV 只用于读取既有记录；审批复用比较完整快照与主体。硬拒绝命中任一目标即阻止，过期请求不再命中允许规则，放宽策略不复活历史拒绝。
- SQLite 短事务复用同一请求的审批，重复相同决定读回历史结果；相反决定与不同内容冲突。Gateway 两设备先后或同时批准不会生成第二个 grant。取消/结束的 Run 不接纳新批准，已经发生的批准仍保留为历史事实。
- Schema 34 的 `authorization_reservations` 保存预约与 Handle 关联。排队时只预约，消费计数保持不变；现有调用回执准入事务同时承诺额度。回执写入失败会回滚额度、Handle 使用次数及预约状态。缺失结果或 ACK 不退回已承诺额度。
- 释放明确未派发的预约时，同事务撤销其未使用 Handle；Run 结束释放尚未承诺的预约。新请求争用同一份剩余额度时只有一个成功。旧 `authorization_usage` 保留，不通过迁移退费；没有可核对回执的历史使用不会自动转成新执行权。
- 复用当前已安装的 `@noble/hashes` 2.4.0，新增精确的直接依赖声明；Pi 和 SRT 版本不变。未引入新的模型侧工具协议。

[审批修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-01/continuity-red.log) 六项失败，[修复后](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-01/continuity-green.log) 21 项通过；[额度扣除复现](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-01/reservation-red.log) 证明原实现在排队时消费额度。[消费者回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-01/all-consumers.log) 233 项通过；[额度原子性与迁移](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-01/reservation-atomic.log) 30 项通过；[派发前撤销](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-01/withdrawal.log) 60 项通过。第一轮全量执行 3,408 项，其中 41 项失败：23 项为文件读取测试未连接授权与 Handle 预约存储，18 项为迁移断言仍停在 Schema 33。已连接测试存储并更新迁移终点，保留原有执行和历史数据断言。[读取工作流](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-01/file-read-fixture.log) 34 项通过。补充验证了异步检查期间到期和多个范围授权的额度选择，原实现两项失败；[修复后的相关回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-01/selection-final.log) 66 项通过。标准本地 CI 已通过：[232 文件、3,410 项全部通过、零跳过](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-01/standard-ci-result.json)，包含构建和安装产物的本地服务验证；hosted gate 未执行。类型、lint、边界、实现约束、密钥扫描、CI 配置和严格文档检查通过。`npm run check` 仍被原先未跟踪的 r1/r2 原型校验脚本格式问题阻断，未修改这些其他任务文件。

待完成：排队调度与公平性、所有历史消费恢复路径、执行中撤销的真实停止与效果核验、完整页面投影，以及与文件提交和自动审查的联合验收。当前 invocation receipt 被保守视为“可能派发”的承诺点；取得回执后尚未发送的情况仍保留额度，未实现对该情况的自动退款协议。

### P3 文件发布与资源排队（局部实现）

- 新建文件先在同一文件系统的私有恢复目录写完并同步，再用无覆盖 hard-link 发布；已存在的目标不会被覆盖。替换保留普通权限位，同步备份、候选与相关父目录。入口复制候选字节，异步检查期间不能改变将要保存的内容。
- `PreparedFileOperation.publication` 在最终路径出现副作用前持久保存暂存文件身份。恢复核对 inode、大小、时间及内容摘要；仅内容相同不能认定操作成功。发布后中断可清理本次私有别名，权限撤销后只核实既有结果，不启动新写入。候选和备份不按超时自动删除。
- Schema 35 的 `sandbox_admission_queue` 保存排队顺序。排队不创建调用回执、不占用任何资源；出队在同一事务重验并消费。新冲突请求不插队，无关目录继续；等待后复核期限、Run、Handle 和当前授权，取消后结束队列条目。只读准备可以并行。
- [发布缺陷复现](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-01/publication-red.log)四项失败后，[候选固定与消费者回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-01/snapshot-green.log) 53 项通过，包括真实 SQLite 关闭、重开与独立读回。[排队生产准入回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-01/queue-consumers.log) 29 项通过；[只读并行修复](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-01/read-parallel-green.log) 13 项通过；[迁移与调用消费者](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-01/migration-and-invocation.log) 286 项通过。

本批标准本地构建与测试通过：233 个文件、3,428 项测试、零跳过，见[标准验证结果](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-01/standard-ci-result.json)。类型检查、任务代码格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档校验通过。全仓 lint 的两处错误仍来自本任务前已有的 r1/r2 原型 `verify.cjs`；全仓格式检查亦有这两个原型目录的既有问题，未修改这些文件。

仍未缩小任意进程的真实写入范围。精确文件提交需要受信提交者拥有可核验的生命周期，不能让已确认结束的沙箱之外再出现未登记的写者。已重新核对固定 Pi read/write/edit 的 Operations 注入路径：继续在现有 Job Host 所管理的可信 runner 内保存文件；先将 Operations 限定到固定目标，再为新版文件合同接入文件身份与目标槽位。旧合同保留目录协调，任意 Shell 继续按实际沙箱范围协调。短时提交权与持久发布证据仍需继续接通。目录改名原语、跨 Worker 文件并发、队列重启恢复、完整页面投影和 Mac/Linux 联合验收尚未完成。本段不是整个 P3 的完成声明。

### P3 固定文件目标与版本化协调（继续实施）

- Schema 36 为文件型 claim 和受保护 Scope 新字段建立 writer 屏障，不改写旧数据。合同 `pi-coding-tool` 1 保留目录级协调；合同 2 用于受信 runner 的 read/write/edit，携带目标路径、原 inode、内容摘要和授权根以下的父目录身份。旧 Worker 拒绝新合同；新版缺少目标快照时不启动 Job Host。
- 固定文件 Operations 拒绝其他目标和任意 Shell；同目录其他文件不因目录授权宽而自动成为本次访问对象。宿主在准备、排队重验、启动前验证原目标；runner 在启动和发布前验证父目录，文件被替换、内容变化或原本不存在的目标被创建时拒绝覆盖。
- 文件型 claim 同时协调父目录名称槽位和 inode，祖先路径稳定要求互相兼容。已有父目录的无关文件可分别准入；名称保守归一化可能让区分大小写的文件系统多排队。父目录尚不存在时保留目录级协调，并只允许从冻结的不存在基线创建。
- 默认文件核验继续要求当前路径不变；显式 `opened_version` 读取可在原子替换发生后读完已打开的完整旧版本。原地写入变化检查、父目录检查和链接拒绝仍保留。
- [固定目标复现](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-02/target-pin-red.log)两项失败；[启动基线复现](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-02/frozen-baseline-red.log)三项失败。初次并发读取测试未触发替换，修正 canonical path 后才[复现实际缺陷](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-02/atomic-read-mechanism-red.log)，未将先前测试失误算作产品故障证据。[文件与 Scope 消费者](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-02/nested-scope-consumers.log) 88 项通过；[Pi 兼容](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-02/pi-compat.log) 120 项通过。Worker 生命周期测试模拟 OS/SRT 边界，不代表真实平台资格。

本批完整构建首次因新增名称校验的 TypeScript `unknown` 推断失败，见[编译日志](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-02/build-compile-red.log)；已修正，[标准本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-02/standard-ci-result.json)通过：233 个文件、3,448 项测试、零跳过。类型、任务代码格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档校验通过。新合同仍需安装资格和实际配置接入，未更改部署实例。当前占用覆盖整个工具调用，尚不是短时提交锁；私有候选准备、生产文件发布日志恢复、目录改名、跨 Worker 实测、队列重启续接、完整页面和 Mac/Linux 联合验收仍未完成。

### P3 生产固定文件发布与结果恢复（2026-09-19 继续实施）

固定文件合同批次已保存为本地提交 `0183db0`。本轮继续复用 Pi Write/Edit Operations，在原 Job Host 管理的 runner 内记录发布，未引入沙箱外业务写者或新模型工具。

- 发布前记录失败时不保存最终文件；保存后等待异步核验记录完成才返回。[两个原缺口](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/publication-hooks-red.log)已复现并修复。发布日志只保存身份和摘要；候选正文继续留在原受控恢复目录。
- 私有 Job 记录绑定原 Scope、输入、目标、候选 inode 与实际父目录；新建父目录也保存身份。[父目录替换复现](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/recovery-parent-red.log)后补入检查，[最终文件记录回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/publication-parent-green.log) 30 项通过。
- Schema 37 使用独立受保护 artifact 保存原 invocation 的恢复结果。恢复服务只接纳已永久释放且没有新保护的操作；没有启动工具的端口。缺少最终记录时核实原发布，而非重新写入。已核验效果保留为历史事实，后续用户编辑不被覆盖。原已知错误结果不被改成成功。
- 结果交接同时要求恢复 artifact、核验后的交接回执与当前披露权限。原运行时拒绝恢复来源的[回归复现](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/recovery-delivery-red.log)已修复，[56 项消费者测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/recovery-delivery-green.log)通过。
- [实际生产装配的定向回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/recovery-production.log) 29 项通过：真实文件、加密 artifact、SQLite、恢复和交接一起执行；只有进程释放证据使用受控夹具。早期夹具使用抽象根 ID 和不合法状态转换，失败日志保留，没有算作产品缺陷。[迁移合同](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/migration-contracts.log) 24 项通过；[资源与持久化消费者](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/consumers-final.log) 205 项通过。

本批类型与任务 lint 检查通过。首轮完整验证执行 3,468 项，3,467 项通过；旧 runner 测试未等待新的异步回调而失败，已修正测试调用。另加并发回调测试后[复现重复接纳](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/runner-concurrent-red.log)，将唯一性检查移到第一个异步等待之前，[42 项 runner 回归通过](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/runner-concurrent-green.log)。构建发布扫描还发现本地依赖目录存在 35,702 个相同内容的带编号副本；已逐项核对摘要并移入可恢复隔离目录，两个不同内容的带编号文件也单独保留，未修改依赖版本、锁文件或扫描规则，见[环境修复记录](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/dependency-duplicate-summary.json)。[首次失败记录](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/standard-ci-red-result.json)保留；[最终完整构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-03/standard-ci-result.json)通过：234 个文件、3,469 项、零失败、零跳过；发布扫描通过。短时提交锁、目录改名协议、排队重启续接、完整页面以及真实双平台验收仍未完成；不能把本段当作完整 P3 或整个 Plan 完成。

### P2 工具执行前的受保护检查点（局部实现）

生产 Pi 装配已有 `RuntimeContinuationService`。本批继续复用 Pi 的工具批次捕获/重放和产品的加密 Payload，不新增 Agent Loop 或模型工具协议。

- 进入产品工具之前保存原模型工具批次；已有完成结果作为批次前缀保留，等待审批时复用刚保存的引用。保存失败返回明确的 `RUNTIME_TOOL_CHECKPOINT_FAILED`，本次工具未执行；原始存储诊断不发送给模型。
- 受保护执行 intent 保存 `tool-batch-recovery.v1` 引用和原模型 toolCallId。内部文件阶段指向父工具调用；重放不改写原引用，Worker 消息与工具结果不包含该内部引用。
- [检查点修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-02/checkpoint-red.log)两项失败；[执行请求关联修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-02/intent-binding-red-final.log)确认派发前缺少恢复引用。首次关联测试因夹具遗漏 executionLease 失败，已修正，未算作产品缺陷。
- [消费者回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-02/checkpoint-consumers.log)5 文件、182 项通过；[真实 SQLite 回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-02/checkpoint-sqlite.log)20 项通过，覆盖直连/数据库 Worker、加密保存、关闭重开和拒绝延长期限。消费者权限测试使用受控执行边界，不代表实际沙箱资格。

本批未解除旧执行权限制，也未让被隔离的 Run 自动重启。跨 boot/fence 的当前执行权重新绑定、Run 自动恢复调度、页面完整分类与真实平台验收仍须继续实施。[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-02/standard-ci-result.json)通过：236 文件、3,497 项，零失败、零跳过，发布扫描通过。随后补充页面错误分类：[修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-02/projection-red.log)真实 SQLite 两种执行方式均失败，[完整生命周期回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-02/projection-green.log)118 项通过。[四组 Chrome 浏览器夹具回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-02/execution-browser/result.json)通过，沿用现有“尚未派发”标签；不是生产 Worker 或模型 E2E。[最终构建](../../../test/qualification/evidence/workspace-authorization-lifecycle/p2-local-02/build-final.log)、类型、任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档校验通过。Chrome 在受限环境中启动 SIGABRT，随后通过获准的隔离浏览器执行入口完成回归。

### P3 持久队列身份与工具续接（局部实现）

- 出队事务核对原冻结计划、资源声明、期限和调用身份，再承诺回执；同一调用不能换 Job 编号获取第二个队列位置。历史多条相同调用记录拒绝自动选择，不删除或重排。
- 新增按 Owner/Agent/Run/invocation 读回原队列的端口。数据库重开后保留队列顺序；生产准备复用原目标基线和 receiptRef，等待不更新 deadline，出队仍重验权限和资源。
- 工具对象重新创建后，只有无已存结果、仍 queued 且完整服务/Worker 执行身份未变的原请求可以重新进入准入。并发续接由 SQLite 回执承诺保证只发送一条 executable message。已准入、已取消、身份变化、资源上限收紧均不会从该入口再次派发。
- [冻结边界修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-04/queue-binding-red-final.log) 4 项失败；[生产准备修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-04/queue-replay-red.log)复现 receiptRef 被重建。[消费者回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-04/consumers.log) 6 文件、145 项通过，包括真实 SQLite 独立读回、数据库重开、生产装配和受控 Worker 消息。最早重入测试失败来自夹具连接已关闭，改用独立只读连接核对回执。

本批沿用 Schema 37 的数据形状，不修改 Pi 或重新创建模型侧工具。跨 Agent/Worker boot、产品 authority fence 变化后的执行权重新绑定仍未实现；上述入口不能被称为完整服务重启恢复。后台自动调度、短时提交锁、目录改名及真实平台验收仍未完成。[完整构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-local-04/standard-ci-result.json)通过：236 个文件、3,491 项测试，零失败、零跳过，发布扫描通过。类型、任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档校验通过。

### P7 历史占用只读清单（局部实现）

新增[只读核查 Runbook](../../runbooks/workspace-lifecycle-audit-runbook.md)及真实 CLI 入口，按 Owner/Agent 分页读取新版执行、旧版保护和持久队列。最初支持 Schema 28～37，P4 纯联网批次扩展只读兼容至 Schema 38；不迁移、不消费额度、不派发，不依据数据库状态生成可执行解锁；每页独立快照，报告始终标明现场宿主未验证、不可直接修复。

[CLI 子进程回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p7-local-01/audit-cli-final.log) 10 项通过，使用真实 SQLite，包含旧 Schema 28 和数据库正文独立读回。最早缺少新模块的测试是功能脚手架失败，非历史产品故障；首次误放 tooling 项目导致夹具超时，已归入现有 integration 项目使用其正常时限；旧版夹具预先消费回执造成一次测试错误，改为合法准入。扩展用例也确认已取消队列被误归为待核对，已修正。完整 P7 的历史现场证明、修复候选、迁移/回退演练和部署尚未完成。

### P4 纯联网搜索与用户目录脱钩（局部实现）

- 受保护 `sandbox-scope.v2` 明确没有目录 Grant，部署操作使用 `private_temp` / `network_only`；仅前台、仅已授权网络目标。私有范围不能混入目录或文件目标，也不能给固定 Pi 文件工具使用。安装清单只有全部操作都使用私有范围时才允许没有用户目录根。
- 公开搜索新增显式私有路由，冻结查询、模型接收方、搜索接收方与原期限，保留 Run 执行权和原网络授权重验；纯搜索无需读取目录授权状态。旧目录路由保持原行为，未切换实际部署配置；保存结果须另走文件授权。
- Schema 38 阻止旧 writer 处理新范围。准入仍承诺同一调用回执和额度，但不写共享文件占用；私有临时区是实际 cwd，文件读写白名单只有本 Job 私有区及必要只读运行时。Job Host、网络出口和结束证据仍独立管理。
- [初始缺口](../../../test/qualification/evidence/workspace-authorization-lifecycle/p4-local-01/network-red.log)、[搜索入口缺口](../../../test/qualification/evidence/workspace-authorization-lifecycle/p4-local-01/search-red.log)和[无目录安装清单缺口](../../../test/qualification/evidence/workspace-authorization-lifecycle/p4-local-01/rootless-red.log)已复现。[相关消费者回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p4-local-01/consumers.log)17 文件、334 项通过，包含真实 SQLite、受保护 Payload、UDS、配置解析和 Worker 装配；OS/SRT 边界仍使用受控替身。中间失败中的迁移脚本插入位置错误、合同测试遗漏上下文，以及 Run 测试夹具缺少已提交消息，都已更正并保留日志，未算作产品缺陷。

[真实 Mac 私有范围验证](../../../test/qualification/evidence/workspace-authorization-lifecycle/p4-local-01/private-platform-final.log)使用本轮构建产物和合成文件：私有 cwd 可写，用户文件读写、子进程读取和本机 TCP 直连均收到 `EPERM`，外部标记未变、测试服务零连接。临时文件与解包运行时已清理，[产物摘要与复现入口](../../../test/qualification/evidence/workspace-authorization-lifecycle/p4-local-01/private-platform-artifact.json)保留。受限环境首次不能创建嵌套沙箱，获准在本机执行后完成；早期直接加载源码的模块扩展名错误仅是探针启动问题。Mac 返回 `taskTreeCleanup: unknown`，不能据此签发完整进程树清理或生产资格，Linux 尚未执行。

[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p4-local-01/standard-ci-result.json)已通过：237 文件、3,511 项，零失败、零跳过，发布扫描通过。类型、任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档检查通过。任意命令的更窄限制、可选副本与逐文件应用、完整页面和双平台产品验收仍未完成；本段不代表整个 P4 或 Plan 已完成。

### P5 默认关闭的自动审查基础（局部实现）

- `ActionPolicyService` 在硬拒绝、既有审批/授权及安全读取规则之后接受可选宿主审查协调器；未装配时保持原路径。协调器的返回值本身没有授权作用，等待结束后重读能力、审批、额度和期限，失败或无效输出回到人工路径。
- 结构化请求/建议绑定请求摘要、审查编号、政策版本、模型配置版本和模型引用；响应不得携带 Grant、命令或扩大后的范围。安全替代仅作为受保护文本保存，不执行文本中的指令。委托当前仅覆盖明确的原请求摘要，关键风险及凭据变更仍走人工确认。
- Schema 39 保存模型调用前的唯一审查记录。重复请求和进程重开不再次调用模型；完成与原审批及一次性精确 Grant 同事务提交，使用数据库 writer 当前时间核验期限、委托和执行租约。人工请求已经存在、撤销、取消、过期或执行权失效时拒绝迟到结果。批准保存 `automaticReview` 来源，后续使用仍经过原额度预约和撤销检查；审查本身不创建文件 claim、Handle 或工具调用回执。
- 审查等待期限独立于原授权期限，避免超时审查稍后写入授权，也避免正常批准被不必要地缩短。人工确认创建与决定竞争已[复现](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-01/fallback-race-red.log)并修复：不再向调用者返回已被拒绝请求的 ASK。[最终入口与持久化回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-01/entry-durable-final2.log) 56 项通过。

本批仍为基础接入，未创建真实模型配置、未启用生产自动审查，也未发生真实付费调用。Pi 模型边界与预算/披露装配、建议替代的新请求、页面来源/状态投影及真实模型验收尚未完成。[完整本地构建与测试原始结果](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-01/standard-ci-result.json)：构建通过；239 文件、3,562 项执行，3,561 通过、1 失败、零跳过。唯一失败为审计测试仍将已支持的 Schema 39 当作未知版本，夹具插入时主键冲突；改为当前最高版本加一后，[10 项真实 CLI/SQLite 审计测试全部通过](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-01/audit-schema-green.log)，未知版本拒绝断言保留。复用产品代码和输入未变的其余通过结果，见[组合验证记录](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-01/verification-result.json)；没有把原 CI 的失败改写成一次全量通过。类型、任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档检查通过。不能据此标记整个 P5 完成。

### P5 复用模型端口、预算与取消（局部实现）

- 新增 `ModelActionReviewer`，复用产品 `ModelPort`、`TrustedModelProviderAdapter` 与 Pi 0.84.2 transport；模型及配置版本必须与请求完全相符，不能自动切换。宿主先提供当前披露许可，再调用模型；仅接收绑定原审查编号的有界 JSON 输出，不提供执行工具。生产文件授权工厂接受可选审查器，但实际启动配置仍未装配。
- `ModelInvocationRequest.signal` 传到现有 Pi provider。调用开始前取消释放预算预约；已经开始且用量未知时保存 `cancel_unresolved`，不推断免费。已到达的完整用量继续结算，即使审查随后被取消；迟到输出不能生成批准。
- 受保护输入准备器先获得冻结的完整审查标识，避免模型无法回传绑定字段。受控模型流、实际预算服务和真实 SQLite 联合验证批准、拒绝、预算不足、调用中取消及用量已知后取消；数据库重开独立读回费用和 Grant，全部场景均无工具调用回执。
- [取消修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-02/cancellation-red.log)七项失败，[终止事件修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-02/terminal-cancel-red.log)两项失败；[最终相关回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-02/model-consumers.log)六文件、154 项全部通过。新增适配器最早的缺少模块失败属于功能脚手架，未作为既有产品缺陷。

本批证明给定取消信号能够传至模型以及费用事实被保留；用户点击 Stop 到授权入口的上游信号仍需接通，不能将该局部结果写成完整 Stop 验收。真实模型、披露配置和生产委托尚未启用，没有真实付费调用。[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-02/standard-ci-result.json)通过：240 文件、3,595 项，零失败、零跳过，发布扫描通过。类型、任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档检查通过。整个 P5 和 Plan 仍未完成。

### P5 从 Pi Stop 传递取消到授权审查（局部实现）

- Pi 的工具调用信号通过 `RuntimeToolPort.execute` 的独立选项传入生产读取/编码工作流，再传给 `ActionPolicyService`。信号不参与工具请求摘要，不写入受保护续接记录，既有请求身份保持不变。
- 已取消的请求不调用审查、不新建人工确认；审查等待期间取消会结束等待并通知下游，即使审查器没有返回。普通超时继续走原人工确认路径，不能把超时等同用户拒绝。既有 Run/Worker 停止和效果核验仍由原持久化入口负责，取消信号不能证明进程树已清理。
- [修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-03/stop-red.log)复现四处断言失败，其中生产文件用例同时被 unit 与 node-services 项目执行，共五次失败。第一次修复后剩余一项来自测试包装器遗漏转发新增参数；修正夹具后，[149 项入口回归通过](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-03/stop-green-final.log)。Pi 回归使用真实 Pi 会话取消入口和受控模型，不调用真实服务。

[405 项消费者回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-03/stop-consumers.log)通过，覆盖编码/文件入口、Pi 会话、Run 停止、预算和真实 SQLite；随后[复现审计写入期间取消仍返回 ALLOW](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-03/trace-cancel-red.log)，补充最终返回检查后，[37 项权限回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-03/trace-cancel-green.log)通过。[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p5-local-03/standard-ci-result.json)通过：240 个文件、3,601 项全部通过，零跳过，发布扫描通过。类型、任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档检查通过。模型审查适配已保存为 `825a7a1`。自动审查真实配置仍未启用，用户页面联合验收和完整 P5 尚未完成。

### P6 自动审查来源与实际用时（局部实现）

- 审查开始、允许、拒绝、转人工和建议替代写入现有 Run 执行事件，与审查记录及批准同事务提交；事件写入失败回滚对应审查状态和授权，重复提交不重复发事件。仅保存宿主已确认的状态，不公开模型输入、输出或建议正文。
- 事件沿现有 Thread 通知和归属校验后的执行投影进入页面。审查使用独立步骤标识，不能充当 Run 开始/结束边界；完整起止事件才计算审查用时，缺少边界时显示暂无时长。自动允许明确标为自动审查，不显示“用户已确认”，也不单独触发红点或人工确认卡片。
- [先前缺口](../../../test/qualification/evidence/workspace-authorization-lifecycle/p6-local-01/review-projection-red.log)包含缺少新功能入口的脚手架失败；另行[复现请求 Thread 与 Run 不一致仍获接纳](../../../test/qualification/evidence/workspace-authorization-lifecycle/p6-local-01/review-thread-scope-red.log)，修复持久化归属检查。[189 项相关回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p6-local-01/review-consumers.log)全部通过，覆盖真实 SQLite 事务失败、关闭重开、分页读回和错误主体拒绝。
- [4 组真实 Chrome 回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p6-local-01/browser/result.json)通过，覆盖中文桌面、320 像素窄屏、日文与英文、重复通知、断线及刷新后保留同一审查步骤。浏览器使用隔离 HTTP 夹具，不是生产 Worker 或真实模型联合验收。首次浏览器启动因受限环境 `SIGABRT` 失败，隔离本机重跑通过，原日志保留。

本批沿用已确认的 r3 交互，未启用真实自动审查配置。[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p6-local-01/standard-ci-result.json)通过：240 文件、3,611 项，零失败、零跳过，发布扫描通过。类型、任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档校验通过。全部执行阶段的统一投影、真实服务端到端路径、跨平台验证和整个 P6 尚未完成。

### P1 停止请求独立派发与清理重试（局部修复）

- Run 取消决定先持久化，再分别请求运行时、资源管理器和当前 Worker 停止。一个目标同步抛错、异步拒绝或尚未返回，均不阻止其他停止请求发出；错误汇总返回，取消状态本身不证明进程或占用已释放。
- 对已取消或失败的 Run 再次停止，只重试仍活跃的运行时/Worker 并重新核对资源，不启动新的模型或工具。执行权中断保留资源停止端口的同步异常，避免漏报清理失败。
- [独立停止修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-02/cancel-independent-red.log)四项失败、[再次停止修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-02/cancel-retry-red.log)两项失败、[同步异常修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-02/interrupt-resource-red.log)一项失败均保留。最终[155 项相关回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-02/cancel-consumers-final.log)全部通过，使用真实协调器/持久化与受控运行时和 Worker 边界。

[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-02/standard-ci-result.json)通过：240 文件、3,618 项，零失败、零跳过，发布扫描通过。类型、任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档检查通过。未新增全局清理超时，也不将 `released: false` 当作释放成功；未绑定环境停止、进程树资格、其他恢复盲区及整个 P1 仍未完成。

### P0 身份合同与首次加载测试（局部补充）

[当前身份与持久化合同](#identity-contract)逐项记录 operation、attempt、invocation、审批、额度、占用、恢复及结果交付的关联和持久化点，并明确当时 Schema 39、固定文件合同 2、Scope v2 的兼容边界。短时提交与未绑定环境取消的数据扩展仍待实现，没有将这些设计目标写成现有能力。

在原 `qualifyControlCenterV4` 中加入四个首次访问场景：桌面/320 像素分别覆盖慢配置和配置失败后重试。配置未就绪时草稿保留且不提交；配置就绪后故意继续阻塞事件连接，立即发送并再按 Enter，只产生一次创建和一次消息提交；独立查询与刷新均读回一条消息和一个 Run。相关输入立即发生，没有共享“先等待已连接”的前置条件。

[原 Chrome 浏览器入口](../../../test/qualification/evidence/workspace-authorization-lifecycle/p0-local-02/browser/browser.json)完整通过，包括新增四项、已有移动端、断线/历史恢复及自动审查执行链，零页面异常与可访问性违规。已实际查看窄屏截图，未见横向溢出。测试沿既有 CI browser 入口收集；这次执行在本机 Chrome 和隔离 HTTP 夹具完成，不代表托管 CI 或真实 Worker 验收。此批只增加测试和合同说明，没有改变产品代码；复用上一批 3,618 项通过结果，未伪造修复前失败。任务格式/lint、CI policy、严格文档与链接目标检查通过。

### P1 未绑定预约的停止隔离与启动恢复（局部实现）

- [复现停止后没有恢复记录](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-03/unbound-stop-red.log)。Schema 40 增加不可撤销的 `reservation_stopped_at`，与后续清理进度分开保存；停止和启动恢复将未绑定预约登记为有限的 `unresolved`，保留责任进程、时间和原因。重复请求返回原标记，不能重新绑定启动，也不增加工具回执或消耗第二次额度。
- 停止与绑定在同一 SQLite writer 内比较：如果绑定先成功，返回原运行记录走既有清理；如果停止先成功，数据库约束阻止迟到绑定。Worker broker 不再给已停止预约解析执行范围或注册新控制端点。线上 Worker 消息不增加字段，旧 writer 由 Schema 40 版本门槛拒绝。
- 已注册的私有 Job Host 通过原认证控制通道收到停止请求，控制目录身份不符时拒绝。请求观察保存为受保护记录，不作为释放证明；未注册或清理未知的环境继续保留占用，没有伪造运行时绑定。启动恢复扫描原预约，数据库重开后仍保留同一停止标记。只读清单支持 Schema 40，显示停止时间、恢复终点和 `UNBOUND_RESERVATION_STOPPED`。
- [251 项相关回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-03/unbound-consumers-final.log)通过，覆盖真实 SQLite/关闭重开、认证 socket、生产 broker、启动装配及迁移。修复过程中发现的已关闭测试连接、序号 1 预约观察和迁移版本断言错误已修正，原日志保留，不列为产品故障。

[完整本地构建与测试原始结果](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-03/standard-ci-result.json)执行 240 文件、3,625 项，3,624 通过、1 失败、零跳过；唯一失败是旧测试仍要求 39 条 migration ledger。改为 40 后，[334 项合同回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-03/contracts-schema-final.log)全部通过，复用未变产品代码的其他项目结果，见[组合验证](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-03/verification-result.json)。构建与发布扫描、类型、任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和该批文档检查通过。真实未绑定环境的永久释放证明、实际平台进程树、停止端口的总等待上限及完整 P1 仍未完成。

### P6 终态工具不再持续显示准备中（局部修复）

[真实 Chrome 复现](../../../test/qualification/evidence/workspace-authorization-lifecycle/p6-local-02/browser-confirmed-red.log)确认：轮次已经取消，但只有准备事件的工具行仍显示“正在准备”。自动审查行的“已开始自动审查”是历史记录，未被误改成拒绝或完成。工具行现在结合已保存的 Run 终态显示“结果未确认”；若已有明确未派发证据，继续显示“尚未派发”，不推断未修改文件或虚构执行用时。

[三项单元失败](../../../test/qualification/evidence/workspace-authorization-lifecycle/p6-local-02/terminal-projection-red.log)在修复后通过；[全部 362 项前端回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p6-local-02/browser-unit.log)通过。[原执行链 Chrome 流程](../../../test/qualification/evidence/workspace-authorization-lifecycle/p6-local-02/browser-fixed/result.json)四组均通过，每组新增取消、失败、完成三种终态及刷新恢复，覆盖中文桌面/320 像素、日文 393 像素和英文 430 像素。已查看中文窄屏与日文截图。初次浏览器探针未等到记录加载，后续先作记录数量的正向断言再复现；测试中途重置同一页面的追加式历史也已改为新页面加载独立场景，相关日志保留，不将这些夹具问题记为产品缺陷。

浏览器构建、类型、任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档检查通过。后台代码未改变，复用 P1 的组合验证；本批 UI 验证仍使用隔离 HTTP 夹具，不代表真实 Worker 联合路径，完整 P6 仍待完成。

### P1 清理等待有界且保留已完成输出（局部修复）

Run 取消、执行权中断和运行时结束后的资源清理现在分别对每个异步停止端口限制调用方等待；当前实现上限为 30 秒，独立于 Run 执行截止时间。端口拒绝或不返回均不妨碍其他目标收到停止请求。超时只表示清理未确认，不能释放占用、证明后代进程退出或重新派发；迟到成功不会改写已返回的状态。此上限用于防止协调器无限等待，不作为全部工具停止宽限或恢复重试政策的最终配置。

运行时已完成但资源清理拒绝或超时时，保留原输出和检查点，保存受保护的清理原因，进入 `reconciling_external_result`。再次领取不会重跑模型。执行权中断后禁止提交迟到的完成状态；运行时已有失败或取消事实继续保留，不因清理异常丢失。

[停止等待修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-04/cleanup-timeout-red.log)三项失败、[完成后清理修复前](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-04/completion-cleanup-red.log)两项失败均保留。可控计时器验证端口永久等待，不依靠真实睡眠或放宽测试期限。[168 项消费者回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-04/cleanup-consumers.log)全部通过，覆盖协调器、网关、Run 生命周期和生产派发；类型检查通过。[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-04/standard-ci-result.json)通过：240 文件、3,633 项，零失败、零跳过，发布扫描通过。任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档检查通过。额外的 `biome check` 指出该文件原有 import 排序，项目规定的格式与 lint 入口均通过，未为此调整无关 import。多资源停止的逐条等待、未绑定环境释放证明、真实平台进程树资格及整个 P1 仍未完成。

### P1 多资源停止不被先前清理阻塞（局部修复）

同一 Run 的资源停止原来按页逐条等待；第一条清理不返回时，后续资源甚至不能收到停止请求。现在继续枚举所有页并分别发出停止，最后汇总结果；任一资源缺少永久释放回执、仍有 barrier 或停止报错，整体仍返回 `released: false`。

[有效复现](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-05/stop-pages-confirmed-red.log)显示第一条等待时仅发出一次停止，第二页未收到请求。修复后[52 项相关回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-05/stop-pages-green.log)与类型检查通过。新增用例采用真实 SQLite 预约/绑定与受控分页、清理端口，101 条记录验证跨页派发，分别覆盖等待和拒绝；不代表同时启动 101 个真实进程。初次测试试图修改冻结端口而失败，已改在工厂捕获前注入，保留[夹具失败日志](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-05/stop-pages-red.log)。[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-05/standard-ci-result.json)通过：240 文件、3,635 项，零失败、零跳过，发布扫描通过。任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档检查通过。未绑定环境的独立释放证明、真实平台资格和完整 P1 仍待完成。

### P1 未启动预约的原宿主释放凭据（W06 分支）

Schema 41 保存独立的预约释放回执：原认证宿主从未启动任务、已退出并清理完成后，当前服务权威才可在同一 SQLite 事务中保存凭据并结束该预约的占用。仍保持 `reserved` 和不可撤销停止标记，不伪造运行时绑定、执行时间、工具成功结果或退款。重复停止、凭据有效期过后和数据库重开均读回已接纳事实；旧任务仍不可绑定或启动，其他合法冲突请求可以重新准入。回执与占用更新中途失败时一并回滚。

[生产停止路径](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-06/production-stop.log) 24 项通过，新增场景使用真实 SQLite、安装文件检查、认证 socket 和受控子进程退出，监督事实与安装资格为测试输入。[预约接纳/拒绝矩阵](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-06/reservation-release-matrix.log) 36 项通过；[宿主及存储消费者](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-06/release-control-green.log) 65 项通过。新增 Schema 40→41 迁移不补造历史凭据，并阻止旧 writer；只读清单分别展示两类回执，保留旧 Schema 28/40 的实际迁移读取回归。

[本机原生宿主探针](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-06/mac-host-probe-final.log) 五个场景通过，只有 `never-started` 返回预约释放证明；已启动任务的清理仍为 `unknown`，不会因此解除占用。探针经过真实 Job Host、SRT、控制通道和进程退出，资格及 artifact 存储仍受控，`productionQualified: false`。受限环境未 ready，以及旧探针遗漏现有 `admit` 装配的失败日志保留；修正测试装配后原生探针通过。完整 P1/W06、Linux 及任意后代进程资格仍未完成。

[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-local-06/standard-ci-result.json)通过：240 文件、3,653 项，零失败、零跳过；产物检查通过。类型、任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 与严格文档检查通过。第一次构建期间修改探针导致 `ARTIFACT_BUILD_INPUT_MISMATCH`，失败证据保留；冻结全部构建输入后重跑通过。该错误属于执行安排失误，不是产品或机器故障。

### P3 完整候选先准备、再经原队列提交（初轮记录）

本批核对的实际前置条件是：原队列已经按文件槽位与身份互斥，P1 的占用释放仍必须有原宿主不可再写的证明；不能仅把 runner 中的锁提前释放。P2 的当前执行身份、Grant、Run 与额度检查须在准备前和正式准入时都成立，跨 boot 的自动重绑定尚未完成。

新增 `pi-coding-tool@3` 仅适用于固定目标 `write/edit`。在预约之前，通过固定 Pi 0.84.2 的原工具定义与 Operations 对不可变快照生成候选；Pi 继续负责参数正规化、编辑匹配、BOM/换行与差异结果。宿主只在 `.himawari-recovery` 保存完整候选与结果，`fsync` 后将身份和摘要保存到原受保护 Scope artifact；准备期间不登记工作区占用、不消费调用额度、不创建正式目标的父目录。候选可以同时准备，之后才使用原持久队列取得提交占用。

Worker 重验 Scope、权限、目标版本、父目录、候选 inode/摘要及文件权限，再用原发布记录和原子发布接口保存同一个已暂存 inode，不重新生成内容。新建不覆盖，替换冲突保留候选；准备前已经取消、过期、撤权或来自旧 Worker boot 的请求不会开始暂存；准备期间失效后不能准入提交。Worker 检出候选被改写或权限位变化时拒绝覆盖正式文件，既有占用仍按实际资源状态清理。已成功发布的历史结果继续由原恢复路径确认，不覆盖之后的用户编辑。仍按原宿主停止证明释放本次提交占用，不把进程尚存时的“工具返回”当作释放证明。

[生产准备入口与权限回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-prepared-01/production-authority-fixed.log)已验证两个 `write/edit` 候选同时到达暂存屏障，此时 SQLite 中占用和调用回执均为零；随后同文件请求互斥，等待期间目标变化会拒绝原请求且保留候选。测试使用真实文件、SQLite、保护载荷与生产装配，安装资格为受控夹具。[构建后 runner](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-prepared-01/runner-final.log)已通过原生子进程验证发布 inode、权限、编辑差异、新建父目录、篡改拒绝、重复执行拒绝和历史效果恢复；该入口尚未经过 SRT，不代表完整沙箱或 Linux 资格。

新合同保持旧合同 1/2，不改变 Schema 41，也不修改现有生产配置；只有明确选择合同 3 且通过部署资格的绑定才使用新路径。旧执行器不能理解新合同/Scope 时必须拒绝，不能降级执行旧写法。初轮时完整本地验证仍待完成；后续结果见[本地批次验收](#p3-prepared-delivery)。合同 3 的跨 Worker 联合路径与目标平台资格仍待完成，不将本批标为整个 P3 完成。

本批证据目录为 `p3-prepared-01`。首次误用已存在的 `p3-local-04`，消费者日志发生覆盖；历史文件已经按 HEAD 精确恢复，错误日志不计入验收，另行重跑。全库格式检查发现原有未跟踪 r1/r2 原型脚本问题；本批保留这些文件并单独验证修改范围。实施期间出现的四个带 ` 2` 后缀的无关副本也予以保留。

<a id="p3-prepared-delivery"></a>

### P3 准备计算的可停止边界与安装入口（本地批次已验收）

根据本次 reflect，继续使用原 Plan、单一决策日志与现有测试入口。新日志目录以排他创建选择 `p3-prepared-02`，不复用历史目录。先核对准备计算、Stop 信号和安装产物的实际入口，再冻结源码进行完整验证。

上一轮[完整验证结果](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-prepared-01/standard-ci-initial-result.json)为失败：构建成功，安装 runner 的初始化超过默认 10 秒 hook 限额，8 项行为检查未执行。该失败不是已确认的安装器故障。当前安装测试沿用仓库现有安装测试的 180 秒进程上限与 240 秒初始化上限；准备模块与提交 runner 均从同一构建或安装目录加载，不能再用源码准备结果代替安装入口证明。

Pi 计算改为独立线程，复用请求已有时间及内存预算，不改变生产模型或部署配置。V8 堆上限不等于 OS 总内存或沙箱资格；输入/候选仍有原有字节限制。运行时把当前 Stop 信号传到准备计算，取消/超时只有在线程终止后才返回。准备前和提交准入时仍核验原授权，暂存完成后保留原 Scope artifact。

[运行中中断检查](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-prepared-02/compute.log)用真实计算线程和受控计时，在确认计算已经开始后触发取消或期限，再检查线程已退出。[临时禁用终止调用](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-prepared-02/compute-stop-disabled.log)时两项检查均失败，原实现已恢复。此前 1ms 短字符串测试只能混合观察启动耗时，已由此替换。[生产准备权限回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-prepared-02/production-authority-fixed.log)通过；最初失败来自测试请求的资源预算与夹具宿主上限不一致，修正限定于测试夹具。

[构建产物路径](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-prepared-02/built-runner.log)及[安装归档路径](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-prepared-02/installed-runner-ci-env.log)均实际执行了准备和提交两段的 8 项行为检查。首次定向安装命令缺少标准 CI 的 `HIMAWARI_CI_PYTHON`，安装器在执行行为断言前拒绝；复用锁定工具链环境后通过，未为此修改源码或放宽安装校验。

[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-prepared-02/standard-ci-result.json)通过：243 文件、3,676 项，零失败、零跳过。[冻结清单复核](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-prepared-02/freeze-check-final.json)确认 1,232 个已跟踪及未忽略输入在构建、安装检查和完整验证期间没有新增、删除或内容变化；证据目录单独排除。类型、任务范围格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档检查通过。全库格式/lint 仍受原有 r1/r2 原型脚本影响，本批保留这些无关改动，不把任务范围检查写成全库通过。

已验收的用户行为是：两个候选可在零共享占用时准备；同文件提交仍由原队列互斥；目标变化不覆盖后续修改且保留候选；Stop 可中断准备计算且不会继续派发；成功发布的结果可恢复而不重复覆盖。此结论限定于本机文件系统、生产装配夹具和真实安装 runner。跨 Worker 联合路径、目录改名、冲突后新 intent、多文件及 Linux 资格仍未完成。

<a id="p3-conflict-delivery"></a>

### P3 确定未派发的版本冲突与重新生成（本地批次已验收）

沿用 Pi 原有 tool result → 下一轮模型 → 工具调用路径，没有新增模型工具参数或另一套循环。宿主把固定写入准入前的目标版本变化明确为 `FILE_VERSION_CONFLICT`；原请求重新进入时核对冻结上下文与持久的未派发诊断，返回原冲突事实，不再次消费确切批准或使用已撤销 Handle。结果未知或已派发后的失败不进入自动重生成路径。

Pi 从当前 Run 的真实工具历史提出前序冲突关联，宿主复核同一 Run、主机/目录/模型绑定、相同目标及原失败记录。新内容产生新的不可变 intent，并把前后 intent 与工具调用关系保存到原受保护 artifact。关联本身不提供权限；真实权限服务回归确认旧确切内容批准会让新内容等待新批准。原额度、截止时间和 Stop 继续适用；既有循环检测增加累计四次文件冲突的上限，并随审批 continuation 保存，改变内容或穿插读取不能绕过。

定向验证已覆盖已知冲突重放、新批准、未派发记录缺失/可能已发送时拒绝关联、实际 Pi 循环的读取/新调用和持续冲突停止。早期版本误把重放送回授权入口的失败、测试使用了错误审批字段和列表次序的失败均保留在 `p3-conflict-01`。[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-conflict-01/standard-ci-result.json)通过：243 个文件、3,689 项，零失败、零跳过；发布扫描通过。[冻结审计](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-conflict-01/freeze-check-final.json)确认 1,232 个输入未变化。类型、打包后 Agent 入口、任务格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档检查均通过。这些结果不证明模型能够理解任意合并意图、Worker 已启动后冲突自动恢复、完整页面或跨平台资格。

<a id="p1-recovery-fencing"></a>

### P1 恢复尝试隔离与并发结果保留

本批沿用原恢复入口、持久任务与 SQLite 事务，不增加重试调度器或工具协议。新增回归先确认两处缺陷：超时后迟到的 `lost` 返回仍尝试写入、迟到的 `released` 返回仍触发证据核验；另一个恢复任务已接管时，原任务仍能提交释放事实。[超时复现](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-recovery-01/races-red.log)与[接管后错误释放复现](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-recovery-01/ownership-red.log)保留于独立目录。

修复后，恢复写入带原任务 revision，并在同一 SQLite 事务中比较 owner、revision、运行状态和释放期限；过期任务仍可登记无结论，但被接管或结束的任务不能再改写资源。服务在调用宿主前及返回后检查剩余期限，超时后拒绝旧回调进入新校验或写入；登记本身耗尽期限时不再调用宿主。失败和结束前重新读取当前事实，保留并发到达的结果、效果与永久释放记录，旧任务不能替新任务结束恢复。此处拒绝的是旧恢复尝试；后续独立核验仍须重新取得有限期处理权。

[恢复矩阵](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-recovery-01/recovery-matrix.log) 116 项通过，包含真实 SQLite、生产 repository 端口及数据库重开后的独立读回；定时器和宿主证据仍为受控输入。新增测试最初用了当前 TypeScript lib 未支持的 `Promise.withResolvers`，类型检查失败后改为本地 Promise 屏障，不改变工程编译目标。[消费者回归](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-recovery-01/consumers.log) 114 项通过；[完整本地构建与测试](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-recovery-01/standard-ci-result.json) 243 个文件、3,709 项全部通过，零失败、零跳过，产物发布扫描通过。[冻结复核](../../../test/qualification/evidence/workspace-authorization-lifecycle/p1-recovery-01/freeze-check-final.json)确认 1,179 个输入在构建及测试期间未变化，之后仅补验收记录。类型、任务范围格式/lint、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档检查通过；全库 `npm run check` 与 lint 仍被原有未跟踪 r1/r2 原型脚本阻断。四份受影响 Runbook 已修正恢复归属说明并经治理工具重新封存；没有执行任何 Runbook 的生产操作。无需数据库迁移；端口字段为宿主内部附加校验，Schema 41 与原 Worker 工具合同保持不变。此批不代表进程后代资格、迟到矛盾证据的新风险保护、完整错误分类与调度已完成。

### 当前完成边界与下一步

P0 尚未全部完成；P1～P7 和 68 项产品验收仍未全部完成。P1 释放与交接修复已提交为 `fe92846`，P2 的当前实现已提交为 `e4eebf4`，P3 发布与队列已提交为 `b5b3e9a`，文件级合同已保存为 `0183db0`，生产发布恢复已保存为 `9e0a11e`，只读历史清单为 `649b5a4`，排队身份及同执行身份续接为 `ecefe09`，工具执行前检查点为 `8e9eded`，纯联网私有范围为 `58c6598`，默认关闭的审查持久化基础为 `f379f80`；尚无生产迁移或部署。Architecture/README 暂不将未验证阶段写成已完成能力，Spec/Plan 保持 active。本批恢复写入隔离已完成本地标准验证；下一优先项是 P1 已启动任务及后代的停止与释放资格，须用真实宿主证明旧 writer 不可再写，再验证冲突请求能否重新准入。其他 P1～P7 缺口继续以当前实施进展表为准。

[单一决策日志](../../../test/qualification/evidence/workspace-authorization-lifecycle/decisions.tsv) 记录本轮选择及证据；没有建立另一个项目状态缓存。
