## 结论

主体实现与作者大部分说法一致，round 7 的三处修改（标记按 runId 去重、`undiscarded` 扫全部近期运行、关着评测也清标记）方向正确，未发现“误删已被题库收下的题干”或“runId 与服务内 newId 冲突”的问题。但发现若干错误路径、资源与推进性问题，其中两条会影响评测能否持续产出。

说明：受工具限制，本次只读代码与 diff，未运行任何测试；测试是否通过、提示词清单的 sha256 是否匹配均**未核实**。

## 问题清单（严重度从高到低）

### 1.【中高·读代码证实】单条记忆读取/解密出错会让整轮失败，而且下周会再次撞上同一条

- 文件:行：`packages/application/src/services/real-memory-eval-service.ts:251-256`、`391-401`；`packages/application/src/services/real-memory-eval.ts:60-69`
- 问题：出题循环里 `readMemoryText` / `readQuote` 没有逐条兜底。任意一条记忆的 payload 解密抛错（密钥轮换、payload 损坏、`TextDecoder` fatal），会直接冲出循环进入外层 `catch`，整轮记为 `failed`。该记忆仍然 `active`、`eligibleForQuestions` 通过、没有题、也不在 `declined` 里，所以下一次运行 `pickNewMemories` 仍会选中它，再次失败。若它排在候选前面（按 id 排序），评测会永久失败；如果前面已经做了若干出题调用，还会每天重复花这部分钱，直到 7 天额度耗尽。
- 证据：
  ```ts
  251: const text = await deps.readMemoryText(memory);
  252: const quote = await deps.readQuote(memory);
  ...
  253: if (text === undefined || quote === undefined) {
  254:   rejected["source_missing"] = ...;
  255:   continue;
  256: }
  ```
  ```ts
  391: } catch (error) {
  ...
  399:   outcome = "failed";
  400:   failure = error instanceof Error ? error.name : "unknown";
  401: }
  ```
  以及 `real-memory-eval.ts:66-69` 的选择只看 `!banked && eligibleForQuestions(...) === null`。
- 建议：对每条记忆的读取单独 `try/catch`，把失败计数并把该 memory@revision 记入 `declined`（或单独的跳过集合），保证一条坏记忆不会让整轮评测停摆；补一条反向测试。

### 2.【中·读代码证实】`source_missing` 不记 `declined`，会一直占满每轮新题名额，饿死后面的记忆

- 文件:行：`packages/application/src/services/real-memory-eval-service.ts:245-256`、`60-69`、`265-266`
- 问题：`pickNewMemories` 先按 id 排序截取 `newMemoriesPerRun` 条，之后再发现原话/正文缺失。`source_missing` 只加计数，不加入 `declined`。于是这些缺原话的记忆每周仍会被选中、仍占名额；如果它们 id 较小，后面的可用记忆永远轮不到。ADR 只说“取不到原话的记忆不出题”，没说要让它们挤掉其他记忆。
- 证据：
  ```ts
  245: for (const memory of pickNewMemories(candidates, banked, startedAt, limits.newMemoriesPerRun)) {
  251:   const text = await deps.readMemoryText(memory);
  252:   const quote = await deps.readQuote(memory);
  253:   if (text === undefined || quote === undefined) {
  254:     rejected["source_missing"] = ...;
  255:     continue;
  256:   }
  ```
  `declined.push` 只出现在模型拒绝/丢弃和 `already_banked` 分支（265-266、302-303）。
- 建议：把“源缺失”的 memory@revision 记入 `declined`，或在 `pickNewMemories` 之前先判断正文/原话可得性，避免不可用记忆消耗名额；补一条“前 N 条都缺原话时后面的记忆仍能出题”的测试。

### 3.【中·读代码证实，触发条件为推测】未来时间的进行中标记永不过期，并会永久阻塞评测

