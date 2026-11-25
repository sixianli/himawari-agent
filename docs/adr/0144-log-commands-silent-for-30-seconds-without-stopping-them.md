---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-01"
covers: "apps/agent-service/src/command-silence-watch.ts, apps/agent-service/test/command-silence-watch.unit.test.ts, apps/agent-service/test/production-payload-broker-handler.unit.test.ts, apps/execution-worker/src/production-sandbox-execution-v2.ts, scripts/delivery-mode/packet-template/systemd/pair-supervisor.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0144：命令超过 30 秒没有执行进程的消息时只写日志，不停止命令

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

命令在沙箱里跑的时候，执行进程（execution-worker，替主服务看管命令的进程）每 250 毫秒向主服务发一次查询（`apps/execution-worker/src/production-sandbox-execution-v2.ts` 的命令轮询循环）。如果执行进程没有死、但不再发查询，现在没有任何东西能发现，最长要等命令自己的期限（bash 是 30 分钟）。

2026-11-01 核对后发现两点（来源：`scripts/delivery-mode/packet-template/systemd/pair-supervisor.mjs`，执行进程一退出或报错就整体停掉两个进程；生产取证 `prod-hang-evidence.md`）：

1. 执行进程崩溃已有处理：看守脚本会让整个服务重启，没结束的命令在重启后标成“状态未知”。心跳只补“活着但卡住”这一种。
2. 生产库 174 条沙箱命令里没有一条耗时达到 29 分钟，日志全部历史里轮询出错、退出未知相关记录为 0 条。没有证据说明“卡住”真的发生过，但卡住后被重启打断的命令耗时会被截短，所以也不能证明没发生过。

Andy 先选了方案 A（超过 30 秒没动静就停止并释放命令），看到上述两点后改选“只记录不停止”。

<a id="decision"></a>

## 决定

1. 新增 `apps/agent-service/src/command-silence-watch.ts`。主服务每次处理某条命令的执行请求时，记下“这条命令最后一次有消息的时间”（只在内存里，不加表）。只有记录显示该命令正处于受控运行状态（`supervision === "controlled"`）时才计入；命令结束、停止或释放后立即忘掉它。
2. 每 5 秒检查一次。某条正在运行的命令超过 30 秒没有消息，写一条日志 `sandbox.command.silent`（带 `runId` 和静默毫秒数），每次静默只写一次。之后它又来消息了，写 `sandbox.command.silence_ended`，记录这次静默一共多久。
3. 不停止命令，不改结果，不改变本轮的收尾方式。命令的启动入口仍然只有一个，“最多执行一次”不受影响。
4. 先确认主服务自己没有卡顿：如果两次检查之间隔了超过 7 秒（5 秒间隔加 2 秒容忍），说明主服务自己的循环滞后，这期间收不到消息不能怪执行进程，于是所有尚未报告的命令重新从现在开始计时。
5. 30 秒大于执行进程自己的容忍期 10 秒（[ADR 0141](0141-tolerate-transient-broker-errors-while-polling-a-running-command.md)），又远小于 30 分钟。数值没有测量依据，以后看日志再调。

<a id="options"></a>

## 放弃的做法

- **超过 30 秒没动静就停止并释放（原方案 A）**：改的是 Agent 循环核心，可能误杀健康的长命令（主服务卡顿时也会表现成“没动静”，而命令不能重跑），而生产数据没有显示需要。等日志证明卡住确实出现过再做。
- **执行进程定期发显式心跳消息（方案 B，Temporal 的做法）**：多一种消息和协议；Temporal 的心跳带进度用来断点续跑，我们不重试，用不上，收益和现有轮询一样。
- **完全不做**：以后即使卡住也没有任何记录可查，没法判断要不要做真正的检测。

<a id="consequences"></a>

## 后果

- 卡住的命令仍然要等到命令期限才结束，用户体验没有变化；变化是生产日志里会留下证据。
- 日志里同一条命令先 `silent` 后很快 `silence_ended`，说明是慢而不是卡；一直没有 `silence_ended`，才是真卡住的候选。
- 门槛（测试）：`apps/agent-service/test/command-silence-watch.unit.test.ts` 的 [SILENCE-1]（静默一次只报一次、恢复会记录）、[SILENCE-2] 反向（每 250 毫秒轮询、每 20 秒慢轮询、已结束的命令都不报）、[SILENCE-3] 反向（主服务循环滞后不算执行进程的错）；`apps/agent-service/test/production-payload-broker-handler.unit.test.ts` 的 [SILENCE-4]（真实处理器：不再轮询的运行中命令被报告，持续轮询或已释放的命令不报告；去掉接入处的判断，[SILENCE-4] 的正向用例会失败）。
- 没自动测试的部分：`service-main.ts` 里的定时器启动和日志输出，因为需要完整启动服务；上线后看 `sandbox.command.silent` 日志。
- 将来如果日志证明卡住确实出现，再另开 ADR 决定是否真的停止。

<a id="references"></a>

## 关联文档

- [案例 79](../engineering-casebook.md#case-command-hang-heartbeat)
- [案例 77](../engineering-casebook.md#case-command-disconnect)
- [ADR 0141](0141-tolerate-transient-broker-errors-while-polling-a-running-command.md)
- [ADR 0127：结果未知且资源已释放时立即收尾](0127-settle-unknown-result-run-once-resources-released.md)
- [ADR 0098：后台 bash 命令](0098-move-long-bash-commands-to-background.md)
- 取证：`/mnt/project-files/disconnect-fallback-review/prod-hang-evidence.md`

[返回目录](#contents)
