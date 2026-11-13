## 结论摘要

方案方向（reflect 下游传播、规则重检、挂起不执行）合理，但当前设计在**状态机、删除触发、多上游/截断、决策记录闭环、以及新值的消费端**上有几处会直接导致实现失败或产生错误行为。尤其是：`needs_review` 仍然执行、`suspended` 没有被现有 Owner 规则端口和 UI 全部接受、BEFORE DELETE 写入的待审行会被外键动作删掉、规则“已清除”后旧的 `rule_review/needs_review` 决策仍会一直显示。

---

## 证实的

### 【高】1. 重检失败时旧规则仍无限期执行，与“挂起不执行”和“方向安全”矛盾

- 问题：方案第 3 节写“调用失败、超时、输出不合法、校验不过 → 状态不变（needs_review 照常执行）……最多 3 次，之后只列出”。但 `needs_review` 在当前代码里是**强制执行**的；达到 3 次后规则仍然是 `needs_review`，也就仍然执行。来源记忆已经改过、规则可能已过时时，这会持续产生错误行为。
- 证据：
  - `packages/application/src/rules/rule-book.ts:12-16`：`ruleIsEnforced` 对 `active` 和 `needs_review` 都返回 true。
  - `packages/application/test/rule-registry.unit.test.ts:210-212`：测试固定了 `needs_review` 为 true。
  - 方案第 8 节“方向安全”只对“模型判为变化”成立；模型失败时方向并不安全。
- 建议：明确定义状态语义，二选一：
  - 失败达到上限后转 `suspended` 或新增 `needs_owner`（不执行），并在 UI 明确“因重检失败已停用”；或
  - 保持 `needs_review` 执行，但必须把“仍生效”写进主人可见文案，并把“方向安全”改为“失败时保留旧行为”。不能两者都按现在的写法。

### 【高】2. `suspended` 没有接入全部 Owner 规则端口和消费者

- 问题：方案第 5/6 节要做“恢复原规则、采用建议”，但现有端口和实现只认识 `active`/`retired`，或者只对 `needs_review` 做特殊处理。照方案实现会出现：恢复命令报错、列表里看不到 suspended、恢复后仍然显示“执行中”。
- 证据：
  - `packages/application/src/ports/owner-rules.ts:35-43`：`setStatus` 只接受 `"active" | "retired"` 和 `"owner_undo" | "owner_confirmed"`。
  - `packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:171-174`：同样的校验。
  - `apps/agent-service/src/production-owner-rules.ts:709-730`：`reconfirm` 只在 `current.status === "needs_review"` 时改回 active；如果状态是 suspended，会原样返回，并在 `:730` 返回 `enforced: true`。
  - `packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:86-89`：`includeRetired=false` 时只查 `status IN ('active','needs_review')`，suspended 直接消失。
  - `packages/application/src/rules/rule-types.ts:300-310`：`enforceableOwnerRule` 只排除 `retired`。
- 建议：先画一张完整状态迁移表，再逐一改：`OwnerRuleStorePort.setStatus`、`SqliteOwnerRuleOperations`、`ProductionOwnerRuleWriter.reconfirm/list/undo`、`enforceableOwnerRule`、`ruleIsEnforced`、`rule-ref`、gateway schema、MCP、UI。加一个“状态矩阵”测试，确保每个状态在每个消费者上都有预期结果。

### 【高】3. BEFORE DELETE 写入的待审行会被外键动作删掉，或反过来阻止删除

- 问题：方案说“BEFORE DELETE 触发器同样（依据行会被级联删除，所以必须在 BEFORE）”。但待审行里的 `upstream_memory_id` 指向的正是即将被删除的记忆；SQLite 的执行顺序是：BEFORE 触发器 → 删除父行 → 外键动作 → AFTER 触发器。`ON DELETE CASCADE` 会把刚插入的子行再删掉；`RESTRICT/NO ACTION` 会让删除失败；`SET NULL` 又会丢掉上游 id。
- 证据：
  - SQLite 官方文档，<https://www.sqlite.org/foreignkeys.html>：“Execute applicable BEFORE trigger programs, Check local (non foreign key) constraints, Update or delete the row in the parent table, Perform any required foreign key actions, Execute applicable AFTER trigger programs.”
  - 同页：“For an ‘ON DELETE CASCADE’ action, this means that each row in the child table that was associated with the deleted parent row is also deleted.”
  - `packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:273-279`：basis 的 `memory_id` 是 `REFERENCES memory_records(id) ON DELETE CASCADE`，所以删除记忆时依据行确实会消失。
