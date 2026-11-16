I'll start by mapping the repo and reading the core files in parallel.
Bash is restricted to git commands. Let me use the file tools.
## 0. 结论（先给判断）

我认为最好的做法不是再写一套调度/注意力服务，而是把现有的 `think_inbox` 补成唯一的“醒来入口”，再在它旁边加一张很薄的定时器表、一份任务进度/已告知摘要，以及一个追溯查询。`packages/application/src/services/scheduler-service.ts`、`durable-background-work-service.ts`、`attention-policy-service.ts`、`unified-trigger-ingestion-service.ts` 虽然已写好，但它们围绕 grant、authority lease、fencing token 设计，和“单人、SQLite 单写、v0.3 先在 iPhone 跑起来”不匹配，v0.3 不接入。

v0.3 的顺序：**先接邮件一个来源打通入口和追溯 → 再做自己的跟进定时器 + 进度/已告知 → 再做主人要的周期任务 → 再接记忆和手机感知 → 最后收紧推送、设置和真机验收**。带工具的“想一想”运行和只读工具限制沿用 ADR 0274，不新增写工具。

---

## 1. 方案依赖的前提

每条都附来源和原话；读代码证实的标“已证实”，推断标“推测”。

**P1｜只追加是硬约束。** 已证实。
来源：`.agents/instructions/prompt-prefix.md:28`：
> “每轮都会变的内容只放在最后一条用户消息里。”
同文件 `:36`：
> “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”
同文件 `:42`：系统提示和工具按对话冻结，“改了提示词文字，只对新对话生效”。

**P2｜入口已经存在，但没有来源接进来。** 已证实。
来源：`docs/adr/0274-new-things-go-through-one-think-entrance.md:55`：
> “一个入口表。表 `think_inbox`……一行记一件来源请 Himawari 想一想的事”。
同文件 `:57`：
> “来源要先登记……没登记的种类直接拒收。新增来源只加一行登记，不改判断代码。”
同文件 `:105`：
> “带工具的想一想运行、同意任务的写操作审批、来源接入和旧代码清理在后续 PR 里。”
代码：`production-http-composition.ts:1881`、`:1896` 已经 `think?.loop.start()`；但在 `apps/agent-service/src` 非测试代码里搜不到 `ProductionThinkInbox.submit` 或 `sources.register` 的调用。

**P3｜入口的去重、限量、载荷清理已经实现。** 已证实。
来源：`packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:16`：
> `UNIQUE (owner_id, agent_id, source_kind, source_ref, source_version)`
`production-think-inbox.ts:149-157`：未登记来源直接 `THINK_SOURCE_UNREGISTERED`；`sourceRef` 1–256、`sourceVersion` ≤256、摘要为空拒收。`:198-235`：先写加密摘要载荷，再入队；没被引用则删除载荷。

**P4｜一次“想一想”运行是全新对话、只有一条消息，不会改已有对话前缀。** 已证实。
来源：`production-think-runner.ts:138-148` 由 entry id 派生 `thread:think:* / message:think:* / run:think:*`；`:199-215` 以 `triggerSource: "external_event"` 开运行；`:85-97` 把来源说明、摘要、外部内容提示和动作清单渲染成一条消息；`production-think-runner.ts:95` 的 `actions.map(...)` 来自 `ThinkActionRegistry.list()`，而 `:77` 按 type 排序。
`packages/prompt-catalog/src/think.ts:20-45` 是单条 `THINK_RUN_TASK`，没有系统提示或工具定义里的每轮变化值。

**P5｜定时器必须独立于收件箱，调度器只写事件、不开运行。** 一手来源。
来源：Anthropic《Building always-on agents》<https://claude.com/resources/articles/building-always-on-agents>：
> “A follow-up is a deadline that the agent sets for itself… A schedule… is a recurring task that happens on a known cadence.”
> “Timers live in their own durable store, usually another database table, separate from the inbox.”
> “A timer doesn’t initiate a run on its own. Instead, a scheduler… adds an event to the inbox and wakes the worker.”

**P6｜文章要求记忆里有“已经告诉过用户什么”和“每个进行中任务的进度”。** 一手来源同上：
> “Past messages: The agent should keep track of what it’s already told the user so nothing is repeated.”
> “Task progress: For each ongoing task, the agent should keep a progress file that covers what’s been done and what’s left.”

**P7｜现有 `scheduled_jobs` 不适合直接当个人跟进/周期任务。** 已证实。
来源：`packages/application/src/ports/coordination.ts:88-111` 的 `ScheduledJob` 要求 `authorizationRef`、`taskScopeRef`、`capabilityRef`、`operation`、`resourceRef`、`sideEffect`、`estimatedCostMicros`、`minimumIntervalMs`；`scheduler-service.ts:82-105` 的 `grantAllowsJob` 要求 `kind === "long_term"` 的 grant、资源前缀、分类上限、费用上限、频率上限。表 `scheduled_jobs` 见 `0001_initial_product_schema.sql:311-322`。
结论：可以复用它的**纯时间计算** `evaluateDurableSchedule`（`durable-background-work-service.ts:172-294`，处理 daily/interval/one_shot、DST、misfire），但不复用它的授权/租约/occurrence 存储。

**P8｜邮件检查有自己的定时器和直接推送路径，必须收口。** 已证实。
来源：`production-proactive.ts:315-325`：`setInterval(() => void this.tick(), ...)`；`:406-422` 逐个跑来源。`production-web-push.ts:441-451` 把 `proactive.listReady()` 直接变成待推送项；`:835-854` 直接把邮件 insight 变成推送内容。

**P9｜推送已经有统一的出箱、闸门、送达时机和降频。** 已证实。
来源：`packages/application/src/ports/web-push.ts:5` 推送种类只有 `"reminder" | "approval" | "run"`；`production-web-push.ts:528-601` 的 `#deliver` 统一处理 `kinds`、`gate`、`visible`、`expiresAt`；`:651-713` 的 `#deferred` 走 `PushGate`；`:715-790` 走送达时机（ADR 0273）；ADR 0184 的降频已在同一出箱里。
结论：新来源不应各自调用发送器；只应产出提议或 insight，交给这个出箱。

