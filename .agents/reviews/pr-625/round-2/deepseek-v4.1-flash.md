## 侧重检查

这一轮先看了 `git diff 6a46d580..1d123197` 的增量，再回头核对增量触及的旧路径：`production-memory-control.ts`、`sqlite-memory-reminder-operations.ts`、`durable-adapters.ts`、`memory-reminders.ts`、`contracts-v2.ts`、`memory-page.tsx`、三份 i18n、相关测试和 ADR 0192。用 grep 找过 `listCancelled`、`cancelled`、`memory.reminder.respond`、`restore`、`upcoming` 的生产者和消费者。**没有运行测试或浏览器**，测试结论都来自读断言和代码路径。

检查过的风险路径：

- **错误路径**：`restore` 对不存在、非 cancelled、状态冲突、读不到正文时的行为；`listCancelled` 的 limit 校验；`readText` 失败被 `catch(() => "")` 跳过。发现 `restore` 仍不幂等，以及恢复后记忆不活跃时列表不可见的问题（见下）。
- **不可信输入**：`action` 由契约枚举限制；`reminderId` 只作为 SQL 参数；`restore` 前检查 `ownerId/agentId`；没有发现 SQL 注入或跨 owner 读写。
- **安全/隐私**：新 `cancelled` 列表里的正文来自原有记忆读取路径，和 `upcoming` 一样不额外扩大可见范围；React 会转义正文。
- **资源耗尽**：列表最多 20 条，`limit` 限制在 0..200，`readMany` 对空数组直接返回、最多 1000，查询走 `(owner_id, agent_id, status, due_at)` 索引。
- **不可撤销操作**：本次没有新增不可撤销操作；但“取消可撤销”在到期时间已过的提醒上仍不成立，见第 1 条。
- **规则/文档一致**：ADR 0192 第 8 条已补 `restore`；工具登记表里 `reminder_cancel` 仍是 `reversible: true`，与“到期已过的取消仍不可恢复”存在张力。

## 复核结论（本轮范围与上一轮意见）

本轮增量范围：`6a46d580..1d123197`，实际代码提交是 `f5bcde88c`（另一个提交是复核材料）。查过的文件就是上面列出的那些；没有重读增量之外的整份旧代码，但证据指向旧代码时跟到了 `production-home.ts`、`production-tool-actions.ts` 和 SQL 查询。

上一轮意见：

- **1（高）**：**只修复了一部分**。对话和网页取消的、到期时间还没过的提醒现在会出现在“最近取消”，可以恢复；但首页“到点提醒”仍提供取消，取消时 `due_at` 已过的提醒不会进入“最近取消”，仍无入口恢复。
- **4（低）**：**失败提示修好了，幂等没修**。`restore` 失败会显示“没能恢复这条提醒”；但第二次 `restore` 仍返回 `MEMORY_REMINDER_NOT_CANCELLED`，不是无操作成功。
- **5（低）**：**已修好**。ADR 0192 第 8 条现在写明已取消提醒接受再次取消和 `restore`；没有再搜到“只接受再次取消”的旧说法。

### 1. 中高：首页“到点提醒”仍能取消，但到期时间已过的取消不会进入“最近取消”，仍然无法恢复

**文件:行**：`apps/agent-service/src/production-home.ts:367-376`、`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:176-190`、`apps/agent-service/src/production-memory-control.ts:655-663`、`test/integration/production-memory-capture.test.ts:1918-1927`

**问题**：首页的到点提醒三个按钮里包含“取消这个提醒”。到点列表的判定是 `remind_at <= now`，`due_at` 可以已经过去；这种提醒被取消后，`listCancelled` 要求 `due_at > now`，所以它永远不进“最近取消”。网页撤销提示只覆盖网页上的取消，日程页面也不显示它，结果仍然没有恢复入口。这正好是上一轮第 1 条要解决的“首页发起的取消无法恢复”的剩余部分。

**证据（读代码证实）**：

