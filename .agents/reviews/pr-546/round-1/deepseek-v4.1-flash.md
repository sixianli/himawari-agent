说明：我只读了代码、diff 和文档，没有运行 node/npm，所以作者关于“改后通过、migrations=109”的实测结果标为未核实。

### 1. 高：跳过全部成对检查后，晚合的小编号迁移可能静默失效，出包检查却通过

文件：`scripts/migration-conflicts/analyze.mjs:265-267`、`scripts/migration-conflicts/analyze.mjs:298-310`

问题：`sequential` 时 `pairLimit = 0`，`CONFLICT` 和 `ORDER_DEPENDENT` 两类成对检查全部不执行。函数末尾的 production 对 fresh 检查无法补上：production 是 `base + sorted`，fresh 是 `[...base, ...sorted].sort(按 id)`，待上线迁移在两边都按 id 顺序执行，结果当然相同。作者说“顺序已固定”，但固定的是 id 顺序，不一定等于写迁移时假定的合并顺序；ADR 0265 要防的正是“晚合的小编号迁移”。

证据（读代码证实）：

```js
// analyze.mjs:266
const pairLimit = sequential ? 0 : sorted.length;
for (let i = 0; i < pairLimit; i += 1) {
```

```js
// analyze.mjs:299-303
const production = cloneFrom([...base, ...sorted]);
const fresh = cloneFrom(
  [...base, ...sorted].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  ),
);
```

具体例子（推测，但机制由代码确定）：base 已有表 `t`；A 的 id 较大，执行 `INSERT INTO t VALUES (1)`；B 的 id 较小，执行 `UPDATE t SET v='x' WHERE id=1`，B 是后合并、却拿到更小号的情况。旧实现会跑 `[B,A]` 和 `[A,B]` 两种顺序，发现结果不同并报 `ORDER_DEPENDENT`。新实现只按 `[B,A]` 跑：B 更新 0 行、A 插入，production 和 fresh 完全一致，检查通过，B 的更新在生产和全新库里都静默丢失。

建议：不要全局关闭成对检查。可以只对“能在 base 上独立跑通”的迁移保留成对顺序检查；有依赖的迁移（例如建表后插数据）本来就不能独立跑通，自然不参与，而上面这种两边都能独立跑、但结果依赖顺序的情况仍会被拦下。至少要在 ADR/门槛文档里明确放弃这项检测，并加一条对应的反向用例。

### 2. 中：前一个待上线迁移失败后，下一步在 try 外重放它并抛未捕获异常

文件：`scripts/migration-conflicts/analyze.mjs:196-199`、`scripts/migration-conflicts/analyze.mjs:207-212`

问题：某个迁移执行失败时只 `continue`，没有把它从后续 `stepBase` 里去掉。下一步的 `stepBase = [...base, ...ordered.slice(0, position)]` 仍然包含失败的迁移，而 `snapshotOf(stepBase)` 和 `cloneFrom(stepBase)` 在 `try` 块之外，会再次执行失败的 SQL 并抛出异常。`analyzeMigrations` 原本承诺返回问题数组，这里变成未捕获异常；`check-migration-conflicts.mjs:191-197` 和 `make-packet.py:148-157` 都没有捕获这个异常。结果仍然是拒绝出包（失败关闭），但诊断从清晰的 `MIGRATION_FAILS`/`MIGRATION_CONFLICT` 变成堆栈，且后续迁移的问题都看不到。

证据（读代码证实）：

```js
// analyze.mjs:197-199：try 从 207 行才开始
const stepBase = sequential ? [...base, ...ordered.slice(0, position)] : base;
const stepBaseSnapshot = sequential ? snapshotOf(stepBase) : baseSnapshot;
const database = cloneFrom(stepBase);
```

```js
// analyze.mjs:207-213
try {
  database.exec(entry.sql);
} catch (error) {
  problems.push(`MIGRATION_FAILS ${entry.file}: ${error.message}`);
  database.close();
  continue;
}
```

建议：sequential 下某个迁移失败后 `break` 或直接 `return problems`，因为后面的步骤都依赖它；或者把 `snapshotOf(stepBase)`/`cloneFrom(stepBase)` 也放进 `try` 并转成问题。新增一个“失败迁移后面还有合法迁移”的用例。

### 3. 中低：新增的反向用例没有真正守住 sequential 路径

