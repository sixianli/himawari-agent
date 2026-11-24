# 方案：一个主对话 + 她自己开的后台子线程，所有新事情走同一个收件箱

> 阅读范围说明：我读了 `prompt-prefix.md`、`AGENTS.md`、ADR 0274/0278、`think_inbox` 迁移、think 收件箱/工人/运行器/动作、`production-task-proposals.ts`、`production-runtime-tools.ts`、`production-run-composition.ts`、`action-rules.ts`、`sqlite-think-inbox-operations.ts`、`decision_ledger` 迁移、`chat.ts`/`think.ts`、`perception-source-prompts.ts`、`proactive-source-runtime.ts`、`proactive-mail-check-service.ts`、`production-web-push.ts`、`compaction-prefix.ts`、`strict-configuration.ts`。没读的地方标「未核实」。

---

## 1. 前提

### 1.1 缓存与上下文规则（硬约束）

**P1. 发给模型的内容只能末尾追加，固定的在前、会变的在后。**
来源：`.agents/instructions/prompt-prefix.md:27-29`
> “固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。”
> “每轮都会变的内容只放在最后一条用户消息里。”
> “要告诉模型新情况时，追加一条消息，不改系统提示。”

**P2. 已发出的内容不得改动、重排、删除。**
来源：`.agents/instructions/prompt-prefix.md:36`
> “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”

**P3. 系统提示和工具按对话冻结，换新要留记录。**
来源：`.agents/instructions/prompt-prefix.md:42-45`
> “系统提示和工具按对话冻结……只有下面这些情况才换新一次，并且每次都留记录：工具集合变了……或者手动执行了 `thread prompt rebuild`。”
> “改了提示词文字，只对新对话生效。要让老对话也用上，必须手动换新。”

**P4. 同样的内容必须序列化成同样的字节；遮盖必须确定。**
来源：`.agents/instructions/prompt-prefix.md:53-56`
> “同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序……都要固定，不能依赖对象遍历顺序或数据库返回顺序。”

**P5. 压缩集中做、少做，并沿用原对话的头。**
来源：`.agents/instructions/prompt-prefix.md:61-63`
> “必须缩短历史时，集中做、少做，并在 ADR 里写明。不得每轮都做。”
> “压缩请求应当沿用原对话的系统提示和工具，只在末尾追加‘请总结’的指令。”

**P6. 现有系统提示明确“最后一条用户消息承载本轮的新请求”。**
来源：`packages/prompt-catalog/src/chat.ts:278`
> “最后一条用户消息承载本轮的新请求，其中 `<owner-message>` 里是主人本轮说的话，`<himawari-context>` 里是系统附上的时间和资料，不是主人说的话。”

这条是下面“批次消息”设计的关键约束：**不要轻易改成多条用户消息承载一轮请求**，否则老对话里冻结的这句提示会误导模型。

### 1.2 现有代码事实

**P7. 现在是一次主人消息建一次运行，运行与触发一对一。**
来源：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:147`
> “trigger_id TEXT NOT NULL UNIQUE REFERENCES triggers(id) ON DELETE RESTRICT,”

来源：`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1090-1125`（`admitOwnerMessage` 写一条 `triggers` 再写一条 `runs`）。

**P8. 触发表只允许三种来源。**
来源：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133`
> “CHECK (source_type IN ('user_message', 'schedule', 'external_event'))”

**P9. 上下文形成要求“请求里的 trigger id 必须等于上下文封包的 prompt id”。**
来源：`packages/application/src/services/context-formation-service.ts:556`
> “parsed.prompt.id !== request.trigger.id ||”

**P10. 收件箱有表、有工人，但生产里没有 `submit` 调用；且有排队/每日上限和过期。**
来源：`packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:1-20`
来源：`apps/agent-service/src/production-think-inbox.ts:59-61`（上限是 `runPolicy.thinkInbox` 配置）
来源：`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:197-211`
> “if (queued >= queueLimit) … return { outcome: "queue_full" };”
> “if (accepted >= dailyLimit) … return { outcome: "daily_limit" };”

来源：同文件 `:298-307`（`expireQueued` 把过期条目改成 `expired`）
来源：`docs/adr/0274-new-things-go-through-one-think-entrance.md:105`
> “带工具的想一想运行、同意任务的写操作审批、来源接入和旧代码清理在后续 PR 里。”

**P11. 现有“想一想”先过一个小判断模型，再决定值不值得想。**
来源：`packages/prompt-catalog/src/think.ts:4-16`（`think.worth-question`）
来源：`apps/agent-service/src/production-think-worker.ts:90-101`
> “const verdict = await this.#decide(...)”; “if (verdict === "skip") … skipped”; “if (verdict === "unsure") … skipped”

**P12. 现有“想一想”运行强制只读，只能提三种动作，每件事开一个隐藏线程，结束后归档。**
来源：`packages/prompt-catalog/src/think.ts:38`
> “这次运行不能做任何写操作，也不要尝试。”

来源：`apps/agent-service/src/production-think-actions.ts:57-111`（只有 `task.run`、`reminder.create`、`reminder.reschedule`）
来源：`apps/agent-service/src/production-think-runner.ts:142-147`（`thread:think:<hash>` 一事件一线程）
来源：同文件 `:316-348`（`#archive` 结束后归档）

**P13. 主人同意的 `task.run` 会新开一个独立对话，并标成 `external_event`。**
来源：`apps/agent-service/src/production-task-proposals.ts:111`
> “threadId: `thread:proposal:${key}` as ThreadId,”

来源：同文件 `:154-170`（`triggerSource: "external_event"`，`sourceProofRef: proposal:<id>:<proof>`）

**P14. 授权层靠“来源凭据 + 数据库里的提议状态”判定主人同意过的任务。**
来源：`docs/adr/0278-...md:46-50`
> “触发来源是 `external_event`、来源凭据以 `proposal:<提议编号>:` 开头、并且这条 `task.run` 提议的状态是‘已同意’，来源上就带 `ownerApprovedTask`。这个判断在数据库里做，只认服务器自己写的提议记录。”
> “这个标记每次都从数据库里的提议状态重新算……”

**P15. 现有规则：后台读到外部内容后写操作直接拒绝；主人同意过的任务改成问主人。**
来源：`packages/application/src/rules/action-rules.ts:122`
> `action_kind != "READ" && target_type != "managed-task" && "context_external_content" in facts && !(owner_intent_confirmed...)` → `ask_owner`

来源：同文件 `:249`
> `... run_source != "user_message" && "context_external_content" in facts && !("run_source_owner_approved_task" in facts)` → `refuse`

