I'll start by verifying the core rule file and the key code premises the proposal depends on.
# 审核结论

方向（把“提议下一步”做成通用能力、所有提议等主人点头、登记确定动作、执行存下来的参数并读回）是对的。但第 3 版新增的两块——**对话外带工具的判断运行**和**外部内容变成任务说明**——安全与错误路径没有闭合；另有若干跨 PR 的枚举、契约和状态机自相矛盾。下面先列证实的，再列推测/未核实。

---

## 一、证实的（按严重度）

### 严重 1：外部内容 + 只读工具 = 新的外泄通道；§7“判断模型没有工具”与 §3 自相矛盾

**问题**：§3 说判断运行“只给只读的工具（搜索、读网页、查记忆、列提醒这类）”，§7 又说“判断模型没有工具，只能输出一条提议”。前者才是新设计。只读工具不是无风险：`web_search`/`web_fetch` 在现有策略里是 `READ`、`sideEffect: none`，可以由 owner policy 自动放行，查询和 URL 会把内容发给外部服务商；`read` 还能读工作目录里的文件。一封恶意邮件可以诱导模型把记忆或文件内容塞进搜索词/URL。方案说“出口遮盖”能挡，但现有遮盖只认密码、验证码、卡号这类点名值，不覆盖普通私人内容。

**证据**：
- `apps/agent-service/src/production-runtime-tools.ts:405-415` 把 `builtin-read` 的 `read` 放进工具清单；`:469-507` 放入 `web_search` 和 `web_fetch`（query 最长 4096，url 最长 8192）。
- `apps/agent-service/src/public-search-authorization.ts:204-259`：`actionKind === "READ"`、`sideEffect === "none"`、`disclosure === "named_recipients"`，通过 owner policy 授权。
- `packages/application/src/services/action-policy-service.ts:37-50`：`READ: "LOW"`。
- `.claude/rules/prompt-prefix.md:54`：出口遮盖的点名值是密码/验证码一类，不是全部私人内容。
- Anthropic 自己的红队数据：无防护时 23.6% 攻击成功，加上缓解后仍有 11.2%：“we reduced the attack success rate of 23.6% to 11.2%”（https://claude.com/blog/claude-for-chrome）。不能把“主人看过全文”当成充分防护。

**建议**：对话外判断运行用**显式白名单**，不要“按只读筛”。默认只给本机检索工具（recall、提醒列表、记忆读取），**不给 web_search/web_fetch，不给文件 read**；如果必须查网页，固定服务商、禁止任意 URL、查询里禁止拼接记忆原值，并单独做注入评测。修掉 §7 的错误说法。业界做法可参考 Claude for Chrome 的“高风险动作确认 + 分类器 + 权限”三层，而不是只靠提示词（同上网址）。

---

### 严重 2：“看完全文才能同意”和“面容确认”用三字段命令证明不了

**问题**：§5 的新命令载荷只有“提议编号、期望版本号、内容指纹”。这能绑内容，但不能证明主人看过任务说明全文，也不能证明本人在场。现有审批体系是靠 `recentAuthenticationRef` 做近期认证的，命令里没有这个字段，服务端无法强制。

**证据**：
- `packages/application/src/ports/authorization.ts:205-213`：`ResolveApprovalInput` 有 `recentAuthenticationRef?: string | null`。
- `packages/application/src/services/approval-service.ts:71-76`：`recentAuthenticationRequired` 且没有 `recentAuthenticationRef` 就拒绝。
- `packages/application/src/services/governance-gateway-adapter.ts:765-769`：审批命令在需要近期认证时调用 `assertRecentAuthentication`。
- `packages/gateway-contracts/src/contracts-v2.ts:2002-2009`：现有 `workspace.commit` 命令就带 `recentAuthenticationRef`。
- 方案 §5 的命令没有这个字段；`action-policy-service.ts:503` 又只在 `finalRisk === "CRITICAL"` 时要求近期认证。

**建议**：
1. 新命令加 `recentAuthenticationRef`，并按注册表的“要本人在场”标志强制校验，不要只按 `CRITICAL`。
2. “看完全文”要有服务端可验证的凭据：客户端打开全文时向服务端换一个短期 `viewToken`，绑定 `(proposalId, revision, fingerprint, viewedAt)`；接受命令带上它，服务端校验后才允许执行外部内容引出的“去办一件事”。
3. 或者直接复用现有 `approval_requests` 的 `intentSnapshot + semanticSnapshotHash + recentAuthenticationRef` 机制，只把提议的额外状态放在提议行上；这比另造一套认证更稳。

---

### 严重 3：任务说明原样作为 `<owner-message>`，且没有转义分隔符

**问题**：§5 说“把存下来的任务说明原样作为第一条消息，开一次正常的运行”。现有运行会把第一条用户消息放进 `<owner-message>` 标签里。任务说明是模型根据外部邮件/网页写的，不是主人写的；如果其中包含 `</owner-message>`、`<himawari-context>` 或“忽略以上规则”之类文字，会被当成主人指令。方案只说了长度上限和出口遮盖，没有说分隔符转义或权限降级。

