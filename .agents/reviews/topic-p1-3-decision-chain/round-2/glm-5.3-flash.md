# 审核结论（P1-3 决策记录完整链方案）

## 侧重检查（普通使用流程走查）

我走的主流程：提醒页「提醒检查记录」行 → 点「依据」→ `decision.chain.snapshot` 查询 → approval-gateway 派发 → 新类 `ProductionDecisionChain` → 账本端口 `read`（SQLite）→ 记忆状态/历史/来源读取 → `readBasisChain` → 抽屉渲染 → 展开 → `decision.chain.model-io.read` → `decision_ledger_payloads` 解密读出。

结论：这条链上**全部代码都是新写的或新改的**，方案第 10 条的测试清单基本覆盖了它；但有一段被改动的**既有**路径没有测试安排——把「记忆概览单条条目组装」从 `ProductionMemoryControl.query()`（production-memory-control.ts:322-412）抽成概览与链共用的方法，会动 `memory.overview.read` 的产出路径，方案测试清单里没有任何「概览输出不变」的回归用例。`check:prompt-prefix` 只管发给模型的内容，管不到这个 UI 快照。另外 `#basisChain`（`memory.basis.read`，production-memory-control.ts:323、295-318）已经实现了带 `complete` 标志的链读取，方案第 3 条的「复用 readBasisChain、节点上限、complete 标志」在概览侧已有现成形状，建议明确复用它而不是再包一层。

## 核对结果（按严重度从高到低）

### 1.（证实，中高）设计基线的引用指向一个不存在的文件
- 问题：前提第 9 条「设计基线：`web-design-baselines.md:9` 不新增堆内部运行信息的通用面板」——全仓库没有这个文件（glob `**/web-design-baselines.md` 无结果，docs/ 目录清单里也没有）。
- 证据：这条规则的真实出处是 `docs/execution/specs/2026-09-15-control-center-v4-design.md:58`（「只禁止堆放内部运行信息的通用栏或页面」）及 ADR 0105 第 61 行（「ADR 0100 的基线规则……继续有效」）。
- 建议：改引用；同时说明本次是在**既有提醒页**上加抽屉入口，不属于「新增通用面板」，不触发「先出原型经 Andy 批准」的要求（提醒页本身是 ADR 0105/0106 已批的页面）。

### 2.（证实，中）「这是发给模型时的版本，敏感信息已遮盖」这句标注不成立
- 问题：`decision_ledger_payloads` 里存的 `model_input` 是**出口遮盖之前**的提示词，不是发出的字节。
- 证据：`production-model-composition.ts:521-529`——`prepare()` 在调用模型**之前**把原始 `prompt` 写入 payload 边界（`content: prompt`）；出口遮盖在 invoke 传输层（同文件 329-337 的 `egress` / `egressContext`）按整条请求做。提示词组装侧只对邮件字段逐字段遮盖（`proactive-mail-check-service.ts:269-271` `masked()` = `maskSensitiveText`，单字段调用）。而出口层还有跨消息的遮盖（点名验证码在同请求后续消息里也要遮，`.claude/rules/prompt-prefix.md:54`），这一层的效果不可能出现在按字段遮好的存档里。ADR 0147 第 70 行也只承诺「发件人、标题、摘要以加密形式随账本保存」，没承诺存档等于发出字节。
- 风险：邮箱正文里偶发的卡号/验证码在发送时被出口层遮掉，但在存档里是明文；抽屉把它展示出来就是新增的敏感文字暴露面，与方案第 6 条「不在提醒页新增敏感文字暴露面」自相矛盾。
- 建议：要么在读取端对 payload 正文**再过一次出口级遮盖**（用读时的固定输入，输出只进 UI，不影响已发内容），要么把标注改准：「提示词组装时的版本，邮件字段已遮盖；发送时出口层可能再遮盖个别值」，并把「存档与发出字节的差异」列为第 7 条待 Andy 拍板的一部分。集成测试里应有一条：正文中含卡号的邮件决策，抽屉读出的文本不含卡号。

