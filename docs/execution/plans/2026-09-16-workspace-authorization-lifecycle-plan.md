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

**当前范围：** 用户于 2026-09-16 要求实施本 Plan。P0 的 r3 新增交互已获确认，P1 正在实施：永久释放回执、结果 ACK 分离、有界核验及未派发页面分类已加入代码与回归。完整 P1～P7 未完成；详见[本次实施记录](#implementation-record)。Spec 已通过不等于自动审查配置或生产操作已获授权。

<a id="contents"></a>

## 阅读导航

- [本次实施记录与待审核交互](#implementation-record)

- [一、先看实施顺序与交付结果](#roadmap)
- [二、已经核对的代码与测试基础](#baseline)
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
- [ ] 明确 operation、attempt、invocation、审批、额度预约、文件占用、恢复任务与交付消息的身份关系和各自持久化点。复用现有字段，只对不能表达的部分版本化扩展。
- [ ] 列出 release receipt（永久释放记录）、新风险保护、排队与文件提交阶段所需数据；确定迁移、reader、writer 和 Worker 的兼容顺序。没有可靠平台证据的安全原语列为后续资格检查，不能假定可用。
- [x] 按既有 ADR 治理记录必须新增的持久决策；[ADR 0030](../../adr/0030-durable-workspace-release-facts.md) 仅记录本 Spec 已确认的释放事实与风险保护原则，不改变历史 ADR。
- [x] 对照冻结 v4 原型补出新增场景并保存 r3；用户于 2026-09-16 明确确认，允许用于对应 UI 实现。冻结原型内“待审核”文字保留，批准事实以本条为准。
- [ ] 检查现有真实浏览器路径是否都等待“已连接”；为首次打开立即点击/发送、慢配置、断线完成保留独立用例，不共享会掩盖问题的就绪前置。

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

- [ ] 在现有 ActionPolicy 中增加可选审查调用：硬拒绝 → 有效授权/允许规则 → 符合委托范围才自动审查 → 必要人工确认/拒绝。未配置时保留现有人工处理路径。
- [ ] 定义结构化审查请求/结果并绑定请求摘要、政策版本、模型配置版本与决策来源。批准范围由宿主校验，审查模型的自由文本不能直接创建广泛 grant 或命令执行。
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

验收语义以来源 Spec 的矩阵为准。下面逐项分配实施责任、测试入口和必须检查的证据；**当前全部为待验证**。一个场景可能需要多个用例，68 行不代表恰好只写 68 个测试。失败前证据适用于可复现缺陷，不伪造新增功能的历史失败。

<a id="test-entries"></a>

### 测试入口索引

下列代号只为减少表格重复，链接指向已存在的测试。它们是扩展入口，不代表已经覆盖新要求。

- **J**：[SQLite 执行记录](../../../test/integration/sqlite-sandbox-execution-v2.test.ts)、[执行准备](../../../test/integration/sandbox-execution-preparation.test.ts)、[Worker 生命周期](../../../test/integration/sandbox-v2-worker-lifecycle.test.ts)。
- **A**：[权限额度](../../../test/integration/permission-grants.test.ts)、[生产审批订阅](../../../test/integration/production-approval-subscription.test.ts)；补充生产 ActionPolicy 的直接集成断言。
- **F**：[受控文件](../../../packages/platform-node/test/constrained-file-system.unit.test.ts)、[Pi 文件操作适配](../../../packages/platform-node/test/sandboxed-coding-operations.unit.test.ts)、[宿主身份](../../../packages/platform-node/test/sandbox-host-verifier.unit.test.ts)；新增跨 Worker 文件协调集成测试。
- **S**：[生产范围](../../../test/integration/production-sandbox-scope.test.ts)、[运行库策略](../../../packages/runtime-sandbox/test/policy.unit.test.ts)、[候选工作区](../../../packages/platform-node/test/qualified-candidate-workspace.unit.test.ts)、[Git 适配](../../../packages/platform-node/test/git-workspace-adapter.unit.test.ts)。
- **T**：[运行时工具](../../../apps/agent-service/test/production-runtime-tools.unit.test.ts)、[运行历史](../../../test/integration/runtime-history.test.ts)、[外部效果核验](../../../test/integration/external-action-reconciliation.test.ts)。
- **B**：[页面投影](../../../apps/control-center/test/execution-view.unit.test.ts)、[Playwright 执行链](../../../scripts/test-execution-chain-browser.mjs)、[授权反馈](../../../scripts/test-authorization-feedback-browser.mjs)、[浏览器主入口](../../../scripts/qualify-control-center-browser.mjs)；P6 补真实服务路径，不能仅用 fixture。
- **R（拟新增）**：ActionPolicy 自动审查单元/集成测试与真实配置资格测试；复用 A/T/S，新增文件按现有 runner 命名规则收集。
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

### P2 接口边界核查（尚未实现）

生产路径为 `ActionPolicyService.evaluate` → `CapabilityHandleService.issue` → `WorkerDelegationAdmissionService.admit` → SQLite invocation receipt → Worker executable message。当前权限判定直接消费额度，尚无“等待但未获派发权”的独立记录。后续应在原授权存储内预约，并将预约与 Handle 的关联随创建事务持久化；在现有 invocation receipt 授权事务中承诺额度。承诺后不得仅因没有收到 Worker 结果而退回额度，明确撤销派发须先使旧 receipt 无法再执行。

请求摘要应使用带版本和域标识的 canonical SHA-256；旧 FNV 标识只用于验证历史记录，不能给新请求继续生成弱摘要。比较历史审批时还须比较完整冻结快照，避免把摘要相等当作内容必然相同。请求内容变化使用新 intent，不能重写旧 key。重复决定在 SQLite 事务中返回同一个历史决定；相反决定、错主体、不同快照和取消/过期后批准均须拒绝。

硬拒绝应检查任一目标是否相交，不能要求所有目标都被同一禁止前缀覆盖；历史拒绝应在允许规则和 grant 复用前检查。当前 `assertGrant` 会检查撤销、期限和部分范围，但派发边界还需核对原请求及当前硬规则。以上是代码核查所得实施约束，不是已完成的授权连续性或数据迁移证据。

### 当前完成边界与下一步

P0 尚未全部完成；P1～P7 和 68 项产品验收仍未完成。已保存复现和审核稿，P1 的释放与交接修复、定向回归及标准本地 CI 已通过，正在保存本地阶段提交；尚无生产迁移或部署。Architecture/README 暂不修改，以免将准备工作写成已实现能力；Spec/Plan 不归档。后续优先实现并验证 W09/W10/W15 对应的永久释放事实、结果交接分离和新风险保护，再推进授权与文件并发。

[单一决策日志](../../../test/qualification/evidence/workspace-authorization-lifecycle/decisions.tsv) 记录本轮选择及证据；没有建立另一个项目状态缓存。
