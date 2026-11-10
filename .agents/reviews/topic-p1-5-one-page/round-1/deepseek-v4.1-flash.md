I'll start by reading the governing rules and the key files named in the brief, then verify the claimed facts in code.
Bash is restricted to git commands. I'll use the file tools.
Now the control-center pages and the Muse/weekly wiring.
Now let me examine the contracts, the ledger port, weekly report data, and Muse intake/pairing.
# P1-5：一封 Gmail 邮件的完整决策追踪页（独立方案）

## 一、方案依赖的前提（均已读代码或来源核对）

1. **发给模型的内容只追加、开头冻结；只读查询和界面不在此列。**
   - 来源：`.claude/rules/prompt-prefix.md:27-29`：“固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息”“每轮都会变的内容只放在最后一条用户消息里……系统提示和工具定义里不得出现会变的值”。
   - 来源：`.claude/rules/prompt-prefix.md:35`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”
   - 来源：`docs/adr/0195-show-the-whole-chain-of-one-decision-record.md:37`：“只读已存的记录：不重算、不改发给模型的任何内容，不加迁移。”

2. **`decision.chain.read` 已经能按决策记录编号读出完整链，并已实现缺项状态和受限记忆隐藏。**
   - 来源：`apps/agent-service/src/production-decision-chain.ts:81-92`（按 `decisionId` 读 ledger，未找到抛 `DECISION_RECORD_NOT_FOUND`）。
   - 来源：同文件 `:215-243`（`visible` 为假时记忆正文、原话、依据节点正文都置空，但保留记忆编号和来源编号）。
   - 来源：`packages/gateway-contracts/src/contracts-v2.ts:989-1082`（`decision.chain.read` 的入参和 `recorded/none/not_recorded/not_applicable` 分节状态）。
   - 来源：ADR 0195:36-40（规则出处登记、体量上限、控制中心抽屉）。

3. **链的统计单位是“一次判断/一次读邮件”，不是“一封邮件”；周校准的数字不能挂到单封邮件上。**
   - 来源：`docs/glossary.md:52`（词表 18）：“Himawari 每 15 分钟读一次新邮件……用在每天打分的标签和校准周报的行名上，单位是‘一次读邮件’，不是一封邮件。”
   - 来源：`apps/control-center/src/components/weekly-report.tsx:610-616`（周报按决策分组行渲染）。
   - 来源：`packages/calibration/src/index.ts:280-309`（`summarizeDecisions` 按决策行分组，分母是评过的决策数）。

4. **gapCases 的 `id` 是邮件编号的哈希，不带决策记录编号；但底层查询其实已经拿到了 `decisionId`。**
   - 来源：`apps/agent-service/src/production-gap-cases.ts:39-41`（`gapCaseId` 是 `gap_` + sha256 前 20 位）。
   - 来源：同文件 `:79`（返回时只放 `id: gapCaseId(...)`，丢掉了 `candidate.decisionId`）。
   - 来源：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:514-563`（`readGapCandidates` 的 SQL 已 join `decision_ledger`，返回 `decisionId`、`memoryHitsForMail`、`relatedMessagesForMail`）。

5. **`proactive_processed_messages` 是“Gmail 邮件编号 → 决策记录编号”的现成映射，不需要新表。**
   - 来源：`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:99-114`（主键 `(owner_id, agent_id, source, message_id)`，含 `decision_id`、`thread_id`、`outcome`、`skip_reason`、`header_ref`、`owner_rating`）。
   - 来源：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:696-718`（`INSERT ... ON CONFLICT DO NOTHING`，即同一封邮件只保留第一次处理时的决策）。
   - 来源：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:526-530`（现有 gap 查询正是这样 join `proactive_processed_messages` 和 `decision_ledger`）。

6. **Muse 条目按 Gmail 邮件编号配对，且已有“Muse 实际做了什么”的原始表。**
   - 来源：`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:227-235`（写入/补齐 `gmail_message_id`，并同步 `muse_reference_entries.paired_message_id`）。
   - 来源：同文件 `:497-511`（评分时把 `gmailMessageId` 写进参考条目）。
   - 来源：`packages/application/src/ports/muse-intake.ts:6-11`（proactive 的 state 是 `delivered/suppressed`，scheduled 是 `succeeded/failed`）。

7. **周校准是固定观察期，且未完成时比例要隐藏；本周数字应复用现有周报查询。**
   - 来源：`packages/calibration/src/index.ts:233-257`（`resolveWindow` 以 `end` 为排他上界，7 天窗口）。
   - 来源：`apps/agent-service/src/production-observation.ts:186-209`（周报用 `resolveWindow` + `readCalibrationRows` + `summarize*`）。
   - 来源：同文件 `:238-260`（`ratesWithheld = !complete`，未完成时把 rates 置空）。
   - 来源：`docs/glossary.md:51`（词表 17）：“观察期是从这天起的 7 天”。
   - 来源：`docs/glossary.md:50`（词表 16）：“分母都是你评过的条数，评过的少于 5 条写‘样本不足’”。

8. **现有规则登记只有出处，没有测试；测试映射目前只在文档里。**
   - 来源：`packages/application/src/services/proactive-rules.ts:39-58`（`DecisionRuleDefinition` 只有 `origin`、`document`）。
   - 来源：`docs/agent-rulebook-inventory.md:68-70`（H-1/H-2/H-3 每条都列了对应测试，例如 PG-4、PG-9、PG-17、PG-18、OM-3）。
   - 来源：`docs/product-vision.md:122`：“每条带出处（哪次事件立的）、带回归测试、可导出带走。”

9. **UI 的硬规则：数字必须有定义、说明收进 ⓘ、三语、手机和电脑、缺项不留白。**
   - 来源：`docs/ui-ux-design-guide.md:56`（第 2 条）：“页面上的每个数字都要能说清是怎么算出来的……没有门槛、凑够 3 条就叫‘相关’，是不良设计”。
   - 来源：`docs/ui-ux-design-guide.md:62`（第 48 条）：“解释文字收进标题旁的 ⓘ，页面只放标题、数字和简短状态。”
   - 来源：`docs/ui-ux-design-guide.md:68`（第 10 条）：“同一种意思在中英日里长度不同，按钮和标签不写死宽度”。
   - 来源：问题约束原文：“链上任何一环没有记录，显示‘无记录’，不留空白。”

10. **通用 `/trace` 面是另一个东西，且它的旧操作已被删除；不能复用名字。**
    - 来源：`apps/control-center/src/app/control-center-inventory.ts:358-375`（`id: "trace"`，稳定对象是 `TraceEvent/Run/ActionIntent/...`，`integrationPolicy: "blocked"`）。
    - 来源：`ci/operations-removed.json:26-28`（`trace.detail`、`trace.snapshot`、`trace.timeline` 已在 P1-4 删除）。

11. **新增操作必须同时进契约、生产安装列表、浏览器配置和路由，否则页面永远看不到；`check:operations` 只查其中一部分。**
    - 来源：`scripts/check-operations.mjs:201-227`（只检查“后端实现 / 调用方 / 测试”三项，不检查 `installedGatewayV2Operations` 和浏览器配置）。
    - 来源：`apps/agent-service/src/production-approval-gateway.ts:103-120`（按 `query.type` 前缀分派）和 `:248-261`（`installedOperations` 由各 `PRODUCTION_*_OPERATIONS` 拼成）。
    - 来源：`apps/agent-service/src/production-http-composition.ts:661-671`（浏览器拿到的 `installedGatewayV2Operations` 也是这里拼的）。

12. **Gmail 邮件编号的存储校验和前端路由校验不是同一套，不能混用。**
    - 来源：`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:41-45`：`GMAIL_MESSAGE_ID = /^[A-Za-z0-9_-]{1,256}$/`。
    - 来源：`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:103`：`message_id` 长度 1-256。
    - 来源：`packages/gateway-contracts/src/validation.ts:49-60`：`machineString` 只允许 1-128，且首字符必须是字母数字。
    - 来源：`apps/control-center/src/app/router.ts:27`：路由的 `MACHINE_VALUE` 是 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`，同样只到 128、首字符必须是字母数字。

