### 1. 低 — 作者说明里“新增测试直接用 git('show')”与最终代码不一致

文件：`scripts/delivery-mode/test_make_packet.py:541-542`；对比 `47acaf251` 与 `e5e12895a`

问题：作者说明称新增测试用 `packet_maker.git('show', 'HEAD:…/0083…')` 走一遍放行，但最终增量已经把该测试改成 `migration_ledger('HEAD', 82, 83)`。作者还称“只改出包脚本和测试”，实际还改了 `docs/adr/0086-generate-release-packets-from-parameters.md:51`。

证据：最终代码是

```python
541:    def test_the_owner_lost_rebuild_is_allowed_through_the_migration_ledger_as_the_packet_maker_reads_it_from_git(self):
542:        self.assertEqual(packet_maker.migration_ledger('HEAD', 82, 83), [{'sequence': 83, 'name': 'model_invocation_owner_lost', 'phase': 'expand'}])
```

而 `git show 47acaf251 -- scripts/delivery-mode/test_make_packet.py` 里的旧版才是：

```python
+        sql = packet_maker.git('show', 'HEAD:' + packet_maker.MIGRATIONS + '/0083_model_invocation_owner_lost.sql')
+        self.assertEqual(packet_maker.rebuilds_keeping_rows(..., sql, tables), tables)
```

建议：把作者说明改成“经 `migration_ledger`，其内部仍用 `git('show', …)` 读文件”，并写明 ADR 也改了。代码本身不需要改。

**读代码证实的**

- `git()` 在 `make-packet.py:86-90` 对文本输出做 `.strip()`；`migration_ledger` 在 `make-packet.py:243` 用 `git('show', …)` 取 SQL，因此旧代码“摘要按原样字节、读取却已 strip”确实永远对不上。
- 旧测试在 `1f378b14a` 里用 `read_text()` 读文件，正文 `test_make_packet.py:529-539` 仍在；旧摘要 `a367…` 能与含结尾换行的原文对上，这与作者的根因解释一致。
- 新代码 `make-packet.py:190` 对 `sql.strip()` 算摘要，常量在 `:185`；正向测试 `test_make_packet.py:533` 用 `read_text()` + 内部 strip，`:542` 用 `migration_ledger` 的 `git('show')` 路径，两条都会在常量写错时失败。
- `preserved_tables()`（`make-packet.py:207-212`）读到模板里的 `historyTables` 确实包含 `model_budget_allocations`、`model_invocation_identities`；迁移 0083 的 `touched` 会命中这两张表，所以新测试不是“空跑”。
- 迁移目录 0001–0095 连续，`0083` 正好是第 83 条；`migration-engine.ts:668` 的 0083 是 `name: "model_invocation_owner_lost", phase: "expand", file: "0083_…sql"`，与测试期望一致。`migration_ledger` 在 `target=83` 时只取前 83 条，不会把 0084 以后算进 `pending`。
- 反向用例仍有覆盖：`test_make_packet.py:538` 追加 `UPDATE saved_model_budget_allocations …` 后三步仍在、对真实表也无额外写，只有摘要检查能把它挡下；删掉摘要检查该用例会失败。
- ADR 0086:51 的“去掉首尾空白后的内容摘要”与 `make-packet.py:190` 一致。
- 增量只碰了 `scripts/delivery-mode/make-packet.py`、`test_make_packet.py`、ADR 和复核记录，没有碰提示词、工具定义、历史组装、遮盖或模型请求代码。

**推测 / 未核实**

- `f268bbd8…` 是否精确等于去除首尾空白后的 SHA-256：受工具限制无法重算。代码里的正向用例会在常量错误时失败，但本轮未执行测试。
- 云端 107 条 unittest 是否全通过：作者声称通过，本轮无法运行。
- 实际出包是否因此不再被 `PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES` 拒绝：取决于出包所用提交的 0083 内容与常量，未在真实出包环境核实。
- 迁移引擎自己也记录 0083 的摘要（`migration-engine.ts:1347` 的 `digest: sha256(sql)`，按未 strip 的文件文本算），与这里的 `ROW_PRESERVING_REBUILDS` 摘要不是同一个值；这是两套用途，ADR 已说明，不构成本次改动的错误。但未来若有人把两者“对齐”，会让放行再次失效。

**侧重检查**

- 错误路径：`git('show', …)` 失败会经 `git()` 抛 `PACKET_GIT_FAILED`（`make-packet.py:88-89`），不会静默放行。
- 不可信输入 / 改写迁移：摘要绑定整个 strip 后文本；改任何非空白内容都会失配，`rebuilds_keeping_rows` 返回 `[]`，`migration_ledger:247-248` 再抛 `PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES`。仅首尾空白变化会被忽略，而首尾空白不改变 SQL 语义，未发现可利用的改写路径。
- 资源耗尽：新增逻辑只对一个已知迁移文件做字符串 strip、SHA-256 和正则匹配，无网络、无循环放大、无外部输入规模失控。
- 不可撤销操作：增量只改出包脚本、测试和 ADR，不执行迁移，不删除数据。
- 规则/文档一致性：ADR 与代码一致；作者说明的测试写法与实际代码不一致，见意见 1。
- `migration_ledger` 的其他校验（迁移文件连续性、未知迁移拒绝、名称与文件对不上拒绝）在 `make-packet.py:215-250`，本轮未发现增量引入的新错误。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。增量只改 `scripts/delivery-mode/make-packet.py`、其测试和 ADR，不涉及系统提示、工具定义、历史消息、遮盖结果或请求组装代码。按 `prompt-prefix.md:27-28、36` 的要求，发给模型的内容仍由原运行时代码决定，本次既没有追加消息，也没有把每轮变化的值放进前面；此项不涉及。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。改动里的 `sql.strip()` 和 SHA-256 都是确定性的，只依赖迁移文件内容；没有时间、随机数、无序集合或上下文相关遮盖。`git('show', 'HEAD:…')` 也随提交固定；测试里的 `HEAD` 不进入模型请求。
3. **有没有对应的自动检查，反向用例真的会失败？** 有。正向用例是 `test_make_packet.py:541-542`，反向覆盖在原 `test_make_packet.py:533-539`，其中 `:538` 是只有摘要检查才能挡住的反例。若把 `.strip()` 去掉而保留新常量，`:533` 会失败；若把常量改回 `a367…`，`:542` 会失败；若删掉摘要检查，`:538` 会失败。测试本身本轮未执行。
4. **每个被改动的值，使用端都能接受吗？** 能。新摘要常量只被 `rebuilds_keeping_rows`（`make-packet.py:189-190`）使用，该端现在按 strip 后文本比较；`rebuilds_keeping_rows` 的两个使用端是 `migration_ledger:245`（SQL 来自已 strip 的 `git()`）和测试 `:533-539`，都能接受。新测试的 `82/83` 被 `migration_ledger` 当作 `current/target`，与连续迁移编号一致；期望的 `{sequence,name,phase}` 正是 `migration_ledger:249` 产出的字段。ADR 的措辞与实现一致。未发现别的配置键、清单项或序列化格式被改动。
