## 结论

这个 PR 确实只改文档，没有改代码；7 份被取代 ADR 的 frontmatter 改动也与作者说法一致。但规格里“现在代码怎样”的若干说法、以及规格自身的设计，与代码/项目规则有实质冲突。下面按严重度列出；每条都标了是读代码证实的，还是设计推断。

## 侧重检查

- **错误路径**：查了 `runs.trigger_id UNIQUE` 与“失败运行重试复用同一 trigger”的冲突（见意见 7）；查了收件箱 `enqueue` 的排队/每日上限和 `recoverStalled`；查了提醒兜底写消息的去重思路（规格自己写了，未发现反例）；审批暂停、5 分钟截停、`session.steer()` 的真实行为规格自己列为未核实，我没有继续读 Pi 源码。
- **不可信输入/安全**：查了外部事件以 system 消息进入主对话时是否设置 `context_external_content` 事实（见意见 3）；查了感知内容以 system 消息进入主对话是否违反 `perception-read` 结构规则（见意见 4）；查了同意卡片的回答在现有代码里是 `external_event`（见意见 9）；查了“以后都行”能否覆盖删除（见意见 10）；查了推送去重键长度（见意见 6）。
- **资源耗尽**：查了收件箱排队/每日上限被删除、子线程数量无上限、费用上限只约束花钱不约束队列/磁盘/上下文（见意见 8）。
- **不可撤销操作**：查了“上线删全部旧对话”（Andy 已明确同意，规格也写明后果）；查了“以后都行”覆盖删除（见意见 10）；查了失败重放时对外动作的去重（规格自己列为未核实）。
- **规则文件、说明文档和代码一致**：查了 ADR 0257 被实际修改却未列入 `amends`/`supersedes`（见意见 5）；查了 `amends`/`amended_by` 双向元数据（见意见 12）；查了 `memories` 表名、`rule-types.ts:293` 行号、`check:prompt-prefix` 的 `[I-66]` 标签（见意见 13-15）；查了表改名对 `schema-catalog` 的影响（见意见 16）。

## 意见

### 1. 高：新增“她的话”推送会在现有推送闸门里落到 `unknown`，既绕过安静时段，也可能被 kind 白名单拒绝

文件:行：`packages/application/src/services/web-push-gate.ts:7-23,28-40`；`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:30,167-176,309-321`；`packages/persistence-sqlite/src/migrations/0058_web_push.sql:26`；规格 338、584 行。

问题：规格只说“新加的‘她的话’要加成第四种”并引 `rule-types.ts:47`，以及“推送种类 `web_push_outbox.kind`”。但实际链路上还有：`PUSH_CLASSES`、`pushClassOf`、`PUSH_RULE_PROTECTED_CLASSES`、`WEB_PUSH_KINDS`、`assertItem`、`readKinds`/`setKind`/`writeKinds`、`web_push_account_kinds` 的三个开关列、数据库 `CHECK`。只改 `rule-types.ts` 和 `web_push_outbox.kind` 不够。

证据（读代码证实）：
- `web-push-gate.ts:18-23`：`PUSH_RULE_PROTECTED_CLASSES = ["approval","muse_outage","proposal","unknown"]`。
- `web-push-gate.ts:28-40`：`pushClassOf` 对未匹配的 `kind`/`sourceKey` 返回 `"unknown"`；`production-web-push.ts:660-663` 对受保护类别直接放行，不走安静时段。
- `sqlite-web-push-operations.ts:30`：`const WEB_PUSH_KINDS = ["reminder", "approval", "run"]`；`:309-321` 的 `assertItem` 只接受这三个；`0058_web_push.sql:26` 的 `CHECK (kind IN ('reminder','approval','run'))`。

建议：把“她的话”同时加进 `PushClass`/`PUSH_CLASSES`、`pushClassOf`、`PUSH_QUIET_CLASSES`/默认受管类别、`WEB_PUSH_KINDS`、`assertItem`、`web_push_account_kinds` 与数据库 `CHECK`，并加两条测试：一条证明它默认受安静时段管，一条证明数据库和运行时校验都接受这个新 kind。这是 I-73 类“只改一端”的问题。