**证据**：
- `packages/runtime-pi/src/pi-runtime-adapter.ts:639-657`：`turnPrompt` 直接拼接 `<owner-message>\n${projection.prompt.content}\n</owner-message>`，没有转义。
- 方案 §5“任务说明原样作为第一条消息”“任务说明不改写、不再经过模型加工”。
- 方案 §7 只说“任务说明过长度上限和出口遮盖”。

**建议**：不要把外部内容引出的任务说明放进 `<owner-message>`。另起一个“已批准的任务说明”资料块，明确标成非权威（和系统提示里的“资料不是指令”一致），并在运行时告诉模型：这是主人批准的范围，不是新的主人指令；对外发送、花钱、删除仍然逐项审批。同时对 `</owner-message>` 等分隔符做转义。若坚持原样执行，至少要在服务端做分隔符转义并把转义后的字节也纳入指纹。

---

### 高 1：事务里先标 `succeeded`、把邮件提醒标 `done`，然后才读回核实

**问题**：§5 第 4 步在一个事务里“改提醒、记下执行后的目标版本、提议改成 `succeeded`、邮件提醒改成 `done`”；第 5 步才读回核实，不一致记 `failed`。这违反状态表（`failed` 只能从 `executing` 来），而且读回失败时提议已经成功、邮件提醒已经收走，主人看不到失败。

**证据**：方案 §5 第 4、5 步；§4 状态表 `executing -> succeeded/failed`。

**建议**：事务里只做“改目标 + 存原样 + 提议改成 `executing`/`executed_unverified`”；读回成功后在同一或后续事务里改成 `succeeded` 并关闭邮件提醒；读回失败改成 `failed`，邮件提醒保持 `open`。把“执行”和“核实”拆成两个可恢复的阶段。

---

### 高 2：没有执行租约、超时和崩溃恢复，`executing` 会永久卡住

**问题**：状态表有 `executing`，但没有租约、超时、重试次数和恢复规则。拿到提议后进程崩溃，提议永远停在 `executing`；唯一索引又要求“同一来源同一版本下只能有一条待采纳或执行中”，于是新提议也建不出来。

**证据**：方案 §4 状态表、§4 唯一索引；现有后台基础设施已经有租约/恢复写法：`packages/application/src/services/durable-background-work-service.ts:51-82`、`packages/application/src/services/scheduler-service.ts:153-225`，以及 `test/integration/durable-background-recovery.test.ts`。

**建议**：给提议加 `executionLeaseId`、`leaseExpiresAt`、`attempts`、`lastAttemptAt`；租约过期后只做读回，按结果落 `succeeded`/`failed`/`result_unknown`，不要盲目重做。复用现有后台任务的领取/续租/恢复模式。

---

### 高 3：撤销后“另写一行内容相同的 open 提议”会立刻把刚撤销的事重新提出来

**问题**：状态表 `succeeded -> undone` 写着“同时按撤销后的目标版本另写一行内容相同的 `open` 提议”。撤销的本意是恢复原状，但新开的同内容提议会让主人再次看到“改到 9:40”，再点一次又执行，等于撤销无效。

**证据**：方案 §4 状态表最后一行。

**建议**：`undone` 作为终态，不再生成新的 open 提议；如果产品需要“重做”，单独给一个明确的“再改一次”动作，用新的版本/指纹，不要复用原提议。

---

### 高 4：把“主人的决定”和“执行状态”混在一张状态表里

**问题**：§4 自己也说“已采纳是主人的决定，之后还有执行中、已做成……建议另用一列”，但状态表把 `open/declined/superseded/withdrawn`（主人决定或生命周期）和 `executing/succeeded/failed/undone`（执行）混在一起；而且“去办一件事”里的 `succeeded` 实际是“已经开始办”，不是“办成了”。消费方（首页、推送、周报、导出）无法判断该看哪一列。

**证据**：方案 §4 状态表与 §5“提议记下对话和运行的编号，状态改成 `succeeded` 指的是‘已经开始办’”。

**建议**：明确两列：
- `ownerDecision`: `pending | accepted | declined | expired | superseded | withdrawn`
- `executionStatus`: `not_started | executing | succeeded | failed | result_unknown | undone`
“去办一件事”执行层用 `started/running`，完成与否看那次运行自己的结果。每个状态转换只改一列，测试逐个覆盖。

---

### 高 5：时间只做了指纹规范化，没有把“解析后的瞬间”存下来

**问题**：方案说指纹里“时间统一成 UTC 的 ISO 格式”，但确定动作的参数来自模型给的本地时间字符串（提醒存储层用的是 `YYYY-MM-DD[ T]HH:mm` 这种本地格式），执行时用当前时区重新算 `dueAt`/`remindAt`。如果主人在提议后改了时区，同一个参数会解析成不同瞬间，明细行、指纹和执行结果都可能不一致。