```ts
// production-home.ts:367-376
actions: [
  action(locale, "dismiss", "positive", { command: reminderCommand(reminder.reminderId, "dismiss") }),
  action(locale, "snooze", "neutral", { command: reminderCommand(reminder.reminderId, "snooze") }),
  action(locale, "cancel", "negative", { command: reminderCommand(reminder.reminderId, "cancel") }),
],
```

```ts
// sqlite-memory-reminder-operations.ts:183-189
`${reminderSelect} ${liveMemory}
WHERE r.owner_id = ? AND r.agent_id = ? AND r.status = 'cancelled' AND r.due_at > ?
ORDER BY r.updated_at DESC, r.id LIMIT ?`
```

```ts
// production-memory-capture.test.ts:1918-1927：提醒 dueAt 是 07:00，clock 已是 07:06
expect(await reminders.read(reminderId)).toMatchObject({ status: "cancelled" });
expect((await overview(context.control)).reminders).toEqual([]);
expect((await overview(context.control)).cancelled).toEqual([]);
await answer("restore");
```

这条断言实际上把“到期已过的取消不显示”固化成了预期行为。工具登记表仍把 `reminder_cancel` 标成可撤销（`production-tool-actions.ts:287` 继承 `OWNER_WRITE_DEFAULTS`，`reversible: true`），和这个结果不一致。

**推测**：没有别的网页入口能读到这类 cancelled 记录；只有直接构造 `memory.reminder.respond` 命令才能恢复。因此普通用户从首页取消后，实际上无法通过界面恢复。

**建议**：不要用 `due_at > now` 作为是否可恢复的条件；按取消时间（`updated_at`）保留最近 N 条，过期条目可标注“已过期”但仍允许恢复（恢复后进入到期列表，必要时年度提醒顺延到下一次）。或者明确从首页到点提醒移除 `cancel`，只留 `dismiss`/`snooze`。无论选哪种，都补一个“首页取消已过到期时间的提醒后仍能恢复”的反向测试。

### 2. 低：只有“最近取消”时，页面同时显示“最近取消”和“还没有提醒”空白提示

**文件:行**：`apps/control-center/src/components/memory-page.tsx:1117-1148`、`apps/control-center/src/components/memory-page.tsx:1161-1163`

**问题**：新增的“最近取消”分组条件只看 `overview.cancelled.length`，但后面的空状态条件仍只排除 `reminders`、`upcoming` 和邮件。于是当用户唯一的提醒刚被取消时，页面会先列出“最近取消”的条目和“恢复”按钮，紧接着又显示“还没有提醒”。这是新功能最典型的使用场景之一。

**证据（读代码证实）**：

```tsx
// memory-page.tsx:1117
{overview.cancelled.length ? (
...
// memory-page.tsx:1140
{!overview.reminders.length && !overview.upcoming.length && !mailCount ? (
  <EmptyState ... title={message("reminders.emptyTitle")} ...>
```

**推测**：这是界面文案矛盾，不会损坏数据；但会让用户怀疑“最近取消”列表是不是别的功能，降低恢复入口的可发现性。

**建议**：空状态条件加上 `&& !overview.cancelled.length`；第 1161 行的通知说明条件也应考虑 cancelled。补一个“只有 cancelled、没有 due/upcoming/mail”的 UI 测试。

### 3. 低：`restore` 仍不幂等，重复恢复会显示失败

**文件:行**：`apps/agent-service/src/production-memory-control.ts:2032-2036`、`test/integration/production-memory-capture.test.ts:1928-1929`

**问题**：上一轮第 4 条的后半部分没有改。第一次恢复成功后，第二条相同请求（双开标签页、提示条点击重试、客户端重发）会读到 `status: "scheduled"`，然后抛 `MEMORY_REMINDER_NOT_CANCELLED`。用户会看到“没能恢复这条提醒”，即便提醒其实已经恢复。作者的说法第 1 条也明确说非 cancelled 会被拒绝，所以这可能是有意设计，但与“撤销/恢复”通常期望的幂等行为不一致。

**证据（读代码证实）**：

