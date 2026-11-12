## 结论摘要

对照 `a857cd40..fe92cf20` 和最后一轮 `fc2842aa..fe92cf20` 读完了实际代码。多数作者说法与代码一致，但发现以下几个值得在合并前处理的问题：**一个标记文件的读取/删除错误会让每小时巡检一直失败**、**`source_unreadable` 加全局 4 倍上限会永久挡住后面的好记忆**、**0.5 美元不是严格硬上限**，以及若干反向用例并没有真正验证目标行为。下面先列证实的问题，再列推测/未核实，最后逐条回答必答问题。

---

## 读代码证实的问题（按严重度）

### 1. 中：单个标记文件读不了或删不掉，会让每次 tick 在评测开始前失败，评测永久不跑

- 文件:行：`apps/agent-service/src/production-real-eval.ts:156-162`、`:190-196`、`:447`
- 问题：`readUnfinishedRealEvals` 对标记文件做 `stat`、`readFile` 和 `rm` 时，只把 `ENOENT` 当作“不存在”；`EACCES`、`EPERM`、`EROFS`、`EIO` 都会直接抛异常。`ProductionRealEval.#tick` 又直接 `await readUnfinishedRealEvals(...)`，没有局部 catch，于是 tick 在 `dueRealEvalTrigger` 之前就失败，一小时后再失败，永远不进入运行。
- 证据：
  ```ts
  // production-real-eval.ts:83-86
  function missing(error: unknown): undefined {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // :156-162
  if (name.endsWith(".tmp")) {
    await rm(file, { force: true });
    continue;
  }
  const found = await stat(file).catch(missing);
  ...
  const text = await readFile(file, "utf8").catch(missing);
  // :190-196
  if (recordedRunIds.has(run.runId) || ... >= REAL_EVAL_INTERVAL_MS) {
    await rm(file, { force: true });
    continue;
  }
  ```
  `rm(..., { force: true })` 只忽略 `ENOENT`，其他错误照样抛。下面的“将来时间标记”分支反而正确 catch 了 `utimes` 和 `rm` 失败（`:164-181`），说明这里是遗漏。
- 建议：把每个文件的 `stat/readFile/rm` 都包在局部 try/catch 里；读不了的标记按“花光整周上限”或明确跳过并记诊断，删不掉的 `.tmp`/旧标记只记一条诊断后继续扫描。补一个故障注入测试：让 `readFile`/`rm` 对单个文件抛 `EACCES`，要求后续 tick 仍能调度评测。

### 2. 中：`source_unreadable` 不占名额，但“全局读到 4N 就停 + 每轮从头排序”会永久挡住后面的好记忆

- 文件:行：`packages/application/src/services/real-memory-eval-service.ts:260-270`、`:60-70`；文档 `docs/adr/0219-real-memory-eval-sets.md:54`、`docs/engineering-casebook.md:5493`
- 问题：`pickNewMemories` 每轮都按 id 排序，从第一条开始；`reads` 是所有记忆共享的全局上限 `newMemoriesPerRun * 4`，不是每个名额独立。若前 `4N` 条记忆永久解不开，循环在读到它们后直接 `break`，后面的好记忆一条也读不到；下一轮又从头读同样这批。更糟的是这一轮记为 `completed`，weekly 模式要等 7 天才再跑，等于整周没有新题。
- 证据：
  ```ts
  // :260-270
  for (const memory of pickNewMemories(candidates, banked, startedAt, candidates.length)) {
    if (asked >= limits.newMemoriesPerRun ||
        reads >= limits.newMemoriesPerRun * SOURCE_READS_PER_SLOT)
      break;
    reads += 1;
    const source = await readSource(memory);
    if (source.unreadable) {
      rejected["source_unreadable"] = ...;
      continue;              // 不记 declined，也不推进游标
    }
  ```
  ```ts
  // :66-69
  return records
    .filter(...)
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .slice(0, Math.max(0, limit));
  ```
  ADR 写“每个名额最多读 4 条记忆，读满就留到下一轮”，但代码是全局 `4N`，而且没有游标，下一轮不会“接着读”，会重新读同一批。
- 建议：让读取位置可推进（持久化游标，或短期跳过最近 `source_unreadable` 的 id，过期后再试）；同时把读取预算改成真正的“每名额 4 次”，或把文档改成“整轮最多读 4N 条”。补测试：`a1..a4` 解不开、`coffee` 可读、`newMemoriesPerRun: 1`，连续两轮应至少问出 `coffee`。

