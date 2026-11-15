复核范围：`f3013398..b869402` 的 2 个提交（`5a2c99e11`、`b869402b4`），并用 `82ebfe69..b869402b` 和旧代码对照。读了 maintenance-common、verify-fixtures、read-s0-db、I-105、ADR 0265、migration-engine、migration-ids 合同测试、run-packet-checks、make-packet，以及 packet-template 的 maintenance/s0-db/install/systemd。未发现中、高严重度的新代码错误；下面是 3 条低严重度问题，主要是测试和文档缺口。

## 侧重检查

- **错误路径**：`readMaintenanceState` 在 S3_COPY51 先只读打开旧库，`definitionsForLedger` 取不到定义时返回 `undefined`，随后 `assert(definition, ...LEDGER_DIGEST_MISMATCH)` 失败，发生在 `copyRecovery` 之前；失败关闭，不会继续做不可撤销操作（maintenance-common.mjs:917-951）。
- **不合规范/不可信输入**：迁移定义来自本机 `oldPrefix` 或 `newPrefix` 的已装包，账本来自生产 SQLite；两者只用作 Map 键和字段比较，没有把值拼进 SQL、路径或 `eval`，本增量没有新增外部输入面。
- **安全/资源**：`definitionsForLedger` 只做一次 O(n) 建 Map 和一次 O(m) 查找，无未限制循环、无网络、无文件写入。
- **不可撤销操作**：`readMaintenanceState` 使用 `openRecoveryReadonly`，事务内只有读；本增量不新增写库、删文件或改配置。
- **规则/文档/代码一致性**：I-105 已改成 `definitionsForLedger`/`ledgerMigrationId` 口径，和最终代码基本一致；但作者材料的“三条断言”“`bundledMigrationId` 是唯一取号方式”停留在中间提交。见下面第 3 条。
- **其他模板**：在 packet-template 内搜索 `loadBundledMigrations`、`migration.id`、`migration_id`、`schema_migration_ledger`，除 maintenance-common:932-937 和 read-s0-db:80-81 外，`S9-control-files.py:235`、`raw-copy-recovery.mjs:154`、各 verify-*-fixtures 只读账本的 sequence/name/phase/digest，不按 `migration.id` 取定义；install/systemd 没有此类读取。

## 意见

### 1. 低 — 新断言没有锁住“按 id 对齐”和“按 sequence 对齐”的区别

文件:行：`scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:29-34`、`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:24-26`、`docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md:126`

问题：ADR 0265 要求 maintenance-common 从“按下标对齐”改成“按编号对齐”，但新增的 4 条断言里没有一条让账本的 `sequence` 与定义的 `sequence` 不一致。把 `definitionsForLedger` 退化成按 `sequence` 建 Map、按 `sequence` 查找，这 4 条仍然全部通过；晚合入的小编号迁移会拿错定义，然后被 name/phase/digest 比对拒绝，或更糟地换成另一条定义。

已读代码证实：
```js
// maintenance-common.mjs:24-26
export function definitionsForLedger(migrations, ledgerIds) {
  const definitions = new Map(migrations.map((migration) => [ledgerMigrationId(migration), migration]));
  return ledgerIds.map((row) => definitions.get(ledgerMigrationId(row)));
}
```
```js
// verify-fixtures.mjs:33
assert.deepEqual(definitionsForLedger(releaseWithMigrationIds, [{ sequence: 1, id: "0001" }, { sequence: 96, id: "20261114120000" }]).map((definition) => definition?.name), ["a", "c"], "MIGRATION_DEFINITIONS_ID_COLUMN");
```
这条用例里账本 sequence 96 对应的定义 sequence 也是 96，按 sequence 查也能得到 `"c"`，所以识别不出“没有按 id 对齐”。

推测：当前 helper 确实按 `ledgerMigrationId` 建键，代码本身是对的；上面只是回归风险，不是现在就会失败。

建议：加一条“晚合入的小号”用例，例如定义 `sequence 96 / id A`、`sequence 97 / id B`，账本应用顺序为 `sequence 96 / id B`、`sequence 97 / id A`，期望得到 `[B, A]`；只有按 id 对齐才能通过。最好同时断言 name/phase/digest，而不只是 name。

### 2. 低 — 自动检查仍不执行 `readMaintenanceState`，I-105 却写成覆盖了 `migration_id` 列分支

文件:行：`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:935-937`、`scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:31-34`、`docs/incidents-and-gates.md:140`

