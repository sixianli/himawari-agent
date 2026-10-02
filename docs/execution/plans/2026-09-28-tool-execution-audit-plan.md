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
- [reply-33：Job Host 加载期间的启动监督](#reply-33job-host-加载期间的启动监督)
- [reply-34：MCP 测试夹具的准备成本](#reply-34mcp-测试夹具的准备成本)
- [reply-34：Job Host 返工与取证边界](#reply-34job-host-返工与取证边界)
- [reply-46：准备与心跳计时取证](#2026-10-02-reply-46准备与心跳计时取证)
- [reply-47：D17 夹具前缀与短临时根](#2026-10-02-reply-47d17-夹具前缀与短临时根)
- [D21：期限后交付测试的受控计时器](#d21-期限后交付测试的受控计时器)

## 目标与边界

2026-09-29 R1/B3/B6 批次：依据 [ADR 0033 决定第 2、5 条](../../adr/0033-process-sandbox-default-and-optional-containers.md#decision)，修正 Mac 资源观察器把脱离进程组本身判为 `host_failure` 的旧策略；只移除该分支及无用标记，保留资源上限、采样失败、PID 身份、期限和释放证明。先红后绿及测试层级见 [R1 验证](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r1-verification.md)。B3 已在真实 Mac 确认更内层 Bash 等待继承管道的问题；按 [ADR 0040](../../adr/0040-background-output-closed-after-bash-returns.md#decision) 和 reply-27 改为主进程退出后输出连续安静 100ms 正常返回，保留已读输出与退出码；返回时关闭读端，说明明确晚写原通道可能使后台退出并建议重定向到文件，不实现 SANDBOX_OUTPUT_INCOMPLETE。说明不占命令字节额度，但计入整份结果上限，超限沿用 PI_RESULT_OUTPUT_LIMIT，不另设或放宽额度。测试先行、Pi 复用边界及真实 Mac 验收见 [B3 验证](../../../.ci-output/tool-execution-audit/2026-09-28/round2/b3-r27-verification.md)。现有后台列表不能列出前台 Bash 自行脱离进程组的后代，按裁定留为待办；本批只核对释放后的“停止未经严格确认”。本批不含 Linux/Hermes 或无筛选资格。

按 `.ci-output/handoff/2026-09-28-codex-tool-execution-brief.md` 系统检查工具执行、停止、释放与结果交付，逐项复现并修复。初始版本为 `fc2b318`，分支为 `claude/isolated-tool-execution`，开始时工作区干净。本文是开放的排查计划，不代表全量验收完成。第一轮 TE-01 至 TE-06 的局部修复已完成，历史结果见[第五份回复后的诊断与测量](#第五份回复后的诊断与测量)。第二轮按新交接继续：TE-07 已提交；收尾阶段重启发现 TE-08；Claude 已拒绝宿主保存完整输出的提案，批准在原尝试失效且有签名退出和释放证明时写入 `SANDBOX_TOOL_RESULT_LOST` 并唯一交付。已按[前台输出恢复设计](../specs/2026-09-29-sandbox-foreground-result-durability-design.md)完成本地修复验证，提交与报告见[TE-08 交付记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te08-delivery.json)。LOST 提交 `77fb033` 保留；用户于 2026-09-29 追加批准方案 B，前台复用既有加密分块，恢复时导入普通 Payload。reply-4 撤回单副本优化，reply-5/6 明确成对重启及 Worker 离线时业务 HTTP 不可用的合同。方案 B 已通过本机定向验证和全量测试，提交记录见[方案 B 交付记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te08-b-delivery.json)；reply-7 的矛盾失败正文已通过真实回归，终态 pending 时间修复已通过组件测试，上一轮成对重启矩阵因主机名不一致的状态目录锁中止；[reply-8](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-8.md) 已将其裁定为环境启动阻塞，允许新隔离安装继续，并要求记录每次启动的主机名与锁身份。旧锁接管风险记录为独立 Backlog，待方案 B 后单独提交。reply-8 后 B7 的 22 项完整定向矩阵全部通过，包含真实 before-result 两种重启和六个宿主崩溃位置；48 条启动身份记录没有主机名变化或启动失败。原30对30性能增量288ms超门槛后已按 stop-8 停止；[reply-9](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-9.md) 批准先清理运行时副本再拆分诊断。10对10详细探针中位增量15.5ms，清理环境后原探针正式30对30为7976→7954.5ms，增量−21.5ms，满足100ms门槛。生产代码未改，原超标的具体原因仍不确定，全部测量及限制见[性能诊断](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te08-b-r9-performance-analysis.md)。完整 check 与第二次完整 npm test（4697项、零失败/跳过）已通过，四份Runbook已核对并显式封存；历史失败和当前进展见[第二轮证据](../../../.ci-output/tool-execution-audit/2026-09-28/round2/README.md)。完整审计尚未完成。

来源：[隔离工具执行设计](../specs/2026-09-24-isolated-tool-execution-design.md) [SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md]、[既有实施计划](2026-09-24-isolated-tool-execution-plan.md) [SOURCE: docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md]、[ADR 0033](../../adr/0033-process-sandbox-default-and-optional-containers.md#decision) [SOURCE: docs/adr/0033-process-sandbox-default-and-optional-containers.md]。

固定依赖及安装的 Pi Coding Agent 均为 `0.84.2`；已检查指定上游目录的 `BashOperations.exec` 和本项目 `executeSandboxedPiCodingTool`、`createGovernedPiCodingTools` / `createPiOperationsFromGovernedHostPort`。工具定义和执行仍复用 Pi；数据库资源记录、恢复所有权、释放证明和结果投递由 Himawari 负责。本任务不新建工具协议。

不下载依赖，不操作 Hermes，不修改交接中特别保护的部署证据目录。Claude 已通过第一份回复批准 `/tmp/hma-pp-*` 自动测试隔离安装的服务重启。其他重启仍须批准。需要改变状态所有权、外部合同或持久数据形状时，先交付设计提案供 Claude 审阅。2026-09-28 第二份回复通知部署结束，HEAD 已增加只涉及部署证据的 `20e60b6`；不因此获得 Hermes 操作授权。

2026-09-29 reply-26 将旧程序执行器丢失末尾输出记为 B6，并入 R1/B3 批次。`runSandboxedProcess()` 不再把主进程 exit 直接当作输出收集完成；统一使用 platform-node 内部等待函数，读取到输出流结束，或主进程退出后连续安静 100ms。新输出重新计时，期限、取消和输出上限在等待期间继续有效；结构化字节结果不追加说明。真实同组后代延迟输出连续三次红测试及后续验证见 [B6 验证](../../../.ci-output/tool-execution-audit/2026-09-28/round2/b6-r26-verification.md)。B6 已独立提交 06cf5b5 并由 reply-27 审核通过；B3 共用该等待函数。晚到输出导致退出、说明导致整份结果超限的实测已由 ADR 0040 接受；新回归同时要求重定向到文件的后台程序在调用返回后继续写入且仍存活。最终第 3、4 层结果由 B3 验证记录给出，未执行前不声称批次完成。

2026-10-02 reply-49 登记 R2-D20：云端完整验证中的 B6 期限测试已收到父进程退出后的 3 行输出，且期限分类正确，却因固定“大于 64 字节”断言失败。测试夹具改用 `/bin/sh`，同步旁路文件只在父进程退出后、每次 stdout 写入之后计数；断言要求至少有一行被确认写出，收到的行数等于计数或比计数多 1（终止发生在两次写之间），并核对完整输出内容。保留子进程启动延迟 500ms 的 `[R2-D20]` 回归，为父进程退出后到 1000ms 期限之间留出约 0.4 秒余量；原 1000ms 产品期限、退出码 7、期限分类、输出上限、取消和 tail 合同保持。可控延迟下旧断言先以 `expected 49 to be greater than 64` 失败，新的逐行核对与后续第 0–3 层原始报告见 [R2-D20 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r49-verification.md)。这项测试修正不改变 B6 产品实现；整轮完成与否仍由长任务证据计算。

## 必须成立的规则

1. 正常完成且清理成功的调用最终释放占用，已知结果可以交付，Run 能结束。
2. 原工具不得因恢复重新执行；同一工具结果在模型对话中的消费最多一次。持久回执的幂等重写不等于重复模型消费。
3. 无释放证明不释放；`lost` 不能直接跳到 `released`；SRT 的 `process_group_gone` 不声称脱离进程组的后代已停止。
4. 服务就绪时，`unresolved` 后仍能停止本轮；Run 的终点与尚未清理的资源分别保存。Worker 离线、Agent 单独存活时，业务 HTTP（包括页面停止）不可用，必须成对重启，见[成对重启与离线边界](../specs/2026-09-29-sandbox-foreground-result-durability-design.md#成对重启与离线就绪边界)。
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

2026-09-29 已逐对核对 45 个组合，并补充控制观察、候选排期、文件结果恢复、恢复事务收尾与前台交付的可控竞争测试。完整的正反顺序、测试名、证据范围及限制见[45 对写者审计](../../../.ci-output/tool-execution-audit/2026-09-28/round2/writers-matrix.md)。这里的“已有保护”指该报告列出的实现和测试，不代表穷举所有调度排列；真实 Mac 产品资格另计。

| 组合 | 当前结论 |
| --- | --- |
| W/C | 已有保护。W 的完成在 authority 检查中到达时跳过运行观察（W `finished-during-check`）；观察先进入、结果后持久化时，旧观察不能覆盖结果（C 新增 `in-flight ... result`）。 |
| W/R | 已修复 TE-01。后端观察和 proof 核验中插入结果写入均保持已知结果并释放（SQL `accepts verified cleanup ...`）；释放先到则允许补操作事实（SQL `stores late operation evidence ...`）。 |
| W/S | 已有保护，职责分开。S 不会因单纯操作版本变化重新启动原任务；资源未释放且 unresolved 时不会无限自动重试。 |
| W/D | 已有保护。结果先保存正常交付；D 在恢复中被结果抢先时捕获操作 CAS 冲突，重读唯一结果，只存一次回执（D 两顺序）。 |
| W/B | 已修复 TE-08，已有启动隔离。B 保留已知输出但不重放；原结果未落盘的边界由加密分块恢复或合法 LOST 判定处理。 |
| W/F | 已有保护。F 新增在读回前、写结果前插入第二个恢复写者：相同事实幂等，不同事实旧写者冲突；获胜记录、releaseReceipt 不变。 |
| W/X | 已修复 TE-07/09。M 运行中停止后宿主/进程组退出、Run 取消、无模型交付；工具期限和 Run 期限分别收尾。 |
| W/H | 已修复 TE-05/08/09 的既有窗口；TE-10 可控测试确认管道未关闭仍被标为成功，现已加入明确关闭检查并通过原复现。完整check和4855项npm test通过，独立提交见TE-10交付记录；最终无筛选资格仍待执行。 |
| W/I | 无直接写者竞争，经过 D。W 不派发 intent；先保存结果再派发；I 先持久化后 Worker 迟到不能改已知事实。 |
| C/R | 已有 CAS/owner 保护。C 新增观察挂起后释放抢先，旧观察被拒且释放不回滚；反序由 SQL resource sequence 与 recovery owner/revision 校验拒绝旧恢复证明。 |
| C/S | 已有保护。S 新增 observation-first/schedule-first 两顺序：陈旧候选或陈旧 beginRecovery 拒绝，重读才排期；资源事实不倒退、attempt 不额外增长。 |
| C/D | 已修复 TE-03，已有披露保护。D 核验期间资源序号改变会重读；C 先接受的矛盾资源证据形成阻断（SQL `protects fresh contradictory ...`），不因已释放而忽略风险；intent 先派发不等于取消后还能消费。 |
| C/B | 已有启动 authority 隔离。旧 boot 不能继承执行/输出权；C `new authenticated Worker reconciles old jobs ...`；SQL startup；M services 重启后用新 fence 恢复，原工具启动数不增加。 |
| C/F | 已有保护。F 必须先有接受的释放；控制矛盾先出现则占用/屏障阻断恢复投递；F 结果先写后出现矛盾不会撤销历史释放，而是保留独立风险屏障（SQL contradiction/changed subject，F still-running）。 |
| C/X | 已有保护。C 的只读历史观察与 live authority 检查分开；撤权后不得 start/resolve/output，仍允许清理观察和降低风险。 |
| C/H | 已修复 TE-05，已有 pending 分类。C controlled→process_group_gone/exit_cleanup_pending 保持旧状态，真正 unconfirmed 才记 lost；认证 socket 测试验证签名、任务退出及最终进程组读回。 |
| C/I | 已有保护。观察先推进资源版本则旧 intent 派发拒绝；派发先发生后观察/矛盾不能伪造 ACK 或恢复披露权。 |
| R/S | 已有保护。S 的候选/恢复版本 CAS、running timeout、过期 owner、取消后的迟到回调均有 S/SQL 用例；先排期后 R 结束会关闭该义务，先结束后排期不能再发 host stop（S `releases verified bound resources ...`）。 |
| R/D | 已修复 TE-03。SQL `Agent foreground ... recovery is released/unresolved` 与 `refreshes ... verification` 的 released/unresolved/cancelled 覆盖两顺序和不披露结局，原 35 秒上限不变。 |
| R/B | 已有保护。B 中断旧 recovery owner；迟到 proof 不能覆盖新 boot/revision。 |
| R/F | 已有保护。本次 SQL `preserves a file result written around the recovery finish transaction` 在 finishRecovery 事务前后分别写结果；恢复 resolved、操作版本和结果保留、releaseReceipt 不变、目录可再准入。 |
| R/X | 已有保护，真实停止缺陷由 TE-07 修复。S `prioritizes explicit stop over inspect/stop`：新 stop 接管 inspect，旧回调不能覆盖新终点，重复 stop 不发第二次；X 先到由调度安排 stop；M stop/期限验证宿主退出。 |
| R/H | 已修复 TE-02/05/07。pending 在原恢复期限内继续检查；超时、错身份、旧观察、取消均不能释放；H 先结束由认证 final 恢复，R 先发 stop 须等签名和实际进程事实。 |
| R/I | 已有保护。releaseReceipt 与 intent ACK 独立；先释放后 ACK 丢失仍保留释放，先 ACK 后资源风险仍阻止 Run 假完成。 |
| S/D | 已修复 TE-04。D 先等超过窗口仍保存可恢复状态；S/Run dispatcher 后发现已核验结果续接原批次，不重新执行。 |
| S/B | 已有保护。排期先保存后重开仍保留、旧 revision 拒绝；B 先恢复后 discovery 根据当前状态排期。 |
| S/F | 已有保护，资源/操作职责分开。F 仅在释放后补结果；S 对释放作业关闭恢复，不因 operation revision 变化新发 stop；F 先保存后结果发现可认领，S 先取候选后操作变则结果认领校验版本。 |
| S/X | 已有保护。终态 Run/撤权/期限触发原资源 stop；新 stop 优先，旧 scheduled/recovery revision 不能覆盖；取消先发生的 reservation 永不 start。 |
| S/H | 已有保护且有明确暂停边界。H 不直接写调度表；已接受释放先到时 S 关闭陈旧队列、不增加 host attempt；S 先核查遇到清理 pending 由 R 在原期限内续查。 |
| S/I | 已修复 TE-04。资源 S 不持有模型端口；Run dispatcher 认领当前结果与租约。 |
| D/B | 已修复 TE-04/08。D prepare/保存回执前后崩溃，新 boot 只交付原结果；旧租约拒绝。 |
| D/F | 已有保护。本次 D 在恢复挂起窗口被结果写者抢先，重读不可变获胜记录、一次 dispatch/ACK/回执；反序已知结果直接交付，不调用恢复。 |
| D/X | 已有保护。D 每个阶段检查披露；核验挂起期间取消、派发前取消、结果续接时撤权/Run 到期均拒绝，资源释放仍保留。 |
| D/H | 无直接数据库竞争，必须经过认证观察。H 先退出但无证明时 D 不释放；D 先等待期间 H 完成则由 C/R 写事实，D 重读。 |
| D/I | 已修复 TE-04，已有唯一派发。prepare→dispatch→receipt→ACK 各阶段断点由 SQL 和 M after-intent、批次恢复覆盖；I 先存在走恢复读取，D 先持有旧版本派发被拒。 |
| B/F | 已有保护，且 TE-08 补分块恢复。B 不重放文件操作，F 从真实发布记录读回；已知结果先到 B 不删除。 |
| B/X | 已有保护。B 不恢复旧执行权限；撤权先到仍可降低风险、不能再执行。 |
| B/H | 已有签名与 boot 边界。Host 存活时重启不重复创建；Host 先退出由原签名 final/同 boot 进程证据核验。 |
| B/I | 已修复 TE-04。持久原执行凭证与新结果租约分工；I 先派发后重启恢复原批次，不恢复旧执行权。 |
| F/X | 已有保护。本次 F 在读回前或写入前撤销真实 Grant，仍可保存已发生的文件事实，Grant 保持 revoked，原文件/Handle 使用数不变。 |
| F/H | 已有证明边界。没有认证释放不读回恢复；H 先退出并释放后可以从原发布记录补结果；F 先开始意味着此前已接受释放，不能重开 Host。 |
| F/I | 已有保护。F 先写操作结果后 I 固定其 revision；I 先 prepare 后操作版本变则 dispatch 拒绝，不交付旧结果。 |
| X/H | 已修复 TE-07/09。X 先发送 stop 不等于已退出；H 已在清理则 stop 仍等待认证释放。 |
| X/I | 已有保护。X 先取消阻止 prepared continuation；I 先 dispatched 后取消不伪造 ACK、不交给模型。 |
| H/I | 无直接 SQLite 写竞争，跨进程顺序通过 W/C/R/D。M 六个 finish 崩溃、流块/结束块/IPC/intent 两种重启，断言 release、result、intent、模型消费与 Host 启动数；保证边界见 TE-08，未保存原字节不得捏造输出。 |

## 缺陷和待验证项

| 编号 | 状态、现象与根因 | 复现与修复 |
| --- | --- | --- |
| TE-01 | confirmed，已做局部修复：成功释放证明与新结果竞争时，`append` 的 operation revision CAS 失败；reconciliation 将该竞争当成后端失败，转 lost/unresolved，目录继续被占用 | `accepts verified cleanup when operation completion races with %s`；backend-observation 与 proof-verification 两窗口，worker/direct 两模式，共 4 条先失败后通过。日志 `recovery-operation-race-before.log`、`recovery-operation-race-after.log` 均在证据根。仅操作版本变化时，在原期限与所有权内重新核验最新事实。相关回归、静态检查及完整 npm test 已通过，修复提交 `bce20d2`；新增 Mac 产品路径仍待验收 |
| TE-02 | confirmed，组件修复完成：清理 pending 原先被恢复服务当成终点，stop 又将其降为普通 lost；改为明确非终态观察，在原恢复期限内继续检查 | `settles an acknowledged stop whose host finishes cleanup inside the recovery deadline`；证据根下 `cleanup-pending-before.log`。扩展后的 12 条测试覆盖释放、超时、取消、身份错误、过期观察与真正 lost；修改前 2 失败、10 通过，修改后全部通过。真实认证 socket 和 SQLite 等相关回归 349 条通过（`te02-regression.log`）。提交 `eedfb42`；全部产品用户路径尚未验收，见[已批准提案](../specs/2026-09-28-sandbox-cleanup-observation-design.md) |
| TE-03 | confirmed，局部修复完成：前台先进入 verifyFresh，后台完成核查/释放，旧序号导致 Observation replay changed，前台丢失交付机会 | `refreshes a foreground handoff overtaken during verification`：修改前 4 失败、2 通过，修改后 6 通过。`te03-before.log`、`te03-focused-after.log`；仅在派发前、版本确有改变时重新读取和核验，原 35 秒上限不变；相关回归、check、完整 npm test 通过，提交 `20377db` |
| TE-04 | confirmed，局部修复已验证：Run 遇到 `runtime.result_unknown` 后保存 `RUNTIME_TOOL_RESULT_UNKNOWN` 且 output=null。自动恢复仅接受已有最终回答；资源释放不会自动消费工具结果 | 已核对 RunCoordinator、SQLite discovery、Pi 的 capture/restore 工具批次入口。既有测试明确拒绝重启时自动重放未知调用。Claude 已批准[恢复合同](../specs/2026-09-28-sandbox-tool-result-resumption-design.md)。已实现只交付入口；真实 SQLite 与生产调度/Pi 联合回归覆盖迟到结果、原进程中断、交付中断、批次恢复及拒绝边界，完整 npm test 4574 条通过，Mac 读取及写入交付中断恢复分别通过；完整任务验收仍待完成 |
| TE-06 | partially confirmed：原现场首次准备失败的触发原因仍 uncertain；准备失败后丢失控制关联的恢复缺口 confirmed | 原现场 reserved、未 bind，控制关联缺失。真实 Job Host 受控 SDK 初始化失败探针复现：任务未启动、已签名结束文件可由原密钥核验，但 Agent 未持久保存控制关联，登记 ENOENT，恢复 SANDBOX_CONTROL_BINDING_UNAVAILABLE。已按第四、五份回复完成重点、真实安装、完整 npm test/check 与两版各30成功样本的性能验收；历史首次触发原因仍 uncertain，见[已批准的数据与顺序提案](../specs/2026-09-28-sandbox-preparation-control-recovery-design.md) |
| TE-07 | confirmed，局部修复已验证：真实 Mac 运行中停止后 Run 已取消、宿主和原进程组已退出，但签名终态保存的 `taskProcessGroupGone: false` 遮住后续进程身份核验，恢复结束为 unresolved，目录占用未释放 | `round2/stop-running-4` 为真实产品失败现场；可控认证 socket/真实进程用例 `verifies the original group after its signed final observation could not confirm cleanup` 在 inspect/stop 两路径先失败。沿用原签名开始记录、同开机身份检查和既有释放证明形状补核验；不延长期限、无迁移。控制证据 81 条、真实 Mac 停止回归、check 与完整 npm test 4608 条通过，4 份受影响 Runbook 已核对封存，修复提交 `f1519e7`；完整任务仍开放。进展见[第二轮证据](../../../.ci-output/tool-execution-audit/2026-09-28/round2/README.md) |
| TE-08 | confirmed，已修复并通过本地验证：真实 SRT reset 后重启 Agent/Worker，完整 read 输出已从宿主到达 Worker，但只保存在 Worker 内存；重启后资源释放成功，result=null、intent=0、Run 停在 reconciling_external_result。签名控制终态不保存原输出与退出结果，既有结果发现又要求 result/error 已存在 | `round2/restart-1`：运行中重启和收尾不重启对照通过，收尾重启失败（2 通过、1 失败、15 未执行）。失败安装 `/private/tmp/hma-pp-Vp0WPJ`；`te08-red-readback.json` 为独立数据库和控制文件读回。完整原始输出不等于已被 Agent 认证接纳的成功结果。[先前 LOST 修复及后来批准的分块恢复补充](../specs/2026-09-29-sandbox-foreground-result-durability-design.md)，测试和证据见[TE-08 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te08-verification.md)；该历史提交仅在已接受释放、原签名任务退出、无确定结果且原 fence 已失效时，用 operation revision 保存确定的 SANDBOX_TOOL_RESULT_LOST，再沿原 Pi 批次唯一交付；效果未知不改写，原输出保存前退出仍是明确保证边界。相关集成 469 条、旧写者 16 条、预算 2 条、Mac 定向 9 条及 IPC 接收补验 2 条通过；完整 npm test 4651 条通过，Runbook 已封存。提交见[TE-08 交付记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te08-delivery.json)，整轮最终无筛选资格待后续执行 |
| TE-11 | confirmed：累计事件单响应超过65,536字节；有界分页与A1轮询推进修复按reply-16独立交付 | 30项UDS矩阵、7项A1测试和73项相邻回归通过；原前置场景加连续30读8项通过。完整check通过，te11-full-2的4883项全通过且命令退出0；新[分页设计](../specs/2026-09-29-execution-event-pagination-design.md)和两份Runbook同步。A2失败测试与钩子不进入本提交，A2及最终无筛选资格仍未完成；[完整证据](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te11-verification.md) |
| TE-10 | confirmed（可控 Host/Worker 边界）：主进程退出但输出管道未关闭，Host 如实报告 stdioClosed=false；Worker 却把传输结束当完整输出并保存成功结果 | `round2/te10-pipe-red-2` 为有效红测试：Host 证明测试通过，Worker 的 end=false 与非成功断言均失败。修复要求最终 flush 和 knownExit 明确 stdioClosed=true，保留前缀、未知结果、原清理与恢复边界；同测试 `te10-pipe-green-1` 2项通过，相邻首轮106项通过。完整check、重新构建、4855项npm test全部通过，四份Runbook重新封存、严格文档校验零警告。独立提交见[TE-10交付记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te10-delivery.json)；[TE-10 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te10-verification.md)。这不是实际 OS 管道泄漏或 Linux 平台验收 |
| TE-09 | confirmed，已提交 `ac094b9`：两次真实300秒场景均按期限退出并认证释放，Run仍待核查。细分复验确认Agent未留清理汇报余量，Worker将deadline且exitCode:null的退出归为未知；本次结束块和普通Payload保存成功，旧场景缺块的具体RPC原因仍uncertain。原900秒后的无候选仅有SQL投影和源码证据 | `round2/deadline-1`及`round2/te09-r10-diagnostic-1`各为1失败、40筛选未执行。reply-10已批准工具超时错误一次交付并继续Run；仅到原Run期限才作failed兜底。reply-11已批准最小内部收尾端口及原子租约事务，见[到期收尾设计](../specs/2026-09-29-sandbox-deadline-settlement-design.md)。本机专项验证已通过；Worker真实300秒与Run90秒场景已通过。结束块保存后重启另确认普通恢复入口拒绝已过工具期限，reply-13批准限定期限用途并沿用Agent验签/SQLite绑定分工；相关SQLite整文件478项通过，第六版真实300秒恢复及22项受影响矩阵通过，补充边界10项通过；依赖边界检查发现新helper越层导入，复用既有application身份工厂后第七版90秒Run复验通过。完整check及npm test 4827项通过，四份Runbook已显式封存，严格文档校验零警告；[TE-09交付与提交记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te09-delivery.json)。整轮无筛选验收仍待后续执行。见[TE-09验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te09-verification.md#reply-10-细分诊断)及[stop-10](../../../.ci-output/handoff/2026-09-28-codex-round2-stop-10.md) |
| TE-08 方案 B | 已批准并完成本机实现验证，提交 `81a9fd2`：前台输出复用加密分块，结束块后服务退出可以在释放后恢复原字节；保留77fb033的合法LOST边界 | [方案 B 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te08-b-verification.md)保留早期失败、三方事务竞争、矛盾正文与终态pending时间红/绿证据。B7真实22项矩阵通过；reply-9原探针30对30中位增量−21.5ms通过，原288ms超标及因果不确定性保留。完整check通过；首次完整npm test的10项失败来自旧JobHost夹具缺completed，补齐后同文件17通过，第二次完整npm test为4697项全部通过、零失败与跳过。交付与提交见[方案 B 记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te08-b-delivery.json)。整轮无筛选资格仍待后续执行 |
| TE-05 | confirmed（本机可控延迟），Hermes 当次因果仍 uncertain：finish 在异步清理前停止心跳，2 秒正常 reset/control.finish 等待期间心跳为 0，会触发 Worker 的 1.5 秒失联判断 | `te05-before.log` 两条失败；修复后心跳保持到清理结束，退出期限仍有效。`te05-after.log` 及 `te03-te05-regression.log`。使用真实 Job Host 入口、受控 OS/IPC/SRT 边界；不是磁盘满载实测，不推断 Hermes 历史失败根因；相关回归、check、完整 npm test 通过，提交 `266715d` |

交接中的五个历史缺陷只作为线索；本轮不能把历史通过日志记成本轮验证。关于“后台核查导致所有故障”的说法目前仅 partially confirmed，仍需检查退出、停止及投递各自的窗口。

## 验证与交付

先对 TE-01 做窄集成回归：真实 SQLite 和生产恢复服务，外部后端观察/证明使用夹具，deferred 仅控制异步位置，不替换持久写入或状态投影。浏览器不能可靠把并发写入安排在这两个 await 之间，因此需要该层测试；其通过不能证明真实平台释放。

证据根为 `.ci-output/tool-execution-audit/2026-09-28/`，保留命令、退出码、版本、差异和读回结果。使用现有 Vitest、项目 `npm run check`、`npm test`、完整 E2E 及 `qualification-product-path`；不下载工具，不新建测试系统。

- [x] 阅读交接、当前指令、固定 Pi 入口、设计、ADR 及相关实现，建立写者表。
- [x] TE-01 先失败证据。
- [x] TE-01 局部修复和相关回归：4 条复现通过；原资源身份、期限、恢复所有权等既有回归通过。完整验收另计。
- [x] 45 对已逐对核对并补定向测试；W/H 管道未关闭窗口 TE-10 已复现修复且完整check/npm test通过，其余证据范围见审计表。真实产品最终无筛选验收仍单列。
- [ ] 多工具、停止、重启、期限和重复运行的本机产品 E2E。
- [ ] `npm run check`、`npm test`、全套 E2E、构建及文档校验。
- [ ] Runbook 语义核对、重新封存，按独立缺陷提交。
- [ ] Hermes 上的对应 Linux 测试；否则明确记录 Linux 未验证。
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

完整任务尚未完成，仍有交错排列、Job Host 故障窗口与 Mac 产品路径新增场景待执行。Hermes 未访问，Linux 真实平台行为未验证。按 Claude 批准的规则，每个独立缺陷在相关检查与完整 npm test 通过后单独提交；TE-01 `bce20d2`、TE-02 `eedfb42`、TE-03 `20377db`、TE-05 `266715d` 已分别提交。

### TE-03 与 TE-05 验证

两项局部修复及既有 SQLite/Job Host 回归共 296 条通过，`te03-te05-check.log` 静态检查通过；完整 npm test 在 `full-te03-te05/` 通过：278 个文件、4495 条测试，0 失败、0 跳过（unit 2090、contracts 381、integration 1891、E2E 3、Pi 130）。源码摘要及差异分别为 `te03-te05-tested-source.json`、`te03-te05-tested.patch`。TE-02 提交为 `eedfb42`。

Mac 产品路径已新增同轮两次工具和重复读取 30 次，独立读回 SQLite 的 Run 状态、释放回执和结果 intent，并核对每个模型请求的工具结果 ID。首轮在安装前因缺少 HIMAWARI_CI_PYTHON 停止（9 个场景均未执行）；已指定现有锁定版本 Python 重跑。停止/运行中重启/执行期限等新增场景及 finish 各步骤真实崩溃仍未完成。

产品路径第二轮 `product-path-te03-te05-run2/` 已通过登录、普通回答、读取已有/缺失文件，写入获批后出现结果未知；后续用例被该未结束 Run 阻塞，测试主动中断，退出 130。保留数据库备份、页面快照、服务日志与 interruption.json。执行预留尚未绑定，Job Host 的最终证据 taskStarted=false，恢复原因 SANDBOX_CONTROL_BINDING_UNAVAILABLE；当前证据不能区分准备失败、控制登记失败或监督失联，不能归因于 TE-03/TE-05。相同产物单独执行写入场景在 `product-write-isolated/` 通过（1 通过、8 筛选跳过，含文件独立读回），前次偶发故障仍是开放问题，编号 TE-06。

### 既有自动化覆盖的本轮复核

`full-te03-te05` 已运行既有测试，以下结论只覆盖测试明确断言的窗口，不将 45 对写者全部标为通过：

- `sqlite-sandbox-execution-v2.test.ts`：真实 SQLite 重新打开后保留操作结果/占用，唯一 dispatch 和变更序号拒绝，Run 取消阻止 continuation 但允许清理，SQL 事务前恢复所有者变化拒绝旧写入，release 后迟到结果不会伪造资源转换。
- `sandbox-resource-recovery-scheduling.test.ts`：失败尝试跨重启保持暂停，显式 stop 接管 inspect 后旧回调被拒，重复 stop 不再次执行，过期尝试终结且不获得新期限，撤权先阻止预留启动再安排清理。
- `production-sandbox-lineage.test.ts`：真实文件发布记录、受保护 Payload 和 SQLite 恢复，平台释放证明为夹具；不得恢复未释放、归属不匹配的文件结果，已恢复结果不重复读回。Worker/F 同时写入窗口仍未单独安排。
- `sandbox-control-evidence.test.ts`：认证 socket 与保存的任务身份，same-boot 宿主崩溃和机器 boot 变化分别判断，不把 PID 存在或任意主进程退出当作释放证明；不是 finish 每一步实际杀进程的替代证据。

### 本轮交付与审阅停点

Mac 的两项新增产品路径已通过：`product-multiple-repeat-vitest.json` 为 2 通过、7 项因 -t 筛选未运行；同轮两个工具和连续读取 30 次共 32 个沙箱作业。最终数据库备份独立只读查询得到 32 条 `completed / released / result`，quick_check=ok。浏览器 trace、每轮读回、report.json、数据库与服务日志均在 `product-multiple-repeat/`，清理后仍存在。测试提交 `def89be`；本次结果不能代替完整 9 场景无失败运行，也不能消除 TE-06。

`product-process-cleanup.json` 记录本任务保留的两个隔离安装均无存活测试进程；保留安装目录供诊断，未触及用户服务。停止/运行中重启/执行期限、finish 各步实际崩溃、剩余交错仍未全部覆盖。Hermes/Linux 未操作、未验证。

Claude 第三份回复已于 18:05 批准 [TE-04 持久恢复提案](../specs/2026-09-28-sandbox-tool-result-resumption-design.md)。实现复用原工具意图、Pi 冻结批次和 Run 租约，不增加表、迁移或期限。当前 52 条重点边界测试通过，6 个相邻集成文件 474 条通过，Pi 兼容测试 134 条通过；日志分别为 `te04-production-final-focused.log`、`te04-adjacent.log`、`te04-pi-regression.log`。静态检查 `te04-check-progress.log` 通过，首轮完整 `full-te04/` 的 4572 条均通过，但运行中加入审批快照修复，因此仅作中间记录。冻结最终代码重新构建后，`full-te04-final/` 全部通过：278 个文件、4574 条测试，0 失败、0 跳过（unit 2090、contracts 381、integration 1966、E2E 3、Pi 134）。`te04-check-final.log` 静态检查通过，四份受影响 Runbook 已重新封存，严格文档检查 0 警告。`product-te04-crash-3/` 与 `product-te04-write-crash/` 分别通过真实读取、写入交付中断恢复；前者筛选未运行 9 项，后者 10 项，不能替代未筛选完整 Mac 产品资格。

TE-04 的 Mac 崩溃验证发现历史审批快照会覆盖已核验结果的恢复引用；`product-te04-crash-2/` 保留首个有效现场失败，`te04-approval-snapshot-before-scoped.log` 两条同因失败、`te04-approval-snapshot-after.log` 两条通过。Coordinator 只在专用结果恢复入口采用已核对的原调用快照。先前第一轮产品测试因未等旧租约过期而启动失败，属于测试前提错误，不作为产品缺陷；没有放宽租约、费用或期限保护。

独立读回 `te04-product-independent-readback.json` 确认两次崩溃恢复各只有一个 completed Run、一个 bound/released/result 作业、一个已派发并确认的 tool_result intent，agent-stream 序号 1、2 各一条 settled，数据库 quick_check=ok。写入场景还核对重启前后实际文件内容。`te04-product-process-cleanup.json` 确认四个本任务隔离安装没有残留 Agent/Worker/Job Host 进程。命令、源码摘要、产物 SHA256、红绿证据及限制统一保存在证据根的 `te04-verification.md`。本次提交交付已验证的 TE-04 修复，不代表全部计划验收完成。

### TE-06 批准与实施验证

以下保留第四份回复时的历史停点；最终本轮结论见[第五份回复后的诊断与测量](#第五份回复后的诊断与测量)。

TE-04 已在本地提交 `58e6c48`，完整任务仍开放。按 Claude 第三份回复要求继续检查 TE-06 原失败记录，确认 Worker 在 `host.ready` 之后才登记控制关联；准备失败跳过登记，Agent 无法认证遗留结束文件。原现场的准备错误、Worker catch 原因与宿主基础设施 stderr 未保存，尚不能确定首次触发原因或归因于某个并发写者。四次 prepare 探针与单独写入通过仅作对照。

`te06-preparation-failure-probe.mjs` 使用实际 Job Host、签名最终文件及生产控制器，控制 SDK initialize 和 admission/Artifact 存储边界；断言失败复现关联缺失，日志与 JSON 在证据根。它不等于完整 Worker 产品 E2E；原历史 final 文件缺少已保存控制密钥，也不能补称已认证证明。

现有持久数据不能还原原验证密钥，需要增加受保护的准备控制记录并提前至 fork 前登记。已编写[具体 TE-06 提案](../specs/2026-09-28-sandbox-preparation-control-recovery-design.md#建议的数据与执行顺序)，包含确定未启动的失败交付和有界诊断。Claude 已通过 `claude-reply-4.md` 批准四项改动，并要求保留首次私有诊断、测量修改前后 30 次工具调用的中位数和最大值；中位数增加超过 100 毫秒必须暂停。

受控探针已先转为持久 Vitest 回归，保留真实失败再实施。重点回归验证原凭据、取消、期限、模型费用未知及缺失证明均不能越过原边界。`te06-product-failure-3/` 通过实际安装、浏览器审批和 CLI 诊断：原文件保持不变，task 未启动，认证的预留释放依据为 `host_never_started`，Run 完成且模型只收到一次工具结果；诊断保留 `prepare / sdk_initialize / EIO`，不含私有正文。第二次产品运行在场景执行前启动超时；后续加入启动阶段记录后通过，但超时原因仍 uncertain，保留 `te06-product-failure-2/`，不能称该问题已修复。修改前 30 次中位数 8403 ms、最大值 11035 ms，修改后第 8 次真实准备失败，只有 7 个完整成功样本，中位数 12664 ms、最大值 17773 ms；初步中位差 +4261 ms，未达到完整 30 对 30 验收。完整测试 4599 条中 5 条容器分支失败，诊断范围修正后原断言的 28 条针对性回归通过；修正后尚未全量复跑。最新构建和静态检查通过。当时按第四份回复性能停点暂停；第五份回复随后批准继续定位，当时 TE-06 尚未提交。新实际失败已有 prepare/launch/UNKNOWN 私有诊断，认证释放后 Run 正常结束，但首次触发原因未确定。详细证据见证据根 `te06-verification.md`。


### 第五份回复后的诊断与测量

**TE-06 本轮验收完成。** 保留 fork 前的受保护准备登记、全部身份/权限/释放核验、原1.5秒心跳及执行期限；没有新增跨调用核验缓存。Pi仍复用既有工具定义和批次恢复，产品负责受保护控制关联及结果交付。剩余场景未执行，不归档本计划。

第五份回复期间确认并修复两个启动问题：prepare封套通过校验后立即发送首次heartbeat，消除“启动加初始化期间没有第一条消息”的间隙；固定SRT0.0.75查找Java代理前同步执行npm root -g会阻塞心跳，现通过SDK已有javaAgentJarPath参数指定同一已核验安装的随包JAR。真实失败捕获3116.09ms的npm阻塞；1600ms慢命令注入及500ms启动加1150ms同步初始化均有失败再通过的回归。机器诊断保留白名单错误码、命令、phase、消息年龄、序号和期限余量，不保存任意SDK正文。

新增登记的主要成本是一次必要的完整宿主核验。每次核验内，原有node/runner摘要及runtime新鲜检查由串行改为并发；每次调用的证据要求不变，67条身份、内容和权限回归通过。最少完整核验次数为12→13；轮询和观察会增加次数，不能把全部作业固定描述成12/13。原先8/9只统计Agent部分入口。

|验收项|结果和证据（均在原证据根）|
|---|---|
|两版各前30个成功调用|旧版中位9773.5ms、最大19899ms；修改版中位8925.5ms、最大16705ms，中位减少848ms，满足增量≤100ms。最终完整分段和逐次核验为te06-r5-final-performance/profile-summary.json|
|采集与失败口径|alternating-6得到旧版29/修改版30成功，旧版另有3次已解释失败；原Vitest失败报告保留。相同产物和探针再成对补测1次，补足旧版第30成功；额外修改版第31成功单列，不替换较慢样本。不是单次未中断30对30通过；两次命令和夹具摘要均保留|
|旧版3次失败|两次首次心跳晚于取消；第三次prepare封套到达已1567ms，按原1500ms规则拒绝，尚未进入初始化。全时间线、SQLite及未释放现场保留；没有重放或手工清除占用|
|新增准备登记|登记RPC中位566.11ms，内部核验548.89ms，加密0.37ms、SQLite写0.48ms。fork→ready中位736→180.5ms；完整阶段表见te06-r5-final-report.md|
|完整项目测试|te06-r5-build-3真实产物；te06-r5-full/local-summary.json为local_passed。unit2096、contracts381、integration1992、e2e3、pi-compat134，共4606通过，0失败、0跳过；容器路径修正已包含|
|静态检查|te06-r5-check-final.log：npm run check通过，包含最终采样器类型、格式及边界检查|
|最终真实安装准备失败|te06-r5-product-failure：浏览器审批、CLI诊断、实际文件和SQLite读回通过。文件不变、reserved/未启动、认证host_never_started释放、Run完成、模型消费一次；单独资格项目1通过、13筛选未运行，不替代完整Mac产品资格|
|文档与交接|四份受影响Runbook语义核对并重新封存，严格校验结果见te06-r5-docs-final.log。独立交接为.ci-output/handoff/2026-09-28-codex-round1-summary.md；TE-06提交以Git记录及交接为准|

最初+4261ms来自非交替、修改版仅7成功样本的比较；原日志只够定位宿主核验累计中位差约+2882.8ms，其余不能追溯成唯一原因，不能将不同样本的中位数直接相加。新探针确认主要成本为逐次runtime遍历和摘要，而非Payload/SQLite；观察到过磁盘99%和高CPU，但不能断言该系统状态导致原历史差值。原历史准备触发、te06-product-failure-2场景前启动超时仍uncertain。

修改版第13个成功调用在宿主正常ready/started/result/close之后出现worker.rpc.reconcile抛错，留有execute/UNKNOWN诊断；实际文件、释放、唯一intent与模型消费均通过。它不是准备失败，精确RPC拒绝原因仍待剩余交错排查；不得据30成功宣称所有内部调用没有异常。

为保留证据并缓解本机磁盘压力，八个已停机成功安装的重复prefix经逐文件、类型、权限和链接核验后完整压缩；state、secrets、workspace、jobs和所有失败安装均保留。归档和恢复说明见te06-r5-final-report.md及各根runtime-archive.txt，恢复会产生新inode。本轮只重启自有/tmp/hma-pp-*安装，未操作Hermes。

后续由Claude派发运行中停止/重启、执行期限、finish各步崩溃、剩余交错以及最终未筛选Mac产品资格与总报告。本轮不继续这些场景，不声称Linux或生产验收完成。


### 第二轮剩余写者与诊断

TE-09 已独立提交 `ac094b9`。其后补充的测试没有改变产品状态、协议或持久结构；验证操作结果竞争不会撤销释放、资源候选和观察受版本校验、前台只交付获胜的不可变结果。新增测试和诊断验证汇总见[写者与诊断报告](../../../.ci-output/tool-execution-audit/2026-09-28/round2/writers-verification.md)。

历史样本 13 的 `worker.rpc.reconcile` 仍缺少内部原因，真实 SQLite 已重现“已释放后旧序号请求被拒”的候选路径，但不能倒推为历史唯一根因。`resolve` 的内部异常会统一包装为 `SANDBOX_SCOPE_UNAVAILABLE`；新增测试探针只记录白名单原因，已通过核验前到期、核验中到期和私有异常脱敏测试。真实 300 秒复验通过，未出现 RPC 异常，因此旧 `resolve / UNKNOWN` 的确切触发原因仍未确认。完整证据见[诊断分析](../../../.ci-output/tool-execution-audit/2026-09-28/round2/unknown-diagnostics.md)。

本阶段完整 check 通过；匹配当前提交的重新构建及完整 npm test 4853 项通过、零失败/跳过。该结果未包含随后静态发现的 W/H 管道未关闭候选缺口；其复现与处理将独立记录，不将整轮标为完成。

### TE-10 输出完整性检查

按已批准方案 B 的“不能把前缀作为完整成功”合同，Worker 的最终输出保存与结果分类增加明确的 stdioClosed 检查，不修改消息、状态或持久数据结构。Job Host 已正确区分 exit 与 close；无需复制 Pi 工具能力。失败发生在 Himawari 自有宿主清理事实到结果接纳的边界。可控测试负责精确安排 exit 后无 close 的窗口，真实 Mac 的一般输出、期限与恢复路径由最终产品资格另行验收。

### 最终无筛选资格发现 TE-11

TE-10已提交 `f635513`，4855项完整测试及check通过。随后从该HEAD重建，无筛选运行全部43项Mac产品资格（启用原性能基线），在同一服务累计作业后的第29次读取失败，7通过、1失败、35未执行，不能归档或宣称最终验收完成。详见[两轮总报告](../../../.ci-output/tool-execution-audit/2026-09-28/round2/round2-final-report.md)和[TE-11证据](../../../.ci-output/tool-execution-audit/2026-09-28/round2/te11-verification.md)。该次停止时新增真实UDS红测试未提交、生产代码保持f635513；后续获批实现及A2新停止点见下一节。

### reply-15 A2 恢复阻塞与后续审核

TE-11有界分页及A1轮询推进已先红后绿，原连续30读在同一服务保留前置调用后通过。修复前本次前28读成功、第29读失败，阈值取决于累计事件大小，且之前还有前置工具调用；不能泛化为固定28次工具上限。

A2真实安装故障注入确认：准备resolve的UDS响应断开后，预约reserved、无准备控制artifact、无释放回执，恢复停在unresolved；成对重启和原90秒Run期限后约40秒仍未进入终态。未放宽释放守卫或清占用，按[stop-14](../../../.ci-output/handoff/2026-09-28-codex-round2-stop-14.md)提交准备封锁/释放证明提案。该段记录当时停止状态；reply-16裁定与独立提交范围见下节。

B1期限后撤销检查、B2终态通知、B3真实脱离进程组输出场景按reply-15顺序待做；B4非沙箱UNKNOWN无到期路径只记录不修。事件历史内存/重复读取Backlog尚待独立创建提交。性能历史+288ms未通过与清理后−21.5ms通过并列保留，新最终30对30尚未运行。详见[总报告待决与验收范围](../../../.ci-output/tool-execution-audit/2026-09-28/round2/round2-final-report.md#reply-15-待决与验收范围)。

### reply-16 TE-11 独立交付与 A2 前置检查

Claude已批准先单独交付TE-11分页与A1，并要求A2失败场景及钩子留待A2修复提交。分页合同、失败处理与同包成对升级要求记录在[执行事件分页设计](../specs/2026-09-29-execution-event-pagination-design.md) [SOURCE: docs/execution/specs/2026-09-29-execution-event-pagination-design.md]。连续30读的持久回归已在此前提交中，本次沿用同一服务含前置调用的8场景通过证据；不能把筛选通过视为最终完整资格。

A2批准的方向是在同一不可变准备附件key先写确定内容的封锁记录，限定本机SRT，并复用既有“工具未启动”交付；实施前必须证明旧版本先fork后登记的记录不能进入新依据。仍须测试最多一次的旧unresolved额外恢复、登记与封锁竞争及ACK丢失。批准不等于已实现，A2现场当前仍无终点。诊断丢失D和container预约自动恢复E须分别确认后处理，随后才是B1/B2/B3、Backlog及最终无筛选资格。

TE-11独立提交前，当前源码的73项相邻测试、完整npm run check通过。首次全量4883项均通过但因并发纯文档提交0f7060f导致导出阶段testedSha不符，完整命令退出1；从0f7060f重建build-te11-3后重跑te11-full-2，280文件4883项全部通过、0失败/跳过，命令及报告导出退出0。两次原始结果均保留，不修改历史context。两份Runbook在语义核对后封存，严格文档校验随提交证据保存。


### reply-17 A2 新计划封锁与旧记录保护

reply-17 已撤回 reply-16 的旧 unresolved 额外尝试；前节描述保留为历史要求，不再实施。新 SRT 计划带固定准备协议字段，旧计划缺省读取不回填，历史 Worker 在建宿主前由严格解析拒绝新字段。设计与静态历史证明见 [A2 准备封锁设计](../specs/2026-09-28-sandbox-preparation-control-recovery-design.md#第二轮-a2准备登记之前的封锁) [SOURCE: docs/execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md]。

真实 SQLite 竞争、回滚、权限和旧计划矩阵已经通过。新版真实安装在原 Run 期限前接受 preparation_not_authorized，释放占用，持久结果为 SANDBOX_TOOL_NOT_STARTED，模型只收到一次固定中文说明并继续；成对重启无重复。单独的旧格式安装在重启及原期限后仍未释放、不产生模型工具回复。完整过程、测试夹具缺陷、数据库独立读回、检查及提交状态见 [A2 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/a2-r17-verification.md)。登记成功但 ACK 丢失仍无终点；D、E、B1 至 B3、Backlog 和最终无筛选资格尚待继续，不把 A2 定向通过当作整轮完成。

A2 提交前完整 `npm run check` 与 `npm test` 均退出 0，4,924 项全部通过、零失败/跳过。四份受影响 Runbook 语义核对后重新封存，严格校验零错误/警告。真实新旧安装的数据库以只读 immutable 方式独立复核，原文件摘要不变。


### D 准备失败诊断的断连恢复

A2 已独立提交 `b97aae8`。其后确认 D：Payload UDS 传输异常清除连接状态，Worker catch 未握手就发诊断，诊断再次被拒。新增组件测试先有 2 条失败，复用原 peer 握手后完整生命周期 27 条通过；新旧真实安装的同一断连注入都通过 CLI 读回一条受保护 prepare / SANDBOX_PREPARATION_FAILED，且 A2 的新旧释放边界不变。只重建诊断通道，不重发 resolve 或原工具。握手/权限仍失败时不能保证诊断持久，未增加新接口或备用日志。完整验证与提交状态见 [D 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/d-verification.md)。

D 提交前完整 check、4,926 项 npm test、两项实际安装回归和四份 Runbook 封存均通过；严格文档校验零错误/警告。未增加接口或恢复用途。


### E container 预约自动恢复分流

D 已独立提交 `33c1590`。E 的有效红测试先用 TaskEnvironmentCoordinator 产生真实环境释放回执，再由自动预约恢复读取；旧实现错误调用本机控制，独立 SQL 仍读到未释放占用。分流到现有 environments.releaseReservation 后，释放及重复 pump 幂等通过；环境仍运行与伪造回执的拒绝检查保留。定向容器路线与 SRT 封锁矩阵 39 项通过，完整 check 通过；构建与完整项目验证、提交状态见 [E 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/e-verification.md)。未新增接口、持久形状或重新调度规则，未执行 Docker/Linux 资格。

E 提交前完整 check、构建、4,928 项 npm test 全部通过，零失败/跳过；四份 Runbook 完成 dry-run、确认封存及 check，严格文档校验零错误/警告。被测源码与提交前源码逐文件相同。


### reply-18 F：UDS 通用恢复与暂停审核

E `cd276c3` 已获 Claude 独立审核通过；文档提交 `e0bce8e` 修正 A2 状态与停服后的预约统计，四份 Runbook 已在当前目录及 git archive HEAD 干净副本验证。B1 的 +290 行测试已原样保存为 b1-wip-at-stop-16-preparation.patch 并从工作区移除，F 完成后须写 stop-16 等审核，不能直接继续 B1。

F 红测试确认同一生产 Worker 装配首次写输出断连后，第二次正常调用被 HANDSHAKE_REQUIRED 拒绝而 readiness 仍为 true；Admission 同样不能继续。现两个客户端共享内部并发握手机制，保留原身份、认证和握手校验，不重发失败业务。Worker 就绪探测可启动有界共享重握手，关闭仍拒绝迟到成功。D 的显式重连特例已删除，其两项回归使用真实 UDS 与通用生产客户端，诊断成功/握手失败及无原操作重发仍成立。

定向 81 项已通过，包括原认证合同、8 项通道恢复矩阵、12 项 Worker 装配及 27 项生命周期；其中 Worker endpoint 依赖仍为测试 fetch，不是完整 SRT 资格。完整 check、build、npm test 和提交证据见 [F 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/f-verification.md)。实现与限制见 [F 设计说明](../specs/2026-09-28-sandbox-preparation-control-recovery-design.md#f通用-uds-断连恢复) [SOURCE: docs/execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md]。

E 留下的终态 Run / 未绑定 container 环境停止缺口已按只读调用链确认并记录 [BL-20260929-004](../../backlog/BL-20260929-004-agent-重-启-后-停-止-终-态.md)，本轮不实现；期限恢复本身要求资源释放，不能把该缺口描述成已复现的到期后错误终态。整轮仍待 B1、B2、B3、其余 Backlog 与最终无筛选 Mac 资格。

首轮 F 完整 4,940 项全部通过后，静态复核新增关闭期间清理通道寿命回归；测试确认重握手 catch 过早 disconnect。已改由 close 在 shutdown 完成后统一断开，原关闭错误码保持；该新增场景先失败后通过。最终版本重新构建与全量验证记录见 F 验证记录，不能复用首轮全量作为最终代码证据。


### reply-21 B1：期限后交付授权

B1 已确认：真实交付意图提交后撤销 Grant/Handle，工具期限后的普通结果和固定期限错误仍可交付；解密期间撤权同样存在窗口。按 reply-21 批准新增只读 `assertResultAuthority`，在同一 SQLite 读快照复用原回执授权核验，持久回执期限加 35000ms 与原 Run 期限限制上界，调用方不能扩大。期限前路径及解密后检查保留，不改通信协议或数据库结构。合同见 [期限后的交付授权](../specs/2026-09-29-sandbox-foreground-result-durability-design.md#期限后的交付授权) [SOURCE: docs/execution/specs/2026-09-29-sandbox-foreground-result-durability-design.md#期限后的交付授权]。

第 0 层最终 80 项通过、第 1 层 check 通过；第 2 层首次 4471 项通过，两个安装测试文件因缺少构建输入未进入正文；补齐当前版本安装包及锁定 Python 后 7 项全部通过，最终覆盖 unit 2120 项与 integration 2358 项。证据、复跑命令及最终提交状态见 [B1 实施验证](../../../.ci-output/tool-execution-audit/2026-09-28/round2/b1-r21-verification.md)。按 ADR 0038 和 reply-20，B1、B2、B3 各自第 0–2 层后独立提交，批次末执行第 3 层；B3 另须真实 Mac 定向验证。当前结果不代表本批或整轮验收完成。


### reply-21 B2：Run 到期标准通知

B2 已确认并修复：原 settleExpired 只写 Run/checkpoint/lease，漏掉标准终态通知。现在与普通状态转换共用回执和网关事件写入函数，在同一个事务内保存命令回执、待发布 run.failed、线程版本与网关事件；稳定幂等键与原 Run/期限绑定，重复调用不重复写入。独立构造 dispatcher 的既有用法保持。没有表结构、迁移或外部端口变化，合同见 [Run 到期](../specs/2026-09-29-sandbox-deadline-settlement-design.md#run-到期) [SOURCE: docs/execution/specs/2026-09-29-sandbox-deadline-settlement-design.md#run-到期]。

第 0 层 54 项、第 1 层 check、第 2 层 unit 2120 项与 integration 2368 项全部通过；真实 SQLite 独立读回证明通知关联、重复调用及四处写入故障的整体回滚。失败记录、自查修正、最终提交与复跑方式见 [B2 验证](../../../.ci-output/tool-execution-audit/2026-09-28/round2/b2-r21-verification.md)。当前构建仅用于第 2 层安装测试并供 B3 复用，批次第 3 层及整轮资格未运行；下一项为真实 Mac 脱离进程组输出管道验证。

### reply-24 R2：合法结束原因不关闭 Agent

当前批次改为 B1、B2、R2；R1 与 B3 留到下一会话。R2 按 Job Host 的实际六种结束原因划分恢复语义：exited/deadline 保持原条件，cancelled/output_limit/resource_limit/host_failure 完整校验后返回不可恢复，不导入输出、不重放，也不因合法原因触发 Agent authority loss。非法原因、矛盾字段、未退出、绑定/摘要/分块损坏继续拒绝。源码依据、测试失败原因和验证范围见 [R2 验证](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r2-r24-verification.md)。

已完成有效红测试和两个相关集成文件的回归，check 通过；随后运行第 2 层并独立提交，在 B3 补丁暂移开的已提交版本上执行本批第 3 层。实际运行结果及最终版本由验证报告记录。R1 尚未修改；B3 的旧“脱离后代存活即释放缺陷”判断已被 reply-23 撤销，当前未提交测试及 hma-pp-Vvii2j 现场继续保留，下一批按 ADR 0033 验证进程组释放与界面提示。

### 最终批次的测试位置与 Mac 资格（用户 2026-09-29 决定）

2026-09-29 用户决定不在开发 Mac 上跑测试，当时测试转到 Hermes。2026-10-01 起测试曾改到云服务器 `84.247.157.41`；2026-10-02 用户决定测试回到 Hermes，云服务器只用于生产，现行规则见 [ADR 0046](../../adr/0046-tests-back-on-hermes.md#hosts)。[SOURCE: docs/adr/0046-tests-back-on-hermes.md] 以下 Hermes 目录与下载授权记录的是 2026-09-29 的安排；新的下载仍要先经用户同意。最终批次在 Mac 上启动的第 3 层因此被中止，没有产生可用结果。第 3 层和 Linux 无筛选产品路径资格在 Hermes 上对最终版本执行：源码、依赖、工具、构建和证据在 `/data`，运行中的临时数据在根盘的任务目录。用户已批准为此下载 `ci/toolchain-lock.json` 中 linux-x64 的固定工具、锁定的 npm 依赖和与 `@playwright/test` 配套的 Chromium，需要 root 的系统包另行由用户执行脚本。

用户于2026-09-30无限期推迟所有 Mac 验证，用户重新安排前不运行、不排期，Mac 行为未验证；这也包括第二轮的 Mac 无筛选产品路径资格。总报告必须写明这一点，并注明最后一次 Mac 资格的版本和结果；Linux 结果不能当作 Mac 结果。Linux 性能结果为第一次测量，不与 Mac 的 +288ms、−21.5ms 对比。

### 第二轮的收尾条件（用户 2026-09-29 决定）

用户决定：第二轮不能带着已发现的缺陷收尾。凡是已经发现、确认属于缺陷的问题，都要先修复，并各有先失败后通过的测试，然后再跑最终完整测试、Linux 无筛选资格和总报告。原本记为“已知限制”或 Backlog 的工具执行缺陷，也在这一轮修复；只有需要用户另做产品或设计决定、或需要在 Mac 上验证的项目，先由 Claude 向用户确认。

2026-09-30用户决定每个提交创建后立即推送；第0–2层通过即可提交，第3层不作为推送前提，仍在批次交付、开PR、合并前及一轮结束时运行，见 [ADR 0044 的现行提交规则](../../adr/0044-tests-on-cloud-server.md#commits)。

2026-09-29用户要求代码和文档不得漂移：每个改变行为的提交都在同一提交中更新受影响的文档，提交前运行严格文档校验，改到 Runbook 覆盖的代码时复核并重新封存。规则写在 `AGENTS.md` 的 “Code and Documentation Consistency” 一节。

2026-09-30 在 Hermes 上第一次跑整组单元测试，共 67 项失败，其中 64 项超时、3 项被权限检查拒绝：`/data` 是慢速机械硬盘，每次同步写入约 70 毫秒，根盘 NVMe 约 3 毫秒。用户决定测试运行中的临时数据改放根盘的任务目录，并加空间保护，其余内容仍放 `/data`，见 [ADR 0043](../../adr/0043-push-every-commit-full-test-before-merge.md#storage) [SOURCE: docs/adr/0043-push-every-commit-full-test-before-merge.md]。

reply-32 将临时根解析集中到 `@himawari-agent/testing/temporary-root`，应用测试、根夹具和 CI 均通过包名导入。Hermes 使用短路径 `/tmp/h32`，每次运行前确认不存在并以 0700 创建；记录器采样根盘余量和临时目录占用，低于 10 GiB 停止，先保留现场再清理。三项权限失败已在 NVMe、`umask 0002` 下重现，均由测试夹具未指定权限造成；修正配置文件、绑定文件和运行时目录权限，生产检查保持严格。运行命令、报告、临时根核查、包解析检查和完整验证进度见[本次验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r32-verification.md)。

NVMe 上整组 unit 首次复验为 2,143 通过、1 失败，原 67 项均已通过。新增失败来自测试把文件权限迅速改回原值，却假定状态变更时间一定不同；真实元数据诊断证实这个假定不稳定。夹具改为保留不可读权限，直接验证仅元数据读取和指纹变化，保留原断言；生产验证器未修改。定向的 Worker 与安装核验 45 项已通过，整组和最终验证结果由上述验证记录更新。

集成验证另发现开发依赖的 `vendor/seccomp` 目录为同组可写的 0775，147 项被严格工具链检查拒绝；正式安装包对应目录已由构建规范为 0755。仅修正任务开发依赖目录权限并核对文件摘要不变后，同组 22 文件、403 项均通过。另有一次准备失败清理用例返回 `srtReset: false`，后续定向与整组未重现，首轮原因尚未确定；用例保留完整 Host 结果日志用于继续诊断，不放宽断言或期限，也不宣称这个间歇失败已修复。


### reply-33：Job Host 加载期间的启动监督

本批按 [reply-33](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-33.md) 先修 Job Host 启动，再为 MCP 连接与 Agent 子测试接受超时各取 20 次证据；后两项不得先改产品或放宽期限。第 3 层与 Linux 无筛选资格等两项归因及获准修复完成后，在批次最终版本统一运行。本轮不运行 Mac 测试，用户已无限期推迟包括共享 Job Host 代码在内的 Mac 验证，不再排期，Mac 行为未验证。

Job Host 修复保留全部认证、消息类型、签名格式及原期限：先处理 IPC 和发送认证心跳，再动态加载 SRT 与策略模块；消息新鲜度按到达时判断，加载失败记录 dependencies 阶段。固定 2.5 秒加载延迟的集成红测试在 `4eeac7e` 上复现 `JOB_HOST_HEARTBEAT_EXPIRED` 与 `srtReset=false`。设计见[启动监督合同](../specs/2026-09-28-sandbox-preparation-control-recovery-design.md#startup-supervision)；实际各层结果、输入补丁和停止边界见[本批验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r33-verification.md)。
第 0 层准备监督 6 项与入口 82 项通过；第 1 层 `npm run check` 通过。第 2 层相关 integration 为 19 个文件、437 项通过；unit 整组为 2143 通过、1 失败，失败是本批另一项 MCP active 连接超时，因此暂不能提交 Job Host 修复。已继续执行原授权的测试侧阶段取证，保留失败现场，不为求绿重复整组；准确输入与逐次结果见上述验证记录。

固定取证已完成：MCP 冷缓存 9/10 通过、热缓存 10/10 通过；唯一失败保留 probe 发出 server/discover 后 3 秒到期、测试服务模块尚未加载完成的时间线。该 3 秒来自原请求资源上限，尚未改产品期限或夹具。Agent 冷、热各 10 次及一次相关并发对照均通过，原 15 秒失败的根因仍 uncertain，不标为修复或接受为限制。附加并发对照 436/437 通过，新出现 prepared-file-runner 准备子进程 20 秒超时，尚不能区分模块导入和 prepare 逻辑；按 brief 第 5 节停止扩展诊断并交 Claude 决定。无新提交，第 3 层和无筛选资格未运行。详细分类、未验证部分及下一步范围见 [stop-30](../../../.ci-output/handoff/2026-09-28-codex-round2-stop-30.md)。

### reply-34：MCP 测试夹具的准备成本

按 [reply-34](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-34.md) 保留请求资源上限中的 3000ms 连接期限。此前 Hermes 冷缓存失败发生在 echo 夹具从机械盘加载官方 SDK 和 zod 期间，没有进入工具调用；这是已复现的测试夹具加载问题，不能解释所有缺少阶段记录的历史失败。

测试使用仓库已安装的 Vite 8.2.2，将 echo 夹具和官方 SDK 依赖打成一个临时模块，再启动真实 Node stdio 子进程。产物位于测试 TMPDIR；Hermes 的记录器同时把 TMPDIR 和 HIMAWARI_TEST_TEMP_ROOT 指向根盘的任务自有 0700 目录。无需下载或新增依赖，不更改产品构建与 MCP 协议。测试继续核对服务身份、版本、当前权限和受保护输出，并用 preload 注入 4000ms 启动延迟，断言原 3000ms 连接失败且没有工具调用或输出写入。

冷、热各 10 次验收以及第 0–2 层的实际命令、版本和结果保留在[reply-34 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r34-verification.md)。冷/热标签描述运行之前对任务文件缓存的控制；测试准备阶段生成的新 bundle 自然经过写入，不宣称它是完全未驻留的冷文件。此项没有改变产品能力，也没有取得新的平台隔离资格。

Hermes 验收已完成：冷、热各10次，每次成功、撤权、固定超时三个场景，合计60/60通过；正常连接冷缓存中位303.90ms、最大338.33ms，热缓存中位333.11ms、最大411.54ms。包含待提交 Job Host 修复的组合补丁（基座 `5df887e`，第2层补丁 `fdfa46f4…`）通过定向86项、`npm run check`、unit 2145项及相关 integration 439项。严格文档校验0警告；没有运行第3层或完整产品资格。

### reply-34：Job Host 返工与取证边界

contracts 导入失败时，Worker 原来只能看到 host_failure，无法从被丢弃的基础设施 stderr 得知阶段。现在复用原有允许省略 detail 的诊断消息发送 `dependencies` 和受限系统码，Worker 仍按原协议校验；没有新增协议字段或重依赖。任务期限在有效请求解析之后立即计时，覆盖依赖导入；准备超过任务期限的真实子进程反例返回 deadline，没有启动用户任务。原入口两行注释已恢复。

Hermes 返工回归8/8通过：慢导入、同步准备、原30秒准备上限、SRT与contracts导入失败、准备期间任务到期、过期消息、签名终态和释放依据读回。MCP 已先以 `f1af23f` 提交并推送；随后在同一代码补丁上重跑整组 unit，2145/2145通过，提交前 `npm run check` 再次通过；相关19文件 integration 的439/439结果因代码未变继续有效。架构、准备控制 Spec 与四份 Runbook 同步更新并封存；Mac 验证无限期推迟，仍未验证。

本批随后仅为 prepared-file-runner 的20秒子进程期限增加失败阶段和工作根留存，在原19文件并发冷5次以及单文件冷5/热5中取证；判定和建议修法交 Claude 审阅后才能实施。Agent 原15秒失败继续开放，不再单独重复，等待后续第3层的失败证据。第3层与 Linux 无筛选资格此时均未运行。实际版本、命令和结果见[reply-34 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r34-verification.md)。

## 2026-09-30 用户暂停

用户 2026-09-30 11:50 要求全部任务暂停，几天后再继续。暂停时第二轮尚未收尾：Job Host 启动修复（`a3a11ed`）和 MCP 夹具修复（`f1af23f`）已提交；新发现的 Job Host 期限诊断分类缺陷（任务期限与准备期限两个定时器争先，诊断码与结束原因不一致）和 `prepared-file-runner` 20 秒超时的修法等待 Claude 裁定；第 3 层完整测试和 Linux 无筛选资格未跑。恢复时从上面列出的待裁定项继续，不把它们留作已知限制。

## 2026-10-01 恢复：reply-35 期限分类与 prepared 夹具

[reply-35](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-35.md) 明确批准两个修复，原期限和断言全部保留。当前工作顺序为：

1. 期限分类先确认红测试，再修复；通过第 0–2 层、同步文档并复核封存受影响 Runbook 后独立提交、立即推送。相等边界必须归任务期限，取消/结束后不再分类，见[期限诊断合同](../specs/2026-09-28-sandbox-preparation-control-recovery-design.md#deadline-classification)。
2. prepared 原失败仅在 Hermes 机械盘上确认；云端原基线冷 5 次、热 5 次合计 110/0，19 文件并发中也是 11/0，未复现这项失败。按 [reply-46 撤回复制候选](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-46.md#4-preparedd2撤回复制候选保留取证)，撤回开发模式的 `statfs` 检查及完整运行时复制，保留失败现场、子进程 `process_started`、`module_imported`、`prepare_started`、`prepare_finished` 阶段记录和产物模式的 `testTemporaryRoot()`。原 20000ms 包装期限与 10000ms 资源上限保留。这不是 D2 已修复的证明；stop-37 曾有一次 19 文件并发导入超时，剩余风险由 Pi 准备线程冷 5 次、热 5 次测量跟进。证据仍保留在 `/srv/himawari-test/round2/evidence/r36/`，每次云端测试的独占根改按 [ADR 0045 存放规则](../../adr/0045-short-test-temp-root.md#storage)通过 `mktemp -d /tmp/hXXXX` 创建，核对 10 字节、UID 1001、0700 和真实路径；失败现场先保留再删除精确运行根。新主机只有固态盘，云端结果不能证明历史机械盘失败已解决，也不能证明产品安装在机械盘上的启动速度合适。
3. 保存已有失败阶段及工作根取证。按 [reply-37](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-37.md)，MCP 夹具保留 `os.tmpdir()`，由记录器将 `TMPDIR` 指向本次scratch；不新增testing依赖，不改锁文件和边界规则。只读审查产品子进程/线程的时限起点、模块加载和准备预算，明确区分静态时序与真实缺陷；不自动修复审查发现的新问题。
4. 在批次最终版本完成第 3 层构建与完整 `npm test`，逐条读取报告；如 Agent 15 秒接受期限再次失败，保留阶段和工作根现场。Mac 验证仍无限期推迟。

用户先说明开发 Mac 的 Tailscale 已停止，并明确允许等待期间先在本地编写红测试及修复；随后更新指示：Hermes 不再可用，禁止连接或运行命令；测试改到 `84.247.157.41`，Claude 将在新 reply 文件提供访问方式和测试目录规则。在收到该文件前只做本地编辑和只读审查，不连接云服务器，不在 Mac 上运行测试、构建或 `npm run check`。收到规则后再重放原代码的红测试和 prepared 对照，再运行候选；不得将新测试主机的结果直接替代旧 Hermes 机械盘对照。开始版本为 `86e0f66`，新测试补丁与 prepared 原文件已独立保存，以免候选覆盖修复前输入；恢复之初的准备记录见[本批验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r35-verification.md)，当时尚未验证或提交；后续实际结果见下文。

reply-36 已提供云端环境和目录规则，当前从 `64b3b8d` 重放红测试并验证候选。普通测试账号、10GiB 空间门槛、失败现场先保留再清理和每次提交立即推送目前遵循 [ADR 0045](../../adr/0045-short-test-temp-root.md#storage)。第 0–2 层之后、第 3 层之前，另用真实构建运行时测量 Pi Worker 从创建到 `started` 的冷 5 次、热 5 次耗时；中位数超过 2000ms 时仅提出复现思路，交 Claude 裁定，不自行修改产品预算。证据写入[云端本批验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r36-verification.md)。

reply-37 已裁定撤销MCP helper候选，恢复第1–2层验证。系统bwrap0.9.0用于本批SRT/Job Host路径；不升级或下载0.11.2，不放宽program/MCP隔离后端的版本门槛。如果实际测试出现 `BACKEND_VERSION_UNSUPPORTED`，保留现场后交Claude裁定。本次后续结果见[reply-37验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r37-verification.md)。

reply-37 后云端第1层通过；完整unit组2150项中2134通过、16失败，Job Host 30项全部通过。失败位于5个文件，都是原5000ms测试期限；保持配置与断言不变的定向检查仍有4个文件15项失败，另外有超时后的目录清理错误。根因未确认，没有归因于bwrap版本或内存不足。按brief的范围边界写[stop-34](../../../.ci-output/handoff/2026-09-28-codex-round2-stop-34.md)，由Claude裁定这些范围外超时的调查范围；第2层未通过，不提交或推送，不把Runbook封存或后续prepared/Pi/第3层标为完成。失败现场已保留，每次scratch均清理。

reply-38按用户决定批准`HIMAWARI_TEST_TIMEOUT_MS=30000`只替换没有自设时限的项目默认值，integration、hook、用例显式时限和产品期限不变。配置及tooling合同测试已独立提交并推送`cc57e0e`：红测16项中15失败，绿测16/16通过，第1层通过，tooling整组41文件1132项通过；配置提交的严格文档校验0错误/0警告，相关Hermes历史Runbook已复核封存。Job Host完整unit在同一30000ms条件下144文件中143通过/1失败、2150项中2149通过/1失败；Job Host30项与旧16项超时全部通过，16项耗时均低于15000ms。新失败是原MCP/HTTP能力测试的Retry-After发送间隔985.293ms小于原990ms断言，根因uncertain；原19文件integration没有启动。另静态确认正式npm test的隔离env未透传新变量，直接Vitest通过不能代替此入口验证。按brief边界写[stop-35](../../../.ci-output/handoff/2026-09-28-codex-round2-stop-35.md)，不改断言或再放宽；Job Host提交及4份Runbook封存、prepared campaign、Pi测量、提前和最终第3层均未完成。结果见[reply-38验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r38-verification.md)，Mac仍未验证。

## 2026-10-01 reply-39：D11 与正式测试入口

[reply-39](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-39.md) 批准新增 D11：能力 GET 不能早于服务器要求的重试时刻。单次 985.293ms 失败的具体时钟滞后仍 uncertain；确定性回归已确认旧代码缺少等待后的单调时钟复核。修复保持原总期限、取消信号、两次发送上限、250ms 下限及原 990ms 断言，合同见[只读 HTTP 重试时刻](../specs/2026-09-24-isolated-tool-execution-design.md#readonly-http-retry) [SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#readonly-http-retry]。

正式测试入口的变量透传已提交、推送 `98b3822`：真实入口调用链的合同探针在修复前 3 项中 2 项失败，修复后与相邻配置检查共 21 项通过，第 1 层通过。该探针独立读回 5 个真实子进程的环境，不代表完整产品测试已经通过。

D11 的 3 项确定性回归已先失败再通过；完整能力测试文件 32 项通过。第 2 层按 ruling 延后到包含入口、D11 和 Job Host 三个提交的合并版本，运行完整 unit 与原 19 个 integration 文件；随后通过正式 `npm test` 入口提前执行第 3 层，最后仍在本批最终版本重复第 3 层。prepared 对照、取证提交与 Pi 冷热测量继续按 reply-36 执行，不在 Mac 上运行测试。实际命令、版本、补丁和报告见[reply-39 验证记录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r39-verification.md)。

D11已独立提交并推送 `3217e4b`，其第1层通过，4份Runbook针对该提交复核封存，严格检查0错误/0警告。Job Host候选生产代码与已审核红绿输入保持一致，复用同次第1层结果；本次随期限合同、当前云端测试规则及4份Runbook核对封存一起提交。按reply-39，前三项的第2层将在合并版本运行，不能把此前失败的完整unit报告描述为本次已通过。


## 2026-10-01 reply-45：D14 独立进程夹具与后续验证

D14 将父测试的子 Vitest 改为直接执行两个测试侧 `.mjs`，继续使用真实构建的 UDS 服务器、Agent 执行客户端、原崩溃场景及全部断言。主入口导入测量中位 3053ms，窄执行客户端导入中位约 912ms；该一次性产品启动成本未证明会触发启动超时，不另登记缺陷。窄导入 10 次合计 30/0，最终重建 3 次合计 9/0；后者 Agent 最大 1657ms、Worker 最大 6639ms，均低于 7500ms 验收线。原 15000ms 期限未改变。

父测试同时提供 artifact/context 时沿用 prepared 的现有安装器和清理流程，缺少两者时使用开发构建，缺少其中一个时报错。旧五个夹具文件按 HEAD 原样保留，原因与删除条件见 [BL-20261001-005](../../backlog/BL-20261001-005-主-分-支-接-受-政-策-后.md)。这是获准的测试侧修改，没有改产品代码。本轮第 0 层开发模式三次合计 9/0，Worker 最大 2958ms、Agent 最大 1814ms；正式 CI 构建产物的安装模式一次 3/0，Worker 最大 2373ms、Agent 最大 1819ms，三个场景均实际读取本次 scratch 的安装目录。全部样本低于 7500ms，条件均为 `HIMAWARI_TEST_TIMEOUT_MS=30000`、umask 022。第 1 层及后续实际运行结果随本批报告交付；D1、D11、D14 第 2 层按裁定由原 19 个 integration 文件合并运行补齐。之后运行 prepared 原基线冷 5/热 5，并保留 Job Host 同步命令、事件循环间隔和心跳时间线；不改人为阻塞或心跳期限。原 100 项权限失败是否消失、D13 归因和正式第 3 层均以本批实际运行报告为准。

历史完整 unit 的记录保持为：unit 第一次 2152/1 失败（Node 内部断言），同版本复跑 2153/0。Mac 验证仍无限期推迟，Linux 结果不替代 Mac。

## 2026-10-02 reply-47：D17 夹具前缀与短临时根

[reply-47](../../../.ci-output/handoff/2026-09-28-round2-claude-reply-47.md) 接受产品路径夹具的套接字长度检查，测试临时根改为 [ADR 0045 存放规则](../../adr/0045-short-test-temp-root.md#storage)规定的 10 字节 `/tmp/hXXXX`，由普通测试账号运行 `mktemp -d` 创建并核对 UID 1001、0700 和真实路径。D17 仅将 SQLite 夹具的 `himawari-sqlite-capability-invocation-` 改为 `h-`，保留所有断言、产品路径上限和其他前缀。完整控制目录在旧 35 字节根下最多 99 字节，新根下为 74 字节；其他夹具控制路径最多 77 字节，SRT 最长 105 字节，逐行静态核算见[新根路径审计](../../../.ci-output/tool-execution-audit/2026-09-28/round2/r47-socket-path-audit.json)。任意调用方指定的绝对根需要另行计算，这份表不证明任意配置都安全。

D17 改前在旧根下两个生产停止/恢复用例因 `JOB_HOST_CONTROL_PATH_TOO_LONG` 失败，证据保留在[红测试报告](../../../.ci-output/tool-execution-audit/2026-09-28/round2/cloud-r46/r36/r46-D17-red-vitest.json)。改后在旧根 `/srv/himawari-test/scratch/58ee6504` 仅做一次前后对照，[2 项均通过](../../../.ci-output/tool-execution-audit/2026-09-28/round2/cloud-r47/r36/r47-D17-old-root-green-vitest.json)，另 25 项由定向筛选未运行；新根 `/tmp/hYeze` 下整个文件 [27 项均通过](../../../.ci-output/tool-execution-audit/2026-09-28/round2/cloud-r47/r36/r47-D17-new-root-file-vitest.json)。这两次及通过的第 1 层 `npm run check` 均使用 `HIMAWARI_TEST_TIMEOUT_MS=30000`；实际根及资源采样保留在对应元数据，不把这些结果视为完整第 3 层验收。生产 `privateRoot` 的 27 字节限制由 Claude 登记为 [D18 后续缺陷](../../backlog/BL-20261002-002-生-产-privateroot-超-过-27-字-节.md)，本批不修。

## 2026-10-02 reply-46：准备与心跳计时取证

prepared 开发模式恢复直接使用真实构建目录，复制候选撤回；测试失败时仍保存工作根和准备阶段。Job Host 测试保留同步命令耗时、事件循环最长间隔与心跳时间线，原 1150ms 人为阻塞及心跳期限不变。这两部分以一个测试诊断提交交付；在已完成的 [reply-45 原 19 文件运行](../../../.ci-output/tool-execution-audit/2026-09-28/round2/cloud-r45/r36/r45-integration-19-vitest.json)中，prepared 11/0、准备控制 8/0，心跳用例通过；该次 437/2 的两项失败均为随后修复的 D17 路径过长。事件循环最长间隔 1185ms 包含人为阻塞，阻塞结束后 34ms 发出心跳，D13 仍为 uncertain。本次撤回复制并保留统一临时根之后，新根下这两个文件合计 19/0，第 1 层 `npm run check` 也通过，严格文档校验 0 错误、0 警告；这些云端结果均在 `HIMAWARI_TEST_TIMEOUT_MS=30000` 下得到。结果见[诊断定向报告](../../../.ci-output/tool-execution-audit/2026-09-28/round2/cloud-r47/r36/r47-diagnostics-focused-vitest.json)。失败归因以证据为准，不把增加诊断视为产品修复。

## D21：期限后交付测试的受控计时器

`thread-run-lifecycle` 的期限后交付矩阵保留原 `maximumRunDurationMs: 1000` 和 `ManualClock`，仅在初次协调执行期间控制 `setTimeout` / `clearTimeout`。原来的真实期限回调会在 SQL 操作耗时超过 1 秒时先触发，而测试逻辑时钟仍停在起点，导致测试没有走到预设的输出持久化崩溃点。现在用受控计时器保持两者一致，初次执行结束后恢复真实计时器，再把逻辑时钟明确推进到原期限之后，验证已保存答复交付一次、模型及策略均不重跑。

`[R2-D21]` 的两个崩溃场景在 worker 和 direct 路径都保留第一次检查点读取的 1100ms 真实延迟。修复前这四例均因期限中断失败，其他八例通过；这项测试设计修正不改变产品期限计算、生产计时器或 Pi 的运行循环。取消、恢复输入拒绝、检查点冲突及正常交付断言继续保留。Hermes 默认时限下的原始报告、补丁和复跑环境见[本批证据目录](../../../.ci-output/tool-execution-audit/2026-09-28/round2/hermes-r52/)，各层实际结果和提交号由[停止文件](../../../.ci-output/handoff/2026-10-02-codex-round2-hermes-stop-02.md)给出；Mac 未在本批运行验证。

[返回阅读导航](#阅读导航)
