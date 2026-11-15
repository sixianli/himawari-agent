本轮核对范围：`58c97c8..da95a27` 的增量 13 个文件；顺证据追到 `production-web-push` 的 `#deferred/#timed`、SQLite web/apple push 操作、`service-main` 启动段、感知存储的 `listRecordsBetween`、ADR 0273、prompt manifest/出网登记，以及相关单测和集成测试。上一轮 5 条意见的核对结果：第 1、2、4、5 条已实质改好；第 3 条只补了限流触发，诊断标签仍是“规则闸门失败”；第 2 条在超过 1 万条时仍有截断，并带来新的读放大（见下）。增量没有发现会改坏主流程的新错误。

## 侧重检查

- 错误路径：分页超过 20 页会抛 `DELIVERY_TIMING_WINDOW_TOO_LARGE`，该异常在 `#timed` 的 `try/catch` 内被吞掉并返回“不延后”，通知仍会发出（`production-web-push.ts:651-720`）；模型错误、预算失败、限流同样走失败即发。
- 不可信输入：真正进入外部模型的 `motion.activity` 值是枚举（`perception.ts:161-164`），睡眠/专注/车连接也都是布尔或枚举，`activity` 不是任意文本；出网还经过 `redactForExternalText`，并带 `zeroDataRetention: true`。
- 安全/出网：增量没有新增出网路径；新增文件已在 `ALLOWED_EXTERNAL_EGRESS_FILES` 和 `REQUIRED_EXTERNAL_REDACTION_CALLS` 登记，`redactForExternalText` 调用存在。
- 资源耗尽：见意见 1。分页把每个窗口从 1 次查询放大到最多 20 次，且发生在判断器的缓存/限流之前；`#deliver` 对最多 50 条到期项逐条调用，最坏可达 5000 次 SQL 查询/轮。
- 不可撤销操作：本轮修改只有延后状态和 refs 的数据库更新，均在同一事务内，且行 ledger id 幂等；没有不可撤销动作。
- 规则/文档一致性：ADR 0273 第 76 行只要求“发送闸门失败的诊断”，代码的 event 是 `web-push.gate-failed`、code 是 `WEB_PUSH_RULE_GATE_FAILED`，与“规则”相关的命名不完全一致（意见 2）。ADR 关于 `delivery_timing` 只允许 `delivered/deferred/deadline_reached`、不存概率、不改表的说法与代码一致。
- 启动顺序：`webPush.start()` 现在在 `http = await createProductionHttpComposition(...)`（`service-main.ts:3287`）之后（`3472`），预算闭包在调用时才读 `http.perception`，第 1 条意见的失败模式已消除。

## 上一轮 5 条的核对

1. 已改好：旧位置 `webPush.start()` 已删除，新位置在 `service-main.ts:3472`，晚于 `http` 赋值（`3287`）。但没有对应自动检查（见意见 3）。
2. 已改好到 10,000 条以内；超过 20 页仍抛错并直接送达，最新状态仍会丢，且带来读放大（见意见 1）。
3. 部分改好：`timing_rate` 现在会触发 `onGateFailure`，但标签仍是 `WEB_PUSH_RULE_GATE_FAILED`（见意见 2）。
4. 已改好：`recordDeliveryTiming` 对非 `deferred` 结果清空 `defer_rule_refs`，且新增 APNS 失败后不再写 `deadline_reached` 的反向测试。未被记录成 `delivered` 的“失败即发”路径本来就不会产生 `delivered`，因此不构成同一类矛盾，我不另算缺陷。
5. 已改好：比较改为 `probability * 1000 >= busyAtLeastPermille`，`0.6995` 不再被四舍五入成 700；新增反向测试覆盖 `0.6995` 与 `0.7`。

### 1. 低：分页硬上限 20 页/1 万条，超过后仍会丢掉最新状态，并把每个窗口的查询放大到最多 20 次

文件:行：`apps/agent-service/src/production-delivery-timing.ts:21-22`、`85-99`；`apps/agent-service/src/production-web-push.ts:552-567`、`674`

问题：分页只保证 10,000 条以内取到最新记录。某个窗口超过 `20 × 500` 条时，代码抛出 `DELIVERY_TIMING_WINDOW_TOO_LARGE`，`#timed` 捕获后返回 false 并直接发送，最新状态（比如“已经停下”）仍然没被用上，只是失败阈值从 500 提高到 10000。同时，每次判断都会先读完五个窗口的所有分页，才进入判断器的缓存/每分钟限流；`#deliver` 每条到期项各调用一次，最坏会产生大量重复查询。

