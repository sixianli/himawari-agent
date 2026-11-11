## 侧重检查（先说我查了哪些错误路径/不可信输入/安全/资源/文档）
- **错误路径**：退役题删题干、`addQuestion` 返回 false/抛错、模型失败、`recordRun` 失败、预算耗尽。结论：退役删题干在真实 SQLite 上会违反外键；其余问题见下。
- **不可信输入**：模型生成的题干、`abstainQuestion`、判分输出、日期/数字泄题检查、敏感值检查、`now` 字段。结论：解析总体严格，日期检查有漏网格式。
- **安全/隐私**：抽查样本文件权限、样本内容、运行 summary、错误记录、题干 payload 删除、导出清单。结论：summary/错误只含计数与标识；样本文件仍含记忆正文/原话（仅做已知模式遮盖），且删除记忆后不立即清除。
- **资源耗尽**：预算硬上限、嵌入费用、题目/run 数量增长、输出大小。结论：嵌入费用入账但不预留；失败调用费用可能完全不入账；`listQuestions` 无上限地随历史增长。
- **不可撤销操作**：删题干 payload、删抽查样本、删记忆级联。结论：退役删题干与表结构冲突；样本只按 mtime 过期。
- **规则/文档一致性**：ADR 0219、`.claude/rules/prompt-prefix.md`、作者说法。结论：prompt 前缀规则满足；“只存数字”已与 ADR/代码不一致；“题退役时删 payload”实际做不到。

---

## 发现（按严重度）

### 高：题退役时删题干 payload 会撞 `ON DELETE RESTRICT`，导致运行失败且 payload 永久残留
- **文件:行**：`packages/persistence-sqlite/src/migrations/0088_real_eval.sql:8`；`packages/persistence-sqlite/src/sqlite-real-eval-operations.ts:148-158`；`packages/application/src/services/real-memory-eval-service.ts:190-196`；`apps/agent-service/src/production-real-eval.ts:335-337`；`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1778-1784`
- **问题（读代码证实）**：退役只把 `retired_at` 更新到行上，行仍然存在；随后 `discardQuestion` 走 `payloads.delete`，物理 `DELETE FROM payloads`。但 `real_eval_questions.question_ref` 是 `NOT NULL ... REFERENCES payloads(ref) ON DELETE RESTRICT`，SQLite worker 又执行 `PRAGMA foreign_keys = ON`，所以删除被引用的 payload 会立刻报外键错误。结果是：每次有题退役，`discardQuestion` 抛错，整个 run 被记成 `failed`，题干 payload 留在库里；下一轮该题已 `retired_at` 非空会被跳过，payload 再也不会被删，直到记忆本身被治理删除。
- **证据**：
  - ``question_ref TEXT NOT NULL UNIQUE REFERENCES payloads(ref) ON DELETE RESTRICT,``（0088:8）
  - ``UPDATE real_eval_questions SET retired_at = ?, retired_reason = ? WHERE id = ? ... AND retired_at IS NULL``（`sqlite-real-eval-operations.ts:153-158`），没有删行
  - ``await deps.store.retireQuestion(...); await deps.discardQuestion(question.questionRef);``（`real-memory-eval-service.ts:190-196`）
  - ``discardQuestion: async (ref) => { await deps.payloads.delete(ref as PayloadRef); }``（`production-real-eval.ts:335-337`）
  - ``.prepare("DELETE FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?")``（`sqlite-durable-operations.ts:1781-1783`）
  - ``database.pragma("foreign_keys = ON");``（`sqlite-worker.ts:120`）
- **为什么测试没抓到（读代码证实）**：集成测试的 `discardQuestion` 只删内存 Map，不删 `payloads` 表：``discardQuestion: async (ref) => { resource.content.values.delete(ref); }``（`test/integration/real-memory-eval.test.ts:282-284`）。没有任何测试用真实 payload 存储执行“退役后删 payload”。
- **建议**：二选一并在迁移/端口层落实：① 退役时删除题目行（可另建审计表只存计数/标识），再删 payload；② 把 `question_ref` 改为可空并 `ON DELETE SET NULL`，退役后保留行但断开 payload 引用。无论哪种，都补一条使用真实 `SqliteProductStateRepository`/真实 payload store 的反向测试：记忆版本变化 → 题退役 → `payloads` 行与题干文件都不存在，且 run 不是 `failed`。

