---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "packages/application/src/services/daily-review.ts, packages/application/src/services/owner-profile-service.ts, packages/application/test/owner-profile-service.unit.test.ts, packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql, test/integration/decision-ledger.test.ts, test/integration/memory-source-browser.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0214：档案块放不下时写决策记录，主人打开“每次对话都带上”的记忆永不挤掉

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

每轮对话，系统都会把一份“关于主人的档案”放进发给模型的内容：先放规则类记忆，再放主人打开“每次对话都带上”开关的记忆（下文叫“置顶”）和重要度够高的档案条目。三类共用 2000 字的上限，放不下的条目这一轮就不放。以前被挤掉的编号只算出来留在内存里，也就是 `usage.queued`，从没写进任何记录：模型因为缺了某条记忆答错时，查不到原因。而且规则类记忆先占字数，规则一多，置顶条目也会被挤掉，主人却不知道，这违反了“最终决定权归主人”。本 ADR 是 P2-5 的落地。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 档案块的选取在 `packages/application/src/services/owner-profile-service.ts` 的 `#select`，上限是 `OWNER_PROFILE_CHARACTER_BUDGET = 2000`。改动前的 `take` 对放不下的条目只做 `queued.push(memory.id)`，而 `compose()` 的返回值里没有 `queued`。
2. [ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md) 合并后，规则类记忆的**文字**仍然占档案块的字数。PR 366 说明的原话：“规则类记忆**文字**的 2000 字预算（清单 M-3）没动”。Andy 在 2026-11-11 10:44 JST 的决策卡上选了“366 合并后照清单做”，也就是说，规则继续先占字数，被挤掉的规则编号同样记录。
3. 决策记录里已有 `context_truncation` 这一类，`outcome` 只允许 `truncated`，`reason_code` 是 1 到 64 个字符的任意文字，`inputs` 是一个 JSON 对象（`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql`）。所以加新的原因码和新的输入字段，都不用改表。
4. “每天打分”页把 `context_truncation` 归进 `other` 组（`packages/application/src/services/daily-review.ts` 的 `ledgerGroup`）。这一组折叠显示，不占每日预算。
5. 档案块放在每轮的最后一条用户消息里，不在按对话冻结的系统提示里（`.agents/instructions/prompt-prefix.md` 第 2 条：每轮会变的内容只放在最后一条用户消息里）。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **置顶的先占字数，永不因字数被挤掉。**这里的“置顶”指档案块本来就会带上的分类（规则、身份、偏好、人际、长期目标、进行中的事）里打开了开关的记忆。打开开关后被改成事件、健康、财务、其他等分类的记忆，开关会保留，但按 [ADR 0112](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0112-memory-page-carried-memories-and-topic-browsing.md) 不进档案块，也不算进 `pinned`；改回原来的分类后又会带上。这是原有的设计，本 ADR 不改。`#select` 先读出全部候选条目（规则类，以及置顶或重要度够高的档案条目），把置顶条目的字数全部算进去，剩下的字数再按原来的顺序（规则在前，同组按重要度）分给没置顶的条目，放不下的才挤掉。置顶的条目本身就超过上限时，照样全部放进去，允许超出上限，这时没置顶的条目全部挤掉。
2. **`compose()` 带回用量。**`OwnerProfile.usage` 有四项：`limit`（上限）、`used`（实际用掉的字数，可能大于上限）、`pinned`（置顶条目占的字数）、`queued`（被挤掉的记忆编号）。网关里的 `profileUsage` 也加上 `pinned`。
3. **写决策记录。**对话流程（`ContextFormationService`）拿到用量后，只要有条目被挤掉，或者置顶条目超出了上限，就写一条 `context_truncation` / `truncated` 记录：
   - 原因码：置顶条目超出上限时用 `profile_pinned_over_budget`，其他情况用 `profile_budget_exceeded`，和“相关记忆选太多”用的 `selection_limit_reached` 分开。
   - 输入：`memoryIds` 是被挤掉的编号，排序后最多 200 个；`profileBudget` 是 `{limit, used, pinned}`。只写编号，不写记忆正文，这样敏感内容不会被复制到决策记录这张表里。
   - 写入失败时，和原来的截断记录一样忽略，不影响这一轮对话。
4. **同一组只记一次。**新的存储操作 `appendIfChanged` 在一个事务里，先读出这个主人最后写入的（按 `rowid` 取最大）、原因码属于上面两种的那条记录。如果它的原因码相同、编号集合也相同，就不写，否则写入。判断以数据库里的记录为准，所以服务重启后也不会多记一条。几点细节：
   - 去重按主人和这个 Himawari 实例（`owner_id` 加 `agent_id`）算，不按对话算。档案块是主人的，不属于某个对话，所以另一个对话里同一组被挤掉也不再记，记录的 `subjectRef` 指向第一次写入时的那一轮运行。
   - 只和最后写入的那一条比较：被挤掉的组合按 A、B、A 的顺序变化时，会记三条，因为第三次和最后一条（B）不同。
   - 编号相同、但原因码变了（置顶从没超出上限变成超出，或者反过来）时，会再记一条，因为主人需要知道置顶已经超出上限。
   - 不写新记录时，旧记录里的字数也不更新，保留第一次写入时的值。
   - 被挤掉的超过 200 条时，只记排序后的前 200 条，去重也只比较这 200 条。
   - 数据导出后再导入时，记录按导出的顺序重新写入，`rowid` 不一定还是原来的写入顺序；最坏情况是导入后第一次比较拿错一条，多记一条重复记录，不会丢记录。
