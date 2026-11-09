## 复核结论（对比 a1eb91f4 → 32dde89a，并对照 d6b3a96 起的整体改动）

### 读代码证实的问题（按严重度）

**1. 中：导出的逐条 try/catch 会吞掉系统性错误，可能返回 200 空清单**
- 文件：`apps/agent-service/src/production-gap-export.ts:106-131`
- 问题：`try` 包住了 `seal.open`、`JSON.parse`、`gapBacklogPrefill` 全部步骤，`catch {}` 既不记录也不区分错误类型。若载荷保护器不可用、密钥轮换不匹配、数据库读失败，会对**每一条**标记都抛错，结果是 200 + `cases: []`，导出方会误以为“没有已标记案例”。逐条隔离本身没问题，问题是没有把“单条快照坏”与“整条链路坏”分开。
- 证据：
  ```ts
  for (const mark of marks) {
    try {
      const text = await this.#seal.open({ ...this.#scope, ref: mark.snapshotRef });
      ...
    } catch {
      continue;
    }
  }
  return { schema: GAP_EXPORT_SCHEMA, generatedAt: this.#clock.now(), cases };
  ```
- 另：该路由没有像 Muse 入站路由那样设置错误处理器（`apps/agent-service/src/production-muse-intake.ts:520-532`）。若 `marks.list` 抛错，会把 Fastify 默认 500 的 `message` 带出去，和旁边路由的“只返回稳定错误”不一致。
- 建议：只对可预期的坏快照（解密失败/JSON/结构不合法）逐条跳过；`marks.list`、保护器不可用等基础设施错误直接 5xx。跳过时计数并写诊断日志；导出体加 `skipped` 计数，避免静默丢失。给该路由补与 Muse 路由一致的错误处理器。

**2. 中：周报和“标记”命令仍没有逐条隔离，一条坏 Muse 载荷会让整页和所有标记失败**
- 文件：`apps/agent-service/src/production-gap-cases.ts:63-67`、`apps/agent-service/src/production-observation.ts:301-311`、`:322-324`
- 问题：`buildGapCases` 的 `open` 直接 `await options.seal.open(...)`；`seal.open` 在内容不是合法 UTF-8 或解密失败时会抛异常（`packages/application/src/services/proactive-seal.ts:28-34`）。周报 `#gapCases()` 没有 try/catch；`#markGapCase` 又先调用 `#gapCases(window)`，所以一条坏载荷会让周报接口和所有“加入 Backlog”请求一起 500。导出已经逐条隔离，但同一条数据在周报/标记路径没有。
- 证据：
  ```ts
  const open = async (ref: string | null, limit: number) => {
    if (ref === null || options.seal === undefined) return null;
    const text = await options.seal.open({ ...options.scope, ref });
    return text === undefined ? null : clean(text, limit) || null;
  };
  ```
- 建议：按候选逐条 try/catch，失败时把该字段置 `null`（或跳过该案例）并记录；至少不要把整个周报和标记命令拖垮。

**3. 中：标记/取消标记的“先提交数据库、后释放载荷”存在崩溃窗口，会永久留下孤儿快照**
- 文件：`apps/agent-service/src/production-observation.ts:317-319`、`:327-334`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:461-474`；`apps/agent-service/src/production-muse-intake-control.ts:170-173`
- 问题：作者说“取消标记后释放失败留下孤儿快照不在本 PR 范围”，但取消标记和失败释放恰恰是本 PR 新增的代码。`gapUnmark` 在事务里先删行并返回 ref，`#markGapCase` 之后才 `seal.release`；若进程在两者之间崩溃或 `release` 抛错，行已经不在，ref 只存在于失败请求的内存里，永久无法再释放。标记方向同样有窗口：`seal.seal` 之后、`marks.mark` 之前崩溃也会留下孤儿。`clearAll` 也是先删数据、后释放 refs（`production-muse-intake-control.ts:171-172`）。
- 证据：
  ```ts
  const ref = await marks.unmark({ ...scope, caseId: payload.caseId });
  if (ref !== null) await seal.release({ ...scope, refs: [ref] });
  ```
  ```ts
  const ref = await seal.seal({ ...scope, text: JSON.stringify(snapshot), at });
  const added = await marks
    .mark({ ...scope, caseId: payload.caseId, snapshotRef: ref, at })
    .catch(async (error: unknown) => {
      await seal.release({ ...scope, refs: [ref] });
      throw error;
    });
  ```
