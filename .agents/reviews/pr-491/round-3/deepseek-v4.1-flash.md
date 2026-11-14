## 一、读代码证实的问题

### 1. 严重度：高（生产/新装数据可能不一致，打包硬门槛会放过）
`scripts/migration-conflicts/analyze.mjs:118-124`、`:301-334`

`writtenTables` 只在“after 里出现了 before 没有的行”时把表算作写过；只删行、不插行的迁移不会把表纳入数据比较。`tableRows` 用 `Set` 去重，重复行的数量差异也会丢失。

```js
118: function writtenTables(before, after, created) {
119:   const written = new Set(created);
120:   for (const [name, rows] of after) {
121:     const previous = before.get(name);
122:     if (!previous || [...rows].some((row) => !previous.has(row))) written.add(name);
123:   }
```
```js
320:     const compared = writtenTables(beforeRows, afterRows, created);
321:     const reference = cloneFrom(fresh);
322:     if (schemaDump(production, compared) !== schemaDump(reference, compared)) {
```

可构造的漏检场景（由代码逻辑推演，未运行）：已有迁移 Y（大号）`INSERT INTO t VALUES (1)`；晚合的小号迁移 X `DELETE FROM t WHERE id=1`。生产顺序 Y→X 得到空表，新装顺序 X→Y 得到一行；但 X 只删不插，`written` 不含 `t`，`compared` 为空，`schemaDump` 只比结构（相同），于是 `compareOrders` 不报 `ORDER_DEPENDENT`。这正是本 PR 第 2 轮声称补上的“顺序比较的数据”。

建议：`writtenTables` 同时检查 `before` 有、`after` 没有的行（以及行数/多重集差异），或对 `before ∪ after` 的所有表比较数据；`tableRows` 用“行 → 计数”的多重集而不是 `Set`；补一条只删行的反向用例。

### 2. 严重度：中高（下一次新增迁移会直接打断现有测试，违背本 PR 目标）
`packages/persistence-sqlite/test/migration-engine.contract.test.ts:21`、`:339-346`
`packages/persistence-sqlite/test/run-checkpoint-migration.contract.test.ts:22`、`:161-169`

```ts
21: const CURRENT_SCHEMA_SEQUENCE = 95;
```
```ts
339:     expect(applyMigrations(database, migrations, { snapshot })).toEqual({
340:       appliedSequences: [
...
343:         90, 91, 92, 93, 94, 95,
344:       ],
345:       currentSequence: 95,
```
`run-checkpoint-migration.contract.test.ts` 同样把 `CURRENT_SCHEMA_SEQUENCE` 写死为 95，并用完整 `loadBundledMigrations()` 迁移。

当前仓库没有时间戳迁移（只有 0001–0095），所以现在能过；一旦加入第一个 `2026..._*.sql`，`applyMigrations(database, migrations)` 返回 96 和 96 个 appliedSequences，这些断言立刻失败。于是“每加一个迁移只新增文件、不改共用行”的目标仍需要在下一个 PR 改这些测试，和 `.agents/instructions/migrations.md` 的规则、ADR 第 121 行“写死版本号的测试改成从清单推算”不一致。

建议：改为从 `LATEST_MIGRATION_SEQUENCE` 或 `migrations.length` 推算，并像本 PR 已改的 `sandbox-reservation-administration.test.ts` 一样去掉 95。

### 3. 严重度：中（打包是“完整重放”，不是“重跑冲突检查”，已有迁移改动也查不到）
`scripts/check-migration-conflicts.mjs:143-169`、`:176-181`
`scripts/delivery-mode/make-packet.py:148-157`

`--commit` 分支只做：

```js
152:     problems.push(...replayAll([...legacy, ...stamped]));
153:     const appliedFlag = process.argv.indexOf("--applied");
...
156:         ...compareOrders({
```

而 `changedExistingFiles` 和 `analyzeMigrations`（逐个迁移的 `alters`/`removes`、两两冲突、禁止语句之外的声明检查）只在不带 `--commit` 的本地分支执行：

```js
176:   const ref = baseRef();
177:   problems.push(...changedExistingFiles(ref));
...
181:   problems.push(...analyzeMigrations({ base, added, meta: loadMeta(added) }));
```

打包脚本调用的是 `--commit` 路径。因此：
- 一个 PR 修改了已存在的 0001–0095 文件内容，`--commit` 会在空库里用修改后的文件重放并通过；但生产库账本里的旧摘要不同，新程序启动时 `validateLedger` 会报 `DIGEST_MISMATCH`，服务起不来、要回滚。ADR 第 142 行说打包时会“再跑一遍迁移冲突检查”，实际没有。
- 同一个提交里两个新迁移都重建同一张表、或去掉一个 CHECK 取值但没写 `removes`，`--commit` 只重放（两段 SQL 都能跑）加上“生产顺序 vs 新装顺序”比较；两者顺序相同，可能通过，而 `analyzeMigrations` 的 `CONFLICT`/`UNDECLARED_REMOVAL` 没有执行。

