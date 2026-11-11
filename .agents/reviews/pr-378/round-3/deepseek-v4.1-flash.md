## 一、侧重检查

- **错误路径**：模型失败/检索失败按预估记账（`real-memory-eval-service.ts:180-183, 299-302`）；但“样本写失败”“`recordRun` 失败”“模型返回无效费用”“`judge_invalid` 长期不退役”这几条仍有缺口，见下。
- **不合规范/不可信输入**：模型题干有长度、JSON 结构、6 字重合、数字、日期时刻、敏感值检查（`real-memory-eval.ts:207-231`）；`7:00` 已能识别。但 `realEval.modelRef` 的启动校验只要求接受 `private`，而评测实际可能发送 `sensitive`（见问题 5）。
- **安全/隐私**：运行 `summary` 只放分数、计数、`memoryId@revision` 和错误名，未见正文（`real-memory-eval-service.ts:378-404`）。但抽查样本文件会写入 `question/response/quote/memory`，只做出口遮盖（`production-real-eval.ts:183-199`、`production-gap-export.ts:89-91`）；且向量检索请求可能被错误标成 `private`（见问题 1）。
- **资源耗尽**：固定面板没有上限或轮换，题库会随记忆数量持续增长，最终每周都只能答一部分；退役题的题干 payload 永不清理；`judge_invalid`/`unanswerable` 题会反复重试（见问题 3、6、10）。
- **不可撤销操作**：退役题现在保留 payload（`real-memory-eval-service.ts:194-205`），只有永久删除记忆时才由治理删除连带清理（`sqlite-governed-deletion.ts:884-890`）；预算一旦花出无法回滚。
- **文档一致性**：作者说“最近 52 次运行”，代码是 520（`real-memory-eval-service.ts:108`）；ADR 说“题被丢弃/写入失败后同一版本不再问”，`response_invalid` 和 `addQuestion` 抛错路径并不记入 `declined`；schema 目录说题干 payload 会随 Owner/Agent 删除清掉，但 `payloads` 对 Owner/Agent 是 `ON DELETE RESTRICT`（`0001_initial_product_schema.sql:59-60`）。

## 二、读代码证实的问题（按严重度）

### 1. 高：检索向量请求把题目一律按 `private` 发送，绕过了题目的真实分类

- 文件:行：`apps/agent-service/src/production-real-eval.ts:297-303, 363-376`；`apps/agent-service/src/production-run-memory.ts:68-72, 122-126, 131-141`。
- 问题：题目 payload 是按 `memory.dataClassification` 存的（`production-real-eval.ts:322-333`），但作答前检索只把 `questionText` 传给 `recall`，`timeout()` 创建的上下文没有 `dataClassification`。`embedForMailCheck` 的 mail 分支固定回退到 `"private"`，于是 `sensitive` 记忆生成的题目会被当成 `private` 送进向量模型。
- 证据：

```ts
// production-run-memory.ts:122-126
const classification =
  context?.dataClassification ??
  projection?.memory.dataClassification ??
  (mail ? ("private" as const) : undefined);
```

```ts
// production-real-eval.ts:297-303
const timeout = () => ({
  deadlineAt: ...,
  signal: AbortSignal.timeout(deps.configuration.requestTimeoutMs),
  costMicros: 0,
});
```

```ts
// production-real-eval.ts:363-376
const context = timeout();
const found = await deps.embed(context, () =>
  deps.memory.search({ ...scope, queryRef: "", queryText: question, ... }),
);
```

- 影响：如果部署的 embedding 模型只允许 `private`，这个检查会被“标成 private”绕过，`sensitive` 内容被送到未获准的模型；这是分类降级，不只是费用问题。
- 建议：`RealEvalRecall`/`recall` 增加分类参数，由服务端把 `memory.dataClassification` 或 `question` 的存储分类传下来；`MailEmbeddingContext` 增加可选 `dataClassification`；检索前用真实分类检查 `descriptor.allowedDataClassifications`。

