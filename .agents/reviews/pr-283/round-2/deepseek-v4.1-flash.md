## 侧重检查

我按「错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档与代码一致性」逐项看了增量：

- **不可信输入/注入**：`gmail_message_id` 在 `apps/agent-service/src/production-muse-intake.ts:67` 用 `^[A-Za-z0-9_-]{1,256}$` 限制，SQLite 写入全部走参数绑定（`sqlite-muse-intake-operations.ts:284-297`），没有拼接；未发现注入路径。结论：可接受。
- **超长/空串/空格**：解析层（`production-muse-intake.ts:233-239`）、存储接口（`sqlite-muse-intake-operations.ts:41-45`）、数据库 CHECK（`0079_muse_intake_gmail_message.sql:1-5`）三处规则一致；测试也放了空串/257/空格反例。结论：一致（未执行测试，只读代码）。
- **资源耗尽**：批次上限 100 条、请求体 256 KB 未改；`fillGmailMessage` 命中 `muse_intake_items` 的 `(owner,agent,kind,natural_key)` 唯一约束，`fillPairedMessage` 命中 `muse_reference_entries_intake_key_index`（`0069_decision_ledger.sql:151-152`），没有全表扫描。结论：可接受。
- **不可撤销操作**：`fill*` 只更新 `IS NULL` 的列，不覆盖已有编号；但迁移 0079 是**在原文件上改约束**，已应用旧 0079 的库会被迁移引擎判为摘要不符。见下面低危条目。
- **文档与代码一致性**：ADR 0162 第 8 条写「编号不进内容摘要……按重复处理」，代码并未做到。见高危条目。
- **错误路径**：重复条目补编号的路径实际上走不到（详见高危条目）；非法可选编号会让整条提醒被拒（低危条目）。
- **遮盖/模型请求**：本增量不涉及出口遮盖或提示词组装；未发现 muse/calibration 数据进入 prompt 组装。结论：不改变请求开头。

---

## 结论（按严重度）

### 高：`gmail_message_id` 仍通过 `sources` 进入 `contentDigest`，导致「重发补编号」在生产路径不可达

- 文件:行：`apps/agent-service/src/production-muse-intake.ts:233-239`、`264-278`、`299`；`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:281-298`
- 问题：增量只从 `parts` 里删掉了 `gmailMessageId` 的**值**，但 `text()` 仍把 `gmail_message_id` 记进 `reader.sources`，而 `parts` 又包含 `sources`。因此「首发不带编号、重发带编号」两次摘要不同，store 走 `conflict` 而不是 `duplicate`，补编号和补 `paired_message_id` 都不会执行。更严格地说：任何存储行若 `gmail_message_id IS NULL`，其摘要必然不含 `gmail_message_id` 这个 source（因为只要 record 了 source 就一定有值），而带编号的重发摘要必然含它；所以 `filled.changes === 1` 在生产 HTTP 路径上不可达。
- 证据（亲自读到）：
  ```ts
  const gmailMessageId = text(
    reader, "gmail_message_id", "gmail_message_id", GMAIL_ID_PATTERN, 256,
  );
  ```
  `text()` 内部会 `reader.record(column, field)`；`ItemReader.record` 为 `this.sources[column] = field.source;`（`production-muse-intake.ts:137-139`）。随后：
  ```ts
  const parts = {
    ...,
    options: offered as readonly string[],
    sources: reader.sources,
    editionId: ...,
  };
  ...
  contentDigest: digestOf("proactive", parts, safe(title), safe(body)),
  ```
  store 端：
  ```ts
  if (stored?.digest === item.contentDigest) {
    duplicate += 1;
    if (item.gmailMessageId !== null) {
      const filled = fillGmailMessage.run(...);
      if (filled.changes === 1) fillPairedMessage.run(...);
    }
  } else { conflict += 1; ... }
  ```
  与 ADR 0162 第 8 条「编号不进内容摘要……按“重复”处理」直接矛盾。