**P16. 邮件现在是“模型分类 + 固定公式决定推不推”。**
来源：`packages/application/src/services/proactive-mail-check-service.ts:1274-1281`
> “const wantsPush = mustNotify || dueSoon || (final.result === "check" && (floor || threadUnread));”
> “const push = wantsPush && suppressing.length === 0;”

**P17. 感知现在是五个来源各一个检查提示，提示里只有条目、日历、当前时间，没有记忆；且有每次/每天条数上限。**
来源：`packages/application/src/services/perception-source-prompts.ts:14-20`、`:42-62`
来源：`packages/application/src/services/proactive-source-runtime.ts:19`
> “export type ProactiveSourceLimitKind = "per_check" | "per_day";”

来源：同文件 `:63-64`
> “const leftToday = Math.max(0, settings.perDay - usedToday); const allowance = Math.min(settings.perCheck, leftToday);”

**P18. 推送循环每 10 秒跑一次，不经过模型；另有推送时机小模型和连续忽略自动降频。**
来源：`apps/agent-service/src/production-web-push.ts:28`
> “const DEFAULT_INTERVAL_MS = 10_000;”

来源：`packages/prompt-catalog/src/perception.ts:596`（`push.delivery-timing-question`，材料给出，未亲读该行上下文）
来源：ADR 0273、ADR 0184（材料给出，未亲读原文）

**P19. 一次运行最长 5 分钟，生产并发 totalRuns=3、foregroundReserved=1。**
来源：`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:150-157`（材料给出）
来源：`apps/agent-service/src/production-run-composition.ts:754`
> “maximumRunDurationMs: configuration.deadlines.runMs,”

来源：同文件 `:826`
> “maximumRunsPerPump: configuration.concurrency.totalRuns,”

**P20. 压缩触发上限 200k token，模型窗口 1M。**
来源：`packages/runtime-pi/src/compaction-prefix.ts:75`
> “export const COMPACTION_TRIGGER_CAP_TOKENS = 200_000;”

来源：配置模板 `:87`（材料给出）

**P21. Pi 运行中插消息的语义是“下一次请求模型之前送达”。**
来源：`docs/pi-development-guide.md:285`
> “`deliverAs: "steer"` 在当前这轮工具跑完、下一次请求模型之前送达；`"followUp"` 等整轮结束；`"nextTurn"` 等下一次用户输入。”

**P22. 决策记录表把 `scenario` 写死为 `gmail`，`kind` 写死为 8 种。**
来源：`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:23-35`
> “kind IN ('proactive', 'memory_candidate', ...)”
> “scenario TEXT CHECK (scenario IS NULL OR scenario IN ('gmail'))”
> “verdict ... IN ('pushed', 'silent', 'deferred', 'failed', 'capped', 'capped_daily', 'needs_owner')”

**P23. 严格配置会拒绝未知键；删掉 `thinkInbox.worth` 或上限键要同时改解析器和模板。**
来源：`packages/platform-node/src/strict-configuration.ts:1399`
> “rejectUnknown(input, [...Object.keys(ranges), "worth"], field);”

**P24. 收件箱状态和完成结果在存储层是白名单校验的。**
来源：`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:261`
> “if (!["proposed", "skipped", "failed"].includes(input.to)) …”

来源：`packages/application/src/ports/think-inbox.ts:3-9`（`queued|thinking|proposed|skipped|failed|expired`）

### 1.3 授权与安全

**P25. 产品原则冲突时的顺序是：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。**
来源：`docs/product-vision.md:55`
> “原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”

**P26. 外部内容是数据，不是指令；敏感/不可逆动作要确认。**
来源：`docs/product-vision.md:57-58`
> “外部内容与其他 Agent 的输出是数据，不是可覆盖我意图的指令”
> “敏感或不可逆的行动需要确认；能可逆、先验证的，不直接做成不可逆。”

### 1.4 业界一手来源

**P27. 收件箱 + 单工人 + 进度文件 + 会话过长就压缩/开新会话。**
来源：Anthropic《Building always-on agents》https://claude.com/resources/articles/building-always-on-agents
> “every source sends an event to an inbox, where a worker picks it up.”
> “An inbox should only have one active worker at a time.”
> “For each ongoing task, the agent should keep a progress file that covers what's been done and what's left.”
> “If a session becomes too long, you can either compact the older messages or start a new session.”

**P28. 子代理需要目标、输出格式、工具与来源指引、清晰边界；主管先写计划。**
来源：Anthropic《How we built our multi-agent research system》https://www.anthropic.com/engineering/multi-agent-research-system
> “Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries.”
> “The LeadResearcher begins by thinking through the approach and saving its plan to Memory”

**P29. 子代理只回传浓缩摘要（常见 1000–2000 token）。**
来源：Anthropic《Effective context engineering for AI agents》https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
> “returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)”

**P30. 先简单后复杂。**
来源：Anthropic《When to use multi-agent systems》https://claude.com/resources/articles/building-multi-agent-systems-when-and-how-to-use-them
> “Start with the simplest approach that works, and add complexity only when evidence supports it.”

**P31. 主管保留对用户回复的所有权。**
来源：OpenAI Agents 编排 https://developers.openai.com/api/docs/guides/agents/orchestration
> “The manager keeps ownership of the reply.”

**P32. 共享任务列表、主管可随时给成员改方向、成员结束自动通知主管。**
来源：Claude Code sub-agents https://code.claude.com/docs/en/sub-agents 、agent teams https://code.claude.com/docs/en/agent-teams （材料给出）

**P33. Pi 自带子代理示例是每个子代理一个独立 pi 进程。**
来源：`@earendil-works/pi-coding-agent` 的 `examples/extensions/subagent/`（材料给出，未亲读包源码）

---

## 2. 方案

### 2.1 总览

```
外部事件/感知/邮件/记忆变化/定时/提醒
主人消息、审批回答、后台命令完成
                │
                ▼
        ┌──────────────────┐
        │  inbox_events    │  只记录，不判断、不设上限、不丢
        └────────┬─────────┘
                 │ 单个 inbox worker 串行领取 + 机械合并
                 ▼
        ┌──────────────────────────────┐
        │ 目标线程判定（只按持久绑定，  │
        │ 不做语义判断）                │
        └───┬───────────────┬──────────┘
            │               │
            ▼               ▼
     主对话 run        子线程 run（每个子线程独立会话）
     （唯一语义决策者）  （计划→执行→检查点→续跑/交回）
            │               │
            └──────┬────────┘
                   ▼
        decision_ledger + 真正的聊天消息 + 推送传输
```

核心主张有三条：