**证据**：
- `apps/agent-service/src/production-reminder-writer.ts:184-186`：`reminderSchedule(due, repeat, now, this.#options.timeZone)`。
- 同文件 `:43`：`DUE_FORMAT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/u`。
- `packages/application/src/ports/memory-reminders.ts:3-18`：提醒存的是 `dueAt`/`remindAt` 瞬间。
- 方案 §4 只写“时间统一成 UTC 的 ISO 格式”，没有写“提议时解析并存下 `dueAt`/`remindAt` + 时区/偏移”。

**建议**：在提议生成时就把 `dueAt`、`remindAt` 解析成 UTC 瞬间，连同 `timeZone`/offset 一起存进提议载荷；指纹对这两个瞬间取，明细按存下来的瞬间显示。执行时只写存下来的瞬间，不重新解析模型给的本地字符串。

---

### 高 6：后台运行的授权/工具范围没有落地；方案低估了现成代码

**问题**：§3 说“每条记录都用对话同一套运行方式把她叫起来，只给只读工具”，但没有说这次运行凭什么被授权。现有的“非主人消息触发的运行”不是完全没有：`SchedulerService` 已经通过 `trigger.admit` 发起运行，并且要求 `grant` 覆盖任务；没有有效授权会直接 `disabled`。方案却把这称为“最大的一块新东西”，没有把 `SchedulerService`/`DurableBackgroundWorkService`/`UnifiedTriggerIngestionService` 列为复用点。

**证据**：
- `packages/application/src/services/scheduler-service.ts:166-199`：先查 grant，`disabledReason` 不过就不发；然后 `triggers.ingest({ sourceType: "schedule" })`。
- `packages/application/src/services/durable-background-work-service.ts:51-82`：后台运行的 dispatch 结构。
- `test/integration/scheduler-trigger-ingestion.test.ts:167-197`：schedule → trigger.admit → context/permission/trace 的完整测试。
- `test/integration/durable-background-recovery.test.ts`：崩溃恢复测试。
- 但 `apps/agent-service/src` 里搜不到 `trigger.admit`/`TriggerAdmissionPort`，说明生产装配没接上。

**建议**：明确复用 `UnifiedTriggerIngestionService` + `SchedulerService`/`DurableBackgroundWorkService`，补的是生产装配、一个最小权限的只读 grant、以及来源读取器；不要新造第三套后台运行入口。这样也能自动获得幂等、租约、崩溃恢复和授权检查。

---

### 高 7：资源耗尽——观测洪泛、队列无上限、保险上限语义自相矛盾

**问题**：每条观测都可能触发一次多步工具调用。方案只说了“保险上限（默认 20）”和“每日花费上限（默认 1 美元）”，但保险上限看起来是卡“提议条数”，不是卡“观测处理数”；一封邮件/一段对话可以产生很多观测，即使都不提议，也会消耗大量模型调用。观测表还没有容量上限、清理和死信。并且两处写法冲突：§3 说碰到保险上限“记录留着第二天接着想”，首页一节说“到上限后当天的只进首页不再通知”——前者是“不建提议”，后者是“建了但不通知”。

**证据**：方案 §3“限额”与“和首页条目接口怎么接”一节；`packages/application/src/services/scheduler-service.ts:153-161` 的 `dispatchDue(limit)` 是现成的每轮上限模式可以借鉴。

**建议**：
1. 给观测处理加每轮上限、队列长度上限、最大尝试次数和死信/过期清理。
2. 明确保险上限卡的是“每轮/每天处理的观测数”还是“产生的提议数”，二选一并统一两节文字；如果卡的是观测，未处理的保留到明天；如果卡的是提议，不要建提议就不要说“第二天接着想”。
3. 每日花费上限要覆盖工具循环的每一次模型调用，并在用量页显示“今天有几条观测没处理”。

---

### 中 1：`action_proposals` 与 `owner_proposals`、新命令自相矛盾

**问题**：§4 说“这个方案不另建 `action_proposals`，下文凡是写 `action_proposals` 的地方都指 `owner_proposals`；这样就不需要另起 `proactive.proposal.respond`”。但 §10 仍写“新表 `action_proposals`、`proposal_observations`”，§5 标题仍是“新命令 `proactive.proposal.respond`”。实现者会不知道到底建哪张表、加哪个命令。

**证据**：方案 §4、§5、§10 的原文。

**建议**：全文统一成 `owner_proposals` 和任务 1 已有的命令；如果确实需要新命令，明确写出与 `suggestion.respond`/任务 1 命令的取舍，不要两处并存。

---

### 中 2：决策记录新增 `proposal` 种类依赖未合并的 PR 444；当前数据库约束会拒绝

**问题**：当前 `decision_ledger` 的 `kind` CHECK 只有 7 种，`outcome` 的大 CHECK 也只列了现有种类。方案说“PR 444 正在重建，已让它加 `proposal`”，但只加 `kind` 不够，还必须加 `outcome` 的合法值（`proposed/blocked/accepted/.../not_proposed/superseded`），否则插入会失败。代码侧 `DECISION_KINDS` 和 `DECISION_OUTCOMES` 的 `satisfies` 也会在编译期要求补全。

