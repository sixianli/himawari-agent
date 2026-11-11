# P4-5 代码复核结论

## 读代码证实的问题

### 1. 高 — 每周 0.5 美元不是真正的硬上限
**文件:行**：`packages/application/src/services/real-memory-eval.ts:284-291`、`packages/application/src/services/real-memory-eval-service.ts:161-173`、`264-265`、`apps/agent-service/src/production-real-eval.ts:123-135`、`46-49`、`224-227`

**问题**：`reserve` 只检查“预估”，`record` 直接把实际费用累加，既不校验也不在超过上限后停止；嵌入检索的费用在调用之后才 `record`，调用前完全没有 `reserve`；模型失败或未完成时直接抛错，报告里的 `costMicros` 根本不会进入预算。再加上 `once` 模式把 `failed` 当作未完成、每小时重试，每次重试都拥有独立的一轮上限，周累计费用可能超过 0.5 美元。

**证据**：
```ts
reserve(estimateMicros: number): void {
  if (this.#spentMicros + Math.max(0, estimateMicros) > this.#limitMicros)
    throw new RealEvalBudgetExceededError();
}
record(actualMicros: number): void {
  this.#spentMicros += Math.max(0, actualMicros);
}
```
```ts
budget.reserve(deps.model.estimateMicros(prompt, maxOutputTokens));
const result = await deps.model.generate({...});
budget.record(result.costMicros);
```
```ts
const recall = await deps.recall(questionText);
budget.record(recall.costMicros);
```
```ts
if (failure !== null) throw new RealEvalModelError(failure);
if (!completed) throw new RealEvalModelError("MODEL_NOT_COMPLETED");
return { output, costMicros };
```
```ts
if (mode === "once")
  return runs.some(({ trigger, outcome }) => trigger === "manual" && outcome !== "failed")
    ? null
    : "manual";
```

**建议**：嵌入调用前也 `reserve`；每次 `record` 后立即检查上限并停止；失败调用若已产生费用要记账；按“周”持久化累计费用，而不是每轮重新开始；`once` 失败重试要有次数/总费用上限。

---

### 2. 中 — 题干 payload 可能变成无主残留
**文件:行**：`packages/application/src/services/real-memory-eval-service.ts:231-249`、`packages/persistence-sqlite/src/sqlite-real-eval-operations.ts:118-143`

**问题**：先调用 `storeQuestion` 写入加密 payload，再调用 `addQuestion`。当 `addQuestion` 返回 `false`（记忆不属于该 owner、或同一 `memory_id + memory_revision + kind` 已存在）或抛错时，payload 已经写入，但没有任何行引用它。删除记忆时只会按 `real_eval_questions.question_ref` 清理，因此这类 payload 永远不会被治理删除，可能积累含记忆正文的密文。

**证据**：
```ts
questionRef: await deps.storeQuestion({ memory, kind, text: questionText, createdAt }),
...
if (await deps.store.addQuestion({ ...deps.scope, question })) {
  added += 1;
  ...
}
```
```ts
if (!owned) return false;
...
`INSERT INTO real_eval_questions (...) VALUES (...)
 ON CONFLICT (memory_id, memory_revision, kind) DO NOTHING`
```

**建议**：先插入题目行再写 payload，或把“建 payload + 插行”做成可回滚事务；`addQuestion` 返回 `false` 或抛错时删除刚写的 payload。对“同 revision/kind 已退役后重新可出题”的情况要显式处理，否则会反复生成、反复写 payload、反复花钱。

---

### 3. 中 — 泄题/敏感/无效题不记忆，declined 只保留 52 次运行：会反复出题、反复花钱
**文件:行**：`packages/application/src/services/real-memory-eval-service.ts:221-227`、`197-199`、`125-135`

**问题**：只有 `declined` 会写入 `summary.declined`；`leak`、`sensitive`、`question_invalid`、`kind_invalid` 等拒绝只计数，下次运行仍会重新为该记忆调用出题模型。并且 `declined` 只从最近 52 次运行读取，超过后同一版本会再次被问，与作者“拒绝过的同一版本记忆以后不再问”不一致。

