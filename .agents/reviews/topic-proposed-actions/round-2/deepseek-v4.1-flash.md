总体判断：方向合理（提议与执行分离、模型不直接执行、按钮文字由程序生成），但按当前文字直接实施，会踩到读通道写库、数据清除/导出漏表、I-73 式“值只在两端之一被接受”、状态机与撤销、费用记账五类问题。建议先把契约/状态机/数据生命周期补齐，再进入实现。

---

# 一、证实的

## 1. 【严重】首页读取时写 `superseded`，会违反只读读通道

**问题**：方案 §5 写“首页读取时顺手比对目标版本，不一致的不显示并标 `superseded`”。这会让一个 query 产生写入。

**证据**：
- `README` 不相关；项目规定见 [ADR 0131](docs/adr/0131-read-lane-separate-readonly-connection.md)：读走 `readonly: true` 的独立连接，“读线程只读，发出写语句会直接报 `attempt to write a readonly database`”（第 55–56 行）；后果里又写“读线程看到的是已提交的数据”（第 79 行）。
- `packages/persistence-sqlite/src/durable-adapters.ts:1071` 把 `proactive.listInsights` 标成 `context.read`，`:1075` 把 `proactive.updateInsight` 标成 `context.write`。
- `apps/agent-service/src/production-proactive.ts:508` 的 `proactive.overview.read` 走 `this.overview()`；`packages/application/src/services/proactive-overview.ts:145` 在里面遍历 insights。方案如果在这个路径里更新 proposal，按读通道会直接报只读错误；如果改走写通道，则 query 变成写，页面轮询会放大写入。
- SQLite 官方对 WAL 的说明：“readers do not block writers and a writer does not block readers”“there can only be one writer at a time”，https://www.sqlite.org/wal.html 。

**建议**：读取层保持纯读。首页只按“目标版本不一致 → 本条不显示/显示为已过期”做内存判断，不改库；把 `superseded` 的落库放到后台对账任务，或放到 `proactive.proposal.respond` 的接受前校验里。增加一条测试：在只读连接上调用 `proactive.overview.read` 不得发出任何写语句。

## 2. 【严重】新表没有接进“断开 Gmail / 全部删除 / 数据导出”，会留下邮件派生数据

**问题**：方案 §3 存“参数（加密存）、引用的邮件原话、目标编号、问句、依据”，但 §10 只列了建表和两次重建，没有把 `action_proposals` 接进现有的清除和导出路径。

**证据**：
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:556-573` 的 `clearRecords` 只删 `source_insights`、`proactive_processed_messages`、`proactive_pushes`、`proactive_push_backoff` 和 `decision_ledger kind='proactive'`；`:462-485` 的 `collectRefs` 只收集这三类 payload 引用。新表的加密参数和邮件原话不会被删，payload 也会成为孤立密文。
- `packages/persistence-sqlite/src/data-export/snapshot.ts:175-211` 只导出 `decision_ledger`、`source_insights`、`proactive_processed_messages`，没有新表；导入白名单 `data-export/import.ts:80-86` 也没有。
- 现有设计承诺过“清除记录或断开 Gmail 时一并删除”（`docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md:150`）和“断开时……删掉所有提炼结果”（同文件 `:223`）。

**建议**：把 `action_proposals` 加入 `collectRefs`、`clearRecords`、`removeSource`、数据导出 schema/JSONL/import、`check:data-export` 的用例和 `REQUIRED` 计数；增加“断开后新表为空、密文 payload 已删”的反向测试。邮箱原文引用必须和 `source_insights` 同生命周期，不能只在“全部删除”里漏掉。

## 3. 【高】`reminder.create` 没有“目标”，过不了方案自己写的目标校验和表结构

**问题**：方案 §1 登记 `reminder.create`，但 §2 的校验是“目标存在且属于主人”，§3 的列是“目标编号和目标版本（提醒的 `updatedAt`）”，§4 第 2 步又要求“目标还在且版本没变”。新建提醒没有目标，按字面无法创建提议；内容指纹也要求“目标编号和版本”。

**证据**：方案原文以上三处；代码侧 `apps/agent-service/src/production-reminder-writer.ts:165-166` 的 `create` 是从 `key` 生成新的 `memoryId/reminderId`，调用方并不传目标。

**建议**：把目标做成按动作区分的可空结构：`target_kind = none | reminder`；`reminder.create` 不要求目标，指纹里用“创建幂等键 + 规范化参数 + 来源编号/版本”；`reminder.reschedule`/`reminder.cancel` 才要求目标。校验函数按动作分派，不能用一个“目标必须存在”的通用规则。测试里必须有 `reminder.create` 无目标的正向用例和“create 被错误要求目标”的反向用例。

## 4. 【高】`reminder.cancel` 与“删除类不许由不可信内容提出”自相矛盾，且可能绕开 CRITICAL

**问题**：方案 §1 说“对外发送、删除、花钱、改权限这些类别，不允许由不可信内容提出一键执行的提议”，但同一节又把 `reminder.cancel` 登记为第一版可由邮件提出的动作。取消一条提醒最自然映射到现有 `DELETE`，而 `DELETE` 在风险表里是 HIGH；如果不可撤销，`computeActionRisk` 还会抬到 CRITICAL。

**证据**：
- `packages/application/src/services/action-policy-service.ts:37-50`：`DELETE: "HIGH"`。
- 同文件 `:58-68`：`if (intent.actionKind === "DELETE" && !intent.reversible) facts.push("CRITICAL")`；`:169-175` 要求最终风险等于 `computeActionRisk` 的结果。
- 方案 §1 只在“风险档位”里提 `ACTION_KIND_RISK_BASELINE`，没有说会用 `computeActionRisk` 的 `reversible`/`credentialOrAccessChange`/`disclosure` 规则。

**建议**：明确 `reminder.cancel` 的 `ActionKind`。如果按 `DELETE` 处理，就不要允许它由邮件内容提出（第一版直接不做从邮件取消）；如果一定要做，必须要求 HIGH/CRITICAL 的本人再认证，并且加“目标必须和这封邮件/这个线程有关”的确定性校验。风险不能只查 baseline，必须复用 `computeActionRisk`，否则“不可撤销的删除”会被低估。

## 5. 【高】“绑定串”很可能过不了 `machineString`，新命令也没有列全 I-73 的两端

**问题**：方案 §4 说接受时核对“提议编号、版本号、内容指纹三样”，§9 说“绑定串是‘提议编号、版本号、内容指纹’”。如果把它做成一个字符串，很可能超过 `machineString` 的 128 字符或含不允许的字符；如果做成对象，则契约必须有对应字段。方案没有逐项列出契约、后端、前端、测试的改动。

**证据**：
- `packages/gateway-contracts/src/validation.ts:49-59`：`machineString` 要求 `input.length <= 128` 且 `^[A-Za-z0-9][A-Za-z0-9._:-]*$`。JSON 的 `{}`、`"`、`|`、空格都不允许；提议编号本身可能到 128 字符，再拼 64 位指纹必然超限。
- `packages/gateway-contracts/src/contracts-v2.ts:35-46` 是 `GATEWAY_V2_MESSAGE_TYPES`；`:670-676` 是现有命令 schema；`:2584-2587` 是 schema 注册表。
- `apps/agent-service/src/production-proactive.ts:53-64` 的 `PRODUCTION_PROACTIVE_OPERATIONS` 和 `:625` 的 `execute` switch 都要加新命令。
- `scripts/check-operations.mjs:202-213` 要求每个契约操作同时有“后端实现、调用方、测试”，否则 `OPERATION_INCOMPLETE`。
- `docs/incidents-and-gates.md:112`（I-73）原话：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”。