**P10｜提醒工具目前只提醒主人，不能给 Himawari 自己定闹钟。** 已证实。
来源：`production-reminder-writer.ts:83-121` 只有 `reminder_set`、`reminder_list`、`reminder_cancel`；`:309-341` 新建的是主人提醒（memory/reminder），不是 agent 自己的跟进。

**P11｜提案箱对来源版本的长度限制比收件箱更严。** 已证实，且正是 I-73 那类跨模块契约。
来源：`think_inbox.sql:7`：
> `source_version TEXT NOT NULL CHECK (length(source_version) <= 256)`
`20261114151010_owner_proposals.sql:11`：
> `source_version TEXT CHECK (source_version IS NULL OR length(source_version) BETWEEN 1 AND 128)`
`packages/persistence-sqlite/src/data-export/schemas.ts:263-264`：
> `sourceRef: nullable(text(1, 256)), sourceVersion: nullable(text(1, 128))`
`production-think-actions.ts:25-29` 已经把提案侧的版本截到 128（超长转 `sha256:`）。
结论：来源产生的 `sourceVersion` 必须在源头就 ≤128；不能只靠提案层兜底，否则收件箱里是原文、提案里是哈希，追溯断掉。

**P12｜“新存下的记忆”有可用的提交点，“手机感知”目前只有计数没有 id。** 已证实/部分。
来源：`automatic-memory-service.ts:83` 的 `committedMemoryIds`，`:265` 返回；`production-memory-capture.ts:1387-1395` 在 `unitOfWork.run` 里调用 `service.processCommittedRun`，但没有把返回的 id 交给外部回调。
`perception-extraction.ts:454-465` 的 `PerceptionExtractionReport` 只有 `memories/tentative/proposals` 计数，没有 id。
结论：记忆来源可以在 capture commit 处加回调；感知来源需要新增带 id 的回调，不能从 report 反推。

**P13｜设置项有严格的三处契约：定义、配置解析、三语文案。** 已证实。
来源：`configuration.ts:417-441` 的 `THINK_SETTING_DEFINITIONS`；`strict-configuration.ts:1391-1407` 按 definitions 生成允许键并用 `rejectUnknown`；`production-think-settings.ts:26-134` 的 `THINK_SETTING_TEXT` 是 `Record<ThinkSettingKey, ...>`，缺一项编译不过。
结论：新增任何数量/间隔/上限都必须同时进这三处，不能写死。

---

## 2. 方案本身

### 2.1 总体结构

```
来源适配器（邮件/记忆/感知/跟进/周期）
        │  只调用 think.inbox.submit(sourceKind, sourceRef, sourceVersion, summary)
        ▼
   think_inbox（唯一入口，已有）
        │  Jev 判值不值得（follow_up / schedule 可配置为 always）
        ▼
   think run（新对话，只读工具，已有）
        │  最后一条 JSON：none / 提议动作 / 自己的 follow_up / 更新进度
        ├── 提议动作 → 提议箱 → 主人点头 → 执行
        ├── follow_up → think_timers（自己的定时器，不惊动主人）
        └── progress → think_timers.progress（下次醒来读）
        ▼
   ProductionWebPush（唯一出箱：提议/提醒/审批/运行结果）
        │  PushGate + 送达时机 + 降频
        ▼
   iPhone
```

关键分离：

- **入口决定“要不要想”**，不决定“要不要推”。
- **“想一想”运行决定“要不要提一个下一步”**，仍然只读。
- **提议箱决定“主人点不点头”**。
- **`ProductionWebPush` 决定“现在送不送”**。
- 新来源永远不直接调用发送器。

### 2.2 新增数据：一张薄定时器表，不新建服务

新增迁移 `think_timers`（名字可改），一行代表一个“进行中的承诺”：

| 列 | 用途 | 校验 |
|---|---|---|
| `id` | `timer:<uuid>`，也作 inbox 的 `sourceRef` | 1–128 |
| `owner_id/agent_id` | 单人仍按 scope | 外键 |
| `kind` | `follow_up` / `schedule` | CHECK |
| `status` | `active/paused/done/cancelled/expired` | CHECK |
| `task_ref` | 加密载荷，任务说明 | `payloads(ref) ON DELETE RESTRICT` |
| `progress_ref` | 加密载荷，上次做到哪 | 可空，RESTRICT |
| `origin_kind/origin_ref/origin_version` | 引起它的原始来源（邮件/记忆/感知/主人消息） | 长度同 inbox |
| `recurrence` | `once/daily/interval` | CHECK |
| `timezone` | daily 用，来自 `runPolicy.timeZone` | IANA |
| `hour/minute/interval_minutes` | daily/interval | 范围和最小值来自设置 |
| `next_run_at/last_run_at` | 调度 | ISO |
| `occurrence` | 第几次，作 inbox 的 `sourceVersion` | 非负整数 |
| `misfire_grace_ms` | 复用 `evaluateDurableSchedule` | 非负 |
| `expires_at` | 最晚何时失效 | ISO |
| `created_at/updated_at/revision` | 并发控制 | — |

**不把定时器放进 `think_inbox`**，理由就是 P5：收件箱只放“现在可以工作的事件”。

**不把 `task/progress` 放进 `think_inbox` 的摘要**：摘要条目结束就删（P3），进度要跨多次运行，必须独立且可更新。

### 2.3 来源登记

给 `ThinkSource` 增加两个字段（代码内固定，不写进模型）：

```ts
interface ThinkSource {
  kind: string;
  describe: string;
  externalContent: boolean;
  judgment: "worth" | "always";   // 新增
}
```

v0.3 登记的来源：

| kind | describe 示例 | externalContent | judgment |
|---|---|---|---|
| `mail` | “一封新邮件或已有邮件线程的新进展” | true | worth |
| `memory` | “刚刚存下的一条关于主人的记忆” | false | worth |
| `perception` | “手机感知到的一段事” | true | worth |
| `follow_up` | “Himawari 自己定的跟进到点了” | false | **always** |
| `schedule` | “主人要的周期任务到点了” | false（任务本身可能读外部） | **always** |

`follow_up`/`schedule` 用 `always` 的理由：这是 Himawari 自己或主人已经定下的承诺，不能再让第二个模型决定“值不值得履行”。这也避免“跟进被 Jev 判不想而永远不发生”。这是一个需要 Andy 拍板的点（见第 6 节）。

