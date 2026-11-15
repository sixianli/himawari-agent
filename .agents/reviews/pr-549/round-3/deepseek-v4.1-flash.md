**总体判断：** 核心修复方向正确：`git()` 读出的 SQL 已去掉首尾空白，旧摘要必然对不上；改成对 `sql.strip()` 取摘要并使用新值后，出包路径可以重新放行 0083。未发现高、中严重度问题，以下两条为低风险意见。

### 1（低）新测试没有走真正的出包路径，清单或 touched 推导变化时会漏报

文件：`scripts/delivery-mode/test_make_packet.py:541-544`、`scripts/delivery-mode/make-packet.py:232-248`

问题：新测试直接调用 `rebuilds_keeping_rows`，并把 `tables` 写死为两个表名；真正出包时 `tables` 来自 `preserved_tables()`，`touched` 由第 244 行的正则从 SQL 推出。若以后 `historyTables` 或该正则变化，新测试仍会通过，但 `migration_ledger` 仍可能报 `PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES`。

证据：

```python
542:        sql = packet_maker.git('show', 'HEAD:' + packet_maker.MIGRATIONS + '/0083_model_invocation_owner_lost.sql')
543:        tables = ['model_budget_allocations', 'model_invocation_identities']
544:        self.assertEqual(packet_maker.rebuilds_keeping_rows('0083_model_invocation_owner_lost.sql', sql, tables), tables)
```

```python
232:    tables = preserved_tables()
244:        touched = sorted(table for table in tables if re.search(...))
245:        kept = rebuilds_keeping_rows(entry['file'], sql, touched)
```

建议：增加一个经 `migration_ledger` 或 `schema_parameters` 的用例，例如在 mock 掉 `check_migration_replay` 后，用 `migration_ledger('HEAD', 82, 83)` 断言不再抛出 `PacketError`；或至少用 `preserved_tables()` 生成 `tables`，不要手写。

### 2（低）摘要不再是逐字节绑定，`strip()` 的语义与文档里的“内容摘要”不完全一致

文件：`scripts/delivery-mode/make-packet.py:185-190`、`scripts/delivery-mode/test_make_packet.py:542`

问题：放行条件现在忽略文件首尾空白。对 0083 来说，只改首尾空白不会改变任何 SQL 语句，因此不会执行额外 SQL；但“摘要绑定整个文件内容”的说法不再严格成立，严格说是“去掉首尾空白后的内容”。另外，新测试读到的 `sql` 已经先被 `git()` 第 90 行 `.strip()` 过，所以这条新测试本身不能区分“函数内的 `strip()` 是否必要”；真正守住函数内 `strip()` 的是第 529-539 行的 `read_text()` 用例。

证据：

```python
190:    if hashlib.sha256(sql.strip().encode()).hexdigest() != digest:
```

```python
 90:    return child.stdout if binary else child.stdout.decode().strip()
```

建议：若目标是严格绑定文件字节，可对 `git('show', ..., binary=True)` 的原始字节取摘要，避免依赖 `strip()`；若接受空白归一化，至少把 ADR 0086 第 51 行的“内容摘要”改成“去掉首尾空白后的摘要”，避免后来的人误以为它与原文件逐字节绑定。

## 侧重检查

- **不可信或改写的迁移输入：** 读了 0083 全文和 `rebuilds_keeping_rows` 的步骤正则。只有整段内容摘要匹配后才检查“存一份、删除、重建、插回”；追加 `DELETE`、`DROP`、`UPDATE`、删除 `INSERT` 都会改变摘要，被拒绝。只改首尾空白会放行，但这类改动对 0083 不能引入额外语句。
- **错误路径：** 摘要不符时返回 `[]`，随后第 247-248 行 `refuse('PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES', ...)`，没有吞掉错误；`git()` 失败也会抛 `PacketError`（第 86-90 行）。
- **资源耗尽：** 摘要在正则之前计算，不匹配就提前返回；正则使用的表名来自固定的模板清单和常量，迁移文件很小，没有明显的 ReDoS 或内存放大入口。
- **不可撤销操作：** 该检查只决定能否出包，本身不执行迁移。源码包由 `create_bundle` 固定到同一 `commit`，并校验 bundle heads 等于该提交（`make-packet.py:843-853`），因此执行迁移的源码与校验摘要的提交是同一个。
- **安全与秘密：** 改动只涉及公开文件的内容摘要，没有新增密钥、令牌或日志泄漏。
- **规则与文档一致性：** `docs/adr/0086-generate-release-packets-from-parameters.md:51` 仍说“内容摘要…摘要对不上就仍然拒绝”，没有写死旧摘要值，因此不会因 `a367…` 改成 `f268…` 而过期；唯一措辞差异是上面第 2 条说的“逐字节”与“忽略首尾空白”。
- **模型请求规则：** 改动不涉及提示词、工具、历史或遮盖路径，见必答问题 1。