### 2. 高：模型返回缺失或非整数 `costMicros` 时按 0 记账，费用上限会被低算

- 文件:行：`apps/agent-service/src/production-real-eval.ts:149-151`。
- 问题：`Number.isSafeInteger(event.costMicros)` 为假时（缺失、`NaN`、小数、超出安全整数）直接把实际费用当 0。这一笔真实花费不会进入本次 `budget`，也不会进入后续 7 天累计。
- 证据：

```ts
if (event.type === "model.completed") {
  costMicros = Number.isSafeInteger(event.costMicros) ? Math.max(0, event.costMicros) : 0;
```

- 影响：网关若返回 `37.5` 或没有 `costMicros`，实际已扣费而评测记 0，硬上限失效。
- 建议：无效费用应抛出 `RealEvalModelError("COST_INVALID")` 或返回 `undefined`，由服务层按预估 `absorb`；不要静默记为 0。

### 3. 中高：7 天 0.5 美元不是严格硬上限，单次调用可以突破剩余额度

- 文件:行：`packages/application/src/services/real-memory-eval.ts:338-354`；`apps/agent-service/src/production-real-eval.ts:105-106`；`apps/agent-service/src/production-proactive.ts:67-71`。
- 问题：`reserve` 只比较“预估”，真正的 `record(actual)` 在实际调用完成后才加入；实际费用超过剩余额度时只能事后抛 `RealEvalBudgetExceededError`。并且输入预估用 `prompt.length` 当 token 数，对某些文字可能低估 token；所以单次调用可以超过上限。
- 证据：

```ts
reserve(estimateMicros: number): void {
  if (this.#spentMicros + Math.max(0, estimateMicros) > this.#limitMicros)
    throw new RealEvalBudgetExceededError();
}
record(actualMicros: number): void {
  this.#spentMicros += Math.max(0, actualMicros);
  if (this.#spentMicros > this.#limitMicros) throw new RealEvalBudgetExceededError();
}
```

```ts
return (prompt) =>
  Math.ceil(
    prompt.length * Math.max(cost.input, cost.cacheRead, cost.cacheWrite) +
      maxOutputTokens * cost.output,
  );
```

测试也明确允许超出：

```ts
// production-real-eval-service.unit.test.ts:426-437
const report = await test.service.run("weekly", { capMicros: 500, ... });
expect(report.costMicros).toBe(2 * 100 + 10 + 1_000); // 1210 > 500
```

- 影响：ADR 说“最多超出一次调用的预估误差”，但实际可能是一次完整调用；如果预估严重偏低（或问题 2 的 0 记账），累计会明显超过 0.5 美元。
- 建议：要么把“硬上限”改成“预检 + 单次调用最大可能费用”的保守上界（例如按 tokenizer 上界计算并预留），要么明确这是软上限；对单次调用可设置最大 `maxOutputTokens`/输入长度，使最坏费用不超过剩余额度。

### 4. 中：`once` 的样本写失败或样本过期后不会重跑

- 文件:行：`apps/agent-service/src/production-real-eval.ts:245-261`；`packages/application/src/services/real-memory-eval-service.ts:392-404`；`apps/agent-service/src/production-real-eval.ts:61-64`。
- 问题：`service.run` 先把本次运行记成 `completed`，`#tick` 之后才写 `latest-sample.json`。如果 `writeRealEvalSample`（磁盘满、权限、`maskForExport` 抛错）失败，运行已经是 `manual + completed`，`dueRealEvalTrigger("once", ...)` 以后都返回 null，主人永远拿不到样本；7 天后样本即使存在也会被 `expireRealEvalSample` 删掉，而 `once` 不会重新生成。
- 证据：

```ts
// production-real-eval.ts:254-260
const report = await service.run(trigger, { ... });
if (trigger === "manual") await writeRealEvalSample(this.#options.sampleDirectory, report);
this.#options.onRun?.(report, trigger);
```

