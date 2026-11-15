结论先说：本轮增量（6881cc9..604e684，实质代码提交为 17d49c3b9）没有发现新的高/中严重度错误；上一轮第 1、3 条已按代码改好，第 2 条内容补齐但 ADR 留下旧措辞。另有两处低严重度的说明/测试保真度问题。测试未能在本环境执行，涉及运行结果的地方标“未核实”。

### 1. [低] ADR 0086 仍写“唯一的例外是 0083”，紧接着又写“第二个例外”，前后矛盾
文件:行：`docs/adr/0086-generate-release-packets-from-parameters.md:51`
问题：上一轮第 2 条要求把例外从“只有旧版本”改好。这次确实补上了 `thread_origin`，但保留了“唯一的例外”的旧句，读者仍会先读到“唯一”，随后又读到“第二个例外”。`maintenance/P-readback-design.md:42` 已写“例外只有两处”，`steps/README.md:77` 已写“例外两处”，只有 ADR 的措辞没同步。
证据（亲自读到）：
> 唯一的例外是 `0083_model_invocation_owner_lost.sql`：……第二个例外是 `20261115045512_thread_origin.sql`：……
建议：把“唯一的例外是 0083…”改成“第一个例外是 0083…”或直接改成“例外有两项：……”。

### 2. [低] 材料说 `historyIgnoredColumns` 在 `read-s0-db.mjs` 且是固定值，代码实际在 `maintenance-common.mjs` 按本包台账动态推导
文件:行：`scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:59-63,65,81,109`；`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:787-793`
问题：本轮材料“做法”写“read-s0-db.mjs 新增 `historyIgnoredColumns = { threads: ["origin"] }` 和 `historyRow`”，并说 `make-packet.py` 要求“read-s0-db.mjs 的 historyIgnoredColumns 登记了 origin”。实际 `read-s0-db.mjs` 只有 `historyRow`/`historyDigests(database, ignoredColumns)` 的参数；固定的登记项叫 `addedColumnBackfills`，在 `maintenance-common.mjs`，`historyIgnoredColumns` 由 `migrationExpectedLedger` 动态计算。`make-packet.py:202-207` 解析的也是 `maintenance-common.mjs` 的 `addedColumnBackfills`。按材料理解会误以为所有包都固定忽略 `origin`，恰好是上一轮高严重度问题的形态。
证据（亲自读到）：
> `read-s0-db.mjs:59` `export function historyRow(table, row, ignoredColumns = {})`
> `maintenance-common.mjs:787` `export const addedColumnBackfills = Object.freeze({ thread_origin: ... })`
> `maintenance-common.mjs:793` `export const historyIgnoredColumns = historyIgnoredColumnsFor(migrationExpectedLedger);`
建议：更正 PR/评审材料，写明“例外按本包待补台账动态生效”；代码本身无需改，而且这个动态实现正是上一轮第 1 条的修法。

### 3. [低] 新增“含 thread_origin 台账”的测试不是有效上线包，且没有覆盖 `verify-migrate-fixtures.mjs`
文件:行：`scripts/delivery-mode/test_make_packet.py:556-563`
问题：测试把台账换成含第 57 步 `thread_origin`，但仍沿用 `TWELFTH` 的 `TARGET_SCHEMA=56`/`CURRENT_SCHEMA=56`；真实包含该迁移的包应是 target 57。`verify-fixtures.mjs` 目前不校验“台账条数 = target - current”，所以测试通过；一旦夹具补上这条一致性检查，测试会因构造不合法而失败。另外第 2 轮第 1 条还涉及与 `verify-migrate-fixtures.mjs` 的一致性，本次没有自动跑该夹具，作者提交信息也写了“本机未跑”。
证据（亲自读到）：
> `ledger = json.dumps([{'sequence': 57, ..., 'name': 'thread_origin', 'phase': 'expand'}], ...)`
> `for packet in (self.render(MIGRATION_LEDGER=ledger), self.render()):`
> `result = subprocess.run([... verify-fixtures.mjs ...])`
建议：用 `TARGET_SCHEMA=57`（或直接用 `schema_parameters` 生成参数）渲染；如条件允许，补一个覆盖 `verify-migrate-fixtures.mjs` 的自动检查，或把“未运行”明确记为上线前必须人工确认项。

**上一轮三条意见的核对结果**
- 第 1 条（高）：已改好。`verify-fixtures.mjs:31-32` 现在按 `migrationExpectedLedger` 推导期望值，`:262-263` 分别验证包默认“含台账时跳过 origin、不含时仍报列变更”；新增测试渲染含/不含台账两种包并真跑夹具。旧断言 `historyIgnoredColumns` 必为 `{}` 已删除。
- 第 2 条（低）：内容上已补齐，残留 ADR “唯一的例外”措辞，见第 1 条意见。
- 第 3 条（低）：已改好。断言名与 scope 改成“台账含 thread_origin 时整次上线跳过”，不再写成“只在迁移待补时”。

