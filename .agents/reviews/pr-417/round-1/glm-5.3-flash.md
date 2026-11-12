## 复核结论（PR 417，608f0884）

### 读代码证实的

**作者说法核对（逐条）**
- 「标题、记忆保存、片段总结、整理共用 `thread-title:<runId>` 账户」：证实。标题走 `gate.begin({ ...input, budgetAccount: "thread-title" })`（apps/agent-service/src/production-run-composition.ts:476），三类记忆调用走同一路径（production-run-composition.ts:571），持久层由 `identity.begin` 按 `budgetAccount` 定账户（packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:475、36 行的 `BUDGET_ACCOUNTS` 白名单）。
- 「各类调用带不同分级」：证实。记忆保存用来源分级（production-memory-capture.ts:1082 `request: { ...request, dataClassification: source.dataClassification }`），片段总结用片段分级（production-memory-episodes.ts:98 `dataClassification: segment.dataClassification`），整理动态传（production-memory-consolidation.ts:109-113），标题用首个来源分级（production-thread-titles.ts:84）。
- 「账户分级第一次定下、之后要求相同」：证实（sqlite-model-budget-operations.ts:1492-1494；改动前的 diff 显示该断言原来无条件调用）。
- 「run/title 仍受 assertRunClassification 下限约束」：证实（sqlite-model-budget-operations.ts:472-478，对 run 和 thread-title 都先查 run 分级下限，再做账户分支）。
- 「run 账户仍不许改、原有测试不变」：证实。run 账户仍走 `assertAccountClassification`（:497），测试 test/integration/sqlite-model-budget-operations.test.ts:1178-1185 保留 run 账户换分级报 `PORT_CONFLICT` 的反向用例。
- 「记忆保存失败落 extraction_failed」：证实（production-memory-capture.ts:1140）。
- 文档 I-94 行与代码一致：三个日志事件名、两处 `[I-94]` 测试名（test/integration/sqlite-model-budget-operations.test.ts:2131、packages/platform-node/test/service-failure-reason.unit.test.ts:32）、`portErrorSite` 的位置和截 200 字符（packages/platform-node/src/service-runtime.ts:61-73）都对得上。
- `raiseAuxiliaryAccountClassification`（:1470-1486）只升不降、每笔 allocation 仍记自己的分级（:532）；`markStarted`/`settle`/`markUnknown`/`finalize` 都不查账户分级（:560-655、:764-827），不会因提升后分级不同再被拒。

**分级只升不降不会造成披露问题（读代码证实）**：全仓库对账户级 `dataClassification` 的消费只有 3 处（本文件 :1474、:1492 和测试 :2167），没有出口、遮盖或记忆可见性逻辑读它；每次调用该不该放行仍由 `assertRunClassification`（下限）和模型描述符 `allowedDataClassifications`（production-model-composition.ts:580）逐笔决定。账户分级只是记账，把它抬高只会让记录更保守，不会放宽任何检查。

**site 字段不会写入不该进日志的内容（读代码证实）**：`portErrorSite` 只在 `code` 以 `PORT_` 开头时返回 `message` 截 200 字符；日志行先过 `redactMachineSecrets` 再写出（service-runtime.ts:85-86）。我抽查了持久层所有 `PORT_` 失败消息（如 sqlite-durable-operations.ts、sqlite-thread-operations.ts），内容是固定检查说明或内部 ID（memory id、payload ref、thread id），不含载荷明文。注意这是这三类日志第一次出现带内部 ID 的原文（此前只有 `code`），失败时才出现，可接受。

### 问题（按严重度从高到低）

