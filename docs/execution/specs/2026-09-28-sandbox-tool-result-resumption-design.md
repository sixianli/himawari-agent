---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-28"
---

# 已核验工具结果的持久恢复提案

**审阅状态：Claude 已于 2026-09-28 18:05 批准，局部修复与相关回归已通过，完整任务验收仍未完成。** 批准依据为 `.ci-output/handoff/2026-09-28-claude-reply-3.md`。 本提案解决 TE-04：工具结果在前台停止等待之后才得到确认，或服务在结果交付前重启，资源已释放而 Run 仍不能继续的问题。它涉及 Run 调度与 Pi 恢复入口的责任变化，按交接第 5.3 节必须先审阅。

## 阅读导航

- [问题与当前证据](#问题与当前证据)
- [恢复条件与用户行为](#恢复条件与用户行为)
- [数据来源与组件责任](#数据来源与组件责任)
- [接口与执行顺序](#接口与执行顺序)
- [重复取消与崩溃](#重复取消与崩溃)
- [取舍与验收](#取舍与验收)

## 问题与当前证据

来源：[隔离工具执行设计](2026-09-24-isolated-tool-execution-design.md) [SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md]、[本次排查计划](../plans/2026-09-28-tool-execution-audit-plan.md) [SOURCE: docs/execution/plans/2026-09-28-tool-execution-audit-plan.md]。

实施前的代码链路：

1. 前台 `createProductionSandboxToolResult` 最多等待 35 秒；恢复 unresolved 时返回未知，到期抛出 `SANDBOX_RECOVERY_UNSETTLED`。
2. Pi adapter 将未知工具结果变成 `runtime.result_unknown`，停止本次模型循环。RunCoordinator 保存 `RUNTIME_TOOL_RESULT_UNKNOWN`，清空最终回答引用，Run 留在 `reconciling_external_result`。
3. `RUN_COMPLETION_RECOVERY_SQL` 和 `RunCoordinator.recoverCompleted` 只接受已经存在最终回答的恢复。因此资源后来释放，也不会让模型收到尚未消费的工具结果。
4. 已有 `QUEUED_TOOL_BATCH_SQL` 只恢复还没有准入的排队工具，明确排除已存在执行记录的调用，不能用于已完成工具。

以上问题由实施前代码和既有 `run-coordinator.test.ts` 的未知结果重启及拒绝 completion recovery 测试支持。前者明确验证重启不会再次调用 runtime。这是保护未知副作用的正确规则；缺口是没有单独接纳“后来已有确定结果和释放证明”的路径。尚无本机浏览器的完整迟到结果恢复成功证据，本提案不把静态证据说成产品验收。

现有可复用数据已经存在：`ProductionRuntimeTools` 在派发前保存受保护的 `runtime-tool-intent`，包含原 request，以及 `tool-batch-recovery.v1` 的 `continuationRef` 与 `toolCallId`。Pi 的 `capturePiToolBatch` 保存冻结批次，`restorePiToolBatch` 可以恢复此前已完成的结果与模型调用序号。无需重新实现 Pi 会话或工具协议。

## 恢复条件与用户行为

同一轮对话仍有效、未取消且未超过原 Run 期限时，后台确认以下所有条件，才允许继续原模型循环：

- 原 foreground 调用有不可变的确定结果；`unknown`、后台任务启动句柄、任意命令的未知效果不据此推断成功。
- 原资源有已认证的永久释放回执，没有新风险、占用或 barrier。
- 受保护的原派发意图、执行身份、输入、语义指纹、冻结 Pi 批次和等待中的 toolCallId 一致。
- 当前执行权、Run 租约、模型披露策略、原结果的数据分类均允许恢复；没有待核对的模型费用或已取消的决定。

满足时，模型接收原工具的已知结果，原工具不再启动。后续模型调用和批次中尚未执行的工具继续经过现有预算、期限与授权检查。任一条件不满足时，保留当前未知状态及停止本轮的出路；不能重新授权原工具来清除未知。

35 秒前台等待、30 秒资源核查和原 Run 总期限均保持不变。过期的 Run 不因恢复得到新的执行时间。没有完整恢复凭据的旧记录不自动升级成可恢复状态。

## 数据来源与组件责任

| 组件 | 责任与限制 |
| --- | --- |
| SQLite Run discovery | 从未知 Run 和已释放、已有结果的 foreground 记录中列出有界候选；不解密 Payload，不决定披露，也不派发工具 |
| Agent 恢复准备 | 读取原 invocation 对应的受保护 `runtime-tool-intent` 和冻结 continuation，核对完整关系；缺失、替换、多个不一致的等待调用均拒绝 |
| 现有 Run 租约 | 仍是唯一恢复执行所有者；领取时事务内重查 Run/checkpoint revision、原 job 的 operation revision、resource sequence、释放/风险及模型费用条件 |
| RunCoordinator | 增加只用于已确认工具结果的恢复入口，区别于已完成回答交付；接受经过核对的原 continuation，不重新构造用户输入 |
| Pi adapter | 复用 `restorePiToolBatch` 和原 stream ordinal。恢复中的等待调用只读取既有已核验结果，不能走到 Worker dispatch；之前已完成的工具结果沿用冻结批次 |
| ProductionRuntimeTools | 为这个等待调用提供只交付既有结果的入口；查不到确定结果、身份变化或无权限时停止恢复，禁止退回执行入口 |
| 资源核查 | 继续只负责资源观察和释放，不获得模型调用或工具启动端口 |

优先使用现有受保护派发意图、执行记录、checkpoint revision 和 Run 租约，不新增数据库状态、表或第二套任务队列。候选发现与真正恢复分开：应用层读取受保护凭据后，数据库仍对公开可验证的身份和版本做事务检查。如果实施证明现有持久字段不足以可靠区分恢复身份，必须先补充具体数据变更提案，不能自行添加迁移或降低核对要求。

## 接口与执行顺序

内部恢复准备结果至少绑定这些字段：

```ts
interface SandboxToolResultResumption {
  runId: string;
  jobId: string;
  invocationId: string;
  toolCallId: string;
  continuationRef: string;
  semanticFingerprint: string;
  checkpointRevision: number;
  operationRevision: number;
  resourceSequence: number;
}
```

这些值由 Agent 从持久记录交叉核对后生成，不能来自模型参数或网页提交。现有 discovery/dispatcher 新增 `resume_tool_result` 分支；现有 `deliver_completed` 继续只交付最终回答。

执行顺序为：有界发现候选 → 验证原恢复凭据 → 用现有 Run 租约领取且复核版本 → 重新核验结果与披露 → 恢复冻结 Pi 批次 → 等待调用仅返回原结果 → 后续模型调用沿用既有费用记录 → 通过原 Run 完成事务保存回答。

不把资源释放回执当作结果已被模型消费的回执。工具结果 intent 仍使用原确定性 ID；Pi 中同一 toolCallId 只注入一次，重复写入同一受保护交付回执不计作新执行。

## 重复取消与崩溃

- 两个发现者同时观察到候选：只有当前 Run 租约和 checkpoint revision 的赢家继续；输家重读，不形成第二个模型循环。
- 领取之前取消、撤权或过期：不领取；领取之后发生这些变化：既有披露与执行权检查中止恢复，不能让迟到结果覆盖 cancelled。
- 恢复前或交付回执之后重启：重新使用同一冻结批次与不可变结果，禁止启动原工具；原回执按确定性 ID 幂等读取或写入。
- 模型请求已经发出但费用/完成结果未知时重启：保留现有待核对保护，不承诺无法证明的模型请求恰好一次，也不自动重发未知的付费请求。
- 文件结果恢复与 Worker 迟到结果竞争：以 journal 的不可变事实和版本为准；恢复准备失败后重读，不能覆盖已确认结果。
- 控制证据出现新矛盾：停止交付，保留风险；过去的释放回执仍保留，但不覆盖当前风险。

## 取舍与验收

延长前台等待只能减少触发概率，不能处理进程重启，因此不采用。对所有未知 Run 重新调用 runtime 会重复未知副作用，也不采用。推荐上述“只恢复已经核验的工具结果”入口；代价是 Run discovery、租约领取、Coordinator 和 Pi 恢复适配需要联合回归。

批准后的第一步是测试先行：在真实 SQLite + 生产 dispatcher/coordinator 中，先得到未知 checkpoint，再独立保存确定工具结果与释放证明，验证同一 Run 自动成为可恢复候选且最终完成；现状应失败。随后覆盖取消、期限、旧权限、缺失/篡改 continuation、多候选、重复领取以及模型请求不明。

Mac 产品路径验收使用现有隔离安装与脚本模型：同轮多个工具、工具运行及收尾时停止/重启、35 秒等待结束后才取得释放、原执行期限到达、同一动作重复至少 30 次。通过页面行为、独立 SQLite 读回、原工具实际启动次数、每个模型请求内 toolCallId 的唯一性共同断言。已有授权只允许重启测试自己创建的 `/tmp/hma-pp-*` 安装；Hermes 仍须另行批准。

完成后运行相关回归、`npm run check`、完整 `npm test` 与新增 Mac 产品 E2E，核对受影响手册并单独提交。未通过上述验收前，不宣称 TE-04 或整个系统排查完成。

### 实施前的失败模式与验证边界

先验证真实 SQLite 候选发现：未知 Run 的原调用在确定结果和释放回执都存在后成为专用恢复候选；结果仍未知、没有释放、存在新风险、取消、过期、恢复意图或 Pi 快照缺失时不得执行恢复。领取时重查版本和模型费用，两个恢复者只能有一个成功。生产 Coordinator/Pi 联合测试再验证原工具派发计数不增加、原 stream ordinal 继续、已完成工具结果不重复消费。测试不得把恢复自身替换为假实现；外部模型与宿主观察可以受控。

恢复结果的披露不能调用旧执行凭证重新派发：现有 receipt 精确绑定 Agent/Worker boot，重启后的当前执行权与它不同。需要独立核对原持久身份与当前披露权限，保持原凭证不可重绑定的规则。此项属于已批准的只交付入口，不降低原工具启动检查。

### 本次实施验证结果

已实现上述专用结果恢复入口，复用 Pi 冻结批次和原 stream ordinal，不重新派发原工具，不增加数据库表、状态、迁移或期限。真实 Mac 读取、写入在持久结果 intent 后崩溃并重启均恢复完成；独立数据库读回确认原作业与交付记录各一条，实际写入文件在重启前后保持预期内容。最终重新构建及完整 npm test 的 4574 条测试通过，静态检查、四份 Runbook 封存检查与严格文档校验通过。

证据及准确命令见 `.ci-output/tool-execution-audit/2026-09-28/te04-verification.md`。35 秒后才释放的真实产品场景、工具运行中停止/重启、原期限与 finish 各步崩溃，以及未筛选完整 Mac 产品资格仍属于[排查计划](../plans/2026-09-28-tool-execution-audit-plan.md#验证与交付)的待验收项；本次局部修复提交不表示这些项已完成。
