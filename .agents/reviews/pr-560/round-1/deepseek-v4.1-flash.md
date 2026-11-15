## 侧重检查

- 旧版本路径：读了 `git show bc380a6e:packages/persistence-sqlite/src/migration-engine.ts`（生产 11-07 版本）。`MigrationDefinition` 没有 `id`，`loadBundledMigrations` 返回 `{ ...metadata, sql, digest }`，确实没有 `id`；`bundledMigrationId` 的序号回退能覆盖这条路径。
- 新版本路径：`migration-engine.ts:762-764` 的 `legacyMigrationId`、`:845-848` 的校验、`:1129-1138` 的写入、`:929-935` 的读回，legacy 用四位补零、时间戳用 14 位 id，和 helper 口径一致。
- 其他模板：在 `scripts/delivery-mode/packet-template` 的 maintenance、s0-db、install、systemd 里搜索 `migration.id`、`loadBundledMigrations`、`migration_id`，除 `readMaintenanceState` 和 `verify-migrate-fixtures.mjs`（后者只加载新版本迁移、不读 `id`）外，没有发现其他旧 prefix/new prefix 下按 `migration.id` 取定义的路径。
- 错误路径：旧定义缺 `id`、数据库缺 `migration_id` 列、`migration_id` 为 NULL 三种情况都走补零回退；`name/phase/digest` 的逐条比较没有被放宽（`maintenance-common.mjs:939`）。
- 安全 / 资源 / 不可撤销操作：改动只影响只读状态读回和测试，不新增写库、循环、网络或模型请求；`readMaintenanceState` 仍在只读事务里。
- 规则文档：I-105 的编号格式、唯一性、门槛路径按 `scripts/check-incident-gates.mjs:73-78` 的检查逻辑可以通过；但文档里“唯一取号方式”和“已落门槛”的实质覆盖不足，见下面第 1、2 条。
- 包内摘要：模板里的 `maintenance/OWNED-SHA256SUMS` 第 2 行仍是旧摘要，但 `make-packet.py:609-623` 的 `regenerate_hashes` 会在出包时重算，出包一致性检查读的是生成后的包，因此不构成问题。

## 读代码证实的

- 生产旧版本确实没有迁移 `id`：`bc380a6e` 的 `MigrationDefinition` 和 `loadBundledMigrations` 都没有 `id`。
- 当前基线 `82ebfe696` 的 legacy 定义已有 `id`（`legacyMigrationId(sequence)`），所以 helper 必须同时支持“有 id”和“没有 id”，它现在确实两种都支持。
- 时间戳迁移：`applyMigrations` 写入时 `migration.id.length === 4 ? null : migration.id`，14 位 id 会原样写入账本；读账本时 NULL 回退为四位补零。两端一致。
- 补零后不会和 14 位编号冲突：当前 legacy 最多 95 条，补零结果是 4 位；时间戳 id 是 14 位。理论上只有序列号达到 14 位才可能冲突，当前不可达。
- 新增测试确实会在出包时运行：`run-packet-checks.py:14-16` 把 `maintenance/verify-fixtures.mjs` 放进 `NODE_FIXTURES`，`:149` 用 Node 执行它。
- `verify-fixtures.mjs` 的改动只增加测试断言，没有改变生产逻辑；`maintenance-common.mjs` 只把建表键从 `migration.id` 换成 `bundledMigrationId`。

## 推测 / 未核实

- “把 `maintenance-common.mjs:934` 改回 `migration.id`，新增三条断言仍然会通过”是根据断言只调用 `bundledMigrationId`、不调用 `readMaintenanceState` 推出来的，未实际运行验证。
- 生产账本 78 条与新版本迁移逐条一致的“生产实测”无法在本仓库核实；`bc380a6e` 的 78 条 legacy 定义和当前前 78 条名称一致，但生产数据库里的实际 digest 未读。
- “出包检查和 Hermes 演练都用新版本代码读库”属于流程事实，代码只能证明出包检查确实运行新渲染的 `verify-fixtures.mjs`。

### 1. 中 — 新增断言只锁住了 `bundledMigrationId`，没有锁住真正出错的 `readMaintenanceState` 调用点

