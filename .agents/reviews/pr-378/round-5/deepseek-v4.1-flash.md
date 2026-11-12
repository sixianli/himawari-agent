# 代码复核结论

总体判断：在**单个服务进程**的前提下，费用、前缀、隐私三条主线基本成立；本次增量没有发现会改变已有对话请求开头的改动。但有几个错误路径会造成评测长期停摆、题干密文残留，以及跨进程时费用上限并不“硬”。下面按严重度排列。

---

## 一、读代码证实的问题

### 1. 严重度：中高｜`apps/agent-service/src/production-real-eval.ts:96-115, 339`
**问题**：`in-progress.json` 一旦损坏、被截断或来自不兼容的旧格式，`readUnfinishedRealEval` 会抛错；`#tick` 在进入 `try/catch` 之前调用它，错误被 `tick()` 的 `.catch(onFailure)` 吞掉，但文件永远不会被删除，之后每次 tick 都在同一处失败，评测永久停摆。这与“残留标记按花光本次额度计”的设计不一致：此时既不计数，也不运行。

**证据**：
```ts
101: const value = JSON.parse(text) as Partial<InProgressRun>;
...
108: throw new Error("REAL_EVAL_IN_PROGRESS_INVALID");
...
339: const unfinished = await readUnfinishedRealEval(sampleDirectory);
```
`#tick` 的整体 catch 在 `323-330`，只会调用 `onFailure`，没有清理或降级处理。

**建议**：标记改用“临时文件 + rename”原子写入（现在 `117-122` 直接 `writeFile`）；读取时把 JSON/校验失败当成“上一次运行花光额度”处理并删除或替换该文件，至少不要让单次读取错误永久阻断评测。

---

### 2. 严重度：中高｜`apps/agent-service/src/production-real-eval.ts:190-240`
**问题**：模型调用的 `prepare` 在 `try/finally` 之外。`proactiveModel.prepare` 会先把 prompt（可能含记忆正文和原话）写成加密 payload，再申请 secret handle；如果 `prepare` 在写 payload 之后抛错，这段 prompt payload 不会被释放。另外 finally 里两个 `await` 串行，前一个 `authority.release()` 抛错时，后一个 `model.release(payloads)` 不会执行，输入和输出 payload 都会残留。

**证据**：
```ts
190: const authority = await model.prepare({
...
201: try {
...
237: } finally {
238:   await authority.release();
239:   await model.release(payloads);
240: }
```
同文件 `production-model-composition.ts:577-629` 的普通辅助调用用了 `leftBehind` 列表并在 finally 中 `release(...).catch(() => undefined)`，说明这里漏了同样的错误路径处理。

**建议**：`prepare` 放进保护块，失败时释放 inputRef；两个 release 用 `try/finally` 或 `Promise.allSettled`，避免前一个失败导致后一个不执行。

---

### 3. 严重度：中｜`packages/application/src/services/real-memory-eval-service.ts:271-278`、`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:871-890`
**问题**：`addQuestion` 返回 false 且 `discardQuestion` 失败时，只记 `discard_failed` 计数，题干 payload 会永久孤立：没有 `real_eval_questions` 行引用它，治理删除记忆时只按 `real_eval_questions.question_ref` 收集密文，因此以后也找不到它。题干由记忆和原话生成，属于真实内容残留。

**证据**：
```ts
274: if (!stored)
275:   await deps.discardQuestion(questionRef).catch(() => {
276:     rejected["discard_failed"] = (rejected["discard_failed"] ?? 0) + 1;
277:   });
```
治理删除只查题库行：
```sql
884: SELECT question_ref FROM real_eval_questions WHERE memory_id = ?
```
`addQuestion` 抛错时若 `discardQuestion` 也失败，同样会留下孤立 payload，且这次运行会被记为 failed。

**建议**：把删除失败的 `questionRef` 记入可重试的持久化清单（或按固定前缀扫描清理）；`discardQuestion` 失败时至少不要只计数，或者在治理删除中补一条按 `real-eval-question:` 前缀/创建时间的清理路径。

---

### 4. 严重度：中｜`apps/agent-service/src/production-real-eval.ts:339-348`
**问题**：`in-progress` 标记只能降低跨进程重复运行的窗口，不能真正互斥：两个服务进程可以同时读到“没有标记”，同时计算剩余额度，再各自写标记并开始评测。每次评测都拿“剩余额度”作为本次上限，因此两边合计可以超过 7 天 0.5 美元。ADR 第 90 行确实承认“同一份数据同时开两个服务进程时，两边各跑一次”，但这与“每周费用硬上限”的验收说法存在张力。

