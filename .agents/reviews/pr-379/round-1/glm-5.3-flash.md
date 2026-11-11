先看改动涉及的完整文件与规则文档。
再看状态端口、ledger 校验、门槛登记表的消费方，以及 DurableMemoryService 里 tentative 记忆的 status。
# 复核报告：P4-7 待确认记忆转正门槛

## 侧重检查

我走的流程：主人发消息 → 运行提交 → 后台记忆捕获（`ProductionMemoryCapture`）→ 抽取（模型调用）→ `AutomaticMemoryService.processCommittedRun` 逐候选过门槛 → 提交/暂存/丢弃 + 写决策账本。重点核对了：`packages/application/src/services/automatic-memory-service.ts`、`packages/calibration/src/thresholds.ts`、`apps/agent-service/src/production-memory-capture.ts` 与 `production-memory-control.ts`、`packages/application/src/services/durable-memory-service.ts`、迁移 `0069_decision_ledger.sql`、`sqlite-decision-ledger-operations.ts`、两个单元测试与金样集成测试、相关 ADR。

结论：改动全部发生在运行提交之后的后台处理和记录层，不触碰任何发给模型的内容；生产环境到确认门槛的整条链路中，「生产用 `isTentative` 闭包」（`production-memory-capture.ts:566-568`，含 `status === "active"` 条件）没有任何测试走到——金样测试（`test/integration/automatic-memory-golden.test.ts:314`）是直接构造 `AutomaticMemoryService` 并自带一个**不带 status 检查**的 `isTentative`，绕过了生产闭包；单元测试用的是内存假件。这是本次改动覆盖上的主要空洞。

## 发现（按严重度从高到低）

**1. 中｜packages/application/src/services/automatic-memory-service.ts:226、238-240｜「默认行为与改前完全一致」在账本层不成立**
- 证据：改前，指向待确认记忆的 `unchanged` 候选（分数≥850）账本记 `kept` + `auto_committed`，低于门槛记 `discarded` + `confidence_below_threshold`；改后默认配置下改记 `tentative_confirmed`（:239）和 `confirm_below_threshold`（:226）。且账本行 id 由 reasonCode 参与派生（:571 `ledgerId(\`${generationId}:${ordinal}:${outcome}:${reasonCode}\`)`），id 也变了。
- 影响：门槛报表（`thresholds.ts` `gateSamples` 按 `gatedReasons` 归属门槛）里，这些行从 autoCommit 门槛挪到 confirmTentative 门槛；上线前后同类决策的账本原因码不一致。门槛判定本身确实逐值不变（默认 850，测试 `tentative-memory-capture.unit.test.ts:292-308` 覆盖了全分类 849/850 等价）。
- 建议：作者说明改为「门槛判定与改前一致；账本原因码对转正路径变了」，并在 ADR 0143 补记。

**2. 低｜docs/adr/0143-decision-ledger-for-model-gate-decisions.md:53｜文档与代码不一致：新的丢弃原因未登记**
- 证据：该行列举 `memory_candidate` 的丢弃原因「共有六种……置信度低于门槛（`confidence_below_threshold`）……」，括号修订只提到 `kept_tentative`。代码现在会写第七种原因 `confirm_below_threshold`（automatic-memory-service.ts:226），文档未更新。ADR 0179:55「其余仍记 `confidence_below_threshold`」同样过期。
- 建议：补 ADR 修订段，或在新 PR 说明里明确要补。

**3. 低｜apps/agent-service/src/production-memory-capture.ts:568 vs test/integration/automatic-memory-golden.test.ts:323-324｜生产判定与测试判定不一致，生产闭包零覆盖**
- 证据：生产 `isTentative` 要求 `memory?.status === "active" && memory.attributes?.tentative === true`；金样测试的替身只查 `attributes?.tentative === true`，不查 status。如果「非 active 且带 tentative 标记」的记录出现（例如被归档的待确认记忆），测试替身会判 true、生产判 false，两者分叉且测不出来。
- 建议：金样替身补上 status 条件，或加一条直接测 `createProductionAutomaticMemory` 闭包的用例。