- 我未找到通用的孤儿载荷回收路径（只读代码范围内只见 `sqlite-governed-deletion.ts` 的按引用删除，不是全库 GC）。因此这不是“范围内外”的问题，而是新代码的崩溃一致性缺陷。
- 建议：引入持久化的待释放记录（先写待释放 ref，再删行，后台/下次启动重试释放），或提供能重放的卸载操作。至少不要让 ref 只存在于请求内存里。

**4. 中/低：先截断再遮盖，可能把敏感值截成半截后漏遮**
- 文件：`apps/agent-service/src/production-gap-export.ts:53-57` 与 `:120-125`
- 问题：`gapBacklogPrefill` 先用 `clip` 把 title 截到 120、summary 截到 900，导出时才 `mask()`。如果密码/银行卡号正好跨在截断边界，剩下的是不完整值，`redactForEgress` 的规则可能匹配不上，导出里就会留下半截敏感值。
- 证据：
  ```ts
  title: clip(`让 Himawari 也能提醒 Muse 提醒过的这类邮件：${subject}`, 120),
  summary: clip(`...`, 900),
  ```
  ```ts
  title: mask(prefill.title),
  summary: mask(prefill.summary),
  ```
- 建议：先对来源文字（`museTitle`、`museText`、`himawariReason`）做遮盖，再拼装和截断；或至少对截断后的每个字段再次按完整规则检查边界。

**5. 低：快照只防“会抛异常的结构”，没有校验结构是否完整；ADR 的“结构不对时跳过”不成立**
- 文件：`apps/agent-service/src/production-gap-export.ts:113-119`；文档 `docs/adr/0187-weekly-gap-lines-and-cases-against-muse.md:47`
- 问题：`JSON.parse` 后直接断言为 `GapCaseSnapshot`。测试里的 `{}`/`null` 之所以被跳过，是因为 `jstDay(undefined)` 会抛 `RangeError`，不是因为有结构校验。若快照是 `{"museAt":"2026-10-29T...","weekStart":"...","weekEnd":"...","id":"x"}`，不会抛错，导出会产出缺少 `attribution`、`memoryHits` 等字段、甚至带 `undefined` 的条目。ADR 说“结构不对时跳过”，与实现不符。
- 证据：测试只覆盖 `["{not json", "null", "{}"]`（`test/integration/gap-cases.test.ts:457`）。
- 建议：加一个显式的 `GapCaseSnapshot` 结构校验（字段类型、`attribution` 枚举、时间格式），校验失败再跳过；否则至少把这个结论写进 ADR 的“未覆盖”。

**6. 低：`LIMIT 1000` 在筛选前截断，不报截断；差距线不受影响但案例清单会静默少条**
- 文件：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:509`、`apps/agent-service/src/production-gap-cases.ts:52-62`
- 问题：上限加在“所有 Muse 已提醒且配对”的候选上，之后才 `isGapCase` 过滤、再 `.slice(0, 50)`。超过 1000 条时，排在后面的合格案例会完全看不到、也无法标记；接口没有 `truncated` 标志，用户不知道清单被截断。差距线不受影响，因为它走 `readCalibrationRows`（`packages/calibration/src/index.ts:631-635` 的 `museEntries` 没有 LIMIT），是从另一个查询算的。因此“1000 上限”不会让差距线和案例清单口径不一致；它只是让案例清单自身静默截断。
- 证据：
  ```sql
  ORDER BY e.muse_at, e.id LIMIT 1000
  ```
- 建议：把筛选（`muse_reminded=1` 且 Himawari 未提醒等）尽量下推到 SQL，或者保留 `LIMIT 1001` 用来判断“是否截断”，在快照里给出 `truncated`。另外 `gapReportLines` 的“没评过的 X 封只进案例清单”实际还受 `GAP_CASE_LIMIT=50` 限制（ADR:84 已承认 50 条，但报告文案没写），建议一并说明。

**7. 低：`INSERT OR IGNORE` 会把任何约束失败都当成“已标记”；作者“合约和迁移都校验”说法不准确**
- 文件：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:448-458`；`packages/persistence-sqlite/src/migrations/0082_gap_case_marks.sql:4`；`packages/gateway-contracts/src/validation.ts:49-59`
- 问题：服务端确实会重算案例并比对编号（`production-observation.ts:322-324`），所以当前命令路径不会写入任意编号；但合约只校验通用 `machineString`，迁移只校验 `gap_` 前缀和长度 24，都没有校验“20 位小写十六进制”。`INSERT OR IGNORE` 对 `CHECK`/`NOT NULL` 等约束失败也返回 changes=0，会被当成 `replayed: true`，把错误吞掉。
- 证据：
  ```sql
  INSERT OR IGNORE INTO gap_case_marks ...
  ```
  ```sql
  case_id TEXT NOT NULL CHECK (case_id GLOB 'gap_*' AND length(case_id) = 24),
  ```