文件：`test/tooling/migration-conflicts.test.mjs:344-351`

问题：这条用例里的坏迁移是最后一个，触发不到上面第 2 条的崩溃路径；而且 `checkAgainstApplied` 会先调用 `compareOrders`，坏迁移在全量重放时已经产生 `FULL_REPLAY_FAILS`，所以即使 sequential 分析完全失效，这条用例仍然会通过。它没有验证“新的 sequential 分析仍会拒绝坏迁移”，也没有验证“后来的迁移改动/删除前面待上线迁移创建的表但未声明”这种 sequential 才可能出现的新情况。

证据（读代码证实）：

```js
// test:344-351
it("still rejects a pending migration that fails even after the earlier pending ones", () => {
  const kinds = entry("20261114000001", "kinds", "CREATE TABLE kinds (kind TEXT PRIMARY KEY);");
  const broken = entry("20261114000002", "broken", "INSERT INTO missing VALUES ('a');");
  ...
  expect(checkAgainstApplied({ entries: [seed, kinds, broken], applied })[0]).toMatch(
    /^FULL_REPLAY_FAILS no such table: missing/,
  );
});
```

`checkAgainstApplied` 在调用 `analyzeMigrations` 之前先执行 `compareOrders`（`analyze.mjs:402`），后者已经会报 `FULL_REPLAY_FAILS`。

建议：直接对 `analyzeMigrations({ sequential: true })` 断言，或在 `checkAgainstApplied` 返回里过滤出 `MIGRATION_FAILS`。补充：坏迁移后面再放一个合法迁移；后来的迁移无 meta 地修改/删除前面待上线迁移创建的表，必须报 `UNDECLARED_ALTERATION`；带相应 meta 时通过。

### 4. 低：`touched` 在 sequential 下完全没用，`written` 只用于最后的数据比较；每步还重复回放整段前缀

文件：`scripts/migration-conflicts/analyze.mjs:191-192`、`scripts/migration-conflicts/analyze.mjs:197-199`、`scripts/migration-conflicts/analyze.mjs:260-261`

问题：sequential 时 `pairLimit=0`，`touched` 除了第 271 行的成对循环外没有其他使用，因此 `touched.set(...)` 是纯无用计算；`written` 仍在第 305 行用于构造最后比较的数据表集合。关于语义：`written` 每步相对 `stepBase` 计算，取并集后覆盖了所有待上线步骤写过的表；结构比较本身是全量 `sqlite_schema`，所以我没有发现 `written` 在这一用途上的正确性问题。真正的额外成本是 `stepBaseSnapshot = snapshotOf(stepBase)` 和 `database = cloneFrom(stepBase)` 把同一段前缀执行了两遍，既慢，也多了一个跨执行比较的来源。

证据（读代码证实）：

```js
// 197-199
const stepBase = sequential ? [...base, ...ordered.slice(0, position)] : base;
const stepBaseSnapshot = sequential ? snapshotOf(stepBase) : baseSnapshot;
const database = cloneFrom(stepBase);
```

```js
// 214
const diff = diffSnapshots(stepBaseSnapshot, snapshot(database));
```

建议：打开 `database` 后、执行当前迁移前，直接 `const stepBaseSnapshot = snapshot(database)`，删掉 `snapshotOf`；sequential 时不要构造 `touched`。这样每步只回放一次前缀，也消除了两次执行可能不一致的问题。

### 5. 低：作者说明和文档与代码不一致，且新的“批内改动必须声明”没有写进文档

文件：`docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md:141-143`、`docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md:160-171`、`docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md:235`、`docs/incidents-and-gates.md:139`

问题一（读代码证实）：作者说“这 31 个迁移……每个只在生产已应用迁移上单独测”。实际 `checkAgainstApplied` 把 17 个待上线四位号迁移（0079–0095）放进 `base`，只有 14 个时间戳迁移进入 `added`（`analyze.mjs:406-409`）。仓库里 `LEGACY_MIGRATION_COUNT = 95`，时间戳迁移文件我数到 14 个，95+14=109，与作者的 `migrations=109` 对得上；所以“31 个被单独测”不准确，被独立测的是 14 个。`web_push_gate` 依赖 `decision_ledger_kinds` 的情况仍属于这 14 个，修复方向本身没被推翻。