### 中高：7 天费用上限只统计“已成功回报”的费用，失败/中断调用可能完全不计费
- **文件:行**：`apps/agent-service/src/production-real-eval.ts:48-52`、`149-160`；`apps/agent-service/src/production-real-eval.ts:252-256`
- **问题（读代码证实）**：`realEvalSpentMicros` 只累加 `real_eval_runs.cost_micros`，而 `createRealEvalModel.generate` 只在收到 `model.completed` 时才取出 `event.costMicros`；`model.failed`、超时、`OUTPUT_TOO_LARGE`、`MODEL_NOT_COMPLETED` 都直接抛错，`costMicros` 保持 0，`service.run` 不会调用 `budget.record`。于是“最近 7 天所有运行”实际是“最近 7 天所有**成功回报费用**的运行”。如果供应商在失败/超时调用上仍计费，反复失败可以持续花钱而 7 天窗口看不到，下一次 tick 的 `remaining` 仍然很大。
- **证据**：
  - ``costMicros = Number.isSafeInteger(event.costMicros) ? Math.max(0, event.costMicros) : 0; completed = true;``（`production-real-eval.ts:149-152`）
  - ``if (failure !== null) throw new RealEvalModelError(failure); if (!completed) throw new RealEvalModelError("MODEL_NOT_COMPLETED");``（`production-real-eval.ts:159-160`）
  - ``.filter((run) => startedWithin(run, now, REAL_EVAL_INTERVAL_MS)) .reduce((total, { costMicros }) => total + Math.max(0, costMicros), 0);``（`production-real-eval.ts:48-52`）
- **建议**：失败/超时/中断时至少把本次的预估费用（或“未知费用”按预估上限）记入 `budget.spentMicros` 和运行记录；或者在 `recordRun` 中单列 `unreportedCostMicros` 并计入 7 天累计。另加反向测试：模型在 `model.failed` 前已产生费用时，下一轮 `remaining` 必须减少。