- 文件:行：`scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:29-34`，`maintenance-common.mjs:934`。
- 问题：测试自己在文件顶部用 helper 新建了一个 Map，然后断言 `definitionsByLedgerId.get("0001")`；真实的失败点是 `readMaintenanceState` 里 `new Map(migrations.map(...))` 这一行。如果以后有人把这一行改回 `migration.id`，三条新断言仍然全过，出包检查和 I-105 声称的门槛也发现不了，和第二十九次上线的故障完全一样。
- 证据（读代码证实的）：
  ```js
  // verify-fixtures.mjs:29-34
  const definitionsByLedgerId = new Map([...releaseWithoutMigrationIds, ...releaseWithMigrationIds].map((migration) => [bundledMigrationId(migration), migration]));
  assert.equal(definitionsByLedgerId.get("0001")?.name, "a", "MIGRATION_ID_FALLBACK_FIRST");
  ...
  // maintenance-common.mjs:934
  const definitions = new Map(migrations.map((migration) => [bundledMigrationId(migration), migration]));
  ```
  `check-incident-gates.mjs:73-78` 只检查门槛列里的文件是否存在，不检查该文件是否覆盖 `readMaintenanceState`；提交说明里“改动前它在导入 bundledMigrationId 时失败”也只证明导出不存在，不证明旧调用点会被测试拦住。以上是读代码证实；测试改回调用点是否仍通过是推测。
- 建议：把“迁移定义 + 账本 id”的配对逻辑抽成纯函数（例如 `migrationDefinitionsByLedgerId(migrations, ledgerIds)`），让 `readMaintenanceState` 和测试调用同一个函数；测试里至少覆盖三种输入：旧定义无 `id` 且无 `migration_id` 列、legacy 定义有四位 `id`、时间戳定义有 14 位 `id`。或者像 `s0-db/verify-catalog-runtime-switch.mjs` 那样做源码级断言，要求 `readMaintenanceState` 必须使用 `bundledMigrationId`。这样才能在调用点回退时真正变红。

### 2. 低 — “`bundledMigrationId` 是唯一取号方式”与代码不符，补零规则仍有三份手写副本

- 文件:行：`maintenance-common.mjs:24`、`maintenance-common.mjs:937`、`s0-db/read-s0-db.mjs:79`，文档 `docs/incidents-and-gates.md:140`。
- 问题：文档 I-105 说 `bundledMigrationId` 是这条比对“唯一的取号方式”，但同一函数里账本侧仍内联了一份 `String(ledger[index].sequence).padStart(4, "0")`，`read-s0-db.mjs` 还有第三份。当前三者一致，但以后只改其中一处就会重新产生“定义键”和“账本键”对不上的故障，而现有测试只覆盖 helper 那一份。
- 证据（读代码证实的）：
  ```js
  // maintenance-common.mjs:24
  export const bundledMigrationId = (migration) => migration.id ?? String(migration.sequence).padStart(4, "0");
  // maintenance-common.mjs:937
  const definition = definitions.get(ledgerIds[index].id ?? String(ledger[index].sequence).padStart(4, "0"));
  // s0-db/read-s0-db.mjs:79
  ...map((row) => row.id ?? String(row.sequence).padStart(4, "0"));
  ```
- 建议：导出一个共享的 `legacyMigrationId(sequence)` 或 `ledgerMigrationId(row)`，让 `bundledMigrationId`、`readMaintenanceState` 的账本回退、`read-s0-db` 都使用它；并加一条同时覆盖定义侧和账本侧的测试。这样文档里的“唯一取号方式”才成立。

### 3. 低 — 测试夹具把 14 位 id 放在 sequence 79，不符合当前引擎对迁移定义的校验

- 文件:行：`verify-fixtures.mjs:30`，`packages/persistence-sqlite/src/migration-engine.ts:845-848`。
- 问题：当前引擎规定 legacy 位置（`sequence <= LEGACY_MIGRATION_COUNT`，目前 95）的 `id` 必须是四位补零，时间戳 id 只能出现在 95 之后。夹具 `{ sequence: 79, id: "20261114120000" }` 在真实引擎里是非法定义；它只测 helper 的“有 id 优先”，没有测真实的时间戳迁移位置，因此无法防止“只对 sequence > 95 才用 id”这类未来规则变化。
- 证据（读代码证实的）：
  ```js
  // verify-fixtures.mjs:30
  const releaseWithMigrationIds = [{ sequence: 79, id: "20261114120000", name: "c" }];
  // migration-engine.ts:845-848
  const legacyPosition = expectedSequence <= LEGACY_MIGRATION_COUNT;
  const idValid = legacyPosition
    ? migration.id === legacyMigrationId(expectedSequence)
    : /^\d{14}$/.test(migration.id) && migration.id > lastTimestampId;
  ```