问题：新增断言只直接调用 `definitionsForLedger`，没有调用真正出错的 `readMaintenanceState`。因此 `pragma_table_info` 检测 `migration_id` 列、以及 `ledgerIds` 到底传 `ledger` 还是传带 `id` 的查询结果这一段，仍未被自动检查覆盖。I-105 写“断言……账本有无 `migration_id` 列时都按账本逐条取到对应定义”，严格说测试只覆盖了“账本行有/没有 `id` 属性”的 helper 层行为，没有覆盖数据库列检测和传参。

已读代码证实：
```js
// maintenance-common.mjs:935-937
const idColumn = rows(database, "SELECT 1 AS present FROM pragma_table_info('schema_migration_ledger') WHERE name='migration_id'", []).length === 1;
const ledgerIds = idColumn ? rows(database, "SELECT sequence, migration_id AS id FROM schema_migration_ledger ORDER BY sequence", []) : ledger;
const definitions = definitionsForLedger(migrations, ledgerIds);
```
```js
// verify-fixtures.mjs:31-34
assert.deepEqual(definitionsForLedger(releaseWithoutMigrationIds, [{ sequence: 1 }, { sequence: 78 }])...);
assert.deepEqual(definitionsForLedger(releaseWithMigrationIds, [{ sequence: 1 }, { sequence: 78 }])...);
assert.deepEqual(definitionsForLedger(releaseWithMigrationIds, [{ sequence: 1, id: "0001" }, { sequence: 96, id: "20261114120000" }])...);
assert.equal(definitionsForLedger(releaseWithoutMigrationIds, [{ sequence: 2 }])[0], undefined, ...);
```
第 1 轮意见 1 指出的正是“没锁住调用点”。这次把 Map 的建法和查找都移进 helper 后，原始 bug（用 `migration.id` 建表）会被第 31 行抓住；但“列检测 + 参数传递”仍只在生产路径上跑。

推测：当前 935-937 三行本身没有发现错误；这是测试覆盖和文档措辞问题。

建议：在 verify-fixtures 里用临时 SQLite 建一个 5 列账本和一个 6 列账本（旧行 `migration_id` 为 NULL），把 `persistence`/`loadBundledMigrations` 替换成夹具定义，直接调用 `readMaintenanceState`，分别断言旧定义无 id 和旧库无 id 列、新定义有 id 和旧库无 id 列、新定义有 id 和新库有 id 列都能逐条取到；或者把 I-105 的措辞改成“覆盖 `definitionsForLedger` 的取号与查找，列检测由维护脚本本身负责”，不要写成已覆盖数据库列分支。

### 3. 低 — 作者说法停留在中间提交，和最终 b869 代码不一致

文件:行：本次材料 vs `scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:73`、`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:24-26`、`scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:31-34`

问题：材料说“新增导出 `bundledMigrationId(migration)`”“`bundledMigrationId` 是这条比对唯一的取号方式”“verify-fixtures.mjs 加三条断言”。最终 b869 里 `bundledMigrationId` 已被删除，取号改成 `read-s0-db.mjs` 的 `ledgerMigrationId`，定义与账本配对改成 `definitionsForLedger`，断言是四条而不是三条。

已读代码证实：
```js
// read-s0-db.mjs:73
export const ledgerMigrationId = (row) => row.id ?? String(row.sequence).padStart(4, "0");
```
```js
// maintenance-common.mjs:24-26
export function definitionsForLedger(migrations, ledgerIds) {
  const definitions = new Map(migrations.map((migration) => [ledgerMigrationId(migration), migration]));
  return ledgerIds.map((row) => definitions.get(ledgerMigrationId(row)));
}
```
仓库内搜索 `bundledMigrationId` 已无引用；`verify-fixtures.mjs` 第 31-34 行是四条断言。

推测：这不是运行时错误，只是复核材料没有随 `b869402b4` 更新；I-105 正文已经改成了最终口径。

建议：把作者材料和 I-105 的措辞统一到 `ledgerMigrationId`/`definitionsForLedger`，并写清是四条断言；不影响代码合并，但避免后续复核按旧说明查错地方。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。此次增量只改 `scripts/delivery-mode` 的维护/出包脚本、`packet-template/s0-db`、测试和 `docs/incidents-and-gates.md`，没有改 `packages/prompt-catalog`、Pi 适配器、工具定义、历史消息或出口遮盖。模型请求仍按原规则只在末尾追加，每轮变化的值不在本次改动范围内。
   依据：`.agents/instructions/prompt-prefix.md#rules`（第 4 条“只能追加”）。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会。`ledgerMigrationId` 是纯函数，只依赖 `row.id` 和 `row.sequence`；`definitionsForLedger` 返回顺序由传入的 `ledgerIds` 数组决定，不依赖 Map 遍历顺序，没有时间、随机数、无序集合或前后文相关逻辑。并且这些值不进入模型请求。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有。`verify-fixtures.mjs` 在 `run-packet-checks.py:16` 的 `NODE_FIXTURES` 中，出包时执行（`run-packet-checks.py:149`，环境变量在 226 行设置）。
   - 若去掉 `id` 回退，第 31 行 `MIGRATION_DEFINITIONS_OLD_RELEASE_NO_ID_COLUMN` 会得到 `[undefined, undefined]`，失败；
   - 若误返回某个定义，第 34 行 `MIGRATION_DEFINITIONS_UNKNOWN_SEQUENCE` 会失败；
   - 但“按 sequence 对齐而不是按 id 对齐”的回归不会被现有断言发现（见意见 1），`readMaintenanceState` 的列检测分支也未直接执行（见意见 2）。
   以上为静态推理，本轮没有运行测试。