**证据**：
- `packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:21-25`（kind CHECK）、`:64-75`（outcome CHECK）。
- `packages/application/src/ports/decision-ledger.ts:32-44`（`DECISION_KINDS`、`DECISION_OUTCOMES satisfies`）。
- `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:53-60`（写前校验）。
- 方案 §9 说“已请第 3 批线程在合并前加上”，但这是跨线程承诺，不是本仓库可验证的事实。

**建议**：要么本方案自己出迁移重建 `decision_ledger` 并补全 outcome CHECK，要么把“PR 444 已合并且包含全部 outcome”作为硬性前置条件并在合并说明里列出验证命令。加一个测试：对每个 outcome 都插入一条记录。

---

### 中 3：推送种类仍是 `reminder/approval/run`，没有 `proposal`

**问题**：方案说“到手机是一条不响不震的通知”，但现有 `web_push_outbox.kind` 的 CHECK 只允许 `reminder/approval/run`，`web_push_subscriptions` 也只有 `notify_reminder/notify_approval/notify_run`。不补迁移，提议通知发不出去。

**证据**：`packages/persistence-sqlite/src/migrations/0058_web_push.sql:10-13`、`:26`；`0061_web_push_feedback.sql:6`。

**建议**：加迁移把 `proposal` 加进 kind，并决定是新增 `notify_proposal` 还是复用某一类；同步改推送发送、角标计数、Watch/Mac 的开关和测试。

---

### 中 4：来源种类直接复用 `ProactiveSource` 会不够

**问题**：`ProactiveSource` 现在只有 `"gmail"`，数据库 `source_insights.source` 也只允许 `'gmail'`。方案要接“新存下的记忆”，如果新表复用这个类型/约束，会直接拒绝。

**证据**：`packages/application/src/ports/proactive-checks.ts:4`；`packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:91`。

**建议**：为观测单独定义 `ProposalObservationSource = "gmail" | "memory" | "chat" | "schedule" | ...`，不要复用 `ProactiveSource`；所有产生/读取/badge/清除/导出两端一起改。

---

### 中 5：有序集合没有全部写死排序

**问题**：方案给工具名、动作名、记忆、提醒都写了排序，但没有给“还开着的提议”“最近被拒绝/忽略的提议”写排序。同样的输入如果数据库返回顺序不同，后台判断请求的字节就不同；规则明确要求列表顺序固定。

**证据**：`.claude/rules/prompt-prefix.md:51`；现有 `listUpcoming` 有 `ORDER BY r.due_at, r.id`（`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:144`），`listInsights` 有 `ORDER BY due_at IS NULL, due_at, updated_at DESC, id`（`sqlite-proactive-operations.ts:1006`）。新查询要照这个写。

**建议**：所有新查询显式 `ORDER BY (时间, id)`；测试里打乱数据库返回顺序并断言字节相同。

---

### 中 6：`machineString` 最长 128，Gmail message id 最长 256

**问题**：方案把“来源版本”定为邮件 `last_message_id`。仓库里 Gmail message id 允许 1–256 个字符，而通用 `machineString` 只允许 128。如果来源版本出现在任何新命令/快照字段里，长 id 会过不了契约；现有 `gmailMessageId` 才是对应类型。

**证据**：`packages/gateway-contracts/src/validation.ts:49-59`（`machineString` 128）；同文件 `:62`（`GMAIL_MESSAGE_ID_PATTERN` 1-256）。这正是 I-73 的教训：方案核了代码，但没问“清单里的 id 能通过后端校验吗”。

**建议**：来源 id/版本如果进契约，用 `gmailMessageId` 或单独的 256 长度字符串；提议 id 用固定 hex/SHA-256，不要拼进超长前缀。逐个检查新命令、首页快照、绑定串、导出字段的类型。

---

### 中 7：注册表的“要本人在场”标志没有被现有风险算法消费

**问题**：§2 的登记表有“要不要主人本人在场”，§5 说“登记了要本人在场的动作，仍然要面容确认”。但现有 `recentAuthenticationRequired` 只看 `finalRisk === "CRITICAL"`；一个 HIGH 但登记为“要本人在场”的动作不会触发近期认证。

**证据**：`packages/application/src/services/action-policy-service.ts:503`：`recentAuthenticationRequired: intent.finalRisk === "CRITICAL"`。

**建议**：要么把“要本人在场”的动作映射成 CRITICAL，要么扩展审批/命令模型显式携带 `requiresPresence` 并由网关校验；不要产生一个没人读的字段。

---

### 中 8：提示词测试“开着和关着提议功能，字节相同”与加两个工具矛盾；第 0 步对老对话不生效

**问题**：加两个对话工具必然改变工具集合，按规则第 6 条老对话会换新一次；如果功能开关会增删工具，开关切换会反复换新。测试却写“开着和关着提议功能，同一个对话发出的请求字节相同”。另外，§1.5.2 说“改系统提示文字只对新对话生效”，但 §12 第 0 步又说“做完‘问天气、提洗衣服’就该成立”——对老对话不成立，除非同时触发工具换新。

