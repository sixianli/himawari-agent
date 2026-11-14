未发现会阻断合并的高严重度问题。以下按严重度排列，区分「读代码证实」与「推测」。

## 发现

### 1. 严重度：低 — 三条记忆类日志的 `site` 接线没有任何反向用例
- 文件:行：`apps/agent-service/src/service-main.ts:2603`、`2633`、`2666`；`apps/agent-service/test/service-orchestration.unit.test.ts:1112`
- 问题：`memory-episode.failed`、`memory-consolidation.failed`、`memory-capture.failed` 三处都加了 `...siteField(error)`，但只有 `thread-title.failed` 有接线测试。把其中任意一处 `siteField` 删掉，现有测试都不会失败。
- 证据（读代码证实）：
  - 四个处理器分别位于 `service-main.ts:2582`、`2603`、`2633`、`2666`，内容都是 `code: stableErrorCode(error), ...siteField(error)`。
  - `service-orchestration.unit.test.ts:1116-1123` 只通过 `boundary.runs.mock.calls[0]?.[0].onTitleFailure(...)` 验证标题那一条。
  - `docs/incidents-and-gates.md:128` 自己也写明“后者只接得到标题那一条日志，其余三条共用同一个 `siteField`，没有单独的装配测试”。
- 建议：把四个回调的接线做成参数化测试，或抽成一个四个回调共用的构造函数/辅助函数，并对每个事件名断言 `site` 存在；同时保留“非 PORT 错误不写 `site`、不写 message”的用例。

### 2. 严重度：低 — `portErrorSite` 对任意 `PORT_` 前缀错误输出原始 message
- 文件:行：`packages/platform-node/src/service-runtime.ts:61-73`
- 问题：判断条件只有 `error.code.startsWith("PORT_")`，随后把 `error.message` 前 200 字符写进生产诊断日志。仓库里存在带动态标识符的 PORT 错误消息，不是全部都是静态说明。
- 证据（读代码证实）：
  - `service-runtime.ts:67-72`：`!error.code.startsWith("PORT_") ... return error.message.slice(0, 200);`
  - 动态 message 的例子：`packages/persistence-sqlite/src/sqlite-thread-operations.ts:671` 的 `` `Thread ${threadId} not found` ``；`sqlite-capability-invocation-operations.ts:1149` 的 `` `Capability handle ${input.handleRef} not found` ``；`sqlite-worker.ts:471` 的 `` `Agent ${lease.agentId} already has a live lease` ``。
  - `writeServiceDiagnostic` 只做 `redactMachineSecrets` 和 JSON 序列化（`service-runtime.ts:81-87`），不会把普通标识符去掉。
- 推测：这些动态消息是否会真的到达标题/记忆四个回调，未核实；即便到达，泄露的是内部标识符而非正文，`redactMachineSecrets` 也会遮住像密钥的字符串，因此风险有限。但如果将来有人用 `ApplicationPortError(PROVIDER_FAILURE, 供应商原文)`，这条路径就会把供应商原文写进日志，与现有“非 PORT 错误不泄露 message”的测试意图不一致。
- 建议：不要按前缀放行，改为在预算模块里为需要诊断的拒绝点输出稳定 `site` 码（例如 `budget.account_classification_immutable`），或为 `portErrorSite` 维护一份允许输出的静态 message 清单；至少加注释/测试固定“PORT_ message 必须是静态常量”。

### 3. 严重度：低（推测、设计取舍）— `run` 账户不再有“粘性分级地板”
- 文件:行：`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:494-498`、`1488-1495`
- 问题：`run`/`thread-title` 账户现在只升不降，且**不再调用** `assertAccountClassification`。账户被某次 `sensitive` 调用抬高后，后续 `private`（只要不低于 Run trigger 分级）会被接受。对 `thread-title` 这是修复的目的；对主对话 `run` 账户，这移除了原先“账户分级一旦定下就不许变”的隐式防线。
- 证据（读代码证实）：
  - `sqlite-model-budget-operations.ts:494-498`：只有 `run`/`thread-title` 走 `raiseAccountClassification`，其余才 `assertAccountClassification`。
  - `sqlite-model-budget-operations.ts:1474-1475`：请求分级不高于账户当前分级时直接返回，不报错。
  - 集成测试明确要求这种“先 sensitive 后 private”被接受：`test/integration/sqlite-model-budget-operations.test.ts:2169-2172` 的 `lowerAgain` 期望 `fresh`。
  - 仍存在的下限是 `assertRunClassification`（`1432-1444`），它比较的是 Run trigger 的分级，不是账户见过的最高分级。