**证据**：
```ts
if ("rejected" in generated) {
  rejected[generated.rejected] = (rejected[generated.rejected] ?? 0) + 1;
  if (generated.rejected === "declined")
    declined.push(declinedKey(memory.id, memory.revision));
  continue;
}
```
```ts
const skip = declinedFromRuns(
  await deps.store.listRuns({ ...deps.scope, limit: RECENT_RUNS_FOR_DECLINES }),
);
```

**建议**：把“该记忆版本不可出题/出题失败”持久化为题库状态，至少记录重试次数或永久 skip；对泄题/敏感输入也应避免无限重试；若确实要 52 次窗口，请在文档和作者说明中写明“不是永久”。

---

### 4. 中 — 固定面板无上限、旧题优先，可能饿死新题并反复触发上限
**文件:行**：`packages/application/src/services/real-memory-eval-service.ts:183-196`、`254`、`packages/persistence-sqlite/src/sqlite-real-eval-operations.ts:94-95`

**问题**：每次运行都会把所有未退役题放进 `pending` 并逐题作答/判分，题库没有总量上限，也没有按轮转或优先级裁剪。查询按 `created_at, id` 升序，预算耗尽时总是先跑最老的题；下一周仍然从同一批最老题开始，新题可能永远轮不到。长期看固定面板会随记忆数线性增长。

**证据**：
```ts
for (const question of await deps.store.listQuestions(deps.scope)) {
  if (question.retiredAt !== null) continue;
  ...
  else active.push(question);
}
const pending: PendingItem[] = active.map((question) => ({ question, panel: "fixed" }));
```
```sql
FROM real_eval_questions WHERE owner_id = ? AND agent_id = ?
ORDER BY created_at, id
```

**建议**：给固定面板设上限或轮转/抽样策略；预算不足时记录 `attempted/skipped`，并按新题优先或公平轮转；至少不要把“最老题永远优先”作为唯一顺序。

---

### 5. 中 — 抽查样本文件在删除记忆后不会清除
**文件:行**：`apps/agent-service/src/production-real-eval.ts:149-174`、`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:884-890`

**问题**：题干 payload 会被删除，但 `real-eval/latest-sample.json` 不在治理删除范围内。样本包含 `question/response/quote/memory`，虽然经过 egress 遮盖且文件权限为 0600/0700，但记忆删除或 owner 清理后文件仍可能保留真实内容。作者材料/ADR 也承认“不随记忆删除自动删除”。

**证据**：
```ts
const body = {
  ...
  items: report.sample.map((item) => ({
    ...
    question: maskForExport(item.question),
    response: maskForExport(item.response),
    quote: maskForExport(item.quote),
    memory: maskForExport(item.memory),
  })),
};
```
```ts
...this.#values(
  database,
  "SELECT question_ref FROM real_eval_questions WHERE memory_id = ?",
  [objectId],
),
```

**建议**：记忆/owner 删除时删除或重写样本文件；或只保留抽中且主人已确认的样本，并设过期时间；补一条删除后样本文件不残留的集成测试。

---

### 6. 中 — 泄题过滤挡不住短答案和汉字日期
**文件:行**：`packages/application/src/services/real-memory-eval.ts:21`、`87-98`

**问题**：`LEAK_NGRAM = 6`，数字只匹配 `\d{2,}`。因此“大阪”这类 2 字地点、“十二月三日”这类 5 字日期，以及短偏好值不会被判为泄题；题目可能在题干里直接给出答案，评测结果会偏高。现有测试只覆盖长句照抄和 4 位数字。

**证据**：
```ts
export const LEAK_NGRAM = 6;
```
```ts
function numbers(value: string): Set<string> {
  return new Set(value.normalize("NFKC").match(/\d{2,}/gu) ?? []);
}
```
```ts
export function leaksAnswer(question: string, sources: readonly string[]): boolean {
  const asked = ngrams(question, LEAK_NGRAM);
  const askedNumbers = numbers(question);
  ...
}
```

