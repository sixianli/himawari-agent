## 复核结论

作者的三条说法基本成立：
- `memory.overview` / `proactive.overview.snapshot` 的输出字段未被这次改动改变：`production-memory-control.ts:987-994` 把 `upcoming.dataClassification` 剥掉，`:941-945` 用 `{ lead: false }` 后仍把 `lead` 剥掉；`production-proactive.ts:544-607` 是逐字段显式映射，新加的 `dataClassification`、`insightsCapped`、`decisionId`、`createdAt`、`changedAt` 不会进入旧快照。
- 「没有任何改动涉及发给模型的内容」在代码层面成立：改动落在 home 读取、web push、gateway 合约、proactive/seal 读取层，没有碰 prompt catalog、`thread-prompt-bundles`、`runtime-pi` 或遮盖逻辑。
- 但「新增字段的每个使用处都对得上」有缺口：`upcoming` 的编号字段没有像 `items` 那样过 `fitsContract`，见下面第 1 条。

---

## 读代码证实的问题

### 1. 中：`home.snapshot` 的 `upcoming` 没有做合约可用性过滤，过长 ID 会让整个首页快照解析失败

文件：`apps/agent-service/src/production-home.ts:555-561`、`:573-583`；`packages/gateway-contracts/src/contracts-v2.ts:748-757`

`showableOnly` 只包住了 sources，`upcoming` 是 `HomeFeedService` 的另一个回调，没有经过 `fitsContract`：

```ts
// production-home.ts:555-561
return [
  ...(options.proactive ? [mailSource(options.proactive)] : []),
  approvalSource(options),
  ...(options.memory ? memorySources(options.memory) : []),
  ...(options.runs ? [runSource(options, options.runs)] : []),
].map((source) => showableOnly(source, options.onSourceFailure));
```

而合约要求 upcoming 的三个字段都通过 `machineString`（1–128 字符）：

```ts
// contracts-v2.ts:748-757
upcoming: array(
  object({
    reminderId: machineString,
    memoryId: machineString,
    ...
    sourceThreadId: nullable(machineString),
```

这个不是纯理论：提醒 ID 由命令的 `idempotencyKey` 派生，而 `idempotencyKey` 合约允许到 128 字符：

```ts
// contracts-v2.ts:181
return { ...envelope("command", type), idempotencyKey: machineString } as const;
```

```ts
// production-memory-control.ts:1316-1321
const created = await writer.create({
  key: `owner:${command.idempotencyKey}`,
  ...
```

```ts
// production-reminder-writer.ts:165-166
const memoryId = `memory:reminder:${input.key}` as MemoryId;
const reminderId = `reminder:${memoryId}`;
```

按 `reminder:`(9) + `memory:reminder:`(16) + `owner:`(6) + 128 = 159 字符，`reminderId`/`memoryId` 都超过 `machineString` 的 128。创建/落库路径没有截断或校验这个派生长度（`sqlite-memory-reminder-operations.ts:81-93` 只校验时间、状态和 repeat）。这种提醒如果 `remindAt > now`，会进入 `upcoming`；`notYetDue` 不会滤掉它，而 `items` 那条路径会因 key/`target.id` 被过滤，upcoming 却直接把整个 `home.snapshot` 合约打挂。建议二选一：在创建提醒时限制/规范化派生 ID（例如按上限截断并加哈希）；或对 upcoming 也套用 `fitsContract`，丢掉不合约的 entry、标记 `incomplete`。

### 2. 低：`notYetDue` 在 SQL `LIMIT` 之后过滤，可能少返回本应展示的提醒

文件：`apps/agent-service/src/production-memory-control.ts:511-519`；SQL 在 `packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:151-158`

```ts
// production-memory-control.ts:511-519
const coming = (
  (await this.options.reminders?.listUpcoming({
    ownerId, agentId, from: input.now, to: input.until, limit: input.limit,
  })) ?? []
).filter(({ id, remindAt }) => !exclude.has(id) && !(input.notYetDue && remindAt <= input.now));
```

`listUpcoming` 已经按 `due_at, id` 取了前 `limit` 条，过滤发生在取数之后。正常情况下 `dueReminderViews(sourceReadLimit)` 的 `exclude` 已经覆盖已到提醒，`notYetDue` 是冗余保护；但当已到提醒超过 `sourceReadLimit`（配置上限 200）时，前 `upcomingLimit` 条可能全是被 `notYetDue` 去掉的已到提醒，后面的未来提醒根本取不到，`upcoming` 会少返回甚至为空。建议把 `remind_at > now` 下推为 SQL 条件（在 `LIMIT` 前生效），或循环取到足够条数。

### 3. 低：`insightsCapped` 和 sqlite 的 `LIMIT 500` 是两份独立常量，且统计范围比首页实际展示的更宽