- 建议：计算摘要时排除 `gmail_message_id` 的 source（用过滤掉该键的 sources 副本，或先算 digest 再 `record` gmail），并补一条真正经过 `parseMuseBatch` 的端到端用例。

### 中：「store 测试覆盖」是假覆盖，关键反向用例不会失败

- 文件:行：`test/integration/muse-intake-store.test.ts:52`、`340-371`；`apps/agent-service/test/production-muse-intake.unit.test.ts:108-115`
- 问题：补编号测试直接把 `contentDigest` 手填成 ``digest-${naturalKey}``，完全绕过 `parseProactive`；单元测试只验证「文本变摘要变」，没有任何 `gmail_message_id` 相关断言。即使把 gmail 值重新放回摘要、或保留上面的 `sources` 缺陷，这些测试仍全部通过，不能作为反向用例。
- 证据：
  ```ts
  contentDigest: `digest-${naturalKey}`,
  ```
  ```ts
  expect(digest("a")).toBe(digest("a"));
  expect(digest("a")).not.toBe(digest("b"));
  ```
- 建议：增加「经 HTTP/解析层、同一自然键先无编号后带编号」的用例，断言 `duplicate=1`、`conflict=0`、`gmailMessageId` 被补上、已评价条目 `pairedMessageId` 被补上；再加一条 `digest(无编号) === digest(有编号)`。

### 低：编号写错时仍可能静默配到另一封真实邮件，「不会错配到别的邮件以外」说法过强

- 文件:行：`packages/calibration/src/index.ts:291-309`；`docs/adr/0162-receive-muse-data-through-a-service-token-and-an-app-secret.md:46`
- 问题：配对只按字符串查 `proactive_processed_messages.message_id`。若 Muse 发来的错误编号恰好等于另一封 Himawari 处理过的邮件编号，周报会把两条不同邮件配在一起并分错桶；已有编号又永不覆盖，没有纠正入口。作者已把「无纠正入口」列给 Andy，但「不会错配到别的邮件以外」这句话不成立。
- 证据：
  ```ts
  const judgment = mailJudgments.get(messageId);
  if (judgment === undefined) { buckets.noHimawariRecord += 1; continue; }
  ```
- 建议：把风险描述改成「错误编号若命中另一封真实邮件会静默配错」；可考虑在周报里标出「配对编号在 Himawari 记录中找不到」的条目，或提供人工重配入口。（此条依赖 Muse 发错数据，业务上按可信处理，故列低。）

### 低：迁移 0079 文件被原地修改，已应用旧版本的库会启动失败

- 文件:行：`packages/persistence-sqlite/src/migrations/0079_muse_intake_gmail_message.sql:1-5`；`packages/persistence-sqlite/src/migration-engine.ts:761-774`
- 问题：`cd2b1e3d` 已引入 0079（只查长度），本次把同一文件改成 GLOB 检查。迁移引擎会比对已应用记录的 digest；任何跑过旧 0079 的持久库（本地/预发）升级后会抛 `SQLITE_MIGRATION_DIGEST_MISMATCH`。
- 证据：
  ```ts
  definition.name !== record.name ||
  definition.phase !== record.phase ||
  definition.digest !== record.digest
  ```
- 建议：如果确认 79 从未在持久环境应用，保持现状并在 PR 说明；否则新增 0080 来加/换约束。

### 低：可选编号格式非法会让整条提醒被拒，而非只丢弃编号

- 文件:行：`apps/agent-service/src/production-muse-intake.ts:240-262`；`test/integration/muse-intake-http.test.ts:318-325`
- 问题：`gmail_message_id` 是可选配对提示，但一旦格式非法/超长，整个 item 被判 invalid（`accepted: 0`），提醒正文和评价都丢失。ADR 只说「没带编号的条目照收」，未说「带坏编号的整条拒收」。
- 建议：明确这是 fail-closed 的设计并写进 ADR/运行手册；若希望不丢提醒，可只丢弃该字段并计入 `droppedFieldCount`，条目按未配对保存。

