---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: ""
date: "2026-11-15"
---

# ADR 0277：想一想对话到期由系统自动删除，不等主人确认

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

“想一想”（[ADR 0274](0274-new-things-go-through-one-think-entrance.md)）每想一件事就开一个后台对话（下文叫“想一想对话”）。这些对话是 Himawari 自己琢磨用的，结论会进提议箱，主人很少回头看原文。PR 558 已经把它们标成 `threads.origin = 'think'`，并从所有列表、搜索、推送、导出和记忆摘要里藏起来。这个决定要回答的是：这些对话留多久、由谁删。

Andy 2026-11-15 定：这些记录不进列表，保留 7 天后自动清掉，保留天数做成可以改的设置。

<a id="premises"></a>

## 前提

1. Andy 的原话：“30 天太长了，7 天怎么样？因为其实我不会，我很少会去看他们自己琢磨的内容。”他回的提议是“这些记录不放进你的列表，单独存 30 天，过期自动清掉。它们想出的结论照样会进提议箱。”（项目聊天 cmsg_01EE1hey9cboYNfwFnBv5dgrDs6moWVTLBrHyMTxWzj99b）
2. 主人发起的“永久删除”在服务运行时只把对话改成 `deletion_pending`，并不真删：`packages/persistence-sqlite/src/sqlite-thread-operations.ts` 里的原文是 `const target = input.mode === "trash" ? "trashed" : "deletion_pending";`。
3. 真删数据的 `SqliteGovernedDeletionAdapter.deleteImmediately` 要求服务已停并拿到状态目录锁：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts` 里的原文是 “Governed deletion requires stopped services and an exclusive state-root lock”。
4. 想一想对话在建对话的同一个事务里记 `origin = 'think'`；客户端经网关建的对话一律是 `owner`，即使编号以 `thread:think:` 开头：见 `docs/architecture-v0.1.md` 里“想一想”的运行那一段。

<a id="decision"></a>

## 决定

1. 新设置项 `threadRetentionDays`（想一想记录保留天数），1 到 90，默认 7，是想一想的第 11 个可改设置，写在 `packages/application/src/ports/configuration.ts` 的 `THINK_SETTING_DEFINITIONS`。每次清理都现读，改了天数，已有对话也按新天数算。
2. `apps/agent-service/src/production-think-retention.ts` 的 `ThinkThreadRetention` 在服务启动后先清一次，之后每小时清一次，不管想一想有没有开。
3. 只删同时满足这些条件的对话：`origin = 'think'`；没有还没结束的运行；没有生效中的定时任务；已归档且归档满保留天数，或者一直没归档、最后更新满保留天数加一天。选出之后、真删之前，在删除的事务里按同样的条件再查一遍，不满足就跳过。
4. 删除用 `SqliteGovernedDeletionAdapter.deleteExpiredThinkThreads`，和停服务时的永久删除共用同一套删除步骤，删除记录也照样留；删除步骤也会删对话的标题载荷 `threads.title_ref`。它不拿状态目录锁，另开一个数据库连接。上一轮没删完的（例如加密文件删除失败），下一轮先补完；补删前在删除的事务里查一遍这个编号的对话还在不在，还在就跳过。
5. 这是“永久删除要主人确认”的一个例外，只对系统自己建的想一想对话成立。理由按产品愿景的裁决顺序：用户主权排第一，主人已经明确说了这类记录 7 天后清掉，天数也由他在 App 里改；主人和客户端建的、还在的对话一律不碰，所以边界与可逆性不受影响。补删只收尾对话行已经删掉、删除记录还停在“未完成”的删除，包括主人永久删除后没删完的加密文件。

<a id="industry"></a>

## 业界怎么做

ChatGPT 的“临时对话”不进历史记录，服务端最多保留 30 天后删除（https://help.openai.com/en/articles/8914046-temporary-chat-faq ）。这里照这个做法，天数按 Andy 定的 7 天，并且可改。

<a id="options"></a>

## 放弃的做法

- 让清理走主人删除的网关命令：那条路在服务运行时只标 `deletion_pending`，真删要停服务，清理永远不会真删。
- 建对话时就算好删除时间并存下来：改天数后已有对话还按旧天数算，和“天数可改”的要求不符。
- 凭编号前缀 `thread:think:` 判断是不是想一想对话：客户端可以自己指定这样的编号，会误删主人的对话。

<a id="consequences"></a>

## 后果

- 想一想对话最多留“保留天数加一天”再加一小时左右；改小天数后，下一轮清理就会删掉已到期的。
- 被删的想一想对话无法找回，它的结论如果已经进了提议箱，提议本身不受影响。
- 服务运行时多了一条真删数据的路径。它只认 `origin = 'think'`，不接受客户端传来的任何字段；回归测试在 `test/integration/think-runner.test.ts`（主人的旧对话、运行中的想一想对话、有生效定时任务的、未到期的都不删）。
