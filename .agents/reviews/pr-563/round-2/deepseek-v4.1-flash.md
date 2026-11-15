**本轮范围**

只核对了 `268e6309..6881cc9` 的增量，并沿证据跟到旧代码：`make-packet.py`、`maintenance-common.mjs`、`read-s0-db.mjs`、`run-maintenance.mjs`、`S7-switch-start-readback.py`、`verify-migrate-fixtures.mjs`、`verify-sidecar-tidy-fixtures.mjs`、`verify-fixtures.mjs`、`test_make_packet.py`、`20261115045512_thread_origin.sql`、`steps/README.md`、ADR 0086。未运行测试、未联网、未读生产 S0，因此“生产当前 schema 低于目标 schema”按材料说明作为前提。

### 1. [高] 真实包含 `thread_origin` 的操作包会让 `verify-fixtures.mjs` 必然失败，并且与 `verify-migrate-fixtures.mjs` 的要求互相矛盾

文件：`scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:31`（还有 `:258`）、`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:788-789`、`scripts/delivery-mode/packet-template/maintenance/verify-migrate-fixtures.mjs:142`、`scripts/delivery-mode/run-packet-checks.py:213,229`

问题：这次出包时 `migrationExpectedLedger` 含 `thread_origin`，于是 `historyIgnoredColumns` 是 `{ threads: ["origin"] }`，不是空对象。夹具第 31 行却断言它是空对象；第 258 行还指望默认的 `historyRows()`（即 `compareHistoryRows(reference, current, historyIgnoredColumns)`）在加出 `origin` 列时报 `HISTORY_COLUMNS_CHANGED`。在真实包里这两条都会失败。若反过来把操作包的 `historyIgnoredColumns` 改成空，`verify-migrate-fixtures.mjs` 的 M1 又会失败，因为它要求迁移前后 `history` 分区相等，而迁移前没有 `origin` 列、迁移后有；现在正是靠忽略 `origin` 才相等。也就是说：同一个包里两个夹具的要求不能同时满足。

证据：

```js
// verify-fixtures.mjs:31
assert.deepEqual(historyIgnoredColumns, {}, "HISTORY_FIXTURE_LEDGER_HAS_NO_IGNORED_COLUMNS");
// verify-fixtures.mjs:258
throwsCode(historyRows, "__PKT_LABEL_UPPER___MAINTENANCE_HISTORY_COLUMNS_CHANGED:threads", "origin added by a release that does not apply thread_origin");
```

```js
// maintenance-common.mjs:788-789
export const historyIgnoredColumnsFor = (ledger) => Object.freeze(Object.assign({}, ...ledger.map((row) => addedColumnBackfills[row.name] ?? {})));
export const historyIgnoredColumns = historyIgnoredColumnsFor(migrationExpectedLedger);
```

```js
// verify-migrate-fixtures.mjs:142
for (const section of common.migrationComparedSections) assert.deepEqual(after[section], before[section], `MIGRATE_FIXTURE_M1_SECTION_CHANGED:${section}`);
```

`migrationExpectedLedger` 的名称来自 `make-packet.py:255-256` 的文件名解析（`by_id[identifier][1]`），而时间戳迁移的名字在 `migration-engine.ts:1363` 也是文件名里的 `thread_origin`，所以真实包中这个忽略项确实会被激活。

建议：不要断言 `historyIgnoredColumns` 为空；改为按本包 ledger 推导期望值，并在“这个迁移不属于本包”的反向用例里显式传 `{}` 给 `compareHistoryRows`。同时加一个真正渲染出含 `thread_origin` ledger 的包、再跑 `verify-fixtures.mjs` 和 `verify-migrate-fixtures.mjs` 的测试；现有 `test_make_packet` 没有覆盖这种真实 ledger（`test_carried_copies` 虽然用 `COMMIT=head`，但参数仍是 `TWELFTH`，ledger 为空）。

### 2. [中] 操作员文档和 ADR 仍把例外写成唯一的旧版本，上一轮第 4 条没有完全改好

文件：`scripts/delivery-mode/packet-template/steps/README.md:77`、`docs/adr/0086-generate-release-packets-from-parameters.md:51`

问题：`P-readback-design.md:42` 已改成两处例外，但 `steps/README.md` 的 S8 行仍写“只有 `sandbox_execution_records.recovery_json` 允许被启动恢复改写”；ADR 0086 仍写“迁移改历史表时唯一的例外是 `0083_model_invocation_owner_lost.sql`”。代码里现在已经有第二种放行：`ADDED_COLUMN_BACKFILLS` 对 `thread_origin` 加列并回填，以及 S8 忽略 `threads.origin`。这两份都是操作/设计依据，和代码不一致会误导下一次出包和现场判断。

证据：

