## 结论摘要

本次第 9 轮改动本身方向正确：`source_unreadable` 不再永久跳过、预览样本/标记能处理未来时间。但我核对后发现 2 个中等问题和几处低风险问题，其中最能直接落到“规则文件与代码是否一致”的是 `docs/engineering-casebook.md` 没有跟着 ADR 改。没有发现会改变已有对话请求开头、或让同一段文字产生不同字节的问题。

---

## 问题（按严重度从高到低）

### 1. 中：案例库仍说“只有非法 JSON 才下次再问”，与第 9 轮代码/ADR 矛盾

- **文件:行**：`docs/engineering-casebook.md:5520`（另见 `:5493`）
- **问题**：案例 87 的“题干当不可信输入检查”仍写“被丢弃或模型拒绝出题的记忆版本，以后不再问……只有模型回的不是合法 JSON 时，下次照常再问”。但当前代码把 `source_unreadable` 也当作“下次照常再试”，且不记 `declined`。
- **证据**：
  - 案例库原文：`被丢弃或模型拒绝出题的记忆版本，以后不再问……只有模型回的不是合法 JSON 时，下次照常再问。`
  - 代码 `packages/application/src/services/real-memory-eval-service.ts:260-269`：
    ```ts
    const source = await readSource(memory);
    if (source.unreadable) {
      rejected["source_unreadable"] = (rejected["source_unreadable"] ?? 0) + 1;
      continue;
    }
    asked += 1;
    if (source.text === undefined || source.quote === undefined) {
      rejected["source_missing"] = (rejected["source_missing"] ?? 0) + 1;
      declined.push(declinedKey(memory.id, memory.revision));
      continue;
    }
    ```
  - ADR `docs/adr/0219-real-memory-eval-sets.md:54` 已正确写成“读取（解密）出错时也跳过（计为 `source_unreadable`），但不占名额、下次照常再试”。
- **建议**：把案例库第 5520 行补成“除了非法 JSON，`source_unreadable` 也不记版本、下次再试”；第 5493 行的“每轮最多 `newMemoriesPerRun` 条”建议改成“每轮最多为这么多条可读记忆出题”，避免读者以为读取尝试也有上限。

### 2. 中：`source_unreadable` 不占名额后，单轮读取/解密工作量没有上限

- **文件:行**：`packages/application/src/services/real-memory-eval-service.ts:257-265`
- **问题**：为了跳过错记忆，代码把 `pickNewMemories(..., candidates.length)` 的所有候选都拿出来遍历，`asked` 只在“读得出”时自增。若大量记忆解密持续失败（例如密钥轮换导致一批旧 payload 全部解不开），每轮都会把所有候选各做一次 `payload.get`、`listHistory` 和 `unprotect`。作者说“只读不调模型，不花钱”是对的，但资源/时间不是零，且不受 `newMemoriesPerRun` 限制。
- **证据**：
  ```ts
  let asked = 0;
  for (const memory of pickNewMemories(candidates, banked, startedAt, candidates.length)) {
    if (asked >= limits.newMemoriesPerRun) break;
    const source = await readSource(memory);
    if (source.unreadable) {
      rejected["source_unreadable"] = (rejected["source_unreadable"] ?? 0) + 1;
      continue;
    }
    asked += 1;
  ```
  `readQuote` 在 `apps/agent-service/src/production-real-eval.ts:521-525` 每条还会额外查一次 `listHistory`。
- **建议**：加一个独立的“本轮最多读取/尝试解密多少条”上限（例如 `maxSourceReadsPerRun`），或让连续 `source_unreadable` 也消耗一个单独的扫描预算/次数，超过就留到下一轮；或者在连续失败 N 次后按版本临时冷却。

### 3. 低：未来时间标记在 `utimes` 和 `rm` 都失败时被直接跳过，花费漏算

- **文件:行**：`apps/agent-service/src/production-real-eval.ts:159-167`
- **问题**：标记 mtime 在将来、`utimes` 失败时，代码尝试删除；若删除也失败，就 `continue`，这个标记完全不进入 `unfinished`。于是它记录的 `capMicros` 不会计入 `realEvalSpentMicros`，后续运行可能继续花掉整整一周额度。这正是作者第 9 轮让看的“跳过删不掉的未来标记会不会漏算花费”所指路径。
- **证据**：
  ```ts
  if (found.mtimeMs > Date.parse(now)) {
    const reset = await utimes(file, new Date(now), new Date(now)).then(
      () => true,
      () => false,
    );
    if (!reset) {
      await rm(file, { force: true }).catch(() => undefined);
      continue;
    }
  }
  ```