- 推测/风险：安全性现在完全依赖“每笔调用自己声明的分级是正确的”。这次改动没有破坏这一点：准入仍按每笔调用的分级校验模型允许的分级（`packages/application/src/services/model-invocation-admission-service.ts:481-486`），主对话上下文分级也取运行时与上下文的最大值（`packages/application/src/services/run-coordinator.ts:683-704`）。因此不是已证实的漏洞，但原来的第二道防线没有了，建议在代码或数据库注释里写清“账户分级是统计/上界，不是 egress 授权依据”，避免以后有人把它当权限用。
- 建议：保留现有每笔调用的校验；若担心调用方算错分级，可在 `run` 账户的主对话路径上显式要求 `input.dataClassification >= max(本次上下文分级)`，而不是恢复账户不可变。

### 4. 严重度：信息 — 抬高分级不递增 `revision`
- 文件:行：`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:1476-1481` 对比 `1204-1220`
- 问题：`raiseAccountClassification` 直接 `UPDATE ... SET data_classification = ?`，不修改 `revision`；而 `updateAccount` 每次更新预留/花费/状态都会把 `revision + 1`。
- 证据（读代码证实）：
  - `1478-1480`：`UPDATE model_budget_accounts SET data_classification = ? WHERE ...`，没有 `revision = revision + 1`。
  - `1204-1209`：`const revision = addCost(account.revision, 1, ...); UPDATE ... SET ..., revision = ? WHERE ... AND revision = ?`。
- 推测：目前没有找到把 `revision` 当作“整行版本”的外部使用方；`revision` 的实际消费点只在 `updateAccount` 的乐观锁里，且两次更新在同一个 immediate transaction 内，所以当前不构成功能缺陷。但如果以后用 `revision` 做审计/增量导出，会漏掉分级变化。
- 建议：要么递增 `revision`，要么在注释里明确 `revision` 只表示费用/状态版本；两者选一，别让语义悬空。

### 5. 严重度：信息 — 门槛措辞与自动运行范围
- 文件:行：`docs/incidents-and-gates.md:128`、`scripts/check-incident-gates.mjs:65-70`
- 问题：I-94 写“已落门槛”，并注明两条核心测试“不在 `npm run check` 里”。这句话本身准确；但 `check-incident-gates.mjs` 只检查门槛栏里的路径是否存在、状态是否合法，不检查该测试是否真的被任何自动检查执行。因此“已落门槛”在脚本层面是形式通过。
- 证据（读代码证实）：
  - `scripts/check-incident-gates.mjs:65-70`：只做 `existsSync(path.join(root, relative))`。
  - 不过 CI 的 coverage 任务确实包含 `integration` 项目：`ci/policy.json:108` 的 `coverage.projects` 含 `"integration"`，`.github/workflows/ci.yml:287` 运行 coverage。`unit` 项目 include `apps/**/*.unit.test.ts`（`ci/policy.json:147`），所以标题日志接线测试也会在 CI 的 unit 里跑。结论：门槛在 CI 上确实自动运行，本地 `npm run check` 不跑，但文档已说明。
- 建议：无需改状态；如果希望本地快速检查也能挡住，可加一个只跑 `sqlite-model-budget-operations.test.ts -t "[I-94]"` 的 `check:` 步骤，或在 `check:incident-gates` 里增加“门槛文件必须属于某个 check 的 include/testProjects”的校验。

## 侧重检查

