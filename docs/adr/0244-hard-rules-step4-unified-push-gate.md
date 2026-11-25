---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
amends: ""
superseded_by: ""
amended_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"
date: "2026-11-12"
---

# ADR 0244：硬规则第 4 步，所有推送走统一闸门，主人一句话就能立“夜里别提醒我”

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [和最终方案文档不同的几处](#deviations)
- [放弃的做法](#options)
- [后果](#consequences)
- [验证](#verification)

<a id="context"></a>

## 背景

推送（网页推送，Himawari 主动弹到主人手机或电脑上的通知）共有五类来源：主人定的到点提醒、审批、任务完成或失败、邮件提醒、Muse（另一个提醒程序）掉线告警。第 2 步（[ADR 0212](0212-hard-rules-step2-amount-field-and-push-suppression.md)）只让规则管邮件；其余几类发不发、什么时候发，还是写死在代码里，主人没法说一句“夜里别提醒我”。

第 4 步让所有推送经过同一个闸门（发送前用规则手册里的规则判断一次“现在发，还是延后”），并加一种主人规则 `push_quiet_hours`（静默延后）。主人在对话里说一句话，模型调用 `rule_set` 工具就立成规则，不做设置页开关。

<a id="premises"></a>

## 前提

1. 规则是硬性设定：`docs/product-vision.md:59`，“规则不是记忆，是硬性设定：记忆只保存一条规则的出处和修改历史；规则本身写进程序、必定执行，每条都有回归测试守着。”
2. 原则顺序：`docs/product-vision.md:55`，“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”
3. 常规判断由规则预先授权：`docs/product-vision.md:58`，“常规判断应由规则手册预先授权，不逐次确认；每日需要我介入的次数与时间有上限。”
4. Andy 在本线程的回复：“开工”；“不要管以前的老对话”（一句话立规则这一步现在就做，接受工具定义变化让老对话重建一次缓存）；决策记录放进现有表，“按照你的建议”；“同意”（失败的任务结果也延后）；此前“文档里面要我定的那些，按照你的建议来”“一定要按照最新版的这个文档来做”。
5. 最终方案文档 https://claude.ai/artifact/PNvUTw6W4iw9YQiTKgT5Xk 第 4 步：闸门管五类推送，审批和告警是否延后要单独说明。
6. 推送入队和发送的代码：`apps/agent-service/src/production-web-push.ts`，`#collect` 入队、`#deliver` 发送；有效期常量 `REMINDER_WINDOW_MS = 6 * 3_600_000`（第 24 行）。
7. 规则判断器和闸门字段表：`packages/application/src/rules/field-catalog.ts` 的 `RULE_GATES`、`push_delivery` 字段。

<a id="decision"></a>

## 决定

1. **闸门放在发送点 `#deliver`，不放在入队点 `#collect`。**入队时还不知道哪些设备、什么时间会发；发送点才有这条推送要发的时刻。同一轮里同一个来源键只判断一次，结果给所有设备共用。
2. **新增闸门名 `push_delivery`**，事实有四个：`push_class`（`scheduled_reminder`、`approval`、`run_result`、`mail_reminder`、`muse_outage`、`unknown`；[ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 决定 6 加“她的话”这一类，主人消息叫起的运行不再推“已完成”，改推她回的那句话，安静时段规则也管“她的话”）、`local_minutes`、`local_weekday`、`local_previous_weekday`（主人所在时区，默认 `"UTC"`，生产配置里写实际时区）。规则的结果只有一种：延后到静默时段结束。
3. **审批、Muse 告警和认不出的来源由代码直接放行，不交给规则判断。**这样规则写错、判断器出错都拦不住它们。目前唯一的规则类型也不碰审批；Andy 11-10 定的“普通审批可以延后但不得过期、高风险审批和告警不受影响”留给以后扩展，到时另写 ADR。
4. **新增主人规则类型 `push_quiet_hours`**：参数是时段（`periods`，每段有星期、开始、结束，可跨零点）和适用类别（`classes`）。默认管任务完成或失败、邮件提醒；主人明说“包括我自己定的提醒”才含到点提醒。注册时必须带测试文件（`packages/application/test/rule-type-push-quiet-hours.unit.test.ts`），规则自带的命中和不命中例子必须能在判断器里重现。不再另做设置页开关。
5. **一句话立规则要认得“夜里别提醒我”。**`rule_set` 里“这是长期有效的话”的判断另加了一族“别提醒我、不要提醒我、别打扰我”的说法（`QUIET_REQUEST_MARKERS`），它单独不算长期，必须同时有“夜里、晚上、周末、每天”这类反复出现的时段词（`RECURRING_TIME_MARKERS`）才算；整句话里只要有“今晚、现在、这次、这封、明天、这个周末、下个月、今年”之类一次性或限时的词（`ONE_OFF_MARKERS`，不分子句），就只算提议；“从现在起”这类开头不算一次性。这张词表对所有规则类型通用，所以“今年起每次……”这类邮件规则也只会先成提议，不会直接生效；词表是启发式的，漏掉的说法最坏结果是多立一条主人可以撤销的规则。`rule_set` 的工具定义改了，所以这次上线后所有老对话的系统提示和工具重建一次（Andy 已接受）。
6. **延后存在推送出站表上。**新列 `defer_until`、`defer_rule_refs`；`listDue` 跳过还没到点的行。延后到的时刻最多 24 小时之后；延后后有效期延长到延后时刻再加 1 小时，从入队起算总寿命最长 48 小时，不会无限延后。主人改、停、删任何一条规则，数据库触发器会把所有延后清空，下一轮重新判断。**迁移里的这三个触发器挂在表 `rule_book_rules` 上：以后谁重建这张表，必须把它们一并重建。**
7. **判断器或规则读取出错，推送照发，并告警**（`onGateFailure`，每条推送来源各报一次）。存着的静默规则读不懂（例如参数被改坏）也算读取出错：整类推送照发并告警，不会悄悄当成“没有这条规则”。拦不住一条推送，好过吞掉它。
8. **每次延后写一条决策记录。**表 `decision_ledger` 新增种类 `web_push`，结果固定为 `deferred`；和出站表更新放在同一个事务里写（`deferItem` 开事务，记录写不进就整体回滚，推送照发并告警），编号由主人、实例、来源键、延后到的时刻算出，同一次延后只写一条；`ruleIds` 写让它延后的规则“规则 id@修订号”（[ADR 0215](0215-decision-record-points-at-the-rule-version.md)）。这个种类不进「每天打分」、不进校准分组、不要求主人打分。延后到几点不进决策记录，只在出站表里。写入约定见 [决策记录写入约定](../execution/specs/2026-11-09-decision-record-write-convention.md)。
9. **加种类需要重建决策记录表。**检查约束里的种类和结果写死在表定义里，所以迁移 0093 照 0089 的做法重建 `decision_ledger` 和七张直接或间接指着它的表，并且先复制再删掉 `decision_prereviews`（它指向决策记录和邮件记录，带不许改的触发器），重建后原样放回。
10. **测试推送（设置页“发一条测试”）不走闸门**：主人自己点的，夜里点也要立刻收到。

<a id="deviations"></a>

## 和最终方案文档不同的几处

已告诉方案线程，待 Andy 知悉：

1. 闸门位置是 `#deliver`，不是文档写的 `#collect`（原因见决定 1）。
2. 审批和告警本步不进规则，由代码放行（决定 3）；文档里“普通审批可延后但不得过期”留给后续。
3. 延后的寿命有上限（延后 ≤ 24 小时、总寿命 ≤ 48 小时），文档没写。

<a id="options"></a>

## 放弃的做法

- **推送继续在设置页开关里管。**开关是软设置，没有出处、版本和回归测试，也不能说一句话就改。
- **延后后一律等 6 小时有效期过去就丢。**夜里延后到早上，早上 7 点已经超过 6 小时，推送会被当成过期吞掉；所以延后时延长有效期。
- **新开一张表记录延后。**多一张表要导出、清理、迁移，而决策记录本来就是“当时做了什么决定”的地方（Andy 同意放进现有表）。
- **把审批也交给规则判断器。**判断器出错时重要审批也会晚到，不值得。

<a id="consequences"></a>

## 后果

- 上线后，所有老对话的第一轮请求开头变一次（`rule_set` 工具定义变了，按 [ADR 0165](0165-freeze-the-request-head-per-conversation.md) 重建），Andy 已同意。
- 总寿命 48 小时是硬上限：一条推送若入队已久、延后到的时刻加 1 小时超过入队后 48 小时，到点前就会过期，记为 `expired` 不再发送；这是有意的，不让推送无限期拖着。
- 同一条规则里相邻两个时段之间只隔 1 分钟空隙时，推送会在空隙那一分钟发出，不等后一个时段结束；规则的时段本来就该写成连续的。
- 主人此刻正盯着页面且静默时段生效时，推送先延后（写一条记录），到点后若主人仍在场才按“在场抑制”不弹；规则优先于在场判断。
- 延后记录目前只能按决策编号在“依据”抽屉里查，没有列表页；要做列表另开任务。
- 规则试跑的说明文字（“周日 23:00”之类）目前只有中文。
- 迁移 0093 比单纯加列大得多（重建八张表）；合并时按改表队列，并且要等 P4-1 的迁移先合，再以它合并后的 `decision_ledger` 定义为准重新生成这一段。
- 写延后时在同一事务里核对依据的每条规则仍是同一修订且仍在生效（`active` 或 `needs_review`）；对不上就不写延后、不写决策记录、不延长有效期，这一轮不发，下一轮重新判断。这是为了规则刚被撤销或改动的那一瞬间不把推送扣住最长 24 小时。依据记录最多 16 条。
- 只跑一个服务实例。延后记录的编号由主人、来源键和延后到的时刻算出，同一次延后重复写入只留一条；同一来源键、同一时刻再次延后（规则改过后）不更新旧记录里的规则版本，展示的可能是旧修订号。

<a id="verification"></a>

## 验证

- `test/integration/production-web-push.test.ts` 的 `[HR-4]` 用例：真实 SQLite，延后、一次写入、早上发给所有设备；没有规则时立刻发（反向）；审批不延后（反向）；撤销规则立即放出；延后期间新订阅的设备；到点提醒只在规则点名时才延后；规则读取失败照发并告警（反向）；决策记录只在延后时写（反向：没延后没记录）。
- `packages/persistence-sqlite/test/web-push-gate-migration.contract.test.ts`：重建后决策记录、信号、预评一条不丢，不许改的触发器还在；`web_push` 只接受 `deferred`（反向）。
- `packages/application/test/rule-type-push-quiet-hours.unit.test.ts`、`web-push-gate.unit.test.ts`、`rule-version.unit.test.ts`：规则类型、闸门、规则版本展示。
- `test/integration/production-web-push.test.ts` 的 `[HR-4]`：待重审（`needs_review`）的规则与生效规则一样延后并延长有效期；规则在读取后、写入前被撤销，不留延后。
- `test/integration/production-memory-capture.test.ts` 的 `[HR-4]`：经 `rule_set` 工具，“夜里别提醒我”立成生效规则，错误时段被拒绝；“今晚别提醒我”不算长期有效。
- `test/integration/data-export-rules.test.ts` 的 `[HR-4]`：规则随数据导出导入往返。

[↑ 回到阅读导航](#contents)
