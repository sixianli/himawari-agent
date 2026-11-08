# PA-2 复核结论

## 发现（按严重度从高到低）

### 1. 【中高】待确认记忆会被回灌进下一次抽取提示，且 `unchanged` 不校验原话，存在“模型自己把猜测转正”的路径
- 位置：`apps/agent-service/src/production-memory-capture.ts:689`、`:134`、`:291`；`packages/application/src/services/durable-memory-service.ts:112`
- 问题：低分候选现在以 `active + tentative` 存下来，下一次记忆抽取的 `existingMemories` 直接来自 `listActive`，没有过滤或标注 `tentative`；同时 `unchanged` 候选不要求 `evidenceVerified`。模型只要输出高置信度 `unchanged`（或高置信度 `create` 复述该猜测），就能把主人从未确认过的猜测转成正式记忆。
- 证据（读代码证实）：
  - `production-memory-capture.ts:689`：
    ```ts
    const recent = [...(await this.options.state.listActive(ownerId, agentId))]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAXIMUM_RECENT_MEMORIES);
    ```
    后面的过滤（`:694-701`）只排除 `status`、分类、`supersededBy`，没有排除 `tentative`。
  - `production-memory-capture.ts:134`：
    ```ts
    existingMemories: existing.map(({ id, text, stance }) => ({ id, text, stance: stance ?? null })),
    ```
    没有 `tentative` 字段。
  - `production-memory-capture.ts:291`：
    ```ts
    const evidenceRejected =
      input.ownerMessage !== undefined &&
      decision !== "unchanged" &&
      dataClassification !== "restricted" &&
      !evidenceVerified;
    ```
    `unchanged` 被明确排除在原话校验之外。
  - `durable-memory-service.ts:112`：
    ```ts
    return current.status === "active" && current.attributes?.tentative === true
      ? this.confirm(current.id, generationId)
      : current;
    ```
- 推测/风险：模型是否真的会在无关消息上输出 `unchanged`，属于模型行为，未实测；但代码没有阻止这条路径。本次改动会让这类待确认条目数量大幅增加，风险比改动前明显放大。
- 建议：在 `existingMemories` 里显式标出 `tentative: true` 并调整提示；对指向待确认记忆的 `unchanged` 要求 `evidenceVerified`；或把非 `rule` 的待确认记忆从 `recent` 列表里排除，只保留少量待确认 `rule` 供原有转正逻辑使用。补一条“下一轮抽取把待确认记忆转正”的反向测试。

### 2. 【中】“不能单凭待确认记忆判 act”只是提示词约束，代码不强制
- 位置：`packages/application/src/services/proactive-mail-check-service.ts:267`、`:329`、`:839`、`:993`
- 问题：ADR 说待确认记忆“不能单凭它判 `act`”，但代码只把说明文字拼进提示；解析结果、写账本、生成推送时都没有检查 `act` 是否只依赖 `tentativeMemoryIds`。模型若无视说明，猜测仍可触发提醒推送。
- 证据（读代码证实）：
  - `:270` 只做条件拼接：
    ```ts
    ...(memories.some(({ tentative }) => tentative) ? [MAIL_JUDGMENT_TENTATIVE_NOTE.text] : []),
    ```
  - `:839-843` 只记录 `usedMemoryIds`：
    ```ts
    const injected = new Set(promptMemories.map(({ id }) => id));
    for (const { usedMemoryIds } of judgements.values())
      for (const id of usedMemoryIds) if (injected.has(id)) trace.usedMemoryIds.add(id);
    ```
  - `:993-1016` 写账本时也没有对 `act` 做待确认记忆检查。
- 推测/风险：这是“不可信输入影响外部动作”的典型路径；是否真的误推送取决于模型是否遵守提示，未实测。
- 建议：解析后做确定性兜底：若某封判为 `act`，且 `usedMemoryIds` 只命中待确认记忆（或没有任何正式记忆/地板规则依据），降级为 `check` 或要求主人确认，并在账本里记下原因。补一条脚本化模型“只凭 tentative 判 act”的测试。

