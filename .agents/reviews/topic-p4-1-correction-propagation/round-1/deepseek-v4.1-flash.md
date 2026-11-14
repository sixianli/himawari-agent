# P4-1 记忆纠正传播：我的完整方案

## 0. 结论先写

我的方案分两层，关键点是**不碰对话请求头**：

1. **确定性传播层**：数据库触发器只做一件事——在记忆被编辑/取代/删除的同一事务里，把“直接下游记忆”写入一张待重审表；删除时必须在 `BEFORE DELETE` 里抓，因为依据行会被 `ON DELETE CASCADE` 删掉。后台任务再从这些种子沿依据表做有界 BFS，标记全部下游，并把 `source_memory_id` 命中的生效规则标为 `needs_review`。
2. **规则重检层**：后台用低价模型，按立规则时同一套翻译说明，把改后的记忆正文重新译成规则；程序用现有 `parseOwnerRuleParameters`/`writableRuleType` 校验，再与现有规则逐项比较。相同→自动恢复 `active`；类型/参数变化或“不再是长期规则”→新增状态 `suspended`（不执行），并给出建议值；模型失败或输出非法→保持 `needs_review`（照常执行），只列入列表。

不改记忆正文；不新增模型工具；不把待重审标记塞进系统提示或记忆注入内容。

---

## 1. 方案依赖的前提

### 1.1 产品原则

- 冲突优先级是：**用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率**。
  来源：`docs/product-vision.md:55`，原话：“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”
- 纠正必须传播到推断和行为。
  来源：`docs/product-vision.md:59`，原话：“纠正应传播到受其影响的推断与行为。规则不是记忆，是硬性设定……”

### 1.2 依据链现状

- 依据表已经存在，按记忆编号有索引，设计目的就是给纠正传播反查。
  来源：`docs/adr/0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md:39`，原话：“迁移 0084 新建 `memory_consolidation_change_basis`：每行是某次整理改动的一条依据记忆（改动编号、顺序、记忆编号），改动或记忆被删时随之级联删除，按记忆编号建索引，供以后‘改一条记忆，由它推出的记忆跟着重审’反查。”
- **删除会级联删掉依据行，这是本方案最关键的现状缺陷。**
  来源：同上 `:41`，原话：“依据记忆被治理删除时，它的依据行随之级联删除，依据链会少一个节点，读取方看不出少的是已删除的来源（可以更好，未做）。”
- 现有读取接口只往上游走，不负责下游反查。
  来源：`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:302` 起 `readBasisChain`；`:312` 的查询条件是 `memory_id = ?`，沿被改记忆自己的整理改动往依据里走。
- 只有 reflect 会产生新记忆；merge/supersede/archive/hold 改的是已有记忆。
  来源：`packages/memory-engine/src/consolidation.ts:562`、`:573`、`:618`；`docs/adr/0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md:39` 也写明“推断记全部基础记忆”。

### 1.3 规则与记忆的对应

- 规则用 `source_memory_id` 指回来源记忆。
  来源：`docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md:50`，原话：“`rule_book_rules` 和 `rule_book_history` 各加一个可空字段 `source_memory_id`，指向那条规则类记忆的编号。”
- 记忆一变，触发器把规则标 `needs_review`，而且**待重审的规则照常执行**。
  来源：`docs/adr/0211-...:51`，原话：“待重审的规则**照常执行**……”；同 ADR `:57` 说明触发器在同一个事务里标记。
- 触发器只从 `active` 标，已经是 `needs_review` 的不重复触发。
  来源：`docs/adr/0211-...:57`，原话：“已经是 `needs_review` 的规则不会重复触发，删除也一样。”
- 规则来源记忆的正文是“主人原话 + 说明”，不是整理推出的。
  来源：`apps/agent-service/src/production-owner-rules.ts:520-525`，代码写的是 `text: \`${proposal.quote}\n${parsed.summary}\``，`category: "rule"`，并写 `sourceMemoryId: memoryId`。
- 规则参数在写入前会被规范化、排序和校验，表达式与例子由程序生成。
  来源：`packages/application/src/rules/rule-types.ts:79-86`（折叠、去重、排序）、`:257-273`（`parseOwnerRuleParameters`）、`:224-231`（`writableRuleType`）；`packages/application/src/rules/rule-book.ts:455-480`（形状和例子校验）。

### 1.4 规则状态与执行路径

- 当前状态只有三种：`active`、`needs_review`、`retired`。
  来源：`packages/application/src/rules/rule-book.ts:12`；`packages/application/src/rules/rule-ref.ts:23`。
- `ruleIsEnforced` 目前把 `needs_review` 当作执行。
  来源：`packages/application/src/rules/rule-book.ts:14-16`，原话：`return status === "active" || status === "needs_review";`
