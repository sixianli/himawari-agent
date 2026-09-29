---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-28"
---

# 沙箱准备失败的控制关联与恢复提案

**审阅状态：Claude 已于 2026-09-28 19:55 批准；第五份回复范围内的实施与验收已完成，完整产品资格仍待后续任务。** 批准依据为 `.ci-output/handoff/2026-09-28-claude-reply-4.md`。 本提案处理 TE-06 已确认的恢复缺口。原现场第一次准备失败的触发原因仍不确定；不能把本提案解释成已证明原故障由磁盘、心跳或某个并发写者引起。

2026-09-29 第二轮 reply-16、reply-17 已批准 A2 的准备封锁、新释放依据与计划协议字段；[追加设计](#第二轮-a2准备登记之前的封锁)尚未实现。TE-11 分页和 A1 已独立提交 `022c81a`，不能据此宣称 A2 已恢复。

## 阅读导航

- [目标与来源](#目标与来源)
- [已经确认的证据](#已经确认的证据)
- [现有数据为什么不够](#现有数据为什么不够)
- [建议的数据与执行顺序](#建议的数据与执行顺序)
- [权限与失败边界](#权限与失败边界)
- [替代方案](#替代方案)
- [验收与审批范围](#验收与审批范围)
- [第二轮 A2：准备登记之前的封锁](#第二轮-a2准备登记之前的封锁)

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

## 替代方案

只在 ready 失败的 catch 中补登记，可以改善进程仍活着的部分情况，但无法处理补登记之前 Worker 退出，且现有 register 不接受已经关闭的宿主。它没有消除丢失关联的窗口。

放宽心跳或增加重试次数只改变触发概率，不能恢复已经丢失的认证材料。根据未认证 final 文件释放则降低现有释放证明要求。两者均不采用。

## 验收与审批范围

批准后先把探针转为现有 Vitest 框架内的可重复失败测试，再修改实现；保留红绿日志。覆盖 fork 前后、ready 失败、登记 ACK 丢失、Worker/Agent 退出、取消/撤权、原期限、密钥/目录/身份替换和重复恢复。验证无原工具启动、无第二份控制关联、无伪造 bind、无重复模型消费。必要的 OS/SDK 故障注入需注明边界，真实产品路径另行验证。

Mac 产品路径重复审批写入至少 30 次，加入准备失败和重启的确定控制点，保留每条 Job、预留释放回执、模型调用、文件内容及实际进程证据。再次失败先保留第一份原因，不以重跑通过销项。第五份回复已调整停止点：本轮完成 TE-06 验收、完整 check/test、本地提交与交接后停止；剩余 stop/deadline/finish 故障、交错验证及最终未筛选 Mac 产品资格由 Claude 在新会话派发。

Claude 第四份回复已批准上述受保护准备控制记录、fork 前登记顺序、确定未启动的失败交付，以及有界机器码诊断。批准不包含 Hermes、用户服务、下载、push 或历史数据修复。当前按下列附加要求实施验证，未经实测的项不记为通过。

### 第四份回复的附加验收

首次准备、控制登记与 bind 失败须通过既有 `sandbox-control:*:diagnostic:*` 受保护记录保留有界阶段与机器错误码，可由 `himawari diagnose run` 查询，不进入日志、不包含任务正文或密钥。Mac 同样的 30 次审批写入在改动前后记录从原计划 requestedAt 到 tool_result acknowledgedAt 的耗时，统计中位数和最大值，同时保留各样本和环境；若中位数增加超过 100 毫秒，立即停下向 Claude 报告，不绕过登记。

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

当前生产创建入口均在 `production-sandbox-services.ts`：`prepareRuntimeV2()` 为普通、网络及托管任务创建 v2 候选计划；`child.prepare()` 的 v2 分支为私有子调用创建候选计划。这两处在 backendRef 为 srt 时写字段。子调用不继承父计划的标记，而按当前路线写入。`rebindQueuedRun()` 只恢复已有排队计划并换租约，保留其原标记或原缺省状态，不能把旧计划升级为新协议。v1 创建分支不产生 v2 reserved 记录，保持既有合同。

历史源码审查覆盖从 v2 Worker 引入提交 5d069ab 到 a2f51ba 父提交的全部 21 个相关源码变更点，并显式检查 fc2b318 与 a2f51ba 父提交，共 23 个修订快照、39 个不同源码摘要。路径为生产 composition → ProductionPayloadBrokerClient → PayloadUdsClient → parseJsonResponse → payloadBrokerV1MessageSchema → reserved/bound 计划 schema → v1 planShape/object。所有版本在 run 的首次 read 返回后才到 prepareSandboxJobHost；没有从执行请求取得未解析计划的生产入口。旧 parsePlan 将未知字段继续传给 v1 的 object，后者自 e996c50 起拒绝 unknown field，因此旧 Worker 收到新字段会在创建宿主前失败。源码节选、摘要及祖先关系见 [reply-17 历史兼容性证据](../../../.ci-output/tool-execution-audit/2026-09-28/round2/a2-r17-compatibility-sources.json)。这是固定历史源码证明，不是旧服务运行实验，不涉及 Hermes。

新依据的 Agent 判断与 SQLite basisHolds 都要求本机 SRT 和该固定字段；SQLite 同时直接检查持久 plan_json 的 json_extract 值。缺字段使用可区分的 `SANDBOX_PREPARATION_PROTOCOL_UNAVAILABLE` 原因。已有 host_never_started 与 task_environment_released 依据不依赖新字段，行为保持。

reply-17 撤回 reply-16 的一次额外恢复尝试；不增加重试状态或机会。升级前的 reserved 记录（包括 TE-06 之后的中间版本）没有字段，永远不能使用新依据；无既有宿主证明时仍保留占用和 reconciling_external_result。新版 Agent 配旧 Worker 时，读取新计划失败，不能创建宿主；不会把旧记录标成新版。

两份安装/升级 Runbook 在停旧服务前用只读查询统计 backendRef=srt、reserved、started_at 为空的记录。非零停止升级并报告，不自动释放。这是操作提示；安全证明依赖计划字段与严格解析，不依赖操作者排空承诺。

### 封锁实现边界

停止流程使用已经持久的原 stopRequestedAt，不生成新停止时间。自动恢复与 stopRun 均已读取带停止时间的 admission；向本地控制器传入该值后竞争同一 preparation key。没有新持久表、列、迁移或握手，也不改变准备登记命令。封锁之前检查现有控制记录；真实登记赢或写入冲突后重新读取现有记录，进入原核验路径。已有封锁内容必须逐项符合当前计划和原停止时间，不能据 version 字符串单独认定封锁成立。

共享的 TypeScript 判断描述预约是否确定从未启动；共享 SQL 判断用于恢复发现与派发再核验。它们只识别已经被接受的释放依据，不替代权限、证据、披露或期限检查。Pi 继续复用固定版本 0.84.2 的工具结果交付与 Agent Loop；Himawari 负责持久封锁、资源证明和产品权限，没有新建模型工具协议。

### 实施验证与明确限制

保留缺证据拒绝释放的全部断言。实现前矩阵须覆盖：stop/登记两种先后、ACK 丢失、旧 boot 晚登记、job/attempt/指纹不符、已有控制、重复释放、事务回滚、封锁已存但释放事务失败再恢复、同 identity 改派新 Worker 仍不 fork、同封锁内容重放、container 拒绝及旧版本记录。真实 A2 场景须读回新 basis、占用释放、期限前的唯一 SANDBOX_TOOL_NOT_STARTED 模型交付和 Run 继续。

登记已持久但 Worker 未收到 ACK 的情况不能使用新依据，现有路径仍无终点；这是明确待决限制，不在本次封锁方案的修复范围。准备失败诊断丢失 D 与 container 自动恢复分流 E 仍须独立测试确认，未据静态猜测声称修复。新增矩阵还包括缺字段双侧拒绝、新字段接受、两个创建入口、旧计划解析及旧依据兼容、旧记录启动恢复直到 Run 到期仍不释放和不交付“工具未启动”。上述矩阵已通过组件与真实 SQLite 测试；新版 A2 真实安装在原期限前完成唯一失败结果交付并继续原轮，成对重启不重复交付。独立旧格式安装在成对重启及原 Run 期限后仍保留占用、不交付“工具未启动”。原生产故障、测试夹具错误与修正后的结果分别保留；证据和具体命令见 [A2 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/a2-r17-verification.md)。完整项目测试及本地提交状态以该记录为准。
