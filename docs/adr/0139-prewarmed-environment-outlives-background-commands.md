---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-31"
covers: "apps/agent-service/src/production-sandbox-services.ts, apps/agent-service/src/production-task-environments.ts, apps/agent-service/test/production-sandbox-startup.unit.test.ts, apps/agent-service/test/production-task-environments.unit.test.ts, apps/execution-worker/src/production-srt-task-environment-backend.ts, packages/runtime-sandbox/src/job-host-protocol.ts, test/integration/production-srt-task-environment.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0139：预热出来的沙箱环境要活得比后台命令久；命令确定没启动时告诉模型，本轮继续

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-31（日本时间），Andy 在第二十二版让 Himawari 读文档技能，命令是 `cat` 技能文件。整轮以“有一条命令的结果没能确认，本轮已结束”收场，换个对话再试结果一样。查生产数据库和日志后确认命令根本没有启动（事故 [I-50](../incidents-and-gates.md#incidents)）：

- 每次失败的沙箱记录相同：环境建好后 0.6 到 1.1 秒状态变成“丢失”，原因码 `SRT_ENVIRONMENT_DEADLINE_EXCEEDED`，没有输出。
- 这个原因码只在 `apps/execution-worker/src/production-srt-task-environment-backend.ts` 的 `run` 里产生：命令的期限晚于环境的期限就拒绝启动。
- 环境由“预热”提前建好（`apps/agent-service/src/production-sandbox-services.ts` 的 `prewarmEnvironment`）。预热用的期限是 `min(本轮截止时间, 目录授权到期时间)`，约 5 分钟（`runMs` 为 300000 毫秒）；bash 命令自己的期限是 30 分钟。命令自己建环境时用的 `environmentDeadline()` 会加上后台命令的 30 分钟，预热分支漏了。
- 命令到达时 `acquireSrt` 看到已有可用环境就复用，`TaskEnvironmentCoordinator.acquire` 里的 `reserve` 是幂等的，更晚的期限被丢掉。
- 生产数据：预热从 2026-10-30 02:12Z（11:12 JST）起才有，此后每个环境的寿命都是 4.6 到 4.9 分钟，此前是 34.7 或 60 分钟；此后生产上一共 4 次 bash 被派进沙箱，4 次都失败，其中 10-30 14:13 的一次就是事故 [I-41](../incidents-and-gates.md#incidents)。write 和 edit 的期限只有 2 分钟，所以没事。
- 这类“命令确定没启动”的情况被当成“结果不明”，Pi 的执行循环遇到结果不明的工具就终止整轮。

[返回目录](#contents)

<a id="decision"></a>

## 决定

1. 预热建环境的期限改用 `environmentDeadline()`，和命令自己建环境时同一个算法：`min(本轮截止 + 后台命令时间, 目录授权到期)`。
2. 复用已有环境前先看它的期限够不够：已有环境比这次请求的期限早到期，就按“扩大”重建（`srtEnvironmentRotationReason`，`apps/agent-service/src/production-task-environments.ts`）。今后无论哪条路径建出了偏短的环境，命令都不会再被拒绝。
3. 命令在启动前被拒绝（`session.run` 同步抛错）时，结果记成 `SANDBOX_TOOL_NOT_STARTED`（已有的“工具未启动”类型，`isSandboxBoundedToolFailure` 已把它归为可继续的失败），正常走“停止、释放”两步，模型收到“工具未启动：准备阶段失败，已确认清理完成。”，这一轮继续。不自动重试：Andy 2026-10-31 21:44 JST 决定，本次的原因重试也不会成功，价值在于不终止整轮。
4. 补日志：命令退出未知（`sandbox.exit.unknown`，此前只有前台主机路径有）、启动前被拒绝（`sandbox.command.not_launched`）、执行出错变“丢失”（`sandbox.execution.lost`）、轮询出错取消命令（`sandbox.command.cancelled_by_poll_error`）。这几处原来静默吞掉错误，I-41 查了一天没查出原因。

[返回目录](#contents)

<a id="options"></a>

## 放弃的做法

- **回滚到第二十一版**：第二十一版同样有预热，I-41 就发生在上面，回滚不能让 bash 恢复。
- **关掉预热**：预热把第一个工具前的沙箱准备移到模型思考的时间里，是上一轮提速的一部分，关掉等于放弃已有的收益。
- **命令不启动时自动重试一次**：根因是环境期限，重试同一个环境同样被拒绝；重建环境的逻辑由第 2 条承担。
- **把命令期限收紧到环境期限**：会让 30 分钟的后台命令悄悄变成 5 分钟，破坏 [ADR 0098](0098-move-long-bash-commands-to-background.md) 的设计。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 预热环境的寿命从约 5 分钟变成约 35 分钟，对应的沙箱常驻进程多存活最多 30 分钟，但本来就在 Run 结束时被停止，这只是上限。
- 门槛：`apps/agent-service/test/production-task-environments.unit.test.ts` 的 `[BG-9]` 例；去掉第 2 条的判断后该例失败。第 1 条和第 3 条没有自己的单元测试（第 1 条所在的预热闭包和第 3 条所在的 `runInSrtEnvironment` 需要真实沙箱才能完整运行，已有的 `test/integration/production-srt-task-environment.test.ts` 在没有 bubblewrap 的机器上整份跳过）。
- 未解释：第二十二版上线前验收场景 `accept-run-command` 在 Hermes 上通过，生产上同样的 bash 却失败，两边的差别没有证据。上线后要在真实网页上亲手跑一次 `cat` 技能文件。

[返回目录](#contents)

## 追加：第二十三版验收拦下的缺陷（2026-10-31）

第二十三版在生产验收的沙箱重启探针（`r2l6`）失败，停服之前停止，生产仍是第二十二版。探针要求一个 Run 恰好一个常驻环境，两次失败现场都有两个：第 1 代被换成第 2 代，第 1 代的目录要等 `destroy()` 才删，探针等 60 秒超时。命令其实在 0.5 秒内启动了；执行记录停在“初始化”对一条长时间运行的后台命令是正常状态，不是卡住。

换代的原因有两个，第一个来自上面第 1 条决定本身的缺陷：

1. 预热环境的期限是“本轮截止时间加 30 分钟”，而 bash 命令到来时请求的环境期限是“命令期限加 30 分钟”，更晚，所以被判为扩容换代（a11516b3 的现场）。
2. 第一次修复把预热期限改成“本轮截止时间加两个 30 分钟”，超过了任务宿主对一个会话的上限（`JOB_HOST_MAXIMUM_SESSION_MS`，60 分钟，`packages/runtime-sandbox/src/job-host-protocol.ts` 校验），预热会话以 `JOB_HOST_DEADLINE_INVALID` 失败，第 1 代被 `failure` 换掉（84d9c348 的现场）。

最终的决定：预热环境从预热那一刻起活 60 分钟（宿主上限，受授权到期限制）；`acquireSrt` 用命令自己的期限（而不是加了 30 分钟的环境期限）判断是否需要新环境，所以在预热后 30 分钟内开始的 bash 命令都复用预热环境。更晚开始的命令仍然换代。探针保持“恰好一个常驻环境”，这样以后任何多余的换代都会被它拦下。

门槛：`apps/agent-service/test/production-sandbox-startup.unit.test.ts` 的 `[BG-10]` 例；预热期限超过宿主上限、或用加了 30 分钟的环境期限判断时该例失败。真实沙箱流程的覆盖：`test/integration/production-srt-task-environment.test.ts` 的 `[R2-P2]` 预热用例要求预热后 bash 复用同一个环境（`rotationReason` 为 `initial`），它需要 bubblewrap，云端没有，必须在 Hermes 或生产机上跑。

<a id="references"></a>

## 关联文档

- 事故：[I-50](../incidents-and-gates.md#incidents)、[I-41](../incidents-and-gates.md#incidents)
- [ADR 0098：后台 bash 命令](0098-move-long-bash-commands-to-background.md)
- [ADR 0118：预装文档库和文档技能](0118-preinstalled-document-tools-and-document-skill.md)
- [ADR 0127：结果未知且资源已释放时立即收尾](0127-settle-unknown-result-run-once-resources-released.md)
- 案例：[案例 70](../engineering-casebook.md#case-unknown-result-late-settle)

[返回目录](#contents)