- 建议：用真实形状的夹具，例如 legacy 部分用 `{ sequence: 1, ... }`、时间戳部分用 `{ sequence: 96, id: "20261115033014" }`（具体 legacy 数以当前 `LEGACY_MIGRATION_COUNT` 为准），或者至少明确命名为“synthetic helper input”，避免以后把这个夹具当成合法迁移定义复用。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次 diff 只涉及 `docs/incidents-and-gates.md`、`maintenance-common.mjs`、`verify-fixtures.mjs`，没有系统提示、工具定义、历史消息或遮盖逻辑的改动；`readMaintenanceState` 不组装模型请求，新增的 `bundledMigrationId` 只在维护脚本内部计算。因此发给模型的内容仍然只在末尾追加，每轮变化的值仍在最后一条消息，未受此次改动影响（对照 `.agents/instructions/prompt-prefix.md` 第 1–3 条及第 4 条）。

2. **不会让同一段文字在不同请求里变成不同字节。** 新值只由 `migration.id` 或 `migration.sequence` 确定性计算，不依赖时间、上下文或集合顺序；`readMaintenanceState` 里的 `checkedAt` 等时间字段是原有证据输出，不进入模型请求。本次没有改遮盖、序列化集合或时间相关逻辑。

3. **有自动检查，但覆盖不完整。** `verify-fixtures.mjs` 确实由 `run-packet-checks.py` 在出包时运行；如果 helper 去掉回退、补零宽度改错或丢掉显式 id 优先，三条断言会失败，这算部分反向保障。但测试不执行 `readMaintenanceState`，所以调用点回退到 `migration.id` 时测试不会失败；`check-incident-gates` 也只确认门槛文件存在。因此 I-105 的“已落门槛”对真正的故障点覆盖不足，建议按第 1 条补调用点/纯函数测试。

4. **逐值核对结果：**
   - `bundledMigrationId` 的输出只用于 `readMaintenanceState` 的定义 Map 和新增测试；使用端是 `definitions.get(ledgerIds[index].id ?? 四位补零)`。生产旧版本无 `id` 且账本无 `migration_id` 列时两端都得到 `0001` 这类四位串；新版本 legacy 定义有四位 `id`、账本为 NULL 时也回退四位串；时间戳定义有 14 位 `id`、账本 `migration_id` 也是 14 位。两端一致。
   - `migration_id` 的生产者是 `migration-engine.ts:1129-1138`，legacy 写 NULL、时间戳写 14 位 id；消费端是 `readMigrationLedger`（`:929-935`）、`read-s0-db.mjs:79` 和 `readMaintenanceState`，三者对 NULL 都回退四位补零。
   - `I-105`：编号符合 `I-\d{2,}`，当前表内没有重复；门槛列里的 `verify-fixtures.mjs` 和 `maintenance-common.mjs` 都存在，按 `check-incident-gates.mjs` 会通过。但“唯一取号方式”的说法不准确，“已落门槛”只由文件存在性保证，见第 2 条。
   - 时间戳迁移（14 位）在新版本下的 `id` 与账本 `migration_id` 一致；补零后不会与 14 位编号冲突，因为长度分别是 4 位和 14 位，且 legacy 数量当前只有 95。
   - `maintenance/OWNED-SHA256SUMS` 中 `maintenance-common.mjs` 的摘要目前是模板里的旧值，但 `make-packet.py:609-623` 会在出包时重算，实际包内检查不会因此失败。
   - 在 maintenance、s0-db、install、systemd 模板里没有发现其他旧 prefix/new prefix 下按 `migration.id` 取迁移定义的地方；`verify-migrate-fixtures.mjs` 只加载新版本迁移，不读 `id`。
