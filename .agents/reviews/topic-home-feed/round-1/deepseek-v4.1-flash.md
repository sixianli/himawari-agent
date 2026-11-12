## 0. 先给结论

这个接口应该是**一个共享的只读汇总层 + 两类薄适配器**：设备走 `GET /api/device/v1/home`，网页走 `gateway.v2` 的 `home.read/home.snapshot`；两端读同一个 `HomeReadService`，件数只由服务器算一次。排序**不新增读取时模型调用**，只用条目产生时已有的模型判断和结构化字段做确定性排序；一句话和“为什么”只从已有记录里取，取不到就留空，不编。

反馈 `useful/disturbing` **不能只靠现有表**：现有 `owner_rating` 只允许 `useful/unneeded/missed`，`decision_signals.signal` 只允许 `opened/undone/replied`，审批和运行根本没有对应的决策记录行。建议加一张 `home_feedback`，迁移号 **0095**（当前最大是 `0094_memory_conversation_review.sql`）。

---

## 1. 方案依赖的前提

每条都附来源和原话；没有原话的明确标“检索结论”。

1. **设备接口是待建形态，已有表里没有“首页”。**
   来源：`docs/execution/specs/2026-11-11-apple-device-body-design.md:208-230`
   原话：“全部在 `/api/device/v1/` 下。除 `pair` 外都要设备签名。每个会改数据的请求都带设备生成的唯一编号，服务器收到重复的只认一次并返回第一次的结果。”
   同一张表列了 `GET threads`、`GET usage`、`POST feedback`、`POST approvals/respond`，没有 `GET home`。我搜索 `apps/agent-service/src` 也没有找到 `/api/device/v1` 的实际路由，只有设计和合约测试；**当前 main 上设备接口尚未实现**。

2. **网页已有多个单类读取消息，但没有跨类“首页”。**
   来源：`packages/gateway-contracts/src/contracts-v2.ts:22-141`
   清单里有 `proactive.overview.read`、`memory.overview.read`、`decision.chain.read`、`approval.list`，没有 `home.*`。原话可见同文件 `:35`、`:62`、`:66`、`:106`。

3. **主动提醒已有可为首页直接用的字段。**
   来源：`packages/application/src/ports/proactive-checks.ts:101-117`
   原话（字段名）：“`result`、`priority`、`dueAt`、`floorRaised`、`status`、`decisionId`、`contentRef`、`pushSourceKey`”。
   读取过滤在 `packages/application/src/services/proactive-overview.ts:145-192`：只读 `open/replied`，再用 `isReminderWorthy` 过滤。

4. **审批有结构化意图，但没有一句人话描述；`finalRisk` 是危险档位，不是时效。**
   来源：`packages/application/src/ports/authorization.ts:168-203`
   原话（字段名）：“`status`、`deliveryState`、`runId`、`intentSnapshot`、`expiresAt`、`semanticSnapshotHash`、`finalRisk`”。
   意图字段在 `:57-75`：`reversible`、`recipients`、`threadId`、`modelClassification.reasonCode`、`deterministicFacts`。
   设计文档也写明审批里没有一句人话描述，见 `docs/execution/specs/2026-11-11-apple-device-body-design.md` 的“还没有的东西”一节。

5. **待确认记忆和“替主人做好的”已有快照字段。**
   来源：`packages/gateway-contracts/src/contracts-v2.ts:1437-1605`
   原话（字段名）：“`pending`、`externalProposals`、`tidyUps`、`conversationReviews`、`reminders`、`personSuggestions`”。
   其中 `pending` 带 `requestId/threadId/sourceRef/text/topic/requestedAt`，`externalProposals.items` 带 `proposalId/text/category/dataClassification/client/receivedAt`，`tidyUps` 带 `changeId/action/text/relatedText/undoable`，`conversationReviews` 带 `reviewId/undoable/changes`。

6. **“为什么”的规则/记忆数据在决策记录里，且已有三态展示。**
   来源：`packages/application/src/ports/proactive-checks.ts:235-256`
   原话（字段名）：“`ruleIds`、`sourceIds`、`floorHits`、`ruleHits`、`usedMemoryIds`、`memoryByMail`”。
   来源：`packages/application/src/services/production-decision-chain.ts:95-318`
   它把每一段分成 `recorded`、`none`、`not_recorded`、`not_applicable`，并限制展示数量。

