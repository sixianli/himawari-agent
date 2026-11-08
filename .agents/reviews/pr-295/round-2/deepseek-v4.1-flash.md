# PA-2 复核结论

总体：没有发现会让普通聊天请求开头变化、或让提示字节不确定的改动。主要问题集中在「待确认记忆在抽取提示里不带标记，可能被 `unchanged`/`update` 自动转正」和「待确认记忆无上限、不过期，会挤占主动检查名额」两处；另有几处测试/文档与实现不完全一致。以下按严重度排列。

---

## 中高｜抽取提示把待确认记忆混在 existing 里且不标记，可被自动转正

【读代码证实】

- 文件:行
  - `apps/agent-service/src/production-memory-capture.ts:699-701`（`listActive` 取全部 active，含 tentative）
  - `apps/agent-service/src/production-memory-capture.ts:144-149`（existing 只序列化 `id/text/stance`，没有 tentative 标记）
  - `packages/application/src/services/durable-memory-service.ts:101-114`（`unchanged` 对待确认记忆调用 `confirm`）
  - `packages/application/src/services/durable-memory-service.ts:171-188`（`update` 时 `tentative: false`）

- 问题：本轮把低分候选大量写成 `attributes.tentative` 记忆后，抽取提示的 `existingMemories` 现在会包含它们，但模型看到的格式与正式记忆完全相同。模型只要对某条待确认记忆输出 `unchanged`（或高置信度 `update`），现有 `applyProposal` 就会把它转成正式记忆，随后进入档案块和聊天检索。作者材料只把 `unchanged` 列为已知项，**`update` 分支同样会清掉 tentative，ADR 0179 第 76 行没有写**。

- 证据：
  ```ts
  // production-memory-capture.ts:144-149
  JSON.stringify({
    existingMemories: existing.map(({ id, text, stance }) => ({ id, text, stance: stance ?? null })),
  ```
  ```ts
  // durable-memory-service.ts:112-114
  return current.status === "active" && current.attributes?.tentative === true
    ? this.confirm(current.id, generationId)
    : current;
  ```
  ```ts
  // durable-memory-service.ts:181-188
  ...(proposal.attributes || current.attributes?.tentative
    ? { attributes: { ...(proposal.attributes ?? current.attributes ?? DEFAULT_MEMORY_ATTRIBUTES), tentative: false } }
    : {}),
  ```

- 建议：三选一——①抽取的 `existingMemories` 排除 tentative；②在 `ExistingMemoryText` 增加 `tentative` 并在提示里明确「这是待确认，只有主人本次明确确认才可 unchanged/update」；③让 `unchanged`/`update` 对待确认记忆不自动转正。至少把 `update` 路径补进 ADR 的「已知后果」。

---

## 中｜待确认记忆无上限、不过期、不衰减，且与正式记忆同权占主动检查名额

【读代码证实】

- 文件:行
  - `packages/application/src/services/automatic-memory-service.ts:196-214`（每条符合条件的低分 create 都存）
  - `packages/memory-engine/src/consolidation.ts:249-255`、`426-437`（tentative 不参与整理、不衰减）
  - `packages/application/src/services/proactive-mail-check-service.ts:897-916`（按分数排序，不区分 tentative/confirmed）

- 问题：每次对话最多可新增 8 条待确认记忆，永久保留且被索引；主动检查里它们和正式记忆按分数同权竞争每封 3 条、每批 12 条的名额，可能把正式记忆挤出提示。ADR 0179 第 73、75 行已承认「不加上限和过期」「可能占用名额」，属于已知取舍，但风险仍在。

- 建议：加按 owner 的 tentative 上限或过期/衰减；主动检查召回时像抽取列表一样让正式记忆优先（或给 tentative 单独配额），避免猜的挤掉确定的事实。

---

## 低｜黄金对账没有真正覆盖 tentative 分支

【读代码证实】

- 文件:行
  - `test/integration/fixtures/memory-golden-dataset.json:265-277`（low-confidence 候选没有 `quote`）
  - `test/integration/automatic-memory-golden.test.ts:481-488`

- 问题：`canBeKeptTentatively` 要求 `quote` 非空；该黄金用例没有 quote，仍走 `confidence_below_threshold`，所以新增的 `auditCount(..., "tentative_kept")` 恒为 0，是空转。作者材料说「补黄金对账」，实际这条断言没有验证新路径。

