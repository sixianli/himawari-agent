你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希，代码原文取自那个提交里的文件；这样写只限于当前提交里已经没有这段原文的旧代码，讲现状的句子仍然用当前提交里的文件和行。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行 或 文件:行@完整提交哈希>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 0e3f8ac757009f835da7acad3019773b6ee4f41e。
本 PR 的基线提交是 34f2e1411ce45e483eae0d3cbb3418343c0ad67e（main 与 0e3f8ac757009f835da7acad3019773b6ee4f41e 的共同祖先）。
待核对的方案：
方案文件：docs/adr/0282-evaluation-facts-live-in-the-decision-record-tables.md（在提交 0e3f8ac757009f835da7acad3019773b6ee4f41e 里的内容）

---
status: active
document_type: adr
decision_status: proposed
supersedes: ""
superseded_by: ""
amends: "docs/adr/0182-record-proactive-implicit-signals.md"
date: "2026-11-15"
---

# ADR 0282：判断 Himawari 变好还是变坏所需的事实，只存在决策记录这一组表里

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
  - [一、每次判断一行](#d-judgment)
  - [二、当时是哪一版](#d-context)
  - [三、判断之后发生的事](#d-events)
  - [四、通知的送出、点开和划掉](#d-push)
  - [五、Andy 的评价和抽样](#d-rating)
  - [六、怎样算出结论](#d-metrics)
  - [七、导出、导入和接口](#d-export)
- [实施顺序](#rollout)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

产品愿景的 Jarvis Test 第 10 条要求连续 30 天统计所有由模型做的门槛决策（要不要开口、记忆留不留、整理做不做），并且“趋势可量化”。Andy 2026-11-15 把问题说得更直接：要记哪些数据、数据的什么状态，才能判断整个系统和 Agent 是变好了还是变坏了；现在数据散在很多表里，要不要整理。

要下“变好还是变坏”的结论，四样东西缺一不可：

1. 每一次判断，做了和没做都算，连同当时看到的材料和模型给的把握。
2. 这次判断的正确答案。
3. 做判断时是哪一版：模型、提示词、门槛和设置。
4. 这次开口有没有到 Andy 眼前。

现状是：邮件的系统主动提醒有第 1 样和一部分第 2 样；“想一想”（[ADR 0274](0274-new-things-go-through-one-think-entrance.md)）不写决策记录；第 3 样在决策记录的写入字段里没有位置（前提 2）；第 4 样本决定只找到推送表在记（前提 9）。同一件事还记在两处（通知的点开既在推送表又在决策信号表；邮件有按次和按封两套评价）。

本决定只定“记什么、存哪里、怎么算”，不含统计页面，也不新增或修改任何模型调用。

<a id="premises"></a>

## 前提

1. 愿景要的是所有模型门槛决策的趋势：`docs/product-vision.md` 第 3.7 节表格第 10 行，原话“连续 30 天统计所有由模型做出的门槛决策”“附样本量”“趋势可量化”。
2. 决策记录的写入字段里没有模型、提示词或设置的版本：`packages/application/src/ports/decision-ledger.ts` 的 `DecisionLedgerWrite` 只有 `id, ownerId, agentId, kind, decidedAt, outcome, reasonCode, subjectRef, inputs, reasonRef, contentRef, costMicros, durationMs, category, confidencePermille, inferred`。
3. 把握分数只允许记忆候选记：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts` 原话 `"Decision ledger candidate fields belong to memory candidates only"`；迁移 `packages/persistence-sqlite/src/migrations/20261114172143_proactive_source_registry.sql` 原话 `kind = 'memory_candidate' OR (category IS NULL AND confidence_permille IS NULL AND inferred IS NULL)`。
4. 来源名一栏只允许邮件那一种决策用：同一迁移原话 `CHECK ((kind = 'proactive') = (scenario IS NOT NULL))`。
5. 决策信号只有三种，写死在表里：同一迁移原话 `signal TEXT NOT NULL CHECK (signal IN ('opened', 'undone', 'replied'))`；代码里是 `packages/application/src/ports/decision-ledger.ts` 的 `export const DECISION_SIGNALS = ["opened", "undone", "replied"] as const;`。
6. 想一想判断完只改自己的队列状态，不写决策记录：`apps/agent-service/src/production-think-worker.ts` 原话 `if (verdict === "skip") return await settle("skipped", "worth_no");` 和 `if (verdict === "unsure") return await settle("skipped", "worth_unsure");`；`apps/agent-service/src/production-think-runner.ts` 写出提议后只返回 `return { outcome: "proposed", reasonCode: "proposal_written" };`。
7. 邮件判断的把握只有两档，没有数字：`packages/application/src/ports/proactive-checks.ts` 原话 `export type ProactiveConfidence = "sure" | "unsure";`。
8. 邮件有两套评价，单位不同：`proactive_processed_messages` 每封邮件一行，自己带 `owner_rating`（同一迁移原话 `owner_rating TEXT CHECK (owner_rating IS NULL OR owner_rating IN ('useful', 'unneeded', 'missed'))`）；决策记录每次检查一行，也有 `owner_rating`。
9. 推送表按通知记点开和划掉，并且只把“点开”抄进决策信号：`packages/persistence-sqlite/src/migrations/20261114154943_apple_push.sql` 里 `web_push_feedback` 有 `opened_at TEXT`、`dismissed_at TEXT`，主键是 `PRIMARY KEY (owner_id, agent_id, source_key)`；`packages/persistence-sqlite/src/sqlite-web-push-operations.ts` 原话 `if (event.reaction !== "opened" || changes === 0) continue;`。
10. 推送的退避和概览在读推送表的这两列：`packages/persistence-sqlite/src/proactive-push-backoff.ts` 读点开，原话 `feedback.opened_at AS openedAt`；`packages/application/src/services/proactive-overview.ts` 点开和划掉都读，原话 `return sent?.openedAt ? "opened" : sent?.dismissedAt ? "dismissed" : null;`。
11. 统计包按决策种类分组的规则写在代码里，信号名单也写在代码里：`packages/calibration/src/index.ts` 的 `export function calibrationGroup(row: CalibrationDecisionRow): CalibrationGroup | null` 和 `export const IMPLICIT_SIGNALS = ["opened", "undone", "replied"] as const;`。
12. 每天打分现在的取样范围和上限：`packages/application/src/services/daily-review.ts` 原话 `export const DAILY_REVIEW_WINDOW_DAYS = 7;`、`export const DAILY_REVIEW_MAX_RATINGS = 50;`。
13. 想一想当时看到的摘要在条目结束后会被清掉：`apps/agent-service/src/production-think-inbox.ts` 的清理里对已结束的条目执行 `.delete(summaryRef as never)`，再 `clearSummary`。
14. Anthropic 的评测文章（https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents ）：原话 “The most effective teams combine these methods”；用户反馈 “Sparse and self-selected”；A/B 测试 “Slow; days or weeks to reach significance and requires sufficient traffic”。
15. 苹果原生通知能把“划掉”交给 App：`UNNotificationCategoryOptions.customDismissAction` 的说明原话 “Send dismiss actions to the UNUserNotificationCenter object’s delegate for handling.”（https://developer.apple.com/documentation/usernotifications/unnotificationcategoryoptions/customdismissaction ）。

<a id="decision"></a>

## 决定

总原则：**干活用的表只管流程走到哪一步；评估用的事实只存在决策记录这一组表里；每个事实只有一个存放处。** 干活用的表指想一想队列 `think_inbox`、提议箱 `owner_proposals`、推送的 `web_push_outbox` 和 `web_push_attempts`。决策记录这一组表指 `decision_ledger` 和挂在它上面的表。

记录里只存事实（发生了什么、什么时候、在哪个界面），不存结论（这算对还是算错）。结论由统计在读取时按一份带版本号的口径算，口径改了，历史可以按新口径重算。

<a id="d-judgment"></a>

### 一、每次判断一行

1. **评估的单位是“一件事的一次判断”。** 一封邮件、想一想队列里的一个条目、一条记忆候选、一次整理，各是一件事。所有会开口的来源，做了和没做都在 `decision_ledger` 写一行。
2. **重建一次 `decision_ledger`**（沿用迁移 `20261114172143_proactive_source_registry.sql` 里先存 `*_keep` 再重建的写法），改这些：
   - `scenario`（来源名）放开给所有种类用，取值来自已有的来源登记，不写死；不另加“来源”列。
   - `confidence_permille`（把握，千分数）放开给所有种类用。`sqlite-decision-ledger-operations.ts` 里对应的校验一起放开。
   - 新增 `context_id`，指向[第二节](#d-context)的版本表。
   - 新增 `parent_id`，指向同表另一行，用来把“按封的判断”挂到“那一次检查”上。
3. **结果值带一个属性，统计不再在代码里列名单。** `decision_ledger_outcomes` 增加两列：`stance`（`act` 做了或开口了、`silent` 没做或没开口、`none` 不算判断）和 `retired`（1 表示不再允许新写入，旧行保留）。`packages/calibration` 的分组改成读“种类 + 来源名 + `stance`”，删掉写在代码里的对应关系。
4. **邮件：每封被模型判断过的邮件写一行**，种类用新登记的 `proactive_item`，结果值沿用 `proactive_processed_messages.outcome` 现有的 `act`、`know`、`check`、`ignore`，`parent_id` 指向那次检查的记录，材料指向这封邮件已有的邮件头载荷。被规则直接跳过的邮件（现有的 `skipped`）不是模型判断，不写。那次检查的记录保留，作为一次运行的汇总，`stance` 为 `none`，不进对错统计。`proactive_processed_messages` 只留去重和流程用的列，它的 `owner_rating` 搬到按封的那一行决策记录上，然后删掉这一列。邮件的把握仍是“有把握、没把握”两档，照实记在 `inputs` 里，不伪造数字。
5. **想一想：每个条目结束时写一行**，种类 `proposal`，来源名是这个条目的来源种类。
   - 判断为不值得或拿不准：`not_proposed`，`reasonCode` 沿用 `worth_no`、`worth_unsure`、`nothing_to_propose`。
   - 写出了提议：这一行由提议箱写（见下一条），想一想不重复写。
   - 只告诉不提议：`told`。
   - 运行失败、答案无效、动作被拒：新结果值 `not_judged`，`stance` 为 `none`，只计数。
   - 第一步“值不值得”的把握分数写进 `confidence_permille`；当时生效的门槛在版本记录里。
   - 队列状态的改动和这一行决策记录在同一个数据库事务里写。
   - 材料：把她当时看到的那份摘要另存一份，挂在这一行的 `decision_ledger_payloads` 上（`role = 'model_input'`），不指向队列自己的那份（那份会被清理，见前提 13）。保留多久见[后果](#consequences)。
6. **提议箱是 `proposal/proposed` 唯一的写入点。** 任何来源（想一想、对话里、感知、外部 Agent）创建提议时，在 `sqlite-owner-proposal-operations.ts` 创建提议的同一个事务里写一行，`subject_ref` 是 `proposal:<提议编号>`，来源名和版本由创建方传入。`perception-extraction.ts` 里自己写 `proposal/proposed` 的那一段删掉，改成只在决定不提时写 `not_proposed`。
7. `proposal` 种类里原来用来表示 Andy 的反应或后续结果的结果值（`accepted`、`dismissed`、`expired`、`executed`、`failed`、`undone`、`superseded`）标成 `retired = 1`：这些事改记成[第三节](#d-events)的事件，避免两处都能记。

<a id="d-context"></a>

### 二、当时是哪一版

8. 新表 `decision_contexts(id, owner_id, agent_id, fingerprint, first_used_at, first_revision)`。`fingerprint` 是一份键按字典序排好的 JSON，`id` 是它的 SHA-256。同一份内容只存一行。
9. `fingerprint` 的内容：实际作答的模型名和服务方（拿不到实际模型名时记路由名，并标 `modelResolved: false`）、提示词的编号和内容摘要、这次判断读到的每个门槛和设置的键值、可用工具清单的摘要。不放时间、不放服务版本号（服务版本号单独记在 `first_revision`，只表示第一次见到这份内容时的版本），否则每次上线都会变成“新的一版”。
10. `stance` 不是 `none` 的决策记录必须带 `context_id`，由写入校验拦。记忆的保留和丢弃、整理的合并和作废同样带上。
11. 设置改动本身也是事实：Andy 开关一个来源，和改它的上限一样，写一行 `limit_change` 决策记录（键 `enabled`，从 1 到 0 或从 0 到 1）。现在只有改每天上限和每次上限时才写。统计把“关掉一个来源”当作最重的负面事实单独列出，不挂在某一次判断上；所有设置改动在趋势上作为标记显示。

<a id="d-events"></a>

### 三、判断之后发生的事

12. **`decision_signals` 换成 `decision_events`**，每件事一行：`decision_id, event, occurred_at, delay_ms, surface, reporter, source_ref, detail`。`surface` 是发生的界面（App、通知、手表、网页；服务器自己发生的事为空），`reporter` 是谁报的（`server` 或 `client`）。同一决策、同一事件、同一 `source_ref` 去重。只能追加，不能改。
13. **事件种类用参照表 `decision_event_kinds(event, actor, class)`**，不用 CHECK 列名单。`actor` 是 `owner` 或 `system`；`class` 是下面五类之一：

    | `class` | 含义 | 初始取值 |
    |---|---|---|
    | `exposure` | 到了 Andy 眼前 | `shown`（App 里的卡片第一次显示在屏幕上，由客户端回报） |
    | `owner_explicit` | Andy 明说的 | `accepted`（说好）、`rejected`（说不用）、`undone`（说好之后撤销，或把已处理的提醒改回未处理） |
    | `owner_implicit` | 从 Andy 的行为看出来的 | `card_opened`（在 App 里点开卡片）、`card_dismissed`（在 App 里划掉卡片）、`replied`（提醒之后他自己去做了） |
    | `system_result` | 系统后来发生的 | `executed`（说好之后办成）、`execution_failed`、`expired`（到期没人理）、`superseded`、`withdrawn` |
    | `rating` | Andy 的评价 | `rated`（`detail` 里是评价值；改评价再写一行） |

14. 一个事件算正面还是负面，不存在表里，写在统计口径里（见[第六节](#d-metrics)）。理由：这是解释，不是事实；“划掉”可能是看完了，也可能是嫌烦，口径会改。
15. 提议箱的每次状态变化，在 `sqlite-owner-proposal-operations.ts` 的同一个事务里写对应的事件：采纳、拒绝、撤销、过期、被替代、撤回、办成、办失败。
16. “没反应”不写。读取时按可改的时间窗口算。
17. 旧数据：`decision_signals` 里的 `undone`、`replied` 搬进新表；`opened` 不搬（它是推送表 `opened_at` 的副本，见下一节）。

<a id="d-push"></a>

### 四、通知的送出、点开和划掉

18. **通知这一层的事实只存在推送表里。** `web_push_feedback` 保留 `first_sent_at`、`devices`、`opened_at`、`dismissed_at`：它们说的是“这条通知”，而很多通知背后没有模型判断（Andy 自己定的提醒、审批请求、任务完成），退避读点开、概览读点开和划掉（前提 10）。
19. **不再把“点开”抄一份到决策这一侧。** 统计要知道某次判断的通知有没有点开，按决策记录的 `push_source_key` 去推送表查。
20. `web_push_feedback` 的主键加上 `channel`，同一条通知经网页推送和苹果推送各一行，互不覆盖。
21. 名称上分清三层：`sent`（推送服务收下了，不等于到了设备）、`shown`（卡片在 App 里显示了，客户端回报）、点开。统计里“到了 Andy 眼前”指：通知已送出，或有 `shown` 事件。
22. 没有模型判断的通知不进对错统计，只单独列点开的比例，用来看通知是不是太多。
23. 客户端回报：`push.feedback.record` 放开给 iPhone、Mac、手表用（苹果端通知分类打开 `customDismissAction`，见前提 15）；App 里卡片的显示、点开、划掉用一个新命令回报，带决策编号、事件、界面、发生时间和一个去重编号。服务器校验设备身份，把发生时间限制在这次判断之后、服务器当前时间之前。

<a id="d-rating"></a>

### 五、Andy 的评价和抽样

24. 评价值不变（数据库里是 `useful`、`unneeded`、`missed`，界面上是“做对了、不该做、该做没做”）。`decision_ledger.owner_rating` 存最新的评价，每次评价和改评价另写一条 `rated` 事件留历史。
25. **每天打分的范围扩到所有来源**，包括想一想的“没提”。新表 `decision_rating_samples(decision_id, sampled_on, stratum, probability_permille)` 记下每天抽了哪些、从哪一层抽的、被抽中的概率。
26. 分四层抽：
    - `random_silent`：从所有“没做”的判断里纯随机抽。**“该做没做”的比例只用这一层算**，否则专挑可疑的来评，会把这个比例算高。
    - `random_spoken`：从所有“做了”的判断里纯随机抽。
    - `needs_answer`：到了 Andy 眼前、但他没有明说好或不用的。
    - `near_threshold`：把握分数离门槛近的。
    各层占多少、每天最多几条，是设置项，可见可改。已经有明说事件的不抽。
27. 模型预评（`decision_prereviews`）、Muse 对照、观察期照旧，不在本决定里改。

<a id="d-metrics"></a>

### 六、怎样算出结论

28. **正确答案分三档：** Andy 的评价，高于 Andy 明说的事件，高于行为推测。前两档进对错；第三档单独列，不进对错。
29. **口径是一份带版本号的定义**，放在 `packages/calibration`：哪些事件算正面、哪些算负面、“没反应”的窗口多长、最少要多少样本。每周的统计快照写明用的是哪一版口径；口径改了，旧快照不改，新旧可以各算一遍对比。
30. 每个“种类 + 来源名”一组，按版本（`context_id`）分列，7 天和 30 天两种窗口，每个数都带样本量和 Wilson 置信区间：
    - 做对的比例 = 有答案且判为对的“做了” ÷ 有答案的“做了”。
    - 该做没做的比例 = `random_silent` 层里评为“该做没做”的 ÷ 这一层评过的。
    - 打扰量 = 每天到了 Andy 眼前的次数；其中 Andy 明说不用、撤销或关掉来源的次数。
    - 办成的比例 = 办成的 ÷ 说好的。
    - 有答案的比例 = 有答案的“做了” ÷ 到了 Andy 眼前的“做了”。太低说明上面的数不可信。
    - 另列：因为没到眼前而不计入的条数、还在窗口内等反应的条数、记录有没有断档（沿用观察期的检查）。
31. **“变好”“变坏”的判定：** 比较两个时间段时，算两个比例之差的置信区间（两组独立样本，Newcombe 方法，是新增函数；现有的 `pairedDifferenceInterval` 是配对数据用的，不能直接拿来用）。区间不含 0，并且差值超过设置里的“最小有意义差值”，才说这个数变了。一组数据整体说“变好”，要同时满足：做对的比例升了或打扰里的负面降了；该做没做的比例没有变差；有答案的比例没有明显下降；这段时间里没有设置改动或版本更替把两段数据混在一起（有就按版本分开比）。否则一律写“看不出”，并写明差多少样本。
32. **不花钱的重算：** 有数字把握分数的判断（想一想的“值不值得”、记忆候选），改门槛前可以用历史记录直接算出“门槛是 X 时，各个数是多少”，不调用模型。邮件没有数字分数，做不了这一项。
33. **要花钱的重考**（换模型或改提示词后，把评过的历史判断连同材料重做一遍比分数）不在本决定里；它要调用模型，开工前单独报费用，等 Andy 同意。本决定保证它需要的数据（材料、答案、版本）都记全。

<a id="d-export"></a>

### 七、导出、导入和接口

34. 数据导出格式升一版，包含新表和新列；导入旧版本备份时，`decision_signals` 按[第三节](#d-events)的规则转成事件。配一个“导入旧备份”的测试。
35. 事件种类、结果值这类会增长的取值，在网关契约（`packages/gateway-contracts`）和导出格式（`packages/persistence-sqlite/src/data-export`）里不再各自列一份名单，统一从参照表对应的一处常量来；配一个测试：参照表里登记一个新取值后，写入、读取、导出、导入每一处都接受它。
36. 给以后的统计页面和想一想的周报留一个只读查询：按组、按窗口、按版本返回[第六节](#d-metrics)的数和判定。本决定不做页面。

<a id="rollout"></a>

## 实施顺序

编码不在设计线程做，由协调者另开线程。建议拆成四个 PR，按顺序合：

1. **表和读写接口**：重建 `decision_ledger`，新建 `decision_contexts`、`decision_events`、`decision_event_kinds`、`decision_rating_samples`，参照表加属性，推送表改主键，旧数据搬迁，导出导入升版。不改任何写入点的行为。
2. **各处写入**：邮件按封写、想一想写、提议箱写判断和事件、来源开关写记录、所有模型判断带版本。想一想的来源登记依赖想一想线程的 PR 4。
3. **抽样和统计**：每天打分分层抽样、统计口径和判定、只读查询、设置项。想一想周报的三个数调用它。
4. **客户端回报**：服务器命令先做；苹果端和网页端的回报交给各自的线程。

每个 PR 的验收都要有反向用例：没到 Andy 眼前的判断不进打扰量；没有答案的判断不进对错；样本不够时判定必须是“看不出”。

<a id="industry"></a>

## 业界怎么做

- Anthropic 的评测文章（前提 14）：离线评测和线上监控一起用；用户反馈稀少而且是自己挑着给的；A/B 测试要足够的流量。Himawari 只有一位主人，做不了 A/B，所以用“线上趋势 + 历史判断重算或重考”代替，并把 Andy 评过的判断留作以后的考题。
- 学术界评主动 Agent 用准确率、召回率、误报率（Proactive Agent，https://arxiv.org/abs/2410.12361 ）；PARE（https://arxiv.org/abs/2604.00842 ）另加采纳后办成的比例和提议的频率。本决定的五个数和它们对应。
- 推荐系统把反馈分成明说和行为两类（YouTube，https://support.google.com/youtube/answer/16089387 ）。本决定的事件 `class` 照这个分，并且把“算正面还是负面”留给统计口径。
- 两个独立比例之差的置信区间用 Newcombe 的方法（R. G. Newcombe, “Interval estimation for the difference between independent proportions: comparison of eleven methods”, Statistics in Medicine, 1998），它建立在已经在用的 Wilson 区间之上。
- 我们为什么这样做：单人数据少，每个数都必须带样本量和区间，宁可说“看不出”。放弃了什么：不做线上 A/B，不做“不提醒他也会去做”这类因果推断。

<a id="options"></a>

## 放弃的做法

- **推送表不再记点开和划掉，全部搬到决策这一侧。** 设计线程曾这样提议。放弃的原因：没有模型判断的通知没有决策记录可挂，要为它们造假的“判断”行；退避和概览在读这两列（前提 10）。改成推送表是这类事实唯一的存放处，删掉决策这一侧的副本。
- **给邮件判断补一个数字分数。** 现在只有两档。补数字要改发给模型的内容和输出格式，属于模型调用改动，不在本决定里；要做另出方案。
- **把事件的“正面、负面”写进参照表。** 口径会变，写进表里改一次就要改数据。
- **只挑可疑的沉默给 Andy 评。** 省他的时间，但算出来的“该做没做”比例会偏高，不能代表全部沉默。保留这一层，另加纯随机的一层专门用来算比例。
- **两段区间不重叠就说变了。** 这比“差值的区间不含 0”更保守，样本少时几乎永远得不出结论；改用差值的区间。
- **给每个来源各建一套评估表。** 每加一个来源就要再建一套，统计也要各写一遍。
- **在决策记录上加一列“来源”。** 已有的 `scenario` 就是来源名，放开它的限制即可。

<a id="consequences"></a>

## 后果

- 决策记录的行数会变多：每封被判断的邮件、每个想一想条目各一行。单人使用量下可以接受，没有测量过具体大小。
- 想一想当时看到的摘要要跟着决策记录留下来，否则以后无法重算或重考。它原本在条目结束后就清掉（前提 13）。新增设置项“评估材料保留天数”，建议默认不过期，Andy 清除主动记录时一起删。**这一项改变了数据留多久，需要 Andy 点头。**
- 邮件的每天打分以“一封邮件”为单位；按“一次检查”打分的入口不再出新条目，已有的评价保留可查。网页和 App 上每天打分的界面要跟着改，由做界面的线程出原型。
- `decision_signals` 表不再存在；读它的校准周报“观察信号”一节改读事件表和推送表。周报历史格式要再升一版。
- 所有写决策记录的地方都要带版本信息，写入校验会拦住不带的。实际作答的模型名怎样从模型调用的返回里取到，由编码线程核实后定；取不到时按第 9 条记路由名。
- 头一两个月很多组的判定会是“看不出”。这是如实的结果，不是缺陷。
- 本决定修订 [ADR 0182](0182-record-proactive-implicit-signals.md) 的第 1、2、4 条（信号表换成事件表，点开不再抄一份），修订 [ADR 0102](0102-record-push-notification-feedback.md) 的第 1、4 条（主键加渠道，苹果端可以回报划掉），并替换 [ADR 0154](0154-weekly-calibration-report-and-muse-mail-pairing.md) 里按代码分组的做法。这三份 ADR 的其余内容仍然有效。
