---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-28"
---

# 工具执行并发缺陷排查与修复计划

## 阅读导航

- [目标与边界](#目标与边界)
- [必须成立的规则](#必须成立的规则)
- [参与者与写入窗口](#参与者与写入窗口)
- [交错组合](#交错组合)
- [缺陷和待验证项](#缺陷和待验证项)
- [验证与交付](#验证与交付)

## 目标与边界

按 `.ci-output/handoff/2026-09-28-codex-tool-execution-brief.md` 系统检查工具执行、停止、释放与结果交付，逐项复现并修复。初始版本为 `fc2b318`，分支为 `claude/isolated-tool-execution`，开始时工作区干净。本文是开放的排查计划，不代表全量验收完成。

来源：[隔离工具执行设计](../specs/2026-09-24-isolated-tool-execution-design.md) [SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md]、[既有实施计划](2026-09-24-isolated-tool-execution-plan.md) [SOURCE: docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md]、[ADR 0033](../../adr/0033-process-sandbox-default-and-optional-containers.md#decision) [SOURCE: docs/adr/0033-process-sandbox-default-and-optional-containers.md]。

固定依赖及安装的 Pi Coding Agent 均为 `0.84.2`；已检查指定上游目录的 `BashOperations.exec` 和本项目 `executeSandboxedPiCodingTool`、`createGovernedPiCodingTools` / `createPiOperationsFromGovernedHostPort`。工具定义和执行仍复用 Pi；数据库资源记录、恢复所有权、释放证明和结果投递由 Himawari 负责。本任务不新建工具协议。

不下载依赖，不操作 Hermes，不修改交接中特别保护的部署证据目录。Claude 已通过第一份回复批准 `/tmp/hma-pp-*` 自动测试隔离安装的服务重启。其他重启仍须批准。需要改变状态所有权、外部合同或持久数据形状时，先交付设计提案供 Claude 审阅。2026-09-28 第二份回复通知部署结束，HEAD 已增加只涉及部署证据的 `20e60b6`；不因此获得 Hermes 操作授权。

## 必须成立的规则

1. 正常完成且清理成功的调用最终释放占用，已知结果可以交付，Run 能结束。
2. 原工具不得因恢复重新执行；同一工具结果在模型对话中的消费最多一次。持久回执的幂等重写不等于重复模型消费。
3. 无释放证明不释放；`lost` 不能直接跳到 `released`；SRT 的 `process_group_gone` 不声称脱离进程组的后代已停止。
4. `unresolved` 后仍能停止本轮；Run 的终点与尚未清理的资源分别保存。
5. 正常退出及清理期间的观察不误取消 Job Host。
6. 核查有期限、终点和当前所有者；迟到证明不能越过期限或覆盖新所有者。
7. Agent/Worker 重启不重放原工具，不丢失已知结果或撤销历史释放。
8. 仅操作结果的版本变化不能被解释成资源失控；但资源身份、序号、恢复所有者变化仍须拒绝旧证明。

## 参与者与写入窗口

| 代号 | 参与者、触发与判断 | 写入及可交错窗口 |
| --- | --- | --- |
| W | Worker 执行结束、控制循环、取消 | `recordCompletion` 写结果及 lost；`afterRecovery` 等 reconciling；RPC 读取与追加之间可被其他写者抢先 |
| C | Agent broker 的 `observe_control` 及控制分类 | 宿主检查、签名观察存储、执行记录追加之间有异步窗口；受控记录遇到正常退出清理会暂缓追加 |
| R | 后台 reconciliation | beginRecovery 登记 owner/revision，追加 reconciling，调用后端及校验证明，追加 released/lost，finishRecovery 终结；每个 await 均可插入写入 |
| S | discovery/scheduling | 读取候选后比较资源序号和 recovery revision；为 stop/inspect 排期，逾期 running 转 unresolved；`unresolved` 通常不再自动尝试 |
| D | 前台结果交付 | lost/reconciling 最多等待 35 秒；核验证据、追加资源观察、prepare/dispatch intent、写回执、ACK，每步之间均可竞争 |
| B | 启动恢复 | reserved 登记中断；bound 先中断恢复再把旧观察转 lost；准入开启前执行，禁止启动原任务 |
| F | 文件结果恢复 | releaseReceipt 后读回已发布文件事实，再写 `recordOperation`；核验与 CAS 之间可能出现 Worker 的迟到结果 |
| X | 停止、撤权、到期 | Run/Handle/Grant 状态改变，调度 stop 或显式 stop 接管 inspect；恢复 revision 隔离迟到写入 |
| H | Job Host | 停止出口和进程组、SRT reset、签名 finish、发送结果、退出；不直接写 SQLite，但改变 C/R 可观察事实 |
| I | intent 和受保护回执 | 与执行记录不同的表及 Payload；prepare/dispatch/ACK、结果回执保存之间可崩溃；数据库派发一次不自动证明模型消费一次 |

另须检查流式输出 `production-sandbox-stream.ts`：它与最终结果证据相关，但不拥有资源释放状态。文件恢复只恢复有专用证据的固定文件操作，不能推断任意 shell 命令的未知效果。

## 交错组合

以下列出每对参与者的检查方向；“已有保护”仅指静态实现/既有测试，不代表本轮重新验证。带“待验证”的条目不能视为通过。每对的先后两种顺序均需考虑，不能把一次正常执行当成所有排列的证明。

| 组合 | 当前结论或判别检查 |
| --- | --- |
| W/C | 已有退出清理保护；observe RPC 在完成之后才返回的窗口待验证 |
| W/R | **confirmed：TE-01**，成功释放与结果写入竞争会变 unresolved；反序有既有迟到结果测试 |
| W/S | 候选 CAS 拒绝旧版本；新完成事实是否唤醒已有 unresolved 待验证 |
| W/D | 结果不可变和 operation revision 提供保护；交付核验中发生结果更新待验证 |
| W/B | 启动恢复保留结果且禁止重放；真实 Worker 重启待验证 |
| W/F | 两方恢复同一结果的 CAS 冲突待验证 |
| W/X | Worker 取消及运行权限重查；停止后迟到结果不得复活 Run，待验证 |
| W/H | result 在子进程 close 后才完成；不是收到 IPC result 就完成。退出前崩溃及输出管道未关闭待验证 |
| W/I | Worker 不负责投递 intent；经过 D 的交错另行检查 |
| C/R | 资源 CAS 与 recovery revision 保护陈旧观察；竞争是否误终结恢复待验证 |
| C/S | 旧候选 CAS 被拒；下一轮发现负责重读，待验证 |
| C/D | fresh verification 与资源追加竞争，待验证 |
| C/B | 新 boot 的 authority 隔离旧 broker；恢复期不开放准入，真实重启待验证 |
| C/F | 文件恢复要求已释放；释放后矛盾证据阻止不安全交付，待验证 |
| C/X | `current(false)` 与授权重查分工，撤权后必须停止而不能继续执行，待验证 |
| C/H | 已有清理 pending 分类；主进程退出前后的所有分类窗口待验证 |
| C/I | intent 派发前检查资源序号；派发后回执幂等需结合模型消费检查 |
| R/S | 恢复 owner/revision CAS；deadline 与 finishRecovery 竞争待验证 |
| R/D | 既有 lost 起点并发测试；进入 verifyFresh 后才启动恢复的反向窗口待验证 |
| R/B | 启动恢复使旧 recovery owner 失效；迟到回调不能释放，已有合同覆盖 |
| R/F | released 后恢复操作结果；finishRecovery 读取最新记录，但读取到写入之间的窗口待验证 |
| R/X | stop 可接管 inspect，revision 隔离旧核查；既有合同覆盖，真实停止收尾待验证 |
| R/H | TE-02 组件级失败已复现；真实 socket 的 pending 分类已有通过测试，真实 SRT 停止链路仍待验证 |
| R/I | 释放与 ACK 分离；释放后不能因 ACK 丢失反锁，已有合同覆盖 |
| S/D | 35 秒是前台等待上限，排期延迟及结束后的恢复消费待验证 |
| S/B | 新 boot 接管 scheduled；unresolved 的再次发现规则待验证 |
| S/F | 文件结果变化不等于资源变化；是否唤醒核查待验证 |
| S/X | stop 是区别于 inspect 的新义务，能唤醒失败的 inspect；失败 stop 的后续证据待验证 |
| S/H | Job Host 不直接唤醒 SQLite 调度；终态到来能否避免旧 unresolved 永久阻塞待验证 |
| S/I | 调度只处理资源；不负责恢复模型消费，待检查调用方 |
| D/B | 启动后原 authority/fence 变化；已派发 intent 的回执重试与新权限组合待验证 |
| D/F | F 返回的新 operation revision 应被 D 使用；竞争失败待验证 |
| D/X | 每个交付阶段检查披露权限；等待循环内取消响应待验证 |
| D/H | 经控制校验间接观察终态；前台等待不构成释放证明 |
| D/I | 数据库 dispatch 返回 applied=false 后仍可重写回执；这不直接证明重复模型消费，待产品路径验证 |
| B/F | 新 boot 文件读回只能补事实、不能重放写入；已有边界，真实重启待验证 |
| B/X | 恢复不依赖原 Grant 重新授权，不能恢复执行权；已有边界 |
| B/H | boot 标识变化与同 boot 签名开始记录分开判断，已有控制证据测试 |
| B/I | 旧 authority 绑定可能阻止新 boot 的交付，待验证 |
| F/X | 文件恢复无执行/披露端口；撤权不应阻止保存已发生事实，待验证 |
| F/H | 固定文件发布证据只在确认释放后恢复；Job Host 崩溃前后待验证 |
| F/I | 回执必须引用最终不可变操作结果；准备 intent 后更新操作版本会被拒绝 |
| X/H | stop 的发送不等于宿主退出；收尾中的重复 stop 及期限待验证 |
| X/I | 未派发 intent 检查授权，已派发仍须核对消费；既有 Run cancellation 测试 |
| H/I | 无直接数据库写者竞争；结果/释放/投递跨进程崩溃窗口仍待验证 |

## 缺陷和待验证项

| 编号 | 状态、现象与根因 | 复现与修复 |
| --- | --- | --- |
| TE-01 | confirmed，已做局部修复：成功释放证明与新结果竞争时，`append` 的 operation revision CAS 失败；reconciliation 将该竞争当成后端失败，转 lost/unresolved，目录继续被占用 | `accepts verified cleanup when operation completion races with %s`；backend-observation 与 proof-verification 两窗口，worker/direct 两模式，共 4 条先失败后通过。日志 `recovery-operation-race-before.log`、`recovery-operation-race-after.log` 均在证据根。仅操作版本变化时，在原期限与所有权内重新核验最新事实。相关回归、静态检查及完整 npm test 已通过，修复提交 `bce20d2`；新增 Mac 产品路径仍待验收 |
| TE-02 | confirmed，组件修复完成：清理 pending 原先被恢复服务当成终点，stop 又将其降为普通 lost；改为明确非终态观察，在原恢复期限内继续检查 | `settles an acknowledged stop whose host finishes cleanup inside the recovery deadline`；证据根下 `cleanup-pending-before.log`。扩展后的 12 条测试覆盖释放、超时、取消、身份错误、过期观察与真正 lost；修改前 2 失败、10 通过，修改后全部通过。真实认证 socket 和 SQLite 等相关回归 349 条通过（`te02-regression.log`）。产品用户路径尚未验收，见[已批准提案](../specs/2026-09-28-sandbox-cleanup-observation-design.md) |
| TE-03 | uncertain：前台先进入 verifyFresh，后台后开始核查/释放，前台使用旧资源序号 | 需 deferred 固定交错，检查结果最终交付与 intent |
| TE-04 | partially confirmed：Run 遇到 `runtime.result_unknown` 后保存 `RUNTIME_TOOL_RESULT_UNKNOWN` 且 output=null。自动恢复仅接受已有最终回答；资源释放不会自动消费工具结果 | 已核对 RunCoordinator、SQLite discovery、Pi 的 capture/restore 工具批次入口。既有测试明确拒绝重启时自动重放未知调用。恢复已知工具结果需要新的持久恢复合同，尚未实施 |
| TE-05 | uncertain：Hermes install 输出成功但最终 host_failure。源码中 finish 在异步清理前停止心跳，可能与 Worker 1.5 秒失联判断冲突 | 第一手本地证据为 `test/qualification/evidence/isolated-tool-execution/p3-hermes-deployment-01/fix-fc2b318/qualification-attempt1.json`；准备对 SRT reset 和 control.finish 做可控延迟测试，不操作 Hermes |

交接中的五个历史缺陷只作为线索；本轮不能把历史通过日志记成本轮验证。关于“后台核查导致所有故障”的说法目前仅 partially confirmed，仍需检查退出、停止及投递各自的窗口。

## 验证与交付

先对 TE-01 做窄集成回归：真实 SQLite 和生产恢复服务，外部后端观察/证明使用夹具，deferred 仅控制异步位置，不替换持久写入或状态投影。浏览器不能可靠把并发写入安排在这两个 await 之间，因此需要该层测试；其通过不能证明真实平台释放。

证据根为 `.ci-output/tool-execution-audit/2026-09-28/`，保留命令、退出码、版本、差异和读回结果。使用现有 Vitest、项目 `npm run check`、`npm test`、完整 E2E 及 `qualification-product-path`；不下载工具，不新建测试系统。

- [x] 阅读交接、当前指令、固定 Pi 入口、设计、ADR 及相关实现，建立写者表。
- [x] TE-01 先失败证据。
- [x] TE-01 局部修复和相关回归：4 条复现通过；原资源身份、期限、恢复所有权等既有回归通过。完整验收另计。
- [ ] 剩余交错与故障注入逐项验证；发现结构问题先审设计。
- [ ] 多工具、停止、重启、期限和重复运行的本机产品 E2E。
- [ ] `npm run check`、`npm test`、全套 E2E、构建及文档校验。
- [ ] Runbook 语义核对、重新封存，按独立缺陷提交。
- [ ] Hermes 经授权后的对应测试；否则明确记录 Linux 未验证。
- [ ] 全部验收完成才归档本计划。

### 当前证据与停点

已完成的运行：

| 命令或范围 | 实际结果与证据 |
| --- | --- |
| `vitest ... -t 'accepts verified cleanup when operation completion races'` | 修改前 4 失败，修改后 4 通过；两个 log 见 TE-01 |
| 三个相关集成文件一起运行 | `recovery-regression.log`：315 通过、9 失败；失败均为 `/bin/ps` 被执行沙箱禁止（spawn EPERM），不是断言不符 |
| `sandbox-control-evidence.test.ts` 在获准的沙箱外环境重跑 | `control-evidence-unsandboxed.log`：72/72 通过。结合上一行，原 324 条相关用例均取得通过证据；期间没有修改控制代码或测试来绕过限制 |
| TE-02 新复现 | 2 失败，实际 unresolved；保留红测试供获批后修复，未跳过、未弱化断言 |
| `npm run check` | `check.log`、`check-final.log`：均通过 |

全部日志位于 `.ci-output/tool-execution-audit/2026-09-28/`。准确命令和源文件摘要见同目录 `evidence.json`。`worker`/`direct` 是现有组件夹具的执行模式，新复现使用真实 SQLite 操作；并不等于真实 Execution Worker 或 SRT 端到端测试。

Claude 第一份回复已批准 TE-02 结构调整；本轮已实施并通过相关 349 条组件回归与 `npm run check`（`te02-check.log`）。第一轮完整 `npm test` 构建通过，但 Claude 同期提交部署记录，HEAD 从 fc2b318 改为 20e60b6，触发 `CI_CONTEXT_MISMATCH:testedSha`，测试执行数为 0；证据保存在 `full-te01-te02/`，不能记为产品测试失败或通过。新基线运行通过：278 个文件、4485 条测试，0 失败、0 跳过；含 E2E 3 条、Pi 兼容性 130 条。完整报告在 `full-te01-te02-head20e60b6/`。TE-01 与 TE-02 使用同一份冻结代码的全量结果；拆分提交时不改变已测试的执行行为。测试输入摘要和补丁为 `te01-te02-tested-source.json` 与 `te01-te02-tested.patch`。

完整任务尚未完成，仍有交错排列、Job Host 故障窗口与 Mac 产品路径新增场景待执行。Hermes 未访问，Linux 真实平台行为未验证。按 Claude 批准的规则，每个独立缺陷在相关检查与完整 npm test 通过后单独提交；TE-01 先提交，TE-02 后提交。
