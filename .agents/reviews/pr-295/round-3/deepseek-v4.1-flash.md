# 复核结论

## 一、读代码证实的问题（按严重度）

### 【中】第 3 轮的「生产接线」没有自动检查，反向用例只覆盖了解析器

- 文件：`apps/agent-service/src/production-memory-capture.ts:795`、`apps/agent-service/test/production-memory-evidence.unit.test.ts:87-130`
- 问题：`confirmsTentative` 依赖 `tentativeIds`，但唯一新增的第 3 轮反向测试是**手工**把 `tentativeIds` 传进 `parseMemoryCandidates`。没有任何测试覆盖 `#capture` 从 `memory.attributes.tentative` 算出 `tentativeIds` 并传入解析器这一步。如果这行接线漏掉或 `tentative` 取值写错，生产上的转正门禁会静默失效，测试仍然全绿。
- 证据（我读到的代码）：
  - `production-memory-capture.ts:795`：
    `tentativeIds: new Set(existing.filter(({ tentative }) => tentative).map(({ id }) => id)),`
  - 测试自己构造：`production-memory-evidence.unit.test.ts:105-106`：
    `existingIds: new Set(["memory-tentative", "memory-formal"]),`
    `tentativeIds: new Set(["memory-tentative"]),`
  - `test/integration/production-memory-capture.test.ts` 里 `tentative` 只出现在「低分存成 tentative」那个用例（约 654-707 行），没有「tentative 被 unchanged 是否转正」的端到端用例。
- 建议：在 `test/integration/production-memory-capture.test.ts` 增加两轮用例：先产生一条 tentative 记忆；下一轮模型对同一 id 输出不带 quote 的 `unchanged`，断言仍是 tentative、账本记 `evidence_unverified`；再输出带主人原话的 `unchanged`，断言转正。这样接线和门禁才真正被反向覆盖。

### 【低】材料说「账本记下这次用了哪几条」，代码记的是「本次送进提示的待确认记忆」

- 文件：`packages/application/src/services/proactive-mail-check-service.ts:790-795`、`1010-1015`
- 问题：`trace.tentativeMemoryIds` 在遍历 `promptMemories` 时按 `memory.tentative` 无条件加入，并不看模型是否在 `usedMemoryIds` 里真的用了它。所以账本里的 `tentativeMemoryIds` 是「送给模型的待确认记忆」，不是「用了几条」。ADR 0179 决定 4/5 已正确写成「送进提示的」和「与 usedMemoryIds 的交集」，但材料顶层目标仍写「账本记下这次用了哪几条」。
- 证据：
  - `proactive-mail-check-service.ts:790-792`：
    `for (const memory of promptMemories) {`
    `  trace.memoryIds.add(memory.id);`
    `  if (memory.tentative) trace.tentativeMemoryIds.add(memory.id);`
  - `1013`：`tentativeMemoryIds: [...trace.tentativeMemoryIds],`
- 建议：把材料改成「记下本次送给模型的待确认记忆；真正用上的是它与 `usedMemoryIds` 的交集」，或代码另加 `usedTentativeMemoryIds`（如果确实要「用了几条」）。

### 【低】「必须带原话」只做去标点后的子串匹配，不要求与待确认记忆相关

- 文件：`apps/agent-service/src/production-memory-capture.ts:125-133`、`305-314`
- 问题：`quoteFromOwnerMessage` 只要求 quote 规范化后是 `ownerMessage` 的子串且至少 8 字（或整条消息）；`confirmsTentative` 只用 `evidenceVerified`。模型可以拿主人消息里任意一段 8 字以上的话去确认一条毫不相关的待确认记忆。这不违反字面要求，但「原话核对」给人的保证偏强。
- 证据：
  - `125-132`：`const normalizedQuote = evidenceText(quote); ... normalizedMessage.includes(normalizedQuote)`
  - `305-314`：`const confirmsTentative = existing !== null && input.tentativeIds?.has(existing) === true && (...);`，随后 `(confirmsTentative && !evidenceVerified)`。
- 建议：至少要求 quote 与候选 `text` 有实体/关键词交集，或把「这是来自本次消息的引文，不等于主人确认了这条记忆」写进 ADR；否则转正门禁可被任意无关引文绕过。

### 【低】`update`/`merge` 的反向用例实际测不到第 3 轮新增分支

