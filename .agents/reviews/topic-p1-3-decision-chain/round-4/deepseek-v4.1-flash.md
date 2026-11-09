## 侧重检查（先做的一节）

我按你给的侧重先查了这些路径，结论如下：

- **不可撤销操作**：`memory.overview.read` 开头确实会 `#purgeExpiredTrash()`，而它调用 `memory.delete`（`apps/agent-service/src/production-memory-control.ts:206-214`、`:327`）。方案说“链不调用会清回收站的 query()”是对的；但 7g 的观测点只断言 `decisionLedger.append` 和 payload put/release 零调用，**没有断言 delete / listExpiredTrash 零调用**，这个保护没有落到测试上。见 C1。
- **资源耗尽**：每条记忆都 `readBasisChain`，而该实现自身就有深度 8、节点 200 的上限（`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:19-20`、`:282-334`）。100 条记忆 × 200 节点 = 最多 2 万节点，且每节点一条 SQL；若再为节点读正文，就是 2 万次解密。方案没有总节点/总查询预算。见 C4。
- **安全/敏感数据**：`textHidden` 只覆盖 `text`，但方案同时返回 `history 首条 quote`、`supersededBy` 文本和 `sourceRefs`；这些是原文，敏感记忆时没有遮挡规则。见 C5。
- **错误路径/不可信输入**：owner/agent 范围校验在 SQL 层（`WHERE owner_id = ? AND agent_id = ?`）是好的；但 `entryFromRow` 的 `JSON.parse` 没有保护（`sqlite-decision-ledger-operations.ts:137`），损坏的 inputs 会让整条链失败，与“单条读失败只让该条显示无记录”矛盾。见 C14。
- **规则、文档、代码一致**：设计基线只引用了“不新增通用内部面板”，漏掉同一条规则的另一半“特定用途面板须用户批准原型并存为新基线版本”（`.agents/instructions/web-design-baselines.md:9`）。`memory_candidate` 把 `reasonCode` 写进 `ruleIds` 与新写入约定矛盾（`automatic-memory-service.ts:570-573`）。见 C8、C10。

---

## 一、证实的（代码/文档可逐条核对）

### C1（高）读接口可能间接执行不可撤销的回收站清理；测试没有守住

- **问题**：方案明确“链不调用 `query()`”，但把概览的单条组装抽成公共方法时，如果公共方法里带着 `#purgeExpiredTrash()` 或调用了 `query()`，链就会在“读”时删除过期回收站记忆。方案 7g 只检查 `decisionLedger.append`、payload 读写，不检查 `memory.delete`/`listExpiredTrash`，因此这个最危险的写路径没有门槛。
- **证据**：
  - `production-memory-control.ts:206-214`：`#purgeExpiredTrash()` 对过期回收站逐条 `await this.options.memory.delete(...)`。
  - `production-memory-control.ts:327`：`query()` 开头 `await this.#purgeExpiredTrash();`。
  - 方案 7g 原文只写“断言 decisionLedger.append、payload put/release 零调用”。
  - HTTP 语义：读操作应当是 safe 的。RFC 9110 §9.2.1：“Request methods are considered **‘safe’** if their defined semantics are essentially **read-only**; i.e., the client does not request, and does not expect, any state change on the origin server...”。<https://www.rfc-editor.org/rfc/rfc9110#section-9.2.1>
- **建议**：把“概览组装”抽成**纯函数/纯只读方法**，不包含 purge；链只调用这个方法。7g 增加断言：`book.listExpiredTrash`、`memory.delete` 零调用；再加一个集成反向用例：造一条已超过保留期的 trashed 记忆，调用 `decision.chain.read` 后它仍存在、没有被删。

### C2（高）方案里的 `counts` 不在 `DecisionLedgerPort.read` 能返回的字段里

- **问题**：方案第 3 条说 chain 的 decision 段包含“kind、时间、结论、原因代码、**counts**、评价与时间”。但现有 `DecisionLedgerEntry` 和 `entryColumns` 没有 `counts`；`counts` 只在 `ProactiveDecision` 的 `decisionColumns`/`decisionFromRow` 里。若按“新增 `DecisionLedgerPort.read` 复用 `entryFromRow`”实现，`counts` 根本拿不到。
- **证据**：
  - `packages/application/src/ports/decision-ledger.ts:113-130`：`DecisionLedgerEntry` 字段中无 `counts`。
  - `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:130-134`：`entryColumns` 选择列无 `counts`；`:136-203` 的 `entryFromRow` 也没有 `counts`。
  - `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:58-60`：`decisionColumns` 才有 `counts`；`:83-88` 的 `decisionFromRow` 才解析它。