### 2. 高：推送采集仍会自动推提醒、运行完成、邮件、提议和 Muse，与“推不推由她定”冲突

文件:行：`apps/agent-service/src/production-web-push.ts:406-477`；规格 338-346、373、420、426 行。

问题：规格说“提醒到点……推不推到手机由她看情况定”“新邮件……推不推她定”“子线程跑完不再自动响”“提议由她决定说不说；Muse 断开作为事件进收件箱”。但采集器仍无条件把五类来源写进 outbox；只加“她的话”并只处理子线程，会继续出现程序自动推送，甚至同一件事推两次。

证据（读代码证实）：
- `:406-415`：`for (const reminder of reminders) items.push({ kind: "reminder", sourceKey: \`reminder:${reminder.id}:${reminder.remindAt}\` ... })`。
- `:430-440`：所有 finished runs 都 `items.push({ kind: "run", ... })`，没有按 `threads.origin` 排除子线程。
- `:441-451`：`proactive` 的邮件提醒直接入队；`:452-466` 提议直接入队；`:467-477` Muse 断开直接入队。

建议：明确列出这五条采集路径各自改成什么（删除、改为事件、或由“她的话”替代），并加反向用例：她决定不推时 outbox 没有对应行；子线程完成不产生 `run` 推送；主对话不会同时收到 `run` 和“她的话”两条。

### 3. 高：外部事件/感知以 system 消息进入主对话时，没有设置 `context_external_content`，权限可能直接放行写操作

文件:行：`apps/agent-service/src/context-external-content.ts:193-205`；`apps/agent-service/src/production-runtime-tools.ts:753-754,803-804`；`apps/agent-service/src/production-run-composition.ts:363`；`packages/application/src/rules/action-rules.ts:86,122,249`；规格 272、409、587 行。

问题：规格要求“外来的事一律用‘系统’身份存，不进 `<owner-message>`”，但没有说要在追加事件时调用 `ContextExternalContent.mark`。现有代码只在工具结果、主人附件、回忆到带标记的记忆、感知读取等路径设置这个事实；`preauthorizeOwnerData` 只看 `context_external_content` 是否缺席，不看 `run_source`。如果外部事件摘要只作为 system 消息存在而没有标记，一次由外部事件叫醒的运行或随后的主人消息可能被 `preauthorizeOwnerData` 直接放行。

证据（读代码证实）：
- `action-rules.ts:86`：`preauthorizeOwnerData` 的条件是 `... && !("context_external_content" in facts) && ...`，没有 `run_source` 条件。
- `action-rules.ts:122`：`askAfterExternalContent` 只有在 `"context_external_content" in facts` 时才命中。
- `context-external-content.ts:193-205`：`mark(runId, origin)` 是显式调用；现有调用点见 `production-runtime-tools.ts:753-754`（感知）和 `:803-804`（外部工具结果）、`production-run-composition.ts:363`（主人附件）。

建议：规格明确要求：外部事件入队时使用 `think_inbox.external_content`，worker 叫醒运行时调用 `mark(runId, <来源>)`；全文用工具打开时同样标记。加反向用例：一封带指令的邮件进入主对话后，主人再说一句模糊的话，不能在没有卡片的情况下写日历/删东西。

### 4. 高：感知经历以“系统送来的事件”进入主对话，与 `prompt-prefix` 的 `perception_read` 结构规则冲突

文件:行：`.agents/instructions/prompt-prefix.md:30`；规格 78、272、421 行。

问题：规则原文要求“设备感知到的内容（听到的话、网页、短信、屏幕上的字）只作为 `perception_read` 这一次调用的工具结果追加在末尾。不得把它放进系统提示、工具定义，也不得作为一条更早位置的消息插入”。规格却把“感知的每段经历进收件箱交给主对话”，并统一以“系统送来的事件”追加进主对话。如果 `perception.extract` 的输出仍算感知内容（按规则字面，算），这就是把感知内容放进了 system 消息，而不是 `perception_read` 的工具结果。