- **建议**：即使删不掉，也应按“花光整周上限”把它加入 `unfinished`（`startedAt` 取 `min(mtime, now)`，`costMicros` 取 `weeklyCapMicros`），只是保留文件等下次再删；删除失败不应同时意味着记账失败。

### 4. 低：`capMicros: 0` 被当成合法进行中标记，会记为 0 花费

- **文件:行**：`apps/agent-service/src/production-real-eval.ts:118-130`（校验）、`:441-449`（正常写标记）
- **问题**：`inProgressRun` 只拒绝负数：`(value.capMicros ?? -1) < 0`。但正常流程在 `remaining <= 0` 时不会写标记，所以合法标记的 `capMicros` 一定 ≥ 1。一个被篡改或损坏成 `capMicros: 0` 的标记会被当作“本次只花了 0”，而不是按设计“读不懂按花光整周上限算”。
- **证据**：
  ```ts
  !Number.isSafeInteger(value.capMicros) ||
  (value.capMicros ?? -1) < 0
  ```
- **建议**：把合法条件改成 `capMicros >= 1`（或将 `<= 0` 视为读不懂），并在注释/ADR 中写明“合法标记的额度必为正”。

### 5. 低：未来时间的抽查样本在 `utimes` 失败时不会过期

- **文件:行**：`apps/agent-service/src/production-real-eval.ts:95-98`
- **问题**：`expireRealEvalSample` 的未来 mtime 分支没有捕获 `utimes` 异常；一旦失败，函数抛出、文件保留，之后每个 tick 都同样失败。调用方会吞掉错误，评测不受影响，但包含真实记忆正文/原话的样本文件会无限期留在磁盘上，和“满 7 天删除”的承诺不符。
- **证据**：
  ```ts
  if (found && found.mtimeMs > Date.parse(now)) {
    await utimes(file, new Date(now), new Date(now));
    return false;
  }
  ```
- **建议**：和 `readUnfinishedRealEvals` 一样处理：`utimes` 失败时直接 `rm`（未来时间的样本本来也超过保留期，删除比留着更安全），或者至少 `catch` 后记录并按 `mtime` 继续判断，避免永久保留。

### 6. 低：第 9 轮两处生产粘合代码没有自动测试

- **文件:行**：`apps/agent-service/src/service-main.ts:1704-1716`（档案 `readText` 解密失败返回 `undefined`）、`apps/agent-service/src/production-real-eval.ts:583`（检索结果 `readText` 失败当读不到）
- **问题**：第 9 轮新增的 service 层测试只覆盖了 `RealMemoryEvalService` 的 `readSource/readQuestion` 失败路径；`createProductionRealEval` 在测试里没有任何引用，档案解密失败和检索解密失败这两处生产适配层改动没有直接用例。无法证明“档案和检索里的坏记忆不拖垮整轮”在真实装配下成立。
- **证据**：仓库中测试对 `createProductionRealEval` 的引用为 0（检索 `createProductionRealEval` 只命中源码）；新增测试集中在 `packages/application/test/real-memory-eval-service.unit.test.ts`。
- **建议**：加一条 `createProductionRealEval` 的单元测试：让 `protector.unprotect` 对某条记忆抛错、对另一条正常，断言本轮完成、坏记忆被省略、好记忆正常作答；再覆盖检索结果里 `readText` 抛错的路径。

### 7. 低（推测）：`storeQuestion` 抛错时可能留下未被引用的题干 payload

- **文件:行**：`packages/application/src/services/real-memory-eval-service.ts:289-294`
- **问题**：`addQuestion` 返回 false/抛错时已有 `finally` 调用 `discardQuestion` 清题干；但如果 `deps.storeQuestion` 自身在 payload 已写入后抛错（例如 worker 写成功但响应丢失），服务拿不到 `questionRef`，没有任何清理路径，这段加密题干会永久留在 `payloads` 里且无人引用/删除。
- **证据**：
  ```ts
  const questionRef = await deps.storeQuestion({
    memory,
    kind,
    text: questionText,
    createdAt,
  });
  ```
  只有后续 `store.addQuestion` 的 `finally` 会删 `questionRef`。
