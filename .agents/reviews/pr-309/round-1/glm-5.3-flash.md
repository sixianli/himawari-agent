# PR 309 复核报告（基准 01873f5 → d911557a）

## 读代码证实的问题（按严重度从高到低）

### 1.（中）同一次检查里同类多条提醒共享一个推送，忽略计数会翻倍
- 文件：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:866`、`packages/persistence-sqlite/src/proactive-push-backoff.ts:24-52`
- 证据：`record()` 里 `for (const id of pushed) setKey.run(\`proactive:${input.push.id}\`, id)` —— 一次检查的多条被推提醒共用同一个 `push_source_key`；而 `countIgnoredPushes` 是按 `source_insights` 行计数再 `LEFT JOIN web_push_feedback ON feedback.source_key = insight.push_source_key`，同一 key 会 JOIN 出多行。若一次检查有两条同一域名的 due+high 提醒（各自 `pushClass` 相同、都被放行），用户没点开这一条推送，24 小时后会被算成 **2 次**忽略。第 1 台阶的"每天 1 条"放行的推送若含 2 条同类提醒，被忽略一次就抵 2 次，往第 2 台阶走的速度翻倍，等效阈值低于配置的 N。
- 建议：按 `push_source_key` 去重后再计数（每个推送至多算 1 次），或在 `#gateBackoff` 里限制一次检查每类至多放行 1 条；补一个反向用例。

### 2.（中）从未送达的推送会被算成"被忽略"，与 ADR 0184 的说法相反
- 文件：`packages/persistence-sqlite/src/proactive-push-backoff.ts:37-52`、`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:434-446`、`docs/adr/0184-back-off-ignored-proactive-pushes.md`（已知局限段）
- 证据：`web_push_feedback` 行只在推送尝试 `status === "sent"` 时插入（sqlite-web-push-operations.ts:434 `if (recorded && input.status === "sent")`）；而 `countIgnoredPushes` 只要求 `insight.push_source_key IS NOT NULL`，时间取 `COALESCE(feedback.first_sent_at, insight.updated_at)`。推送已排进推送（record 时就写了 `push_source_key`）但从未成功送达（无订阅、发送一直失败）时，没有 feedback 行，回退到 `insight.updated_at`，满 24 小时即计为忽略。ADR 明确写"没有订阅或发送失败的推送不计"——**代码与 ADR 不一致**。极端情形：设备一直离线，用户零交互，一类提醒也会自己走到第 2 台阶暂停。
- 建议：计数只统计有 `web_push_feedback` 行（确曾送达）的推送；或改 ADR 说明真实行为。

### 3.（低）`reason_code` 优先级会盖掉 `QUIET_HOURS`，且"推了又压"的检查标签含混
- 文件：`packages/application/src/services/proactive-mail-check-service.ts:947-960`
- 证据：`#reason` 中 `backoff?.steppedUp → PUSH_BACKED_OFF`、`suppressed > 0 → PUSH_SUPPRESSED` 排在 `verdict === "deferred" → QUIET_HOURS` 之前。安静时段里发生的压制会记成 `PUSH_SUPPRESSED` 而不是 `QUIET_HOURS`；反之，一次检查若 A 类放行推送、B 类被压，`verdict = "pushed"` 但 `reasonCode = PUSH_SUPPRESSED`，记录自相矛盾。
- 建议：把 backoff 两个码放在 verdict 分支之后，或按 verdict 分派。

### 4.（低）preview（读）与 apply（写）不在同一事务，并发下可能重复升阶
- 文件：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:155-164`（preview 是独立 read）、`proactive-push-backoff.ts:100-133`
- 证据：`previewBackoff` 走 `context.read`，`applyBackoffWrites` 在 record 事务内；两者之间没有锁。同一 scope 两次检查并发时可能都读到 stage 0、都判升阶，后写者覆盖 `step_decision_id` / `ignoredCount`。后果有限（stage 收敛一致、不会卡死在 stage 2，还有一键恢复兜底）。调度器是否保证同一 scope 串行，**未核实**。
- 建议：确认调度器串行性，或把 preview 挪进 record 事务（`RETURNING`/重读校验）。

### 5.（低）`push_class` 的边界值
- 文件：`packages/application/src/services/proactive-mail-check-service.ts:112`、`packages/application/src/services/proactive-rules.ts:14-16`
- 证据：`senderDomain` 在地址无 `@` 时返回整个字符串（如 `"Alice"` → `due:alice`），明文进库并显示在界面；`slice(0, 128)` 截断可使两个超长域名并成同一个类。与契约 `boundedString(128)`（contracts-v2.ts:419-420）和表 CHECK（0081 第 2 行）一致，不会写库失败，只是语义含混。
- 建议：无 `@` 的地址直接不分类（`pushClass = null`）。

## 侧重检查（普通使用流程走查）

流程：邮件到达 → 定时检查 → 取信 → 模型判定 →（新）`pushClass` 分类 → `previewBackoff` 读台阶 → 放行/压制 → `record()` 单事务写 `decision_ledger` + `source_insights.push_class` + `proactive_push_backoff` → 推送入 outbox → 送达写 feedback → 用户忽略/评价 → 下次检查计数。逐段核对结论：

- 分类、门槛、写库、事务边界：均有集成测试覆盖（`test/integration/proactive-mail-check.test.ts` [PA-6] 7 个用例，含反向：差 1 次、中间点开、异域名、地板命中、阈值 0；`proactive-production.test.ts` [PA-6] 总览+恢复+拒绝；UI [PA-6]；配置反向 11/-1；契约 fixture）。
- **无覆盖的路径**：(a) 一次检查同类多条提醒（问题 1）；(b) 推送从未送达（问题 2）；(c) 安静时段与压制同时发生（问题 3）；(d) UI 点"恢复推送"后的页面刷新，单测只断言命令发出，端到端**未核实**；(e) 并发检查（问题 4）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会（读代码证实）。diff 未触碰提示词目录、工具定义、遮盖与历史组装；`pushClass`、`previewBackoff`、`backoff` 写全部发生在模型输出之后（proactive-mail-check-service.ts:873-874），`previewBackoff` 只是读库，不新增模型调用；新值（push_class、backoff 状态）只进 SQLite 和 UI 快照，不进任何模型请求。作者此条说法属实。
2. **同一段文字会不会在不同请求变成不同字节？** 不会。降频决策依赖时钟和库状态，但这些值不进入模型请求；进 UI 的列表 `ORDER BY class_key` 顺序确定（proactive-push-backoff.ts:160）。
3. **迁移 0081 是否安全？** 是（读代码证实）。expand 相位、纯增量：`ADD COLUMN` 可空带 CHECK、部分索引、新 STRICT 表（0081 全文）；已有行 `push_class` 为 NULL，老数据不计入新计数；无 down 迁移（引擎 forward-only），二进制回退后写库会被 `WRITER_TOO_OLD` 拦（测试证实 schema 49 写者被拦、81 放行；**v80 写者是否被拦未核实**，测试里迁移后 `minimum_writer_sequence = 81` 暗示会拦）；`SUPPORTED_SCHEMA_MAX = 81` 与迁移清单同步更新。
4. **并发/重复触发下计数与台阶会不会错？** 单线程顺序下正确（测试覆盖了升阶、降频、暂停、恢复全链）。风险点是上面问题 1（多提醒单推送多算）和问题 4（并发重复升阶，可恢复、不会永久卡死）。
5. **新增值每个使用处都能接受吗？** 逐对核对：`push_class`（产生于 service:112，CHECK 1–128 / 契约 boundedString(128) / UI domain 推导一致）；`PUSH_BACKED_OFF`/`PUSH_SUPPRESSED`（decision_ledger.reason_code 只有长度 1–64 的 CHECK，0069:19，可写，且测试直查该列证实落库）；命令 `proactive.backoff.restore` 在消息类型表、schema 表、服务端 handler、控制台允许清单、fixture 五处齐全；`backoffThreshold` 端口、严格配置（缺省 3、0–10）与生产接线一致。均通过。唯 `senderDomain` 边界值见问题 5。
6. **反向用例真的会失败吗？** 会：若门槛去掉压制，`fourth` 用例断言 `verdict: "silent", reasonCode: "PUSH_BACKED_OFF"`、`pushed: 0` 即失败；配置越界断言抛错；恢复不存在的类断言 `PROACTIVE_RECORD_NOT_FOUND`。但问题 1、2 两个场景没有反向用例，是缺口。
7. **隐私？** `push_class` 只含域名明文，与已有的 `proactive_settings.important_senders`（同样明文、同标 `metadata_only`，schema-catalog.ts:786-790）同级；不存地址/标题/正文，清单描述（schema-catalog.ts:891-893）与实现一致。可接受；仅注意问题 5 中无 `@` 地址会把非域名文本明文入库。
