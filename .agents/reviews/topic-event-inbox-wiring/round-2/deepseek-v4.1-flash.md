# 方案审核：统一事件入口、跟进与告知

## 结论先行

这个方案的方向（单一入口、定时只往入口写事件、运行只读、告知有出处）和 Anthropic 的一手文章一致；但我核对代码后，发现 **5 处会直接推翻方案关键承诺的事实性错误**，以及一批跨层契约没对齐。最严重的是：

1. “老对话工具定义不变”不成立：新增工具会触发老对话换新一次请求头。
2. “写入口成功再推进，所以不会丢”不成立：入口把 `expired`/`failed` 的重复条目也当成成功，跟进会被吞掉。
3. 复用 `evaluateDurableSchedule` 与“晚到也跑一次”的承诺相反：超过 `misfireGraceMs` 的一次性任务直接变成 `missed`。
4. 新告知推送说“照旧过 ADR 0273/0184”不成立：新 kind/sourceKey 会落入 `unknown`，直接投递、不延后、不降频。
5. “来源编号做成定长摘要、还能点回原记录”不成立：摘要是单向的，原邮件/记忆编号丢失。

---

# 一、证实的（按严重度）

## 高-1　新增对话工具会改变老对话的请求头，“只在末尾追加”不成立

**问题**：方案说“系统提示不动；对话加两个工具，在新对话生效，老对话的工具定义不变”。实际工具集合参与请求头身份，任何工具名变化都会让老对话换新一次。

**证据**：
- `packages/application/src/services/thread-prompt-bundle-service.ts:89`：`if (!sameNames(record.identity.toolNames, identity.toolNames)) return "tool_set_changed";`
- `packages/application/src/services/thread-prompt-bundle-service.ts:208-211`：`tool_set_changed` 时调用 `#create` 新建 bundle，并 `#traceInvalidated`。
- `packages/runtime-pi/src/pi-runtime-adapter.ts:1393-1403`：`promptBundles.resolve` 传入的 `identity.toolNames` 是**当前全部** frozen descriptors，不是“对话创建时的工具名单”。
- `packages/runtime-pi/src/pi-runtime-adapter.ts:1402`：`productSystemPrompt(projection.systemInstruction, frozenDefinitions)`，系统提示的渲染结果也包含工具定义。

**结论**：只要新工具进入全局 tool 列表，老对话下一轮就会 `tool_set_changed`，请求开头变一次；此后系统提示、工具定义、全部历史都按新开头重算。这不是“只在末尾追加”，也不是“老对话工具定义不变”。方案没有写任何按对话创建时间/版本的 gating。

**建议**：
- 给新工具加“只对发布后创建的对话提供”的开关（按 `thread.createdAt` 或冻结 bundle 的 feature flag）；老对话的当前 descriptor 列表不包含新工具。
- 或者明确承认会换新一次，走 ADR/Andy 同意，并按 `prompt-prefix.md` 第 6 条留记录。
- 加 `check:prompt-prefix` 新用例：老对话在新工具上线后的第一轮请求头逐字节不变，且不出现 `tool_set_changed` trace。这个用例在现方案上会失败。

---

## 高-2　“写入口成功再推进，所以不会丢”不成立：`expired`/`failed` 的重复条目也被当成成功

**问题**：方案说“写入口成功、推进之前进程死了：下一轮再写一次，入口按同一个去重键认出是重复，再推进。所以不会丢，也不会跑两次。” 但入口的 `enqueue` 对**任何已存在**的 `(source_kind, source_ref, source_version)` 都返回 `duplicate`，不看状态；而条目可能以 `expired` 或 `failed` 结束。调度器随后推进定时，跟进就永远不再触发。

**证据**：
- `packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:179-188`：先按唯一键查 `existing`，存在就 `return { outcome: "duplicate", entry: stored(existing) }`，没有检查 `status`。
- `packages/application/src/ports/think-inbox.ts:3-9`：状态包括 `expired`；`production-think-worker.ts:109-116`：运行失败会 `settle("failed", "think_failed")`。
- `packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:16`：唯一键是 `(owner_id, agent_id, source_kind, source_ref, source_version)`。
- 方案第 2 节：“写入口成功后再推进定时……不会丢，也不会跑两次。”

**结论**：`duplicate` 只证明“这条事件以前出现过”，不证明“这条事件被处理成功”。如果第一次是排队过期、运行失败、答案解析失败、取消，调度器仍会推进，承诺的跟进丢失。这个错误比“进程崩溃”更常见。

**建议**：
- 定时表加显式状态机：`pending → enqueued → running → succeeded | failed | expired`；只有 `succeeded`（或明确“决定不做”的 `skipped`）才推进到下一次。
- `duplicate` 时读回 entry 状态：`queued/thinking` 可以推进到“已入队、等待结果”；`failed/expired` 不推进，重新入队（新 `attempt`/新版本）或把定时标失败并告诉主人。
- 加“想一想运行失败后，跟进仍会再触发”的自动测试；在旧代码上跑必须失败。

---

## 高-3　复用 `evaluateDurableSchedule` 与“跟进晚到也跑一次”相反

**问题**：方案说“服务停着的时候错过的：跟进晚到也要跑一次；周期任务只跑最近一次”。但 `evaluateDurableSchedule` 的语义是：一次性超过 `misfireGraceMs` → `missed`；周期/每天超过 grace → `skipped`；每天只回看最近 4 天。