7. **运行和后台任务有真实数据，但“正在做的”只有后台命令挂起记录。**
   来源：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:141-153`
   原话（状态值）：“`accepted`、`building_context`、`running`、`awaiting_approval`、`reconciling_external_result`、`completed`、`failed`、`cancelled`”。
   来源：`packages/persistence-sqlite/src/migrations/0059_run_background_holds.sql:1-20`
   原话（字段名）：“`run_id`、`thread_id`、`task_ref`、`started_at`、`deadline_at`、`released_at`、`outcome`、`output_ref`”。
   `listBackgroundRuns` 只列 `released_at IS NULL` 的挂起记录，见 `packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:892-930`。
   已完成运行的推送游标在 `packages/persistence-sqlite/src/migrations/0058_web_push.sql:50-57`，查询只返回 `runId/threadId/status/finishedAt/resultUnconfirmed`，没有一句话、没有撤销，见 `sqlite-web-push-operations.ts:535-566`。

8. **现有反馈值装不下 `disturbing`。**
   来源：`packages/persistence-sqlite/src/migrations/0080_decision_signals.sql:6`
   原话：“`signal TEXT NOT NULL CHECK (signal IN ('opened', 'undone', 'replied'))`”。
   来源：`packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:43`
   原话：“`owner_rating TEXT CHECK (owner_rating IS NULL OR owner_rating IN ('useful', 'unneeded', 'missed'))`”。
   审批没有对应的 `decision_ledger` 行；`ApprovalRequest` 也没有 `owner_rating`。

9. **模型请求头规则：只能尾部追加，会变的值只能放最后一条消息。**
   来源：`.claude/rules/prompt-prefix.md:27-29`
   原话：“固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。”
   原话：“每轮都会变的内容只放在最后一条用户消息里。”
   来源：`.claude/rules/prompt-prefix.md:35`
   原话：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”
   来源：`.claude/rules/prompt-prefix.md:41`
   原话：“系统提示和工具按对话冻结。”
   来源：`.claude/rules/prompt-prefix.md:51`
   原话：“同样的内容，每次都要序列化成同样的字节。”

10. **I-73 的教训是：新值必须逐项核对产生端和消费端。**
    来源：`docs/incidents-and-gates.md:112`
    原话：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”。

11. **门槛和每日模型费有登记处。**
    来源：`packages/calibration/src/thresholds.ts:56`
    原话：“`export const THRESHOLD_GATES: readonly ThresholdGate[]`”。
    来源：`packages/platform-node/src/strict-configuration.ts:1109`
    原话：“`const dailyCostMicros = optional("dailyCostMicros", 1_000_000, 1, 100_000_000);`”。

12. **`AttentionPolicyService` 在生产里没有接线。**
    来源：`packages/application/src/services/attention-policy-service.ts:186` 定义了服务；我搜索 `new AttentionPolicyService`，只命中测试和夹具（`packages/testing/test`、`apps/agent-service/test/fixtures`、`test/e2e`、`test/integration`）。因此不能直接把它当成现成的全局排序器。

---

## 2. 方案

### 2.1 总体结构

新增一个应用层只读服务 `HomeReadService`，做四件事：

1. 从现有各来源读出六类候选条目；
2. 归一化成统一的 `HomeItem`；
3. 做去重、可见性过滤、排序、件数计算；
4. 在同一组归一化结果上组装“为什么”。

然后两个薄适配器：

- 设备：`GET /api/device/v1/home`，设备签名；
- 网页/嵌入网页：`gateway.v2` 的 `home.read` → `home.snapshot`；
- 反馈：设备 `POST /api/device/v1/feedback`，网页 `home.feedback.record`。

**不新增常驻进程，不新增定时任务，不在读取时调模型。** 读取在一个 SQLite 只读事务里完成，保证列表和件数来自同一快照。

### 2.2 返回什么

建议返回：

```text
GET /api/device/v1/home
{
  asOf: string,                    // 最后
  homeRevision: string,            // 同一快照的稳定摘要，不含 asOf
  countDefinitionVersion: "home-count.v1",
  sortVersion: "home-sort.v1",
  pendingDecisionCount: number,    // 各端唯一来源
  total: number,
  items: HomeItem[],
  truncated: boolean,
  nextCursor: string | null
}
```

`HomeItem`：

```text
{
  key: string,                     // 稳定、可去重，例如 "proactive:insight:<id>"
  kind: "proactive" | "approval" | "memory_confirmation" | "done" | "running" | "error",
  title: string,                   // 一句话
  createdAt: string,
  dueAt: string | null,
  expiresAt: string | null,
  requiresOwnerDecision: boolean,
  state: "actionable" | "in_progress" | "done" | "error",
  severity: "critical" | "high" | "medium" | "low" | null,
  actions: HomeAction[],
  source: {
    state: "recorded" | "not_recorded",
    kind: "thread" | "mail" | "external" | "run" | "memory" | "connection",
    ref: string | null,
    label: string | null,
    href: string | null
  } | null,
  why: {
    source:   { state: "recorded"|"none"|"not_recorded"|"not_applicable", items: [...] },
    rules:    { state: "recorded"|"none"|"not_recorded"|"not_applicable", items: [...] },
    memories: { state: "recorded"|"none"|"not_recorded"|"not_applicable", items: [...] }
  },
  decisionId: string | null,
  dataClassification: "public" | "private" | "sensitive" | "restricted"
}
```

`HomeAction` 不能只给一个 `itemKey`，必须带目标服务真正认识的参数：

```text
{ kind: "approve", target: { approvalRequestId, revision, semanticSnapshotHash } }
{ kind: "deny",    target: { approvalRequestId, revision, semanticSnapshotHash } }
{ kind: "remember", target: { requestId } }              // memory.approval.respond
{ kind: "forget",   target: { requestId } }
{ kind: "keep_external", target: { proposalId } }        // memory.external.respond
{ kind: "reject_external", target: { proposalId } }
{ kind: "undo_tidy", target: { changeId } }              // memory.tidy.undo
{ kind: "undo_review", target: { reviewId } }            // memory.conversationReview.undo
{ kind: "open", target: { threadId? / href? } }
{ kind: "retry" / "reconnect", target: { ... } }
{ kind: "useful" / "disturbing", target: { itemKey } }   // 只走 feedback
```

这是 I-73 的直接应用：**首页的 `key` 不能拿去调审批或记忆接口**。审批接口要 `approvalRequestId + revision + semanticSnapshotHash`（`ApprovalRequest` 字段见 `authorization.ts:168-190`），记忆审批要 `requestId`（`contracts-v2.ts:1741-1748`），外部提议要 `proposalId`（`:1720-1735`），撤销要 `changeId/reviewId`。两端测试必须覆盖“把 `key` 当业务 id 用会被拒”。

### 2.3 六类条目从哪里来

| 类型 | 现有真实来源 | 一句话 | 动作 | 计入件数 |
|---|---|---|---|---|
| 主动提醒/拦截 | `source_insights` 中 `status in (open,replied)`，再按 `isReminderWorthy` 过滤；内容来自 `ProactiveInsightContent` 的 `summary/reason/from/subject/link` | 直接用模型已产出的 `summary`；没有就省略该条 | 打开原信、完成、不再提醒、`useful/disturbing` | `result=act/check` 计；`know` 不计（见待拍板） |
| 审批 | `approval_requests` 中 `status=pending` 且未过期；意图来自 `intent_ref` 的 `GovernedActionIntent` | **不新增模型**：用 `capability manifest displayName`（有则用）+ `operation` + `actionKind` + 目标数量生成模板；没有 displayName 就用 `operation` 原文 | 同意、不同意、打开对话、`useful/disturbing` | 计 |
| 待确认的记忆 | `memory_approval_requests` 中 `status=pending`，文本来自候选；`external_memory_proposals` 中 `status=pending` | 敏感记忆：“要记下这条记忆吗？<text>”；外部提议：“另一个工具提议记下：<text>” | 记下/不记；外部提议 keep/reject | 计 |
| 替主人做好的 | **当前可用的真实来源**：`memory.overview.tidyUps`（`changeId/action/text/undoable`）和 `conversationReviews`（`reviewId/undoable/changes`）。**已完成的运行只有 `runId/threadId/status`，没有一句话和撤销，先不显示** | 整理记忆：“Himawari 已经整理好：<text>”；回看：“Himawari 回看了一段对话并更新了记忆” | 撤销（`undoable=true`）、打开记忆 | 不计 |
| 正在做的 | `run_background_holds` 中 `released_at IS NULL` + `runs.status=running`，通过 `listBackgroundRuns` 读取；有 `commandRef` 时可读命令预览，没有就只说“后台任务” | “Himawari 正在后台做一件事”或“正在后台做 N 件事”，带已运行时长/最晚时间 | 打开对话 | 不计 |
| 出错要主人处理的 | 当前最确定的：Gmail `connection.status=needs_reconnect`（`proactive-checks.ts:132-140`）；`runs.status=failed`（可复用 `listFinishedRuns` 的查询形态，但要改成窗口查询）；后台挂起 `outcome=failed` 需要新增一个只读窗口查询 | “Gmail 连接需要重新授权”“这一轮没有完成” | 重新连接、打开对话、重试/忽略 | 按设计原文**不计**；见待拍板 |

**没有真实来源、v1 不显示的：**

- 设备动作的“已完成、可撤销”：`device_actions` 还没合进 main，只有设计，没有现成表/读取；
- 通用 `accepted/building_context/running` 运行：没有列表读取，也没有一句话；
- 感知记录产生的待确认记忆：感知功能还没合进 main（材料已写明，未核实最终形态）；
- 已完成的普通运行：`listFinishedRuns` 只有状态和对话 id，无法说“做成了什么”；
- 记忆到点提醒 `reminders`：数据存在，但没有和主动提醒同一套优先级，v1 先留在记忆页，是否并入见待拍板。

### 2.4 排序要不要用模型

**读取时不用。** 理由：

- 每次首屏、每个设备、每次刷新都调模型，费用和延迟不可控；
- 模型输出不稳定，会破坏“同一段文字/同一份清单字节确定”；
- 单机 4 核 8GB，不该为读接口加常驻或高频推理；
- 条目在产生时本来就有模型判断：邮件检查给 `result/priority/dueAt/reason/todo`，记忆候选给分类/置信度，审批给 `finalRisk/actionKind/modelClassification`。读取只是把这些结构化判断汇总。

**排序规则（确定性、可测）：**

1. `requiresOwnerDecision=true` 的在前；然后是 `error`、`in_progress`、`done`。
2. 在需要主人决定的条目内，先按“硬截止/到期窗口”：
   - 审批用 `expiresAt`；
   - 主动提醒用 `dueAt`；
   - 没有截止的排后；
   - 窗口阈值放配置/门槛表，不写死在比较函数里。
3. 同一截止窗口内按 `severity`：`critical > high > medium > low > null`。
   - 审批用 `finalRisk`；
   - 主动提醒用 `priority`，`check` 不高于同优先级 `act`；
   - 待确认记忆按 `dataClassification`/敏感 topic 给固定档，不从正文猜；
   - 运行/错误用固定档。
4. 再按 `createdAt` 新到旧。
5. 最后按 `key` 升序，保证全序稳定。

**不用模型也能做对的部分：** 过滤、过期、去重、件数、来源链接、为什么的取数、反馈落库、排序的并列打破。**需要语义判断的部分：** 邮件“是否值得提醒/多紧急”已经由邮件检查模型给出；审批一句话和跨类“哪个更重要”没有现成语义字段，v1 用结构化模板和确定性排序，不假装是模型理解。

### 2.5 “等主人定的件数”的精确定义

建议定义（版本 `home-count.v1`）：

```text
count = 在同一个只读快照里，满足以下全部条件的 HomeItem 数：
  kind ∈ { proactive, approval, memory_confirmation }
  requiresOwnerDecision = true
  state = actionable
  （有 expiresAt 时）expiresAt > asOf
  该条目的标题/来源至少有一项可读，能显示给主人
  去重后只算一条
