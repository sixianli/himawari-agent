---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0088-process-records-skip-disk-sync.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0130-search-index-built-in-background.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0131-read-lane-separate-readonly-connection.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0145-run-conversations-concurrently-with-a-sliding-window.md"
superseded_by: ""
date: "2026-11-26"
covers: "packages/persistence-sqlite/src/sqlite-durable-operations.ts, packages/platform-node/src/thread-search-projector.ts, apps/agent-service/src/production-http-composition.ts, apps/agent-service/src/production-run-dispatch-loop.ts"
verified_at: "7d0ffcd52cbb69d4941871cf9bf08d93f3843da8"
---

# ADR 0306：数据库读写和对话并发

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

产品状态都在一个 SQLite 库里。为了让回答更快、几个对话能同时跑，读写方式做过四次调整，原来分散在四份 ADR 里（0088、0130、0131、0145）。这份 ADR 只写现在为真的做法。旧文全文在 `supersedes` 列的固定提交链接里。

<a id="decision"></a>

## 决定

- **一个写连接，一个只读连接。** 写仍然只有一个写工作线程；另开一个读工作线程，用只读方式打开同一个库，标成“读”的操作走它。只读连接上发出写语句会直接报错，所以标错了会被发现。慢操作日志带 `lane`（read 或 write），分开看两条队。
- **过程记录不等硬盘确认。** 只有过程记录（`trace.append`、`trace.appendNext` 和用途为 `trace` 的产物提交）提交时不等硬盘落盘（`isProcessRecordWrite`）；对话消息、运行状态、历史、授权等其他写入照旧等硬盘确认。已在外层事务里的写入不切换。
- **对话搜索的索引在后台建。** 服务启动后每 5 秒补建一次索引，每次网页命令提交后也立刻补建；搜索请求最多等正在进行的补建 1.5 秒，之后直接用现有索引查。补建出错只写诊断，不让搜索失败。
- **几个对话同时跑。** 调度器用滑动窗口：有空位就取待执行的对话立刻启动，不等其他对话结束；任何一个结束就立刻再填。同时执行数由配置 `totalRuns` 定，默认 3，测试要求不低于 2。同一对话的后续轮次由数据库查询排除，不会并发。
- 一轮排队超过 3 秒还没开始执行，页面显示“排队等待执行”。

[返回目录](#contents)

<a id="rejected"></a>

## 放弃的做法

- 所有写入都不等硬盘：对话和授权这类数据丢了就找不回来。
- 一开始就开读线程池：先看读写分开后还剩多少排队，再决定。
- 搜索请求等索引建完：库大了以后每次搜索都慢。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 长回答写过程记录时不再卡住其他请求。
- 服务异常断电时，最后一小段过程记录可能丢失，对话和状态不丢。
- 刚发的消息可能要等后台补建后才搜得到。

[返回目录](#contents)
