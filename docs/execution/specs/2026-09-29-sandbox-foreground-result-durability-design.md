---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-29"
---

# 前台工具输出复用加密分块保存设计

**审阅状态：方案 B 已批准。用户于 2026-09-29 批准。** 本设计依据 Claude 的 [round2 reply-3](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-3.md)，补充而不替换已提交的 `77fb033` 结果丢失兜底。批准不等于实现完成：当前按 [reply-4](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-4.md) 的修订合同实施，恢复单位与离线就绪边界按 [reply-5](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-5.md) 和 [reply-6](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-6.md) 执行；验证完成前不视为交付。

## 阅读导航

- [审阅决定与理由](#审阅决定与理由)
- [目标与既有边界](#目标与既有边界)
- [提前退出事实与清理事实](#提前退出事实与清理事实)
- [前台加密分块保存](#前台加密分块保存)
- [恢复裁决与事务](#恢复裁决与事务)
- [失败与竞争规则](#失败与竞争规则)
- [成对重启与离线就绪边界](#成对重启与离线就绪边界)
- [剩余保证窗口](#剩余保证窗口)
- [验收要求](#验收要求)
- [考虑过但不采用的分块输出描述](#考虑过但不采用的分块输出描述)

## 审阅决定与理由

采用方案 B：Job Host 在清理前报告正常任务退出，Worker 沿用已有 `append_output` 通道，把前台 stdout 交由 Agent 的既有 Payload 保护器加密保存。正常提交仍保存原始 stdout Payload，分块副本只用于恢复；没有完整结束块时，满足条件才写 `SANDBOX_TOOL_RESULT_LOST`。

方案 A（宿主加密封存文件）已经考虑，但不采用：需要新的加密文件格式和密钥派生；每次工具调用额外加密写文件和 fsync，在 Hermes 机械盘上代价较高；相较方案 B，多覆盖的是任务结束时 Agent 不可用、之后 Worker 也退出的罕见双重故障。这里的代价和故障频率是审阅取舍，不是本次 Linux 性能实测结果。方案 A 的结果裁决顺序、竞争约束和原内容验收方法已吸收进本设计。

[BL-20260929-001](../../backlog/BL-20260929-001-前-台-工-具-输-出-的-宿.md) 按治理流程关闭，原因是“被 2026-09-29 批准的方案 B 取代”。关闭未来宿主加密待办不表示方案 B 已完成。[SOURCE: docs/backlog/BL-20260929-001-前-台-工-具-输-出-的-宿.md]

## 目标与既有边界

任务已经退出、完整输出结束块已经由 Agent 保存后，即使 Worker 或 Agent 加 Worker 在宿主清理期间退出，恢复也应交付同一次调用的原字节，不重新读文件、不重新运行工具、不撤销已接受释放。

沿用[隔离工具执行设计](2026-09-24-isolated-tool-execution-design.md)、[ADR 0033 的进程释放边界](../../adr/0033-process-sandbox-default-and-optional-containers.md)和[已核验结果续接合同](2026-09-28-sandbox-tool-result-resumption-design.md)。[SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md] [SOURCE: docs/adr/0033-process-sandbox-default-and-optional-containers.md] [SOURCE: docs/execution/specs/2026-09-28-sandbox-tool-result-resumption-design.md]

Pi 固定版本为 `0.84.2`，继续提供 read、其他工具及原工具批次 capture/restore。Himawari 负责输出保护、执行身份、原子事实接纳、资源释放与交付权限。无需修改只读 Pi 源码、复制工具协议或重新执行原调用。

本次批准针对本机 SRT 前台路径。不新增表、迁移、Run 状态、常驻队列、加密方式或密钥，不延长期限，不下载依赖。后台游标与页面资源含义继续成立。

## 提前退出事实与清理事实

任务正常退出且 stdout/stderr 已关闭时，在进入 `finish()` 之前发送新的 IPC 消息，报告 `exitCode` 和 stdio 已关闭事实。消息与输出使用原私有 IPC 顺序；Worker 获得“任务已完成”的信号，不再为保存结果而等待宿主 `close`。

原 `result` IPC 仍在进程组停止、SRT reset、`control.finish()` 之后发送，负责最终清理事实。任务退出与资源释放分别核验。两条消息矛盾时按失败处理，不能选择较好的结果。取消、期限和输出超限路径可以继续使用原路径，不必发送提前完成消息。

按 [reply-7](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-7.md)，已收到最终 IPC 且与提前完成事实矛盾时，保存确定的 `SANDBOX_HOST_COMPLETION_CONTRADICTED` 错误，禁止恢复导入覆盖。交付时不携带原 stdout 引用，而给模型唯一说明：“SANDBOX_HOST_COMPLETION_CONTRADICTED：执行宿主报告的退出结果前后不一致，本次结果按失败处理，没有重新执行。工具可能已经运行，是否重做请先确认。”原 stdout Payload 与分块保留作诊断，不改写或删除。没有最终 IPC 的真实宿主崩溃不算矛盾，仍可核验并恢复完整结束块。命令与写入的效果披露限制不变，矛盾错误不能证明没有副作用。

已认证终态文件的时间在 `control.finish()` 后固定；只要宿主仍存在，就按 `cleanup_pending` 等待原恢复期限内的退出，不再将该终态时间当作活动心跳的新鲜度。pending 返回的观察时间记录本次核验时间，签名文件内的历史时间保持原值；恢复服务仍检查 pending 的新鲜度、身份和资源序号。运行中观察的心跳要求不变；释放仍需核验宿主和原进程组已消失。

## 前台加密分块保存

前台复用既有 250 毫秒循环和 `append_output`，由 Agent 使用现有保护器和密钥保存不可变的连续分块。保存键绑定原执行身份，不给前台资源观察设置 `resourceRef`，不产生可供模型控制的后台资源句柄。

只保存正常前台原本保存的 stdout；不把基础设施 stderr 混入模型结果。收到提前完成信号后，立即保存剩余 stdout 和带 `termination` 的结束块，包括退出码、结束原因及 `taskProcessExited`，然后等待宿主清理。

Claude 在 reply-4 撤回“只存一份”优化：原前提不成立，后台 operation 引用的是“任务已启动”的回执，并非 stdout。证据见[stop-3](../../../.ci-output/handoff/2026-09-28-codex-round2-stop-3.md)。正常 Worker 继续调用现有 `writeOutput()` 保存原始 stdout Payload，operation 引用方式不变。每次前台调用因此额外保存一份加密分块副本，并增加本机 RPC；成本必须纳入性能和存储报告。分块正文是 Base64 JSON，另有每块加密元数据；沿用的结束 artifact 还会重复保存最后一个 chunk 的 JSON，末块正文最多 32 KiB，因此不能把额外磁盘字节等同于一份原 stdout 的大小。现有分块键已按身份生成，后台读取游标及页面合同不变。

## 恢复裁决与事务

恢复严格按以下顺序进行：

1. 已有确定 operation：直接使用，不覆盖。
2. 有完整、已保存的结束块：核对原身份、分块连续性、摘要、长度及退出事实，认证导入原结果。
3. 适用既有固定文件恢复：核验原发布证据，不重读 read 的目标或重跑 bash。
4. 没有可恢复原结果，且满足原 LOST 条件：通过 operation revision 比较写入结果丢失错误。
5. 证据不明：不伪造结果，继续既有有限恢复、原期限和停止路径。

LOST 要求已接受的释放证明、已认证任务启动并退出、缺少确定结果，以及原 Worker 尝试已确定不能再提交。合法 LOST 一旦写入，后来发现原输出也不能覆盖或再次交付，只能保留诊断证据。

导入是 Agent 内部的受限事实写入，不放宽 Worker Payload Broker。原执行身份用于确定结果归属，当前 Agent 权限用于确认现在是否允许登记事实；两者分别验证。恢复在 Agent 内部从连续分块重组原 stdout，用普通 Payload 表示保存，归属键仍为 `capabilityInvocationOutputOperationKey(invocationId)`。分类来自核验后的冻结调用回执；前台合同沿用正常路径的 `application/octet-stream`，不接受 Worker 或分块自称的分类/类型。原 Worker 已保存 Payload 而尚未写 operation 时，核对摘要、长度、类型和分类后复用。加解密在事务外完成；普通输出 Payload 引用接纳与 operation CAS 必须在同一个 SQLite 事务中完成，并在事务内重查当前权限、原身份、operation revision、resource sequence 和已有结果。冲突后重读，不能换新 revision 强行覆盖赢家。

候选查询有界，筛选本机前台、已释放且缺少确定结果的记录，复用现有 Agent 后台循环。导入不等于允许交付；原 Run、取消、期限、披露权限、预算、冻结 continuation 和唯一交付 intent 继续检查。固定文件效果仍须通过既有 `verifyPiWriteEvidence()` 等核验。

## 失败与竞争规则

| 情况 | 必须保持的结果 |
| --- | --- |
| 完整结束块后 Worker 或 Agent 加 Worker 退出 | 恢复原结果，不重跑；资源未认证释放前不交付 |
| 部分输出、缺少结束块或保存失败 | 不把前缀当完整成功结果；满足独立 LOST 条件才兜底 |
| 存储或解密暂时不可用 | 不把读取失败解释为结果不存在，保留证据并受原期限限制 |
| 原 Worker 迟到提交、导入器、LOST 竞争 | 共用不可变结果及 CAS；原尝试失效时拒绝旧写者，最多一个确定结果 |
| 两个恢复者并发 | 只有一个有效接纳；等价重读不造成第二次交付 |
| 取消、过期、撤权 | 不复活 Run，不补交禁止披露的内容 |
| 分块断裂、摘要或长度错误、跨 job/attempt | 拒绝导入，不用坏证据补足成功或释放事实 |
| 超限或非正常退出 | 不把保存前缀当完整成功结果；保留原停止和清理约束 |
| 普通命令已产生效果 | 仍按原效果合同处理，不从结果恢复推断副作用被回滚 |
| LOST 合法写入后发现原输出 | 不覆盖、不重复交付，保留诊断 |

## 成对重启与离线就绪边界

产品支持的恢复单位是 Agent 与 Worker 成对重启。生产启动脚本在任一子进程退出后先停止 Agent，再停止尚存活的 Worker，随后由服务管理器重启整对进程；重启后的新 fence 使原 Worker 失去提交权。不新增同一 Agent boot 内的单次尝试失效决定，不放宽 LOST 的原权限代次检查。正常关停保存的 `SERVICE_STOPPING` 检查点也须进入原工具结果恢复入口；仍核对原批次、原调用、资源释放、当前权限和原期限，不重新执行工具。

**Worker 单独退出而 Agent 继续运行时，服务整体不可用，页面也不能停止本轮；需要成对重启服务。生产启动器在任一进程退出时会自动成对重启。将来的 Mac 常驻启动器必须保持同样的合同。** 本轮不实现 Mac 启动器，也未执行 Hermes 现场验证。

不受支持的单进程存活状态仍须保持结果安全：已保存结束块的结果可由 Agent 后台导入；没有结束块时不得抢先写 LOST。业务 HTTP 保留 `SERVICE_NOT_READY`，包括页面停止所需的前置 Payload 请求。已知限制的真实点击失败、trace 和 SQLite 证据见 [stop-5](../../../.ci-output/handoff/2026-09-28-codex-round2-stop-5.md)；reply-6 接受该限制，它不是本次要修复的 TE-08 缺陷。成对恢复后再核对唯一原结果或 LOST 和页面显示。

## 剩余保证窗口

以下两种情况在成对重启后，仍由满足条件的 LOST 兜底明确结束：

- 任务退出后、结束块保存完成前，Worker 退出。
- 任务退出时 Agent 不可用，之后 Worker 也退出。

本设计目标是服务进程重启恢复；未验证突然断电、整机重启或磁盘损坏后的绝对耐久性。加密输出与恢复证据继续遵守既有保留规则，不能为腾空间删除未导入结果或失败现场。

## 验收要求

先写测试并确认目标缺口，再修改生产代码。证据保留在[第二轮审计目录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/README.md)，实施进度由[排查计划](../plans/2026-09-28-tool-execution-audit-plan.md)记录。[SOURCE: docs/execution/plans/2026-09-28-tool-execution-audit-plan.md]

- 真实 Pi read 读取唯一内容，清理挂起后终止 Agent 加 Worker，修改源文件再重启。模型恰好收到一次修改前原内容；独立 SQLite 读回确认一次启动、一条确定 operation、一条交付 intent、释放未撤销、Run 完成。不重启对照也保留原结果。
- 在结束块保存前后、reset 后、control.finish 前后、result IPC 前后，分别先杀 Worker 并按生产启动器顺序停止 Agent，或同时终止 Agent 加 Worker；然后成对重启。已保存结束块时恢复原结果；未保存时按兜底规则结束，不重复交付、不卡住。额外验证短暂 Worker 离线时业务 HTTP 拒绝服务、Run 不误终结或交付，成对重启后以唯一 LOST 完成。
- 真实 SQLite 验证 Worker、恢复导入、LOST 任意先后和两个恢复者并发；负向覆盖分块不连续、结束块缺失、摘要或长度不符、跨 job/attempt、取消、过期、撤权。
- 矛盾 IPC 用例核对模型正文只含一次指定错误说明，不含原文件内容或 `isError:false`；成对重启后错误不被覆盖且工具不重跑。以没有最终 IPC 的真实宿主崩溃恢复原输出作为对照。
- 沿用 TE-06 交替测量，改前改后各 30 个成功样本，中位耗时增量不超过 100 毫秒。超过门槛写停止文件，不能减少保存或同步来达标。
- 完成相关测试、完整 `npm run check`、完整 `npm test` 和最终无筛选 Mac 产品资格；检查文档并重新封存受影响 Runbook。Linux/Hermes 是否执行由 Claude 决定。

## 考虑过但不采用的分块输出描述

stop-3 核实：stream artifact 的正文是包含块索引、偏移、Base64 正文及终态的 JSON，不是完整原始 stdout。结束块还可以是空块；直接把它的引用交给现有结果读取端，会被摘要/长度核验拒绝。真实 SQLite characterization 保留在 `test/integration/sandbox-output-pages.test.ts`，用来防止再次混淆这两种表示。

曾建议增加版本化分块输出描述及显式输出来源，由读取端有界重组。Claude 在 reply-4 不批准：该方案要修改所有读取点和分类语义，而方案 B 的恢复目标不需要这些改变。

因此既有 `verifyOutput()`、正常 `#observedOutput()`、恢复 `readOutput()`、SQLite 普通输出摘要核验与效果验证消费者均不改。只有 Agent 恢复导入阶段重组分块并接纳普通 Payload；不新增输出表示、不降低普通读取端的分类或完整性检查。

reply-7 另批准两处失败交付选择：矛盾错误返回空输出引用，以及无输出失败分支提供指定正文。这两处不参与读取或核验输出，不改变上述消费者合同。