### 3. 【中】待确认记忆没有上限、过期或整理回收，会持续增长并挤占抽取提示
- 位置：`packages/application/src/services/automatic-memory-service.ts:193`；`packages/memory-engine/src/consolidation.ts:249`、`:428`；`apps/agent-service/src/production-memory-capture.ts:689`
- 问题：每轮最多 8 条低分候选会变成 `active` 待确认记忆；整理（consolidation）的 `reviewable` 和 `#decay` 都明确排除 `tentative`，所以这些条目不会被合并、归档或衰减；它们仍会被索引、生成 embedding，并参与主动检查召回。抽取提示的 `recent` 列表只有 20 条，新待确认条目会不断把正式记忆挤出去。
- 证据（读代码证实）：
  - `automatic-memory-service.ts:193` 进入待确认分支后直接 `commitCandidate` 并 `continue`，没有数量限制。
  - `consolidation.ts:249`：
    ```ts
    const reviewable = active.filter(
      (memory) =>
        !decayed.has(memory.id) &&
        REVIEWABLE.has(memory.dataClassification) &&
        (memory.attributes?.supersededBy ?? null) === null &&
        memory.attributes?.tentative !== true,
    );
    ```
  - `consolidation.ts:428`：
    ```ts
    if (
      !attributes ||
      attributes.tentative === true ||
      ...
    ) return undefined;
    ```
  - ADR 0179 自己也承认：“本次不加上限和过期，只靠账本观察数量。”
- 推测/风险：增长速度取决于模型输出；但代码没有回收路径，长期运行下存储、索引和召回候选池都会持续膨胀。
- 建议：给待确认记忆加每 owner 上限或 TTL；让它们参与衰减/整理；在抽取提示的 `recent` 列表里给正式记忆保留名额。至少加一个数量监控或告警。

### 4. 【中低】主动检查召回里待确认记忆与正式记忆同权排序，可能挤掉正式记忆
- 位置：`packages/application/src/services/durable-memory-service.ts:408`；`apps/agent-service/src/production-proactive-memory.ts:47`
- 问题：召回结果只按分数和 id 排序，不区分 `tentative`。一条相似度略高的猜测会占用 `perMail`/`perBatch` 名额，把正式记忆挤出提示。ADR 的意图是“当线索”，不是“顶替正式记忆”。
- 证据（读代码证实）：
  - `durable-memory-service.ts:408`：
    ```ts
    .sort(
      (left, right) => right.score - left.score || left.memory.id.localeCompare(right.memory.id),
    )
    .slice(0, input.policy.limit);
    ```
  - `production-proactive-memory.ts:47` 打开了 `includeTentative: true`。
- 推测/风险：实际挤占程度取决于数据分布，未实测。
- 建议：正式记忆优先排序，或给待确认记忆单独配额；至少在分数相同时优先正式记忆。

### 5. 【中低】文档与代码不一致：ADR 0143、案例手册仍按旧行为描述
- 位置：`docs/adr/0143-decision-ledger-for-model-gate-decisions.md:53`；`docs/engineering-casebook.md:175`；`docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md` 的 `supersedes`
- 问题：ADR 0143 仍写“推测被压不另设原因：……落在 `confidence_below_threshold`”，但代码现在对带原话的低分 `create` 写 `kept_tentative`；案例手册仍写待确认记忆“确认前不参与召回”，但主动检查现在会召回它们。ADR 0179 没有声明修订 0143，也没有更新案例手册。
- 证据（读代码证实）：
  - `docs/adr/0143...:53`：
    ```md
    “推测被压”不另设原因：推测类置信度上限为 700，低于自动保存的 850，落在 `confidence_below_threshold`，用 `inferred = 1` 区分。……门槛数值（850、700）不变，也没有任何丢弃的候选写进记忆库。
    ```
  - `docs/engineering-casebook.md:175`：
    ```md
    最多推测 3 条习惯（标为“待确认”，确认前不参与召回）
    ```
  - ADR 0179 的 `supersedes: ""`，且“关联文档”没有 0143/0147。
- 建议：在 ADR 0179 里写明它扩展/修订 ADR 0143 第 12 条，并同步更新 ADR 0143 与案例手册；ADR 0147 的 `inputs` 字段清单也建议补上 `tentativeMemoryIds`。