另外 `scripts/check-migration-conflicts.mjs:26-41` 的 `baseRef()` 取的是 `merge-base HEAD origin/main`，而 `base`/`known` 来自本地目录和这个 merge-base（`:170-179`）。分支尚未并入 main 时，origin/main 上后来新增的迁移不在 `base` 里，与它们的冲突要等并入 main 后才能发现；这和 ADR 第 161-170 行“不依赖 PR 什么时候并过 main”的表述不一致。

建议：打包路径也做 `analyzeMigrations`（以目标提交的已应用集合为 base、待跑集合为 added，并读取目标提交的 `.meta.json`），并从 S0 带上已应用迁移的 `{id,digest}`，在打包前核对已有迁移文件未被改动；本地检查应把 `origin/main` 的最新迁移也纳入 base。

### 4. 严重度：中（冲突检查与生产的外键行为不一致）
`scripts/migration-conflicts/analyze.mjs:137-141`、`:257-276`、`:321-326`
`packages/persistence-sqlite/src/migration-engine.ts:1209`

影子库显式关闭外键：

```js
137: function open() {
138:   const database = new BetterSqlite3(":memory:");
139:   database.pragma("foreign_keys = OFF");
```

而生产用的 `openQualifiedDatabase` 打开外键：

```ts
1209:   database.pragma("foreign_keys = ON");
```

`analyzeMigrations` 只在 `production` 克隆上跑 `foreign_key_check`（`:292`），两两顺序克隆（`:257-276`）和 `compareOrders` 的 `reference`（新装顺序，`:321-326`）不检查。后果：迁移如果在同一个文件里先插子行再插父行，最终状态通过 `foreign_key_check`，影子库会放行；但生产库外键开启，执行时立即失败。只在新装顺序才违反外键的情况也不会被发现。

建议：影子库按生产 pragma 打开（`foreign_keys = ON`），或在每个 forward/reverse/fresh/reference 克隆上跑 `foreign_key_check`；并加一个“先插子行后插父行”的反向用例。

### 5. 严重度：中低（说明文档/作者说法与最终代码不一致）
`packages/persistence-sqlite/src/migration-engine.ts:1014-1022`
`docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md:128`、`:135`、`:183`

作者材料说“`schema_metadata` 加 `schema_fingerprint`”。实际最终代码只写两个键：

```ts
1020:   statement.run("current_sequence", String(sequence), updatedAt);
1021:   statement.run("minimum_writer_sequence", String(sequence), updatedAt);
```

ADR 第 133 行已改成“指纹不另存一份”，但同文件第 135 行仍说“备份清单（恢复点、权限转移）和导出清单加可选字段 `schemaFingerprint`”，第 183 行仍说“算出指纹写进 `schema_metadata`”。代码里恢复点/权限转移清单都没有 `schemaFingerprint` 字段（`sqlite-recovery-point.ts:1145-1175` 的 unsigned 对象、`sqlite-authority-transfer.ts` 的 manifest 均无），而是把运行时 bundle 指纹通过 `expectedSchemaFingerprint` 传进来比较（`sqlite-recovery-point.ts:1044-1051`、`sqlite-authority-transfer.ts:790-798`）。ADR 第 128 行还说“没有待跑迁移时在单独的事务里做（加列/加索引/写指纹）”，实际 `applyMigrations` 在 `pending.length === 0` 时提前返回（`migration-engine.ts:1104-1107`），既不加列也不写指纹。

建议：统一 ADR 和作者说明，或者按文档补实现；不要同时保留互相矛盾的两段。

### 6. 严重度：中低（文档声称的消费者实际没改，防护只剩启动顺序）
`docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md:126`、`:132`
`packages/persistence-sqlite/src/sqlite-worker.ts:141-162`
`scripts/delivery-mode/packet-template/maintenance/S9-control-files.py:235-236`
`scripts/delivery-mode/packet-template/maintenance/raw-copy-recovery.mjs:154-156`

ADR 说所有读版本的地方改用 `readSchemaIdentity`，并点名 `sqlite-worker.ts`、S9、raw-copy 改成按编号对齐。实际：

```ts
154:   if (
155:     currentSequence !== configuration.writerSequence ||
156:     minimumWriterSequence > configuration.writerSequence
```

