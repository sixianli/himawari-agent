以下结论基于对 `0d989adb..4778b1ca` 的 diff 和相关源码的阅读；我无法运行测试，涉及“会失败”的判断已标为推断。

## 读代码证实的问题

### 1. [高] 数据导出会写出 `memory_review` 决策，但导入校验的 schema 不认这个类型
- 文件：`packages/persistence-sqlite/src/data-export/schemas.ts:266-274`
- 问题：`DECISION_SCHEMA.kind` 枚举仍是 `proactive/.../rule_review`，没有新增的 `memory_review`；而快照会导出全部 `decision_ledger` 行，导入时用这个 schema 校验。
- 证据：
  ```ts
  kind: enumOf([
    "proactive", ..., "rule_review",
  ]),
  ```
  `snapshot.ts:180-186` 无 kind 过滤地选出所有决策；`export.ts:403-405` 原样写出 `kind: str(row["kind"])`；`import.ts:107` 调用 `parsePortable`，`verify.ts:399` 用 `DECISION_SCHEMA` 校验。
- 影响：只要产生过一条 `memory_review` 决策（改记忆、点待重审、报漏标都会产生），导出的备份在导入/校验时就会因 `kind` 不在枚举中失败。作者说“待重审标记不导出”只覆盖了 `memory_review_items`，没有覆盖 `decision_ledger` 里的 `memory_review` 行。
- 建议：把 `"memory_review"` 加入 `DECISION_SCHEMA`；或者显式从导出中排除 `memory_review` 决策，并在“未导出”清单里写明。两者必须选一个，不能保持现状。

### 2. [高] 新约束 `needs_review => review_after` 与现有写入路径/夹具不一致
- 文件：`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:362-363`
- 问题：
  ```sql
  CHECK (review_after IS NULL OR status IN ('needs_review', 'suspended')),
  CHECK (status <> 'needs_review' OR review_after IS NOT NULL)
  ```
  但 `sqlite-proactive-operations.ts:356-365` 的 `writeRule` 把规则改回 `active` 时没有清 `review_after`：
  ```sql
  ON CONFLICT (...) DO UPDATE SET revision = excluded.revision,
    parameters = excluded.parameters, status = 'active', source = excluded.source,
    updated_at = excluded.updated_at
  ```
- 证据：
  - 现有测试 `test/integration/rule-memory-review.test.ts:288-295` 会在来源记忆改动后保存设置，期望规则从 `needs_review` 回到 `active`；按代码推断该 UPDATE 会留下 `review_after`，触发 CHECK 失败。
  - 现有测试 `test/integration/mcp-read.test.ts:144-170` 直接插入 `status = 'needs_review'` 而不写 `review_after`，同样会失败。该文件的 diff 未更新。
- 影响：这是“值产生端/使用端”没有全部对齐的典型问题。生产上 `writeRule` 只写内置规则，若该行处于待重审/暂停状态就会直接抛约束错误；测试层面则已经有现存用例应失败。
- 建议：在 `writeRule` 的 `ON CONFLICT` 中补 `review_after = NULL, review_attempts = 0, review_failure = NULL, suspend_reason = NULL, suggestion = NULL`，并同步修正直接插入待重审规则的夹具。

### 3. [中] 读取来源记忆失败会中断整批规则核对，并且永远不会记失败/停止重试
- 文件：`packages/application/src/services/rule-review-service.ts:103-109`、`apps/agent-service/src/service-main.ts:2004-2007`
- 问题：
  ```ts
  try {
    prompt = ruleReviewPrompt(await this.#options.readMemoryText(memory), candidate.parameters);
  } catch (error) {
    if (error instanceof RuleTypeError) return this.#fail(candidate, "answer_invalid");
    throw error;
  }
  ```
  `readMemoryText` 在 payload 缺失、类型不对、解密失败时会抛普通 `Error`（`service-main.ts:2006`），不会被转成 `recordFailure`，而是直接从 `#review` 抛出。
  同时 `#runOnce` 是串行 `for`，没有逐条 try/catch：
  ```ts
  for (const candidate of due)
    reports.push(Object.freeze({ ruleId: candidate.ruleId, outcome: await this.#review(candidate) }));
  ```
- 影响：一条规则的内存载荷读不出来，整批 3 条规则都停止核对；该规则 `review_after` 不变、`review_attempts` 不增加，下一次 tick 仍排在最前，形成无限重试并饿死其他规则。这与“失败不无限重试、不阻断”的目标不符。
- 建议：`#review` 内捕获所有来源读取错误和数据库错误，按 `answer_invalid`（或新增 `source_unreadable` 失败原因）调用 `#fail`；`#runOnce` 对每条 candidate 单独 try/catch，保证一条坏规则不影响其他规则。

