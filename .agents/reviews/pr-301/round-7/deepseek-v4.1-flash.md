## 结论

第 7 轮增量（`2c46ca42..74b598e4`）和整条 PR（`6cb8405b..74b598e4`）我逐项对照了代码：**没有发现高/中严重度缺陷**，作者列出的第 6 轮意见在代码里基本落实。下面只列低严重度/测试覆盖类问题。

---

## 问题（按严重度从高到低）

### 1. 低：孤儿 `reserved` 场景没有断言“预算分配本身被改成 released”
- 文件:行：`test/integration/sqlite-sandbox-execution-v2.test.ts:1554`
- 问题：`orphan`（非 started）分支只断言了 identity 和预算账户，没有查 `model_budget_allocations`；而 started 分支（同文件 `:1547-1553`）查了。若哪天 `releaseReservedWithinTransaction` 只退了账户预留下来、没把分配改成 `released`，现有测试不会红。
- 证据：
  ```ts
  } else if (orphan) {
    expect(after.models).toEqual([{ status: "released", ... }]);
    expect(after.budgetAccounts).toEqual([{ ..., status: "active", reserved_cost_micros: 0 }]);
  }
  ```
  对比 started 分支有：
  ```ts
  .prepare("SELECT status,reason_code,observed_at FROM model_budget_allocations ...")
  .toEqual([{ status: "unknown", reason_code: "owner_lost", observed_at: now }]);
  ```
- 建议：在 `orphan && modelScenario?.[3] === "reserved"` 分支补一条分配行断言 `{status:"released", reason_code:null}`。

### 2. 低：接手方法自身不校验执行租约是否已不活跃，只靠调用方
- 文件:行：`packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:757`
- 问题：方法只按 `authority_lease_id <> 当前授权租约` 选行，不检查该调用的执行租约已释放/过期，也不检查 Run 状态。目前唯一调用方 `settleExpiredSync` 已有这些前置检查，且方法是 public，将来若被别处直接调用就有误伤活跃调用的可能。
- 证据：选行条件只有
  ```sql
  WHERE ... AND status IN ('reserved','started') AND authority_lease_id <> ?
  ```
  调用方已有保护（我读到的）：
  ```ts
  // sqlite-run-dispatch-operations.ts:418-420
  if (currentLease && currentLease.releasedAt === null && isAfter(currentLease.expiresAt, at))
    return this.fail("PORT_CONFLICT", "Expired Run still has a live execution lease");
  ```
  授权唯一性也确有约束：`sqlite-worker.ts:463-474` 已有活租约时拒绝再领；`:523-537` 续期只改 `expires_at`，不改 lease id，所以同一进程续期不会被误判成孤儿。
- 建议：在 `abandonOrphanedWithinTransaction` 里再确认该 run 没有活跃执行租约（或把方法收窄为私有/仅由 `settleExpiredSync` 调用的内部函数），把“误伤活跃调用”的风险从调用约定变成方法自身保证。

### 3. 低：接手写状态后没有校验 `changes === 1`
- 文件:行：`packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:772`、`:788`
- 问题：UPDATE 带 `AND status='reserved'/'started'`，但没检查实际影响行数。同一 immediate 事务内正常应恰好 1 行；万一状态被别的触发器/写入改掉，会静默出现“预算已动、identity 没动”。本项目这两张表没有触发器，风险很低。
- 证据：
  ```ts
  .prepare(`UPDATE model_invocation_identities SET status='released', released_at=?
    WHERE ... AND status='reserved'`).run(...)
  ...
  .prepare(`UPDATE model_invocation_identities
    SET status='unknown', observed_at=?, reason_code='owner_lost'
    WHERE ... AND status='started'`).run(...)
  ```
- 建议：读取 `.run()` 的 `changes`，不等于 1 时 `this.fail("PORT_CONFLICT", ...)`。

### 4. 低：迁移整表复制进 TEMP 表，可能放大磁盘/内存占用
- 文件:行：`packages/persistence-sqlite/src/migrations/0083_model_invocation_owner_lost.sql:1`
- 问题：`CREATE TEMP TABLE saved_... AS SELECT *` 会把两张表整份复制到 temp store，再加上重建期间的新表副本，峰值接近 2 倍。与既有的 `0049_thread_title_budget.sql` 写法一致，不是本次新引入，但仍是资源耗尽面上值得记录的点。
- 证据：
  ```sql
  CREATE TEMP TABLE saved_model_invocation_identities AS SELECT * FROM model_invocation_identities;
  CREATE TEMP TABLE saved_model_budget_allocations AS SELECT * FROM model_budget_allocations;
  ```