- **错误路径**：预算模块的 `fail` 消息基本是静态说明；`execute` 会把 `TypeError` 转成 `PORT_INVALID_OPERATION` 并带上原始 message（`sqlite-model-budget-operations.ts:212-214`）。新增的 `site` 只对 `PORT_` 错误生效，写日志前经过 `redactMachineSecrets`。未发现新的崩溃/递归/重试放大路径。
- **不合规范或不可信输入**：`dataClassification` 在 `parseReserve` 经 `classification()` 校验，只允许四个值（`sqlite-model-budget-operations.ts:141-147`、`914`）；数据库列也有 CHECK（`0049_thread_title_budget.sql:16-17`）。`raiseAccountClassification` 只写这个已校验的值。未发现新的注入面。
- **安全 / 分级**：每笔模型调用仍按自己的分级校验模型允许的分级（`model-invocation-admission-service.ts:481-486`），Run trigger 的最低分级仍由 `assertRunClassification` 把关（`sqlite-model-budget-operations.ts:1432-1444`）。删掉的是账户级“粘性”检查；按现有代码没有发现账户分级被用于 egress 授权。`portErrorSite` 的日志暴露面见发现 2。
- **资源耗尽**：抬高分级只在四个枚举值之间比较，无循环、无外部长度放大；日志 message 截断 200 字符。
- **不可撤销操作**：分级抬高是单向的，没有降级路径；`finalize` 不改分级，只改预留/花费/状态（`sqlite-model-budget-operations.ts:764-827`）。这与“只升不降”的设计一致。
- **规则/文档/代码一致性**：`docs/incidents-and-gates.md:128` 关于代码分支、四个日志事件、两条集成测试、测试所属项目、只有标题有装配测试的描述，与代码一致。作者说的“run 账户只升不降”“标题日志加 site”“补标题接线单测”均属实。未核实的是：生产事故里那些调用的实际分级是否低于 Run trigger；以及运行测试的实际结果（本轮只能读代码，未执行测试）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只涉及预算账户持久化、诊断日志、文档和测试，没有碰系统提示、工具定义、历史消息、遮盖或压缩。读代码没有找到从 `model_budget_accounts.data_classification` 流入 prompt 组装的地方；`account.dataClassification` 的消费点只有预算模块自身和测试（`sqlite-model-budget-operations.ts:1533`、集成测试 `2136/2182`）。因此发给模型的内容仍然只在末尾追加，每轮会变的值仍应只在最后一条消息里。依据的 prompt-prefix 规则见 `.claude/rules/prompt-prefix.md:31-36`。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。新值有两类：数据库里的账户分级（不会进入模型请求）和日志里的 `site`（只写 stderr）。`site` 取决于错误本身，不依赖后续请求或无序集合；日志里的时间戳是既有的 `writeServiceDiagnostic` 行为，也不发给模型。没有新增序列化到请求的内容。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有，但覆盖不均：
   - 核心行为有两条 `[I-94]` 集成测试（`test/integration/sqlite-model-budget-operations.test.ts:2123-2186`）。按代码推断，撤掉 `|| input.parent.kind === "run"` 或改回 `assertAccountClassification`，第一条会以 `Budget account classification is immutable` 失败；第二条会同样失败。未实际运行。
   - 日志函数有 `packages/platform-node/test/service-failure-reason.unit.test.ts:31-48`，反向用例（非 PORT 返回 `undefined`）存在。
   - 标题日志接线有 `service-orchestration.unit.test.ts:1112-1125`，撤掉标题处的 `siteField` 会失败。
   - 但另外三条记忆日志接线没有反向用例（发现 1）。
   - 自动运行范围：CI 的 coverage 会跑 `integration` 和 `unit`（`ci/policy.json:108/147`），所以不是“只写在文档里”；本地 `npm run check` 不含 integration（`package.json:27`），文档已注明。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `model_budget_accounts.data_classification`（run/thread-title）：产生处是 `raiseAccountClassification`（`sqlite-model-budget-operations.ts:1470-1486`），输入已由 `classification()` 限制为四个值；读取处 `readAccount` 再经 `classification()` 校验（`1267`），输出 `toAccount` 直接透传（`1533`），数据库 CHECK 接受四个值。`settle`、`markUnknown`、`releaseReserved`、`finalize`（`598-655`、`664-713`、`722-762`、`764-827`）以及派发查询（`sqlite-run-dispatch-operations.ts:1106-1116`）只看状态/金额，不看分级；`occurrence` 与 `memory-projection` 仍走精确匹配（`ensureAccount` 和 `reserveWithinTransaction` 的 else 分支）。没有找到数据导出使用 `model_budget_accounts`。结论：使用方都能接受。
   - `site`：产生处 `portErrorSite` 返回 `string | undefined`（`service-runtime.ts:61-73`），消费处 `siteField` 展开到诊断对象，`writeServiceDiagnostic` 接受字符串并做遮盖/序列化（`81-87`）；未找到下游解析器。能接受。
   - `portErrorSite` 导出：`packages/platform-node/src/index.ts:37` 有 `export * from "./service-runtime.js"`，`service-main.ts:81` 正常导入。
   - 文档清单项：I-94 行引用的文件都存在，`check-incident-gates` 的路径检查可通过；但它不校验“是否在自动检查里”（发现 5）。

未核实：上述测试在 CI/本地实际执行的结果；生产事故中记忆保存、片段总结、整理各自的分级与 Run trigger 分级的相对高低；动态 `PORT_` message 是否真的会流到四个记忆/标题回调。