---

## 二、读代码/来源证实的与推测的

**已证实**

- `decision.chain.read` 只按决策记录编号读，返回规则、记忆、推断依据、评价，但没有“这封邮件”的身份、单封结果、Muse 信息；它只有 `mails.judged` 和 `mails.related` 两个计数（`production-decision-chain.ts:117-125`）。
- gapCases 现在不能从一封 Muse 配对的邮件直接找到决策记录：`GapCandidate` 有 `decisionId`，`buildGapCases` 把它丢了（`production-gap-cases.ts:79`；`decision-ledger.ts:187`）。
- `proactive_processed_messages` 已经能按 Gmail 邮件编号找到 `decision_id`、单封 `outcome`、`thread_id`、`owner_rating`、`header_ref`，所以不需要新表。
- Muse 的原始条目 `muse_intake_items` 有 `gmail_message_id`，参考条目 `muse_reference_entries` 有 `paired_message_id`；周报的 Muse 统计只使用参考条目（评分后才有），不是所有 Muse 条目。
- 周报的比例在 `complete=false` 时被置空（`production-observation.ts:244-259`）。
- 当前 `/trace` 是执行 Trace 面，不是决策追踪面；其旧操作已删。
- 前端路由 `objectId` 最多 128 字符且首字符必须是字母数字；Gmail 邮件编号可以到 256 且可以以 `_`/`-` 开头。这是一个现成的“生产出的 id 过不了使用端校验”的隐患。
- 规则登记表没有 `test` 字段；测试映射在 `docs/agent-rulebook-inventory.md`。

**推测/未核实**

- 真实 Gmail `message_id` 通常 16 位十六进制，是否会出现 129-256 位或以下划线/连字符开头，未在真实数据上核实；但存储层允许，设计必须按最宽口径处理。
- `muse_intake_items.naturalKey` 最长 150，而 `muse.overview.snapshot` / `muse.item.rate` 用 `machineString`（最多 128）。这是现有潜在不一致；未核实生产里是否出现过 129-150 的自然键。本方案不依赖 `naturalKey` 作为邮件键。
- 页面放置位置、是否允许在页面里直接做导出/评分、是否把测试路径链到 GitHub，属于需要 Andy 拍板的产品取舍，下面单列。
- 性能：按 `muse_intake_items.gmail_message_id` 查询目前没有看到专门索引（迁移 0079 只加了列和 CHECK），数据量未核实；第一版按 owner/agent + limit 控制，若变慢再单独评估只读索引迁移。

---

## 三、方案

### 3.1 总体

新增**一个只读解析查询** `decision.email.read`（快照 `decision.email.snapshot`），入参是 Gmail 邮件编号；它只负责把“一封邮件”解析成三样东西：

1. 这封邮件的单封判断：`thread_id`、`outcome`、`skip_reason`、`decision_id`、`owner_rating`、`ruleIds`、`memoryIds`、`relatedMessages`、可选的已遮盖邮件头（发件人/标题/链接）。
2. 这封邮件对应的 Muse 原始条目（可能多条），包括 `delivered/suppressed`、时间、标题/正文（尊重 `text_withheld`）、时机/内容评价。
3. 一个按周报同一定义计算的“可比较状态”（见 3.3）。

**不新表、不迁移。** 解析查询只读现有表：`proactive_processed_messages`、`decision_ledger`、`muse_intake_items`、`muse_reference_entries`、`source_insights`（取已遮盖的 from/subject/link）。