### 3. 中：0.5 美元不是严格硬上限，单次调用可能把 7 天累计顶过上限

- 文件:行：`packages/application/src/services/real-memory-eval-service.ts:194-208`、`:331-369`；`apps/agent-service/src/production-real-eval.ts:456-467`
- 问题：`reserve(estimate)` 只在调用前检查“已花 + 预估”，`record(actual)` 在调用后才把实际费用加进去，只有已经超过上限才抛错。因此实际费用高于预估时，7 天累计会超过 `weeklyCapMicros`，超出的量是这次调用的“实际减预估”。作者在 ADR `:58` 已承认“最多超出一次调用的预估误差”，但这与任务要求的“每周费用硬上限 0.5 美元、花到上限必须立刻停”不是字面一致。嵌入费用同样走 `reserve(recallEstimateMicros)` + 事后 `record(recall.costMicros)`，没有例外。
- 证据：
  ```ts
  // real-memory-eval-service.ts:194-208
  const estimate = deps.model.estimateMicros(prompt, maxOutputTokens);
  budget.reserve(estimate);
  ...
  budget.absorb(estimate);   // 调用失败按预估
  ...
  budget.record(result.costMicros);   // 实际费用，事后检查
  // :366-368
  record(actualMicros: number): void {
    this.#spentMicros += Math.max(0, actualMicros);
    if (this.#spentMicros > this.#limitMicros) throw new RealEvalBudgetExceededError();
  }
  ```
- 建议：如果“硬上限”是验收条件，需要预留保守上界（例如输入按最坏遮盖后长度、输出把推理余量算足），或在剩余额度里扣掉一个“单次最大超支”余量；否则请在任务/ADR 里把 0.5 美元明确改成“预估硬上限，实际最多超出一次调用误差”。

### 4. 低：新增的 `capMicros: 0` 反向用例并不能证明代码拒绝它

- 文件:行：`apps/agent-service/test/production-real-eval.unit.test.ts:549-567`；`apps/agent-service/src/production-real-eval.ts:133-134`
- 问题：测试把 `capMicros: 0` 和另外三个必按 500000 计的坏标记放在一起。即使把 `(value.capMicros ?? 0) < 1` 这一行删掉、让 0 当合法值，另外三个标记仍会让第一次 tick 因额度不足不跑、第二次 tick 因满 7 天全部删除后跑；断言 `limits` 前后完全相同。这条新增用例对目标行为没有区分力。
- 证据：
  ```ts
  // test:549-563
  for (const text of [
    '{"startedAt":',
    '{"startedAt":"2026-11-08","trigger":"weekly","capMicros":5}',
    '{"startedAt":"2026-11-08T00:00:00.000Z","trigger":"weekly","capMicros":-5}',
    '{"runId":"run-zero",...,"capMicros":0}',
  ]) { ... }
  await timer(NOW).tick();
  expect(limits).toEqual([]);
  await timer(at(REAL_EVAL_INTERVAL_MS - REAL_EVAL_RETRY_MS)).tick();
  expect(limits).toEqual([500_000]);
  ```
  三个坏标记已经足够产生同样的两次断言。
- 建议：单独放一个 `capMicros: 0` 标记，直接断言 `readUnfinishedRealEvals` 返回的 `costMicros` 是 `weeklyCapMicros`，或断言这次 tick 不调用 `service.run`；不要和别的满额标记混在一起。

### 5. 低：第 10 轮新增的两个错误分支没有测试

- 文件:行：`apps/agent-service/src/production-real-eval.ts:95-102`、`:164-181`；测试 `apps/agent-service/test/production-real-eval.unit.test.ts:651-717`
- 问题：第 10 轮说“将来时间且 `utimes` 失败时直接删除样本”和“标记 `utimes`、`rm` 都失败时按今天开始、花光整周上限计”。现有测试只覆盖 `utimes` 成功路径（`:707-717`、`:651-688`），没有覆盖失败分支。加上第 1 条提到的 `rm` 失败会让 tick 抛错，这两处正好是最需要反向用例的错误路径。
- 建议：注入/替换 `utimes`、`rm`，或用只读目录构造失败，分别验证：
  - 样本 `utimes` 失败、`rm` 成功 → 文件被删除；
  - 标记 `utimes` 和 `rm` 都失败 → `readUnfinishedRealEvals` 返回 `costMicros = weeklyCapMicros` 且 `startedAt = now`；
  - 标记 `rm` 失败（第 1 条）→ tick 不整体失败。