## 读代码证实的

- 本次 diff 只改了 `scripts/delivery-mode/make-packet.py`、`scripts/delivery-mode/test_make_packet.py`，以及一份复核简报；没有改产品代码、提示词目录、迁移文件或 `deploy.sh`。
- `ROW_PRESERVING_REBUILDS` 的新摘要为 `f268bbd8…`，第 190 行改为对 `sql.strip()` 取 SHA-256。
- 0083 最后只在 `a57fffb76` 被修改过；仓库内所有包含它的提交看到的内容相同，所以换提交不会改变摘要。
- `migration-engine.ts:663-669` 的 83 号迁移文件名为 `0083_model_invocation_owner_lost.sql`，与摘要表的键一致；第 240 行还会校验文件名与序号、名字一致。
- `read-s0-db.mjs:28-29` 的保留表清单包含 `model_budget_allocations` 和 `model_invocation_identities`，与摘要表的 `allowed` 两端一致。
- `rebuilds_keeping_rows` 在整个仓库只被 `make-packet.py:245` 和测试调用；该摘要值没有写入参数文件或清单。

## 推测与未核实

- **未核实摘要值本身：** 本环境只允许只读 git 命令，无法复算 `sha256(strip(0083))` 是否确为 `f268bbd8…`。若这个值不对，新测试会失败；作者提交说明称本地测试通过。
- **未运行测试：** 没有执行 unittest，也没有跑 `git show` 之外的命令；关于“旧代码下新测试失败”的结论是按代码推断的。
- **Unicode 空白差异（推测）：** Python 的 `str.strip()` 会去掉一些 Unicode 空白，而 SQLite 的 SQL 词法分析通常只把 ASCII 空白当空白。若把这类字符加在 0083 首尾，摘要会忽略它们，但 SQLite 更可能报语法错误；即使如此，也只能让迁移失败，不能借此执行额外 SQL，属于失败关闭。
- **未来迁移改动：** 如果以后合法修改 0083，摘要和测试会一起失效，需要人工更新；这正是当前门禁的预期行为。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 改动只在出包脚本和测试里；系统提示、工具定义、历史消息、遮盖结果和每轮变化值都没有被触碰。发给模型的内容仍由原有代码只在末尾追加，本改动没有新增请求字段或请求头内容。依据 `prompt-prefix.md:34-37` 和 `prompt-prefix.md:53`。
2. **不会让同一段文字在不同请求里变成不同字节。** 新引入的只有确定性的 SHA-256：`strip()` 是确定性的，摘要表是常量，`touched` 在调用处已排序（`make-packet.py:244`），没有时间戳、随机数或依赖字典遍历顺序的输出；摘要也不发送给模型。
3. **有自动检查，且反向用例基本有效，但不是完整生产路径。** 新正向用例在 `test_make_packet.py:541`；反向用例在 `test_make_packet.py:535-539`，若去掉摘要检查，这些“应返回空”的用例会失败。对基准提交的旧代码（旧摘要加未 `strip`）新用例会失败；但若只回退第 190 行的 `strip()` 而保留新摘要，新用例仍会通过，因为 `git()` 已经 strip，只有第 530 行的 `read_text()` 用例会失败。新用例也没有经过 `migration_ledger`，见意见 1。
4. **摘要值的两端目前一致，未发现 I-73 式错配。** 产生处是 `make-packet.py:185` 的常量，使用处只有第 189-190 行的查找和比较，再经第 245 行进入门禁；文件名与 `migration-engine.ts` 的 83 号条目一致，允许的表名与 `read-s0-db.mjs` 的保留表清单一致。该值没有被序列化进其他清单或参数文件，因此没有第二套校验需要同步。唯一未核实的是摘要字面值是否确实对应 strip 后的 0083 内容。