**建议**：不要做拼接的“绑定串”。命令 payload 拆成三个显式字段：`proposalId: machineString`、`expectedVersion: integer(1)`、`contentFingerprint: machineString`（如果存 64 位 hex，长度可行；若带 `sha256:` 前缀则 71，仍可行，但不要和编号拼在一起）。同时补：`contracts-v2.ts` 的操作列表、`commandEnvelope` schema、schema 注册表、`PRODUCTION_PROACTIVE_OPERATIONS`、`execute`、控制中心客户端、i18n、`check:operations` 的测试。为这三个值各写“产生端/使用端”的契约测试。

## 6. 【高】状态机和撤销定义自相矛盾，`succeeded → undone` 与“回到 open”冲突

**问题**：方案 §3 写 `succeeded → undone`，§4 撤销又写“提议回到 `open`”；§4 拒绝写“给撤销”，但状态表没有 `declined → open`；撤销写“提醒回到 `open`”，但记忆提醒的状态是 `scheduled/dismissed/cancelled`，没有 `open`。

**证据**：
- `packages/application/src/ports/memory-reminders.ts:14`：`status: "scheduled" | "dismissed" | "cancelled"`。
- 方案 §3、§4 原文。
- `packages/application/src/services/durable-memory-service.ts:384-386` 的 `delete` 是 `deactivation` 到 `deletion_pending`，不是硬删除；`memory_reminders` 行不会自动消失（`sqlite-memory-reminder-operations.ts:11-12` 只是用 `JOIN memory_records ... status='active'` 隐藏）。

**建议**：先写一张显式状态转移表，至少包括：
- `open → executing → succeeded → undone → open`（或 `undone` 终态，由新提议重新提出，二选一，不能两种都写）；
- `open → declined → open`（如果拒绝可撤销）或明确“拒绝不可撤销”；
- `open → superseded/expired/withdrawn` 为终态；
- 目标状态用记忆提醒自己的 `scheduled/dismissed/cancelled`，不要用 `open`。
为每个动作定义撤销的目标值：`reschedule` 恢复 `dueAt/remindAt`，`cancel` 恢复 `status/dismissedAt`，`create` 取消提醒并软删记忆（并记录 tombstone）。每条转移都要有正向和反向测试。

## 7. 【高/中】撤销时用创建时的 `updatedAt`，执行后必然对不上

**问题**：方案 §3 只存“目标编号和目标版本（提醒的 `updatedAt`）”，§4 撤销要求“按原样恢复目标（目标在这之后又被改过就拒绝）”。但执行本身会改目标的 `updatedAt`；撤销拿创建时的版本去比，必然冲突。