- 文件:行：`apps/agent-service/src/production-real-eval.ts:45-47`、`97-123`、`150-157`
- 问题：`inProgressRun` 只校验 `startedAt` 是规范 ISO，不要求它不晚于 `now`。`startedWithin` 对未来的 `startedAt` 计算 `now-startedAt` 为负，永远 `< 24h`，于是 `dueRealEvalTrigger` 一直返回 `null`；同时过期判断 `now-startedAt >= 7d` 对负数永远为假，该标记永远不会被删。一个损坏或恶意写入未来时间的标记会让评测永久停摆。`capMicros` 同样只校验 `>=0`、未与周上限比较。
- 证据：
  ```ts
  45: function startedWithin(run, now, windowMs) {
  46:   return Date.parse(now) - Date.parse(run.startedAt) < windowMs;
  47: }
  ```
  ```ts
  109: typeof value.startedAt !== "string" ||
  110: !Number.isFinite(Date.parse(value.startedAt)) ||
  111: new Date(value.startedAt).toISOString() !== value.startedAt ||
  ...
  151: if (recordedRunIds.has(run.runId) ||
  152:   Date.parse(now) - Date.parse(startedAt) >= REAL_EVAL_INTERVAL_MS) {
  ```
- 建议：拒绝 `startedAt > now + 少量容差` 的标记（按“读不懂”处理，取 mtime，并且 mtime 也钳到 `now`），并把 `capMicros` 钳到 `weeklyCapMicros`；补一条未来标记的反向测试。

### 4.【中低·读代码证实】旧版本标记缺 `runId` 会被当成“读不懂”，升级后可能白吃整周上限

- 文件:行：`apps/agent-service/src/production-real-eval.ts:104-122`、`144-149`
- 问题：round 6 及以前的标记只有 `startedAt/trigger/capMicros`，没有 `runId`。round 7 把 `runId` 设为必填后，这些旧标记会被 `inProgressRun` 判为读不懂，回退成 `capMicros = weeklyCapMicros`。如果升级时状态目录里正好残留一个旧标记，评测会被按“已花光整周 0.5 美元”处理，最长停 7 天。ADR 只说“读不懂的标记按整周上限”，没有提这个版本迁移后果。
- 证据：
  ```ts
  107: typeof value.runId !== "string" ||
  108: value.runId.length === 0 ||
  ...
  144: const run = inProgressRun(text) ?? {
  145:   runId: "",
  146:   startedAt: new Date(found.mtimeMs).toISOString(),
  ...
  148:   capMicros: weeklyCapMicros,
  149: };
  ```
- 建议：要么兼容缺 `runId` 的旧标记（按可读标记处理并只用于到期），要么在发布说明/ADR 明确“升级前清一次状态目录”；补一张“旧格式标记”的测试。

### 5.【低·读代码证实】`once` 模式下 `budget_exceeded` 之后永不重跑

- 文件:行：`apps/agent-service/src/production-real-eval.ts:61-70`
- 问题：`once` 只看“是否存在任意一条 `trigger === "manual"` 且 `outcome !== "failed"` 的运行”，没有时间窗口。`budget_exceeded`（以及 `completed`）都算非失败，因此一旦 once 第一轮因额度用完停下，即使 7 天后 7 天累计降下来，也永远不会再跑；它也不会像 `failed` 那样隔一天重试。ADR 只写了“失败隔一天重试”，没有明确 `budget_exceeded` 在 once 下是否应该等 7 天再补跑。
- 证据：
  ```ts
  61: if (runs.some((run) => startedWithin(run, now, REAL_EVAL_RETRY_MS))) return null;
  62: if (mode === "once")
  63:   return runs.some(({ trigger, outcome }) => trigger === "manual" && outcome !== "failed")
  64:     ? null
  65:     : "manual";
  ```
- 建议：若 once 的语义是“跑完一轮”，应把 `budget_exceeded` 也视为未完成，按额度窗口允许重跑；若是有意“只尝试一次”，在 ADR 里写明。

### 6.【低·读代码证实】ADR 说“一点”后有“几分”才算钟点，代码没有这个分支

- 文件:行：`packages/application/src/services/real-memory-eval.ts:128-135`；`docs/adr/0219-real-memory-eval-sets.md:54`、`:90`
- 问题：ADR 写“‘一点’只在前面有‘下午’这类时段词、或后面跟着‘钟’‘整’‘半’‘几分’时才算钟点”。代码的 `AFTER_HOUR` 只匹配 `钟|鐘|整|半|数字+分`，`几` 不在字符类里。因此“一点几分”不会被识别为钟点，日期泄题检查会漏掉这种写法。
- 证据：
  ```ts
  128: const PART_OF_DAY = /(凌晨|早上|...|午夜)\s*$/u;
  129: const AFTER_HOUR = /^\s*(钟|鐘|整|半|[0-9〇零一二三四五六七八九十]+\s*分)/u;
  130: function oneMeansHour(text, start, end) {
  131:   return PART_OF_DAY.test(text.slice(Math.max(0, start - 4), start)) ||
  132:     AFTER_HOUR.test(text.slice(end));
  133: }
  ```