```ts
// production-memory-control.ts:2032-2036
if (reminder.status !== "cancelled" && action === "restore")
  throw new ApplicationPortError(
    PORT_ERROR_CODES.INVALID_OPERATION,
    "MEMORY_REMINDER_NOT_CANCELLED",
  );
```

```ts
// production-memory-capture.test.ts:1928
await expect(answer("restore")).rejects.toThrow("MEMORY_REMINDER_NOT_CANCELLED");
```

**推测**：通常的点击路径因为 `busy` 会暂时禁用列表按钮，所以不是高频问题；但多标签页或网络失败后的重试仍可触发。

**建议**：如果目标是把恢复做成安全的重试操作，已处于 `scheduled` 且时间一致时可返回成功（`replayed: true`/无变化成功）；如果坚持拒绝，至少在 UI 中把“已恢复”处理成成功而不是失败，并补一个双标签页或重复请求的测试。

### 4. 低：恢复不检查记忆是否仍活跃，可能返回成功但提醒不会出现在任何列表

**文件:行**：`apps/agent-service/src/production-memory-control.ts:2029-2050`、`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:11-12`、`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:132`、`:161`

**问题**：`restore` 只读提醒本身并检查 owner/agent，不检查它关联的记忆是否仍满足 `liveMemory`。而 `listCancelled`、`listDue`、`listUpcoming` 都带 `JOIN memory_records ... status = 'active' AND superseded_by IS NULL AND tentative = 0`。所以给一个记忆已归档或被取代的 cancelled 提醒发 `restore` 会成功返回，但这条提醒随后不在任何列表里，作者说法第 2 条“到期列表和即将到来列表照常显示它”在这种情况下不成立。网页列表本身过滤了不活跃记忆，因此只会由直接命令或“列表加载后记忆被并发归档”的窄窗口触发。

**证据（读代码证实）**：

```ts
// production-memory-control.ts:2029-2050
const reminder = await this.options.reminders.read(reminderId);
if (!reminder || reminder.ownerId !== ownerId || reminder.agentId !== agentId)
  throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_REMINDER_NOT_FOUND");
...
const next = action === "restore"
  ? { status: "scheduled", dueAt: reminder.dueAt, remindAt: reminder.remindAt, dismissedAt: null }
```

```ts
// sqlite-memory-reminder-operations.ts:11-12
const liveMemory = `JOIN memory_records m ON m.id = r.memory_id AND m.status = 'active'
  AND m.superseded_by IS NULL AND m.tentative = 0`;
```

**推测**：没有看到其他恢复入口会主动恢复不活跃记忆的提醒，所以影响面小。

**建议**：在 `restore` 前用 `state.read` 或 `state.readMany` 确认记忆仍活跃；不活跃时返回明确的错误（例如 `MEMORY_REMINDER_NOT_FOUND` 或专门的不可恢复错误），不要静默成功。

### 5. 低：`app-interactions` 的 memory overview 测试桩仍缺少 `cancelled`，说法第 5 条“所有产生它的地方一致”不完全成立

**文件:行**：`apps/control-center/test/app-interactions.unit.test.ts:209-211`、`packages/gateway-contracts/src/contracts-v2.ts:2403-2410`

**问题**：契约已把 `cancelled` 设为必需字段，网页也在 `memory-page.tsx:1117` 直接读 `overview.cancelled.length`，但这个测试桩返回的 memory overview payload 没有 `cancelled`。当前用例没有真正挂载提醒页，所以不会当场报错；但这是一个不符合新契约的“快照生产者”，以后在这个用例里渲染提醒页会变成 `undefined.length` 的运行时错误。`correction-review.unit.test.ts:235` 的 `payload: {}` 也是同类桩，只是更明显地不打算当快照用。

**证据（读代码证实）**：

```ts
// app-interactions.unit.test.ts:209-211
{
  type: "memory.overview.snapshot",
  payload: { reminders: [], upcoming: [], memories: [], pending: [] },
},
```

```ts
// contracts-v2.ts:2403-2410
cancelled: array(
  object({
    reminderId: machineString,
    text: boundedString(2000),
    dueAt: timestamp,
    repeat: enumeration(["none", "yearly"]),
  }),
),
```

