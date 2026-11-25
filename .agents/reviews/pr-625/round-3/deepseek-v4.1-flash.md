**复核范围**：当前目录已检出 `17ee26284`。本轮只核对 `1d1231973..17ee26284` 的增量（`production-memory-control.ts`、`memory-page.tsx`、`memory-reminders.ts`、`sqlite-memory-reminder-operations.ts`、两个 control-center 测试、一个集成测试）；用 `grep` 追到端口、SQLite、合约、e2e/测试夹具的全部直接使用端。全量 diff 只用于确认上下文。未运行测试，也未运行 iPhone 代码生成器。

## 意见

### 1. 低：上一轮意见 3 没有改好，重复/重试 restore 仍直接失败，会把已经成功的恢复显示成“没能恢复”

**文件:行**：`apps/agent-service/src/production-memory-control.ts:2031-2035`、`apps/control-center/src/components/memory-page.tsx:947-954, 1128-1134`、`test/integration/production-memory-capture.test.ts:1931`

**问题**：增量没有改动 `restore` 的状态机。第一次恢复成功后再发一次 `restore`（重试、双击、列表尚未刷新时的陈旧按钮）仍会抛 `MEMORY_REMINDER_NOT_CANCELLED`，网页随即显示“没能恢复这条提醒”，与第一次实际已经成功的结果矛盾。上一轮意见 3 说“已修改”，但代码与测试都仍是拒绝。

**证据（读代码证实）**：

```ts
// production-memory-control.ts:2031
if (reminder.status !== "cancelled" && action === "restore")
  throw new ApplicationPortError(
    PORT_ERROR_CODES.INVALID_OPERATION,
    "MEMORY_REMINDER_NOT_CANCELLED",
  );
```

```ts
// memory-page.tsx:947
const restore = (item) => memory?.respondReminder(item, "restore").then((ok) =>
  setNotice({
    text: ok ? message("memory.page.restored", ...) : message("memory.page.restoreFailed"),
  }),
);
```

集成测试还明确把这个失败固化成断言：

```ts
// test/integration/production-memory-capture.test.ts:1931
await expect(answer("restore")).rejects.toThrow("MEMORY_REMINDER_NOT_CANCELLED");
```

**推测（竞态窗口）**：`memory.ts:239-251` 的 `run` 在 `finally` 里先把 `busy` 置回 false，再异步 `setReload` 拉新快照；在快照返回前，`memory-page.tsx:1128-1134` 的“恢复”按钮仍按旧 `overview.cancelled` 渲染且已重新可点，因此第二次点击可能落在这段窗口里，产生假失败提示。

**建议**：二选一，并在说明中写清。若 accept “非取消状态必须拒绝”，请把上一轮“已修改”的说法改正，并说明重复点击由前端处理；否则前端在成功后立即乐观移除该取消项/禁用按钮，或让后端对同一恢复命令做幂等重放（用同一幂等键），并补一条“连续两次 restore 第二次也成功或至少不报错”的测试。目前测试只覆盖了“第二次必须失败”，没有正向幂等用例。

## 上一轮意见核对

- **意见 1（中高）已改好**：`production-memory-control.ts:658-662` 不再传 `dueAfter`，`sqlite-memory-reminder-operations.ts:174-187` 删除了 `r.due_at > ?` 条件，改为按 `updated_at DESC, id` 取最近取消。集成测试 `production-memory-capture.test.ts:1920-1922` 用已过期的 `dueAt: 2026-10-30T07:00:00.000Z`（当时时钟 07:06）断言它出现在 `cancelled`；若恢复旧过滤，这条会失败。
- **意见 2（低）已改好**：`memory-page.tsx:1140-1143` 的空状态条件加入了 `!overview.cancelled.length`；`memory-interactions.unit.test.ts:1524-1540` 的用例在有取消项且无提醒时断言不出现“还没有提醒”，恢复旧条件即失败。
- **意见 3（低）未改好**：见上面意见 1；增量未触碰 `restore` 分支，且测试仍在断言第二次恢复失败。

## 侧重检查