**证据**：
- `packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:155-186` 的 `UPDATE ... WHERE id = ? AND updated_at = ?` 用 `expectedUpdatedAt` 做条件。
- `apps/agent-service/src/production-reminder-writer.ts:315-332` 的 `cancel` 每次都会写新的 `updatedAt`；方案新加的 `reschedule` 也会走同一个 `update`。
- 方案 §3 没有“执行后的目标版本”列。

**建议**：执行函数返回执行后的目标 `updatedAt`，在同一个事务里写进 `action_proposals.executed_target_updated_at`（或 `execution_result` 的加密内容）；撤销用这个新版本做 `expectedUpdatedAt`。同时保存 `created_reminder_id`/`created_memory_id`，供 `reminder.create` 撤销。测试：执行成功后立刻撤销必须成功；执行后目标又被改过一次，撤销必须拒绝。

## 8. 【中】`model_usage_observations` 的用途是典型的三端值，方案只提了重建表

**问题**：方案 §10 说“重建 `model_usage_observations` 加用途 `action-proposal`”，但 §2 又说费用记在邮件检查的 `proactive_decisions` 上，不重复算。两处没有说清“这个用途到底用来做什么”；更重要的是，加用途不只改 DB。

**证据**：
- `packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql:88-93`：`purpose` 的 CHECK 只列到 `review-prereview`、`other`。
- `packages/application/src/ports/model-usage.ts:3-13` 的 `MODEL_USAGE_PURPOSES` 没有 `action-proposal`；`:59-63` 的 `modelUsagePurpose` 遇到未知值会落到 `other`。
- `packages/persistence-sqlite/src/sqlite-model-usage-operations.ts:20-22` 的 `valid()` 用 `MODEL_USAGE_PURPOSES` 校验，没加就会拒绝写入。
- 现有每日费用上限 `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:987-996` 只统计 `decision_ledger.kind='proactive'`；如果 proposal 的费用写到 `action_proposal` 决策记录，就不会计入上限。

**建议**：二选一，不要两边都记：
(a) 用 `model_usage_observations` 记录用量/次数，费用仍只写 `proactive_decisions`，则必须同步改 `MODEL_USAGE_PURPOSES`、`valid()`、`modelUsagePurpose`、用量页和测试；
(b) 不新增用途，只在 `decision_ledger` 的 `inputs` 里记 token/次数，避免重建大表和两端不一致。
无论哪种，都写一条测试：写入 `action-proposal` 用量成功，读回不被映射成 `other`；并确认每日上限的 `costSince` 能覆盖 proposal 费用。

## 9. 【中】`decision_ledger` 的 `kind`/`outcome`/`inputs` 不只是一张表的 CHECK

**问题**：方案 §8 只说 `decision_ledger.kind` 是表约束，要重建表；但新 `kind` 还会改 TS 联合类型、outcome 白名单、inputs 类型、SQLite 读写映射、清空逻辑、数据导出。方案 §8 又说“输入里记邮件、记忆、目标、动作清单的摘要”，这是新的 `inputs` 字段。

**证据**：
- `packages/application/src/ports/decision-ledger.ts:32-40` 的 `DECISION_KINDS`；`:44` 的 `LedgerWriteKind`；`:46-60` 的 `DECISION_OUTCOMES`；`:104-133` 的 `DecisionInputs` 是封闭结构。
- `packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:21-26`、`:61-63`、`:64-75`：非 `proactive` 的 kind 必须 `scenario IS NULL`、`verdict IS NULL`、`outcome` 非空；如果方案想给 proposal 记 `scenario='gmail'`，会被约束拒绝。
- `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:191-242` 逐字段读写 `inputs`，新字段不加就会丢。
- 清空逻辑 `sqlite-proactive-operations.ts:571` 只删 `kind='proactive'`；新 `kind='action_proposal'` 不会被删。

**建议**：新增 `action_proposal` 时，成组修改：`DECISION_KINDS`、`DECISION_OUTCOMES`、`DecisionInputs`、SQLite 读写、决策链页面、`costSince`/`clearRecords`、数据导出；明确 `scenario`/`verdict` 为 NULL，来源放到 `subject_ref` 或 `inputs`。为“新 kind 能写入、能读出、能清空、能导出”各写测试。

## 10. 【中】新提示词没有进 `prompt-catalog`，`npm run check` 会失败

**问题**：方案 §2 有“固定说明 → 可用动作清单 → 这件事……”，但没有提 `packages/prompt-catalog` 和 `prompt-manifest.json`。

**证据**：
- `apps/agent-service/test/prompt-catalog.unit.test.ts:299-337`：所有发给模型的提示词必须在 catalog；manifest 的 digest 不更新会报 `PROMPT_MANIFEST_STALE`；源码里出现 catalog 外的提示词字面量会报 `PROMPT_TOOL_RESULT_OUTSIDE_CATALOG`。
- `packages/prompt-catalog/src/trusted.ts:11-14` 决定哪些固定文字进入 `TRUSTED_PROMPT_TEXTS`；这直接影响遮盖规则（`.claude/rules/prompt-prefix.md:53`）。
- `packages/prompt-catalog/src/mail.ts:3-34` 是现有邮件判断提示词的写法，新 proposal 提示词应照这个模式加。

