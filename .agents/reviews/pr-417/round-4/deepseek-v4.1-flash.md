## 结论

增量（`b2f25352..82077ba7`）确实只有一条集成测试、round-3 复核记录和 `usage.jsonl`，作者对增量的描述基本属实。新增测试**确实会走到 `assertAccountClassification`**，不是永真，也不会与已有的实现分支错开；但它只断言错误码，测试强度偏弱。未发现高、中危的代码缺陷，发现两处低严重度问题、一处需确认的门禁覆盖问题。

---

## 发现（按严重度从高到低）

### 低：文档仍写“两条 `[I-94]`”，代码里已有三条

- 文件:行：`docs/incidents-and-gates.md:128`
- 问题：I-94 行称“测试 `test/integration/sqlite-model-budget-operations.test.ts` 的两条 `[I-94]`（辅助账户、主对话账户各一条）”，但增量新增了第三条后台 occurrence 拒绝用例后没有更新这句话。
- 证据：
  - 文档原文：`测试 ... 的两条 [I-94]（辅助账户、主对话账户各一条，改前失败：Budget account classification is immutable，改后通过...）`
  - 代码里实际三条：`test/integration/sqlite-model-budget-operations.test.ts:285`、`:2175`、`:2198`。
- 建议：把该行改为“三条 `[I-94]`”，并说明第三条是“后台 occurrence 账户仍不可改分级”的反向守卫，避免后续读者按文档以为只有两条。

### 低：新增反向测试只断言 `code`，没有钉住具体拒绝点

- 文件:行：`test/integration/sqlite-model-budget-operations.test.ts:329`
- 问题：`rejects.toMatchObject({ code: "PORT_CONFLICT" })` 只能证明第二次 reserve 被某个 `PORT_CONFLICT` 拒绝，不能证明一定是 `Budget account classification is immutable`。`reserveWithinTransaction` 里还有别的 `PORT_CONFLICT` 来源，例如同一 operationKey 语义冲突（`sqlite-model-budget-operations.ts:461`）和 occurrence 租约不持有（`:1063`）。
- 证据：
  - 测试代码：`await expect(reserve("classification-sensitive", "sensitive")).rejects.toMatchObject({ code: "PORT_CONFLICT" });`
  - 实现代码：
    - `sqlite-model-budget-operations.ts:1492-1493`：`if (account.dataClassification !== dataClassification) { this.fail("PORT_CONFLICT", "Budget account classification is immutable"); }`
    - `sqlite-model-budget-operations.ts:1056-1063`：`occurrence.revision !== parent.expectedRevision || occurrence.status !== "running" ...` 也抛 `PORT_CONFLICT`。
- 当前实际情况：我按调用链核对过，第一条 reserve 成功后 occurrence revision 不会被预算账户更新改动，operationKey 也不同，因此第二次 reserve 没有在 `assertParent` 或 allocation 冲突处提前失败，确实会走到 `assertAccountClassification`。所以这不是当前失败误判，而是**未来回归可能假通过**。
- 建议：同时断言错误消息，例如 `rejects.toMatchObject({ code: "PORT_CONFLICT", message: "Budget account classification is immutable" })`，或断言失败后 `budget.read(...).account.dataClassification` 仍为 `private` 且没有新增 allocation。

### 低（需确认）：四条失败日志的“装配测试”可能不在任何必过门里

- 文件:行：`apps/agent-service/test/service-orchestration.unit.test.ts:1128`
- 问题：这条 `[I-94]` 用例不是运行四条真实失败路径，而是读取 `service-main.ts` 源码，检查 `event: "...failed"` 后 200 字符内出现 `...siteField(error)`。这能防明显漏写，但不能证明运行时四条日志真的都带 `site`。更关键的是，该测试文件属于 `node-services` 项目，而 `ci/policy.json:108` 的 coverage 必跑项目列表是 `["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"]`，不含 `node-services`；`npm run check` 的步骤里也没有 `npm run test:services`。
- 证据：
  - `apps/agent-service/test/service-orchestration.unit.test.ts:1137-1139`：`const start = source.indexOf(...); expect(source.slice(start, start + 200)).toContain("...siteField(error)");`
  - `ci/policy.json:108`：`"projects": ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"]`
  - `package.json` 的 `check:steps` 中没有 `test:services`。
