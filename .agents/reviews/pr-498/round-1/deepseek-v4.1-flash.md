## 总体结论

没有发现会改变模型请求、或会在正常运行时丢失数据的改动。迁移对新表种子与代码常量一致，`decision_ledger` 的约束语义基本忠实保留。主要问题集中在“外键关闭”兜底路径的守卫不完整，以及作者说明与代码不一致。

## 读代码证实的意见

### 1. 中：删除“被结果表引用的种类”不会被拦截，外键关闭时会留下孤儿结果行

文件：`packages/persistence-sqlite/src/migrations/20261114110331_decision_ledger_reference_tables.sql:375-381`

问题：`decision_ledger_kinds_in_use_no_delete` 只检查 `decision_ledger` 是否引用该种类，没有检查 `decision_ledger_outcomes`。而 `decision_ledger_outcomes.kind` 正引用种类表（同文件 `:5-7`）。外键关闭时，只要某个种类还没有账本行、但已有结果行（新库中所有非 proactive 种类都是这个状态），删除该种类就会成功并留下孤儿结果；随后 `foreign_key_check` 不再为空，违反作者自己列出的“必须为空”约束。

证据：

```sql
CREATE TABLE decision_ledger_outcomes (
  kind TEXT NOT NULL REFERENCES decision_ledger_kinds(kind),
  outcome TEXT NOT NULL CHECK (length(outcome) BETWEEN 1 AND 64),
```

```sql
CREATE TRIGGER decision_ledger_kinds_in_use_no_delete BEFORE DELETE ON decision_ledger_kinds
WHEN EXISTS (SELECT 1 FROM decision_ledger WHERE kind = OLD.kind)
BEGIN SELECT RAISE(ABORT, 'DECISION_LEDGER_KIND_IN_USE'); END;
```

测试只覆盖了“账本行在用”的删除（`decision-ledger-reference-tables.contract.test.ts:249-251`），没有覆盖“只有结果行在用”的删除。

建议：在 `WHEN` 中增加 `OR EXISTS (SELECT 1 FROM decision_ledger_outcomes WHERE kind = OLD.kind)`；或让 `decision_ledger_outcomes.kind` 带 `ON DELETE RESTRICT/CASCADE` 并明确依赖外键。补一条外键关闭时删除“只有结果行引用的种类”的反向用例。

### 2. 低：参照表没有 UPDATE 守卫，外键关闭时改名会静默改坏已有账本行

文件：`packages/persistence-sqlite/src/migrations/20261114110331_decision_ledger_reference_tables.sql:366-381`

问题：文件里唯一的 UPDATE 触发器是 `decision_ledger_known_kind_update`，它挂在 `decision_ledger` 上；两张参照表只有 DELETE 守卫。外键关闭时，`UPDATE decision_ledger_kinds SET kind='x'` 或 `UPDATE decision_ledger_outcomes SET kind/outcome=...` 不会触发任何 ABORT，已有账本行会继续指向旧值，之后 `foreign_key_check` 才会发现。这和本 PR 用触发器兜底外键关闭场景的理由一致，但兜底只做了一半。

证据：

```sql
CREATE TRIGGER decision_ledger_known_kind_update BEFORE UPDATE OF kind, outcome ON decision_ledger
...
CREATE TRIGGER decision_ledger_kinds_in_use_no_delete BEFORE DELETE ON decision_ledger_kinds
...
CREATE TRIGGER decision_ledger_outcomes_in_use_no_delete BEFORE DELETE ON decision_ledger_outcomes
```

建议：给两张参照表增加 `BEFORE UPDATE` 守卫（或明确把参照表定义为只可追加、禁止 UPDATE），并补外键关闭时更新被引用行的反向用例。

### 3. 低：作者说明与代码不一致，容易误导后续维护者

文件：`packages/persistence-sqlite/src/migration-engine.ts:1213-1218`、`packages/persistence-sqlite/src/sqlite-worker.ts:120`、`packages/persistence-sqlite/test/rule-memory-review.contract.test.ts:44`

问题一：材料说“SQLite 外键默认每个连接关闭”，据此论证需要触发器兜底。但产品的连接入口明确打开外键，迁移也在这条连接上执行，所以生产路径上外键一直开启，触发器只是非产品连接/测试里的兜底。

证据：

```ts
export function openQualifiedDatabase(databasePath: string): SqliteDatabase {
  const database = new BetterSqlite3(path.resolve(databasePath));
  database.pragma("foreign_keys = ON");
```

```ts
database.pragma("foreign_keys = ON");
```

```ts
const applyOne = database.transaction(() => {
  ensureLedgerIdColumn(database);
  database.exec(migration.sql);
```

问题二：材料说“两份旧测试……错误信息改为触发器的错误码”。实际只有 `memory-capture-backlog-migration.contract.test.ts` 改了错误断言（`:185-187`）；`rule-memory-review.contract.test.ts` 只加了触发器名称过滤（`:44`），没有错误码改动。

建议：把说明改为“产品连接外键开启，触发器用于外键关闭的连接”，并更正旧测试改动范围的描述。这不影响运行，但会影响后来人判断哪道防线才是主防线。

## 推测 / 未核实

- 作者称“139 条测试、lint、typecheck、两道迁移检查通过”：本次只读了代码，未运行任何测试或检查，未核实。
- “生产库现有行全部能通过新外键”：从旧 CHECK 的取值集合推算，现有数据只可能是这 8 种 kind 和 25 种 outcome 的组合，因此迁移应当成功；但没有真实生产数据可验证，未核实。
- 重建时 `INSERT ... SELECT` 未写 `ORDER BY`，理论上 rowid 顺序不保证；`appendIfChanged` 使用 `ORDER BY rowid DESC`（`sqlite-decision-ledger-operations.ts:375-378`）。实际 SQLite 对 keep 表的简单扫描通常保持原顺序，且 0095 已经这样做过，风险很低，但未实测。