**建议**：新增 `packages/prompt-catalog/src/action-proposal.ts`（或 `proposal.ts`），把固定说明、动作清单标题、日期/当前时间模板都放进去；在 `index.ts`、`trusted.ts` 注册；更新 `prompt-manifest.json` 的 `sha256`、`changedIn`、`reason`。固定部分不能含日期、时间、哈希或可用性；动作清单、目标现状、记忆、当前时间都放在固定文字之后的数据段。

## 11. 【中】审计记录放不下“指纹、风险档位、谁”

**问题**：方案 §4 说写审计记录“谁、什么时候、哪条提议、哪个指纹、风险档位”，但现有 `AuditRecord` 没有 detail 字段，SQLite 的 `appendAudit` 也没写 `detail_ref`。

**证据**：
- `packages/application/src/ports/observability.ts:109-117`：`AuditRecord` 只有 `id/ownerId/agentId/action/targetRef/outcome/occurredAt`。
- `packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:287-296` 的表有 `detail_ref`，但 `packages/persistence-sqlite/src/sqlite-durable-operations.ts:1831-1845` 的 INSERT 没有写它。
- `outcome` 只有 `accepted/rejected/completed/failed`；“谁”只有 owner/agent，没有设备/会话。

**建议**：扩展 `AuditRecord` 加 `detailRef`（或直接复用 `decision_ledger` 的 `inputs/content_ref`），把指纹、风险、`authenticationRef`、设备/会话放进 detail payload。接受时写 `accepted`，执行完成写 `completed`，失败写 `failed`；不要在执行前就写 `completed`。如果多设备要区分“谁”，加设备/会话标识。

## 12. 【中】过期时间用“目标的旧到期时间”，会把该做的改期提议立刻作废

**问题**：方案 §5 说“过期时间取三者最早：事情本身的时间、目标的到期时间、设置里的最长保留时间”。对“把一条已经逾期的提醒改到将来”的 `reminder.reschedule` 来说，目标的旧到期时间已经过去，提议会立刻过期。

**证据**：方案 §5 原文；`memory_reminders.due_at` 是目标当前到期时间（`packages/persistence-sqlite/src/migrations/0085_memory_reminder_cancelled.sql:6`）。

**建议**：改期类动作用“提议后的新到期时间”参与过期，而不是旧目标到期时间；或者对改期/取消给一个最小宽限（例如至少保留到 `now + 设置下限`）。测试：目标已逾期、提议改到明天，提议仍可接受；目标已逾期且提议是取消，也应可接受或明确说明不可接受。

## 13. 【中】“去重键”没有定义，也没有数据库唯一约束

**问题**：方案 §2/§5 说“同一件事同一版本下主人已经拒绝过同样的提议就不再提”，§3 有“去重键”，但没有说去重键由哪些字段组成、如何规范化，也没有说用唯一索引防并发。

**证据**：方案原文；现有类似表 `external_memory_proposals` 用唯一索引防重复（`docs/adr/0246-external-proposals-join-the-data-export-and-web.md:36`，引用迁移 0093 的 `external_memory_proposals_text_index`）。

**建议**：去重键 = `action_name + canonical(params) + target_id + target_version + source_id + source_version`，与 `content_fingerprint` 同源，不要再用一套独立的“问句文本”做键。加部分唯一索引：`UNIQUE(owner_id, agent_id, dedupe_key) WHERE status IN ('open','executing')`。测试：两次并发检查只产生一条；同一版本下拒绝后再提不产生；新邮件版本后允许新提议。

## 14. 【中】首页条目契约是严格对象，新增 `actions`/提议字段会直接失败

**问题**：方案 §9 要给 `insights` 条目加“肯定/否定按钮、绑定串、明细、undo”，但现有 `proactive.overview.snapshot` 的 `insights` schema 是严格对象，未知字段会被拒绝；`insights[].status` 也只有 `open/replied/done/muted`。

**证据**：
- `packages/gateway-contracts/src/validation.ts:174-176`：`object()` 遇到未声明字段直接 `unknown field`。
- `packages/gateway-contracts/src/contracts-v2.ts:422-440`：`insights[]` 的字段和 `status` 枚举。
- `apps/agent-service/src/production-proactive.ts:566-583` 是按字段逐个映射的，新增字段要同步。

**建议**：在契约里明确加一个 `proposal` 子对象（自己的 `status` 枚举、`actions`、`detail`、`fingerprint`、`undo`），不要把 proposal 状态硬塞进 `insights[].status`；同时更新 `production-proactive.ts` 的映射、控制中心类型/i18n、e2e fixture。加契约测试：未知字段必须失败；带 proposal 的完整 snapshot 必须通过。

## 15. 【中】新提议调用没有明确复用邮件遮盖/模型出站检查

**问题**：方案 §2 把“邮件、同一件事的相关邮件、判断调用写的待办和理由”送给 proposal 模型，但没有说这些文字是否先经过 `maskSensitiveText`，也没有说新的 `purpose` 如何接入 `mailEgress`/模型披露。

**证据**：
- `packages/application/src/services/proactive-mail-check-service.ts:330-332` 的 `masked()`；`:411-423` 对邮件正文/标题/附件名做遮盖；`:594-614` 的 `#reportMasked`。
- `apps/agent-service/src/service-main.ts:1880-1891` 给邮件判断挂了 `purpose: "mail-judgment"` 的 `onMasked`。
- 邮件判断模型写出的 `todo`/`reason` 也可能包含验证码/卡号；方案没有说这些输出在进入 proposal 提示词前是否再遮盖。

