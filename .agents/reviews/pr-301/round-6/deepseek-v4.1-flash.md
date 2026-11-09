## 结论

本轮增量（`af58e6f8..2c46ca42`，15 个文件）**没有发现会阻断合并的高/中严重度正确性问题**。核心判定、写入、迁移和反向用例在代码上能对上；作者关于「迁移登记在 0082 之后」「rebuild 两张表的原因码约束」「测试文件存在」的说法属实。但有一条文档自相矛盾、几处测试/防御缺口，以及一个需要产品确认的行为变化。

作者说法中**未核实**的部分：`.agents/reviews/pr-301/plan-orphaned-model-calls.md` 在本检出中不存在（整个 `.agents/`、`.claude/` 都不在），无法核对方案原文。另外受工具限制我没有运行测试，作者列出的「100 条通过 / 5 个反证」只能按代码推断，不能确认实际执行结果。

---

## 问题清单（按严重度）

### 1. 低：I-88 文档同一格里新旧描述相互矛盾

- **文件**: `docs/incidents-and-gates.md:123`
- **问题**: 同一行前半段仍写「第三种情况……没有 `reserved`、`started` 的模型调用」「这次调用和预算账户保持原样，没有自动对账」；后半段追加的 2026-11-09 段落已改成「只挡当前授权租约名下的调用」「原进程已失去授权的调用……`reserved` 改 `released`、`started` 改 `unknown` 并自动同步预算分配」。两段对同一规则的描述相反。
- **证据**（我读到的新增文字）:
  - `docs/incidents-and-gates.md:123`：「现在收尾规则只挡“当前授权租约名下”的 `reserved`、`started` 调用（三种情况统一用顶层条件……）」
  - 同格旧文：「新增第三种情况：……没有 `reserved`、`started` 的模型调用」「这次调用和预算账户保持原样，没有自动对账」
- **建议**: 把旧段里被取代的两处改为「见下方 2026-11-09 追加」，或直接重写为最终规则，避免读者按旧条件核对代码。

### 2. 低：迁移契约测试没有锁定 CHECK/外键/触发器语义

- **文件**: `packages/persistence-sqlite/test/model-invocation-owner-lost-migration.contract.test.ts:176-214`
- **问题**: 测试只验证了「行内容不变」「外键检查为空」「新原因码可写」「乱写原因码被拒」「索引名列表」。它没有断言重建后仍保留原有 CHECK（状态/时间戳组合、fencing token 一致性等）和外键动作。如果哪天有人重写迁移时漏掉一条 CHECK，这个测试不会失败。迁移本身我逐行比对过，约束是保住的，所以这是测试强度问题，不是当前缺陷。
- **证据**: 新迁移 `packages/persistence-sqlite/src/migrations/0083_model_invocation_owner_lost.sql:106-127` 完整保留了 `model_version`/settled/unknown/released/started_at 及四个 fencing 一致性 CHECK；测试 `:176-214` 没有覆盖这些条件。
- **建议**: 在迁移测试里用一段非法写入（例如 `released` 不带 `released_at`、`started` 不带 `started_at`、fencing token 不一致）证明 CHECK 仍在；或直接比较重建前后 `sqlite_master.sql`。

### 3. 低：orphan 夹具的 fencing token 比当前租约更高，且不覆盖授权代数变化

- **文件**: `test/integration/sqlite-sandbox-execution-v2.test.ts:1239-1257`
- **问题**: 测试把「旧授权租约」的 `token` 设成 `current.token + 1`，但 title 叫 `previous-authority-lease`；真实崩溃场景里旧租约的 fence 应低于/等于当前租约，授权转移还可能带 `authority_epoch` 变化。这个夹具不能验证「按 lease id 而不是按 fencing token 判定」是否必要，也如作者自己所述没有覆盖授权转移（epoch 变化）后的旧调用。
- **证据**:
  - `test/integration/sqlite-sandbox-execution-v2.test.ts:1239-1241`: `const lease = orphan ? { ...current, id: "previous-authority-lease", token: current.token + 1 } : current;`
  - 文档 `docs/incidents-and-gates.md:123` 也承认「授权转移（部署的授权代数变了）后的旧调用没有单独场景」。