登记发生在 `createProductionHttpComposition` 创建 `think` 之后、`http.listen()` 启动 `think.loop` 之前。现在 `productionThinkLoop` 返回了 `{ inbox, worker, loop }`，但 `ProductionHttpComposition` 没有把 `think` 暴露出来；需要把 `think`（至少 `inbox`）加进返回对象，或在 `createProductionHttpComposition` 里接受 `thinkSources` 选项。两种都行，推荐前者，方便 `service-main` 在启动前注册。

### 2.4 来源适配器怎么写

**邮件（v0.3 第一步）**

- 保留 `ProductionProactive` 的邮件读取、线程阅读、规则、预算、背压（它已经做了很多正确的事）。
- 在“新 insight 已提交”的地方加一个 `onInsight` 回调（当前 `ProactiveDecision` 只有 counts 和 pushSourceKey，没有 insight id；`production-proactive.ts` 的 `onDecision` 不足以拿到每封邮件，见 `ProactiveDecision` 定义 `ports/proactive-checks.ts:57-69`）。回调拿到 `ProactiveInsight` 的 `lastMessageId`、`source`、`contentRef`、`decisionId`。
- 每封新 insight 调用一次：
  - `sourceKind: "mail"`
  - `sourceRef: "mail:" + sha256(accountRef + "\0" + lastMessageId).slice(0,32)`（避免 Message-ID 里的尖括号、超长、不可打印字符）
  - `sourceVersion: "mail:" + sha256(decisionId + "\0" + lastMessageId).slice(0,32)`（≤128；新进展产生新版本）
  - `summary`: insight 的 summary/subject/from，截到 `summaryCharacters`
  - `externalContent: true`
- **同一个 PR 里关掉邮件 insight 的直接推送**：不再把 `createProactivePushSource` 的邮件项交给 `ProductionWebPush`，或加一个开关 `mail.directPush=false`。邮件 insight 仍写页面/决策记录，但不再自己推。
- 这样“新邮件”只经 inbox → think run → 提议 → 出箱。反向用例：同一封邮件重复检查，`sourceVersion` 相同，inbox 去重，不产生第二个运行/推送。

**记忆（v0.3 第四步）**

- 在 `production-memory-capture.ts:1387-1395` 捕获 `processCommittedRun` 的返回，取出 `committedMemoryIds`，逐条调用 `submit`。
- `sourceKind: "memory"`；`sourceRef: "memory:" + memoryId`；`sourceVersion: "memory:" + generationId + ":" + memoryId`（≤128）；`summary` 用记忆正文截断；`externalContent: false`。
- 只对 `auto_committed` / `approval_committed` 这类真正写入的候选提交；`tentative_kept`、`approval_requested` 可配置是否提交，避免噪音。
- 反向：记忆提取返回 `nothing_to_remember` / 被拒 → 不提交。

**手机感知（v0.3 第四步，可延后到 v0.3 末）**

- 在 `PerceptionExtractionService` 的提交点加一个 `onCommitted` 回调，带新记忆 id 和已接收的 proposal id；现在的 `PerceptionExtractionReport` 只有计数，不够（P12）。
- `sourceKind: "perception"`；`sourceRef: "perception:" + recordId`；`sourceVersion` 用 record 的 `updatedAt` 或提取 generation；`externalContent: true`。
- 反向：感知暂停 / 没有新 episode / 提取丢弃 → 不提交。

**跟进（v0.3 第二步）**

- 不新增写工具。给“想一想”的最终 JSON 加一个动作 `follow_up`，由 runner 在运行之外写 `think_timers`，不是模型工具。这样运行仍然只有只读工具（ADR 0274 决定 6）。
- 字段固定：
  - `delayMinutes`: 正整数，范围来自设置（例如 1 分钟到 30 天，默认上限可配）。
  - `task`: 下次醒来要做什么，≤ 设置的长度。
  - `reason`: 为什么定这个跟进，≤500。
  - `progress`: 可选，本次做到哪，≤ 设置的进度长度。
- runner 校验：字段只能有这些；`delayMinutes` 在范围内；`task` 非空；然后写一条 `kind=follow_up`、`recurrence=once`、`next_run_at = now + delayMinutes`、`origin_*` 指向当前 inbox 条目原始来源的定时器。返回 `resultRef = timerId`，inbox 条目标成 `scheduled`（或复用 `proposed` + reason `follow_up_set`；见 2.9）。
- 反向：`delayMinutes` 超范围 / 多给字段 → 拒绝；同一个 inbox 条目重试不会写第二条（按 entry id + occurrence 幂等）。

**周期任务（v0.3 第三步）**

- 主人只有在对话里说“每晚查天气”时，才需要新工具。推荐新增一个**只创建提议**的工具 `schedule_create`（`actionKind: CREATE_OR_UPDATE`，`reversible: true`），它不直接写定时器，而是写提议箱。主人点头后，handler 写 `think_timers`。
- 字段：`kind: "daily" | "interval"`、`hour/minute`（daily，主人当地时间）或 `intervalMinutes`（interval）、`task`、`reason`。时区不从模型来，固定用 `runPolicy.timeZone`。
- 提议 type 用 `schedule.create`，proposalId 前缀用 `schedule-create`（匹配 `production-proposals.ts:25` 的 `^[a-z][a-z0-9-]{0,31}:[0-9a-f]{32}$`）。
- 这个工具会改变**新对话**的工具定义。已有对话若继续运行，工具集合检查可能触发一次换新（ADR 0165 允许的例外）；之后稳定。如实回答见必答问题 1。
- 反向：主人拒绝 → 不写定时器；取消/暂停 → 到点不提交；`intervalMinutes` 小于设置下限 → 拒绝。

### 2.5 调度器（薄）

新增 `ProductionThinkTimerLoop`，和 `ThinkLoop` 并列，在 `http.listen()` 里启动：