**建议**：proposal 调用复用同一个 `masked` 和 `mailEgress.reportMasked`，新 purpose 登记为 `action-proposal`（或复用 `mail-judgment`），只发送遮盖后的文本；对判断调用的 `todo/reason` 再过一次遮盖。测试：正文含卡号/验证码时，proposal 请求体里不得出现原值；引用原话里出现遮盖占位符的提议直接丢弃（可照 `2026-11-11-apple-device-body-design.md:399` 的做法）。

## 16. 【中】每个 `act` 邮件一次 proposal 调用，缺少每轮上限和独立预算

**问题**：方案 §2 说“每天次数上限（默认 30）”，但没有每轮上限；一封恶意邮件可以批量制造 `act` 结果，把当天的 proposal 次数/费用耗尽。

**证据**：方案 §2 原文；现有每轮预算在 `packages/application/src/services/proactive-mail-check-service.ts:717-723`（`perCheckMs`）和 `:915`（每日费用估算）里；现有每日费用只按 `kind='proactive'` 汇总（`sqlite-proactive-operations.ts:987-996`）。

**建议**：加每轮 proposal 上限（例如 1–3 条）、按发件人/线程去重、优先高优先级/高置信度；proposal 调用必须走同一个 `#invoke` 估算和截止时间，不能把检查拖过 `perCheckMs`。测试：一轮 20 封 `act` 邮件只调用上限次数；到上限时提醒仍出现、不带动作；每日上限与 proposal 费用不重复计算。

## 17. 【低/中】迁移耦合到别的 PR，风险高于收益

**问题**：方案 §10 说“苹果端第 3 批本来就要重建一次，请它顺带加上，否则这个方案自己重建”，又说 `model_usage_observations` 最好和首页打分那次重建合成一次。跨 PR 复用迁移会让两个改动的合并顺序、数据复制、回滚互相牵连。

**证据**：方案 §10 原文；SQLite 的 `ALTER TABLE` 不能直接新增 `CHECK`，只能重建（官方：https://www.sqlite.org/lang_altertable.html ）；`decision_ledger` 已经被 0087、0088、0089 多次重建，`model_usage_observations` 也已在 0091 重建过。

**建议**：本方案自带一个自包含迁移，明确 `PRAGMA foreign_keys`、建新表、复制、校验行数、再换名；不要依赖别的批次“顺带”。如果只是为了一个 purpose 值，优先不重建 `model_usage_observations`（见第 8 条），或改用无 CHECK 的独立表。

## 18. 【低】和苹果端 `perception_suggestions` 的合并没有更新设计文档/状态

**问题**：方案 §1 说“设计文档里的 `perception_suggestions` 并进这张提议表，不再单独建表”，但苹果端设计已经定义了一张独立表，字段/状态与 proposal 表不同。

**证据**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:339`：“表 `perception_suggestions`：……状态（`open`、`accepted`、`dismissed`、`expired`）……主人点‘好’时才真正去建。” proposal 表的状态是 `open/executing/succeeded/...`，且目标模型对“建日程/建提醒”不适用。

**建议**：要么保留 `perception_suggestions`，只在读取层合并展示；要么在方案里明确修改苹果端设计和 ADR，给出 `source='perception'`、目标可空、`accepted` 映射到 `succeeded` 的完整对照，并补数据导出/清空。不要只写一句“并进这张表”。

---

# 二、推测 / 未核实

## S1. 【中/推测】“服务器动作在同一个数据库事务里”可能做不到

方案 §4 要求“存原样、改目标、提议改成 succeeded、提醒改成 done”全在一个事务里。现有 `ProductionReminderWriter` 的 `create/cancel/update` 和 `ProactiveStorePort.record` 是分开的存储操作，应用层没有统一的 unit-of-work 事务端口。除非把执行做成一个新的 `ProactiveStorePort` 原子操作，否则跨服务“全成或全不成”无法保证。**未核实**：没有找到应用层可直接包住 memory/reminder/proactive 三套操作的通用事务 API。建议把 proposal 执行落到一个存储层原子方法，或用事务性 outbox（AWS 的一手说明：https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html ）。

## S2. 【中/推测】提议调用需要的 `source_insight_id` 和 `decision_id` 在 `#finish` 里才生成

`packages/application/src/services/proactive-mail-check-service.ts:1602-1637` 在 `#finish` 里才调用 `ids.next("source-insight")` 和 `ids.next("proactive-decision")`。如果提案调用在 `#finish` 之前，它拿不到来源编号和决策记录编号；如果在 `#finish` 之后，提醒/决策已经写入，费用和“同一轮”关联就要额外更新。方案没有写这个顺序。建议在进入 proposal 调用前先生成这两类 id，或把 proposal 写入放到 `#finish` 的同一事务里。

## S3. 【中/推测】新增固定提示词可能改变老对话的遮盖字节

按 `.claude/rules/prompt-prefix.md:41-44`，改了提示词文字只对新对话生效；但 `:53` 又说明 `TRUSTED_PROMPT_TEXTS` 清单变化会影响老对话里固定文字的遮盖判定。如果新 proposal 提示词里有长数字、验证码样式文字，并被加入 `trusted` 清单，老对话的遮盖结果可能变一次。方案没有提 catalog，**未核实**具体文字是否触发；实现时必须检查 `TRUSTED_PROMPT_TEXTS` 和遮盖测试。