- **建议**：明确二选一：
  1. 扩展 `read` 的返回/`entryColumns`，把 `counts` 查出来并解析（同时扩展应用层 `DecisionLedgerEntry` 或定义一个独立的 `DecisionRecordRead` 读模型）；或
  2. 链不返回 `counts`，UI 用提醒页现有 `overview.decisions` 行上的 `counts`。无论哪种，都要在网关 schema/fixture 和测试里写清，避免到实现时才发现端口不够用。

### C3（高）直接复用“概览单条组装”会丢掉 deleted/missing 记忆，和方案 3/5 自相矛盾

- **问题**：方案要求记忆状态包含 `missing`，并且“单条读失败只让该条显示「无记录」”。但现有概览组装对读不到正文的记录直接 `continue`，也不再输出非 active/archived/trashed 的状态。把这段原样抽成公共方法，链里被删除或读不到正文的记忆会**整条消失**，而不是显示 `missing`/“无记录”。
- **证据**：
  - `production-memory-control.ts:368-372`：
    ```ts
    if (memory.status !== "active" && memory.status !== "archived" && memory.status !== "trashed")
      continue;
    const text = await textOfRef(memory.contentRef);
    if (!text) continue;
    ```
  - `production-memory-control.ts:340-347`：`readText(...).catch(() => "")`，读失败变成空串，再被上面的 `if (!text) continue` 丢掉。
  - ADR 0186 也明确说“概览里读不出文字的记忆被跳过”（`docs/adr/0186-memory-jumps-to-the-owners-original-message.md:52`）。
- **建议**：把“构造单条记忆视图”和“是否跳过”分开：抽出的方法接受 `{ includeMissing: boolean }` 或返回 `{ item, readable }`；概览继续跳过，链不跳过。增加回归用例：一条 `contentRef` 缺失/不可解密的记忆，概览仍跳过，链显示 `status: "missing"` 和“无记录”。

### C4（中）每条记忆都展开 200 节点的依据链，缺少总预算，可能打爆单次请求

- **问题**：方案限制“记忆 100 条”，但每条记忆都 `readBasisChain`，而 `readBasisChain` 单次最多 200 节点（深度 8）。最坏是 2 万节点；每个节点一次 SQL，若为节点读记忆正文就再加 2 万次 payload 解密。方案没有“全链总节点上限”或“总查询/解密预算”，也没有分页。
- **证据**：
  - 方案第 3 条：“每条记忆的 basis（复用 readBasisChain，节点上限 200，complete 标志）”“记忆……上限 100 条”。
  - `sqlite-memory-consolidation-operations.ts:19-20`：`MEMORY_BASIS_CHAIN_MAX_DEPTH = 8`、`MEMORY_BASIS_CHAIN_MAX_NODES = 200`。
  - `sqlite-memory-consolidation-operations.ts:282-334`：`walk()` 每层每节点都执行 SQL。
  - OWASP API4:2023 明确把“Number of operations to perform in a single API client request”和“Number of records per page to return in a single request-response”列为缺失上限时的风险，并建议“maximum number of elements in arrays”。<https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/>
- **建议**：顶层快照只返回每条记忆的 basis 根节点/摘要；依据链按需展开（点开某条记忆再调 `memory.basis.read`），或对整条链设总节点 200、总 SQL/解密预算。增加 100 条记忆 × 200 节点的资源测试，并在 schema 里给所有数组加明确上限。

### C5（中）敏感记忆只隐藏 `text`，却返回原文 `quote`/`history`/`supersededBy` 文本，和“不新增敏感文字暴露面”矛盾

- **问题**：方案第 6 条承诺“不可见时 textHidden……不在提醒页新增敏感文字暴露面”，但第 3 条又要求记忆条目携带“history 首条 quote”“supersededBy 及其文本”。这些是原文，可能包含敏感内容；`reviewMemoryVisible` 只判断分类，不覆盖 quote。
- **证据**：
  - `production-memory-control.ts:374-385`：历史节点无条件带 `quote: ...`。
  - `packages/gateway-contracts/src/contracts-v2.ts:1049-1055`：快照 schema 里 `history.quote` 是 `nullable(boundedString(2000))`。
  - `apps/control-center/src/components/memory-page.tsx:249-252`：页面无条件渲染 `node.quote`。
  - 方案第 6 条原文：“不可见时 textHidden，提示去记忆页看，不在提醒页新增敏感文字暴露面。”