证据（读代码证实）：
- `prompt-prefix.md:30`：上述原文。
- 规格 421 行：“感知的每段经历进收件箱交给主对话”；272 行：“收件箱的事件以一条‘系统送来的事件’追加进主对话”。
- `packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 `[iOS-5]` 结构检查要求感知内容只能出现在最后追加的工具结果里（`prompt-prefix.md:76`）。

建议：编码前先决定：把感知事件做成 `perception_read` 的工具结果，还是由 Andy 明确批准一条新的例外并写进 ADR/规则。无论哪种，都加 `[iOS-5]` 结构反向用例：把感知内容放进 system 消息必须失败。

### 5. 高：ADR 0285 实际修改了 ADR 0257 的决定 3，却没有把 0257 列入 `amends`/`supersedes`，且冻结的规则 id 与界面文案未处理

文件:行：`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:141-148`；规格 402 行；`docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:5-7`；`test/tooling/rule-ids.frozen.json:6`；`apps/control-center/src/i18n/resources/zh-CN.ts:882`。

问题：ADR 0257 决定 3 的表格明确写“后台发起的一轮，上下文里有外来内容，想做有后果的事 | 不做，也不建等着的审批”。规格 402 行改成“所有运行都一样：问你”，这是对 ADR 0257 决定 3 的实质修改。但 ADR 0285 的 `amends` 只列 0230、0244，`supersedes` 也只列 7 份，没有 0257。另一个后果是内置规则 `action_refuse_background_after_external_content` 的 id 已冻结，界面文案还写着“不做”。

证据（读代码/文档证实）：
- ADR 0257 上述表格行。
- 规格 402 行：“现在后台运行读过外来内容后写操作直接拒绝（`action-rules.ts:249`）……改成所有运行都一样：问你。”
- `rule-ids.frozen.json:6`：`"action_refuse_background_after_external_content"` 已在冻结清单。
- `zh-CN.ts:882`：该 id 的文案是“后台读过外来内容后要做事：不做”。

建议：把 0257 加进 ADR 0285 的 `amends`，并在 0257 加 `amended_by`；明确是保留这个 id 但改 outcome（同时改 id 语义/文案，需按冻结清单流程），还是新增一条 ask 规则并保留旧规则不再命中。加一条规则注册测试。

### 6. 中：推送去重键“来源种类 + 来源编号 + 版本”可能超过 `source_key` 的 256 字符上限

文件:行：`packages/persistence-sqlite/src/migrations/0058_web_push.sql:25`；`packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:6-7`；`apps/agent-service/src/production-think-inbox.ts:151-154`；规格 341 行。

问题：规格用“来源种类 + 来源编号 + 版本”当推送编号，但 `source_key` 只允许 1-256；`source_ref` 本身可到 256，`source_version` 也可到 256，`source_kind` 还可到 64。简单拼接会在长来源时被数据库拒绝。规格的“编码时要逐个核对的新值”只写了 `web_push_outbox.kind`，没有写长度。

证据（读代码证实）：
- `0058_web_push.sql:25`：`source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256)`。
- `20261115004401_think_inbox.sql:6-7`：`source_ref ... BETWEEN 1 AND 256`，`source_version ... <= 256`。
- `production-think-inbox.ts:151-154`：提交时同样允许 256/256。

建议：规定用哈希或截断加哈希生成固定长度 `source_key`，并保留可读的来源引用；加一条最大长度来源的集成测试，确认能入队且重放去重仍生效。

### 7. 中：失败运行“重试时用回同一 trigger”与 `runs.trigger_id UNIQUE` 冲突

文件:行：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:147`；规格 270、583 行。

问题：规格说“一次运行仍只对应一行 `triggers`……重试时用回同一行，不会多出一次运行”，又说“运行失败或服务中途挂掉，这几行回到待处理”。但 `runs.trigger_id` 是 `UNIQUE` 且引用 `triggers(id)`；一个 trigger 已经有一个失败 run 时，不能再为同一 trigger 建新 run。要么复用那个 failed run（无法继续跑），要么新建 trigger（与“用回同一行”矛盾，也会让收件箱行的“被哪次运行处理”变化）。

