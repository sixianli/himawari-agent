我会先看改动内容，再针对必答问题逐个核对代码。
## 侧重检查

- **错误路径**：`restore` 对非 `cancelled` 状态、非本人/本 agent 的提醒、并发修改都有拒绝分支（`production-memory-control.ts:1994-2005`、`2037-2044`），这一点读代码证实没问题。
- **不可信输入**：`action` 由契约枚举校验，`reminderId` 由 `machineString` 校验；控制层再按 `ownerId/agentId` 查归属，未发现新的越权面。
- **资源耗尽**：每次撤销只做一次 `read` + 一次 `update`，没有新增循环、批量或外部调用，未发现新的资源放大。
- **不可撤销的操作**：本改动只让“网页取消”在 6 秒内可逆；模型工具取消、首页取消仍然没有恢复入口，见问题 1。
- **规则/文档一致**：工具登记表没改（符合作者约束），但 ADR 0192 仍写“已取消的提醒只接受再次取消”，与当前代码不一致，见问题 5。
- **未核实**：现有测试是否全部包含在 `npm run check` 的具体执行清单里，未逐项核实。

## 问题

### 1. 高：撤销入口只在网页取消后的临时提示条里，模型和首页发起的取消仍然无法恢复
文件：`apps/control-center/src/components/memory-page.tsx:966-974`、`apps/control-center/src/components/memory-page.tsx:72`、`apps/agent-service/src/production-reminder-writer.ts:403-421`、`apps/agent-service/src/production-home.ts:367-377`、`packages/gateway-contracts/src/contracts-v2.ts:987-1001`、`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:128,157`

问题：作者说“取消真的能撤销”，但 `restore` 只有网页取消按钮成功后的提示条这一个入口。模型工具 `reminder_cancel` 直接写 `cancelled`；首页只发 `dismiss/snooze/cancel`；`HOME_ACTIONS` 里没有 `restore`；提醒概览只列 `status='scheduled'`。提示条 6 秒后自动消失（`NOTICE_MS = 6000`），页面也没有“已取消提醒”列表，所以无论网页、模型还是首页取消，超出这 6 秒或离开页面后都没有入口恢复同一条提醒。

证据：
```ts
// memory-page.tsx:966-974
onClick={() =>
  void memory?.respondReminder(item, "cancel").then(
    (ok) =>
      ok &&
      setNotice({
        text: message("memory.page.cancelled", { text: item.text }),
        undo: () => void memory.respondReminder(item, "restore"),
      }),
  )
}
```
```ts
// production-reminder-writer.ts:408-417
if (reminder.status === "cancelled") return reminder;
...
status: "cancelled",
dueAt: reminder.dueAt,
remindAt: reminder.remindAt,
dismissedAt: now,
```
```ts
// production-home.ts:367-377
actions: [
  action(locale, "dismiss", ...),
  action(locale, "snooze", ...),
  action(locale, "cancel", ...),
]
```

建议：至少补一个能发现“已取消提醒”的入口（例如提醒页的“已取消”分组或长期撤销记录），或者让模型/首页取消也产生同等的可撤销回执；否则工具登记表里 `reminder_cancel` 的 `reversible: true` 仍然只对网页按钮成立。

### 2. 中：契约新增的 `restore` 没有任何经过真实契约校验的测试，删掉枚举项现有用例仍会通过
文件：`packages/gateway-contracts/src/contracts-v2.ts:2537`、`test/integration/production-memory-capture.test.ts:1888-1894`、`apps/control-center/test/memory-interactions.unit.test.ts:1491-1495`、`packages/gateway-contracts/test/gateway-v2.fixture.ts:1263-1266`

问题：网页单元测试只检查 mock 的 `mutate` 收到了什么；集成测试把命令 `as never` 直接交给 `control.execute`，不经过 `CLIENT_GATEWAY_SCHEMAS` / HTTP 契约解析；契约夹具里 `memory.reminder.respond` 仍然只有 `action: "dismiss"`。因此如果 `contracts-v2.ts` 的枚举没有加 `restore`，现有新增用例仍可能全部通过，这正是 I-73 说的“只看了改动，没核对两端校验”。

证据：
```ts
// 集成测试
const answer = (action: "dismiss" | "snooze" | "restore") =>
  context.control.execute({
    ...
    payload: { reminderId, action },
  } as never);
```
```ts
// 契约夹具只有 dismiss
fixture("command", "memory.reminder.respond", {
  reminderId: "reminder:memory-01",
  action: "dismiss",
})
```
建议：在契约测试/夹具中增加一条 `action: "restore"` 的解析用例，最好再有一条从 HTTP 网关发送 `memory.reminder.respond` 的端到端用例；否则这条契约改动没有真正的反向保护。

### 3. 中：恢复已过期的取消提醒会成功但可能不显示，作者“即将到来列表照常显示它”不成立
文件：`apps/agent-service/src/production-memory-control.ts:2007-2014`、`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:144-170`、`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:11-12`

问题：`restore` 原样保留 `dueAt/remindAt`。如果一条提醒在到点后被取消（模型或首页取消都可以取消已到期提醒），恢复后 `dueAt < now`，`listUpcoming` 的 `due_at >= ?` 会把它排除；它只会出现在到期列表。若其记忆已不活跃，`liveMemory` 的 join 还会让它从到期列表也消失，命令却返回成功。作者的说法只在“取消时还没到点”的网页路径下成立。