```
| `S8_READBACK` | ...和 S3 保存的数据库副本逐行比较，已有行不能删改（只有 `sandbox_execution_records.recovery_json` 允许被启动恢复改写），允许新行；...
```

```
迁移文件如果改写这些要保留的表（例如给历史表加列），出包时就拒绝（`PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES`）...唯一的例外是 `0083_model_invocation_owner_lost.sql`...
```

建议：把 `steps/README.md` 的 S8 说明补上“本包待补 `thread_origin` 时 `threads.origin` 不比”；把 ADR 0086 第 3 条补上 `ADDED_COLUMN_BACKFILLS` 及其摘要绑定、表/列登记两个条件，并说明它与 `ROW_PRESERVING_REBUILDS` 并列。

### 3. [低] “只有迁移待补时才忽略”的测试名和 scope 与实现不一致

文件：`scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:30`、`:656`

问题：实现是按“这个包的 `migrationExpectedLedger` 里有没有 `thread_origin`”来决定忽略，模块加载时算一次。迁移在 S7 应用后，S8/S9 仍然忽略 `origin`；并不是“迁移应用后就不再忽略”。测试名 `HISTORY_ORIGIN_COMPARED_ONCE_ITS_MIGRATION_IS_APPLIED` 和输出 scope 里的 “threads.origin skipped only while thread_origin is pending” 都说得比实际更强。

证据：

```js
assert.deepEqual(historyIgnoredColumnsFor([{ sequence: 97, name: "other" }]), {}, "HISTORY_ORIGIN_COMPARED_ONCE_ITS_MIGRATION_IS_APPLIED");
...
scope: "... threads.origin skipped only while thread_origin is pending ..."
```

建议：把措辞改成“只在本包的待补迁移清单里含 `thread_origin` 时忽略”；如果确实想只在迁移尚未应用时忽略，需要按实际 ledger 状态分级传入忽略表，而不是一个模块级常量。

### 4. [低] 新增的按名解析和合并逻辑对未来多迁移/多列只有隐式约束

文件：`scripts/delivery-mode/make-packet.py:195`、`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:788`

问题：`TIMESTAMP_MIGRATION.fullmatch(file_name).group(2)` 没有空值保护；当前 `ADDED_COLUMN_BACKFILLS` 只有时间戳文件所以不会触发，但以后若加入一个旧式文件名，出包会以 Python `AttributeError` 崩溃，而不是可控的 `PACKET_*` 拒绝。`historyIgnoredColumnsFor` 用 `Object.assign` 合并，同名表的多条回填后写会覆盖前写，而不是合并列数组；当前只有一个条目，所以未触发。

建议：对 `fullmatch` 结果做检查并 `refuse('PACKET_ADDED_COLUMN_BACKFILL_NAME_INVALID', ...)`；合并时按表合并数组并去重。

**作者说法核对**

- “`read-s0-db.mjs` 新增 `historyIgnoredColumns` 和 `historyRow`，出包时要求它登记了 `origin`”已不成立：增量的 `historyRow` 仍在 `read-s0-db.mjs`，但登记表已移到 `maintenance-common.mjs` 的 `addedColumnBackfills`，`make-packet.py:200-204` 也是从 `maintenance-common.mjs` 解析。以代码为准，这一移动本身没有引入新的不一致，但说明文字需要同步。
- “`historyDigests` 与 `compareHistoryRows` 比对前去掉这一列”已核实：`read-s0-db.mjs:72`、`maintenance-common.mjs:740,968-975`。
- “不改 `deploy.sh`”已核实：本轮 diff 没有 `deploy.sh`。
- 上一轮第 1 条“`threads.origin` 被所有历史闸门永久忽略”已改好：现在由 `migrationExpectedLedger` 决定，后续不补该迁移的包会恢复比较 `origin`。但同一发布包内的 S8/S9 仍然忽略它，见第 3 条。

**读代码证实的**