- 每 `timerIntervalSeconds`（设置，默认 30–60 秒，不能写死）扫一次 `listDue(now, limit)`，按 `next_run_at, id` 排序。
- 对每条：
  1. 用 `evaluateDurableSchedule`（复用 `durable-background-work-service.ts:172-294`）判断 `future/due/skipped/missed`。
  2. 先 `inbox.submit`（sourceKind=`follow_up`/`schedule`，sourceRef=`timer.id`，sourceVersion=`String(occurrence)`，summary=task + progress 摘要，externalContent=false）。
  3. `submit` 成功后，再推进定时器：follow_up → `done`；schedule → `next_run_at = nextAt`、`occurrence += 1 + skippedCount`、`last_run_at = scheduledAt`。
  4. 如果 `submit` 因队列满/日限被拒：**不推进**，下一个 tick 再试；记录 `think.timer_delayed`。这样不会丢。
- 失败/崩溃语义：如果 submit 成功但推进前崩溃，下一 tick 再次 submit，`sourceVersion` 相同 → inbox 去重返回 duplicate，再推进。最多 at-least-once，入口去重保证不重复运行。
- follow_up 的 `missed`：按“晚到也要做一次”处理（把 missed 当 due），因为这是她对主人的承诺；schedule 的 missed：按 `evaluateDurableSchedule` 合并/跳过，避免一次醒来补一堆。
- 不打开运行，只写收件箱。验收要看“worker 没启动时，定时器到点只产生 queued 行，没有 run”。

### 2.6 进度和“已经告诉过主人什么”

- **进度**：`think_timers.progress_ref`。每次 think run 的第一条消息末尾追加：
  ```
  【上次做到哪】<progress>
  【这件事最初是什么】<origin summary>
  ```
  模型最终 JSON 可带 `progress`，runner 写回 `progress_ref`（加密载荷）。这样下一次醒来读得到。
- **已告知**：不新建 outbox。直接用现有 `WebPushStorePort.listFeedback({sentFrom, limit})`（`ports/web-push.ts:177-179`）取最近实际发出的推送，按 `firstSentAt, sourceKey` 排序，取前 N 条，拼成：
  ```
  【最近已经告诉过主人的事】<时间> <kind> <摘要>
  ```
  再加最近已处理的提议摘要（提议箱的 `summary`）。这些都只放在**新 think 对话的最后一条消息**里，不动任何已有对话。
- v0.3 不新增“读已告知”的模型工具。理由：工具定义会进入请求头，新增工具会影响新对话的工具集合；而“想一想”是全新对话，直接把摘要放在最后一条消息已经满足需求。以后若普通对话也需要，再单独评估工具集合换新。

### 2.7 追溯：一次开口或沉默都能回到来源

- 新增一个网关查询 `think.activity.list`（`ProductionThinkControl` 旁边），读 `think_inbox` 的历史行：`id, sourceKind, sourceRef, sourceVersion, status, reasonCode, resultRef, createdAt, updatedAt`。
- 给 `think_inbox` 加一列 `result_ref`（可空，≤256）：提议 → proposalId；`follow_up`/`schedule` → timerId；skipped → null + reasonCode。
- 提议本身已有 `sourceRef/sourceVersion`（`production-proposals.ts:408-409`），再在 evidence 的 `basis` 里保留 `think_source`（`production-think-actions.ts:68`）。这样链是：inbox 条目 → 提议 → 推送出箱 → 尝试。
- 推送的 `navigate` 带 `proposal` 或 `think` 的 id，点击回到这条 activity；id 必须 URL 编码，客户端 route 要接受 `PROPOSAL_ID_PATTERN` 和 `think:<32hex>` 的格式。反向：伪造一个超长/带斜杠的 id，服务端查询拒绝，客户端不崩。
- 摘要载荷在条目结束后仍会删（P3）。追溯靠 `sourceRef` 回到邮件/记忆/感知记录；如果源记录已删除，显示“来源已删除”，不保留正文。若 Andy 要求“事后还能看到当时那句摘要”，需要另加一个短展示摘要列并定保留期——这是取舍（见第 6 节）。

### 2.8 推送纪律

- 迁移过来的来源**不再直接推送**。所有开口只经提议箱 → `ProductionWebPush`。
- `ProductionWebPush` 已经只会每轮推“最新一条提议”（`production-web-push.ts:452-466`），不会一次推一堆。
- 新增设置（全部可改）：
  - `maxProposalsPerDay`（提议箱/think 出口的每日上限）
  - `followUpMaxDelayDays`、`followUpMinDelayMinutes`
  - `scheduleMinIntervalMinutes`、`scheduleMaxLifetimeDays`、`scheduleMaxOccurrences`
  - `timerIntervalSeconds`
  - `toldWindowHours`、`toldLimit`
  - `progressCharacters`
  - `timerQueueReserve`（给定时器事件预留的队列槽，避免邮件洪水把跟进挤掉）
- “先安静再赢得注意”：默认 `maxProposalsPerDay` 取小值，`follow_up`/`schedule` 不走 Jev 但仍受每日提议上限；`PushGate`、送达时机、ADR 0184 降频继续生效。
- 不新增推送 kind。提议继续用 `reminder`，审批用 `approval`，运行结果用 `run`（P9）。加 kind 会同时影响 DB、客户端和设置页，v0.3 不做。

### 2.9 状态与值

- `ThinkInboxStatus` 增加 `scheduled`（follow_up/schedule 已写入定时器）。表 `think_inbox.status` 只校验长度，不用迁移；但 `sqlite-think-inbox-operations.ts:258-273` 的 `finish` 白名单要加，`StoredThinkEntry` 类型和 UI 要加。
- 或者不加状态，复用 `proposed` + reason `follow_up_set`/`schedule_set`。我倾向加 `scheduled`，因为“沉默地定了自己的下一步”和“向主人提了提议”是两种不同的结果，追溯时要分得清。

---

## 3. v0.3 分步顺序与 iPhone 真机验收

每一步都给出“该触发”的正向和“不该触发”的反向；反向用例必须在去掉对应守卫时失败。

### 第 1 步：入口 + 邮件来源 + 追溯（最先做）

**做什么**
- `createProductionHttpComposition` 返回 `think`（或接受 `thinkSources`），在 `http.listen()` 前注册 `mail` 来源。
- 在邮件 insight 提交处加 `onInsight`，逐条 `submit`。
- 同一 PR 关掉邮件 insight 的直接推送。
- 加 `think_inbox.result_ref`、`think.activity.list` 查询、推送 deep link。