- **建议**：对 `reviewMemoryVisible(classification) === false` 的记忆，**所有正文类字段**（`text`、`history[].text`、`history[].quote`、`supersededBy` 的文本、`sourceRefs` 是否展示）统一隐藏或省略；UI 只显示“去记忆页看”。增加一条测试：敏感记忆的 quote 里放一个哨兵字符串，`decision.chain.read` 返回里不得出现该哨兵。

### C6（中）rules 的状态枚举缺 `not_recorded`，历史 Gmail 行会被误显示成“没有命中规则”

- **问题**：方案对 memories 定义了 `recorded|none|not_recorded`，但对 rules 只定义了 `recorded|none|not_applicable`。ADR 0147 明确说旧的 Gmail 行 `inputs` 固定是 `'{}'`；这些行没有 `ruleIds`，会被当成“没有命中规则”（`none`），而不是“没有记录”。同样问题也适用于 `relatedRead`、`memoryRecall`、`sourceIds` 缺失。
- **证据**：
  - 方案第 3 条 rules 段：“state: recorded | none | not_applicable”。
  - 方案第 5 条：“每一环缺了都显示「无记录」”。
  - ADR 0147 背景：“Gmail 行的 `inputs` 列固定写 `'{}'`”（`docs/adr/0147-keep-model-prompt-and-answer-of-each-gmail-check-with-the-ledger.md:28`）。
  - `sqlite-decision-ledger-operations.ts:157-201`：缺失字段被补成 `"off"`/`false`/空数组，单看 `entry` 无法区分。
- **建议**：为**每一个可选段**统一 `recorded|none|not_recorded|not_applicable`，全部由 `inputFields` 驱动；`inputs = {}` 时 rules/recall/related/sourceIds 都显示“无记录”。增加反向用例：插入 `inputs='{}'` 的 Gmail 行，断言不显示“没有命中规则”。

### C7（中）`DecisionLedgerPort.append` 接受完整 `DecisionInputs`，但 `insertLedgerRow` 只持久化 4 个字段，其余被静默丢弃