- 建议：`upstream_memory_id` 不要加会级联/限制的 FK，或使用 `ON DELETE SET NULL` 并另存上游快照（id、删除前状态、原因、时间）；更稳妥的是改用独立的 outbox 事件表，事件里保存快照，不引用即将删除的行。加“删除上游后下游待审项仍在”的测试。

### 【高】4. “采用建议”没有可用的写参数操作

- 问题：方案第 6 节要求“采用建议（重新校验建议参数，写参数，回 active，owner_adopted）”。但持久层没有“更新现有规则参数”的端口；`create` 在规则已存在且参数不同时直接 `PORT_CONFLICT`。
- 证据：
  - `packages/application/src/ports/owner-rules.ts:21-43`：只有 `list/read/create/setStatus`。
  - `packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:141-145`：`create` 发现 existing 参数不同就抛 `PORT_CONFLICT`。
  - `setStatus` 不写 `parameters`（`:167-196`）。
- 建议：新增 `adopt`/`updateParameters`（带 `expectedRevision`、参数重新校验、`revision + 1`、history `owner_adopted`），或者做一个事务化的 `ruleReview.resolve`，把写参数、改状态、写 history/ledger 放在同一事务。

### 【高】5. 重检“相同→active”不写决策记录，旧的 `needs_review` 决策会一直显示

- 问题：方案说“相同 → active，写历史（review_cleared），不写决策记录”。但 0087 在标记 needs_review 时已经写了一条 `decision_ledger(kind='rule_review', outcome='needs_review')`。这条记录不会因为规则后来 active 而消失，daily review / decision chain 仍会显示“硬规则待重审”。
- 证据：
  - `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:508-522`：`listReviewPool` 只按时间和 rating 过滤，不 join 当前规则状态。
  - `apps/control-center/src/i18n/resources/zh-CN.ts:980`：`dailyReview.ruleReview` 仍写“规则照常执行，等你看一眼”。
  - `packages/application/src/ports/decision-ledger.ts:57`：`rule_review` 目前只有 `needs_review`。
- 建议：每次重检都写一条结果决策（新增 `cleared`/`active` outcome，或给 ledger 加 `resolved_at`/`resolution`），或者显式把原决策标记为已处理。否则历史记录和当前状态永远对不上。

### 【中高】6. 0087 已经会给 legacy 规则标 needs_review，但新方案只重检 `owner:` 规则

- 问题：方案第 3 节只处理“主人规则（`owner:` 前缀）”。但 0087 的触发器对所有 `rule_book_rules` 都生效，现有测试用的正是 `floor_important_sender` 和 `quiet_hours`。这些规则会永远停在 `needs_review`，而且继续执行；新方案不会重检、不会 suspended、也不会清除。
- 证据：
  - `packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:301-360,363-402`：触发器不区分 `rule_id` 前缀。
  - `test/integration/rule-memory-review.test.ts:36,137`：`RULE = "floor_important_sender"`、`quiet_hours`。
  - 方案第 3 节：“主人规则（`owner:` 前缀）中状态为 needs_review 的……”。
- 建议：要么把 legacy 规则也纳入重检（分别处理 `{senders}`、`{periods}` 参数和设置页确认），要么明确它们是“由设置页负责确认”的例外，并在迁移/清理策略里给出出口，不能留下永久 needs_review。

### 【中高】7. 触发条件只覆盖单向变化，撤销/恢复不会传播

- 问题：方案说“条件同 0087：content_ref 变、superseded_by 由空变非空、status 离开 active、category 变”。这漏掉了：
  - supersede 撤销：`superseded_by` 从非空变回空；
  - 归档恢复：`status` 从 archived/trashed 回到 active；
  - 其他语义字段（如 `valid_to`）变化。
  上游记忆恢复有效后，下游 reflect 记忆可能重新变得相关，但不会触发重审。
- 证据：
  - `packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:308-314`：只判断 `NEW.superseded_by IS NOT NULL AND ...` 和 `NEW.status IN ('archived','trashed','deletion_pending','deleted_verified')`。
  - `packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:393-408`：记忆状态包含 active/archived/trashed/deletion_pending/deleted_verified，恢复是 archived→active。
  - `packages/memory-engine/src/consolidation.ts:437-470`：undo 会把 reflect 生成的记忆改回 archived，也会撤销 supersede 的属性。
