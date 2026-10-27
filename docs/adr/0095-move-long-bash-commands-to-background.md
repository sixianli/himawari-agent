---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-27"
---

# ADR 0095：bash 命令超过等待时间转入后台继续运行，结束时主动通知模型

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

- Claude Code：前台命令到了超时不杀，自动转入后台，返回任务编号和输出文件；后台命令结束或到达后台时间上限时，Claude 会“再走一轮”看结果，无人值守时后台默认最长 30 分钟、最多 2 小时；退出时清理全部后台任务。
- Codex：`exec_command` 等待 `yield_time_ms`（250–30000 毫秒）后交回已有输出和会话编号，之后要模型自己用 `write_stdin` 轮询。公开 issue openai/codex#38495 报告了轮询的代价：一次删除命令让模型等了 90 轮，约 2160 万输入 token。
- OpenHands：命令 30 秒没有新输出就暂停并交回，模型发空命令继续看、发 `C-c` 中断，同样靠模型轮询。
- Pi 社区扩展 omp-unified-exec：进程结束时用 Pi 的 `sendCustomMessage(..., { triggerTurn: true, deliverAs: "followUp" })` 唤醒 Agent，不打断正在进行的一轮；pi-processes 在 Agent 正忙时用 steer（插到下一次模型调用之前）送达。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **超过等待时间不杀，转入后台。** 模型调用 `bash` 时，Himawari 在工具层（`apps/agent-service/src/production-background-commands.ts`，由 `ProductionRuntimeTools.execute` 调用）先等最多 `deadlines.commandWaitMs`（默认 30 秒）。命令在这段时间里结束，照旧把结果交给模型；没结束，就立刻交给模型一条“已转入后台”的结果，里面有任务编号（`background-command:` 加 24 位十六进制）、“结束时会自动通知你，不要反复查询”的说明和最晚停止时间。命令本身继续在原来的前台沙箱路径里跑，所以仍复用常驻沙箱、仍走原有的失败输出、效果未核实提醒和结果恢复逻辑。
2. **最长时长单独设置。** `bash` 这一种操作的墙钟和 CPU 上限改用 `deadlines.backgroundCommandMs`（默认 30 分钟），不再用 `workerRequestMs`；实际上限仍取它、沙箱签名里的上限、执行句柄有效期、本轮截止时间四者中最小的一个。生产要真正跑满 10 分钟以上，还需要放宽 `runMs` 和沙箱签名里的上限，这个数字由 Andy 决定（见[后果](#consequences)），代码不写死。
3. **结束时主动通知，不靠轮询。** 运行时适配层（`packages/runtime-pi/src/pi-runtime-adapter.ts`，Himawari 自己的代码，不改 Pi）订阅本轮的后台命令：
   - 模型还在工作时，用 Pi 的 `sendCustomMessage(..., { deliverAs: "steer" })` 把“后台命令已结束”的消息插到下一次模型调用之前；
   - 模型已经答完、但本轮还有后台命令在跑时，这一轮先不结束，等命令结束（或到本轮截止时间、或用户停止），再用 `sendCustomMessage(..., { triggerTurn: true })` 让模型看着结果再答一轮。这和 Claude Code 无人值守时“再走一轮”的做法一致。
   - 通知是 `himawari.background.command` 类型的自定义消息，不显示成用户发的话，会进入对话历史。
4. **沿用三个管理工具。** `execution_task_status`、`execution_task_output`、`execution_task_cancel` 认得 `background-command:` 编号：状态返回运行中、已结束或已停止；输出在命令结束后分页读取（运行中返回空并说明原因）；停止会中止这次调用，沿用原有的“发 `work.cancel` 给执行进程”路径，并在通知里写明“已按你的要求停止，命令可能只执行了一部分”。只能管理本轮的命令。
5. **只在有用时才发管理工具。** 只有存在可启动的后台任务（`execution_task_start`），或本轮发给模型的工具里有 `bash` 且后台功能开启时，才把三个管理工具发给模型。
6. **本轮结束就清理。** 本轮结束、失败、被停止或因等待审批而暂停时，适配层调用 `stopBackground`，中止本轮全部后台命令，不再发通知；原有的 `resources.stopRun` 照旧回收沙箱资源。服务重启时进程内的后台命令随服务一起结束，重启后的结果核查沿用现有恢复流程。
7. **授权不变。** 转入后台的命令在开始前已经按原规则通过授权（`bash` 风险仍为 HIGH、仍按顺序执行）；转后台只是不再等它，不新增权限。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：工具层等待窗口 + 本轮内通知（选用）

- 好处：不改沙箱协议和能力绑定，仍复用常驻沙箱和前台的全部失败处理；通知用 Pi 自带的自定义消息和 steer，不改 Pi；业界主流（Claude Code）的行为。
- 代价：转后台那一刻和运行期间读不到已有输出（前台沙箱只在结束时交回结果，记为 [BL-20261027-011](../backlog/BL-20261027-011-background-command-live-output.md)）；后台命令活不过本轮。

### 方案 B：每条 bash 都按后台模式启动，主机端等待

- 好处：已有输出分页、状态记录、恢复都是现成的。
- 代价：生产绑定没有声明后台模式，要改签名和部署；后台模式不复用常驻沙箱，每条命令多出数秒新建沙箱的时间（[ADR 0054](0054-readonly-tools-in-host-and-reused-task-sandbox.md) 记录过 7–14 秒）；[BL-20261016-003](../backlog/BL-20261016-003-后-台-和-服-务-模-式-的.md) 里三处失败处理和前台不一致。不选。

### 方案 C：照 Codex 返回会话编号，让模型轮询

- 好处：实现最简单。
- 代价：openai/codex#38495 证明轮询会烧掉大量 token，而且模型分不清安静运行和卡死。Andy 关注 token。不选。

### 方案 D：后台命令跨轮存活，结束时由系统另起一轮

- 好处：最接近 Claude Code 交互模式，命令跑完前用户可以继续聊别的。
- 代价：要让沙箱资源、执行句柄、目录授权不再以本轮为界，还要新增“系统发起一轮回答”的入口和对话归档时的清理，改动面大。记为 [BL-20261027-012](../backlog/BL-20261027-012-background-commands-outlive-turn.md)，以后再定。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：30 秒以上的命令不再卡住模型；命令结束模型一定会收到结果，不用反复查询；管理工具只在有对象时出现。
- 坏处：本轮回答会等后台命令结束，现在同时只能跑一轮回答，命令跑的这段时间其他对话要排队；后台命令跑完前读不到输出；等待审批会停掉本轮的后台命令。
- 生产生效条件：代码默认等待 30 秒、最长 30 分钟，但生产实际上限仍被 `runMs`（300 秒）和沙箱签名（墙钟 300 秒、CPU 30 秒）卡住。2026-10-27 已请 Andy 选择放宽到 30 分钟、10 分钟或保持不变；选定后改生产配置 `deadlines.runMs`、`deadlines.backgroundCommandMs` 和签名模板 `scripts/delivery-mode/packet-template/signing/cloud-seal.mjs` 里的 `maximumResourceCeiling`，随“完整版本”一起上线。
- 验证范围：适配层的通知和等待用真实的 Pi 0.84.2 会话（测试用的确定性模型）验证；后台命令登记、通知、状态、分页、停止和清理有单元测试；管理工具是否发给模型有单元测试。没有在生产沙箱里实际跑一条超过 30 秒的命令，这要在上线验收时做。
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
