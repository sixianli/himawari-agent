## 复核结论（按严重度排列）

### 1. 中：启动时 `webPush` 早于 `http` 启动，送达时机预算必然失败，到期通知会被直接放行

**文件:行**：`apps/agent-service/src/service-main.ts:2912-2916`、`apps/agent-service/src/service-main.ts:2943`、`apps/agent-service/src/service-main.ts:3288`；`apps/agent-service/src/production-web-push.ts:284-292`

**问题**：`timing` 的 `reserve` 依赖 `http?.perception.reserveModelCost`，但 `webPush.start()` 在 `http = await createProductionHttpComposition(...)` 之前执行，而 `start()` 会立即 `void this.tick()`。在 `http` 赋值前，`reserve` 恒为 `false`，判断结果变成 `timing_budget`，随后走“失败时发”，不会扣住通知。

**证据（读代码证实）**：

```ts
reserve: async (micros) =>
  (await http?.perception.reserveModelCost(
    { ownerId: configuration.ownerId, agentId: configuration.agentId },
    micros,
  )) ?? false,
```

```ts
webPush.start();
...
http = await createProductionHttpComposition({
```

```ts
start(): void {
  if (this.#timer) return;
  this.#timer = setInterval(() => void this.tick(), ...);
  ...
  void this.tick();
}
```

**建议**：把 `http`（或它内部的 `PerceptionService`）的构造提前到 `webPush.start()` 之前，或让 `reserve` 直接使用已构造好的感知存储，不要依赖尚未赋值的 `http`。补一条启动后的首个 tick 反向用例：已有忙状态时首个 tick 应该扣住，而不是直接发送。

**推测**：实际启动窗口持续多久取决于 `createProductionHttpComposition` 的初始化耗时；时间越长，重启期间即将到期的通知越可能被提前发送。

### 2. 中：每个感知窗口只取最早 500 条，超过 500 条时最新状态被丢掉，可能把“已经停下”误判成“还在开车”

**文件:行**：`apps/agent-service/src/production-delivery-timing.ts:80-91`、`:88`；`packages/persistence-sqlite/src/sqlite-perception-operations.ts:1097-1102`

**问题**：`listRecordsBetween` 的 SQL 是 `ORDER BY occurred_at_ms, id LIMIT @limit`，`createDeliveryTimingSource` 又固定 `after: null`、`limit: 500`。因此窗口内超过 500 条时拿到的是最早 500 条，`ownerStateFacts` 的 `newest()` 只能在这批旧记录里挑“最新”，真正最新的停车、醒来、专注关闭记录可能被截掉，继续用旧的 `driving`/`asleep`/`focus_on` 做判断。

**证据（读代码证实）**：

```ts
options.store.listRecordsBetween({
  ...options.scope,
  fromMs: Math.max(0, nowMs - seconds * 1000),
  toMs: nowMs,
  types: [type],
  after: null,
  limit: READ_LIMIT,
})
```

```sql
ORDER BY occurred_at_ms, id LIMIT @limit
```

**建议**：改成从窗口末尾倒序取、或增加“取某类型最新记录”的端口，不要在每类 500 条处截断；若必须分页，从 `toMs` 往回翻页直到取到足够新的记录。补一条 501 条记录、最新一条状态与旧记录相反的测试。

**推测**：故障或恶意设备可以高频上报制造超过 500 条的窗口，从而让服务器一直沿用旧的“忙”状态，导致通知被持续扣住到最长送达时间；这是资源/输入处理风险，不是已复现漏洞。

### 3. 低：限流路径没有诊断，且送达时机的失败会被统一记成“规则闸门失败”，与 ADR 不一致

**文件:行**：`docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:75-76`；`packages/application/src/services/delivery-timing.ts:231-233`；`apps/agent-service/src/production-web-push.ts:676-677`；`apps/agent-service/src/service-main.ts:2921-2927`

**问题**：ADR 第 5 条写“模型超时、出错、回答越界、费用预算用完、每分钟超过 30 次，都……并记一条发送闸门失败的诊断”。代码只对 `timing_failed` 和 `timing_budget` 调用 `onGateFailure`；`timing_rate` 直接返回 `deliver`，没有诊断、没有账本行。并且 `onGateFailure` 在 `service-main.ts` 里固定写 `code: "WEB_PUSH_RULE_GATE_FAILED"`，送达时机的模型失败也会被误报成规则闸门失败。

**证据（读代码证实）**：

```ts
if (this.#recent.length >= configuration.perMinute)
  return this.#settled(question, "deliver", "timing_rate", null, false);
```

