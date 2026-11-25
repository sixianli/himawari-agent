---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-30"
covers: "apps/agent-service/src/production-http-composition.ts, packages/platform-node/src/browser-thread-search.ts, packages/platform-node/src/thread-search-projector.ts, test/integration/thread-lifecycle.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0130：搜索对话的索引在后台建好，搜索请求不再等它

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-30 Andy 在生产网页（第二十一版）搜索对话，只看到“搜索用时较长，请稍候或重试”，重试也一样。生产日志（14:00–14:30 UTC，`/mnt/project-files/search-diagnosis-journal-20261030.txt`）里 14:14:50 同一瞬间有 3 个 `/api/thread-search/v1/prepare` 请求一起返回，耗时 20,730、18,828、15,638 毫秒，并发请求数 34–36。原因是每次搜索前，`ThreadSearchProjector.synchronize` 要把上次搜索之后新增的消息和标题一条一条读出来、解密、算词元、写索引，每一步都要排进那条唯一的数据库工作线程队列（同一时刻日志里 `queuedBehind` 为 6–9，每步排 0.5–1 秒）。3 个请求共用同一次补建，所以一起返回；1 分钟后再搜没有新内容要补，所以很快。每一步各花多少毫秒，当时的日志没有记，是推断。

另一处：补建时只要有一条消息读不出来（例如超过 64KB 的回答，`BrowserTextPayloadReader` 会拒绝），整个搜索永远报错。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

Elasticsearch 文档（2026-10-30 打开）：新写入的文档不是立刻可搜，“A refresh makes all operations performed on an index since the last refresh available for search”，默认每秒后台刷新一次，搜索请求自己不等建索引。SQLite FTS5 文档（2026-10-30 打开）建议用触发器在写入时同步索引（“One way to do this is with triggers”），并说触发器不会补旧数据，要用 `rebuild`。我们的消息是加密存放的，索引只存加盐哈希词元，SQL 触发器读不到明文，用不了；在写入路径里算词元要改“一轮执行结束”的大事务（拿不到明文和搜索密钥），风险大于这次的问题，放弃。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 服务启动后，`ThreadSearchBackgroundIndexer` 每 5 秒补建一次索引，每次网页命令提交成功后也立刻补建一次（`apps/agent-service/src/production-http-composition.ts`）。
2. 搜索请求最多等正在进行的补建 1.5 秒（`BrowserThreadSearchPreparer` 的 `synchronizeWaitMs`），之后直接用现有索引查。补建出错只写诊断日志，不让搜索失败。
3. 补建时读不出的单条（Port 错误 `INVALID_OPERATION`、`NOT_FOUND`，或密级对不上）只记入“仅含文档标记”的词元，从待补建列表里去掉，并写 `thread_search.source_skipped` 日志；数据库忙等临时错误仍然抛出，下次重试。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 刚发的消息最多晚几秒才能被搜到（命令提交后立刻补建一次，助手回答靠 5 秒的定时补建）。
- 读不出的那一条消息不能被搜到，但不再拖垮整个搜索。
- 门槛：`test/integration/thread-lifecycle.test.ts` 的 `[I-43]` 用例（真实 SQLite）：补建每步慢 400 毫秒时，搜索准备请求必须在 380 毫秒内返回；一条读不出的消息不阻塞索引、其余可搜；数据库忙的错误仍抛出。在改前代码上该用例失败（814 毫秒），改后通过。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

[事故 I-43](../incidents-and-gates.md)；[案例 72](../engineering-casebook.md#case-search-index-background)；`packages/platform-node/src/thread-search-projector.ts`；`packages/platform-node/src/browser-thread-search.ts`。