页面**不重复实现链和周报**：
- 拿到 `decisionId` 后，调用现有 `decision.chain.read` 渲染完整链（规则、记忆、推断依据、评价），与现有 ADR 0195 完全一致。
- 周校准直接调用现有 `proactive.weekly.read`（观察期窗口、未完成隐藏、样本不足、Muse 分组、gap 线全部复用），页面只负责把“这封邮件所在的那次判断/那一周”对应上。

数据流：

```
点一封邮件（messageId）
  → decision.email.read({ messageId })
       → { decisionId?, mail, muse, comparison }
  → decision.chain.read({ decisionId })        （若 decisionId 存在）
  → proactive.weekly.read({ end: null })       （复用观察期周报）
  → 同一屏渲染：邮件 → 决策 → 规则 → 记忆 → 推论 → 评价
                + 该周校准 + Muse 做了什么 + 两边对比
```

### 3.2 新查询的建议形状

入参：

```
{ messageId: string }   // 用 /^[A-Za-z0-9_-]{1,256}$/，不是 machineString
```

快照（示意，字段名最终由契约定）：

```
{
  messageId,
  mail: {
    state: "recorded" | "not_recorded",
    threadId: string | null,
    outcome: "act" | "know" | "check" | "ignore" | "skipped" | null,
    skipReason: "category" | "sensitive" | "own_mail" | null,
    processedAt: string | null,
    decisionId: string | null,          // 交给 decision.chain.read
    ownerRating: "useful" | "unneeded" | "missed" | null,
    ruleIds: string[],                  // 只来自 floorHits[messageId]
    memoryIds: string[],                // 只来自 memoryByMail[messageId]
    relatedMessages: number,
    header: { from: string | null, subject: string | null, link: string | null } | null
  },
  muse: {
    state: "recorded" | "not_recorded",
    items: [{
      kind: "proactive" | "scheduled",
      naturalKey: string,               // 只做键/展示，不作为查询入参
      state: string,                    // delivered/suppressed/succeeded/failed
      decision: string | null,
      reasonCode: string | null,
      occurredAt: string,
      title: string | null,             // text_withheld 为真时必须 null
      text: string | null,
      withheld: boolean,
      timingOk: boolean | null,
      contentOk: boolean | null
    }],                                 // 固定排序：occurredAt, kind, naturalKey
    reference: {                        // 周报统计实际使用的评分条目
      entryId: string,
      museReminded: boolean,
      timingOk: boolean | null,
      contentOk: boolean | null
    } | null
  },
  comparison: {
    state: "unavailable" | "noHimawariRecord" | "museUnrated"
         | "both" | "museOnly" | "himawariOnly" | "bothSilent",
    museReminded: boolean | null,
    himawariReminded: boolean | null
  },
  generatedAt
}
```

关键点：
- `mail.ruleIds` 和 `mail.memoryIds` 来自 `decision_ledger.inputs.floorHits[messageId]` 和 `memoryByMail[messageId]`，这样页面能标出“这条规则/这条记忆是这封邮件命中的”，而不是只看到整批的并集。
- `comparison` 使用与 `packages/calibration/src/index.ts:4-8` 和 `:325-366` 相同的 `HIMAWARI_ATTENTION_OUTCOMES` 与 `pairEntriesByMail` 语义；不在页面里另写一套判断。
- Muse 原始条目和周报参考条目分开：原始条目回答“Muse 对这封邮件做了什么”，参考条目回答“它是否进入校准统计”。没有评分时显示“已记录动作，但未评价，不进入周报比例”，不伪造对比。
- 头部只打开写入时已经遮盖过的 `from/subject/link`（`proactive-mail-check-service.ts:861-865`、`:1299-1311`），**不读 `decision_ledger_payloads`**，遵守 ADR 0195 第 2 条。

### 3.3 页面：`/decision` “决策追踪”

新增一个侧栏页面（`CONTROL_CENTER_PAGES` 加 `"decision"`，路径 `/decision`，标题“决策追踪 / Decision trace / 判断の追跡”），不占用已有 `/trace` 面。页面接收 `?message=<gmailMessageId>`，用专门的正则校验（不是路由的 `MACHINE_VALUE`）。

一屏从上到下：

1. **邮件**
   - 已遮盖的发件人、标题、收到/处理时间、Gmail 原文链接（有则显示）。
   - “这封邮件的 Himawari 判断”：`act/check/know/ignore/skipped` 的界面词，旁边 ⓘ 给定义。
   - 没有记录时写“无记录”，不留空。

2. **决策记录**
   - 决策记录编号、判断结果（`pushed/silent/deferred/...`）、原因、评价和评价时间。
   - “打开完整依据链”直接滚动到第 3 节；编号可复制。
   - 若决策记录已被清除：显示“这条记录已被清除”，不显示空链。

3. **依据链（复用现有抽屉内容）**
   - 把 `decision-chain-drawer.tsx` 的展示体抽成可复用的 `DecisionChainView`，抽屉和页面共用，避免两套渲染。
   - 规则：`ruleId` 的界面词、来源（`owner_setting/built_in`）、文档、命中邮件数，并新增“测试”字段（见 3.5）；这封邮件命中的规则打标。
   - 记忆：正文、状态、是否模型使用、是否待确认、是否推断、决策后是否改过、被谁取代；来源原话和“打开原对话”；受限记忆只显示编号和“内容不在这里显示”。
   - 推断：依据树，每个节点显示正文/动作/时间/重复/截断；节点可点开到记忆详情（记忆页按编号聚焦）。
   - 评价：链接到“每天打分”里对应条目。
   - 分段状态完全沿用 `recorded/none/not_recorded/not_applicable`；被截断时明说“只显示前 N 条/节点”。

