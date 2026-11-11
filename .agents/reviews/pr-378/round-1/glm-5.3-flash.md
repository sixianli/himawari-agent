# P4-5 真实记忆评测：代码复核报告

## 发现的问题（按严重度从高到低）

### 1.（中）预算“预留”只是检查不扣减，嵌入费用完全不走预留；once 模式下“每周硬上限”不成立

- 文件:行：`packages/application/src/services/real-memory-eval.ts:284-291`、`packages/application/src/services/real-memory-eval-service.ts:265`、`apps/agent-service/src/production-real-eval.ts:46-49,224-228`
- 问题：
  - `reserve()` 只做 `spent + estimate > limit` 的比较，**不把预估值记入已花**；实际费用在调用后由 `record(actual)` 累加。若某次调用实际费用超过预估（出题/判分输入是中文，`proactiveCostEstimator` 用 `prompt.length`（UTF-16 码元）估输入，对中文可能低于真实 token 数），单次调用就会把累计花费推过上限，上限是“调用边界检查”而不是硬挡板。
  - 嵌入（recall）费用**计入了但从不预留**：`budget.record(recall.costMicros)` 在检索之后才记（service:265），检索前没有任何上限检查。预算耗尽后，下一个待答题目仍会先做一次检索、花掉嵌入费，然后才在作答调用的 `reserve` 处抛出。嵌入确实被计入（`production-run-memory.ts:210,213` 把实际/预估嵌入费写进 `mail.costMicros`），这一点作者没说错，但“超过上限抛”只对 LLM 调用成立。
  - `weeklyCapMicros` 是**每次运行**的上限，不是每周累计：`#tick` 每次都把满额 `configuration.weeklyCapMicros` 传给 `service.run`（production-real-eval.ts:225）。`once` 模式下 outcome 为 `failed` 时每小时重试一次且每次重新拿满预算（`dueRealEvalTrigger` 只看 `outcome !== "failed"`，:46-49），持续失败可按 0.5 美元/小时的速度花钱，与“每周费用硬上限 0.5 美元”的约束不符。`budget_exceeded` 算“没失败”，会停，这一点没问题。
- 建议：reserve 时把预估值暂记、调用后按实际结算；recall 前也做 reserve；once 模式失败重试加上限次数或累计预算。

### 2.（中）出题成功但入库失败时，题干 payload 成永久孤儿

- 文件:行：`packages/application/src/services/real-memory-eval-service.ts:238,243`、`packages/persistence-sqlite/src/sqlite-real-eval-operations.ts:121,130`、`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:884-888`
- 问题：`storeQuestion` 先把题干写成加密 payload（service:238），然后 `addQuestion` 才落库。`addQuestion` 有两条返回 false 的路：记忆不属于本 scope（:121 `if (!owned) return false`，记忆被并发删除时触发）和唯一键冲突（:130 `ON CONFLICT ... DO NOTHING`）。返回 false 时 service 只是跳过（service:243-249），**已写入的 payload 没有回滚**。治理删除只收集 `real_eval_questions` 表里行的 `question_ref`（governed-deletion:884-888），孤儿 payload 不在任何清理路径上，题干（含记忆内容派生文字）会留在 payloads 表里。
- 建议：`addQuestion` 返回 false 时删除刚写入的 payload，或先落库再写 payload。
- 推测部分：未核实仓库里是否存在别的孤儿 payload GC 机制；若有则此条降级。

### 3.（低）weekly 模式下一次失败把下次评测推迟整整 7 天

- 文件:行：`apps/agent-service/src/production-real-eval.ts:50-54`
- 证据：`latest` 取**所有**运行（含 `failed`、`budget_exceeded`）的最新 `startedAt`，`now - latest >= 7 天` 才触发。一次瞬时模型失败（`RealEvalModelError`）记为 failed 后，要再等满 7 天才重试，期间固定面板不更新。
- 建议：failed/budget_exceeded 的运行用更短的重试间隔。

### 4.（低）退役题的题干 payload 永不清理

- 文件:行：`packages/persistence-sqlite/src/sqlite-real-eval-operations.ts:148-159`
- 证据：`retireQuestion` 只 UPDATE `retired_at/retired_reason`；payload 只在**记忆删除**时随 `question_ref` 收集删除。记忆还在但题退役（如 `memory_revised`）时，旧题干永久留在 payloads 表。每周运行量小，属缓慢累积。
- 建议：退役时一并收集/删除题干 payload，或接受并在 schema-catalog 说明里写明（当前说明只提“Owner 删除记忆时”，`schema-catalog.ts:836` 写的是“cascade with the memory”，与实际“仅记忆删除时清 payload”一致，未发现文档矛盾）。

### 5.（低）抽查样本文件不随记忆删除清理（文档已承认，属设计取舍）

- 文件:行：`apps/agent-service/src/production-real-eval.ts:149-174`
- 证据：`writeRealEvalSample` 写 `real-eval/latest-sample.json`（0600、目录 0700），内容经 `maskForExport`（= `redactForEgress`，production-gap-export.ts:89-91）。ADR 0219 后果一节明确写了“抽查样本文件不随记忆删除自动删除，只保留最近一次”。注意遮盖只处理被识别的敏感值（卡号等），记忆正文本身（个人事实）在文件里是明文——这是给主人自己抽查的设计，权限也够，仅提示存在。

### 6.（低）测试缺口