**证据**：
```ts
339: const unfinished = await readUnfinishedRealEval(sampleDirectory);
346: const remaining = configuration.weeklyCapMicros - realEvalSpentMicros(runs, now);
348: await markRealEvalStarted(sampleDirectory, { startedAt: now, trigger, capMicros: remaining });
```
读取、计算、写入之间没有任何排他锁或数据库事务。

**建议**：用 `O_CREAT|O_EXCL` 的锁文件、数据库租约/行锁，或明确部署上只允许一个评测进程；若接受多进程，应把“本周期已预留”写入共享存储后再计算剩余。

---

### 5. 严重度：中低｜`apps/agent-service/src/production-real-eval.ts:109-114, 346`
**问题**：残留标记的 `costMicros` 直接取 `capMicros`，即“本次可用额度”。崩溃一次后，`remaining` 立刻变成 0，`once` 模式在标记的 `startedAt` 满 7 天前都不会重跑。这不是永久卡死，但会把一次零花费的崩溃变成 7 天停摆；与“24 小时规则”给人的预期不同。

**证据**：
```ts
113: costMicros: Math.max(0, value.capMicros ?? 0),
...
346: const remaining = configuration.weeklyCapMicros - realEvalSpentMicros(runs, now);
```
`once` 的触发逻辑（`62-65`）在标记为 failed 时会返回 `manual`，但 `remaining <= 0` 又直接 return。

**建议**：如果这是有意设计，应在 ADR/案例里写明“`once` 崩溃后最长等 7 天”；否则把标记的预留额度和实际已记费用分开，允许 24 小时后重试。

---

### 6. 严重度：低｜`packages/application/src/services/real-memory-eval.ts:137`
**问题**：第 5 轮为了修“一点”误判，把所有“一 + 点/點”都跳过了。这会让真正的时刻“一点”不再参与泄题比对，例如题干“我一点做什么？”不会命中记忆“主人每天 1:00 跑步”的 `1时`；相反，`7:30` 与“七点”都会被归一成 `7时`，误报方向也不完全对称。

**证据**：
```ts
137: if (amount === null || (match[1] === "一" && (unit === "点" || unit === "點"))) continue;
```
测试也只覆盖了“一点都不喜欢”这个反例（`real-memory-eval.unit.test.ts:141`），没有覆盖“一点=1:00”的正例。

**建议**：结合上下文区分“一点（稍微）”和“一点（时刻）”，例如要求前面有“早上/凌晨/下午/晚上”或后面有“钟/整”；补一条正例测试。

---

### 7. 严重度：低｜`apps/agent-service/src/production-real-eval.ts:102-107, 113`
**问题**：残留标记校验接受负数 `capMicros`。负值会被 `Math.max(0, ...)` 变成 0，等于让“残留按花光额度计”的保护失效；同时 `startedAt` 只检查 `Date.parse` 有限，不要求规范 ISO 格式。

**证据**：
```ts
106: !Number.isSafeInteger(value.capMicros)
...
113: costMicros: Math.max(0, value.capMicros ?? 0),
```
**建议**：要求 `capMicros >= 0`（或 `> 0`）并校验 `startedAt` 是规范 ISO 字符串；非法值按失败/清理处理。

---

### 8. 严重度：低｜`apps/agent-service/src/production-real-eval.ts:66-70`
**问题**：`budget_exceeded` 被当作“已经跑完或花到上限”，会在 7 天内阻止 `weekly` 再跑；但 `RealEvalBudget.reserve` 可能在“下一次调用预估放不下、当前实际花费远低于上限”时抛出 `budget_exceeded`。此时剩余额度可能还有不少，却要等 7 天。

**证据**：
```ts
66: return runs.some(
67:   (run) => run.outcome !== "failed" && startedWithin(run, now, REAL_EVAL_INTERVAL_MS),
68: ) ? null : "weekly";
```
代码没有区分“真的达到上限”和“下一笔预估放不下”。

**建议**：在 summary/记录里区分 `budget_exhausted` 与“预估不足”，或允许在剩余额度明显大于 0 时按 24 小时重试。

---