4. **该周校准（复用周报）**
   - 显示观察期窗口（`report.startDay/endDay`），并判断这封邮件的 `processedAt` 是否在窗口内；不在窗口内直接写“这封邮件不在观察期，无校准数字”。
   - 只显示与这次判断相关的一行（`proactive_pushed` 或 `proactive_silent`）以及 Muse 分组、gap 线；每个数字的 ⓘ 里写清分母、样本门槛、95% 区间和定义来源（词表 16/17/18）。
   - `ratesWithheld` 为真时只显示“观察期未完成，比例不显示”；评过少于 5 条显示“样本不足（N 条）”，不显示百分比。
   - 明确标注单位是“一次读邮件”，不是“这一封邮件”。

5. **Muse 对这封邮件做了什么**
   - 按时间列出该 Gmail 编号对应的 Muse 条目：`delivered/suppressed`、`send/skip/defer`、原因、发生时间、标题/正文（`text_withheld` 时写“没有留存”）、时机/内容评价。
   - 区分三种状态：“Muse 提醒了”“Muse 明确没提醒”“没有 Muse 记录”，不把后两者混为一谈。
   - 校准只统计已评价条目；未评价的 Muse 动作只展示，不进入比例。

6. **两边对比**
   - 行为层：Muse 提醒/没提醒 vs Himawari 提醒/没提醒，两个布尔值都带定义。
   - 校准层：只有“Muse 有评分参考条目 + Himawari 有这封邮件的判断”时才给出 `both/museOnly/himawariOnly/bothSilent/noHimawariRecord`，与周报 bucket 完全一致；否则显示“无法比较”及具体原因。
   - 可链接到周报的 gapCases 行或每天打分，不在本页做写操作。

7. **入口**
   - 周报 gapCases 行：新增“查看这封邮件的完整追踪”，需要给 gapCases 增加 `messageId`（见 3.4）。
   - 提醒检查记录：每行“依据”保留原抽屉，另加“在追踪页打开”，传该条的 `messageId`；需要给 `proactive.overview` 的 insight/audit 暴露 `messageId`（audit 已有，insight 需要加）。
   - Muse 列表：可选，给 `muse.overview` 条目增加 `gmailMessageId` 后可从 Muse 行进入。
   - 侧栏“决策追踪”默认打开最近的 gap case 或最近的 Muse 条目；都没有时显示空状态和入口说明。

### 3.4 需要同步修改的现有查询（尽量小）

- `proactive.weekly.snapshot.report.gapCases[]` 增加 `messageId: string`（Gmail 规则，1-256）。**不要改 `id` 的计算方式**，`id` 继续用于 `proactive.gapcase.mark` 和导出快照。
  - 风险：`buildGapCases` 的结果会进 `GapCaseSnapshot` 并封存；多一个字段会改变快照字节，但导出响应只取白名单字段，`isGapCaseSnapshot` 也不拒绝额外字段。需要加测试确认导出 `id`、`cases` 结构和 `GAP_EXPORT_SCHEMA` 不变。
- `proactive.overview.snapshot.insights[]` 增加 `messageId`（audit 项已有）。
- 可选：`muse.overview.snapshot.items[]` 增加 `gmailMessageId`；契约里用 Gmail 规则，不要用 `machineString`。

### 3.5 规则“带测试”

- 给 `DecisionRuleDefinition` 增加 `test: string`（例如 `test/integration/proactive-mail-check.test.ts#PG-9`），并只从 `DECISION_RULE_CATALOG` 读取；`decision.chain.snapshot.rules.items[]` 增加 `test: string | null`。
- 新增 `npm run check:rule-catalog`（或并入现有 `decision-rule-catalog.unit.test.ts`）：
  - 每个 `FloorRuleId` 必须有非空 `test`；
  - 解析 `docs/agent-rulebook-inventory.md` 的 H-1/H-2/H-3 行，断言代码里的 `test` 与文档一致；
  - 断言测试文件里确实存在该测试名（防止写了不存在的测试）。
- 这样页面上的“规则 → 出处 → 测试”是可验证的，不是硬编码一句文案。若 Andy 不想在 UI 暴露工程测试编号，可把它放在规则卡的 ⓘ 第二层。

### 3.6 为什么不把周报数字和链塞进新查询

- 链：`decision.chain.read` 已经处理了受限记忆、截断、未登记规则、错误处理；复制一遍必然漂移。
- 周报：`proactive.weekly.read` 已经处理了观察期、未完成隐藏、样本门槛、Muse 分组、gap 线；复制一遍会让页面和周报对不上。
- 新查询只做“解析身份和单封切片”，是最小职责。

---

## 四、考虑过但不选的做法

1. **只用现有查询、零新增操作。** 给 gapCases 加 `messageId/decisionId`、给 Muse 加 `gmailMessageId`、给 overview 加 `messageId`，前端自己拼。
   - 不选原因：gapCases 只覆盖“Muse 做对而 Himawari 没做到”的当周案例（`production-gap-cases.ts:49-63`）；Muse overview 只列最近 20 条可评条目（`production-muse-intake-control.ts:27,94-100`）；overview 只覆盖提醒/审计窗口。三者交集不足以支撑“长期产品页”，且三路数据可能对“同一封邮件”给出不一致的周窗口。可作为没法新增操作时的退路。

2. **扩展 `decision.chain.read`，让它同时接受 `messageId` 并返回 Muse。**
   - 不选原因：`decision.chain.read` 属于记忆控制面，Muse/seal 属于另一个控制面；混在一起会让一个已经很大的快照继续变大，也会改变 ADR 0195 的明确语义（按决策记录编号读）。

