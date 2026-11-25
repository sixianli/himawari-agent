---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-31"
covers: "apps/execution-worker/src/broker-poll-tolerance.ts, apps/execution-worker/src/production-sandbox-execution-v2.ts, apps/execution-worker/test/broker-poll-tolerance.unit.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0141：轮询正在运行的命令时，瞬时的通信错误先重试，不再立刻取消命令

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

命令在沙箱里跑的时候，执行进程（execution-worker）每 250 毫秒向主服务查一次记录、把新输出写回去（`apps/execution-worker/src/production-sandbox-execution-v2.ts` 的命令轮询循环）。2026-10-31，Andy 问命令与主服务断联时现在的设计有没有兜住，评估（只读，读代码）发现一处漏洞：这个循环里任何一次出错，不管原因，都直接取消正在跑的命令（日志 `sandbox.command.cancelled_by_poll_error`）。主服务与执行进程之间只隔一条本机连接，一次瞬时的连接失败或超时就能杀掉一条本来好好的命令，用户看到“命令结果没能确认”，命令可能只执行了一半。

其余几种断联的现状见 [案例 77](../engineering-casebook.md#case-command-disconnect)：重启或上线后记为状态未知且不重跑；退出信息不全记为“退出未知”；命令没启动由 [ADR 0139](0139-prewarmed-environment-outlives-background-commands.md) 处理。

[返回目录](#contents)

<a id="decision"></a>

## 决定

1. 新增 `apps/execution-worker/src/broker-poll-tolerance.ts`。只有两类错误算“瞬时”：连接不可用（`PAYLOAD_UDS_TRANSPORT_UNAVAILABLE`）和请求超时（`PAYLOAD_UDS_DEADLINE_EXCEEDED`）。
2. 出现瞬时错误时命令继续跑，下一个 250 毫秒再查；连续出错超过 10 秒（`BROKER_POLL_GRACE_MS`）才取消。中间只要有一次查询成功，计时重新开始。第一次出错时写一条 `sandbox.command.poll_retry` 日志。
3. 其他错误（主服务明确拒绝、记录绑定丢失、权限或 fence 被撤销、停止请求）仍然立刻取消，和以前一样。这些错误在主服务一侧都是同一类“拒绝”，不能靠重试解决，也不能拖延用户按下停止后的取消。
4. 同样的规则用在两条轮询路径：SRT 沙箱路径（生产使用）和作业宿主路径。
5. 重试的只是“读记录、写输出”这类查询，命令本身一直在跑，没有被重新启动。重复执行命令的风险没有增加：命令的启动仍然只有一个入口，每个调用只有一个身份（`SandboxJobIdentity`），重启后的恢复路径没有启动命令的能力。

[返回目录](#contents)

<a id="options"></a>

## 放弃的做法

- **断联后自动重跑命令**：Temporal、Kubernetes 默认这样做，前提是任务可以重复执行。bash 命令可能已经改了文件或发了请求，重跑会重复副作用，所以保持“最多执行一次”。
- **所有错误都重试**：主服务的“拒绝”和“传输失败”在执行进程这边都是异常；全部重试会让停止请求被拖延。只对明确的传输层错误码重试。
- **把宽限期做成可配置项**：没有数据支持某个具体值，10 秒是按“比一次主服务短暂卡顿长、比 30 分钟命令期限短得多”选的，未测量。以后有生产统计再调。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 一次瞬时的本机连接失败不再杀命令。主服务整个挂掉的情况不变：执行进程与主服务同属一个服务单元，随之一起被停。
- 如果连接持续断开，命令最多比以前多跑 10 秒才被取消。命令自己的期限仍由宿主强制执行。
- 门槛：`apps/execution-worker/test/broker-poll-tolerance.unit.test.ts`，[POLL-1] 与 [POLL-2]。该文件测的是判定类本身；循环里的接线（出错后 `continue`）没有自己的自动测试，因为触发它需要在运行中的真实沙箱里让主服务连接失败。
- 没做的事：心跳（执行进程卡死但没退出时，目前最长要等命令期限才发现）。这是核心特性，另出方案，讨论同意前不动代码。

[返回目录](#contents)

<a id="references"></a>

## 关联文档

- [案例 77](../engineering-casebook.md#case-command-disconnect)
- [ADR 0098：后台 bash 命令](0098-move-long-bash-commands-to-background.md)
- [ADR 0127：结果未知且资源已释放时立即收尾](0127-settle-unknown-result-run-once-resources-released.md)
- [ADR 0139：预热环境与命令没启动](0139-prewarmed-environment-outlives-background-commands.md)
- 评估报告：`/mnt/project-files/disconnect-fallback-review/report.md`

[返回目录](#contents)