- 设置读取 SQL 也只取 `active`、`needs_review`。
  来源：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:241-242`，原话：`WHERE owner_id = ? AND agent_id = ? AND status IN ('active', 'needs_review')`。
- 规则列表查询也只取 `active`、`needs_review`。
  来源：`packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:86-88`。
- 现有 `setStatus` 只接受 `active`/`retired`，原因只接受 `owner_undo`/`owner_confirmed`。
  来源：`packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:171-174`。所以“挂起”和“按建议值生效”不能硬塞进现有 `setStatus`。

### 1.5 请求与提示词

- 请求顺序是工具定义 → 系统提示 → 历史 → 最后一条用户消息；每轮会变的值只能放最后一条用户消息。
  来源：`.claude/rules/prompt-prefix.md:27-28`，原话：“固定的在前，会变的在后……每轮都会变的内容只放在最后一条用户消息里。”
- 已经发出去的内容只能追加，不能改系统提示、工具定义、历史消息。
  来源：`.claude/rules/prompt-prefix.md:35`。
- 后台调用同样“固定的指令在前、这次的数据在后”。
  来源：`.claude/rules/prompt-prefix.md:67`，原话：“后台调用也是固定的在前、会变的在后。整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。”
- 新增提示词必须登记进目录，并且固定文本清单会影响遮盖。
  来源：`.claude/rules/prompt-prefix.md:53`；`packages/prompt-catalog/src/entry.ts:1-8`；`packages/prompt-catalog/src/trusted.ts:10-13`；`apps/agent-service/test/prompt-catalog.unit.test.ts:175-195`。
- 新增提示词若进入 `TRUSTED_PROMPT_TEXTS`，会给“固定文字不检查”的清单增加一段；只要新文本是全新长句、不会出现在旧历史里，旧对话的遮盖字节不变。这一点必须用测试证明。

### 1.6 决策记录

- 决策记录可以被主人清除或评价，不能当事实来源。
  来源：`docs/adr/0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md:49`，原话：“决策记录会被 Andy 清除或评价，不能当事实来源”。
- `rule_review` 类型已经存在，但结果值只有 `needs_review`。
  来源：`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:64-75`；`packages/application/src/ports/decision-ledger.ts:44-58`。

### 1.7 写入路径与事务

- 记忆写入口不止一个，所以触发器比服务层挂钩可靠。
  来源：`docs/adr/0211-...:57`，原话：“用触发器而不是在服务层挂钩，是因为写入口不止一个……触发器在同一个事务里，改记忆和标待重审不可能只成功一半。”
- SQLite 的外键动作顺序是：先执行 `BEFORE` 触发器，再改父表行，再做外键动作，最后执行 `AFTER` 触发器。因此 `BEFORE DELETE` 触发器能在级联删依据行之前读到依据。
  来源：<https://www.sqlite.org/foreignkeys.html> 第 4.3 节，原话：“Execute applicable BEFORE trigger programs, Check local (non foreign key) constraints, Update or delete the row in the parent table, Perform any required foreign key actions, Execute applicable AFTER trigger programs.”

### 1.8 迁移与模型成本

- 改表要排队、迁移号连续（本次材料约束）。当前最新迁移是 `0089_consolidation_hold.sql`，所以本方案用 `0090`。
- 按 token 付费只能用 DeepSeek V4.1 Flash 这类低价模型；超过 0.5 美元先问主人（本次材料约束）。
- 现有后台调用走 `auxiliaryMemoryGeneration`，它用的是发起请求的 `request.modelRef`，不能自动保证是低价模型。
  来源：`apps/agent-service/src/production-run-composition.ts:555-591`；`apps/agent-service/src/service-main.ts:2147-2159`。
- 现有低价邮件模型配置在 `runPolicy.proactive.modelRef`。
  来源：`packages/application/src/ports/configuration.ts:223-244`；`apps/agent-service/src/production-model-composition.ts:496-518`。
- 高价模型扫描会禁止 `claude-*`、`gpt-*` 等出现在代码、脚本、配置里。
  来源：`scripts/check-expensive-models.mjs:45-48`。

---

## 2. 方案

### 2.1 数据怎么存

不往 `memory_records` 加字段，也不把待重审做成记忆状态。新增两张表，并给规则状态加一个值。

#### 表 1：`memory_review_items`

一行代表“某条记忆当前待重审”。**不要给 `memory_id`/`source_memory_id` 加指向 `memory_records` 的外键**，否则删除记忆时待重审记录也会被级联删掉。

字段：

| 字段 | 含义 |
|---|---|
| `owner_id`, `agent_id` | 归属，随主人/Agent 删除级联 |
| `memory_id` | 被标记的派生记忆；允许已删除 |
| `state` | `pending` / `cleared` |
| `reason` | `upstream_edited` / `upstream_superseded` / `upstream_removed` / `upstream_reclassified` |
| `root_memory_id` | 最初被改的那条记忆 |
| `source_memory_id` | 直接上游 |
| `depth` | 从根算起的层数 |
| `suggested_action` | 可空，`archive` / `keep`；只在程序能确定时给 |
| `expanded_at` | 下游是否已经展开；空表示还没 BFS |
| `truncated` | 是否因深度/节点上限没展开完 |
| `first_marked_at`, `updated_at`, `cleared_at` | 时间 |

主键 `(owner_id, agent_id, memory_id)`；索引 `(owner_id, agent_id, state, updated_at)`。

这样删除上游后，待重审记录仍在；UI 能显示“由已删除的记忆 X 推出”，下游记忆本身不受影响。

#### 表 2：`rule_review_cases`

一行是一轮规则重检。规则状态变化仍写在 `rule_book_rules`/`rule_book_history`，这张表只存“检验过程、模型建议、为什么挂起”。

字段：

| 字段 | 含义 |
|---|---|
| `id` | 确定性编号，如 `rule-review:<ruleId>:<sourceRevision>`，长度 ≤128 |
| `owner_id`, `agent_id`, `rule_id` | 归属与规则 |
| `source_memory_id` | 来源记忆快照；允许已删除 |
| `source_memory_revision` | 检验时依据的记忆版本，用于防“检验完又改了” |
| `state` | `pending` / `model_failed` / `invalid_output` / `suggested` / `not_needed` / `source_missing` / `content_blocked` / `applied` / `cleared` |
| `reason` | `memory_edited` / `memory_superseded` / `memory_removed` / `memory_reclassified` |
| `proposed_type` | 可空，模型译出的类型 |
| `proposed_params` | 可空，JSON object；DB 只校验 `json_valid` 和 object，语义校验在服务层 |
| `proposed_summary` | 可空 |
| `proposed_action` | 可空，`apply_parameters` / `retire` |
| `model_error` | 可空，短错误码 |
| `attempt_count`, `claimed_at`, `claimed_by` | 重试与并发租约 |
| `decision_id` | 可空，指向本次挂起的决策记录 |
| `created_at`, `updated_at`, `closed_at` | 时间 |

同一规则同时只允许一个未关闭的 case：用部分唯一索引 `(owner_id, agent_id, rule_id) WHERE closed_at IS NULL`。

#### 规则状态加 `suspended`

`rule_book_rules.status` 和 `rule_book_history.status` 的 CHECK 增加 `suspended`。语义：

- `active`：执行；
- `needs_review`：待重审，**照常执行**（模型失败/输出非法时停在这里）；
- `suspended`：检验已完成且不通过，**不执行**，等主人确认；
- `retired`：主人撤销，不执行。

这比把 `suspended` 塞进 `needs_review` 再另存一个标志更直接，执行路径只需要认一个字段；代价是所有读状态的地方都要同步，见第 7 节必答问题 4。

### 2.2 何时标记

#### 编辑/取代/归档/分类变化

在 `memory_records` 上新增 `AFTER UPDATE` 触发器，条件只覆盖会让依据失效的变化：

- `content_ref` 变了（修正、恢复版本、整理更新）；
- `superseded_by` 从空变成非空（被取代）；
- `status` 离开 `active`，进入 `archived`、`trashed`、`deletion_pending`、`deleted_verified`；
- `category` 变了。

不覆盖：只改重要度、`last_used_at`、`use_count`、从回收站恢复、再次确认同样文字（`content_ref` 不变）。

触发器**只标记直接下游**，不递归：

```sql
INSERT INTO memory_review_items (...)
SELECT OLD.owner_id, OLD.agent_id, c.memory_id, 'pending', <reason>,
       OLD.id, OLD.id, 1, NULL, NULL, 0, NEW.updated_at, NEW.updated_at, NULL