### 低：字符规则重复三处，且「只限提醒条目」只在 HTTP 边界成立

- 文件:行：`apps/agent-service/src/production-muse-intake.ts:67`、`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:41`、`0079_muse_intake_gmail_message.sql:4`
- 问题：正则/GLOB 三份拷贝当前一致，但后续容易漂移；另外 `MuseIntakeItemWrite` 和 DB 并不拒绝 scheduled 条目带编号，只有解析器的 `SCHEDULED_KEYS` 会丢弃。ADR 0162 的「定时运行条目带了会作为多余字段丢弃」仅在 HTTP 入口成立。
- 建议：把字符集/长度抽成共享常量（迁移无法共享则至少在注释里对齐），并在存储层也校验 `kind === "proactive"` 才能带编号，或明确接受该边界。

---

## 读代码证实的 vs 推测

- **读代码证实**：高危条目（sources 进摘要、补编号不可达）、中危条目（测试手填 digest）、迁移原地修改的 digest 比对逻辑、字符规则三处一致、`fill*` 只更新 NULL、索引覆盖、非法编号导致整条 item 被拒。
- **推测/条件性**：低危的「已应用旧 0079 的库」取决于是否有持久环境跑过 `cd2b1e3d`；「错编号命中另一封真实邮件」取决于 Muse 实际发来错误数据，代码路径本身已证实；我没有运行任何测试（工具限制），测试是否真绿是静态推断。

---

## 必答问题

1. **不会改变模型已见过的请求开头。** 本增量只改 Muse 入库、SQLite 迁移、文档和测试；未改系统提示、工具定义、历史消息或遮盖。`prompt-catalog` 与 `context-formation-service` 中未发现 muse/calibration 引用。发给模型的内容仍是「只在末尾追加」，本轮变化的 `gmail_message_id` 不进入模型请求，也不存在把每轮变化值塞到系统提示/历史里的情况。此结论针对本增量；未运行 `check:prompt-prefix`。

2. **对模型请求不会造成同文不同字节**（未触及遮盖、时间字段、集合顺序）。但**内部 `contentDigest` 会**：同一自然键「带/不带 `gmail_message_id`」的请求摘要不同（`sources` 多了键），这正是高危条目；`sources` 键的插入顺序本身是固定的（解析顺序固定），不是无序问题。

3. **字符限制有反向用例，但核心摘要/补编号行为没有有效反向用例。** 现有反例（HTTP 超长/非法字符、store `"a b"`、迁移空串/257/空格）在代码上确实会让反向失败；而「gmail 不进摘要、重发补编号」的测试手填了 `contentDigest`，把缺陷放回去测试仍然全绿。未执行测试，结论来自代码阅读。

4. **逐项核对产生端与使用端：**
   - 解析端 `gmail_message_id`：`[A-Za-z0-9_-]{1,256}` → 存储端 `itemProblem` 同规则 → DB CHECK 同规则，**接受**。
   - 自动写入 `muse_reference_entries.paired_message_id`：该列 CHECK 仅 `length 1..256`，Gmail 编号是其子集，**接受**；手工 `recordMuse` 仍允许更宽字符，属既有接口。
   - 消费端周报：`paired_message_id` 直接查 `proactive_processed_messages.message_id`（`length 1..256`，无字符限制），**接受**。
   - `listItems` 新增返回 `gmailMessageId`，控制中心未使用，**接受**。
   - 迁移序列 79：`migration-engine.contract`、`model-budget`、`run-checkpoint`、`workspace-lifecycle-audit` 的 78→79 断言已在基础提交更新，**一致**。
   - **不一致处**：存储层/DB 未强制「只有 proactive 能带编号」，与文档「只限提醒条目」仅在 HTTP 边界一致（低危）。