### 4. [中] 已暂停规则再次变化时会重复写“待重审”决策，且保留旧建议/旧暂停原因
- 文件：`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:551-581`
- 问题：触发器的决策记录插入条件包含 `status IN ('active', 'suspended')`，所以已暂停规则每次来源变化都会再写一条 `outcome = 'needs_review'` 的 `decision_ledger`；但 ADR 0232 决定 2 明确说“同一条规则再次变化时修订号再加 1、重新核对，但不重复写‘待重审’决策记录”。
- 证据：
  ```sql
  SELECT 'rule-review:' || ..., 'rule_review',
    NEW.updated_at, '{}', 'needs_review', ...
  FROM rule_book_rules
  WHERE ... AND status IN ('active', 'suspended')
  ```
  另外 UPDATE 只重置了 `review_after/review_attempts/review_failure`，没有清 `suggestion`/`suspend_reason`：
  ```sql
  UPDATE rule_book_rules SET
    status = CASE WHEN status = 'suspended' THEN 'suspended' ELSE 'needs_review' END,
    revision = revision + 1, updated_at = ..., review_after = ...,
    review_attempts = 0, review_failure = NULL
  ```
- 影响：暂停规则重新排队时，旧建议仍然显示，Andy 可能在自动核对给出新结论前就点“采用建议”，采用基于旧来源的建议；同时决策记录与 ADR 不一致。
- 建议：只在 `active -> needs_review` 时写 `needs_review` 决策；重新排队暂停规则时清空 `suggestion` 和旧 `suspend_reason`（或写一个单独的重检记录）。

### 5. [中] 页面“采用建议”只显示 summary，但实际应用的是完整参数
- 文件：`apps/agent-service/src/production-memory-control.ts:617-623`、`packages/gateway-contracts/src/contracts-v2.ts:1708-1716`、`packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:364-368`
- 问题：网关把建议裁剪成一行摘要：
  ```ts
  suggestion: rule.suggestion ? clip(rule.suggestion.summary) : null,
  ```
  实际“采用建议”时应用的是数据库里完整的 `suggestion` JSON：
  ```ts
  if (input.action === "adopt") {
    if (current.status !== "suspended" || current.suggestion === null) return false;
    status = "active";
    parameters = current.suggestion;
  }
  ```
- 影响：Andy 看到的是模型写的一句 summary，但真正生效的是匹配域名、地址、词表的完整参数；摘要可能省略或弱化实际条件。这是产生值与展示值不一致。
- 建议：快照中返回结构化建议（或至少返回完整参数的只读展示），UI 在“采用建议”前展示实际条件和参数。

### 6. [低] 展开的批量上限没有“未展开”提示
- 文件：`apps/agent-service/src/production-memory-control.ts:172-190`
- 问题：每轮 20 条、最多 10 轮，即一次请求最多展开 200 条根行；超过的部分既不 `truncated` 也不提示，只是留在 `expanded = 0` 等下次。ADR 说“最多 8 层、200 条”，但代码的 200 条是每个根节点上限，批量 200 根是另一层限制。
- 建议：至少把“还有未展开的根行”暴露到快照或日志；或者循环直到没有 `expanded = 0`，并保留单链 8 层/200 条截断标记。

### 7. [低] “确认暂停”实际是不可逆的 `retired`，且没有二次确认
- 文件：`packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:369-372`
- 问题：`confirm_suspended` 直接把规则设成 `retired`，之后 `list()` 默认不返回 retired 规则，待重审列表也不再显示；UI 文案是“确认暂停”，容易让 Andy 以为是可恢复的暂停。
- 证据：
  ```ts
  } else if (input.action === "confirm_suspended") {
    if (current.status !== "suspended") return false;
    status = "retired";
  ```
- 建议：如果产品意图是“停用”，UI 明示“停用且不再出现在规则列表”，并加确认；如果意图是可恢复暂停，应保留 `suspended` 或增加独立状态。

### 8. [低] 导入前“目标必须为空”的检查没有包含 `memory_review_items`
- 文件：`packages/persistence-sqlite/src/data-export/import.ts:78-91`
- 问题：`EMPTY_TARGET_TABLES` 包含 `rule_book_rules`、`decision_ledger` 等，但没有 `memory_review_items`。导入不会写这张表；若目标库里残留旧的待重审行，导入不会拒绝，ADR 所说的“导入后从空清单开始”也就不成立。
- 建议：把 `memory_review_items` 加入 `EMPTY_TARGET_TABLES`，或在导入事务中显式清空/校验该表。

