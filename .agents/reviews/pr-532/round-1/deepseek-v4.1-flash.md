**读代码证实的**

### 1｜低｜测试用目录文件数复刻产品算法，与产品实际取值来源和文件名正则都不一致
文件：`test/integration/installable-node-services.test.ts:23`；`packages/persistence-sqlite/src/migration-engine.ts:756`、`:758`、`:766-769`

问题：新的期望值来自“目录里匹配文件名的 .sql 个数”，而产品 `LATEST_MIGRATION_SEQUENCE` 来自“代码数组 `bundledMigrationFiles.length` + 目录里匹配更严格正则的时间戳文件个数”。两端不是同一个来源，正则也不同。

证据：
```
test:23  return names.filter((name) => /^(\d{4}|\d{14})_[a-z0-9_]+\.sql$/u.test(name)).length;
engine:756  export const LEGACY_MIGRATION_COUNT: number = bundledMigrationFiles.length;
engine:758  const TIMESTAMPED_MIGRATION_FILE = /^(\d{14})_([a-z][a-z0-9_]*)\.sql$/;
engine:766-769  export const LATEST_MIGRATION_SEQUENCE: number =
                  LEGACY_MIGRATION_COUNT +
                  readdirSync(MIGRATION_FILE_SYNC_DIRECTORY).filter((name) => TIMESTAMPED_MIGRATION_FILE.test(name))
                    .length;
```
会不一致的情况：目录里出现一个未登记进 `bundledMigrationFiles` 的四位 `.sql`（测试计数 +1，产品的 legacy 计数仍按数组长度）；数组登记了但磁盘缺对应文件（产品长度不变、测试 -1）；14 位文件名后半段以数字或下划线开头，例如 `2026..._1foo.sql`（测试的 `[a-z0-9_]+` 算入，产品的 `[a-z][a-z0-9_]*` 拒绝）。当前目录 `0001`–`0095` 共 95 个四位文件、14 位 `.sql` 共 12 个，95+12=107，与数组长度 95+12=107 恰好一致，所以现在能通过；这只是“当前恰好一致”，不是两侧共享同一校验。

建议：直接用第 8–12 行已经导入的 `(await loadBundledMigrations()).length` 作为期望值，或导入 `LATEST_MIGRATION_SEQUENCE` 比较；同时把函数改名为 `bundledMigrationCount`。这样期望值与实际写入数据库的迁移集合同源，不必复刻文件名正则。

### 2｜低｜作者说 schemaSequence 是“已应用迁移数”，代码实际是最后一条迁移的序号
文件：`packages/persistence-sqlite/src/migration-engine.ts:1261-1262`；`test/integration/installable-node-services.test.ts:494`

问题：`schemaSequence` 取的是 ledger 最后一条记录的 `sequence`，真正的“已应用迁移数”是相邻的 `migrationCount`。只有在 ledger 从 1 连续且全部应用时，两者才相等。测试把一个“计数”直接当作“序号”来断言，依赖的正是这个隐含前提。

证据：
```
engine:1261  schemaSequence: ledger.at(-1)?.sequence ?? 0,
engine:1262  migrationCount: ledger.length,
test:494     schemaSequence: await latestMigrationSequence(),
```
这个前提目前由 `validateDefinitions` 的连续序号检查守住（`migration-engine.ts:837-848`，`expectedSequence = index + 1` 且 id 必须匹配），所以全量迁移后确实相等，测试能通过。但作者对字段语义的描述不准确；若将来只做部分迁移或序号出现空洞，用“文件数”推“最后序号”就会错。

建议：测试如需按“个数”对齐，应同时断言 `migrationCount`，或直接用产品常量 `LATEST_MIGRATION_SEQUENCE` 比较 `schemaSequence`；注释/材料中把 `schemaSequence` 写成“最后一条已应用迁移的序号”。

**推测 / 未核实**

- 作者称“改前实测 95 对 107、改后 4 条通过”：我没有运行测试，未核实；但按目录现状（95 个四位 + 12 个时间戳 = 107，旧算法 `Math.max` 得 95）与代码推算，方向是吻合的。
- “产品算法 = 旧迁移个数 + 时间戳迁移个数”成立，但其中的“旧迁移个数”是代码数组长度，不是目录四位文件数；现在两者相等，所以材料读起来没错，实际含义有细微差别。

**侧重检查**

- 错误路径/不可信输入：helper 只对固定的仓库迁移目录做 `readdir`，没有外部输入、路径拼接用户数据或 SQL 执行；文件名不匹配只会被过滤，不会抛错。
- 安全：没有新增网络、文件写入、密钥或权限逻辑；原有测试的临时目录清理未改。
- 资源耗尽：读取的是仓库内固定小目录，无循环放大或大文件读取。
- 不可撤销操作：改动只改测试期望值，不触及生产线、数据库迁移执行或删除路径。
- 规则/文档与代码一致性：diff 仅一处测试文件，未触及提示词组装、遮盖或历史存储。发现两处表述不精确：`schemaSequence` 语义；“旧迁移个数”的实际来源。
- 双向校验：测试侧正则比产品侧宽（`[a-z0-9_]+` 对 `[a-z][a-z0-9_]*`），且测试侧数文件、产品侧数数组，未共享同一校验；当前靠产品加载时的 `DEFINITION_INVALID` 提前失败兜底，不是测试期望值本身正确。

**必答问题**

1. 不会改变模型已经见过的请求开头。`git diff` 只改了 `test/integration/installable-node-services.test.ts` 的 helper，没有动系统提示、工具定义、历史消息或遮盖结果；发给模型的内容仍然只在末尾追加。依据 `prompt-prefix.md` 第 4 条（只追加）及整个改动范围。
2. 不会让同一段文字在不同请求里变成不同字节。新 helper 只是 `readdir(...).filter(...).length`，结果与目录遍历顺序无关，没有时间、随机数或集合序列化；且它是测试代码，不参与请求组装。产品 `LATEST_MIGRATION_SEQUENCE` 也只依赖目录内容，顺序无关。
3. 有对应检查，但绑定不完整。这条断言本身是检查；`packages/persistence-sqlite/test/migration-ids.contract.test.ts:93` 已保证 `loadBundledMigrations().length === LATEST_MIGRATION_SEQUENCE`，并检查 legacy id 连续、时间戳 id 格式。反向用例：把 helper 换回旧算法，在当前 12 个时间戳迁移下期望 95、数据库实际 107，会失败（作者实测 4 条通过，我未运行，未核实）。但目前没有自动检查把“测试 helper 的计数”与 `LATEST_MIGRATION_SEQUENCE`／`loadBundledMigrations().length` 绑在一起，helper 将来漂移不会单独报警；建议加一行断言或直接复用常量。
4. 值的产生与使用：产生处是 `test/...:23` 返回的整数；使用处是 `test/...:494` 与 `inspectSqliteDatabaseReadOnly` 产出的 `schemaSequence` 精确比较（`toMatchObject`）。另一端的产生处是 `migration-engine.ts:1261` 的 `ledger.at(-1)?.sequence ?? 0`。两端当前都是 107，校验能接受。前提是 ledger 序号 1..N 连续（`validateDefinitions` 强制）且四位文件数等于数组长度（当前 95=95，但这不是代码保证）。会不一致的条件已列在第 1 条。按 I-73 的教训，这里两端没有共享校验：建议期望值改从 `loadBundledMigrations()` 或产品常量取得，避免只在一端“认”文件计数。