```ts
if (judgement.reasonCode === "timing_failed" || judgement.reasonCode === "timing_budget")
  this.#options.onGateFailure?.({ sourceKey: item.sourceKey });
```

```ts
code: "WEB_PUSH_RULE_GATE_FAILED",
```

**建议**：给 `timing_rate` 也发出诊断（或单独的 `timing_rate_limited` 指标），并让送达时机失败的 code 与规则闸门失败分开，例如 `WEB_PUSH_DELIVERY_TIMING_FAILED` / `WEB_PUSH_DELIVERY_TIMING_RATE_LIMITED`。要么改代码，要么改 ADR，不能两边不一致。

### 4. 低：`delivered` 判断后不清掉 `defer_rule_refs`，跨过 deadline 重试会再写一条 `deadline_reached`

**文件:行**：`apps/agent-service/src/production-web-push.ts:659-672`、`:678-690`、`:702-712`；`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:505-520`

**问题**：送达时机扣住时会把 `defer_rule_refs` 写成 `["delivery_timing"]`。之后模型判“可以送”时，代码写一条 `delivered`，但没有清除这个标记；如果实际发送失败进入重试，重试时间越过 deadline，`#timed` 仍会看到 `item.deferredByTiming === true`，于是再写一条 `deadline_reached`。同一个通知的账本里可能同时出现 `delivered` 和 `deadline_reached`，`deadline_reached` 不再表示“最后是被最晚时间放行的”。

**证据（读代码证实）**：

```ts
if (nowMs >= deadline) {
  if (item.deferredByTiming)
    await store.recordDeliveryTiming({
      ...
      outcome: "deadline_reached",
```

```ts
if (judgement.action === "deliver") {
  ...
  if (judgement.judged)
    await store.recordDeliveryTiming({
      ...
      outcome: "delivered",
```

**建议**：`delivered` 时清除 `defer_until`/`defer_rule_refs`，或单独保存“最后一次送达时机判断是 deferred”的状态；只有最后一次判断是 deferred 且越过 deadline 时才写 `deadline_reached`。补一条“先判可以送、发送失败、重试越过 deadline”的测试。

### 5. 低：概率阈值先取整，0.6995 这类低于 0.7 的值也会被扣住

**文件:行**：`packages/application/src/services/delivery-timing.ts:280-283`

**问题**：规格是“概率 >= 0.7 就扣住”，代码先 `Math.round(probability * 1000)` 再和 `busyAtLeastPermille` 比较。`0.6995 * 1000 = 699.5`，`Math.round` 变成 700，于是低于门槛也被判为忙。

**证据（读代码证实）**：

```ts
const permille = Math.round(probability * 1000);
return permille >= configuration.busyAtLeastPermille
  ? this.#settled(question, "defer", "timing_busy", permille, true)
```

**建议**：直接用 `probability * 1000 >= configuration.busyAtLeastPermille`，或在取整时使用 `Math.floor`；补 0.6995、0.6999、0.7 的边界测试。

### 6. 低：每个到期通知先做 5 次感知查询再查缓存/限流，批量到期时数据库读放大

**文件:行**：`apps/agent-service/src/production-delivery-timing.ts:79-93`；`packages/application/src/services/delivery-timing.ts:227-235`

**问题**：`createDeliveryTimingSource.judge()` 无论 `DeliveryTimingJudge` 是否已有缓存、是否已触发限流，都会先读取 5 个窗口（每类最多 500 条）。而 web 和苹果两条路径各最多处理 50 个到期项，最坏情况下同一 tick 会做几百次、数十万行读取，哪怕最终全部命中缓存。

**证据（读代码证实）**：

```ts
const read = await Promise.all(
  windows.map(([type, seconds]) =>
    options.store.listRecordsBetween({ ... })
  ),
);
...
return judge.decide({ pushClass, facts: ownerStateFacts(records, nowMs, configuration) });
```

```ts
const known = this.#remembered.get(key);
if (known) return known.judged;
```

**建议**：先按通知类别/时间窗口读取一次感知快照并在同一 tick 内复用，或让缓存键在读取数据库之前就能命中；限流检查也应尽量前置。补一条批量 50 个通知、同一事实只会读一次感知窗口的性能测试。

### 7. 低：作者关于评测费用和“40 忙/40 闲”的说法与产物不一致

**文件:行**：`evals/delivery-timing/result.json:1-9`、`evals/delivery-timing/first-prompt-result.json:1-22`；`docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:87-91`