**证据**：`.claude/rules/prompt-prefix.md:41-43`（工具集合变了换新一次；改提示词只对新对话生效）；Anthropic 文档：“Modifying tool definitions (names, descriptions, parameters) invalidates the entire cache”（https://platform.claude.com/docs/en/build-with-claude/prompt-caching）。

**建议**：两个工具无条件加入（不要按开关增删），接受一次换新并记录；把系统提示那句和第 0 步的评测明确标成“新对话生效”，老对话要等工具换新。删掉“开关前后字节相同”的测试，改成“换新一次后保持稳定”。如果服务商支持中途加工具（Anthropic 的 mid-conversation tool changes），可以作为未来避免整段重算的选项，但不要假设所有服务商都支持。

---

### 中 9：最核心的行为只有真实模型评测，不是自动回归；命中率指标量不出“值不值得”

**问题**：§1.5 的“问天气、提洗衣服”测试明确写“真实模型评测，不是自动回归”。这意味着提示词或工具装配回归时 CI 不会失败。§9 的采纳率 = 接受 ÷（接受 + 拒绝 + 过期没理），这只能说明主人愿不愿意点，不能说明“该不该提”：漏提（false negative）和“提了但不值得”都没有分母。`not_proposed` 记录只有原因，没有“这次没提对不对”的标签。

**证据**：方案 §1.5“真实模型评测，不是自动回归”；§9 三个指标；`docs/product-vision.md:60`“预判的收益必须大于打扰我的成本”。

**建议**：
1. 加确定性测试：对“输入 → 渲染出的后台判断提示词/工具清单/动作清单”做字节快照；用一个固定的假模型输出测试“提议→校验→入库→接受→执行→读回→撤销”的契约。
2. 建一个有标签的评测集：每条观测标“应该提/不应该提”，跑真实模型后报 precision/recall/F1，不只报采纳率。
3. 加漏提抽样：定期抽一批 `not_proposed`，让人或第二个模型判断“是否漏了”；同时统计主人在提议后短时间内自己做了同类操作的比例，作为“missed”信号。
4. 记录程序挡掉的观测（去重、无依据、超限）及其原因，否则无法估计 false negative。

---

### 中 10：对话内提议的来源可信标记没有定义

**问题**：§1.5.4 给对话加“提出提议”工具，但没有说这条提议的“来源/可信标记”怎么定。如果因为“发生在主人的对话里”就默认成主人来源，那么一次网页搜索结果注入产生的“去办一件事”会被当成主人来源，绕过“外部内容必须看全文”的规则。§3 的“依据至少一条主人的记忆”也不够：记忆本身可能是从外部邮件抽出来的。

**证据**：方案 §1.5.4、§3“依据不能为空”、§4“来源标记加一种：由外部内容引出”。

**建议**：来源可信标记必须由服务端根据提议实际引用的内容引用（contentRefs）推导，不能由模型声明；要求至少一条**主人原创**的依据（区分主人原话/主人自己做的事 vs 外部来源记忆）；对话内工具的输出也走同一套程序核对。加一个测试：模型在对话里引用网页内容提出“去办一件事”，必须被标成外部来源并要求看全文。

---

### 中 11：导出/导入/表目录的清单没有列全

**问题**：方案说“数据导出和导入都要带上两张表”，但仓库里导入的 `EMPTY_TARGET_TABLES`、导出的逐表查询、`schema-catalog` 都是显式清单。只建迁移不改这些，导出会漏、导入会允许非空目标、表目录会不一致。

**证据**：`packages/persistence-sqlite/src/data-export/import.ts:78-91`；`packages/persistence-sqlite/src/data-export/snapshot.ts:175-209`（逐表 SELECT）；`packages/persistence-sqlite/src/schema-catalog.ts:827-882`（表说明/保留策略）。

**建议**：把新表加进 `EMPTY_TARGET_TABLES`、导出/导入、`schema-catalog`、清除路径和加密 payload 释放；加一次“导出→导入→提议还在、加密内容还在”的往返测试。

---

## 二、推测/未核实

以下不是我从当前提交能确认的，方案作者也承认没读或依赖未合并分支：

1. **PR 436 的 `owner_proposals` 实际列/约束/类型处理器**（id 是否内容哈希、是否允许新类型、唯一索引、采纳处理器接口）。方案说“PR 436 的代码线程没有读”，我也无法从当前提交核实。建议在动工前把它的迁移和端口读一遍，尤其是 id 长度/字符集和 type handler 的同步/异步语义。
2. **PR 444 的 `decision_ledger` 重建**是否包含 `proposal` 的全部 outcome 和 CHECK。当前仓库没有 PR 444，无法核实。
3. **首页条目方案**的 `proposal` 种类、`awaitsOwner`、绑定串、按钮文字来源、Watch/Mac 渲染。方案引用的是仓库外文件，我未读到。`web_push` 的缺口是仓库内证实的，但首页 DTO 的缺口只能标记未核实。
4. **苹果 Mail 的 Siri 建议**和 **ChatGPT Pulse** 的逐字说法。方案自己说前者是搜索摘要转述、后者 openai.com 抓取被拒；我未逐字核对，不作为结论依据。
5. **按钮字数上限（中文 6、日文 8、英文 16）**来自设计线程答复，仓库里没有对应代码/文案，无法核实。
6. **定时/外部事件运行是否已经能用工具**：我只能证实 `SchedulerService → trigger.admit → context/permission/trace` 的测试路径存在且未在生产装配；工具是否随该路径组装，我没有读到运行时装配的完整链路，标为推测。
7. **每次判断 0.005–0.02 美元**没有实测；多步工具循环的实际费用可能更高，尤其是观测洪泛时。
8. **`docs/adr/0209` 的动作闸门后续步骤**、**v0.2 主动建议代码删除的牵连文件**、**记忆入库路径的具体接入点**：方案自己说没读，我也没有逐项核实。

