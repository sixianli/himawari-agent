你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希，代码原文取自那个提交里的文件；这样写只限于当前提交里已经没有这段原文的旧代码，讲现状的句子仍然用当前提交里的文件和行。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行 或 文件:行@完整提交哈希>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 04904ecf0348da68502855a84d29adbc7f9abe08。
本 PR 的基线提交是 0d31eb96b5981b48a4624ae0d2d60673ce808f8b（main 与 04904ecf0348da68502855a84d29adbc7f9abe08 的共同祖先）。
待核对的方案：
方案文件：docs/adr/0277-the-system-deletes-expired-think-threads.md（在提交 04904ecf0348da68502855a84d29adbc7f9abe08 里的内容）

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
4. 删除用 `SqliteGovernedDeletionAdapter.deleteExpiredThinkThreads`，和停服务时的永久删除共用同一套删除步骤，删除记录也照样留；另外补删了原先漏掉的标题载荷 `threads.title_ref`。它不拿状态目录锁，另开一个数据库连接。上一轮没删完的（例如加密文件删除失败），下一轮先补完；补删前在删除的事务里查一遍这个编号的对话还在不在，还在就跳过。
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