问题二（读代码证实）：ADR 0265 第 141-143 行说打包时会“再跑一遍迁移冲突检查（下一节）”，第 160-171 行描述的是逐个迁移检查和成对顺序检查；现在打包走的是 sequential 变体，成对检查被跳过。文档没有记录这个差异，也没有记录“后来的待上线迁移如果改动前面待上线迁移创建的表，也必须在 meta 里声明 `alters`”这一新增要求（当前 `apple_push` 的 meta 正好声明了 `paired_devices`，所以能过）。

建议：修正作者说明里的 31/14；在 ADR 0265 或事故门槛里补一段“打包时按 id 累积检查、放弃成对冲突检查及原因”，并明确批内改动需要 meta 声明。

## 侧重检查

- 错误路径：发现第 2 条的未捕获异常；坏迁移不在最后时，后续步骤会重放它并崩溃。仍以非零退出拒绝出包，不会误放行，但诊断变差。
- 不合规范/不可信输入：迁移 SQL 来自仓库文件，`FORBIDDEN_STATEMENT` 检查仍在重放前执行（`analyze.mjs:170-179`）；`sequential` 不是 CLI 参数，只由 `checkAgainstApplied` 内部传入；`--applied` 的 `id:digest:name` 解析未改动。没有发现新的输入校验问题。
- 安全：改动只在内存 SQLite 中重放迁移，`foreign_keys=ON`、`ATTACH/VACUUM/load_extension/writable_schema` 禁令未放松；没有新增网络、文件写入或模型请求面。
- 资源耗尽：sequential 每步重放整段 base，复杂度约 O(n²)，且第 4 条指出同一前缀每步执行了两遍。当前 14 个时间戳迁移、109 个文件，作者实测能过；但待上线迁移很多时会更接近 `make-packet.py` 的 300 秒上限。没有发现连接泄漏，正常路径和失败路径都会 `close()`；`snapshotOf` 在 `snapshot()` 抛错时没有 `finally` 关闭，属于很小的健壮性问题。
- 不可撤销操作：没有。脚本只读 git/仓库文件并操作内存库，不写生产库、不写迁移文件。
- 规则/文档与代码一致：见第 5 条。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。`git diff --name-only` 只有 `scripts/migration-conflicts/analyze.mjs` 和 `test/tooling/migration-conflicts.test.mjs`；没有碰系统提示、工具定义、历史消息、遮盖或请求组装代码。因此发给模型的内容仍然只在末尾追加，也没有把每轮会变的值挪到前面。

2. **会不会让同一段文字在不同请求里变成不同字节？** 对模型请求不会。该改动不产生任何上下文相关的遮盖、时间字段或无序集合序列化。检查脚本内部新增的 `ordered` 是按 id 排序的确定顺序；`written`/`snapshot` 只影响检查结果，不进入模型请求。现有迁移 `0087`、`0095` 里的 `strftime('now')` 只在触发器体内，迁移执行时不写入数据，且这些文件本 PR 未改。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 不完整。第一条新用例（依赖允许）在撤掉修复后应当失败，代码逻辑上也成立；第二条“坏迁移仍被拒”不是区分性用例：`compareOrders` 在 `analyzeMigrations` 之前就会返回 `FULL_REPLAY_FAILS`，撤掉 sequential 修复它也会通过。缺少的用例包括：坏迁移后面还有合法迁移（会暴露第 2 条崩溃）、sequential 下后来的迁移改动/删除前面待上线迁移创建的表但未声明、以及带 meta 时应通过。作者“新用例撤掉修复后失败”的说法只对第一条成立，且我未实际运行。

4. **改动产生或修改的每个值，所有使用方都能接受吗？** `sequential` 只新增在 `analyzeMigrations` 的可选参数上，唯一传 `true` 的地方是 `checkAgainstApplied`（`analyze.mjs:409`）；`check-migration-conflicts.mjs` 的非 `--applied` 路径和测试仍走默认 `false`，非 sequential 行为未变。`ordered`、`stepBase`、`stepBaseSnapshot`、`pairLimit` 都只在函数内部使用，没有跨包字段、配置键或清单项，因此不存在 I-73 那种“清单 id 过不了后端校验”的两端契约问题。但 `analyzeMigrations` 的返回契约是“问题数组”，第 2 条的未捕获异常违反了这个契约；`touched` 在 sequential 下没有任何使用方，`written` 的使用方是最后的 `everything` 数据比较，语义基本正确但缺少针对性测试。
