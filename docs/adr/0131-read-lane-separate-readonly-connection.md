---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-30"
covers: "test/integration/sqlite-product-state.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0131：数据库读请求走独立的只读连接，写继续走唯一的写连接

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

2026-10-30 Andy 问“询问助手身份”这么简单的问题为什么用了 28.2 秒（[事故 I-45](../incidents-and-gates.md#incidents)）。生产日志（`dialogue28-journal-20261030.txt`）和数据库（`dialogue28-db-20261030.txt`）里的事实：

- 这一轮共 209 次数据库操作，排队合计 21.3 秒，真正执行合计 3.2 秒。
- 同一时刻网页发来 35 到 49 个请求；队里有审批全量读（单次最长 751 毫秒）、保存会话（506 毫秒，每次提交都落盘）。很多执行 0 毫秒的小读排队 0.5 到 1 秒，并在同一毫秒一起完成，是前面有一个慢操作占住了队。
- 过程记录比事件实际发生的时间晚写入，积压最多约 5.7 秒。

根因（已确认的部分）：所有读和写走同一个工作线程、同一条连接（`sqlite-execution-context.ts`），一次只跑一个，读也要排在写后面。代码里调用处早就分了“读”和“写”（`context.read` 142 处、`context.write` 184 处），但两者最后都走同一个 `request`，分得没有效果。

没有解释的部分：这一轮最后一条 `runtime.completed` 发生后又过了 10 秒才写入，单条记录写入最长只有 1.4 秒，所以这 10 秒不是排队，原因另查。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

2026-10-30 实际打开的一手资料：

- SQLite 官方 WAL 文档：“WAL provides more concurrency as readers do not block writers and a writer does not block readers. Reading and writing can proceed concurrently.”；“there can only be one writer at a time.”。https://www.sqlite.org/wal.html
- 同一文档第 11 节：WAL-reset bug 只在“two or more database connections open on the same file, in separate threads or processes”同一瞬间写或检查点时出现，官方称 “unlikely to occur in common use”，3.51.3 及以后已修。我们用 better-sqlite3 12.11.1，自带 SQLite 3.53.2（云端容器实测 `select sqlite_version()`；生产机待在 Mac 线程确认）。
- better-sqlite3 线程文档只说慢查询可以放 worker 线程，没有规定一条还是多条连接，也没提只读连接；所以“读另开只读连接”的具体做法是按 SQLite 官方并发说明推出的，不是 better-sqlite3 的明文建议。https://github.com/WiseLibs/better-sqlite3/blob/master/docs/threads.md

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 新开 1 个读工作线程，用 better-sqlite3 的只读方式（`readonly: true`）打开同一个库；写线程不变，仍是唯一的写连接。
2. 仓库里原来标成“读”的调用（`context.read` 和 `SqliteProductStateRepository` 里直接读的几处）改走读线程。读线程只读，发出写语句会直接报 “attempt to write a readonly database”，用来暴露标错的操作。
3. 实际核对发现 `memoryJob.listPending` 标成了读，其实会把过期的认领改回等待重试（写），改成写。
4. 慢操作日志和每次操作的耗时回调新增 `lane`（read 或 write），上线后能分开看两条队。操作失败时错误详情带上操作名。
5. 第一版只开 1 个读线程，不开线程池：先看读写分开后排队剩多少。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **换成 Postgres**：问题出在用法（读写同队、过程记录逐条写、页面轮询频繁），换库这三样照样存在，还要搬迁加密存储并多维护一个服务。Andy 2026-10-30 同意先做读写分开和批量写，两步做完仍慢再评估。
- **读线程池（多个读连接）**：没有数据说明一个读线程不够，先不加。
- **只放宽 `synchronous=FULL`**：会让每次提交不再落盘，断电可能回滚已提交的事务（SQLite 官方），是数据可靠性的取舍，要 Andy 决定，本次不动。
- **读失败时自动改走写线程重试**：会掩盖标错的操作；选择让它直接报错，由测试发现。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 门槛：`test/integration/sqlite-product-state.test.ts` 的“answers a read while a slow write holds the writer”在写线程被占住 600 毫秒时读必须在 300 毫秒内返回（旧代码 608 毫秒，失败）；“refuses a write that was sent down the read lane”要求读线程拒绝写。`memoryJob.listPending` 标错时 15 个记忆类集成测试失败，改成写后通过。
- 读线程看到的是已提交的数据：一次写完成后再发的读一定看得到；和写同时进行的读看到写之前的快照。
- 未验证：生产机上读写分开后排队剩多少（要上线后用同一问题复测）；只被生产路径走到、测试没走到的操作如果其实在写，会报只读错误，上线后看日志里的 `lane` 和错误操作名。
- 没解决：28 秒那一轮里最后约 10 秒的卡顿，以及过程记录逐条串行写（BL-20261030-001）。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [事故与门槛清单 I-45](../incidents-and-gates.md#incidents)
- [工程案例库：案例 73](../engineering-casebook.md#case-read-write-lanes)
- [ADR 0128：记录每次模型请求的缓存用量](0128-record-cache-usage-of-every-model-request.md)

[↑ 返回阅读导航](#contents)