- 建议：改成 `INSERT ... ON CONFLICT(owner_id, agent_id, case_id) DO NOTHING`，只忽略主键冲突；迁移把 CHECK 收紧为 `gap_` + `[0-9a-f]{20}`（例如 `case_id GLOB 'gap_[0-9a-f][0-9a-f]...'` 或等价长度/字符检查）。

**8. 低：标记状态是全局的、案例清单是当周的，导致“案例不再合格后标记无法在网页取消”**
- 文件：`apps/agent-service/src/production-observation.ts:205-208`、`:261`；`apps/agent-service/src/production-gap-export.ts:106-107`；`apps/control-center/src/components/weekly-report.tsx:1134-1139`
- 问题：`markedIds` 取的是该 owner/agent 的**全部**标记，但 `gapCases` 只来自当前窗口；导出又列出全部标记。如果一封邮件被重新评价后不再满足 `isGapCase`（`rate` 会删除并重插 `muse_reference_entries`，见 `sqlite-muse-intake-operations.ts:490-512`），它就从网页案例清单消失，但标记仍在导出里，网页没有入口取消，只能“清除全部 Muse 数据”。作者说“旧编号的标记行无证据”，这里能给出机制证据；实际发生频率是场景问题。
- 建议：网页/命令提供一个“所有标记”的列表或按案例编号直接取消的入口；或定期把不再合格的标记列出让用户处理。ADR 目前只写了“留在导出里直到 Andy 取消”，没写取消入口。

**9. 低：新增的失败释放和 1000 上限没有自动检查；新命令也没有走真实网关的端到端用例**
- 文件：`test/integration/gap-cases.test.ts:286-290`
- 问题：`h.mark` 直接构造对象 `as unknown as GatewayV2Command` 调 `ProductionObservation.execute`，跳过了 `production-approval-gateway.ts:219-220` 的路由、`installedOperations`、真实合约解析和授权。合约 fixture 会往返（`gateway-v2.fixture.ts:300` 被 `compatibilityMessages` 收录），但没有测试证明这条命令在网关层真的能被路由到 `observationControl`。另外，`marks.mark` 失败释放、`unmark` 释放失败、`LIMIT 1000` 截断都没有测试。`[negative] skips a damaged snapshot` 在去掉逐条 catch 后确实会失败（会 500），这一点反向用例是有效的。
- 建议：补网关层用例（至少一次经 `AgentGatewayV2Service`/`createProductionHttpComposition` 的成功路径）；补 mark 写库失败时载荷被释放（可用桩 seal 记录 release）、以及 1000 边界/截断标志的用例。

### 推测 / 未核实

- 导出方（Backlog/定时会话）拿到空 `cases` 会如何处理，未读外部代码，无法确认是否会造成“误删/不再重试”。但“200 + 空清单”至少会让故障不可见。
- 密钥轮换或载荷损坏在生产中是否实际发生，未核实；这是错误路径的防御性问题。
- 第 4 条“半截敏感值”的实际泄露取决于被截断的具体规则和位置，我没有构造复现；建议按最坏情况处理。
- 是否存在仓库之外的孤儿载荷清理任务，只读代码范围内未找到；若有，第 3 条的严重度可降低。
- 第 8 条中“用户确实会重新评价到不再合格”是场景推测；代码机制（rate 删除重插、导出列全部标记、网页只列当周）已确认。

### 侧重检查