3. **复用通用 `/trace` 面。**
   - 不选原因：它是 `TraceEvent/Run/ActionIntent` 的执行面，且 `trace.detail/snapshot/timeline` 已被删除；重新定义要么撞名，要么另开 ADR。用独立 `/decision` 页面更清楚。

4. **只扩展现有抽屉。**
   - 不选原因：抽屉是按“提醒检查记录行”打开的，没有邮件锚点，也没有周校准和 Muse 对照；无法满足“一个画面”。

5. **新建 trace 表 / 物化视图。**
   - 不选原因：违反“尽量不加表/迁移”；而且链上数据本来就有，物化只会多一份会漂移的副本。

6. **在页面里用原始行自己算校准比例。**
   - 不选原因：会和周报的 `summarizeDecisions/summarizeMuse/summarizeGap` 定义漂移；必须复用周报查询。

7. **用 `gapCase.id`（`gap_<hash>`）作为追踪页的键。**
   - 不选原因：它是不可逆哈希，不是 Gmail 邮件编号；传进新查询会查不到，或者更糟——如果未来有人放宽校验，会指向错误记录。这正是 I-73 的教训：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”（`docs/incidents-and-gates.md:112`）。

8. **为了显示邮件而读取 `decision_ledger_payloads`。**
   - 不选原因：那是判断前的模型输入/输出，可能未遮盖；ADR 0195 明确这一版不显示（ADR 0195:37,49）。本方案只打开写入时已遮盖的 `headerRef` / `source_insights.contentRef`。

---

## 五、风险、反例、需要人拍板的取舍

### 风险与反例

1. **同一封邮件只映射到第一次处理的决策。** `proactive_processed_messages` 用 `ON CONFLICT DO NOTHING`（`sqlite-proactive-operations.ts:696-701`）。如果同一封邮件后来被重新处理，追踪页显示的是第一次的决策，不是最新一次。页面必须写“这封邮件第一次被处理时的决策”；要改“最新”就得改写入语义或加历史表，超出本方案。
2. **周校准不是这封邮件的比例。** 一次判断可能包含多封邮件；页面只能显示“这次读邮件所在的这一周、这一类决策”的比例，不能写“这封邮件的命中率”。这是词表 18 的硬定义。
3. **观察期外的邮件没有周数字。** 观察期是固定的 7 天（词表 17）；旧邮件或观察期开始前的邮件应显示“无校准数字”，不能拿滚动 7 天冒充。
4. **`ratesWithheld` / 样本不足。** 未完成观察期或评过少于 5 条时，页面不能显示 0% 或任何百分比；必须显示“未完成”/“样本不足（N 条）”。
5. **Muse 有三态，不能合并。** 没有 Muse 条目 ≠ Muse 明确没提醒（`suppressed`）≠ Muse 已提醒但没评分。前两者混用会伪造对比；第三者不能进入周报 bucket。
6. **受限记忆可能被别的查询“补”出来。** `decision.chain.read` 会把受限记忆正文置空（`production-decision-chain.ts:215-243`），但记忆总览的 `#memoryViews` 会返回正文（`production-memory-control.ts:404-430`）。追踪页**不得**为了补全依据节点去调用记忆总览；只能使用链返回的 `hidden` 状态。测试要用 sentinel 断言页面上不出现受限正文。
7. **Muse `text_withheld`。** 即使 seal 能打开，只要 `text_withheld=1`，新查询必须返回 null；页面显示“没有留存”。
8. **邮件编号长度/字符集。** 新查询和 `?message=` 路由参数必须用 `/^[A-Za-z0-9_-]{1,256}$/`；现有路由 `MACHINE_VALUE` 只到 128 且首字符必须是字母数字（`router.ts:27`），不能直接复用。否则生产能存下的邮件编号，页面链接打不开。
9. **`decisionId` 两端校验。** 新查询产出的 `decisionId` 必须能通过 `decision.chain.read` 的 `machineString` 校验；旧记录 / 已删除记录要返回“无记录”，不能把 `gap_<hash>` 当决策编号。
10. **规则编号未登记。** `floor_unregistered_rule` 这类编号会返回 `origin:null/document:null`（现有测试已覆盖）；新增 `test` 后也要允许 null，页面显示“未登记的规则”，不能猜。
11. **邮件头来源不完整。** 只有 `ignore` 邮件写了 `headerRef`（`proactive-mail-check-service.ts:856-866`）；提醒类邮件的发件人/标题在 `source_insights.contentRef`（`:1299-1311`）。两者都取不到时只显示邮件编号和 Muse 文本，不能读原始 payload。
12. **性能。** 按 `gmail_message_id` 查 Muse 可能没有专用索引；第一版限制条数、固定排序；若数据量大再单独评估只读索引迁移。
13. **导出。** 现有 `GET /api/gap-cases/v1/export` 是给外部周会话用的 Bearer 接口，而且只导出“已标记的 gap case”（`production-gap-export.ts:12-13`；ADR 0187:47）；没有找到按任意决策记录导出的现有接口。页面不能假装能导出任意决策。
14. **页面放置与设计规范。** UI 规范第 45 条说“完整的提醒决策记录放进设置的邮件那一栏，不占提醒页”（`docs/ui-ux-design-guide.md:94`）。本方案放在独立侧栏页，是否与这条冲突需要 Andy 拍板；备选是 Reminders 的第三个标签页或 Settings → 邮件子页。

### 需要 Andy 拍板