1. **低｜apps/agent-service/src/service-main.ts:2577-2582｜thread-title.failed 日志没加 site 字段**。标题调用和记忆调用共用同一账户，同样会因 `Budget account parent identity is inconsistent` 之类 PORT_ 错误被拒，但这次只给 memory-capture/episode/consolidation 加了 `site`。证据：2577 行的 `onTitleFailure` 仍只写 `code`。建议：同样加 `...siteField(error)`。
2. **低｜测试缺口｜site 的日志装配没有测试**。`portErrorSite` 有单测（正例、截断、反例），但 `...siteField(error)` 的装配无任何断言；service-orchestration.unit.test.ts:1107 已有 `thread-title.failed` 的 stderr 断言可扩展。若装配写错（如字段名打错），测试不会失败。建议：加一条集成/编排级用例，PORT_CONFLICT 后断言日志行含 `site`。
3. **低（未核实）｜提交说明 608f0884｜Layer-0 列表与声明数量对不上**。`Layer-0-tests:` 列了 16 个文件，`Fast-mode-checks:` 却写「第 0 层 25 个文件」，且本次主门槛测试文件 `test/integration/sqlite-model-budget-operations.test.ts` 不在列表里。规则（.agents/instructions/test-trigger-timing.md:8）要求 derive 列出的文件「只能增加，绝不能去掉」。我无法运行 derive 脚本核实，列为待查。
4. **信息｜packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:494｜分支硬编码 `parent.kind === "thread-title"`**。「thread-title」账户实际承载一轮全部辅助调用（标题+三类记忆），名字已名不副实；将来若新增辅助账户种类，同类 bug 会原样复发。建议至少在 `BUDGET_ACCOUNTS`（sqlite-model-invocation-operations.ts:36）或常量处注明这层语义，或用显式的「辅助账户」集合代替单个 kind 判断。
5. **信息｜test/integration/sqlite-model-budget-operations.test.ts:2131｜[I-94] 测试只覆盖直接 begin 的正向路径**。重试补做（production-memory-capture.ts:897-937，用旧来源分级）和整理的动态分级没有组合用例；对持久层足够，但组合层（auxiliaryMemoryGeneration）的分级拼装只有既有测试间接覆盖。

**推测（无代码证据，仅提示）**：occurrence/memory-projection 账户仍是严格不可变（:497）。若未来同一 occurrence 下出现不同分级的模型调用，会踩同一类错；目前没有发现这样的路径（未核实到反例）。

### 侧重检查（普通使用流程走查）

流程：用户发消息 → Pi 回答结束 → 记忆捕获计划（production-memory-capture.ts:1082，分级=来源分级）→ `auxiliaryMemoryGeneration`（production-run-composition.ts:555-592）→ service-main 的 `generate`（service-main.ts:2637-2650）→ `gate.begin` 带 `thread-title` 账户（composition:571）→ `identity.begin` → `reserveWithinTransaction`（budget ops:444，断言链 449/471-478/491-498）→ allocation → 生成 → settle。其中：改动改到的 `reserveWithinTransaction` 有 [I-94] 集成测试覆盖；**没有测试覆盖**的路径：`...siteField(error)` 装配（见问题 2）、backlog 补做与整理的分级组合（问题 5）、`thread-title.failed` 无 site（问题 1）。走查结论：核心缺陷路径已覆盖，诊断日志的“最后一公里”没有覆盖。

### 必答问题

1. **不会**。diff 只改了预算记账（persistence-sqlite）、诊断日志字段（service-main/service-runtime）、文档和两个测试文件；没有任何组装系统提示、工具定义、历史或遮盖的代码被触及，发给模型的内容仍是末尾追加，每轮变化的值也未被挪动。
2. **不会**。改动产生/修改的值只有两个：账户的 `data_classification`（全仓库消费仅预算模块内部和测试，grep 证实 3 处引用）和日志 `site` 字段（`writeServiceDiagnostic`，不进模型请求）。请求字节不受影响，遮盖规则也未触及。
3. **有，反向用例成立**。改前 `assertAccountClassification` 无条件调用，`[I-94]` 集成测试第二次 begin（sensitive）必然命中 `Budget account classification is immutable` 而失败（读旧代码证实；未实际运行测试）。`portErrorSite` 单测含正例、截断和三个反例。缺口是日志装配本身无测试（见问题 2）。
4. **两端都能接受（逐个核对）**：`site` 由 `portErrorSite`（service-runtime.ts:61）产生，仅三处失败日志消费，类型上 `writeServiceDiagnostic` 收 `string`，写出前过机密遮盖，内容为内部检查说明/ID；账户分级提升由 :1476-1481 的 UPDATE 产生，读回走 `readAccount` 的 `classification()` 校验（:1267），消费方只有本文件和 `toAccount` → `modelBudget.read`（消费仅测试），不在 data-export 里；`"thread-title"` 字符串两端一致（composition 硬编码 ↔ `BUDGET_ACCOUNTS` 白名单，后者有解析校验）；I-94 表行格式与相邻行一致（`check:incident-gates` 是否校验行内容未核实，作者声明已运行）。

未核实项：测试是否真的在 CI 门里（依交付规则属第 0/2 层，作者声明已跑）、derive 清单是否为 25 个文件、生产 09:13 那次是否确为本机制（作者自己声明是推断，无生产日志佐证）。
