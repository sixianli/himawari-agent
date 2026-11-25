---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0033-process-sandbox-default-and-optional-containers.md, docs/adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md"
date: "2026-10-24"
covers: ""
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0072：Linux 上扫过整个 PID 命名空间的释放，页面显示为“已释放”

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [与 ADR 0033、0054 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

按 [ADR 0033](0033-process-sandbox-default-and-optional-containers.md#decision) 和 [ADR 0054](0054-readonly-tools-in-host-and-reused-task-sandbox.md#decision)，SRT 模式的释放证明是“进程组已消失”（`process_group_gone`），不是容器严格模式的“已核实停止”（`confirmed`）。理由是：主动离开进程组的后代进程查不到，可能还在运行。页面因此在每次释放后都显示“停止未经严格确认”。

2026-10-24 的真实使用复盘（第 4 项）发现，生产上 8 次工具调用全部是这条提示，提示没有区分意义。核对代码后确认，这个理由在 Linux 的常驻任务宿主上已经不成立：

- 任务宿主在 Linux 上先做命名空间门控（`job-host-main.ts` 的 `launchTask`），用 `captureLinuxNamespace` 证明用户命令跑在一个独立的 PID 命名空间里，命名空间的 1 号进程是任务宿主启动的根进程的后代，并且和宿主命名空间不同。
- 在 PID 命名空间里，任何失去父进程的进程（包括两次 fork 脱离的守护进程）都会被过继给命名空间的 1 号进程，进程不能离开自己的 PID 命名空间。所以从宿主看，命名空间里的每个进程都是那个根进程的后代。
- 每条命令结束后，`sweepResidentCommand` 从根进程起扫描整棵进程树，杀掉常驻基础设施以外的全部进程，连续两次扫描为空才判定 `commandTreeGone`。在上面两点成立时，这等于证明命名空间里除基础设施外已经没有任何进程。
- Runbook 也记录过：2026-09-20 的隔离实测中，Linux 命名空间释放后没有新增写入，Mac 上的后代仍继续写入。

Mac 没有 PID 命名空间，脱离进程树的后代确实扫不到，原来的风险仍然存在。

<a id="decision"></a>

## 决定

1. 任务宿主在每条常驻命令的结果里多报一项 `namespaceSwept`：只有在 Linux 上、本会话已捕获 PID 命名空间身份、该命名空间的 1 号进程仍是原来那个（`readLinuxNamespaceState` 为 `alive`）、并且这次扫描判定 `commandTreeGone` 时才为真。其他情况一律为假。
2. Worker 在 SRT 常驻路径写释放事实时，`namespaceSwept` 为真就在 `released` 记录上加 `cleanupScope: "pid_namespace"`。证明种类仍是 `process_group_gone`，释放回执、数据库表和迁移都不变。这个字段是可选的，旧记录没有它。
3. 页面投影（`thread-execution-resources.ts`）把 `cleanup: process_group_gone` 加 `cleanupScope: pid_namespace` 的释放显示为“已释放”（`RESOURCE_RELEASE_CONFIRMED`）。没有这个字段的 `process_group_gone`（Mac、一次性启动路径、旧记录）继续显示“停止未经严格确认”。
4. 容器严格模式不变，仍是唯一写 `cleanup: confirmed` 的路径。

<a id="amendments"></a>

## 与 ADR 0033、0054 的关系

本决定只修改这两份 ADR 里“`process_group_gone` 一律提示停止未经严格确认”的展示口径，不修改证明种类、存储约束、恢复规则和严格模式。[ADR 0033 决定第 3 条](0033-process-sandbox-default-and-optional-containers.md#decision)关于严格模式的内容保持有效；Mac 上“离开进程组的后代继续写入是所有者已接受的风险”保持有效。

<a id="options"></a>

## 比较过的方案

| 方案 | 结论 |
| --- | --- |
| 删除容器路径 | 未采用：提示来自 SRT 路径，删掉容器路径消不掉它；容器路径是 ADR 0033 的严格模式。 |
| 只在页面按运行平台判断 | 未采用：平台不是记录下来的事实，投影只能猜；将来 Agent 和 Worker 不在同一台机器时会判错。 |
| 新增证明种类 namespace_gone | 未采用：要改释放回执表的允许值并新增迁移，收益和本方案相同。 |
| 不改语义，只把提示收进工具详情 | 未采用：提示仍然每次都有，只是不显眼。 |
| 由任务宿主报告、Worker 记录可选字段、投影读取 | 采用。 |

<a id="consequences"></a>

## 后果

- 生产（Linux）正常完成的工具调用不再显示“停止未经严格确认”；Mac 上和异常路径的提示不变。
- 任务宿主与 Worker 之间的命令结果多一个字段，属于 Agent-Worker 协议改动，按测试规则单独跑第 3 层；影响沙箱运行时行为，受影响的产品路径场景跑第 4 层。
- 一次性启动路径（`start`）暂不报告这个字段，仍按原口径显示；以后需要时另行扩展。