4. **每个产生或修改的值，使用它的地方都能接受吗？** 逐个核对如下：
   - `ledgerMigrationId`（read-s0-db.mjs:73）：使用端是 `readS0State` 的 `.map(ledgerMigrationId)`（read-s0-db.mjs:81）和 `definitionsForLedger` 的定义侧/账本侧（maintenance-common.mjs:25-26）。两端都接受带 `sequence`、可选 `id` 的行对象；旧 ID 为 4 位补零，新时间戳 ID 为 14 位，引擎的校验正是这个口径（migration-engine.ts:845-857），可以接受。
   - `definitionsForLedger`（maintenance-common.mjs:24-26）：使用端是 `readMaintenanceState`（maintenance-common.mjs:937，返回数组且允许 `undefined`，随后第 941 行断言存在）和 verify-fixtures 第 31-34 行（只取 `.name`/是否为 `undefined`）。两端都接受。
   - `bundledMigrationId`：已删除，仓库内无剩余引用；没有使用端漏改。
   - 迁移 ID 与账本 `migration_id`：引擎写入时 4 位旧 ID 存 NULL，14 位时间戳 ID 存原值（migration-engine.ts:1129-1138）；读取时 NULL 回退为 4 位补零（migration-engine.ts:932-934）。`definitionsForLedger` 的键与这个口径一致；新版本定义的时间戳 ID 来自文件名 14 位（migration-engine.ts:1363-1371）。
   - 补零与 14 位 ID 冲突：不会。旧 ID 补零到至少 4 位，时间戳 ID 固定 14 位数字；即使 sequence 超过 9999 也只是 5 位以上，不会等于 14 位。
   - I-105 清单项：只被文档/复核使用，没有运行时消费端；门槛是出包检查运行 verify-fixtures，属实，但“数据库列分支已覆盖”的措辞偏大（见意见 2）。
   - 测试夹具名称 `MIGRATION_DEFINITIONS_*`：仅测试内使用，无外部消费端。

## 作者说法与代码对照

- “新增导出 `bundledMigrationId`”与最终代码不符：b869 已删除它，改成 `ledgerMigrationId` + `definitionsForLedger`（read-s0-db.mjs:73、maintenance-common.mjs:24-26）。
- “`bundledMigrationId` 是唯一取号方式”与最终代码不符；I-105 正文已改成“定义侧和账本侧共用 `ledgerMigrationId`”，这一句与代码一致。
- “verify-fixtures.mjs 加三条断言”与代码不符：实际是四条（verify-fixtures.mjs:31-34）。
- “旧版本定义没有 `id`、新版本有四位和 14 位 `id`、账本有无 `migration_id` 列”：helper 层有对应覆盖（第 31-33 行）；数据库列检测分支未直接测试（意见 2）。
- “timestamp 迁移 14 位编号在新版本下的 id 与账本 migration_id 一致”：读代码成立；新定义用 14 位，引擎对时间戳迁移存 14 位（migration-engine.ts:1363-1371、1129-1138）。
- “补零后可能与 14 位编号冲突吗”：不会，长度和取值空间不同，代码里没有可产生相同字符串的路径。
- “maintenance 目录、s0-db、install、systemd 等模板里还有没有其他地方在 oldPrefix/newPrefix 下读 migration.id 会取不到”：未发现。只有 maintenance-common:932-937 读取定义并按 id 配对；其余模板只读账本的 sequence/name/phase/digest，或读 `max(sequence)`。

## 未核实

- 生产账本确实 78 条、旧版本 `loadBundledMigrations` 返回的定义确实只有 `sequence,name,changeSet,phase,file,sql,digest` 而没有 `id`：这是事故记录中的生产实测，本仓库没有旧版本构建产物，无法从代码复核。
- verify-fixtures 的断言在真实 Node 环境下会通过：本轮按要求只读代码，未运行测试。
- `readMaintenanceState` 在真实旧库、旧定义组合下的端到端行为：没有运行生产夹具，只能按代码和行形状推断。
