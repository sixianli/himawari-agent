---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-30"
covers: "apps/execution-worker/src/production-sandbox-execution-v2.ts, packages/application/test/thread-execution-state.unit.test.ts, packages/persistence-sqlite/src/sqlite-run-resource-guard.ts, test/integration/sqlite-sandbox-execution-v2.test.ts, test/integration/sqlite-web-push.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0127：命令结果未知且沙箱资源都已释放时，本轮立刻收尾；失败推送写明原因

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-30 14:44（日本时间），Andy 的手机收到“没有完成”的推送，点开是 14:13 就已经显示出结果的那一轮“写一个简易小游戏”（[事故 I-41](../incidents-and-gates.md#incidents)）。

生产数据库和日志（Mac 线程只读导出，`run-2e5744db-*.txt`）里的事实：

- 14:13:42（05:13:42Z）最后一条 bash 命令跑完，沙箱记录里的结果是“退出未知”（`SANDBOX_EXIT_UNKNOWN`，结果类型 unknown，没有退出码和结束方式）。命令本身是一段普通的 Python 脚本加 `node --check`，没有后台进程。
- 这一轮留着 3 条沙箱记录（写文件、改文件、bash），全部在 14:13:15、14:13:29、14:13:42 拿到了释放凭证，占用也全部释放，没有阻挡项，没有后台占用。
- 因为结果未知，这一轮停在“核对外部结果”（`reconciling_external_result`），之后没有任何记录。
- 14:43:36 它才被期限清理改成“失败”，比 bash 那条记录自己的 30 分钟期限（`originalDeadlineAt` 05:43:35.795Z，[ADR 0098](0098-move-long-bash-commands-to-background.md) 规定每条 bash 命令期限是开始时间加 30 分钟）晚 1 秒；5 秒后推送发出。

根因：收尾规则（`RUN_EXPIRED_RECONCILIATION_SQL`，`packages/persistence-sqlite/src/sqlite-run-resource-guard.ts`）对“命令结果未知”只有一条快路径：沙箱里完全没有记录。只要有记录，就要等“所有记录的期限都过了”，规则没有区分已经释放的记录和还在占用的记录，所以明知资源早已干净，仍然等 bash 记录自己的 30 分钟。

没有查清的一点：bash 为什么被记成“退出未知”。判定要求“任务已启动、进程已退出、输出管道已关闭、拿到退出码”四项同时成立（`apps/execution-worker/src/production-sandbox-execution-v2.ts`），这四个值用完就丢，数据库和日志里都没有。这次先加日志，下次再出现就能定位。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

2026-10-30 实际打开的一手资料：

- Apple 推送规范（Human Interface Guidelines，Notifications）：“Avoid sending multiple notifications for the same thing, even if someone hasn’t responded.”；“A notification gives people timely, high-value information they can understand at a glance.”。https://developer.apple.com/design/human-interface-guidelines/notifications
- Apple 管理通知（Managing notifications）：Time Sensitive 只用于“happening now or will happen within an hour”的事。https://developer.apple.com/design/human-interface-guidelines/managing-notifications
- GitHub 工作流通知：任务结束（成功、失败、取消）都会通知，用户可以选择“only when a workflow run has failed”，也就是说失败通知本身不隐藏。https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/notifications-for-workflow-runs
- Temporal 活动超时：卡住的任务没有超时，用户会遇到 “an indefinite delay ... with no feedback”，所以要尽早判超时。https://temporal.io/blog/activity-timeouts

没有一手资料回答的问题：外部结果未知的任务，在资源已确认清理完毕时，是否应该提前判失败。这是本项目自己的判断，依据是本 ADR“背景”里的事实：这一轮“核对外部结果”之后没有任何东西会去核对。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **收尾规则**：一轮处于“核对外部结果”、原因是命令结果未知时，只要它的全部沙箱记录都已有释放凭证、没有未释放占用、没有阻挡项、没有后台占用，就立刻收尾为失败，不再等记录自己的期限。仍有未释放资源时，行为不变，照旧等期限。收尾后的诊断码保持“结果未知”（`RUNTIME_TOOL_RESULT_UNKNOWN`），期限到点才收尾的仍用 `RUN_EXECUTION_DEADLINE_EXCEEDED`。
2. **页面**：这样收尾的一轮，状态原因显示“有一条命令的结果没能确认，本轮已结束，没有生成回答。继续前请先核实命令做了什么”（`chat.reason.toolResultUnknown`，三语）。
3. **推送**：失败照常推送，不隐藏（GitHub 同做法）。这种收尾的一轮，推送标题写“命令结果没确认，本轮已结束”（`unconfirmed`，三语），不再是笼统的“没有完成”。收尾提前后推送会在命令结束后几秒内发出，页面在前台时现有的“前台不推”规则照常生效。
4. **日志**：命令结果被记成“退出未知”时，输出 `sandbox.exit.unknown`，带 `taskStarted`、`taskProcessExited`、`stdioClosed`、`exitCodeKnown` 和结束原因，用来查清“为什么未知”。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **期限清理补出的失败不再推送**：没有任何一手资料支持隐藏失败通知（GitHub 反而默认通知失败），而且会让用户不知道这一轮没有生成回答。放弃。
- **只缩短 bash 的 30 分钟期限**：30 分钟是后台命令的设计（ADR 0098），缩短会破坏它；而且问题不在期限长，在于规则不看释放状态。放弃。
- **结果未知一律立刻失败，不看释放**：资源还没释放就收尾，等于放弃清理。放弃。
- **先只加“沙箱里没有记录”的提前收尾**：已写好并测过，但这一轮有 3 条记录，它救不了这次事故，所以没有采用。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 同样的情况下，这一轮会在命令结束后几秒内收尾，页面和推送都写明原因，不再拖 30 分钟。
- 门槛：`test/integration/sqlite-sandbox-execution-v2.test.ts` 的“settles an expired unknown Run without dispatching”新增场景 `before-deadline`（记录已释放、期限未到，必须收尾，旧代码上失败）、`absent-before-deadline`（没有沙箱记录，旧代码上失败）和反向场景 `unreleased-before-deadline`（有记录未释放，必须继续等）；`packages/application/test/thread-execution-state.unit.test.ts` 和 `test/integration/sqlite-web-push.test.ts` 覆盖页面原因和推送区分。改前 4 例失败，改后通过。
- 未验证：真实生产上这样收尾后的页面和推送。“命令为什么被记成退出未知”仍未查清。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [事故与门槛清单 I-41](../incidents-and-gates.md#incidents)
- [工程案例库：案例 70](../engineering-casebook.md#case-unknown-result-late-settle)
- [ADR 0098：长命令转后台](0098-move-long-bash-commands-to-background.md)
- [ADR 0125：模型写工具参数时只记进度](0125-streamed-tool-call-recorded-as-progress-not-snapshots.md)

[↑ 返回阅读导航](#contents)