**读代码证实的关键事实**
- S3、S7、S8 的历史比对都经过 `historyRow`：`run-maintenance.mjs:107-114`（S3）、`:117-151`（S7_DB_STATUS/CONFIG_APPLY）、`:158-175,194-202`（S7_CATALOG_UPGRADE）、`:203-211`（S8）；`readMaintenanceState` 在 `maintenance-common.mjs:928` 把 `historyIgnoredColumns` 传给 `readS0State`，`collectTidyState:740` 也传给 `historyDigests`。S8 的 `verifyHistoryAgainstRecoveryPoint` 调 `compareHistoryRows`，后者在 `:972`（当前库）和 `:979`（S3 参考库）两边都调用 `historyRow`。
- `compareHistoryRows` 提前退出时，`finally { live.return(); }`（`:997-999`）关闭外层生成器；生成器内部是 `for (const row of ...iterate())`，按 JS 的 `IteratorClose` 语义，生成器被 `return/throw` 时会关闭底层 for-of 迭代器。S3 参考库的 `for...of` 在断言抛出时也会关闭自己的迭代器。better-sqlite3 的 `iterate()` 的 `return` 真正释放语句这一点依赖库实现，属推测/未运行验证。
- 回填 UPDATE 不会被现有检查拦下：`historyDigests` 的 `rows` 数不变，`history` 内容忽略 `origin`，`capabilities/authorization/releaseReceipts/integrity/foreignKeys` 都不读 `threads`；S8 也没有别的 threads 行数检查。`make-packet` 的 `touched` 只会落在 `threads`，因为 `think_inbox`/`thread_command_receipts` 只出现在子查询里，且两者不在 `preserved_tables` 中。
- 除维护代码外，没有别处逐行读取 `threads` 做历史比较；`grep` 到的其他 `FROM threads` 都是业务读写或测试。
- 新值/使用端：`historyIgnoredColumnsFor` 返回冻结对象和冻结数组，唯一消费者是 `historyIgnoredColumns`、`readS0State`/`historyDigests`/`compareHistoryRows` 以及 S8 报告字段，均用 `.includes`、`deepEqual` 或 JSON 序列化，没有修改数组的代码；`PACKET_ADDED_COLUMN_BACKFILL_NAME_INVALID` 只在 `make-packet.py:197` 抛出并在测试中断言，没有发现别的允许清单/注册表需要同步；S8 新增的 `ignoredHistoryColumns` 字段只在 `run-maintenance.mjs:211` 写入，未发现下游解析器要求固定字段集。

**推测与残余风险**
- 本轮未执行任何 Node/Python 测试，也未重算 `ADDED_COLUMN_BACKFILLS` 的 SHA-256（工具不允许执行哈希命令）；摘要与迁移文件是否一致只能依赖作者记录和第 546 行的 HEAD 测试，标“未核实”。
- 例外是“整列排除”，因此 `UPDATE` 把哪些 `threads` 回填成 `think` 是否正确，S7/S8 不会发现；这是本 PR 有意接受的例外，不是增量引入的新错，但属于不可撤销数据变更的残余风险。若想降低，可在迁移后加一个只读的“回填值与来源回执关系”计数检查。

**侧重检查**
查过：`make-packet.py` 的摘要/文件名分支与 `refuse` 错误路径；`read-s0-db.mjs`/`maintenance-common.mjs` 的输入过滤与生成器关闭；`run-maintenance.mjs` 的 S0/S3/S7/S8/S9 各阶段；`verify-migrate-fixtures.mjs` 的 M1 迁移夹具；`verify-fixtures.mjs` 的正反用例；`test_make_packet.py` 新增测试；ADR、P-readback、steps README 的一致性；以及 `threads` 的其他逐行读取点。结论：错误路径上新增的文件名检查把原来的潜在 `AttributeError` 变成了明确拒绝，是改进；未发现新的资源耗尽、不可信输入或不可撤销操作方面的代码缺陷，残余风险仅限于上述“整列例外导致回填值不被校验”。

**必答问题**
1. 不涉及。增量只改出包/维护脚本、测试和文档，没有改系统提示、工具定义、历史消息或遮盖逻辑，也没有改任何模型请求组装路径；因此“只在末尾追加、每轮变化值在最后一条消息”的约束不受影响。
2. 不涉及模型请求文本。维护报告里的历史摘要用 `canonicalJson`（键排序）和静态忽略列，新增的 `Set` 去重也保持静态登记顺序，不引入时间或无序集合；只有原本就存在的 `checkedAt: new Date().toISOString()` 等报告时间字段，不属于请求字节。
3. 有自动检查：`verify-fixtures.mjs:28-33,260-268` 覆盖“台账含/不含 thread_origin”和“默认是否忽略 origin”，新增 `test_history_fixtures_pass_in_a_packet_whose_ledger_applies_thread_origin` 会真跑两种渲染包，`test_the_thread_origin_backfill...` 覆盖非法文件名拒绝。按代码推理，若把这些行为改回旧实现，`:30`、`:260`、`:263` 会失败；但本环境未执行，标“未核实”。`verify-migrate-fixtures.mjs` 未纳入自动检查，见第 3 条意见。
4. 已逐个核对：迁移台账 `name=thread_origin` → `historyIgnoredColumnsFor` → `historyIgnoredColumns` → `readS0State`/`historyDigests`/`compareHistoryRows`/S8 报告，所有使用端都能接受冻结数组；`addedColumnBackfills` 的 Python 解析端与 JS 源格式两边的表/列校验一致；新增错误码没有其他注册/校验端；新增报告字段没有下游固定字段集校验。唯一不一致是作者材料对文件位置的描述和 ADR 的旧措辞，见第 1、2 条意见。

本轮查过范围：`git diff 6881cc9..604e684` 的全部增量、其对应的 17d49c3b9 提交、`make-packet.py`、`read-s0-db.mjs`、`maintenance-common.mjs`、`run-maintenance.mjs`、`verify-fixtures.mjs`、`verify-migrate-fixtures.mjs`、`test_make_packet.py` 和 three 份相关文档；未重新通读与本增量无关的旧代码。
