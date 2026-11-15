我先查看改动和相关的规则文件。
### 1. 高：额外的 `DROP TABLE` 目标表不在写操作检查里，会放行会清空历史表的迁移

**文件:行**：`scripts/delivery-mode/make-packet.py:194-200`（关键在 `199`），`make-packet.py:242`

**问题**：`written_elsewhere` 只检查 `ALTER TABLE / UPDATE / DELETE FROM / INSERT / REPLACE INTO`，没有 `DROP TABLE`。对白名单表，只要三段模板存在，`DROP TABLE model_budget_allocations;` 这类语句会留在 `other` 里却匹配不到，`kept` 仍包含该表，`migration_ledger` 不拒绝。白名单文件里如果在 `INSERT ... SELECT *` 之后再 DROP 一次目标表，出包会放行，上线后表为空。`DROP TABLE IF EXISTS` 连 `242` 行的 `touched` 正则都不匹配，更不会进入检查。

**证据**：

```python
199:        written_elsewhere = re.search(r'\b(?:ALTER\s+TABLE|UPDATE|DELETE\s+FROM|INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|REPLACE\s+INTO)\s+"?' + table + r'\b', other, re.I)
200:        if table in allowed and all(re.search(step, sql, re.I) for step in steps) and not written_elsewhere:
```

```python
242:        touched = sorted(table for table in tables if re.search(r'\b(?:ALTER\s+TABLE|DROP\s+TABLE|UPDATE|DELETE\s+FROM|INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|REPLACE\s+INTO)\s+"?' + table + r'\b', sql, re.I))
```

**建议**：不能简单把 `DROP TABLE` 加进 `written_elsewhere`，因为合法迁移本身就有一次 `DROP TABLE <表>`。应改成语句级校验：每个白名单表恰好一次 `DROP TABLE <表>`、一次重建、一次原样 `INSERT`，并拒绝任何额外 DROP；更稳妥的是直接绑定迁移文件内容的 SHA-256（见第 3 条）。当前仓库里的 `0083_model_invocation_owner_lost.sql` 本身没有这个写法，所以本次出包不会被此问题直接影响。

### 2. 高：只判断三段语句“出现过”，不判断顺序、次数和注释，也不检查 `saved_` 临时表被改写

**文件:行**：`scripts/delivery-mode/make-packet.py:194-200`

**问题**：`all(re.search(step, sql, re.I) for step in steps)` 只要求三段文字在文件里出现过；`re.sub` 默认删除所有匹配。因此：

- 三段语句写在 `--` 注释里也算“存在”；
- `UPDATE saved_model_budget_allocations ...`、`DELETE FROM saved_model_budget_allocations ...` 不在 `written_elsewhere` 的检查范围内（它只检查目标表名，不检查 `saved_` 前缀的临时表），可以先改临时表再插回；
- 第二次 `CREATE TEMP TABLE saved_... AS SELECT * FROM ...` 会被 `re.sub` 一起删除，仍算三段齐全，但实际把临时表重建为空，再插回空表；
- 重复的 `INSERT INTO ... SELECT * FROM saved_...` 也会被全部删除，仍算通过。

所以作者说的“原样插回”没有被真正验证。

**证据**：

```python
194:            r'CREATE\s+TEMP\s+TABLE\s+' + saved + r'\s+AS\s+SELECT\s+\*\s+FROM\s+' + table + r'\s*;',
195:            r'INSERT\s+INTO\s+' + table + r'\s+SELECT\s+\*\s+FROM\s+' + saved + r'\s*;',
196:            r'DROP\s+TABLE\s+' + saved + r'\s*;',
198:        other = re.sub('|'.join(steps), '', sql, flags=re.I)
200:        if table in allowed and all(re.search(step, sql, re.I) for step in steps) and not written_elsewhere:
```

**建议**：去掉 SQL 注释后按语句解析，要求每个表严格按“保存 → 删除原表 → 重建 → 原样插回 → 删除临时表”各一次且顺序正确；拒绝任何对 `saved_<表>` 的 UPDATE/DELETE/INSERT，以及重复的 CREATE/INSERT/DROP。若不想写 SQL 解析器，最直接的是绑定该迁移文件的完整字节摘要。

### 3. 中：白名单只绑文件名，不绑迁移内容，改过的同名 0083 也会自动享受放行

**文件:行**：`scripts/delivery-mode/make-packet.py:185`、`189`、`241-244`

**问题**：`ROW_PRESERVING_REBUILDS` 只按文件名查表；`sql` 来自调用者传入的 `commit`（`git show commit:...`）。`require_current_scripts` 只要求该 commit 是 HEAD 的祖先，不要求 0083 的字节是本次审查过的内容。任何包含 `0083_model_invocation_owner_lost.sql` 的提交都会命中例外；结合第 1、2 条，一个改过的同名迁移可以在存在性正则下通过。“限定到这个文件名”成立，“限定到这次审查的迁移”不成立。

