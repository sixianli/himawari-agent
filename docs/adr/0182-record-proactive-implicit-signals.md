---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-08"
covers: "packages/application/test/daily-review.unit.test.ts, packages/persistence-sqlite/test/migration-engine.contract.test.ts, packages/platform-node/test/startup-configuration.unit.test.ts, test/integration/decision-signals.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0182：主动提醒的点开、撤销、回复信号单独记录，抽样含沉默决策

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P0-11（Andy 2026-11-08 写，同日同意变更清单）。决策记录（数据库表 `decision_ledger`，记录 Himawari 每次拿主意的那张表，[ADR 0143](0143-decision-ledger-for-model-gate-decisions.md)）里，主动检查的评价只来自 Andy 在“每天打分”页的手动打分，稀疏而且自选（只有他想评的才会评）。业界把用户不用动手就产生的行为（点开、忽略、撤销）单独记成弱信号，只当观察，不当打分；漏报率也要看沉默的决策才算得出来。

动手前对着代码核对的现状（main 8ae40ba）：

- “点开”已有记录：`web_push_feedback.opened_at / dismissed_at`（迁移 0061），通过决策记录的 `push_source_key` 关联；缺的是没有一条挂在决策上、不可改写的记录。
- “回复”只有当前状态 `source_insights.status = 'replied'`，没有时间，下一封新邮件会把状态改回 open。
- “撤销”（网页上点完成或不再提醒后再点撤销）只是把状态改回 open，没有任何记录。
- “每天打分”的抽样池已含沉默决策，但和被推送的决策在同一组里按哈希混排，占比不可配。
- 设置里现有的“命中”统计把“24 小时内点开”算作命中。它在校准周报页的另一张卡片里，文字已写明算法和打分比例不同，本次不改。

产品愿景的取舍依据：记忆可靠性优先于主动性与效率，所以信号落成不可改写的记录；用户主权优先，所以信号不替 Andy 打分，也不自动改任何门槛。

<a id="decision"></a>

## 决定

1. **迁移 0080 新建 `decision_signals`，并给决策记录的 `push_source_key` 建部分索引（点开时按推送找决策不再整表翻）**：每条是一个信号（`opened` 点开、`undone` 撤销、`replied` 回复），外键指向决策记录的那一行，带发生时间 `occurred_at`、距起点的毫秒数 `delay_ms`、小 JSON `detail`、来源标识 `source_ref`；同一决策、同一信号、同一来源去重。数据库触发器拒绝修改和直接删除；决策记录被删（清除主动记录、删除 Agent 或账户）时随之级联删除。迁移时把已有的点开记录回填进来。
2. **三个信号和原动作在同一个事务里写**：点开写在 `recordReactions` 里（挂到发出这条推送的决策，间隔 = 点开时间 − 首次发出时间）；撤销写在 `updateInsight` 里，只有原状态是完成或静音、改回未处理时才记，`detail.from` 记原状态；回复写在主动检查记录结果时判定“你已回复”的地方，只对仍在等待的提醒记，发生时间用你那封回复邮件的收件时间。撤销和回复挂到该条提醒当时关联的那次决策。
3. **按决策查询**：决策记录端口新增 `listSignals`（按决策编号取信号）。
4. **周报把观察信号单独成一节，不和打分混算**：校准周报（网页、命令行报告、历史记录）新增“观察信号 · 不是打分”。分母是这一周推送过提醒的决策（结论为已推送或延后推送，并且这条推送确实发出去了：推送反馈表里有它的发送记录；排进待发队列但没有订阅或发送失败的不算）；同一决策同类信号出现多次只算一次，另给事件条数和首次发生的中位间隔；落在没有推送的决策上的信号单独计数，不进比例。样本少于最小样本数时不出百分比。历史记录格式升到 `himawari-calibration-week.v3`（新增 `implicit` 字段）。
5. **抽样里沉默决策的占比可配**：`runPolicy.proactive.reviewSilentSharePermille`（0 到 1000，缺省 500）。主动检查那一组拆成“提醒了”和“沉默”两个队列，按这个千分比穿插取样，一边取完时名额让给另一边；0 表示有被推送的决策就不取沉默的。
6. **只记不用**：任何信号都不用来改门槛、规则或推送行为；信号表只被周报和按决策查询读取。