FROM memory_consolidation_change_basis b
JOIN memory_consolidation_changes c ON c.id = b.change_id
WHERE b.memory_id = OLD.id
  AND c.undone_at IS NULL
  AND c.memory_id <> OLD.id
ON CONFLICT (owner_id, agent_id, memory_id) DO UPDATE SET
  state = 'pending', reason = excluded.reason,
  source_memory_id = excluded.source_memory_id,
  updated_at = excluded.updated_at, cleared_at = NULL, expanded_at = NULL;
```

注意 `c.memory_id` 才是“被这次整理影响/推出的记忆”；`related_memory_id` 是合并保留方、取代的新方，不是依据链下游。三层推断 A→B→C 走的是 reflect 的 `memory_id`，所以这条方向是对的。

#### 删除

新增 `BEFORE DELETE ON memory_records` 触发器，逻辑同上，原因记 `upstream_removed`，时间用数据库当前时间。因为 SQLite 的 `BEFORE` 触发器先于外键级联动作执行，这时 `memory_consolidation_change_basis` 里指向被删记忆的行还在，能抓到直接下游。删除后再由后台 BFS 找 C。

触发器加与 0087 删除触发器相同的保护：只在所属 Agent 和主人还在时动作，避免删除主人/Agent 时产生无意义待重审项。

#### 规则

沿用现有 0087 触发器，不新增规则标记触发器。理由：

- 来源记忆被改且规则是 `active` 时，0087 已经标 `needs_review`、写历史、写决策；
- 来源记忆在规则已经 `needs_review`/`suspended` 时又被改，0087 不会重复触发；后台重检任务每次读取“当前记忆版本”，用 `source_memory_revision` 发现变化并刷新 case，不需要再写一遍历史/决策；
- 规则来源是“由下游派生记忆”的情况，由后台在标记下游记忆后，查 `rule_book_rules.source_memory_id IN (visited)`，把仍是 `active` 的规则标 `needs_review`。当前事实说规则来源是 `rule_set` 直接写的，不是整理推出的，所以这条是防御性覆盖，但测试里会造一条合成数据证明它成立。

### 2.3 怎么往下游找

后台 `MemoryReviewPropagator` 做 BFS：

1. 取所有 `expanded_at IS NULL` 且 `state='pending'` 的项；
2. 对每个 `memory_id`，查：
   ```sql
   SELECT DISTINCT c.memory_id
   FROM memory_consolidation_change_basis b
   JOIN memory_consolidation_changes c ON c.id = b.change_id
   WHERE b.memory_id = ? AND c.undone_at IS NULL AND c.memory_id <> b.memory_id
   ORDER BY c.memory_id
   ```
3. 对每个新下游 upsert 待重审项，`depth+1`，`expanded_at=NULL`；
4. 已访问集合去重，防止环；
5. 每轮限制节点数（例如 200），处理不完就保留 `expanded_at IS NULL`，下一轮继续；不静默丢弃；
6. 深度上限（例如 32）只用于防御异常图，达到上限记 `truncated=1`，列表显示“未展开完”，后续人工或下一轮继续。

遍历时不按记忆状态过滤：B 即使已归档，也可能是 A→B→C 的中间节点；只有依据改动被撤销（`undone_at` 非空）才切断。

遍历结束后，在**同一个事务**里：

- 把 `source_memory_id IN (所有 visited)` 且 `status='active'` 的规则标 `needs_review`（历史 + 决策 + revision+1）；
- 对 `source_memory_id IN (visited)` 或来源已删除的规则，确保有打开的 `rule_review_cases`。

### 2.4 规则怎么重检

#### 提示词

新增一个 `layer: "background"` 的固定提示词，登记进 `packages/prompt-catalog`，例如 `RULE_RECHECK`。内容与 `rule_set` 的翻译说明同义，要求模型只输出 JSON：

```json
{"standing": true, "type": "mail_must_notify", "params": {...}, "summary": "..."}
```

- 固定指令在前；
- 本次数据只有“改后的记忆正文”，放在最后一段；
- **不把现有规则的参数给模型**，避免模型锚定、照抄旧值；比较全部由程序做。
- 不把时间、case id、attempt、随机数放进提示词。
- 正文按记忆自己的 `dataClassification` 走统一出口；`restricted` 不发送。

如果新提示词进入 `TRUSTED_PROMPT_TEXTS`，用测试证明一段旧历史在新清单下遮盖字节不变（见必答问题 1/2）。

#### 程序校验与比较

模型输出只当候选：

1. `standing === false` → 判为“不再是长期规则”；
2. `standing === true` 且 `type === "soft"` → 也判为“不再是硬规则”；
3. `type` 必须通过 `writableRuleType(type)`；
4. `{type, params, summary}` 必须通过 `parseOwnerRuleParameters`（内部会走 `parseMailMatch`、域名/地址/词条校验、长度上限、去重排序）；
5. 用解析后的规范对象与现有规则 `parameters` 比较，**只比 `type` 和 `params`，不比 `summary`**；数组已在解析时排序，JSON 键顺序固定，所以比较确定；
6. 校验不通过 → `invalid_output`，**不改变规则状态**。

#### 结果

| 模型结果 | 规则状态 | case 状态 | 决策记录 |
|---|---|---|---|
| 与现有类型、参数相同 | `active`（自动解除待重审） | `applied` | 不新增，只写 `rule_book_history`，原因 `rechecked_same` |
| 类型或参数不同 | `suspended` | `suggested`，存建议参数 | 写一条 `rule_review`/`needs_review`，原因 `recheck_changed` |
| `standing=false` 或 `type=soft` | `suspended` | `not_needed`，建议 `retire` | 写一条 `rule_review`/`needs_review`，原因 `recheck_not_needed` |
| 来源记忆已删除/分类不再是 rule | `suspended` | `source_missing` / `reclassified` | 写一条 `rule_review`/`needs_review`，原因 `recheck_source_missing` |
| 模型调用失败 | 保持原状态（通常是 `needs_review`，继续执行） | `model_failed` | 不新增；写 observation |
| 输出非法/参数校验失败 | 保持原状态 | `invalid_output` | 不新增；写 observation |
| 内容分级不允许发送 | 保持原状态 | `content_blocked` | 不新增；列入列表 |

“保持原状态”很重要：**模型失败或输出非法不能把规则从 `suspended` 重新启用，也不能把 `needs_review` 变成 `suspended`**。只有成功解析并完成比较才改变状态。

#### 防陈旧

模型调用可能很慢，期间主人又改了记忆或规则。应用结果前重新读：

- 规则 revision 必须还是 case 记录的那一版；
- 来源记忆 revision 必须还是 `source_memory_revision`；
- 任一变化 → 丢弃本次结果，case 回到 `pending`，下一轮重检。

主人点“按建议值生效”时也再次校验：规则 revision、来源记忆 revision、`proposed_type`/`proposed_params` 必须还能通过后端解析。任何一项不通过就返回冲突，不写入。

### 2.5 挂起与恢复

新增持久层操作 `ruleReview.resolve`，在同一个事务里完成：

- 更新 `rule_book_rules.status`、`revision+1`、`updated_at`；
- 写 `rule_book_history`（带 `source_memory_id` 和 `change_reason`）；
- 更新 `rule_review_cases`；
- 需要时写决策记录；
- 所有写入都校验预期 revision，冲突就不写。

主人的动作：

| 动作 | 效果 |
|---|---|
| `apply_suggestion` | 用建议的参数写回规则，`suspended → active`，保留 `source_memory_id`，历史原因 `owner_accepted_recheck` |
| `keep_current` | 用旧参数恢复 `active`，历史原因 `owner_kept_current` |
| `retire` | `suspended → retired`，历史原因 `owner_retired_after_recheck` |
| `recheck` | 重新排队检验，不动规则 |

“改成不用了”被主人确认时，建议只停用规则，不改来源记忆正文；是否归档来源记忆由主人另行处理，避免把主人刚写的“不用了”也弄丢。

### 2.6 待确认列表

新增网关查询/命令，不改模型工具：

- `memory.review.read` / `memory.review.snapshot`
- `memory.review.respond`

列表内容：

**记忆项**

- 派生记忆 id、正文（仅模型可见分级；`restricted` 不带正文）、分类、状态；
- 原因（上游被编辑/取代/删除/改分类）；
- 直接上游 id、根记忆 id、层数；
- 建议动作：可空。只有程序能确定的才给，例如上游已删除或已被取代 → `archive`（建议归档派生记忆）；其他情况只列出，不给建议；
- `first_marked_at`、是否还有未展开的下游。

**规则项**

- ruleId、说明、当前状态（`needs_review`/`suspended`）；
- 来源记忆 id、是否已删除；
- 模型建议：`proposed_type`、`proposed_params`、`proposed_summary`、`proposed_action`；
- 检验状态（待检验/模型失败/输出非法/已给建议）；
- 决策记录 id；
- 动作按钮：按建议值生效 / 保留原参数 / 停用 / 重新检验。

响应命令必须带 `expectedRevision`（记忆和规则各自的），后端再次读记录、校验归属、校验分级、再次解析建议参数。列表的 `complete` 字段在存在未展开节点、深度截断、正文读不到时为 `false`，不能假装完整。

### 2.7 决策记录

挂起时写一条：

- `kind = 'rule_review'`
- `outcome = 'needs_review'`（现有约束允许）
- `reason_code = 'recheck_changed' | 'recheck_not_needed' | 'recheck_source_missing'`
- `subject_ref = ruleId`
- `inputs = { memoryIds: [sourceMemoryId], ruleIds: [ruleId], batchId: null, resultMemoryIds: [] }`
- `cost_micros` 能拿到就填实际调用成本，拿不到填 0
- id 确定性生成，重复执行用 `ON CONFLICT DO NOTHING`

自动恢复写 `rule_book_history`（原因 `rechecked_same`），不新增决策记录；因为 `rule_review` 现有结果值只有 `needs_review`，硬写会名不副实。若 Andy 要求“每次检验都进决策账本”，才需要新增 outcome，并重建 `decision_ledger`。

模型失败/输出非法只写 observation event，不写决策记录，避免每次重试刷账本。

### 2.8 何时跑、怎么控成本

- **传播层**：记忆变更事务提交后，由网关命令触发一次 `expand`；服务启动时也扫一次未展开项。传播层不调用模型，可以立即做。即使进程崩了，触发器和待重审表已经落盘。
- **规则重检层**：
  1. 传播完成后尝试跑；
  2. 每次 Gmail 主动检查开始、读规则之前跑一次，保证挂起的规则在下一次检查前生效；
  3. 对话运行开始时作为兜底跑一次（类似现有记忆整理的触发位置）。
- 同一 owner/agent 同时只允许一个重检任务；用 case 的 `claimed_at/claimed_by` 加租约。
- 每轮最多处理 N 条（例如 3 条），失败重试间隔至少 1 小时、最多 3 次；超过就留在列表，状态不变。
- 设每日成本上限；达到上限就停止自动重检，保留待重审/挂起状态并显示原因。单次调用很小，但 32 条规则 × 重试仍要防失控。
- 调用用低价模型。推荐复用 `runPolicy.proactive.modelRef`（它已经是 Gmail 判断用的低价模型），新增用途 `rule-review` 只用于成本观测；如果不想改 `model_usage_observations` 的 CHECK，就先映射到 `other`，但成本报表会粗。这个取舍见第 5 节。

### 2.9 迁移

本次一个迁移 `0090`（当前最新是 0089）：

1. 新建 `memory_review_items`、`rule_review_cases` 及索引；
2. 重建 `rule_book_rules`、`rule_book_history`，状态 CHECK 加 `suspended`，数据原样拷回，重建历史只追加触发器、`source_memory_id` 索引；
3. 新建 `memory_review_items` 的 `AFTER UPDATE` / `BEFORE DELETE` 触发器；
4. 如果要新增模型用途 `rule-review`，重建 `model_usage_observations`（否则用 `other`）；
5. 不重建 `decision_ledger`，因为 `rule_review`/`needs_review` 已经允许；
6. 不迁移回填历史下游：旧数据没有可靠的“删除前依据”，只能从现在开始。已有 `needs_review` 的规则由第一次后台扫描建 case，不需要迁移脚本写业务逻辑。

迁移必须带快照，契约测试验证旧数据逐列一致、`suspended` 可写、非法状态被拒、`foreign_key_check` 为空。

### 2.10 测试怎么证明“做到什么算完”

新增 `[P4-1]` 测试，并确保在 `npm run check` 里跑：

1. **三层链**：真实建 A、B=reflect(A)、C=reflect(B)，编辑 A 后：
   - `memory_review_items` 有 B、C，层数正确；
   - 无关记忆 D 没有；
   - B、C 的正文、revision 都没变（证明只标记，不改正文）；
   - 去掉 `AFTER UPDATE` 触发器或 BFS，这条测试失败。
2. **删除传播**：删除 A（治理删除/回收站/直接删），B、C 仍被标记；即使 `memory_consolidation_change_basis` 已级联删掉。去掉 `BEFORE DELETE` 触发器，这条测试失败。
3. **规则失败挂起**：规则来源是 B，模型桩返回参数变化：
   - 规则 `suspended`；
   - `ruleIsEnforced('suspended') === false`；
   - 设置读取 SQL 不返回它（实际邮件检查路径验证，不只看状态字段）；
   - 待确认列表有建议参数；
   - 有 `rule_review` 决策记录；
   - 规则来源记忆正文没变。
4. **规则通过恢复**：模型桩返回相同类型/参数，规则回到 `active`，历史原因 `rechecked_same`，不挂起。
5. **模型失败**：抛错时规则仍在 `needs_review` 且仍被执行，case 为 `model_failed`，列表可见。
6. **输出非法**：类型不存在、参数非法、`standing` 缺失时，规则状态不变，不挂起，case 为 `invalid_output`。
7. **建议值后端校验（I-73）**：把 `rule_review_cases.proposed_params` 改成合法 JSON 但语义非法（例如未知类型、空匹配条件、超长词条），主人点“按建议值生效”必须失败，规则仍 `suspended`。这条专门防“清单里的 id/参数能通过后端校验吗”。
8. **来源已删除**：来源记忆删除后，规则 `suspended`、建议停用，决策原因 `recheck_source_missing`。
9. **陈旧检验**：模型返回后、应用前改来源记忆 revision，结果被丢弃，规则不恢复/不挂起。
10. **迁移契约**：旧规则/历史数据不变；`suspended` 可写；`status='bogus'` 被拒。
11. **状态消费者**：`ruleIsEnforced('suspended')=false`；`rule_book`/规则列表/网关快照都能接受 `suspended`；反向：如果某个 SQL 仍只写 `active`/`needs_review`，测试失败。
12. **请求头**：`npm run check:prompt-prefix` 原样通过；新增提示词登记后 `check:prompt-catalog` 通过；反向用例：把时间/内存正文塞进固定提示词，新加的检查必须失败；用旧历史 + 新 `TRUSTED_PROMPT_TEXTS` 验证遮盖字节不变。
13. **成本/模型**：`check:expensive-models` 通过；测试重检调用的是配置的低价模型 ref，不是聊天模型。
14. **数据导出/目录/界面**：新表进入 schema catalog 或明确排除理由；新 UI 文案三语齐全，`check:locale` 通过。

---

## 3. 考虑过但不选的做法

1. **在 `memory_records` 加 `review_state` 字段。**
   - 不选：记忆读取、注入、投影、列表、导出都要改；删除后无法保留待重审墓碑；还可能改变模型看到的记忆内容。
2. **把待重审直接做成记忆状态。**
   - 不选：会改变所有 `status='active'` 的查询，等于悄悄把记忆移出模型视野，违反“只标记、不改正文”，且影响请求内容和缓存。
3. **用决策记录当待确认列表。**
   - 不选：ADR 0194 已明确决策记录会被清除/评价，不能当事实来源；挂起建议需要可修改、可重试的状态。
4. **只在服务层挂钩，不加触发器。**
   - 不选：记忆写入口不止一个，治理删除、撤销整理、恢复版本等都直接改表；触发器才能保证同事务、删除前抓到依据。
5. **用递归触发器直接标完整条链。**
   - 不选：SQLite 递归深度、顺序、环和上限都难控；BFS 在后台做更可控，触发器和删除场景只负责保命的第一跳。
6. **删除时把 `ON DELETE CASCADE` 改成 `RESTRICT` 或把依据行做成无外键。**
   - 不选：会改变既有清理语义，影响治理删除和主人删除；迁移风险远大于加一个 `BEFORE DELETE` 触发器。
7. **重新检查“规则参数是否还出现在记忆正文里”。**
   - 不选：主人已给出反例，`isa.go.jp`、`出入国在留管理庁` 是模型扩写的变体，本来就不在原话里，会误挂起。
8. **重跑规则自带正反例。**
   - 不选：正反例由程序按参数生成，与记忆正文无关，永远通过。
9. **拿旧规则参数喂给模型让它判断。**
   - 不选：会锚定旧值，模型容易原样返回；程序比较更可靠。模型只负责从新原话重新翻译。
10. **把 `suspended` 塞进 `retired`。**
    - 不选：`retired` 是主人主动撤销，UI、`rule_undo`、来源记忆恢复逻辑语义都不同；且 `retired` 规则再启用走的是另一条路，容易误操作。
11. **新增决策类型或结果值。**
    - 不选：要重建 `decision_ledger` 和六张子表，成本高；现有 `rule_review`/`needs_review` 足够表达“挂起等主人看”，恢复结果放 `rule_book_history` 和 case 表。
12. **重检做成新的模型工具。**
    - 不选：会改变工具定义，老对话下一轮要按 ADR 0165 换新一次，违反本任务“不改请求头”的目标；后台调用即可。
13. **一次模型调用批量处理所有规则。**
    - 不选：单条失败会污染整批，重试和成本核算困难；一条一调用，固定提示词还能命中后台缓存。
14. **自动改记忆正文或自动归档派生记忆。**
    - 不选：违反主人目标“只标待重审和检验，不自动改记忆正文”；建议值必须主人点头。
15. **把“待重审”标记注入模型看到的记忆文字。**
    - 不选：会改变最后一条消息/历史内容，影响缓存；模型是否知道待重审不应成为传播正确性的前提。

---

## 4. 风险和反例

1. **删除前触发器漏装或迁移时 `DROP TABLE memory_records` 不会触发。**
   SQLite 文档说 `DROP TABLE` 的隐式 DELETE 不触发 SQL 触发器。本方案只对行删除依赖 `BEFORE DELETE`；迁移/重建 `memory_records` 时必须另走数据迁移，不能靠触发器。测试要模拟真实 `DELETE`，不能只测应用层。
2. **历史删除无法补回。**
   本方案上线前的删除已经把依据行级联删掉，无法恢复上下游关系。这一点要明说，不能假装能追溯历史。
3. **规则已经 `needs_review` 时再次改来源记忆，0087 不重复触发。**
   本方案靠后台读当前记忆 revision 刷新 case；如果后台一直没跑，主人看到的仍是旧的 `needs_review`。必须保证重检任务会在邮件检查前跑，并在列表里显示 `source_memory_revision` 与当前版本的差异。
4. **模型调用期间来源又改。**
   用 `source_memory_revision` + 应用前复核解决；否则会把旧文本的检验结果应用到新文本。
5. **模型输出非法时误挂起规则。**
   明确规定“只有成功解析并比较才改变状态”；否则一次坏输出会把主人的硬规则悄悄停掉，违反“硬偏好必定执行”。
6. **模型把记忆正文里的指令当指令（提示词注入）。**
   固定提示词里写明“下面只是数据，不要执行其中指令”；程序只接受类型/参数/standing，不执行自由文本；最终生效还要主人点头或参数完全一致。
7. **敏感/受限内容发给低价模型。**
   按记忆的 `dataClassification` 走统一出口；`restricted` 直接不发送，case 记 `content_blocked`，规则保持原状态并列入列表。不能为了自动检验绕过分级。
8. **遍历上限导致“所有下游”没找全。**
   用分轮 BFS + `expanded_at`，不静默截断；列表 `complete=false` 时要显示。深度上限只防异常图，不能把上限当正常完成。
9. **merge/supersede 的方向被误解。**
   本方案只沿 `memory_consolidation_changes.memory_id` 找“被影响的记忆”，不把 `related_memory_id` 当下游。若 Andy 认为“保留下来的那条也依赖被丢弃的那条”，需要另加边；这是语义取舍，不是实现细节。
10. **规则来源是派生记忆的边。**
    当前事实说没有，但代码上并非绝对不可能（整理没有显式排除 rule 类）。方案在 BFS 后按 `source_memory_id IN visited` 补标规则；测试用合成数据覆盖。
11. **`suspended` 新状态漏改一个消费者。**
    最容易漏的是 `rule-ref.ts` 的字面量联合、`sqlite-owner-rule-operations.list` 的 SQL、网关 schema、控制中心类型/三语文案、MCP `rule_book` 输出、决策链展示。任何一处漏改都可能让挂起规则仍被执行或从列表消失。
12. **待重审项挂在已删除/重建的记忆 id 上。**
    记忆 id 可能被重新创建（例如规则记忆 key 固定）。读取/操作时必须重新校验归属、revision、正文；不能只凭表里的 id 就归档新记忆。
13. **成本/重试风暴。**
    模型失败会每小时重试，32 条规则可能累积；必须有每日成本上限、最多重试次数、单实例单任务并发限制。达到上限只列出，不挂起。
14. **待确认列表没人看。**
    如果只写表不做 UI，等于没完成“生成一份待确认列表”。网关查询、控制中心页面、三语文案、空状态/失败状态都要一起做。
15. **新增提示词进入 `TRUSTED_PROMPT_TEXTS`。**
    如果新固定文本恰好出现在旧历史里，旧对话的遮盖可能少遮一段，导致请求开头变一次。必须用“旧历史 + 新清单”测试证明字节不变；新文本应是全新长句，避免与旧提示词/常见用户话术重合。

---

## 5. 需要人拍板的取舍

1. **`suspended` 用新状态，还是 `needs_review` + 独立标志？**
   我推荐新状态：执行路径只认一个字段，语义清楚；代价是要改全部状态消费者。
2. **重检用哪个低价模型？**
   推荐复用 `runPolicy.proactive.modelRef`（已经是 Gmail 判断的低价模型），新增用途 `rule-review` 只为成本报表；或者新增 `runPolicy.ruleReview.modelRef`，配置更清楚但要多改配置/部署/检查。**实际部署的 `proactive.modelRef` 是不是 DeepSeek V4.1 Flash，未核实。**
3. **待重审的记忆要不要继续给模型看？**
   我推荐继续看：只标记、不隐藏，避免悄悄改变模型回答和请求内容；如果 Andy 认为“可能错误的推断不应再影响回答”，那要另做注入过滤，会触及请求内容，必须单独出方案。
4. **来源已删除/分类不再是 rule 时，自动挂起还是保持 `needs_review` 照常执行？**
   我推荐自动挂起：来源没了，规则失去依据；但这是“不执行”，需要 Andy 确认。模型失败/输出非法则保持执行。
5. **自动恢复要不要写决策记录？**
   我推荐只写 `rule_book_history` + case；挂起才写决策记录。若要求每次检验都进账本，需要给 `rule_review` 增加 outcome，并重建决策表。
6. **记忆待重审项给不给“建议归档”？**
   我推荐只在上游已删除/已被取代时给 `archive` 建议，其余只列出；不能自动改正文。
7. **合并/取代的 `related_memory_id` 要不要也算下游？**
   我推荐先不算，只沿 `memory_id`；如果业务上认为“保留下来的新说法依赖被丢弃的旧说法”，要补一条边并重新定义依据链。
8. **重检失败的重试上限和每日成本上限。**
   需要 Andy 给一个数；我建议最多 3 次/条、每日调用预算单独记账，超过只列出。
9. **“改成不用了”确认后是否归档来源记忆？**
   我建议只 `retired` 规则，不动记忆正文/状态；来源记忆的去留由主人在记忆页处理。

---

## 6. 已证实 vs 推测/未核实

### 读代码/来源证实的

- 依据表存在、按记忆编号有索引、删除级联删依据行：ADR 0194、迁移 0084/0089。
- `readBasisChain` 只往上游走：`sqlite-memory-consolidation-operations.ts:302-354`。
- 只有 reflect 新建记忆：`consolidation.ts:562/573/618`。
- 规则来源 `source_memory_id`、`needs_review` 照常执行、触发器只从 active 标且不重复：ADR 0211、迁移 0087。
- 规则来源记忆正文是 `quote\nsummary`、分类 `rule`：`production-owner-rules.ts:520-525`。
- 规则参数规范化/校验/表达式生成：`rule-types.ts`、`rule-book.ts`。
- 现有执行路径接受 `active`/`needs_review`：`rule-book.ts:14-16`、`sqlite-proactive-operations.ts:242`。
- 现有 `setStatus` 只接受 `active`/`retired` 且原因受限：`sqlite-owner-rule-operations.ts:171-174`。
- 后台调用固定在前、变化在后：`.claude/rules/prompt-prefix.md:67`。
- 新增提示词要登记、清单会影响遮盖：`prompt-catalog` 测试与 `trusted.ts`。
- 决策记录 `rule_review` 结果值只有 `needs_review`：迁移 0087、`decision-ledger.ts`。
- SQLite 的 `BEFORE` 触发器先于外键动作执行：<https://www.sqlite.org/foreignkeys.html> 第 4.3 节。
- 当前最新迁移是 0089：迁移目录文件列表。
- 高价模型检查规则：`scripts/check-expensive-models.mjs:45-48`。

### 推测/未核实

- **实际部署里 `runPolicy.proactive.modelRef` 是否就是 DeepSeek V4.1 Flash**：未核实；需要看实例配置。
- **整理是否真的会碰 rule 类记忆**：代码没有显式排除，但规则记忆由 `rule_set` 直接写、key 固定；实际是否会被合并/取代未核实。
- **重检提示词在 DeepSeek V4.1 Flash 上的准确率**：ADR 0213 只记录了“立规则”的 15/15，重检场景未跑评测；需要小样本实测。
- **SQLite `ON CONFLICT DO UPDATE` 在触发器中的具体写法**：版本支持大概率没问题，但未在本仓库验证；实现时可用 `INSERT OR IGNORE` + `UPDATE` 两步替代。
- **删除记忆的所有入口是否都会触发 `BEFORE DELETE`**：治理删除、维护、主人删除等行删除会；`DROP TABLE` 隐式删除不会。需要逐个入口测试。
- **数据导出检查对新表的具体要求**：`check-data-export` 目前按 53 条 `[P1-6]` 测试计数，不是按表自动发现；但 schema catalog/导出清单仍要人工确认。
- **界面工作量**：待确认列表、建议值确认、三语文案、失败/截断状态，未评估工时。

---

## 7. 必答问题

### 问题 1：会不会改变模型已经见过的请求开头？

**不会改变对话请求开头。** 具体：

- 不改系统提示文字；不改工具定义；不新增对话工具；不改历史消息的存储/重排/删除；不改遮盖规则或遮盖密钥。
- 待重审状态只存在新表里，不注入记忆文字、不拼进系统提示、不塞进最后一条用户消息。
- 规则状态从 `active` 变 `needs_review`/`suspended` 只影响“规则是否执行/邮件是否处理”，不改变对话请求内容。模型通过 `rule_list`/`rule_book` 工具看到的差异是**新的工具结果**，追加在历史末尾，不是开头。
- 新增的重检模型调用是**独立的后台请求**，不是已有对话请求的一部分。它的固定指令在前，改后的记忆正文在最后；没有任何每轮变化的值进入系统提示或工具定义。
- 唯一需要额外验证的边角：新增提示词会进入 `TRUSTED_PROMPT_TEXTS`，固定文字清单变了。用测试证明旧历史在旧清单和新清单下遮出的字节相同；新提示词是全新长句，不应出现在旧历史里。若测试发现旧历史包含该文本，就必须改用不进入 trusted 清单的独立模块，或调整文本。
- 现有 `npm run check:prompt-prefix` 必须原样通过；它包含“改写历史里的用户消息、系统提示带每轮变化值、关掉冻结”等反向用例，证明如果实现走偏会被拦下。

**结论：发给模型的内容仍然只在末尾追加；每轮会变的值仍然只在最后一条用户消息里（对话场景），重检后台调用的变化值只在它自己的数据段末尾。**

### 问题 2：会不会让同一段文字在不同请求里变成不同的字节？

**对话侧不会。** 对话请求头、历史、遮盖规则都没变；同一段历史在同一个对话里仍按原字节重发。

**重检后台调用也不会，前提是实现时守住以下几点：**

- 固定提示词是常量，不含时间、日期、路径、版本号、随机 id、attempt、case id。
- 数据段只放“改后的记忆正文”，正文按固定格式拼接；不把 SQLite 行对象直接 `JSON.stringify`，而是映射成固定字段顺序的对象。
- 建议参数在存储前先经过 `parseOwnerRuleParameters` 规范化：去重、排序、全半角/大小写折叠；比较和展示都用同一份规范 JSON。
- 列表/遍历按 `memory_id`、`rule_id` 排序，不依赖 `Set`/对象遍历/数据库返回顺序。
- 不把“当前时间”放进提示词；如果将来确实需要，只能放在数据段最后，且只出现在后台请求里。
- 遮盖仍走统一出口；同一正文、同一密钥、同一规则下，遮出的字节相同。

**风险点**：如果为了调试把 `updated_at`、revision、模型调用 id 写进提示词，就会让同一段正文在不同请求里字节不同；本方案明确禁止。

### 问题 3：有没有对应的自动检查？反向用例真的会失败吗？

有，且必须进 `npm run check`。最小集合：

- `packages/persistence-sqlite/test/memory-review-propagation.contract.test.ts`：编辑/取代/删除触发器、`BEFORE DELETE` 抓依据、无关记忆不受影响、同文字再次确认不触发。
- `test/integration/memory-review-propagation.test.ts`：真实 A→B→C 三层链、下游全部 pending、正文/revision 不变；去掉触发器或 BFS 即失败。
- `test/integration/rule-review-recheck.test.ts`：同参数自动恢复、参数变化挂起、`standing=false` 挂起、模型失败保持执行、非法输出不改变状态、陈旧结果被丢弃、按建议值生效时后端二次校验。
- `packages/persistence-sqlite/test/rule-book-status-migration.contract.test.ts`：旧数据保留、`suspended` 可写、非法状态被拒、外键检查为空。
- `packages/application/test/rule-status-enforcement.unit.test.ts`：`ruleIsEnforced('suspended')===false`；实际设置读取/邮件检查路径不返回 suspended；`rule_book`/列表/网关快照接受 suspended。
- `apps/agent-service/test/prompt-catalog...`、`prompt-catalog.unit.test.ts`：新提示词有 manifest 摘要和理由；固定段无时间/哈希；反向用例：改了提示词不更新 manifest 会失败。
- `npm run check:prompt-prefix`：原样通过；另加“旧历史 + 新 trusted 清单遮盖字节不变”的测试。
- `check:expensive-models`：重检模型不是贵模型；`check:product-path-configuration`（若新增配置键）。
- `check:locale`：待确认列表三语文案齐全。
- `check:data-export`/schema catalog：新表要么导出、要么明确排除。
- 完成标准测试：三层链 + 无关记忆 + 规则失败挂起/通过恢复 + 模型失败仍执行；每条都配“删掉实现就失败”的反向验证。

### 问题 4：每个产生/修改的值，使用它的地方都能接受吗？

逐个核对如下：

1. **规则状态 `suspended`**
   - 产生：新的 `ruleReview.resolve`、迁移后的 CHECK。
   - 使用处：
     - `rule_book_rules`/`rule_book_history` 的 CHECK：迁移必须加，否则写入失败。
     - `RuleStatus`（`rule-book.ts:12`）、`RuleBookVersion`（`rule-ref.ts:23`，这里是独立字面量，必须加）。
     - `ruleIsEnforced`（`rule-book.ts:14`）：`suspended` 必须返回 false。
     - `enforceableOwnerRule`（`rule-types.ts:300`）：目前只排除 `retired`，必须同时排除 `suspended`。
     - `sqlite-proactive-operations.ts:242`：已只取 `active`/`needs_review`，suspended 天然不执行；但要加测试确认实际邮件检查路径。
     - `sqlite-owner-rule-operations.ts:86-88`：列表必须包含 `suspended`，否则主人看不到、无法处理；这里要改 SQL。
     - `sqlite-owner-rule-operations.ts:171-174`：`setStatus` 不接受 suspended；新操作走 `ruleReview.resolve`，不要硬塞进旧方法。
     - `production-owner-rules.ts` 的 `reconfirm`/`list`：要决定 `suspended` 时“重新确认”是恢复旧参数还是按建议值；不能只检查 `retired`。
     - 网关契约 `contracts-v2.ts` 的状态枚举、控制中心类型/三语文案、MCP `rule_book` 输出、决策链展示、规则页测试。
   - 结论：**可以接受，但必须全量改**；漏一处就会出现“UI 看不到”或“挂起仍执行”。

2. **决策记录 `kind='rule_review'`、`outcome='needs_review'`、新 `reason_code`**
   - 产生：挂起时写入。
   - 使用处：
     - DB CHECK：`rule_review` + `needs_review` 已允许；`reason_code` 只校验长度 1–64，新值可用。
     - `DecisionLedgerWrite` 的 `inputs`：`memoryIds`/`ruleIds` 数组已有；`subject_ref` 长度 ≤256，ruleId ≤64，安全。
     - 决策列表/UI 的 kind 映射已支持 `rule_review`；新 reason_code 如果不做映射，会显示原始码，但不会写入失败。
   - 结论：**可以接受，不需要重建决策表**。

3. **`rule_review_cases.state` / `proposed_action` / `proposed_params`**
   - 产生：重检服务。
   - 使用处：新持久层、新网关 schema、新 UI、测试。DB 只做 `json_valid`/object 和枚举 CHECK；**语义校验必须在写入建议前和生效前各做一次**，都用 `writableRuleType` + `parseOwnerRuleParameters`。
   - 特别注意 I-73：模型给的 `type` 必须在注册表里且有测试；`params` 必须能通过 `parseMailMatch`（域名/地址/词条长度、不可见字符、至少一项匹配条件、排除词不能全排掉）；`summary` 必须通过 `validRuleSummary`；整组 JSON 长度 ≤16384。列表里存的是“建议”，不是已生效参数；主人点头时再次校验，防止数据库被篡改或模型输出过期。

4. **`memory_review_items` 的 `state`/`reason`/`suggested_action`**
   - 产生：触发器/传播服务。
   - 使用处：新持久层、新网关/UI、测试。DB CHECK 枚举；`memory_id` 允许已删除，所以**读取/操作时必须重新读 `memory_records` 校验归属、状态、revision**，不能凭待重审表直接归档。`suggested_action='archive'` 不是自动执行，必须主人确认。

5. **模型用途 `rule-review`（如果新增）**
   - 产生：重检模型调用。
   - 使用处：`MODEL_USAGE_PURPOSES`、`model_usage_observations.purpose` 的 CHECK、成本报表/导出、`modelUsagePurpose()`。
   - 如果不想改 DB CHECK，就映射到 `other`；代价是成本归因变差。推荐新增并重建该表（无子表，风险小）。

6. **新配置键（如果新增 `runPolicy.ruleReview.modelRef`）**
   - 使用处：`configuration.ts` 类型、配置解析/校验、部署包、`check:product-path-configuration`、`check:expensive-models`、模型目录解析、服务装配、测试 fixture。
   - 如果复用 `runPolicy.proactive.modelRef`，这些全部不用改；但预算/超时也被邮件检查共享，需要明确。

7. **新网关查询/命令名**
   - `memory.review.read` / `memory.review.snapshot` / `memory.review.respond` 要加进契约枚举、schema、fixture、控制中心客户端、i18n、测试；否则前端调用会被契约拒绝。

8. **迁移号/表清单**
   - `0090` 必须连续；schema catalog/导出清单/管理 schema 范围测试要同步；迁移快照和不可逆说明要写进 ADR。

---

## 8. 一句话总结

**触发器只负责“同事务保命 + 抓删除前的第一跳”，后台 BFS 负责“完整下游”，低价模型只负责“重新翻译”，程序负责“校验、比较、挂起/恢复”，主人只在建议值和不明确时点头。记忆正文和对话请求头都不动。**