- 证据：
  ```json
  // memory-golden-dataset.json:265-277
  "expectedCandidates": [{ "kind": "durable_fact", "decision": "create", ..., "confidencePermille": 500, "inference": true, ... }]
  ```
  （无 `quote` 字段）

- 建议：给黄金数据集加一个带 quote 的低分 create 用例，并断言 tentative 记忆、`tentative_kept` 审计和 `kept_tentative` 账本；否则删掉这个空转项。

---

## 低｜`AutomaticMemoryResult.tentativeMemoryIds` 生产端无人使用

【读代码证实】

- 文件:行 `packages/application/src/services/automatic-memory-service.ts:60-65`
- 问题：全仓只有测试读取 `result.tentativeMemoryIds`，生产调用方 `production-memory-capture.ts:835` 忽略返回值。功能靠审计/账本已能观察，这个字段目前是多余 API 面。
- 建议：要么在生产里用于日志/指标，要么删除，减少以后误以为它已被消费。

---

## 低｜`canBeKeptTentatively` 只用 `quote` 非空代替 `evidenceVerified`

【读代码证实】

- 文件:行 `packages/application/src/services/automatic-memory-service.ts:79-89`
- 问题：生产抽取器只在 `evidenceVerified` 为真时才带 quote（`production-memory-capture.ts:409-411`），所以生产等价；但服务端口本身允许「quote 非空、attributes.evidenceVerified=false」的候选被存成 tentative，也允许纯空白 quote（`length > 0`）。
- 建议：在服务层同时要求 `candidate.attributes?.evidenceVerified === true`，并 trim 后判断非空；或明确这是端口契约并在类型/文档里写死。

---

## 低｜反向测试缺口：personLinks、抽取提示实际接线

【读代码证实】

- `packages/application/test/tentative-memory-capture.unit.test.ts:123-136` 只反向覆盖 `reminder` 和 `people`，没有 `personLinks`（代码条件里有 `personLinks`）。
- `apps/agent-service/test/confirmed-first-recent.unit.test.ts` 只测纯函数排序，没有端到端证明 `#capture` 实际把 tentative 放进抽取提示并让正式记忆优先（`listActive` 含 tentative 这一点也没有测试守住）。
- 建议：补 personLinks 反向用例；补一个「已存在 tentative 记忆时抽取 prompt 的 existingMemories 顺序/内容」的测试。

---

## 低｜文档/材料表述与实现有出入

【读代码证实】

- 作者材料说「账本记下这次用了哪几条」。实现里 `tentativeMemoryIds` 记的是**本次送给模型的待确认记忆**（`proactive-mail-check-service.ts:790-796, 1013`），真正「用了」的是 `usedMemoryIds`。ADR 0179 第 56 行写对了，作者材料表述不精确；要判断「tentative 是否被用」需要 `usedMemoryIds ∩ tentativeMemoryIds`。
- ADR 0179 第 76 行只写 `unchanged` 会转正，漏了 `update` 也会清 tentative（见第一条）。
- 建议：修正材料措辞；ADR 补 `update` 路径。

---

## 侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 不可逆 / 文档一致性）

