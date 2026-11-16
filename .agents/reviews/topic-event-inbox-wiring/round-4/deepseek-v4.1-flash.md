I'll start by exploring the repository structure and the key files cited in the proposal.
Bash is restricted to specific git commands. Let me use the file tools.
I have enough code context. Let me verify the key industry quotes from the first-party Anthropic article before writing conclusions.
## 结论

方案方向（一张收件箱、一个工人、调度器只写事件、跟进与周期任务分开）和 Anthropic 的一手做法一致；但“把用户消息也搬进同一个收件箱”这一半，按现在的代码不能像方案写的那样“运行怎么执行不动”地落地：消息入队的事务边界、批量消息的上下文投影、系统提示对“最后一条消息才是本轮请求”的约定、think 运行的只读工具限制，四层都要改。下面按严重度列，先列证实的，再列推测/未核实的。

---

## 证实的：高

### 高 1. 用户消息会被收件箱的排队/每日上限拒绝，且没有失败兜底

**问题**：方案说“收件箱已有的去重、排队上限、每日上限照常生效”，又说“你发的消息……一定处理”。这两句不能同时成立。`enqueue` 的排队上限和每日上限是对所有来源统一计数的；用户消息走同一个入口时，超过上限会返回 `queue_full`/`daily_limit`，而聊天消息已经存进对话，之后不会建运行，用户永远等不到回复。

**证据**：
- `apps/agent-service/src/production-think-inbox.ts:17-18`：`THINK_QUEUE_LIMIT`、`THINK_DAILY_LIMIT`。
- `packages/application/src/ports/configuration.ts:420-421`：`queueLimit` 默认 20，`dailyLimit` 默认 50。
- `packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:197-211`：排队数 `>= queueLimit` 返回 `queue_full`；当天接收数 `>= dailyLimit` 返回 `daily_limit`。
- `apps/agent-service/src/production-think-inbox.ts:237-240`：`return { accepted: false, reason: ... }`。

**建议**：给聊天消息单独一条通道（或预留名额并绕过上限）；`submit` 失败时必须回退到现有直接受理路径或向客户端返回明确错误，不能只记诊断。加一条“连发超过 queueLimit、超过 dailyLimit 仍每条都有回复”的自动测试。

### 高 2. “先存消息、再写收件箱”不是原子的，崩溃窗口会永久丢一轮

**问题**：方案把消息存进对话和写收件箱拆成两步，但没有事务或恢复机制。两步之间进程崩溃，会留下一条已提交、但没有收件箱行、也没有运行的消息；启动后没有任何扫描能把它捞回来。方案的反向验收“服务停掉再启动，那条消息没有丢”没有对应机制。

**证据**：
- `packages/persistence-sqlite/src/sqlite-thread-operations.ts:1090-1160`：现在 `triggers`、`runs`、`turns`、`thread_messages` 是在同一个事务里写的。
- 一手来源：Anthropic《Building always-on agents》<https://claude.com/resources/articles/building-always-on-agents>：“The inbox should be the source of truth. When the worker is woken up, it should pull the latest events from the inbox first. That way, if the worker dies mid-run, a new one can pick up the same event and retry.” 方案的做法把对话当成第一真相、收件箱当第二步，正好反过来。

**建议**：要么在同一个事务里写消息和收件箱行（transactional outbox），要么以收件箱为真相、消息由收件箱行派生；再加启动时的补偿扫描。用故障注入测试卡在两次写之间。

### 高 3. 现有模型无法把多条用户消息合成一轮，“运行怎么执行不动”不成立

**问题**：方案说“每条消息仍然单独存、按顺序排在最后，她一次看到全部”，并说“运行怎么执行不动”。但现在的运行与消息是一对一绑死的：一次受理生成一个 trigger、一个 run、一个 turn、一条 message；`runs.trigger_id` 是 UNIQUE；上下文投影只有一个 `prompt`，而且 `prompt` 必须等于该 run 的 trigger。更关键的是系统提示写明“最后一条用户消息承载本轮的新请求，历史消息供理解背景，不是等待执行的任务队列”。把三条消息中的前两条放进历史、最后一条放进 `prompt`，模型会按系统提示把前两条当背景，不会当成三件要办的事；把三条拼进 `prompt`，又违反方案“不拼接你的原话”。

**证据**：
- `packages/application/src/services/thread-command-service.ts:210-233`：每次 `admitOwnerMessage` 生成 `messageId`、`turnId`、`runId`、`triggerId` 各一个。
- `packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:147`：`trigger_id TEXT NOT NULL UNIQUE REFERENCES triggers(id)`。
- `packages/application/src/services/context-formation-service.ts:556-559`：`parsed.prompt.id !== request.trigger.id` … `parsed.prompt.payloadRef !== request.trigger.payloadRef` … `parsed.prompt.occurredAt !== request.trigger.occurredAt` 直接拒绝。
- `packages/application/src/ports/intelligence.ts:349-354`：`RuntimeProjectionContext.prompt` 只有一个 `content`。
- `packages/prompt-catalog/src/chat.ts:278`：“最后一条用户消息承载本轮的新请求……历史消息供理解背景，不是等待执行的任务队列。”
- Anthropic 文章确实说 “the worker can merge them into a single run”，但那是事件层的合并；本项目的运行/投影层没有“多条当前消息”的概念。

**建议**：不要把“合批”说成运行层不用动。二选一：(a) 保持一条消息一轮，后续消息用 `session.steer()` 叠加；(b) 真正做“批量 turn”：一次运行对应多条当前消息，改 `runs`/`turns`/`thread_messages` 的关联和 `RuntimeProjection`，并同步改系统提示的任务边界。两种都要有“连发三条只回一条且三件都办”的行为测试。