证据：
```ts
// restore 分支
{
  status: "scheduled" as const,
  dueAt: reminder.dueAt,
  remindAt: reminder.remindAt,
  dismissedAt: null,
}
```
```sql
-- listUpcoming
WHERE ... r.status = 'scheduled'
  AND r.due_at >= ? AND r.due_at <= ?
```
```sql
-- liveMemory
JOIN memory_records m ON m.id = r.memory_id AND m.status = 'active'
```
建议：明确恢复策略：拒绝恢复时间已过的提醒、恢复时重新计算时间，或在 UI 上明确显示“已过期但已恢复”。并补一条“取消已到期提醒再恢复”的测试。

### 4. 低：撤销失败被吞掉，提示条无条件消失；`restore` 也不幂等
文件：`apps/control-center/src/components/memory-page.tsx:1138-1148`、`apps/control-center/src/memory.ts:239-252`、`apps/agent-service/src/production-memory-control.ts:1996-2000`

问题：点击“撤销”后先调用 `notice.undo?.()`，紧接着无条件 `setNotice(null)`；`send` 内部捕获错误只返回 `false`，页面没有提示。若恢复失败（并发改动、网络失败、提醒状态已变），用户看不到失败原因。另外 `restore` 第二次调用会报 `MEMORY_REMINDER_NOT_CANCELLED`，不像 `cancel` 那样可重复执行，重试或双击可能产生失败。

证据：
```tsx
onClick={() => {
  notice.undo?.();
  setNotice(null);
}}
```
```ts
try { await operation(); ... return true; }
catch { setFailed(true); return false; }
```
建议：让撤销回调返回 Promise，失败时保留提示条并显示错误；若希望“撤销可重试”，可让已恢复的再次 `restore` 幂等返回成功，或在前端按结果保留提示。

### 5. 低：文档仍写“已取消的提醒只接受再次取消”，与当前代码不一致
文件：`docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:51`、`.agents/handoffs/2026-11-12-home-feed-plan.md:201`

问题：ADR 0192 第 8 条仍写着“已取消的提醒只接受再次取消，忽略和稍后提醒会被拒绝”，首页交接文档也写“现在没有恢复的命令，不给撤销”。代码现在已允许 `restore`，至少 ADR 需要一条修正记录，否则后来的人会按旧规则理解 `memory.reminder.respond`。

建议：在 ADR 0192 加一条补充/修订，说明取消新增 `restore`，并写清哪些取消路径可恢复、哪些仍不可恢复；同步更新首页交接文档。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及控制中心网页、`memory.reminder.respond` 的契约枚举、`ProductionMemoryControl` 和测试。模型工具定义来自 `packages/prompt-catalog/src/tools.ts` 与 `production-reminder-writer.ts`，这两处没有改动；也没有改系统提示、历史、遮盖或工具集合。`restore` 改变的是提醒状态，最多影响之后的 `reminder_list` 结果，那属于追加在末尾的工具结果。没有新的每轮变化值被放进系统提示或工具定义，因此仍满足“只在末尾追加”。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会。没有改序列化格式、键顺序、集合顺序或遮盖规则；恢复时 `dueAt/remindAt` 按原值保存，`updatedAt` 只是数据库元数据，不进模型请求；新枚举字面量 `"restore"` 是固定值。提醒列表的 SQL 排序仍是既有的 `ORDER BY due_at, id`。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有，但覆盖不完整。
   - 服务端逻辑：`test/integration/production-memory-capture.test.ts:1920-1927` 覆盖恢复成功、`MEMORY_REMINDER_NOT_CANCELLED`、`MEMORY_REMINDER_CANCELLED`；去掉恢复分支或去掉状态判断，这些断言会失败，反向用例是真的。
   - 网页：`memory-interactions.unit.test.ts:1491-1495` 覆盖“撤销发送 `restore`”，去掉提示条会失败。
   - **但契约层没有覆盖**：见问题 2，删掉 `contracts-v2.ts` 的枚举项，上述测试都可能仍然通过。
   - 缺少“已 `dismissed` 的提醒调用 restore 应失败”的用例；`MEMORY_REMINDER_NOT_CANCELLED` 目前只在“恢复后再恢复”这一场景验证。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - `"restore"`：网页产生，契约枚举接受，`ProductionMemoryControl` 接受，存储层 `status: "scheduled"` + `dismissedAt: null` 满足 `sqlite-memory-reminder-operations.ts:190` 的校验；到期列表接受，但 `listUpcoming` 对过期 `dueAt` 不接受，见问题 3。
   - `MEMORY_REMINDER_NOT_CANCELLED`：服务端产生，只被测试和通用错误处理消费，没有专用映射，不会破坏现有校验。
   - `undo` 回调：只在 `RemindersPage` 的 `Notice` 里使用，`memory.undo` 文案已存在；但失败被吞，见问题 4。
   - `restore` 后的提醒字段：存储层接受；概览读取还要求关联记忆 `status='active'`，否则恢复成功但不可见，见问题 3。
   - iPhone 生成的能力清单只列命令类型，不列 action 枚举，所以不因新增 `restore` 失效；但首页绑定 `production-home-binding.ts:53-59` 的 `reminderCommand` 类型和 `HOME_ACTIONS` 仍不接受 `restore`，因此 iPhone 首页无法提供撤销动作，作者“所有发送的地方都能接受”的说法不准确。
