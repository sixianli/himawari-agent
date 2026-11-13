## 侧重检查

我按“错误路径、不合规输入、安全、资源、不可撤销操作、文档与代码一致”逐项查了本增量涉及的路径：

- **错误路径**：`fitsMachineStrings` 用 try/catch 吞掉 `ContractValidationError`，返回 false；`showableOnly` 与 `upcoming` 回调都会在丢条目时调用 `onSourceFailure`，`notShowable()` 现在把 `name` 设为 `HOME_ITEM_ID_NOT_SHOWABLE`（`production-home.ts:543-547、558-561、593-598`）。
- **不可信/超限输入**：`machineString` 先判 `input.length > 128` 再跑正则，超长 id 不会进入正则（`packages/gateway-contracts/src/validation.ts:49-60`）。SQL 全部参数化，无注入面（`sqlite-memory-reminder-operations.ts:153-168`）。
- **资源**：`listUpcoming` 仍受 `this.limit()` 约束（0–200，`sqlite-memory-reminder-operations.ts:76-79`）；新增的 open-only 查询也只取最多 500 条，未发现无界读取。
- **不可撤销操作**：本增量只改读取路径，没有写入、删除或外部副作用。
- **规则/文档一致性**：`"upcoming"` 已列入 `HOME_SOURCE_NAMES`（`contracts-v2.ts:672-682`），可被 `incompleteSources` 合约接受；本增量未改 prompt 组装代码。

---

## 读代码证实的问题

### 1. 中：`reminderId` 的生成端可超过 128 字符合约，新过滤会静默丢弃真实提醒；记忆页仍无过滤

- `apps/agent-service/src/production-memory-capture.ts:609`
  ```ts
  memoryIdFor: (generation, ordinal) => createMemoryId(`memory:${generation}:${ordinal}`),
  ```
  `packages/domain/src/identifiers.ts:39-47` 允许机器 id 最长 **128** 字符。

- `apps/agent-service/src/production-memory-capture.ts:618`
  ```ts
  id: `reminder:${memoryId}`,
  ```
  这里直接拼上 9 个字符，没有长度校验。`memoryId` 长度 120–128 时，`reminderId` 为 129–137，超过 `machineString` 的 128 上限。

- 而 `MemoryReminder` 的 `schedule` 也不校验 reminder id 的长度/字符集：
  `packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:81-93` 只校验 `dueAt`、`remindAt`、`status`、`repeat` 和 memory 是否存在。

- 消费端合约确实要求 `machineString`：
  - 首页 `upcoming.reminderId`：`packages/gateway-contracts/src/contracts-v2.ts:748-757`
  - 记忆页 `reminders`/`upcoming.reminderId`：`contracts-v2.ts:1626-1643`
  - 提醒操作 `memory.reminder.respond.reminderId`：`contracts-v2.ts:1736-1741`

影响：这样的提醒在首页 upcoming 会被新过滤掉并标记 `incompleteSources: ["upcoming"]`；在记忆页仍原样输出，可能直接触发合约校验失败。新测试用 160 字符 id 只验证了“超大 id 会被丢”，没有覆盖“按现有生成路径可产生的 129–137 字符 id”。

建议：为 reminder id 定义统一的有界校验（例如引入 `createReminderId` 并在 `schedule` 校验），或改用定长哈希/截断策略；合约若有意支持更长 id，则首页、记忆页、respond 三处一起放宽。并加一条从 `onCommitted` 生成 → 首页/记忆页/respond 合约的端到端用例。

### 2. 中低：“过滤在 LIMIT 之前”这一关键行为没有反向用例

- `packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:153-158`
  ```sql
  WHERE ... AND r.due_at >= ? AND r.due_at <= ? AND (? IS NULL OR r.remind_at > ?)
  ORDER BY r.due_at, r.id LIMIT ?
  ```
  改动意图是让 SQL 先剔除已到点提醒，再取 LIMIT。

- 但对应测试 `test/integration/home-feed.test.ts:1108-1117` 用的是 `sourceReadLimit: 1`（限制的是 due 列表，不是 `upcomingLimit`，后者仍为 20），且只有 2 条已到点提醒；即使把 `remind_at` 过滤放在 SQL 取完 LIMIT 之后再做，这条测试仍然通过。