- 建议：触发条件改成“任何语义字段变化”（`content_ref`、`status`、`superseded_by`、`category`、`valid_to` 等都用 `IS NOT`），并补 supersede 撤销、归档恢复的传播测试。

### 【中高】8. “truncated 下次继续”在无状态 `readDerived` 上不可实现

- 问题：`readDerived` 每次从同一个起点做无状态 BFS，超过节点上限就返回相同的前 200 个。若把项标成 expanded，后面的分支永远发现不了；若不标，下一轮还是同一批，无法前进。
- 证据：
  - `packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:370-408`：BFS 只有 `found` 和 `truncated`，没有 cursor/offset/frontier。
  - 方案第 2 节：“超上限的留 truncated，下次继续”。
- 建议：改为持久化队列/游标（例如 `memory_review_queue(memory_id, depth, last_child_id)`），或者把每个发现的直接下游都写成独立待办，按 `memory_id` 排序分页处理；补 201+ 节点和深度 9 的测试，证明最终能覆盖全图。

### 【中高】9. 一个下游记忆可能有多个上游，单行 + 单个 `upstream_memory_id` 会丢信息

- 问题：reflect 的 basis 可以有多个（`basisMemoryIds` 是数组），但方案的表是“每个 (owner, agent, memory) 只有一行”，只存一个 `upstream_memory_id`。两个上游先后变化时，后一次 upsert 会覆盖前一次；界面只能显示一个上游。
- 证据：
  - `packages/memory-engine/src/consolidation.ts:618-623`：`basisMemoryIds = basis.map(...)`。
  - `packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:45-47`：basis 最多 200 个。
  - 方案第 2 节的列定义只有一个 `upstream_memory_id`。
- 建议：拆成 `memory_review_sources(memory_id, upstream_memory_id, reason, flagged_at)` 多行，或 item 上存规范化后的 upstream id 数组；主键/唯一约束明确写成 `(owner_id, agent_id, memory_id, upstream_memory_id)`。

### 【中】10. 新表没有进 `schemaCatalog` 和 data export/import，`npm run check` 会失败

- 问题：方案第 4 节只说了迁移，没有说 `schemaCatalog`、数据导出/导入。仓库的迁移契约测试要求数据库实际表集合与 `schemaCatalog` **完全相等**；只加迁移会直接失败。数据导出也没有新表，恢复后待审状态会丢。
- 证据：
  - `packages/persistence-sqlite/test/migration-engine.contract.test.ts:67-72`：`expect(tables).toEqual(schemaCatalog.map(({ table }) => table).sort())`。
  - `packages/persistence-sqlite/src/schema-catalog.ts:638-651`：`memory_consolidation_changes`/basis 的条目是逐个登记的。
  - `packages/persistence-sqlite/src/data-export/snapshot.ts:102-120`：导出了 runs/changes/basis，但没有 review items。
- 建议：补 `schemaCatalog` 条目、导出/导入、迁移契约测试；如果认为它是可重建的派生状态，就在文档和测试里明确“恢复后可重建”，并证明删除类事件也能重建（否则删除后 basis 已丢失）。

### 【中】11. 规则重检接入点与现有模型入口不匹配

- 问题：方案说用 `auxiliaryMemoryGeneration` 在“邮件检查读规则之前”和“对话运行开始时”跑重检。`auxiliaryMemoryGeneration` 在 per-run 组合里，依赖 `memoryCaptureOptions` 和 `RuntimeRequest`；邮件检查用的是 `ProductionProactive` 的独立 `ProactiveModelInvoker`，purpose 固定为 `mail-judgment`。直接复用会拿不到 admission/budget，或者把费用记错。
- 证据：
  - `apps/agent-service/src/production-run-composition.ts:555-591`：`auxiliaryMemoryGeneration` 定义在 run 组合内。
  - `apps/agent-service/src/production-proactive.ts:142`：邮件检查持有自己的 `ProactiveModelInvoker`。
  - `apps/agent-service/src/production-model-composition.ts:496-517`：proactive invoker 的 purpose 固定为 `mail-judgment`。
  - `packages/application/src/services/proactive-mail-check-service.ts:636-645`：邮件检查读规则走的是自己的 store/model 路径。
- 建议：把规则重检做成独立的后台任务/端口，有自己的预算账户、`rule-review` purpose、超时、并发锁；邮件检查和对话开始只触发/读取它的结果，不要复用 run 的辅助生成。