- **问题**：方案要“读回完整 inputs”，但没有改 non-proactive 的写入路径。`DecisionInputs` 里已有 `sourceIds`、`floorHits`、`memoryInjected`、`usedMemoryIds`、`tentativeMemoryIds`、`memoryByMail`、`memoryRecall`、`related*`，但 `insertLedgerRow` 只写 `memoryIds/ruleIds/batchId/resultMemoryIds`。今天 Gmail 走 `ProactiveStorePort.record` 才写全；将来任何新 kind 或新写入方用 `DecisionLedgerPort.append` 写这些字段，会被静默丢掉，链显示“无记录”而写入方以为记下了。
- **证据**：
  - `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:114-119`：`JSON.stringify` 只有 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds`。
  - `packages/application/src/ports/decision-ledger.ts:71-92`：`DecisionInputs` 包含全部字段。
  - `validateLedgerWrite`（`sqlite-decision-ledger-operations.ts:59-66`）也只校验 `memoryIds/ruleIds/resultMemoryIds`。
- **建议**：要么让 `insertLedgerRow` 持久化全部字段并在 `validateLedgerWrite` 校验它们，要么让 `append` 对未持久化字段明确报错（不静默丢）。增加“每个 `DecisionInputs` 键 append→read 往返”的契约测试；这正是 I-73 的教训：只看改动，不问两端能不能接上（`docs/incidents-and-gates.md:112`）。

### C8（中）`memory_candidate` 的 `ruleIds=[reasonCode]` 与新写入约定矛盾，链的规则段会歧义

- **问题**：方案说“约定文档写明新写入方不得再这么做”，但现有写入方 `automatic-memory-service.ts:572` 就在这么做，方案又说不改。读取端如果按 `ruleIds` 查登记册，会把 `kept/discarded/...` 当成未知规则；如果按 `kind` 忽略，又和“覆盖所有 kind”的规则段定义不清。
- **证据**：
  - `packages/application/src/services/automatic-memory-service.ts:570-573`：
    ```ts
    await this.options.ledger.append({
      ...write,
      inputs: { memoryIds: write.inputs.memoryIds, ruleIds: [reasonCode] },
    });
    ```
  - 方案第 4 条：“memory_candidate 把 reasonCode 写进 ruleIds 是既有形状，不改，约定文档写明新写入方不得再这么做”。
- **建议**：修掉这个写入方（`ruleIds: []`，reasonCode 只在 `reasonCode` 列），或在 `DecisionInputs` 增加独立的 `reasonCodes`。链读取端明确按 `kind` 分支：非 proactive 的 rules 段 `not_applicable`，绝不把 `ruleIds` 当规则登记册查。增加测试：`memory_candidate` 链不出现“unknown rule”。

### C9（中）7b 承诺展示“被判断的邮件/读过的前情邮件”，但依赖清单里没有任何邮件读取器

- **问题**：`inputs.sourceIds` 和 `relatedByMail` 都只是 message id，账本里没有发件人/标题；`ProactiveStorePort` 也没有“按 decisionId 读 processed messages”的方法（`listProcessed` 需要 outcome + since + limit）。方案第 2 条的新类依赖只有账本、记忆状态/历史/来源消息、consolidation、规则登记册、可选模型 IO；第 7b 条却要展示邮件。两者对不上。
- **证据**：
  - `packages/application/src/ports/proactive-checks.ts:289-399`：`ProactiveStorePort` 无按 decisionId 读邮件的方法；`:337-343` 的 `listProcessed` 只按 `since/outcome/limit`。
  - 方案第 2 条依赖清单无邮件/processor 读取；第 7b 条要求“被判断的邮件（inputs.sourceIds）和读过的前情邮件（relatedByMail、relatedRead、relatedStats）”。
- **建议**：二选一：
  1. 7b 明确只展示邮件编号/数量，不展示发件人和标题；或
  2. 新增一个按 decisionId 读取 processed messages 的 scoped 端口（含 `headerRef` 的解封和上限），并把它列进依赖；否则“缺失时显示无记录”没有实现基础。

### C10（中）设计基线引用不完整：特定用途面板还要求“用户批准原型并存为新基线版本”

- **问题**：方案只引用了基线的“不新增堆积内部运行信息的通用面板”，但同一条规则后半句明确：“有特定用途的面板或页面，在用户批准其原型并将其另存为新的基线版本后，可以添加。”提醒页上的“依据”抽屉是一个特定用途面板；方案没有原型批准/新基线版本这一步，也没有按 `.agents/instructions/web-design-baselines.md:6` 读/更新 `docs/ui-ux-design-guide.md`。
- **证据**：
  - `.agents/instructions/web-design-baselines.md:9`：“……不得新增堆积内部运行信息（模型、token、步骤、审批、内部记录）的通用面板或页面。**有特定用途的面板或页面，在用户批准其原型并将其另存为新的基线版本后，可以添加。**”
  - `.agents/instructions/web-design-baselines.md:6`：要求先读 `docs/ui-ux-design-guide.md`，交付时把新 UI/UX 问题加进去，能自动检查的加检查。
- **建议**：在方案第 8 条前加“先出原型，Andy 批准后存为新的 `docs/assets/control-center/...` 基线版本”；同时按第 6 条更新 `docs/ui-ux-design-guide.md` 和 `scripts/check-layout-audit.mjs` 场景。

### C11（中）决策已被清除时，方案返回 NOT_FOUND 错误；UI 只有从列表点进来的入口，没有“记录已清除”空状态

- **问题**：`decision.chain.read` 不存在/不是自己的返回 NOT_FOUND（`DECISION_RECORD_NOT_FOUND`）。但入口来自提醒检查记录（可能已过期/已清除）；`gateway-client.ts` 只读取 `error.code`，不读 message，所以 `DECISION_RECORD_NOT_FOUND` 到 UI 只会变成 `PORT_NOT_FOUND`。方案第 5 条定义了各环节“无记录”，唯独没有定义“整条决策记录已被清除”时抽屉显示什么。
- **证据**：
  - `apps/control-center/src/gateway-client.ts:324-326`：`new Error(typeof code === "string" ? code : "CONTROL_CENTER_REQUEST_REJECTED")`——只用 `error.code`。
  - ADR 0147 说清除主动检查记录会删账本行（`docs/adr/0147-...md:46`）；ADR 0186 对“点击时快照已旧”有先例（重新读概览、按钮失效时显示“来源已不可查”）。
  - `production-reminders.tsx:542-639`：记录行来自 `overview.decisions`，可能是旧快照。
- **建议**：入口点击时 404/`PORT_NOT_FOUND` 不当作错误弹窗，而是关闭抽屉、刷新提醒记录并显示“这条记录已被清除”；加三语文案和单测。若确实要区分，给网关一个可识别的错误码，而不是只靠 message。

### C12（低）截断前是否排序、并集是否遗漏 `tentativeMemoryIds`，方案没有定义

- **问题**：方案说“记忆取 memoryIds ∪ memoryByMail ∪ usedMemoryIds 去重，上限 100 条，超出标 truncated；一切按编号排序”。但没有说“先排序再截断”还是“先截断再排序”，也没有说 `truncated` 时保留哪 100 条。`memoryByMail`/`relatedByMail`/`floorHits` 是对象，顺序是写入时的插入顺序。`tentativeMemoryIds` 没有进并集（今天它是 `memoryIds` 的子集，但这是写入端事实，不是端口不变量）。
- **证据**：
  - 方案第 3 条并集列表只写三个来源。
  - `packages/application/src/services/proactive-mail-check-service.ts:1076-1082`：`tentativeMemoryIds` 是 `memoryIds` 的子集；`:1294-1308` 同时写两者。
  - `inputFields` 设计只对键排序（方案 7c），没有对记忆集合/映射排序的规则。
- **建议**：明确定义：先对完整 id 集合按 UTF-8/编号排序，再取前 100；所有对象按 key 排序输出；`truncated` 附带总条数和被省略的 id 数；把 `tentativeMemoryIds` 纳入并集或明确写“它是 memoryIds 的子集”。

### C13（低）若把 `unrecorded` 加进 `DecisionInputs.memoryRecall` 类型，会漏掉校准侧消费者

- **问题**：方案 7c 说“recall 状态新增 unrecorded”。如果只是链快照的枚举没问题；如果改到 `DecisionInputs`/`DecisionLedgerEntry`，`attributeGap` 只把 `off/partial/failed` 当 `notRetrieved`，`unrecorded` 会落到 `wrongJudgment`。
- **证据**：`packages/calibration/src/index.ts:528-537`：
  ```ts
  if (input.memoryRecall === "off" || ... "partial" || ... "failed") return "notRetrieved";
  if (input.memoryRecall === "ok" && input.memoryHitsForMail === 0) return "notRemembered";
  return "wrongJudgment";
  ```
- **建议**：`unrecorded` 只定义在 `decision.chain.snapshot` 的 schema/类型里，不要改 `DecisionInputs`；如果坚持改，就同时更新 `attributeGap` 和所有消费者，并加单测。

### C14（低）`entryFromRow` 的 `JSON.parse` 没有降级，损坏的 inputs 会让整条链失败

- **问题**：方案承诺“单条读失败只让该条显示无记录，不让整条链失败”，但 `entryFromRow` 直接 `JSON.parse(row["inputs"])`；损坏/非对象 inputs 会抛异常。若 `counts` 也加进来，同样问题。
- **证据**：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:136-137`。
- **建议**：在 `read`/`entryFromRow` 里对 `JSON.parse` 做 try/catch，解析失败返回 `inputFields: []` 和“记录损坏”状态；增加一条损坏 inputs 的集成反向用例。