## 推测/未核实

- 上面第 2 条中“现有测试会失败”是基于代码和约束的推断，未实际运行测试（工具限制不允许运行测试命令）。
- 资源层面：`RuleReviewService` 每次 tick 最多 3 条、每条最多 3 次尝试，但没有看到独立于邮件检查的每日费用上限；ADR 明确说“不占邮件检查的每日费用上限”。大量规则待重审时可能产生持续模型费用。未找到全局 `rule-review` 预算限制，标为风险而非证实 bug。
- 邮件检查使用的规则集合会随规则暂停而变化；我没有继续追踪规则清单在邮件检查提示词中的具体位置，因此无法断言它是否位于“已见请求开头”。本次 diff 本身没有修改已有提示词拼接代码。

## 侧重检查

- 错误路径：
  - 模型返回格式不对：`parseRuleReviewAnswer`/`judgeRuleReview` 返回 invalid，走 `recordFailure("answer_invalid")`，不暂停，正确。
  - 模型失败/超时/披露被拒：走 `recordFailure`，不暂停，正确。
  - 来源记忆删除或不再是规则：按 ADR 主动暂停，`source_removed`，正确。
  - 没有配置邮件检查：`ruleReview` 接在 proactive tick 内，不配置就不会自动核对，规则停在待重审并照常执行，符合 ADR。
  - 来源载荷读不出来：见问题 3，会中断整批并无限重试，不符合“不无限重试”。
- 不合规范/不可信输入：
  - 网关对 `target/action/expectedRevision/memoryId/upstreamMemoryId` 有 schema 校验；持久层再校验规则 id/记忆 id 正则、revision、action、resolution。
  - `reportMissed` 用 `WHERE owner_id=? AND agent_id=? AND id IN (?,?)` 并要求恰好 2 行，不能跨 owner；`memoryId === upstreamMemoryId` 被拒绝。
  - 规则匹配参数由 `parseOwnerRuleParameters` 校验后才作为建议，且必须由 owner 点击才生效；模型输出不会自动改记忆文字。未发现直接注入执行路径。
- 安全/越权：
  - `rules.act`、`memoryReview.resolve/reportMissed` 都带 owner/agent 作用域；未发现只凭 payload 里的 owner 操作别家数据的路径。
  - “采用建议”展示值与实际应用值不一致，见问题 5，这是本次最值得注意的安全/信任问题。
- 资源耗尽：
  - 展开有 8 层/200 节点/200 根上限；规则核对每次 3 条、失败 3 次后停止。主要缺口是问题 3 的无限重试与问题 6 的静默未展开。
- 不可撤销操作：
  - 迁移不可逆（ADR 已说明）；`confirm_suspended` 实际 retired 且无二次确认/撤销入口，见问题 7。
- 规则文件、说明文档和代码一致：
  - ADR 0232 的 `suspended` 状态、`recheck_failed`、一致率口径、导出“未导出”项大体一致。
  - 不一致处：已暂停规则再次变化时重复写 `needs_review` 决策（问题 4）；ADR 说“不重复写”；建议值 UI 只显示 summary（问题 5）；数据导出决策类型缺 `memory_review`（问题 1）。

## 必答问题

1. 会不会改变模型已经见过的请求开头？
   - 本次改动没有修改已有聊天/邮件检查的提示词模板、工具定义或历史消息拼接；`prompt-manifest.json` 只是新增 `rule.review` 和 `rule.review.instructions-header`，没有改旧 hash。
   - 新增的规则核对调用是独立请求，`ruleReviewPrompt` 的顺序是固定说明、固定规则类型说明、最后才是本次的 `memory/currentRule` JSON（`rule-review-service.ts:43-55`），会变的内容在最后。
   - 因此按本次代码，已有请求开头不变；新调用也符合“固定内容在前、会变内容在后”。未核实邮件检查提示词中规则清单的具体插入位置。

2. 同一段文字会不会在不同请求里变成不同字节？
   - 规则核对提示词中，当前规则参数经过 `parseOwnerRuleParameters` 规范化：列表会 fold、去重、排序（`rule-types.ts:87,111`），JSON 字段顺序固定，且提示词不含时间。`rule-review-service.unit.test.ts:198-213` 专门断言不同大小写/顺序得到完全相同的 prompt。
   - 展开顺序、列表顺序和一致率统计都有显式排序；没有发现依赖前后文的遮盖或无序集合进入模型提示词。
   - 例外：删除触发器用 SQLite `strftime(..., 'now')` 写 `flagged_at`，重放同样操作会得到不同时间；这不是模型请求内容。