### 【中】12. UI 文案和分支只认识 `needs_review`

- 问题：`suspended` 规则会没有说明，或者沿用“规则照常执行”的错误文案。
- 证据：
  - `apps/control-center/src/components/rule-receipt.tsx:195-199`：只有 `status === "needs_review"` 时显示提示。
  - `apps/control-center/src/components/decision-chain-drawer.tsx:173`：同样只处理 `needs_review`。
  - `apps/control-center/src/i18n/resources/zh-CN.ts:980`：文案写“规则照常执行”。
- 建议：建立 status→label/enforced 文案表，覆盖 `active/needs_review/suspended/retired`，并对 `rule-receipt`、decision chain、daily review、规则列表做 UI 反向测试。

### 【中】13. 建议参数没有类型和展示位置

- 问题：方案要把“建议参数”写进决策记录 inputs，但 `DecisionInputs` 是封闭接口，没有 suggestion 字段；`validateLedgerWrite` 只校验已知字段。实现时要么 TypeScript 编译失败，要么写进去后显示/导出没地方读。
- 证据：
  - `packages/application/src/ports/decision-ledger.ts:100-129`：`DecisionInputs` 没有 suggestion/parameters 字段。
  - `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:52-72`：只校验 memoryIds/ruleIds 等已知字段。
- 建议：显式增加结构化 `suggestion`（type/params/summary）字段，或单独建 `rule_review_suggestions` 表；同时在 decision chain 和导出 schema 里支持。

### 【中】14. 新增的 reason/state/purpose 没有约束和完整消费端

- 问题：`memory_review_items.state`、`reason`、`cleared_reason` 没有 CHECK；`rule-review` purpose 需要同时加到 `MODEL_USAGE_PURPOSES` 和 0068 的 CHECK，否则写入会被数据库拒绝或被归为 `other`。
- 证据：
  - `packages/application/src/ports/model-usage.ts:3-12`：`MODEL_USAGE_PURPOSES` 目前没有 `rule-review`。
  - `packages/persistence-sqlite/src/migrations/0068_model_usage_observations.sql:6-11`：purpose 有 CHECK 白名单。
- 建议：像 0087 一样给出完整的 CHECK 和端口校验；新增一个“产出值 → 所有消费端”的契约测试（见 I-73 的教训，`docs/incidents-and-gates.md:112`）。

### 【中】15. 触发器无法区分“主人编辑”和自动更新，会自动清掉待审

- 问题：方案说“被改的记忆自己若是 pending，且 content_ref 变了（主人改了它）→ 把它自己标 cleared（owner_edited）”。但触发器只能看到 `content_ref` 变了，区分不了是主人手动更正、consolidation 的 update、还是 MCP/其他自动写入。自动更新也会把待审项错误地清成 `owner_edited`。
- 证据：方案第 2 节把清除逻辑放在同一个 `memory_records` AFTER UPDATE 触发器里；`packages/memory-engine/src/consolidation.ts` 的 update 路径可以改变 content_ref；`packages/persistence-sqlite/src/sqlite-memory-operations.ts` 的保存路径不携带“谁改的”信息。
- 建议：不要在触发器里自动清；把“记忆看过没问题”做成显式的 Owner 命令事务（带 expectedRevision），或在记忆历史里记录 `actor/origin`，触发器只记录事件、不推断主人意图。

---

## 推测（实现前需要验证）

- **多实例并发**：方案只保证“同一实例同时只有一个重检在跑”。如果生产有多个 agent-service 进程，可能重复调用模型、重复写决策。未核实生产进程数；建议用数据库租约/单行锁。
- **运行上下文遮盖**：如果 rule-review 走父 run 的 `auxiliaryMemoryGeneration`，同一段记忆文本可能因为该会话前面出现过的点名值而被遮成不同字节。取决于实现。
- **工具定义变化**：如果为了“认识 suspended”去改 `TOOL_RULE_SET`/`TOOL_RULE_LIST` 的描述，会改变工具定义，进而改变请求开头。方案没有明说是否改；如果改，必须按 ADR 0165 只对新对话生效。
- **重检延迟**：3 条 × 最长超时（现有辅助生成 45 秒）放在对话开始或邮件检查前，可能拖慢主路径。方案说“节流”，但没有给出上限和是否异步。
- **重检“相同”后是否清除记忆待审项**：方案没写。可能造成规则已 active、但记忆页仍显示待审。
- **legacy 规则是否故意排除**：方案没有说明这是范围外还是遗漏。