证据（读代码证实）：
- `0001...:147`：`trigger_id TEXT NOT NULL UNIQUE REFERENCES triggers(id) ON DELETE RESTRICT,`。
- 规格 270 行：“一次运行仍只对应一行 `triggers`……重试时用回同一行”。

建议：在规格里明确失败重试的模型：是允许同一 trigger 对应新的 run（需要改唯一约束/状态机），还是每次重试新建 trigger 并更新收件箱行；加一个“运行中途挂掉后重试”的集成用例，断言不会多出运行、也不会卡死。

### 8. 中：删掉收件箱排队/每日上限和子线程数量上限后，没有替代背压，外部来源可造成资源耗尽

文件:行：规格 98、147、255、371 行；`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:170-210`。

问题：规格明确“收件箱不设排队和每天上限”“开几个没有上限”。现有 `enqueue` 用 `queueLimit`/`dailyLimit` 拒绝并记 `declined`；删掉后，一封封邮件、感知记录或外部 agent 的提交可以无限增长收件箱、把大量事件合进一次运行、并无限开子线程。规格只靠“产品的花费上限”和子线程预算，但费用上限只能停止花钱，不能停止队列、磁盘和上下文增长。

证据（读代码/规格证实）：
- `sqlite-think-inbox-operations.ts:170-210`：`if (queued >= queueLimit) { ... return { outcome: "queue_full" }; }`、`if (accepted >= dailyLimit) { ... }`。
- 规格 98 行：“收件箱不设排队和每天上限”；147 行：“开几个没有上限”；255 行：“排队上限、每天上限、排久了自动作废（`expired`）都去掉”。

建议：保留某种硬背压：按来源的速率/积压上限、收件箱总行数上限、或“同一对话最多积压 N 条未处理事件”；达到上限时拒绝并告知，而不是无限排队。加一条“外部来源灌入大量事件”的资源测试。

### 9. 中：同意卡片回答的来源类别与现有代码的 `external_event` 不一致，影响 `owner-intent` 能否看到主人的话

文件:行：规格 261 行；`apps/agent-service/src/production-task-proposals.ts:154-155`；`docs/adr/0274-new-things-go-through-one-think-entrance.md:39`。

问题：规格把“你对同意卡片的回答”归为“你的”来源，但现有“同意过的任务”是用 `admitOwnerMessage({ triggerSource: "external_event", ... })` 启动的。规格没有说明同意卡片的回答在新收件箱里到底用哪个 `triggerSource`。如果用 `external_event`，它就不属于“你的”来源；`authorization.owner-intent-question` 只读主人亲口说的话，可能看不到这次同意。这不是说一定要改，而是规格必须明确，否则编码线程会按现有代码做出与权限表不一致的行为。

证据（读代码证实）：
- `production-task-proposals.ts:154-155`：`await commands.admitOwnerMessage({ triggerSource: "external_event", ... })`。
- 规格 261 行：“要么是你的（你的消息、你对同意卡片的回答）”。

建议：在规格里明确同意卡片回答的 `triggerSource`、它在 `<owner-message>` 里的表示方式，以及 `owner-intent` 是否应把它当作主人原话；加一条“子线程因同意卡片恢复后写操作”的权限测试。

### 10. 中：权限表允许“以后都行”覆盖删除，而删除是不可撤销的；花钱却只允许“只这一次”

文件:行：规格 398、403 行；`docs/product-vision.md:55`（规格 125 行引用）。

问题：规格的权限表把“发出去、删东西”放在同一行：“先问你，除非你给过范围内的‘以后都行’”；同意卡片可选“以后都行”，只有花钱限制为“只这一次”。愿景的裁决顺序是“用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率”。给删除一个永久/长期预授权，等于把不可撤销操作交给模型在以后自行执行，风险高于“发出去”这类可撤回/可补救的动作。

证据（读规格/愿景证实）：
- 规格 398 行：“发出去、删东西 | 先问你，除非你给过范围内的‘以后都行’”。
- 规格 403 行：“‘只这一次’……‘以后都行’；花钱只给‘只这一次’”。
- 规格 125 行引愿景：“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”