### 6. 【中低】待确认候选被主人确认后，不会补登记提醒和人物；低分承诺类候选的提醒信息会永久丢失
- 位置：`packages/application/src/services/automatic-memory-service.ts:536`；`apps/agent-service/src/production-memory-control.ts:865`；`packages/application/src/services/durable-memory-service.ts:260`
- 问题：待确认候选跳过 `onCommitted`，因此不会登记提醒/人物；之后主人在记忆页点“确认”时，`confirm` 只把 `tentative` 置 false，不会补跑 `onCommitted`。低分 `commitment` 候选即使被确认，也不会产生提醒。
- 证据（读代码证实）：
  - `automatic-memory-service.ts:536`：
    ```ts
    if (keptReason !== "kept_tentative")
      await this.options.onCommitted?.(...)
    ```
  - `production-memory-control.ts:865`：
    ```ts
    if (action === "confirm") {
      const saved = await this.options.memory.confirm(current.id, generationId);
    ```
  - `durable-memory-service.ts:260-280` 的 `confirm` 只更新 `attributes.tentative: false`。
- 建议：对带 `reminder`/`people` 的低分候选，要么不存成待确认，要么把相关数据持久化并在确认时补登记；至少在 ADR 里明确“确认后也不会补提醒”的后果。

### 7. 【低】服务层只信 `quote` 非空，不自己复核原话
- 位置：`packages/application/src/services/automatic-memory-service.ts:78`；`apps/agent-service/src/production-memory-capture.ts:290`、`:399`
- 问题：`canBeKeptTentatively` 只检查 `candidate.quote` 非空，依赖抽取层已经核对过原话。生产路径目前确实只在 `evidenceVerified` 时设置 `quote`，但服务层作为通用边界没有防御；未来换抽取实现或抽取层出 bug，会把未核实内容存成待确认记忆。
- 证据（读代码证实）：
  - `automatic-memory-service.ts:78`：
    ```ts
    return (
      candidate.decision === "create" && candidate.quote !== undefined && candidate.quote.length > 0
    );
    ```
  - `production-memory-capture.ts:399`：
    ```ts
    ...(evidenceVerified && dataClassification !== "restricted"
      ? { quote: quote.trim().slice(0, MAXIMUM_QUOTE_CHARACTERS) }
      : {}),
    ```
- 建议：服务层用已有的 `sourceText` 再核一次 `quote` 是否出现在原文，或在候选类型里加显式 `evidenceVerified` 字段并在服务层检查。这正对应 I-73 的教训：只看改动本身不够，要核对两端。

### 8. 【低】自动检查覆盖缺口：生产召回接线、act 兜底、sensitive/restricted 反向用例、golden 不变量
- 位置：`test/integration/proactive-mail-check.test.ts:1309`；`apps/agent-service/test/production-mail-embedding.unit.test.ts:94`；`test/integration/automatic-memory-golden.test.ts:480`；`test/integration/fixtures/memory-golden-dataset.json:260`
- 问题：
  - `[PA-2]` 集成测试用的是 fake `recallOf`，没有覆盖 `createProactiveMemoryRecall` 里真正传 `includeTentative: true` 和把 `attributes.tentative` 映射成 `tentative` 的两行。
  - `production-mail-embedding.unit.test.ts` 的 `found` 不带 `attributes`，也没有断言 `includeTentative`，所以生产接线无测试。
  - golden 测试的 `ledgerCount("kept")` 不把 `tentative_kept` 算进去；当前低分用例没有 `quote`，所以没触发，但一旦加入“低分带原话”用例就会误报。
  - 没有反向用例验证“低分 sensitive/restricted 带原话仍走审批/排除”，也没有验证“只凭 tentative 不能 act”。
- 证据（读代码证实）：
  - `automatic-memory-golden.test.ts:481`：
    ```ts
    expect(ledgerCount("kept")).toBe(
      auditCount("auto_committed", "explicitly_approved", "approval_committed") - replayedCommits,
    );
    ```
  - `memory-golden-dataset.json:260-277` 的 `low-confidence` 用例没有 `quote`。
