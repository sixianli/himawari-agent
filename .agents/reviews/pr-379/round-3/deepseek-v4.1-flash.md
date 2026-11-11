## 侧重检查

- **错误路径**：`confirmsTentativeCategory` 只由抽取阶段产生；服务端在 `automatic-memory-service.ts:104-110` 做形状校验。若该值非法，账本写入会被 `sqlite-decision-ledger-operations.ts:85` 的 `DECISION_CATEGORIES` 校验拒掉，不会静默写错。没有新增循环、递归或数据库读取；每候选仍是 O(1)。**未发现新的高风险错误路径。**
- **不可信输入**：模型 JSON 不能直接设置 `confirmsTentativeCategory`；该字段由 `production-memory-capture.ts:350-353,471-478` 根据可信的 `tentativeMemories` 快照生成，分类在 `production-memory-capture.ts:362-366` 经 `CATEGORIES` 校验。模型也不能借此把内容写进提示词。
- **安全与隐私**：新增字段只是分类枚举，不增加正文/原话的存储；敏感审批候选的加密存储格式只多一个分类字段，未发现泄露面扩大。
- **不可撤销操作**：默认配置下转正/丢弃结果与改前相同；按分类覆盖会改变某些转正决策，这是本次有意的配置能力。未发现默认路径下新增不可逆操作。
- **规则与文档一致性**：未改任何提示词、工具定义、会话历史或遮盖代码；`.claude/rules/prompt-prefix.md` 的约束不受影响。ADR 0143 有一处数量/清单不一致，见下。

## 发现（读代码证实）

### 1. 低：ADR 0143 的“六种原因”与新增原因码自相矛盾
- **文件:行**：`docs/adr/0143-decision-ledger-for-model-gate-decisions.md:53`
- **问题**：正文仍写“丢弃共有六种原因”，列表仍包含已在 ADR 0183 废止的 `candidate_secret_excluded`，随后又说 P4-7“这是新增的一种丢弃原因”。读者无法按这段文字得到当前准确的丢弃原因清单。
- **证据**：该行同时包含“丢弃共有六种原因：含机密（`candidate_secret_excluded`）……”和“（2026-11-11 起，P4-7：……这是新增的一种丢弃原因……）”。
- **建议**：改成当前实际清单：`restricted_excluded`、`transient_ignored`、`confidence_below_threshold`、`approval_rejected`、`approval_expired`、`evidence_unverified`、`confirm_below_threshold`，并明确 `candidate_secret_excluded` 已废止。

### 2. 低：新原因码/新分类没有经过真实账本持久化边界的自动检查（I-73 类风险）
- **文件:行**：`packages/application/test/tentative-memory-capture.unit.test.ts:73`、`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:55-57`、`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:35,45-51`
- **问题**：单元测试用的是假账本 `ledger: { append: async (write) => void ledger.push(write) } as never`，没有把 `tentative_confirmed` / `confirm_below_threshold` 和新分类真正写进 SQLite。新原因码是否能通过后端校验只靠人工读代码确认。
- **证据**：持久化端只校验 `!text(write.reasonCode, 1, 64)`（`sqlite-decision-ledger-operations.ts:57`）和 DB 的 `length(reason_code) BETWEEN 1 AND 64`（`0087...sql:35`）；分类由 `DECISION_CATEGORIES` 和 DB 的 IN 列表校验。新字符串长度分别 19、23，分类值也在列表内，**代码核对是能通过的**。但没有自动化用例守着这条链路。
- **建议**：在真实 `DecisionLedger`/SQLite 的集成测试中追加一条 `unchanged` 待确认记忆的转正（含 `tentative_confirmed`）和一条低于门槛（`confirm_below_threshold`）的用例，并断言读回的 `reasonCode`、`category`。