### C15（低）“覆盖所有 kind”与“只有提醒页一个入口”范围不一致；7e 的测试场景在实际页面上不成立

- **问题**：方案第 2 条说覆盖所有 kind；第 8 条只在提醒页“提醒检查记录”每行加入口。非 proactive（memory_candidate/consolidation/context_truncation/retrieval_degrade/external_read）没有入口。7e 又说“proactive 不可用而记忆可用时入口仍在”，但提醒页本身只有 `proactive.overview.read` 可用时才渲染（`apps/control-center/src/proactive.ts:87-92`）；proactive 不可用时没有记录行，入口不会“仍在”。
- **证据**：`proactive.ts:87-92`；`proactive-reminders.tsx:542-639`（记录行来自 `proactive.overview`）。
- **建议**：要么把“覆盖所有 kind”降为“网关覆盖，UI 先只做 Gmail”，并改掉 7e 的测试场景；要么在每日打分/记忆整理等有非 proactive 记录的地方也加入口。入口能力门应与入口所在页面一致。

### C16（低）方案内部矛盾：第 2 条列了“可选模型输入输出读取”，第 7 条又说“不加第二个查询”

- **问题**：如果第一版不展示 prompt/answer，`ProductionDecisionChain` 就不应把模型 IO 读取列成依赖；否则实现者容易顺手接上，重蹈“存的是出口遮盖前的 prompt”的敏感暴露。
- **证据**：方案第 2 条依赖“可选的模型输入输出读取”；第 7 条“第一版不展示、不加第二个查询”。
- **建议**：第一版删除这个依赖，等做“读取端再过一次出口级遮盖”时再加。