- 建议：保持现状即可；若要收紧，可评估 SQLite 12 步改表法或分表迁移，不必在本 PR 做。

### 5. 低（测试缺口）：`assertCurrentAuthority` 这道新检查没有反向用例
- 文件:行：`packages/persistence-sqlite/test/model-invocation-owner-lost-migration.contract.test.ts:288`
- 问题：直接测试覆盖了“去掉事务检查会失败”和“去掉授权租约过滤会失败”，但没有覆盖“去掉 `assertCurrentAuthority` 会失败”。因为 `settleExpiredSync` 外层已经先调了同样的授权校验，删掉方法内这道检查不会让现有测试红。
- 证据：测试只验证 `:288-290` 事务外抛 `PORT_INVALID_OPERATION`、`:291-301` 同租约调用不改行、`:315-325` 换租约后才接手。
- 建议：若要锁住“方法自身必须核对当前授权”，可加一个调用方授权已过期/被释放时直接调该方法的用例。

---

## 侧重检查

- **错误路径**：`fail` 类型是 `=> never`（`sqlite-durable-operations.ts:104-108`），接手内任一步失败都会把整个 `settleExpiredSync` 的 `.immediate()` 事务回滚（`sqlite-run-dispatch-operations.ts:409-410,561-562`），不会留下半更新的调用/预算。读代码证实。
- **不可信输入**：`abandonOrphanedWithinTransaction` 不经过 `execute()`/IPC 的 JSON 解析，参数都是内部 brand 类型；SQL 全部参数化，`'owner_lost'` 是常量字面量，无注入面。读代码证实。
- **安全/秘密**：该改动不触及提示词、遮盖、工具描述或任何出口内容，没有新增会写日志的敏感值。读代码证实。
- **不可撤销的操作**：`started → unknown(owner_lost)` 之后，正常 `settle` 会因执行租约不匹配而无法再结清（`settleWithinTransaction` 里 `assertExecutionLease`），这是刻意保守。它靠“新授权只能在旧租约释放/过期后领取”+“收尾要求没有活跃执行租约”两道条件避免误伤；但方法本身没再验一次旧租约状态（见问题 2）。读代码证实 + 设计建议。
- **规则/文档与代码一致**：`docs/incidents-and-gates.md` I-88 追加内容与 `RUN_EXPIRED_RECONCILIATION_SQL`、`abandonOrphanedWithinTransaction`、五个诊断码、`SUPPORTED_SCHEMA_MAX=83` 一致；没有找到网页展示或审计脚本枚举模型调用 reason 的地方（`owner_lost` 之外只有 port 类型、迁移和测试引用它），所以“网页展示/审计脚本要同步”这条在本仓库没有实际落点。读代码证实；`.agents/reviews/pr-301/plan-orphaned-model-calls.md` 在工作区不存在，未能核对（未核实）。
- **旧版本兼容**：`sqlite-worker.ts:141-164` 的 `assertCurrentSchema` 在读写 worker 都要求 `current_sequence === writerSequence`，旧二进制无法读 schema 83，因此不会用旧的白名单去解析 `owner_lost`。读代码证实。

---

## 读代码证实的 vs 推测

**读代码证实：**
- 迁移 0083 的两张表定义与上一版重建（0049）逐字一致，唯一差别是 reason_code 列表多了 `'owner_lost'`；索引、外键、CHECK 都保留，数据经 TEMP 表原样搬回（`0083_model_invocation_owner_lost.sql:1-136` vs `0049_thread_title_budget.sql:50-187`）。
- 0082 不涉及这两张表；0049 之后也没有 `ALTER TABLE model_invocation_identities/model_budget_allocations` 加列。
- 迁移前检查 0049 之后无触发器/视图引用这两张表（全库搜 `CREATE TRIGGER/CREATE VIEW` 与表名无交集）。
- 新的 `owner_lost` 能被 `parseRow`/`recordedUnknownReason`（`sqlite-model-invocation-operations.ts:199-204,952-962`）和 `parseAllocation`（`sqlite-model-budget-operations.ts:1305-1313`）读出；port 类型已放宽（`model-invocation.ts:51,97`；`model-budget.ts:121`）。
- 外部入口的 `markUnknown` 解析白名单仍只允许三个原因（`sqlite-model-budget-operations.ts:937-953`、`model-invocation-admission-service.ts:564-571`），但 `owner_lost` 只由内部方法产生，未发现把它回灌到这些入口的路径。
- 接手在收尾的同一个 `.immediate()` 事务内执行，方法自身还检查 `database.inTransaction` 和当前授权（`sqlite-model-invocation-operations.ts:744-797`；`sqlite-run-dispatch-operations.ts:409-475`）。
- `LIVE_MODEL_INVOCATION_SQL` 的 `@authorityLeaseId` 在两个使用 `RUN_EXPIRED_RECONCILIATION_SQL` 的查询里都有绑定（`sqlite-run-dispatch-operations.ts:370-378,442-452`）。