**证据**：

```python
185: ROW_PRESERVING_REBUILDS = {'0083_model_invocation_owner_lost.sql': ('model_budget_allocations', 'model_invocation_identities')}
189:     allowed = ROW_PRESERVING_REBUILDS.get(file_name, ())
```

```python
241:         sql = git('show', commit + ':' + MIGRATIONS + '/' + entry['file'])
243:         kept = rebuilds_keeping_rows(entry['file'], sql, touched)
244:         touched = [table for table in touched if table not in kept]
```

**建议**：白名单改成 `(文件名, SQL 的 SHA-256)` 或 `(文件名, 提交)`，例如 `ROW_PRESERVING_REBUILDS = {('0083_model_invocation_owner_lost.sql', '<sha256>'): (...)}`，在 `rebuilds_keeping_rows` 里先核对 `hashlib.sha256(sql.encode()).hexdigest()`。这样才真正只放行这一个文件、这一份内容。

### 4. 中：新增测试只覆盖两种反向写法，未覆盖真实绕过，也未端到端验证 `migration_ledger` 放行 0083

**文件:行**：`scripts/delivery-mode/test_make_packet.py:529-536`；`make-packet.py:243-246`

**问题**：新增用例覆盖了：其他文件名、额外 `DELETE FROM model_budget_allocations`、缺少 `INSERT INTO model_invocation_identities ...`。但没有覆盖：额外 `DROP TABLE model_budget_allocations`、对 `saved_...` 的 UPDATE/DELETE、把三段语句放进注释、重复 CREATE/INSERT、同名但内容被改的 0083。因此测试名里的 “anything else is not” 没有被证明；这些危险写法按当前实现会被放行。另外测试直接调用 `rebuilds_keeping_rows`，没有走 `migration_ledger` 的 `kept` 剔除和拒绝路径，也没有一条“包含 0083 的提交可以让 `schema_parameters` 返回第 83 条 ledger”的端到端用例。

**证据**：

```python
533:        self.assertEqual(packet_maker.rebuilds_keeping_rows(name, sql, tables), tables)
534:        self.assertEqual(packet_maker.rebuilds_keeping_rows('0099_other.sql', sql, tables), [])
535:        self.assertEqual(packet_maker.rebuilds_keeping_rows(name, sql + '\nDELETE FROM model_budget_allocations;', tables), ['model_invocation_identities'])
536:        self.assertEqual(packet_maker.rebuilds_keeping_rows(name, sql.replace('INSERT INTO model_invocation_identities SELECT * FROM saved_model_invocation_identities;', ''), tables), ['model_budget_allocations'])
```

**建议**：至少补上第 1、2 条中的反向用例；再加一个用 `git show` 读取目标提交的 0083 的端到端用例，以及一个“同名文件内容被改”的用例。测试已通过 `package.json:51` 的 `check:delivery-packet` 接入检查，补上后才会真正守住这个放行口。

### 5. 中：ADR 0086 仍写着“改写历史表的迁移出包时拒绝”，与新增白名单例外不一致

**文件:行**：`docs/adr/0086-generate-release-packets-from-parameters.md:51`；`scripts/delivery-mode/make-packet.py:185-202`

**问题**：ADR 0086 明确写着迁移文件如果改写要保留的历史表，出包时就拒绝，因为需要人另外设计核对方法。现在代码对 0083 开了例外，但文档没有记录这个例外、适用范围和替代核对方法（迁移合同测试 + S7/S8 历史比较 + `deploy.sh` 自动回滚）。后来的人会按 ADR 以为所有改写都会被拒，或者不知道这个例外需要同样严格的核对。

**证据**：

> `docs/adr/0086-generate-release-packets-from-parameters.md:51`：迁移文件如果改写这些要保留的表（例如给历史表加列），出包时就拒绝（`PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES`），因为那需要人另外设计核对方法。

```python
185: ROW_PRESERVING_REBUILDS = {'0083_model_invocation_owner_lost.sql': ('model_budget_allocations', 'model_invocation_identities')}
```

**建议**：在 ADR 0086 补一段例外说明，写清只针对 `0083_model_invocation_owner_lost.sql`、只针对这两张表、替代核对是迁移合同测试和 S7/S8 历史摘要比较，并建议同时绑定内容摘要。若本次约束不允许改文档，至少在常量旁加注释，说明例外的边界和补偿检查。

**侧重检查**