### 3. 低：新增第二个 `memory_candidate` 门槛后，校准报告会把兄弟门槛的行算成“不由门槛决定”
- **文件:行**：`packages/calibration/src/thresholds.ts:150-155`、`packages/calibration/src/thresholds.ts:616`、`scripts/calibration-report/thresholds.mjs:92`
- **问题**：`gateSamples` 只按当前 gate 的 `gatedReasons` 判断；现在 `MEMORY_AUTO_COMMIT_GATE` 和 `MEMORY_TENTATIVE_CONFIRM_GATE` 共享 `decisionKind: "memory_candidate"`，转正行会进入自动存入 gate 的 `notGated`，报告打印成“不由门槛决定 N 条”，其实它们是由另一门槛决定的，容易误导调参。
- **证据**：
  - `if (!isAmbiguous && !gate.gatedReasons.includes(row.reasonCode)) { notGated += 1; continue; }`
  - 报告文案：`analysis.notGated > 0 ? \`不由门槛决定 ${analysis.notGated} 条\``
- **建议**：`notGated` 改成按同一 `decisionKind` 的所有门槛的 `gatedReasons` 并集判断；或者把文案改为“不由本门槛决定”。

### 4. 低：“默认行为与改前完全一致”这一说法只对记忆去留成立
- **文件:行**：`packages/application/src/services/automatic-memory-service.ts:222,235,580-583,567`
- **问题**：默认门槛值相同，记忆提交/丢弃结果确实不变；但决策账本的 `reasonCode`、`category` 以及由它们拼出的账本 `id` 都会变。对 `unchanged` 的待确认记忆，`category` 从“模型自报的分类”变成“那条记忆原有的分类”。因此如果“默认行为”包括账本内容，这句话不成立。
- **证据**：
  - 低于门槛：`confirmsTentative ? "confirm_below_threshold" : "confidence_below_threshold"`；
  - 提交：`confirmsTentative ? "tentative_confirmed" : "auto_committed"`；
  - 分类：`confirmedTentativeCategory(detail.candidate) ?? detail.candidate?.attributes?.category ?? null`；
  - 账本 id：`ledgerId(\`${input.generationId}:${candidateOrdinal}:${outcome}:${reasonCode}\`)`。
- **建议**：把作者说明/ADR 的措辞收窄为“默认门槛下待确认记忆的转正/丢弃结果与改前相同；账本原因码、分类和校准归属会变化”。

## 推测（未证实）

### 5. 低：重试时若重新抽取，可能因原因码变化而绕过账本 id 幂等
- **文件:行**：`packages/application/src/services/automatic-memory-service.ts:567`、`apps/agent-service/src/production-memory-capture.ts:350-353`、`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:106`
- **说明**：账本 id 含 `reasonCode`，而 `ON CONFLICT (id) DO NOTHING` 依赖 id 不变。第一次运行把待确认记忆转正后，若同一 generation 被重试并重新抽取，目标已不是待确认记忆，抽取不会再设 `confirmsTentativeCategory`，同一候选可能从 `tentative_confirmed` 变成 `auto_committed`，从而生成第二个账本 id。
- **为什么只是推测**：我确认了 `processCommittedRun` 只被 `ProductionMemoryCapture` 调用一次，**没有核实** memory-capture 作业失败重试时是否会重新抽取同一 generation。作者说的“重放同一批候选结果不变”在“候选对象固定”的前提下成立。
- **建议**：如果该作业可能重试，考虑账本 id 不包含 `reasonCode`，或在服务层对同一 generation/ordinal 做去重。

## 必答问题