### 6. 低：抽查样本会在记忆删除后继续保留记忆正文和原话，最多 7 天

- 文件:行：`apps/agent-service/src/production-real-eval.ts:88-107`、`:364-394`；`docs/adr/0219-real-memory-eval-sets.md:90`
- 问题：`latest-sample.json` 的清理只看文件 mtime 是否满 7 天，记忆删除流程没有任何“清样本”的调用。因此删除一条记忆后，它的正文和原话还会留在样本文件里直到 TTL 到期。ADR `:90` 明确承认了这一点，所以这是已记录的设计取舍，不是新 bug；但如果“删除记忆必须连带清掉真实内容”也覆盖抽查样本，就不满足。
- 证据：
  ```ts
  // writeRealEvalSample:379-383
  question: maskForExport(item.question),
  response: maskForExport(item.response),
  quote: maskForExport(item.quote),
  memory: maskForExport(item.memory),
  ```
  只做敏感值遮盖，正文其余照原样；`expireRealEvalSample` 仅在 `Date.parse(now) - found.mtimeMs >= REAL_EVAL_SAMPLE_TTL_MS` 时删除。
- 建议：若要求删除后立刻不可见，在记忆删除时把样本里对应的 question/memory/quote 一并清掉或整份删除；否则在验收标准里明确“样本最多保留 7 天”。

### 7. 低：跨进程没有互斥，两个服务进程可各跑一次并各自花掉同一份剩余额度

- 文件:行：`apps/agent-service/src/production-real-eval.ts:411`、`:430-437`、`:458-464`；`docs/adr/0219-real-memory-eval-sets.md:90`
- 问题：同进程内 `#running` 确实能防止 tick 并发（`this.#running ??=`），但跨进程没有锁。两个进程会从各自数据库读到同一份 7 天累计，算出相同的 `remaining`，各写自己的标记、各跑一轮；总花费最多可接近 2 倍上限。ADR 只写了“两边各跑一次”，没有写预算会翻倍。作者说跨进程互斥是有意不做，这一点可以作为已接受风险，但预算后果值得写清。
- 建议：如果不加锁，至少在 ADR 后果里写明“两个服务进程同时运行时，预算上限不成立（最多 2 倍）”；若要保硬上限，用数据库/文件租约只允许一个进程运行评测。

### 8. 低：退役题仍占唯一键，同一版本重新可出题时不会再出新题；文档已承认但和“给没有在用题的记忆出题”的说法有落差

- 文件:行：`packages/persistence-sqlite/src/migrations/0088_real_eval.sql:21`、`packages/persistence-sqlite/src/sqlite-real-eval-operations.ts:118-131`、`packages/application/src/services/real-memory-eval-service.ts:314-325`；`docs/adr/0219-real-memory-eval-sets.md:90`
- 问题：`UNIQUE (memory_id, memory_revision, kind)` 不排除已退役题；`ON CONFLICT ... DO NOTHING` 返回 false 后服务把该记忆版本记进 `declined`。如果一条记忆以相同 revision 重新变成可出题（例如可见分级改回），旧退役题会挡住新题，而且本次尝试还会白花一次模型调用。ADR `:90` 最后一句承认“版本号不变时这个版本不再出新题”，但任务/作者说法里“给没有在用题的已确认记忆出题”容易被理解成会重新出。
- 建议：用部分唯一索引 `WHERE retired_at IS NULL`，重新可出题时删掉退役题及其 payload 或直接复用；若坚持当前设计，请在 ADR/案例里明确“同一 revision 退役后不会重新出题，只有 revision 变化才出”。

---

## 推测/未核实（不要当成已证实结论）

- 第 2 条的永久饥饿需要“前 `4N` 条记忆解不开”。这是故障场景，不是常态；但一旦发生，后果是无声的整周空跑。
- 第 7 条的双倍花费没有实际跑过两个进程，只是代码里没有任何锁文件/数据库租约。
- 第 3 条的实际超支幅度取决于服务方计价与出口遮盖后长度，没有实测。
- `docs/engineering-casebook.md:5571` 的复核累计费用（1.23 美元）和 `usage.jsonl` 内容未核实；`npm run check` 未运行；本次不允许运行测试。
- 迁移号“合并前按队列改成 main 下一个空号”无法在本地核实；当前代码是 88，且 `workspace-lifecycle-audit.mjs` 的 `SUPPORTED_SCHEMA_MAX` 已同步到 88。