**证据**：
- `packages/application/src/services/durable-background-work-service.ts:183-209`：`one_shot` 在 `now - at > schedule.misfireGraceMs` 时返回 `outcome: "missed"`、`nextAt: null`。
- 同文件 `:230-239`：`interval` 超过 grace 返回 `outcome: "skipped"`；`:286-293`：`daily` 超过 grace 返回 `skipped`。
- 同文件 `:255`：`daily` 的窗口从 `now - 4 * 86_400_000` 起；停机超过 4 天时更早的候选根本不生成。
- Claude Code 文档（已核对）原话：“No catch-up for missed fires. If a task's scheduled time passes while Claude is busy on a long-running request, it fires once when Claude becomes idle, not once per missed interval.” 以及 “A restored recurring task doesn't fire for the runs it missed while the session wasn't running.”（<https://code.claude.com/docs/en/scheduled-tasks>）

**结论**：除非把 `misfireGraceMs` 设成覆盖整个停机期，否则“跟进晚到也跑一次”不会发生；而“周期任务只跑最近一次”正好是“补跑一次”，与它引用的 Claude Code“不补跑”相反。方案把这两条写成“采纳”，但代码语义和一手来源都不支持。

**建议**：
- 为跟进/周期显式定义 `dueAt`、`expiresAt`、`misfire` 策略；不要直接套用 `evaluateDurableSchedule` 的 one-shot `missed` 语义。
- 跟进：在 `expiresAt` 之前，晚到也跑一次；超过 `expiresAt` 标 `missed` 并告诉主人，而不是静默消失。
- 周期：明确选择“跑最近一次”还是“不补跑”；如果选择补一次，就在方案里写成自己的决定，不要写成采纳 Claude Code。
- 加“停机超过 grace 后跟进仍触发一次”“超过 expiresAt 标记错过并告知”的测试。

---

## 高-4　新定时没有成本/资源预算，违反愿景原则 8

**问题**：方案明确“不接旧的定时、统一触发、注意力策略三套代码，只借时刻计算函数”，理由之一是“那三套围绕长期授权和费用预算设计，跟进用不上”。但愿景原则 8 要求“推进受成本、资源与时间预算约束，超限即停下等待”。新的自定跟进/周期任务没有 per-schedule 或 per-day 成本上限，只受 inbox `dailyLimit`（默认 50）约束；一个恶意/ bug 的周期任务可以持续触发模型调用。

**证据**：
- `docs/product-vision.md:64`：“它能在我不在时按既定规则推进有明确目标与停止条件的事情……推进受成本、资源与时间预算约束，超限即停下等待。”
- `packages/application/src/services/scheduler-service.ts:82-105`：现有调度有 `grant.kind === "long_term"`、`maxCostMicrosPerUse`、`maxTotalCostMicros`、`maxFrequency`、`expiresAt` 等校验。
- 方案的定时表列：种类、状态、下次到点、周期规则、任务说明、做到哪、谁建的、来源编号、已触发次数、最晚失效时刻、修订号——没有成本/用量/预算列。

**结论**：方案把“费用预算”当成旧代码的负担丢掉了，但这是愿景的硬要求，不是可选项。

**建议**：
- 每条定时加 `budgetMicros`、`spentMicros`、`maxRunsPerDay`、`maxRunsTotal`；运行前预留、运行后结算；超限自动暂停并告知。
- 复用现有 `ScheduledJob`/grant 的成本字段，或在新的定时表里明确这些列；App 显示每条已花/上限。
- 加“达到预算后不再触发”的测试。

---

## 高-5　新告知推送不会“照旧过 ADR 0273/0184”：会落入 `unknown`，且 DB kind 约束只允许三种

**问题**：方案说“推送时机照旧过 ADR 0273（你忙的时候延后）和 ADR 0184（被忽略就降频）”。但新告知如果新增 kind，会被三处 DB CHECK 拒绝；如果复用 `reminder` 但 sourceKey 不匹配现有前缀，`pushClassOf` 返回 `unknown`，而 `unknown` 在保护类里，直接投递、不延后；ADR 0184 的降频只覆盖“due”邮件提醒，不覆盖新的告知。

**证据**：
- `packages/application/src/ports/web-push.ts:5`：`WebPushKind = "reminder" | "approval" | "run"`。
- `packages/persistence-sqlite/src/migrations/0058_web_push.sql:26`：`kind TEXT NOT NULL CHECK (kind IN ('reminder', 'approval', 'run'))`；`0061_web_push_feedback.sql:6`、`20261114154943_apple_push.sql:93` 同样。
- `packages/application/src/services/web-push-gate.ts:18-41`：`PUSH_RULE_PROTECTED_CLASSES` 含 `unknown`；`pushClassOf` 只识别 `approval:`、`run:`、`muse-channel:`、`proactive:`、`proposal:`、`reminder:`，其余一律 `unknown`。
- `packages/application/src/services/web-push-gate.ts:78`：保护类直接 `DELIVER`。
- `packages/application/src/services/delivery-timing.ts:4-8`：`DELIVERY_TIMING_CLASSES` 只有 `scheduled_reminder`、`run_result`、`mail_reminder`。
- `docs/adr/0184-back-off-ignored-proactive-pushes.md:38-42`：降频的“同一类”只针对到期邮件提醒（`due`）。

**结论**：新告知要么被 DB 拒绝，要么以 `unknown` 直接投递，既不过安静时段也不降频。方案不能声称“照旧”。