```ts
// production-real-eval.ts:61-64
if (mode === "once")
  return runs.some(({ trigger, outcome }) => trigger === "manual" && outcome !== "failed")
    ? null
    : "manual";
```

- 建议：把样本写入放进运行结果落库之前，或把样本写入失败记成可重试状态；`once` 的“完成”条件应检查样本是否确实存在。

### 5. 中：`realEval.modelRef` 启动校验只要求 `private`，评测实际会发 `sensitive`

- 文件:行：`packages/platform-node/src/strict-configuration.ts:1476-1487`；`packages/application/src/services/real-memory-eval.ts:29-42`；`packages/application/src/services/model-visibility.ts:10-14`；`apps/agent-service/src/production-model-composition.ts:529-531`。
- 问题：`eligibleForQuestions` 只排除 `restricted`，`sensitive` 是允许出题的；`OwnerProfileService.compose` 的 ceiling 也是 `sensitive`，作答分类取最高值（`real-memory-eval-service.ts:308-311`）。但启动时只校验 `allowedDataClassifications.includes("private")`，没有校验 `"sensitive"`。如果选了只接受 `private` 的模型，第一次遇到敏感记忆/敏感档案时 `proactiveModel.prepare` 会抛 `PROACTIVE_MODEL_DISCLOSURE_DENIED`，整轮 `failed`，而且按预估计费。
- 证据：

```ts
if (
  !descriptor ||
  descriptor.role === "embedding" ||
  !descriptor.allowedDataClassifications.includes("private")
)
  throw invalid(..., "must name a configured generation model that accepts private data");
```

```ts
// production-model-composition.ts:530-531
if (!descriptor.allowedDataClassifications.includes(dataClassification))
  throw new Error("PROACTIVE_MODEL_DISCLOSURE_DENIED");
```

- 建议：启动时要求 `allowedDataClassifications` 覆盖 `modelVisibleClassifications()`（至少含 `sensitive`），或在评测侧按模型允许的分类过滤记忆/档案；同时校验 `api === "openai-completions"`，否则第一轮才会失败。

### 6. 中：固定面板没有上限/轮换，题库增长后每周都会预算不足且分数有偏

- 文件:行：`packages/application/src/services/real-memory-eval-service.ts:207-281, 284-357`；`apps/agent-service/src/production-real-eval.ts:252-258`。
- 问题：`planned = active.length`，所有未退役题都进入 `pending`，然后从头到尾逐题回答；`newMemoriesPerRun` 只限制“新题”。记忆越多，active 题库越大，每轮要答的题越多，最终在预算上限处提前停止。由于先答 fresh、再按 `created_at,id` 答 fixed，预算不足时靠后的固定题永远得不到分数，`budget_exceeded` 还会被 weekly 当成“已有非失败运行”而等 7 天。
- 证据：

```ts
pending.push(...active.map((question) => ({ question, panel: "fixed" as const })));
...
for (const { question, panel } of pending) {
```

- 建议：给固定面板增加每轮抽样/轮换上限（类似 `newMemoriesPerRun` 的 `fixedPanelPerRun`），或按记忆 id 轮转；把“本轮覆盖了哪些面板题”记入 summary，避免预算不足时产生系统性偏差。

### 7. 中：抽查样本是明文 JSON，且包含记忆正文/原话的出口遮盖版本

- 文件:行：`apps/agent-service/src/production-real-eval.ts:183-199`；`apps/agent-service/src/production-gap-export.ts:89-91`；ADR `docs/adr/0219-real-memory-eval-sets.md:90`。
- 问题：样本文件确实只做了 `maskForExport`（即 `redactForEgress(text).text`），它不会删掉普通记忆正文、原话、人名地名；样例测试也只验证银行卡号被遮。因此 `latest-sample.json` 会包含真实记忆内容的明文（0600 权限），并在记忆删除后最多保留 7 天（评测关着且服务不重启时更久）。这不是“运行结果表不含正文”的问题，而是抽查样本的独立隐私面。
- 证据：