---

## 侧重检查

已逐项看过这些路径：

- **费用**：所有模型调用都经过 `call()` 的 `reserve`（`real-memory-eval-service.ts:194-208`），检索经过 `ensureRemaining + reserve(recallEstimateMicros)`（`:352-361`）；嵌入费用通过 `embedForMailCheck` 的 `mail.costMicros` 计入并在检索后 `record`；调用失败、费用缺失/非法走 `absorb(estimate)`；标记残留按本次 `capMicros` 计；7 天累计按 `startedAt` 滑动。结论：不可避免“一次调用的事后超支”，见问题 3。
- **敏感信息**：`summary` 只写分数、计数、`memoryId@revision`、`questionRef`、错误名（`real-memory-eval-service.ts:444-458`、`:459-471`）；样本写 `latest-sample.json` 前逐字段 `maskForExport`，目录 0700、文件 0600（`production-real-eval.ts:364-394`）；错误只记 `error.name` 或 `stableErrorCode`；题干 payload 用记忆自身分级加密（`production-real-eval.ts:541-554`）。
- **不可信输入**：标记 JSON 解析失败/字段不合规按花光整周上限（`production-real-eval.ts:116-143`、`:184-189`）；生成题严格解析 JSON、限长、禁换行/花括号、泄题和敏感值检查（`real-memory-eval.ts:195-246`）；题干、回答、档案、检索内容都用 `JSON.stringify` 放进数据块，固定指令在前。
- **资源耗尽**：`SOURCE_READS_PER_SLOT = 4` 限制一轮读取；输出 64KB 上限；样本 30 条；运行记录读取上限 520；退役题会永久保留（题干 payload 被题库行引用，ADR 已记录这个增长代价）。
- **不可撤销操作**：`discardQuestion` 失败会记 `undiscarded` 并在后续运行重删（`real-memory-eval-service.ts:229-232`、`:314-321`）；治理删除先删 `memory_records` 让题级联删除，再删 payload（`sqlite-governed-deletion.ts:884-890`）；样本和标记的 TTL 删除；标记 `rm` 失败的阻塞问题见问题 1。
- **规则/文档一致性**：`prompt-prefix` 的“固定在前、变化在后”与三个 `*Prompt` 一致；ADR/casebook 与代码在“每个名额 4 条”“留到下一轮”“记忆读取出错”等处有措辞出入，见下面“说法核对”。

---

## 作者说法与代码不一致的地方

1. 第 1 轮说法 #2 写“从最近 **52** 次运行的 `summary.declined` 读”；代码是 `RECENT_RUNS_FOR_DECLINED = 520`（`real-memory-eval-service.ts:118`）。第 2 轮已改成 520，最终代码是 520。
2. ADR `:54` 和案例 `:5493` 写“每个名额最多读 4 条记忆，读满就留到下一轮”；代码是整轮共享 `newMemoriesPerRun * 4` 次读取，且没有游标，下一轮从头开始（问题 2）。
3. 第 10 轮说法 #1 的“读满留到下一轮”同样不成立：没有保存读取位置，下一轮会重读同一批。
4. 第 2 轮说法 #3“所有被拒的出题都记进 `summary.declined`”不准确：`response_invalid` 和 `source_unreadable` 不记（最终代码如此，第 3、9 轮已修正）。
5. 第 5 轮说法 #4“discardQuestion 失败只计数”不完整：代码还会把题干编号写进 `summary.undiscarded`，供后续运行重删（第 6 轮已修正）。
6. 案例 `:5520` 写“记忆读取出错时，下次照常再问”，容易和 `source_missing` 混淆：代码只对 `source_unreadable`（抛错）重试；`source_missing`（取不到）会记 `declined` 并永久跳过该版本（`real-memory-eval-service.ts:268-276`）。建议案例明确区分“读取（解密）出错”和“取不到”。
7. 第 9 轮说法 #3 的“标记 `utimes` 失败时删掉标记，删不掉就跳过”不够准确；第 10 轮已改成“删不掉按今天开始、花光整周上限计”，代码与第 10 轮一致。
8. ADR `:58` 说“上限按最近 7 天所有运行实际花的钱累计”，但残留标记是按“本次可用额度”计，不是实际花费；同一段后面有解释，但前半句字面上不准确。