1. **页面位置**：独立侧栏“决策追踪”（推荐，适合面试的一屏和深链接） vs Reminders 第三标签（改动最小） vs Settings → 邮件子页（最贴合 UI 规范第 45 条）。
2. **邮件身份显示到什么程度**：只显示邮件编号 + Muse 标题；还是显示已遮盖的发件人/标题/原信链接（推荐后者，和现有提醒页一致）。
3. **规则测试是否上屏**：只在 ⓘ 第二层显示测试引用（推荐），还是作为规则卡的一等信息；是否配置仓库 URL 做成可点链接。
4. **导出范围**：本页只链接现有 gap case 导出，还是新增一个“按决策记录导出”的只读接口（需要新契约、鉴权、遮盖复检）。
5. **`decisionId` 与邮件编号的深链接参数**：是否接受新增路由字段 `message`（推荐），还是只用页面内事件传值。
6. **旧邮件/已清除记录**：只显示“无记录”，还是保留一个“已清除”墓碑状态（后者要改清除逻辑，不建议）。

---

## 六、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 这个改动是“只读查询 + 控制中心界面”，不碰系统提示、工具定义、历史消息、出口遮盖，也不把任何新值写进发给模型的内容。

- 发给模型的内容仍然只在末尾追加：`.claude/rules/prompt-prefix.md:35`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”
- 每轮会变的值仍然只在最后一条用户消息里：`.claude/rules/prompt-prefix.md:28`：“每轮都会变的内容只放在最后一条用户消息里……系统提示和工具定义里不得出现会变的值。”
- 新查询里的 `generatedAt`、邮件编号、周数字、Muse 条目、评价都只进入控制中心的查询响应，不进入 prompt 组装；ADR 0195 也明确“只读已存的记录：不重算、不改发给模型的任何内容”。
- 规则登记表新增 `test` 字段不会改变提示词文本：`DECISION_RULE_CATALOG` 目前只被 `decisionRuleDefinition` 和规则测试使用，不参与提示词渲染（`proactive-rules.ts:60-64`；调用点仅在 `production-decision-chain.ts:106`）。
- 如果未来要做“让模型解释这条链”的聊天功能，那必须把整条链作为**新追加的一条用户消息**发送，所有会变的值放在那条消息里，不能改系统提示或工具定义；本方案不做这个功能。

**依据**：`.claude/rules/prompt-prefix.md:27-29,35,84`；ADR 0195:37；Anthropic/OpenAI/DeepSeek 的提示缓存说明（`prompt-prefix.md:6` 引用：<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>、<https://developers.openai.com/api/docs/guides/prompt-caching>、<https://api-docs.deepseek.com/guides/kv_cache>）。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会进入模型请求，因此不会影响缓存字节。** 但页面数据本身要保证确定性：

- 新查询必须固定排序：Muse 条目按 `occurredAt, kind, naturalKey`；规则按 `ruleIds` 排序；记忆按现有 `sortedUnique`（`production-decision-chain.ts:64-66`）；`memoryIds`/`ruleIds` 去重排序。
- `generatedAt` 是唯一每轮会变的值，只用于显示；不要写进 `decision_ledger.inputs`，也不要拼进任何 prompt。
- 打开 seal 的文字是确定性的（同一密文同一密钥同一结果）；但如果未来在出口重新遮盖，必须遵守 `prompt-prefix.md:51-54` 的确定性规则。本方案只读写入时已遮盖的邮件头，不再重新遮盖，因此不会因“后面的内容”改变前面的字节。
- 新查询不产生“依赖前后文的遮盖”：它只读已经存下的 `masked` 文本和 `text_withheld` 标志，不做新的上下文敏感遮盖。

**依据**：`.claude/rules/prompt-prefix.md:51-54`：“同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序……都要固定”“遮盖敏感信息必须是确定的。一条消息遮成什么样，只能取决于它自己和它前面的内容，不能取决于它后面的内容。”

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，分四层。关键是每条反向用例都要能在“故意写错”的提交上失败，不只是正向通过。

**A. 契约/操作门槛**

- `npm run check:operations`（`package.json:32`）：新操作必须有后端实现、前端调用方、测试。
- 新增工具测试：`PRODUCTION_DECISION_TRACE_OPERATIONS` 必须包含 `decision.email.read`；`production-http-composition` 的浏览器 `installedGatewayV2Operations` 必须包含它；`production-approval-gateway` 的 `installedOperations` 必须包含它；它不得出现在 `ci/operations-removed.json`。这补上 `check-operations.mjs` 不查安装列表的盲区（`scripts/check-operations.mjs:201-227`）。
- 契约 fixture：在 `packages/gateway-contracts/test/gateway-v2.fixture.ts` 增加 query/snapshot 样本，并过 `gatewayV2MessageSchema`。
- 新增 `check:decision-email-contract`（或并入现有契约测试）：
  - 用 1、128、129、256 位的 Gmail 编号、含 `_`/`-`、以 `_`/`-` 开头、257 位、非法字符分别喂 query schema；
  - 断言 256 位和 `_`/`-` 通过，257 位和非法字符失败；
  - 反向证明不能偷懒复用 `machineString`（`validation.ts:49-60` 只到 128）。

**B. 后端集成测试**（建议 `test/integration/decision-email.test.ts`，真实 SQLite + 真实 seal）

正向：
- 一封 Gmail 邮件 → 决策记录 + 地板规则 + 普通/受限/被取代/推断依据记忆 + 评价；
- Muse 同一 Gmail 编号有 `delivered` 和 `suppressed` 两条 + 一条评分参考条目；
- 断言：单封 outcome、`decisionId`、`ruleIds`、`memoryIds`、`relatedMessages`、邮件头（已遮盖）、Muse 排序、`text_withheld`、comparison 与周报 bucket 一致；
- 把返回的 `decisionId` 直接喂给 `decision.chain.read`，断言成功且规则/记忆/依据/评价一致；
- 把 `proactive.weekly.read` 的同周数字和页面用的字段对比，断言 deep-equal。