### 3.（证实，中）「完整链」漏了 Gmail 判断实际交给模型的另外两块输入
- 问题：快照只列了规则和记忆，缺 `sourceIds`（被判断的邮件编号）和 `relatedByMail`/`relatedRead`/`relatedStats`/`relatedFailedSteps`（前情邮件时间线）。
- 证据：`proactive-mail-check-service.ts:1294-1308` 这两块都写进了 inputs；ADR 0180 第 44 行明确「`sourceIds`……仍是真正放进提示词的『被判断的邮件』编号」「前情邮件的编号另记在 `relatedByMail`，只记真正随提示词发给模型的那几批」。方案第 3 节的 decision 段没有它们，规则段只带 `floorHits` 的命中邮件编号——模型自己判断（非地板规则）的邮件和它读过的历史邮件在链上看不到，「读出并展示完整链」的目标没达成。
- 建议：decision 段加「判断的邮件（sourceIds）」和「读过的前情邮件（relatedByMail，按邮件编号排序）+ relatedRead 状态」，缺失时同样走「无记录」。

### 4.（证实，中）新错误码 `DECISION_RECORD_NOT_FOUND` 只写了网关一端，两端都没对齐（I-73 的教训）
- 问题：现在同类场景用的是 `PROACTIVE_RECORD_NOT_FOUND`（production-proactive.ts:433-434 `new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "PROACTIVE_RECORD_NOT_FOUND")`）。引入新码意味着：contracts 的夹具/校验、控制中心的错误文案映射（三语）都要跟着登记；方案第 2 条的登记处清单没有列错误码这一项。
- 建议：优先沿用现有惯例（新端口返回 NOT_FOUND，网关复用 `PROACTIVE_RECORD_NOT_FOUND` 或按 kind 分派既有码）；确要新码，就把「错误码登记 + 控制中心映射 + 契约反向用例（未知码必须失败）」补进第 2/10 条。

### 5.（证实，中）端口加方法漏了两处必改点
- `DecisionLedgerPort` 加 `read` 后：`sqlite-decision-ledger-operations.ts` 的 `execute` switch（220-254 行）要加 `decisionLedger.read` 分支；durable-adapters.ts:934 一带（`readBasisChain: (input) => this.context.read("memoryConsolidation.readBasisChain", input)` 的同款转发）也要加映射；所有测试替身实现该端口的都要跟着实现。方案第 2 条的登记处清单没有这些。
- 建议：在第 2 条登记处清单里补上「端口接口、SQLite execute 分支、durable adapter 转发、测试替身」。

### 6.（证实，低）`inputFields` 必须从原始 JSON 算，且键序要固定
- 证据：`entryFromRow`（sqlite-decision-ledger-operations.ts:136-203）会把缺的字段补默认值（`memoryRecall ?? "off"`、`memoryInjected ?? false` 等），从补过的条目上算「实际存在的键」就错了——必须在 padding 前从 raw JSON 算。另外快照第 3 条说「一切按编号排序」，没覆盖 `inputFields` 的键序；JSON.parse 保留写入顺序，不同版本写入方的键序可能不同，违反 prompt-prefix 规则第 10 条的精神（确定性序列化）。第 3 节的「recall 状态」直接读补过默认值的 `memoryRecall` 也会把「没记录」错显示成「off」，应结合 `inputFields` 显示「未记录」。
- 建议：方案第 1 条写明「inputFields 在 entryFromRow 补默认值之前从 raw JSON 计算、输出按键名排序」；第 3 节 recall 状态加 `unrecorded`。

### 7.（推测，低）新操作挂在哪个能力门下需要写明
- 证据：http-composition.ts:662-670 里各 Operations 组按 `proactiveAvailable` 等能力门拼接；approval-gateway.ts:249-258 同样按 options 分组。方案说「覆盖所有 kind」，但没说 `decision.chain.*` 登记在哪个组——若挂进 `PRODUCTION_PROACTIVE_OPERATIONS`，主人断开 Gmail/停用主动检查后，memory_candidate、consolidation 等非 proactive 决策的链也一起读不了，与「覆盖所有 kind」矛盾。
- 建议：写明挂靠条件（建议跟账本/记忆控制可用性走，而不是跟 proactive 走），并在控制中心单测里加「proactive 不可用、memory 可用时入口仍在」。