**建议**：对日期（阿拉伯数字和汉字日期）、数字、命名实体、短答案值单独做“答案值是否出现在题干”的检查；或对题干和答案做更细粒度的 token/实体重叠检查。补短地点、汉字日期、短偏好值的反向用例。

---

### 7. 低 — “运行结果表只存数字”说法不准确
**文件:行**：`packages/application/src/services/real-memory-eval-service.ts:320-340` 附近

**问题**：`summary` 中除分数/计数外，还存了 `declined`（`memoryId@revision` 字符串）、`failure` 错误名；`real_eval_runs.model` 也是字符串。没有记忆正文，测试也验证了摘要不含正文，但“只存数字”不是字面事实。

**建议**：把作者说明改成“只存计数、分数和标识，不含正文”；或把 `declined` 标识移出 summary，放入单独元数据。

---

### 8. 低 — 重复导出
**文件:行**：`packages/application/src/services/index.ts:42-45`

**问题**：`real-memory-eval` 和 `real-memory-eval-service` 各被 `export *` 了两次，属于无用重复，可能触发 lint/可维护性问题。

**证据**：
```ts
export * from "./real-memory-eval.js";
export * from "./real-memory-eval-service.js";
export * from "./real-memory-eval.js";
export * from "./real-memory-eval-service.js";
```

**建议**：删掉重复两行。

---

### 9. 低 — 自动检查存在，但关键反向用例缺失
**文件:行**：`packages/application/test/real-memory-eval.unit.test.ts:251-258`、`packages/application/test/real-memory-eval-service.unit.test.ts:319-324`、`test/integration/real-memory-eval.test.ts:297`

**问题**：已有预算、泄题、敏感值、退役、删除、导出、配置、固定前缀测试，但没有测“实际费用大于预估后是否仍不超过上限”、没有测嵌入费用是否预留、没有并发 tick 测试、没有 `createProductionRealEval` 生产适配器的集成测试，也没有样本文件删除后的测试。集成测试里的 recall 费用还是 `costMicros: 0`，无法验证嵌入计费。

**建议**：补上述反向用例；尤其要构造 actual > estimate、嵌入费用超过剩余额度、两个 tick 同时到达、删除记忆后样本文件不残留的用例。

---

## 推测 / 未核实

- **推测评测费用可能低估**：`proactiveCostEstimator` 用 `prompt.length`（UTF-16 字符数）当作 token 数，再乘最高输入单价；对“一个字符被分成多个 token”的语言/字符，实际输入费用可能大于预估。结合“实际费用没有上限校验”，单次调用有可能超过剩余额度，具体是否发生取决于模型分词和报价（未用真实模型验证）。
- **推测固定面板整段请求字节不稳定**：`profile.texts` 和 `recalled.memories` 没有显式排序，完整 prompt 的数据部分可能随档案/检索顺序变化。因为变化发生固定指令之后，不影响前缀缓存，但可能降低固定面板的缓存命中；检索并列排序是否稳定未核实。
- **未核实**：作者说 `production-model-composition.unit.test.ts` 18 条、`model-payload-cleanup.unit.test.ts` 8 条在基线同样失败；本次不能运行测试，无法确认。
- **未核实**：提示词 manifest 的 sha256 是否与实际 catalog digest 完全一致；仓库已有 `apps/agent-service/test/prompt-catalog.unit.test.ts` 会检查，但我没有独立重算。`promptSha256` 使用 `JSON.stringify(segments)`，与该测试的 digest 定义一致，因此不算代码不一致。
- **未核实**：迁移号 0088 合并前是否会按队列改名；当前仓库 0087 之后确实只有 0088，代码内一致。

---

## 侧重检查