**4. 低｜packages/application/src/services/automatic-memory-service.ts:186-193｜`isTentative` 在不需要时也查库**
- 证据：`confirmsTentative` 对每个 `decision === "unchanged"` 的候选都执行一次 `readMany` 查询，包括 `explicitlyApproved` 的候选——此时门槛被跳过（:196）、原因码也是 `explicitly_approved` 优先（:236-237），查询结果完全用不上。
- 建议：把计算挪到 `!explicitlyApproved` 分支内，或惰性求值。纯浪费一次查询，不影响正确性。

**5. 信息｜packages/application/src/services/automatic-memory-service.ts:42、54-62｜`gates` 选项未标注「仅测试用」**
- 证据：作者说「只给测试用的 gates 选项」，代码里它是公开可选接口，无注释区分。生产两个构造点（production-memory-capture.ts:563、金样 :314）都没传，默认行为成立。建议加注释说明生产不得传。

## 必答问题

**1. 会不会改变模型已见过的请求开头？** 不会（读代码证实）。diff 只涉及 `thresholds.ts`、`automatic-memory-service.ts`、`production-memory-capture.ts`/`production-memory-control.ts` 的装配和两个测试，未触碰提示词目录、工具定义、历史组装或遮盖。`isTentative` 是对 `ProductMemoryStatePort.readMany` 的数据库读（端口签名见 memory-projection.ts:119-123），不进模型请求；抽取调用本身及其请求组装未改。追加性不受影响，此改动也不产生任何「每轮会变的值」。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会（读代码证实）。没有任何进模型请求的序列化被改动。唯一新增的状态依赖是账本原因码取决于库里的 `attributes.tentative`——这影响的是决策记录不是请求字节，且给定库状态是确定的。注意发现 1：默认配置下账本字节相对改前会变。

**3. 有没有对应的自动检查、反向用例真会失败？** 有（读代码证实）。`tentative-memory-capture.unit.test.ts:209-308` 新增 6 条用例：门槛登记与默认值、覆盖值合法性、按分类生效、确认门槛接管转正，以及反向用例「REVERSE: reaffirming a formal memory still uses the auto-commit gate」（:283-290）——若门槛选择逻辑反转（正式记忆也走 confirmTentative=0），800 分会被放行并记 `tentative_confirmed`，与断言 `committedMemoryIds === []`、`confidence_below_threshold` 矛盾，用例会红。默认等价循环（:292-308）也双向覆盖。未核实：CI 是否确实跑到该文件（按目录约定属于 vitest 常规收集，未见特殊排除）。

**4. 每个新值的两端都核对了吗？**
- 新门槛 key `memory_candidate.confirm_tentative`：仅被 `THRESHOLD_GATES`（thresholds.ts:56-59）和报表展示消费，不经过任何后端枚举校验，无 I-73 式「清单 id 过不了后端校验」风险（读代码证实）。
- 新原因码 `tentative_confirmed`/`confirm_below_threshold`：写入端过长为 17/22；`0069_decision_ledger.sql:19` 只查长度 1–64，`sqlite-decision-ledger-operations.ts:57` 同样只查长度，导出 schema `schemas.ts:206` `text(1,64)`，全部通过（读代码证实）。消费端：`gateSamples` 已把两个码登记进新门槛的 `gatedReasons`（thresholds.ts:49）；`decisionRuleDefinition` 对未知码返回 undefined，不受影响；「依据」抽屉展示原始字符串。通过。
- `isTentative` 必填选项：全仓 4 处 `new AutomaticMemoryService` 均已补（production-memory-capture.ts:563、金样 :314、两个单元测试），类型检查会兜底（读代码证实）。
- `state` 选项：`ProductionMemoryControl` 传入 `this.options.state`（production-memory-control.ts:985），该字段在同类调用 `readMany` 处已存在（:535 等），类型吻合（读代码证实）。
- `gates` 选项：可选，生产不传，默认 `DEFAULT_CAPTURE_GATES`（automatic-memory-service.ts:59-62）与登记表同源（读代码证实）。

**总评**：实现正确、默认门槛判定逐值不变，测试和反向用例扎实；主要问题是作者「默认行为与改前完全一致」的说法对账本层不准确（发现 1、2），以及生产 `isTentative` 闭包没有测试覆盖且与测试替身判定不一致（发现 3）。