### 8.（证实，低）其余前提核对为正确
以下 premise 我逐一对了代码，均属实：production-memory-control.ts:395（sourceMessageId）、ports/memory-consolidation.ts:71（readBasisChain）、proactive-mail-check-service.ts:1294-1308、entryFromRow 补默认值、production-proactive.ts:218（readDecisionModelIo，且 `readDecisionPayloads` 的 SQL 带 owner/agent/kind='proactive' 过滤，sqlite-proactive-operations.ts:426-441）、proactive-rules.ts:29-34、daily-review.ts:135、迁移 0070（migration-engine.ts:565-568）、`query()` 先 `#purgeExpiredTrash()`（production-memory-control.ts:327）、DECISION_KINDS 恰为六种（decision-ledger.ts:29-36）、memory_candidate 把 reasonCode 写进 ruleIds（automatic-memory-service.ts:572 `ruleIds: [reasonCode]`）、仓库确无规则登记册、ADR 0192 是下一个编号（现有最新 0191）、`proactive.decision.rate` 已存在（production-proactive.ts:39）、e2e fixture 文件存在。`memoryRecall` 等 inputs 键与 entryFromRow 的类型一致。

「未核实」：`RatingChoices` 组件与 glossary 现状（未打开控制中心全部组件文件）；契约 fixture 反向用例的具体形态；自动审查链上「读取不触发写库」能否用现有观测点断言（需实施时找注入点）。

## 如果由我来定

方案骨架（只读、不加迁移、复用既有端口和 basis 链、敏感记忆沿用 reviewMemoryVisible、不动任何发给模型的请求）是对的，我会保留，改这几点：

1. 快照补上 sourceIds 与 relatedByMail/relatedRead 两段（问题 3），否则「完整链」不完整。
2. model-io 段的标注与隐私处理按问题 2 改：读取端再遮盖或改标注，并加「存档正文含卡号时抽屉读出为遮盖文本」的反向测试。
3. 登记处清单补全：错误码两端、SQLite execute 分支、durable adapter、测试替身、能力门归属（问题 4、5、7）。
4. inputFields 的计算时机与键序、recall 的 `unrecorded` 状态写进方案正文（问题 6）。
5. 文档引用改到真实出处（问题 1）。
6. 测试清单加一条：`memory.overview.read` 的既有集成用例在重构后全部照旧通过（防共用方法改动概览输出）；「读取不触发写库」给出具体观测点（如断言 `decisionLedger.append`、payload put/release 零调用）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。全部改动在读取/展示侧，方案第 11 条明确不动请求、提示词目录、迁移；唯一改动的既有路径 `memory.overview.read` 是控制中心 UI 快照，不进模型请求，且新链读取明确绕开会清回收站的 `query()`（production-memory-control.ts:327）。无「每轮会变的值」问题——本改动不产生任何发给模型的内容。唯一要守的是重构不改变概览快照输出（见侧重检查）。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会改变模型请求的字节（不触碰）。方案自身产出的快照要求「按编号排序」，方向正确；已核实排序依赖的数据源本身是确定的：listHistory `ORDER BY h.occurred_at, h.rowid`（sqlite-memory-operations.ts:907）、earliestSourceMessage 按 sequence 排序（production-memory-control.ts:116）。需补两处确定性约定：`inputFields` 键序排序（问题 6）、`memoryByMail`/`relatedByMail` 等 `Object.fromEntries` 展开后的键序排序。
3. **有没有对应的自动检查，反向用例会不会真的失败？** 方案第 10 条的清单结构上完整（集成正反向、契约夹具反向、登记册双向单测、控制中心单测、真浏览器正反向）；登记册的双向核对设计上能抓住「新加地板规则不登记」和「登记册写了不存在的规则」两个方向。我无法运行测试验证反向用例真红（工具受限），但按现有同类门槛（如 model-ref-contract、prompt-prefix 的 `[I-66]` 反向用例）模式可行。缺口：概览回归用例缺失（问题见侧重检查）；「读取不触发写库」需指定观测点，否则反向用例可能形同虚设。
4. **每个新值的两端都核过了吗？** 逐个：`decisionId`——产生端 decision_ledger.id（写入带 owner_id/agent_id，sqlite-decision-ledger-operations.ts:98-127），使用端新 read 的 SQL 仿 `rate` 带 owner/agent 过滤（:313-326 模式），跨主人编号返回 NOT_FOUND，两端成立；`DECISION_RECORD_NOT_FOUND` 错误码——网关一端写了，控制中心文案/契约登记一端没写（问题 4）；`read` 端口方法——漏 SQLite execute 分支与 durable adapter（问题 5）；`decision.chain.*` 操作名——登记处清单齐全但能力门归属未定（问题 7）；规则编号登记册——双向单测覆盖两端；快照 JSON 形状——控制中心消费端有三语文案与类型，fixture 覆盖；`textHidden`——沿用 daily-review.ts:135/321 的既有判定，两端一致。除列出的四处缺口外，其余两端可接受。