**iPhone 验收**
- 正向：用测试邮箱发一封“退款需要你确认”的邮件；邮件检查认为重要后，iPhone 只收到**一条**通知/提议；点开能追到那封邮件的 `sourceRef`，activity 显示 `proposed` 和 proposal id。
- 反向：发一封广告/已经处理完的邮件；iPhone **不收到**通知，activity 显示 `skipped`（或邮件检查根本没有提交），原因码可读。

**自动检查**
- 端到端：真实 SQLite + 假模型，邮件 insight → inbox → think run → 提议；断言只产生一条推送。
- 反向：同一封邮件检查两次 → 第二次 inbox `duplicate`，没有第二个运行/推送；去掉 `UNIQUE` 或版本去重后该用例失败。

### 第 2 步：自己的跟进 + 进度 + 已告知摘要（v0.3 核心）

**做什么**
- 新增 `think_timers` 迁移、`ThinkTimersStorePort`、SQLite 操作、`ProductionThinkTimerLoop`。
- 复用 `evaluateDurableSchedule`。
- `follow_up` JSON 动作；`progress` 字段；`told` 摘要从 `listFeedback` 来。
- `follow_up`/`schedule` 来源 `judgment: always`。
- 加 `timerQueueReserve`，定时器事件在队列满时保留槽位或重试。

**iPhone 验收**
- 正向：用设置把跟进最小/测试延迟改成 3 分钟；制造一封“退款已承诺、3 天没收到收据”的邮件；activity 里出现 `scheduled` 和 timer；3 分钟后 iPhone 收到一条跟进结果（提议或提醒），timer 变成 `done`。
- 反向：同一封邮件再检查一次 → 不产生第二个 timer；把收据邮件先放进线程让模型判断已办结 → 不产生 follow-up，iPhone 无通知。

**自动检查**
- 定时器到点只写 inbox、不开运行：worker 不启动时，`think_inbox` 出现 queued、`think_timers` 已推进，`runs` 没有新行。
- 反向：队列满时不推进 timer；去掉“先 submit 后推进”后，该用例失败（timer 推进了但没有 inbox 行）。
- 重复到点：同一 `occurrence` 连续两次 fire → 只有一个 inbox 条目。
- 进度：第一次 run 写 `progress`，第二次 run 的第一条消息包含上次进度；去掉写回后用例失败。

### 第 3 步：主人要的周期任务

**做什么**
- 新增 `schedule_create` 提议工具（普通对话可用）和 handler；写 `think_timers` 的 `schedule`。
- 新增 `think.schedules.list` / `think.schedules.cancel` / `think.schedules.pause` 查询/命令。
- 工具集合变更按 ADR 0165 记录一次换新。

**iPhone 验收**
- 正向：在对话里说“每晚 21:00 查明天天气，需要带伞就提醒我”；收到提议，点同意；把 21:00 临时改到几分钟后；到点后 iPhone 收到结果/提议，下一次 `next_run_at` 前进一天。
- 反向：同样的请求，点拒绝 → 没有 timer、没有到点运行；或创建后暂停/取消 → 到点不运行、不推送。

**自动检查**
- 提议 ID 匹配 `PROPOSAL_ID_PATTERN`；同意后写 timer；拒绝后不写。
- daily 跨 DST 的 `evaluateDurableSchedule` 测试（若已有，复用；没有就补）。
- 反向：interval 小于设置下限 → 提议/命令被拒。

### 第 4 步：记忆 + 手机感知来源

**做什么**
- 记忆 capture commit 回调提交新记忆 id。
- 感知提取加 `onCommitted` 回调提交记录 id。
- 两个来源的每日上限、是否提交 tentative/approval 的开关。

**iPhone 验收**
- 正向：在对话里让 Himawari 记住一条新偏好；activity 出现 `memory` 条目，若模型认为值得则出现提议；手机感知产生一条新记录时同理。
- 反向：暂停记忆捕获 / 没有新感知 episode → 不出现新条目；一条明显无价值的记录被 Jev 判 `worth_no` → 不推送，activity 显示 skipped。

**自动检查**
- 捕获返回 `committedMemoryIds` 的桩 → 每条只提交一次；重复 generation 不重复。
- 反向：`nothing_to_remember` → 不提交；去掉判断后用例失败。

### 第 5 步：推送纪律、设置、追溯硬化

**做什么**
- 所有迁移来源关闭直接推送；只保留提议出箱。
- 新增设置项全部进 definitions、配置解析、三语文案、设置页。
- `maxProposalsPerDay`、`timerQueueReserve`、`toldWindowHours` 等生效。
- `think.activity.list` 增加分页、按状态筛选、来源解析。
- 补 egress、prompt-catalog、I-73 契约测试。

**iPhone 验收**
- 正向：把某来源关掉或把 `maxProposalsPerDay` 调到 0；该来源的事件仍进 activity，但 iPhone 不推送；把上限调回来，下一条推送恢复。
- 反向：审批推送不受静默/降频影响，仍然到达（ADR 0273 的保护类）；把审批也错误地延后时，测试必须失败。

**自动检查**
- 每个设置键在三种语言都有文案；配置解析拒绝未知键和越界值。
- 跨模块契约测试：每个登记来源用最大长度 fixture 走 `submit → entry → proposal → owner_proposals → export schema → web_push sourceKey`，两端都接受；反向：`sourceVersion=129` 必须被拒。

### v0.3 不做

- 不接入 `scheduler-service` / `durable-background-work-service` / `scheduled_jobs` 的 grant/lease 体系。
- 不接入 `attention-policy-service`（ADR 0014）。现有 `PushGate` + 送达时机 + 降频已经是运行中的统一推送层；再加一层会两处判断。
- 不做多人、并行 worker、多个调度器。
- 不让 think run 续用同一对话（v0.3 用新对话 + 进度文件）。续用会拉长对话、增加压缩和前缀风险；等进度文件证明不够再评估。
- 不给 think run 任何写工具；所有写都通过 JSON 动作/提议箱。
- 不导出 `think_inbox` / `think_timers`（临时队列/运行状态）；导出提议、提醒、记忆即可。若 Andy 要把“跟进承诺”当作用户资产，再单独决定。
- 不做已同意 `task.run` 的跨运行进度（v0.4）。
- 不做 `decision_ledger` 的 `think` kind 和完整校准指标（v0.4；v0.3 先用 activity 追溯）。