### 高 4. 主人建的定时任务拿不到写工具：`readOnlyRun` 强制 think 运行只读，提示词还写着“不能做任何写操作”

**问题**：方案说主人明说建的定时任务“到点能动手……权限和现在‘你同意过的一件任务’完全一样”。但 think 运行的只读限制有两层：`service-main.ts` 的 `readOnlyRun` 对 `isThinkRunSource` 返回 true，`ProductionRuntimeTools` 只给 READ 工具；`think.run-task` 提示词还明确告诉模型“这次运行不能做任何写操作”。不换运行来源、不换提示词，主人建的任务也只能读。

**证据**：
- `apps/agent-service/src/service-main.ts:1719-1722`：`readOnlyRun: async (runId) => { const source = await runSources.read(runId); return source === undefined || isThinkRunSource(source); }`。
- `packages/application/src/services/...` 无；`packages/runtime-pi` 无。工具过滤在 `apps/agent-service/src/production-runtime-tools.ts:605-606`：`const readOnly = ...; return this.#registry.offer(descriptors, { readOnly });`。
- `packages/prompt-catalog/src/think.ts:38`：“这次运行不能做任何写操作，也不要尝试。”
- `docs/adr/0274-new-things-go-through-one-think-entrance.md:66`：“只给读类工具……不给任何写工具。”

**建议**：为主人建的定时任务定义独立的运行来源和 runner，`readOnlyRun` 只对“她自己定的跟进”返回 true；主人建的任务用可写提示词（或直接复用现有 `task.run` 执行路径）。加一条测试：主人建的任务能写、她自己定的跟进不能写。

### 高 5. “主人明说”的出处校验可被外部内容绕过

**问题**：方案把“主人明说”的凭据定为“任务说明所在的那次运行确实由主人消息触发”。这不够：主人消息触发的一轮可以读一封恶意邮件，模型读完邮件后自己建一条任务；这次运行确实由主人消息触发，但任务内容不是主人要的。把它标成 `run_source_owner_approved_task`，外部内容就借模型的手拿到写权限。方案说“是不是‘主人要的’这个意思由模型判断、程序校验出处”，但模型判断不能当安全边界。

**证据**：
- 方案原文：“主人明说的凭据是那条主人消息的编号，建的时候程序核对任务说明所在的那次运行确实由主人消息触发”。
- `packages/application/src/rules/action-rules.ts:249`：`... && !("run_source_owner_approved_task" in facts)`；一旦带上这个事实，`refuseBackgroundAfterExternalContent` 不再拒绝。
- `docs/adr/0278-...md:47`：决定 2 说“任务说明本身是主人看过全文后同意的，所以不算外部内容”。模型自己建的任务没有经过主人看全文，不适用。
- `apps/agent-service/src/owner-scope-authorization.ts:260`：`const eventIsExternal = source.sourceType === "external_event" && !source.ownerApprovedTask;`。

**建议**：只认两种出处：(a) 任务文本逐字出现在主人那条消息里；(b) 主人同意过一条包含该任务全文的提议。模型自己归纳出的任务一律按提议处理，主人点头后才可写。加反向测试：主人消息触发的一轮读了夹带指令的邮件并建任务，任务必须是只读/待提议。

### 高 6. 她自己的跟进不是“规则一律拒绝写”：非外部内容的 schedule 运行会被预先放行

**问题**：方案说“她自己想到的事，到点只看不动……写操作被规则直接拒绝”。现有内置规则并不是这样：`preauthorizeOwnerData` 只检查动作类型、风险、可逆、披露、收件人、是否有外部内容，不检查 `run_source`；它的示例里 `run_source_schedule` 明确期望 `true`。只有 `refuseBackgroundAfterExternalContent` 才要求 `context_external_content`。所以一个不带外部内容的自建跟进，如果走了非 think 的运行来源，写主人数据会被预先放行。

**证据**：
- `packages/application/src/rules/action-rules.ts:82-87`：`'action_kind == "CREATE_OR_UPDATE" && risk == "MEDIUM" && reversible == 1 && disclosure == "none" && recipient_count == 0 && !("context_external_content" in facts) && ...'`，没有 `run_source`。
- `packages/application/src/rules/action-rules.ts:96`：示例 `deterministicFacts: [{ code: "run_source_schedule" }, ...]` 期望 `true`。
- `packages/application/src/rules/action-rules.ts:249`：拒绝规则要求 `"context_external_content" in facts`。

**建议**：不要用“规则会拒绝”来保证自建跟进只读；真正依靠工具层只读（`readOnlyRun`），或新增一条“自建跟进/非主人发起不得写”的内置规则并加测试。测试要覆盖“没有外部内容”的自建跟进也不能写。

### 高 7. 新的“告知”推送沿用 `kind:"reminder"` 会被 `#content` 当成记忆提醒而静默过期

**问题**：方案说“推送种类这一列不加新值，沿用‘提醒’，靠来源键的前缀区分”。但 `production-web-push.ts` 的 `#content` 对 `kind: "reminder"` 有一个兜底分支，任何不匹配 `muse-channel:`、`proposal:`、`proactive:` 的提醒都按“记忆提醒”处理：它用 `sourceRef` 去 `reminders.read`，读不到就返回 `{ expired: true }`。告知如果用 `sourceKey: "told:..."`、`sourceRef: <告知编号>`，就会走进这个兜底，静默过期，手机永远收不到。

**证据**：
- `apps/agent-service/src/production-web-push.ts:855-886`：`if (item.kind === "reminder") { const reminder = await this.#options.reminders.read(item.sourceRef); if (!reminder || ... ) return { expired: true }; ... }`。
- 方案原文：“推送种类这一列不加新值，沿用‘提醒’，靠来源键的前缀区分，免得改三张表的约束。”