## 侧重检查

- 错误路径：未知 kind/outcome 的 INSERT/UPDATE 由 `decision_ledger_known_kind_insert/update` 和复合外键拦截（`:357-373`、`:108`）；proactive 的 NULL outcome 由 `CHECK ((kind='proactive') = (outcome IS NULL))` 允许（`:107`），非 proactive 的 NULL outcome 被同一条 CHECK 拒绝。结论：写入路径覆盖完整。
- 不合规范/不可信输入：数据导入的 `DECISION_SCHEMA` 允许任意 `outcome` 字符串（`data-export/schemas.ts:282`），但导入仍会经过新触发器/外键和 `:107` 的 CHECK；且导入要求源/目标迁移序列完全相等（`data-export/verify.ts:302-306`），不会把新种类的数据导入旧参照表。结论：没有发现新的绕过路径。
- 安全：参照表只含枚举字符串，不含用户数据；未引入密钥、时间或随机字段。
- 资源耗尽：迁移临时复制 8 张表，存在短时双份存储和写锁；与 0095 已有模式相同，不属于本改动新增的特殊风险。
- 不可撤销操作：迁移是前进式、无回滚；已有库升级由引擎强制要求同机快照（`migration-engine.ts:1114`），与仓库现有约定一致。
- 规则/文档一致：ADR 0265 描述的参照表结构与本次迁移一致；`schema-catalog` 的两条新增与迁移引擎的“全表一致”测试相符；`check:audit-schema-range` 不受影响，因为新迁移没有碰 `AUDIT_READ_TABLES` 里的 16 张表（`workspace-lifecycle-audit.mjs:6-23`）。不一致处见意见 3。
- 触发器漏写入路径：INSERT/UPDATE 账本行、outcome 为 NULL、外键关闭均已覆盖；DELETE 参照行的守卫有意见 1 的缺口；UPDATE 参照行没有守卫，见意见 2。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会。改动只涉及数据库迁移、`schema-catalog.ts` 和测试，没有触碰系统提示、工具定义、历史消息或遮盖代码。因此仍然只在末尾追加，每轮变化的值仍只应在最后一条消息里；`decision_ledger` 本身不参与模型请求。依据 `.claude/rules/prompt-prefix.md` 第 4 条（`append-only`）。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。新迁移的种子是固定字面量和固定顺序，没有 `randomblob`、`now`、`strftime` 等每轮变化的值；两张参照表也不被序列化进模型内容。重建过程没有改变任何提示词或历史文本。

**3. 有没有对应的自动检查，反向用例真的会失败？** 有：新契约测试覆盖“行不丢”“种子等于代码常量”“外键开关下拒绝未知 kind/outcome”“新增种类/结果后可用”“在用种类/结果不可删”；旧测试也做了相应调整。反向用例中，外键关闭时未知 kind/outcome 的 INSERT/UPDATE 确实依赖新触发器，去掉触发器会失败；但“删除只被结果行引用的种类”和“UPDATE 参照表行”没有反向用例，见意见 1、2。另外，新测试的 `TABLES` 列表没有包含 `decision_prereviews`，不过 `correction-propagation-migration.contract.test.ts:496-515` 已覆盖预评行跨迁移保留。旧测试用 `name NOT LIKE 'decision_ledger_known_kind%'` 排除了新触发器（`memory-capture-backlog...:45`、`rule-memory-review...:44`），这削弱了它们的 schema 快照断言，但行为断言仍覆盖新触发器。

**4. 每个新值的使用方都能接受吗？** 逐项核对如下：
- 表名 `decision_ledger_kinds`、`decision_ledger_outcomes`：已加入 `schema-catalog.ts:883-896`，`migration-engine.contract.test.ts:75-80` 会比对“库里所有表 = 目录所有表”，两端一致。
- 种子 kind/outcome：与 `decision-ledger.ts:32-70` 的 `DECISION_KINDS`/`DECISION_OUTCOMES` 完全一致，新契约测试 `:185-199` 断言相等；0095 触发器写入的 `rule_review/needs_review`（`0095_correction_propagation.sql:557、620`）和 proactive 写入的 `proactive`/NULL（`sqlite-proactive-operations.ts:739`）都在种子里。
- 账本写入校验：`validateLedgerWrite` 仍用同一组常量（`sqlite-decision-ledger-operations.ts:54-61`），未发现使用方与种子不一致。
- 触发器错误码：`DECISION_LEDGER_UNKNOWN_KIND_OR_OUTCOME`、`..._KIND_IN_USE`、`..._OUTCOME_IN_USE` 都被新测试按字符串断言。
- `.meta.json` 的 `alters`/`removes`：按 `scripts/migration-conflicts/analyze.mjs:211-246` 的逻辑，`decision_ledger` 的旧字面量都被 `removes` 覆盖（多列了 `proactive`、`memory_candidate`，但多列不会被判错）。
- 数据导入：`DECISION_SCHEMA` 仍允许任意 outcome 字符串，但目标库的 CHECK/触发器/外键会再校验，没有发现新值被导入端错误接受。
- 审计脚本：新迁移不碰 `AUDIT_READ_TABLES` 的表，不需要登记 `AUDIT_REVIEWED_MIGRATIONS`。

除意见 1、2 指出的参照表守卫缺口外，没有找到“产生端能写出、使用端不接受”的值。