---

## 三、侧重检查（错误路径、不可信输入、安全、资源、不可逆、文档一致性）

我按下面路径逐一查了：

- **不可信邮件/网页 → 对话外判断运行 → 工具调用 → 外泄**：确认存在 `read` + `web_search/web_fetch` 的只读工具面，且 web 工具可由 owner policy 自动放行；§7“判断模型没有工具”是错的。**结论：严重问题，需白名单+禁外泄。**
- **外部内容 → 任务说明 → 运行的第一条消息**：确认 `turnPrompt` 把内容放进 `<owner-message>` 且不转义；任务说明是模型写的。**结论：严重问题，需改成非权威“已批准任务”块并转义。**
- **“看全文”/“面容确认”**：确认新命令只有三字段，缺少 `recentAuthenticationRef` 和 view proof；现有审批靠这两个。**结论：严重问题，需补认证凭据。**
- **执行崩溃/部分失败/读回失败**：确认事务里先标 `succeeded` 并关邮件提醒，读回失败无法回到 `failed`；没有执行租约/超时/恢复。**结论：高问题。**
- **撤销/不可逆**：确认 `undone` 会新开同内容 open 提议；`reminder.create` 的“收回记忆”未核实；计划承认可能做不到完整撤销。**结论：高/中问题。**
- **资源耗尽**：确认观测表无上限、保险上限语义冲突、每轮无明确处理上限；每观测多步模型调用。**结论：高问题。**
- **授权/后台运行**：确认 `SchedulerService` 要求 grant，且 `trigger.admit` 生产未装配；方案把所有后台运行说成“要新做”不准确。**结论：高问题/可复用代码。**
- **规则/文档/代码一致**：确认 `action_proposals` vs `owner_proposals`、`proactive.proposal.respond` vs 合并命令、`open->withdrawn` vs `superseded`、`succeeded->undone` 逻辑、保险上限两处说法、提示词测试“开关前后字节相同”等多处矛盾。**结论：多处需先统一。**
- **枚举/契约跨端**：确认 `decision_ledger` CHECK、`model_usage_observations` CHECK/用途清单、`web_push_outbox.kind`、`ProactiveSource`、`machineString` 128 等都是会产生/消费新值的地方，方案有的提到、有的漏掉。**结论：Q4 风险集中区。**

---

## 四、如果由我定，我会怎样改这份方案

1. **先停掉“判断运行带网页/文件工具”这个设计**。对话外判断默认无工具，只喂服务端按固定顺序取好的邮件/记忆/提醒；如果确实需要查，单独一次受控的只读检索，固定服务商、禁止任意 URL、禁止把记忆原值拼进查询，并用注入评测做上线门槛。
2. **把“去办一件事”当成高风险能力，而不是普通提议**。外部内容引出的任务说明：服务端生成 view token + `recentAuthenticationRef`；运行时不放进 `<owner-message>`，而是“已批准任务”资料块；分隔符转义；对外发送/花钱/删除仍逐项审批；加一条“恶意邮件夹带指令”的自动反向测试。
3. **合成一张 `owner_proposals`，两列状态**：`ownerDecision` 和 `executionStatus`；加版本、指纹、来源类型/版本、可信标记、目标版本、执行租约/尝试次数、view/face 凭据、原样和撤销信息。不要再用 `action_proposals` 这个名字。
4. **复用现有后台基础设施**：`UnifiedTriggerIngestionService` + `SchedulerService`/`DurableBackgroundWorkService`，补生产装配和最小权限只读 grant；不要新造“第三套运行入口”。
5. **时间和字节确定**：提议时解析并存 UTC `dueAt`/`remindAt` + 时区；所有列表 `ORDER BY (time, id)`；遮盖沿用现有规则并检查新增固定提示词对老对话的影响；后台每轮串行处理观测（避免并发缓存和重复判断），用观测租约防重复。
6. **状态机收敛**：事务只到 `executing/executed_unverified`；读回后再 `succeeded`/`failed`；`undone` 终态不再重提议；统一 `withdrawn`/`superseded` 的触发条件；加超时恢复。
7. **把跨 PR 的约束变成硬前置**：`decision_ledger` 的 kind + outcome CHECK、`model_usage_observations` 的 purpose、`web_push_outbox.kind`、特定来源枚举、`machineString` 长度，全部列出“产生处/消费处/测试”；加一个“每个新枚举值都能落库、能读出、能导出”的测试。
8. **评测和度量**：加确定性提示词/工具快照测试 + 假模型契约测试；真实模型评测用有标签的正反例，报 precision/recall；`not_proposed` 也要有抽样复核和“missed”信号，不能只看采纳率。

