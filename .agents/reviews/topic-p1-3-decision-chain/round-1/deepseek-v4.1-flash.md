我先读取材料中点名的关键文件，弄清现状，再决定方案。
我已读完主要代码路径。现在查业界「决策可追溯 / 数据血缘」的一手做法。
# P1-3 方案：决策记录的完整来源链

> 说明：下面把「读代码/来源证实的」标为 **【已证实】**，「推测或需要验证」标为 **【推测/未核实】**。我没有修改任何文件，也没有运行除只读 git 以外的命令。

---

## 一、方案依赖的前提

| # | 前提 | 来源与原话 |
|---|---|---|
| P1 | Gmail 决策的 `inputs` 已经写入了本轮注入了哪些记忆、命中了哪些地板规则、每封邮件对应哪些记忆 | `packages/application/src/services/proactive-mail-check-service.ts:1294-1308`：`ruleIds: [...new Set(Object.values(input.floorHits).flat())].sort(), ... memoryIds: [...trace.memoryIds], usedMemoryIds: [...trace.usedMemoryIds], tentativeMemoryIds: [...trace.tentativeMemoryIds], memoryByMail: Object.fromEntries(trace.memoryByMail)`；`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:665-684` 把同一组字段写进 `decision_ledger.inputs` |
| P2 | 决策记录能按 id 读回 `inputs`、评价，但当前没有“按 id 读单条”的端口方法 | `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:130-201`：`owner_rating AS ownerRating, rated_at AS ratedAt ... inputs`；`packages/application/src/ports/decision-ledger.ts:199-250` 只有 `list`、`listReviewPool`，没有 `read` |
| P3 | 记忆概览已经带来源线程/消息、原话 `quote`、当前状态、被谁取代、是否推测 | `apps/agent-service/src/production-memory-control.ts:387-411`：`sourceThreadId, sourceMessageId, sourceRefs, ... supersededBy, validTo, tentative, ... history: nodes`；`packages/gateway-contracts/src/contracts-v2.ts:1024-1059` 对应快照字段 |
| P4 | 整理依据链已有读取能力，包含变更、账本 id、父记忆、重复/截断 | `packages/application/src/ports/memory-consolidation.ts:44-51`：`MemoryBasisChainNode { memoryId, change, ledgerId, basis, repeated, truncated }`；`apps/agent-service/src/production-memory-control.ts:278-320` 已有 `memory.basis.snapshot` 的组装 |
| P5 | 地板规则只有三条，出处在 ADR 0106 第 4 条；仓库没有统一规则登记册 | `packages/application/src/services/proactive-rules.ts:29-52`：`FLOOR_RULE_IDS = { importantSender: "floor_important_sender", publicDomain: "floor_public_domain", moneyWords: "floor_money_words" }`；`docs/adr/0106-proactive-loop-v1-gmail-read-only.md:45`：“发件人在 Andy 维护的‘重要发件人名单’里；发件域名是 `go.jp`、`lg.jp`、`ac.jp`、`ed.jp`；标题或摘要里有中日英三语的金钱词。” |
| P6 | 名称是“决策记录”，不是“决策账本”；三语界面 | `docs/glossary.md:37`：“决策记录是 Himawari 每次拿主意……留下的一行……旧叫法 `决策账本` `决策日志` `Decision log`” |
| P7 | 发给模型的内容只追加，每轮变化的值只在最后一条消息 | `.claude/rules/prompt-prefix.md:28`：“每轮都会变的内容只放在最后一条用户消息里”；`:34`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。” |
| P8 | 抽屉复用记忆页样式；不得新增堆内部运行信息的通用面板 | `apps/control-center/src/components/memory-page.tsx:440-453`：`memory-drawer-backdrop`、`memory-drawer`、`role="dialog"`；`.agents/instructions/web-design-baselines.md:9`：“不得新增堆积内部运行信息（模型、token、步骤、审批、内部记录）的通用面板或页面。” |
| P9 | 新网关操作必须同时登记契约类型、schema map、服务端派发和浏览器 installed ops | `packages/gateway-contracts/src/contracts-v2.ts:21-...`、`:2351-2394`；`apps/agent-service/src/production-approval-gateway.ts:103-119`、`:248-260`；`apps/agent-service/src/production-http-composition.ts:661-671` |
| P10 | 不需要新迁移即可读：`inputs` 是 JSON，依据表已存在，决策 id 是主键 | `packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:2` `id TEXT PRIMARY KEY`；`:21` `inputs TEXT NOT NULL CHECK (json_valid(inputs) ...)`；`0084_memory_consolidation_basis.sql:1-7` |
| P11 | 业界做法：数据血缘用 Job/Run/Dataset + 输入输出 + 可扩展 facet；AI 追踪界面用 span 树和每段输入输出；provenance 只说明来源，不等于可信 | [OpenLineage Object Model](https://openlineage.io/docs/spec/object-model/)：“OpenLineage cares how Datasets come into being... its object model contains both Jobs and Datasets.”；[OpenLineage Facets](https://openlineage.io/docs/spec/facets/)：“job: What kind of activity ran / run: How it ran / inputs: What was used during its run / outputs: What was the outcome of the run”；[OTel GenAI spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)：“GenAI spans represent logical operations as observed by the caller... Retrievals... `gen_ai.operation.name` SHOULD be `retrieval`”；[W3C PROV-O](https://www.w3.org/TR/prov-o/)：“Activities... use and generate a variety of Entities... one can construct provenance chains”；[MLflow Trace UI](https://mlflow.org/docs/latest/genai/tracing/observe-with-traces/ui/)：“The detailed trace view contains... The span tree that represents the execution flow... Input and output of each span”；[Microsoft Content Provenance](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/content-safety/provenance-disclosure)：“Provenance doesn't determine trustworthiness... doesn't prove authorship” |

---

## 二、方案本身

### 2.1 总体判断

**【已证实】** 这条链需要的原始数据都已经在库里：`decision_ledger.inputs`（本轮注入/命中）、`decision_ledger_payloads`（模型输入输出，本方案不展示）、`memory_records` + `memory_history`（记忆当前内容与历史原话）、`memory_consolidation_changes` + `memory_consolidation_change_basis`（整理依据）、`decision_ledger.owner_rating`（Andy 的评价）。缺的不是数据，而是三样东西：

1. 一个按 `decisionId` 读单条决策记录的端口方法；
2. 一个只读的“决策 → 规则 → 记忆 → 依据 → 评价”组装器；
3. 一张统一的规则登记表和一份写入约定。

所以我建议：**新增一个只读网关查询 `decision.record.read`，服务端一次组装完整链，控制中心只负责渲染；不新增迁移、不新增模型调用、不改任何提示词。**

### 2.2 数据从哪读

新增 `apps/agent-service/src/production-decision-trace.ts`，构造在 `production-http-composition.ts`，只读依赖：

| 链上的块 | 数据源 | 说明 |
|---|---|---|
| 决策本身 | `DecisionLedgerPort.read({ ownerId, agentId, decisionId })`（新增） | 按主键读，天然带 owner/agent 过滤；返回 `inputs`、`verdict`、`counts`、`ownerRating`、`ratedAt` 等 |
| 命中的规则 | `inputs.ruleIds`、`inputs.floorHits` | 只对 `kind = "proactive"` 解释；`floorHits` 是邮件 id → 规则 id 列表 |
| 规则出处 | 新静态表 `packages/application/src/services/decision-rules.ts` | 不读数据库；三条地板规则各一条，带 `sourceRef`、`codeRef`、是否可配置 |
| 注入的记忆 | `inputs.memoryIds`、`memoryByMail`、`usedMemoryIds`、`tentativeMemoryIds` | 取并集去重，避免某个字段漏写导致记忆丢失 |
| 记忆当前内容/状态 | `ProductMemoryStatePort.readMany` / `listHistory`（分批） | 复用 `production-memory-control.ts:338-411` 的读法；**不要调用 `query()`，因为它会 `#purgeExpiredTrash()`（`production-memory-control.ts:327`），不是纯读** |
| 记忆原话 | `MemoryBookStorePort.findOwnerMessages` + `payloads.get` + `protector.unprotect` | 与记忆页 `memorySourceState` 的判定一致；找不到就是“原话已不可查” |
| 整理依据 | `MemoryConsolidationStorePort.readBasisChain` | 复用 P1-2 的接口；每个注入记忆单独一棵小树 |
| 评价 | 决策行 `owner_rating` / `rated_at` | 与 `proactive.decision.rate` 写的是同一列（`sqlite-proactive-operations.ts:1040`） |

**明确不读的东西：**

- 不读 `decision_ledger_payloads` 里的模型输入/输出。目标链不包含它；把它塞进抽屉会变成“堆内部运行信息”的通用面板，违反 P8。将来若 Andy 要审计模型输入输出，再开独立入口，复用已有的 `readDecisionModelIo`（`production-proactive.ts:218-229`）。
- 不按 `decision_id` 扫 `proactive_processed_messages` 取邮件头。该表没有 `decision_id` 索引，扫全表可能慢；为一个抽屉加迁移不值得。v1 的规则区块只显示规则名和邮件 id，不显示邮件标题/发件人。若一定要显示，再加索引迁移并单独决定。

**“不重算”的落实：**

- 不重新跑检索、不重新判断规则、不调用模型；
- 注入记忆只认 `inputs`，不根据当前设置重新算；
- 规则命中只认 `floorHits`，不拿当前“重要发件人”名单重算；
- 读取失败一律降级成显式状态，不静默补算。

### 2.3 网关接口

新增两个操作：

```text
decision.record.read      (query)
decision.record.snapshot  (snapshot)
```

查询载荷：

```ts
{ decisionId: machineString }   // 1-128，现有决策 id 均满足
```

快照载荷建议如下（字段都按现有 validator 选型）：

```ts
{
  decision: {
    id: machineString,
    kind: enumeration(DECISION_KINDS),
    decidedAt: timestamp,
    outcome: boundedString(64),
    verdict: nullable(boundedString(32)),      // proactive 的 7 个值
    reasonCode: boundedString(64),
    subjectRef: nullable(boundedString(256)),
    counts: nullable(object({                   // 只有 proactive 有
      fetched, skipped, judged, act, know, check, ignore, floorRaised, pushed: integer(0)
    })),
    costMicros: integer(0),
    durationMs: integer(0, 86_400_000),
    category: nullable(enumeration(DECISION_CATEGORIES)),
    confidencePermille: nullable(integer(0, 1000)),
    inferred: nullable(booleanValue),
    rating: nullable(object({
      value: enumeration(["useful", "unneeded", "missed"]),
      ratedAt: timestamp
    }))
  },
  rules: {
    state: enumeration(["recorded", "not_recorded", "not_applicable"]),
    items: array(object({
      ruleId: machineString,
      sourceRef: boundedString(256),    // 含 / 和 #，不能用 machineString
      codeRef: boundedString(256),
      configRef: nullable(boundedString(128)),
      mailIds: array(machineString)
    })),
    unknownRuleIds: array(boundedString(64))
  },
  memory: {
    state: enumeration(["recorded", "not_recorded", "not_applicable"]),
    recall: enumeration(["off", "ok", "partial", "failed", "not_recorded"]),
    items: array(object({
      memoryId: machineString,
      text: nullable(boundedString(2000)),
      textHidden: booleanValue,
      revision: nullable(integer(1)),
      status: nullable(enumeration(["active", "archived", "trashed", "missing"])),
      dataClassification: enumeration(...),
      topic: nullable(...),
      inference: booleanValue,
      tentative: booleanValue,
      usedByModel: booleanValue,
      mailIds: array(machineString),
      supersededBy: nullable(machineString),
      supersededByText: nullable(boundedString(2000)),
      changedSinceDecision: booleanValue,
      source: {
        state: enumeration(["jump", "reminder", "import", "owner", "tidy", "deleted", "unavailable"]),
        threadId: nullable(machineString),
        messageId: nullable(machineString),
        quote: nullable(boundedString(2000))
      },
      basis: {
        state: enumeration(["present", "none", "unavailable"]),
        complete: booleanValue,
        nodes: array(object({
          memoryId: machineString,
          text: nullable(boundedString(500)),
          action: nullable(enumeration(["merge", "supersede", "archive", "reflect"])),
          changedAt: nullable(timestamp),
          decisionRecordId: nullable(machineString),
          basisMemoryIds: array(machineString),
          repeated: booleanValue,
          truncated: booleanValue
        }))
      }
    }))
  }
}
```

**登记位置（P9，逐个使用处）：**

1. `GATEWAY_V2_MESSAGE_TYPES` 加两个类型（`contracts-v2.ts:21`）。
2. 定义 `decisionRecordReadQuerySchema` / `decisionRecordSnapshotSchema`，并加入 `schemasByType`（`contracts-v2.ts:2351`）。
3. 新增 `PRODUCTION_DECISION_OPERATIONS`，加入服务端 `installedOperations`（`production-approval-gateway.ts:248-260`）。
4. 在 `production-approval-gateway.ts:103-119` 的 query 派发里加显式分支；不要靠 `startsWith("memory.")` 之类的猜测，避免命名歧义。
5. 加入浏览器配置的 `installedGatewayV2Operations`（`production-http-composition.ts:661-671`）。
6. 控制中心在 `installedGatewayV2Operations.includes("decision.record.read")` 为真时才显示“详情”按钮；否则保持只读行，兼容滚动发布。
7. 在 `packages/gateway-contracts/test/gateway-v2.fixture.ts` 加 query/snapshot fixture；如果仓库有“每种消息类型都要有 fixture”的检查，这一步会强制被发现。

**错误语义：**

- 决策不存在、或不属于当前 owner/agent：返回 `PORT_NOT_FOUND`，错误码用 `DECISION_RECORD_NOT_FOUND`。不要返回空快照，否则 UI 会误以为“有记录但全空”。
- 记忆、原话、依据读不到：不报错，返回对应的 `missing` / `unavailable` 状态。这样一条坏记忆不会让整条链打不开。

### 2.4 规则出处怎么表示

新增静态登记表 `packages/application/src/services/decision-rules.ts`：

```ts
export interface DecisionRuleDefinition {
  readonly id: string;
  readonly sourceRef: string;   // "docs/adr/0106-proactive-loop-v1-gmail-read-only.md#decision 第 4 条"
  readonly codeRef: string;     // "packages/application/src/services/proactive-rules.ts#FLOOR_RULE_IDS"
  readonly configRef: string | null; // "proactive.settings.importantSenders" 或 null
}

export const DECISION_RULES = Object.freeze([
  { id: FLOOR_RULE_IDS.importantSender, sourceRef: "...0106...#decision", codeRef: ".../proactive-rules.ts#FLOOR_RULE_IDS.importantSender", configRef: "proactive.settings.importantSenders" },
  { id: FLOOR_RULE_IDS.publicDomain, sourceRef: "...0106...#decision", codeRef: ".../proactive-rules.ts#FLOOR_RULE_IDS.publicDomain", configRef: null },
  { id: FLOOR_RULE_IDS.moneyWords, sourceRef: "...0106...#decision", codeRef: ".../proactive-rules.ts#FLOOR_RULE_IDS.moneyWords", configRef: null },
]);
```

规则 id 与出处的关系：

- **规则 id 是机器标识**，用 `machineString`；三条规则的值来自 `FLOOR_RULE_IDS`，不要在 UI 里另写一套。
- **出处是文档路径 + 代码符号**，用 `boundedString`，因为路径含 `/`、锚点含 `#`。不要把出处做成外链 URL；控制中心没有文档查看器，编一个 GitHub URL 反而会猜错。UI 显示成可读文本：`ADR 0106 第 4 条 · proactive-rules.ts#FLOOR_RULE_IDS`。
- **动态配置只给引用，不给历史值**。`floor_important_sender` 依赖 Andy 维护的“重要发件人”名单；决策记录里只存了规则 id，没有存当时命中的发件人/域名。因此 v1 只能说“命中了这条规则”，不能说“当时命中 `@example.com`”。当前设置是“现在”的设置，不能当成决策时的快照展示。这一点必须在文档和 UI 里写明。
- **未知规则 id 不隐藏**。如果 `floorHits` 里出现登记表没有的 id（包括历史 `memory_candidate` 把 `reasonCode` 写进 `ruleIds` 的旧行），放入 `unknownRuleIds`，UI 显示“规则出处未登记（id）”。对非 `proactive` 类型，规则区块直接 `not_applicable`，不展示 `ruleIds`，避免把丢弃原因当规则。

### 2.5 “无记录”怎么定义

“无记录”不是空白，也不是同一种灰字。建议固定成下面这组状态，写进写入约定文档，UI 每个区块都按状态渲染：

| 位置 | 状态 | 含义 | 中文文案示例 |
|---|---|---|---|
| 决策本身 | `not_found` | 行不存在或不属于当前 owner/agent | 这条决策记录已不存在（可能已随 Gmail 记录清除） |
| 规则 | `not_applicable` | 该 kind 不使用规则 | 这类决策不使用地板规则 |
| 规则 | `not_recorded` | `proactive` 但 `floorHits` 缺失/为空 | 这一轮没有命中地板规则 |
| 规则 | `unknown` | ruleId 不在登记表 | 规则出处未登记（id） |
| 记忆 | `not_applicable` | 该 kind 不涉及记忆 | 这类决策不涉及记忆 |
| 记忆 | `not_recorded` | 应有记录但 `inputs` 里没有 | 这一轮没有记录注入的记忆 |
| 记忆 | `missing` | id 查不到或已删除 | 记忆已删除或查不到（id） |
| 来源 | `unavailable` | 有线程但原话找不到 | 原话已不可查 |
| 来源 | `not_applicable` | 导入/手动/整理产生 | 这条记忆不是你直接说的（来源：导入/手动/整理） |
| 依据 | `none` | 没有整理变更 | 这条记忆不是整理推出来的 |
| 依据 | `unavailable` | 依据读取失败 | 整理依据暂时读不到 |
| 依据 | `truncated` | 节点/深度超限 | 依据链太长，只显示前 N 条 |
| 评价 | `unrated` | `owner_rating` 为空 | 你还没有评价这条记录 |
| 模型输入/输出 | `not_shown` | 本抽屉不展示 | （不显示；需要时另开审计入口） |

关键是要区分 **“从来没有记录”** 和 **“记录过但被删了/读不到”**。这需要读单条决策时保留 `inputs` 的**字段存在性**：现有 `entryFromRow` 会把缺失字段补成 `off` / `false` / `0`（`sqlite-decision-ledger-operations.ts:157-201`），这会抹掉“缺失”和“显式为 off”的区别。建议新增的 `read` 返回 `inputFields: readonly string[]`（或 `presence`），由服务端根据 `Object.keys(JSON.parse(inputs))` 得出，再决定 `not_recorded` 还是 `off`/`false`。**不需要迁移**。

记忆“当前状态”的定义：

- `active` / `archived` / `trashed`：直接来自 `memory_records.status`；
- `missing`：记录查不到，或状态为 `deletion_pending` / `deleted_verified`；
- `supersededBy`：只表示“被哪条记忆取代”，UI 文案用“已被记忆 X 取代”，不要说“被谁取代”；
- `changedSinceDecision = memory.updatedAt > decision.decidedAt`：这是启发式，只能说明“决策后改过”，不能还原“决策时是什么”。UI 必须写“上面是当前内容，决策后改过”。

### 2.6 抽屉怎么展示

在 `apps/control-center/src/components/proactive-reminders.tsx` 的 `ProactiveDecisionLog` 行里加一个“详情”按钮（不要整行包 button，行里已有评价按钮）。新组件建议叫 `DecisionTraceDrawer`，放在同目录或 `components/decision-trace.tsx`，复用记忆页抽屉的类名和键盘行为：

- `memory-drawer-backdrop` + `memory-drawer`，`role="dialog"`，`aria-label`；
- 打开时 focus 到抽屉，Escape 关闭，backdrop 关闭；关闭后焦点回到“详情”按钮；
- 桌面右侧抽屉，手机底部弹出（复用现有 `.memory-drawer` 的响应式样式，若没有则按 v12 基线补）。

内容只放五段，顺序就是链的顺序：

1. **决策**
   - 时间、`kind` 的中文名、判断结果（直接复用现有 `decisionLine` 的文案，避免两套说法）。
   - `reasonCode` 的说明；数字（检查/判断/提醒/地板抬升等）用 `title` 或可展开的“这些数字是什么”解释定义。
   - 记忆检索/相关邮件的读取状态：`memoryRecall`、`relatedRead`。如果 `failed`，显示“本轮记忆检索失败”，这比“没有注入记忆”更准确。
   - 不显示 token、成本、模型名、步骤，避免变成通用运行面板。

2. **地板规则**
   - 仅 `proactive` 显示。每条规则：本地化名称 + 出处文本（ADR 0106 第 4 条 + 代码符号）+ 命中的邮件 id。
   - 没有命中：明确“这一轮没有命中地板规则”。
   - 未知规则 id：明确“规则出处未登记（id）”。
   - 非 `proactive`：明确“这类决策不使用地板规则”。
   - 副标题写清楚：“这是模型判断之后、推送之前的确定性规则；模型的理由不在这里。”

3. **记忆**
   - 标题按 kind 变化：Gmail 是“注入了哪些记忆”；`memory_candidate` 是“涉及的记忆”；`consolidation` 是“整理依据 / 整理结果”；`context_truncation` 是“被截掉的记忆”；`retrieval_degrade` 是“不涉及记忆”；`external_read` 是“被读取的记忆”。
   - 每张卡片：
     - 当前文本（敏感记忆按下面的取舍处理）+ 分类/敏感/推测/待确认标签；
     - “模型在判断里引用”徽标（`usedMemoryIds`），“只注入、未引用”也要能看出来；
     - 当前状态（active/archived/trashed）、被哪条记忆取代（含替代记忆文本）；
     - 来源：原话 `quote` + 线程/消息跳转；没有原话时显示 `source.state` 对应文案；
     - `changedSinceDecision` 时显示“决策后改过，以上为当前内容”；
     - 依据链：小树/缩进列表，显示动作、时间、父记忆文本；`none`/`unavailable`/`truncated` 用明确文案。
   - 没有记忆：按 `not_applicable` / `not_recorded` 显示对应句子，不渲染空卡片。

4. **评价**
   - 已评价：显示 `useful`/`unneeded`/`missed` 对应的三语文案和评价时间；
   - 未评价：显示“你还没有评价这条记录”，并提供与行内相同的评价按钮（复用 `proactive.decision.rate`，不要再写一套写入逻辑）。

5. **可选：本轮模型输入/输出**
   - **v1 不显示**。原因见 P8 和 2.2。若 Andy 明确要求，再作为独立折叠块，复用 `readDecisionModelIo`，并明确“已遮盖、只读、不重算”。

### 2.7 写入约定文档

新增 `docs/decision-record-write-conventions.md`（并在新 ADR 里链接它；下一号是 ADR 0192）。内容建议：

1. **适用范围**：`decision_ledger` 一行就是“一次由模型做的门槛决策”；本文件是后续所有写入点的唯一依据。
2. **一行有哪些列**：`id/owner_id/agent_id/kind/checked_at/verdict/outcome/reason_code/subject_ref/inputs/reason_ref/content_ref/cost_micros/duration_ms/owner_rating/rated_at/category/confidence_permille/inferred`，以及哪些列只属于哪个 kind。
3. **`kind` 与必填/禁止矩阵**：
   - `proactive`：必写 `verdict`、`counts`、`inputs.floorHits/memoryIds/memoryInjected/usedMemoryIds/tentativeMemoryIds/memoryByMail/memoryRecall/relatedByMail/relatedRead/relatedStats/relatedFailedSteps`；不写 `outcome`、候选三列。
   - `memory_candidate`：`outcome` 三值；`memoryIds` = 被决策的已有记忆；`ruleIds` **不再写丢弃原因**（原因在 `reason_code`）；候选三列仅此类型。
   - `consolidation`：`outcome` 四值；`memoryIds` = 动作前的依据；`resultMemoryIds` = 动作后的结果；`batchId` = 整理批次；`ruleIds` 空。
   - `context_truncation`：`memoryIds` = 被截掉的记忆；`ruleIds` 空。
   - `retrieval_degrade`：`memoryIds`/`ruleIds` 空；原因写 `reason_code`。
   - `external_read`：有被读取记忆就写 `memoryIds`；`ruleIds` 空。
4. **`inputs` 字段表**：逐字段写类型、长度、是否去重、谁写入、什么含义、缺失时读取端怎么解释。重点写清：
   - `memoryIds` 是“本轮实际放进提示词的记忆”（ADR 0143 第 3 条原话）；
   - `ruleIds` 只放真实规则标识，不是原因码；
   - `floorHits` 的 key 是邮件 id，value 是规则 id；
   - `memoryByMail` 是每封邮件对应的注入记忆；
   - `usedMemoryIds` 是模型在判断里明确用到的子集；
   - `tentativeMemoryIds` 是待确认子集；
   - `memoryRecall` / `relatedRead` 的四个状态；
   - `relatedStats` 的非负整数定义。
5. **不变量**：
   - owner/agent 必须与决策对象一致；
   - 时间用 ISO 8601 UTC；
   - 数组去重；写入端不依赖对象遍历顺序，读取端排序；
   - 正文、邮件地址、标题、摘要、设置值不得写进 `inputs`；正文只进加密 `content_ref`/`reason_ref`；
   - 写入与记忆变更同事务（ADR 0143 第 5 条、ADR 0191）；
   - 清除 Gmail 记录只删 `kind='proactive'`。
6. **读取端解释**：`recorded/not_recorded/not_applicable/missing/unavailable/truncated` 的定义，未知 ruleId 的处理，当前记忆状态与决策时状态的区别。
7. **版本与变更流程**：新增 kind/字段/outcome 时，先改本文件，再改 gateway schema、服务端组装、UI、测试；新字段必须可选、有默认值、读取端能处理缺失；不得复用旧字段表达新含义。

### 2.8 测试怎么设计

**接口/契约层（`packages/gateway-contracts`）**

- 新增 query/snapshot fixture；如果仓库有“每种消息类型都要有 schema 和 fixture”的检查，这会自动覆盖。
- 正向：真实 `decisionId`、`sourceRef` 带 `/` 和 `#`、`titleKey` 带点、`timestamp`、`nullable` 字段都能过。
- 反向：`decisionId` 含 `/` 或超过 128 字符必须被拒；`sourceRef` 超过 256 必须被拒；`counts` 出现负数必须被拒。

**端口/持久化层（真实 SQLite）**

新增 `test/integration/decision-trace.test.ts`：

- 正向：造一条 Gmail 决策，2 封邮件，`floorHits` 命中 2 条规则，注入 3 条记忆（1 条 `used`、1 条 `tentative`、1 条被取代），其中 1 条有整理依据链，Andy 已评价。调用新增 `read` + trace 组装，断言：
  - 决策摘要、规则名/出处、每封邮件的规则 id；
  - 每条记忆的文本、原话、来源线程/消息、当前状态、`supersededBy`；
  - `usedByModel` 与 `tentative` 标记；
  - 依据链的父子关系、`complete=true`；
  - 评价值和评价时间。
- 反向（每条都必须真的失败，不能只写正向）：
  1. 删除决策行 → `read` 返回 `undefined`，网关错误码 `DECISION_RECORD_NOT_FOUND`。
  2. 删除某条记忆记录 → 该条 `status="missing"`，UI 文案不是空白。
  3. 让原话 payload 不存在 → `source.state="unavailable"`。
  4. 在 `floorHits` 放一个登记表没有的 ruleId → `unknownRuleIds` 包含它。
  5. 清空 `owner_rating` → 评价状态 `unrated`。
  6. 用另一个 owner/agent 查同一个 id → `NOT_FOUND`（作用域隔离）。
  7. 只在 `memoryByMail` 出现、不在 `memoryIds` 的记忆 → 仍被并集解析出来。
  8. 造超过节点上限的依据链 → `complete=false`，节点数被截断。
  9. 决策后修改记忆 `updatedAt` → `changedSinceDecision=true`。
  10. `inputs='{}'` 的旧行 → 各区块 `not_recorded`，而不是 `off`/`false`。
  11. 非 `proactive` 的 `memory_candidate` 行把原因码放在 `ruleIds` → 规则区块 `not_applicable`，不显示成规则。
  12. 注入一个会抛错的模型端口 → trace 仍成功，证明没有调用模型。
  13. 用只读连接/写操作 spy → trace 没有写库。
  14. 连续调用两次 → 深度相等，证明顺序确定。

**规则登记表单测**

- 遍历 `Object.values(FLOOR_RULE_IDS)`，断言每条都在 `DECISION_RULES` 里。
- 反过来，遍历 `DECISION_RULES`，断言 id 都在 `FLOOR_RULE_IDS` 里，且 `sourceRef`/`codeRef` 非空。
- 未知 id 返回 `undefined`，由组装器转成 `unknownRuleIds`。
- 反向：删掉登记表一条规则，测试必须失败。

**UI 单测/浏览器测试**

- `apps/control-center/test/decision-trace.unit.test.ts`（jsdom/Testing Library）：
  - 每个区块的 `recorded/not_recorded/not_applicable/missing/unavailable/truncated/unrated` 都渲染出对应句子；
  - 不渲染模型输入/输出、token、模型名；
  - 点击“详情”打开抽屉，Escape/backdrop 关闭，焦点返回；
  - 评价按钮调用现有 `rateDecision`，不新增 command。
- `test/integration/decision-trace-browser.test.ts`（真实 Chromium，复用 `memory-source-browser.test.ts` 的构建/启动方式）：
  - 正向：用 fixture 的 Gmail 决策打开抽屉，断言规则名 + ADR 出处文本、记忆原话、当前状态、依据链、评价；
  - 反向：fixture 去掉某条记忆，断言“记忆已删除或查不到”；去掉评价，断言“你还没有评价”；去掉原话，断言“原话已不可查”；每个区块都不是空白。
  - fixture 必须更新：`test/e2e/fixtures/control-center-browser-server.mjs` 的 `proactive.overview` 现在 `decisions: []`（`:1258`），需要加一条 Gmail 决策；`installedGatewayV2Operations`（`:1920-1968`）加 `decision.record.read`；`handleOperationsQuery` 加 `decision.record.read` 分支；`memoryOverview()`（`:840`）给注入记忆补 `history[].quote`。
- `npm run check:locale`：三语 key 必须齐全。
- `npm run check:glossary`：界面文案不得出现“决策账本”“决策日志”“Decision log”。
- `npm run check:layout`：给抽屉加桌面/手机场景；`check:phone-layout` 如涉及手机宽度也补。
- `npm run check:prompt-prefix`：本改动不应影响，作为回归门槛继续跑。

**端到端验收对应目标 4**

选一条 Gmail 记录，从提醒页点“详情”，抽屉中依次看到：决策摘要 → 地板规则及 ADR 0106 出处 → 注入记忆（原话、来源、状态、被取代） → 整理依据链 → Andy 的评价。任一块缺失时显示上表对应的“无记录”句子，而不是空白。

---

## 三、考虑过但不选的做法及原因

| 做法 | 为什么不选 |
|---|---|
| **只做 `proactive.decision.trace.read`，只覆盖 Gmail** | 最小改动，但目标写的是“给一条决策记录”，`memory_candidate`/`consolidation` 等也需要同一条链；先做专用接口，后面还要再开一套命名和派发。除非 Andy 要求极致最小改动，否则不选。 |
| **客户端用现有 `proactive.overview` + `memory.overview` + `memory.basis.read` 拼** | 省服务端工作，但有多项问题：`memory.overview` 很大且可能过期；每条记忆一次 `memory.basis.read` 是 N+1；规则登记表仍要另一处；跨 owner 校验和“无记录”语义会散在 UI；E2E 不稳定。 |
| **把 `inputs` 直接塞进 `proactive.overview.decisions`** | 每次刷新提醒页都要带最多 30 条决策的全部记忆 id/映射，浪费且把列表和详情耦合；只覆盖 proactive，其他 kind 仍没有。 |
| **新建一张“决策链快照”表，在决策时物化整条链** | 保真度最高（能保存决策时的记忆文本/版本），但要新迁移、新写入路径、新事务，且当前目标只要求“复用已有记录，不重算”。先用现有数据 + “决策后改过”标记；确需精确快照时再单独立项。 |
| **把模型输入/输出直接展示在抽屉里** | 数据已有（`decision_ledger_payloads`），但目标链不包含它；展示全文会变成“堆内部运行信息”的通用面板，违反 P8，也扩大敏感内容暴露面。将来另开审计入口。 |
| **接 OpenTelemetry/MLflow 式 span 树，把整轮执行过程都画出来** | 业界成熟，但那是“执行追踪”，不是“决策来源链”。本需求要的是领域语义：规则、记忆、整理依据、评价。用 OTel 会引入大量无关 span，且要改运行时埋点。只借它的“树 + 每节点输入输出 + 评价”呈现方式，不接整套系统。 |
| **按 `decision_id` 反查 `proactive_processed_messages` 显示邮件标题/发件人** | 能让人更容易看懂“哪封邮件”，但该表没有 `decision_id` 索引，按决策查询会扫表；为此加迁移不值得。v1 只显示邮件 id，后续若 Andy 认为必须，再加索引并单独评审。 |
| **把当前“重要发件人”名单当成决策时命中值展示** | 会撒谎：名单会变，决策记录没存当时的名单。只能显示规则定义和出处，不能显示当前设置作为历史事实。 |

---

## 四、风险和反例

1. **当前记忆文本 ≠ 决策时模型看到的文本（最大风险）。**
   - 决策记录只存 `memoryIds`，没存当时的 revision/文本快照。
   - 缓解：UI 明确写“当前内容”；`changedSinceDecision` 用 `updatedAt > decidedAt` 标记“决策后改过”；文档写明这是限制。
   - 反例：Andy 在决策后编辑了记忆，抽屉显示新文本，容易被误读成“模型当时看到的就是这句”。这是推测/解释风险，不是数据错误。

2. **规则命中值不可还原。**
   - `floorHits` 只有规则 id，没有“命中了哪个重要发件人/哪个金钱词”。
   - 缓解：只展示规则定义和出处，不展示当前配置作为历史值；文档写明缺口。
   - 反例：Andy 问“当时是因为哪个发件人被抬升的？”抽屉答不出来。若要答，需要在写入时新增 `ruleMatches`（不能放正文，需脱敏/哈希或只存配置项引用），这是写入约定变更，需拍板。

3. **敏感记忆在提醒页被新暴露。**
   - 记忆页本来就显示敏感记忆，但每天打分有意隐藏敏感记忆原文（`daily-review.ts:135-137` 的 `reviewMemoryVisible` 只允许 public/private）。
   - 若 trace 直接返回 `sensitive` 记忆文本，等于在提醒页新增了一个以前没有的敏感文本展示面。
   - 缓解方案 A（推荐）：trace 沿用 `reviewMemoryVisible`，敏感记忆返回 `textHidden=true`，显示“这条记忆含敏感信息，原文请到记忆页查看”+ 跳转记忆页。方案 B：像记忆页一样显示并打敏感标签。**需要 Andy 拍板。**

4. **Gmail 记录被清除后，抽屉打不开。**
   - `proactive.source.manage` 的 `clear_records` 会删 `kind='proactive'` 的决策行（`sqlite-proactive-operations.ts:497`），`decision_ledger_payloads` 级联删除。
   - 缓解：`read` 返回 `NOT_FOUND`，抽屉显示“已不存在（可能已随 Gmail 记录清除）”，不崩、不空白。反例：从旧的列表快照点进来时正好被清除。

5. **旧行缺少字段，被误读成显式值。**
   - `entryFromRow` 会给缺失字段补 `off/false/0`。如果不保留字段存在性，`inputs='{}'` 会显示“记忆检索关闭、没有注入记忆”，而实际是“没有记录”。
   - 缓解：新增 `read` 返回 `inputFields`；测试覆盖 `inputs='{}'`。

6. **新操作未上线时的兼容性。**
   - 新控制中心 + 旧 agent-service：`installedGatewayV2Operations` 没有 `decision.record.read`。
   - 缓解：UI 先检查该操作是否存在；不存在就不显示“详情”按钮，或显示“当前服务不支持详情”。反向测试要断言不会发请求。

7. **性能与无界数据。**
   - 一条 Gmail 决策最多 200 个记忆 id、每个记忆有历史与依据链；如果全量展开，响应可能很大。
   - 缓解：记忆上限（如 100 条）、每条历史原话只取最早一条、依据链节点上限（如 200）、每个节点文本上限 500、`complete/truncated` 标记；分批 `listHistory`。反例：极端行会截断，UI 必须显示“链太长，只显示前 N 条”。

8. **确定性/顺序。**
   - `inputs.memoryByMail`、`floorHits` 是对象，遍历顺序不稳定。
   - 缓解：服务端按 messageId/ memoryId 排序；依据链按 `createdAt, id` 排序；同一请求重复调用结果相同；不用 `generatedAt`/`Date.now()`。反例：UI 列表每次刷新顺序不同、快照测试抖动。

9. **跨 owner 泄露。**
   - 新增 `read` 必须 `WHERE owner_id=? AND agent_id=? AND id=?`；不能只按 id。
   - 反例：另一个 owner 的 id 被猜到。测试必须覆盖。

10. **把“记录”当“证明”。**
    - 抽屉展示的是 Himawari 当时写下的记录，不是对因果的重新验证。Microsoft 的 provenance 文档也明确“provenance doesn't determine trustworthiness / doesn't prove authorship”。
    - 文案建议用“记录显示”，不要用“因此一定”。

---

## 五、需要人拍板的取舍

1. **决策时记忆文本的精确性**：接受“当前文本 + 决策后改过标记”（我推荐，零迁移），还是在写入时新增 `memorySnapshot`（revision + 加密引用/短文本），从下一个版本开始保存决策时快照？后者更准确，但要改所有写入点和写入约定。
2. **敏感记忆在抽屉里的显示**：沿用每天打分的规则隐藏原文、只给记忆页跳转（我推荐，避免新增暴露面），还是像记忆页一样显示并打敏感标签？
3. **规则命中值**：接受“只到规则 id + 出处”（我推荐，零迁移），还是新增 `ruleMatches` 记录命中的发件人/域名/金钱词（不能存正文，需要脱敏或只存配置项引用）？
4. **是否修 `memory_candidate` 把 `reasonCode` 写进 `ruleIds`**：我建议从现在起改为 `ruleIds: []`、原因只写 `reason_code`，旧行读取时按未知规则/不适用处理。这是行为变更，需要 Andy 同意；不加迁移。
5. **操作命名**：用新的 `decision.record.read`（覆盖所有 kind，需要在派发里加显式分支），还是先用 `proactive.decision.trace.read`（改动更小，但以后还要再开一套）？我推荐前者。
6. **评价是否可在抽屉里改**：只展示（最小），还是复用行内的评价按钮（我推荐，目标说“Andy 的评价”，抽屉里能改更顺手）？两种都复用现有 command，不新增写入路径。

---

## 六、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。**

- 本方案只新增：一个只读网关查询、一个服务端组装器、一个抽屉组件、一个规则登记表、测试和文档。没有任何文件属于提示词组装、工具定义、历史消息或遮盖逻辑。
- 发给模型的内容仍然只在末尾追加；每轮会变的值仍然只在最后一条消息里。依据：`.claude/rules/prompt-prefix.md:28`“每轮都会变的内容只放在最后一条用户消息里”；`:34`“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”
- 本方案不新增模型请求；抽屉读取的是库里已经保存的决策、记忆和历史，不调用模型。因此也不涉及“新发给模型的请求必须走统一出口”的改动。
- 唯一需要守住的是：trace 组装器必须是纯读，不能调用会 `#purgeExpiredTrash()` 的 `ProductionMemoryControl.query()`（`production-memory-control.ts:327`），也不能写审计事件或改记忆；否则会间接改变后续请求或数据。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会影响发给模型的内容。** 具体到本方案：

- 不重新遮盖、不重新序列化模型请求；只读已保存的、已遮盖的 header/记忆文本。
- 快照里不用 `generatedAt`、`Date.now()`，不用“当前时间”参与任何字段；所有时间都来自 `decision_ledger` / `memory_records` / `memory_consolidation_changes` 的已存值。
- `memoryByMail`、`floorHits`、`memoryIds`、依据链在服务端排序后再返回；同一行重复查询结果一致。
- `changedSinceDecision` 是 `updatedAt > decidedAt` 的确定性比较，不依赖本次请求时间。
- 唯一“随当前状态变化”的是记忆的当前文本/状态/是否被取代；这是产品定义上的“当前状态”，不是模型请求，也不会改变任何已发内容的字节。UI 必须标明“当前内容”。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有。** 关键检查：

- `packages/gateway-contracts`：新 query/snapshot schema + fixture；反向用例覆盖非法 `decisionId`、超长 `sourceRef`、负数 `counts`。
- `test/integration/decision-trace.test.ts`：真实 SQLite 正向完整链；反向覆盖决策不存在、记忆删除、原话不可查、未知规则、未评价、跨 owner、仅 `memoryByMail` 出现、依据链截断、决策后修改、`inputs='{}'`、非 proactive 旧行、模型端口会抛错但 trace 仍成功、写操作 spy 为 0、重复调用深相等。
- `packages/application` 规则登记表单测：`FLOOR_RULE_IDS` 与 `DECISION_RULES` 双向一致；删一条规则必须失败。
- `apps/control-center/test/decision-trace.unit.test.ts`：每个状态都渲染对应句子；不渲染模型/ token/成本；打开/关闭/焦点；评价调用现有 command。
- `test/integration/decision-trace-browser.test.ts`：真实 Chromium 打开 Gmail 决策，断言完整链；反向用缺失记忆/缺失原话/未评价的 fixture，断言“无记录”句子而不是空白。
- `npm run check:locale`、`check:glossary`、`check:layout`、`check:prompt-prefix`。

这些用例不是“只测改动本身”：

- 如果服务端把缺失记忆返回成空数组而不是 `missing`，第 2 条反向用例失败；
- 如果规则登记表漏掉一条 `FLOOR_RULE_IDS`，登记表单测失败；
- 如果 `read` 忘了 owner 过滤，跨 owner 用例失败；
- 如果 `sourceRef` 误用 `machineString`，含 `/`/`#` 的契约用例失败；
- 如果 UI 对 `not_recorded` 渲染空白，浏览器用例失败；
- 如果 trace 偷偷调用模型或写库，模型 spy / 写操作 spy 用例失败。

### 4. 每个新值的使用处都能接受吗？

逐个核对如下（这是 I-73 的教训：只看改动不够，要看清单里的 id 能不能过下一道校验）：

| 产生的值 | 产生处 | 使用处 | 两端校验是否一致 |
|---|---|---|---|
| `decision.record.read` / `decision.record.snapshot` | 新增常量 | `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、服务端 `installedOperations`、浏览器 `installedGatewayV2Operations`、客户端 `queryMessage` | 类型名以字母开头、只含点，满足现有类型字符串；契约测试会遍历 schema map |
| `decisionId` | UI 从 `proactive.overview.decisions[].id` 取；服务端 `ids.next("proactive-decision")` / `ledgerId(hash)` 产生 | 新 query 的 `machineString` 校验；`DecisionLedgerPort.read` 的 id 长度校验 | 现有 overview 已把 decision id 声明为 `machineString`（`contracts-v2.ts` proactive snapshot），所以现有 id 必须已经能过；测试用真实 id 回归 |
| `ruleId` | `FLOOR_RULE_IDS`；旧 `memory_candidate` 可能把 `reasonCode` 写进 `ruleIds` | trace 的 `machineString`；UI 映射 | 三条规则 id 都是 `floor_*`，满足 `machineString`；旧原因码也只含下划线/字母，满足，但非 proactive 不展示为规则 |
| `sourceRef` / `codeRef` | 规则登记表 | trace 的 `boundedString(256)` | 含 `/` 和 `#`，**不能用 `machineString`**；契约测试专门放一个带 `/`/`#` 的样本 |
| `memoryId` / `threadId` / `messageId` / `supersededBy` | 领域层 / 记忆概览 | trace 的 `machineString` | 现有 `memory.overview.snapshot` 已用 `machineString` 校验这些字段（`contracts-v2.ts:1033-1034`），所以系统已假设它们合法；测试用真实 `memory:...` id |
| `text` / `quote` / `supersededByText` | 记忆记录 / 历史 quote | trace 的 `boundedString(2000)` | 与现有 `memory.overview.snapshot` 的 2000 上限一致 |
| `status` | 旧记忆行可能是 `deletion_pending` / `deleted_verified` | trace 只允许 `active/archived/trashed/missing` | 服务端先映射：删除中/已删除 → `missing`，不会把非法状态直接塞进快照 |
| `counts` | `decision_ledger.counts` JSON | trace 的 9 个 `integer(0)` | 读取时按 9 个键补默认值并校验非负；旧行缺键不会让整条查询失败 |
| `decidedAt` / `ratedAt` / `changedAt` | 数据库 ISO 字符串 | trace 的 `timestamp` | 写入时有 `validTime`（`sqlite-decision-ledger-operations.ts:28-31`）；读取时 null 用 `nullable` |
| `rating.value` | `owner_rating` | trace 的 `DECISION_RATINGS` + UI | 与 `proactive.decision.rate`、`rateMany` 同一列同一枚举 |
| `basis.nodes[].decisionRecordId` | `consolidationLedgerId()` 产生 `ledger:<40位hex>` | trace 的 `machineString` | 以 `l` 开头、只含 `:` 和 hex，满足 |
| `basis.nodes[].action` | `memory_consolidation_changes.action` | trace 的四个枚举 | 与 `DECISION_OUTCOMES.consolidation` 一致 |
| 新 `DecisionLedgerPort.read` | 新端口方法 | `SqliteDecisionLedgerOperations`、`DurableAdapters.decisionLedger()`、测试 fake | 所有实现都要加；`daily-review` 的 fake 用的是 `Pick<..., "listReviewPool">`，不受影响；用 typecheck 和单测兜住 |
| 新 i18n key | `message-ids.ts` + zh-CN/en/ja | 抽屉组件 | `check:locale` 检查三语齐全；`check:glossary` 检查旧名 |
| 新 doc | `docs/decision-record-write-conventions.md` | 新 ADR / 后续写入块 | `check:docs` / `check:markdown-tables` / `check:instruction-links` 如果链接了它 |

**反例（I-73 式）**：如果只把新操作加到 `contracts-v2.ts`，忘了加到 `PRODUCTION_DECISION_OPERATIONS` 和 `production-http-composition.ts` 的 `installedGatewayV2Operations`，控制中心永远不会显示“详情”按钮，E2E 会失败。或者只把 `sourceRef` 声明成 `machineString`，带 `/` 的 ADR 路径会被后端校验拒绝，抽屉打不开。这两条都必须在测试里覆盖，而不是只测“结构看起来对”。

---

## 七、哪些是已证实、哪些是推测/未核实

**【已证实】**

- `decision_ledger.inputs` 已有 Gmail 检查所需字段，且 `sqlite-proactive-operations.ts` 确实写入（P1）。
- `DecisionLedgerPort` 目前没有按 id 读单条的方法（P2）。
- 记忆概览和 `memory.basis.read` 已有来源、原话、状态、依据链（P3、P4）。
- 三条地板规则 id 和 ADR 0106 第 4 条的出处（P5）。
- 请求前缀规则和“只追加”要求（P7）。
- 抽屉可复用记忆页类名，且基线禁止新增通用内部面板（P8）。
- 新网关操作必须登记到契约、schema map、派发、installed ops 四处（P9）。
- 不需要新迁移即可读现有数据（P10）。

**【推测/未核实】**

- `check:locale` 是否逐键比对三语并会在缺 key 时失败：只确认脚本存在（`package.json:57`），未读实现。
- 控制中心是否有文档查看器、能否直接打开 ADR：未核实；因此方案只显示文档路径和代码符号，不编外链。
- 所有历史 Gmail message id / thread id 是否都满足 `machineString`：现有 `memory.overview.snapshot` 已这样校验，若历史数据有例外，新接口也会拒绝；需要用真实样本回归，不能只靠类型定义。
- 按 `decision_id` 查 `proactive_processed_messages` 的实际性能：该表没有 `decision_id` 索引，未实测；因此 v1 不查邮件头，避免为此加迁移。
- 模型输入/输出 payload 是否与新 trace 服务共用同一 protector：v1 不读它，所以不影响；将来若展示，需要确认。
- 控制中心是否已有现成的底部弹出抽屉样式：基线说记忆页抽屉支持桌面/手机，未逐一读 CSS；实现时先复用 `.memory-drawer`，不够再按 v12 基线补。

---

## 八、一句话结论

**用一条只读的 `decision.record.read` 查询，在服务端把 `decision_ledger.inputs`、记忆记录/历史、整理依据链和 `owner_rating` 一次性组装成“决策 → 规则 → 记忆 → 依据 → 评价”的显式状态机；控制中心复用记忆抽屉样式渲染，任何缺失都渲染成有定义的“无记录”句子；不新增迁移、不新增模型请求、不改任何提示词，并用真实 SQLite 反向用例和真实浏览器正/反向验收把每一环钉住。**