- **建议**：让 `storeQuestion` 的实现返回可清理的句柄，或在服务层把“生成 ref + 写 payload + 入库”合并成可重试/可回滚的操作；最低成本是写入失败时按 ref 规则尝试删除（生产 ref 是 `real-eval-question:<newId>`，可在进入前生成 ref 再由调用方清理）。
- **说明**：这条取决于 worker 模式下写入已提交但响应失败的窗口，属于推测；普通 SQLite 直连抛错时通常未提交。

---

## 与作者说法不一致处

1. **最初说法 #2 的“最近 52 次运行的 summary.declined”**与当前代码不符：`RECENT_RUNS_FOR_DECLINES = 520`（`packages/application/src/services/real-memory-eval-service.ts:118`）。第 2 轮已改成 520，这条只是遗留表述，不是功能错误。
2. **第 9 轮说法 #4“ADR、案例 87 文字修改”不完整**：案例库第 5498、5548 行改了，但第 5520 行仍与代码/ADR 矛盾（见问题 1）；第 5493 行的“每轮最多 `newMemoriesPerRun` 条”也没反映“读取尝试可以超过该数”。
3. 第 9 轮说法 #1、#2、#3 与代码一致：档案/检索读取失败返回 `undefined` 或被省略；`source_unreadable` 不记 `declined`、不占名额；`source_missing` 记 `declined`、占名额；未来样本先 `utimes`，标记 `utimes` 失败时删、删不掉跳过。
4. 第 8 轮说法 #1（`source_unreadable` 和 `source_missing` 都记 `declined`）已被第 9 轮取代；当前只对 `source_missing` 记 `declined`。ADR 已更新，案例库未完全更新。
5. 最初说法 #6（两个已知失败测试与改动无关）本轮无法核实（见“未核实”）。

---

## 侧重检查

- **错误路径**
  - 出题读取失败：`readSource` 全包 `catch`，`source_unreadable` 跳过；`source_missing` 记 `declined`。已核对。
  - 作答读取失败：`readQuestion` 使用 `.catch(() => undefined)`，`readSource` 内部 `catch`，计入 `unanswerable`。已核对。
  - 档案读取失败：`service-main.ts` 的 `readText` 只包住 `unprotect/decode`，返回 `undefined`；`OwnerProfileService` 对 `undefined` 是跳过，不抛错。已核对。
  - 检索结果读取失败：`production-real-eval.ts:583` 的 `.catch(() => undefined)` 会省略该条记忆。已核对。
  - 模型失败/费用不合法：`createRealEvalModel` 抛 `RealEvalModelError`，服务层 `absorb(estimate)` 后把错误名记为 `failed`；不记错误文字。已核对。
  - 样本写入失败：先写样本再 `recordRun`，写失败把本次记为 `failed`。已核对。
  - 标记读不懂/未来时间/重复 runId：有校验与去重；但 `capMicros=0` 是漏洞（问题 4），`utimes`+`rm` 双失败会漏算（问题 3）。
- **不合规范/不可信输入**
  - 模型题干：长度、行内字符、JSON 结构、泄题（6-gram/数字/日期时刻）、敏感值都检查；日期检查对“一点”做了时段/后接限制。已核对。
  - 进行中标记：JSON 解析、`runId`、规范 ISO `startedAt`、`trigger`、`capMicros` 都校验；唯一缺口是 `capMicros=0`。
  - `summary.undiscarded` 的编号：来自数据库里的运行记录，消费者 `discardQuestion` 不再校验“是否 `real-eval-question:` 前缀”。目前只有服务自己写这些值，且 FK `ON DELETE RESTRICT` 保护被题库引用的题干、记忆正文等；删除不存在的 ref 是空操作（`deletePayload` 返回 `false`，不抛错）。不构成已证实漏洞，但建议加前缀校验做纵深防御。