- 也就是说，现有用例能覆盖“过滤条件存在”，但不能覆盖“过滤发生在 LIMIT 之前”这一真正要防的回归。若以后有人改成“先取 limit 再过滤”，测试不会失败。

建议：增加 `upcomingLimit` 很小（例如 2）且已到点提醒数量 ≥ `upcomingLimit`、后面还有一条未来提醒的用例，断言未来提醒仍出现；这种场景下“先 LIMIT 后过滤”会返回空，能真正反向失败。

### 3. 低：持久化 worker 分发处的类型漏掉了 `remindAfter`

- `packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:44-53`
  ```ts
  case "memoryReminder.listUpcoming":
    return this.listUpcoming(
      payload as {
        ownerId: OwnerId;
        agentId: AgentId;
        from: string;
        to: string;
        limit: number;
      },
    );
  ```
  但 `listUpcoming` 的实现读取 `input.remindAfter`（同文件 `:149-152`），端口也新增了该字段（`packages/application/src/ports/memory-reminders.ts:33-40`）。

- 运行时目前没问题：`as` 只影响类型，`postMessage` 的结构化克隆会保留该属性。但这意味着类型系统不再保护这个跨 worker 边界的新字段；若将来中间层做字段白名单或重建对象，会静默失效。

建议：在 `execute` 的 cast 类型里补上 `readonly remindAfter?: string;`，让两端类型一致。

### 4. 低：新过滤的 `memoryId`/`sourceThreadId` 分支和错误 name 都没有自动检查

- 新测试 `test/integration/home-feed.test.ts:1119-1146` 只让 `reminderId` 超限；`memoryId`（`memory-long-later`）和 `sourceThreadId`（来自 `remember` 的合法 thread id）都是合法值。若有人删掉 `fitsMachineStrings` 中 `memoryId` 或 `sourceThreadId` 的检查，测试仍通过。

- `HOME_ITEM_ID_NOT_SHOWABLE` 在全仓库只出现在 `apps/agent-service/src/production-home.ts`，没有任何测试断言诊断里的 `error.name`；把 `notShowable()` 改回 `new Error("HOME_ITEM_ID_NOT_SHOWABLE")`，现有测试仍会通过。

建议：各加一个非法 `memoryId`、非法 `sourceThreadId` 的提示/提醒用例；并在首页测试里捕获 `onHomeDiagnostic`，断言 `error === "HOME_ITEM_ID_NOT_SHOWABLE"`。

### 5. 低：作者列的“其他调用方”漏了 `owner-profile-service.ts`

作者说其他调用方只有“记忆页、production-reminder-writer.ts”。实际还有：

- `packages/application/src/services/owner-profile-service.ts:261-267`
  ```ts
  const upcoming = await reminders.listUpcoming({
    ownerId: input.ownerId,
    agentId: input.agentId,
    from: input.now,
    to: ...,
    limit: AGENDA_LIMIT,
  });
  ```
  这是 `owner-agenda` 上下文块的来源（同文件 `:340-350`）。

它没有传 `remindAfter`，SQL 的 `(? IS NULL OR ...)` 分支为真，因此结果确实不变；但作者的说法不完整。好在这一点也支持了“没有改到模型已见内容”的判断。

---

## 推测 / 未核实

- 第 1 条的实际触发频率取决于生产里 `runId`/`memoryId` 的真实长度分布；代码允许 `memoryId` 到 128，但当前数据是否接近该边界**未核实**。
- 首页/记忆页前端最终是否从 `key`（如 `reminder:...`）反解 `reminderId` 再发 `memory.reminder.respond`，本仓库没有该 UI 实现，**未核实**；但记忆页快照本身已足以触发合约不一致。
- 我没有运行 `npm run check:prompt-prefix` 或任何测试（环境只允许读文件和 git 命令），下面关于“测试会/不会失败”的结论均来自静态阅读。

---

## 作者说法核对