- 文件：`apps/agent-service/test/production-memory-evidence.unit.test.ts:110-127`
- 问题：对 `update`/`merge`，旧的 `evidenceRejected` 已经要求（非 restricted 时）必须有已核对原话；即使删掉 `confirmsTentative`，`update`/`merge` 无 quote 仍会被拒。`it.each(["unchanged","update","merge"])` 里只有 `unchanged` 真正依赖新分支。
- 证据：`production-memory-capture.ts:309-314` 旧子句 `decision !== "unchanged" ... && !evidenceVerified`；测试 `it.each` 三个 decision 共用同一断言。
- 建议：保留 `unchanged` 作为真正的反向用例；为 `update`/`merge` 增加 `classification: "restricted"` 的用例（旧规则不覆盖 restricted），才真正验证新分支。

### 【低】`canBeKeptTentatively` 信任 `quote` 非空，而不是 `attributes.evidenceVerified`

- 文件：`packages/application/src/services/automatic-memory-service.ts:78-87`
- 问题：ADR 把「quote 非空」当成「evidenceVerified」，但端口类型上任何 `ExtractedMemoryCandidate` 提供者都可以塞一个未核对过的 quote，从而把未核对内容存成待确认。生产路径目前只有 `parseMemoryCandidates` 会产出 candidate，所以现状可控，但契约不自我保证。
- 证据：`80-82`：`candidate.quote !== undefined && candidate.quote.length > 0`
- 建议：改为同时要求 `candidate.attributes?.evidenceVerified === true`，或在服务层再校验 quote 与 `readSourceText` 的包含关系。

### 【信息 / 未核实】提示清单 sha256 与「测试已跑过」

- `packages/prompt-catalog/prompt-manifest.json:322` 的新条目 `"sha256": "72da4d..."` 无法在本环境计算（只允许 git 只读命令）。若 hash 与 `text` 不符，`apps/agent-service/test/prompt-catalog.unit.test.ts` 的阻断检查会失败。**未核实。**
- 作者称「测试已在云端容器跑过」，本环境无法运行测试，**未核实**。

## 二、推测（未直接证实）

- **资源耗尽**：待确认记忆无上限、无过期（ADR 0179 后果里明确接受）。每条低分 `create` 都会写记忆记录、内容 payload、索引任务和账本行；模型每次最多 8 条候选，长期会单调增长。这是已知取舍，不是本次实现的缺陷，但建议后续观察数量。
- **名额占用**：主动检查召回里待确认记忆与正式记忆按分数同权排序，可能占用 `perMail`/`perBatch` 名额（ADR 已承认，代码确实没有降权）。影响大小取决于实际分布，未测。
- 若存在 `restricted` 的待确认记忆（理论上不会由本功能产生），`update`/`merge` 转正时 quote 不会落盘（`production-memory-capture.ts:416` 对 restricted 不写 quote），但校验已通过，影响很小。

## 三、侧重检查

- **错误路径**：`commitCandidate` 抛错会冒泡到 `#capture` 的 `.catch(onFailure)`，与旧的自动提交一致；tentative 分支在 `commitCandidate` 之后才写 `tentative_kept` 审计，提交失败时不会留下假的 kept 审计（与 `auto_committed` 同模式）。`production-proactive-memory.ts` 的读文本失败会被整体 catch 计入 `failedQueries`，与旧行为一致。
- **不可信输入**：模型输出经 `parseMemoryCandidates` 校验 text 长度、kind、decision、existingId、classification、quote；tentative 额外要求 quote 非空、无 reminder/people/personLinks；密钥扫描覆盖 `text + quote`（`candidateSecretFindings`），restricted 先排除，sensitive 走审批。邮件判断里记忆文本经 `JSON.stringify`，新增 note 是固定文字。
- **安全**：待确认记忆只可能是非 sensitive/restricted；主动检查的 `allowedClassifications` 仍只 `["public","private"]`；quote 加密存 payload。唯一弱点是上面的子串校验。
- **资源耗尽 / 不可撤销**：召回有条数上限（`hitsPerMail`/`perBatch`/`searchesPerCheck`），不会因待确认记忆变多而无界进入提示；写入只是新增记忆行，可在记忆页删改，不是不可撤销操作。
- **规则/文档一致性**：ADR 0179 决定 6、后果，ADR 0143 第 12 条修订，`docs/engineering-casebook.md` 与代码一致。唯一不一致是材料顶层「账本记下用了哪几条」与代码「送给模型的待确认记忆」（见上）。
- **`includeTentative` 默认关闭**：`sqlite-memory-operations.ts:242` 改成 `(@includeTentative = 1 OR m.tentative = 0)`，默认 `includeTentative` 为 0，聊天检索工具 `production-memory-recall.ts` 不传该开关，档案块 `owner-profile-service.ts:100` 和提醒 `sqlite-memory-reminder-operations.ts:12` 仍排除，符合约束。

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本改动只碰后台调用（记忆抽取、邮件判断），没有改对话的系统提示、工具定义、历史消息或遮盖结果；对话仍然只在末尾追加，每轮变化的值仍在最后一条用户消息里。邮件判断的新 note 只在存在待确认记忆时出现，属于后台一次性调用，不是对话前缀；没有待确认记忆时 `proactivePrompt` 与原来字节相同（记忆条目不追加 `tentative`、不追加 note）。记忆抽取的 `existingMemories` 在无 tentative 时也与原来一致——base 本来就按 `updatedAt` 倒序（`git show 8ae40ba...:apps/agent-service/src/production-memory-capture.ts` 里就是 `sort((l,r)=>r.updatedAt.localeCompare(l.updatedAt))`），head 的 `confirmedFirstByRecency` 在全为非 tentative 时退化成同一排序。依据 `prompt-prefix.md` 第 4 条。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
没有引入新的不确定性。新增字段都是记忆自身属性的确定函数；`confirmedFirstByRecency` 有确定比较器（tentative 分组 + `updatedAt` 倒序，并列时稳定排序保留数据库 `ORDER BY id` 的顺序）；`tentativeMemoryIds` 用 Set 的插入顺序序列化，来源是确定的 `promptMemories` 顺序；没有新增时间字段（`now` 仍在最后）。邮件判断 note 的有无取决于该批次是否召回到 tentative，这是按内容确定的，不是随机。