建议：把删除单独列出，要求至少“这件事里”或“只这一次”，或者明确在 ADR 里论证为什么永久预授权删除可以接受；加一条反向测试：给过“以后都行”的删除，在不可撤销动作上仍要卡片。

### 11. 中：“每个对话一开始就拿到全部工具”与“子线程里再开子线程不做”没有闭合

文件:行：规格 405、562 行；`apps/agent-service/src/production-runtime-tools.ts:601`（工具描述按 options 追加）。

问题：规格一方面说“每个对话一开始就拿到全部工具，能不能做由每次动作时的规则判断”，另一方面说“子线程里再开子线程：这一版不做，只有主对话能开”。如果“全部工具”包含“开子线程”，子线程就会拿到它；规格没有给出拒绝“子线程开子线程”的规则或按对话类型裁剪工具集的方案。同理，“告诉主对话”“交回结果”等工具出现在主对话里也没有说明。

证据（读规格/代码证实）：
- 规格 405 行：“每个对话一开始就拿到全部工具”。
- 规格 562 行：“子线程里再开子线程：这一版不做，只有主对话能开”。
- `production-runtime-tools.ts:601` 等位置按 options 追加工具描述，说明工具集本来就是按运行装配的，不是天然全局一致。

建议：明确主对话和子线程各自的工具集（在创建时冻结），或者明确一条“子线程调用开子线程一律拒绝”的动作规则；加一条反向测试：子线程调用开子线程不会产生新子线程。

### 12. 中：ADR 0285 声明 `amends` 0230、0244，但这两份 ADR 没有加 `amended_by`

文件:行：`docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:7`；`docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:1-9`；`docs/adr/0244-hard-rules-step4-unified-push-gate.md:1-9`；`docs/adr/0031-isolated-tool-execution.md:139`。

问题：项目约定是双向 `amends`/`amended_by` 元数据（ADR 0031 正文明确写“采用双向 `amends` / `amended_by` 元数据及正文范围链接”）。ADR 0285 加了 `amends`，但 0230、0244 的 frontmatter 没有 `amended_by`，后来的人只看被修改的 ADR 时不知道它已被 0285 部分修改。

证据（读文档证实）：
- ADR 0031 第 139 行原文：“采用双向 `amends` / `amended_by` 元数据及正文范围链接”。
- 0230、0244 的 frontmatter 只有 `amends`/`superseded_by`，没有 `amended_by`。
- ADR 0285 第 7 行：`amends: "docs/adr/0230..., docs/adr/0244..."`。

建议：给 0230 和 0244 加 `amended_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"`；如果 0257 也确认要修改，同样加。

### 13. 低：规格把 `memory_records` 写成了 `memories`

文件:行：规格 72 行；`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:401`。

问题：规格说“`memories.source_thread_id` 是 `ON DELETE SET NULL`”，但仓库里没有 `memories` 表；第 401 行属于 `memory_records`。这会让编码线程在删旧对话时找错表。

证据（读代码证实）：
- `0001...:401`：`source_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,`，所在的 `CREATE TABLE` 是 `memory_records`。
- 全仓库没有 `CREATE TABLE memories`（grep 无结果）。

建议：改成 `memory_records.source_thread_id`。

### 14. 低：`push_quiet_hours` 的行号写成 293，实际在 333

文件:行：规格 337 行；`packages/application/src/rules/rule-types.ts:333`。

问题：规格引“规则类型 `push_quiet_hours`，`rule-types.ts:293`”，但 293 行是 `pushQuietExpression` 的返回语句；`push_quiet_hours` 的注册在 333 行。虽然不影响理解，但属于“代码说法与代码不符”。

证据（读代码证实）：
- `rule-types.ts:333`：`pushQuietType("push_quiet_hours", ...)`。
- `rule-types.ts:293`：`return \`push_class in ...\``。

建议：把 293 改成 333。

### 15. 低：规格说把状态板加进 `check:prompt-prefix`，但没说要加 `[I-66]` 标签和 `REQUIRED` 名单

文件:行：规格 314、498 行；`scripts/check-prompt-prefix.mjs:8-11`。