**建议**：在 `#content` 里加 `told:` 分支，从告知表读句子并构造标题/正文；同时把新推送分类加进 `pushClassOf`、`DELIVERY_TIMING_CLASSES`、`data-export/rules.ts` 的标签。加一条“告知推送不会被判过期”的测试。

### 高 8. ADR 0278 决定 6 明确排除定时任务，方案没有说要改它

**问题**：ADR 0278 决定 6 原文：“想一想自己的运行、定时任务和其他外部事件运行不带这个标记，规则不变，读到外部内容后照旧直接拒绝。”方案要把 `run_source_owner_approved_task` 扩到“主人明说建的、状态是生效的定时”，这是直接修改决定 6。方案只在“还没核实”里说“编码线程写 ADR 时要单独过方案审核”，没有在方案里写明要 supersede/amend 哪一条。

**证据**：
- `docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:51`：决定 6 的原文。
- `packages/persistence-sqlite/src/sqlite-thread-operations.ts:1528-1533`：`ownerApprovedTask` 只在 `t.source_type = 'external_event'` 且来源凭据以 `proposal:<accepted task.run id>:` 开头时为真。

**建议**：新开 ADR 明确取代/修订 ADR 0278 决定 6，并同步改 `readRunExecutionSource` 的 SQL、`readOnlyRun`、提示词和测试。不要只在代码里“扩成也认”。

### 高 9. 审批回答走收件箱会受排队/延迟/拒绝影响，可能过期或丢失

**问题**：方案说审批回答也进收件箱，“工人交给现有的续跑逻辑”。但审批是有期限的，收件箱是统一排队、有上限的；如果审批回答排在邮件后面或收件箱满，运行可能已过期，或者回答被 `submit` 拒绝而丢失。方案对审批回答没有保留名额、优先级或失败兜底。

**证据**：
- `apps/agent-service/src/production-web-push.ts:369-372`：审批只在 `approval.status === "pending" && Date.parse(approval.expiresAt) > Date.parse(now)` 时列出，过期就不处理。
- `packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:197-211`：统一排队/每日上限。
- 方案原文：“你发的消息、你的审批回答……不过这道判断，一定处理。”

**建议**：审批回答走最高优先级通道（或独立队列），不占邮件名额；`submit` 失败直接走现有审批接口；加“收件箱满 + 审批临近过期仍能生效”的测试。

---

## 证实的中等

### 中 1. “老对话只有新对话有这个工具”是错的

**问题**：方案第 2 节写“工具定义按对话冻结，所以只有新对话有这个工具；验收用新对话”，但第 5 节又写“老对话在下一轮开始时会按规则换新一次请求开头”。后者才对：`promptBundleChange` 在工具名集合变化时返回 `tool_set_changed`，老对话下一轮会重建一次。

**证据**：`packages/application/src/services/thread-prompt-bundle-service.ts:89`：`if (!sameNames(record.identity.toolNames, identity.toolNames)) return "tool_set_changed";`。

**建议**：统一写成“老对话下一轮换新一次，之后稳定”，并加一条“老对话只换新一次”的测试。

### 中 2. “系统提示不动”与“新对话的提示词”改名冲突

**问题**：方案开头说改名包含“新对话的提示词”，第 5 节又说“系统提示不动”。如果“新对话的提示词”会改到系统提示，新对话的系统提示字节就变了；老对话仍按冻结字节。方案应明确到底改了哪一段提示词、对哪些对话生效。

**证据**：方案开头“仓库里的改名（词表加一行、设置页三种语言的文案、现行文档、新对话的提示词）”；第 5 节“系统提示不动”。
**建议**：列出要改的提示词条目（系统提示 / 后台任务提示 / 工具说明），并分别说明“新对话生效”还是“老对话一次换新”。

### 中 3. “同一件事最多响一次”需要的共同起因编号没有存在现有推送行上

**问题**：方案说“收件箱条目、提议、告知、推送都带同一个‘起因编号’”。现有推送行只有 `sourceKey`、`kind`、`sourceRef`、`threadId`：邮件推送的 `sourceKey` 是 `proactive:${push.id}`、`sourceRef` 是 `push.id`，不是邮件或收件箱的编号。要判断“这封邮件已经推过”，必须额外查 `source_insights.push_source_key` 或给推送行加字段；方案没有写。

**证据**：
- `packages/application/src/ports/web-push.ts:33-42`：`WebPushOutboxItem` 没有起因编号字段。
- `apps/agent-service/src/production-web-push.ts:441-451`：`sourceKey: \`proactive:${push.id}\``、`sourceRef: push.id`。
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:1194`：`UPDATE source_insights SET push_source_key = ?`。

**建议**：明确用 `source_insights.push_source_key` 做关联，或给推送行加 `origin_ref`；加一条“邮件已推送 → 由它引出的提议/告知不推送，只进首页”的端到端测试。

### 中 4. 新推送分类的消费者漏了 `DELIVERY_TIMING_CLASSES`、导出标签和 `#content`

**问题**：方案只说“加进延后判断的类别和降频的键里”。新推送分类至少还有四个消费者：`PUSH_CLASSES`、`pushClassOf`、`PUSH_RULE_PROTECTED_CLASSES`、`DELIVERY_TIMING_CLASSES`，以及 `data-export/rules.ts` 的 `PUSH_CLASS_LABELS` 和 `production-web-push.ts` 的 `#content`。漏掉 `DELIVERY_TIMING_CLASSES`，新告知不会被“忙时延后”；漏掉导出标签，导出里的规则说明会显示原始英文 key；漏掉 `#content`，推送会被当成记忆提醒（见高 7）。