<a id="options"></a>

## 放弃的做法

- **只靠 `web_push_feedback` 和洞察状态，周报时现算**：状态会被覆盖（回复被新邮件改回 open，撤销没有痕迹），算不出历史。
- **把信号折算成打分写进 `owner_rating`**：会和 Andy 的显式打分混在一起，违背“只当观察”。
- **回复按“搜索收件箱里有没有你的回复”新增读取**：已有的主动检查本来就会判定“你已回复”，复用它不增加邮件读取。
- **在设置页的四个统计里一并改“命中”的算法**：那是 ADR 0155 已计划搬进周报页的另一件事，不在本次范围。

<a id="consequences"></a>

## 后果

- 门槛（会自动拦下的测试）：
  - `test/integration/decision-signals.test.ts`（worker 和 direct 两种执行方式各跑一遍）：点开、撤销、回复各落一条且能从那次决策查到；反向用例：划掉推送、未知标签、没发推送的决策、完成但未撤销、未处理上再设为未处理、已完成的提醒上出现回复、重复的回复，都不产生信号；触发器拒绝修改和删除，清除主动记录时随决策一并删除；周报里观察信号和 Andy 的打分分开，加入信号后打分比例原样不变。
  - `packages/application/test/daily-review.unit.test.ts`：沉默占比按配置取样，0 和 1000 两端，一边取完时让位，未取到的沉默决策仍计入“没抽到”。
  - `packages/platform-node/test/startup-configuration.unit.test.ts`：缺省 500，范围外被拒绝。
  - `packages/persistence-sqlite/test/migration-engine.contract.test.ts` 等迁移序号测试更新到 80。
- 已知局限：撤销和回复挂到提醒当时关联的那次决策，一条提醒被后来的检查更新过后，信号挂在更新它的那次决策上；点开按推送发出的那次决策。点开只记第一次；撤销可记多次。
- 回复信号的时间间隔 = 回复时间 − 该提醒最近一次出现的时间，不是从推送发出算起。
- 本次不改设置页“命中”统计把点开算作命中的算法，由 ADR 0155 计划的搬迁处理。
- 一条网页推送可以同时覆盖多个决策（安静时段会把几次检查的提醒合进同一条待发推送）。一次点开会给每个共用这条推送的决策各记一条 `opened`，所以“事件条数”按决策计，不按物理点开次数计；“出现过的决策”和分母同为决策，口径一致。
- 撤销和回复只在对应提醒排进了推送（`source_insights.push_source_key` 不为空）时才记。同一决策里没推送的提醒被完成、静音再撤销，或被回复，不进观察信号。提醒被后来的检查更新过时，信号仍记在发出这条推送的那个决策上（按提醒的推送编号找到最早的那个决策），不记在后来更新它的决策上。
- 延后推送（`deferred`）在真的发出去以后才进分母；撤销和回复在写入时只看提醒是否排进了推送，到周报里再按“推送确实发出”归入比例或归入“落在没有推送的决策上”，所以排进队列后才发出的推送不会丢信号。
- 历史记录格式从 v2 升到 v3 后，命令行报告不再把 v2 记录当作“上一周”，第一次跑 v3 的那周会显示“没有更早的记录可比”。
- 周报按决策所在的周归属信号，不看信号发生的时间：回头看旧的一周，数字会随之后才发生的点开、撤销、回复变大（打分也是同样的归属方式）。
- 删除 Agent 或账户时，触发器放行对信号的级联删除（和 `observation_events` 同一做法），由 `decision-signals.test.ts` 里的反向用例保证；直接改写或单独删除仍然被拒绝。

<a id="references"></a>

## 关联文档

- [ADR 0143：决策记录](0143-decision-ledger-for-model-gate-decisions.md)
- [ADR 0155：决策记录观察期与校准周报网页](0155-decision-record-observation-and-weekly-report-page.md)
- [决策记录观察期 Runbook](../runbooks/decision-record-observation-runbook.md)
- [产品愿景](../product-vision.md)

[返回目录](#contents)
