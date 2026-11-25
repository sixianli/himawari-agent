---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "apps/agent-service/src/production-memory-capture.ts, packages/application/src/services/durable-memory-service.ts, packages/persistence-sqlite/src/durable-adapters.ts, packages/persistence-sqlite/src/sqlite-execution-context.ts, packages/persistence-sqlite/test/memory-capture-backlog-migration.contract.test.ts, test/integration/production-memory-capture.test.ts, test/integration/sqlite-transaction-scope.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0240：每轮记忆抽取的全部写库放进一个数据库事务，写失败留在待补队列重试

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

一轮对话结束后的记忆抽取，在模型给出结果之后要写很多东西：载荷（记忆内容、引用原话）、记忆行和历史、取代旧记忆、决策记录、提醒、人物、待批准请求、出队。以前这些是十几次各自独立的写库调用，中途失败会留下半轮结果。[ADR 0222](0222-retry-and-queue-failed-memory-capture.md) 决定 4 因此规定“写记忆失败直接放弃，不重试”，并在当时的界面上写“可能已存下一部分”（这句界面文字本 ADR 已经改掉，见决定 6）。做梦记忆线程（PR 395）为补做取代加的“重试时补做”，也是同一个半轮残留的补丁。Andy 在 2026-11-11 决定：每一轮的记忆抽取做成一个事务，要么全成功，要么全回滚，失败后整轮可以安全重试。