1. **收件箱工人不做任何“值不值得/推不推”的判断。** 它只做持久化、去重、按持久绑定路由、机械合并。语义判断全部交给主模型在正常主对话 run 里做。
2. **主对话是唯一语义决策者。** 它看到合并后的本轮输入、完整记忆工具、所有子线程的计划/进度板，决定：自己回、沉默、开子线程、给子线程发消息、继续/取消子线程。
3. **子线程不是长驻进程，而是“带持久进度文件的事件驱动步骤机”。** 每次 run 最多 5 分钟，结束时把计划/进度写盘；未完成就给自己排下一次续跑事件，完成就把浓缩结果交回主对话。

这与 Anthropic 的“一个收件箱、一个活跃工人、每个任务一个进度文件”一致（P27），也符合“先简单后复杂”（P30）：不引入一个小判断模型，而是让主模型在完整上下文里判断。

### 2.2 收件箱：唯一入口，只记录不判断

在现有 `think_inbox` 基础上做扩展迁移（建议保留表名以减少改动，语义上升级为通用 inbox）：

新增/调整字段：

| 字段 | 作用 |
|---|---|
| `payload_ref` | 事件的**完整内容**（不再只有被裁剪的一句 summary）。工人和模型需要全文时直接读。 |
| `target_kind` | `main` / `subthread` / `approval` / `background_command` |
| `target_ref` | 目标线程 id、子线程 id、审批 id、命令 id |
| `batch_key` | 机械合并键，默认 `target_kind:target_ref` |
| `available_at` | 定时/延后事件的可见时间 |
| `durable` | 主人消息、提醒、审批、子线程结果 = 1；纯感知流可为 0（但也不因上限丢弃，只允许被同源新版本“取代”） |
| `claimed_at` / `claimed_by` | 领取与卡住恢复 |
| `settled_at` / `outcome` | 结算 |

必须改掉的现有行为：

- **删掉 `queueLimit`、`dailyLimit`。** 对应 P10 的两道上限；主人明确要求不设上限。
- **删掉 `expireQueued` 对持久事件的过期。** 提醒、主人消息、审批回答、子线程结果永不因“排队太久”被标 `expired`。
- **保留去重**（`UNIQUE(owner_id, agent_id, source_kind, source_ref, source_version)`）。这是幂等，不是判断。
- **状态白名单扩展**：`queued | claimed | settled`，具体结果放 `decision_ledger`，不要在收件箱里堆语义状态。

来源登记表 `ThinkSourceRegistry` 继续保留：每个来源种类登记 `describe` 和 `externalContent`。新增来源只加一行登记，不改判断代码（沿用 ADR 0274 决定 2 的思路）。但**去掉“没登记就拒收”之外的任何筛选**。

**关键顺序：先把事件写成目标线程里的一条真实消息/批次消息，再唤醒 run，最后才把 inbox 行标 settled。** 这样即使进程崩溃，事件已经在线程历史里，收件箱重放也不会丢；反过来“先 settled 再写消息”会丢事件，必须禁止。

### 2.3 工人：机械合并与路由

单个 `InboxWorker` 串行领取（满足 P27“一个收件箱一个活跃工人”），但不串行跑模型：

1. `maintain()`：恢复卡住的领取（重试），不把持久事件判过期。
2. 领取一批 `queued` 且 `available_at <= now` 的条目，按 `(created_at, id)` 稳定排序，按 `batch_key` 分组。
3. 对每组做**机械合并**：
   - 连续的主人消息：合并成一个“本轮输入批次”消息（见 2.4），保留每条原话的顺序和各自 id。
   - 同源感知流：合并成一个摘要段，但每条都保留引用和可展开全文。
   - 邮件/提醒/审批：各自保留为批次里的独立段，不合并成一句话。
4. 路由：
   - `target_kind = approval`：唤醒等待中的那个 run（审批回答必须回到发起审批的线程/子线程）。
   - `target_kind = subthread`：若子线程 run 在跑，`steer` 进去；否则开一个子线程 run。
   - `target_kind = main`：若主对话 run 在跑，外部事件可以 `steer`；**主人消息不 steer，排队等本轮结束后并入下一轮**（见 2.4 的授权理由）。若主对话空闲，开主对话 run。
   - `target_kind = background_command`：回到原 run/线程。
5. 结算：消息已持久化 + run 已接收（或已排队）后，才把 inbox 行标 settled，并写 `decision_ledger`。

**不做什么：** 不在这里问模型“值不值得”，不在这里按公式决定推不推，不在这里按数量丢事件。

### 2.4 主对话：唯一语义决策者

主对话的每次 run 由“本轮输入批次”驱动。批次是**一条**持久化的用户消息（一个 envelope），里面按顺序放：

- 主人原话（逐条，带原 id、时间、来源）
- 外部事件段（邮件、感知、记忆变化、定时、提醒）
- 子线程进度/问题/结果段
- 审批回答段
- 系统生成的“本轮背景”：当前时间、未结子线程板、待审批、最近主动说过的话（或给工具让模型自己查）

为什么用“一条批次消息”而不是“多条用户消息”：

- 保持 P6“最后一条用户消息承载本轮请求”不变，老对话冻结的系统提示不会误导模型。
- 保持 P7/P9 的“一 run 一 trigger”不变，不用改 `runs.trigger_id UNIQUE` 和上下文形成校验。
- 合并后仍然只追加在末尾，符合 P1/P2。
- 主人原话逐字保存在批次里，符合“存实际发出去的那一条”。

代价：`thread_messages` 里一条消息可能对应主人的多条原话。UI/导出需要能按批次里的 part 渲染成多个气泡；这是**导出格式/UI 契约改动**，必须列为 I-73 类核对项（见 7.4）。

主对话模型在正常循环里决定：

- 直接回复主人 / 沉默（沉默也记决策）；
- 调 `start_subthread(...)` 开子线程；
- 调 `send_to_subthread(...)` 给已有子线程改方向；
- 调 `subthread_status(...)` 看计划/进度；
- 调 `cancel_subthread(...)`；
- 调记忆/旧对话工具查细节。

**主人消息不 steer 进正在跑的主对话**，原因：现有授权事实（`owner_intent_confirmed`、`run_source_owner_approved_task`）是在 run 开始时按来源算的，中途 steer 一条主人消息不会自动更新授权；如果把它当成本轮新请求，可能“主人刚说的话”没有被授权层看到。排队到下一轮最稳。主对话 run 通常很短，这个等待可以接受；如果要极致低延迟，需要把授权改成“每次请求前按已见消息重算”，这是另一项大改，见“需要拍板”。

### 2.5 子线程：任务书、计划、执行、完成

#### 谁决定开、开几个

- **只有主模型决定。** 通过 `start_subthread` 工具。程序不按“任务大小公式”决定，也不设数量上限。
- 资源层仍然有并发事实（P19：`totalRuns=3`、`foregroundReserved=1`）。子线程 run 排队，不丢；主对话有保留位，不会被饿死。**这是资源调度，不是“每天几次”的上限。**