- **建议**: 把 orphan 夹具改成低于当前 token，并补一个 `authority_epoch`/deployment 变化、旧租约仍残留 `started` 调用的场景；这也能直接验证判定只看 `authority_lease_id` 是否符合预期。

### 4. 低：`abandonOrphanedWithinTransaction` 是公开方法，自身不校验事务和当前授权

- **文件**: `packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:744-756`
- **问题**: 方法本身不调用 `requireTransaction`，也不调用 `assertCurrentAuthority`，完全依赖被调用的 `budget.releaseReservedWithinTransaction` / `markUnknownWithinTransaction`（它们各自校验）。当前唯一调用点 `settleExpiredSync` 已在外层事务内且先做了 `assertCurrentAuthority`，所以现在安全；但它是 public，未来若被别处直接调用，语义靠隐式约定。另外 `sqlite-run-dispatch-operations.ts:18-19` 新增的 import 与 `sqlite-model-budget-operations.ts:30` 形成双向模块依赖（`run-dispatch ↔ model-budget/model-invocation`），目前只在方法体内使用不会触发 TDZ，但属于新增的初始化期脆弱点。
- **证据**:
  - `sqlite-model-invocation-operations.ts:748-757`: 直接 `SELECT ... authority_lease_id <> ?`，无事务/授权自检。
  - `sqlite-run-dispatch-operations.ts:458-475`: 唯一调用点位于 `settleExpiredSync` 的 `database.transaction(...).immediate()` 内（`:409-410`）。
- **建议**: 给方法加 `this.requireTransaction` 之类的断言，或改成 `private`/通过注入依赖调用，避免未来误用。

### 5. 低（行为变化，需确认）：`RUNTIME_TOOL_RESULT_UNKNOWN` + orphan 调用会提前收尾，跳过工具结果恢复

- **文件**: `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:42-46,60-64`；`apps/agent-service/src/production-run-expiry.ts:72-73`
- **问题**: `SANDBOX_TOOL_RESULT_RECOVERY_SQL` 仍把任何 `reserved/started/unknown` 模型调用都算作「不可恢复」，因此有 orphan `started` 调用时它为 false，第一种情况 `RUNTIME_TOOL_RESULT_UNKNOWN AND NOT (SANDBOX...)` 变成 true；`production-run-expiry` 又允许诊断码为 `RUNTIME_TOOL_RESULT_UNKNOWN` 时在截止时间前收尾。结果：这类运行现在会提前被改为失败，而不会再走工具结果恢复。由于恢复本身的 SQL 也被同一个 orphan 调用挡住，它此前实际上也恢复不了，所以这不是「恢复能力回退」，但属于需要产品确认的取舍（「先恢复结果」还是「先解除卡住」）。
- **证据**:
  - `sqlite-sandbox-tool-result-recovery.ts:42-46`: 恢复判断里的模型调用条件 `model.status IN ('reserved','started','unknown')` 不区分授权租约。
  - `sqlite-sandbox-tool-result-recovery.ts:60-64`: 新第一分支只排 `unknown`，`reserved/started` 仅由顶层当前租约条件挡。
  - `production-run-expiry.ts:72-73`: `if (at < frozen.deadlineAt && ... !== "RUNTIME_TOOL_RESULT_UNKNOWN") return false;`
- **建议**: 在方案/I-88 文档里明确「orphan 调用存在时不尝试恢复，直接失败」；若希望先恢复，需要让恢复 SQL 也只把当前租约的未决调用视为阻塞，并在收尾前先完成恢复尝试。

---

## 读代码证实的 vs 推测

**读代码证实的**

