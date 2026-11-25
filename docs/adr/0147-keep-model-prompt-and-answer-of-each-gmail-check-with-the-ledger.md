---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-01"
covers: "apps/agent-service/src/production-model-composition.ts, apps/agent-service/test/model-payload-cleanup.unit.test.ts, packages/application/src/services/proactive-rules.ts, packages/persistence-sqlite/src/sqlite-proactive-operations.ts, packages/runtime-pi/src/pi-model-transport.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0147：Gmail 检查的决策账本记下输入，并清理模型调用留下的无人管的加密内容

> 2026-11-25 补：Gmail 检查不再调用模型逐封判断，新邮件改为进收件箱、由主对话里的她自己决定要不要告诉主人（[ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 第 1 步，PR 648）。本文里关于邮件判断提示词、判断结果和判断前带给模型的内容的部分已不再执行；规则手册、决策记录等其余部分照旧。

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P0-5（Andy 2026-11-01）要求：Gmail 主动检查在[决策账本](0143-decision-ledger-for-model-gate-decisions.md)（数据库里记每次判断依据和成本的表 `decision_ledger`）里的记录要带上输入，这样一次误扰才能归因到“依据的是什么”。现状：

- Gmail 行的 `inputs` 列固定写 `'{}'`（`packages/persistence-sqlite/src/sqlite-proactive-operations.ts`），从来没有内容。
- 每次检查调模型时，系统把整段提示词（发给模型的全部文字，含每封邮件的发件人、标题、Gmail 摘要）和模型的每段回答各加密存进 `payloads` 表，但**没有任何记录指向它们，也没有任何代码删除它们**：提示词在 `apps/agent-service/src/production-model-composition.ts` 的 `proactiveModel().prepare()` 写入，回答在 `packages/runtime-pi/src/pi-model-transport.ts` 的每段输出写入，检查结束时只撤销了模型的密钥。同一段“写入提示词和回答”的代码还被 `generateText` 使用（线程标题、记忆捕获、每日整理三处调用），同样不删。
- 系统判断“某份加密内容有没有被别处用着”时只看有外键（数据库的约束：被引用的行不允许删除）指向它的列（`isPayloadReferenced`）。把引用编号写在文本列里，系统看不见，别的清理可能把它误删。
- Gmail 检查这一轮实际没有给模型注入任何记忆（提示词里只有发件人、标题、摘要、时间），所以“这一轮注入了哪些记忆”今天的真实答案是“没有”，不存在可以复用的记录。带记忆另行处理，不在本 ADR 范围内。

[返回目录](#contents)

<a id="decision"></a>

## 决定

1. **新表 `decision_ledger_payloads`（迁移 0070）：** 每行记“某个账本决策的第几次模型调用，留下了哪份加密内容、是提示词还是回答”。列：`decision_id`（外键指向账本行，`ON DELETE CASCADE`）、`sequence`（调用顺序）、`role`（`model_input` 或 `model_output`）、`payload_ref`（外键指向加密内容，`ON DELETE RESTRICT`）。因为是外键，系统的“有没有被用着”检查自动认得它，别的清理不会误删。
2. **检查过程中收集引用：** `ProactiveMailCheckService` 在每次模型调用准备好提示词后记下提示词的引用，每收到一段回答记下该段的引用；收集器由检查本身持有，调用中途失败或抛错也不丢。失败重试和多批邮件都按顺序记入。
3. **同一个事务写入：** `proactive.record` 在同一个数据库事务里写账本行、`inputs` 和上表的行。写入失败时，检查删除已存的提示词、回答，以及已封存的摘要和邮件头，不留垃圾。
4. **`inputs` 的内容（明文，不含邮件正文）：** `memoryIds`（本轮实际放进提示词的记忆，目前没有，为空）、`ruleIds`（命中的地板规则短代码）、`sourceIds`（真正放进过提示词的邮件编号，上限 500）、`floorHits`（每封邮件命中了哪几条规则）、`memoryInjected`（本检查有没有带记忆，目前为 `false`，以免空数组被误读为“没选中”）。扩展 [ADR 0143](0143-decision-ledger-for-model-gate-decisions.md) 第 3、4、13 条：`inputs` 本来就是自由文本列，加字段不需要改表结构。
5. **地板规则的短代码：** 地板规则是不经过模型、把邮件至少提到“值得知道”的规则（[ADR 0106](0106-proactive-loop-v1-gmail-read-only.md) 第 4 条）。短代码 `floor_important_sender`、`floor_public_domain`、`floor_money_words` 是 `packages/application/src/services/proactive-rules.ts` 里集中定义的常量；新增 `floorHitIds` 返回命中了哪几条，[hitsFloor](https://github.com/sixianli/himawari-agent/blob/eb128285317814ff89176657023f3bdb345dc973/packages/application/src/services/proactive-rules.ts) 的行为不变。（[ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md) 起，词表和后缀搬到 `rules/rule-book.ts`，[hitsFloor](https://github.com/sixianli/himawari-agent/blob/eb128285317814ff89176657023f3bdb345dc973/packages/application/src/services/proactive-rules.ts) 已移除，行为不变。）
6. **读取：** `DecisionInputs` 和 `entryFromRow` 带上新字段（否则读取时会被丢掉）；`ProactiveStorePort.readDecisionPayloads` 按决策读出引用，`ProductionProactive.readDecisionModelIo` 解密后给出提示词和回答。
7. **删除顺序：** 外键 `RESTRICT` 要求先删上表的行、再删加密内容。
   - 清除主动检查记录：先收集该来源所有引用（含上表的），再删上表的行和账本行，最后由调用方删加密内容。
   - 断开 Gmail：账本行和 `inputs` 保留；先删上表里该来源的行，再删加密内容。
8. **保留期不变：** 不自动删除，清除记录或断开 Gmail 时删除；不新增期限（Andy 2026-11-01：以后再说，存储空间不是问题）。
9. **同类问题一起修：** `generateText`（线程标题、记忆捕获、每日整理）在调用中收集提示词和每段回答的引用，调用结束（成功或失败）就用写入层新增的 `release` 删除。它们没有任何地方要读这些内容（核实：删除加密内容的入口都只处理被明确告知的引用，没有按时间的清扫，这三处的引用只在函数里短暂存在），所以不需要上表。只有 Gmail 检查因为账本要留着它们用来解释，才保存。
10. **不改模型看到的内容，不改费用上限。** 本 ADR 只做记录和清理。

[返回目录](#contents)

<a id="options"></a>

## 放弃的做法

- **把引用编号写进 `inputs` 文本：** 系统的“有没有被用着”检查看不见文本里的编号，别的清理可能把内容误删。
- **账本表 `content_ref` 列装提示词：** 一次检查有多批邮件和失败重试，一列只能放一个引用。
- **另存一份快照提示词：** 是在一个泄漏旁边再多存一份，没有修根因。
- **先带记忆再记：** 是另一个改动，见带记忆方案，单独评审。
- **三处 `generateText` 也建关联表：** 没人要读它们，保存只会增加长期保存的敏感文字；若以后要对记忆捕获做回放评估，再改成账本保存。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 提示词和回答会随账本长期保存，每轮几 KB 到几十 KB。**这不是新增的“发给模型”，但是新的“长期保存”**：今天这些内容其实已经存着，只是没人管。[ADR 0106](0106-proactive-loop-v1-gmail-read-only.md) 第 7 条“都不存正文”里的“正文”指邮件正文，仍然成立；发件人、标题、摘要现在以加密形式随账本保存，清除或断开时删除，已在 Gmail 设计规格里写明。
- 进程恰好崩在“存加密内容”和“写账本”之间仍会留下垃圾；已经存在的旧垃圾无法一一找出，不处理。
- 若以后把整封邮件交给模型，账本保存的提示词会包含邮件正文，体积和敏感度更大；那一项要等“送模型前统一脱敏”完成，本 ADR 的表和删除顺序不用改。
- 门槛：
  - [test/integration/proactive-mail-check.test.ts](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/test/integration/proactive-mail-check.test.ts) 的 `[P0-5]` 组：提示词解密后逐字等于发给模型的内容；`sourceIds` 恰好等于提示词里的邮件；多批和缩批重试的引用按顺序都在；模型失败时提示词仍被记；300 封邮件不被拒；被跳过的邮件不进 `sourceIds`；没有邮件送模型时没有关联行（反向）；写入失败后没有遗留的加密内容（反向）；清除记录和断开 Gmail 之后内容读不到，断开后账本行和 `inputs` 还在；账本行还关联着内容时直接删内容被外键挡住（反向）。
  - `apps/agent-service/test/model-payload-cleanup.unit.test.ts`：`generateText` 的三种用途各跑一次成功和失败，调用后没有遗留的加密内容；邮件判断的提示词在调用方释放之前保留；调用点清单写在测试里，新增调用点没接清理机制，测试会失败（在旧代码上这些用例全部失败，已核实）。
- 迁移编号取当时 main 上的最大号加一；本 PR 写作时是 0070。

[返回目录](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0143：决策账本](0143-decision-ledger-for-model-gate-decisions.md)
- [ADR 0106：主动闭环第一刀（只读 Gmail）](0106-proactive-loop-v1-gmail-read-only.md)
- [Gmail 主动检查设计规格](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md)
- [产品愿景 v2.2](../product-vision.md)

[返回目录](#contents)