- **安全/敏感信息**
  - 抽查样本：目录 `0700`、文件 `0600`，正文经 `maskForExport`（`redactForEgress`）遮盖；只保留最近一份，7 天过期。已核对。
  - 运行 summary：只含分数、计数、记忆编号/版本、题干 ref、错误名；不写题干/回答/原话。`recordRun` 落库前只做 `json_valid` 对象校验，不含正文。已核对。
  - 日志：`onRun` 只写 trigger/outcome/cost，`onFailure` 只写 `stableErrorCode`。已核对。
  - 导出：`data-export` 的 payload 只按导出行的 `content_ref/quote_ref/...` 收集，不包含 `real_eval_questions.question_ref`；集成测试断言导出的字节里没有题干文本。已核对。
  - 题干 payload 使用记忆自身的数据分级加密；配置在评测开启时要求生成模型允许 private+sensitive、向量模型允许 sensitive。已核对。
- **资源耗尽**
  - 模型输出有 64 KiB 上限；题干长度有上限；单轮模型调用受 `newMemoriesPerRun` 和预算限制。
  - 但读取/解密次数不受限（问题 2）；`undiscarded` 会跨 520 次运行累积并在每轮重删，极端错误路径下可能变成大量 DB 删除操作（本轮未改，低风险）。
- **不可撤销操作**
  - 题干删除：`addQuestion` 失败才删；退役题不删（外键 RESTRICT）；删除记忆由治理删除按 `question_ref` 收集 payload，再级联删题。已核对。
  - 抽查样本不随记忆删除立即删，最长约 7 天，ADR 已写明。
- **规则/文档一致性**
  - ADR 0219 与代码基本一致；案例 87 第 5520 行不一致（问题 1）。
  - `.claude/rules/prompt-prefix.md` 第 15 条与评测 prompt 的“固定指令在前、数据在后、`now` 最后”一致。

---

## 必答问题

### 1. 改动会不会改变模型已经见过的请求开头？

**不会改变已有对话/主动邮件请求的开头。** 本次改动只新增独立的后台评测调用，没有修改系统提示、工具定义或历史消息。评测调用按“固定指令文本 + `\n` + JSON 数据”拼接：

- `questionPrompt`：`REAL_EVAL_QUESTION.text` 在前，`{memory, quote}` 在后；
- `answerPrompt`：`REAL_EVAL_ANSWER.text` 在前，`{profile, memories, question, now}` 在后，每轮变化的 `now` 在 JSON 最后；
- `judgePrompt`：固定指令在前，判分数据在后。

评测没有对话历史，每个请求只有一条用户消息，因此“会变的值”都只出现在末尾的数据块里。`proactiveModel` 新增的 `purpose` 只影响模型调用的用途标记，默认仍是 `mail-judgment`，不改变 prompt 字节。`TRUSTED_PROMPT_TEXTS` 新增了评测固定文本，但旧对话里不会出现这些新文本，所以旧请求的遮盖字节不变（未发现与旧文本逐字相同的情况）。

依据：`.claude/rules/prompt-prefix.md` 第 15 条。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**没有发现新的跨请求字节不确定性。** 评测 prompt 的固定前缀是 `prompt-catalog` 里的常量；变化的 profile、检索记忆、问题、`now` 都在末尾 JSON。`dateTokens`/`ngrams` 里的 `Set` 只用于成员判断，不参与序列化。候选记忆按编号排序（`pickNewMemories` 的 `toSorted`），运行记录按时间倒序，`declined`/`undiscarded` 的生成顺序由这些确定顺序决定。样本文件用 `maskForExport`/`redactForEgress`，对同一段文字输出确定，且不依赖后面的内容。

唯一可预期的差异是 `now`、`runId`、`costMicros` 这类运行值；它们出现在末尾数据或运行记录/样本的元数据中，不在会被复用的固定前缀里。检索/档案返回的列表顺序没有显式再排序，但这些内容本来就在末尾数据块，且同一次输入的检索顺序由检索实现决定，不构成本次改动引入的“同一段文字变成不同字节”。

### 3. 有没有对应的自动检查，反向用例真的会失败？

**有测试，但覆盖不完整。**

