## 一、读代码证实的发现（按严重度从高到低）

### 1. 中｜“损坏快照跳过”只挡住了 JSON 语法错误，结构损坏仍会让整个导出 500
- 文件：`apps/agent-service/src/production-gap-export.ts:109-118`、`35-60`
- 问题：`try/catch` 只包住 `JSON.parse`。只要快照是“合法 JSON 但结构不对”（例如 `null`、`{}`、缺 `weekEnd`/`museAt`），后面的 `gapBacklogPrefill` 会抛异常：`jstDay` 用 `Date.parse(undefined)` 得到 `NaN` 再 `toISOString()`，或 `snapshot.museTitle` 对 `null` 取属性。整条导出因此 500，与 ADR 0187 第 7 条“某条标记的快照损坏时跳过该条，不让整个导出失败”不符。
- 证据：
  - `production-gap-export.ts:113-117`：
    ```ts
    let snapshot: GapCaseSnapshot;
    try {
      snapshot = JSON.parse(text) as GapCaseSnapshot;
    } catch {
      continue;
    }
    ```
  - `production-gap-export.ts:35-36`：
    ```ts
    const jstDay = (iso: string) =>
      new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString().slice(0, 10);
    ```
  - 反例测试只用了非法 JSON：`test/integration/gap-cases.test.ts:457` 的 `text: "{not json"`。
- 另外：`seal.open` 本身在 `unprotect` 失败或 UTF-8 解码失败时会抛异常（`packages/application/src/services/proactive-seal.ts:28-34`），现在也不在 `try` 内。密钥轮换或任一载荷损坏同样会拖垮整份导出。
- 建议：把“读取 + 解析 + 校验 + 生成 prefill”整段放进逐条 `try/catch`，或先把快照按一个显式 schema 校验（字段类型、枚举、时间格式）再使用；补一条 `"null"` 或 `"{}"` 的反向用例。

### 2. 中低｜标记/取消标记/清除时快照的生命周期在失败路径上会泄漏
- 文件：`apps/agent-service/src/production-observation.ts:317-329`、`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:528-563`、`apps/agent-service/src/production-muse-intake-control.ts:170-173`
- 问题：
  1. 取消标记：`gapUnmark` 先在事务里删行，返回 ref，再由调用方 `release`。若 `release` 失败，行已删、快照还在，用户无法再通过界面或“清除 Muse 数据”找到它（`clearAll` 只查 `gap_case_marks`），Muse 文字被永久留在载荷库。作者说“超出范围”，但这是数据保留/隐私问题，不只是资源浪费。
  2. 标记：`seal.seal` 成功后才 `marks.mark`；若 `marks.mark` 抛异常，`ref` 不会被释放，同样留下含 Muse 文字的孤儿快照。
  3. `clearAll` 先提交删除再返回 refs 给调用方释放；释放失败时整批快照成为孤儿。
- 证据：
  - `production-observation.ts:317-320`：
    ```ts
    const ref = await marks.unmark({ ...scope, caseId: payload.caseId });
    if (ref !== null) await seal.release({ ...scope, refs: [ref] });
    ```
  - `production-observation.ts:327-329`：
    ```ts
    const ref = await seal.seal({ ...scope, text: JSON.stringify(snapshot), at });
    const added = await marks.mark({ ...scope, caseId: payload.caseId, snapshotRef: ref, at });
    if (!added) await seal.release({ ...scope, refs: [ref] });
    ```
  - `sqlite-muse-intake-operations.ts:558-563` 返回 mark refs，释放发生在事务外。
- 建议：标记失败时 `try/catch` 释放；取消标记改为“释放成功后再删行”，或记录一个待释放 outbox，失败可重试；`clearAll` 同样用 outbox/重试，避免“数据库已清、载荷未清”。