#### 任务书（brief）必须包含

按 P28：

1. **objective**：要达成什么，为什么现在做。
2. **owner 原话/授权依据**：主人原话逐字（若有），或“主人同意过的提议 id / 定时规则 id”。由服务器从当前 run 的持久记录派生，**不接受模型自填的授权字符串**。
3. **output format**：交回主对话的结果结构（状态、摘要、产物引用、未决问题）。
4. **tools & sources**：允许用哪些工具、优先查哪些来源。
5. **task boundaries**：不做什么、外部内容怎么对待、哪些动作必须审批。
6. **completion criteria**：什么算完成（可检查的条目）。
7. **plan requirement**：第一条动作必须是把待办和每条的完成标准写进进度文件，再开始做。
8. **reporting rule**：什么时候向主对话报进度、提问、报阻塞、交结果。

#### 子线程状态与进度文件

建议新增 `subthread_state`（或复用线程 metadata + payload），至少包含：

```
{
  subthreadId, parentThreadId, objective, authorizationBasis,
  plan: [{ id, step, doneCriteria, status, evidenceRef? }],  // 固定顺序
  currentStepId, progress: [{ at, note, artifactRef? }],      // 追加、固定顺序
  openQuestions: [...],
  result: { status, summary, artifactRefs, unfinished } | null,
  revision, updatedAt
}
```

- `plan` 由子线程模型用 `update_plan` 工具写；每次写都递增 revision。
- `progress` 每次有意义的一步后追加；**进度文件是权威**，不是模型上下文里的记忆。
- 主对话随时可以用 `subthread_status` 读这个文件；不需要把子线程全文塞进主对话。

#### 先计划、按计划做、判断完成

子线程系统提示（新提示词，登记 manifest）要求：

1. 第一轮先 `update_plan`，列出待办 + 每条完成标准；没有计划不许开始做。
2. 每完成一步，`update_plan` 标记状态并写证据（工具结果引用/文件引用）。
3. 每步结束检查是否满足完成标准；不满足就继续，满足就 `finish_subthread`。
4. 需要主人批准才能继续时，走审批工具，run 进入 `awaiting_approval`，不要绕过。
5. 遇到无法解决的阻塞，`report_to_main({kind:"blocked"})` 并结束本步，不要空转。

#### 结果怎么交回、主对话怎么汇总

- 子线程完成时调 `finish_subthread`：
  - 写结构化结果（**浓缩摘要**，遵循 P29 的 1000–2000 token 量级；详细产物放引用）；
  - 标记子线程 `done`；
  - 向主对话 inbox 入队一条 `subthread_result`（`durable=1`）。
- 主对话收到结果后，在自己的 run 里决定：直接汇报主人、合并多个子线程结果、追问子线程、或再开新子线程。
- 主对话**不接收子线程全文**；需要原文时用“打开旧对话原话”工具按 `subthreadId` 读。这直接服务“减少主人注意力分散”和“主上下文不变长”。

### 2.6 主↔子实时通信与动态改计划

- **主 → 子**：`send_to_subthread({subthreadId, message})`。若子线程在跑，`steer`（P21：下一次请求模型前送达）；若空闲，作为新消息启动 run。消息进入子线程历史，只追加。
- **子 → 主**：
  - 常规进度：`report_to_main({kind:"progress"})` 追加到主对话历史（作为批次段），但**是否唤醒主对话 run 由事件类型决定**：问题/阻塞/完成立即唤醒；常规进度可只追加、下次主对话 run 时一起看到（避免频繁打扰主人）。
  - 提问/阻塞/完成：立即入队并唤醒主对话。
- **主人中途改需求**：
  1. 主对话收到主人消息（新一轮批次）。
  2. 主模型判断对应哪个子线程（看 `subthread_status` 和当前计划）。
  3. 调 `send_to_subthread` 把改动发过去。
  4. 子线程收到后 `update_plan`：重新思考，改计划，继续做。
  5. 若改动隐含新的权限（例如“顺便把邮件发出去”），主对话必须走审批/提议，不能靠子线程的旧授权直接做。
- **主对话随时看进度**：`subthread_status` 工具；同时本轮批次末尾的“未结子线程板”给出每个子线程的 id、状态、当前步骤、最后更新时间（绝对时间）。这个板**只放在最后一条消息里**，绝不进系统提示（见必答问题 1）。

### 2.7 定时、提醒、审批、后台命令

全部走同一个收件箱，但绑定不同：

| 来源 | 入队时机 | target | durable | 结算条件 |
|---|---|---|---|---|
| 主人消息 | 到达 | main | 是 | 已写入批次消息并启动/排队 run |
| 审批回答 | 主人点击 | approval → 发起审批的线程/子线程 | 是 | 对应 run 恢复 |
| 提醒到点 | `remind_at <= now` | main | 是 | **已提交一条真正的聊天消息**（或模型明确决定改期并重新入队） |
| 周期任务 | 每次到点 | main 或绑定子线程 | 是 | 已处理/已委派 |
| 邮件 | 新邮件 | main | 是 | 已进入批次消息 |
| 感知 | 新条目 | main | 否（可被同源新版本取代） | 已进入批次消息 |
| 记忆变化 | 记忆系统通知 | main | 是 | 已进入批次消息 |
| 子线程进度/结果 | 子线程写 | main | 是 | 已写入主对话历史 |
| 后台命令完成 | 命令结束 | 原线程 | 是 | 已送达原 run |

**提醒绝不丢的机制**：提醒记录在“主人看到一句话”之前保持 `scheduled`，不标 `fired`。模型若决定现在不说，必须显式安排下一次（重新入队），不能静默丢弃。发送失败重试；只有消息提交成功后才标 fired。这是对“主人自己定的提醒绝不能丢”的直接实现。

**审批**：子线程的写操作审批走现有审批链路，但审批卡片必须带“这是哪个子线程/哪个任务”的上下文。审批回答按持久绑定回到发起者，不经过主对话（除非主对话也订阅了该审批）。审批过期时，向发起者入队一条事件让它决定下一步，不静默丢。

**定时任务不设每天/总次数上限**：如果现有调度器有 `perDay`/`maxRuns` 之类的上限，全部移除（具体位置**未核实**，材料说 `SchedulerService` 未装进生产）。

### 2.8 5 分钟时限与长任务续跑

- 每个 run 最长 `runMs=300000`（P19）。子线程不能“一直跑”，必须做成步骤机。
- 每次子线程 run：
  1. 开始：读进度文件，确定当前步骤。
  2. 执行：每步后 `update_plan` 持久化；工具批之间也写检查点（防止 5 分钟硬切时丢进度）。
  3. 结束：
     - 完成 → `finish_subthread` + 向主对话入队结果。
     - 未完成 → 写“下一步 + 未完成原因”，向自己的 inbox 入队 `subthread_resume`（`available_at=now`），run 正常结束。
     - 等审批/等外部 → 状态 `waiting_*`，不排续跑，等事件唤醒。