```ts
items: report.sample.map((item) => ({
  panel: item.panel,
  kind: item.kind,
  verdict: item.verdict,
  question: maskForExport(item.question),
  response: maskForExport(item.response),
  quote: maskForExport(item.quote),
  memory: maskForExport(item.memory),
})),
```

- 建议：如果约束是“真实内容不得落到磁盘明文”，样本应使用 payload protector 加密，或只保留 `question/response/verdict` 不保留 `quote/memory`；至少在永久删除记忆时同步删除/清理样本文件，而不是只靠 TTL。

### 8. 中：跨进程没有互斥，两个服务进程会各跑一次并各算一份预算

- 文件:行：`apps/agent-service/src/production-real-eval.ts:214-243`；ADR `docs/adr/0219-real-memory-eval-sets.md:90`。
- 问题：`#running` 只能阻止同一进程内的重叠 tick；由于唯一性/租约在数据库里没有实现，两个进程共用同一个 SQLite 时会各自读到“最近没有运行”，然后各跑一次，费用上限按各自读到的已花费用计算，可能双倍花费。
- 证据：

```ts
tick(): Promise<void> {
  this.#running ??= this.#tick()
    .catch(...)
    .finally(() => { this.#running = undefined; });
  return this.#running;
}
```

- 建议：在数据库中加运行租约/唯一触发记录（例如 `real_eval_runs` 的唯一 claim 或状态表），或用现有的 state-root lock 保证单例；至少要在启动时明确拒绝多进程。

### 9. 低：`once` 和 `weekly` 都把 `budget_exceeded` 当成“非失败/已完成”

- 文件:行：`apps/agent-service/src/production-real-eval.ts:54-70`。
- 问题：`once` 的判断是 `outcome !== "failed"`，所以一次 `budget_exceeded` 的手动运行以后不再重试；`weekly` 也把 `budget_exceeded` 当作最近 7 天的成功运行，即使它没答完。预算因滚动窗口恢复后，`once` 仍不会自动补跑（除非人工清运行记录）。
- 建议：明确 `budget_exceeded` 的语义；如果它是“未完成”，应允许按 24 小时/预算恢复后重试；如果故意终止，应在 ADR 和主人操作说明里写清楚。

### 10. 低：`judge_invalid` 和 `unanswerable` 题会长期重试并反复花钱

- 文件:行：`packages/application/src/services/real-memory-eval-service.ts:289-291, 332-335`。
- 问题：判分输出非法时只增加 `rejected["judge_invalid"]` 并 `continue`，题目保持 active，不退役也不记入 `declined`；下次运行会再次作答并再次判分。若模型持续输出非法判分，这题每周都消耗作答/判分费用。`unanswerable` 题同样保持 active，虽然不花模型钱，但每轮都重复。
- 建议：对连续 `judge_invalid` 达到阈值的题做退役/标记跳过；或把“本题本轮判分失败”写进运行时状态，避免永久重试。

### 11. 低：作者说法与代码/文档不一致