**建议**：
- 新增明确的 `tell` push kind + `PushClass` 映射 + 迁移（三处 CHECK）+ 通知开关 + App 文案；把 `tell` 加入 `DELIVERY_TIMING_CLASSES`，并为它定义降频键。
- 或者明确“告知只进首页、不推送”，删掉“照旧过 0273/0184”的表述。
- 加“告知推送在安静时段会延后、被忽略会降频”的自动测试；旧代码上应失败。

---

## 高-6　“编号先做成定长摘要”会破坏“点回那件事”

**问题**：方案说“编号和版本一律由来源先做成定长摘要再交给入口，不超过 128”，又要求在 App 里“点开任何一条主动消息，能一路点回那件事（哪封邮件、哪条记忆）”。摘要（`sha256:`）是单向的，原记录编号丢失后无法点回。

**证据**：
- `apps/agent-service/src/production-think-actions.ts:25-29`：`bounded()` 超长时返回 `sha256:<64hex>`。
- 同文件 `:31-33`：`sourceRef(context)` 对 `${sourceKind}:${sourceRef}` 做 `bounded(..., 256)`。
- `packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:6`：`source_ref` 本身允许 1–256，并不需要哈希。
- `packages/persistence-sqlite/src/data-export/schemas.ts:263-264`：导出里 `sourceRef` 1–256、`sourceVersion` 1–128。
- 方案第 4 节：“链靠来源编号回到原记录”。

**结论**：把 `sourceRef` 摘要化后，提议/告知只持有摘要；原邮件/记忆编号不在任何地方，App 无法“点回”。方案自己的“读得回来”测试只能证明摘要一致，不能证明原记录可达。

**建议**：
- `source_ref` 保存原始编号（≤256）；只对超过 128 的 `sourceVersion` 做摘要。
- 如果确实需要去重摘要，另存一列 `source_digest` 或映射表，**不要拿摘要替换原编号**。
- 加端到端测试：从告知/提议按 `source_ref` 查到原邮件/记忆行，且原记录删除时显示“来源已删除”。

---

## 中-1　告知表复制记忆原话，绕过记忆删除/保留/受限规则

**问题**：方案说告知表存“那句话、依据（用了哪几条记忆的原话）”。这会在记忆子系统之外复制记忆原文；记忆被删除、改为受限、或敏感处理后，告知里的副本还在。若按普通列明文存储，更严重。

**证据**：
- `docs/product-vision.md:59`：“记忆是所有决策的主要输入，必须有单一权威源，且我可查看、编辑与删除。”
- 现有记忆正文由 `PayloadProtectorPort` 加密存；想一想摘要也走 `protector.protect`（`production-think-inbox.ts:200-209`）。方案的告知表没有说明用加密载荷/分类。

**建议**：
- 告知表只存 memory id / 消息 id / 来源 id，展示时解密；确需展示原话时用加密载荷，并跟随记忆删除/保留策略。
- 对外部邮件内容，不要复制外部正文，只存可验证的短引用和来源。
- 加“删除记忆后告知里的引用显示已删除/不再展示原文”的测试。

---

## 中-2　外部内容 → 告知/跟进：现有核对挡不住钓鱼和自助放大

**问题**：方案的程序核对是“引用原话逐字能找到”“外部内容引出的告知至少有一条自己的记忆或自己说过的话”。这挡不住“邮件里提到一个真实退款，然后叫你立刻转账”这类钓鱼；而且外部内容可以引出跟进，跟进到点又能再告诉主人或再定跟进，形成放大链。

**证据**：
- 方案第 3 节：“程序核对，不过就不存……外部内容引出的告知，依据里必须至少有一条你自己的记忆或你自己说过的话”。
- 第 2 节：“建一条跟进：别的来源引出的事，她觉得该过一阵再看。”
- `production-think-actions.ts:35-40`：所有想一想提议硬编码 `origin: "external_content"`、`externalContentSeen: true`，不会因内部跟进而降级。

**建议**：
- 外部内容引出的告知默认只进首页并要求主人确认，或限制为“对邮件状态的逐字事实引用”，不让模型自由生成行动建议。
- 外部内容引出的跟进/周期任务创建加审批或严格配额（每来源每天几条、最多再定几次），并在 App 显示“因为哪封邮件”。
- 加注入回放测试：邮件提到真实记忆 + “立刻转账”，必须不产生可推送的告知/跟进。

---

## 中-3　周期任务进数据导出，但格式版本/清单/校验没改

**问题**：方案说“你要的周期任务随数据导出一起带走”，但没有提数据导出格式版本、schema、清单 counts、verify/import。按项目先例，新数据进导出必须升版本，旧文件整份拒绝。

**证据**：
- `packages/persistence-sqlite/src/data-export/schemas.ts:10`：`FORMAT_VERSION = "himawari.data-export.v4"`。
- 同文件 `:656-747`：`MANIFEST_SCHEMA` 的 `counts.required` 是固定列表，`additionalProperties: false`。
- 同文件 `:749-792`：`SCHEMA_FILES`、`DATA_FILES` 是固定列表。
- `docs/adr/0233-rule-book-joins-the-data-export.md:47`、`docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56`、`docs/adr/0272-owner-proposals-join-the-data-export-format-v4.md:33`：新数据进导出升版本，旧文件 `DATA_IMPORT_FORMAT_UNSUPPORTED`。