- 影响：文档 I-94 把这条测试算作门槛，但在仓库里能读到的 required 配置中，它不一定会被实际执行。
- 建议：把这条装配测试移到某个 `unit` 项目会被 `check` 或 CI coverage 跑到的位置，或把 `node-services` 加入 coverage 项目列表。若仓库外还有别的 workflow 跑 `test:services`，请在文档里写明，否则应视为门禁缺口。
- 说明：`.github/` 不在当前检出中，无法确认是否有别的流程运行 `node-services`，所以这一条标为“需确认”。

---

## 读代码证实的

- 增量 diff 只有 `test/integration/sqlite-model-budget-operations.test.ts` 的一处新增测试，以及 round-3 复核记录和 `usage.jsonl`；作者“只加了一条测试”的说法与 diff 一致。
- 新测试先通过 `reserveAdmission` 创建 occurrence 预算账户（`sqlite-durable-operations.ts:4279-4284` → `reserveOccurrenceWithinTransaction` → `ensureOccurrenceAccountWithinTransaction`，`sqlite-model-budget-operations.ts:218-231`），账户分级来自 `occurrence.dataClassification`，测试数据为 `private`。
- 第二次 reserve 的 parent 是 occurrence，因此 `sqlite-model-budget-operations.ts:494` 的 `thread-title || run` 分支不成立，进入 `:497` 的 `assertAccountClassification`；账户仍为 `private`、请求为 `sensitive`，在 `:1492-1493` 抛 `PORT_CONFLICT`。
- 第一条 reserve 不会改动 `job_occurrences.revision`；`claimOccurrence` 已把 occurrence 置为 `running` 且 work lease 到 `FAR_FUTURE`（`sqlite-durable-operations.ts:4349-4363`），所以第二次 reserve 的 `assertParent`（`:1038-1065`）不会先失败。
- 如果把这个测试期待的行为反过来——即让 occurrence 也走 `raiseAccountClassification`——第二次 reserve 会成功，`expect(...).rejects` 会失败；因此它不是永真，能挡住“把后台账户也放开”的过度修复。
- `raiseAccountClassification` 的输入来自 `classification()` 校验过的枚举，数据库列也有 `CHECK (data_classification IN (...))`；读取端 `readAccount` 又会再次校验（`sqlite-model-budget-operations.ts:1267`），两端校验一致。
- `site` 字段由 `portErrorSite` 返回 `error.message.slice(0, 200)`，只接受带 `PORT_` 前缀且 `message` 为字符串的对象（`service-runtime.ts:61-73`）；`writeServiceDiagnostic` 再做 `redactMachineSecrets` 后写 JSON（`:81-87`）。

## 推测 / 未核实

- `raiseAccountClassification` 只更新 `data_classification`，不自行递增 `revision`（`:1478-1481`）；而同一个 reserve 紧接着会在 `updateAccount` 中按 `account.revision + 1` 做 CAS 更新（`:1204-1219`）。当前事务内不会产生可见窗口，未发现生产代码消费预算账户的 `revision`，所以暂不构成缺陷；但若将来有人单独调用它，可能需要补 revision 语义。
- `portErrorSite` 会把 `PORT_` 错误消息写进诊断日志。当前预算相关消息都是静态文案，`writeServiceDiagnostic` 还会做机器密钥遮盖，因此未发现实际泄露；但如果未来 `PORT_` 错误的 message 承载外部文本，需要重新评估。
- `.github/` 不在检出中，无法核实是否存在其他 CI 流程运行 `node-services` 测试。

---

## 侧重检查