- **续跑不设次数上限**（主人要求）；但连续多次同一错误要标 `blocked` 并报主对话，避免无限热循环。这是健壮性，不是成本上限。
- **重复副作用**：续跑可能重做上一步。所有外部写必须走现有命令幂等键/审批回放；进度文件在副作用前记录“进行中”，完成后记录“完成”，恢复时先查状态。反例见风险 R4。

### 2.9 权限与审批

子线程的权限必须**从服务器记录派生**，不能让模型自填。建议 `authorizationBasis`：

| basis | 何时产生 | 写权限 |
|---|---|---|
| `owner_message` | 由主人消息触发的主对话 run 开的子线程 | 和主人自己发起的 run 一样：低/中风险、可逆、只动自己数据可预授权；高/不可逆/对外/花钱/删除照常问主人；读过外部内容后问主人（现有 `askAfterExternalContent`） |
| `owner_approved_task` | 由已同意的 `task.run` 提议开的子线程 | 沿用 ADR 0278：没读外部内容时同主人发起；读过后每个写都问主人 |
| `owner_standing_rule` | 由主人亲口设定/同意的周期任务触发 | 按该规则的授权范围；超出范围问主人 |
| `self_initiated` | 邮件/感知/记忆/她自己的想法触发 | **只读**；写操作直接拒绝（沿用 `refuseBackgroundAfterExternalContent` 的精神） |

实现要点：

- 在 `runExecutionSource` 解析时，按 `target_ref` 去数据库核对：提议状态是否已同意、定时规则是否主人设定、子线程的 `authorizationBasis` 是否由服务器写入。核对通过才加事实（如 `run_source_owner_authorized` / 复用 `run_source_owner_approved_task`）。
- `start_subthread` 工具只接受 `objective` 等业务字段，**不接受 `basis` 字符串**；basis 由当前 run 的来源和持久记录决定。
- 动作规则扩展：把 `run_source_owner_approved_task` 泛化为 `run_source_owner_authorized`，或在表达式里同时认两个事实；所有使用处（`action-rules.ts`、`policy-fact-registry.ts`、测试）一起改。这是 I-73 类核对项。

### 2.10 主对话保持恒定长度、不变笨

- **分工**：主对话只做“和主人对话 + 编排 + 汇总”。重活、长活、脏上下文全部在子线程。
- **留在主对话**：主人原话、主对话自己的回复、子线程的浓缩进度/问题/结果、决策记录引用、未结子线程板（最后消息里）。
- **放到外面**：子线程全文、原始邮件/感知、工具大结果、旧对话。通过记忆/旧对话工具按需打开。
- **压缩时机**：
  - 主对话：比 200k 更早压缩。具体阈值建议先用评测定（例如 120k–150k，**推测值**），不要拍脑袋写死；写成按线程角色的配置，并在 ADR 里写明理由。压缩请求沿用原头（P5），压缩后重建记忆快照（由记忆线程负责）。
  - 子线程：短命；完成即归档。超过阈值同样按 P5 压缩，或直接结束交回。
  - 两次压缩之间的记忆变化：按记忆线程的约定追加在下一条消息末尾，不改历史。
- **绝不做**：把“当前子线程板/当前时间/最近主动说过的话”放进系统提示。它们每轮会变，只能放最后一条消息或作为工具结果。

### 2.11 决策记录与“她说过什么”

- 每一条主动发给主人的话，**先**写成主对话里的一条真正 `thread_messages`（role=agent），**再**由推送循环作为传输发出去。推送只是通知渠道，不是消息本体。
- 每次“说/不说/推迟/委派/失败”都写 `decision_ledger`（`kind='proactive'` 或新 kind）：
  - `subject_ref`：相关事件/子线程/提醒；
  - `content_ref`：发出去的那条消息 payload（沉默时为空）；
  - `reason_ref`：为什么说/为什么不说；
  - `counts`：看到了哪些输入；
  - `verdict`：`pushed`（说了）/`silent`（决定不说）/`deferred`（推迟）/`delegated`（交给子线程）/`failed`；
  - `owner_rating`：主人后续标记有用/打扰/漏了。
- 新增只读工具 `recent_proactive`：返回最近主动说过的话、原因、主人评价，**绝对时间、固定顺序**。主对话和子线程都能用。这样“她在任何对话里都看得到自己最近主动说过什么、为什么”不靠把内容塞进每个系统提示。

### 2.12 要改的“写死的决定”和“只看一小片信息的判断”（对应问题 6）

**要删/改：**

1. `think.worth-question` 小判断模型和 700‰/300‰ 门槛（P11）→ 删。所有事件进主对话，由主模型判断。
2. 邮件 `wantsPush` 固定公式、每封最多 3 条记忆（P16）→ 删公式；邮件全文入收件箱，主模型用记忆工具判断。
3. 感知五来源的 `per_check`/`per_day` 上限和“提示里没有记忆”（P17）→ 删上限；事件进收件箱，模型用记忆工具。
4. 推送时机小模型 `push.delivery-timing-question`（P18）→ 删。是否现在说由主模型决定；主人配置的免打扰时段作为规则告诉模型，而不是另一个模型闸门。
5. 连续忽略自动降频（ADR 0184）→ 删自动公式。忽略历史写进决策记录，主模型看得到并自己决定。
6. 首页要紧度模型 `home.urgency` → 不再作为“推不推”的闸门；如果还要排序，只做展示排序，且不阻断消息。
7. `task.run` 同意后开独立 `thread:proposal:*`（P13）→ 改为“同意后开主对话下的子线程”，结果回到主对话。
8. 收件箱排队/每日上限、过期（P10）→ 删。

**要保留（这是安全/正确性，不是“聪明度筛选”）：**

1. 去重（source/version）——幂等。
2. 出口遮盖、外部内容标记、`refuse/askAfterExternalContent`（P15）——安全边界。
3. 审批与可逆性规则（P26）——用户主权与边界。
4. 系统提示/工具冻结、只追加、确定性序列化（P1–P4）——缓存正确性。
5. 压缩机制与压缩请求复用原头（P5）——成本与正确性。
6. 提醒的持久化与“消息提交后才标 fired”——可靠性。
7. 运行/命令的幂等键与崩溃恢复——可靠性。

一句话：**判断交给模型，安全留给规则。**

### 2.13 分步上线与验收（对应问题 7）