---

## 4. 考虑过但不选的做法

1. **直接复用 `scheduled_jobs` + `SchedulerService`。**
   不选：`ScheduledJob` 需要授权引用、task scope、capability、operation、资源、费用、频率上限，`grantAllowsJob` 还要求 `long_term` grant；个人跟进不需要这些，硬套会把“自己定个 3 天后再看”变成一次授权工程。只复用纯函数 `evaluateDurableSchedule`。

2. **每个来源自己决定推不推。**
   不选：P8/P9 已经证明邮件来源现在就这样。来源只 submit，推送统一到 `ProductionWebPush`。

3. **给 think run 写工具，让它自己写定时器。**
   不选：违反“后台运行只有只读工具”。用 JSON 动作在 runner 侧写，模型看不到写工具。

4. **follow-up 也走提议箱等主人点头。**
   不选（但这是要 Andy 拍板的取舍）：这与“主人不在时自己回头跟进”直接冲突；跟进是内部、可撤销、不碰主人世界。若坚持所有写都点头，则必须给“自己的跟进”一条预授权硬规则，否则目标无法成立。

5. **新增第二张 outbox / 新的推送种类。**
   不选：现有 `ProductionWebPush` 已经有 kinds、闸门、送达时机、降频；新增 kind 会同时改 DB、客户端、设置。

6. **把进度塞进 `think_inbox.summary`。**
   不选：条目结束摘要就删；进度要跨多次运行。独立 `task_ref/progress_ref`。

7. **续用同一个 think 对话做跟进。**
   不选（v0.3）：对话会越来越长，触发压缩和前缀变化；进度文件更符合 P6，也更容易在 retention 删除后恢复。

8. **用 `TaskProgress` 文件系统/对象存储。**
   不选：单人 SQLite 单写，加密载荷表已经存在；多一层存储没有收益。

---

## 5. 风险和反例

- **跟进被 Jev 吞掉。** 若 `judgment` 不设为 always，模型可能判“不值得想”，承诺永远不发生。缓解：定时器来源 always；反向测试：去掉 always 后该用例失败。
- **重复通知。** 邮件 insight 直接推 + think 提议推，会响两次。缓解：同一 PR 关闭直接推送；集成测试断言一个来源事件最多一条推送。
- **think run 没有 Gmail 读取工具。** 它只能看摘要，可能漏掉线程里的关键细节。缓解：邮件来源摘要必须包含关键事实；v0.4 再评估只读 `mail_read` 工具。**未核实**：是否值得为 v0.3 加这个工具，需要看真实邮件评测。
- **队列满导致定时器延迟。** 缓解：submit 成功才推进 + `timerQueueReserve` + 重试；activity 显示 `timer_delayed`。反例：邮件洪水 50 条/天时，跟进可能被推迟。
- **SQLite 写竞争。** 一个调度器 + 一个 think worker，短事务；默认 30–60 秒扫描。**推测**：4 核 8GB 足够，但没有实测。
- **`sourceVersion` 256 vs 128。** 这是 I-73 的同类陷阱。若来源传 200 字符版本，inbox 收下，但提议/导出只接受 128，提案层会哈希掉，追溯断。缓解：源头 ≤128；跨模块测试拒绝 129。
- **`sourceRef` 超 256。** inbox 在 `submit` 就拒，`think-actions` 的 `bounded` 来不及救。缓解：来源适配器先哈希邮箱 Message-ID；测试超长 ref。
- **摘要/进度的遮盖不确定。** 若把相对时间、`Set` 遍历、每次重新生成的摘要放进模型消息，同一事件重试会变成不同字节。缓解：摘要只生成一次并加密存储；列表排序；重试复用已存的消息载荷；`now` 只出现在最后一条消息。
- **追溯在源记录删除后断掉。** `think_inbox` 结束删摘要，只剩 sourceRef；邮件/记忆删除后只能显示“来源已删除”。取舍：是否保留短摘要。
- **工具集合变更。** `schedule_create` 会改变新对话工具定义；已有对话可能在下一轮开始时按 ADR 0165 换新一次。缓解：发布说明 + 测试；若不能接受，周期任务只能由设置页创建。
- **Prompt injection。** 邮件/感知是外部内容；think run 已标 `externalContent`，`refuseBackgroundAfterExternalContent` 会拒绝非 READ 动作（`action-rules.ts:244-275`）。但模型仍可能把私人内容放进搜索词。沿用 ADR 0274 的出口遮盖和搜索上限；评测要保留。

---

## 6. 需要 Andy 拍板的取舍

1. **跟进要不要主人点头？** 我建议自己定、不经提议箱（内部、可撤销、可取消、可见）；若坚持“所有写都点头”，需要一条“允许自己定跟进”的硬规则，否则“主人不在时自己回头”不成立。
2. **跟进/周期任务要不要过 Jev 的“值不值得”？** 我建议 `always`，不把承诺交给第二个模型；若坚持过 Jev，必须有“承诺类事件永远 worth”的硬规则。
3. **周期任务入口。** 我建议加 `schedule_create` 工具（对话里说就能建提议），接受一次工具集合换新；若完全不想动工具头，则只能在设置页手动建。
4. **定时器存储。** 我建议新 `think_timers` + 复用纯 `evaluateDurableSchedule`；复用 `scheduled_jobs` 的授权体系不划算。
5. **“已告知”给模型的方式。** 我建议 v0.3 预加载摘要到新 think 对话的最后一条消息，不加工具；若希望普通对话也能查，再加只读工具。
6. **追溯保留多久。** activity 保留 `threadRetentionDays` 还是单独设置？摘要载荷结束就删，是否保留短展示文本？
7. **默认安静预算。** `maxProposalsPerDay`、各来源每日上限、跟进最大延迟、定时器扫描间隔的默认值，需要 Andy 定；方案里只给范围和默认建议，不写死。
8. **是否把 timer/progress 纳入数据导出。** 我建议 v0.3 不纳入（运行状态）；若视为用户资产则要进导出格式。

---

## 7. 已证实 vs 推测

