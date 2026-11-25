---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0023-durable-hitl-execution.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0035-tool-deadline-continues-run.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0040-background-output-closed-after-bash-returns.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0053-workspace-auto-approval-like-codex.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0077-workspace-risk-by-operation.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0078-authority-check-once-then-version-compare.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0079-parallel-read-only-tools-and-host-web-tools.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0097-bash-writes-workspace-with-change-ledger.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0098-move-long-bash-commands-to-background.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0119-conversation-speed-prewarm-on-tool-call-and-embedding-retry.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0125-streamed-tool-call-recorded-as-progress-not-snapshots.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0127-settle-unknown-result-run-once-resources-released.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0139-prewarmed-environment-outlives-background-commands.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0140-settle-early-only-without-recoverable-result.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0141-tolerate-transient-broker-errors-while-polling-a-running-command.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0144-log-commands-silent-for-30-seconds-without-stopping-them.md"
superseded_by: ""
date: "2026-11-26"
covers: "apps/agent-service/src/production-background-commands.ts, apps/agent-service/src/production-background-runs.ts, apps/agent-service/src/production-payload-broker-handler.ts, apps/agent-service/src/production-workspace-ledger.ts, apps/agent-service/src/production-tool-call-prewarm.ts, apps/agent-service/src/production-task-environments.ts, apps/agent-service/src/production-run-dispatcher.ts, apps/execution-worker/src/production-sandbox-execution-v2.ts, apps/execution-worker/src/broker-poll-tolerance.ts, packages/platform-node/src/public-web-egress.ts"
verified_at: "7d0ffcd52cbb69d4941871cf9bf08d93f3843da8"
---