1. **会不会改变模型已见过的请求开头？**
   不会。本次改动没有触碰系统提示、工具定义、历史消息或遮盖代码。记忆抽取提示词仍只把已有记忆的 `id`、`text`、`stance` 放进去（`production-memory-capture.ts:182-186`）；新增的 `ExistingMemoryText.category` 只用于服务端构造 `tentativeMemories` 快照（`production-memory-capture.ts:780-786,859-866`），不进入提示词。发给模型的内容仍然只在末尾追加；每轮会变的记忆内容仍由既有链路放在本轮消息里。**需要补充的边界**：如果按分类覆盖改变了某条待确认记忆是否转正，后续轮次的记忆块会随之变化，但那是本轮末尾内容的正常变化，不是请求开头被改写；默认配置下连这一点也不变。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。新增的 `confirmsTentativeCategory`、账本 `reasonCode`、账本 `category` 都不是提示词文本；门槛查表是纯函数，分类在抽取时固定进候选，没有时间字段、无序集合或前后文相关遮盖参与。**语义上的前提**：同一段文字重新抽取时，若数据库里的目标记忆分类变了，算出的分类可能不同；这是输入状态不同，不是同一请求内文本字节不确定。未发现对遮盖或历史序列化的影响。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。`packages/application/test/tentative-memory-capture.unit.test.ts` 覆盖了按分类门槛、默认配置等价、原因码、账本分类、`create` 带确认标记仍走自动门槛、正式记忆仍走自动门槛；`apps/agent-service/test/production-memory-evidence.unit.test.ts:150-168` 覆盖抽取阶段标记和“正式记忆不标记”的反向用例。按代码路径推理：
   - 若账本分类改回候选自报分类，“confirmed memory's own category” 用例会失败；
   - 若服务端不检查 `decision/create`，“new memory carrying a confirmation mark” 用例会从 `kept_tentative` 变成提交，失败；
   - 若把正式记忆的 `unchanged` 也走转正门槛，对应反向用例会失败。
   **但我没有实际运行测试**（工具限制）。**缺口**：新原因码和分类没有真实 SQLite/账本持久化用例，见发现 2。

4. **改动产生或修改的每个值，所有使用它的地方都能接受吗？**
   逐项核对结果：
   - `confirm_below_threshold` / `tentative_confirmed`：生产于 `automatic-memory-service.ts:222,235`；`KeptReason` 已加 `tentative_confirmed`（`:86-91`），`discard` 参数类型已加 `confirm_below_threshold`（`:593`）；后端只校验长度 1–64（`sqlite-decision-ledger-operations.ts:57`，DB `0087...sql:35`），两者长度分别为 23、19，能通过；`outcome` 仍是 `kept`/`discarded`，符合 `DECISION_OUTCOMES` 和 DB 约束。
   - 新账本 `category`：来自 `confirmsTentativeCategory` 或 `attributes.category`；`MEMORY_CATEGORIES`、`DECISION_CATEGORIES`、DB IN 列表三处当前都是同样 10 个值（`memory-projection.ts:13-24`、`decision-ledger.ts:58-69`、`0087...sql:45-51`），能通过。注意：自动化只断言了 `THRESHOLD_CATEGORIES === MEMORY_CATEGORIES`（测试 `:227`），没有断言 `DECISION_CATEGORIES`，目前靠人工核对一致。
   - `confirmsTentativeCategory` 字段：抽取端用 `CATEGORIES` 校验分类（`production-memory-capture.ts:362-366`），服务端只在“非 create 且有目标记忆”时采用（`automatic-memory-service.ts:104-110`）；会随敏感候选加密 JSON 持久化（`production-memory-capture.ts:544`）并在审批提交时读回，格式无严格 schema 拒绝额外字段。
   - 新门槛 `key`/`label`/`gatedReasons`：只被校准报告的 `THRESHOLD_GATES` 消费（`scripts/calibration-report/thresholds.mjs:85,92`，`thresholds.ts:588-613`），字符串本身没有后端校验问题；但报告归属有低风险问题，见发现 3。
   - `ExistingMemoryText.category`：只用于 `tentativeMemories` 快照；提示词构造显式只取 `id/text/stance`，不影响模型输入。
   - `CaptureGates` / `DEFAULT_CAPTURE_GATES`：生产组合没有传 `gates`，实际总是用默认常量；所谓“可配”目前是改 `packages/calibration/src/thresholds.ts` 源码，不是运行时配置。这一点与作者“只给测试用的 gates 选项”的说法一致。

**总体结论**：未发现高严重度缺陷；默认门槛下记忆去留行为与改前一致。主要需要处理的是 ADR 0143 的文档矛盾、真实持久化边界的测试缺口，以及新增同 `decisionKind` 门槛后校准报告的归属文案。