```

具体到来源：

- 主动提醒：`status in (open,replied)` 且 `result in (act,check)`；
- 审批：`status=pending`、未过期；`deliveryState=queued_no_ui` 也算，因为它仍然等主人决定；
- 敏感记忆：`status=pending` 且候选文本可读；
- 外部提议：`status=pending`。

**不计：** `knowledge`（`result=know`）、`done`、`running`、`error`。这是按材料原话“只数需要主人做决定的条目（提醒、审批、待确认的记忆）”的直译；如果 Andy 认为 `error` 也算，需要改定义和测试。

**怎么保证各端永远一样：**

1. 件数**只在服务器算**，客户端不得用 `items.length` 或自己过滤重算；
2. 列表和件数在同一个 SQLite 只读事务里生成；
3. 件数在分页/截断之前算；
4. 服务器返回 `homeRevision` 和 `countDefinitionVersion`；同一 `homeRevision` 的件数必须相同；
5. iPhone/Watch/Mac 都调同一个读取层/字段，不各自维护算法；
6. 测试用同一个 DB、同一个 `ClockPort` 起三种设备客户端，断言三个 `pendingDecisionCount` 完全相等，并等于测试侧独立按定义算出的集合大小；再加“换 DB 插入顺序结果不变”。

### 2.6 “为什么”三样分别能给什么

| 类型 | 来源依据 | 命中的主人规则 | 用到的记忆 |
|---|---|---|---|
| 主动提醒 | 能给：发件人、主题、原信链接；决策记录里的 `sourceIds` | 能给：`ruleIds/floorHits/ruleHits`，复用 `production-decision-chain.ts` 的 `recorded/none/not_recorded` 和规则版本 | 能给：`memoryIds/usedMemoryIds/memoryByMail`，按现有可见性规则隐藏受限内容 |
| 审批 | 能给：发起它的 `threadId/runId` 和对话标题；审批意图里的 `actionKind/operation/targets/recipients` | **给不出主人规则**；只能给系统审批依据（`finalRisk`、`modelReasonCode`、`deterministicFacts`），不能写成“你定的规则” | **给不出**；审批没有“用到的记忆”记录 |
| 敏感记忆待确认 | 能给：`threadId`、`sourceRef`；“要记下的文本”本身 | **给不出主人规则** | 如果 `decision=update/merge`，能给“会改到的记忆”`existingMemoryId`；这不是“用到的记忆”，界面若只有“用到的记忆”一行就不显示 |
| 外部提议 | 能给：`client`、`sourceKey`、`receivedAt` | 给不出 | 给不出 |
| 替主人做好的 | 能给：`action/text/relatedText`；没有可追溯对话就不给来源 | 给不出 | 给不出（除非以后决策记录补链） |
| 正在做的 | 能给：`runId/threadId/taskRef/startedAt/deadlineAt`；`commandRef` 可读时给命令预览，但这不是“为什么” | 给不出 | 给不出 |
| 出错要主人处理的 | 能给：Gmail 连接状态、失败运行的 `runId/threadId`、诊断码 | 给不出 | 给不出 |

**规则：** 没有就返回 `state="none"` 或 `"not_recorded"`/`"not_applicable"`，客户端隐藏对应行；**不得用正文关键词猜规则，不得用别的记忆凑数**。

### 2.7 反馈怎么落地

新增表 `home_feedback`（迁移 0095）：

```sql
CREATE TABLE home_feedback (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 256),
  item_kind TEXT NOT NULL CHECK (item_kind IN (
    'proactive','approval','memory_confirmation','done','running','error'
  )),
  feedback TEXT NOT NULL CHECK (feedback IN ('useful','disturbing')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 256),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, item_key, feedback, source_ref)
) STRICT;
```

- `POST /api/device/v1/feedback` 带设备唯一编号；同一编号重复返回第一次结果；表上的唯一约束是第二道幂等。
- 服务端先按 `itemKey` 重建/定位条目，确认它属于当前 owner/agent、当前可见；找不到就拒绝，不把任意字符串写进表。
- 对主动提醒，可以**镜像**到现有 `owner_rating`：`useful→useful`，`disturbing→unneeded`。但绝不能把 `disturbing` 原样写进 `owner_rating`，因为 `0089:43` 的 CHECK 会拒绝；这个映射函数必须两端测试。
- 审批、运行、记忆确认没有 `decision_ledger` 行，只写 `home_feedback`；现有日报/校准暂不强行接，下一版再 union。
- 通知按钮的“有用/打扰”仍按设计里的 `notification_action_tokens` 校验，落到同一张 `home_feedback`；注意主动提醒的 push source key 可能是批次 `proactive:<pushId>`，而首页条目 key 是 `proactive:insight:<insightId>`，合并批次时不能假装是单条反馈。

### 2.8 要不要改表

**要改，但只加一张表，不改现有表：**

- 新增 `home_feedback`（0095）；
- 可加索引 `home_feedback_time_index`、`approval_requests_pending_index`（只是索引，不改表结构）；
- 更新 `schema-catalog.ts`；
- 迁移号当前最大 `0094`，新号 `0095`；如果合并时被别人占用，按队列顺延；
- 不需要改 `decision_signals`/`decision_ledger` 的 CHECK，也不需要给审批新建决策记录行。

### 2.9 费用和上限

- **新增模型调用：0 次/天，费用 0。** 读取只做 SQLite 读和内存排序。
- 上限放配置，并在 `GET config`/设置页可见：
  - `home.items.max`（默认 50）；
  - `home.why.rules.max`（默认 5）；
  - `home.why.memories.max`（默认 5）；
  - `home.done.windowMs`（默认 24h）；
  - `home.error.windowMs`（默认 24h）。
- 超过条目上限时返回 `truncated=true`、`total`、`nextCursor`，页面显示“还有 N 条”；不静默截断。
- 如果以后为了审批一句话新增“产生时模型调用”，必须另走提示词目录和预算：固定指令在前、审批数据在后、时间最后；每天次数不超过新增审批数，费用走现有 `dailyCostMicros`（默认 1 美元/天），到上限退回模板。**本方案 v1 不做。**

### 2.10 测试清单（含反向）

**单元/合约：**

1. `HomeItem` 合约：六种 `kind`、动作枚举、`why.state`、`itemKey` 格式；多字段/未知枚举拒绝。
2. 件数定义：`act/check` 计，`know` 不计；pending 审批计，过期不计；敏感记忆 pending 计；外部提议 pending 计；done/running/error 不计；`queued_no_ui` 计。
3. 去重：同一外部提议重复读到只算一次；同一 run 的多个后台 hold 合并成一条 `running`；同一 run 有待审批时 `running/error` 不重复出现。
4. 排序：同一输入、打乱 DB 插入顺序，输出顺序不变；并列为空/相同时间时按 `key` 稳定。
5. 为什么：主动提醒有规则/记忆；审批的规则/记忆为 `not_applicable`；缺字段时为空，不生成占位文本；受限记忆文本隐藏。
6. 可见性：`restricted` 记忆不出现在为什么正文；敏感条目的 `dataClassification` 正确。
7. 反馈映射：`useful→owner_rating=useful`，`disturbing→owner_rating=unneeded`；把 `disturbing` 直接写 `owner_rating` 必须被拒。
8. 动作目标：审批动作带 `approvalRequestId/revision/semanticSnapshotHash`；记忆动作带 `requestId`；外部提议带 `proposalId`；撤销带 `changeId/reviewId`。把 `itemKey` 当这些 id 用必须失败。

**集成：**

9. 设备签名后的 `GET home`：真实 P-256 签名、真实 SQLite；iPhone/Watch/Mac 三种设备同一 `ClockPort` 下 `pendingDecisionCount` 相等。
10. 同一只读事务：并发写入新审批时，列表和件数不出现“列表有、件数没有”或反之。
11. 反向：只有 done/running/error 时 `pendingDecisionCount=0`、列表非空但不计数。
12. 反向：`know` 主动提醒显示但不计数。
13. 反向：过期审批从列表和件数同时消失；`queued_no_ui` 仍计数并出现在列表。
14. 反向：待确认记忆文本不可读时，不显示也不计数（不能出现红点大于可见条目）。
15. 反向：不存在的 `itemKey`、别的 owner 的 `itemKey`、已消失条目的反馈被拒。
16. 反馈幂等：同一设备唯一编号重放只写一次；同一 item 先 useful 再 disturbing，历史保留且最新查询正确。
17. 通知按钮反馈：token 过期/重复/换设备/审批内容变了被拒；主动提醒批次反馈不冒充单条。
18. `home.read` 网关快照与设备 `GET home` 在同一 DB/时钟下字段和件数一致。
19. 迁移：`0095` 表结构、CHECK、索引、`schema-catalog` 一致；删掉表/改 CHECK 时 `migration-engine.contract.test` 失败。
20. **提示词前缀：** `npm run check:prompt-prefix` 的 `[I-66]` 用例保持通过；新增一条断言“读取 home 不产生任何模型调用/不新增提示词目录条目”。如果去掉这个断言或误加后台模型调用，测试必须失败。

**反向验收的核心：** 每一条守卫都要有“去掉守卫就失败”的用例；不能只测正向。

---

## 3. 考虑过但不选的做法

1. **每次读取都让模型排序。**
   不选：费用、延迟、非确定性、失败时首屏不可用；也违反“同一输入字节稳定”的要求。模型只在条目产生时做语义判断。

2. **客户端自己排序/自己算件数。**
   不选：三端算法会漂移，Watch/Mac 与 iPhone 数字会不一致；违反“客户端不能自己排序，也不能自己拼数据”。

3. **直接复用 `AttentionPolicyService` 当全局排序器。**
   不选：它只处理单个 `AttentionCandidate` 的投递等级，不是跨类清单；生产未接线；要用就得为六类编造 `urgency/confidence`，反而把不确定的分数写死。

4. **只改 `decision_signals` 的 CHECK 加 `disturbing`。**
   不选：SQLite 要重建表；审批/运行没有 `decision_id`；只解决主动提醒，不解决六类。加 `home_feedback` 更干净。

5. **只用现有 `owner_rating` 记反馈。**
   不选：`disturbing` 无处存；审批/运行没有行；把 `disturbing` 映射成 `unneeded` 可以做镜像，但不能作为唯一存储。

6. **把通用 `runs` 都算“正在做的”。**
   不选：`listBackgroundRuns` 只给后台挂起记录；通用运行没有列表读取和一句话，会显示空壳。

7. **把已完成运行都算“替主人做好的”。**
   不选：`listFinishedRuns` 只有 `runId/threadId/status`，没有“做成了什么”和撤销；先只接 `tidyUps/conversationReviews`。

8. **把记忆到点提醒并入主动提醒。**
   暂不选：数据存在，但没有和 Gmail 提醒同一套优先级；并入会改变件数和排序，需 Andy 拍板。

9. **审批一句话在读取时用模型生成。**
   暂不选：每次首屏都花钱、慢、可能变；v1 用结构化模板。若 Andy 要更自然的一句话，应放到审批产生时的模型调用里，不在读取路径。

10. **给首页单独做一套通知/推送。**
    不选：沿用现有通知和锁屏规则；首页只负责解锁后的读取。

---

## 4. 风险和反例

1. **跨类“最紧急”是产品判断，不是纯技术问题。**
   反例：一个 `finalRisk=critical` 但 7 天后过期的审批，和一个 `priority=high` 且 1 小时后到期的邮件提醒。按“截止窗口优先”邮件排前；按“危险档位优先”审批排前。需要 Andy 选一个，并用真实样本校准。

2. **审批的一句话可能很生硬。**
   反例：`capabilityRef=restaurant-search`、`operation=search`、`targetRefs=[]`，模板只能写“Himawari 想执行 search”。这比编造好，但不一定好用；若不能接受，必须把一句话移到产生时由模型写，并改提示词/合约。

3. **“为什么”对审批和记忆大面积是空的。**
   反例：用户点开审批，只看到“来源：某个对话”，没有规则、没有记忆。这不是 bug，是现有数据没有；如果产品要求三行都有，就必须新增审批/记忆的决策记录，而不是在读取层编。

4. **件数定义与用户直觉可能冲突。**
   反例：`know` 邮件显示在首屏但不计红点；用户看到 3 条却没红点。或者 `error` 需要处理却不计数。必须让 Andy 确认，并在页面上写清“只数提醒/审批/待确认记忆”。

5. **`disturbing` 的镜像会损失语义。**
   反例：`disturbing` 映射成 `unneeded`，日报里看不出“打扰”与“不需要”的区别。若产品要区分，下一版需要扩 `owner_rating` 或单独报表。

6. **运行/错误条目是易失的。**
   反例：用户点开“正在做”时后台命令刚好结束，条目消失；反馈可能 404。需要定义“条目消失后反馈返回已失效”，不能静默写假 key。

7. **性能未实测。**
   反例：50 条主动提醒每条读 5 条记忆文本 + 规则，单机 SQLite 读取可能变慢。必须加 `home.items.max` 和 `home.why.*.max`，并在生产同规模数据上压测；未测前不宣称“很快”。

8. **设备接口在 main 尚未实现。**
   反例：设计里的 `GET home` 和 `POST feedback` 没有现成路由/签名中间件；如果实现时把 `itemKey` 直接当审批 id，就会重演 I-73。必须先做端到端测试，而不是只测读取层。

9. **主动提醒批次反馈的归属。**
   反例：一条推送合并了 3 封邮件，通知按钮点“打扰”，首页却把它记到 3 条中的某一条。必须明确是批次反馈还是单条反馈，不能让 `home_feedback` 和 `web_push_feedback` 各说各话。

10. **隐私。**
    反例：首页响应含敏感记忆正文，被设备本地缓存或日志记录；锁屏只显示标题的规则必须继续遵守。`why` 里的受限记忆必须走现有可见性判断。

---

## 5. 需要人拍板的取舍

1. **`know` 是否计数？** 我建议不计数（只显示在“值得知道”），因为原话是“只数需要主人做决定的条目”。
2. **`error` 是否计数？** 按设计原文我建议不计；但它确实需要主人处理，建议 Andy 明确。
3. **记忆到点提醒是否并入首屏？** 数据已有，但会改变件数和排序；v1 建议先不并入。
4. **审批一句话：** 接受结构化模板，还是愿意在审批产生时多花一次低价模型调用写自然语言？
5. **`disturbing` 是否只存新表，还是同时映射到现有 `owner_rating=unneeded`？** 映射能兼容旧页面，但语义有损。
6. **`queued_no_ui` 审批是否显示并计数？** 我建议显示并计数，因为它仍然等主人决定。
7. **已完成运行要不要进首屏？** 需要先有结果摘要和撤销语义；v1 建议不进。
8. **列表上限和刷新频率。** 默认 50 条；Watch/Mac 是否只取件数、是否降低刷新频率。

---

## 6. 读代码/来源证实的，和推测的

**已证实（读过文件或检索过代码）：**

- 现有设备接口设计表没有 home；main 没有 `/api/device/v1` 实际路由，只有设计/合约测试。
- 网页 `gateway.v2` 没有 `home.*` 消息。
- 主动提醒、审批、记忆快照、决策记录、后台挂起、运行状态、反馈枚举的字段和限制如前提所列。
- `AttentionPolicyService` 生产未接线。
- `finalRisk` 是风险档位字段；审批没有一句话描述字段。
- 迁移目录当前最大是 `0094`。
- 提示词规则要求固定在前、会变的后、只能追加、字节确定。

**推测/未核实：**

- 设备端最终如何实现签名、路由和 Swift 清单生成；当前 main 没有代码可核。
- 审批一句话所需的 `capability manifest displayName` 是否对所有审批都能取到；取不到时的模板效果未评估。
- 生产数据量下 50 条 × why 的 SQLite 读取耗时；未压测。
- 后台命令的 `commandRef` 在服务重启后是否仍可读、所有后台任务是否都写 label；代码里有 `commandRef` 可选，未逐一核实。
- 已完成后台挂起的读取代价；`run_background_holds` 只有 open 索引，已释放窗口查询可能需要新索引。
- 通知按钮 `useful/disturbing` 的凭据与首页反馈的最终合并方式；设备设计已写，但 main 未实现。
- “工具调用一句话”那个 PR 的最终形态；材料说还没合进 main，我未核实分支。
- 感知产生的待确认记忆；材料说感知记录还没合进 main，我未核实后续实现。
- 首屏排序权重是否符合 Andy 直觉；需要真实样本和用户测试。

---

## 7. 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本方案的读取接口不组装模型请求，不新增系统提示、工具定义、历史消息或遮盖结果。现有对话仍按 `.claude/rules/prompt-prefix.md:41` 冻结，仍只在末尾追加；每轮会变的值仍只能放在最后一条用户消息里。新增的 `home.read`、设备路由和 `home_feedback` 都在模型请求之外。

唯一要警惕的是“为了审批一句话新增后台模型调用并往 `packages/prompt-catalog` 加固定文字”：那会进“自己写的固定文字”清单，可能按 I-78/规则第 11 条让老对话的遮盖结果变一次。本方案 v1 不做这件事。检查：`npm run check:prompt-prefix` 的 `[I-66]` 用例保持通过，并新增“读取 home 不产生模型调用”的断言。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会影响模型请求。** 对首页响应本身，要求同一输入、同一时钟快照下字节稳定：

- 条目按 `key` 最终排序，不依赖数据库返回顺序；
- 规则/记忆列表按固定键排序，不输出无序集合；
- `itemKey` 由来源 id 派生，不用随机 UUID；
- `why` 文本来自已存记录，不在读取时重新生成；
- `generatedAt/asOf` 只作为末尾元数据，不参与 `homeRevision`，不进入模型请求；
- 可见性/遮盖是确定性函数，不依赖同一请求里后面的条目。

### 3. 有没有对应的自动检查，反向用例真的会失败？

有。新增 `npm run check:home`（或并入现有检查）覆盖：合约、件数、排序、去重、why、反馈、迁移、跨端一致性。每条守卫都配“去掉守卫必须失败”的反向用例，例如：

- 去掉 `requiresOwnerDecision` 过滤 → `know` 计数用例失败；
- 去掉过期过滤 → 过期审批计数用例失败；
- 去掉 owner 校验 → 别的 owner 的 `itemKey` 反馈用例失败；
- 去掉幂等/唯一约束 → 重复反馈用例失败；
- 把 `disturbing` 直接写 `owner_rating` → CHECK 用例失败；
- 把 `itemKey` 当审批 id → 端到端动作用例失败；
- 把审批 `rules` 填成主人规则 → “不得编造”用例失败；
- 读取时调模型 → “零模型调用”断言失败。

### 4. 每个新值两端都能接受吗？

逐个核对：

| 值 | 产生端 | 使用端 | 两端校验 |
|---|---|---|---|
| `itemKey` | `HomeReadService` | 设备/网页列表、`home_feedback`、反馈路由 | 服务端格式 + owner/agent + 条目存在性；客户端只回传，不解析业务含义 |
| `kind` | `HomeReadService` | 客户端图标/动作选择、`home_feedback.item_kind`、件数过滤 | 合约枚举与表 CHECK 完全一致 |
| `requiresOwnerDecision` | 服务端 | 件数、客户端徽标（只读） | 客户端不得重算；件数测试 |
| `pendingDecisionCount` | 服务端 | iPhone 页签、Watch 表盘、Mac 菜单栏 | 只认服务端字段；三端一致性测试 |
| `actions[].kind` | 服务端 | 客户端 → 现有审批/记忆/撤销/反馈接口 | 每个动作的 target 字段用现有合约校验；`itemKey` 不得替代业务 id |
| `actions[].target.approvalRequestId/revision/semanticSnapshotHash` | 服务端 | `approvals/respond` | 现有审批服务校验 revision/hash（`approval-service.ts:41,58`） |
| `actions[].target.requestId` | 服务端 | `memory.approval.respond` | 现有记忆审批校验 |
| `actions[].target.proposalId` | 服务端 | `memory.external.respond` | 现有外部提议校验 |
| `actions[].target.changeId/reviewId` | 服务端 | `memory.tidy.undo` / `memory.conversationReview.undo` | 现有撤销服务校验 |
| `feedback` | 客户端 | `home_feedback.feedback`；主动提醒镜像到 `owner_rating` | 表 CHECK 只允许 `useful/disturbing`；镜像函数只产出 `useful/unneeded` |
| `why.*.state` | 服务端 | 客户端隐藏/显示 | 合约枚举；缺失不得编造 |
| `homeRevision/countDefinitionVersion/sortVersion` | 服务端 | 客户端/测试 | 不参与业务写入；测试同快照一致 |

### 5. 排序要不要用模型？用在哪一步、什么时候调用、花多少、失败怎么办？有没有不用模型也能做对的部分？

**读取时不用模型。** 模型只在条目产生时使用，且是现有调用：邮件检查给出 `result/priority/dueAt`，记忆候选给出分类/置信度，审批给出 `finalRisk/actionKind/modelClassification`。本方案不新增模型调用，所以每天 0 次、费用 0、没有失败路径。

不用模型也能做对的部分：过期/状态过滤、去重、件数、来源链接、why 取数、反馈落库、稳定排序和并列打破。需要语义判断的部分已经由产生时模型或产品模板承担；审批跨类“谁更紧急”是产品排序策略，不是读取时模型推理。

如果 Andy 要求审批一句话更自然，建议在审批产生时的现有模型调用里多输出一个字段，而不是读取时调用；那样要登记提示词、固定内容在前、审批数据在后、时间最后，并走现有每日 1 美元上限。

### 6. “替主人做好的”和“正在做的”现在哪些数据能作为真实来源？

**正在做的：** `run_background_holds` 中 `released_at IS NULL` 且关联运行仍为 `running`，通过 `listBackgroundRuns` 读取；字段有 `taskRef/startedAt/deadlineAt`，`commandRef` 可选。通用 `accepted/building_context/running` 运行没有列表读取，也不显示。

**替主人做好的：** 当前真正可用的只有 `memory.overview.tidyUps`（`changeId/action/text/undoable`）和 `conversationReviews`（`reviewId/undoable/changes`）。已完成的普通运行只有 `runId/threadId/status`，没有一句话和撤销，v1 不显示；设备动作的“已完成”还没有合进 main，不显示。

**没有真实来源先不显示的：** 通用运行完成结果、设备动作完成/撤销、感知产生的待确认记忆、记忆到点提醒并入首页。

### 7. 接口形态

**两者共用一个读取层，各自一个薄适配器：**

- 设备：`GET /api/device/v1/home`（新增到设备接口表）；`POST /api/device/v1/feedback` 复用现有反馈入口；
- 网页/嵌入网页：`gateway.v2` 新增 `home.read` / `home.snapshot`，以及 `home.feedback.record`；
- 两端都调用 `HomeReadService`，不各自查表、不各自排序、不各自算件数。

不建议只复用现有网页消息：现有 `proactive.overview.read`、`memory.overview.read`、`approval.list` 是单类读取，跨类汇总会在客户端拼数据，违反“客户端不能自己拼”。

### 8. “等主人定的件数”的精确定义，以及怎么保证各端一样、怎么测

定义见 2.5：同一个只读快照里，`kind ∈ {proactive, approval, memory_confirmation}`、`requiresOwnerDecision=true`、`state=actionable`、未过期、内容可显示的条目数；`know/done/running/error` 不计。

保证方式：服务器唯一计算、列表与件数同事务、分页前计算、返回 `homeRevision` 和 `countDefinitionVersion`、客户端只显示不重算。测试用同一 DB/时钟起三种设备客户端，断言数字相等且等于独立集合大小；再加插入顺序打乱、过期、`know`、done/running/error、重复外部提议等反向用例。

### 9. 反馈 `useful` / `disturbing` 怎么落地，能不能不改表？

**不能完整地不改表。** 现有 `owner_rating` 只有 `useful/unneeded/missed`，没有 `disturbing`；`decision_signals.signal` 只有 `opened/undone/replied`；审批/运行没有对应决策记录行。只靠旧表只能把 `disturbing` 硬塞成 `unneeded`，审批/运行仍然无处记。

建议加 `home_feedback`（迁移 0095），存精确的 `useful/disturbing`；对主动提醒额外镜像到现有 `owner_rating` 以兼容旧页面，但镜像只产出 `useful/unneeded`，绝不把 `disturbing` 原样写进旧 CHECK。

### 10. 要不要改表，要改哪些？

要。只加 `home_feedback` 一张表（迁移 0095），可加两个索引；不改现有表结构，不改 `decision_signals/decision_ledger` 的 CHECK。更新 `schema-catalog.ts` 和迁移合约测试。当前最大迁移是 `0094`，新号 `0095`；合并时按队列顺延。

### 11. 测试清单

见 2.10。核心是：件数正反、排序稳定、why 不编造、反馈幂等/归属、动作目标 id 与后端校验一致、三端同数、迁移一致、提示词零变化。

### 12. 最大的风险和还没核实的事

最大风险是**跨类“最紧急”没有客观答案**：现有字段只能支撑确定性排序，不能保证符合 Andy 的直觉；审批和运行的一句话/“为什么”又大面积缺数据。其次是**设备接口在 main 尚未实现**，端到端签名、通知按钮和 Swift 生成都未核实。未核实还包括：生产数据量下 why 的读取耗时、`capability displayName` 的可用性、后台 `commandRef` 的可读性、通知批次反馈的归属、感知产生的待确认记忆的最终形态。