依据产品愿景的“记忆可靠性”：记忆要么记下、要么没记，不留半轮；半轮残留是已知缺口，不是目标。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 写库在一个 worker 线程里同步执行，每个端口调用是一条消息：`packages/persistence-sqlite/src/sqlite-execution-context.ts` 的 `request`；记忆读走只读连接，写走写连接：`packages/persistence-sqlite/src/durable-adapters.ts` 的 `memory.read`、`memory.saveWithProjection`。
2. better-sqlite3 文档：“Transaction functions do not work with async functions … it's generally a very bad idea to keep a transaction open across event loop ticks anyways.”（<https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md>）；SQLite 同时只有一个写事务（<https://www.sqlite.org/wal.html>：“there can only be one writer at a time”）。
3. 所有 id 已是确定的（`memory:<生成编号>:<序号>`、载荷 ref、决策记录 id、`reminder:<记忆>`），`create` 遇到同 id 同内容直接复用：`packages/application/src/services/durable-memory-service.ts` 的 `applyProposal`。
4. 提交阶段没有模型调用：`apps/agent-service/src/production-memory-capture.ts` 里 `extract` 是返回已解析候选的闭包。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **事务范围，不是数据计划。**写通道上提供一个事务范围（`UnitOfWorkPort.run`，实现是 `SqliteProductStateRepository.runInTransaction`）：开始时在写连接上 `BEGIN IMMEDIATE`，范围内的调用照旧走现有端口，范围内的读改走写连接（看得到自己刚写的），范围外的写请求排队等它结束；成功 `COMMIT`，抛错或超时 `ROLLBACK`。现有的新增、取代、确认、提醒、人物逻辑一行没重写。
2. **范围一旦结束就作废。**回滚、超时或提交之后，范围内还在运行的代码再发任何读写，一律报错，不会落到事务外自动提交；工作线程每次操作前后核对事务还在，SQLite 自行回滚（例如磁盘满）时拒绝后续操作和提交；超时后先发 `ROLLBACK`、确认完成才放开写通道，回滚没有得到确认（例如工作线程已经退出）时写通道保持关闭：等着的和之后的写请求立刻报错（原因 `TRANSACTION_ROLLBACK_UNCONFIRMED`），不会一直挂住。上限默认 2 秒，只管范围里的回调执行，开始和提交两步各自受 SQLite 忙等待上限（默认 5 秒）约束，选项 `transactionScopeTimeoutMs` 可配；范围总时长超过 500 毫秒进慢操作日志。
3. **抽取这一轮的全部写库在一个范围里**：`processCommittedRun` 和出队（`backlog.remove`）；出队失败让整轮失败。“批准敏感记忆后提交”（`resolveSensitive`）同样放进范围，它的审计日志也是提交成功后才发。登记这次生成的行（`generations.request`）在抽取之后、写记忆之前单独写，是只记“这一轮在做”的登记行，回滚后保留无害，不并入；所以“回滚后无残留”指记忆、历史和待补队列行，这条登记行保留，重试时同一身份直接复用，不会重复。
4. **审计日志提交成功后才发。**范围内先攒起来；回滚就丢掉，不会出现日志写着“已自动记下”而库里没有。敏感批准那条路没有队列行可以判断“提交成功但回包丢失”，这种罕见情形只丢审计、数据正确，本 ADR 接受。同轮保存读不到队列时只保存一次，不再重试，避免把已提交的保存再存一遍。关闭仓库时先等进行中的范围结束。
5. **防止“提交成功但回包丢失”造成重放。**开始写之前先确保待补队列里有这一轮（没有就入队），出队和写记忆在同一个事务里：队列里没有这一轮，就等于已提交。写失败后先查队列，不在就当作成功。
6. **取代 ADR 0222 决定 4 和决定 6 里“写记忆失败直接放弃”的部分**：写失败先用同一份已解析的结果再存一次（不再问模型），仍失败就留在队列并记一次补做；补做和存失败共用最多 3 次，满 3 次写 `capture_gave_up` 并出队（每一轮内部最多保存两次，两次都失败才算一次；放弃后删行失败又遇到重启时，补做只删行、不再写放弃记录，见 ADR 0222 的后续说明）；每次失败一条决策记录，原因码是错误码，id 带第几次。三语界面里 `capture_gave_up` 的说明改为“这一轮没有记下任何内容”。ADR 0222 的其余决定不变。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- 工作单元加单个事务加确定性键重试是通用做法：Prisma 的交互式事务回调里用同一个事务连接（<https://www.prisma.io/docs/orm/prisma-client/queries/transactions>），Fowler 的 Unit of Work（<https://martinfowler.com/eaaCatalog/unitOfWork.html>）。Prisma 文档提醒回调内的外部副作用不会随事务回滚，所以本方案把审计日志挪到提交之后。
- 方案讨论里两个模型（DeepSeek、GLM）都倾向另一条路：应用层把整轮写成一份数据计划，在数据库线程里一次同步执行，外加一张“本轮已提交”标记表；它们的理由是 better-sqlite3 不建议事务跨事件循环。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **数据计划加标记表。**要在数据库那一层把新增、取代、确认、投影任务等逻辑再写一遍，两处长期要保持一致，而这些逻辑刚被做梦记忆线程改过；还要新增一张表。事务范围的风险（占住写通道）可控：一轮写库只有毫秒级，有上限，超时先回滚。
- **只合并“新增加取代”。**治不了第 N 个候选失败留前 N-1 个。
- **事务范围用手工事务和 `.transaction()` 混用而不检查。**better-sqlite3 文档说 SQLite 可能在 `SQLITE_FULL`、`SQLITE_BUSY` 时自行回滚，所以工作线程每次操作都核对（决定 2）。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 事务范围期间，别的写请求要等它结束：回调最多 2 秒（默认），加上开始和提交各自的忙等待上限；范围外的读走只读连接，不等，读到的是已提交的数据。一轮正常的写库是毫秒级。
- 写失败的重试会多花几次后台模型调用（补做要重新抽取），最多 3 次。
- 不改表。
- `npm run check:memory-capture-retry` 现在运行带 `[P3-5]` 的 42 条测试：`test/integration/production-memory-capture.test.ts` 19 条，`test/integration/sqlite-transaction-scope.test.ts` 17 条（真实 SQLite，工作线程和进程内两种方式，含回滚、超时、隔离、被 SQLite 自行回滚、工作线程丢失），`packages/persistence-sqlite/test/memory-capture-backlog-migration.contract.test.ts` 6 条。
- 做梦记忆（PR 395）里“重试时补做取代”的补丁，等本决定合并后评估是否可以删除。

[返回阅读导航](#contents)