### 9. 严重度：低｜文档与代码不一致
- `docs/engineering-casebook.md:5510` 说“每道正常题另配一道拒答题”；代码只在模型返回有效的 `abstainQuestion` 时才配（`real-memory-eval.ts:222-229`、`real-memory-eval-service.ts:249-251`），模型可以返回 `null`。
- `docs/engineering-casebook.md:5520` 说“被丢弃或模型拒绝出题的记忆版本，以后不再问”；代码对 `response_invalid` 不记 declined（`real-memory-eval-service.ts:243-247`），下次会重试，ADR 第 54 行已写明这个例外，案例没写。
- `docs/adr/0219-real-memory-eval-sets.md:54` 说“题库没收下的题，题干 payload 当场删掉”；第 5 轮后 `discardQuestion` 失败只计数（`real-memory-eval-service.ts:274-278`），payload 仍在。
- `docs/adr/0219-real-memory-eval-sets.md:58` 说“服务方按标价收费时，实际费用不超过预估”；预估是在出口遮盖之前按 prompt 字节算的（`production-real-eval.ts:179-184`），若遮盖占位符比原文长，实际输入可能更大。这是理论性偏差，但“绝对不超过”的表述不严谨。
- 作者说法第 2 条写“从最近 52 次运行读 declined”，代码是 `520`（`real-memory-eval-service.ts:117`、`219`）。第 2 轮说明里写的 520 才是对的。

**建议**：修正案例/ADR 措辞；`52` 改为 `520`；补偿“discard 失败不保证删除”的说明。

---

## 二、推测 / 未核实

1. **未核实**：作者称“`apps/agent-service/test/production-model-composition.unit.test.ts` 18 条、`model-payload-cleanup.unit.test.ts` 8 条与本改动无关地失败”。本次无法运行测试，未核实。
2. **未核实**：案例 87 的“第 0 层相关测试 126 条通过、`npm run check` 48 步全过”，以及提示词 manifest 的 sha256 是否与实际文本一致，均未运行，未核实。
3. **推测**：抽查样本文件名使用 `report.runId` 拼接（`production-real-eval.ts:264`）。生产 `ids.next("real-eval")` 看起来安全；但如果 `newId` 被替换为可含 `/` 或 `..` 的值，临时文件名可能逃出样本目录。建议对 runId 做文件名白名单校验。
4. **推测**：题干生成只使用记忆的 `dataClassification`（`real-memory-eval-service.ts:237-241`、`storeQuestion`），没有单独读取 `quote_ref` payload 的分级；如果原话分级高于记忆，可能出现发送分级偏低。当前捕获流程大概率保证记忆分级不低，但代码没有两端校验。

---

## 三、侧重检查

- **错误路径**：已查 `prepare/release`、`recordRun` 失败、`writeSample` 失败、`expireRealEvalSample` 失败、`readUnfinishedRealEval` 解析失败、`discardQuestion` 失败。结论：样本清理失败确实不挡评测（`#tick` 有 catch）；但 in-progress 解析失败会永久阻断评测，是本轮最值得修的错误路径。
- **不合规范/不可信输入**：模型输出的题干/JSON 有长度、字符、泄题、敏感值检查；判分只接受三种字符串；in-progress 有字段校验（但接受负数）。整体方向正确，缺口见第 1、6、7 条。
- **安全**：样本目录 `0700`、文件 `0600`（`writeRealEvalSample`）、运行 summary 只含分数/计数/标识/错误名、报告脚本只读打开数据库。主要风险是第 2、3 条的 payload 残留。
- **资源耗尽**：单次模型输出有 64 KiB 上限和 `AbortSignal.timeout`；`newMemoriesPerRun` 上限 200；固定面板虽有增长，但费用上限会停止花钱。`readUnfinishedRealEval` 无文件大小上限，但文件在 0600 状态目录内，风险低。
- **不可撤销操作**：只有模型调用花钱（进程内受 0.5 美元/7 天约束）、退役题是软状态、样本文件会被覆盖/过期删除；本次没有新增不可逆删除。
- **规则/文档一致性**：新增提示词都在固定指令后接数据，符合 [prompt-prefix.md](.claude/rules/prompt-prefix.md) 第 15 条；未发现会改动已有对话系统提示、工具定义或历史消息的代码。文档与代码的出入见第 9 条。