---

## 二、推测 / 未核实

- **未核实（未运行测试）**：当前环境只允许读代码和 GitHub 之外的网页，我没有运行 `npm test`/集成测试，因此“反向用例是否真的会失败”只能按代码路径推断，不能给出实际失败输出。方案第 10 条的反向用例必须在**旧代码/去掉修复后**实跑失败，否则不算门槛。
- **推测**：如果 `ProductionDecisionChain` 直接从 `ProductionMemoryControl` 取 `readText`，而没有重新做 `reviewMemoryVisible`，那么 C5 会在实现中发生；如果实现时另建纯函数，则 C3/C5 可以避免。方案没有把“链只调用纯方法”写成硬约束。
- **推测**：`ProductionMemoryControl` 的 `query()` 目前对 `memory.basis.read` 也走同一个 `query` 方法（`:323`），如果链复用 `query()` 也会触及 purge；必须确认链不经过 `query()` 的 `memory.overview.read` 分支。
- **未核实**：7b 是否其实只打算展示 `sourceIds`/`relatedByMail` 的 id 和数量；如果是，C9 可从“缺依赖”降为“文案问题”，但方案应写明“不展示邮件主题/发件人”。
- **未核实**：真实浏览器 fixture（`test/e2e/fixtures/control-center-browser-server.mjs`）是否能构造“依据链超限/敏感记忆/别的主人编号”这些场景；这决定第 10 条的浏览器反向用例是否可落地。

---

## 三、如果由我来定，我会怎样改这份方案

1. **先定读模型，不硬套 `DecisionLedgerEntry`**：新增 `DecisionRecordRead`，显式包含 `counts`、`inputs`、`inputFields`、`ownerRating/ratedAt`。持久层加 `decisionLedger.read`，SELECT 里补 `counts` 并按 row 解析；应用层端口同步。这样 C2 不会到实现阶段才发现。
2. **链只读，且用纯方法**：把概览的“单条记忆视图”抽成纯函数 `buildMemoryView(record, { includeMissing })`，不包含 purge；`ProductionMemoryControl.query()` 继续包 purge，链只调纯函数。7g 改为断言 `memory.delete`、`book.listExpiredTrash`、`decisionLedger.append`、payload put/release 全部零调用，并加“过期回收站不被删”的集成用例。
3. **依据链按需展开**：顶层快照只给每条记忆的 basis 根/摘要；用户点开某条记忆再调 `memory.basis.read`。如果坚持一次性返回，设**全链总节点 200**（不是每条 200）和总 SQL/解密预算，超出标 `truncated` 并返回总数；加 100 条记忆的资源测试。
4. **敏感字段一次遮全**：抽一个 `visibleMemoryText(record)` 判断，统一套到 `text`、`history[].text`、`history[].quote`、`supersededBy` 文本；不可见时这些字段全部为空/省略。加哨兵反向用例。
5. **每个可选段统一状态**：`recorded | none | not_recorded | not_applicable`，由 `inputFields` 驱动；`inputs={}` 的旧 Gmail 行显示“无记录”，不是“没有命中规则”。方案第 3/5 条改成同一套枚举。
6. **修掉 `memory_candidate` 的 `ruleIds` 滥用**：要么改写入方，要么加 `reasonCodes`；链的规则段按 `kind` 分支，非 proactive 一律 `not_applicable`。写“约定文档”时不要写一条代码正在违反的约定。
7. **7b 明确范围**：第一版只展示“被判断邮件编号 + 前情邮件编号/统计”，不展示发件人和标题；若要展示邮件内容，新增按 decisionId 读取 processed messages 的 scoped 端口，并给出上限/解封策略和“已清除”状态。
8. **补齐契约链路**：`GATEWAY_V2_MESSAGE_TYPES`、schema、fixture、`PRODUCTION_*_OPERATIONS`、approval-gateway 显式分支、http-composition installed 列表、control-center availability 全部登记；`counts`、`truncated`、`textHidden`、`missing`、`not_recorded` 都进 schema。加一条与 I-73 同类的测试：每个新产生的 id/字段/枚举都能通过使用端的校验。
9. **错误路径**：`read` 的 `JSON.parse` 降级；`NOT_FOUND` 在 UI 变成“记录已清除”空状态并刷新列表，而不是错误弹窗；给 `PORT_NOT_FOUND` 一个 UI 映射或可识别错误码。
10. **UI 流程**：先出原型、Andy 批准、存为新基线版本；更新 `docs/ui-ux-design-guide.md` 和 `scripts/check-layout-audit.mjs`。入口能力门与入口所在页面一致；如果“覆盖所有 kind”是目标，就在每日打分/记忆整理也加入口，否则把目标降为“网关覆盖、UI 先做 Gmail”。
11. **测试先红后绿**：C1/C3/C5/C6/C7/C9/C11 各自先写一条在现有代码上失败的用例，再实现。C4 加资源上限测试，C12 加排序/截断确定性测试。
12. **文档**：写入约定文档不要只写“新写入方不得再这么做”，要列出**当前每个写入方实际持久化的字段**（`append` vs `proactive.record`），并加契约测试防止再出现“端口接受、存储丢弃”。

