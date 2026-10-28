---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-27"
---

# ADR 0098：bash 长命令转入后台，本轮先答完，命令跑完后系统另起一轮汇报

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

模型在 Himawari 里用 `bash` 工具（让模型在授权目录的沙箱里执行一条 shell 命令）跑命令时，只能在前台等它跑完。2026-10-27 复盘“贪吃蛇”对话时确认了三个问题：

1. 前台等待有硬上限。每次工具调用的墙钟上限是配置里的 `deadlines.workerRequestMs`（生产 120 秒），沙箱签名里的上限是墙钟 300 秒、CPU 30 秒，再加上一轮回答（Run，用户发一条消息后系统完成回答的整个过程）最多 `deadlines.runMs`（生产 300 秒）。命令超过这些上限就被杀掉，模型只拿到“已超时并清理”的结果，10 分钟的测试根本跑不完。
2. 已有的后台能力用不上。`execution_task_start`（启动一个事先授权、绑定为后台模式的命令）要求能力绑定里声明 `background`/`task_start`，现行生产绑定没有声明（[BL-20261016-003](../backlog/BL-20261016-003-后-台-和-服-务-模-式-的.md)）；后台模式也不走 [ADR 0054](0054-readonly-tools-in-host-and-reused-task-sandbox.md) 的“同一轮复用常驻沙箱”路径，每次都要新建沙箱。
3. 就算后台任务跑起来，跑完也没有通知，模型只能自己反复调 `execution_task_status` 查。另外，没有任何启动工具时，`execution_task_status/output/cancel` 三个管理工具照样发给模型，模型能看到却没有可管理的对象。