- 错误路径：`rebuilds_keeping_rows` 对非白名单文件、空 `touched`、缺少任一步骤都返回空列表，不会崩溃；白名单表若不在 `preserved_tables()` 中则例外不生效。这部分没有发现新问题。
- 不可信/不合规范输入：迁移 SQL 来自 `git show`，被当作纯文本匹配；注释、重复语句、临时表改写都能影响判断（第 2 条）。这是本次最实质的风险。
- 安全：改动没有新增子进程、网络或密钥处理；表名来自 `preserved_tables()` 的 `[a-z_]+`，拼进正则不会造成注入；commit 在 `resolve_commit` 里有 40 位十六进制校验。没有发现新的安全漏洞或 ReDoS。
- 资源耗尽：每个迁移只做有限次正则匹配，输入是单个 SQL 文件，没有无界循环；不构成资源耗尽风险。
- 不可撤销操作：0083 会 DROP 并重建两张历史表。真正的自动回滚在 `deploy.sh:87-99`（任一步失败调用 `rollback.sh`），不是 S7 脚本自己；S7 脚本本身在 `S7-switch-start-readback.py:355` 打印 `rollbackPerformed: False`，S7 只负责比较并抛错。作者“自动回滚”的结论成立，但归因到 S7 不准确。生产行数 1425/1400、rowid 连续、31 个待上线迁移只有 0083 触发，这些都没有仓库证据，未核实。
- 规则/文档一致性：`ADR 0086:51` 与新增白名单不一致（第 5 条）；`prompt-prefix.md` 与本次改动无关。

**读代码证实的**

- 当前 `0083_model_invocation_owner_lost.sql:1-136` 确实只有保存、删除、重建、插回、删除临时表，没有额外写操作；三段模板都能匹配，按现有正则会被放行。
- 白名单文件名与迁移引擎的 `migration-engine.ts:668` 一致；两个表名与 `packet-template/s0-db/read-s0-db.mjs:28-29` 的 `historyTables` 一致。
- `kept` 的唯一使用处是 `make-packet.py:243-244`；ledger 的 `sequence/name/phase` 由 `maintenance-common.mjs:782/809` 和 `verify-migrate-fixtures.mjs:141` 消费，0083 的引擎值是 `83 / model_invocation_owner_lost / expand`，格式上两端能接受。
- 第 1、2 条中的匹配行为是从 `make-packet.py` 的正则和 `re.sub` 语义直接读出的；本轮没有运行测试或出包脚本，实际执行结果未核实。

**推测与未核实**

- 生产当前是 52 左右、待上线 31 个迁移、只有 0083 触发：未核实，需要生产只读读回或实际出包日志。
- 生产两张表的行数、rowid 连续、无进行中调用：未核实，仓库里没有生产数据。
- Andy 2026-11-15 的同意原话：未核实，材料里只有转述。
- 一个修改过的同名 0083 是否真的会进入出包：取决于构建所用提交；这是推测出的攻击/事故路径，不是当前生产事实。
- 新增的 `.agents/reviews/pr-547/briefs/brief-round1.md` 在本次复核环境中不可读（路径被限制），其内容未核实；它不是产品发给模型的内容。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 本次 diff 只改出包脚本和它的测试（另有一个复核 brief 文件），没有改系统提示、工具定义、历史消息、出口遮盖或任何提示词组装路径。发给模型的内容仍然只在末尾追加；改动没有新增任何每轮会变、且放在最后一条消息之外的值。`MIGRATION_LEDGER` 是出包产物，不进入模型请求。

2. **不会让同一段文字在不同请求里变成不同的字节。** 改动没有时间、随机数、无序遍历或依赖前后文的遮盖；`touched` 先排序，`kept` 按 `touched` 顺序生成；白名单只用于确定性查表。出包生成的 ledger 顺序也由待应用迁移顺序决定，不涉及模型请求序列化。

3. **有自动检查，但反向用例不完整。** `npm run check:delivery-packet` 会运行 `test_make_packet.py`（`package.json:51`），新增的三条反向断言按代码逻辑会按预期失败。但它们只覆盖“其他文件名、额外 DELETE、缺少 INSERT”；第 1、2 条里的额外 DROP、临时表改写、注释隐藏、重复语句、同名内容修改都没有反向用例，按当前实现会被错误放行。也没有 `migration_ledger` 端到端放行 0083 的测试。本轮不能运行测试，执行结果未核实。

4. **字面值的两端能对上，但内容没有绑定。** `ROW_PRESERVING_REBUILDS` 的文件名与 `migration-engine.ts:668` 的 `0083_model_invocation_owner_lost.sql` 一致；两个表名与 `read-s0-db.mjs:28-29` 一致；唯一消费者是 `make-packet.py:243-244`；ledger 的 `sequence/name/phase` 与迁移引擎和 `maintenance-common.mjs:782/809` 的校验一致。也就是说，格式和取值不会被下游拒绝。真正的问题不是两端校验不匹配，而是白名单只绑文件名、不绑内容，且放行器只做存在性正则，导致“这个文件”可以被改写成不安全的迁移仍然通过（第 1、2、3 条）。