- **错误路径**：`restore` 对不存在或不属于本 owner/agent 的提醒返回 `MEMORY_REMINDER_NOT_FOUND`（`production-memory-control.ts:2028-2030`）；非取消状态返回 `MEMORY_REMINDER_NOT_CANCELLED`（2031-2035）；已取消提醒的 `dismiss`/`snooze` 仍返回 `MEMORY_REMINDER_CANCELLED`（2036-2040）；更新竞争返回 `MEMORY_REMINDER_CHANGED`（2072-2079）。重复恢复见意见 1。
- **不合规范/不可信输入**：增量没有新增外部字符串入口；`restore` 只能经合约枚举进入（`contracts-v2.ts:2545`）；内部 `listCancelled` 的 `limit` 由 `sqlite-memory-reminder-operations.ts:79-82` 校验为 0–200，生产只传 20。
- **安全**：`memory.reminder.respond` 先按 owner/agent 校验（2028-2030）；`cancelledViews` 只读取仍 active 的记忆文本（SQLite `liveMemory` 连接条件，11-12、182-184），不会跨 owner/agent 暴露。
- **资源耗尽**：`CANCELLED_SHOWN = 20`，最多读 20 条记忆文本，逐条解密。**推测（低风险）**：取消记录移到 `updated_at` 排序且没有 `updated_at` 索引，历史取消很多时会排序全部匹配行；响应本身仍受 20 条限制，未实测其影响。
- **不可撤销操作**：`restore` 只是把状态改回 scheduled，可再次取消，没有删除数据或不可逆副作用。
- **文档/规则一致性**：`docs/adr/0192...md` 第 8 条已写明 `restore` “改回已排期、时间不变”，与代码一致；增量未改工具登记表或规则手册。作者说法第 1 条“其余状态拒绝”与代码一致，但与“上一轮意见 3 已修改”的材料说明矛盾。
- **未核实**：iPhone 生成器未运行；只看到生成文件 `ClientCapabilities.swift:133` 登记的是操作类型，不含 action 枚举，因此它本身不会拒绝 `restore`。

## 必答问题

1. **不涉及模型请求开头。** 增量只改网页提醒页、SQLite 查询和测试，没有触碰系统提示、工具定义、历史消息、遮盖或压缩路径。按 `.agents/instructions/prompt-prefix.md:27-29` 的规则，本次没有给请求开头增加任何会变的值；发给模型的内容“只在末尾追加”这条路径未被改动，未发现回归。
2. **不涉及模型请求字节。** `cancelled` 数据只进网页快照，不进模型请求；增量反而移除了 `dueAfter` 这一依赖当前时间的过滤，`listCancelled` 以 `updated_at DESC, id` 确定排序，不存在无序集合或按上下文变化的遮盖。`overview.generatedAt` 是旧字段，与本次增量无关。
3. **有对应自动检查，反向用例确实会失败。** 意见 1 的反向用例：`production-memory-capture.test.ts:1920-1922`（恢复 `due_at > ?` 即失败）；意见 2 的反向用例：`memory-interactions.unit.test.ts:1524-1540`（去掉 `!overview.cancelled.length` 即出现“还没有提醒”而失败）。意见 3 没有正向幂等用例，反而由 `production-memory-capture.test.ts:1931` 断言第二次恢复失败。
4. **本次增量产生的值两端的校验都能接受。**
   - `listCancelled` 输入删掉 `dueAfter`：生产端 `production-memory-control.ts:658-662`、端口 `memory-reminders.ts:41-45`、适配器 `durable-adapters.ts:1160`、SQLite `sqlite-memory-reminder-operations.ts:55-56, 174-187`；全仓 `listCancelled` 只有这些使用点，均按 `{ownerId, agentId, limit}` 传/收，没有残留传 `dueAfter` 的调用。
   - `overview.cancelled`：服务端 `production-memory-control.ts:655-685` 产生，合约 `contracts-v2.ts:2403-2411` 的 `dueAt` 为 `timestamp`（`validation.ts:152-161` 接受任意规范 UTC 时间，过期 `dueAt` 也能通过）、`text` 与 `repeat` 同既有 upcoming 字段；读取端只有 `memory-page.tsx:1117-1139, 1140-1143, 1164-1167`；快照生产者服务端、`gateway-v2.fixture.ts:1225`、e2e `control-center-browser-server.mjs:1039`、control-center 测试桩 `app-interactions:210`、`memory-interactions:262` 均已带 `cancelled`。
   - `restore` 枚举：合约 `contracts-v2.ts:2545`、网页发送 `memory.ts:401-402`、服务端处理 `production-memory-control.ts:2020-2080`、iPhone 生成能力清单只登记操作类型，不单独校验 action；未发现会拒绝它的另一端校验。