文件：`packages/application/src/services/proactive-overview.ts:309`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:1006`、`apps/agent-service/src/production-home.ts:163-164,219`

```ts
// proactive-overview.ts:309
insightsCapped: storedInsights.length >= PROACTIVE_INSIGHT_LIST_MAXIMUM,
```

```ts
// sqlite-proactive-operations.ts:1006
ORDER BY due_at IS NULL, due_at, updated_at DESC, id LIMIT 500`,
```

`PROACTIVE_INSIGHT_LIST_MAXIMUM = 500` 在 application 层，sqlite 里是硬编码 500。目前数值一致，但改一个不改另一个会静默出错（改大则误报不完整，改小则漏报）。另外 `listInsights` 取的是 `open + replied`，而 home 的 mail source 只展示 `open`（`production-home.ts:164`）；当 500 条都是 `replied` 时也会自报不完整并让 `awaitingCount()` 返回 `undefined`，导致角标一直不显示。建议让 store 返回“是否截断/总数”，或把上限常量放到两端共享的位置，并只对实际会展示的状态判断截断。

### 4. 低：被过滤条目的诊断日志只剩 `"Error"`，丢失 `HOME_ITEM_ID_NOT_SHOWABLE` 这个原因

文件：`apps/agent-service/src/production-home.ts:549`、`apps/agent-service/src/production-http-composition.ts:1176-1181`

```ts
// production-home.ts:549
onSourceFailure(source.name, new Error("HOME_ITEM_ID_NOT_SHOWABLE"));
```

```ts
// production-http-composition.ts:1176-1181
error:
  error instanceof ApplicationPortError
    ? error.code
    : error instanceof Error
      ? error.name
      : "unknown",
```

普通 `Error` 的 `name` 就是 `"Error"`，具体原因在 `message` 里但被故意不记录，运维无法区分“条目 ID 不可展示”和任意其他 `Error`。建议改成带固定 `name`/`code` 的错误类型，既避免泄露 ID，又保留可诊断的原因码。

### 5. 低：`fitsContract` 的 key 超长分支没有反向用例

文件：`apps/agent-service/src/production-home.ts:522-536`；测试 `test/integration/home-feed.test.ts:1037-1049`

新增测试只覆盖了「编号字段不是 machineString」（`proposal ok/1`），没有构造 `key.length > HOME_KEY_MAXIMUM` 的条目。当前 `external_proposal:` 前缀 + `EXTERNAL_PROPOSAL_ID_MAXIMUM=40` 不会触发 160 上限，但提醒、run 等 key 理论上可超长；作者声称「key 过长……丢掉」这一半没有自动检查。建议补一条 key 恰好 160 / 161 的用例，断言被丢弃且 `incompleteSources` 标记。

---

## 推测 / 未核实

- **推测（既有问题）**：`ProductionMcpMemoryWriter.#submit` 对 `proposalId` 只校验长度 1–40（`production-mcp-memory-writer.ts:184-185`），不校验字符集；而 `memory.external.respond` 合约要求 `proposalId: machineString`。非机器串 ID 一旦入库，既进不了 home，也无法通过正常 response 合约处理。真实 MCP 路径用的是 `randomUUID()`（`production-mcp-read.ts:874,934`），所以目前风险低；但这是输入的上下游校验不一致。
- **推测**：`classificationOf` 是每次请求实时读 payload。若 payload 被 `seal.release` 清掉，同一段邮件内容会从 `sensitive` 回退成 `private`。我没有找到 release 会与仍 open 的 insight 同时存在的确定路径，故未列为问题。
- **未核实**：没有运行 `npm run check:prompt-prefix`、测试或 lint；上述「反向用例会失败」是按代码路径判断，未实际执行。
- **未核实**：没有找到专门断言 `memory.overview.upcoming` 不含 `dataClassification` 的回归用例；当前靠 `:994` 的剥除保证。`proactive.overview.snapshot` 由 `production-proactive.ts` 显式映射，现有 snapshot 合约会挡住多出的字段。

---

## 侧重检查

