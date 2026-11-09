# PR 314 第 6 轮复核结论（增量 315e677a → 611ff977）

## 一、总体结论

- `git diff --stat 315e677a..611ff977` 只列出 6 个文件：`.agents/...` 的复核记录、`usage.jsonl`、`docs/adr/0187-...md`、`test/integration/gap-cases.test.ts`。**“本轮只改测试和 ADR、生产代码没动”属实。**
- 新测试确实走 `proactive.gapcase.mark` 命令路径：`wired()` 里的 `mark` 调用 `observation.execute({ type: "proactive.gapcase.mark", ... })`（test 306-310），而 `ProductionObservation.execute` 把它派发到 `#markGapCase`（production-observation.ts:345）。
- 按代码推演，**把标记路径的 `maskForExport` 去掉，新测试会失败**；而且断言比上一轮更稳，不再依赖“占位符恰好被截断”。
- 发现 1 个 ADR 与代码不一致（中），以及几个低风险/测试质量问题。

---

## 二、问题（按严重度从高到低）

### 中-1　ADR 说“周报只读当前周 / 早于本周的标记看不到”，与代码不符（读代码证实）

- 文件：`docs/adr/0187-weekly-gap-lines-and-cases-against-muse.md:84`
- 问题：新增的已知局限写“网页只显示当周……早于本周的标记在网页上看不到……（周报只读当前周）”。但实际周报窗口不是“当前周”，也不会每周前移：
  - 网页读取固定传 `end: null`：`apps/control-center/src/proactive.ts:154` `queryMessage(configuration, "proactive.weekly.read", { end: null })`
  - 服务端在已有观察起点时把窗口固定成 `[start.startDay, start.startDay+7)`：`apps/agent-service/src/production-observation.ts:186-192`
    ```ts
    : start ? { end: addDays(start.startDay, 7), days: 7 }
    ```
  - 观察起点写入后不可改：`packages/persistence-sqlite/src/sqlite-observation-operations.ts:186` `if (this.readStart(start)) ... ALREADY_SET`，并有不可更新/删除触发器 `migrations/0074_ledger_observation.sql:13-19`。
  - 未设观察起点时窗口是“最近 7 天”（`resolveWindow` 对 `end=null` 取 `now`），也不是“当前自然周”。
- 后果：正常通过网页标记的案例始终属于该固定窗口，不会“变成早于本周”，所以 ADR 描述的“看不到、不能取消”在正常 UI 流程下不会发生；反过来，如果“每周滚动”才是产品本意，那这是一个功能缺陷（周报不会更新）。
- 建议：若产品要“每周滚动”，改窗口计算并在 ADR 写清；若当前固定观察期就是本意，把这句改成“周报窗口固定为观察起点起的 7 天，不随时间前移”，并说明命令可传入任意 `endDay` 时才会出现“网页看不到的标记”。

### 低-1　新测试对导出的断言可能被 500 空响应“假通过”（读代码证实）

- 文件：`test/integration/gap-cases.test.ts:576-581`
- 问题：只断言 `exported.body` 不含卡号，没有断言状态码是 200。导出路由出错时返回 500 且**空体**（`apps/agent-service/src/production-gap-export.ts:177-179` `reply.code(500)...send()`），空字符串天然满足 `not.toMatch(...)`。
  ```ts
  const exported = await h.app.inject({ ... });
  expect(exported.body).not.toMatch(/4111|(?:\d[ -]?){13,}/u);
  ```
- 影响：如果将来导出路径坏掉（例如全部快照读不出返回 500），这条“导出也不漏卡号”的断言会静默通过。
- 建议：加 `expect(exported.statusCode).toBe(200)`，最好再断言 `exported.json().cases` 长度为 1 且含该 caseId。

### 低-2　取消标记后多做一次 `release`，磁盘余量不足时会把已成功的取消变成报错（读代码证实；ADR 已承认）