- `compareHistoryRows` 现在把 live 迭代包成生成器，但 `finally { live.return(); }` 存在（`maintenance-common.mjs:993-995`），提前退出或抛错时会关闭生成器，并触发 `for...of` 对底层 SQLite 迭代器调用 `return()`；reference 的原生 `for...of` 在异常时也会关闭自己的迭代器。这个担心不成立。
- S3 前后、S7 迁移前后、S8 对照恢复点，做比较的两边都经过 `historyDigests(..., historyIgnoredColumns)` 或 `compareHistoryRows(..., historyIgnoredColumns)`。S0 的单次 `productionS0()` 调用（`read-s0-db.mjs:196`）没有传忽略表，但它的 history 没有参与任何前后比较，`finalize-bindings.py:154` 只校验形状。
- 回填 `UPDATE threads SET origin=...` 不会改变行数，`history` 分区又忽略 `origin`，`schema/ledger/capabilities/authorization/releaseReceipts/integrity/foreignKeys` 不受影响，所以不会被 `migrationComparedSections` 或行数检查拦下。迁移 SQL 由 `make-packet.py:188` 的 SHA-256 绑定，文本一改就退回 `PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES`。
- 除历史比较外，没有别的地方逐行比较 `threads`。`hermes-native-history-import*` 和资格脚本只 `SELECT message_watermark,revision FROM threads`，不是历史闸门。
- 新值的使用端已逐个核对：`historyRow` 三个调用点、`historyDigests` 五个调用点、`readS0State` 三处、`compareHistoryRows` 三处都接受新参数；`ignoredHistoryColumns` 只写入 S8 证据，没有发现严格 JSON 校验器；`ADDED_COLUMN_BACKFILLS` 与 `addedColumnBackfills` 的名称/表/列两端一致。唯一不能接受的是 `verify-fixtures` 的“空忽略表”假设，见第 1 条。
- 文档不一致：`steps/README.md:77`、ADR 0086:51 仍写旧例外；`P-readback-design.md:42` 已更新。

**推测/未核实**

- 没有运行 `test_make_packet`，所以 `ADDED_COLUMN_BACKFILLS` 里的 SHA-256 是否与当前迁移文件逐字节一致未核实；若不一致，Python 测试会失败，出包也会拒绝，属于安全失败。
- 生产当前 schema 的具体数值未核实；第 1 条的高严重度依赖“这次确实要补 `thread_origin`”这个材料前提。如果出包时生产已经到目标 schema，`MIGRATION_LEDGER` 为空，第 1 条不会显现，但本 PR 的放行逻辑也没有被真实执行。
- `better-sqlite3` 迭代器的 `return()` 实现未实际执行验证，结论基于标准迭代器/生成器语义。

**侧重检查**

- 错误路径：摘要不匹配、登记缺失、模板解析失败都会 `refuse`，属于 fail closed；发现的缺口是真实 ledger 下夹具断言先失败，以及未来非时间戳键可能抛 `AttributeError`。
- 不可信/不合规输入：迁移文本由 SHA-256 固定，忽略表是代码常量，不是外部输入；没有新增外部输入解析路径。
- 安全：`origin` 是可见性标记，本次只在一个发布窗口忽略它；生产服务停服、S3 原始恢复点和迁移前快照都在。没有发现凭据或模型文本泄漏；S8 新字段只写列名。
- 资源耗尽：回填 `UPDATE` 会扫一次 `threads` 并做 `EXISTS`，没有新增无界循环；行迭代器有关闭路径。
- 不可撤销操作：迁移加列/回填不可逆，但 S3 原始副本、迁移前快照和回滚路径仍在，没有发现新的不可恢复点。
- 规则/文档/代码一致性：见第 2、3 条。

**必答问题**

1. **不涉及模型请求。** 本增量只改部署/维护脚本和文档，没有碰系统提示、工具定义、历史消息、遮盖结果；发给模型的内容仍然只在末尾追加，每轮变化的值仍只在最后一条消息。本轮变化的值（`checkedAt`、历史摘要、`ignoredHistoryColumns`）只进部署证据 JSON，不发给模型。
2. **不会让模型可见的同一段文字在不同请求里变成不同字节。** 没有任何依赖前后文的遮盖或提示拼接改动。部署证据里的历史摘要确实会随数据库内容变化，时间戳也仍然存在，但那是部署证据，不是模型输入。
3. **有自动检查，但真实 ledger 场景没有被覆盖，且新增反向用例在真实包里会失效。** `test_make_packet.py` 覆盖了摘要绑定、错文件名、错表、登记解析；`verify-fixtures.mjs` 覆盖了忽略/默认保留、列变更、正文变更；`verify-migrate-fixtures.mjs` 会跑真实迁移。问题是这些检查没有用含 `thread_origin` 的 ledger 渲染过包，而且第 1 条的两个夹具要求互相矛盾。Python 侧“SQL 被改/错表/错文件返回 `[]` 从而拒绝”是有效的反向用例；但“登记表缺失”没有直接反向单测。
4. **逐项核对结果：** `historyRow`/`historyDigests`/`readS0State`/`compareHistoryRows` 的新参数都被现有调用点接受；`addedColumnBackfills` 与 `history_ignored_columns()` 的名称、表、列两端一致；`ignoredHistoryColumns` 只写 S8 证据，没有发现拒绝它的校验器；`productionS0` 未传忽略表，但其 history 不参与比较。唯一不接受的一端是 `verify-fixtures.mjs:31/258` 的默认假设；另外 `steps/README.md` 和 ADR 0086 仍是旧的单例外说法。