- 建议：把 `几\s*分` 加入 `AFTER_HOUR`（或按 ADR 改为更明确的时刻词表），并同步 casebook 的措辞；补“一点几分”的反向测试。

### 7.【低·读代码证实】抽查样本包含记忆正文和原话原文，只有 egress 规则遮盖，不是“把记忆正文遮掉”

- 文件:行：`apps/agent-service/src/production-real-eval.ts:332-344`；`apps/agent-service/src/production-gap-export.ts:89-91`
- 问题：样本的 `question/response/quote/memory` 四个字段都只经过 `maskForExport`（即 `redactForEgress`）。它只遮银行卡、密码、邮箱等可识别值，普通记忆正文和人名、地址等仍以明文写入 `latest-sample.json`。文件权限 0600、目录 0700，且不在仓库里，符合“真实内容不进仓库”；但“遮盖后的样本”容易被理解成正文也被遮掉，与实现不完全一致。被删记忆在样本里最多再留 7 天（服务不跑则更久），这一点 ADR 已承认。
- 证据：
  ```ts
  336: items: report.sample.map((item) => ({
  ...
  340:   question: maskForExport(item.question),
  341:   response: maskForExport(item.response),
  342:   quote: maskForExport(item.quote),
  343:   memory: maskForExport(item.memory),
  344: })),
  ```
  ```ts
  89: export function maskForExport(text: string): string {
  90:   return redactForEgress(text).text;
  91: }
  ```
- 建议：把 ADR/案例的“遮盖”改成“按出口规则遮盖敏感值，正文仍可见（文件 0600）”；如果安全要求是“样本不含正文”，应只写题干和判分、不写 `memory/quote`，或对正文做全量脱敏。

### 8.【低·推测】退役题与唯一键冲突时，同一版本记忆无法再出题

- 文件:行：`packages/persistence-sqlite/src/sqlite-real-eval-operations.ts:126-145`；`packages/application/src/services/real-memory-eval-service.ts:300-303`
- 问题：唯一键是 `(memory_id, memory_revision, kind)`，`ON CONFLICT DO NOTHING` 不区分退役与否。若某记忆因 `tentative`/`inactive`/`expired` 退役后又回到可出题状态、但 revision 没有变，则重新出题时插入因旧的退役行冲突而返回 `false`，服务把该版本记入 `declined`，以后不再问。是否会遇到取决于状态变化是否总伴随 revision 递增；我没有核实所有状态写入路径。
- 建议：明确“退役行是否允许同一 revision 重新插入”；若允许，唯一键应包含 `retired_at IS NULL` 的部分索引，或插入时先检查现有行状态。

### 9.【低·读代码证实】报告脚本不按 owner/agent 过滤

- 文件:行：`scripts/operations/real-eval-report.mjs:29-35`
- 问题：`readRuns` 直接 `SELECT ... FROM real_eval_runs ORDER BY ...`，没有 `WHERE owner_id = ? AND agent_id = ?`。若一个数据库里有多位主人/代理，报告会把不同 scope 的运行混在一起，趋势和费用数字会失真（不是越权读取，脚本本来就要求数据库文件访问权）。
- 建议：脚本增加 `--owner/--agent` 或从运行参数读取 scope 过滤；至少要在帮助里写明当前是“全库汇总”。

## 侧重检查