| 步骤 | 内容 | 正向验收 | 反向验收（去掉修复必须失败） |
|---|---|---|---|
| 0 | ADR + 迁移：inbox 扩展、`subthread_state`、`decision_ledger` 枚举、`triggers.source_type`、`threads.origin/parent`、配置键 | 迁移可应用；表驱动契约测试把每个新枚举值真实插入一遍 | 任一产出值被 DB CHECK 拒绝时测试失败（I-73） |
| 1 | 收件箱成为主人消息/审批/提醒的唯一入口；工人批量合并、先写消息再唤醒 | 连发 3 条主人消息只跑 1 个主 run；审批回答回到原 run；提醒到点必有一条聊天消息 | 重新引入 queueLimit/dailyLimit 或丢事件时测试失败；先 settled 后写消息导致崩溃丢事件时测试失败 |
| 2 | 主对话加子线程工具；子线程计划/检查点/续跑；主↔子消息 | 一个 >5 分钟任务跨多次 run 完成；主对话看到进度板；主人中途改需求到达子线程并改计划 | 把子线程全文塞进主对话头时失败；子线程 id 在重试时变化时失败；自触发子线程写操作未拒绝时失败 |
| 3 | 邮件/感知/定时迁入收件箱；删 worth 模型、公式、上限、推送时机模型、自动降频 | 每个来源都产生 inbox 事件；无上限；沉默也有决策记录；主动消息是真聊天消息 | 仍有公式/小模型闸门时失败；有条数上限丢事件时失败；沉默没有 ledger 时失败 |
| 4 | 决策记录扩展 + `recent_proactive` + 主人评价；删旧 think/proposal 独立线程代码 | 每条主动消息/沉默都有 ledger；任何对话都能查到最近主动说过什么 | 新 scenario 被 CHECK 拒绝时失败；主动消息无 ledger 时失败 |
| 5 | 主对话按角色压缩阈值、记忆快照整合、清理旧工具结果 | 压缩后主对话仍能靠工具拿到旧细节；缓存命中率可解释 | 把每轮变化的值塞进系统提示时 `check:prompt-prefix` 失败 |

每一步都必须跑 `npm run check`（含 `check:prompt-prefix`），并为新行为加集成测试。反向用例要在**未修复版本**上跑一遍，确认真的红。

---

## 3. 考虑过但不选的做法

1. **收件箱前再放一个“路由小模型”**：违反主人第 2 条，且多一个只看小片信息的判断者。不选。
2. **主对话只做展示，另开一个“大脑线程”做决策**：多一层上下文同步，主对话不再直接和主人对话，违背“一个主线程和它聊天”的直觉。不选。
3. **用 Pi 自带 subagent 扩展（每个子代理一个 pi 进程）作为主机制**：隔离好，但绕过 Himawari 的线程/run/审批/决策记录，权限与审计要另造一套。只作为参考，不作为主机制。
4. **多 trigger 对应一 run（改 `runs.trigger_id UNIQUE` + 上下文形成）**：更“原生”，但要改 P7/P9 及大量消费方，且老对话的系统提示仍假设“最后一条用户消息”。除非批次 envelope 方案被证明不够，否则不选。
5. **把子线程板/当前时间注入系统提示**：每轮变化，直接违反 P1/P2，缓存全毁。不选。
6. **保留 `wantsPush` 公式，只把阈值交给模型**：仍是程序决定“推不推”。不选。
7. **保留自动降频**：用程序公式代替模型判断，且会压掉主人明确要求优先的提醒。不选。
8. **让子线程长期挂起一个 run 等审批**：占用并发槽且 5 分钟会超时。不选；改为结束 run、持久化状态、审批回答再唤醒。

---

## 4. 风险与反例

**R1. 主对话被事件淹没。** 每个感知/邮件都进主对话，主上下文会变长、变慢。
反例：一天几百条感知，主对话每轮都带一大段摘要，模型抓不住重点。缓解：机械摘要 + 全文可按引用展开 + 主模型可委派；但摘要裁剪可能漏掉关键细节。**这是“看得全”和“上下文短”的真实张力，需要拍板摘要粒度。**

**R2. 合并窗口与实时性的冲突。** 为了“连发几条合成一轮”需要 debounce；debounce 会让主人多等。
反例：主人发“在吗”然后 3 秒后发正事；如果 2 秒就启动 run，两条分成两轮。**需要拍板 debounce 时长或“主人消息永不 steer、只排队合并”的边界。**

**R3. 子线程 id 不确定导致重复子线程。** 如果 id 用模型生成的 objective 文本做哈希，模型重试时措辞不同就会开两个。
缓解：id 用 `(父线程, 触发事件 id, 工具调用 id)` 派生；`start_subthread` 以工具调用 id 做幂等。反例测试必须覆盖“同一工具调用重放不产生第二个子线程”。

**R4. 续跑重复副作用。** 子线程发了邮件，5 分钟硬切在写进度之前，续跑又发一次。
缓解：外部写先写“进行中”再执行、完成后写“完成”，并用现有命令幂等键；审批回放也走幂等。反例测试：模拟写完外部副作用后崩溃，恢复不得重发。

**R5. 授权提权。** 模型在 `start_subthread` 里自称“主人同意过”。必须服务器按持久记录派生 basis；反例测试：自触发来源伪造 `owner_approved_task` 必须被拒绝。

**R6. 决策记录与消息不一致。** 先发消息、后写 ledger 失败，导致“说过但没记录”。
缓解：同一事务/outbox；或先写 ledger（状态 pending）再发消息再确认。反例测试：ledger 写失败时消息不得发出（或必须可补偿）。

**R7. I-73 类枚举/契约不匹配。** 新 `scenario`、新 `trigger.source_type`、新 `web_push_outbox.kind`、新 `verdict` 可能被 DB CHECK 或消费方拒绝。
必须逐个核对（见 7.4）。反例测试：真实存储插入每个新值。

**R8. 缓存退化。** 新工具/新系统提示只对新对话生效；老对话需要一次 `thread prompt rebuild`。这是一次性缓存失效，必须记录并接受。反例：如果把“子线程板”放进系统提示，`check:prompt-prefix` 必须红。

**R9. 压缩把子线程状态写进摘要后过期。** 摘要冻结后，子线程状态继续变；主模型可能拿旧摘要当现状。
缓解：摘要只写“当时发生了什么”，现状永远从 `subthread_status` 工具/批次板读。反例测试：压缩后旧摘要不得被当作最新进度。

**R10. 审批轰炸。** 多个子线程各自要审批，主人注意力被打散。
这是产品取舍：主人要求“边界与可逆性”优先，但也要“减少注意力分散”。可考虑同一子线程的多个审批合并展示，但不自动放行。**需要拍板。**

---

## 5. 需要人拍板的取舍