**证据**：
- `packages/application/src/services/web-push-gate.ts:7-23`：`PUSH_CLASSES`、`PUSH_RULE_PROTECTED_CLASSES`。
- `packages/application/src/services/delivery-timing.ts:4-8`：`DELIVERY_TIMING_CLASSES`。
- `packages/persistence-sqlite/src/data-export/rules.ts:162-166`：`PUSH_CLASS_LABELS`。
- `apps/agent-service/src/production-web-push.ts:661,717`：`pushClassOf` 和 `DELIVERY_TIMING_CLASSES.includes(pushClass)`。

**建议**：一次性列出并更新所有消费者；加一条“新告知在忙时延后、连续忽略降频、导出有中文标签”的测试。这正是 [I-73](../../docs/incidents-and-gates.md#incidents) 说的“只在一端认”。

### 中 5. 新决策种类和“told”的文字自相矛盾，且缺 DB 参照表/导出 schema

**问题**：方案第 3 节先说“决策记录的结果用已有的 `told`”，后又说“给告知单独登记一个种类……不借用提议的 `told`”。两者只能选一个。若新增种类，除 TS 的 `DECISION_KINDS`/`DECISION_OUTCOMES` 外，还要迁移 `decision_ledger_kinds`/`decision_ledger_outcomes` 的参照行、`validateLedgerWrite` 的输入校验、以及导出 schema 的 `enumOf(DECISION_KINDS)`。

**证据**：
- `packages/application/src/ports/decision-ledger.ts:32-102`：`DECISION_KINDS`、`DECISION_OUTCOMES`；`told` 在 `proposal` 下。
- `packages/persistence-sqlite/src/migrations/20261114172143_proactive_source_registry.sql:19-65`：`decision_ledger.kind` 外键到 `decision_ledger_kinds`，`(kind, outcome)` 外键到 `decision_ledger_outcomes`。
- `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:55-62`：`validateLedgerWrite` 用 `DECISION_KINDS`/`DECISION_OUTCOMES`。
- `packages/persistence-sqlite/src/data-export/schemas.ts:472`：`kind: enumOf(DECISION_KINDS)`。

**建议**：明确选“新增种类 + 结果值”，补迁移、TS 常量、输入校验、导出 schema；加一条“告知写入决策记录、导出再导入仍可读”的测试。

### 中 6. 新表没有进 schema catalog、删除、导出/导入；告知表没有保留策略

**问题**：方案只说了“你要的周期任务进导出、她自己的跟进不进导出”，但没有说新定时表、告知表如何进入 `schema-catalog.ts`、永久删除、数据导出/导入的 `EMPTY_TARGET_TABLES`，也没有说告知表的保留/清理。新表如果不进删除清单，主人“删除我的数据”不会删到它们；告知表不清理会无限增长。

**证据**：
- `packages/persistence-sqlite/src/schema-catalog.ts:429`：已有 `scheduled_jobs` 条目；新表需要同样登记。
- `packages/persistence-sqlite/src/data-export/import.ts:87-101`：`EMPTY_TARGET_TABLES` 是导入前必须为空的表清单。
- `packages/persistence-sqlite/src/sqlite-governed-deletion.ts`：按对象类型逐表删除；新表需要明确归属。
- ADR 0274 决定 1（`docs/adr/0274-...md:55`）：`think_inbox` 是临时队列、不进导出。

**建议**：把新定时表、告知表加入 schema catalog、删除 cascade、导出/导入清单（定时表按“谁建的”过滤），并给告知表定保留策略。加“导出再导入后主人建的周期任务还在、她自己的跟进不在”“删除全部数据后新表为空”的测试。

### 中 7. 告知表存整句话，可能复制已删除记忆/邮件的内容

**问题**：方案说告知表“只存她写的那句话（加密）和依据的编号……不抄记忆或邮件的原文；显示时按编号现取……这样记忆的删除和改动不会被告知里的副本绕过”。但“她写的那句话”本身可能引用/复述记忆或邮件原文；依据被删除后，句子还在，显示时仍会露出已删除内容。这个设计和“副本不绕过删除”的目标不一致。

**证据**：
- 方案原文：“告知表只存她写的那句话（加密）和依据的编号……不抄记忆或邮件的原文。”
- `docs/product-vision.md:59`：“记忆是所有决策的主要输入……我可查看、编辑与删除。”

**建议**：依据被删除时，删除或遮盖对应告知；或者告知只存模板/引用，不存自由文本；至少显示时按依据分类重新做出口遮盖。加“删除依据记忆后告知不再显示原文”的测试。

### 中 8. “多久没被你看过就自动暂停”没有字段支撑

**问题**：方案说周期任务“多久没被你看过就自动暂停并告诉你一声”，但定时表字段清单里没有“最后一次查看时间”。没有这个字段，调度器无法判断“没被看过”。

**建议**：加 `last_viewed_at`，在主人打开清单时更新；加自动暂停测试。

### 中 9. 空文本/纯图片消息会被 `THINK_SUMMARY_EMPTY` 拒绝

**问题**：`submit` 要求非空 `summary`，而聊天消息可能只有图片/附件没有文字；这种情况下收件箱会返回 `THINK_SUMMARY_EMPTY`，消息已存进对话但没有运行。

**证据**：`apps/agent-service/src/production-think-inbox.ts:157`：`if (summary.length === 0) return { accepted: false, reason: "THINK_SUMMARY_EMPTY" };`；`packages/application/src/ports/intelligence.ts:349-354` 支持 `images`。
**建议**：聊天消息允许用占位摘要或跳过摘要，或让 `summaryRef` 可空；加纯图片消息测试。

### 中 10. “来源编号用原值”与现有 256 哈希不一致

**问题**：方案说“来源编号用原记录自己的编号，不做摘要”。但 `production-think-actions.ts` 的 `sourceRef` 是 `kind:ref`，超过 256 会换成 `sha256:` 摘要；架构文档也写明“来源种类加编号超过 256 字……换成 SHA-256 摘要”。因此“从提议按来源编号查回原记录”在长编号上不成立。

**证据**：
- `apps/agent-service/src/production-think-actions.ts:22-45`：`bounded(...)` 超过上限换成 `sha256:...`。
- `docs/architecture-v0.1.md:437`：“来源种类加编号超过 256 字、来源版本超过 128 字时换成它的 SHA-256 摘要，好通过数据导出的长度校验。”
**建议**：如实写“长编号会被哈希，反查要用哈希”，或把来源编号单独存一份原值；加长编号的往返测试。

### 中 11. 去重键不含 `externalContent`，第一次提交的外部标记被冻结

**问题**：`entryKey` 只用来源种类、编号、版本；`externalContent` 不在键里。同一来源同一版本第一次以“非外部”提交，第二次即使传 `externalContent: true`，也会命中 duplicate 并返回旧行，外部标记不会更新。对于“外部标记跟着出处走”的记忆/感知/跟进，这是一个安全相关的缺口。

**证据**：
- `apps/agent-service/src/production-think-inbox.ts:76-81`：`entryKey(scope, kind, ref, version)`。
- `apps/agent-service/src/production-think-inbox.ts:223`：`externalContent: input.externalContent === true || source.externalContent`。
- `packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:179-188`：命中同一键直接返回 `duplicate`，不比较 `external_content`。

**建议**：把外部标记纳入去重键/版本，或在 duplicate 时更新该标记；加测试。

### 中 12. “每次到点有自己的状态”没有明确存储位置，“第几回尝试”与去重语义不清

**问题**：方案说“每一次到点有自己的状态：等着、已写进收件箱、办完、没办成、错过”，但定时表是“一行一条跟进/周期任务”，字段清单里没有每次到点的行/表。又说“去重键是定时编号、第几次、第几回尝试”，但 `entryKey` 只有 `sourceVersion` 一个版本字段，没有 attempt。若把 attempt 编进版本，每次重试都是新行，旧失败行会留下并占名额；若不编进去，重试会命中 duplicate，无法“换一回尝试重新写”。

**建议**：明确每次到点是独立行（可复用 `job_occurrences` 的模式），并定义 `sourceVersion = 第几次`、attempt 如何编码；加“失败后重试、达到上限暂停、只留最后一次成功”的测试。

### 中 13. 最近告知列表/邮件“最新一封”的顺序和重试生成没有冻结

**问题**：方案说把“最近已经告诉过主人的几件事”放进最后一条消息，但没有说排序键和重试时是否复用同一份。如果按时间排序且有并列，或重试时重新查询/重新生成，同一段文字在不同请求里可能变成不同字节。邮件“版本跟着这串里最新一封变”也有同样的并列风险。

**建议**：固定排序（时间 + 编号）；把最后一次运行的最后一条消息材料整体冻结/复用，不只冻结摘要；加“同一输入重试两次，最后一条消息逐字节相同”的测试。

### 中 14. `check:prompt-prefix` / `check-data-export` 的 REQUIRED 数没有更新，反向用例没有说明会在旧代码上失败

**问题**：新增 `[I-66]` 用例后，如果不同时改 `scripts/check-prompt-prefix.mjs` 的 `REQUIRED`，新用例等于没进门槛；新增导出测试同理。方案只列了验收场景，没有说测试文件、门槛计数和“改之前必须失败”。

**证据**：`scripts/check-prompt-prefix.mjs:10`：`const REQUIRED = 12;`；`scripts/check-data-export.mjs:19`：`const REQUIRED = 141;`。
**建议**：为每个高风险点指定测试文件，增加 `[I-66]`/`[DATA-EXPORT]` 用例并同步 REQUIRED；在 PR 说明里记录“改前失败、改后通过”。

### 中 15. `ThinkLoop` 没有 wakeup 接口，“写入即叫醒”没有实现点

**问题**：方案说“收件箱要加‘有新事件立刻处理’”，并引用聊天队列的 `wakeup`。但现在 `ThinkLoop` 只在 `start()` 后按定时器调度，`ProductionThinkInbox.submit` 没有回调唤醒它；如果不加接口，消息写进去后仍要等默认 60 秒。

**证据**：`apps/agent-service/src/production-think-composition.ts:79-118`：`ThinkLoop` 只有 `start`、`#schedule`、`stop`，没有 `wakeup`；`apps/agent-service/src/production-think-inbox.ts:134-180` 没有唤醒调用。
**建议**：给 `ThinkLoop` 加 `wakeup()`，`submit` 成功后调用；加一条“写入后立即开始处理”的延迟测试。

### 中 16. 提醒到点的两条路径可能重复或延迟

**问题**：现有 `production-web-push.ts` 每 10 秒 `listDue`，直接给提醒入队推送；`memory_reminders.status` 仍是 `scheduled`，靠推送 outbox 的 `sourceKey` 去重。方案又让调度器往收件箱写提醒事件、工人“固定直接推送”。如果旧循环不删，提醒会走两条路；如果删了，新的调度器/工人必须保持 10 秒内的延迟，否则比现在慢。

**证据**：
- `apps/agent-service/src/production-web-push.ts:28`：`DEFAULT_INTERVAL_MS = 10_000`。
- `apps/agent-service/src/production-web-push.ts:373-380`：`listDue`；`:572`：`listDue`。
- `packages/persistence-sqlite/src/sqlite-web-push-operations.ts:281`：`ON CONFLICT ... DO NOTHING`。
- `packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:128`：`status = 'scheduled'` 不会被推送标记。

**建议**：二选一：保留现有提醒推送循环，收件箱只记一条可观测事件；或让收件箱工人用完全相同的 `sourceKey` 入队，并删除旧的提醒 `listDue` 分支。加“到点 10 秒内收到、只响一次”的测试。

---

## 推测 / 未核实（需要编码前确认）

1. **`session.steer()` 在审批暂停、结果未知状态下的行为**：方案引用仓库的 Pi 规范，但没打开上游文档；`session.steer()` 是否把消息持久化成普通 `thread_messages`、是否经过 `<himawari-context>`/`<owner-message>` 包装、是否影响迟到结果恢复，未核实。若不是，方案的“每条消息单独存”和“每轮变的值在最后一条”都不成立。
2. **提议在 iPhone 上到底从哪个页面显示**：前提 11 的首页来源没有提议；方案的第 1 步验收依赖一个可能不存在的界面，未核实。
3. **`coding_workflow` 执行的代码能否读到服务进程里的 Gmail 访问令牌**：方案自己列为未核实。在给主人建的定时任务开放写工具之前必须先核；否则 `coding_workflow` 的写工具可能成为凭据读取面。
4. **后台运行能不能读到邮件全文**：方案说先看真实邮件效果。如果读不到，后台运行的提议只能基于摘要，风险/准确性都不同。
5. **生产上 `think_inbox` 现在是否为空**：方案打算改名/加列；如果已有数据，改名/加列的迁移和导出/删除闸门影响更大，未查。
6. **不同对话现在能同时跑几个运行**：方案说“同一对话一次运行”，但不同对话的并发/资源上限没有读；调度器 + 收件箱工人 + 现有派发在同一进程里的互相影响未实测。
7. **邮件检查/感知抽取的准确提交点**：方案承认 DeepSeek 给了位置但线程没打开核对；编码前必须读。
8. **新记忆“存下来”的全部路径**：方案承认没读完；如果漏掉一条路径，收件箱就不是“所有新记忆都进来”。

---

## 侧重检查

我按“错误路径、不合规范/不可信输入、安全、资源耗尽、不可撤销操作、规则/文档/代码一致性”查了这些：

- **错误路径**：
  - 用户消息被 `queue_full`/`daily_limit` 拒绝且无兜底：**证实（高 1）**。
  - 消息与收件箱两次写之间崩溃丢轮：**证实（高 2）**。
  - 空文本/纯图片消息被 `THINK_SUMMARY_EMPTY` 拒绝：**证实（中 9）**。
  - 审批回答排队/过期/被拒：**证实（高 9）**。
  - 提醒到点两条路径重复/延迟：**证实（中 16）**。
  - 调度器重试与去重语义不清：**证实（中 12）**。
  - 失败/过期条目重试后旧行占名额：**证实（中 12）**。
  - “停止”按钮在没有运行（消息还在收件箱）时的行为：**未核实**；方案没有定义。
- **不可信输入**：
  - 邮件/网页内容作为外部内容：方案只把入口标记和运行外部标记分层，但“由这次运行读到的网页”是否算外部、告知是否只进首页，方案没有明确用运行的 `context_external_content` 而不是只用餐桌条目的标记；**推测有绕过风险**。
  - 主人消息触发的一轮读恶意邮件后建任务：**证实（高 5）**。
  - 告知句子引用已删除记忆：**证实的设计缺口（中 7）**。
  - 外部标记去重冻结：**证实（中 11）**。
  - 新推送内容走 `#content` 兜底：**证实（高 7）**。
- **安全**：
  - 自建跟进写操作并非规则一律拒绝：**证实（高 6）**。
  - `readOnlyRun`/提示词阻止主人建的任务写入：**证实（高 4）**。
  - `ownerApprovedTask` 的 SQL/ADR 冲突：**证实（高 8）**。
  - `coding_workflow` 令牌隔离：**未核实**；在开写工具前必须核。
- **资源耗尽**：
  - 收件箱队列/每日上限吞消息：**证实（高 1）**。
  - 告知表无保留策略：**证实（中 6）**。
  - 每次到点无独立状态行，失败重试可能堆积：**证实（中 12）**。
  - 定时任务只限次数、不限单次成本：方案明确沿用 ADR 0076“只记账不拦”；按项目现行决定可以接受，但“愿景原则 8 超限即停”在单次运行成本上并没有真正落实，**属于取舍，不是 bug**。
- **不可撤销操作**：
  - 审批/拒绝被延迟：**证实（高 9）**。
  - 停止按钮在无运行时的行为：**未核实**。
  - 定时任务撤销后旧进度/旧载荷删除失败：方案没有失败处理；**推测会留下残留**。
  - 删除依据记忆后告知仍显示：**证实（中 7）**。
- **规则/文档/代码一致性**：
  - ADR 0274 决定 5（工人一次处理一条）与批处理冲突；决定 6（只给读工具）与主人建任务可写冲突；决定 8（不改授权规则）与 `ownerApprovedTask` 扩展冲突：**证实**，方案没有逐条列出要改的 ADR。
  - ADR 0278 决定 6 明确排除定时任务：**证实（高 8）**。
  - ADR 0184 的降频只覆盖主动邮件、键是 `due:<域名>`，不是通用推送分类；方案说“加进降频的键里”过于轻描淡写：**证实**。
  - ADR 0273 的延后类别只列了 `scheduled_reminder`、`run_result`、`mail_reminder`；新增告知要同时改 `DELIVERY_TIMING_CLASSES` 和 ADR 列表：**证实（中 4）**。
  - 方案内部矛盾：老对话工具、系统提示不动、来源编号用原值、`told` 借不借用、重试去重键：**证实**。

---

## 如果由你来定，我会怎样改这份方案

### 总体

不要把它当成“一个 PR 把用户消息也搬进收件箱”。拆成“先把外部来源接进现有收件箱”和“再设计聊天批处理”两件事；聊天那一半在事务、投影、提示词、工具权限四层没有定稿前不要动主流程。

### 我会采用的顺序

1. **第 0 步：补现有收件箱的地基，不改聊天主流程。**
   - 给 `ThinkLoop` 加 `wakeup()`，`submit` 成功后唤醒。
   - 给收件箱加来源优先级/预留名额（邮件、定时、审批分桶），并给用户消息留独立通道。
   - 给 `ThinkSource` 加“是否过值不值得判断”的标记，修 `#decide` 只对外部来源调用。
   - 把 `think_inbox` 的 `summary_ref` 改成可空（或允许纯引用），让不依赖摘要的来源不必写重复载荷。
   - 加去重/外部标记/长编号/空消息的测试。

2. **第 1 步：只接邮件来源。**
   - 邮件检查写库后 `submit`，来源 `mail`，外部标记真，过值不值得。
   - 提议/推送带上统一 `origin_ref`；先用 `source_insights.push_source_key` 做“同一件事最多响一次”。
   - 保留邮件自己的提醒和推送，不让后台运行替代它。
   - 加“广告邮件不提议、重复读到只有一行、已推送的邮件提议只进首页”的测试。

3. **第 2 步：聊天消息——先不要搬进收件箱。**
   - 保留 `admitOwnerMessage` 的原子事务和现有派发；在同一个事务里额外写一条“收件箱事件/唤醒行”，只为可观测和后续批处理，不改变运行来源。
   - 如果一定要“所有运行从收件箱开始”，就把“消息 + 收件箱行 + 运行”做成一个事务，并让 worker 从收件箱取；不要先存消息再写收件箱。
   - 批处理二选一：
     - (a) 保持一条消息一轮，后续消息用 `session.steer()`；改系统提示/任务边界，明确“同一轮里追加的用户消息都是当前请求”；验证 `session.steer` 的持久化和上下文块。
     - (b) 真做批量 turn：一次运行对应多条当前消息，改 `runs`/`turns`/`thread_messages`、`RuntimeProjection.prompt` 和系统提示；这是大改，单独 ADR。
   - 加“连发三条只回一条、三件都办”“中途追加改要求”“审批暂停时追加不越过审批”“停止按钮在未开跑时也能取消”的测试。

4. **第 3 步：跟进和周期任务。**
   - 建议复用 `scheduled_jobs`/`job_occurrences` 的模式（或新表但照抄它的 occurrence 状态机），不要只做“一行一条任务”而没有每次到点的行。
   - 字段补齐：`creator`（主人明说/她自己/主人同意的提议）、`last_viewed_at`、`trigger_count`、`last_progress_ref`、`cost_micros`、`expires_at`、`revision`。
   - 调度器/收件箱各自单飞、限量；失败重试写独立的 occurrence 行；达到上限暂停并告知。
   - **主人建的任务用独立运行来源 + 可写提示词 + `readOnlyRun=false`；她自己定的跟进继续走 think 只读。** 不要靠 `preauthorizeOwnerData` 或“规则会拒绝”来保证只读。
   - `owner_approved_task` 的出处只认“任务文本逐字在主人消息里”或“主人同意过含全文的提议”；模型自建一律按提议。
   - 新表加入 schema catalog、删除 cascade、导出/导入；主人建的进导出，自建的不进；告知表加保留策略。
   - 新开 ADR 修订 ADR 0278 决定 6 和 ADR 0274 决定 5/6/8。

5. **第 4 步：告知。**
   - 新表 + 新决策种类 + 新首页来源 + 新推送分类。
   - 推送分类要同时改 `PUSH_CLASSES`、`pushClassOf`、`PUSH_RULE_PROTECTED_CLASSES`、`DELIVERY_TIMING_CLASSES`、`data-export/rules.ts` 标签、`#content` 分支、ADR 0273 列表。
   - 外部告知只进首页；告知的依据被删除时删除/遮盖告知；告知显示前按分类再做一次遮盖。
   - 加“告知推送不被判过期、忙时延后、连续忽略降频、删除依据后不显示原文”的测试。

6. **第 5 步：感知、新记忆、审批回答。**
   - 审批回答走最高优先级独立通道，不占邮件名额，失败直接回退现有审批接口。
   - 感知/记忆的来源编号、外部标记、摘要/引用在编码前逐个读代码确认。

### 必答问题逐条回答

**1. 这个改动会不会改变模型已经见过的请求开头？**

会，分三种：
- **新增两个聊天工具**：工具定义在请求最前面；老对话下一轮会因 `tool_set_changed` 重建一次请求开头，之后稳定。方案第 2 节“只有新对话有工具”是错的，第 5 节“老对话换新一次”是对的。依据：`packages/application/src/services/thread-prompt-bundle-service.ts:89`；`.agents/instructions/prompt-prefix.md` 第 6 条。
- **“新对话的提示词”改名**：如果改到系统提示正文，新对话的系统提示字节变化；老对话仍按冻结字节。方案第 5 节“系统提示不动”与开头“新对话的提示词”冲突，需要明确改的是哪一条。
- **后台运行的动作清单**：每次后台运行都是新对话，不影响任何已有对话的开头；`ThinkActionRegistry.list()` 按动作名排序，同一版本内字节稳定。依据：`apps/agent-service/src/production-think-runner.ts:77`、`:95`。
- **聊天批处理**：如果只是把新消息追加在历史末尾、把本轮可变资料放在批量的最后一条消息里，已发内容仍然只追加；但现在的 `RuntimeProjection` 只有一个 `prompt`，系统提示又说“历史是背景”。把前两条放进历史会让模型不把它们当本轮请求；把三条拼进 `prompt` 又违反“不拼接原话”。方案必须明确批量的投影方式，否则“只在末尾追加”只是字节层面成立、语义层面不成立。依据：`packages/application/src/ports/intelligence.ts:349-354`、`packages/prompt-catalog/src/chat.ts:278`、`context-formation-service.ts:556-559`。
- **中途 `steer`**：追加的是新消息，前面的字节不变；但旧的 `<himawari-context>`（含本轮时间）留在较早的消息里，新消息成为最后一条，严格说“每轮会变的值都在最后一条消息里”不再成立。需要明确是接受这一点，还是在新消息里补一个只含时间的上下文块。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

有这个风险，主要在：
- “最近已经告诉过主人的几件事”按时间排序，若没有并列的稳定 tie-breaker，数据库返回顺序可能不同；同一秒的多条告知会变换顺序。需要固定 `ORDER BY ... , id`。
- 邮件“版本跟着这串里最新一封变”如果用时间戳而不是 message id，同一时间的两封会不稳定；应使用唯一的 message id。
- 重试时如果重新查询/重新生成“最近告知/做到哪/任务说明”，最后一条消息的字节会变；方案只说摘要生成一次，没有说整段最后消息材料冻结。应把一次运行的最后一条消息材料整体冻结并复用。
- `externalContent` 的去重键不含标记，第一次提交的标记会冻结；同一来源同一版本在不同请求里可能带/不带“外部内容”说明。应把标记纳入键或更新。
- 动作清单按动作名排序、来源说明是静态的、摘要写入前 clip 并存储，这些是确定的，没问题。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

方案列了很多验收场景，但没有把每个高风险点落到测试文件和门槛上。需要补：
- 队列/每日上限、收件箱满、纯图片消息、审批临近过期：失败路径测试。
- 两次写之间崩溃的故障注入测试。
- 连发三条只回一条、三件都办；中途追加改要求；审批暂停时追加不越过审批；停止按钮在未开跑时取消。
- 主人建的任务能写、自建跟进不能写；主人消息触发的一轮读恶意邮件后建任务必须只读/待提议。
- 告知推送不被 `#content` 判过期；忙时延后；连续忽略降频；外部告知只进首页。
- 删除依据记忆后告知不显示原文；导出再导入后主人建的任务还在、自建跟进不在。
- 新增 `[I-66]` 用例后同步 `scripts/check-prompt-prefix.mjs` 的 `REQUIRED`（现在是 12）；新增导出测试后同步 `scripts/check-data-export.mjs` 的 `REQUIRED`（现在是 141）。
- 每个反向用例在旧代码上必须失败，PR 说明里记录“改前失败、改后通过”。现有 `check:prompt-prefix` 的反向用例只证明检查器能发现断裂，不证明新功能的反向路径；新功能的负向用例要单独写。

**4. 每个值，使用它的地方都能接受吗？**

不能，方案漏了这些两端核对：
- **新工具**：产生处是 runtime tools / prompt catalog；使用处还有 `service-main.ts` 的 `readOnlyRun`、`isThinkRunSource`、动作登记表、动作规则、`check:prompt-prefix` 的工具集合。方案只提了“动作登记表和提示词目录”，漏了 `readOnlyRun` 和 `THINK_RUN_TASK` 的“不能写”。
- **新推送分类**：产生处是 `PushClass`；使用处有 `pushClassOf`、`PUSH_RULE_PROTECTED_CLASSES`、`DELIVERY_TIMING_CLASSES`、`data-export/rules.ts` 的标签、`production-web-push.ts` 的 `#content`、ADR 0273 的类别列表。方案只提了“延后判断的类别和降频的键”。
- **新决策种类**：产生处是 TS `DECISION_KINDS`/`DECISION_OUTCOMES`；使用处还有 DB `decision_ledger_kinds`/`decision_ledger_outcomes`、`validateLedgerWrite`、导出 schema `enumOf(DECISION_KINDS)`。方案提了参照表，但没提导出 schema 和输入校验。
- **新表**：产生处是 scheduler/worker；使用处有 `schema-catalog.ts`、`sqlite-governed-deletion.ts`、`data-export/import.ts` 的 `EMPTY_TARGET_TABLES`、导出 schema/manifest、保留策略。方案只说了导出，没说删除和 schema catalog。
- **批量消息**：产生处是 inbox worker；使用处有 `triggers`/`runs`/`turns`/`thread_messages`、`context-formation-service` 的 prompt=trigger 校验、`RuntimeProjection` 的单 prompt、系统提示的“最后一条消息才是本轮请求”。方案没有逐个核对，且“运行怎么执行不动”与代码相反。
- **`owner_approved_task`**：产生处是 `readRunExecutionSource` 的 SQL；使用处有 `owner-scope-authorization.ts` 的外部标记、`action-rules.ts` 的拒绝/询问、`readOnlyRun`、提示词。方案只看了规则，漏了 `readOnlyRun` 和提示词。
- **来源编号/版本**：产生处是各来源/调度器；使用处有 inbox 的 256/256 校验、`production-think-actions.ts` 的 256/128 哈希、导出 schema 的长度校验。方案说“编号用原值”，与长编号哈希不一致。
- **新设置键**：产生处是 `THINK_SETTING_DEFINITIONS`；使用处有 `THINK_SETTING_TEXT`（三语）、`THINK_SETTING_UNIT_TEXT`、gateway 快照、手机设置页。方案说“少一项编译不过”，这条是对的；但还要确认新键的 `minimum`/`maximum`/`defaultValue` 和单位都登记。

用一句话收尾：这份方案“事件收件箱”的方向是对的，但“把聊天消息也搬进去”不是接线，而是重做聊天受理的事务模型、上下文投影、系统提示和工具权限；在把这四层的契约和测试定下来之前，不要按现在的方案直接实施。