- 建议：补生产召回的单测；golden 不变量加入 `tentative_kept`，并增加一条低分带 `quote` 的数据；增加 act 兜底和 sensitive/restricted 的反向用例。

---

## 侧重检查

- **错误路径**：待确认分支的 `commitCandidate` 失败会中断整轮抽取（和正式候选一样），低分候选现在也会触发内容存储/投影错误；`tentativeMemoryIds` 的后端校验存在（`sqlite-proactive-operations.ts:539`），未知审计结果会被敏感拦截记录器忽略，没有发现新的数据库约束冲突。未核实：真实磁盘/网络故障下的行为。
- **不合规范或不可信的输入**：`quote` 只由抽取层保证；服务层未复核（见第 7 条）。待确认记忆文本是模型生成的，之后会进入抽取提示和主动检查提示；代码只用提示词说明它是猜测，没有内容级隔离（见第 1、2 条）。密钥/受限/敏感/暂时性分支在待确认分支之前，读代码确认顺序正确。
- **安全**：未发现新的密钥泄漏路径；候选文本和原话都经过 `candidateSecretFindings`。主要安全问题是“待确认记忆只靠提示词约束，不强制阻止 act”（第 2 条）。
- **资源耗尽**：无上限、无过期、无衰减、无整理回收，且会持续索引/embedding（第 3 条）；召回同权排序可能挤掉正式记忆（第 4 条）。
- **不可撤销的操作**：待确认记忆本身可通过记忆页删除/回收站恢复，未发现不可逆副作用；但跳过 `onCommitted` 导致提醒/人物信息永久丢失（第 6 条）。
- **规则文件、说明文档和代码一致性**：ADR 0143、案例手册与代码不一致（第 5 条）；ADR 0179 自身对 `indexScope` 的引用已过时（背景仍写 `m.tentative = 0`），且“reflect 洞察也会被召回”过于绝对（`rule` 类被 `excludeCategories: ["rule"]` 排除，还受相似度和限额影响）。`prompt-prefix` 规则方面，对话请求未被改动；主动检查是新的后台调用，没有“已经发过的开头”，但固定说明被放在可变的记忆 JSON 之后，属于规则 15 的排序偏好偏差，不影响已有前缀缓存。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**对话请求：不会。** 待确认记忆仍被排除在主人档案块（`owner-profile-service.ts:97-102`）、聊天每轮检索（`production-run-memory.ts:350-364` 未传 `includeTentative`）、聊天记忆召回工具（`production-memory-recall.ts:163-171` 未传 `includeTentative`）和提醒（`sqlite-memory-reminder-operations.ts:11-12` 仍有 `m.tentative = 0`）之外。系统提示、工具定义、历史消息、遮盖结果都没有改动。

**主动检查（后台调用）：** 没有待确认记忆时，`proactivePrompt` 的数组与原来逐字节相同（`:267-274` 只在 `memories.some(tentative)` 时插入说明）。有待确认记忆时，说明被插在记忆 JSON 之后、邮件数据之前；这是每次新起的后台调用，不存在“上一次已经发过的开头”，因此不改变任何已发送前缀。唯一的小偏差是固定说明排在可变记忆之后，和规则 15“固定的在前、会变的在后”的排序偏好不完全一致，但由于记忆 JSON 本来每次就变，不额外损失稳定前缀缓存。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
**未发现新的不确定性。** `tentative` 来自数据库布尔列，说明文字固定，JSON 键顺序固定（`mailId`、`id`、`text`、`tentative`），记忆顺序按分数和 id 排序（`durable-memory-service.ts:408-411`），`tentativeMemoryIds` 用 `Set` 去重且插入顺序确定；没有加入时间字段。账本 `inputs` JSON 现在总会多一个 `tentativeMemoryIds` 字段（即使是 `[]`），这是确定性的格式变化，读取端 `entryFromRow` 已兼容。待确认记忆的文本本身由抽取模型生成，生成时可能因模型不确定性而不同，但一旦落库就固定，后续请求字节稳定。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？
**有，且主路径的反向用例是有效的。** 新增 `tentative-memory-capture.unit.test.ts` 覆盖：
- 低分带原话的 `create` 存成待确认并写 `kept_tentative` / `tentative_kept`；
- `REVERSE`：空原话、`update`、`unchanged`、`transient` 仍丢弃；
- `REVERSE`：高置信候选仍是正式记忆。
这些反向用例如果删掉 `decision === "create"`、`quote` 非空或“只对低分生效”的判断，会失败。`[PA-2]` 集成测试覆盖说明文字的有无、`tentative` 字段和账本读回；`owner-profile` 测试覆盖档案块排除；`memory-consolidation` 测试覆盖 `includeTentative` 开关；`production-memory-capture` 测试覆盖真实抽取到待确认落库。