1. **批次数据模型**：采用“一条批次 envelope 消息”（推荐，兼容冻结提示和现有 1:1 trigger）还是“多 trigger 一 run”（更原生，但要改 schema 和上下文形成）。我推荐前者。
2. **主人消息合并窗口**：debounce 多久；主人消息是否永不 steer 进正在跑的主对话（我推荐永不，保授权正确）。
3. **主对话压缩阈值**：具体 token 数（建议先用评测定，不拍脑袋）；是否按线程角色配置。
4. **感知/邮件的摘要粒度**：机械摘要 + 全文工具展开，摘要裁到多长；是否接受“主模型可能没一眼看到全文”。
5. **子线程进度唤醒策略**：每条进度都唤醒主对话，还是只唤醒“问题/阻塞/完成”，常规进度只追加历史。
6. **审批展示**：每个写操作一张卡，还是同一子线程合并成一张卡（仍逐项确认）。
7. **`task.run` 提议的去留**：保留为“开子线程”的审批 UI，还是改成 `start_subthread` 提议。
8. **`triggers.source_type`**：新增 `subthread`/`owner_approval` 枚举（要重建表）还是复用 `external_event` + 前缀（改动小但语义混）。
9. **免打扰时段**：模型主动说话时是否硬性遵守主人配置的免打扰；提醒是否例外。
10. **旧对话是否统一 rebuild 一次**：让新系统提示/新工具生效，接受一次缓存失效。

---

## 6. 读代码/来源证实的 vs 推测

**证实（读代码或一手来源）：**

- 只追加、冻结头、确定性、压缩复用原头：P1–P5。
- 现有 1:1 trigger/run、三种 source_type、上下文形成校验：P7–P9。
- 收件箱空转、有上限/过期、worth 小模型、只读、三种动作、独立线程：P10–P13。
- `task.run` 独立线程与 `ownerApprovedTask` 数据库判定：P13–P15。
- 邮件公式、感知上限与无记忆、推送循环：P16–P18。
- 5 分钟/并发、200k 压缩阈值、Pi steer 语义：P19–P21。
- `decision_ledger` 的 `scenario='gmail'` 等 CHECK、严格配置拒绝未知键、收件箱状态白名单：P22–P24。
- 业界 inbox/进度文件/子代理 brief/摘要/主管所有权：P27–P32。

**推测（需要评测或实测）：**

- 主对话压缩阈值具体取多少（120k/150k 只是猜测）。
- 主对话每事件唤醒的实际延迟与上下文增长速度。
- 机械摘要是否足够让主模型做出“该不该打扰”的判断。
- 子线程 step 拆分粒度对完成质量的影响。
- 生产 4 核 8GB 下同时跑主对话 + 多个子线程的吞吐（现有 totalRuns=3 是起点，可能需要调，但未实测）。
- 决策记录/推送/UI 对“批次消息多 part”的改造工作量（未读导出与前端代码）。

**未核实：**

- `web_push_outbox.kind` 后续迁移是否已加入 `proposal`/`muse` 等值（0058:26 只看到 `reminder/approval/run`）。
- `approval_requests` 表字段是否足以承载“子线程/任务”上下文。
- 调度器是否已有每天/总次数上限（材料说 `SchedulerService` 未装进生产）。
- `threads.origin` 后续是否有 CHECK 约束。
- 记忆线程的两个对话工具和 `/memories` 工具的具体接口（材料说由另一线程设计）。

---

## 7. 必答问题逐条

### 7.1 这个改动会不会改变模型已经见过的请求开头？

**结论：按本方案设计，不会改变已发出的字节；但“新增工具/新系统提示”会让新对话与旧对话不同，旧对话需要一次显式 rebuild。**

- 对已有主对话：事件、主人消息、子线程进度/结果都以**新的末尾消息**进入（P1 第 3 条、P2），不改系统提示、不改历史、不重排。
- 每轮会变的值（当前时间、批次内容、子线程板、最近主动说过的话）只放**最后一条消息**或工具结果，不进系统提示/工具定义（P1 第 2 条）。
- 子线程是独立会话，有自己的冻结头；它的 brief 是第一条消息，之后只追加。
- 唯一例外：主对话要新增 `start_subthread`/`send_to_subthread`/`subthread_status` 等工具，工具集合变了，按 P3 属于“换新”条件，**只对新对话生效；老对话要手动 `thread prompt rebuild`**，并留记录。这是一次性缓存失效，不是每轮变化。
- 如果实现时把“子线程板”塞进系统提示，或把批次拆成多条消息并改写历史，就违反了 P1/P2，必须停。

**所以：只要坚持“末尾追加 + 每轮变化值只在最后一条消息 + 子线程独立冻结头”，答案是否定的；老对话 rebuild 是已知、一次性、需记录的例外。**

### 7.2 会不会让同一段文字在不同请求里变成不同的字节？

**不会，前提是避开下面这些坑：**

- **顺序**：批次里的事件、子线程板、计划列表、进度列表必须按 `(created_at, id)` 或固定字段排序；不能用 `Set`/`Map` 遍历顺序或数据库返回顺序（P4）。
- **时间**：不要生成“3 分钟前”这种相对时间；用绝对时间。相对时间每轮都变，即使放在最后一条消息也会让同一事件在两次请求里字节不同（虽然它是新消息，但会让“同一段文字”不稳定）。
- **id**：子线程 id、批次 id、消息 id 必须从稳定输入或工具调用 id 派生；重试不能重新随机。
- **遮盖**：沿用现有确定性出口遮盖（P4）；不要做“依赖后文”的遮盖。
- **压缩**：只在压缩时重建摘要/记忆快照（P5），不要每轮重写历史。
- **重复投递**：同一事件重放必须用幂等键，保证写入的字节与第一次相同。

**风险点：** 如果把“最近主动说过的话”做成动态拼接并带相对时间，或把子线程板里的“最后更新时间”写成相对时间，就会让同一段内容在不同请求里不同。设计上必须禁止。

### 7.3 有没有对应的自动检查？反向用例真的会失败吗？

有，建议至少这些：

**缓存/追加：**
- 扩展现有 `npm run check:prompt-prefix`（P1 提到它是阻断检查）：
  - 多事件批次只追加在末尾；
  - run 中 `steer` 一条事件后，下一次请求仍以前一次请求开头；
  - 子线程头冻结；
  - 子线程板只在最后一条消息；
  - 反向：把板放进系统提示、把批次插入历史中间、重排批次、重试生成新 id → 必须报告失败。

**收件箱：**
- 连发 N 条主人消息只产生一个主 run（正向）；把 `queueLimit`/`dailyLimit` 加回来导致丢事件时失败（反向）。
- 先 settled 后写消息的崩溃注入测试：必须丢事件并失败（反向）。
- 提醒到点后模型选择沉默/推迟：提醒仍 `scheduled`，直到有聊天消息提交；没有消息就标 fired 的测试必须失败（反向）。