- “首页 upcoming 按合约检查 reminderId、memoryId、sourceThreadId，丢条目写 incompleteSources”：**对**（`production-home.ts:593-598`）。
- “HomeFeedService 的 upcoming 回调改为 `{ items, incomplete }`”：**对**（`home-feed.ts:118-124、248-261`）。
- “`remindAfter` 下推到 SQL，在 LIMIT 之前排除已到点提醒”：**SQL 对**（`sqlite-memory-reminder-operations.ts:153-158`），但缺少针对“过滤在 LIMIT 之前”的反向测试（见问题 2）。
- “首页不再为了排除而读到点提醒”：**对**，`production-home.ts:584-599` 不再调用 `dueReminderViews`。
- “`insightsCapped` 只有 open 被截掉才报不完整”：**大体对，边界措辞不精确**。`proactive-overview.ts:154-159` 里 `openCount >= PROACTIVE_INSIGHT_LIST_MAXIMUM` 在“恰好 500 条 open、实际没有截断”时也会报不完整；因为 SQL `LIMIT 500` 无法区分是否还有更多，这属于保守处理，不算 bug。
- “丢条目时错误 name 是 `HOME_ITEM_ID_NOT_SHOWABLE`”：**对**（`production-home.ts:543-547`），但无测试断言（见问题 4）。
- “listUpcoming 其他调用方不传 remindAfter，行为不变”：**结论对，列表不完整**，漏了 `owner-profile-service.ts:261`（见问题 5）。
- “这些修改没有涉及发给模型的内容”：**对**。本增量未改 prompt 组装；唯一与模型上下文相关的 `listUpcoming` 调用是 `owner-profile-service.ts:261`，不传 `remindAfter`，SQL 空分支使结果不变。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本增量只改首页、主动概览、提醒查询，没有改系统提示、工具定义、历史消息、遮盖或 prompt 组装代码（`git diff e9c00e3..c7285be` 未触及 `packages/prompt-catalog`、运行时适配器或请求组装）。唯一可能进入模型上下文的 `owner-agenda` 仍走 `owner-profile-service.ts:261`，未传 `remindAfter`，SQL 的 `(? IS NULL OR ...)` 使查询结果与改前相同。因此仍是“只在末尾追加”，本轮会变的值仍只在最后一条用户消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。未运行 prompt-prefix 门槛，属未核实。

2. **同一段文字会不会在不同请求里变成不同字节？** 未发现新增的不确定性。SQL 仍按 `due_at, id` 固定排序（`sqlite-memory-reminder-operations.ts:158`）；新过滤只取决于条目自身字段；`incompleteSources` 顺序由固定 source 顺序加末尾 `"upcoming"` 决定；`Set` 只用于 `exclude`，不参与序列化。`insightsCapped` 是布尔值，不引入时间相关字节。`owner-agenda` 的 listUpcoming 结果不变。

3. **有没有对应自动检查，反向用例真的会失败吗？** 有新增/修改用例，但覆盖不完整：
   - 500 条上限用例 `home-feed.test.ts:1156-1197`：旧逻辑（`storedInsights.length >= 500`）会在第一次 `full` 断言处把 `mail` 标为不完整，确实会失败，反向有效。
   - 超长 id 用例 `:1119-1146`：若去掉 upcoming 过滤，`snapshot.upcoming` 会包含超长 id，合约解析失败或断言失败，反向有效。
   - 但“过滤在 LIMIT 之前”没有反向用例（问题 2）；`memoryId`/`sourceThreadId` 分支、`HOME_ITEM_ID_NOT_SHOWABLE` 的 `error.name` 都没有反向用例（问题 4）。

4. **每个值是否所有使用方都能接受？** 大部分可以：
   - `remindAfter`：端口、durable adapter、SQL 三处一致；但不传的调用方（记忆页、reminder writer、`owner-profile-service`）结果不变；worker 分发 cast 漏了该字段（问题 3，运行时仍可用）。
   - `"upcoming"`：已列入 `HOME_SOURCE_NAMES`，合约接受（`contracts-v2.ts:672-682`）。
   - `HOME_ITEM_ID_NOT_SHOWABLE`：`onHomeDiagnostic` 用 `error.name` 上报（`production-http-composition.ts:1172-1182`），现在会得到正确值。
   - `insightsCapped`：只被首页 `mailSource` 消费（`production-home.ts:162、219`），而它只显示 open，语义一致；其他调用方未使用该字段。
   - **问题在 reminder id**：生成端允许超过 128 字符，首页 upcoming 会丢弃、记忆页仍输出、`memory.reminder.respond` 也要求 128 字符上限（问题 1）。这是本次“逐个查产生端和使用端”后最值得处理的跨端不一致。
