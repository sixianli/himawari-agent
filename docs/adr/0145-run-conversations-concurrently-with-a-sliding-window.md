---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-01"
covers: "apps/agent-service/src/production-run-dispatcher.ts, apps/agent-service/test/production-concurrency-default.unit.test.ts, apps/agent-service/test/production-run-dispatcher-concurrency.unit.test.ts, apps/control-center/test/execution-process.unit.test.ts, scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json, test/integration/sqlite-concurrent-run-dispatch.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0145：对话用滑动窗口同时执行，默认同时 3 个

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-11-01 15:22（JST，日本标准时间），Andy 在 iPhone 上问“今日天气”，用了 2 分 03 秒。生产库 `run_execution_leases`（每个对话运行占用一个执行位置的记录）显示，这一轮等了 86.6 秒才拿到位置，前面 7 个运行首尾相接、没有任何两个重叠。

两个原因叠在一起：

1. 生产配置 `concurrency.totalRuns` 是 1，模板 `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json` 也是 1。
2. 即使把它改大也不会并发：调度器（`apps/agent-service/src/production-run-dispatcher.ts`）每次只取一批对话，用 `await` 逐个等它们跑完，才会取下一批。

<a id="decision"></a>

## 决定

1. 调度器新增 `fill()`：计算空位数（上限减去正在执行的数量），取出不超过空位数的待执行对话，逐个申领执行位置后立刻启动，不等它们结束。取出和申领在同一把锁里完成，避免两次 `fill()` 同时取到同一个对话。
2. 任何一个对话结束，调度循环（`production-run-dispatch-loop.ts`）立刻被唤醒再填一次，不等 1 秒的兜底扫描。
3. `pump()` 保持原语义（取一批、等完），旧测试不变；服务接线改用 `fill()`。
4. 同一个对话的后续轮次仍由数据库查询排除（`listClaimable` 不返回已有未释放租约的运行和同一对话更早的轮次），所以同一对话不会并发。
5. 配置模板的 `totalRuns` 默认改为 3，并用测试要求它不得低于 2。选 3 的依据：生产机 4 个 CPU、约 8 GB 内存；一个对话约 209 次数据库操作、执行合计约 3.2 秒（[ADR 0131](0131-read-lane-separate-readonly-connection.md) 的取证），3 个并发只占单个写线程约三成；对话大部分时间在等模型和搜索，不占 CPU。
6. 页面：一个轮次处于 `accepted` 且没有任何执行记录超过 3 秒，显示“排队等待执行”和“已排队 M”，M 是现在减去创建时间。不显示“前面有 N 个”，因为页面只在轮次变化时重读状态，这个数会过期。

<a id="options"></a>

## 放弃的做法

- **只改配置里的数字**：调度器仍然串行，没有效果。
- **每个对话各开一个进程**：为 3 个并发多出进程管理和内存，现有的进程内异步已够。
- **显示“前面有 N 个对话”**：要服务端推送才不会过期，范围大于这次的目的。

<a id="consequences"></a>

## 后果

- 慢对话不再堵住别的对话；总数据库写入量按并发数增加，仍是一个写线程，过程记录批量写（BL-20261030-001）是下一步。
- 生产要生效还需要把 `/etc/himawari/config.json` 的 `concurrency.totalRuns` 改成 3 并重启；该文件在仓库之外。
- 门槛（测试）：`apps/agent-service/test/production-run-dispatcher-concurrency.unit.test.ts`（快任务在慢任务占位时启动，旧代码失败）；`test/integration/sqlite-concurrent-run-dispatch.test.ts`（真实 SQLite，worker 和 direct 两种，3 个对话同时各持租约，上限为 2 时第 3 个等位置）；`apps/agent-service/test/production-concurrency-default.unit.test.ts`（模板不得低于 2）；`apps/control-center/test/execution-process.unit.test.ts` 的 [QUEUE-1]。

<a id="references"></a>

## 关联文档

[ADR 0131](0131-read-lane-separate-readonly-connection.md)、[案例 80](../engineering-casebook.md#case-concurrent-dispatch)、[事故清单 I-60](../incidents-and-gates.md)。

<a id="multi-user-follow-up"></a>

## 2026-11-11 后续：多人使用

[ADR 0234](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0234-one-program-per-person-database-file.md) 之后，并发上限分两级：全机一个总数，每人一个上限，并给 Andy 留一个保底名额；本 ADR 决定 5 的默认值 3 对 Andy 单人仍成立，多人的全机和每人上限数字按生产机的实测结果另定，测量出来之前不改 3。其余决定不变。