## S4. 【中/推测】读回核实失败没有状态

方案 §4 说执行后“读回核实”，但没有说核实不一致时 proposal 是什么状态。服务器动作事务已提交但读回不一致，既不能简单回滚，也不属于“设备动作的 `result_unknown`”。建议增加 `executed_unverified`/`verification_failed` 或直接 `failed` 并保留补偿信息；否则首页可能显示“成功”但目标实际不对。

## S5. 【中/推测】推送/Watch/Mac 的“绑定串”是否被当成能力令牌

方案 §9 说“推送、Watch、Mac 菜单栏用同一份文字和绑定串”。如果绑定串只是“编号/版本/指纹”，它本身不是授权，必须仍要求已登录主人会话、CSRF，HIGH/CRITICAL 还要再认证；如果客户端把绑定串当作 bearer token，锁屏上看到通知的人就能执行。方案没有明确这一点。OWASP LLM01 的缓解措施写“Require human approval for high-risk actions”“Enforce privilege control and least privilege access”（https://genai.owasp.org/llmrisk/llm01-prompt-injection/ ）。建议在契约里明确“绑定串不是能力”，并让推送只做深链接，实际命令由解锁后的客户端提交。

---

# 三、侧重检查

- **错误路径**：检查了模型失败/超时/日上限/次数上限、事务回滚、读回失败、撤销冲突、重复接受、旧版本/旧指纹、目标被改、目标不存在、`reminder.create` 记忆 generation 未就绪。发现：失败时“留在 open + 显示没改成”没有持久错误字段；读回失败没有状态；撤销用旧版本必然冲突（第 7 条）。
- **不合规范或不可信输入**：检查了邮件内容 → 动作、目标 id 是否必须来自模型实际看到的快照、引用原话逐字校验、多余字段、过去时间、文字长度、时区、遮盖占位符。发现：目标只校验“存在且属于主人”，没有校验“在发出去的那份清单里”和“与这封邮件相关”；引用原话不绑定动作；模型写的问句可能误导（第 4、13 条；建议见后）。
- **安全**：检查了通知/按钮的授权、HIGH/CRITICAL 的再认证、审计内容、敏感数据出站、记忆投毒、数据清空/导出。发现：`reminder.cancel` 的 DELETE 分类与“不可信来源”规则冲突；审计缺指纹/风险/设备；新表未接清除/导出；proposal 调用未明确复用遮盖（第 2、4、11、15 条）。
- **资源耗尽**：检查了每轮/每日调用、成本估算、长提示词、首页轮询的 N+1、表增长。发现：缺少每轮上限和按发件人/线程去重；proposal 行和加密 payload 没有保留/清理策略（第 16 条）。
- **不可撤销操作**：检查了 `cancel`、`create` 的撤销、`result_unknown`、幂等键、执行后版本。发现：`create` 的撤销依赖软删记忆且没有提醒删除端口；`cancel` 被列为可提议但没有强制本人；幂等键没有要求“同键不同 payload 必须报错”（第 4、6、7 条）。
- **规则/文档/代码一致性**：核对了 `.claude/rules/prompt-prefix.md`、I-73、ADR 0131、数据导出、`prompt-catalog`、苹果端 `perception_suggestions`。发现：读通道写库、prompt catalog/manifest 缺失、新表未进导出/清空、苹果端表合并未更新设计（第 1、2、10、18 条）。

---

# 四、如果由我来定，我会怎样改