# ADR 0299：工具调用和命令的生命周期

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [批准和恢复](#approval)
  - [工作区里自动放行，其余先问](#auto-approval)
  - [授权只查一次，之后比版本号](#authority)
  - [并行的只读工具和网页工具](#parallel)
  - [命令可以改工作区，留改动记录](#ledger)
  - [超时、后台命令和输出](#long-commands)
  - [预热和环境期限](#prewarm)
  - [结果未知时的收尾](#unknown)
  - [流式工具调用和日志](#progress)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

一次工具调用从模型写出它、经过批准、在沙箱里执行、到结果回到模型，中间每一步怎么做，原来分散在十六份 ADR 里（0023、0035、0040、0053、0077 到 0079、0097、0098、0119、0125、0127、0139 到 0141、0144），后面的多次修正前面的。这份 ADR 只写现在为真的做法。工具在哪里执行、怎样隔离，见 [ADR 0298](0298-where-tools-run.md)。旧文全文在 `supersedes` 列的固定提交链接里。

<a id="decision"></a>

## 决定

<a id="approval"></a>

### 批准和恢复

- 需要主人批准的动作，运行停在 `awaiting_approval`。批准或拒绝写成持久记录；恢复由持有租约（一段时间内只许一个进程接手的占用记录）的进程按记录继续，批准这一动作本身不执行任何东西。
- 已经发出但没确认结果的外部动作进入 `reconciling_external_result`，只对账，不自动重发。

<a id="auto-approval"></a>

### 工作区里自动放行，其余先问

- 在主人授权的工作区里，读、写、编辑和不联网的沙箱命令直接放行（`ALLOW`），做法参照 Codex 的工作区自动批准。
- 写工作区以外的地方、联网的命令、推送、对外发送、碰密钥，先问（`ASK`）。
- 风险按操作分级：read、ls、find、grep 为低；write、edit 为中；bash 为高；网页工具为中；删除为高；不可恢复的删除为最高。

<a id="authority"></a>

### 授权只查一次，之后比版本号

- 一次运行第一次调用工具时完整核对一次授权，之后只比对授权版本号 `authority_revision`（授权一变，数据库触发器就加一）。同一结果最多复用 60 秒（`RESOLVED_AUTHORITY_REUSE_MS`）。
- 撤销授权通过 250 毫秒一次的轮询被发现，正在跑的命令随之停止。

<a id="parallel"></a>

### 并行的只读工具和网页工具

- web_search、web_fetch 在服务进程里执行，统一经 `packages/platform-node/src/public-web-egress.ts` 和共用的 undici 连接器出网，不进沙箱。
- 只读工具标成 `executionMode: "parallel"`，可以同时跑；write、edit、bash 若被标成并行，直接拒绝。

<a id="ledger"></a>

### 命令可以改工作区，留改动记录

- bash 在工作区里可以读、建、改文件；受保护的文件名仍然挡住。
- 命令前后对工作区拍快照并比出差异（`snapshotWorkspace`），形成改动记录；记录做不出来时报 `WORKSPACE_LEDGER_UNAVAILABLE`，不假装成功。

<a id="long-commands"></a>

### 超时、后台命令和输出

- 工具超过时限时报 `SANDBOX_TOOL_DEADLINE_EXCEEDED`，模型收到固定说明，不自动重跑，这一轮继续。
- 命令前台最多等 `commandWaitMs`（默认 30 秒），还没结束就转为后台，模型拿到 `background-command:` 开头的编号。后台命令登记在 `run_background_holds` 表；`ProductionBackgroundRuns` 每 10 秒续一次租约；命令结束后用一轮系统通知把结果告诉模型；服务重启时没结束的记成 `interrupted`。
- 主进程退出后，再静默 100 毫秒就关掉标准输出，不等后台子进程；结果文字提示模型把长输出重定向到文件。

<a id="prewarm"></a>

### 预热和环境期限

- 模型在流式输出里一开始写 bash、write、edit 的调用（`toolcall_start`），就预热沙箱（`apps/agent-service/src/production-tool-call-prewarm.ts`），同一轮只预热一次；预热失败只写诊断，真正的调用照常冷启动。
- 预热建的环境和命令自己建的环境用同一个期限算法 `environmentDeadline()`。已有环境比这次需要的早到期，就重建。
- 命令在启动前被拒绝时记成 `SANDBOX_TOOL_NOT_STARTED`，确认清理后告诉模型“工具未启动”，这一轮继续，不自动重试。
- 找记忆的向量请求 3 秒没回就重发一次，只重发一次。
- 上线前的网页走查给对话耗时设上限：简单问题 4 秒、执行命令 12 秒（`scripts/delivery-mode/browser-acceptance-gate.py`）。

<a id="unknown"></a>

### 结果未知时的收尾

- 工具结果未知的运行，只有同时满足三条时才提前收尾：所有资源已确认释放；没有还能恢复的迟到结果；没有还在等的模型调用。否则等迟到结果恢复。
- 轮询正在跑的命令时，和中转进程之间的临时连接错误容忍 10 秒（`BROKER_POLL_GRACE_MS`），超过才算失败。

<a id="progress"></a>

### 流式工具调用和日志

- 模型流式写工具参数时，只记录进度（路径、行数），事件为 `runtime.tool_call.writing`，不存每一刻的参数快照。
- 命令 30 秒没有任何输出时写诊断 `sandbox.command.silent`，不停止命令。
- 命令退出未知、启动前被拒、执行中丢失、因轮询出错被取消，各写一条诊断，不静默吞掉。

[返回目录](#contents)

<a id="rejected"></a>

## 放弃的做法

- 每次调用都完整核对授权：开销大，换来的只是比版本号已经能发现的变化。
- 结果未知时自动重发：可能把外部动作做两次。
- 命令超时就终止整轮：一次超时不该让整件事失败，模型可以换做法。
- 存流式参数的每一刻快照：记录暴涨，对恢复没有用。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 正常在工作区里干活不用主人一次次点批准；碰外部的才问。
- 长命令不卡住对话，结果晚到也能接上。
- 结果未知时宁可多等也不重发，代价是偶尔收尾慢。

[返回目录](#contents)