- 文件:行：`packages/application/src/services/real-memory-eval-service.ts:108, 210`；ADR `docs/adr/0219-real-memory-eval-sets.md:54`；`packages/persistence-sqlite/src/schema-catalog.ts:839`；`packages/prompt-catalog/src/eval.ts:13` 对比 `packages/application/src/services/real-memory-eval.ts:24`。
- 具体：
  - 作者说“从最近 52 次运行的 summary.declined 读”，代码 `RECENT_RUNS_FOR_DECLINES = 520`，`listRuns` 也传 520；52 是 `real-eval-report.mjs` 的默认显示行数。
  - ADR 说“模型说这条记忆出不了题，或者题被丢弃时，同一版本以后不再问”，但 `response_invalid` 明确不加入 `declined`（`real-memory-eval-service.ts:234-238`），下一轮还会问。
  - ADR 说“题库没收下的题（重复或写入失败）……这个记忆版本以后也不再出题”，但 `addQuestion` **抛错**时只走 `finally` 删 payload，随后异常冒泡到外层 `failed`，不会把 key 写进 `declined`；只有返回 false 才写（`real-memory-eval-service.ts:261-271`）。
  - `schema-catalog.ts:839` 说题干 payload“removed ... with Owner or Agent deletion”，但 `payloads.owner_id/agent_id` 是 `ON DELETE RESTRICT`（`0001_initial_product_schema.sql:59-60`），没有找到 Owner/Agent 删除时自动清理 payload 的代码路径。
  - 出题提示词写“最多 60 个字”，代码允许 120 个字符（`QUESTION_MAX_CHARACTERS = 120`）。
  - `real-eval-report.mjs` 只渲染分数，不显示 `summary.decisions`；决策计数虽然存了，但主人从报告里看不到。

## 三、推测与未核实

- 作者第 6 条“与本改动无关的失败”**未核实**：当前环境不能运行测试。`production-model-composition.ts` 本次确实有 `purpose` 改动，相关测试文件未改；需要实际跑一次确认失败与 `purpose` 无关。
- 迁移号 88 是否与 main 队列冲突**未核实**：没有读迁移队列/分支状态。
- `recordRun` 失败或进程在记录运行前崩溃时，已花的费用不会进入 7 天累计，下一次 tick 也可能再次运行；这是基于代码结构的推测，未见对应测试。
- `addQuestion` 只校验 `memoryId` 属于当前 owner/agent，没有校验 `questionRef` 对应的 payload 也属于当前 owner/agent；目前调用方是内部服务，跨租户风险低，但端口层没有双向校验。
- `readQuote` 只返回文本，不返回 quote 的 classification；如果原话分类高于记忆，出题调用可能按较低分类发送。这个风险取决于数据写入约定，未能从本次代码确认。
- `profile`/`recalled` 列表没有显式排序；`DurableMemoryService.search` 按 score 和 id 排序，profile 顺序取决于 `OwnerProfileService.compose`，没有进一步核实其确定性。

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会改变已有会话的请求头。** 评测是独立的单次后台调用，不走对话历史，不修改系统提示、工具定义或历史消息。每次调用的结构都是“提示词目录里的固定指令 + 末尾追加的 JSON 数据”：
- `questionPrompt`：固定 `REAL_EVAL_QUESTION.text`，后面 JSON；
- `answerPrompt`：固定 `REAL_EVAL_ANSWER.text`，后面 JSON，`now` 是 JSON 的最后一个键；
- `judgePrompt`：固定 `REAL_EVAL_JUDGE.text`，后面 JSON。

因此“只追加”在评测调用内部成立，每轮会变的 `now`、记忆、问题都在最后的数据段。唯一需要留意的是 `trusted.ts` 把新评测提示词加入了 `TRUSTED_PROMPT_TEXTS`；理论上这会改变出口遮盖对“固定文字”的识别，但新加的文字是评测专用、且不含敏感值，未发现会改变旧会话开头字节的证据。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