业界做法（来源和原文摘录见[关联文档](#references)）：

- Claude Code：前台命令到了超时不杀，自动转入后台，返回任务编号和输出文件；后台命令结束或到达后台时间上限时，Claude 会“再走一轮”看结果，无人值守时后台默认最长 30 分钟、最多 2 小时；退出时清理全部后台任务。交互模式下后台命令跑着时用户照常发下一条消息。
- Codex：`exec_command` 等待 `yield_time_ms`（250–30000 毫秒）后交回已有输出和会话编号，之后要模型自己用 `write_stdin` 轮询。公开 issue openai/codex#38495 报告了轮询的代价：一次删除命令让模型等了 90 轮，约 2160 万输入 token。
- OpenHands：命令 30 秒没有新输出就暂停并交回，模型发空命令继续看、发 `C-c` 中断，同样靠模型轮询。
- Pi 社区扩展 omp-unified-exec：进程结束时用 Pi 的 `sendCustomMessage(..., { triggerTurn: true, deliverAs: "followUp" })` 唤醒 Agent，不打断正在进行的一轮；pi-processes 在 Agent 正忙时用 steer（插到下一次模型调用之前）送达。

第一版（同一 PR 的较早提交）让后台命令只活在本轮里：模型答完后这一轮还要等命令结束再补答，期间这个对话发不了下一条。Andy 看了原型后在 2026-10-27 15:33（日本时间）要求照 Claude Code 做完整版，原话：

> 就不能完全像 Cloud Code 一样吗？这第一轮如果有一个长命令一直在后台跑，那么也不能阻止用户跑第二轮呢，对不对？就只能说，如果这个命令跑完了，它自己主动汇报它的结果的话，然后模型的话又再来根据工具的输出结果，然后再跑一轮。

随后在选择卡上选了“现在就做完整版”。本 ADR 记录的是完整版的决定，第一版没有合进 main，所以直接改写，不另开 ADR。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **超过等待时间不杀，转入后台。** 模型调用 `bash` 时，工具层（`apps/agent-service/src/production-background-commands.ts`）先等最多 `deadlines.commandWaitMs`（默认 30 秒）。命令在这段时间里结束，照旧把结果交给模型；没结束，就交给模型一条“已转入后台”的结果：任务编号（`background-command:` 加 24 位十六进制）、“可以先回答用户，结束时系统会通知你，不要反复查询”、最晚停止时间。命令继续在原来的前台沙箱路径里跑，仍复用常驻沙箱，失败输出、效果未核实提醒和结果恢复逻辑不变。转后台以后命令不再跟着 Pi 会话的取消信号走，只在等待窗口里跟随。
2. **本轮先答完，轮次“挂着”不结束。** 模型答完时，如果本轮还有后台命令在跑（或跑完了还没送达模型），运行协调器（`packages/application/src/services/run-coordinator.ts`）不清理资源，而是把回答连同后台命令清单交给 `completeRun` 的 `background` 参数。数据库在一个事务里：写入回答、把这一轮的 turn 标为已提交、在新表 `run_background_holds`（迁移 0059）登记每条后台命令，轮次状态保持 `running`。不新增轮次状态：`runs.status` 的取值约束要重建 `runs` 表才能改，而保持 `running` 时回执、执行租约、`assertRunActive`、工作进程每 250 毫秒的复核这些执行许可检查全部原样有效。
3. **不挡住下一条消息。** 排队查询 `listClaimable` 和领取时的复核不再让“回答已提交”的更早轮次挡住同一对话后面的轮次；排队和对账都跳过有未放登记的轮次。挂着的轮次不占调度器的并发名额。网页把“已回答、只剩后台命令”的轮次当作已结束：可以发送、回答下方显示“后台命令运行中 · 已运行 2m 14s · 停止”。
4. **看守后台命令。** 调度器把挂着的轮次交给 `ProductionBackgroundRuns`（`apps/agent-service/src/production-background-runs.ts`）：每 10 秒续一次执行租约（租期 30 秒），等命令全部结束后先停掉这一轮的沙箱环境，再调用 `finishBackgroundRun`。续租失败就停掉命令，交给重启恢复。
5. **跑完由系统另起一轮汇报。** `finishBackgroundRun` 在一个事务里：确认沙箱资源已放、执行租约仍有效，给登记写上结果（completed、failed、stopped、timed_out、interrupted），把原轮次标为 completed、放掉租约，同时新建一轮“系统通知”回答：触发来源 `external_event`、对话里一条 `system` 消息（内容加密存放，开头写明“系统通知，不是用户发的消息”，列出每条命令的结果和输出）、沿用原轮次的会话和模型选择。这一轮照常排队，模型看着结果和这期间的聊天上下文再答一次。通知的编号由原轮次编号算出，重复调用只生效一次。
6. **停止。** 网页上的“停止”仍发 `thread.run.cancel`；服务端先问看守者，轮次正挂着后台命令时只停命令（沿用 `work.cancel` 路径），然后照第 5 条另起一轮，通知里写“已按要求停止，命令可能只执行了一部分”。模型自己可以用 `execution_task_cancel` 停同一对话里的后台命令。
7. **重启。** 服务重启时进程里的后台命令随服务一起结束。调度器每次巡检调用看守者的 `recover()`：执行租约已过期、仍有未放登记的轮次，先停沙箱环境，再以 `interrupted` 结束并另起一轮，通知里写明“结果没有拿到，重新执行前先核实已经产生的效果”。
8. **沿用三个管理工具，只在有用时发。** `execution_task_status/output/cancel` 认得 `background-command:` 编号，可以管理同一轮或同一对话里的后台命令。只有存在可启动的后台任务（`execution_task_start`），或本轮发给模型的工具里有 `bash` 且后台功能开启时，才把三个管理工具发给模型。
9. **授权不变。** 转入后台的命令在开始前已经按原规则通过授权（`bash` 风险仍为 HIGH、仍按顺序执行）；挂着的轮次仍受同一套执行许可约束，不新增权限。不改 Pi：用 Pi 0.84.2 自带的 steer 在模型还在工作时插入结果；模型答完后的汇报由 Himawari 另起一轮完成。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：工具层等待窗口 + 跨轮挂起 + 系统另起一轮（选用）

- 好处：和 Claude Code 交互模式一致，命令跑着时用户照常聊天；不改沙箱协议和能力绑定，仍复用常驻沙箱和前台失败处理；执行许可检查一处没放宽；不靠模型轮询。
- 代价：转后台那一刻和运行期间读不到已有输出（[BL-20261027-011](../backlog/BL-20261027-011-background-command-live-output.md)）；挂着期间这一轮的沙箱环境一直占着。

### 方案 B：本轮内等命令结束再补答（第一版）

- 好处：改动小，生命周期仍以一轮为界。
- 代价：命令跑完前这个对话发不了下一条，现在同时只能跑一轮回答，其他对话也要排队。Andy 明确否定（见[背景](#context)）。

### 方案 C：新增轮次状态 `background_waiting`

- 好处：状态一眼看得出。
- 代价：SQLite 改取值约束要重建 `runs` 表，几十张表的外键指向它；所有执行许可检查都要加例外。不选。

### 方案 D：每条 bash 都按后台模式启动，主机端等待

- 代价：生产绑定没有声明后台模式，后台模式不复用常驻沙箱（[ADR 0054](0054-readonly-tools-in-host-and-reused-task-sandbox.md) 记录过 7–14 秒新建时间），失败处理和前台不一致（[BL-20261016-003](../backlog/BL-20261016-003-后-台-和-服-务-模-式-的.md)）。不选。

### 方案 E：照 Codex 返回会话编号，让模型轮询

- 代价：openai/codex#38495 报告轮询会烧掉大量 token，模型也分不清安静运行和卡死。Andy 关注 token。不选。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：30 秒以上的命令不卡住对话；命令跑完一定会有一轮汇报；重启、停止、超时都会告诉用户结果；管理工具只在有对象时出现。
- 限制一：后台命令的最长时间是 `deadlines.backgroundCommandMs`，2026-10-28 Andy 定为 30 分钟（原话“30 分钟”），并要求和一轮回答的总时限脱钩（原话“现在脱钩”）。做法：每条 bash 命令开始时记下自己的截止时间“开始时刻 + 30 分钟”（存成这一轮的一条记录，重启后恢复用同一个值），这条命令的执行句柄（系统发给这一次工具调用的一次性执行许可）、沙箱执行计划和结果恢复都用它，不再取本轮截止时间；命令另外仍受目录授权到期时间和沙箱签名上限约束。其他工具和普通一轮回答仍用 `deadlines.runMs`（生产 5 分钟）。为让同一轮里后开始的命令也能用满 30 分钟，这一轮沙箱环境的期限改为“第一次用沙箱时的截止时间 + 30 分钟”（不超过目录授权到期时间）；轮次到期结算对 bash 计划放行比本轮更晚的截止时间，仍要求计划期限已过、资源已释放。签名模板 `scripts/delivery-mode/packet-template/signing/cloud-seal.mjs` 的 `maximumResourceCeiling` 在本 PR 改为墙钟 1800000 毫秒、CPU 1800000 毫秒（下一次出包生效）。前提：`runMs` 不大于 `backgroundCommandMs`；否则同一轮很晚才开始的命令会超过沙箱环境期限，被沙箱以 `SRT_ENVIRONMENT_DEADLINE_EXCEEDED` 明确拒绝。原来“上线时把 `runMs` 放宽到 35 分钟”的做法不再需要，[BL-20261028-001](../backlog/BL-20261028-001-background-command-deadline-independent-of-run.md) 已随本 PR 关闭。业界做法相同：Claude Code 的后台命令跨轮运行，直到结束或 Claude Code 退出；Codex 的后台终端会话也比单次工具调用活得久（见[关联文档](#references)）。
- 限制二：挂着期间这一轮的沙箱环境和工作目录占用不释放；同一工作目录的下一轮会不会因此排队，没有在真实沙箱里验证。
- 限制三：第一轮的回答不单独发手机推送，推送来自汇报那一轮。
- 限制四：网页上的后台提示行不显示命令原文：登记表不保存命令（命令可能含敏感内容，内容只放在加密的通知里）。命令原文在这一轮的执行过程里能看到。
<a id="release-steps"></a>
- 上线时要改的生产项（随“完整版本”，由负责上线的线程执行，改前备份 `/etc/himawari/config.json`）：
  1. 生产配置 `deadlines.runMs` 保持 300000 不改。
  2. 生产配置写明 `deadlines.backgroundCommandMs: 1800000`（和代码默认值相同，写出来便于核对）；`deadlines.commandWaitMs` 不写，用默认 30 秒。
  3. 用本分支合并后的签名模板重新出包，新的沙箱签名上限是墙钟 1800000 毫秒、CPU 1800000 毫秒；旧签名下命令仍会在 300 秒 / CPU 30 秒被停。
  4. 验收：在生产网页让模型跑一条超过 30 秒的命令（例如 `sleep 45; echo done`），确认第一轮先答完、能发第二条消息、命令结束后系统另起一轮汇报。再跑一条超过 5 分钟的命令（例如 `sleep 400; echo done`），确认它没有在一轮回答的 5 分钟时被停。
- 验证范围：持久层、协调器、调度器、看守者有单元和集成测试；命令单独计时有测试 [BG-8]（执行句柄拿到“开始 + 30 分钟”而不是本轮 5 分钟，同一调用再进入时值不变；沙箱环境期限覆盖最晚开始的命令；bash 计划期限晚于本轮时到期结算仍能完成），三条都先在改动前跑失败；一条端到端集成测试用真实 Pi 0.84.2 会话和确定性测试模型走完“第一轮答完 → 第二条消息照常回答 → 命令结束 → 系统另起一轮汇报”。没有在生产沙箱里实际跑一条超过 30 秒的命令，这要在上线验收时做。
- 案例：[工程案例库案例 33](../engineering-casebook.md#case-background-bash)。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md]
- [SOURCE: docs/backlog/BL-20261016-003-后-台-和-服-务-模-式-的.md]
- [SOURCE: docs/backlog/BL-20261027-011-background-command-live-output.md]
- [SOURCE: docs/backlog/BL-20261027-012-background-commands-outlive-turn.md]
- [SOURCE: docs/engineering-casebook.md]
- Claude Code 官方文档 [Tools reference](https://code.claude.com/docs/en/tools-reference)：“When a foreground command reaches its timeout without finishing, Claude Code moves it to the background instead of stopping it”。
- Claude Code 官方文档 [Environment variables](https://code.claude.com/docs/en/env-vars)：`BASH_DEFAULT_TIMEOUT_MS`“default: 120000”，`BASH_MAX_TIMEOUT_MS`“default: 600000”。
- Claude Code 官方文档 [Interactive mode](https://code.claude.com/docs/en/interactive-mode)：“Background tasks are automatically cleaned up when Claude Code exits”。
- OpenAI Codex 源码 [unified_exec/mod.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/mod.rs)：`MIN_YIELD_TIME_MS` 为 250，`MAX_YIELD_TIME_MS` 为 30_000；Codex 配置文档 [Config reference](https://developers.openai.com/codex/config-reference) 的 `background_terminal_max_timeout` 默认 300000。
- OpenAI Codex issue [#38495](https://github.com/openai/codex/issues/38495)：轮询等待长命令消耗大量输入 token（数字为该 issue 作者报告，未复现）。
- OpenHands [terminal 工具定义](https://github.com/OpenHands/software-agent-sdk)：“the command will instead pause and ask for confirmation when it produces no new output for 30 seconds”。
- Pi 社区扩展 [omp-unified-exec](https://github.com/mouriya-s-lab/omp-unified-exec)：结束通知用 `triggerTurn: true` 和 `deliverAs: "followUp"`，“never interrupt a running turn”。
- Pi 0.84.2 `AgentSession.sendCustomMessage` 类型说明（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`）：“Streaming: queues message, processed when loop pulls from queue … Not streaming + triggerTurn: appends to state/session, starts new turn”。