**未核实**：生产 agent-service 实例数；实际 rule-review 的超时/输出上限；邮件检查的真实节流窗口；`TOOL_RULE_SET` 是否会被修改。

---

## 侧重检查

我按额外侧重检查了以下路径：

- **错误路径**：模型超时/非法 JSON/503 → 方案会保持状态并重试，但没有上限后的 fail-closed；`needs_review` 仍执行（见问题 1）。规则参数重校验、来源 revision 变化丢弃结果，这两点方案有写。没有看到 rule-review 的最大输出 token 和超时值。
- **不合规范或不可信的输入**：模型返回的规则由 `judgeRuleReview` 走 `writableRuleType`/`parseOwnerRuleParameters`/`ownerRuleRecord`，校验链是对的（`packages/application/src/rules/rule-review.ts:49-83`）。但记忆正文作为提示词数据仍有 prompt injection 风险；因为结果只会变成“建议参数”或 suspended，影响被限制在“误挂起/误建议”，不会直接写入新规则。`standing: false` 会自动 suspended，属于可用性风险。
- **安全/数据分级**：方案只排除了 `restricted`，没有检查目标模型是否允许 `sensitive`。如果 run 使用的模型只允许 `private`，来源记忆为 `sensitive` 时会被拒绝或需要跳过。另一处语义问题：待重审的 rule 类记忆仍会进入 `owner-rules` 上下文块（`packages/application/src/services/owner-profile-service.ts:204-232,305-324`），即使对应硬规则已 suspended，模型在聊天中仍可能照做。
- **资源耗尽**：`memory_review_items` 没有清理/保留策略；触发器在每次记忆更新时同步 upsert 多个下游；展开在写事务里做 BFS；rule-review 每次最多 3 条且每条可能几十秒。建议加保留期、批量上限、后台执行。
- **不可撤销操作**：删除/取代/撤销 reflect、规则 undo、采用建议、主人确认都会改变不可逆状态；BEFORE DELETE + FK 是当前最具体的风险。采用建议和恢复规则都缺 expectedRevision 的完整端点。
- **规则/文档/代码一致性**：
  - 方案说“条件同 0087”，但 0087 的 status 条件是单向的（离开 active），方案复述成“离开 active”会漏掉恢复。
  - 方案只重检 `owner:` 规则，但 0087 已把 legacy 规则标 needs_review。
  - 方案说“不写决策记录”会让旧的 `rule_review/needs_review` 决策永远显示。
  - 新表没有进 `schemaCatalog`/导出，和仓库的迁移契约测试不一致。
  - I-73 的教训（`docs/incidents-and-gates.md:112`）适用于这里：新状态/原因/purpose 必须逐个过所有后端的校验，不能只看改动本身。
- **已核对且正确**：SQLite 触发器内不能用 `WITH`。官方原文：<https://www.sqlite.org/lang_with.html> “The WITH clause cannot be used within a CREATE TRIGGER.” 方案这一点没问题。

---

## 如果由我来定

我会把方案改成下面这样：

1. **用事件/队列代替“每记忆一行 + 触发器里展开”**
   在 `memory_records` 的相关更新/删除事务里，只向 `memory_review_events` 写一条紧凑事件（changed memory、old/new status、content_ref、superseded_by、category、revision、actor）。触发器不做 BFS、不 upsert 大量行、不引用即将删除的行。后台 worker 消费事件，按 cursor/queue 展开，幂等、可重试、可限流。这样同时解决删除 FK、截断、多上游、资源耗尽和触发器延迟。

2. **明确规则状态机，所有迁移都写决策**
   `active`（执行）/ `needs_review`（是否执行必须明文定义）/ `suspended`（不执行）/ `retired`。重检失败达到上限时，要么 suspended，要么 `needs_owner`，不能悄悄继续执行。每次重检结果（cleared/suspended/adopted）都写 history **和** ledger，避免旧的 needs_review 决策一直显示。

3. **新增专用 rule-review 后台任务，不复用 run 的辅助生成**
   独立端口、独立预算、`rule-review` purpose、固定超时/输出上限、数据库租约。prompt 用专门的 `prompt-catalog` 条目（不要复用 `TOOL_RULE_SET` 的工具描述），固定头 + 末尾数据；使用独立的出口遮盖上下文，避免受父会话历史影响。

