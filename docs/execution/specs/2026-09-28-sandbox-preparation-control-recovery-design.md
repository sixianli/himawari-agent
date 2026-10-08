---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-28"
---

# 沙箱准备失败的控制关联与恢复提案

**审阅状态：Claude 已于 2026-09-28 19:55 批准；第五份回复范围内的实施与验收已完成，完整产品资格仍待后续任务。** 批准依据为 `.ci-output/handoff/2026-09-28-claude-reply-4.md`。 本提案处理 TE-06 已确认的恢复缺口。原现场第一次准备失败的触发原因仍不确定；不能把本提案解释成已证明原故障由磁盘、心跳或某个并发写者引起。

2026-09-29 第二轮 reply-16、reply-17 批准的 A2 准备封锁、新释放依据与计划协议字段已由 `b97aae8` 实现，行为与验证边界见[第二轮 A2：准备登记之前的封锁](#第二轮-a2准备登记之前的封锁)。TE-11 分页和 A1 已独立提交 `022c81a`；整轮完整产品资格仍待后续验收。

## 阅读导航

- [目标与来源](#目标与来源)
- [已经确认的证据](#已经确认的证据)
- [现有数据为什么不够](#现有数据为什么不够)
- [建议的数据与执行顺序](#建议的数据与执行顺序)
- [权限与失败边界](#权限与失败边界)
- [准备失败的安全服务日志](#preparation-safe-log)
- [未启动预留的持续清理核查](#reserved-retry)
- [未绑定预约的管理员处置](#admin-reservation-disposition)
- [替代方案](#替代方案)
- [验收与审批范围](#验收与审批范围)
- [第二轮 A2：准备登记之前的封锁](#第二轮-a2准备登记之前的封锁)
- [D4：登记确认丢失后的启动仲裁](#d4登记确认丢失后的启动仲裁)
- [D6：未绑定容器的终态恢复](#container-unbound-recovery)
- [F：通用 UDS 断连恢复](#f通用-uds-断连恢复)
- [第二轮：依赖加载期间的启动监督](#startup-supervision)
- [准备期间的期限诊断分类](#deadline-classification)

## 目标与来源

宿主在工具启动之前准备失败，若已有可以验证的“从未启动用户任务、宿主已退出且清理已完成”证据，系统应保留控制关联、释放该次预留并向模型交付确定失败。不能因丢失验证关联而永久停留在结果未知，也不能以恢复为由启动原工具。

来源：[工具执行排查计划](../plans/2026-09-28-tool-execution-audit-plan.md#缺陷和待验证项) [SOURCE: docs/execution/plans/2026-09-28-tool-execution-audit-plan.md]、[隔离工具执行设计](2026-09-24-isolated-tool-execution-design.md) [SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md]、[已批准的确定结果恢复合同](2026-09-28-sandbox-tool-result-resumption-design.md) [SOURCE: docs/execution/specs/2026-09-28-sandbox-tool-result-resumption-design.md]。

## 已经确认的证据

| 证据 | 结论及限制 |
| --- | --- |
| 首次失败数据库 `product-path-te03-te05-run2/service-logs/product.sqlite` | 原调用停在 reserved、sequence=1，没有 bind、start 或操作结果；恢复为 `SANDBOX_CONTROL_BINDING_UNAVAILABLE`。这是实际产品失败现场 |
| 对应私有 `final.json` | 文件正文写有 finished、taskStarted=false、srtReset=true；历史控制密钥没有保存在 Agent，因此该正文只能作为诊断线索，不能补称已认证释放证据 |
| Worker `production-sandbox-execution-v2.ts` | 顺序是创建 Job Host → await host.ready → register_control → bind → host.start；ready 拒绝时跳到 catch/finally，不登记控制关联 |
| Agent `production-sandbox-control.ts` | register 只接纳实时 ready 观察；恢复必须先读取已有控制关联。宿主已经退出时重新调用 register 也不能补登记 |
| `te06-preparation-failure-probe.mjs` 与同名 `.log`、`.json` | 真实 Job Host、实际签名最终文件及生产控制器；仅在 SDK initialize 注入失败，并控制 admission/Artifact 存储边界。结果为 ready 拒绝、任务未启动、reset 成功，探针持有原密钥时可验证最终文件；生产登记失败 ENOENT，恢复仍报关联缺失，断言失败。不是完整 Worker/Agent E2E |

证据根均为 `.ci-output/tool-execution-audit/2026-09-28/`。探针在已停服的本任务隔离安装 `/private/tmp/hma-pp-95cXJu` 创建独立 Job，未启动用户工具，未改安装源码，未调用外部模型。复现命令为 `node .ci-output/tool-execution-audit/2026-09-28/te06-preparation-failure-probe.mjs`；重跑须换用新的 jobId/control 目录，避免覆盖第一次证据。

原现场的准备错误和 Worker catch 原因没有被保存，Job Host 基础设施 stderr 也被调用方丢弃。已有四次独立 prepare 探针和单独写入均通过，不能据此排除首次瞬时失败。现在能确认的是失败之后的控制关联丢失；首次触发原因仍为 uncertain。

## 现有数据为什么不够

控制绑定中的随机会话与验证密钥由 Worker 创建 Job Host 时生成。现有持久控制 artifact 只有宿主 ready 后才写入；预留、调用回执、计划和最终文件本身都不能还原该密钥。Worker 在这个窗口退出后，Agent 无法认证剩下的文件。

不允许用文件名、PID、未验签的 taskStarted=false 或“没有 bind 记录”代替宿主清理证明。也不能在重启后换一把密钥重新解释原文件。需要在 fork 之前增加受保护的准备控制记录；这属于持久数据形状与准备顺序变化，须先审阅。

## 建议的数据与执行顺序

复用现有 `run_payload_artifacts` 与加密 Payload，不增加 SQLite 表、迁移、执行状态或任务队列。增加一个不可变的内部记录，例如 `sandbox-preparation-control.v1`，绑定：

- 原 owner、agent、Run、jobId、attemptId、invocationId、receiptRef；
- 原计划语义指纹、environmentId、policyDigest；
- 唯一控制会话、私有目录、验证密钥及目录设备/inode；
- 登记时的机器 boot 身份和当前授权来源。

密钥仅存于 restricted 受保护 Payload，不进入日志、模型、页面或公开证据。具体 operationKey 在实施时沿用现有 `sandbox-control` 命名体系，原关联不得重绑定。

建议顺序：

1. Worker 在原预留和权限检查之后，准备私有路径及策略，生成唯一控制绑定；这一步不 fork 宿主、不启动工具。
2. 通过单独的准备控制登记请求，由 Agent 核对原预留、当前 Worker 身份、权限、目录边界、策略与计划，并持久保存上述记录。登记失败则不能 fork。
3. 登记确认后才 fork Job Host，传入同一控制绑定。禁止 fork 内再次随机生成另一套会话或密钥。
4. 原 ready 登记仍负责核实实时宿主身份，原 bind/start 仍只接受 ready，执行准入不因准备控制记录存在而放宽。
5. 准备失败、Worker 退出或 Agent 重启后，恢复服务用保存的控制绑定认证原 socket/final 文件，再依据现有宿主退出、never-started 与 reset 条件核验原预留是否可释放。记录存在本身不证明资源已释放。
6. 对已取得永久预留释放回执、且 basis 为 `host_never_started` 的调用，保存原工具“确定未启动”的失败结果，并通过原 Pi 批次交付。扩展 TE-04 的只读恢复准备/领取，让这一证明与 bound Job 的确定结果分别校验；不伪造一个已 bind 的执行记录，也不把超时未知改成失败。

步骤 6 使用现有 RuntimeTool 的 failed 结果和受保护回执，继续复用 Pi capture/restore 与原 stream ordinal。后续模型提出的新调用仍走正常授权、预算和期限；原调用绝不重启。

## 权限与失败边界

- 准备记录只允许定位、核验与停止本次宿主，不能授权 start 或新工具调用。
- 种子记录已保存但 fork 是否发生不明，且无最终证明时，保留未知。不得据“缺少 started.json”自动释放。
- 撤权或取消后仍可保存已发生事实、核验和清理；披露与继续原 Run 仍须当前权限、未取消及原 Run 期限。
- 原 35 秒前台等待、30 秒资源核查、Job Host 清理期限和 Run 总期限均不延长。没有证据表明需要改变 1.5 秒心跳规则，本提案不修改它。
- 准备或最终证据被替换、目录身份变化、机器身份不明时保持隔离；认证通过且独立核验宿主已退出后才释放。
- 旧记录没有准备控制 artifact 时维持原保护；不补造密钥、不自动回填旧数据，不宣称本地已有 TE-06 现场会自动修复。
- 模型费用或结果未知时继续阻止自动重发。
- 增加有界机器码诊断，分别保存准备失败、控制登记失败和 bind 失败；不保存任务正文、密钥或 SDK 原始错误文本。

<a id="preparation-safe-log"></a>

## 准备失败的安全服务日志

2026-10-08 的[生产沙箱 reply-01](../../../.ci-output/handoff/2026-10-08-codex-prod-sandbox-reply-01.md)批准为准备失败增加固定字段的服务诊断，保留原 restricted Trace（加密保存的受保护诊断）合同。Agent 收到准备诊断请求并通过原握手、当前权威、调用身份和原回执检查后，先用 `sandboxPreparationDiagnosticSchema` 校验完整诊断。未知字段和枚举外的值均拒绝，不生成这条日志，也不保存未经校验的诊断。

安全日志写入 Agent Service 原诊断输出，事件名为 `sandbox.preparation.failed`。允许字段如下；日志不增加 `schemaVersion` 或原始诊断正文。

| 字段 | 来源与边界 |
| --- | --- |
| `timestamp`、`component`、`event` | 既有服务诊断时间，固定组件 `agent-service` 和固定事件 `sandbox.preparation.failed` |
| `controlRef` | 原 `sandbox-control:<64 位 SHA-256 摘要>` 关联，按完整计划 identity 计算；不输出 identity 本身，用于关联同一受保护诊断的 operationKey |
| `stage`、`reasonCode`、`systemCode` | 只取 `sandboxPreparationDiagnosticSchema` 定义的固定枚举 |
| `hostStage` | 同一 schema 的固定枚举；原值为 null 时省略 |
| `hostDetailCode`、`hostCommand`、`hostPhase` | 分别取 `hostDetail.code`、`hostDetail.command`、`hostDetail.phase` 的固定枚举；原 hostDetail 为 null 时全部省略 |

枚举范围沿用[准备诊断 schema](../../../packages/execution-contracts/src/sandbox-execution-v2.ts)。hostDetail 中的耗时、消息年龄、期限余量和序号只保留在原受保护诊断，不复制到安全日志。日志不包含原 Owner、Agent、Run、Job、attempt、调用或环境身份，不包含宿主路径、用户正文、秘密、控制密钥或 SDK 原始错误文本。

固定字段日志在读取或写入 `sandbox-control:*:diagnostic:preparation-failure` 之前输出。因此，restricted Trace 读取、加密或保存失败时，只要服务诊断输出仍可写，管理员仍能读取固定错误字段。日志写入同步抛错时仍尝试执行原 Trace 保存流程；Trace 本身失败时不能声称持久诊断已保存。已有第一份 Trace 保持原内容，不因重复请求覆盖；重复有效请求可产生重复安全日志，不以日志条数推断工具执行次数。 本批测试覆盖同步写入抛错，没有覆盖真实诊断流的异步错误；不能据此保证异步输出故障时的进程存活或 Trace 留存。

诊断请求未到达 Agent，或未通过握手、当前权威和回执检查时，不生成这条安全日志。缺少日志不能证明没有发生准备失败，已有日志也不能代替签名终态、独立进程核验或永久释放回执。恢复、解除工作区占用、交付结果和新启动仍服从原证据与权限门禁。管理员读取固定字段无需解密 Payload；`himawari diagnose run` 仍读取受保护诊断全文，须按原密钥和私人数据处理要求执行。

<a id="reserved-retry"></a>

## 未启动预留的持续清理核查

本规则处理 `reserved`、`started_at` 为空且已有停止义务的预留。恢复先沿用原停止标记、当前权威、owner 和 revision 取得单次核查处理权。原控制套接字不可连接，或宿主已不可达时，`SANDBOX_SUPERVISOR_UNAVAILABLE`、`SANDBOX_HOST_UNAVAILABLE` 不阻止后续独立核验原释放证明。只有原预留释放事务接受该证明后才解除工作区占用；不可连接、没有 started 记录或任务未启动本身均不构成释放证明。

本次核查以 `unresolved` 结束，只说明这次没有取得充分释放证明。对 action 为 `stop` 的 reserved 记录，以下原因允许下一次扫描在原权威事务内重新排定 `scheduled`：

- `SANDBOX_SUPERVISOR_UNAVAILABLE`、`SANDBOX_HOST_UNAVAILABLE`：宿主或控制连接暂时不可用。
- `SANDBOX_CONTROL_UNCONFIRMED`：尚未确认原资源清理。
- `SANDBOX_CONTROL_TIMED_OUT`、`SANDBOX_RECONCILIATION_TIMED_OUT`：控制请求或本次核查超时。
- `SANDBOX_RECONCILIATION_INTERRUPTED`、`SANDBOX_RECONCILIATION_INCONCLUSIVE`：本次核查中断或没有结论。

最早尝试时间从上次实际 `finishedAt` 起计算。退避依次为 1、2、4、8、16、30 秒，之后每次为 30 秒；排定阶段不增加 attempts，真正开始核查才增加。持续清理不设总次数上限，但每次尝试仍受原 30 秒核查期限、当前权威和取消信号约束。服务重启保留恢复次数和已排定的 `nextAttemptAt`，按原 owner、revision 与当前权威规则接管，不能重置退避或让旧回调写入证明。未得到充分证明期间，工作区占用保持，后续相交请求不得获准启动。

身份、目录、签名、受保护证据或权限错误，以及上述暂时原因以外的错误，保持暂停，等待管理员核对原绑定和证据；不自动替换身份、控制密钥或目录，也不重新授予执行权限。已绑定 `bound` 资源的原 inspect/stop 调度和暂停合同不变。这些尝试只处理原资源停止与核验，不创建新 start，不重放原工具，不延长工具或 Run 执行期限。充分证明被接受后，确定未启动的结果仍通过既有一次交付路径处理；原 Run 的继续或结束仍服从原取消、权限、披露和期限门禁。

<a id="admin-reservation-disposition"></a>

## 未绑定预约的管理员处置

原认证控制没有充分释放证明时，自动恢复保持上述占用和重试规则。管理员另有离线处置入口，仅处理当前配置归属下单个前台 SRT Run 的已停止 `reserved` 预约；不处理 bound、container 或托管后台任务。`started_at` 为空只是数据库记录，不证明用户工具从未启动。

目标还须有仍为 `open` 的所属 Thread、原执行租约和恢复记录；Run 与 checkpoint 都处于 `reconciling_external_result`，checkpoint 尚无终态、output 或最终答案。其他未释放资源、未决保护或未确认意图会使本次处置被拒绝。

`sandbox inspect-reservation --config PATH --job JOB` 只输出 Job/Run/Thread/环境身份、停止标记、Run/checkpoint/lease/Thread 四个 revision、处置摘要和固定 `confirmation`。摘要绑定同 Run 的其他资源与相关数据库快照，不输出资源统计；`confirmation` 列明三项必须由运维独立确认的声明。它不解密控制记录，不读取工具正文或 secret，不检查 final 或进程，不将数据库资格作为现场通过。`sandbox confirm-reservation-cleanup` 要求同一 Job、该摘要、管理员声明引用、独立现场报告的 SHA-256，以及完整确认串 `HOST_GROUP_ABSENT_FINAL_ABSENT_RELATED_PROCESSES_ABSENT`。Agent 和 Worker 必须停止，命令必须取得原 state-root 独占锁，不提供绕过存活锁的选项。

管理员先独立确认原宿主进程组不存在、原控制目录内没有 final、没有相关运行进程。旧预约没有可信 PID/PGID 时，运维必须另行核对原系统现场；无法确认则不执行。CLI 只记录这三项管理员声明和报告摘要，不把它们认证为 Host proof，也不因为 socket 不可连接或 started 为空自动认定清理完成。

Schema 50 保存独立的 `sandbox-admin-reservation-release.v1` 回执，basis 为 `administrator_confirmed_cleanup`。管理员声明引用与实际本机 `{uid, account, hostname}` 分别保存。回执绑定原任务身份、环境语义指纹、停止标记、处置摘要、版本和接受时间；不替代原 `sandbox-reservation-release.v1` Host verification。原计划、facts、observations、受保护控制 Payload、started 与自动释放证据保持原样。

管理员回执是永久历史，不使用 Host `validUntil`。读取历史仍须核对原计划身份、authority 摘要和关联审计的完整关系；缺失、损坏或不匹配拒绝读取为有效释放，不用当前时间续发证明。固定 checkpoint 诊断为 `SANDBOX_ADMINISTRATOR_CONFIRMED_CLEANUP`，审计 action 为 `sandbox.reservation_cleanup_confirmed`，所属 Thread 的持久事件为 `run.failed`。

处置事务重新核对配置归属、Schema、目标资格、版本及摘要，同事务保存管理员回执与审计、释放对应占用、终结核查安排、将 Run 与协调 checkpoint 记为 `failed`、结算原执行租约并推进版本栅栏、保存所属 Thread 的持久事件。事务失败保留原占用；其他未处置资源或状态冲突拒绝本次窄范围处置。相同处置重读同一回执，不重复审计、事件或版本变化；不同声明或报告摘要不能覆盖历史回执。旧 writer 不得写入 Schema 50。

此处 Run 的 `failed` 表示管理员终结该次运行。工具结果及外部效果仍保持未确认，不补造 final、绑定、启动观察、业务失败正文或退款。管理员 basis 永不进入 `isSandboxReservationNeverStarted` 或其 SQLite 白名单，不能交付 `SANDBOX_TOOL_NOT_STARTED`，不能创建结果交付或模型续跑 intent，不调用 Pi 或重放工具。新矛盾证据按原 incident/barrier 规则处理，保留已接受的管理员历史。

具体现场核查、确认命令、独立读回与停止条件见[管理员处置 Runbook](../../runbooks/sandbox-reservation-administrative-disposition-runbook.md)。[SOURCE: docs/runbooks/sandbox-reservation-administrative-disposition-runbook.md] 本合同授权功能实现，不授权任何生产停服、迁移、处置或服务启动。

## 替代方案

只在 ready 失败的 catch 中补登记，可以改善进程仍活着的部分情况，但无法处理补登记之前 Worker 退出，且现有 register 不接受已经关闭的宿主。它没有消除丢失关联的窗口。

放宽心跳或增加重试次数只改变触发概率，不能恢复已经丢失的认证材料。根据未认证 final 文件释放则降低现有释放证明要求。两者均不采用。

## 验收与审批范围

批准后先把探针转为现有 Vitest 框架内的可重复失败测试，再修改实现；保留红绿日志。覆盖 fork 前后、ready 失败、登记 ACK 丢失、Worker/Agent 退出、取消/撤权、原期限、密钥/目录/身份替换和重复恢复。验证无原工具启动、无第二份控制关联、无伪造 bind、无重复模型消费。必要的 OS/SDK 故障注入需注明边界，真实产品路径另行验证。

Mac 产品路径重复审批写入至少 30 次，加入准备失败和重启的确定控制点，保留每条 Job、预留释放回执、模型调用、文件内容及实际进程证据。再次失败先保留第一份原因，不以重跑通过销项。第五份回复已调整停止点：本轮完成 TE-06 验收、完整 check/test、本地提交与交接后停止；剩余 stop/deadline/finish 故障、交错验证及最终未筛选 Mac 产品资格由 Claude 在新会话派发。

Claude 第四份回复已批准上述受保护准备控制记录、fork 前登记顺序、确定未启动的失败交付，以及有界机器码诊断。批准不包含 Hermes、用户服务、下载、push 或历史数据修复。当前按下列附加要求实施验证，未经实测的项不记为通过。

### 第四份回复的附加验收

2026-09-28 第四份回复当时要求：首次准备、控制登记与 bind 失败须通过既有 `sandbox-control:*:diagnostic:*` 受保护记录保留有界阶段与机器错误码，可由 `himawari diagnose run` 查询，不进入日志、不包含任务正文或密钥。2026-10-08 批准的[安全服务日志合同](#preparation-safe-log)增加固定枚举和关联元数据，受保护诊断及控制密钥仍按原边界保存。Mac 同样的 30 次审批写入在改动前后记录从原计划 requestedAt 到 tool_result acknowledgedAt 的耗时，统计中位数和最大值，同时保留各样本和环境；若中位数增加超过 100 毫秒，立即停下向 Claude 报告，不绕过登记。

### 第五份回复的分段测量与停止点

Claude 已于 2026-09-28 21:00 批准继续定位新增耗时与未注入准备失败。保留 fork 前受保护登记、全部身份和释放核验，以及原心跳和执行期限。两份真实安装使用相同分段探针交替执行，每版须有 30 个成功样本，中位增量不得超过 100 毫秒；发生准备失败必须保留并解释，不能用重跑成功替代修复。

诊断在白名单机器码之外保留命令、阶段、实际耗时、消息年龄、原期限余量和序号；不保存任意错误正文。准备请求通过 IPC 校验后立即发送首次心跳，随后仍按原 250 毫秒周期和 1.5 秒失联期限监督。此消息只证明子进程存活，不能替代 ready 或启动授权。

核验性能实验只将原有可执行文件摘要、runner 摘要和运行时身份检查并发执行。每次调用仍新查原证据，没有复用前一次结果；最终两版各30成功样本中位减少848毫秒，保留该改动。跨调用复用核验结果属于另行审批的安全设计变更。

本轮停止点为 TE-06 修复、验收、提交、更新排查计划和独立交接摘要；若现有证据证明不能达到性能门槛，则保存分段数据和原因后报告 Claude，不自行放宽标准。


第五轮进一步发现固定 SRT 初始化的全局 npm 路径发现使用同步命令，可能阻塞准备期间的心跳。Job Host 通过 SDK 已有 `javaAgentJarPath` 参数指定当前安装内随包 JAR；完整 runtime 核验仍覆盖该文件，路径必须规范且为普通文件。缺失或不合法时失败，不搜索全局替代文件。没有修改第三方依赖、文件权限、网络许可或监督期限。真实子进程受控慢 npm 回归已由失败转为通过；最终交替采集加成对补测已取得两版各30成功样本；中位9773.5→8925.5毫秒，旧版另有3次已解释失败，修改版前30次均成功。完整npm test 4606条和npm run check通过，最终真实安装准备失败回归通过。采集曾因未分类的旧版过期prepare封套而停止，保留原失败报告，补测不覆盖原样本；详见[当前排查证据](../plans/2026-09-28-tool-execution-audit-plan.md#第五份回复后的诊断与测量)。

## 第二轮 A2：准备登记之前的封锁

### 已批准合同与交付

本节来源为 [Claude reply-16](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-16.md)。真实准备 resolve 的 UDS 响应断开后，预约无准备附件，成对重启与原 Run 期限都不能推进；证据见 [A2 独立读回](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te11-a2-independent-readback.json)。该路径与已保存准备密钥的 TE-06 路径不同。

批准的新依据 `preparation_not_authorized` 表示：准备登记被接受之前已经封锁，宿主从未获准创建。停止方与登记方竞争同一不可变附件 key `${key(plan)}:preparation`，沿用现有 immediate 事务先写者赢的规则，不改通用附件事务、不建表。封锁内容为固定 version、完整 identity、fingerprint、environmentId、executionLease、原 stopRequestedAt；不包含新时间或随机值。同一内容明文摘要确定，重复写按重放处理。

封锁先赢时，后续登记读到封锁版本或写入冲突，不能成功登记，Worker 不得 fork。登记先赢或遇到不同摘要的 PORT_CONFLICT 时，回到原宿主认证核验或 UNKNOWN，不使用新依据。封锁存在但释放事务失败时保留封锁，下一次可用原内容继续验证释放。

Agent 与 SQLite 都必须限定 `backendRef=srt`。SQLite 在接受回执同一事务中检查 reserved、started_at 为空、reservation_stopped_at 已存在，并验证 evidence.ref/digest 对应同 Run、purpose=trace、准确 preparation key 的 payload_ref/content_digest。SQLite 不解密、不验签；Agent 解释核对封锁内容。container 只能使用既有 task_environment_released 路径。

释放并清除占用后，新依据与 host_never_started 同样给模型既有固定错误 SANDBOX_TOOL_NOT_STARTED：“工具未启动：准备阶段失败，已确认清理完成。”在原 Run 期限前交付，这一轮继续，不重放原调用。TypeScript 与 SQL 各用一个共享判断，统一用于恢复发现、派发再核验、重启恢复、前台交付和 authorizeReservationResult 五处；披露、撤权、租约与期限检查不放宽。

### 新计划字段与旧 Worker 排除

[Claude reply-17](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-17.md) 批准在 v2 计划增加可缺省的 `preparationProtocol: "register-before-host.v1"`。字段仅由 Agent 在新建 SRT 计划时写入；缺失的旧计划按原样解析，不填默认值，不重写持久数据，也不更改原语义指纹或宿主资格摘要。字段存在时严格校验固定字面量。容器路线不使用该标记作为释放依据。

历史 v1 协议及当前新协议的创建入口均在 `production-sandbox-services.ts`：`prepareRuntimeV2()` 为普通、网络及托管任务创建 v2 候选计划；`child.prepare()` 的 v2 分支为私有子调用创建候选计划。这两处在 backendRef 为 srt 时写字段；R2-D4 的当前实现改为写入 `launch-or-block.v2`，已有字段不变，见[启动仲裁](#d4登记确认丢失后的启动仲裁)。子调用不继承父计划的标记，而按当前路线写入。`rebindQueuedRun()` 只恢复已有排队计划并换租约，保留其原标记或原缺省状态，不能把旧计划升级为新协议。v1 创建分支不产生 v2 reserved 记录，保持既有合同。

历史源码审查覆盖从 v2 Worker 引入提交 5d069ab 到 a2f51ba 父提交的全部 21 个相关源码变更点，并显式检查 fc2b318 与 a2f51ba 父提交，共 23 个修订快照、39 个不同源码摘要。路径为生产 composition → ProductionPayloadBrokerClient → PayloadUdsClient → parseJsonResponse → payloadBrokerV1MessageSchema → reserved/bound 计划 schema → v1 planShape/object。所有版本在 run 的首次 read 返回后才到 prepareSandboxJobHost；没有从执行请求取得未解析计划的生产入口。旧 parsePlan 将未知字段继续传给 v1 的 object，后者自 e996c50 起拒绝 unknown field，因此旧 Worker 收到新字段会在创建宿主前失败。源码节选、摘要及祖先关系见 [reply-17 历史兼容性证据](../../../.ci-output/tool-execution-audit/2026-09-28/round2/a2-r17-compatibility-sources.json)。这是固定历史源码证明，不是旧服务运行实验，不涉及 Hermes。

新依据的 Agent 判断与 SQLite basisHolds 都要求本机 SRT 和该固定字段；SQLite 同时直接检查持久 plan_json 的 json_extract 值。缺字段使用可区分的 `SANDBOX_PREPARATION_PROTOCOL_UNAVAILABLE` 原因。已有 host_never_started 与 task_environment_released 依据不依赖新字段，行为保持。

reply-17 撤回 reply-16 的一次额外恢复尝试；不增加重试状态或机会。升级前的 reserved 记录（包括 TE-06 之后的中间版本）没有字段，永远不能使用新依据；无既有宿主证明时仍保留占用和 reconciling_external_result。新版 Agent 配旧 Worker 时，读取新计划失败，不能创建宿主；不会把旧记录标成新版。

两份安装/升级 Runbook 在旧 Agent 与 Worker 完全停止后、新版启动前，用只读查询再次统计 backendRef=srt、reserved、started_at 为空的记录；停服前的查询仅作参考，以停服后的值为准。非零停止升级并报告，不自动释放。这是操作提示；安全证明依赖计划字段与严格解析，不依赖操作者排空承诺。

### 封锁实现边界

停止流程使用已经持久的原 stopRequestedAt，不生成新停止时间。自动恢复与 stopRun 均已读取带停止时间的 admission；向本地控制器传入该值后竞争同一 preparation key。没有新持久表、列、迁移或握手，也不改变准备登记命令。封锁之前检查现有控制记录；真实登记赢或写入冲突后重新读取现有记录，进入原核验路径。已有封锁内容必须逐项符合当前计划和原停止时间，不能据 version 字符串单独认定封锁成立。

共享的 TypeScript 判断描述预约是否确定从未启动；共享 SQL 判断用于恢复发现与派发再核验。它们只识别已经被接受的释放依据，不替代权限、证据、披露或期限检查。Pi 继续复用固定版本 0.84.2 的工具结果交付与 Agent Loop；Himawari 负责持久封锁、资源证明和产品权限，没有新建模型工具协议。

### 实施验证与明确限制

保留缺证据拒绝释放的全部断言。实现前矩阵须覆盖：stop/登记两种先后、ACK 丢失、旧 boot 晚登记、job/attempt/指纹不符、已有控制、重复释放、事务回滚、封锁已存但释放事务失败再恢复、同 identity 改派新 Worker 仍不 fork、同封锁内容重放、container 拒绝及旧版本记录。真实 A2 场景须读回新 basis、占用释放、期限前的唯一 SANDBOX_TOOL_NOT_STARTED 模型交付和 Run 继续。

在本节历史 `register-before-host.v1` 协议中，登记已持久但 Worker 未收到 ACK 的情况不能使用 `preparation_not_authorized`，仍无未启动释放证明；此限制由 R2-D4 的新协议另行处理，旧计划不回填。D 与 E 后续已分别通过独立红绿测试并提交，见下文对应小节；其余限制不因这些修复消失。新增矩阵还包括缺字段双侧拒绝、新字段接受、两个创建入口、旧计划解析及旧依据兼容、旧记录启动恢复直到 Run 到期仍不释放和不交付“工具未启动”。上述矩阵已通过组件与真实 SQLite 测试；新版 A2 真实安装在原期限前完成唯一失败结果交付并继续原轮，成对重启不重复交付。独立旧格式安装在成对重启及原 Run 期限后仍保留占用、不交付“工具未启动”。原生产故障、测试夹具错误与修正后的结果分别保留；证据和具体命令见 [A2 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/a2-r17-verification.md)。完整项目测试及本地提交状态以该记录为准。


### D4：登记确认丢失后的启动仲裁

当前实现为新建 SRT 计划冻结 `launch-or-block.v2`。Worker 在发送准备登记前固定控制目录设备/inode；收到确认后、fork 前申请不可覆盖的启动决定。Agent 停止未绑定预约时可以竞争同一决定，禁止启动先写入后，迟到确认不能再创建 Host。Agent 必须独立核对原准备登记、机器 boot、目录、HMAC 决定和受保护 trace Artifact，才能产生 `preparation_launch_blocked`；SQLite 在释放事务内核对原身份、停止时间、协议、Artifact 摘要及没有 main Host 控制登记。原登记之前的 `preparation_not_authorized` 同时适用于两种已知协议。

旧 v1 与无字段计划保持原语义。启动决定先写入而尚无 Host 证明时仍 UNKNOWN，不据 ACK 缺失或日志宣称未启动，不重发原工具。数据库结构、准备/执行/清理期限、原 authority 和租约门禁不变。完整算法、竞争与中断边界见[启动与停止仲裁设计](2026-10-04-sandbox-preparation-launch-arbitration-design.md) [SOURCE: docs/execution/specs/2026-10-04-sandbox-preparation-launch-arbitration-design.md]。

修复前真实安装已复现：Agent 接受准备登记后，Worker 丢失确认且无 Host 创建；40 秒后 Run 仍为 `reconciling_external_result`，预约仍为 reserved、started_at 为 NULL、占用未释放且没有释放回执。原始失败断言和 SQLite 读回经 SHA 核对，见[修复前报告](../../../.ci-output/tool-execution-audit/2026-09-28/round2/hermes-r64/independent-d4-red/product-ack-loss-red-run.json)。修后真实安装的四个相关场景均通过，包含确认丢失、新旧协议传输失败及准备诊断。确认丢失场景独立读回一条 `preparation_launch_blocked` 回执、已释放占用、空 started_at、没有 Host 创建或工具重放；成对重启后仍为同一回执和一次模型工具回复。该报告覆盖输入指纹 `38bfcb73f2f228f282ca9b95e9b82c0870d6cb91657b4c35c4c56ed650cc978b` 与安装包摘要 `a1b6f186a74c32693cd46d0fd3cc34a1e792b2e6522fbb19aebfde6fd5b43167`，见[真实安装读回](../../../.ci-output/tool-execution-audit/2026-09-28/round2/hermes-r64/independent-d4-green-03/product-ack-loss-green-output/33-preparation-ack-loss-readback.json)。交付仍须完成第 0–3 层、自审和受影响产品路径；具体完成状态以长任务证据为准。Mac 与生产仍未验证。

### D：断连后的准备失败诊断

准备 resolve 传输失败会清除 Payload 客户端的连接状态；原 Worker catch 紧接着发送诊断，被本地握手前置检查拒绝，诊断再次失败而未持久。D 提交 `33c1590` 原先只在保存诊断前显式重握手；后续 F 已将该特例删除，改由 Payload 客户端的通用恢复机制处理，再按既有 schema 与 Agent 权威检查保存受保护诊断；不重发失败操作、不创建宿主、不增加接口或持久队列。握手或权威仍无效时，诊断仍可能无法持久，不保证所有网络/重启故障均可记录。组件红绿与实际产品验证范围见 [D 诊断记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/d-verification.md)。


### E：container 预约自动恢复分流

2026-09-29 的 E 修复将自动预约恢复按 backendRef 分流。本机 SRT 保留准备控制封锁与核验；container 使用既有 environments.releaseReservation，并验证配置的后端一致。当时预约恢复只读取环境自身的 TaskEnvironmentCoordinator 已保存的认证释放回执，没有新增停止整轮环境的动作。环境仍在运行时不释放预约，也不放宽原 unresolved 调度规则。该版本的真实 SQLite、生产装配及受控环境生命周期证据见 [E 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/e-verification.md)；这不是 Docker 或 Linux 现场资格。当前终态 Run 的补充停止规则见[未绑定容器的终态恢复](#container-unbound-recovery)。

<a id="container-unbound-recovery"></a>

### D6：未绑定容器的终态恢复

当前 Agent 的 reserved 恢复分支先核对原预约停止标记和配置的后端，再通过原 Owner/Agent 的公开 RunLifecyclePort 读取权威 Run。只有 `completed`、`failed` 或 `cancelled` 才复用现有同 Run 环境 `stopRun`；取消用 `run_cancelled`，其他终态用 `run_finished`。活动 Run 和 `reconciling_external_result` 保持原读取释放证明的路径，不因被列为恢复候选就停止其环境。数据库将一个 Run 的环境限制在原 execution job 与 host；其他 Run 的环境不参与停止。

环境停止仍经原停止 intent、fence、TaskEnvironmentCoordinator 和认证证明。停止返回 accepted 不等于释放；Agent 要独立读回环境释放回执，原预约事务再核对身份、后端、环境、停止时间、恢复 revision 和工作区占用。停止失败、证明缺失或身份不符时，环境与预约继续占用，本次核查记录 unresolved；暂时原因按[未启动预留的持续清理核查](#reserved-retry)重新排定，身份、签名及权限错误仍暂停。每次核查的原 30000 毫秒上限不变。Worker 已保存失败的原停止命令不会被同义人工请求重新执行；该请求仍返回未释放。原停止命令已接受、只有后续核验证明失败时，人工清理可以按原 intent 取得新证明；不能改写旧停止身份或以删除记录替代证明。

该组合属于 Himawari 的持久资源恢复职责，复用已有 Pi 工具和 Worker 协议，不改 Pi、模型执行、权限消费、数据库结构或业务请求重放规则。测试覆盖公开取消/失败、Agent 重开与二次重开、其他 Run 隔离、停止失败、证明缺失与错误身份、活动 Run 及已取消的恢复信号。真实 Docker 检查使用现有容器资格入口、实时夹具、独有环境标识和独立 Docker/SQLite 读回；受控安装资格不能当作已安装生产主机资格，实际结果和命令归本批报告。


### F：通用 UDS 断连恢复

[第二轮 reply-18](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-18.md) 要求确认准备阶段以外的断连。生产 Worker 装配的同一实例在首次写输出传输失败后，后续调用原先被 HANDSHAKE_REQUIRED 拒绝，就绪状态仍为 true；Admission 也有断连后拒绝后续调用的问题。两个客户端现复用同一个内部握手协调器。它不改变已有认证协议、peer/boot、凭据、epoch/fence 或业务封套。

传输失败的那次业务调用按原结果结束，不自动重发。仅之前已成功握手的客户端，才在后续操作前发起一次有界握手；并发业务调用和显式 connect 共享同一握手 Promise，失败分别收到原有错误码。显式 disconnect 使等待中的旧握手失效，迟到回复不能恢复就绪。首次尚未显式握手的业务请求仍被拒绝。

Worker 就绪状态读取两个客户端当前的握手状态。曾经成功连接的 Worker 若后来断开，后续就绪探测可以发起一次共享恢复，当前探测仍返回未就绪，成功后的探测才返回就绪。握手失败不自动循环重试；后续探测可再次尝试。关闭时保持未就绪，重握手等待者收到 SHUTDOWN，不能复活 Worker。 若 Worker 正在停止任务并保存清理观察，连接错误处理不抢先断开 broker，由 close 在 shutdown 完成后统一断开；否则连续保存清理事实会在中途失去通道。该机制只恢复同一配置身份下的通道，不支持把旧 Worker 身份迁到新 Agent boot。

D 的 resolve 断连与握手拒绝测试已接入真实 Payload UDS Server、ProductionPayloadBrokerClient 和故障代理，继续验证诊断、原 resolve 不重发、无宿主创建与原请求重放幂等。F 的故障矩阵使用实际 UDS 认证和解析；外部 endpoint 执行仍为既有 fetch 夹具，不能当作 SRT 操作系统隔离或 Linux 资格。命令、红绿证据、夹具修正与完整验证状态见 [F 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/f-verification.md)。Pi 沿用固定版本 0.84.2 的工具入口和 governed host operations；此次协调器只处理 Himawari 自有 Agent/Worker 通道，不另建 Pi 工具协议。

E 的原只读补查记录了终态 Run 的未绑定容器缺少自动停止路径，并登记 [BL-20260929-004](../../backlog/BL-20260929-004-agent-重-启-后-停-止-终-态.md)。用户随后将 R2-D6 纳入上线前修复，当前实现见[未绑定容器的终态恢复](#container-unbound-recovery)。期限转 failed 的事务仍要求资源全部释放；这次修复不使期限回调越过资源门禁，也不把旧静态核查改写成现场复现。


<a id="startup-supervision"></a>

## 第二轮：依赖加载期间的启动监督

[reply-33](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-33.md) 批准修复 Job Host 在注册 IPC 处理器前静态加载 SRT 的顺序。旧实现的首次准备消息可能因加载超过 1.5 秒而过期；Worker 同时会报告 `JOB_HOST_HEARTBEAT_EXPIRED`。这解释了 Hermes 第二轮准备清理回归的失败，不追溯认定更早未保留现场的 TE-06 首次触发原因。

Job Host 先加载 Node 内置模块和轻量宿主辅助模块，注册原私有 IPC 处理器；收到准备消息时立即核对协议、会话、序号及到达时的消息年龄，发送首次心跳并启动原 250 毫秒心跳。随后动态加载固定版本 SRT 和依赖它的策略编译模块。到达时新鲜的消息不会因等待依赖而再次被判为过期；到达时已超过 1.5 秒或来自未来的消息仍被拒绝。诊断结构所需的依赖也在首次心跳后加载；错误处理本身不再等待导入，不能因此延后停止。

Worker 从原 fork 时点开始的 30 秒准备上限、1.5 秒双向监督窗口、任务总期限及清理期限均保持；Job Host 自身的任务期限在解析有效请求后立即计时，覆盖依赖加载。加载期间的心跳只证明监督通道仍有响应，不代表准备完成。策略、依赖和初始化检查全部通过后才发出 ready，仍须原唯一启动授权才能启动用户任务。取消或到期后，迟到的加载完成不能恢复准备或启动能力。

依赖加载失败以 `host_failure` 结束，诊断阶段为 `dependencies`，只保留现有白名单机器码。若最先加载的 `execution-contracts` 本身失败，Job Host 通过原有允许省略 detail 的诊断消息发送阶段和系统码；Worker 仍按既有枚举校验并保存，不依赖基础设施 stderr 推断阶段，也不在错误处理中再次导入模块。SRT 未加载时 `srtReset` 为 false；没有实际复位及签名终态就不能宣称清理完成。加载已开始时，清理等待该操作结束，再对已加载的 SRT 复位；原强制退出上限继续有效。控制绑定、签名终态格式、Agent–Worker 消息和所有认证检查均不变，不新增消息类型。

验证使用真实打包 Job Host 的测试加载钩子，固定延迟 2.5 秒，并覆盖超过 30 秒准备上限、SRT 与 contracts 各自的导入失败、准备期间任务期限到达、到达时已过期的消息；准备失败后的恢复仍须独立读取原签名终态。该边界无法靠普通 UI 操作稳定触发，因此使用已有集成测试入口。命令、版本、补丁及实际结果见[首次验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r33-verification.md)和[reply-34 返工验证](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r34-verification.md)。本修复不改变 Pi Operations：Pi 负责工具语义，Himawari 的 Job Host 负责隔离与监督。Mac 与 Linux 共用此代码；Mac 定向验证并入 BL-002；用户已无限期推迟全部 Mac 验证，因此本批仅报告 Linux 证据，Mac 行为未验证，不安排后续 Mac 运行。

<a id="deadline-classification"></a>

### 准备期间的期限诊断分类

[reply-35](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-35.md) 批准修正 Worker 对期限的分类。旧准备定时器取任务期限与 30 秒的最小值，与任务定时器重复负责同一绝对期限；两次注册之间的时钟变化可能使准备回调先到，留下 `JOB_HOST_PREPARATION_TIMEOUT`，而真实 Job Host 最终以 `deadline` 结束。

Worker 父端只用一个回调判定任务绝对期限。任务期限早于或等于 30 秒准备上限时，只保留任务期限回调，诊断必须是 `JOB_HOST_EXECUTION_DEADLINE`；只有准备上限更早时，才另设独立的 30000ms 准备回调，诊断为 `JOB_HOST_PREPARATION_TIMEOUT`。取消或结束后，迟到回调不能再分类。1500ms 监督窗口、准备上限、绝对期限、清理期限及全部启动/认证检查不变，不增加协议字段或用户可见入口。

验证保留真实子进程的 `task deadline during import` 用例。真实进程无法稳定控制两个回调的先后，因此已有 Job Host 单元测试使用可控时钟，覆盖任务期限更早、准备上限更早、相等时任务期限优先，以及取消/结束后排队回调不再分类；断言只接受各场景唯一正确的诊断码。2026-10-01 按 reply-36 与 [ADR 0044](../../adr/0044-tests-on-cloud-server.md#hosts)，以 `himawari-test` 在云服务器 `84.247.157.41` 运行红测：原代码30项中4项失败，失败为两个期限分类及取消/结束后的重复分类；同一测试在修复后30项全部通过。真实导入期限回归1项通过、7项筛选未执行；按 reply-37 恢复 MCP 的 `os.tmpdir()` 后，第1层 `npm run check` 通过，完整unit组2150项中2134通过、16失败，Job Host 30项全部通过。对5个失败文件定向检查后，86项中71通过、15失败；CLI备份/权威转移与Agent服务组合测试仍超过原5000ms期限，根因未确认，交Claude裁定调查范围。原19文件integration和第3层未执行，修复尚未提交，Mac未验证。独立补丁、命令及实际结果见[红绿验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r36-verification.md)和[reply-37验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r37-verification.md)。

reply-38下重新运行完整unit：30000ms仅是获批的云端项目默认测试时限，产品期限和原诊断断言不变。Job Host30项通过，旧16项超时全部通过且逐项耗时不超过15000ms；完整组2150项中2149通过/1失败，新失败为既有Retry-After发送间隔985.293ms未达到990ms断言，根因uncertain。按批次范围停止，原19文件integration和第3层未执行，Job Host修复尚未提交，4份Runbook仍待第0–2层通过后复核封存。当前结果见[reply-38验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r38-verification.md)与[stop-35](../../../.ci-output/handoff/2026-09-28-codex-round2-stop-35.md)。

[reply-39](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-39.md) 调整提交顺序：Job Host 第0层红绿与真实导入回归已通过，复用代码未变的云端第1层结果（`r39-retry-layer1`，默认变量30000ms）；先将修复、合同及4份Runbook核对封存一起提交并立即推送。第2层延后到含入口透传、D11及本修复的合并版本，运行完整unit与原19个integration文件；随后执行提前的正式第3层。本次提交不声称合并第2层或完整第3层已经通过。历史失败及其时序继续保留，Mac未验证。实际记录见[reply-39验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r39-verification.md)。

[返回阅读导航](#阅读导航)