**建议**：
- 升到 v5，新增 schema、data 文件、manifest counts、verify/import/round-trip 测试。
- 明确自跟进和告知是否导出；如果导出周期任务，导入时 `nextRunAt`/`lastScheduledAt` 怎么重算，引用悬空怎么处理。
- 在 `check:data-export` 里加反向用例：旧 v4 文件整份拒绝。

---

## 中-4　新增设置键缺三语文案/单位/快照契约

**问题**：方案说“边界都是设置，写进设置定义表”。现有设置是封闭数组，且每个键必须有 `THINK_SETTING_TEXT`（中英日）和 `THINK_SETTING_UNIT_VALUE`（单位映射）；`change()` 按定义表校验。只加 `THINK_SETTING_DEFINITIONS` 会在设置页/保存时失败。

**证据**：
- `packages/application/src/ports/configuration.ts:417-441`：`THINK_SETTING_DEFINITIONS`、`THINK_SETTING_UNITS`。
- `apps/agent-service/src/production-think-settings.ts:26-134`：`THINK_SETTING_TEXT` 是 `Record<ThinkSettingKey, ...>`，每个键三语。
- 同文件 `:148-165`：`THINK_SETTING_UNIT_VALUE` 是 `Record<ThinkSettingUnit, ...>`。
- 同文件 `:262-268`：`change()` 找不到定义/超出范围就拒绝。

**建议**：
- 列出每个新键、默认值、单位、min/max、三语文案；调度器专属设置考虑单独定义表，不塞进“想一想”设置。
- 加测试：每个键都有文案、能通过 `change()`、出现在快照、三语不缺项。

---

## 中-5　“四种结局”与现有 think 状态/端口不兼容

**问题**：方案要“结局分清四种：提了提议、告诉了一句、定了跟进、不提”，但 `ThinkInboxStatus` 是封闭联合，`finish()` 只接受 `proposed|skipped|failed`，`ThinkRunResult` 只有 `proposed|skipped`。只加一个 `result_ref` 列可以绕开状态，但方案没写。

**证据**：
- `packages/application/src/ports/think-inbox.ts:3-9`：状态联合。
- 同文件 `:65-72`：`finish` 的 `to` 只有三种。
- `packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:261-262`：运行时校验同样只允许三种。
- `apps/agent-service/src/production-think-worker.ts:12-15`：`ThinkRunResult.outcome` 只有 `"proposed" | "skipped"`。

**建议**：
- 明确用新列 `result_kind/result_ref` + 迁移，状态仍用 `proposed/skipped/failed`；或扩展联合/端口/worker/UI。
- 加每种结局的测试（提议、告知、定时、什么都不做），并核对 App 的条目渲染。

---

## 中-6　新调度循环没有单飞、批量上限、退避；每日配额会把定时饿死

**问题**：方案说“一个后台循环按可改的间隔扫定时表……到点的每一条……入口排队满或当天收满：不推进，下一轮再试”。但没有单飞保护、每 tick 批量上限、指数退避；inbox 的 `dailyLimit` 按所有来源计数，方案只给队列预留名额，没给每日名额。一封邮件潮可以把定时条目挤到 `expiresAfterHours` 过期，和“答应过的事不能被吞掉”矛盾。

**证据**：
- `packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:201-211`：`accepted` 统计 `day` 下**所有状态**的条目，达到 `dailyLimit` 就 `daily_limit`。
- 方案的定时表没有 `daily reserved` 字段；设置里只写“排队名额”。
- `apps/agent-service/src/production-proactive.ts:315-326`：`setInterval(() => void this.tick())`，没有单飞；`production-perception-extraction.ts:111-133` 有 `#running` 保护，可作为正例。

**建议**：
- 调度循环加 `#running` 单飞、每 tick 批量上限、失败指数退避。
- 给定时来源独立的每日配额（不只队列），并记录“被推迟”；接近 `expiresAt` 时告诉主人，而不是静默过期。
- 加“邮件潮 + 定时同时到点”的测试，证明跟进不会饿死。

---

## 中-7　`common()` 把所有想一想提议硬编码成外部内容，内部跟进语义会错

**问题**：方案说跟进的“外部内容跟着建它时那件事走”，但 `production-think-actions.ts` 对所有 think 提议硬编码 `origin: "external_content"`、`externalContentSeen: true`；内部跟进产出的提议也会被标成外部内容，并触发 `requiresFullRead`。

**证据**：
- `apps/agent-service/src/production-think-actions.ts:35-40`：`origin: "external_content" as const`, `externalContentSeen: true`。
- `apps/agent-service/src/production-task-proposals.ts:245`：`const external = context.externalContentSeen === true || context.origin === "external_content";`
- 同文件 `:274`：`requiresFullRead: long || external`。
- `apps/agent-service/src/production-proposals.ts:385-390`：`origin = externalContentSeen ? "external_content" : input.origin`。

**建议**：
- 从 `entry.externalContent` 或来源登记推导 `origin`：内部跟进用 `inferred`/`owner_said`，外部内容才用 `external_content`。
- 加“内部跟进产出的提议不是 external_content”的测试。

---

## 中-8　第 1 步验收“iPhone 首页出现一条提议”与现状不符

**问题**：第 1 步验收写“iPhone 首页出现一条提议”，但首页来源只有邮件、审批、记忆、运行；`external_proposals` 是 MCP 外部提议，不是主人提议箱。方案自己在“未核实”里承认。验收标准可能依赖一个不存在的界面。