---

## 四、逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 方案第 11 条明确不动发给模型的请求、提示词目录、迁移；新增的是网关查询和网页抽屉。链读取的是 `decision_ledger`、记忆状态/历史、`readBasisChain`，都不在模型请求组装路径上；模型记忆注入仍走 `production-memory-recall.ts` / `production-run-memory.ts`，与本改动无关。发给模型的内容仍然只在末尾追加，每轮变化的值（时间、本轮记忆、工具状态、运行环境说明）仍在最后一条用户消息里。依据：`.claude/rules/prompt-prefix.md:27-29、35`；ADR 0149；OpenAI 官方：“Preserve conversation history ... Append new messages rather than rewriting earlier turns.” <https://developers.openai.com/api/docs/guides/prompt-caching>；Anthropic：“Prompt caching references the entire prompt: `tools`, `system`, and `messages` (in that order), up to and including the block designated with `cache_control`.” <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>

**前提**：抽取“概览单条组装”只能影响 UI 读路径，不能改 `ProductionMemoryRecall`/`production-run-memory` 的记忆选择、排序或注入内容。方案没有写这条约束，建议补上。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**对模型请求：不会。** 对**新的网关快照**：如果不加约束，会。方案说“一切按编号排序”，但没有定义：
- 截断是在排序前还是排序后；
- `memoryByMail`/`relatedByMail`/`floorHits` 这些对象的 key 顺序（JSON 对象保留写入顺序，不是排序）；
- `readBasisChain` 的节点顺序是否在快照里显式排序；
- 是否包含 `generatedAt` 这类读取时刻字段；
- `changedSinceDecision` 用 `updatedAt > decidedAt` 的字符串比较（ISO UTC 字符串可比，但要固定格式）。

建议：所有数组按 id 排序，所有对象按 key 排序，截断在排序后，快照不包含读取时刻的 `generatedAt`（或只放 envelope 且不参与任何比较）；`changedSinceDecision` 用解析后的时间比较。这样同一份数据每次读出的字节相同。

### 3. 有没有对应的自动检查，反向用例真的会失败？

**有骨架，但不足以证明关键风险。** 方案第 10 条列了真实 SQLite、契约、登记册、UI、浏览器测试，方向是对的；但以下反向用例缺了，且它们对应的都是“会出错”：
- C1：没有“读不删除过期回收站”的断言；
- C3：没有“文本读不出的记忆在链里显示 missing”的用例（现有概览会 `continue`）；
- C5：没有“敏感记忆的 quote/history 不泄露”的哨兵用例；
- C6：没有 `inputs={}` 时 rules/related/recall 显示“无记录”的用例；
- C7：没有“每个 `DecisionInputs` 键 append→read 往返”的用例；
- C8：没有 `memory_candidate` 的 `ruleIds=reasonCode` 不被当成 unknown rule 的用例；
- C11：没有“记录已被清除时抽屉显示空状态”的用例；
- C14：没有损坏 `inputs` JSON 的降级用例；
- C4：没有 100 条记忆 × 200 节点的资源上限用例。

