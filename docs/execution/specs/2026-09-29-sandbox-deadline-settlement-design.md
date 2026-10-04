---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-29"
---

# 工具超时交付与 Run 到期收尾设计

[目标与来源](#目标与来源) · [范围与验收](#范围与验收) · [工具超时](#工具超时) · [期限结果恢复的信任边界](#期限结果恢复的信任边界) · [Run 到期](#run-到期) · [错误与页面](#错误与页面) · [验证](#验证)

## 目标与来源

工具按原期限退出并完成认证清理后，应把确定的超时错误交回原 Pi 批次；若直到原 Run 期限仍无法继续，则在所有资源确认释放后结束本轮，避免一直显示结果未确认。

排查范围及必须成立的规则：[SOURCE: docs/execution/plans/2026-09-28-tool-execution-audit-plan.md]，见[工具执行排查计划](../plans/2026-09-28-tool-execution-audit-plan.md)。本设计已由 Claude 的 [reply-10](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-10.md) 和 [reply-11](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-11.md) 批准。实现与运行证据分开记录在[TE-09 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te09-verification.md)。

## 范围与验收

- 工具执行、派发和 Run 的原期限不延长。仅等待工具结果及清理汇报的截止点取 `min(工具期限 + RECOVERY_SETTLE_WAIT_MS, 原 Run 期限)`，复用既有的 35000 毫秒上限。
- 经认证的期限终止交付 `SANDBOX_TOOL_DEADLINE_EXCEEDED`，不重新执行工具；期限前的部分输出不能被当成成功结果交给模型。
- 原 Run 期限到达后，只有原输入、权限和版本仍一致、全部资源认证释放，或权威数据证明纯非沙箱 UNKNOWN 没有资源义务，才能在一个事务中将 Run 与 checkpoint 写成既有的 failed 状态。
- 不新增表、迁移、持久字段、状态、队列或用户 API；不改变普通 `claim()`、`quarantine()` 的语义。

## 工具超时

Pi 继续负责工具批次及模型循环。Himawari 负责原期限、权限、受保护输出、认证释放和耐久交付，不另建 Pi 工具执行协议。

正常 Worker 路径要求结束语义为 `reasonCode: deadline`、`taskProcessExited: true`、`exitCode: null`，同时核验原宿主签名 final、环境身份、策略摘要和已认证释放，再写确定错误。恢复路径复用受保护的连续分块和结束块；除了已有释放回执，还读取原宿主签名退出事实，得到相同确定错误。其他无退出码的结束情况维持未知。

期限前输出仍按原机制保存为受保护证据，模型交付的 `outputRef` 为 null。读操作的效果为不适用；写入和命令的效果仍未知。确定的错误只表示工具已超时并清理，不表示工作区没有变化。

后台资源观察也可能先于结束块提交推进资源序号。Worker提交被拒绝后，仅在重读确认原计划和环境绑定未变、资源序号严格前进时，沿用既有五次完成记录尝试上限提交同一块。Agent的序号核验与分块幂等校验不变；序号未变、绑定变化或读取权限失效时停止，不能借重试取得执行权。结果通知后的核验等待也受同一汇报截止和当前权限检查约束。

正常结果与超时错误竞争时，沿用 operation revision 的比较并交换及已持久确定结果优先规则。恢复只导入缺失结果；迟到结果不能覆盖已有确定结果。交付继续经过原 Run 执行租约、权限、释放和唯一 intent 检查。

## 期限结果恢复的信任边界

本节依据 Claude 的 [reply-12](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-12.md) 与修订后的 [reply-13](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-13.md)。普通结果恢复要求原工具执行期限尚未到达；期限失败本身发生在这个时间点之后，因此无法复用普通恢复的时间窗口。

现有 `readResultRecovery` 和 `importResult` 增加内部可选用途 `recoveryPurpose: deadline_failure`。未指定用途时，普通恢复的期限与权限合同不变。指定用途也不授予执行权，不能导入普通成功、不能重跑工具或撤回已接受释放。

Agent 沿用现有密钥和控制通道，解密并验证完整连续分块、摘要与结束块的 deadline/null/true 语义，再核验原宿主签名 final、原环境身份和已接受释放。只有全部满足、工具期限已到而原 Run 期限未到时，才带用途发出请求；正常结束、其他 null 退出或签名失败不会进入该用途。

SQLite 事务独立核对其持有的持久事实：原 Run 非终态、当前 authority、Handle/Grant 有效且未撤销、原释放回执、无占用和无矛盾、资源序号及 operation revision。原作业结束块与 control artifact 必须 active，作用范围、operationKey、Payload ref 和内容摘要必须与请求来源相同；control 的引用和摘要通过 `source.controlArtifact` 传递，不传 token 或解密内容。分块来源仍逐份核对。时间窗口必须为 `工具期限 <= now < 原 Run 期限`；仅此用途替换原 plan 和冻结 receipt 的三个执行期限门槛。

事务只允许该用途形成 `error / SANDBOX_TOOL_DEADLINE_EXCEEDED / failure`，效果只能保持未知或固定读取的不适用。持久 operation 继续保留既有必需的受保护 output 证据引用；对模型的交付结果由已有工具结果适配器固定为 `outputRef: null`，只返回中文超时说明，不能交付部分 stdout。已持久的确定结果优先，重复导入不新增 operation；最终消费仍受原唯一 intent 约束。

期限终止明文语义和签名由 Agent 核验，SQLite 将其决定限制为失败并绑定到准确的持久记录。这是沿用普通分块恢复和 LOST 的有意信任边界；SQLite 不持有 Payload 密钥，不接收明文证明或签名信封，也不新增跨包依赖。重启发生在原 Run 期限之后时不导入，进入下述 `settleExpired` 收尾路径。

## Run 到期

Run 表自身没有可信的原执行期限字段。沙箱 plan 保存原期限，但不能单独代替 Run 的原始输入；因此 Agent 读取已有 `run-execution-input:v1` artifact 对应的受保护 Payload，校验摘要、版本、源输入及时间范围，取得冻结的原 Run 期限。SQLite 事务再次比较冻结 artifact 的引用和摘要，并要求该 Run 所有 plan 的原期限与其一致。不根据重启时间重新计算期限。

仅为既有 `RunReconciliationPort` 增加 `settleExpired`。一个 SQLite immediate 事务依次完成：

1. 校验当前 Agent authority、Run/checkpoint/旧 lease revision、冻结输入、原期限已到。
2. 要求 Run 与 checkpoint 仍为待核查、无最终输出，旧执行租约不再活跃，且 `RUN_RESOURCES_RELEASED_SQL` 的全部条件成立。
3. 建立属于当前 Agent 的临时收尾租约；在同一事务内检查其归属。
4. 将 Run 与 checkpoint 写为 failed，checkpoint 原因码为 `RUN_EXECUTION_DEADLINE_EXCEEDED`。
5. 同一事务释放该租约，并复用标准 Run 回执写入，保存 `command_results`、待发布的 `run.failed` 可靠事件、线程版本加一及对应网关事件。任一步失败则全部回滚；不产生可继续调用模型或工具的持久租约。

按 [reply-15 B2](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-15.md) 与 [reply-19](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-19.md)，到期路径与普通状态转换共用回执写入函数，不复制 SQL。幂等键绑定 owner、agent、原 Run 和原期限，可靠事件引用已验证的冻结输入；重复调用不再写入通知或增加线程版本。网关事件的命令引用、线程版本与失败状态在同一次提交后可见，页面不依赖定时查询才发现结束。验证见 [B2 记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/b2-r21-verification.md)。

已取消、已完成或已失败的 Run 不复活。失效 authority、版本变化、活动租约、未释放的目录占用、缺少认证回执、控制屏障或其他未释放资源都拒绝收尾。收尾不消耗模型预算，不把未知预算或命令效果改成已知。

### 非沙箱 UNKNOWN 到期

UNKNOWN 表示工具的操作效果无法确认。Pi 发出工具意图，Himawari 将其保存为受保护的 `runtime.tool_intent`。UNKNOWN 令 Pi 循环停止后，Himawari 负责冻结输入、持久 Run 和恢复调度；不重新实现 Pi 的工具协议或 Agent Loop。新增分支只接纳 Run 与 checkpoint 均为 `reconciling_external_result`、checkpoint 原因 `RUNTIME_TOOL_RESULT_UNKNOWN`，且 output 与 terminal 均为空的记录。原沙箱分支的 EXISTS、原 plan 期限及全部认证释放条件保持不变。

`RUN_SANDBOX_RESOURCES_ABSENT_SQL` 从规范 Run 关联读取：没有 `sandbox_execution_records`，没有任何状态的 admission queue，没有任何状态的 deleted plan，没有 legacy pending 资源。无法归属到 Run 的沙箱删除记录保守阻止缺席证明；Run 标识必须符合既有机器标识契约，空值、空白、非文本、非法字符或超过 128 字符均不能作为无资源证据。候选查询与到期事务复用该谓词；事务仍核验当前 authority、旧 Run/checkpoint/lease revision、活动 lease、原输入 ref 和摘要、原期限与既有资源释放条件。Agent 继续解密并验证原受保护输入的版本、来源、摘要和时间范围；当前配置或重启不能延长原期限。

投影的 `readRunInventory()` 在读取资源的同一 SQLite 事务内使用同一缺席谓词，返回内部计算的 `sandboxResourcesAbsent`，不新增持久字段或浏览器字段。投影把该证据纳入原有 inventory 内容 revision 比较，并保留读取前后 Run revision 检查。只有 Run 与 checkpoint 均已 failed、checkpoint 原因是 `RUN_EXECUTION_DEADLINE_EXCEEDED`、output 为空、权威缺席证据为真且没有 pending 资源时，新增分支显示本轮期限失败、不提供 `retry_cleanup`。空显示清单仍是 `allReleased=false`；有底层资源而显示清单缺失时不能使用这个分支。

恢复按 `(created_at,id)` 逐页扫描，每轮先固定已有 Run 的上界，处理期限未到的 UNKNOWN 后继续向后扫描。到达本轮尾部后重新从头开始，后续新增候选不延长当前轮。游标只在内存中保存；重启重新开始。并发 `recover()` 共享正在执行的恢复操作，停止服务会等待该操作。没有新的表、迁移、队列或持久游标。

到期只结束 Run，不改变工具效果：工具仍 unknown，不重跑，不把 UNKNOWN 交给模型，不发布助手回答。标准 failed 回执和通知继续由原事务写入，重复恢复不重复通知或增加线程版本。

## 错误与页面

页面沿用现有原因码文案机制，不改变 v4/v5 布局。工具错误显示“工具执行超时，已终止并完成清理”；Run 期限终点显示“本轮执行期限已到，清理已完成，本轮已结束”。后者通过既有 checkpoint 和共享权威资源核查确认，同时保留命令效果未知的事实。纯非沙箱 UNKNOWN 的主状态显示期限失败，单个工具显示“结果未确认”；没有仍在运行的活动行或清理按钮，不能推断操作已撤销或没有发生。Host 的 `JOB_HOST_EXECUTION_DEADLINE` 仅作私有诊断。

认证、输入或事务检查失败时保留待核查事实，不编造成功、不取消释放证明。`resolve` RPC 的 UNKNOWN 继续与历史样本 13 一起诊断，不以未经确认的因果解释本项。

## 验证

真实产品场景覆盖默认 300 秒工具期限下的 Worker 交付、结束块保存后重启的恢复交付，以及测试夹具配置 90 秒原 Run 期限后的收尾；生产默认 900 秒不变。验证包括页面中文、进程退出、独立 SQLite 读回、签名释放、唯一模型消费、无重跑及不泄露部分输出。

事务拒绝、版本竞争和回滚难以通过浏览器精确调度，使用既有真实 SQLite 测试同时覆盖直接驱动及 Worker 驱动。保留先失败后通过证据，随后执行受影响产品矩阵、完整 check 和 npm test、Runbook 核对及严格文档校验。各次结果、精确复跑命令和未验证范围以[验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te09-verification.md)为准；本文不代替运行结果。

删除计划中的 Run 标识还必须排除 NUL 字符。SQLite 的文本 `length` 与 `GLOB` 在 NUL 处停止，单靠长度和字符范围会把坏定位误当成合法的其他 Run；共享资源谓词先检查 NUL，无法归属的删除记录继续阻止资源缺席证明。Worker/direct 两条真实 SQLite 路径各覆盖末尾 NUL 和中间 NUL。

D3 的组件回归使用真实 pinned Pi 本地确定性 provider、受保护工具意图、真实 SQLite 的 Worker/direct 两条路径、冻结原期限、公开 `ProductionRunDispatcher.recover()` 和真实 `ThreadExecutionProjection`。边界包括期限前、活跃 lease、撤销权威、三个 revision 的竞争、输入 ref/摘要/来源变化、输出或终态已存在、多候选公平性、所有状态的资源义务、真实底层资源但显示清单为空，以及缺席证据在 Trace 读取期间变化。界面沿用现有组件框架。该证据不代替安装主机上的 D3 全链路或外部服务商资格；实际报告和结果归[审计计划](../plans/2026-09-28-tool-execution-audit-plan.md#2026-10-04非沙箱未知结果的到期终点)。