**子线程：**
- >5 分钟任务跨多次 run 完成；中断后从进度文件续跑；重复副作用测试（R4）必须失败（反向）。
- 自触发子线程写操作必须被拒绝（反向）；`owner_approved_task` 子线程读外部内容后写必须问主人（正向）。
- 同一 `start_subthread` 工具调用重放不产生第二个子线程（反向：产生两个则失败）。
- 主对话只收到浓缩结果，不收到全文（反向：全文出现在主对话头则失败）。

**决策记录：**
- 每条主动消息/沉默都有 ledger（反向：缺一条则失败）。
- 新 `scenario`/`verdict`/`kind` 真实插入通过 CHECK（反向：被拒则失败）——I-73 类门槛。
- 主动消息先落聊天记录再推送（反向：只有推送没有聊天消息则失败）。

**关键要求：** 反向用例必须在**未修复的代码**上跑一遍确认红，否则等于没测。现有 `check:prompt-prefix` 已带反向用例（P1 所在文件 `:76` 描述了这类做法），新检查沿用同样思路。

### 7.4 每个新值/字段/配置键，所有使用它的地方都能接受吗？

这是 I-73 的核心。逐个核对如下（**未核实的标注**）：

| 值/字段 | 产生处 | 使用处/校验 | 结论 |
|---|---|---|---|
| `think_inbox.source_kind` 新值（mail/perception/reminder/schedule/subthread/approval/...） | 各来源 `submit` | `ThinkSourceRegistry.get`；DB 只校验长度 1–64（迁移 `:5`） | 必须在 `production-think-composition` 注册每个新 kind，否则 `source_unregistered`。需要登记表测试 |
| `think_inbox.status` 新值（`claimed`/`settled`） | worker | `sqlite-think-inbox-operations.ts:261` 只允许 `proposed/skipped/failed`；`ports/think-inbox.ts:3-9` 白名单 | **必须改存储层和端口类型**，否则写入被拒 |
| `think_inbox` 删除 `queueLimit/dailyLimit` | 配置 | `sqlite-think-inbox-operations.ts:176-211` 仍要求；`strict-configuration.ts:1391-1408` 仍解析；配置模板仍有键 | 必须同时改迁移/端口/存储/严格配置/模板；否则启动失败或行为仍旧 |
| `triggers.source_type` 新值（`subthread`/`owner_approval`） | worker/子线程 | DB CHECK 只允许三种（`0001:133`）；授权层按 source_type 分支 | 要么加值（重建表），要么复用 `external_event` + 前缀；**必须二选一并核对所有分支** |
| `threads.origin` 新值 `subthread` | 创建子线程 | `threads` 表（ALTER 为 TEXT，未见 CHECK）；可能有消费方 switch | 需查所有 `origin` 消费方；**未核实** |
| `runs.trigger_id UNIQUE` | 批次方案 | `0001:147`；上下文形成 `:556` | 采用批次 envelope 则**不需要改**；若改多 trigger，必须改这两处及重放 |
| `decision_ledger.kind` 新值（如 `proactive_delivery`/`subthread`） | 新记录 | `0095:23-28` 硬编码 8 种；`decision_ledger_kinds` 引用表 | **必须迁移**；两处要一致 |
| `decision_ledger.scenario` 新值（mail/perception/reminder/schedule/subthread） | 新记录 | `0095:29` 只允许 `gmail` | **必须迁移**，否则写 ledger 失败（I-73 的翻版） |
| `decision_ledger.verdict` 新值（`delegated`/`held` 等） | 新记录 | `0095:33-35` 白名单 | **必须迁移**；或复用 `pushed/silent/deferred/failed` |
| `decision_ledger.outcome` 新值 | 新记录 | `0095:66-83` 按 kind 白名单 | 需加分支；否则 CHECK 失败 |
| `web_push_outbox.kind` 新值 | 推送 | `0058:26` 只允许 `reminder/approval/run`；后续迁移**未核实** | 必须核对；否则推送写入失败 |
| `run_source_owner_authorized` / 复用 `run_source_owner_approved_task` | 授权层 | `action-rules.ts:122/249` 表达式；`policy-fact-registry.ts:16`；测试 | 必须同时改表达式、事实注册、测试；否则规则不生效或测试红 |
| 子线程 `authorizationBasis` | 服务器 | `runExecutionSource`、授权层、冻结快照比对（ADR 0278 决定 5） | 必须像 `ownerApprovedTask` 一样“每次从数据库重算”，并处理冻结快照缺键的恢复 |
| 新配置键（压缩阈值、debounce、子线程并发等） | 模板 | `strict-configuration.ts` 的 `rejectUnknown` | 必须同时加解析器和模板；否则启动失败 |
| 删除 `thinkInbox.worth` | 代码 | `strict-configuration.ts:1399` 仍认 `worth`；模板可能仍有 | 删除要同步；否则旧配置报未知键或残留 |
| 批次消息的多 part | 批次 payload | UI、导出 v4、`thread_messages` 消费方 | **未核实导出/前端**；这是“清单里的 id 能通过后端校验吗”的同类问题，必须找到所有消费者 |
| 子线程/审批 `subject_ref`/`content_ref` 长度 | 新 id | `decision_ledger.subject_ref` ≤256、`payloads.ref` 约束 | 新 id 必须满足长度；需要契约测试 |
| 审批卡片上下文 | 审批创建 | 审批 UI/推送（`approval_requests` 字段**未核实**） | 必须确认能带子线程/任务信息；否则主人不知道在批什么 |

**建议的门槛**：新增一个类似 `check:model-ref-contract` 的 `check:inbox-contract`，用真实 SQLite 把每个新枚举值/配置键/ref 走一遍真实存储与真实解析器；任何一端拒绝就红。这直接对应 I-73 的教训。

---

## 8. 对应你列的 7 个设计问题（索引）

1. **组织方式**：2.4（主对话决策）、2.5（子线程任务书/计划/完成/交回）。
2. **实时互发与动态改计划**：2.6。
3. **收件箱服务所有来源、并行与先后、5 分钟续跑**：2.2、2.3、2.7、2.8。
4. **主对话恒定长度**：2.10。
5. **子线程审批与权限来源**：2.9。
6. **要改的写死决定/小判断**：2.12。
7. **分步上线与验收**：2.13。

---

**一句话总结**：把收件箱做成“只记录、不判断、不丢”的持久日志；把唯一的语义判断交给主模型在正常主对话 run 里做；把长活拆成“带持久计划和进度文件的子线程步骤机”；把主动输出先写成真正的聊天消息、再推送、再记决策。这样既满足“所有决策让大模型做、看得到全部必要上下文”，又不破坏只追加/冻结头的缓存规则。