**证据**：
- `apps/agent-service/src/production-home.ts:728-733`：`mailSource`、`approvalSource`、`memorySources`、`runSource`；没有主人提议源。
- `apps/agent-service/src/production-home.ts:430`：`external_proposals` 是另一类 MCP 提议。
- 方案“还没核实的事”：“提议现在在 iPhone 上从哪个接口显示，没有读；前提 11 的首页来源里没有提议。”

**建议**：
- 先读清 iPhone 提议箱的实际接口/页面；把第 1 步验收改成“提议箱出现一条提议”，或把“提议进首页”单独列为范围。
- 如果确实要让提议进首页，新增 home source 并核对 `fitsContract` 的 id 契约（`production-home.ts:701-721`）。

---

## 中-9　“同一件事最多响一次”没有共享的相关键

**问题**：方案说“一封邮件已经推过提醒的，由它引出的提议或告知只进首页”。但邮件推送的 `sourceKey` 是 `proactive:<id>`，提议是 `proposal:<id>:<time>`，告知还没有 key；没有共享的 correlation key。且现有提议推送每轮只取最新一条，可能被别的提议挤掉。

**证据**：
- `apps/agent-service/src/production-web-push.ts:445`：`sourceKey: \`proactive:${push.id}\``。
- 同文件 `:460`：`sourceKey: \`proposal:${proposal.id}:${proposal.proposedAt}\``。
- 同文件 `:452-466`：`newest` reduce，只推最新一条提议。

**建议**：
- 在 inbox 条目、提议、告知、push outbox 存同一个 `originSourceKey`（例如邮件串编号/来源 ref）；入 push 前查是否已有同一 key 的成功推送。
- 加“同一封邮件只响一次”的端到端测试。

---

## 中-10　“上次做到哪”每次更新加密载荷，旧载荷/旧告知没有清理

**问题**：方案说任务说明和“做到哪”是两份加密载荷，后者每次更新。但没有写旧载荷的删除；`payloads.put` 按 ref 存，旧版本会残留。删除/过期/撤销定时时，task/progress/tell 载荷的清理也没写。

**证据**：
- `production-think-inbox.ts:200-209`：载荷按 ref 写入；清理只覆盖入口摘要（`settledSummaries`/`clearSummary`），不覆盖新的定时载荷。
- 方案第 2 节：“两份加密载荷，后者每次更新”。

**建议**：
- 每次更新后删除旧 ref（同事务或可重试），删除定时/记忆时级联清理；加保留上限和 GC。
- 加“更新 N 次后旧载荷数量不增长”的测试。

---

## 低-1　`told` 只是 proposal 的结果值，没有生产写入/读取

**问题**：方案说“决策记录的结果用已有的 `told`”。`told` 确实在 `DECISION_OUTCOMES.proposal` 里，但没有生产代码写它；只有测试插入过。把“非提议的告知”记成 `proposal/told` 会让提议统计和导出语义混淆。

**证据**：
- `packages/application/src/ports/decision-ledger.ts:78-90`：`"told"` 在 `proposal` 下。
- `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:61-62`：按 kind 校验 outcome。
- 全仓库搜索 `told`：生产代码只在 `decision-ledger.ts` 出现；测试在 `packages/persistence-sqlite/test/decision-ledger-reference-tables.contract.test.ts:234` 插入。

**建议**：新增 decision kind `tell`，或在告知表里自带结果列；不要借用 proposal 的结果枚举。

---

## 低-2　新工具未登记 action row / prompt catalog / egress

**问题**：新对话工具需要 `PRODUCTION_TOOL_ACTION_ROWS` 行、prompt catalog 条目和 manifest 摘要；否则授权层会把它当未知工具，或 `npm run check` 的提示词目录检查失败。方案没提。

**证据**：
- `apps/agent-service/src/production-tool-actions.ts:143+`：所有工具在这里登记；`OWNER_WRITE_DEFAULTS` 在 `:61-73`。
- `docs/adr/0274-new-things-go-through-one-think-entrance.md:46`：提示词登记和摘要检查。

**建议**：把新工具加入 action rows、prompt catalog、manifest；如新增对外发文字的文件，登记 `scripts/check-egress-redaction.mjs`。

---

## 低-3　新定时表不在 governed deletion 的检查里

**问题**：`sqlite-governed-deletion.ts` 只检查 `scheduled_jobs`。如果新定时表不复用 `scheduled_jobs`，想一想线程不会被新定时保护；如果定时引用线程上下文，删线程会断链。

**证据**：
- `packages/persistence-sqlite/src/sqlite-governed-deletion.ts:595`：`AND NOT EXISTS (SELECT 1 FROM scheduled_jobs j WHERE j.thread_id = t.id AND j.status = 'active')`。

**建议**：复用 `scheduled_jobs`，或把新表加入删除检查；如果定时不依赖线程，就在方案里说明“删线程不影响定时”，并确保 task/progress 已复制。

---

## 低-4　对一手来源的解读有偏差

**已核对**：
- Anthropic “Building always-on agents”（<https://claude.com/resources/articles/building-always-on-agents>）：原文确实有 “events can be deduplicated based on unique identifiers from the source”“A follow-up is a deadline that the agent sets for itself”“A timer doesn’t initiate a run on its own”“The inbox should be the source of truth”“if the worker dies mid-run, a new one can pick up the same event and retry”“The worker should batch pending events together”“it’s better for the agent to start quiet and then earn more of the user’s attention over time”。
- Claude Code scheduled tasks（<https://code.claude.com/docs/en/scheduled-tasks>）：原文确实有 “A session can hold up to 50 scheduled tasks at once”“Recurring tasks automatically expire 7 days after creation”“No catch-up for missed fires…”“A restored recurring task doesn’t fire for the runs it missed while the session wasn’t running.”