- **错误路径**：source secret、extraction failure 早返回都带空 `tentativeMemoryIds`；候选 secret/restricted/transient/sensitive 都在 tentative 分支之前处理，不会误存。`commitCandidate` 失败不吞异常，与普通提交一致，交给上层 `onFailure`。
- **不可信输入**：抽取输出先经 `parseMemoryCandidates` 校验 text/kind/decision/长度/分类，`supersedes` 在 tentative 分支被丢弃，`existingMemoryId` 对 create 不生效；`people/personLinks/reminder` 被排除。没有发现可直接注入危险字段的路径。
- **安全**：tentative 只可能来自非 secret、非 restricted、非 sensitive 的候选；quote/text 仍走受保护的 `content.store`；分类取候选与来源的较高者。未发现新增泄密面。
- **资源耗尽**：见中危第二条——tentative 无上限、不过期、不衰减、不被整理，长期增长。
- **不可逆操作**：tentative 本身可 trash；但 `unchanged`/`update` 会把它转正，这一步不需要主人动作，属于「可逆但会改变普通聊天可见性」的风险，见第一条。
- **规则/文档一致性**：ADR 0143 的修订、ADR 0179、案例手册与代码基本一致；`owner-profile`/提醒/默认向量检索的排除都在代码里得到确认。不一致点是 ADR 漏写 `update` 转正、作者材料「用了哪几条」措辞。
- **提示前缀**：普通聊天没有新增任何会变的值；主动检查和抽取都是后台单次调用，说明段位置符合「固定在前、数据在后」。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会改变普通聊天请求开头。系统提示、工具定义、历史、遮盖都没有改；`includeTentative` 默认 false（`sqlite-memory-operations.ts:242`、`hybrid-memory-provider.ts:165`），档案块 `currentlyValid` 过滤 tentative（`owner-profile-service.ts:100`），提醒 SQL 过滤 `m.tentative = 0`（`sqlite-memory-reminder-operations.ts:12`）。普通聊天仍然只在末尾追加，每轮变化的值仍在最后一条用户消息。
后台调用方面：主动检查提示只在有待确认记忆时、在记忆 JSON 之后插入固定说明（`proactive-mail-check-service.ts:267-274`）；没有待确认记忆时与原来逐字节相同，确认过的记忆条目也不变。抽取提示的 `existingMemories` 会新增/重排待确认记忆（`production-memory-capture.ts:699-701`），但那是后台单次调用的数据段，不是对话历史；没有 tentative 时排序与旧逻辑等价，字节相同。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会因前后文或时间产生新差异。`tentative` 字段和说明只取决于该记忆自身当前状态；没有新增时间字段；`includeTentative` 是绑定参数；`tentativeMemoryIds` 由 Set 转数组，顺序跟随确定的召回顺序。唯一变化是同一记忆转正前后 JSON 会多/少 `"tentative":true`，但那是不同状态、发生在不同后台请求，不影响已发出的对话开头。遮盖逻辑没有改动。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有，且反向用例有效：`tentative-memory-capture.unit.test.ts`（quote 空/update/unchanged/transient、reminder/people、sensitive/restricted、高置信度都会失败）、`owner-profile-service.unit.test.ts`（tentative 不进档案块）、`production-memory-capture.test.ts`（tentative 落库/投影/账本）、`proactive-mail-check.test.ts`（有/无 tentative 的提示与账本）、`production-mail-embedding.unit.test.ts`（`includeTentative` 接线）、`memory-consolidation.test.ts`（默认排除/开关包含）、`confirmed-first-recent.unit.test.ts`。缺口是：黄金对账的 `tentative_kept` 项是空转（数据集无 quote）；`personLinks` 和「抽取提示实际包含 tentative」没有端到端测试。

**4. 每个产生/修改的值的生产端和使用端都能接受吗？**
- `tentative_kept` 审计结果：生产端只写诊断日志，`SensitiveInterceptionRecorder` 的 partial map 忽略未知值，无 DB CHECK，能接受。
- `kept_tentative` 账本原因码：`decision_ledger.reason_code` 只校验 1–64 长度，`outcome='kept'` 合法，能接受。
- `tentativeMemoryIds`（账本 inputs）：`sqlite-proactive-operations.ts:539` 用 `ids()`（1–256、去重、≤500）校验，`sqlite-decision-ledger-operations.ts:162` 读回时有默认 `[]`；`DecisionLedgerEntry.inputs = Required<DecisionInputs>` 的唯一读取实现已补，测试 fake 已补，能接受。
- `includeTentative`：端口 → `DurableMemoryService` → `HybridMemoryProvider` → `SqliteMemoryOperations` 全链路透传，SQL 四个查询都绑定该参数，默认 false 保持旧行为。
- `tentative` 字段：`ProactiveMemoryHit` → `#batchMemories` → prompt JSON / 说明条件 / trace 全链路一致。
- 提示词 id `mail.judgment.tentative-note`：代码 id 与 manifest id 一致，manifest 测试会校验 digest。
- `AutomaticMemoryResult.tentativeMemoryIds`：生产未消费（见低危项）。
没有发现 I-73 式的「产生端能生成、使用端校验不接受」问题。

---

## 未核实 / 推测

- 【未核实】`prompt-manifest.json:323` 的 sha256 是否与 `mail.ts:48` 的 segments 摘要一致（无法在本环境计算哈希；`prompt-catalog.unit.test.ts` 会校验）。
- 【未核实】作者称云端容器已跑过全部单元/集成测试；我只核对了测试代码存在与反向用例逻辑，未实际运行。
- 【推测】`update` 自动转正的触发频率取决于模型行为，无法从代码量化；但路径确实存在。
- 【推测】待确认记忆长期增长对主动检查名额的实际挤占程度取决于生产召回分布，代码只能确认「同权排序、无上限」。
