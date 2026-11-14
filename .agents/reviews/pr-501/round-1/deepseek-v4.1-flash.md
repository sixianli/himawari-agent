范围说明：`0f72a6c3` 不是 `3eb34bff` 的父提交（head 的父提交是 `f74b149c`，`0f72a6c3` 是另一条合并提交）。因此 `git diff 0f72a6c3..3eb34bff` 还混入了另一条分支上的删除（如 ADR 0270、review 产物、脚本），不能都算到这次修复头上。下面按 head 提交 `3eb34bff5` 本身复核。未运行测试，除标注「推测」外均为读代码得出的结论。

### 1. 中：永久被跳过的题目每次预评运行都会重新 build/读取原文，且每次运行都写日志
文件:行：`packages/application/src/services/review-prereview.ts:228`、`apps/agent-service/src/production-proactive.ts:270`、`apps/agent-service/src/production-proactive.ts:354`、`packages/application/src/services/daily-review.ts:25`

问题：跳过路径既不记 done 也不记 failure，所以不会进入 `failedRecently` 或 `#storeFailedAt` 的 24 小时退避。每次定时 tick 都会重新遍历待评队列，对每个被跳过的题目执行 `source.build()`（可能读取并解密记忆原文）；如果模型长期不允许 sensitive，这些题目会永远留在待评队列里，每次 tick 重做一遍，并且因为 `skippedClassification > 0` 每次都写一条 `proactive.prereviewed`。待评池上限是 500，`perRun` 最多 50，跳过项不受 `perRun` 约束，因此一次运行最多可 build 500 条。

证据（读代码证实）：
```ts
// review-prereview.ts:228-237
for (const { source, ref } of pending) {
  if (attempted >= settings.perRun) break;
  ...
  const subject = await source.build().catch(() => undefined);
  if (subject === undefined) continue;
  if (!this.#options.model.allowedDataClassifications.includes(subject.dataClassification)) {
    skippedClassification += 1;
    continue;
  }
```
```ts
// production-proactive.ts:270
this.#timer = setInterval(() => void this.tick(), ...intervalMs);
// production-proactive.ts:354
.then(async () => { await this.prereview(); })
```
```ts
// daily-review.ts:25
export const DAILY_REVIEW_POOL_LIMIT = 500;
```
旧行为在失败时会 `recordFailure`，随后由 `failedRecently` 过滤 24 小时（`review-prereview.ts:200-209`、`266-269`），因此旧代码是每条每天最多尝试一次，新代码则每个 tick 都重读。

推测：生产实际 tick 间隔、敏感题目数量决定开销大小；这里只确认了机制上的重复读取和日志增长。

建议：增加一个只在内存里的跳过退避表（仿 `#storeFailedAt`，但只记 `subject.key -> at`，不写表），因为 `allowedDataClassifications` 在进程生命周期内不会变，重启自然清空；或者缓存分类结果、限制每轮检查的跳过条数。日志也宜按“跳过集合有变化”或按时间限频，避免长期每 tick 一条。

### 2. 低：新增测试没有覆盖每日 attempts 被跳过占用，也没有证明提示/费用在跳过前未组装；反向用例在旧代码上失败只因缺字段
文件:行：`test/integration/review-prereview-production.test.ts:375`、`test/integration/review-prereview-production.test.ts:406`、`test/integration/review-prereview-production.test.ts:112`、`packages/application/src/services/review-prereview.ts:43`

问题：新用例只有 3 个题目，而默认 `perRun: 10`、`dailyLimit: 50`（`review-prereview.ts:43-45`）。如果实现只在跳过时增加 `attempts`（每日次数）而不增加 `attempted`，结果对象仍会显示 `attempted: 1`，现有断言照样通过；没有用 `perRun=1` 或 `dailyLimit=1` 的边界来证明“不占名额/不计每日次数”。同时 `estimateCostMicros` 是常量桩（测试第 221 行），也没有对 `prereviewPrompt`/费用估算的调用做记录，所以“在组装提示、算费用之前跳过”这一点没有被验证。反向用例在旧代码上失败，是因为旧返回值没有 `skippedClassification` 字段，而不是因为旧代码会跳过允许的题目；旧代码的 `attempted: 2, recorded: 2` 与反向用例的行为断言一致。