- 文件：`apps/agent-service/src/production-observation.ts:321-324`
- 证据：
  - `gapUnmark` 已在同一事务里删掉标记行和载荷行：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:470-475`。
  - 调用方仍对返回的 ref 再调用 `seal.release`：`production-observation.ts:323` `if (ref !== null) await seal.release({ ...scope, refs: [ref] });`
  - `release` → `payload.delete` → `deletePayload` 先做磁盘余量检查：`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1774-1780` `this.assertDiskHeadroom();`
- 影响：标记和载荷其实已删除，但命令可能报错，UI 显示失败；ADR 第 87 行已把它写成已知局限（“重试即可”）。
- 建议：`unmark` 已负责删载荷时不要再 `release`（或让 `unmark` 返回“是否还需要释放”），从根上消掉这个失败路径，而不是只在 ADR 里记录。

### 低-3　`gapMark` / `gapUnmark` 未调用 `assertDiskHeadroom`，与其他写操作不一致（读代码证实；实际影响为推测）

- 文件：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:448-478`
- 问题：同类写操作（如 `setStart` 在 `sqlite-observation-operations.ts:178`、`payload.delete`、`gap` 相关表所在的其他写操作）都会先 `assertDiskHeadroom()`；新增的 `gapMark`/`gapUnmark` 直接执行 SQL，没有调用。
- 影响推测：`gapMark` 前一刻的 `seal.seal` 已检查过一次磁盘，实际风险有限；`gapUnmark` 是删数据，跳过检查反而合理。但这是与仓库约定的偏差，值得统一（至少注释说明为何不检查）。

### 低-4　`gapExportSecretRef` 在 `museIntake.enabled=false` 时被静默忽略（读代码证实）

- 文件：`apps/agent-service/src/service-main.ts:1688-1712`
- 证据：`gapExportRef` 只有在 `museIntakeConfiguration?.enabled === true` 时才解析；否则 `gapExportSecret` 为 `undefined`，且 `else if (... && enabled === true)` 不会抛错。
  ```ts
  const gapExportSecret = museIntakeConfiguration?.enabled === true && gapExportRef !== undefined ? ... : undefined;
  ...
  } else if (gapExportRef !== undefined && museIntakeConfiguration?.enabled === true) {
    throw new Error("GAP_EXPORT_RUNTIME_UNAVAILABLE");
  }
  ```
- 而配置校验（`packages/platform-node/src/strict-configuration.ts:1418-1427`）对 `gapExportSecretRef` 不看 `enabled`，所以“配了 ref、但忘了开 museIntake”会通过启动校验、但没有导出接口。
- 建议：要么在 `gapExportSecretRef` 存在而 `museIntake.enabled=false` 时直接报配置错误，要么在 ADR/配置说明里写清这个组合无效。

### 低-5　新测试的前提与 `TITLE_LIMIT=300` 强耦合（读代码证实）

- 文件：`test/integration/gap-cases.test.ts:95,108-109,570`
- 问题：`CARD_PREFIX = 285` 依赖标题限制 300，才能让未遮盖的卡号落在截断范围内（`expect(long.museTitle).toContain("4111")`）。若以后 `TITLE_LIMIT` 改小到卡号之前，测试会因“找不到 4111”失败，而不是因为遮盖回归；这属于失败原因不可读，但不影响“真回归会失败”。
- 建议：从 `production-gap-cases.ts` 导出/引用 `TITLE_LIMIT`，用它计算前缀长度（如 `TITLE_LIMIT - 15`），让测试意图更明确。

---

## 三、推测 / 未核实

- **未实际运行测试**（本次只能用 read/grep/glob 和有限 git 命令）。关于“去掉 mask 会失败”的结论是按代码推演，不是测试执行结果。
- 生产环境是否可能启用 `HybridPayloadStore`（会把大载荷写成外部密文文件）未在 `apps/` 找到使用点，`apps` 下无 `HybridPayloadStore`；因此 ADR 说“等价于现在的内联存储”基本成立。但这一点取决于部署方式，属于“未完全核实”。
- `redactForEgress` 的上下文窗口规则（验证码前后 40 字符、JP My Number 关键字等）在单段文本内是确定的，但我没有穷举所有输入形态。

---

## 四、侧重检查

- **错误路径**
  - 导出全部快照读不出 → 500 空体：`production-gap-export.ts:169-170`，与 ADR 第 88 行一致。
  - 单条快照坏/编号不匹配 → 跳过并计数：`production-gap-export.ts:141-150`，有测试（test 588-654）。
  - 取消标记后二次 release → 可能报错（见低-2）。
