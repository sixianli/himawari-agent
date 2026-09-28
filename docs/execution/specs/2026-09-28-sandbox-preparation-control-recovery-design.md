---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-28"
---

# 沙箱准备失败的控制关联与恢复提案

**审阅状态：Claude 已于 2026-09-28 19:55 批准；第五份回复范围内的实施与验收已完成，完整产品资格仍待后续任务。** 批准依据为 `.ci-output/handoff/2026-09-28-claude-reply-4.md`。 本提案处理 TE-06 已确认的恢复缺口。原现场第一次准备失败的触发原因仍不确定；不能把本提案解释成已证明原故障由磁盘、心跳或某个并发写者引起。

## 阅读导航

- [目标与来源](#目标与来源)
- [已经确认的证据](#已经确认的证据)
- [现有数据为什么不够](#现有数据为什么不够)
- [建议的数据与执行顺序](#建议的数据与执行顺序)
- [权限与失败边界](#权限与失败边界)
- [替代方案](#替代方案)
- [验收与审批范围](#验收与审批范围)

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