证据：
```ts
const READ_LIMIT = 500;
const READ_PAGES = 20;
...
for (let page = 0; page < READ_PAGES; page += 1) {
  const { records } = await options.store.listRecordsBetween({...});
  collected.push(...records);
  const last = records[records.length - 1];
  if (records.length < READ_LIMIT || !last) return collected;
  after = { atMs: last.occurredAtMs, id: last.id };
}
throw new Error("DELIVERY_TIMING_WINDOW_TOO_LARGE");
```
```ts
for (const entry of due) {
  ...
  const judgement = await timing.judge(pushClass, nowMs);
```
建议：给感知存储增加“按类型/范围只取最新一条”的查询（或降序 + limit 1），让每个窗口一次查询且不受条数上限影响；若保留分页，应把 10000 条上限写进配置/诊断，并补一条超过 10,000 条的反向测试；同时把事实读取按同一 `nowMs` 在单轮内缓存，避免每条通知重复读同样的窗口。

### 2. 低：限流和送达时机失败仍被记成“规则闸门失败”，第 3 条只补了触发、没改标签

文件:行：`apps/agent-service/src/service-main.ts:2921-2927`；`apps/agent-service/src/production-web-push.ts:675-681`

问题：`timing_rate` 现在会调用 `onGateFailure`，但生产回调仍固定写 `event: "web-push.gate-failed"`、`code: "WEB_PUSH_RULE_GATE_FAILED"`。限流、模型失败、预算不足都不是规则闸门失败，运维/告警会把它们当成硬规则故障；上一轮意见的后半句“与 ADR 不一致”没有被消除。

证据：
```ts
judgement.reasonCode === "timing_failed" ||
judgement.reasonCode === "timing_budget" ||
judgement.reasonCode === "timing_rate"
```
```ts
onGateFailure: ({ sourceKey }) =>
  writeServiceDiagnostic(errorOutput, {
    component: "agent-service",
    event: "web-push.gate-failed",
    code: "WEB_PUSH_RULE_GATE_FAILED",
```
建议：让回调带上 `reasonCode`/`kind`，分别写 `web-push.timing-failed`、`web-push.timing-rate` 等事件/代码，或至少把 `WEB_PUSH_RULE_GATE_FAILED` 改成不暗示硬规则的名字，并同步文档和测试。

### 3. 低：启动顺序修复没有自动检查，现有启动测试没有配置 `runPolicy.deliveryTiming`

文件:行：`apps/agent-service/src/service-main.ts:3287`、`3472`；`apps/agent-service/test/service-orchestration.unit.test.ts:207`、`759`

问题：第 1 条是只在“配置了送达时机”时才显现的启动顺序缺陷。本次只移动了 `webPush.start()`，但没有任何测试启动一个带 `runPolicy.deliveryTiming` 的运行时并断言首次判断不是 `timing_budget`，也没有断言 `webPush.start()` 在 `http` 赋值之后。将来再调整启动顺序会静默回归。

证据：
```ts
http = await createProductionHttpComposition({
```
```ts
webPush?.start();
await http.assertIdentityReady();
```
```ts
runPolicy: undefined as unknown,
...
configuration.runPolicy = {};
```
建议：补一个启动级测试（可复用 `service-orchestration` 的租户输入），开启 webPush 与 deliveryTiming，注入可观察的感知存储/预算，断言首次判断能拿到预算或至少不出现 `timing_budget`。

### 4. 低（影响为推测）：阈值改成浮点比较后 `confidencePermille` 仍是四舍五入值，可能和 action 矛盾

文件:行：`packages/application/src/services/delivery-timing.ts:282-285`

问题：`0.6995` 现在正确判为 `timing_clear`，但返回的 `confidencePermille` 仍是 `Math.round(699.5) = 700`，恰好等于默认延后门槛。当前没有任何消费端存储或使用这个字段（`#timed` 只看 `action/reasonCode/judged/signals`，ledger 不存概率），所以现在不会出错；但这是一个以后接诊断或展示时容易踩的坑。

证据：
```ts
const permille = Math.round(probability * 1000);
return probability * 1000 >= configuration.busyAtLeastPermille
  ? this.#settled(question, "defer", "timing_busy", permille, true)
  : this.#settled(question, "deliver", "timing_clear", permille, true);
```
建议：改用 `Math.floor`（或让 `permille` 与比较条件同源），或直接不暴露这个字段；如果保留，补一条“deliver 时 permille 不得等于门槛”的断言。

## 读代码证实的