反向用例（每条都要故意改坏代码验证会失败）：
1. 未知 `messageId` → `NOT_FOUND`，不是空快照。
2. Muse 有配对、Himawari 没有 processed 行 → `mail.state=not_recorded`，`comparison.state=noHimawariRecord`，页面显示“无记录”。
3. processed 行有、Muse 没有条目 → `muse.state=not_recorded`，comparison 不可用，页面不能写“Muse 没提醒”。
4. Muse 有原始条目但无评分参考条目 → 动作显示，校准 bucket 不可用；不能进入周报 bucket。
5. 受限记忆 → 链正文为 null、`state=hidden`；页面快照里搜不到 sentinel 文本（改坏“隐藏受限记忆”必须失败）。
6. `text_withheld=1` 但 seal 能返回文字 → 新查询仍返回 null；改坏“尊重 withheld”必须失败。
7. 邮件决策在观察期外 → 周校准“无记录”，不显示比例。
8. `ratesWithheld=true` → 比例为空，不显示 0%。
9. 评过少于 `minimumSamples` → “样本不足（N 条）”，不显示百分比。
10. 他人 owner/agent → `NOT_FOUND`。
11. 决策记录已删除 → 邮件/决策显示“无记录”或“已清除”，不崩。
12. 同一请求调用两次 → 除 `generatedAt` 外 deep-equal；固定 clock 时连 `generatedAt` 也一致。
13. 超过 100 条记忆 / 200 个依据节点 / 50 条 Muse 条目 → `truncated` 标志正确，不崩、不静默丢。
14. 规则编号未登记 → `origin/document/test` 为 null，页面显示“未登记的规则”。
15. `mail.ruleIds` 的每个 id 都能在 `chain.rules.items` 找到（或明确未登记）；`mail.memoryIds` 的每个 id 都能在 `chain.memories.items` 找到（未截断时）；用 `gap_<hash>` 代替 `messageId` 会 `NOT_FOUND`。

**C. 前端测试**

- `apps/control-center/test/decision-email.unit.test.ts`（jsdom）：
  - 六个区块都渲染；缺项显示“无记录”；受限/withheld sentinel 不出现；
  - 点击记忆 → 触发记忆页聚焦；点击来源 → `onOpenThread`；点击规则 → 打开 ⓘ；点击邮件链接 → 原信；
  - 三种语言都有对应 message id；错误/加载/空状态都有；
  - 反向：把 `ratesWithheld` 当 false、把 `gapCase.id` 当 `messageId`、把 `machineString` 校验传给 `message`，测试必须失败。
- `test/integration/decision-email-browser.test.ts`（真实浏览器）：
  - 桌面 1280 + 手机 390，三种语言；长编号不撑破布局；无横向滚动；缺项和已清除状态；链接可点。
  - 参照现有 `test/integration/decision-chain-browser.test.ts` 的写法（ADR 0195:59）。
- `apps/control-center/test/weekly-report.unit.test.ts` 增加：gap case 的“查看追踪”用的是 `messageId` 而不是 `id`；目标页读到同一封邮件。

**D. 反向用例真的会失败**

在实现分支里做 4 个“坏改动”并记录失败：
1. 把 `messageId` 契约改成 `machineString` → 129/256 位用例失败；
2. 用 `gapCase.id` 当追踪键 → 正向用例失败；
3. 不尊重 `ratesWithheld` → 未完成周报用例失败；
4. 用记忆总览补受限正文 → sentinel 泄漏用例失败。

**依据**：`prompt-prefix.md:74` 的 `[I-66]` 反向用例模式；`docs/incidents-and-gates.md:112` 的 I-73 门槛要求“清单生成出的每个引用都要过两个包的校验……去掉修复后 3 条失败”；ADR 0195:56-60 的测试清单。

### 4. 每个产生/修改的值，两端校验是否都能接受？

下表逐个列出“产生处（校验）”和“使用处（校验）”，并给出反例。核心原则来自 I-73：不要只看改动本身，要把产生出来的值真的喂给使用端。