其余作者说法（迁移级联、治理删除清题干、`once/weekly` 触发、样本 0600、决策五组、导出未导出理由、分类传给向量模型、`COST_INVALID`、按字节预估、模型 `openai-completions` + private/sensitive、`purpose: other`、`source_unreadable`/`source_missing`、`unanswerable`、`undiscarded` 重删）我读到的代码与之一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会改变已有对话的请求开头。** 这次改动没有修改系统提示、工具定义或对话历史；新增的 `REAL_EVAL_QUESTION/ANSWER/JUDGE` 是独立的 background 调用，不进入聊天上下文。新增的三个提示词是新的 manifest 条目，旧条目 sha256 未变。

三个 prompt 都满足“固定指令在前、本次数据在后”：

- `questionPrompt`：`REAL_EVAL_QUESTION.text + "\n" + JSON.stringify({memory, quote})`（`real-memory-eval.ts:174-179`）。
- `answerPrompt`：`REAL_EVAL_ANSWER.text + "\n" + JSON.stringify({profile, memories, question, now})`（`:248-263`），`now` 在 JSON 最后。
- `judgePrompt`：`REAL_EVAL_JUDGE.text + "\n" + JSON.stringify({...})`（`:265-281`）。

测试也明确断言固定头部逐字节不变、`now` 只在末尾：`packages/application/test/real-memory-eval.unit.test.ts:177-215`。结论：对已有请求是 0 改动；新增请求只在末尾追加数据，每轮会变的值在最后的数据块里。

### 2. 同一段文字会不会在不同请求里变成不同字节？

未发现这个问题：

- 三个 prompt 的 JSON 都是对象字面量 + 数组，键顺序固定；`JSON.stringify` 不依赖数据库返回顺序以外的随机性。
- `profile.texts` 和 `recalled` 的顺序来自 `OwnerProfileService.compose` 和记忆搜索返回顺序；它们在单次请求里确定，且属于“本次数据”，不是固定头部。
- `now` 是显式的最后一个字段，没有塞进固定指令。
- `dateTokens`/`numbers`/`ngrams` 里的 `Set` 只用于比较，不参与序列化，不会产生无序输出。
- 抽查样本的 `maskForExport` 是逐字段纯函数，不依赖其他字段或前后文；它不进入模型请求。
- `prompt_sha256` 的计算和 `apps/agent-service/test/prompt-catalog.unit.test.ts:172-173` 的 manifest 规则一致（都是 `JSON.stringify(segments)`），不会出现同一个题干在不同运行里 hash 不同的情况。

没有发现“依赖前后文的遮盖、带时间的固定字段、无序集合进入模型请求”的情况。

### 3. 有没有自动检查？反向用例真的会失败吗？

有测试，且不少反向用例是有效的：

- `packages/application/test/real-memory-eval-service.unit.test.ts`：预算预留不足不检索、单次实际超预估只答一次、额度用完、失败按预估记账、`addQuestion` false/throw 删题干、`undiscarded` 重删、`source_unreadable` 不占名额、`unanswerable`、先新题后面板、错误不落正文。
- `packages/application/test/real-memory-eval.unit.test.ts`：固定头 + 数据在后、日期/数字/敏感值泄题、cap 预算、决策分组。
- `apps/agent-service/test/production-real-eval.unit.test.ts`：once/weekly/24h/7 天触发、7 天累计、样本 TTL/权限、标记满额、将来时间标记、`runId` 去重。
- 数据库/集成：`packages/persistence-sqlite/test/real-eval.contract.test.ts`、`test/integration/real-memory-eval.test.ts`、`test/integration/sqlite-governed-deletion.test.ts`、`test/integration/data-export.test.ts`。
- 配置：`packages/platform-node/test/startup-configuration.unit.test.ts` 覆盖 cap 上限、`newMemoriesPerRun` 范围、`modelRef` 接口/分级、embedding sensitive。

有效的反向例子：

- 去掉 `reads >= newMemoriesPerRun * SOURCE_READS_PER_SLOT`，`"stops reading after four unreadable memories per question slot"` 会因为 `coffee` 被问出而失败（`real-memory-eval-service.unit.test.ts:430-439`）。
- 把 `record` 的事后超限检查去掉，`"stops at once when a call costs more than its estimate"` 会因为多答一道而失败。
- 把 `addQuestion` 的 `discardQuestion` 去掉，`"deletes the stored question text when the bank does not keep the question"` 会失败。