另外，**这些反向用例必须先在当前代码/去掉修复后失败**；只是“现有代码也通过”的用例不算门槛。我未运行测试，无法给出实际失败输出，这一点标“未核实”。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

逐项核对如下：

| 值 | 产生处 | 使用处/校验 | 结论 |
| --- | --- | --- | --- |
| `decision.chain.read` / `decision.chain.snapshot` 字符串 | contracts-v2 新 schema、`PRODUCTION_*_OPERATIONS` | `GATEWAY_V2_MESSAGE_TYPES`（`contracts-v2.ts:21-147`）、schema 映射（`:2391+`）、fixture（`gateway-v2.fixture.ts:375`）、`installedOperations`（`approval-gateway.ts:248-260`、`http-composition.ts:661-671`）、control-center availability（`proactive.ts:87-92`） | 方案提到大部分，但没明确 `GATEWAY_V2_MESSAGE_TYPES` 和客户端 availability；必须逐处加，否则契约测试/页面不生效 |
| `decisionId` | 提醒 overview 的 `decision.id` | `machineString`（`validation.ts:49-59`）；现有 `proactive.decision.rate` 也用它（`contracts-v2.ts:535-537`） | 可以；id 形如 `proactive-decision:<uuid>`，长度/字符符合 |
| `counts` | `decision_ledger.counts`（`sqlite-proactive-operations.ts:58-60`） | 新 `DecisionLedgerPort.read`/`entryFromRow`（`sqlite-decision-ledger-operations.ts:130-134`）没有它 | **不接受**，见 C2 |
| `inputFields` | `entryFromRow` 原始 JSON | 链读取端；`list/listReviewPool` 的消费者不关心 | 可以，但要明确是数组还是对象，并锁定“只包含 `DecisionInputs` 的键” |
| `memoryRecall: "unrecorded"` | 链快照 | `attributeGap`（`calibration/src/index.ts:528-537`）只认 `off/partial/failed` | 若只用于快照可以；若加到 `DecisionInputs` 则**不接受**，见 C13 |
| `status: "missing"` | 链快照 | `memorySourceState`（`apps/control-center/src/memory-source.ts:14-30`）按 `MemoryItem` 的 status/字段分类，不认 `missing` | 需要 UI 适配层或扩展 `memorySourceState`，否则分类/跳转会错 |
| `textHidden` + quote/history | 链快照 | 页面渲染 | `textHidden` 只保护 text；quote/history 未保护，见 C5 |
| `truncated` | 链快照 | 新 schema | 必须进 schema/fixture；否则契约校验会丢字段 |
| rule id | `floorHitIds` / `FLOOR_RULE_IDS`（`proactive-rules.ts:29-52`） | 新登记册；链读取端 | 双向测试可以；但 `memory_candidate` 的 `ruleIds` 是 reasonCode，见 C8 |
| `sourceIds` / `relatedByMail` | `proactive-mail-check-service.ts:1294-1308`；`sqlite-proactive-operations.ts:665-684` | 链 7b | 只有 message id，没有邮件读取器，见 C9 |
| `memoryInjected` / `usedMemoryIds` / `tentativeMemoryIds` | 同上 | 链读取端 | `tentativeMemoryIds` 未进并集，见 C12 |
| `DECISION_RECORD_NOT_FOUND` | 新链/端口 | `gateway-client.ts:324-326` 只读 `code`，不读 message | UI 拿不到这个具体文案，见 C11 |
| `counts`/`inputs` 的 `JSON.parse` | DB 列 | `entryFromRow` | 损坏时抛异常，见 C14 |

**结论**：方案对“新加的 id 能过 `machineString`”这类问题有意识（I-73 的教训），但对**端口字段 vs 存储字段**（C2/C7）、**快照字段 vs UI 分类**（C12/C13）、**新错误码 vs 客户端如何显示**（C11）、**新枚举 vs 所有消费者**（C6/C13）还没有逐处核对。按 I-73 的标准，这些必须在实现前补成契约测试。

---

**总评**：方案的主方向（只读、覆盖所有 kind、按需展示、敏感记忆复用 `reviewMemoryVisible`、不展示 pre-redaction 的模型 IO）是对的；但它在“读接口不写库”和“缺失记忆仍显示”这两个最关键的只读语义上没有把测试写死，在“端口能返回什么”和“UI 能消费什么”上也有几处硬缺口。建议先按 C1/C2/C3/C4/C5 改方案，再进入实现。