**偏差**：
- 方案说“周期任务只跑最近一次”是“采纳”；Claude Code 原文是“不补跑”，这不是采纳。
- 方案说“周期任务多久没被你看过就自动暂停……对应 Claude Code 的 7 天到期”；Claude Code 的 7 天是按**创建时间**到期，不是“没被你看过”。这是不同的信号，不能写成对应。
- 方案没有做 Anthropic 建议的“worker 批量合并待处理事件”，而是明确“不做”；可以不做，但要写成自己的取舍，不要写成“业界共同点”。

---

# 二、推测 / 未核实

以下不是代码已证实，而是方案没写清、或取决于实现：

1. **新工具是否有按对话创建的 gating**：方案没写。如果没有，高-1 成立；如果有，需补测试。
2. **告知推送用新 kind 还是复用 reminder**：方案没写。复用且 sourceKey 不匹配会落入 `unknown`；新 kind 会被 DB CHECK 拒绝。两种都需要明确。
3. **调度器是否把 `misfireGraceMs` 设成覆盖停机期**：方案没写。设得很大则高-3 的“晚到”可发生，但会引入“很旧的一次性任务也触发”的问题，需要配合 `expiresAt`。
4. **“来源编号”是原编号还是摘要**：方案写“一律做成定长摘要”，我按摘要理解；如果实现改为原编号 + 仅版本摘要，高-6 可解。
5. **告知表是否加密存储原话**：方案只说“过出口遮盖”，没说加密/分类。若是明文，属于安全问题。
6. **第 1 步的 iPhone 提议界面**：方案自己承认没读；我也没有在仓库里找到主人提议的 home source。
7. **调度循环是否有单飞/批量/退避**：方案没写；现有 `production-proactive` 没有单飞，`production-perception-extraction` 有，需明确采用哪种。
8. **设置页是否能容纳新键**：定义表是封闭数组，补文案/单位后可以；但方案没列具体键。
9. **Gemini/OpenAI 的一手来源**：方案引用的 Gemini 页面和 OpenAI 403 摘要我没有逐字核对；不作为依据。
10. **生产延迟**：方案自己标“未实测”；我也没有生产机数据。

---

# 三、侧重检查

我按“错误路径、不合规/不可信输入、安全、资源耗尽、不可撤销、文档/规则一致性”逐项查了：

- **错误路径**：`enqueue` 的 duplicate 不看状态（高-2）；worker 的 `failed` 是终态（高-2）；`evaluateDurableSchedule` 的 `missed/skipped`（高-3）；scheduler 在 enqueue 后推进（高-2）；调度循环没有单飞/退避（中-6）。结论：方案的“不丢、不重”只在理想路径成立。
- **不可信输入**：邮件摘要进入 think run，模型可产出告知/跟进；`common()` 硬编码 external_content（中-7）；“引用原话”只验证出处，不验证主张（中-2）；外部内容可引出跟进并放大（中-2）。结论：注入防线不足。
- **安全**：新工具触发老对话换新（高-1）；新 push kind/class 绕过延后/降频（高-5）；告知表复制记忆原文（中-1）；源编号哈希导致无法审计回溯（高-6）。结论：有一处 cache/成本、一处隐私、一处可审计性问题。
- **资源耗尽**：无 per-schedule 成本预算（高-4）；daily limit 可饿死定时（中-6）；自我再定跟进可形成放大链（中-2）；旧载荷不清理（中-10）。结论：需要预算、配额、退避、GC。
- **不可撤销**：撤销定时只停未来触发，不能撤回已推送的告知（方案未说明）；告知里的记忆副本不随记忆删除（中-1）；数据导出新增周期任务需要 v5 和导入语义（中-3）。结论：不可撤销面主要落在“已发出的告知/复制的原文”，方案没有覆盖。
- **文档/规则一致性**：`AGENTS.md:43` 和 `.agents/instructions/prompt-prefix.md:42` 要求工具按对话冻结、改工具只对新对话生效；方案的高-1 与这条冲突。`docs/adr/0274...:105` 明确“来源接入和旧代码清理在后续 PR”，方案没有引用这一点作为边界。`docs/adr/0209...:58` 的“主人明说直接生效”只针对规则，不自动适用于新工具；方案把它推广到“建跟进不再多点一次”，但授权层是 `owner_scope`，需要确认是否真的免审批。`docs/adr/0265...` 要求迁移编号唯一；方案说“名字由编码线程定”，没提迁移 ID 规则。数据导出 ADR 0233/0246/0272 要求升版本；方案没提。结论：方案与规则文件有两处硬冲突，与数据导出先例有一处漏项。

---

# 四、逐条回答必答问题

## 1. 会不会改变模型已经见过的请求开头？是不是仍然只在末尾追加？

**会，按现方案会改变老对话的请求开头。** 理由不是历史消息被改写，而是**工具集合变了**：

- `thread-prompt-bundle-service.ts:89` 在 `toolNames` 变化时返回 `tool_set_changed`；
- `:208-211` 新建 bundle 并记录一次失效；
- `pi-runtime-adapter.ts:1393-1403` 用当前全部工具名参与冻结身份；
- `pi-runtime-adapter.ts:1402` 的系统提示包含工具定义。