- **错误路径**：`model.failed`、`MODEL_NOT_COMPLETED`、`OUTPUT_TOO_LARGE`、`judge_invalid`、`source_missing`、`decisions` 读取失败都处理了；但失败调用已产生的费用没有记账，`recordRun` 自身失败也不会再记录。
- **不合规范/不可信输入**：模型生成的题干做了长度、换行/尖括号/花括号/反引号、kind、泄题、敏感值校验；但泄题规则对短答案和汉字日期不够强。
- **安全/敏感信息**：记忆正文不进 `real_eval_runs.summary`，测试也验证了；错误只记名字；样本文件用 0600/0700 并遮盖敏感值，但删除记忆后不清理，且只按 egress 规则遮盖，不是更强的导出策略。
- **资源耗尽**：嵌入费用未预留；无主 payload 可能累积；固定面板无上限；leak/sensitive 记忆每周重复出题；“once”失败每小时重试。
- **不可撤销操作**：治理删除会级联删题并按 `question_ref` 删题干 payload，有集成测试覆盖；样本文件是遗漏点。
- **规则/文档一致性**：ADR 0219 与实现基本一致，且自己写明了样本文件不随删除清理；但“以后不再问”与 52 次窗口不符，“只存数字”与 `declined` 标识不符。
- **作者说法核对**：第 1、3、4、5 条基本属实；第 2 条大体属实，但“拒绝后不再问”只对 declined 且只保 52 次运行，失败调用费用也未计入；第 6 条未核实。预算部分与“硬上限”要求不符。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。** 本改动没有修改对话的系统提示、工具定义、历史消息或现有出口遮盖逻辑；`proactiveModel` 新增的 `purpose` 默认仍是 `mail-judgment`，既有调用不传 `purpose`，行为不变（`production-model-composition.ts:516`、`service-main.ts:1637-1640`）。新增的评测调用是独立的单轮后台请求，固定指令在前、本次数据在后；`answerPrompt` 中唯一每轮变化的时间 `now` 放在 JSON 最后一个键（`real-memory-eval.ts:172-180` 附近），符合第 15 条。新增评测提示词被加入 `TRUSTED_PROMPT_TEXTS`，只新增精确的固定文本，不删除或改写旧文本；理论上只有包含完全相同新固定文本的内容会受影响，现有冻结对话不会因此改字节。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
**对现有对话请求不会。** 新评测请求中固定指令字节稳定；数据部分有 `now` 和档案/检索列表，完整请求字节会随这些变化，但都位于固定前缀之后。档案和检索结果没有显式排序，所以同一固定面板题在两次运行中的完整 prompt 数据段可能不同；这只影响缓存后缀，不影响前缀。出口遮盖仍是确定性的，未发现依赖后文的跨请求遮盖变化。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？
**有，但不完整。** 已覆盖：固定指令/数据顺序和固定前缀、泄题、敏感值、退役、declined、预算拒绝、失败不记正文、决策分组、配置上限、导出不含题库、删除记忆清题和题干 payload。缺口：实际费用大于预估、嵌入费用是否被上限挡住、并发 tick、`addQuestion=false` 的 payload 残留、样本文件删除、`createProductionRealEval` 生产接线。因此“反向用例真的会失败”只对已覆盖场景成立，预算和资源耗尽两个关键场景没有真正失败的反向用例。

### 4. 每个新值两端是否都能接受？
大体一致：配置键 `realEval` 的解析、消费和启动校验一致；`mode/outcome/trigger/kind/retireReason` 与数据库 CHECK 一致；`question_model`/`model` 长度上限 256 与 `safeReference` 一致；summary 的分数结构能被 `real-eval-report.mjs` 读取；导出清单、schema-catalog、迁移序号、端口导出和删除查询两端都能对上。
不一致/需修正的点：作者“运行结果表只存数字”不准确（含 `declined` 标识和错误名）；“拒绝后不再问”只保 52 次运行；`services/index.ts` 有重复导出。未发现清单 id 无法通过后端校验的 I-73 类问题，但 `newId` 生成的实际 ID 长度上限仍未核实。