**读代码/一手来源证实**
- 入口表和 worker 已有；loop 已启动；没有任何来源 submit/register（P2）。
- 收件箱的 `UNIQUE`、长度、摘要载荷、状态、每 worker 一条（P3）。
- think run 是新对话、单条消息、动作列表排序、external_event、只读（P4）。
- 定时器应独立于收件箱、调度器只写事件（P5）。
- 文章要求“已告知”和“任务进度”（P6）。
- `scheduled_jobs`/`SchedulerService` 绑定 grant/authority（P7）。
- 邮件有独立定时器和直接推送（P8）。
- 推送出箱统一，kinds 固定（P9）。
- 提醒工具只提醒主人（P10）。
- `sourceVersion` 在 inbox ≤256、在 proposal/export ≤128（P11）。
- 记忆 commit 返回 `committedMemoryIds`；感知 report 没有 id（P12）。
- 设置项的三处契约（P13）。

**推测/未核实**
- 4 核 8GB 上“一个 think worker + 一个 timer loop”的吞吐和延迟，没有实测。
- 邮件 insight 提交点的具体代码位置和 `onInsight` 的改法，需要读 `proactive-mail-check-service.ts` 的提交段确认；`ProactiveDecision` 没有 insight id 是已证实的，最小改动点未核实。
- 感知提取加 `onCommitted` 的具体位置，需要读 `perception-extraction.ts` 的 649–656、859、902 附近；方向已证实（report 只有计数）。
- iPhone 客户端的 deep link route 和“activity”页面不存在；本仓库只做服务端查询，客户端批次另做。
- `schedule_create` 工具导致已有对话换新的实际频率，取决于 `freezeThreadPrompts` 配置和活跃对话数量；未实测。
- 成本估计（Jev 每次约 $0.0001、think run 每次 $0.005–0.01）沿用 ADR 0274，未重新评估。

---

## 8. 逐条回答必答问题

### 必答 1：会不会改变模型已经见过的请求开头？

**对已有对话：不改。**
新邮件、新记忆、感知、跟进、周期任务都只做两件事：
- 往 `think_inbox` 写一行，开一个**全新** think 对话（P4）；
- 或让普通对话在末尾多一条工具结果/消息（例如以后如果要暴露“已告知”工具）。

这些都不编辑系统提示、工具定义、历史消息或遮盖结果。think 对话只有一条消息，所有会变的值（当前时间、进度、已告知摘要、来源摘要）都在**这一条最后消息**里。依据：`prompt-prefix.md:28`、`:36`。

**唯一例外是工具集合。** 如果 v0.3 选择加 `schedule_create` 工具，新对话的工具定义会多一个工具；已有冻结对话要么保持旧工具集（不改开头），要么在下一轮开始时按 ADR 0165 换新一次（一次性）。这是规则明确允许的“工具集合变了”例外，不是每轮变化。若 Andy 不接受这个例外，周期任务只能从设置页建，或由 think run 的 JSON 动作建。

**结论：** 发给模型的内容仍然“只在末尾追加”；每轮会变的值只在新追加的最后一条消息里。已有对话的系统提示、工具、历史、遮盖字节不变（除非选择工具集合换新，那是一次性的、有记录的例外）。

### 必答 2：会不会让同一段文字在不同请求里变成不同的字节？

**默认不会，但有四个必须守住的点：**

1. **摘要只生成一次。** 来源在 `submit` 前生成 summary 并加密存储；Jev 和 think run 都读同一份。重试不得用 `now` 重新生成摘要。现有 `production-think-inbox.ts:198-235` 已经是“先写载荷再入队”，沿用。
2. **列表/集合固定顺序。** 动作清单已排序（`production-think-runner.ts:77`、`:95`）；来源清单、进度条目、已告知条目都要显式排序（时间 + id），不能依赖 `Set`/`Map`/数据库返回顺序。规则第 10 条要求同样的内容每次序列化成同样的字节（`prompt-prefix.md:53`）。
3. **时间只在最后一条消息，且只属于那次运行。** 当前时间、相对时间、进度摘要只进最后一条用户消息；系统提示和工具定义里不放时间、路径、版本、额度（规则第 2 条）。think 对话是新的，所以没有跨轮前缀问题。
4. **遮盖确定。** 出口遮盖只取决于当前文本和它前面的内容（规则第 11 条）；不要把后面的消息纳入遮盖，也不要让占位符序号依赖无序集合。Jev 输入已走 `redactForExternalText`（`think-worth-decision.ts:12`、`:46-47`）。

**反例：** 如果实现时把 `Date.now()`、`Intl` 的“几分钟前”、`new Set()` 遍历或每次新生成的摘要放进消息，同一事件重试会变成不同字节。测试要专门构造“同一 sourceVersion 重试两次”，断言除最后一条新消息外字节相同；在代码里故意注入一个时间字段，测试必须失败。

### 必答 3：改动有没有自动检查，反向用例真的会失败？

有，分三层：

**已有、必须继续通过**
- `npm run check:prompt-prefix`（`[I-66]`、`[iOS-5]`）：真实 Pi 适配器 + 真实出口遮盖，多轮逐字节比较；反向用例包括改写历史、系统提示带变化值、关掉冻结、请求中间出现 system 消息（`.agents/instructions/prompt-prefix.md:76`）。新变化只加“新 think 对话的最后一条消息里有时间/进度”，不改已有对话；如果实现把时间放进系统提示，这条检查会失败。
- `check:egress-redaction`：新对外发文字的文件必须登记并调用 `redactForExternalText(`。
- `prompt-catalog.unit.test.ts`：新提示词必须有 manifest 和摘要。
- `prompt-catalog` 的设置文案测试：每个设置键三语齐全。