所以：

- **系统提示文本**：方案说“不动”只对提示词目录里的固定文字成立；渲染后的 system prompt 因工具定义变化而变。
- **历史消息**：没有被改写；这一点符合“只追加”。
- **每轮会变的值**：任务说明、做到哪、最近告知摘要放在最后一条消息，符合规则；但工具定义不在最后一条消息，它在最前面。
- **新想一想运行**：每次新对话，动作清单变化不影响已有对话；但前提是已有 think 条目的 message payload 已存且复用（`production-think-runner.ts:179-190`），这点方案没写清。

**结论**：只有在给新工具加“只对发布后创建的对话提供”的 gating 后，才能回答“不会改变已有请求开头，且值只在最后一条消息”。否则必须按 `prompt-prefix.md` 第 4/6 条走“出方案 + Andy 同意 + 记录一次换新”。

## 2. 会不会让同一段文字在不同请求里变成不同的字节？

**方案声称会存储一次并复用，方向是对的；但有三个未定义的确定性风险：**

1. **“最近已经告诉过主人的几件事”没有规定排序/并列/裁剪**。如果从数据库按时间取，时间相同没有 `id` 兜底，顺序可能不稳定；必须写死 `ORDER BY occurredAt, id`，并在存储前裁到固定字符数。
2. **`sourceVersion` 若用“第几次”以外的可变值**（例如修订号、时间），要保证同一 occurrence 在重试时字节相同；建议用单调的 `occurrenceId`，并把它作为去重键的一部分。
3. **新工具 schema 的 JSON 顺序**：`thread-prompt-bundle-service.ts` 用 `JSON.stringify(frozenDefinitions.map(frozenToolText))` 冻结工具；新工具必须按固定顺序、固定对象键顺序生成，不能依赖 `Map`/`Set`/数据库返回顺序。

只要这三点写死，**同一段历史不会因为后来的请求变成不同字节**；新告知/新工具结果都是新追加的内容，允许不同。

## 3. 有没有对应的自动检查？反向用例真的会失败吗？

**不够，方案没有把“会失败的自动检查”写出来。** 现有仓库已经有这些门槛：

- `npm run check:prompt-prefix`（`AGENTS.md:51`、`.agents/instructions/prompt-prefix.md:76`）；
- `npm run check` 里的 `prompt-catalog` 摘要检查（`docs/adr/0274...:46`）；
- `check:egress-redaction`（`docs/adr/0274...:45`）；
- `check:data-export`（`docs/adr/0200...:61`、`docs/adr/0246...:65`）；
- `check:incident-gates`（`docs/incidents-and-gates.md:18`）；
- layer0 相关测试声明（`docs/incidents-and-gates.md:44`）。

方案只写了“每一步一个 PR，各有自动测试和 iPhone 真机验收”，没有说这些门槛怎么跑、反向用例在旧代码上是否会红。按问题 3 的要求，**反向用例必须先在旧代码上失败**；方案的“反向”多是 iPhone 验收场景，不是可执行的失败测试。

至少需要补：

- 老对话请求头逐字节不变（新工具上线后）——旧代码应“无此功能”，新代码通过；但要用 `check:prompt-prefix` 证明。
- `duplicate` 状态为 `expired/failed` 时调度器不推进——旧代码会推进，测试应红。
- 停机超过 `misfireGrace` 后跟进仍触发一次——旧代码 `missed`，测试应红。
- 每日配额满时定时条目不会过期丢失——旧代码会丢失。
- 告知推送落入 `unknown` 时不延后——旧代码会直接投递，测试应红。
- 钓鱼邮件（提到真实记忆 + 要求转账）不产生可推送告知——旧代码会产生。
- 删除记忆后告知不再显示原文——旧代码会保留副本。
- 数据导出 v4 文件整份拒绝——旧代码会接受/缺字段。

## 4. 每个产生/修改的值，两端都能接受吗？

不能全部接受。逐项如下（产生处 → 使用/校验处 → 结论）：