**问题**：作者说“两轮……约 0.007 美元”，但现用问法的两轮 `estimatedUsd` 是 `0.003354`；两版合计约 `0.0065` 美元。数据集是 20 条忙 + 20 条闲，每条跑两轮，得到 40 忙调用 + 40 闲调用；说“40 忙/40 闲”容易被理解成各有 40 个不同用例。

**证据（读代码/读产物证实）**：

```json
"calls": 80,
"busyTotal": 40,
"clearTotal": 40,
"medianMilliseconds": 202,
"estimatedUsd": 0.003354
```

```json
"estimatedUsd": 0.00315
```

**建议**：材料里改成“两轮各 40 次忙判断、40 次闲判断，现用问法两轮约 0.0034 美元，两版合计约 0.0065 美元”。

## 侧重检查

- **错误路径**：模型超时/抛错/越界、预算预留失败或抛错、感知库读取失败、通知时间字段异常，代码都走 `catch` 或 `timing_failed`/`timing_budget`，最终放行，不会丢通知。发现的问题是启动期预算恒失败（第 1 条）和限流无诊断（第 3 条）。
- **不合规范/不可信输入**：感知记录值由 `PerceptionRecord` 定义校验（`motion.activity`、`context.focus.active`、`context.connectivity.carPlay`、`health.sample.subtype` 等均为枚举/布尔），没有把自由文本发给模型；出口仍经 `redactForExternalText`，并登记在 `check-egress-redaction`。发现的输入风险是窗口超过 500 条时的截断（第 2 条）。
- **安全**：网关基址固定为 `https://ai-gateway.vercel.sh/v1`，API key 只从配置的 secret 读取，没有日志输出；请求带 `zeroDataRetention: true`；响应大小限制 64 KiB，解析器只接受一个 `predicate` 答案。未发现新的直接泄露路径。**未核实**：未运行真实 Jev，无法验证服务端是否真的执行零保留。
- **资源耗尽**：`READ_LIMIT=500` 的截断和每个到期通知重复读 5 个窗口是主要问题（第 2、6 条）；限流只在每次判断时检查，不能阻止读取放大。
- **不可撤销操作**：没有删除操作；`recordDeliveryTiming` 的延后更新和账本插入在同一事务里，账本只追加。发现的是 `delivered` 后标记未清除导致的账本语义问题（第 4 条）。
- **规则/文档一致性**：`prompt-prefix.md` 的“只追加、固定在前、变化在后”没有被违反；ADR 与代码在限流诊断、deadline 记录和评测费用上不一致（第 3、7 条）。

**未核实/推测**：
- 未运行 `check:prompt-prefix`、Vitest、`check-egress-redaction`，也没有重新计算 `prompt.delivery-timing-question` 的 `sha256`；提示词清单的正确性只能由现有 `prompt-catalog.unit.test.ts` 保证，本次未实际执行。
- 未调用真实 Jev，评测数字全部来自仓库里的 `result.json`/`first-prompt-result.json`。
- 第 1 条的实际影响时长、第 2 条中设备高频上报是否会在真实设备上发生，属于推测；机制本身由代码可证。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会改变已有对话请求的开头。这个 PR 只新增了 `push.delivery-timing-question` 一条提示词和它自己的独立模型调用，没有修改系统提示、工具定义、历史消息或已有提示词的遮盖规则；现有对话仍然只会在末尾追加。新增的后台调用是“固定 instructions + 一条 user 消息”，`notificationKind`、`ownerReports`（含 `secondsAgo`）这些每轮会变的值都在那条消息里，符合“固定的在前、会变的在后”。需要注意：`providerOptions` 是固定字段但排在可变 `input` 之后，不影响前缀规则，只是这一段最后面的固定字段无法优先命中缓存。

2. **同一段文字会不会在不同请求里变成不同字节？**
   已有对话不受影响。新调用的事实顺序固定为 `speech → motion → sleep → focus → car_connection`，不依赖对象遍历或数据库返回顺序；`secondsAgo` 本来就是时间相关的值，且只出现在最后一条用户消息里，属于允许的“每轮变化的值”。遮盖使用每次请求新建的 `sequentialPlaceholderTag`，相同事实集合按相同顺序会得到相同字节；当前发送的值都是枚举/布尔，不含自由文本，因此没有发现同一内容因前后文变成不同字节的问题。**推测性风险**：如果以后把某个事实值改成自由文本，占位符编号会依赖它前面出现的敏感值，届时同一段文字可能随前序事实不同而生成不同占位符；当前实现没有这个问题。

