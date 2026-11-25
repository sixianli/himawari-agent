---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/193794f098a53fdd0ee93f37d1f1de630ff6c7c1/docs/adr/0272-owner-proposals-join-the-data-export-format-v4.md"
superseded_by: ""
amends: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0246-external-proposals-join-the-data-export-and-web.md"
date: "2026-11-25"
covers: ""
verified_at: "bac37972f7ca3e74cb3eee53ce278a6e595a7705"
---

# ADR 0289：提议箱删除后，数据导出去掉提议一项，格式升到 v5

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

“提议箱”（表 `owner_proposals`）存的是 Himawari 想做、要主人点头的事。[ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 让她改用回话下面的选项问主人，提议箱的服务、接口和网页提议区已经删掉，表里不会再有新行。这个决定处理剩下的存储：表本身、它在数据导出里的一份，以及“主人同意过的任务”这个运行来源标记（它是靠查这张表算出来的）。

<a id="premises"></a>

## 前提

1. Andy 的原话（项目聊天，2026-11-25）：“以消息下的选项为主，提议箱如果和这个有出入、有矛盾的地方直接删掉”。
2. 旧格式的处理沿用 [被取代的 ADR 0272](https://github.com/sixianli/himawari-agent/blob/193794f098a53fdd0ee93f37d1f1de630ff6c7c1/docs/adr/0272-owner-proposals-join-the-data-export-format-v4.md) 决定 1 的做法：清单里的必填条数变了，旧文件导入时整份拒绝。
3. 线上数据不重要，上线不为保护历史数据另做兼容（Andy 2026-11-15）。

<a id="decision"></a>

## 决定

1. **删表。**迁移 `20261125090938_drop_owner_proposals` 删掉 `owner_proposals`，同时删掉推送队列里还没发出的提议通知（`web_push_outbox` 里 `source_key` 以 `proposal:` 开头的行）。表里已有的提议不搬到别处。
2. **数据导出格式升到 `himawari.data-export.v5`。**去掉导出里提议那一份数据文件和它的结构文件、清单里的 `ownerProposals` 条数和导入报告里的 [ownerProposalsWithoutOriginal](https://github.com/sixianli/himawari-agent/blob/8eeeb3c1f8c8e6255d8efe52005e37a7935902f2/packages/persistence-sqlite/src/data-export/import.ts)。v4 及更早的文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`），要用新版重新导出。
3. **去掉“主人同意过的任务”标记。**运行来源不再带 [ownerApprovedTask](https://github.com/sixianli/himawari-agent/blob/3552abb31c99cafe806656a7ffd7de603ba86e5e/packages/application/src/ports/run-execution-source.ts)，授权层不再有事实 `run_source_owner_approved_task`；这类运行已经没有来源能开出来（[被取代的 ADR 0278](https://github.com/sixianli/himawari-agent/blob/193794f098a53fdd0ee93f37d1f1de630ff6c7c1/docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md)）。读过外来内容后的写操作照 ADR 0285 决定 7 一律先问主人，不受影响。
4. **去掉配置项 `runPolicy.ownerProposals`。**配置里还写着它的，启动时按未知键拒绝。

<a id="options"></a>

## 放弃的做法

- **表留着、导出里写空文件。**表里不会再有新行，留着只会让读文档和代码的人以为提议箱还在用。
- **把旧提议搬成消息下的选项。**选项挂在她某一条回话下面，旧提议没有对应的回话；线上数据也不要求保留。

<a id="consequences"></a>

## 后果

- 旧的 v4 导出文件不能再导入。
- 上线前要从生产配置里删掉 `runPolicy.ownerProposals`（如果有），否则新版起不来。
- [ADR 0246](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0246-external-proposals-join-the-data-export-and-web.md) 里的版本号是当时的，现行格式以本 ADR 为准。
- 事故清单不加行：删功能，不是事故修复。