---

## 五、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**会，但只在工具集合变化时一次性改变，符合规则第 6 条；每轮会变的值仍应只在最后一条消息。**

- 对话里新增 `reminder_reschedule` 和 `propose_next_step` 两个工具，会改变工具定义。Anthropic 的缓存文档明确说工具定义变化会让整个缓存失效（`tools → system → messages`，https://platform.claude.com/docs/en/build-with-claude/prompt-caching）；项目规则也允许“工具集合变了就换新一次”，并要求留记录（`.claude/rules/prompt-prefix.md:41-43`）。所以老对话在工具上线后的下一轮会重算一次，之后恢复稳定。方案这句说对了。
- 系统提示加“先查清楚再提”只对新对话生效；老对话要等工具换新才拿到。方案 §1.5.2 说对了，但 §12 第 0 步说“做完就该成立”对老对话不成立，需要改口径。
- “主人接下来 7 天的安排”现在就是 `contextBlocks`，由 `pi-runtime-adapter.ts:639-657` 的 `turnPrompt` 拼进最后一条 `<himawari-context>`；新增“带日期的记忆”也放在这里，不动系统提示和历史。**结论：只要新增的近期安排仍走 `owner-agenda` 这个 context block，且每轮变化的值不回流到系统提示/工具定义，就仍然只在末尾追加。**
- 新增 `propose_next_step` 的工具结果会作为一轮里的 tool result 追加，属于正常追加；不要把它改写成历史里的旧消息。
- 新固定提示词进入 `packages/prompt-catalog` 后，按规则第 11 条可能改变老对话里冻结文字的遮盖结果；方案已列为“未核实”，必须在动工前用 `check:prompt-prefix` 和遮盖测试确认。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**会，如果实现不额外约束。方案目前只约束了一部分。**

- **依赖前后文的遮盖**：规则第 11 条要求遮盖只取决于自己和前面的内容；新增固定提示词会改变“受信文字清单”，可能让老对话的旧文字从“受信”变成“外来”，从而改变遮盖字节。方案列为未核实，必须在实现时按第 11 条检查。
- **带时间的字段**：`当前时间`、`日期对照表` 放在最后可以接受；但**提议里的时间必须存 UTC 瞬间 + 时区**，不能每次用当前时区重新解析本地字符串（见高 5）。否则同一段“9:40”在不同时区/不同时间会变成不同字节和不同执行结果。
- **无序集合**：工具、动作、记忆、提醒方案都写了排序；但“还开着的提议”“最近被拒绝/忽略的提议”没有写 ORDER BY。必须补 `(时间, id)` 排序，否则数据库返回顺序变化就会改变字节。
- **并发**：同一观测如果被两个 worker 同时处理，会生成两条不同按钮文字/不同提议的模型输出。需要观测租约/领取，保证同一版本只判断一次；这与规则第 17 条“并发且开头相同的请求先等第一个开始返回”也一致。
- **按钮文字**：模型写，天然不确定；方案把它存进提议并用指纹绑定，作为“一次提议”的内容是确定的。但 §4 的指纹定义没有包含按钮文字，而“程序核对”又说“这几个字算进内容指纹”，两处必须统一：要么按钮文字进指纹，要么明确它是展示层、执行不受它影响。

### 3. 有没有对应的自动检查，反向用例真的会失败？

**有相当多测试，但最核心的两块还不够“自动”、也不够“反向”。**

- 提示词前缀：现有 `npm run check:prompt-prefix` 覆盖逐轮追加、遮盖、冻结和反向用例（`.claude/rules/prompt-prefix.md:74`）；工具换新条件由 `test/integration/thread-prompt-bundles.test.ts` 覆盖。方案应把“新增两个工具导致老对话换新一次”加进这个现有测试，而不是只写一个新的临时测试。
- 方案里的“开着和关着提议功能，同一个对话发出的请求字节相同”与“加工具”矛盾，必须改成“工具无条件存在，换新一次后稳定”。
- **最核心的“问天气、提洗衣服”是真实模型评测，不是自动回归**。提示词或工具装配回归时 CI 不会失败。应加：固定输入 → 渲染后的后台判断提示词/工具清单/动作清单的字节快照；假模型输出 → 提议校验/接受/执行/读回/撤销的契约测试。
- 反向用例：方案列了很多，但需要确保下面这些真的“去掉守卫就失败”：唯一索引并发、观测租约、全文 view token、近期认证、来源可信标记、时间参数篡改、目标版本变化、读回不一致、撤销后目标又变、保险上限语义。尤其是**外部内容注入**：要用一个假的恶意邮件/网页，让模型尝试调用 `web_fetch` 外带秘密，断言运行被拒绝或没有外带；这条目前只是“上线前人工测”，应变成自动测试。
- 数据层：加一个“每个新枚举值都能插入/读出/导出”的测试（decision kind、outcome、model usage purpose、web push kind、observation source），防止跨 PR 的 CHECK 漏改。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

