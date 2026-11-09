## 结论（按严重度）

### 1. 中：已删除名单对 8 个 snapshot 名字没有“不得回到约定”的保护
- 文件:行：`scripts/check-operations.mjs:60`、`scripts/check-operations.mjs:99`、`scripts/check-operations.mjs:171-176`
- 问题：`contractNames` 只由查询和命令组成，`readContractOperations` 明确只把 `kind === "query" || kind === "command"` 放进 `operations`；而 `ci/operations-removed.json` 里有 8 个 snapshot 名字（`task.snapshot`、`inbox.snapshot`、`digest.snapshot`、`memory.snapshot`、`trace.snapshot`、`settings.snapshot`、`session.snapshot`、`health.snapshot`）。如果有人把这些名字重新加回 `GATEWAY_V2_MESSAGE_TYPES` 并补上 `envelope("snapshot", "…")` schema，`OPERATION_REMOVED_BUT_IN_CONTRACT` 不会报（名字不在 `contractNames` 里），`OPERATION_REMOVED_STILL_USED` 也不会报（schema 里不是 `type:`/`case` 形式）。这与作者“已删操作不得回到约定”的说法不符。
- 证据：
  ```
  60:     else if (kind === "query" || kind === "command") operations.push({ name, kind });
  ...
  99:   const contractNames = new Set(operations.map(({ name }) => name));
  ...
  172:     if (contractNames.has(name)) errors.push(`OPERATION_REMOVED_BUT_IN_CONTRACT ${name}`);
  174:     const usage = new RegExp(
  175:       `(?:["']?type["']?\\s*(?:===|!==|:|=)\\s*|\\bcase\\s+)["']${escaped}["']`,
  176:     );
  ```
- 建议：另建一个“约定里所有名字”的集合（直接取 `GATEWAY_V2_MESSAGE_TYPES`，或解析包括 snapshot/event 在内的所有 `envelope` 调用）供 `OPERATION_REMOVED_BUT_IN_CONTRACT` 使用；`operations` 仍只保留 query/command 做覆盖检查。反向用例补一条“把已删 snapshot 重新加进约定必须报红”。

### 2. 中：残余引用检测漏掉前端真实发送形式 `send(...)` / `queryMessage(...)` / `commandMessage(...)`
- 文件:行：`scripts/check-operations.mjs:174-180`；`apps/control-center/src/memory.ts:81,118,121,170`
- 问题：`OPERATION_REMOVED_STILL_USED` 只匹配 `type: "名字"`、`type === "名字"`、`case "名字"` 三种形式。但前端发送操作实际用的形式是 `send("memory.mutate", …)`、`queryMessage(configuration, "memory.overview.read", …)`、`commandMessage(configuration, …)`。如果残留写成 `send("session.revoke", …)` 或 `queryMessage(configuration, "trace.timeline", …)`，检查不会报红；`test/tooling/operations-check.test.mjs:129-150` 的反向用例也没有覆盖这些形式。脚本里已有 `frontendSends`（`check-operations.mjs:79-89`）能把这类字面量识别为调用方，但没有被 removed 检查复用。
- 证据：
  ```
  memory.ts:81:       .query(queryMessage(configuration, "memory.overview.read", {}))
  memory.ts:118:       client.mutate(commandMessage(configuration, type, await payload(), { risk: "medium" })),
  memory.ts:121:       send("memory.mutate", () => ({
  memory.ts:170:       send("memory.reminder.respond", () => ({ reminderId: item.reminderId, action })),
  ```
- 建议：removed 检查复用 `frontendSends` 的字面量检测（并加入 `send`/`queryMessage`/`commandMessage` 等形式），或在正则里显式列出这些调用名；反向用例补 `send("session.revoke")` 和 `queryMessage(…, "trace.timeline", …)`。

### 3. 中低：两条“取消”路径对已 dismissed 的提醒行为不一致，作者/ADR“都写 cancelled”的说法不成立
- 文件:行：`apps/agent-service/src/production-reminder-writer.ts:289-299`；`apps/agent-service/src/production-memory-control.ts:866-894`；`docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:44`
- 问题：模型工具 `reminder_cancel` 走 `ProductionReminderWriter.cancel`，当状态不是 `scheduled` 时直接返回原状态（已 dismissed 的提醒不会变成 cancelled，却仍返回 `{cancelled: true}`）；而网关 `memory.reminder.respond` 的 `cancel` 会把已 dismissed 的提醒改成 `cancelled`。ADR 第 44 行写“`memory.reminder.respond` 的 `cancel` 和模型工具 `reminder_cancel` 都写 `cancelled`”，对“已经 dismissed 的提醒”这个情况不成立。现有测试 `production-memory-capture.test.ts:1368-1418` 只覆盖“scheduled 时取消”，没有覆盖“dismiss 后再用工具取消”。
- 证据：
  ```
  production-reminder-writer.ts:294:     if (reminder.status !== "scheduled") return reminder;
  production-reminder-writer.ts:299:       status: "cancelled",
  production-memory-control.ts:888:                 status: (action === "cancel" ? "cancelled" : "dismissed") as
  ```
- 建议：统一两条路径的语义（要么工具也把 dismissed 改成 cancelled，要么明确工具对非 scheduled 是 no-op 且改掉 ADR 说法），并补一条“dismiss 后再用工具取消”的断言。

### 4. 低：0085 迁移测试证明了旧行保留，但没有证明表约束/外键保留，而且在关闭外键下执行
- 文件:行：`packages/persistence-sqlite/test/memory-reminder-cancelled-migration.contract.test.ts:30-31,58,60-77`
- 问题：测试确实插入了旧数据（scheduled、dismissed）并在迁移后断言它们还在，这部分是有效的。但它把 `foreign_keys = OFF` 后就没恢复（第 31 行），生产环境的 `openQualifiedDatabase` 是打开的；同时只断言 `id/status/dismissedAt`、索引名和 `foreign_key_check`。如果 0085 漏掉 `REFERENCES` 或 `STRICT`，`foreign_key_check` 仍会返回空，测试不会失败；`due_at/remind_at/created_at/updated_at` 是否逐列保留也没有断言。
- 证据：
  ```
  31:     database.pragma("foreign_keys = OFF");
  ...
  58:     applyMigrations(database, migrations, { snapshot });
  ...
  63:     expect(rows).toEqual([
  64:       { id: "r-1", status: "scheduled", dismissedAt: null },
  65:       { id: "r-2", status: "dismissed", dismissedAt: T0 },
  66:     ]);
  77:     expect(database.pragma("foreign_key_check(memory_reminders)")).toEqual([]);
  ```
- 建议：迁移前后保持 `foreign_keys = ON`（或至少 apply 前恢复），并断言 `PRAGMA foreign_key_list(memory_reminders)`、`PRAGMA table_info` 和整行所有列；这样才能证明“旧数据及其约束都保留”。

### 5. 低：文档/清单与代码的小偏差
- `docs/adr/0192-…md:88` 的“门槛”列表没有写新增的已删除名单反向用例（作者在第 49 行写了名单本身，但验证清单未同步）。
- `docs/adr/0192-…md:50` 说“`isSurfaceInstalled` 要求页面至少有一个操作且全部已安装”，实际实现对 `threads` 直接返回真、对 `health-deployment` 只看 `healthDependenciesAvailable`（`control-center-inventory.ts:64-71`），这句话不精确（第 7 条另说了会话/健康，但没说 threads）。
- `apps/control-center/src/app/control-center-inventory.ts:403` 的 sessions-devices 现在 `queries/mutations` 都是空，却仍保留 `revisionControl: ["Session.revision", "idempotencyKey"]`；health-deployment 同理。这些字段目前没有消费者，属元数据残留。
- 证据：
  ```
  control-center-inventory.ts:64:   if (surface.id === "health-deployment") return healthDependenciesAvailable;
  control-center-inventory.ts:68:     surface.id === "threads" ||
  control-center-inventory.ts:403:     revisionControl: ["Session.revision", "idempotencyKey"],
  ```

## 读代码证实的 / 推测的

读代码证实：
- 第 1、2、3、4、5 条的代码事实（行号与引用均来自本次实际读取）。
- 0085 的新约束是 `CHECK ((status = 'scheduled') = (dismissed_at IS NULL))`，旧约束是 `(status = 'dismissed') = (dismissed_at IS NOT NULL)`，对 scheduled/dismissed 等价，且允许 cancelled 带 `dismissed_at`。
- `cancelled` 已被端口类型、SQLite 更新校验、SQLite 表约束三方接受；`listDue`/`listUpcoming` 只取 `status = 'scheduled'`，web push 也要求 `status === "scheduled"`，所以 cancelled 不会出现在到期/即将到来列表，也不会被推送。
- `memory.reminder.respond` 的 action 枚举只有 `dismiss/snooze/cancel`（`contracts-v2.ts:1125`），守卫不会误挡其它合法 action。
- `reminders.update` 全仓只有两处调用（`production-memory-control.ts:895`、`production-reminder-writer.ts:296`），所以守卫不影响整理/导出/治理删除。
- 删除的网关操作及其 schema 导出没有悬空引用（grep 无命中）；`grant.revoke` 的替换 payload 与 schema 一致；`workspace.list` 的 `{afterCursor, limit}` 与 `pagePayload` 一致。

推测/未核实：
- 无法运行 `npm run check:operations` 和测试，因此“真实仓库零报红”“去掉修改后这些断言失败”没有实际执行验证。
- 第 4 条中“漏掉 REFERENCES 也能通过 `foreign_key_check`”是按 SQLite 语义推断（无外键定义时该 pragma 没有可报告的行）；这一点我没有运行 SQLite 实测。
- 第 1、2 条的“某个已删名字被重新加回”是潜在回归场景，不是当前仓库里已存在的残留；当前仓库 grep 未发现这三种形式的残余引用。

## 侧重检查

- 错误路径：守卫在所有权校验之后、读取时钟之前，`cancelled && action !== "cancel"` 抛 `MEMORY_REMINDER_CANCELLED`；`cancel` 自身可重复执行。工具路径对非 scheduled 早退，存在第 3 条的不一致。没有发现会误挡整理、导出、治理删除的路径（它们不经过 `memory.reminder.respond`）。
- 不可信/不合规输入：已删除名单是仓库内受控 JSON，名字固定且只对 `.` 做了转义；守卫的判定依据是数据库里的 `reminder.status`，不是客户端传的状态；没有发现可绕过守卫把已取消提醒改回 scheduled 的命令（只有 `cancel` 被放行，且写回仍是 cancelled）。
- 安全：本次改动没有新增外部输入解析、没有日志/密钥泄漏；删除的只读查询和快照不影响认证授权路径。
- 资源耗尽：0085 是全表复制，但提醒表规模小，且迁移引擎要求先建快照并在事务内执行；检查脚本是 26 个名字 × 有限文件集合，没有明显的无界循环或正则灾难性回溯（名字已转义 `.`）。
- 不可撤销操作：0085 是 DROP+重建，属于需要谨慎的迁移；引擎在已有 schema 上强制要求同机快照（`migration-engine.ts:921`），测试也验证了 r-1/r-2 迁移后仍在。但测试没有证明约束完全保留（第 4 条）。
- 规则/文档一致：`.claude/rules/prompt-prefix.md` 与本次改动无冲突；ADR 0192 的部分说法与实际代码有第 3、5 条的小偏差。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次 diff 没有改动 `packages/prompt-catalog`、系统提示拼装、工具定义或历史写入逻辑；`reminder_cancel` 的名称、参数和说明文字都没变（`production-reminder-writer.ts` 只改了写库时的 status）。被删除的网关操作是前后端约定，不是模型可见的工具定义。会变化的值（提醒状态、`now` 时间）都是持久化数据；按规则第 2 条，能进入模型的本轮数据应放在最后一条用户消息里，本次没有把任何新值放进系统提示或工具定义。因此仍满足“只在末尾追加”，每轮会变的值仍在最后一条消息（依据 `.claude/rules/prompt-prefix.md:27-29,35`）。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   没有新增这种风险。`cancelled` 是固定字符串；`listDue`/`listUpcoming` 都有固定的 `ORDER BY`（`sqlite-memory-reminder-operations.ts:125-126,142-145`）；memory overview 的 reminders 字段本来就不含 `status/dismissedAt/updatedAt`（`contracts-v2.ts:1037-1055`），所以取消状态不会以时间字段形式进入模型请求。唯一“每次不同”的是重复取消时写入的 `dismissed_at/updated_at`，但它们是持久化数据，不在提示词里，也不改变遮盖结果。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有：`check:operations` 已接入 `check:steps`（`package.json:27,32`），`test/tooling/operations-check.test.mjs`、`test/integration/production-memory-capture.test.ts`、`memory-reminder-cancelled-migration.contract.test.ts` 都带反向断言。按代码推演，去掉守卫/迁移/名单检查时这些断言会失败。但覆盖不全：已删除名单的反向用例只覆盖 `type:` 形式和 query/command 名字，没有覆盖 snapshot 重新进约定（第 1 条）和 `send/queryMessage/commandMessage` 形式（第 2 条），所以这两类回归不会让现有反向用例失败。实际执行结果未核实（只能读代码）。

4. **每个产生/修改的值，使用它的地方都能接受吗？**
   - `status = "cancelled"`：端口类型（`packages/application/src/ports/memory-reminders.ts:14`）、SQLite 更新校验（`sqlite-memory-reminder-operations.ts:167`）、表 CHECK（`0085…sql:12`）、`listDue/listUpcoming` 的 `status='scheduled'` 过滤、web push 的 `status !== "scheduled"` 检查都能接受。唯一问题是工具/网关两条 cancel 路径语义不一致（第 3 条）。
   - `contractStatus: "missing"`、`integrationPolicy: "blocked"`：类型联合已包含（`control-center-inventory.ts:19-20`），唯一消费者是 `CONTROL_CENTER_INTEGRATION_READY_SURFACE_IDS` 的过滤（`control-center-inventory.ts:439-440`）和清单测试，测试已更新。
   - `memory.overview.read`：约定（`contracts-v2.ts:60,961`）、后端（`production-memory-control.ts:45,324`）、前端（`memory.ts:81`）、测试都有，前后端校验一致。
   - 清单项：`ci/operations-removed.json` 的 26 个名字与 ADR 第 46 行的“18 操作 + 8 回执”一致；`ci/operations-pending.json` 23 项抽查的名字在约定里存在。但“名字不得回到约定”的校验对 8 个 snapshot 不生效（第 1 条）。
   - 迁移序列值：`migration-engine.ts` 加了 sequence 85，`SUPPORTED_SCHEMA_MAX`、`CURRENT_SCHEMA_SEQUENCE`、迁移测试的当前版本号都同步到 85，未发现仍固定写 84 的相关断言。
   - 其它替换值：`grant.revoke` 的 payload 与 `revokeGrantCommandSchema` 一致；`workspace.list` 的 payload 与 `pagePayload` 一致；删除的 schema 导出无悬空引用。