- **不合规范/不可信输入**
  - `caseId` / `endDay` / `marked` 经 gateway schema 校验（`contracts-v2.ts` 新增 `proactiveGapCaseMarkCommandSchema`）；`endDay` 为 `jstDaySchema`。
  - SQL 全部参数化；`gap_case_marks.case_id` 有 `GLOB 'gap_*' AND length(...) = 24`（migration 0082），与 `gapCaseId` 的 `gap_ + 20 hex = 24` 一致。
  - `gapMark` 使用 payload 的 `caseId` 插入，但该值必须先通过“重算案例并匹配”才能走到插入，所以不会写入不规范 id。
  - 服务端没有把 `endDay` 限制在网页当前报告窗口内；构造客户端可标记其他周的案例，这会制造“网页看不到的标记”（与中-1 相关）。
- **安全**
  - `BearerGate` 用 SHA-256 后 `timingSafeEqual`，长度恒定；认证失败/成功分别限流（`bearer-admission.ts:23-35`），复用给 Muse 与导出。
  - 导出只返回遮盖后的 prefill，不含原始 `museTitle/museText`；密码/卡号测试覆盖。
  - `scripts/check-egress-redaction.mjs:25` 把 `production-gap-export.ts` 登记为可调用 `redactForEgress` 的出口模块；但**标记路径的遮盖没有静态门禁**，只能靠新集成测试。
  - 周报网页仍返回未遮盖的案例原文（`production-observation.ts:205` 的 `#gapCases(window)` 未传 mask）。ADR 明确说这是给已登录本人看、不是出口；属于有意识取舍，不是本 PR 新引入。
- **资源耗尽**
  - 导出没有条数上限（ADR 已写），但正常 UI 受 `GAP_CASE_LIMIT=50` 和固定窗口约束；命令允许任意 `endDay`，因此上限实际取决于客户端行为。
  - `readGapCandidates` 有 `LIMIT 1000`（`sqlite-decision-ledger-operations.ts:512`），ADR 已写。
  - `gapMark/gapUnmark` 未做磁盘余量检查（见低-3）。
- **不可撤销操作**
  - 取消标记会在事务里直接删除快照载荷（`sqlite-decision-ledger-operations.ts:470-475`）；重新标记会按当时数据重算，旧快照不可恢复。这符合“标记是人的操作”，但 ADR 未明说“取消后旧快照不可恢复”。
  - 清除 Muse 数据会删除所有标记及快照（`sqlite-muse-intake-operations.ts:528-539`），三种语言的确认文案已更新（en/ja/zh-CN），与 ADR 一致。
- **规则/文档与代码一致性**
  - 除中-1 外，ADR 新增的其余说明（快照先遮盖后截断、导出再遮盖、占位符可能被截断、并发取消导致 500、内联载荷直接删除、磁盘紧张时二次 release 报错）都能在代码中找到对应依据。
  - `prompt-prefix` 规则不涉及本改动。

---