**不能全部确认；下面这些是必须逐项核对的“产生处 ↔ 消费处”，目前方案漏了几处。**

| 值 | 产生处 | 使用处/校验 | 结论 |
|---|---|---|---|
| `owner_proposals` 的 id/version/fingerprint | 新提议/状态变更 | 新命令、首页快照、绑定串、导出、UI | 需确认 id 长度/字符集能过契约；指纹建议纯 hex SHA-256；不要把 Gmail id 拼进 `machineString` |
| 来源 id/版本（Gmail `last_message_id`） | 邮件检查/观测 | 提议行、去重、过期 | Gmail id 最长 256，`machineString` 最长 128；若进契约用 `gmailMessageId` 或 256 字符串（`validation.ts:49-62`） |
| 观测来源种类（gmail/memory/…） | 邮件/记忆/对话 | 观测表、后台任务、清除/导出 | 不要复用 `ProactiveSource = "gmail"`（`proactive-checks.ts:4`；`0089:91` 只允许 gmail） |
| `decision_ledger.kind='proposal'` + outcome | 判断任务 | DB CHECK、`DECISION_KINDS`、`DECISION_OUTCOMES`、写入校验、导出、UI | 当前 `0089:21-25/64-75` 会拒绝；PR 444 必须同时加 kind 和 outcome，否则插入失败 |
| `model_usage_observations.purpose='next-step-proposal'` | 后台判断 | DB CHECK（`0091:83-109`）、`MODEL_USAGE_PURPOSES`（`model-usage.ts:3-13`）、`sqlite-model-usage-operations.ts:20-35`、UI 标签 | 方案已提到，但迁移必须在 0091 之后并重建表 |
| 首页条目 kind `proposal` | 首页读取层 | 合约严格枚举、网页/Apple/Watch、角标、`awaitsOwner` | 仓库内无法核实首页 DTO；`web_push_outbox.kind`（`0058:26`）确实没有 `proposal`，必须补 |
| 推送 kind / 通知开关 | 提议通知 | `web_push_outbox` CHECK、`web_push_subscriptions.notify_*` | 缺迁移；不改就发不出 |
| 新命令名/载荷 | 网页/设备 | 操作清单、合约、服务端 handler、客户端、`check:operations` | §4 说不要新命令，§5/§10 说新命令；先统一 |
| 确定动作名/结构版本/参数/目标版本 | 登记表/模型输出 | 校验、执行、读回、撤销、明细 | 需确认目标版本来自服务端快照而不是模型；参数严格校验 |
| 按钮文字/问句/明细 | 模型/明细生成函数 | 指纹、列表、通知、锁屏、Watch | §4 指纹定义与“按钮文字算进指纹”矛盾；明确其一 |
| `dueAt`/`remindAt`/时区 | 提议生成 | 提醒存储、显示、指纹、撤销 | 必须存解析后的 UTC 瞬间 + 时区，不能执行时重解析 |
| 过期时间 | 提议生成/清理 | 读取过滤、后台清理、UI | “事情本身的时间”对“去办一件事”没有定义，需补 |
| 审计记录 | 接受/执行 | `AuditRecord` 没有细节字段（`observability.ts:109-117`） | 方案把细节放提议行是对的；确认审计只记引用，不泄露内容 |
| 导出/导入/表目录 | 迁移 | `EMPTY_TARGET_TABLES`、`snapshot.ts`、`schema-catalog.ts` | 方案没列这些代码清单，需补 |

**Q4 的直接结论**：方案对“动作登记表”的内部一致性想得比较细，但对**跨层枚举**（decision kind/outcome、model usage purpose、push kind、observation source）和**契约长度/字符集**（Gmail id、machineString）没有逐项找到产生处和消费处。I-73 的教训在这里仍然成立：不能只看改动本身，要问“这个 id/枚举值能通过后端的 CHECK 和契约校验吗”。

---

### 附：我核对过的方案事实（供作者修正）

- 前提 1、2、3、4、5、6、7、9、10、11、12、13、14、16、24 的代码位置基本对得上；前提 24 只描述了 `admitOwnerMessage`，但仓库里已有 `trigger.admit`/`SchedulerService` 的非主人消息路径（未生产装配），所以“运行只能由主人消息开始”不准确。
- §1.5.1 关于“近期安排每轮在最后一条消息”是对的：`owner-profile-service.ts:254-290` 生成 `owner-agenda`，`pi-runtime-adapter.ts:639-657` 拼进最后一条 `<himawari-context>`。
- `packages/prompt-catalog/src/chat.ts:23-25` 的“主动”文字确实如方案所引。
- `production-runtime-tools.ts:405-415` 的 `read`、`:469-507` 的 web 工具确实存在，且 `public-search-authorization.ts:204-259` 把 web 工具当 READ/无副作用授权。
- `decision_ledger` 当前 kind/outcome CHECK、`model_usage_observations` 当前 purpose CHECK、`web_push_outbox.kind` 当前三值，都是新增值必须改的地方。