3. **有没有对应的自动检查？反向用例真的会失败吗？**
   有较完整的检查：`packages/application/test/delivery-timing.unit.test.ts` 覆盖新鲜度、删除记录、最新记录、睡眠结束、defer/clear、无事实不调用、模型失败/越界/预算、预算抛错、缓存复查、失败不缓存、限流、deadline；`packages/platform-node/test/delivery-timing-decision.unit.test.ts` 覆盖请求结构、零保留、HTTP 错误、非法响应、模型不匹配；`apps/agent-service/test/prompt-output-contracts.unit.test.ts` 注册了 `deliveryTimingProbability`；`startup-configuration.unit.test.ts` 覆盖配置范围和未知键；`test/integration/delivery-timing-source.test.ts` 用真实感知存储覆盖读取和失败路径；`push-channels.test.ts` 覆盖扣住后发送、deadline、保护类别、无事实、失败诊断、应用可见时不判断；`prompt-catalog.unit.test.ts` 会检查 manifest 的 sha/原因/遗漏，`check-egress-redaction` 也登记了新出口。
   反向用例的断言是有意义的，例如新鲜度用窗口 +1 秒、限流断言恰好 `perMinute` 次调用、deadline 断言不再调用模型、保护类别断言 `calls` 为空。**缺口**：没有启动顺序反向用例，没有超过 500 条记录的截断用例，没有 `recordDeliveryTiming` 非法参数的直接用例，没有“先 delivered 再重试越过 deadline”的用例，也没有 `timing_rate` 诊断用例。评测是真实 Jev 的 live eval，不在常规 CI 中。

4. **每个新值在产生端和使用端都能被接受吗？**
   逐项核对如下：
   - `runPolicy.deliveryTiming`：产生于 `parseDeliveryTiming`（`packages/platform-node/src/strict-configuration.ts:1578-1601`），使用于 `service-main.ts:2820` 和 `production-delivery-timing.ts:28`；解析端拒绝未知键、校验范围，消费端只读取已知字段。**缺口**：和 `voiceAddressee` 一样，没有在配置解析阶段校验 `secretRef` 是否存在，运行时才抛 `DELIVERY_TIMING_SECRET_REQUIRED`。
   - `TIMING_DEFER_REFS = '["delivery_timing"]'`：产生于 `sqlite-web-push-operations.ts:26`、写于 `recordDeliveryTiming`（`sqlite-web-push-operations.ts:505-520`）；使用于 web 和苹果两条 `listDue` 的精确字符串比较。DB 对 `defer_rule_refs` 有 JSON array 校验，能接受。
   - `outcome` 的 `delivered/deferred/deadline_reached`：产生于 `production-web-push.ts:#timed`；`recordDeliveryTiming` 用 `TIMING_OUTCOMES` 校验，DB 的 `decision_ledger_outcomes` 已在 `migrations/20261114151212_perception_records.sql:6-11` 登记这三个值。能接受。
   - `reasonCode`：`timing_clear`、`timing_deadline`、`timing_busy_<signals>` 都满足 `^[a-z0-9_+]{1,64}$`；最长信号组合也小于 64。
   - `defer_until`/`expires_at`：用 `new Date(...).toISOString()` 生成 24 字符 ISO，DB 的 `time()` 和 `defer_until` 长度校验能接受。
   - `id = delivery-timing-<sha256>`：80 字符，小于 128 字符上限；`costMicros: 0` 满足非负整数校验；`confidencePermille` 不传，满足“非 `memory_candidate` 不能带把握”的约束。
   - `deferredByTiming`：由 web/苹果两条 `listDue` 产生，只有 `#timed` 消费，字段可选，能接受。
   - `recordDeliveryTiming` 端口：SQLite 实现和 durable adapter 的 `webPush.recordDeliveryTiming` 都已接上，没有其他 `WebPushStorePort` 实现被漏掉。
   - 提示词 id `push.delivery-timing-question`：在 `prompt-catalog`、manifest、prompt-contract 测试、manifest 测试中都有对应项；解析器 `deliveryTimingProbability` 已导出并登记。
   结论：产生值和消费端校验整体能对上；唯一明确的语义不一致是 `timing_rate` 不写任何诊断/账本，以及 `delivered` 后仍保留 `deferredByTiming` 标记导致后续可能多写 `deadline_reached`。另外 `DELIVERY_TIMING_RECORD_TYPES` 和 `deliveryTimingLookbackMs` 当前没有被实际读取路径使用，存在以后窗口配置漂移的风险。