1. **把“提议生成”从邮件检查的关键路径里拆出来**：邮件检查仍在原事务里写 `source_insights` 和 `proactive_decisions`；同一事务写一条 outbox 行（来源编号、版本、决策编号、到期时间）。后台 worker 取 outbox 行调 proposal 模型，失败/超时不影响提醒。这样来源编号/决策编号已经存在，也不会把检查拖长。
2. **读取层保持纯读**：`proactive.overview.read` 只读 proposal，不改状态；目标版本不一致只在响应里标“已变化/不显示”；`superseded` 由后台对账或接受时落库。加一条“读通道不得写”的测试。
3. **动作登记表按动作分派**：每项显式写 `actionKind`、`reversible`、`requiresOwnerPresence`、`targetKind`、`paramsSchema`、`proposePolicy`、`execute/verify/undo`。统一用 `computeActionRisk`（含 `DELETE && !reversible → CRITICAL`），不要只查 `ACTION_KIND_RISK_BASELINE`。第一版从邮件只允许 `reminder.reschedule` 和 `reminder.create`；`reminder.cancel` 要么不做，要么要求 CRITICAL 本人再认证 + 目标与邮件相关。
4. **目标模型改成可空**：`reminder.create` 无目标；其余动作要求目标来自“本次发给模型的快照”，不是只要求“存在且属于主人”。`reminder.create` 的执行幂等键用 proposal id，避免重试创建两条。
5. **绑定拆成三个字段**：`proposalId`、`expectedVersion`、`contentFingerprint`；不要拼接。补契约、后端、前端、测试、`check:operations`。幂等键与 payload 指纹绑定，同键不同 payload 必须报错（Stripe 的一手说明：“The idempotency layer compares incoming parameters to those of the original request and errors if they’re not the same to prevent accidental misuse”，https://docs.stripe.com/api/idempotent_requests ）。
6. **状态机写成表**：明确 `open → executing → succeeded → undone`、`open → declined` 是否可撤销、`succeeded` 撤销后回 `open` 还是终态；目标状态用 `scheduled/dismissed/cancelled`。执行时记录 `executed_target_updated_at` 和创建出来的 id；撤销用执行后的版本比对。
7. **审计用现有 `audit_records` 的 `detail_ref`**：扩展 `AuditRecord` 或写 detail payload，记录指纹、风险、`authenticationRef`、设备/会话；接受/完成/失败分别写记录。HIGH/CRITICAL 走现有 `RecentAuthenticationGuard`（`apps/agent-service/src/production-approval-gateway.ts:222`）；推送只深链接，不作为授权。
8. **数据生命周期先接好**：`action_proposals` 进 `collectRefs`、`clearRecords`、`removeSource`、数据导出 schema/JSONL/import、`check:data-export`；过期/被取代的 proposal 和 payload 有保留期或随“全部删除”清理。
9. **提示词进 catalog**：固定说明、动作清单标题、日期模板都进 `packages/prompt-catalog`，注册 `trusted.ts`，更新 manifest；所有集合固定排序，参数用 canonical JSON；当前时间放最后。测试用打乱 DB 顺序、重复两次、不同 key 顺序/空白/Unicode 归一化，确保字节相同。
10. **自动检查补齐**：`check:operations`、`check:data-export`、`check:prompt-prefix`、prompt catalog 测试、读通道禁写、`model_usage` 用途三端、`decision_ledger` kind/outcome/inputs 三端、`reminder.create` 无目标、撤销用执行后版本、目标不在快照、去重唯一索引、每轮 proposal 上限、遮盖占位符拒绝。每条守卫都要有“去掉修复就失败”的反向用例。

---

# 五、必答问题

## 1. 会不会改变模型已经见过的请求开头？

**不会，前提是按方案描述真正做成“独立后台调用”**：
- 对话不新增工具、不改系统提示、不把提议问句/动作清单写进 thread 历史；提议调用用独立的 `proactive:<调用编号>`，不沿用对话的 system/tools（现有设计也是这样：`docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md:296`）。
- 新固定文字只进 `prompt-catalog`，按 `.claude/rules/prompt-prefix.md:41-44`，改了提示词只对新对话生效；老对话冻结，不改开头。
- 后台调用按 `.claude/rules/prompt-prefix.md:67`：固定指令在前，这次的数据在中，当前时间在最后。方案里“日期对照表和当前时间”在最后，符合。
- 会变的值（动作清单、目标现状、用到的记忆）都在后台调用的数据段；对话请求里没有它们。

**但方案没有把这几条写成实现约束**：如果实现时把动作清单塞进对话系统提示、把提议写进 thread 历史、或复用对话的 tool 定义，就会改变开头。建议在方案里显式写“proposal 调用不得读/写任何 thread 历史，不得复用对话 system/tools”，并加测试：开启 proposal 前后，同一对话的请求字节不变。遮盖结果方面，新固定文字进 `trusted` 清单后要检查是否改变老对话的遮盖（`.claude/rules/prompt-prefix.md:53`）。引用的一手依据：Anthropic 提示缓存“匹配是逐字节的”（`.claude/rules/prompt-prefix.md:6`，https://platform.claude.com/docs/en/build-with-claude/prompt-caching ）。

## 2. 会不会让同一段文字在不同请求里变成不同字节？

**目前不能保证，按方案文字还缺几处确定性约束**：
- 只规定了“动作清单按名字排序”“提醒按到期时间和编号排序”，没有规定“同一件事的相关邮件”“用到的记忆”的排序；现有相关邮件是 `receivedAt desc, messageId`（`proactive-mail-check-service.ts:342-347`），新调用必须复用同样的排序，不能依赖 DB 返回顺序。
- “规范化参数”没有定义。必须明确 canonical JSON：键排序、UTF-8、时间统一为带时区的 ISO UTC、数字统一格式、文本 NFC；否则同一语义的两种写法会得到不同指纹/不同字节。
- 可用动作清单是“每次从登记表和可用性算出来的”；如果可用性依赖当前设备/时间，同一输入两次可能不同。测试要固定可用性，或把可用性作为输入的一部分并记录版本。
- 加密本身是非确定性的（随机 IV），但模型看到的是明文；只要指纹对明文 canonical 形式计算，存储密文不同不影响模型请求字节。如果指纹对密文或含 nonce 的内容计算，就会违反确定性。

依据：`.claude/rules/prompt-prefix.md:51`（“同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序……都要固定”）。建议补测：打乱相关邮件和记忆的读取顺序、参数键顺序、空白、Unicode 归一化后，请求字节仍相同；不同语义的参数必须得到不同指纹。

## 3. 有没有对应的自动检查，反向用例真的会失败？