**推测（未实测/未跑测试）：**
- 作者给出的“去掉过滤后新增直接测试失败”“去掉顶层条件时只有四个当前授权场景失败”等，我只读到了对应的断言结构（`model-invocation-owner-lost-migration.contract.test.ts:288-301`、`sqlite-sandbox-execution-v2.test.ts:1636-1663`），按逻辑应当会失败，但没有运行测试验证。
- “同一时间只有一个有效授权”在租约领取主路径有强制（`sqlite-worker.ts:463-474`），但授权转移激活路径我只看到要求服务已停止（`sqlite-authority-transfer.ts:851-854`），没有逐行核实所有写 `authority_leases` 的路径。
- 生产上那条卡住的 run 是否只被新规则命中，需要在生产库只读跑一遍，属于作者未覆盖项。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本次 diff 只改 `packages/application/src/ports/`、`packages/persistence-sqlite/`（迁移/操作/SQL）、`scripts/operations/`、测试和事故文档，没有改系统提示、工具定义、历史消息、遮盖或提示词组装代码。新增的 `owner_lost`、`at`、预算账户状态等都只在 SQLite 内，不会进入任何发给模型的内容。依据 [prompt-prefix.md#rules](../../.claude/rules/prompt-prefix.md#rules)：已发出的内容仍只追加；会变的值仍只放在最后一条消息，本次没有触及这条链路。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会。新增值都是常量（`'owner_lost'`）或数据库内状态；迁移是确定性 DDL；接手查询用 `ORDER BY logical_slot, sequence` 固定顺序（仅影响写库顺序，不影响模型字节）。没有引入依赖前后文的遮盖、时间字段或无序列化到模型的无序集合。

**3. 有没有对应自动检查，反向用例真的会失败吗？**
有：
- 迁移契约测试锁结构/外键/行数据，并验证新原因可写入、乱写被拒（`model-invocation-owner-lost-migration.contract.test.ts:193-248`）。
- 直接测试覆盖“事务外调用被拒”和“同授权租约的调用不被接手、换租约后才接手”（同文件 `:288-325`）；去掉事务检查或去掉 `authority_lease_id <> ?` 过滤都会让它失败。
- 集成测试有孤儿 `started/reserved/epoch` 正向场景，和 `persisted-code-model-started`、`released-model-started` 反向场景（`sqlite-sandbox-execution-v2.test.ts:1476-1575,1636-1663`）。
- 缺口：去掉方法内 `assertCurrentAuthority` 不会让现有用例失败（外层调用方已先校验）；孤儿 `reserved` 的预算分配行没有断言。见问题 1、5。

**4. 每个产生/修改的值，使用方都能接受吗？**
逐个核对：
- `owner_lost`：产生于 `sqlite-model-invocation-operations.ts:786,791` 和预算 `markUnknownWithinTransaction`；迁移 CHECK 接受（`0083:23-24,93-94`）；identity 读取走 `recordedUnknownReason` 接受；allocation 读取走 `parseAllocation` 接受；application port 类型接受；外部 `markUnknown` 解析器拒绝——这是正确的，因为只有内部收尾路径产生它，未发现回灌路径。没有网页/审计白名单需要同步。
- 迁移序号 `83`：`migration-engine.ts:654-660` 已登记；`LATEST_MIGRATION_SEQUENCE` 自动取最后一条；`workspace-lifecycle-audit.mjs:5` 改为 83；`check-audit-schema-range.mjs` 要求二者相等；未发现残留 82。
- `RECORDED_UNKNOWN_REASONS`：只用于读路径，写路径仍用原来的三值白名单。
- 预算账户状态 `reconcile_required`：符合 ADR 0124 的既有语义，`finalize`/`childAllocationState` 已把 unknown 视为需要核对。

---

## 未核实

- `.agents/reviews/pr-301/plan-orphaned-model-calls.md` 在当前检出中不存在，方案文档与代码的逐条对照只做了作者摘要和 `docs/incidents-and-gates.md` 的 I-88 行。
- 无法运行测试、类型检查、lint（本环境只允许 git/read/grep），以上“会失败/会通过”的判断基于读代码。
- 授权转移的所有写入路径未逐行读完（只确认激活要求服务已停止，以及主租约领取路径保证单活租约）。
