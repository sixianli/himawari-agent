---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-27"
covers: "packages/runtime-sandbox/src/job-host.ts, packages/runtime-sandbox/test/job-host.unit.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0094：Job Host 交回最终结果后，调用方停止心跳和租约检查

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Job Host（任务宿主，`packages/runtime-sandbox` 里替每个沙箱任务单独起的一个子进程，负责启动和收尾沙箱）和调用方（agent-service 里的 `prepareSandboxJobHost`，`packages/runtime-sandbox/src/job-host.ts`）之间用 Node.js 的进程间通道传消息。调用方每 250 毫秒做两件事：发一条心跳（`heartbeat`）给 Job Host；检查最近 1500 毫秒内有没有收到 Job Host 的消息，没有就记 `JOB_HOST_HEARTBEAT_EXPIRED` 并取消任务。这一套是为了发现“Job Host 已经卡死或失联”（[ADR 0031](0031-isolated-tool-execution.md)、[ADR 0054](0054-readonly-tools-in-host-and-reused-task-sandbox.md)）。

Job Host 交回最终结果（`result` 消息）后，会调用 `process.disconnect()` 关掉通道，然后自己退出。旧代码在这之后仍然按 250 毫秒发心跳。通道刚关、调用方还没收到 `disconnect` 事件的那一小段时间里，心跳发送会失败；发送失败的回调会调用 `force()`，`force()` 再用 `process.kill(-pid, "SIGKILL")` 杀掉 Job Host 整个进程组。工具结果已经被接收，用户看到的回答不受影响，但 Job Host 和它的守护进程没能自己退出，而是被强杀。

2026-10-27 第十四次上线停服后的 `S6_READ`（读服务实际运行情况的验收步骤）发现了这个问题：被强杀的 Job Host 没来得及在 `exit` 时写下自己的计时记录，验收脚本要求调用方、Job Host 和 SDK 线程三份计时记录都在（`COMPLETE_CALLER_HOST_SDK_MEASUREMENTS_REQUIRED`），于是上线失败、自动回滚。经过见[案例库案例 29](../engineering-casebook.md#case-job-host-heartbeat-after-result)。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 调用方一旦收到 Job Host 的最终结果（`completion` 已有值），就不再检查心跳租约，也不再发心跳。启动阶段（`starting`）和已经结束（`ended`）时同样不做。
2. 收到结果后 Job Host 如果迟迟不退出，仍由原有的收尾期限（`cleanupTimeoutMs`）兜底，到期照旧强制清理。所以“卡死不退”的情况不会因为这条决定而无人处理。
3. 心跳发送失败就强杀整组这条规则本身不改：在交回结果之前，发送失败仍说明 Job Host 已经不在了，应该立刻清理。
4. 用一个单元测试锁住这条规则（`packages/runtime-sandbox/test/job-host.unit.test.ts` 的 “does not kill a Job Host that already delivered its result when it disconnects”）：交回结果后通道关闭、心跳发送开始报错，2 秒内不允许出现 `SIGKILL`，Job Host 自己退出后结果是 `exited`。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **只在发送失败时判断通道是否已经关闭，关了就不强杀**：改动更小，但调用方在结果之后仍然在检查 1500 毫秒的租约，Job Host 收尾稍慢就会被判 `JOB_HOST_HEARTBEAT_EXPIRED` 取消，同一类问题换个样子还在。
- **Job Host 先退出、不主动断开通道**：让调用方先收到 `exit` 再停心跳。要改 Job Host 一侧的退出顺序和协议，还会让结果送达和进程退出绑在一起，改动面更大。
- **把验收脚本放宽，Job Host 计时记录缺了也算通过**：只是把问题藏起来，Job Host 照样被强杀，计时数据也照样缺。不选。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：正常结束的任务不再被强杀，Job Host 每次都能写下自己的计时记录，`S6_READ` 的三份记录要求能稳定满足。
- 坏处：收到结果后到 Job Host 退出之间，调用方只靠收尾期限发现卡死，比原来的 1.5 秒租约慢（收尾期限由每次请求的 `cleanupTimeoutMs` 决定）。
- 这个竞争条件在第十三版里已经存在，第十三版的 `S6_READ` 通过只是没撞上（推断，没有复现第十三版当时的时序）。修复随第十四版上线。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0031-isolated-tool-execution.md]
- [SOURCE: docs/adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md]
- [SOURCE: docs/engineering-casebook.md]
- Node.js 官方文档 [Child process](https://nodejs.org/api/child_process.html)：`'disconnect'` 事件之后“it is no longer possible to send or receive messages”；`subprocess.send()` 的回调“is invoked after the message is sent but before the child process may have received it”，失败时参数是一个 `Error` 对象。
- PR [#56](https://github.com/sixianli/himawari-agent/pull/56)（提交 `76930db6`）