4. **加“值契约”门槛**
   对每个新值（`suspended`、`source_removed`、`no_longer_standing`、`parameters_changed`、`owner_edited`、`owner_confirmed`、`review_suspended`、`review_cleared`、`owner_adopted`、`rule-review`、review item state）列出生产者和所有消费者，并在测试里逐个跑过 DB CHECK、gateway schema、web 类型、MCP、i18n、导出 schema。这是 I-73 的直接应用。

5. **补迁移和导出**
   `schemaCatalog`、data export/import、迁移契约、旧数据保留、决策 ledger 子表灌回，全部纳入 `npm run check`。

### 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会——前提是严格执行方案里“不改发给模型的内容”。主对话的系统提示、工具定义、历史都不需要变；待重审的记忆和规则状态只影响规则执行、UI 和新的后台调用。若 suspended 规则被过滤掉，它出现在**最后一条用户消息**的 `owner-rules` 上下文块里（`packages/application/src/services/owner-profile-service.ts`），仍然只改末尾，不碰请求头。需要特别小心：不要为了“认识 suspended”去改 `TOOL_RULE_SET`/`TOOL_RULE_LIST` 的工具描述，否则就是工具定义变化，必须按冻结/换新规则处理（`.claude/rules/prompt-prefix.md:41-44`）。新加的 rule-review 是独立请求，固定部分在前、数据在后，不进入主对话。
**结论：仍然只在末尾追加；每轮会变的值都在最后一条用户消息；review 状态不应进入系统提示、工具定义或历史。**

**2. 同一段文字会不会在不同请求里变成不同字节？**
规则参数的比较/序列化基本是确定的：`parseMailMatch` 会去重、排序、折叠大小写，`judgeRuleReview` 用规范化后的 `JSON.stringify` 比较（`rule-types.ts:75-87,109-114`；`rule-review.ts:23-25`）。方案也明确不放时间、修订号、编号。
但有两个风险：
- 如果 rule-review 走父 run 的遮盖上下文，同一段记忆文本可能因该会话前面出现过的点名值而被遮成不同字节；应使用独立的、只依赖输入本身的遮盖。
- 列表/报告如果依赖数据库返回顺序，需要显式 `ORDER BY`。
**结论：参数本身可以做到确定；遮盖和列表顺序必须单独保证。**

**3. 有没有对应的自动检查，反向用例真的会失败？**
有基础，但不够。方案已列：两层反射、撤销 reflect、直接 DELETE、改 B 清 B、参数变/不变/standing false/503/来源变化丢弃、去掉触发器/让 suspended 执行/比较恒不等。
缺的检查：
- 主对话请求头字节不变（review 状态变化、规则 suspended 前后）；
- rule-review prompt 的确定性 golden（同样输入同样字节）；
- 每个新状态/原因/purpose 的消费者矩阵（DB、gateway、web、MCP、i18n、导出）；
- 删除上游后 review item 仍存在；
- 201+ 节点/深度 9 的截断续跑；
- 多上游同时变化；
- legacy 规则的处理；
- `schemaCatalog`/导出/迁移契约；
- 重试退避、最多 3 次、source revision 重置。
**结论：反向用例的思路对，但覆盖面不足；至少要补上请求头、确定性、删除 FK、截断和多上游。**

**4. 每个产生/修改的值，使用它的地方都能接受吗？**
目前不能，至少有这些缺口：
- `suspended`：`ruleIsEnforced`、`enforceableOwnerRule`、`OwnerRuleStorePort.setStatus`、`SqliteOwnerRuleOperations.list/setStatus`、`ProductionOwnerRuleWriter.reconfirm`、`rule-ref`、`contracts-v2` 的 `memory.rules.snapshot`、MCP、`rule-receipt`、`decision-chain-drawer`、三语文案。
- `review_attempts`/`review_after`/`reviewed_source_revision`：产生在重检，消费在调度；方案没有说 source 变化/主人操作时如何重置。
- `memory_review_items`：schema catalog、data export/import、迁移契约、state/reason/cleared_reason 的 CHECK。
- 决策结果：`decision_ledger.rule_review` 只有 `needs_review`，缺 `cleared`；`DecisionInputs` 没有建议参数字段。
- `rule-review` purpose：`MODEL_USAGE_PURPOSES` 和 0068 的 CHECK 都要加。
- 采纳建议：没有“更新现有规则参数”的端口。
**结论：按 I-73 的做法，先列一张“值 → 生产者 → 所有消费者”的表，再写一个契约测试；现在方案只覆盖了部分消费端。**