- 迁移 0083 是 0049 两张表定义的忠实复制，仅原因码白名单多了 `owner_lost`：列、CHECK、PK、UNIQUE、三条外键、`STRICT` 全部一致（`0083:5-128` vs `0049:50-176`）；三张索引重新创建（`0083:40-41,130-131`）；数据先存临时表再插回（`0083:1-2,133-136`）。这两张表在全部迁移里没有触发器（grep `CREATE TRIGGER` 未命中它们），因此「触发器遗漏」不存在。
- 0082 是 `gap_case_marks`，不涉及这两张表；0083 也正确登记在 `migration-engine.ts:654-660`，`LATEST_MIGRATION_SEQUENCE` 自动取 83。
- 新原因码 `owner_lost` 的所有写入点：`sqlite-model-invocation-operations.ts:780,785` 与 `sqlite-model-budget-operations.ts` 的 `markUnknownWithinTransaction`；读取点在 `sqlite-model-invocation-operations.ts:199-204,952-956`（`recordedUnknownReason` 含 owner_lost）和 `sqlite-model-budget-operations.ts:1305-1314`（`parseAllocation` 含 owner_lost）。对外写入的解析器仍只允许三个原因（`sqlite-model-invocation-operations.ts:188-197`、`sqlite-model-budget-operations.ts:937-954`），所以外部不能伪造 `owner_lost`，这是有意为之且自洽。
- `RUN_EXPIRED_RECONCILIATION_SQL` 新增的 `@authorityLeaseId` 只有两处执行点，且都绑定了：`sqlite-run-dispatch-operations.ts:370-378`（候选列表）和 `:442-452`（收尾就绪检查）。
- 判定与写入在同一个 `BEGIN IMMEDIATE` 事务里：`sqlite-run-dispatch-operations.ts:409-410` 开启事务，`:458-475` 调用接手，`:476-562` 完成后续写租约/运行/检查点/回执。`abandonOrphanedWithinTransaction` 的 SELECT 与 UPDATE 之间没有其它写入者。
- 生产授权租约 id 是随机 UUID、每次 claim 新建、renew 只改过期时间不换 id（`apps/agent-service/src/production-authority-lifecycle.ts:163-170,415-432`；`packages/persistence-sqlite/src/sqlite-worker.ts:455-537`）。因此「同一进程续期」不会被误判；「多租约」由 `claimLease` 的 live-lease 检查挡住。

**推测/未核实**

- 授权转移/优雅停机时旧进程如果已经把授权租约释放但仍有在途模型调用，会被判成 orphan 并改成 `unknown`。按现有协议收尾要求运行的执行租约已释放/过期，正常路径应已结束在途调用；是否还存在异常窗口我未核实。
- 迁移对大数据量库的临时表复制开销、上线窗口内的影响，我未运行/未测量。
- 作者声称的测试通过数和 5 个反证的实际执行结果，我无法运行验证。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本增量 15 个文件全部是持久化 SQL/TS、迁移、测试和文档；没有任何 prompt 编成、工具定义、历史消息、遮盖器（egress）相关文件被改。新代码只在 `settleExpiredSync`（运行即将终止时）写数据库：身份、预算分配、运行状态、检查点和回执。此后不会再给该运行发模型请求，因此发给模型的内容仍只在末尾追加，本轮变化的 `observed_at`/`owner_lost` 也只留在数据库里，不进入请求。依据 `[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)` 与本 diff 的文件清单核对一致。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会。** `owner_lost` 和 `observed_at=at` 是数据库字段，不进任何模型请求；`ORDER BY logical_slot, sequence` 只用于数据库遍历顺序，不参与请求序列化。本轮没有改动任何「依赖前后文的遮盖、带时间的提示字段、无序集合的序列化」。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有：
- 迁移契约测试：`packages/persistence-sqlite/test/model-invocation-owner-lost-migration.contract.test.ts`（保留行数据、外键检查、owner_lost 可写、乱写被拒、索引存在）。
- 运行时集成场景：`test/integration/sqlite-sandbox-execution-v2.test.ts` 的 6 个新场景（4 个 orphan 接手 + 2 个当前租约不接手）。

按代码推断的反向效果（未实际运行）：
- 去掉顶层 `NOT EXISTS (LIVE_MODEL_INVOCATION_SQL)`：`deadline-code-model-reserved`、`deadline-code-model-started`、`persisted-code-model-started`、`released-model-started` 会满足收尾条件并 resolve `settled:true`，而它们走的是 `else` 分支里的 `await expect(recovery.settleExpired(input)).rejects.toThrow()`（`test/...:1658`），会失败。所以「原进程还活着」的反向用例**会失败**。
- 去掉 `abandonOrphanedWithinTransaction` 调用：4 个 orphan 场景的 `after.models`/`after.budgetAccounts` 断言（`:1525-1567`）会失败。
- **缺口**：没有任何用例会在只删除 `abandon` 里的 `authority_lease_id <> ?` 过滤条件时失败——因为同租约场景在 `ready` 查询阶段就被顶层 SQL 挡住，根本到不了 `abandon`。也就是说，「原进程还活着」测的是顶层 SQL 判定，不是接手方法内部的 lease 过滤。建议补一个直接调用接手方法的用例，或在文档里说明这一层只是纵深防御。