3. 有没有对应的自动检查，反向用例是否真的会失败？
   - 有：三链展开、无关字段不触发、整理撤销不触发、硬删除前抓取下游、一致率、规则重检、暂停不执行、模型失败/格式错误、过期 revision、少于 5 条样本不足等都有测试。
   - 但覆盖不完整：没有看到“恢复/取代/换分类进入 `memory_review_items`”、“8 层/200 条截断”、“已暂停规则重复变更的决策记录次数”、“导出含 `memory_review` 决策后导入”、“writeSettings 清待重审”、“MCP/导出暂停规则”的完整测试。
   - 更严重的是问题 2：按代码推断 `test/integration/rule-memory-review.test.ts` 和 `test/integration/mcp-read.test.ts` 的现有用例会被新约束打断，说明这组自动检查当前不是绿的。未实际运行测试。

4. 一致率计数是否符合 ADR？
   - 基本符合：
     - 规则 `owner_adopted`/`owner_confirmed` 且原因码为 `from_suspended` 计入认可；`owner_restored` 计入处理但不认可；`needs_review` 时点的“看过没问题”原因码 `from_needs_review` 不计入。
     - 系统标出的记忆被编辑计入处理且认可；`owner_dismissed` 计入处理但不认可；只有 `owner_reported` 的条目被处理时不计入。
     - 漏标 `owner_reported_missed` 单独计数，不进分母。
     - 少于 5 条由 `proportion` 的 `DEFAULT_MINIMUM_SAMPLES` 判为样本不足。
   - 需要注意：一次记忆处理若有多条上游行，只写一条决策记录，按一次点击计；同一记忆被多次标出并多次处理会按多次点击累计。ADR 的“每次点击进决策记录”与此一致，但如果产品期望按“记忆条数”而不是“点击次数”，需要再确认。
   - 问题 1 的导出 schema 缺失不会改变计数，但会让含 `memory_review` 决策的备份无法导入。

5. 网关输入是否都校验了归属和存在，能否操作别的主人的记忆或规则？
   - 校验存在：`memory.review.respond` 的 `action` 由枚举和持久层双重校验；规则 `target` 由 `OWNER_RULE_ID` 校验并在 `owner_id/agent_id` 作用域内更新；`expectedRevision` 校验为正整数，规则动作必须非空，过期 revision 返回 `PORT_CONFLICT`。
   - `memory.review.reportMissed` 的两个 id 都经过正则，并用 `owner_id/agent_id` 限定后要求恰好 2 行存在；`memoryId === upstreamMemoryId` 被拒绝。
   - `dismiss` 只能解析当前 owner/agent 下的记忆；解析 0 行返回 `PORT_NOT_FOUND`。
   - 未发现可以只凭 payload 操作别家 owner 记忆或规则的路径。

6. 迁移重建表是否丢数据/约束/外键/索引？
   - 读代码看，0095 对 `decision_ledger`、其子表、`decision_prereviews`、`rule_book_rules/history`、`model_usage_observations` 都做了完整列复制，并重建了索引和触发器；`foreign_key_check` 也有契约测试。
   - 但新增的 `needs_review => review_after` 约束与现有写入点/夹具不一致（问题 2），且导出 schema 少了 `memory_review`（问题 1）。
   - `memory_review_items` 没有加入导入“目标为空”检查（问题 8）。
   - 未发现搬运过程本身丢列或丢索引。

7. ADR 0232、案例 92 和代码是否一致？
   - 大体一致：暂停状态、消费方 `ruleIsEnforced`/`enforceableOwnerRule`/MCP/导出、模型失败不暂停、修订号检查、少于 5 条样本不足都对应上了。
   - 明确不一致：
     - ADR 说已暂停规则再次变化“不重复写待重审决策记录”，触发器实际会重复写（问题 4）。
     - ADR 说导出“待重审标记和规则建议值”不导出；代码确实不导出 `memory_review_items` 和建议值，但 `decision_ledger` 里的 `memory_review` 行仍被导出且导入 schema 不认（问题 1），导致“导出的内容能不能用”与文档不一致。
     - 案例 92 说“模型挂了不停规则”，代码对模型失败成立；但对来源载荷读取失败不成立（问题 3），会无限重试并卡住整批。
     - `200 条` 在 ADR 中像单链上限，代码里另有“每次请求最多 200 根行”的批量上限且不提示“未展开”（问题 6）。