worker 仍只比整数，不读指纹；S9/raw-copy 仍按 5 列位置比较，不读 `migration_id`：

```python
235: ledger = db.execute('SELECT sequence,name,phase,digest,applied_at FROM schema_migration_ledger ORDER BY sequence').fetchall()
236: require([row[0] for row in ledger] == list(range(1, schema + 1)) and ...
```

目前生产启动路径是先 `applyMigrations`（会按指针校验集合）再启动 worker（`product-state-repository.ts:275-297`），所以 worker 的整数检查被间接保护；但 ADR 的“所有读版本的地方只用它”不成立，worker 单独面对“个数相同、集合不同”的库时仍会放行写入。

建议：要么让 worker 也校验指纹，要么把 ADR 改成“worker 依赖启动时的集合校验”；S9/raw-copy 若确实只需前后快照一致，也在 ADR 里说明，不要写成已按编号对齐。

### 7. 严重度：低（ADR 描述的目标产物未实现）
`docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md:139-140`

ADR 说“另外新增 `TARGET_MIGRATION_IDS` 和目标指纹”“`MIGRATION_LEDGER` 里每项带编号”。实际 `make-packet.py:225` 只输出 `sequence,name,phase`，全仓没有 `TARGET_MIGRATION_IDS`。当前消费方 `maintenance-common.mjs:807-809` 只按 `sequence/name/phase` 比对，所以功能上不缺口，但文档承诺的字段不存在。

建议：删掉未实现的描述，或补字段并让消费方校验。

---

## 二、推测 / 未核实

- **未运行测试**：工具限制只能读文件和跑 git 命令，`npm run check`、`npm test`、`npm run check:migration-conflicts` 都没执行。作者“测试已通过”的结论无法独立验证；上面关于“下一次新增迁移会打断测试”的结论来自对测试直接应用完整 `migrations` 的代码阅读。
- **生成器溢出**：`scripts/new-migration.mjs:13-20` 在最大 id 为 `99999999999999` 时会加一得到 15 位，引擎的 14 位正则会拒绝。实际不可能，仅属推测。
- **跨老清单排序**：`compareOrders`/`analyzeMigrations` 的“新装顺序”用字符串全局排序；若时间戳 id 以 `0000` 开头会排到 `0001` 之类旧编号之前，而引擎实际永远旧清单在前。当前生成器只产出 2026 年编号，不现实，仅提示。
- **指纹不含 name/phase**：`migrationSetFingerprint` 只含 `id + digest`，只靠 `assertWritableSchema` 的管理命令无法发现账本里 `name/phase` 被改；引擎启动的 `validateLedger` 会查。属低风险，未构造攻击。

---

## 三、侧重检查

- **错误路径/不可信输入**：迁移文件名用 `TIMESTAMPED_MIGRATION_FILE`/`LEGACY_FILE`/`META_FILE` 白名单，未知文件全部抛错（`migration-engine.ts:788-795`、`1336-1345`；`check-migration-conflicts.mjs:84-86`；`make-packet.py:123-140`），没有静默跳过；`--applied` 的未知 id 由 `compareOrders` 报 `APPLIED_ID_NOT_IN_COMMIT`（`analyze.mjs:301-304`）；S0 对 NULL `migration_id` 按序列补零（`read-s0-db.mjs:78-79`），外来的 4 位 id 会在打包时被拒。这一路基本是 fail-closed。
- **安全**：所有 git/node 调用用参数数组，没有 shell 拼接（`check-migration-conflicts.mjs:18-24`、`make-packet.py:148-153`）；目录扫描后拼接 URL，没有路径穿越；迁移 SQL 的 `ATTACH`/`VACUUM`/`load_extension`/`writable_schema` 被注释和单引号字面量剥离后拒绝（`analyze.mjs:10-50`）。未发现新增的直接注入面。
- **资源耗尽**：`analyzeMigrations` 对每个 added 迁移克隆一次 base，两两再克隆两次，复杂度约为 `O(n² × 95)`；本地检查没有总超时，打包只给 300 秒（`make-packet.py:152-155`）。ADR 已接受“靠 CI 作业超时兜底”，但批量新增迁移时可能明显变慢，建议至少给本地检查加大小上限或超时。
- **不可撤销操作**：已有库的迁移仍要求同机快照（`migration-engine.ts:1104-1108`），加列/加索引和迁移 SQL 在同一 `IMMEDIATE` 事务里（`:1115-1137`）；但打包门槛的上述缺口会让“改了已有迁移文件”或“同提交两个冲突迁移”在打包阶段通过，真正失败推迟到生产启动时，只能靠上线前快照回滚。
- **规则/说明与代码一致**：`.agents/instructions/migrations.md` 的“不改已有迁移、不写死数量、不向 bundledMigrationFiles 加条目”方向正确，但仓库里仍有硬编码 95 的测试；ADR 多处与最终实现不一致（第 5、6、7 条）。I-102 的门槛描述基本成立，但“打包再跑一遍冲突检查”没有落实。