**新增、必须带反向用例**
- 入口契约：每个登记的 `sourceKind` 都能通过 `KIND` 正则、`think_inbox` 长度；`sourceVersion` ≤128；`sourceRef` ≤256。反向：注册 `Mail-Source`（大写/连字符）、`sourceVersion` 129 字符、`sourceRef` 257 字符 → 必须被拒。
- 去重：同一 `(kind, ref, version)` 提交两次 → 第二次 `duplicate`，不新增运行/推送。反向：去掉 UNIQUE 或把 version 换成时间戳 → 用例失败。
- 定时器：到点只写 inbox、不开运行；submit 失败不推进；崩溃后重试不重复运行；follow_up 不会在自己没到点时触发；schedule 的下一次时间正确。反向：把“先 submit 后推进”改成“先推进后 submit”，队列满用例失败；把 `judgment: always` 去掉，跟进被 Jev 吞掉的用例失败。
- 追溯：一个 `skipped` 和一个 `scheduled` 都能从 activity 找到 sourceRef/resultRef。反向：写入一个未知 sourceKind 的 activity 行，查询必须拒绝或标记 unknown。
- 推送：一个来源事件最多一条推送；邮件直接推送关闭后，只有提议推送。反向：重新打开直接推送，集成测试断言出现两条 → 失败。
- 工具集合：如果加 `schedule_create`，新对话包含它、下一轮字节不变；反向：在对话中途替换工具集，`check:prompt-prefix` 必须报告断裂或记录换新。
- 设置：未知键、越界值被拒；每个键三语齐全。反向：新增一个只有定义没有文案的键，编译/测试失败。

**iPhone 真机**
上面第 3 节每一步都有正向/反向。真机验收不能替代自动检查，但必须真做一次，因为“通知到没到、点了能不能追溯”只有真机知道。

### 必答 4：每个新值，产生它的地方和使用它的地方都能接受吗？

下面逐个核对。重点是 I-73 的教训：只看改动不够，要看生产端和消费端的校验。

| 值 | 产生处 | 使用处 | 两端校验 | 守着的检查 |
|---|---|---|---|---|
| `sourceKind`（`mail/memory/perception/follow_up/schedule`） | 来源登记 + `submit` | `think_inbox.source_kind`（1–64）、`sources.get`、`think-actions` 的 `kind:ref` | `KIND=/^[a-z][a-z0-9_]{0,63}$/` 比 DB 更严；DB 只限长度 | 来源契约测试逐个 submit |
| `sourceRef` | 来源适配器 | inbox（1–256）、`entryKey`、`think-actions.bounded(256)`、`owner_proposals.source_ref`（1–256）、export（1–256） | inbox 在 `submit` 就拒 >256；`think-actions` 只处理 `kind:ref` 组合超长 | 超长/带斜杠/尖括号 fixture；邮箱 Message-ID 先哈希 |
| `sourceVersion` | 来源适配器 | inbox（≤256）、去重键、`think-actions.bounded(128)`、`owner_proposals.source_version`（1–128）、export（1–128） | **不一致**：inbox 256，proposal/export 128；必须源头 ≤128 | 129 字符反向用例；跨模块 submit→proposal→export |
| `summary` | 来源适配器 | `clip` 到 `summaryCharacters`（100–4000）、加密 payload、Jev 输入、think 消息 | 非空；长度由设置；出口遮盖 | 空摘要拒收；遮盖登记；三语设置文案 |
| `think entry id`（`think:<32hex>`） | `entryKey` | `think_inbox.id`（1–128）、thread/message/run/session id、`sourceProofRef` | 38 字符，远小于 128；machine string 允许 `:` | id 格式测试 |
| `resultRef`（新增） | worker/runner | `think_inbox.result_ref`（≤256）、activity 查询、推送 deep link | 提议 id 匹配 `PROPOSAL_ID_PATTERN`；timer id `timer:<uuid>` | 查询校验；URL 编码测试 |
| timer `id`/`occurrence` | timer 写入 | inbox 的 `sourceRef`/`sourceVersion`、去重 | id 1–128；occurrence 非负；版本 = 十进制字符串 | 定时器集成测试 |
| `next_run_at`/`last_run_at`/`expires_at` | `evaluateDurableSchedule` + timer store | scheduler、activity、设置页 | canonical ISO；DB CHECK | 定时器测试 + DST |
| `delayMinutes`/`intervalMinutes`/`hour`/`minute` | 模型 JSON | runner/handler、timer store | 设置的范围；daily 0–23/0–59；interval ≥ 设置下限 | 越界反向用例 |
| `progress`/`task` 文本 | 模型 JSON / 来源 | 加密 payload、timer `task_ref/progress_ref`、下次消息 | 长度设置；payload 外键 RESTRICT；分类 | 长度/删除保护测试 |
| 设置键（`maxProposalsPerDay` 等） | `THINK_SETTING_DEFINITIONS` | `ThinkInboxConfiguration`、`strict-configuration.parseThinkInbox`、`THINK_SETTING_TEXT`、UI `think.settings.change` | 三处必须同时有；`rejectUnknown`；min/max；三语 | 编译期 Record + 设置契约测试 |
| 提议 type/proposalId（`schedule.create` / `schedule-create:<32hex>`） | `schedule_create` handler | `ProductionProposalBox.propose`、`PROPOSAL_ID_PATTERN`、handler registry、客户端 | 前缀 ≤32、小写/数字/连字符，后 32 hex | 提议 ID 测试 + 同意/拒绝集成 |
| 推送 `sourceKey`/`sourceRef` | 提议箱/出箱 | `web_push`（source_key/source_ref 1–256）、`webPushTopic`（哈希）、attempts、deep link | sourceKey 由常量 + id 生成；sourceRef = proposalId；topic 哈希 | 推送集成测试 + URL 编码 |
| `judgment: "worth"|"always"` | 来源登记（代码） | worker `#decide` | 只接受两个值；always 跳过 Jev | 反向：去掉 always 后跟进用例失败 |

**特别指出的 I-73 类问题**：`think_inbox.source_version` 允许 256，但 `owner_proposals.source_version` 和导出 schema 只允许 128。生产端（来源适配器）必须自己限制到 128，不能依赖 `think-actions` 的 `bounded`，因为收件箱会先收下 200 字符的版本；随后提案层把它哈希，追溯就断了。这正是“双模型复核只看了改动，没问清单里的 id 能通过后端校验吗”的同类问题。

---

## 9. 一句话总结

v0.3 不要把“常驻 agent”做成一套新框架；把已有的 `think_inbox` 变成唯一入口，把定时器做成一张薄表 + 复用纯时间函数，把进度和“已经告诉过主人什么”放进新 think 对话的最后一条消息，把所有开口交给现有推送出箱。先接邮件、打通追溯，再做自己的跟进，再做周期任务，最后接记忆/感知并收紧安静预算。