- **错误路径**：`showableOnly` 内部 `source.read` 抛错会冒泡到 `HomeFeedService.#collect`，只记一次 `incomplete`/`onSourceFailure`；`fitsContract` 的 `parse` 异常被捕获；`classificationOf?.()` 缺失时回退 `private`；`awaitingCount()` 在来源失败或 `incomplete` 时返回 `undefined`，web push 的 `#badge` 转成 0，`webPushPayload` 仅在 `badge > 0` 时写 `app_badge`（`production-web-push.ts:139,400`），因此「不完整就不带角标」成立。
- **不合规范/不可信输入**：外部提案 ID 只会在 `items` 被 `machineString` 过滤；`upcoming` 的派生 ID 没有同等保护（第 1 条）。文本字段都有 `line()` 截断并去控制字符；`key` 只检查长度，未直接检查控制字符，但 key 里的编号大多已被 `target.id` 的 `machineString` 覆盖。
- **安全**：日志从 `error.message` 改成 `error.code`/`error.name`，确实避免了把 `proposal ok/1` 这类 ID 写进日志；代价是丢失原因码（第 4 条）。`dataClassification` 现在取自封存正文时的分级，方向正确。
- **资源耗尽**：`readProactiveOverview` 对每条 insight 在 `open()` 之外又做一次 `payloads.get`，上限 500 条时每次 home read / 角标计算最多多 500 次读取；不是全新量级，但值得知道。`upcoming` 的后置过滤是功能问题，不是耗尽问题。
- **不可撤销操作**：本次改动没有新增删除、撤销、推送取消等不可逆操作。
- **规则/文档一致性**：我通过 `git show` 读了 `.claude/rules/prompt-prefix.md`，本改动不触碰模型请求开头；`ci/operations-pending.json` 新增 `home.read` 与「处理程序已实现、缺调用方」一致。没找到与本次行为冲突的 home-feed 设计文档（`docs/` 中未发现对应规格，未核实是否在仓库外）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动不涉及系统提示、工具定义、历史消息、遮盖或压缩；新增的是 `home.snapshot`、web push 角标、`proactive.overview`/`memory.overview` 的 UI 读取层。`memory.overview` 的输出被剥回原字段，`proactive.overview.snapshot` 是显式字段映射。发给模型的内容仍只是在末尾追加，每轮变化的值仍应在最后一条消息里——本次没有碰这套组装。依据：`.claude/rules/prompt-prefix.md#rules` 第 2、4 条。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
对模型请求：不会，因为没有改模型输入的组装/序列化。对 home 快照：`revision` 依赖的列表都有固定 `ORDER BY`（`listInsights`、`listUpcoming`、`listApprovals`、`listChanges`、`listWithChanges` 都有排序），同一 DB 状态 + 同一时钟下字节确定；`generatedAt` 和基于 `now` 的 rank/时间窗口本来就会随请求变化，这是 UI 缓存键的预期行为。唯一可能的时间依赖是 `classificationOf` 在 payload 被释放后回退 `private`，属推测，未发现确定路径。

**3. 有没有对应自动检查，反向用例真的会失败？**
主体行为有对应用例：不完整来源不给角标（`home-feed.unit.test.ts:223-236`、`production-web-push.test.ts:299-332`）、达到 500 自报不完整（`home-feed.test.ts:1127-1150`）、不合约 ID 被丢且不崩（`:1037-1049`）、已到提醒不进 upcoming（`:1108-1117`）、敏感分级透传（`:1080-1106`）、去重前等主人优先（unit test `:238-247`）。按代码路径看，去掉对应修复这些用例会失败（未实际运行）。缺口：key 超长分支没有反向用例（第 5 条）；诊断日志格式没有用例；`memory.overview` 不变没有专门断言。

**4. 每个新增值的使用处都能接受吗？**
逐项核对结果：
- `upcoming.dataClassification`：产生于 `production-memory-control.ts:543`，`home-feed.ts:86` 类型、`contracts-v2.ts:756` 合约、`production-home.ts:623` 映射都接受；`memory.overview` 在 `:994` 剥掉，旧输出不变。通过。
- `ProactiveOverviewInsight.dataClassification`：产生于 `proactive-overview.ts:201-202`，唯一消费方 `production-home.ts:193`；旧 `proactive.overview.snapshot` 不映射它。通过。
- `insightsCapped`：产生于 `proactive-overview.ts:309`，消费于 `production-home.ts:162,219` 以及经由 `HomeSourceResult.incomplete` 到 `home-feed.ts:201`。类型和语义能对上，但与 sqlite `LIMIT` 双份常量、统计范围偏宽（第 3 条）。
- `HOME_KEY_MAXIMUM`：合约 `contracts-v2.ts:710` 和生产侧 `production-home.ts:523` 都用字符串长度比较，语义一致；但只覆盖了 `items`，且无超长反向用例。
- `machineString` 由 gateway-contracts 导出给 `production-home.ts:531` 使用，无导出冲突。
- `notYetDue`：只有 home 传 `true`，`memory.overview` 省略，行为不变；但存在后置过滤问题（第 2 条）。
- `conversationReviewViews({ lead })`：两个调用方都传了正确值（home `true`、memory `false`），无遗漏。
- `awaitingCount(): number | undefined`：web push 用 `?? 0` 且 `badge > 0` 才写 `app_badge`，`service-main.ts:2396` 和测试桩都能接受 `undefined`。通过。
- 唯一明显缺口：`upcoming` 的 `reminderId`/`memoryId`/`sourceThreadId` 没有在产生处或消费处做 `machineString` 的长度/字符集校验，而 `items` 做了（第 1 条）。