方案列出的测试覆盖了不少正向/反向场景（旧版本、错指纹、过期、重复请求、别的提醒、新邮件后点旧按钮、提醒被改后点、事务失败、撤销冲突、登记表外动作、不可用动作、不可信来源类别、原话找不到、参数多字段、时间在过去、模型出错/超时/上限、字节相同、打乱顺序、三种语言、首页件数、值两端一致），这是好的。**但还缺这些检查**：
- `check:operations`：新命令必须同时有契约、后端实现、调用方、测试（`scripts/check-operations.mjs:202-213`）。
- `check:data-export`：新表/新 payload 必须进导出、导入、清空；`REQUIRED` 计数要更新。
- prompt catalog/manifest：新提示词必须进 catalog，manifest digest 必须更新；否则 `prompt-catalog.unit.test.ts:299-337` 会失败。
- 读通道禁写：调用 `proactive.overview.read` 时不得发出写语句（ADR 0131）。
- `model_usage_observations` 用途三端一致；`decision_ledger` kind/outcome/inputs 三端一致。
- `reminder.create` 无目标的正向用例；`reminder.cancel` 若不允许由邮件提出，要有“提议被拒绝”的反向用例。
- 撤销使用“执行后的目标版本”的用例；目标在执行后又被改过，撤销必须失败。
- 目标 id 不在发给模型的快照里，即使数据库存在也必须拒绝。
- 同一 `idempotencyKey` 带不同 payload 必须报错（Stripe 的一手依据见上）。
- 每轮 proposal 上限、每日次数/费用上限、按发件人/线程去重。
- 遮盖占位符出现在引用原话里必须丢弃。

另外，“反向用例真的会失败”不能只在方案里写一句，建议每个守卫都写“去掉代码后这条测试失败”的验证记录（I-73 的教训：`docs/incidents-and-gates.md:112`）。

## 4. 每个产生/修改的值，所有使用它的地方都能接受吗？

**不能，按 I-73 逐个找两端，至少发现这些缺口**：

| 值 | 产生端 | 使用端/校验 | 现状 |
|---|---|---|---|
| `action_proposals.status` | 新表 | 首页 contract `insights[].status` 枚举、命令状态机 | 现有枚举没有 proposal 状态，严格对象会拒绝新字段（`contracts-v2.ts:422-440`、`validation.ts:174-176`） |
| 新命令 `proactive.proposal.respond` | 契约 | `GATEWAY_V2_MESSAGE_TYPES`、schema 注册表、`PRODUCTION_PROACTIVE_OPERATIONS`、`execute`、控制中心、测试 | 方案没列全；`check:operations` 会报缺（`contracts-v2.ts:35-46,670-676,2584-2587`，`production-proactive.ts:53-64,625`） |
| 绑定串 | 客户端 | `machineString`（≤128、字符集） | 拼接后可能超限/含非法字符（`validation.ts:49-59`） |
| `action-proposal` purpose | 方案 | DB CHECK、`MODEL_USAGE_PURPOSES`、`valid()`、`modelUsagePurpose`、用量页 | 只改 DB 会写入失败或被映射成 `other`（`0091...:88-93`，`model-usage.ts:3-13,59-63`，`sqlite-model-usage-operations.ts:20-22`） |
| `action_proposal` kind | 方案 | DB CHECK、`DECISION_KINDS`、`DECISION_OUTCOMES`、`DecisionInputs`、SQLite 读写、`clearRecords`、导出 | 方案只提 DB；TS/读写/清空/导出都会漏（`decision-ledger.ts:32-60,104-133`，`0089...:21-75`，`sqlite-decision-ledger-operations.ts:191-242`） |
| 审计里的指纹/风险 | 方案 | `AuditRecord`/`detail_ref` | 现有端口没有 detail，INSERT 不写 `detail_ref`（`observability.ts:109-117`，`sqlite-durable-operations.ts:1831-1845`） |
| `reminder.cancel` 的风险 | 动作登记表 | `ActionKind`/`computeActionRisk` | `DELETE` 是 HIGH，不可撤销会到 CRITICAL；方案只提 baseline（`action-policy-service.ts:37-68`） |
| `reminder.create` 的目标 | 动作登记表 | “目标存在且属于主人”、表列、撤销 | create 没有目标，按字面必被拒（方案 §1/§2/§3/§4） |
| 执行后的目标版本 | 执行函数 | `memory_reminders.update` 的 `expectedUpdatedAt` | 方案只存创建时版本，撤销必然冲突（`sqlite-memory-reminder-operations.ts:155-186`） |
| 去重键 | 提议模型/程序 | 唯一索引、拒绝后不再提 | 没有定义组成，也没有唯一索引 |
| `content_fingerprint` | 程序 | 命令校验、撤销、去重 | “规范化参数”未定义，canonical 形式未定 |
| `perception` 来源/`accepted` 状态 | 苹果端设计 | `action_proposals.source/status` | 苹果端表的状态/字段与 proposal 表不同（`2026-11-11-apple-device-body-design.md:339`） |
| 新表/新 payload | 存储 | `clearRecords`/`removeSource`/数据导出 | 未接入，断开后仍留邮件派生数据（`sqlite-proactive-operations.ts:462-573`，`data-export/snapshot.ts:175-211`） |

建议按 I-73 的做法，专门写一张“新值两端表”：每个值写“谁产生、谁使用、两端怎样校验、哪道检查守着”，并在实现前逐项跑一遍。双模型复核不能只看 diff，要像 I-73 那样问“这个清单里的 id/状态/用途能通过后端校验吗”。