问题：`check:prompt-prefix` 只运行带 `[I-66]` 标签的用例，并要求 `REQUIRED=12`、`REQUIRED_NAMES` 里四个 `[COMPACT-*]` 通过。规格只说“把状态板的生成放进 `npm run check:prompt-prefix` 的逐字测试”和“加这一条”，没有提醒编码线程给新用例打 `[I-66]` 标签；如果标签漏了，新用例根本不会跑。

证据（读代码证实）：
- `scripts/check-prompt-prefix.mjs:8-11`：`const TAG = "[I-66]"; ... const REQUIRED = 12; const REQUIRED_NAMES = ["[COMPACT-1]", ...]`。
- 规格 314 行、498 行只写了“放进/加这一条”。

建议：在规格里写明新用例必须带 `[I-66]`，并按现有做法更新 `REQUIRED`（必要时更新 `REQUIRED_NAMES`）；否则“加了测试”不等于“进了门槛”。

### 16. 低：表改名/删表需要同步 `schema-catalog`，且 SQLite 的 `ALTER TABLE RENAME` 不会自动改索引名

文件:行：规格 237-241 行；`packages/persistence-sqlite/src/schema-catalog.ts:800-818`；`packages/persistence-sqlite/test/migration-engine.contract.test.ts:80`。

问题：规格说“索引 `think_inbox_queue` → `inbox_events_queue`，跟着表名改”，但 SQLite 的 `ALTER TABLE ... RENAME TO` 不会重命名索引；需要 DROP/CREATE。另，`schema-catalog.ts` 里有 `think_inbox` 和 `think_inbox_declined` 两条目录项，契约测试会比较目录与实际表；改名/删表不改目录会失败。

证据（读代码证实）：
- `schema-catalog.ts:800-818`：`entry("think_inbox", ...)`、`entry("think_inbox_declined", ...)`。
- `migration-engine.contract.test.ts:80`：`expect(tables).toEqual(schemaCatalog.map(({ table }) => table).sort());`。

建议：规格里补一句“更新 `schema-catalog.ts`，删除旧索引并按新表名重建索引”；编码时跑 `packages/persistence-sqlite/test/migration-engine.contract.test.ts`。

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

- **PR 本身不会**：diff 只有文档和复核记录，没有代码；当前已发出的请求不会变。
- **规格的设计大部分是“只在末尾追加”**：状态板放在本次最后一条消息末尾；事件作为新消息追加；“她的话”和点选都是新消息；每轮会变的时间写成固定时刻/格式，事件用收件箱行编号。
- **但有两处不满足/高风险**：
  1. 规格 270 行要求“把这一轮处理的所有条都从历史里拿掉”。如果这些条中有已经被 `session.steer()` 发过、或失败运行已经发过的，下一次运行把它们从历史中间拿掉，就是在改写已发出的请求开头，违反 `prompt-prefix.md:36` 第 4 条。规格的“还没核实的事”只问了“会不会和数据库里那条重复出现”，没有问“拿掉会不会改变已发内容”。
  2. 感知事件以 system 消息进入主对话（规格 272/421 行），与 `prompt-prefix.md:30` “感知内容只作为 `perception_read` 工具结果追加”冲突（见意见 4）。
- **另一处是一次性换新**：第 3 步给已经在跑的主对话加待办/子线程工具，会改变冻结的工具集，从而改变主对话的请求开头。规则允许“工具集合变了”换新一次并留记录，但规格没有写这一步需要强制重建/记录；如果不重建，老主对话会继续用旧工具集，规格描述的行为就不会生效。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

- 规格明确要求时间写固定时区和格式、事件用收件箱行编号、状态板放进 `check:prompt-prefix` 的逐字测试，方向是对的。
- 但“子线程按‘属于哪件大事、开的先后’排”没有定义同一时刻的 tie-break；“最近一句进展”如果来自模型生成的文本，文本本身稳定，但排序若依赖数据库返回顺序，就可能不稳定。建议补一个固定排序键（大事 id、子线程创建时间、子线程 id）并加字节稳定测试。
- 压缩时重建记忆快照会改变开头，但这是压缩的一次性换新，规则允许；两次压缩之间记忆变化追加在末尾，规格也写了。清理旧工具结果同理是一次性换新，规格写了记录和“清完后的新开头”。这些不算“同一段文字不同字节”，但需要按 ADR 记录。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