**3. 有没有自动检查，反向用例是否真的会失败？**
有，但第 3 轮不完整。覆盖到的：`tentative-memory-capture.unit.test.ts`（无 quote、update/unchanged、transient、reminder/people/personLinks、restricted/sensitive、高置信度这些反向用例，删掉对应条件会失败）、`production-memory-evidence.unit.test.ts`（unchanged 无 quote 会被拒，删掉 `confirmsTentative` 会失败；confirmed 记忆不需要 quote）、`confirmed-first-recent.unit.test.ts`、`production-mail-embedding.unit.test.ts`（`includeTentative` 接线）、`proactive-mail-check.test.ts`（note + 账本）、`automatic-memory-golden`（`low-confidence-quoted` 存 tentative、`low-confidence` 仍丢弃）、`owner-profile-service`、decision-ledger 读回、`memory-consolidation`（默认排除 / 开关包含）。缺口是：第 3 轮的生产接线（`production-memory-capture.ts:795`）没有端到端反向用例；`update`/`merge` 的反向断言由旧规则兜底，测不到新分支。

**4. 每个新值的使用端都能接受吗？**
逐项核对如下：
- `tentative_kept`（审计 outcome）：`ports/automatic-memory.ts` 联合类型已加；唯一消费方 `SensitiveInterceptionRecorder.reportMemoryAudit` 用 `Partial<Record<...>>` 映射，未映射直接 return，无数据库约束，安全。
- `kept_tentative`（账本 reasonCode）：长度 13，落在 `decision_ledger.reason_code` 的 `1..64` 约束内；`outcome: "kept"` 在 `DECISION_OUTCOMES.memory_candidate` 内；`validateLedgerWrite` 通过；`entryFromRow` 正常读回。
- `tentativeMemoryIds`（`DecisionInputs`）：proactive 写入前在 `sqlite-proactive-operations.ts:539` 校验（字符串、去重、上限），写入 inputs JSON（`611`），读回 `sqlite-decision-ledger-operations.ts:162` 默认 `[]`；不需要迁移；`Required<DecisionInputs>` 的手工构造点（`daily-review.unit.test.ts:155`、`decision-ledger.test.ts:211/825`）已补 `[]`。
- `includeTentative`（`MemoryProviderProjectionPort` / `MemoryIndexStorePort` / `DurableMemoryService.search`）：`HybridMemoryProvider` 只在 true 时透传，`SqliteMemoryOperations.searchIndex` 转成 0/1 用于 `indexScope`，默认 0 保持旧行为；聊天记忆工具不传，仍排除。
- `tentative`（`ProactiveMemoryHit` / `PromptMemory`）：可选字段；生产从 `ProductMemoryRecord.attributes.tentative` 计算，JSON 只在 true 时加字段，确认记忆字节不变。
- 新提示词 id `mail.judgment.tentative-note`：`mail.ts` 导出、`index.ts` re-export、manifest 已登记（hash 未核实）。
- 新属性 `attributes.tentative`：写入 `memory_records.tentative`（`sqlite-memory-operations.ts:737/782`），读回 `493`；档案块 `owner-profile-service.ts:100`、提醒 `sqlite-memory-reminder-operations.ts:12`、整理 `consolidation.ts:254/430` 都排除；索引默认排除、主动检查显式包含。
- 未新增数据库迁移：diff 中没有 `migrations/` 文件。