| 值 | 产生处（校验） | 使用处（校验） | 两端核对 / 反例 |
|---|---|---|---|
| 新操作名 `decision.email.read` / `decision.email.snapshot` | `GATEWAY_V2_MESSAGE_TYPES` + schema（`contracts-v2.ts` 操作表） | `PRODUCTION_DECISION_TRACE_OPERATIONS`、`production-approval-gateway` 的 `installedOperations` 和 delegate、`production-http-composition` 的浏览器 `installedGatewayV2Operations`、前端 `includes(...)` 和 `queryMessage` | `check:operations` 只查后端/调用方/测试；必须另加测试断言安装列表和浏览器配置都含该操作。反例：契约加了、浏览器配置漏了，页面永远不显示。 |
| 入参 `messageId` | `proactive_processed_messages.message_id` / `muse_intake_items.gmail_message_id` / `muse_reference_entries.paired_message_id`，均为 1-256、`[A-Za-z0-9_-]`（迁移 0069:103；0079:4；sqlite-muse-intake-operations.ts:41） | 新查询 schema | **不能用 `machineString`**（1-128、首字符字母数字，`validation.ts:49-60`）。反例：129 位或 `_` 开头的合法邮件编号被拒。前端 `?message=` 也不能复用 `router.ts:27` 的 `MACHINE_VALUE`。 |
| 输出 `decisionId` | `proactive_processed_messages.decision_id` → `decision_ledger.id`（1-128） | `decision.chain.read` 的 `decisionId: machineString`（`contracts-v2.ts:989-992`）；`proactive.decision.rate` 也用它 | 用 trace 返回的 id 直接调用 chain；断言成功。反例：把 `gap_<hash>` 或 `mail-1` 当决策编号 → 查不到。 |
| `mail.outcome` | `proactive_processed_messages.outcome` CHECK 只能是 `act/know/check/ignore/skipped`（迁移 0069:106） | 页面的界面词和 `HIMAWARI_ATTENTION_OUTCOMES`（`calibration/index.ts:4-8`） | 枚举逐值测试；未知值不得被当成“提醒/不提醒”。`skipped` 不应进入对比。 |
| `mail.skipReason` | 同表 CHECK：`category/sensitive/own_mail` 或 null（迁移 0069:107） | 页面文案；`skipped` 时显示原因 | 反例：把 `skipped` 当 `ignore`，会把“没读”说成“判断不用管”。 |
| `mail.ruleIds` | `decision_ledger.inputs.floorHits[messageId]`（`proactive-mail-check-service.ts:810-811`；写入 `sqlite-proactive-operations.ts:665-675`） | 链的 `rules.items[].ruleId`（`production-decision-chain.ts:102-113`） | 断言每个 id 在链里存在或明确“未登记”。反例：`floorHits` 有、`ruleIds` 并集没有（旧记录），页面不能假装命中。 |
| `mail.memoryIds` | `decision_ledger.inputs.memoryByMail[messageId]`（`proactive-mail-check-service.ts:1111-1113`） | 链的 `memories.items[].memoryId`（`production-decision-chain.ts:127-133`） | 断言逐项在链里出现；超过 100 条时显示“被截断”。反例：页面标了“这封邮件用了这条记忆”，但链里因并集截断没有它。 |
| `muse.items[].kind/state` | `MUSE_INTAKE_KINDS` / `MUSE_INTAKE_STATES`（`muse-intake.ts:3-11`；写入校验 `sqlite-muse-intake-operations.ts:56-58`） | 页面文案；对比只对 `proactive` 的 `delivered/suppressed` 有意义 | 两种 kind 都测；`scheduled` 不能套用“提醒/没提醒”。 |
| `muse.items[].naturalKey` | 1-150（`sqlite-muse-intake-operations.ts:57`） | 只做展示/React key；**不要**喂给 `muse.item.rate` 的 `machineString`（最多 128） | 这是现有潜在不一致；本方案不把 naturalKey 当查询入参。反例：150 位自然键在评分时会过不了契约。 |
| `muse.reference.museReminded/timingOk/contentOk` | `muse_reference_entries`（`sqlite-muse-intake-operations.ts:497-511`；`decision-ledger.ts:163-175`） | 周报 `summarizeMuse`/`summarizeGap`（`calibration/index.ts:325-366,482-512`） | 页面的对比 bucket 必须与同一周报 bucket 一致；测试用同一夹具交叉断言。反例：页面把未评分 Muse 条目算进 bucket，周报没有。 |
| `comparison.state` | 新查询用 `HIMAWARI_ATTENTION_OUTCOMES` + 参考条目计算 | 页面文案；周报 bucket | `both/museOnly/himawariOnly/bothSilent/noHimawariRecord` 必须与 `summarizeMuse` 同名同义；缺一边时用 `unavailable/noHimawariRecord/museUnrated`，不能硬套。 |
| 周窗口/比例 `startDay/endDay/complete/ratesWithheld/minimumSamples` | `proactive.weekly.read`（`production-observation.ts:186-260`；`calibration/index.ts:233-257`） | 页面 | 页面不自己算；断言与同一周报字段一致。反例：邮件在观察期外却显示本周比例；未完成却显示 0%。 |
| 记忆正文/原话/取代文本/依据节点文本 | `decision.chain.read` 的 `visible` 规则（`production-decision-chain.ts:215-243`） | 页面 | 受限记忆只显示编号；不得从 `memory.overview.read` 补正文（`production-memory-control.ts:404-430` 会返回正文）。测试用 sentinel。 |
| 记忆来源 `threadId/messageId` | 记忆记录（`production-decision-chain.ts:231-238`） | `onOpenThread` 路由 | 真实浏览器测试点击；来源已删除时 `firstSourceDeleted=true`，不显示链接。 |
| 规则 `ruleId/origin/document/test` | `DECISION_RULE_CATALOG`（`proactive-rules.ts:44-58`；新增 `test`） | 链的 `rules.items`（`contracts-v2.ts:1022-1029`）和页面 | 未登记规则允许 null；新增 `test` 也允许 null。`check:rule-catalog` 断言每条有测试且与 `agent-rulebook-inventory.md` 一致。反例：catalog 有 id、链里被过滤掉；或 test 指向不存在的测试。 |
| `gapCase.id` | `gapCaseId(pairedMessageId)`（`production-gap-cases.ts:39-41`） | `proactive.gapcase.mark.caseId`（`contracts-v2.ts` command）和 `gap_case_marks`（`sqlite-decision-ledger-operations.ts:504-511`） | **不改公式**；导出要求快照里的 id 与标记行一致（`production-gap-export.ts:147`）。新页面不得把它当 `messageId`。反例：把 `gap_...` 传给新查询 → 查不到。 |
| `generatedAt` | clock | 页面显示 | 不进入模型请求、不写 ledger inputs；测试固定 clock 时确定。 |
| 新增 `messageId` 字段（gapCases/overview insights/Muse items） | 各写入表（1-256 Gmail 规则） | 前端“打开追踪”传参、新查询 schema | 用与持久层相同的 `[A-Za-z0-9_-]{1,256}`；不要用 `machineString`。反例：gapCases 的 `messageId` 是 256 位，前端用 `objectId` 深链接被 128 位截断。 |

**结论**：这个方案不新增表、不迁移，只新增一个只读解析查询；链和周报都复用现有实现。真正需要严加核对的是“邮件编号的 256 位/字符集”“`gapCase.id` 不是邮件编号”“受限记忆不能从别的查询补出来”“未完成的周报不能显示比例”这四个两端契约点；它们正好对应 I-73 的教训，应该做成独立的失败用例和门槛，而不是只在页面里小心处理。