- `packages/application/test/real-memory-eval-service.unit.test.ts`：
  - “skips a memory whose text cannot be read without using its slot and asks again later”：断言 `declined` 只含 `aaa-missing@1`、不含 `coffee@1`，且解除不可读后 `coffee` 会出题。若退回第 8 轮“记 declined”，这条会失败。
  - “counts a question as unanswerable when its text or source cannot be read while answering”：断言不可读题干/来源计入 `unanswerable`、`items` 相应减少。若退回“整轮失败”，这条会失败。
- `apps/agent-service/test/production-real-eval.unit.test.ts`：
  - 新增“lets a sample whose time is in the future expire a week after it was first seen”：断言首次不删、TTL-1 不删、TTL 删除。去掉未来时间处理会失败。
- `packages/persistence-sqlite/test/real-eval.contract.test.ts`、`test/integration/sqlite-governed-deletion.test.ts`、`test/integration/data-export.test.ts` 覆盖题库、删记忆级联、导出不含题干。
- **缺口**：第 9 轮的生产粘合改动（`service-main.ts` 档案 `readText` 捕获、`production-real-eval.ts:583` 检索读取捕获）没有直接测试；`createProductionRealEval` 在测试中没有引用。因此“档案和检索里的坏记忆不拖垮整轮”只有 service 层测试，缺少真实装配层的反向用例。
- **未核实**：本次复核不能运行测试，以上“会失败”是读断言后的判断，不是执行结果。

### 4. 每个值的生产端和使用端校验都能接受吗？

逐个核对了本次改动产生/修改的主要值：

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| `questionRef = real-eval-question:<newId>` | `production-real-eval.ts:527` | `payloads.ref` 主键（无格式/长度限制）；`real_eval_questions.question_ref` 有 `UNIQUE` + FK `ON DELETE RESTRICT` | 可接受；生产 `newId` 为 `real-eval:<uuid>`，长度远小于 128 |
| `question.id = newId()` | `real-memory-eval-service.ts:296` | `real_eval_questions.id` `CHECK length 1..128` | 可接受（`real-eval:<uuid>`） |
| `runId = real-eval-run:<uuid>` | `production-real-eval.ts:443` | `real_eval_runs.id` `CHECK length 1..128`；标记里的 `runId` 用于和数据库记录比对 | 可接受 |
| `summary.declined`（`memoryId@revision`） | 服务层 | `declinedFromRuns` 只做字符串比较；DB 仅要求 `summary` 是 JSON 对象 | 可接受 |
| `summary.undiscarded`（题干 ref） | 服务层 | 下次运行 `discardQuestion(ref)` → `payloads.delete`；删除不存在的 ref 返回 `false` 不抛错；FK RESTRICT 保护被题库引用的题干 | 功能可接受；建议加 `real-eval-question:` 前缀校验做纵深防御 |
| `summary.rejected` 新键 `source_unreadable` | 服务层 | `real_eval_runs.summary` 为自由 JSON 对象；报告脚本忽略 | 可接受 |
| `realEval.weeklyCapMicros` | 配置解析 | 校验 1..500000；`RealEvalBudget` 要求安全正整数 | 可接受 |
| `realEval.modelRef` | 配置解析 | 必须是已配置、`openai-completions`、允许 private+sensitive 的生成模型；`service-main` 再按 generation descriptor 查找 | 可接受 |
| 检索的数据分级 | `memory.dataClassification` | `embedOnce` 校验 `descriptor.allowedDataClassifications`；配置在评测开启时要求向量模型允许 sensitive | 可接受 |
| 标记字段 `capMicros` | 标记文件 | 只拒绝负数，允许 0（问题 4） | 建议收紧为 >=1 |

---

## 未核实

- 不能运行测试，因此作者第 6 条“`production-model-composition.unit.test.ts` 18 条、`model-payload-cleanup.unit.test.ts` 8 条在不含本改动的源码上同样失败”未核实。
- `packages/prompt-catalog/prompt-manifest.json` 新增的三个 sha256 是否与实际 prompt 文本一致，未核实（不能运行哈希/测试）。
- 迁移号 0088 在合并队列里是否仍是 main 的下一个空号，未核实（需要看远端/合并队列，本次只能看本地检出）。
- 第 9 轮问题 7（`storeQuestion` 抛错留下题干 payload）标为推测，取决于生产写入路径在提交后失败的可能性，未做实验验证。