- 增量没有修改任何现有 system prompt、工具定义、历史消息或遮盖结果；`push.delivery-timing-question` 是新增的独立 prompt 条目，只被 `delivery-timing-decision.ts` 使用（`prompt-manifest.json` 新增项、`perception.ts:493-501`、`index.ts` 导出）。
- 分页 SQL 的游标语义与代码一致：`ORDER BY occurred_at_ms, id`，`after` 用 `occurred_at_ms > afterMs OR (= AND id > afterId)`（`sqlite-perception-operations.ts:1099-1102`），端口 limit 校验为 1–500（`1077-1085`），`READ_LIMIT=500` 合法。
- 清空 `defer_rule_refs` 合法：迁移允许 NULL（`20261114151105_web_push_gate.sql:4-5`），web 和 Apple 两侧都以“等于 `TIMING_DEFER_REFS`”判断 `deferredByTiming`（`sqlite-web-push-operations.ts:376`、`sqlite-apple-push-operations.ts:397`），NULL 会自然变成未延后。
- 启动顺序：`http` 在 `service-main.ts:3287` 赋值，`webPush.start()` 在 `3472`；`reserve` 是闭包 `(await http?.perception.reserveModelCost(...)) ?? false`，调用时已能拿到 `http`。
- 限流测试、阈值测试、分页测试、清 refs 测试都存在；在旧实现下分别会因“没有 onGateFailure”“0.6995 被 round 成 700”“只取最早 500 条”“deadline_reached 被写入”而失败。
- 权限/出网：`delivery-timing-decision.ts` 已在 `ALLOWED_EXTERNAL_EGRESS_FILES` 与 `REQUIRED_EXTERNAL_REDACTION_CALLS` 中登记，文件里确实调用了 `redactForExternalText`（`delivery-timing-decision.ts:71`）。
- 生产默认关：`productionDeliveryTiming` 在 `!route` 时返回 undefined（`production-delivery-timing.ts:29-30`），`service-main.ts:2902` 只有在 `timingModel && timingConfiguration` 时才注入 `timing`。
- 账本：`recordDeliveryTiming` 写入 `kind: "delivery_timing"`，outcome 只允许 `delivered/deferred/deadline_reached`（`sqlite-web-push-operations.ts:27`、`533`），`insertLedgerRow` 对非 `memory_candidate` 强制 `category/confidence/inferred` 为 null（`sqlite-decision-ledger-operations.ts:118-120`），与“不存概率”一致。

## 推测

- 意见 1 中“高基数会拖慢单轮”的具体耗时只是按最坏查询次数推算，未在真实数据集上跑过；正常窗口通常一页就够。
- 评测数字只核对了 `evals/delivery-timing/result.json` 的 summary（40/40、0/40、0 错误、中位 202ms、约 $0.003354）；作者说的“两版共约 0.007 美元”还需要 `first-prompt-result.json` 的汇总，未逐条核算。
- `.agents/instructions/prompt-prefix.md` 在当前稀疏检出中不存在，具体条文未核实；第 1 题的结论是基于代码和测试推断的。
- 意见 4 的实际影响依赖未来是否有人使用 `confidencePermille`；当前代码路径没有消费它。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 增量没有改主对话的 system/tools/history；新增的 `push.delivery-timing-question` 是独立的一次 `/v1/decisions` 请求，稳定 instructions 在 `questions`，每次变化的 `ownerReports`（含 `secondsAgo`）在唯一的 user 输入里，符合“变化值在最后一条消息”。主对话侧没有任何新增追加。`prompt-prefix.md` 具体条文未核实（文件不在稀疏检出中）。

2. **不会让同一段文字在不同请求里变成不同字节（主对话零影响）。** 增量没有新增依赖前后文的遮盖或时间字段；分页顺序固定为 `occurred_at_ms, id`，`ownerStateFacts` 输出顺序固定，`#settled` 的 `signals` 用 Set 保序。新路线的 `secondsAgo` 本来就随时间变化且位于唯一的 user 输入；`sequentialPlaceholderTag` 是按请求内顺序确定的，不是随机；进入值的是固定枚举，不会触发遮盖差异。

3. **有自动检查，反向用例确实能抓住旧错误。** 分页、阈值、限流诊断、清 refs 都有新增测试，且按旧实现会失败。缺口是：启动顺序修复没有测试；>10,000 条的分页抛错路径没有测试；清 refs 的反向测试只走了 APNS，web 路径没有单独覆盖（两条路径共用同一 `#deferred`/`recordDeliveryTiming`，风险较低）。

4. **增量改到的每个值，直接使用端都能接受。** `timing_rate` 由 `delivery-timing.ts:233` 产生，`production-web-push.ts:679` 消费；因 `judged:false` 不写 ledger，即使写也满足 `^[a-z0-9_+]{1,64}$`。`defer_rule_refs=NULL` 由 `sqlite-web-push-operations.ts:524-527` 产生，`sqlite-web-push-operations.ts:376` 与 `sqlite-apple-push-operations.ts:397` 消费，表 CHECK 允许 NULL。`after` 游标由 `production-delivery-timing.ts:97` 产生，`sqlite-perception-operations.ts:1100-1102` 按其 `atMs/id` 排序和过滤，`limit=500` 通过 1–500 校验。`READ_PAGES`/`READ_LIMIT` 是文件内常量，没有配置键消费端。`webPush.start()` 只影响启动时机，`http` 已在 `3287` 赋值。prompt manifest 新条目由 `prompt-catalog.unit.test.ts:300-318` 校验摘要；出网登记由 `check-egress-redaction.mjs` 校验调用存在。阈值比较的输入来自 `parseDeliveryTiming` 的整数校验（`strict-configuration.ts:1578-1608`），没有别的使用端。