但有两个明确的测试缺口：

- 第 10 轮新增的 `capMicros: 0` 用例**不会**在代码改回接受 0 时失败（见问题 4）。
- 第 10 轮的“将来时间 + `utimes`/`rm` 失败”两条错误路径没有测试（见问题 5）。
- 第 1 条的“标记 `rm` 失败”也没有测试；这是我认为最需要补的故障注入用例。

我没有运行这些测试，不能确认它们当前是否全绿；“测试存在”和“测试能抓住回归”是两件事，上面按代码逻辑判断反向用例的区分力。

### 4. 改动产生/修改的每个值，使用方都能接受吗？

逐项核对结果：

- **配置键/字段**：`parseRealEval` 接受 `mode/modelRef/weeklyCapMicros/newMemoriesPerRun/requestTimeoutMs`，未知字段（如 `budgetKey`）被拒（`strict-configuration.ts:1104-1127`、`:1146`）；`weeklyCapMicros` 1..500000 与 `RealEvalBudget` 要求 `>0` 一致；`newMemoriesPerRun` 1..200；`requestTimeoutMs` 1000..300000。`modelRef` 用 `safeReference`，允许 `:` `/`，长度 ≤256，和 `real_eval_questions.question_model` 的 1..256 一致；`ModelUsagePurpose "other"` 在 `model-usage.ts:3-12` 和迁移 `0068_model_usage_observations.sql:9` 都存在。
- **运行编号/题号/题干引用**：`real-eval-run:<uuid>`、`real-eval:<uuid>` 均 ≤128，满足 `real_eval_runs.id`、`real_eval_questions.id`；`questionRef` 是 `payloads.ref`，payload 表主键没有长度限制；`prompt_sha256` 64 位十六进制，与 manifest 计算方式一致；`createdAt/startedAt/finishedAt/retiredAt` 都是 `toISOString()` 的规范格式，和 SQL 的 GLOB 校验一致；`kind/outcome/trigger/retiredReason` 枚举和迁移 CHECK 完全一致；`cost_micros` 是安全整数，落在 CHECK 的 0..9007199254740991 内。
- **`summary` 的使用方**：`real-eval-report.mjs` 读 `scores/items/added/retired`，服务读 `declined/undiscarded/rejected`，数据库只要求 JSON object。实际写入的 `summary` 是对象，分数是 `proportion` 的可 JSON 化结构，没有函数/undefined。
- **删除/导出**：`real_eval_questions.memory_id` 级联删除，`question_ref` 对 payload 是 RESTRICT；治理删除先收集 `question_ref`、删 `memory_records`（级联题），再删 payload（`sqlite-governed-deletion.ts:884-890`），集成用例覆盖。导出清单只新增“未导出”说明，集成测试确认导出文件里没有题干正文、导入后 `real_eval_questions` 为 0。
- **一处跨进程去重的边界**：`recordedRunIds` 只取 `listRuns({limit:520})`（`production-real-eval.ts:446-451`）。如果某个残留标记对应的数据库运行记录已经掉出最近 520 条，标记不会被识别为“已记录”，会和数据库记录一起重复计入 7 天累计。每周一次运行要 10 年才会遇到，属于低风险；但“读取标记时数据库已有同 runId 就跳过”这句话严格说只对最近 520 条成立。
- **一处产品语义边界**：`UNIQUE(memory_id, memory_revision, kind)` 包含退役题，导致同 revision 重新可出题时永远不出新题（问题 8）。ADR 已记录，但“给没有在用题的已确认记忆出题”这句话在这条路径上不成立。

除此之外，我没有找到“产生方写入后使用方校验不了”的字段。

---

## 未核实项

- 未运行 `npm run check`、`npm run check:prompt-prefix` 或任何测试；以上测试结论来自读代码和测试代码。
- 未重新计算 manifest 中三个新 sha256 的值；只确认了生产代码和测试使用同一计算式。
- 未读取 `.agents/reviews/pr-378/usage.jsonl`（工具拒绝读取），案例里的复核累计金额未核实。
- 未核实合并队列里迁移 0088 是否会被改成别的编号；当前仓库最大序号是 88，审计脚本上限也已改成 88。
- 未实测服务方真实计费、出口遮盖后的实际长度、两个进程并发运行时的真实花费。
