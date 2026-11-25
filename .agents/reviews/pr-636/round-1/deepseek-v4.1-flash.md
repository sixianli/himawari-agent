我已按基准 `011f580`..`83f243a` 对照读过测试、迁移引擎和两条相关迁移。改动只有 `test/integration/memory-numbers.test.ts` 一个文件，没有生产代码改动。

## 结论

没有发现会出错的问题；作者三条说法逐条与代码一致。该做法也比旧写法更贴近真实升级顺序，并且和仓库里其他迁移合同测试的“按 sequence 取前缀”写法一致。

## 读代码证实的

- `git diff` 确认只改了 `test/integration/memory-numbers.test.ts:117-125`，生产代码、迁移 SQL、提示词和文档都没动。
- `loadBundledMigrations` 确实按排序后的位置分配序号：`packages/persistence-sqlite/src/migration-engine.ts:1365` 先按 id 排序，`:1371` 用 `legacy.length + index + 1` 作为 `sequence`。
- `validateDefinitions` 强制 `sequence === index + 1`，否则抛 `Expected migration sequence ...`：`packages/persistence-sqlite/src/migration-engine.ts:836-843`。所以旧写法从中间删掉一条必然制造序号缺口。
- 当前共有 95 条 legacy（最后一条是 `0095_correction_propagation`，见 `migration-engine.ts:747-753`）加 23 个时间戳迁移，共 118 条；`20261124205713_memory_numbers` 是倒数第二条，最后一条是 `20261124212416_main_thread`。旧写法删掉 numbers 后，main_thread 在原位变成 index 116，但 `sequence` 仍是 118，因此会报 `Expected migration sequence 117, received 118`，与作者说法一致。
- `applyMigrations` 用已有 ledger 的 id 集合过滤 pending（`migration-engine.ts:1103-1107`），并比较 `currentSequence` 与快照（`:1114`）。新测试取的是连续前缀，ledger 序号 1..116 连续，随后补 117、118，`validateLedger` 的 `record.sequence === index + 1`（`:972-980`）能通过；prefix 的 id/name/phase/digest 也都能在完整迁移定义里找到（`:981-1003`）。
- `20261124205713_memory_numbers.sql:16-19` 的编号来自 `ROW_NUMBER() OVER (... ORDER BY COALESCE(recorded_at, updated_at), id)`，插入顺序不影响结果；`:24-34` 的触发器给新记忆继续编号，测试 `memory-new === 4` 能覆盖这一点。
- `20261124212416_main_thread.sql` 只建 `main_threads`、给 `thread_messages` 加列、更新 `threads.origin`，不碰 `memory_records`；`recorded_at`（`0053_memory_episodes.sql:1-2`）、`category`/`valid_to`/`superseded_by`（`0052_memory_engine.sql:1-5`）都在前缀之内，所以先跑前缀再 `insertMemory` 不缺列。
- 其他迁移合同测试（如 `packages/persistence-sqlite/test/proactive-received-at-migration.contract.test.ts:30`）也是按 `sequence <= N` 取前缀，而不是删中间一条，说明新写法符合既有约定。

## 推测

- 没有运行测试（复核限制）。根据上面的代码推导，旧写法在基准提交上会因 `validateDefinitions` 抛错而失败，新写法应通过；作者“改前失败、改后 3 条全过”的运行结果未现场核实。
- 若未来在 numbers 之前新增迁移，`numbersAt` 会跟着变，前缀仍然连续，测试应继续成立；若 numbers 迁移文件被改名或 id 写错，`findIndex` 返回 -1，`expect(numbersAt).toBeGreaterThan(0)` 会失败，能拦住。

## 侧重检查

- 错误路径/不合规输入：`NUMBERS_MIGRATION` 不存在时 `findIndex` 为 -1，`toBeGreaterThan(0)` 会失败；为 0 时（没有前缀可先跑）也会失败，守卫方向正确。
- 不可信输入：测试数据都是固定常量，没有外部输入进入迁移或断言。
- 资源耗尽：每条迁移只应用一次，前缀加剩余等于完整列表，没有重复应用；临时目录在 `afterEach` 清理。成功路径在 `memory-numbers.test.ts:150` 关闭数据库。失败路径（断言先失败）不关闭数据库，这是该测试原有的模式，不是本次新引入。
- 不可撤销操作：只在临时 SQLite 上执行迁移和写入，不触碰生产库。
- 规则/文档一致性：没有改 `docs/`、迁移文件或 `AGENTS.md` 指向的规则；测试没有写死迁移数量，符合 `.agents/instructions/migrations.md:9` 的要求。提示词规则未被触及。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在测试里调整临时数据库先应用哪些迁移；不涉及系统提示、工具定义、历史消息、资料块或遮盖。发给模型的内容没有变化，仍然只在末尾追加，每轮会变的值仍只能在最后一条消息里。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增的临时目录、快照 `verifiedAt`、迁移 `applied_at` 等只存在于测试进程，不进入模型请求；测试里也没有新增依赖前后文的遮盖或无序集合。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：这条集成测试本身检查了迁移前表不存在、既有记忆按 `recorded_at` 编号、新记忆继续编号。反向方面，若退回“删中间一条”的旧写法，`validateDefinitions` 会抛序号缺口错误；若 numbers 迁移缺失，`expect(numbersAt).toBeGreaterThan(0)` 会失败。具体运行结果未核实，属按代码推导。
4. **改动产生或修改的每个值，使用方都能接受吗？** 本次没有新增生产标识、字段、配置键或序列化格式。测试里用到的迁移 id `20261124205713` 与文件名一致；前缀 ledger 的 id/name/phase/digest 能被完整迁移列表的 `validateLedger` 接受；补跑时的序号 117、118 与 `validateDefinitions` 的位置序号一致；快照的 `schemaSequence=116` 和 fingerprint 由同一数据库生成，能被 `verifySnapshot` 接受。未发现两端校验不一致。