证据（读代码证实）：
```ts
// test:112-115
const allowed: DataClassification[] = ["public", "private", "sensitive", "restricted"];
const model: ProactiveModelInvoker = {
  modelRef: MODEL_REF,
  allowedDataClassifications: allowed,
```
```ts
// test:395
h.allowed.push("sensitive");
```
```ts
// review-prereview.ts:229-242
if (attempted >= settings.perRun) break;
if (attempts >= settings.dailyLimit) return ...;
...
attempted += 1;
attempts += 1;
```
另外，测试直接原地修改 `allowed` 数组来“放开级别”，但生产代码是 `Object.freeze([...descriptor.allowedDataClassifications])`（`production-model-composition.ts:530`），生产里必须换配置并重启才能生效；测试没有模拟这个冻结快照/重启语义。

建议：新增 `perRun: 1`、`dailyLimit: 1`，让跳过项排在允许项之前，断言允许项仍被评且 `stoppedBy` 不是 `daily_limit`；用可记录的 `estimateCostMicros` 或包装 `prereviewPrompt` 证明跳过项没有组装提示/算费用；把 fake 的 allowed 做成冻结数组，换新 invoker 模拟重启后再跑第二轮。反向用例可再断言“允许项确实各自产生了一次 prepare/调用”，使其在旧代码上因行为而失败，而不只是缺字段。

### 3. 低：跳过行为与 ADR 0237 的描述不一致，本次提交没有更新文档
文件:行：`docs/adr/0237-model-pre-rates-waiting-decisions.md:49`、`docs/adr/0237-model-pre-rates-waiting-decisions.md:50`、`docs/adr/0237-model-pre-rates-waiting-decisions.md:51`

问题：ADR 写的是“失败的调用也存一行（status=failed）”“文字看不到（受限内容、没有原文）的条目不预评”“失败的条目 24 小时内不再试”。现在多出第三类：模型不允许其数据级别的条目不预评、不写 failed 行、也不进入 24 小时退避，而是每个 tick 重试。文档没有说明这一类，和代码行为不一致。

证据（读代码证实）：
```md
// docs/adr/0237...md:49
失败的调用也存一行（`status = failed`），带费用。
// docs/adr/0237...md:50
文字看不到（受限内容、没有原文）的条目不预评。
// docs/adr/0237...md:51
失败的条目 24 小时内不再试。
```
本次提交 `git show --stat 3eb34bff` 只改了 9 个代码/测试文件，没有文档。

建议：在 ADR 0237 的“决定/后果”或新增 ADR 中补一句“预评模型不允许的级别不预评、不落失败行、不占次数，放开后下轮再评”，并同步 `docs/engineering-casebook.md` 中相关内容。

### 4. 低：两个 real-eval 测试替身仍缺必填的 `allowedDataClassifications`，靠 `as unknown as` 绕过类型检查
文件:行：`apps/agent-service/test/production-real-eval.unit.test.ts:168`、`apps/agent-service/test/production-real-eval.unit.test.ts:298`

问题：作者说“其余实现（测试替身）已补”，但这里两个对象字面量没有新字段，并且用 `as unknown as ProactiveModelInvoker` 强行通过编译。目前 `createRealEvalModel` 只调用 `prepare/model`（`production-real-eval.ts:313-318`），不会读这个字段，所以没有现实运行影响；但一旦这些替身被传给 `ReviewPrereviewService.run`，`allowedDataClassifications.includes` 会抛 `TypeError`，并导致整轮预评失败。

证据（读代码证实）：
```ts
// production-real-eval.unit.test.ts:170-194
return {
  modelRef: "eval-model",
  model: { ... },
  async prepare(...) { ... },
  readOutput: ...,
  release: ...,
} as unknown as ProactiveModelInvoker;
```
```ts
// production-real-eval.unit.test.ts:298-306
const failing = { ...base, prepare: ... } as unknown as ProactiveModelInvoker;
```
建议：给这两个替身补上字段，或抽一个返回完整 `ProactiveModelInvoker` 的 helper，并去掉 `as unknown as`；这样接口新增必填字段时编译器能真正拦住。

## 侧重检查