## 五、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。**
- 本轮增量只有测试和 ADR，生产代码未动（diff 已确认）。
- 整个 PR 新增的是 gateway 命令/快照、导出接口、数据库表和网页，不涉及系统提示、工具定义、历史消息或模型请求组装；`GATEWAY_V2_MESSAGE_TYPES` 只用于 gateway schema 与测试（`packages/gateway-contracts/src/contracts-v2.ts:2464`、`test/gateway-v2.contract.test.ts`），不会被拼进模型请求。
- 因此仍然满足 [prompt-prefix.md:27-28](.claude/rules/prompt-prefix.md) 的“固定在前、会变的在最后一条消息里”，以及 [prompt-prefix.md:35-36](.claude/rules/prompt-prefix.md) 的“历史只能追加、遮盖要确定”。
- 新命令/快照里的 `markedAt`、`generatedAt` 等时间字段只出现在 gateway 响应/导出中，不进入模型上下文。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**对模型请求不会；对标记/导出链路，文本遮盖本身是确定的。**
- `maskForExport` 直接调用 `redactForEgress(text)`，不传 `tag`/`known`（`production-gap-export.ts:89-91`），同一段输入每次得到相同占位符（如 `[银行卡 尾号1111]`）。
- 标记快照 = `clean(mask(text), limit)`（`production-gap-cases.ts:64-74`），顺序固定、无随机；`gapCases` 来自 SQL `ORDER BY e.muse_at, e.id` 后再按 Map 插入，顺序固定。
- 唯一变化的是导出体里的 `generatedAt`（`production-gap-export.ts:171`）和数据库 `marked_at`，它们不在模型请求里，也不是“同一段文字”，属于 ADR 0164 所说的“会变的值放最后/单独字段”。因此不违反字节确定性要求（就模型提示缓存而言）。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，但只覆盖了标记路径的遮盖；ADR 的文字没有自动检查。**
- 新增 `test/integration/gap-cases.test.ts:565-586`，经 `h.mark` → `observation.execute("proactive.gapcase.mark")` → `#markGapCase(..., maskForExport)` → `buildGapCases(mask)` → `clean`，然后直接打开存下的快照断言无卡号。
- 反向用例推演：把 `production-observation.ts:327` 的 `maskForExport` 去掉后，`h.cases()` 里未遮盖标题在 300 字内仍含 `4111`（test 570 已证明该案例成立），存下的快照也会含 `4111 1111 ...`，test 575 必然失败。若改成“先截断再遮盖”，截断后只剩 `4111 1111 `（8 位数字），`CARD_CANDIDATE` 需要 13 位以上、不会命中，同样会留下 `4111`，test 仍会失败。
- 上一轮的 `/4111|1111/` 断言确实依赖占位符被截断（完整占位符含 `尾号1111` 会误报）；本轮改成 `4111|(?:\d[ -]?){13,}` 后不再依赖这个巧合。
- 反向缺口：导出断言没有校验 200（见低-1）；ADR 的“当前周”说法没有测试，也没有测试证明周报窗口会滚动。

### 4. 每个产生/修改的值，使用端都能接受吗？

按“产生 → 使用”核对结果：

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| `proactive.gapcase.mark` 命令类型 | `contracts-v2.ts` schema + `PRODUCTION_OBSERVATION_OPERATIONS` | gateway schema、gateway 路由（`production-approval-gateway.ts:219-220`）、控制中心 `proactive.ts:171-179` | 接受 |
| `caseId` | `gapCaseId()` = `gap_` + 20 hex（`production-gap-cases.ts:39-41`） | gateway `machineString`、DB `GLOB 'gap_*' AND length=24`（migration 0082）、UI data 属性 | 接受；长度 24 一致 |
| `endDay` | 网页取 `report.endDay`（`weekly-report.tsx:760`） | gateway `jstDaySchema`、`resolveWindow({end})` | 接受；与服务端窗口定义一致 |
| `gapCases` / `gap` 快照字段 | `buildGapCases` / `summarizeGap` | gateway schema（`contracts-v2.ts` 新增 `gapCases`/`gap`）、`gatewayV2MessageSchema.parse`（`production-observation.ts:297`）、网页 | 接受；`ownerRating` 枚举与 DB CHECK（migrations 0062/0069）一致，`attribution` 枚举与 calibration 一致 |
| `gap_case_marks` 表/序列号 82 | migration + `migration-engine.ts:646-653` | schema catalog、`migration-engine.contract.test.ts`（current 82）、`model-budget-migration`、`run-checkpoint-migration`、`workspace-lifecycle-audit.mjs`（82） | 接受，编号一致 |
| `gapExportSecretRef` | `strict-configuration.ts:1064-1076` | `assertIdentitySecretReference` 校验用途 `gap-export`（1418-1427）、`service-main.ts:1688-1712` | 基本接受；`enabled=false` 时静默忽略（低-4） |
| `himawari-gap-cases.v1` / `GAP_EXPORT_PATH` | `production-gap-export.ts:12-13` | 路由注册、测试、ADR 上线步骤 | 接受 |
| i18n 新 key | `message-ids.ts` + 三语言资源 | `weekly-report.tsx`、`MESSAGE_SAMPLE_VALUES` | 接受；三语言齐全，“清除 Muse 数据”文案已同步说明会清案例标记 |

结论：**核心值和清单项两端校验对得上**；需要留意的是服务端没有把 `endDay` 限制在报告窗口内（可产生“网页看不到的标记”），以及低-4 的配置静默忽略。