- 未鉴权/错误令牌/限流：`BearerGate` 用 SHA-256 后 `timingSafeEqual`，认证 30/分钟、失败 60/分钟，401 空体；导出与 Muse 使用不同密钥、最小长度 32；配置解析只接受 `gap-export` 用途（`strict-configuration.ts:1418-1427`）。结论：鉴权路径本身没发现问题。
- 错误处理器缺失：导出路由没有像 Muse 入站路由一样设置稳定错误处理器，见问题 1。
- 损坏/不可信输入：坏快照逐条隔离有效但吞错；部分坏快照未校验；坏 Muse 载荷和坏 `decision_ledger.inputs`（`json.parse` 在 `sqlite-decision-ledger-operations.ts:513`）会让整页/标记失败，见问题 2、5。
- 资源耗尽：新查询有 1000 上限但无截断标志；导出未分页地读取所有标记并按条解密；`buildGapCases` 对最多 50 个案例并发解密最多 150 个载荷。总体可控，但缺少截断可见性和导出规模上限。
- 不可撤销操作：标记/取消标记/清除 Muse 数据的“先改库、后释放载荷”有崩溃/异常孤儿窗口，见问题 3。
- 规则/文档与代码一致性：ADR 的“结构不对时跳过”（问题 5）、“案例编号由合约和迁移校验”（问题 7）与代码不完全一致；ADR 已写“每周最多 50 条”，但 1000 上限和新取消入口未写。

### 必答问题

1. **会不会改变模型见过的请求开头？**
   不会。这次改动没有触碰任何组装模型请求的代码（无 `runtime-pi`、提示词目录、工具定义、历史、遮盖逻辑改动）。新增的差距线/案例只出现在控制中心周报快照、导出接口和命令行校准报告里；`buildReport` 只被 `scripts/calibration-report/report.mjs` 和测试调用，没有进入模型请求。ADR 第 8 条“不新增任何发给模型或嵌入服务的请求”与代码一致。因此“只在末尾追加、每轮会变的值都在最后一条消息”这一性质不受影响。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对发给模型的内容：不会，因为本次没有模型请求。对新增的非模型输出：排序是确定的（`gapMarks` 用 `ORDER BY marked_at, case_id`，候选用 `ORDER BY e.muse_at, e.id`，`Promise.all` 保持输入顺序，`gap.lines` 固定为 `[hitRate, disturbanceRate]`），遮盖是纯函数。只有 `generatedAt`（导出和周报快照）每次取当前时间而变，但这不是模型请求的一部分；周报 Markdown 的时间标签来自窗口参数，也不随请求时间变。没有发现“依赖前后文的遮盖”或“无序集合”影响模型字节。

3. **有没有对应的自动检查，反向用例真的会失败？**
   - 导出逐条隔离：有 `[negative] skips a damaged snapshot`，去掉 catch 会因 500 失败，反向有效；但只覆盖非 JSON、`null`、`{}` 三种，不覆盖“部分字段缺失但能解析”的结构（问题 5）。
   - 标记写库失败释放快照：**没有测试**（代码里有，测试没有）。
   - 取消标记/清除数据释放孤儿：**没有失败路径测试**。
   - 1000 条上限：**没有测试**。
   - 正相关区间分支：新增测试确实走到 `e > n/2`（`20,2,1,20`：`e=398 > 43/2`），但它只断言有限、包住差值、宽度小于 0.25，没有独立参考值，属于冒烟测试而不是精确门槛。
   - 新命令：合约 fixture 有往返校验；控制中心单测验证发出命令；**没有走真实网关/真实授权的端到端用例**（`gap-cases.test.ts:286-290` 直接调 `execute`）。
   - 三语文案和 ADR 的修改没有内容级自动断言。

4. **每个产生/使用的值，两端都能接受吗？**
   - `caseId`：`gapCaseId` 产出 `gap_` + 20 位小写十六进制（24 字符）；`machineString` 接受，迁移 CHECK 的 `gap_*` + 长度 24 接受，UI `data-case-id` 和 `resultRef`（`gap-case-mark:` 前缀）也接受。**今天可用**，但两端校验都比生产值更宽（问题 7）。
   - `endDay`：UI 传 `report.endDay = window.endDate`（`resolveWindow` 的排他结束日）；`jstDaySchema` 接受；服务端 `resolveWindow({end: endDay, days:7})` 能复现同一窗口，集成测试用 `2026-11-03` 对 `2026-11-02T15:00Z` 也验证了这一点。
   - `gapExportSecretRef`：`parseMuseIntake` 已加入允许键并校验 `gap-export` 用途；`service-main` 据此创建导出；启动配置测试覆盖了正确引用、错误用途、缺失引用。两端一致。
   - 周报快照新增 `gap`/`gapCases`/`marked`：合约 schema、控制中心 fixture、UI 类型和测试都更新了；`gap === null` 时 UI 显示“本周尚未结束”。两端一致。
   - 唯一的跨端不一致是：生产 `caseId` 的校验（合约/迁移）比生成值宽；以及 `markedIds` 全局、`gapCases` 当周导致“导出里有、网页里取消不了”的标记（问题 7、8）。