### 4. 每个新值/新标识的使用两端都能接受吗？

- **`owner_lost`（原因码）**: 产生端 `sqlite-model-invocation-operations.ts:780,785`；数据库两处 CHECK 均允许（`0083:23-25,93-95`）；读身份经 `recordedUnknownReason`（含 owner_lost，`:199-204`）；读预算分配经 `parseAllocation`（含 owner_lost，`sqlite-model-budget-operations.ts:1305-1314`）；类型 `ModelInvocationRecordedUnknownReason` 和 `ModelBudgetAllocation["reasonCode"]` 已放宽；外部写入端仍只接受三个原因（刻意拒绝 owner_lost）；控制中心没有按原因码做白名单/映射（grep `owner_lost`/`cancel_unresolved` 未命中前端展示），审计脚本不读这两张表的 reason 列。两端一致。
- **迁移编号 83**: 使用端 `LATEST_MIGRATION_SEQUENCE` 自动派生；`scripts/operations/workspace-lifecycle-audit.mjs:5` 已改成 83；`scripts/check-audit-schema-range.mjs` 会比较迁移目录最大值与 `SUPPORTED_SCHEMA_MAX`；相关契约测试常量与 `minimum_writer_sequence` 期望值都已改为 83（`migration-engine.contract.test.ts:21,525-526` 等）。没有发现仍写死 82 的消费方。
- **`@authorityLeaseId`**: 两处执行者都绑定了（见上）。
- **`abandonOrphanedWithinTransaction`**: 唯一调用方的 scope 形状与 `SqliteModelBudgetScope` 匹配（`sqlite-run-dispatch-operations.ts:464-472`），构造参数顺序与 `SqliteModelInvocationOperations` 构造函数一致（`:404-414`）。

---

## 侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 不可撤销 / 文档一致性）

- **错误路径**: `abandonOrphanedWithinTransaction` 内部任一 `releaseReserved`/`markUnknown` 抛错会让整个收尾事务回滚，运行继续卡住；没有逐行 catch 或日志。可发生的前提是身份/分配状态跨表不一致（正常事务下不应出现），但一旦出现就永久阻断——建议至少记录告警或按行隔离。文件：`sqlite-model-invocation-operations.ts:758-790`。
- **不可信输入**: 接手方法只处理数据库内已校验的行（`parseRow` 校验 status/reason 等），不接受外部 payload；外部 `markUnknown` 解析器仍拒绝 `owner_lost`。OK。
- **安全**: 新增 SQL 全部参数化（`authority_lease_id <> ?`、`reason_code='owner_lost'` 是常量），无拼接用户输入；收尾前已用 `assertCurrentAuthority` 校验当前授权。未见注入或越权路径。
- **资源耗尽**: `SELECT ... WHERE run_id=? AND status IN (...)` 受单个运行的调用数限制；迁移的临时表复制与 0049 同样的模式，迁移引擎每个迁移包在 `database.transaction(...).immediate()` 内（`migration-engine.ts:910-921`），失败可回滚；大库耗时未测量。
- **不可撤销操作**: `started → unknown` 且运行改 `failed` 不可撤销；判据只有 `authority_lease_id` 不同 + 运行执行租约已释放/过期。若存在「旧进程仍在跑但租约已被释放」的窗口，会丢失真实结果（只能记 unknown、不释放预估费用）。这与方案声明一致，但建议在文档里明确该窗口的产品取舍。
- **规则/文档一致性**: I-88 同一格有新旧矛盾的描述（见问题 1）；`.agents` 方案文档不在本检出，未核实；其余代码、迁移、测试与作者描述一致。