---

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本 PR 只改 SQLite 迁移引擎、管理命令、打包/审计脚本和文档；没有改系统提示、工具定义、历史消息或遮盖。`packages/prompt-catalog` 与 `apps/agent-service` 中检索 `migration`/`schemaSequence`/`LATEST_MIGRATION` 没有发现进入模型请求的路径；`LATEST_MIGRATION_SEQUENCE` 只用于导出清单、管理命令和测试。所以发给模型的内容仍然是“只在末尾追加”，每轮变化的值不因本改动进入请求头。`check:prompt-prefix` 未运行。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会因本改动发生。新增的指纹是 `migrationSetFingerprint`：按 `id` 排序、拼 `id + digest` 再 SHA-256（`migration-engine.ts:770-777`），不含应用时间或先后；`applied_at`（`:1119`）会随时间变，但不参与指纹，也不进模型请求。同一迁移集合在不同请求/不同数据库上算出相同指纹。

**3. 有没有自动检查，反向用例真的会失败吗？**
有：
- `package.json:27` 把 `check:migration-conflicts` 放进 `check:steps`；脚本本身在本地模式做重复 id、已有迁移被改/删、未声明改动、禁止语句、两种顺序和 `foreign_keys`/`integrity_check` 检查。
- `check:audit-schema-range` 检查旧清单数量、新增四位号文件、新迁移是否碰审计读的表且未登记。
- `packages/persistence-sqlite/test/migration-ids.contract.test.ts` 覆盖重复/乱序 id、晚合小号、个数相同集合不同、未知已应用迁移、指纹顺序无关。
- `test/tooling/migration-conflicts.test.mjs`、`test/tooling/audit-schema-range.test.mjs`、`scripts/delivery-mode/test_make_packet.py` 有反向用例。

但缺口也明确：没有“只删行导致生产顺序与新装顺序不同”的用例；没有“打包时已有迁移文件被改”的用例；没有“影子库外键关闭导致生产失败”的用例。且这些测试文件不在 `check:migration-conflicts` 这一步里，而由完整 `npm test`/coverage 收集（`package.json:83`）。我没有运行它们，不能确认“在未修复代码上真的失败”。

**4. 改动产生/修改的每个值，使用它的地方都能接受吗？**
逐个核对结果：
- `migration_id`（4 位 NULL 或 14 位字符串）：引擎写入（`migration-engine.ts:1121-1132`），`readMigrationLedger` 读取并派生旧 id（`:922-935`），S0 输出 `migrationIds`（`read-s0-db.mjs:78-79`），maintenance 按 id 查定义（`maintenance-common.mjs:931-938`），审计脚本检查 `sequence > 95 AND migration_id IS NULL`（`workspace-lifecycle-audit.mjs:52-63`）。两端格式一致，NULL 只用于旧行，消费方能接受。
- `migrationIds`：由 S0 产生，打包侧 `compareOrders` 先拒绝不存在的 id，`migration_ledger` 再用集合差并核对数量/子集（`make-packet.py:193-208`）。能接受。
- `LEGACY_MIGRATION_COUNT=95`：引擎/审计/冲突脚本共用，`check-audit-schema-range` 用引擎最大 sequence 与审计声明交叉核对（`check-audit-schema-range.mjs:17-60`）。一致。
- `LATEST_MIGRATION_SEQUENCE`：语义从“最后编号”变成“总数”；在旧清单连续的前提下等于最后编号。导出、管理命令、沙箱预留、测试都当整数总数使用，目前一致。
- `MIGRATION_LEDGER`：打包只产出 `sequence,name,phase`（`make-packet.py:225`），maintenance 只校验这三项（`maintenance-common.mjs:807-809`），能接受；但 ADR 声称带 id，实际没有。
- `schema_fingerprint` / `TARGET_MIGRATION_IDS` / `schemaFingerprint` 清单字段：**没有任何生产方**，只有说明文档和恢复点/权限转移的可选参数。使用方要么不存在，要么比较的是运行时 bundle 指纹。这是“说法与代码”不一致，不是两端校验不一致。

结论：运行时的迁移 id/指纹消费链基本对齐；真正需要修的是第 1–4 条的检查缺口，以及第 5–7 条文档与代码不一致。