- **错误路径**：逐条记忆读/解码抛错会让整轮失败且不会推进（问题 1）；`addQuestion`/`storeQuestion`/`retireQuestion` 抛错会记 `failed`，marker 保留，属预期；`discardQuestion` 失败有 `undiscarded` 兜底。已确认 `discardQuestion` 底层 `deletePayload` 对不存在的 ref 返回 `false` 而不是抛错（`sqlite-durable-operations.ts:1778-1785`），所以 round 7“重复删全部编号”不会因为“已删过”而失败。
- **不合规范/不可信输入**：题干有长度、字符、JSON、泄题、敏感值检查；模型输出超 64KB 会失败；花费缺失/小数/负数报 `COST_INVALID`；标记文件是本地不可信输入，已发现“未来 `startedAt` 永不过期”（问题 3）和“旧格式标记被当读不懂”（问题 4）。另外 `RealEvalRunLimits.runId` 未校验长度/字符，生产端固定为 `real-eval-run:<uuid>`，目前安全，但未来若由外部传入 `runId`，它会被拼进样本临时文件名（`writeRealEvalSample` 的 `${file}.${report.runId}.tmp`），存在路径穿越面。
- **安全/隐私**：`real_eval_runs.summary` 只含分数、计数、记忆编号/版本、payload ref、错误名，未见正文；样本文件含正文但 0600/0700，见问题 7；错误记录只用 `error.name`，没有错误文字；题干预设加密 payload，删除记忆走治理删除并清理题干（`sqlite-governed-deletion.ts:884-890`），测试也覆盖了。
- **资源耗尽**：7 天累计受 `weeklyCapMicros` 上限 500000 控制；`listRuns` 限 520；`undiscarded` 若长期删不掉会在线性增长（每次运行把旧编号继续带下去），但只有持续删除失败才会发生，且不会无限新增 refs；未来时间标记会让评测永久停摆（问题 3）是更现实的可用性风险。
- **不可撤销操作**：删除 `undiscarded` 的题干 payload 是删除操作，但它们从未成功入题库（`addQuestion` 返回 `false` 才会进 `undiscarded`），且 SQLite 删除不存在的行是空操作，未发现误删已入库题干。
- **规则/文档与代码一致**：ADR 0219 第 2 条、第 6 条与实现总体一致；发现“几分”不一致（问题 6）。案例 87 与代码总体一致，但写“决策评测三类”（代码是 5 个 group，归为主动提醒/记忆/整理三类可以解释）；“第 0 层 126 条、`npm run check` 48 步、4 轮复核”这类历史数字未核实，且当前复核轮次已超过文中“共 4 轮”。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   **不会。** 本改动只新增独立的评测调用，没有改对话的系统提示、工具定义或已存历史。评测 prompt 都是“`REAL_EVAL_*.text` 固定指令 + `\n` + `JSON.stringify(本次数据)`”：`questionPrompt`/`judgePrompt`/`answerPrompt` 均如此（`real-memory-eval.ts:174-179`、`248-281`）。每次会变的值（`now`、记忆、问题、回答）都在后半段 JSON 里，`answerPrompt` 的 `now` 还是 JSON 的最后一个键；没有把时间/记忆塞进固定指令。`production-model-composition.ts` 的 `proactiveModel` 只增加可选 `purpose`（默认仍 `mail-judgment`）和在申请密钥失败时释放 prompt payload，不改变发出去的内容；`production-run-memory.ts` 只是给 `MailEmbeddingContext` 增加可选 `dataClassification`，不影响模型请求。提示词目录新增文本只进入 `TRUSTED_PROMPT_TEXTS`，不会改写老对话里冻结的旧文本。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   **模型请求里没有引入新的不确定字节。** 三个 prompt 的 JSON 键顺序是代码里写死的；题目/记忆数组来自有序查询或显式排序（`sqlite-real-eval-operations.ts` 的 `ORDER BY`、`pickNewMemories` 的 `toSorted`）；没有把无序 `Set` 直接序列化进模型 prompt。唯一会变的 `now` 放在追加数据里，符合“每轮会变的值在最后”。**未核实**的部分：出口遮盖的完整确定性我只读了 `redactForEgress` 的一段；新增固定提示词清单的 sha256 无法在本环境重新计算。数据库 `summary` 里的 `undiscarded` 由 `Set` 展开，顺序依赖运行记录顺序，但这是落库元数据，不发给模型。