- `answerPrompt` 包含 `now`，所以同一段记忆/问题在不同运行会产生不同字节；但这是设计允许的“最后的数据段”，且每个请求是新的，不构成对已发前缀的改写。
- `questionPrompt`、`judgePrompt` 在相同输入和相同 `JSON.stringify` 键顺序下是确定的；未发现依赖前后文的遮盖。
- 抽查样本的 `maskForExport` 只取决于该段文本本身（`redactForEgress(text)`），不依赖上下文，因此同一文本的遮盖是确定的。
- `profile`/`memories` 数组顺序未显式排序；搜索路径本身按 `score`、`id` 排序，但 profile 的顺序来自 compose。它们都在可变数据段，不会影响固定前缀；若要严格满足“列表顺序固定”，建议显式排序。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有，覆盖面比较广：
- `apps/agent-service/test/production-real-eval.unit.test.ts`：off 不跑、once/weekly 触发、7 天累计、24 小时重试、样本过期、样本遮盖与 0600、模型失败、重叠 tick 只启动一次、预算超出。
- `packages/application/test/real-memory-eval-service.unit.test.ts`：空预算后不检索、超出实际费用立即停、失败调用按预估记账、`declined` 不重复出题、`response_invalid` 会重试、退役/新增题、丢弃未入库题干。
- `packages/application/test/real-memory-eval.unit.test.ts`：泄题（含 `7:00`/`7:30`）、敏感值、非法 kind/JSON、预算、日期归一化。
- `packages/persistence-sqlite/test/real-eval.contract.test.ts`、`test/integration/sqlite-governed-deletion.test.ts`、`test/integration/data-export.test.ts`：唯一约束、非法输入、迁移、删除记忆连带删题和 payload、导出不含题库。
- `packages/platform-node/test/startup-configuration.unit.test.ts`：cap 500001、0、未知 key 等反向用例。

从测试代码看，这些反向用例设计上会失败；但**本次环境不能运行测试**，所以“真的会失败”只能算读代码确认，运行结果**未核实**。另外以下路径没有对应测试：样本写失败后的 `once`、模型返回无效 `costMicros`、向量检索分类降级、固定面板增长、`judge_invalid` 重复、跨进程并发。

### 4. 改动产生/修改的每个值，两端都能接受吗？

| 值 | 产生端 | 使用端/校验 | 结论 |
|---|---|---|---|
| `weeklyCapMicros` | `strict-configuration.ts`，1..500000 整数 | `ProductionRealEval` 算 remaining，`RealEvalBudget` 要求安全整数 >0 | 两端一致 |
| `modelRef` | 配置 `safeReference` | `strict-configuration` 只查非 embedding + 接受 private；`proactiveModel` 还要求 `api === "openai-completions"` 且按实际分类检查 | **不一致**：启动可通过，首个敏感/非 openai-completions 调用失败 |
| `recallEstimateMicros` | 全局 embedding descriptor 的 `estimatedCostMicros` | `RealEvalBudget.reserve` | 整数一致；但检索请求分类被降级 |
| `memoryId` / `memoryRevision` / `kind` | `ProductMemoryRecord` | `retireReason`、`pickNewMemories`、`real_eval_questions` 的 FK/CHECK、`declinedKey` | 一致 |
| `questionRef` | `storeQuestion` 生成 `real-eval-question:<id>` | `real_eval_questions.question_ref` FK、`readQuestion`、`discardQuestion` | 一致；但 `addQuestion` 未校验 payload 的 owner/agent |
| `promptSha256` | 配置计算 | DB 检查 64 位 hex | 一致 |
| `createdAt` / `retiredAt` | clock ISO | DB GLOB + `retired_at/reason` 一致性 | 一致 |
| `outcome` / `trigger` | 服务常量 | DB CHECK 枚举 | 一致 |
| `costMicros` | 模型 `model.completed` / recall | `RealEvalBudget`、DB INTEGER 0..MAX_SAFE | **不一致**：无效模型费用被转成 0，实际花费丢失 |
| `summary` | 服务组装 | DB `json_valid + object`；报告脚本只读 `scores/items/...` | DB 接受；决策字段无人展示，报告端未消费 |
| `declined` key | 服务 `memoryId@revision` | `declinedFromRuns` 读最近 520 次 | 格式一致；作者说法 52 与代码 520 不一致 |
| `purpose: "other"` | 评测调用 | `ModelUsagePurpose` 枚举 | 一致 |
| 导出清单“未导出”项 | `export.ts` | 导出 manifest schema/test | 一致 |

总体结论：**类型和大部分数据库校验两端是对得上的，主要不一致在 `modelRef` 的分类/API 校验、`costMicros` 无效值处理、以及若干文档声明。**