- **错误路径**：`source.build()` 抛错或返回 `undefined` 的分支未变；`disabled`、顶层 `daily_limit`、循环内 `daily_limit`、`daily_cost`、`done` 五个返回路径都已带上 `skippedClassification`（`review-prereview.ts:167-186,231,240,296`）。没有新增会写库的失败路径。
- **不合规范/不可信输入**：跳过判断的输入是本地记忆元数据里的 `subject.dataClassification` 和配置里的 `allowedDataClassifications`，只做 `includes`，不拼接、不序列化到提示里；`prepare` 仍用同一 descriptor 再检查一次（`production-model-composition.ts:532`），兜底还在。未发现新的注入或越权路径。
- **安全/外发**：被跳过的题目不会进入 `prereviewPrompt`、`prepare` 或模型调用；测试也断言提示中没有敏感文字（测试第 391-393 行）。未发现新的外发面。
- **资源耗尽**：见意见 1；这是本次复核最实质的风险。
- **不可撤销操作**：跳过不写 `decision_prereviews`、不改表、不做迁移；没有不可撤销写入。
- **规则/文档一致性**：见意见 3；未发现 prompt-prefix 规则或提示词目录被改动。
- **值的两端**：`allowedDataClassifications` 的产生处（`production-model-composition.ts:530`）和使用处（`review-prereview.ts:234`）来自同一个 descriptor，语义一致；`skippedClassification` 只在 `PrereviewRunResult`、service-main 日志和测试中使用，日志写入函数接受 `number`（`service-runtime.ts:81-87`），没有持久化或外部 schema 需要同步。生产路径没有发现未更新的 `ProactiveModelInvoker` 生产者；仅 real-eval 测试替身见意见 4。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。`prereviewPrompt` 没有改（`review-prereview.ts:64-76`），仍是固定目录文字在前、本条数据的 JSON 在最后；跳过只决定“这一条不发”，不会改已发请求的字节。系统提示、工具定义、历史、遮盖规则都没动，新增的 `allowedDataClassifications` 也不会进入提示。允许发送的题目提示字节和改动前相同；只是原来会被拒绝的条目现在不再产生请求。每轮会变的仍是最后一行里的 `group/options/category/text`。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会。提示组装和 `maskSensitiveText` 未变，没有新增时间、随机数或无序集合；`allowedDataClassifications` 只用于成员判断，不参与序列化。`skippedClassification` 只是计数，也不进提示。唯一“会变”的是测试里直接改数组，那不是生产路径（生产是冻结快照）。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有两条集成测试（`review-prereview-production.test.ts:375-415`），会随 integration 项目在 CI 跑。按旧代码逻辑读：正向用例会因 `attempted` 由 1 变 3、且缺少 `skippedClassification` 而失败；反向用例也会失败，但主要因为旧结果没有 `skippedClassification: 0` 这个字段，其 `attempted: 2, recorded: 2` 断言旧代码也会通过。因此反向用例对新实现的“过度跳过”有保护，但不能单独证明旧行为有错。缺口见意见 2。

4. **每个新值两端都能接受吗？**
   - `allowedDataClassifications`：生产由 `production-model-composition.ts:530` 从 descriptor 复制并冻结；`review-prereview.ts:234` 使用 `includes`；`prepare` 在 `production-model-composition.ts:532` 用同一个 descriptor 做同样的 `includes` 检查，启动校验在 `strict-configuration.ts:1877` 只要求 `private`。两端一致，类型和语义都能接受。测试替身除意见 4 外都已补。
   - `skippedClassification`：所有返回路径都产生该字段；唯一生产使用处是 `service-main.ts:2142-2156` 的 `writeServiceDiagnostic`，其签名接受 `number`；无表、无序列化协议、无外部 schema。可以接受。
   - `PrereviewRunResult` 新增必填字段：仓库内构造处只有 `ReviewPrereviewService.run`，已全部补齐；消费处用 `toMatchObject`，多字段不会破坏旧断言；`production-proactive.ts:374-379` 只透传结果。可以接受。
   - 日志事件 `proactive.prereviewed` 新增 `skippedClassification`：`writeServiceDiagnostic` 会把整个对象 JSON 序列化并做 `redactMachineSecrets`（`service-runtime.ts:81-87`），数字字段可接受；仓库内没有找到固定字段 schema 或日志解析器会拒绝它。
   - 本次没有新增标识、配置键、清单项、迁移或序列化格式，因此没有 I-73 那类“id 过不了另一端校验”的问题。