3. **有没有对应的自动检查？反向用例真的会失败吗？**
   有，覆盖面较好：
   - 费用：`packages/application/test/real-memory-eval-service.unit.test.ts:420-425`（失败调用按预估记账）、`:427-432`（检索额度不够不检索）、`:468-479`（停在额度内）、`:481-492`（实际费用大于预估立刻停）、`:494-500`（检索费计入）。
   - 退役/出题/丢弃：`:312-337`（改版退役）、`:339-357`（泄题版本不再问、改版后重新问）、`:359-400`（未入库删题干、删失败带入下次、只删最近一次的反向用例）。
   - marker/定时器：`apps/agent-service/test/production-real-eval.unit.test.ts:401-435`（tick 不并发）、`:478-529`（未记录运行按花光额度）、`:531-566`（读不懂标记按整周上限）、`:568-601`（旧标记不覆盖）、`:603-648`（已有同 runId 记录则跳过并删标记）、`:650-681`（关着评测也清样本/标记）。
   - 删除/导出/配置：`test/integration/sqlite-governed-deletion.test.ts`、`test/integration/data-export.test.ts`、`packages/platform-node/test/startup-configuration.unit.test.ts:1465-1551`、`packages/persistence-sqlite/test/real-eval.contract.test.ts`。
   从断言看反向用例确实会失败（例如把“按最新一次运行读 undiscarded”改回旧逻辑，`:373-400` 会失败）。**未实测**：本环境不能运行测试。**缺口**：没有 `source_missing` 占满名额（问题 2）、未来时间标记（问题 3）、`once + budget_exceeded`（问题 5）的反向用例。

4. **改动产生/修改的每个值，两端都能接受吗？**
   - **`runId`（marker ↔ `real_eval_runs.id` ↔ 样本）**：生产端生成 `real-eval-run:<uuid>`（`production-real-eval.ts:418`），同时传给 marker 和服务（`:419-424`）；服务端 `limits.runId ?? newId()`（`real-memory-eval-service.ts:170`）用它写运行记录和样本。DB 只要求 `length(id) BETWEEN 1 AND 128`（`0088_real_eval.sql:28`），长度满足；marker 端要求非空字符串（`production-real-eval.ts:107-108`）也满足。服务内 `newId()` 仍只用于题目 id、payload ref、invocationId，与 runId 无关，未发现互撞。
   - **`weeklyCapMicros` 传 0（评测关着时）**：`RealEvalSampleExpiry` 调 `readUnfinishedRealEvals(dir, now, 0)`（`production-real-eval.ts:207`）。0 只用于“读不懂的标记”的回退 `capMicros`，而该调用的返回值被丢弃，所以没有实际副作用；没有发现会把整周上限改成 0 的路径。
   - **`undiscarded` 重删全部近期编号**：不会误删已入题库的题干。只有 `addQuestion` 返回 `false` 或抛错才会进 `undiscarded`（`real-memory-eval-service.ts:290-303`），成功入库的 ref 不会进这个列表；同一 ref 只由 `storeQuestion` 新生成，不会复用。重复删已删的 ref 是空操作（`sqlite-durable-operations.ts:1778-1785`）。窗口是最近 520 次运行；只要运行记录还能写、失败编号会随每次运行继续带下去，就不会丢；运行记录本身写不进去时会丢，ADR 已承认。
   - **`purpose: "other"`**：在 `MODEL_USAGE_PURPOSES` 里（`packages/application/src/ports/model-usage.ts:3-12`），默认路径仍为 `mail-judgment`（`production-model-composition.ts:516`），旧调用方行为不变。
   - **配置键/迁移/清单**：`runPolicy.realEval` 的字段在 `strict-configuration.ts:1104-1128`、`:1149`、`:1186`、`:1476-1500` 两端都有校验；迁移 88 同时登记在 `migration-engine.ts`、`schema-catalog.ts`、`workspace-lifecycle-audit.mjs` 和多处迁移测试的 `currentSequence` 中；题目字段与 `0088_real_eval.sql` 的 CHECK 基本对齐（`kind` 含 `abstain`，退役原因与 `REAL_EVAL_RETIRE_REASONS` 一致）。**未核实**：`prompt-manifest.json` 里的 sha256 是否与新提示词文本一致。
   - **决策分组**：`DECISION_EVAL_GROUPS` 的 5 个名字都在 `CALIBRATION_GROUPS` 里，`summarizeDecisions` 能产出对应 `rated/useful`；报告脚本不消费 `decisions`，不影响展示。