### 中高：嵌入（检索）费用没有预估/预留，单次检索可以先花钱再发现超限
- **文件:行**：`packages/application/src/services/real-memory-eval-service.ts:282-284`；`packages/application/src/services/real-memory-eval.ts:341-347`；`apps/agent-service/src/production-run-memory.ts:210、213`
- **问题（读代码证实）**：模型调用前有 `budget.reserve(estimate)`，但检索只做了 `budget.ensureRemaining()`（检查“当前已花 < 上限”），然后直接执行 `recall`，事后才 `record(recall.costMicros)`。如果检索本身费用大于剩余额度，调用照样发生，`record` 事后才抛 `RealEvalBudgetExceededError`，实际支出已超过上限。作者说“嵌入费用也记进同一笔账”是对的，但“挡住”不成立：它没有在检索前把检索费用预留。
- **证据**：
  - ``budget.ensureRemaining(); const recall = await deps.recall(questionText); budget.record(recall.costMicros);``（`real-memory-eval-service.ts:282-284`）
  - ``ensureRemaining(): void { if (this.#spentMicros >= this.#limitMicros) throw ... }``（`real-memory-eval.ts:341-343`）
  - ``mail.costMicros += actualCostMicros;`` / ``mail.costMicros += descriptor.estimatedCostMicros;``（`production-run-memory.ts:210、213`）
- **建议**：给检索也提供 `estimateMicros`/上限（例如按 `embeddingAdmissionDescriptor.estimatedCostMicros` 预留），检索前 `reserve(estimateRecall)`，结束后按实际 `record`；或把检索费用纳入“一次调用的最大可能费用”，在 `remaining <= estimateRecall` 时直接不检索。

### 中：`addQuestion` 返回 false 时既不记为 declined，也不删旧行，可能每周重复出题、重复花钱
- **文件:行**：`packages/application/src/services/real-memory-eval-service.ts:205-214`、`253-267`；`packages/persistence-sqlite/src/sqlite-real-eval-operations.ts:122-145`、`148-158`
- **问题（读代码证实 + 条件性推测）**：`addQuestion` 用 `ON CONFLICT (memory_id, memory_revision, kind) DO NOTHING` 返回 false；退役只更新行、不删行。于是同一 `(memory, revision, kind)` 一旦有过题（哪怕已退役），在 revision 不变的情况下再次入库一定 false；而 false 分支只 `discardQuestion`，**不把该记忆版本写入 `summary.declined`**。下一轮它仍然不是 banked、也不在 skip 集合里，会再次调用模型出题、再次 false，形成“每次运行都为同一条记忆付一次出题费但题库不增加”。这条路径是否常见取决于“记忆重新变为可出题状态时 revision 是否会变”（未完全核实）；但只要某次 false 是持久性的，就会反复花钱。
- **证据**：
  - ``const candidates = memories.filter((record) => !skip.has(declinedKey(record.id, record.revision)));``（`real-memory-eval-service.ts:205-207`）
  - ``let stored = false; try { stored = await deps.store.addQuestion(...); } finally { if (!stored) await deps.discardQuestion(questionRef); } if (stored) { added += 1; ... }``（`real-memory-eval-service.ts:253-267`）——false 时没有 `declined.push`
  - ``ON CONFLICT (memory_id, memory_revision, kind) DO NOTHING``（`sqlite-real-eval-operations.ts:130`）
  - 退役只更新：``UPDATE real_eval_questions SET retired_at = ?, retired_reason = ? ...``（同文件 155-157）
- **建议**：addQuestion 返回 false 时，要么把该 `memoryId@revision` 记入 `declined`（并区分“重复/已退役”与“暂时失败”），要么删除/替换旧退役行；至少加一个测试：同一 revision 的题退役后再次达到出题条件，不应每轮重复调用出题模型。

### 中：所有“被拒”都永久跳过 520 次运行，包含暂时的解析失败/缺原话
- **文件:行**：`packages/application/src/services/real-memory-eval-service.ts:227-230`、`122-136`、`202-207`；`packages/application/src/services/real-memory-eval.ts:170-176`
- **问题（读代码证实）**：`QuestionRejection` 包含 `response_invalid`（模型输出不是合法 JSON）和 `source_missing`；代码对**所有** `"rejected" in generated` 都执行 `declined.push(declinedKey(...))`。而 `declinedFromRuns` 会把最近 520 次运行的 `summary.declined` 当作永久跳过集合。一次临时的模型输出格式错误，或一次暂时读不到原话，会让这条记忆版本在之后 520 次运行（weekly 下接近十年）都不再被问；与作者“拒绝过的同一版本记忆以后不再问”的字面一致，但会把瞬态错误当成永久结论。
- **证据**：
  - ``if ("rejected" in generated) { rejected[...] += 1; declined.push(declinedKey(memory.id, memory.revision)); continue; }``（`real-memory-eval-service.ts:227-230`）
  - ``export type QuestionRejection = "response_invalid" | "declined" | ... | "sensitive";``（`real-memory-eval.ts:170-176`）
  - ``if (text === undefined || quote === undefined) { rejected["source_missing"] += 1; continue; }``（`real-memory-eval-service.ts:217-220`）
- **建议**：只把模型明确拒绝（`declined`）和确定性丢弃（`leak`、`sensitive` 等）写入永久 skip；`response_invalid`、`source_missing` 这类可恢复错误按运行失败/退避处理，或设置较小的重试次数。

### 中：抽查样本文件删除记忆后不立即清除，且只在定时器运行时按 mtime 过期
- **文件:行**：`apps/agent-service/src/production-real-eval.ts:36`、`72-81`、`175-199`、`223-228`、`248`
- **问题（读代码证实）**：样本文件包含 `memory`、`quote`、`question`、`response`（仅 `maskForExport` 遮盖已知敏感模式）。它不跟记忆删除联动；`expireRealEvalSample` 只在 `#tick` 里、按文件 mtime 超过 7 天才删。`start()` 在 `mode === "off"` 时直接返回，服务未运行/停用期间不会执行过期检查，所以被删记忆的正文/原话可能无限期留在 `real-eval/latest-sample.json`。ADR 第 90 行说“最多在这个文件里多留 7 天”，只在服务持续运行且模式非 off 时成立。
- **证据**：
  - ``const body = { ... items: report.sample.map((item) => ({ ..., question: maskForExport(item.question), response: maskForExport(item.response), quote: maskForExport(item.quote), memory: maskForExport(item.memory) })) }``（`production-real-eval.ts:183-195`）
  - ``if (!found || Date.parse(now) - found.mtimeMs < REAL_EVAL_SAMPLE_TTL_MS) return false; await rm(file, { force: true });``（`production-real-eval.ts:78-79`）
  - ``start(): void { if (this.#timer || this.#options.configuration.mode === "off") return; ... }``（`production-real-eval.ts:223-224`）
- **建议**：在治理删除记忆时顺带删除/重建 `latest-sample.json` 中相关条目；或把样本按运行目录分文件并在删除记忆时清理；如果做不到，至少在文档中明确“清理由下一次运行触发，模式 off 时样本会保留”，并考虑设置更短的 TTL 或启动时强制清理。

### 低：运行结果“只存数字”的说法与代码/ADR 不一致
- **文件:行**：`packages/application/src/services/real-memory-eval-service.ts:359-371`；`packages/persistence-sqlite/src/sqlite-real-eval-operations.ts:192`；`docs/adr/0219-real-memory-eval-sets.md:53`
- **问题（读代码证实）**：`summary` 含 `declined` 数组，元素是 `memoryId@revision` 字符串，还含 `failure` 错误名；`real_eval_runs` 还有 `model`、`trigger`、`outcome`。这不是“只存数字”。ADR 第 53 行已改成“只记分数、计数和标识（…记忆编号和版本、错误名）”，说明 ADR 已承认；但本次材料约束与作者旧说法“运行结果表只存数字”已不成立。
- **证据**：``declined, ...(failure === null ? {} : { failure })``（`real-memory-eval-service.ts:370-371`）；``JSON.stringify(run.summary)``（`sqlite-real-eval-operations.ts:192`）
- **建议**：统一说法：要么把记忆编号视为允许的“标识”，更新材料约束；要么把 `declined` 改成计数/哈希，不存原始 id。

### 低：日期泄题检查漏掉 `7:00` 这类冒号时间，`百/千` 中文数字也不识别
- **文件:行**：`packages/application/src/services/real-memory-eval.ts:128-139`
- **问题（读代码证实）**：`dateTokens` 只匹配“数字 + 年月日号点/时”，不匹配 `7:00`、`12/3` 等格式；`chineseNumber` 只处理 `十` 和个位数字，不处理 `百/千`。因此源记忆写 `7:00`、题干写“七点”时不会被判泄题（现有测试之所以通过，是因为测试源里同时写了“七点”）。这只会漏判、让分数偏高，不会误伤。
- **证据**：``matchAll(/([0-9〇零一二两三四五六七八九十]+)\s*([年月日号號点點时時])/gu)``（`real-memory-eval.ts:132`）；`CHINESE_DIGITS` 不含 `百/千`（91-104）。
- **建议**：把 `:` 时间和 `\d+[/-]\d+` 纳入日期 token；至少补一条“源只有 `7:00`、题干问七点”的反向用例。

### 低：`once` 模式下 `budget_exceeded` 被视为已完成，之后不再重试
- **文件:行**：`apps/agent-service/src/production-real-eval.ts:61-64`
- **问题（读代码证实）**：`once` 只把 `outcome === "failed"` 视为未完成；`budget_exceeded` 也算“有 manual 运行”而返回 null。若首次 manual 运行因为 7 天累计额度已被别的运行用掉而 `budget_exceeded`，即使之后额度回滚也不会再跑。是否符合预期需要确认；若 `once` 的语义是“跑成功一次”，这里应只认 `completed`。
- **证据**：``return runs.some(({ trigger, outcome }) => trigger === "manual" && outcome !== "failed") ? null : "manual";``（`production-real-eval.ts:61-64`）
- **建议**：把 `budget_exceeded` 排除在“完成”之外，或者在 ADR 明确 once 只尝试一次。

### 低：并发只做了进程内互斥，没有跨进程/跨重启的租约
- **文件:行**：`apps/agent-service/src/production-real-eval.ts:236-243`
- **问题（推测，基于代码结构）**：`#running ??=` 能保证同一个 `ProductionRealEval` 实例的 tick 不并发；测试也覆盖了这一点。但两个服务进程（或滚动升级时新旧进程短暂并存）各自有实例和定时器，代码没有在数据库里抢运行锁，也没有检查 authority lease；`service.run` 也没有“开始前先写一条 run 占位”的幂等/租约。两进程可能同时读取同一批 runs、都判断到期、都跑一轮，费用和题目都会重复。
- **证据**：``this.#running ??= this.#tick()...``（`production-real-eval.ts:236-243`）；`#tick` 直接 `store.listRuns` + `service.run`，没有运行租约。
- **建议**：若部署允许双实例，增加数据库级运行锁/占位行（复用 authority lease），并在 `#tick` 开始前抢锁；否则在 ADR 明确“只允许单实例运行评测”。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**
不会改变已有聊天/邮件请求开头：本次改动没有改 `thread-prompt-bundles`、系统提示、工具定义或历史消息组装。评测是全新的单向请求，`questionPrompt`/`answerPrompt`/`judgePrompt` 都是“固定指令（`REAL_EVAL_*.text`）在前，本次 JSON 数据在后”（`real-memory-eval.ts:157-162、231-264`）；唯一随每轮变化的 `now` 在 `answerPrompt` 的追加 JSON 里（`real-memory-eval.ts:242`），不在固定前缀。符合 [prompt-prefix 规则](../../.claude/rules/prompt-prefix.md) 的“只追加、变化值放最后”。未发现评测调用复用聊天对话前缀，因此不涉及“已发给模型的开头被改写”。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？**
- 聊天/邮件路径：没有改动，无影响。
- 评测路径：`answerPrompt` 的 `now` 每次不同（tail 字段，允许）；`profile`/`recalled memories` 的顺序来自档案块和检索结果，属于每次请求的新数据，不是同一前缀的不同字节。遮盖是逐段文本的 `placeholderTable`/`redactForEgress`，不依赖前后文；`summary` 的 `declined` 来自最近运行集合，顺序按运行时间稳定。因此没有发现“同一段文字取决于上下文/时间/集合顺序而变成不同字节”的规则违规；但评测请求本身不是可复用前缀，故缓存收益有限。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有：预算类（`real-memory-eval.unit.test.ts` 的 record/ensureRemaining、超预估单次调用、检索额度耗尽）、日期泄题、定时器 24h/7 天、样本过期、tick 并发、先新题后固定面板、`addQuestion` false/throw 清题干、集成导出/治理删除等。
但关键反向用例缺失：**没有用真实 payload 存储验证“题退役后 payload 被删”**。单元测试的 `discardQuestion` 是假实现（`real-memory-eval-service.unit.test.ts:210-213`），集成测试的 `discardQuestion` 只删内存 Map（`test/integration/real-memory-eval.test.ts:282-284`），所以高严重度的外键冲突不会让测试失败。另外“嵌入费用导致单次超限”和“失败调用费用也要计入 7 天累计”也没有反向用例。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？逐个核对两端校验。**
大多数值两端一致：
- `kind`：应用枚举 `fact/preference/time/abstain` ↔ 迁移 CHECK（`0088:7`）一致；
- `outcome`：`completed/budget_exceeded/failed` ↔ 迁移 CHECK（`0088:33`）一致；
- `trigger`：`weekly/manual` ↔ 迁移 CHECK（`0088:34`）一致；
- `retired_reason`：六种 ↔ 迁移 CHECK（`0088:13-19`）一致；
- `weeklyCapMicros`：`REAL_EVAL_WEEKLY_CAP_MICROS_MAXIMUM=500000` ↔ 解析器 max（`strict-configuration.ts` 的 `parseRealEval`）一致；
- `purpose: "other"` ↔ `MODEL_USAGE_PURPOSES`（`ports/model-usage.ts:3-14`）接受；
- `summary`：服务产出 ↔ `declinedFromRuns` 只读字符串数组、`real-eval-report` 只读数字字段、SQLite 只校验 `json_valid + object`，都能接受；
- 导出清单新增“未导出”项 ↔ 导出/导入测试（`test/integration/data-export.test.ts`）通过断言。

不一致的关键是 `question_ref`：生产端由 `storeQuestion` 写入 payload，消费端 `discardQuestion` 直接删 payload；但 DB 端 `real_eval_questions.question_ref` 仍以 `ON DELETE RESTRICT` 引用该 payload，退役又不删行。**产生方和使用方不能同时满足**，这正是 I-73 那类“只看改动、没核对后端校验”的问题。

---

## 未核实
- 作者第 6 条“两个已知失败测试与本改动无关、在基线也失败”：本次只能读代码/不能运行测试，未核实。
- “记忆从不可出题状态恢复时 revision 是否一定递增”：未逐条追完内存写入路径；因此“退役行阻止同 revision 再次入库”的实际触发频率是推测，但 `addQuestion` false 不记 declined 导致重复花钱的代码路径是确定的。
- 配置 `realEval` 在非 web 模式是否应可运行、跨进程部署是否可能并存多个 agent-service：未从部署文档核实；并发问题按“推测”列出。
- `prompt-manifest.json` 中三条提示词的 sha256 是否与实际文本逐字匹配：未运行校验，未核实。