- **这个 PR 没有**。它是纯文档 PR，没有新增或修改任何测试；规格里列出的正向/反向验收是后续编码步骤的验收标准，现在不存在，无法“真的失败”。
- 现有能覆盖新文档的只有 `check:docs-links`、`check:adr-numbers`、`check:markdown-tables`、`check:glossary` 等；我没有运行命令，未核实严格校验结果。
- 规格说“编码时加一个自动检查，用真实数据库把每个新值插一遍”，这个思路正确，但本 PR 没有这道门槛；I-73 的教训正是“只看了改动，没核对清单里的 id 能不能过后端校验”。
- `plan-claims` 复核记录在 `.agents/reviews/topic-event-inbox-wiring/`，当前环境读不到（git 对 records-path 拒绝），无法核实第 7 轮 73 条的说法。
- 如果后续把状态板加进 `check:prompt-prefix`，必须带 `[I-66]` 标签并更新 `REQUIRED`/`REQUIRED_NAMES`（见意见 15），否则新用例不会进门槛。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

**不能，规格的新值清单不完整。** 具体漏项：

- **“她的话”推送 kind**：只提了 `rule-types.ts:47` 和 `web_push_outbox.kind`，漏了 `PUSH_CLASSES`、`pushClassOf`、`PUSH_RULE_PROTECTED_CLASSES`、`WEB_PUSH_KINDS`、`assertItem`、`readKinds`/`setKind`/`writeKinds`、`web_push_account_kinds`、数据库 `CHECK`。漏了就会落到 `unknown`（受保护、绕过安静时段）或被拒绝（见意见 1）。
- **推送去重键**：`source_key` 最大 256，`source_ref`/`source_version` 各自可到 256；拼接会超长，规格没提（见意见 6）。
- **`threads.origin` 新值**：规格提了“所有读它的地方（起标题、到期删除、对话列表、导出）”，但漏了 `packages/domain/src/thread.ts` 的类型只有 `"think"`，以及 `sqlite-thread-operations.ts` 的映射和 `origin='owner'`/`origin='think'` 查询。加新值前要逐个确认。
- **`triggers.source_type`**：规格提了只允许三种，但没有说子线程消息、同意卡片回答分别用哪一种；现有“同意过的任务”用的是 `external_event`（见意见 9）。
- **`decision_ledger` 的 `proactive` 行**：规格提了场景/结果有值、`outcome` 为空，但实际还要求 `scenario` 是 1-64 位小写 ASCII、`reason_code`/`counts`/`inputs`/`checked_at`/`cost_micros`/`duration_ms` 都有值；规格正文用“邮件、提醒、感知”这些中文描述，编码时若照抄会违反 `scenario GLOB '[a-z]*'`。
- **内置规则 id**：`action_refuse_background_after_external_content` 在 `rule-ids.frozen.json` 里，改成 ask 不能简单改名/删除（见意见 5）。
- **表改名**：`schema-catalog.ts` 和索引名要同步（见意见 16）。

## 未核实

- `.agents/reviews/topic-event-inbox-wiring/` 下的复核记录和 `claims-verdicts.jsonl` 被 git 拒绝读取，无法核实“第 7 轮 73 条、70 条一致”的说法。
- 规格引用的 Anthropic/Meta/OpenAI/Google 原文、Claude Code 工具说明、Pi 子代理示例，我没有联网，全部未核实。
- 记忆线程方案在分支 `claude/project-thread-lq8dnz` 的 `205f1060`，当前仓库没有该分支，未核实。
- `session.steer()` 在审批暂停/结果未知时的行为、5 分钟截停是截工具还是等这一步、审批暂停运行现在怎么续跑，规格自己列为未读，我也未核实。
- 我没有运行 `validate_docs.py --strict`、`check:docs-links`、`check:adr-numbers`、`check:markdown-tables`，因此无法确认文档严格校验是否零新增错误。