| 值 | 产生处 | 使用/校验处 | 结论 |
| --- | --- | --- | --- |
| 新 `sourceKind` | `ThinkSourceRegistry.register`（`production-think-inbox.ts:86-92`） | `production-think-inbox.ts:149`；DB `source_kind` 1..64 | 新串必须匹配 `KIND` 正则；方案没列具体串，需补 |
| `sourceRef` | 方案：来源做定长摘要 | inbox 1..256（`20261115004401_think_inbox.sql:6`）；proposal `bounded(...,256)`（`production-think-actions.ts:32`）；导出 `sourceRef` 1..256（`schemas.ts:263`） | 摘要不可逆，导航断链（高-6） |
| `sourceVersion` | 方案：第几次/摘要 | inbox ≤256（`...think_inbox.sql:7`）；proposal `bounded(...,128)`（`production-think-actions.ts:23,43`）；导出 ≤128（`schemas.ts:264`） | 必须 ≤128 且单调；方案未写 |
| 定时 occurrence | 新表“已触发次数” | inbox 唯一键（`...think_inbox.sql:16`）、proposal `sourceVersion` | 若可重复/不含 revision，会误去重 |
| 新 push kind | 新告知 | `WebPushKind`（`web-push.ts:5`）；DB CHECK（`0058:26`、`0061:6`、apple push:93）；`pushClassOf`（`web-push-gate.ts:28-41`） | 需迁移+映射，否则 DB 拒绝或 `unknown` 直接投递 |
| 新 think 结局 | 运行最后 JSON | `ThinkInboxStatus`（`think-inbox.ts:3-9`）；`finish`（`sqlite-think-inbox-operations.ts:261`）；`ThinkRunResult`（`production-think-worker.ts:12`） | 需新列或扩联合；方案未写 |
| 新 settings key | 方案 | `THINK_SETTING_DEFINITIONS`（`configuration.ts:417`）；`THINK_SETTING_TEXT`（`production-think-settings.ts:26`）；`THINK_SETTING_UNIT_VALUE`（`:148`） | 缺文案/单位会失败 |
| 周期任务导出 | 方案 | `FORMAT_VERSION` v4（`schemas.ts:10`）；`MANIFEST_SCHEMA` required/additionalProperties false（`:656-747`）；`DATA_FILES`（`:773-792`） | 需 v5 |
| 告知/定时 id | 方案 | 首页 `fitsContract`（`production-home.ts:701-721`）；gateway contracts；push `sourceKey` | 未定义格式/长度，未核实 |
| 新工具 | 方案 | `PRODUCTION_TOOL_ACTION_ROWS`（`production-tool-actions.ts:143+`）；prompt manifest（ADR 0274 前提 9） | 需登记 |
| `told` | 方案 | `DECISION_OUTCOMES.proposal`（`decision-ledger.ts:78-90`）；`sqlite-decision-ledger-operations.ts:61-62` | 能写，但语义混 |
| 新定时表 | 方案 | governed deletion 只查 `scheduled_jobs`（`sqlite-governed-deletion.ts:595`） | 新表不在删除检查 |

---

# 五、如果由我来定，我会怎样改这份方案

我会保留“单一入口 + 定时只写入口 + 运行只读 + 告知有出处”的主干，但先把契约和失败路径定死，再写功能。顺序如下：

**第 0 步：先定契约和门槛，不写业务。**
- 定 `scheduled_followups` 状态机（`pending/enqueued/running/succeeded/failed/expired/missed`）、`occurrenceId`、`expiresAt`、`budgetMicros/spentMicros`、`nextRunAt`、`revision`。
- 定告知表：加密载荷、分类、`sourceRef`、`memoryRefs`、`origin`、`createdAt`、`readAt`、`pushState`。
- 定 push：是新增 `tell` kind + `PushClass`，还是只进首页；如果是新增，先写迁移（三处 CHECK）、映射、UI 开关、降频键。
- 定导出：v5、schema、counts、verify/import。
- 定设置：每个键的三语文案、单位、min/max、快照契约。
- 定新工具：action row、prompt catalog、manifest、egress 登记。

**第 1 步：邮件接入 + 只读提议，不动对话工具。**
- 邮件检查写 inbox，sourceRef 用原始邮件串编号（不哈希），summary 加密。
- 提议箱显示用现有接口；如果首页没有提议，先不把“首页出现提议”写进验收。
- 加 `sourceRef` 回到原邮件的端到端测试。

**第 2 步：跟进/周期，按状态机做，不按“入队即成功”。**
- 写 inbox 成功后，定时状态 `enqueued`；只有 entry 到 `proposed/skipped`（且 skipped 原因是“决定不做”）才 `succeeded` 并推进；`failed/expired` 重试或标失败并告知。
- `duplicate` 时读回 entry 状态，按上述规则处理。
- 不用 `evaluateDurableSchedule` 的 one-shot `missed`；自己写显式 `due/expires/misfire` 策略，或给它传覆盖停机期的 grace + 额外 `expiresAt` 检查。
- 调度循环：单飞、每 tick 批量上限、指数退避、定时来源独立每日配额。
- 成本：每条定时 `budgetMicros`，超限自动暂停并告知。

**第 3 步：对话工具，只对新对话。**
- 加按 `thread.createdAt`/feature flag 的 gating；老对话的 descriptor 列表不含新工具。
- 新工具登记 action row（`owner_scope`/`CREATE_OR_UPDATE`）、prompt catalog、manifest。
- “主人明说就建”要用现有 `owner_scope` 授权证明真的免审批；如果授权层仍要审批，就改成“回执 + 一键撤销”，不要声称“不再多点一次”。
- 加 `check:prompt-prefix` 用例：老对话请求头逐字节不变。

**第 4 步：告知。**
- 只存 refs + 加密原话，不复制记忆正文；删除记忆时告知显示“来源已删除”。
- 外部内容引出的告知默认只进首页并要求确认，或限制为逐字事实引用；加钓鱼回放测试。
- 如果要推送，走新 `tell` kind + `PushClass`，不要复用 `reminder` 的 `unknown` 路径。
- 在 inbox/提议/告知/outbox 存 `originSourceKey`，实现“同一件事最多响一次”。

**第 5 步：导出/设置/App。**
- 数据导出 v5，旧文件拒绝；周期任务导出，自跟进/告知按“你的东西”定义清楚。
- 设置键补三语文案/单位；App 清单读定时表列，不另算。
- 加 `check:data-export`、`check:prompt-prefix`、`check:incident-gates`、`check:layer0` 的具体用例，并先证明反向用例在旧代码上红。

**一句话取舍**：这份方案最该改的不是“入口”和“只读运行”，而是三件事——**别在入队成功时就宣布定时完成**、**别把工具新增说成不影响老对话**、**别把新推送说成自动继承旧推送策略**。这三件事定死，后面的功能才站得住。