### 3. 中低｜`readGapCandidates` 没有数量上限，且对每行都解析 `decision_ledger.inputs`
- 文件：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:487-537`
- 问题：查询没有 `LIMIT`，一次返回窗口内所有 Muse 条目，并在 `rows.map` 里对每一行 `JSON.parse(inputs)`；周报读取和每次标记都会重算一次。Muse 推送是外部输入（单批 100 条、限流 30 批/分钟，按周累加仍可能很大），数据量可导致 CPU/内存放大。作者说超出范围，但这是本 PR 新增的读取路径。
- 证据：
  ```ts
  const rows = this.database.prepare(`... ORDER BY e.muse_at, e.id`).all(...)
  return rows.map((row) => {
    const inputs = JSON.parse(String(row["inputs"])) as DecisionInputs;
  ```
- 建议：加 `LIMIT`（按 `muse_at,id` 截断，或先按邮件去重/分组后再取前 N）；若差距线也要全量，至少给候选读取设硬上限并在达到上限时记录日志。补一条“大量候选”的测试，断言有界。

### 4. 低｜“清除 Muse 数据”的新行为没有同步到界面文案
- 文件：`apps/control-center/src/i18n/resources/zh-CN.ts:1059-1063`（`en.ts:1132-1137`、`ja.ts:1127-1132` 同样）、`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:528-535`、`docs/adr/0187-weekly-gap-lines-and-cases-against-muse.md:47`
- 问题：本次新增的 `clearAll` 会无条件删除 `gap_case_marks` 并释放快照，也就是已点过“加入 Backlog”的案例会从导出里消失，且不可撤销；但确认文案仍只说“删除自动收到的 Muse 条目和对它们的评价”，没有提“已加入 Backlog 的标记也会被取消”。这是不可撤销操作，用户无法预期。
- 证据：
  - `zh-CN.ts:1060-1062`：`"清除 Muse 数据"` / `"删除自动收到的 Muse 条目和对它们的评价；手动录入的 Muse 对照不受影响。"` / `"确定清除所有自动收到的 Muse 条目和对它们的评价吗？这不能撤销。"`
  - `sqlite-muse-intake-operations.ts:533-535`：
    ```ts
    this.database
      .prepare("DELETE FROM gap_case_marks WHERE owner_id = ? AND agent_id = ?")
      .run(input.ownerId, input.agentId);
    ```
- 附带一个边界：删除标记是无条件的，而 `muse_reference_entries` 只删 `intake_item_key IS NOT NULL` 的行；若将来有“手动录入”的 Muse 条目也能生成案例，会出现“手动对照还在、它的 Backlog 标记被清掉”的情况。
- 建议：更新三语文案，明确“已加入 Backlog 的标记和导出条目也会删除”；若希望保留手动对照的标记，标记删除也要按来源过滤。

### 5. 低｜新增的连续性修正测试不能证明 `corrected` 与 Newcombe 方法 10 一致
- 文件：`packages/calibration/test/gap-lines.unit.test.ts:115-122`、`packages/calibration/src/index.ts:426`
- 问题：新测试 `pairedDifferenceInterval(1, 9, 9, 1)` 的 `difference` 恰好是 0，且完全对称；“区间包含差值”几乎对任何公式都成立，改不改 `corrected` 都会通过。它也没有覆盖 `e > n/2` 的正相关分支。因此作者“已对照 Newcombe 1998 方法 10”的说法，代码和测试都没有给出可复核的证据。
- 证据：
  - `index.ts:426`：`const corrected = e > n / 2 ? e - n / 2 : e >= 0 ? 0 : e;`
  - 测试只断言 `low <= difference <= high` 和宽度 > 0（`gap-lines.unit.test.ts:119-121`）。
- 结论：这是“验证不足”，不是已确认的公式错误；我未能上网核对原文，无法判定这个对负相关不修正、对正相关减 `n/2` 的写法是否真的就是方法 10。
- 建议：用论文中至少一个公开算例（已知 `both/museOnly/himawariOnly/neither` 和论文给出的区间端点）做基准测试；再补一个正相关且 `e > n/2` 的用例，确保两条分支都被覆盖。

### 6. 低｜`INSERT OR IGNORE` 把非法 `case_id`/约束冲突当成“已存在”
- 文件：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:448-458`、`apps/agent-service/src/production-observation.ts:328-330`
- 问题：`INSERT OR IGNORE` 会忽略 `CHECK`/唯一性冲突并返回 `changes=0`，调用方据此认为 `added=false`、`replayed=true`，并释放刚封好的快照。正常路径下 `caseId` 来自服务端重算，不会触发；但一旦编号格式或约束变化，错误会被静默吞掉，表现为“标记成功但其实没写”。
- 建议：对 `case_id` 先显式校验格式；或改用普通 `INSERT`，只在捕获到唯一键冲突时返回 `replayed`。

## 二、侧重检查

- 错误路径：导出逐条隔离只覆盖 JSON 语法错误（发现 1）；标记/取消标记/清除的“数据库已改、载荷未删”问题（发现 2）；`INSERT OR IGNORE` 掩盖约束错误（发现 6）。
- 不合规范/不可信输入：`proactive.gapcase.mark` 的 `caseId/endDay` 由 `gateway.v2` 合约校验（`machineString` + `jstDaySchema`），`gapCaseId` 生成的 `gap_`+20 hex 满足 `machineString` 和迁移里的 `length=24/GLOB 'gap_*'`；`readGapCandidates` 的 `inputs` 有数据库 `json_valid`/object 约束；`museTitle/museText/himawariReason` 经 `clean` 截断到 300/500 个 UTF-16 单元，控制字符替换为空格；`himawariReasonCode` 的来源（`proactive-mail-check-service` 的固定常量与 `failureCode` 的 `[A-Z0-9_]` 清洗）满足 `machineString`。导出前 `redactForEgress` 遮盖密码等敏感信息，测试覆盖了 `hunter22222`。React 渲染 Muse 文字会自动转义，未发现注入面。
- 安全：导出令牌单独用途 `gap-export`，启动配置用 `assertIdentitySecretReference` 校验用途，测试覆盖“指向 Muse 令牌/不存在引用被拒”；`BearerGate` 用 SHA-256 + `timingSafeEqual`，认证/未认证分别限流；未认证返回 401 空体、无 `cache-control` 缓存。标记命令不需要最近登录，但它仍要求已认证 Owner，且可撤销、风险分类为 `low`；作者的理由基本成立（不过这条命令是本 PR 新增的，“超出范围”的说法较弱）。
- 资源耗尽：`GAP_CASE_LIMIT=50` 限制了案例输出，但候选读取/逐行 `JSON.parse` 无上限（发现 3）；导出会读取所有已标记案例，数量由主人操作控制。
- 不可撤销操作：`clearAll` 现在会删除 Backlog 标记并释放快照，文案未同步（发现 4）；取消标记后的释放失败会留下不可达的 Muse 文本（发现 2）。
- 规则/文档与代码一致：ADR 0187 第 7 条“损坏快照跳过”与代码不一致（发现 1）；ADR 说的 `gapExportSecretRef` 用途校验、`origin` 写到周最后一天、`clearAll` 一并取消标记，代码均已实现（`probe` 见对应文件）；迁移序号 82、`SUPPORTED_SCHEMA_MAX=82`、`schema-catalog`、迁移测试序列都已同步。未核实的文档/运行手册：`docs/runbooks/muse-intake-runbook.md` 是否需要补 `gap-export` 步骤，本次没有逐一读全。

## 三、推测 / 未核实

- **推测**：如果第 1 轮分支曾在任何数据库里实际创建过 `gap_case_marks`（旧编号 = `entryId + pairedMessageId` 的哈希），本次改成只哈希邮件编号后，旧行不会被迁移或清理。导出仍会带出旧快照，但周报按新编号计算，会把同一案例显示成“未标记”，用户也无法在界面上取消，只能“清除 Muse 数据”。本 PR 的迁移 0082 没有 backfill/清理。若第 1 轮从未部署，则不影响。
- **推测**：`firstPerMail` 在 `isGapCase` 过滤之前按“最早一条”去重（`production-gap-cases.ts:48-55`）。如果同一封邮件最早那条 Muse 条目不满足入选条件（时机/内容不全对，且主人没评“该做没做”），而后面某条满足，这个案例就不会出现。这和 ADR“取最早的一条”一致，但与“和差距线的按邮件配对口径一致”只在“Muse 是否提醒”层面一致；差距线本身不要求 `isGapCase`，所以两者不会给出互相矛盾的计数，只是案例可能漏掉。建议在 ADR 里写清“取最早且满足入选条件的一条”还是“取最早的一条，不满足就不出”。
- **未核实**：Newcombe 1998 方法 10 原文（无网络），因此无法确认 `corrected` 的负相关不修正是否与原文一致；第 1 轮复核记录文件在当前稀疏检出中不存在（`.agents/...` 不可读），只能按作者摘要核对；Cloudflare Access 外层和部署状态未核实。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 PR 没有新增任何发给模型或嵌入服务的请求，也没有改 `packages/prompt-catalog`、`packages/runtime-pi` 或系统提示/工具定义；改动集中在周报快照、控制中心界面、只读导出、SQLite 迁移和决策记录读取。按 [prompt-prefix 规则第 1-3 条](.claude/rules/prompt-prefix.md#order)，这些值不在模型输入路径里，因此“只在末尾追加、每轮会变的值只在最后一条消息”的不变量未被触碰。ADR 0187 第 8 条也明确写了这一点。导出/周报里的 `generatedAt` 会变，但它不是模型请求内容。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   新路径里，同一份数据的文本是确定的：候选由 SQL `ORDER BY e.muse_at, e.id` 固定，`firstPerMail` 是 `Map` 插入顺序（与 SQL 顺序一致），`gapMarks` 用 `ORDER BY marked_at, case_id`，`buildGapCases` 的 `Promise.all` 保持输入顺序；`gapCaseId` 只依赖邮件编号，重新打分不变；`origin` 由标记时存下的 `weekStart/weekEnd` 计算，不随请求时间变。出口遮盖 `redactForEgress` 对同一输入是确定的。唯一会变的是 `generatedAt`（周报快照和导出都按 `clock.now()` 生成），这是导出/快照的“生成时间”字段，且当前不进入模型前缀；如果以后把整份导出用作模型请求的固定前缀，就会违反规则第 10 条，需要把它挪到末尾或去掉。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   四条中等意见的反向用例是有效的：
   - 编号稳定：`test/integration/gap-cases.test.ts:385-405` 重评后比较 id；旧实现用 `entryId`，重评会换 `entryId`，会失败。
   - 大量 emoji：同文件 `407-432` 断言长度 ≤300/500；旧实现按码点切会得到 600 个 UTF-16 单元，会失败。
   - 清除数据：同文件 `434-449` 断言 `marks.list` 为空且 `refs` 含 `snapshotRef`；旧实现不删标记，会失败。
   - 同邮件多条目：同文件 `407-432` 用相同/唯一 id 断言；只改编号不去重会得到 2 条，会失败。
   仍有缺口：损坏快照只测了非法 JSON（`451-475`），没有测 `"null"`/`"{}"`/缺字段，所以发现 1 不会被现有测试拦住；连续性修正测试无法区分对错（发现 5）；清除测试只验证 `clearAll` 返回 refs，没有走生产 `ProductionMuseControl` 验证“载荷确实被释放”，也没有验证导出条目消失；没有候选数量的上限测试；没有 `summarizeGap` 对同邮件多条目去重的专门反向用例（虽然 `pairEntriesByMail` 本来就在用）。

4. **每个值的使用方都能接受吗？**
   - `gapCaseId` = `gap_` + 20 hex：生产方 `production-gap-cases.ts:39-41`；使用方为 `gateway.v2` 的 `machineString`（允许 `_`，长度 24 ≤128）、迁移 0082 的 `CHECK (case_id GLOB 'gap_*' AND length(case_id)=24)`、周报快照、导出 `id`、React key。两端一致。
   - 新命令 `proactive.gapcase.mark`：`GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、`gateway-v2.fixture`、`PRODUCTION_OBSERVATION_OPERATIONS`、审批网关 delegate、控制中心 `commandMessage` 都已加；payload `caseId/endDay/marked` 与 schema 一致。
   - `gapExportSecretRef` / 用途 `gap-export`：类型 `MuseIntakeConfiguration`、严格配置解析（`rejectUnknown` 已放行）、启动校验（必须指向 `gap-export` 用途）、`service-main` 构造 `ProductionGapExport` 都已接上；启动配置测试覆盖了“指向 Muse 令牌/不存在引用被拒”。注意导出只在 `museIntake.enabled === true` 时创建；未启用时配了 `gapExportSecretRef` 会静默不启用，符合当前 ADR 但值得在运行手册里写明。
   - 周报快照新字段 `gap`/`gapCases`：契约、`production-observation` 映射、控制中心组件、单测 fixture、e2e fixture 都已同步；`gapCases[].marked` 由 `marks.list` 的 `Set` 填充。
   - 迁移/清单：`0082_gap_case_marks.sql`、`migration-engine.ts` 的 sequence 82、`LATEST_MIGRATION_SEQUENCE`、`schema-catalog`、迁移契约测试、`workspace-lifecycle-audit` 的 `SUPPORTED_SCHEMA_MAX=82` 都已一致。
   - 不一致的点就是发现 1：导出读取的是数据库里已存的 JSON 快照，但只在语法层面校验，没有按上面的契约/形状校验，所以“写入端能产生的值”与“读取端能接受的值”之间还缺一道检查；这正是 I-73 那类“只看改动、没核对两端校验”的风险。