- 预算只有正向用例（`real-memory-eval-service.unit.test.ts:319-327`，且该用例里预估=实际）；**没有“实际费用>预估导致越过上限”的反向用例**，也没有嵌入费用计入预算的用例。
- `ProductionRealEval.tick` 的 `#running ??=` 防重入（production-real-eval.ts:210-217）没有并发测试。
- `service-main.ts:1664-1745` 的装配块（含 `REAL_EVAL_RUNTIME_UNAVAILABLE` 报错路径）未见测试覆盖。

### 7.（低，作者说法与代码的措辞出入）

- 作者说“每次模型调用前**预留**预估费用”——代码是“检查”而非预留（见问题 1），其余关于 run 流程的说法（退役条件、52 次 declined、泄题 6-gram+两位数、敏感值丢弃、fast path ≥8 字、judged/rejected 计数、failure 只记 error.name）逐一核对**均与代码一致**。
- 作者说迁移号“合并前会按队列改成下一个空号”——当前 0088 紧跟 0087、无冲突，`workspace-lifecycle-audit.mjs` 的 `SUPPORTED_SCHEMA_MAX` 已同步到 88；这是流程承诺，代码层面无法核实未来合并。

## 侧重检查

走的普通流程：配置解析（`strict-configuration.ts:1101-1126` parseRealEval + :1476-1488 modelRef 必须是接受 private 的生成模型，反向用例齐：cap 500001/0、mode 非法、embedding 模型、未知键都抛错，`startup-configuration.unit.test.ts:1467-1500`）→ `service-main.ts:1667` 装配（mode≠off 且缺 protector/durableMemory/descriptor 时拒绝启动）→ `ProductionRealEval.start` 每小时 tick → `dueRealEvalTrigger` → `RealMemoryEvalService.run`（退役→跳过 declined→按 id 排序出题→泄题/敏感/拒绝过滤→入库→recall→作答→快判/模型判分→计分）→ `recordRun`（只存数字，`real-memory-eval-service.unit.test.ts:261` 断言 summary 不含正文，:356 断言失败不含错误文字）→ once 模式写遮盖样本（0600/0700 有断言，`production-real-eval.unit.test.ts:103-104`）→ `real-eval-report.mjs` 只读列表（字段与 summary 写入端一致：items/added/retired/fixed/fresh/abstain/retrieval）。

**无测试覆盖的路径**：service-main 装配块与 `REAL_EVAL_RUNTIME_UNAVAILABLE`；`#tick` 并发防重入；`createProductionRealEval` 的胶水（readQuote 走 `quoteRefOfMemory`、profile 经 `OwnerProfileService.compose`）只有 `test/integration/real-memory-eval.test.ts:304` 一个端到端用例覆盖主干（该用例标题声称走真实检索，内部细节我未逐行核实，标「部分未核实」）。

**文档与规则一致性**：ADR 0219 决定 1-10 与代码一致（含决定 6 的“输出按两倍 token 预估”=`maxOutputTokens * 2`；决定 3 的 memoryLimit/maxSelectedMemories 取自同一 runPolicy）；未发现文档与代码矛盾。三份新提示词登记进 `prompt-manifest.json` 并纳入 `TRUSTED_PROMPT_TEXTS`（trusted.ts:12），prompt-output-contracts 门更新了正反用例。作者声称与本改动无关的两处预存测试失败：**未核实**（无法运行测试）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。改动没有触碰对话线程的系统提示、工具定义、历史或遮盖；`production-model-composition.ts` 只给 `proactiveModel` 加了可选 `purpose`，默认仍是 `"mail-judgment"`（:516），既有调用字节不变。新增的三类评测调用是单条消息的后台调用，固定指令在前（`REAL_EVAL_QUESTION/ANSWER/JUDGE.text`）、本轮数据 JSON 在后、`now` 在数据里（real-memory-eval.ts:105-212），符合 prompt-prefix 第 15 条“固定在前、会变的在后”。无需追加重排，不存在改动已发内容的情形。
2. **同一段文字会不会在不同请求里变成不同字节？** 没有发现会。题干一次生成、加密存储、判分时原样读回；发给模型的 JSON 键序固定（字面量构造）；遮盖走统一出口，单条消息内遮法只取决于消息自身（prompt-prefix 第 11 条），无跨消息前后文依赖。`summary`/`declined` 等只落库不发给模型。唯一含变值的字段 `now` 按规则放在数据末尾。
3. **有没有自动检查、反向用例会不会失败？** 有：配置校验反向用例（cap 超限、非法 mode 等 9 个反例）；解析契约反向用例（改名键、纯文本）；治理删除/导出用例（断言题干不出现、导入后表为空）；SQLite 契约测试拒绝畸形输入。**缺口**：预算无“实际>预估越过上限”的反向用例、嵌入计费无用例、tick 并发无用例——这些反向用例现在写成测试确实会暴露问题 1。
4. **每个新值的两端校验是否都通过？** 逐一核对过：`kind`（含 `abstain`）三端一致（TS 枚举 / SQL CHECK / 测试）；`retired_reason` 六值、`outcome` 三值、`trigger` 两值与 SQL CHECK 一致；`prompt_sha256` 64 位十六进制两端校验；`weeklyCapMicros` 1–500000 两端一致；`purpose: "other"` 是 `MODEL_USAGE_PURPOSES` 合法成员（model-usage.ts:11）；`real-eval-question:` 前缀 ref 无格式约束冲突（payloads.ref 无 CHECK）；迁移号 88 与 `SUPPORTED_SCHEMA_MAX=88` 同步；`summary` 的消费端（declinedFromRuns、报告脚本）字段匹配。**唯一两端的缝隙是问题 2 的“payload 已写、行未落库”**，校验各自都对，但失败组合留下孤儿。