5. **记忆页提示。**记忆页的用量和对话流程用同一个分级上限（`modelVisibleCeiling()`，见 [ADR 0193](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0193-memory-is-visible-to-the-model.md)），以前记忆页按 `private` 算，置顶的敏感人际记忆进了档案块却不算进记忆页的用量。`pinned > limit` 时，“每次对话都会带上的记忆”卡片顶部（不用展开就能看到）显示：置顶的记忆共多少字、上限多少字、超出多少字，并提示关掉几条就能回到上限以内。三种语言都有这条文案。
6. **门槛：**
   - `test/integration/decision-ledger.test.ts` 里的 `[P2-5]` 用例，跑真实的 `ContextFormationService`、`OwnerProfileService` 和 SQLite 决策记录，worker 和直连两种执行方式都跑：
     - 档案超长时写一条记录，列出被挤掉的编号，不含正文；
     - 下一轮同一组被挤掉时不再多记；
     - 被挤掉的条目变了就再记一条；
     - 置顶条目本身超出上限时，全部照放，只记一条 `profile_pinned_over_budget`；
     - 反向：档案没超字数时，不产生任何截断记录。
   - `packages/application/test/owner-profile-service.unit.test.ts` 里的 `[P2-5]` 单元用例。
   - `test/integration/memory-source-browser.test.ts` 里的两条 Playwright 用例（一条正向、一条反向）。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- ChatGPT 的记忆满了以后，会提示用户并让用户自己删减。这一条没有核实到一手原文：OpenAI 帮助中心的 Memory FAQ 页面（<https://help.openai.com/en/articles/8590148-memory-faq>）在 2026-11-11 抓取时返回 403，所以不把它当作这项决定的依据。
- 上下文被截断时，常见的做法是留下可以追查的记录，而不是悄悄丢掉。本项目已有的“相关记忆选太多”截断记录（[ADR 0143](0143-decision-ledger-for-model-gate-decisions.md)）就是这样，本 ADR 把同一做法用到档案块上。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **每轮都记一条：**会把决策记录和“每天打分”的折叠区刷满，同一件事重复几十次，对主人没有新信息。
- **只在内存里记住上一轮的结果来去重：**服务重启后会重复记一条，多进程时也不一致。所以改用数据库里最近一条记录来判断。
- **两轮之间如果有一轮没超字数，就把状态清空：**要做到这一点，没超字数的那一轮也得写一条记录，等于为了去重每轮都写。所以只要同一组又被挤掉，就算中间隔了没超字数的轮次，也不再记。旧记录仍然在，查原因时能看到。
- **置顶超出上限时，只放进上限以内的部分：**这样会违反“置顶永不挤掉”。所以选择超出上限，同时在记忆页提示主人。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 置顶的条目多了，没置顶的规则类记忆会先被挤掉。规则本身由程序执行，挤掉的只是规则记忆的文字（[ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md)），而且被挤掉的编号会出现在截断记录里。
- 置顶条目超出上限时，档案块会超过 2000 字，每轮发给模型的内容会变长。主人在记忆页能看到这件事，并自己决定关掉哪几条。
- 档案块选中的条目有可能和以前不同。但档案块在最后一条用户消息里，已经发给模型的历史不受影响，请求开头也不变。
- 置顶的字数没有硬上限：主人置顶得越多，每轮发给模型的内容就越长。记忆页的提示是唯一的约束，要不要加硬上限，以后由主人决定。
- [ADR 0112](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0112-memory-page-carried-memories-and-topic-browsing.md) 里“总长 2000 字、超出按重要度截断”的说法，从本 ADR 起改为：先给置顶的留字数，置顶的永不截断；其余的仍按重要度截断。
- 写入失败（例如磁盘满）时不写记录，所以“被挤掉就有记录”在这种情况下不成立；这一轮对话不受影响。
- 不改表结构，不加迁移。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0112](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0112-memory-page-carried-memories-and-topic-browsing.md)：记忆页“每次对话都带上”开关。
- [ADR 0143](0143-decision-ledger-for-model-gate-decisions.md)：决策记录。
- [ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md)：硬规则记着来源记忆。
- [Agent 规则手册清单](../agent-rulebook-inventory.md) 的 M-3。

[返回阅读导航](#contents)