- **错误路径**：新测试的第二次 reserve 会先经过 authority、occurrence 租约、allocation 重放检查；我逐段核对了这些分支，当前夹具下不会先抛其他 `PORT_CONFLICT`，能够到达分级断言。弱点是测试只看错误码，已列在上面的低严重度项。
- **不合规范/不可信输入**：`raiseAccountClassification` 的分级值来自 `parseReserve` → `classification()` 的白名单校验，不能注入任意 SQL 值；`portErrorSite` 对非对象、无 `code`、无 `message` 都返回 `undefined`，不会因异常结构直接抛错（除非 message getter 本身恶意抛错，这不在当前输入面）。
- **安全**：`site` 只写日志，不进模型请求；`writeServiceDiagnostic` 会做机器密钥遮盖。未发现新增外部输入进入系统提示、工具定义或历史消息。
- **资源耗尽**：`site` 截断到 200 字符；分类更新是单行 UPDATE，无循环或无限扩张；新测试每次创建独立临时 SQLite，并在 `finally` 关闭。
- **不可撤销操作**：预算账户分级是单调升高、不会降级；这是 I-94 的预期语义（“记下见过的最高分级”），不是本次新增的隐式不可逆操作。后台 occurrence 和 memory-projection 仍走不可变断言。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md:27-36` 要求请求只追加，本次改动没有触碰请求组装、工具定义、历史或遮盖；但 `docs/incidents-and-gates.md:128` 的“两条 `[I-94]`”已与现在的三条测试不一致。另有 I-94 对 `service-orchestration.unit.test.ts` 作为门槛的描述需要确认是否真的在必跑流程中。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只涉及 SQLite 预算账户的分级持久化和诊断日志；没有修改系统提示、工具定义、历史消息、资料块或出口遮盖。发给模型的内容仍由原有流程决定：固定内容在前、轮次内容在末尾追加，每轮变化的值仍在最后一条消息里。本 PR 没有把预算账户分级或 `site` 日志写进模型请求。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。`data_classification` 是受枚举和数据库 CHECK 约束的确定性值；`site` 只进入 JSON 诊断日志，且日志本身带时间戳，但日志不是模型请求内容。没有新增依赖前后文的遮盖、无序集合或会进入提示词的动态字段。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。预算行为由 `test/integration/sqlite-model-budget-operations.test.ts` 的 `[I-94]` 用例覆盖；两条正向用例在修复前会因 `Budget account classification is immutable` 失败。新增的后台 occurrence 用例是反向守卫：如果把 occurrence 也改成“可升高”，第二次 reserve 会成功，`rejects` 会失败，所以不是永真。`portErrorSite` 本身有 `service-failure-reason.unit.test.ts`，属于 `check:product-path-configuration`。
   但两点需注意：新增预算用例属于 integration 项目，不在 `npm run check` 里，只在 CI coverage 项目执行；`service-orchestration` 的日志装配检查可能不在必跑项目里（见上面的低严重度项）。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `model_budget_accounts.data_classification`：产生端是 `raiseAccountClassification`，输入来自 `classification()` 校验和数据库 CHECK；读取端 `readAccount` 再次校验枚举；消费端 `ModelBudgetAccount`/`ModelBudgetSnapshot` 只做快照和测试读取，未发现生产代码要求账户分级必须等于每笔 allocation 分级。
   - `site` 字段：产生端 `portErrorSite` 返回 `string | undefined`，消费端是 `writeServiceDiagnostic` 的 `Record<string, string | number | boolean | readonly string[]>` 和 JSON 日志，类型兼容，并经过遮盖。
   - 新增测试里的 `operationKey`、`leaseId`、`holderId` 只存在于测试夹具，没有进入生产清单或后端校验。
   - 未发现新增标识、配置键或清单项；I-73 所提醒的“产生端/使用端校验不一致”在本次改动中没有对应新值。唯一两处不一致是文档里的测试数量描述和测试强度/门禁覆盖，已在上面的发现中列出。