**但仍有缺口：**
- 生产召回接线（`includeTentative: true` 和 `attributes.tentative -> tentative`）没有测试；`[PA-2]` 集成测试用的是 fake recall。
- 没有测试“只凭 tentative 不能 act”的代码兜底（因为根本没有兜底）。
- 没有低分 `sensitive`/`restricted` 带原话的反向用例。
- golden 的 ledger 不变量没有把 `tentative_kept` 计入 `kept`，当前数据集恰好没有触发。
- “无待确认记忆时逐字节相同”只测了不含关键词，没有做完整字节对比。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？
逐个核对：

- **`tentative_kept`（审计结果）**：已加入 `MemoryExtractionAuditRecord.outcome` 联合类型；没有数据库 CHECK 约束；`SensitiveInterceptionRecorder` 只映射两种结果，未知结果直接忽略。接受。
- **`kept_tentative`（账本原因码）**：`outcome: "kept"` 在 `DECISION_OUTCOMES.memory_candidate` 内；`reasonCode` 是自由字符串。接受。
- **`includeTentative`**：已加到 `MemoryProviderProjectionPort`、`MemoryIndexStorePort`、`DurableMemoryService.search`、`HybridMemoryProvider.search`；`searchIndex` 的四个 SQL 查询都绑定了 `@includeTentative`，没有遗漏绑定。接受。测试替身忽略该字段，但结构类型允许。
- **`tentative`（`ProactiveMemoryHit` / `PromptMemory`）**：生产端从 `memory.attributes?.tentative` 生成，消费端只用于 JSON 字段和账本集合；键顺序固定。接受。
- **`tentativeMemoryIds`**：`ProactiveCheckInputs` 和 `DecisionInputs` 里是可选的；`DecisionLedgerEntry.inputs` 是 `Required`，`entryFromRow` 已补默认 `[]`；`sqlite-proactive-operations.validateInputs` 用通用 `ids()` 校验（数组、去重、长度 1..256、最多 500），生产端是内存 id（domain 限制 1..128）且用 `Set` 去重。两端都接受。测试 fixture 已同步。
- **`mail.judgment.tentative-note`**：已加入 `prompt-manifest.json` 并有 `changedIn`/`reason`；`prompt-catalog.unit.test.ts` 会校验 digest。**未核实**：本次只读复核没有重新计算 manifest 的 sha256。
- **`attributes.tentative`**：`ProductMemoryAttributes` 已有该字段，数据库 `memory_records.tentative` 列在迁移 0054 已存在，确实不需要新迁移。接受。
- **`decision_ledger.inputs` 序列化格式**：主动检查行现在总会写 `tentativeMemoryIds`，读取端兼容；没有发现严格 schema 或外部消费者拒绝这个新键。

**不一致的地方**：文档端没有接受新语义（ADR 0143、案例手册，见第 5 条）；抽取提示的 `existingMemories` 消费端不知道 `tentative`（见第 1 条）。

---

## 未核实

- `prompt-manifest.json` 里 `mail.judgment.tentative-note` 的 sha256 是否与源码实际 digest 一致；只读工具无法重新计算，但 `prompt-catalog.unit.test.ts` 会校验。
- 作者所称“云端容器已跑过 application、memory-engine、persistence-sqlite、agent-service 单元测试及多个集成测试”未在本次复核中独立复现。
- 真实模型在下一轮抽取时是否会输出 `unchanged`、在主动检查中是否会无视 tentative 说明判 `act`，属于模型行为，未实测。
