---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0018-sqlite-product-state-authority.md"
date: "2026-10-26"
---

# ADR 0088：过程记录写进数据库时不再等硬盘确认

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [为什么其他记录不受影响](#safety)
- [与 ADR 0018 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Himawari 的产品数据库是 SQLite（一种单文件数据库），用 WAL（先把改动追加到一个日志文件，再定期并回主文件）加 `synchronous = FULL`：每次提交都要等硬盘确认“真的写到盘上了”才继续。生产机每次这样的确认实测要 11.5–18.7 毫秒（[BL-20261001-002](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md)）。

一轮回答里，过程记录（`trace_events` 表里的执行过程事件，以及用途为 `trace` 的事件内容，比如“思考了”“搜了哪些”“等你确认”）要写几十到上百条。[ADR 0085](0085-remove-per-turn-system-gaps.md) 已经去掉了每个事件的进度检查点写入，但每个流式事件仍有三次等硬盘的提交：事件内容、事件记录，以及运行层自己保存的一份。网页从数据库读这些事件，所以它们排队等硬盘时，步骤显示和确认卡片就会落后。

2026-10-26 Andy 在两个选项中选了“过程记录不等落盘”（原话：“我也选择这一个”），另一个选项是维持全部等落盘。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 只有过程记录在提交时不等硬盘确认：`trace.append`、`trace.appendNext`，以及用途为 `trace` 的 `runPayloadArtifact.commit`。这几种写入在提交前把连接切到 `synchronous = NORMAL`，提交后立即切回 `FULL`。
2. 其他所有写入照旧等硬盘确认，包括：对话消息和回答（`final_answer`）、运行状态和进度检查点、运行历史（`runtime_history`）、上下文（`context`）、工具结果（`worker_result`）、审批、记忆、授权、外部动作记录。
3. 如果这次写入发生在一个已经开始的数据库事务里，就不切换，按外层事务的设置提交。SQLite 不允许在事务中途改这个设置。
4. 连接打开时的检查（`openQualifiedDatabase`、写入工作线程的启动设置）不变，仍要求并设置 `FULL`；数据库状态检查看到的也始终是 `FULL`。

实现位置：`packages/persistence-sqlite/src/sqlite-durable-operations.ts` 的 `execute` 和 `isProcessRecordWrite`。写入工作线程和直接调用两种运行方式都经过这里。

[↑ 返回阅读导航](#contents)

<a id="safety"></a>

## 为什么其他记录不受影响

- SQLite 官方文档：WAL 加 `NORMAL` 时数据库始终保持一致，只是“A transaction committed in WAL mode with synchronous=NORMAL might roll back following a power loss or system crash. Transactions are durable across application crashes regardless of the synchronous setting or journal mode.”（[PRAGMA synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)）也就是说，服务崩溃或重启不会丢任何记录，只有整台机器断电或操作系统崩溃时，才可能丢最后几条过程记录。
- WAL 日志是按顺序追加的。下一次等硬盘的提交（比如运行状态、回答、审批）会把它前面所有已追加的内容一起确认写盘（[Write-Ahead Logging](https://www.sqlite.org/wal.html)：“Writers sync the WAL on every transaction commit if PRAGMA synchronous is set to FULL”）。所以断电时丢掉的只会是“最后一次等硬盘的提交之后”的那一段过程记录，效果等同于服务在稍早一点的时刻崩溃；现有的恢复逻辑本来就要处理任意时刻的崩溃。
- 等确认后续跑要用的续跑数据（`runtime-continuation`，用途也是 `trace`）写完后，运行会立刻写一次等硬盘的“已暂停”检查点，这次提交会把它一起写盘。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0018 的关系

[ADR 0018](0018-sqlite-product-state-authority.md) 要求“明确 durability pragma”。本 ADR 把它具体化：产品状态和外部动作相关的提交仍用 `FULL`，只有过程记录用 `NORMAL`。ADR 0018 的其他决定不变。[便携持久化设计](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md)里“authority 与 product commit 默认 synchronous = FULL；改变持久性契约必须另立 ADR”这一条也仍然成立，本 ADR 就是那条要求的 ADR。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **维持全部等落盘**：断电时也不丢任何记录，但每个流式事件仍要排队等硬盘，步骤显示和确认卡片会落后。Andy 没有选。
- **整个数据库改成 `NORMAL`**：最简单，也是 SQLite 对 WAL 的常用推荐，但断电时可能丢最后的审批、外部动作记录和回答，违背“外部动作先记录再执行”的保证。没有采用。
- **把一轮的过程记录攒在内存里，定期批量写一次**：等硬盘的次数最少，但网页要等批量写入后才能看到新步骤，而且服务崩溃会丢内存里还没写的记录。没有采用。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：每个流式事件少了两次等硬盘确认（事件内容和事件记录），步骤和确认卡片出现得更及时。
- 代价：整台生产机断电或操作系统崩溃时，最后一次等硬盘的提交之后写的过程记录可能丢失，网页里那一轮的步骤会少几条；对话内容、回答、记忆、审批和外部动作记录不受影响。服务进程崩溃或重启不丢任何记录。
- 后续：第十三版上线后，用 [ADR 0085](0085-remove-per-turn-system-gaps.md) 的 `run.timing` 里 `trace.record` 和 `payload.commit` 的耗时核对效果，结果写进[工程案例库](../engineering-casebook.md#case-run-gaps)。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0018：以 SQLite 作为单权威部署的产品状态库](0018-sqlite-product-state-authority.md)
- [ADR 0085：去掉每轮回答里 Himawari 自己造成的等待](0085-remove-per-turn-system-gaps.md)
- [BL-20261001-002：回到同步写入快的测试机后恢复 5 秒默认测试时限（含生产机同步写入实测）](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md)
- [工程案例库：每轮回答里的系统空档](../engineering-casebook.md#case-run-gaps)
- [SOURCE: docs/adr/0018-sqlite-product-state-authority.md]
- [SOURCE: docs/adr/0085-remove-per-turn-system-gaps.md]