---

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动没有触碰已有对话的组装逻辑；评测是独立的后台调用。三个提示词都是“固定文字 + `JSON.stringify(数据)`”（`real-memory-eval.ts:159-266`），系统提示是固定常量 `EGRESS_PLACEHOLDER_LEGEND`（`packages/runtime-pi/src/egress-context.ts:23-28`），每轮变化的 `now` 只在 answerPrompt 的 JSON 末尾。把评测提示词加入 `TRUSTED_PROMPT_TEXTS` 只影响新出现的固定文字，不会改写旧对话已发出的字节。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
固定前缀不会：提示词常量在同一构建内固定，JSON 键顺序由字面量固定，`now`/memory/question 等变化值都在末尾数据里。数据数组（profile、memories）的顺序可能随数据库/检索顺序变化，但那只影响尾部的数据，不影响缓存前缀；出口遮盖对同一段内容、同一密钥是确定的。抽查样本文件里的条目顺序同样可能变化，但它不是模型输入。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有，且覆盖面较广：
- 泄题/日期/敏感值：`packages/application/test/real-memory-eval.unit.test.ts`
- 预算、检索预留、失败按预估记账、discard 失败、先新题后面板：`packages/application/test/real-memory-eval-service.unit.test.ts`
- 标记残留、样本过期、关评测也清理、临时文件删除：`apps/agent-service/test/production-real-eval.unit.test.ts`
- 表结构与退役：`packages/persistence-sqlite/test/real-eval.contract.test.ts`
- 真实 SQLite/检索、worker/direct 两条路径：`test/integration/real-memory-eval.test.ts`
- 删除记忆连带删题和题干：`test/integration/sqlite-governed-deletion.test.ts`
- 导出不含题库：`test/integration/data-export.test.ts`
- 启动校验：`packages/platform-node/test/startup-configuration.unit.test.ts`
- 提示词解析器契约：`apps/agent-service/test/prompt-output-contracts.unit.test.ts`

反向用例确实针对行为：去掉“只出已确认记忆”会让集成测试失败；超过上限会断言 `budget_exceeded` 且不再调用；非 openai-completions/不允许 sensitive 的模型会启动失败；删除记忆后题干计数为 0。**缺口**：没有“in-progress 文件损坏”的反向用例，也没有“prepare/release 失败后 payload 被释放”“discard 失败后无孤儿 payload”“双进程不超额”的测试。

**4. 每个新值两端是否都能接受？逐个核对结果**
- `mode`：`off/once/weekly` ↔ `REAL_EVAL_MODES` ↔ 迁移无此字段 ↔ `dueRealEvalTrigger`，一致。
- `trigger`：`weekly/manual` ↔ `REAL_EVAL_TRIGGERS` ↔ 迁移 CHECK ↔ 标记校验，一致。
- `outcome`：`completed/budget_exceeded/failed` ↔ 迁移 CHECK，一致。
- `kind`：`fact/preference/time/abstain` ↔ `REAL_EVAL_ITEM_KINDS` ↔ 迁移 CHECK，一致。
- `retired_reason`：六个值在 `REAL_EVAL_RETIRE_REASONS` 与迁移 CHECK 完全一致。
- `prompt_sha256`：服务生成 64 位小写 hex，`SqliteRealEvalOperations` 用 `/^[0-9a-f]{64}$/`，迁移 `length=64`，一致。
- `created_at/retired_at/started_at/finished_at`：服务用 `clock.now()`/`startedAt`，存储层 `instant()` 要求规范 ISO，迁移有 GLOB 校验，一致。
- `memory_revision>=0`：两端一致。
- `capMicros`：生产者写 `remaining` 为正安全整数；读取端只要求安全整数，**接受负数**（见第 7 条），这是唯一明显薄弱的两端校验。
- `modelRef`：配置要求 `openai-completions` 且 private+sensitive；`proactiveModel` 实际还会再校验 openai-completions/private，一致。
- `declined` 键 `memoryId@revision`：生产和读取都在服务层，格式一致；`memoryId` 含 `@` 也不会改变“最后一个 `@` 前是 id、后是 revision”的语义。
- 样本文件名中的 `runId`：生产 `ids.next` 安全，但代码没有对文件名做校验（推测风险，见上）。

---

**建议优先级**：先修第 1 条（否则一次崩溃可能让评测停一周以上），再修第 2、3 条（隐私残留），然后决定第 4 条是否要支持多进程；其余作为低成本加固和文档修正。