**建议**：在 `app-interactions` 的桩里补 `cancelled: []`；如果这是刻意的最小桩，就把返回类型标成局部 mock 而不是完整的 `memory.overview.snapshot`，避免被当成真实生产者。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。增量没有改系统提示、工具定义、历史消息、出口遮盖或工具说明；`reminder_cancel` 的提示词文本没有改（`packages/prompt-catalog/src/tools.ts:27`），新字段只在 `memory.overview.snapshot` 这个控制台查询里，不是模型请求内容。因此模型侧仍然只在末尾追加，每轮变化的值没有进入请求开头。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. **会不会让同一段文字在不同请求里变成不同字节？** 对模型请求不涉及。就页面快照本身而言，`cancelled` 数组按 `r.updated_at DESC, r.id` 排序（`sqlite-memory-reminder-operations.ts:187`），顺序固定；正文是原始记忆文字，不经过依赖前后文的遮盖。唯一会变的是列表成员：`dueAfter: this.options.clock.now()` 会让到期已过的条目随时间从列表消失，但这不是模型上下文，也不会改写旧文字的字节。
3. **有没有自动检查？反向用例真的会失败吗？** 有新增检查：`memory-interactions.unit.test.ts:1502-1513` 覆盖网页取消后的撤销、最近取消和恢复失败提示；`production-memory-capture.test.ts:2099-2120` 覆盖对话工具取消后出现在 `cancelled` 并能恢复；`:1928` 反向覆盖非 cancelled 的 `restore` 被拒。按代码和断言推断，去掉 `cancelled` 分组或吞掉失败提示，这些用例会失败；但**没有运行测试**，实际失败未核实。也缺少针对“首页取消到期已过提醒后恢复”和“只有 cancelled 时的空状态”的反向用例，当前 `:1920` 反而把第 1 条的缺口写成了预期。
4. **改动产生或修改的每个值，所有使用端都能接受吗？** 主要值都核过：
   - `listCancelled` / `memoryReminder.listCancelled`：生产者 `durable-adapters.ts:1160`，SQL 执行分支 `sqlite-memory-reminder-operations.ts:55-58`，私有查询 `:176-190`；消费者 `production-memory-control.ts:658`，limit 20 在 `:81-84` 的 0..200 校验内。接受。
   - `memory.overview.snapshot.cancelled`：生产者 `production-memory-control.ts:678-682`、`:1450-1460`；契约 `contracts-v2.ts:2403-2410`；网页 `memory.ts:8-11`、`memory-page.tsx:1117-1138`；夹具 `gateway-v2.fixture.ts:1225`、`memory-interactions.unit.test.ts:262`/`:1470`、`proactive-interactions.unit.test.ts:308`、`release-walkthrough.unit.test.ts:57`、`weekly-report.unit.test.ts:61`、e2e 夹具 `control-center-browser-server.mjs:1039`、集成测试 `production-memory-capture.test.ts:2102`。接受；`app-interactions` 桩缺字段见第 5 条。
   - `action: "restore"`：契约枚举 `contracts-v2.ts:2545`，服务端处理 `production-memory-control.ts:2032-2050`，网页类型和发送 `memory.ts:95`/`:401`，夹具改成 restore `gateway-v2.fixture.ts:1271-1273`。网页和服务端接受；`production-home-binding.ts:55` 的 action 类型不含 restore，但它本来就不发 restore，不影响。
   - `CANCELLED_SHOWN = 20`：`production-memory-control.ts:126`，传给 SQL limit `:661-662`，SQL 上限 200，接受。
   - i18n：`memory.page.restored`、`memory.page.restoreFailed`、`memory.reminderRestore`、`reminders.cancelledGroup` 在 `message-ids.ts:650-653` 和 en/ja/zh-CN 三份资源里都有；`memory.page.restored` 有示例值，其余无占位符，接受。
   - 文档：ADR 0192 第 8 条已更新；未发现仍写“已取消的提醒只接受再次取消”的文档。
