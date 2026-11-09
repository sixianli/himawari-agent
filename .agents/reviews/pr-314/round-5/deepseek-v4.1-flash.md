# PR 314 第 5 轮复核结论（增量 47556297 → 315e677a）

## 问题（按严重度）

### 中

**1. 新增的「先遮盖再截断」反例只测了 `buildGapCases`，没有测标记命令的接线，去掉生产接线测试仍会全绿（读代码证实）**

- 文件: `test/integration/gap-cases.test.ts:521-545`，对照 `apps/agent-service/src/production-observation.ts:327`
- 问题：本轮修复的核心是让「标记时」先遮盖再截断。但新反例直接调用 `buildGapCases({ ..., mask: maskForExport })`，没有走 `proactive.gapcase.mark` 命令；生产接线在 `production-observation.ts:327` 的 `this.#gapCases(window, maskForExport)`。把这里的 `maskForExport` 删掉，这条反例仍然通过。
- 证据：
  - 测试：`const masked = await buildGapCases({ scope, candidates: input, seal: h.seal, mask: maskForExport });`（`gap-cases.test.ts:533-538`）
  - 生产：`const found = (await this.#gapCases(window, maskForExport)).find(...)`（`production-observation.ts:327`）
  - 现有的导出遮盖测试（`gap-cases.test.ts:369-385`）也不能兜住：导出预填阶段本来就会 `mask(snapshot.museTitle)`，所以即使标记时存了未遮盖的快照，那个短密码测试也照样通过。
- 建议：加一条走命令路径的集成测试：Muse 标题长度超过 300 且在截断边界附近放银行卡/密码，`h.mark` 后用 `h.seal.open(mark.snapshotRef)` 直接断言存下来的快照没有原文/半截敏感值；再断言导出 `summary` 不含该值的可读片段。

**2. 周报快照路径没有做「先遮盖再截断」，与「覆盖所有生成路径」的说法不一致（读代码证实；影响有限，需确认是否故意）**

- 文件: `apps/agent-service/src/production-observation.ts:205`，对照 `:327`、`production-gap-cases.ts:64-70`、`production-gap-export.ts:72-86`
- 问题：标记路径传了 `maskForExport`，导出预填也先 `mask` 再 `clip`；但周报查询 `const gapCases = await this.#gapCases(window);` 没有传 `mask`，因此周报快照里的 `museTitle/museText/himawariReason` 仍是原文按 300/500 截断。
- 证据：
  - 周报：`const gapCases = await this.#gapCases(window);`（`production-observation.ts:205`）
  - 标记：`this.#gapCases(window, maskForExport)`（`:327`）
  - 截断：`clean(options.mask ? options.mask(text) : text, limit)`（`production-gap-cases.ts:68-70`）
  - 导出预填：`const subject = mask(snapshot.museTitle ?? ...)` 后 `clip(..., 120)`（`production-gap-export.ts:73-83`）
- 说明：周报快照只发给已登录的本人网页（`proactive.ts:154` 固定 `end: null`，`weekly-report.tsx` 直接显示），不是出口；所以它不是对外泄露，但如果按「截断边界不能切开敏感值」的威胁模型，周报页仍有切口。是否故意保留原文，应在 ADR 或注释里写明。

### 低

**3. 遮盖占位符自身会被截断，反例断言靠「巧合」通过（读代码 + 推算证实）**

- 文件: `packages/sensitive-capture/src/redaction.ts:333`、`production-gap-cases.ts:30-36`、`test/integration/gap-cases.test.ts:540`
- 问题：银行卡的占位符是 `[银行卡 尾号1111]`，本身含 `1111`。新测试断言的 `not.toMatch(/4111|1111/u)` 之所以通过，是因为 285 个「甲」把占位符推到第 290 位，300 字截断正好把占位符切成 `[银行卡 尾号111`（只剩 3 个 1）。如果前缀少一个字符，占位符完整保留，测试会失败——不是遮盖失败，而是断言写错。同时说明实现会留下半截占位符。
- 证据：`return mask("bank-card", \`银行卡 尾号${digits.slice(-4)}\`, ...)`（`redaction.ts:333`）；`clean` 按字符累加到 limit（`production-gap-cases.ts:30-36`）。
- 建议：断言「不含完整卡号中可识别的数字串」，而不是不含 `1111`；并在遮盖后截断时避免切开占位符（例如按占位符边界回退，或改占位符不再含后四位）。另加一条前缀长度变化的参数化用例。

**4. 早于本周的标记在网页上不可见，也就无法从产品取消；导出会永久保留并无限增长（读代码证实，属既有、非本轮增量）**

- 文件: `apps/control-center/src/proactive.ts:152-158`、`weekly-report.tsx:1084-1160`、`production-observation.ts:205-208`
- 问题：周报固定 `end: null`（当前周），取消按钮只渲染当周 `report.gapCases`。标记行跨周保留，但历史周的案例不再出现在列表里，产品里没有入口取消这些标记。ADR 写「已标记的案例留在导出里，直到 Andy 取消」，但用户无法取消历史周的标记。
- 证据：`queryMessage(configuration, "proactive.weekly.read", { end: null })`（`proactive.ts:154`）；`markedIds` 只用来给当周 `gapCases` 标 `marked`（`production-observation.ts:206-208`）。
- 建议：导出里带上可取消的入口/提供按周读取；或在清除/导出侧加清理策略。至少 ADR 要写明历史周标记无法从网页取消。

**5. 直接 `DELETE FROM payloads` 绕过 `PayloadStorePort.delete`，当前内联存储下等价，但换成密文文件存储会留下文件（读代码证实 + 潜在风险推测）**

- 文件: `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:473-475`、`sqlite-muse-intake-operations.ts:536-539`，对照 `packages/platform-node/src/ciphertext-file-store.ts:258-265`
- 问题：`seal.release` 走的是 `payloadStore.delete`；如果将来用 `HybridPayloadStore`，它会 `this.#files.delete(...)` 删除密文文件。现在两处改为直接 SQL 删 `payloads` 行，密文文件不会被删。当前生产 `EnvelopePayloadProtector` 固定 `storage: { kind: "inline" }`，且 `HybridPayloadStore` 只在测试里实例化，所以现在没有泄露；但与 ADR「载荷和标记同在一个数据库文件里」的假设强耦合。
- 证据：`storage: Object.freeze({ kind: "inline" as const })`（`payload-protector.ts:225`）；`delete` 里才删文件（`ciphertext-file-store.ts:258-265`）。
- 建议：在注释/ADR 写明这个假设，或提供 repository 层的「删除载荷并清理外置文件」接口，供清除路径复用。

**6. 导出与并发取消标记之间存在竞态，可能把「刚好被取消」误报 500；导出也无标记数量上限（读代码证实 + 推测）**

- 文件: `apps/agent-service/src/production-gap-export.ts:135-170`
- 问题：`marks` 先 `list`，再逐条 `open`。若期间用户取消全部标记，所有 `open` 返回 `undefined`，`marks.length > 0 && cases.length === 0 && skipped === marks.length` 就会抛 `GAP_EXPORT_ALL_SNAPSHOTS_UNREADABLE`，返回 500，尽管原因是并发取消。另外标记跨周永久保留，导出每次遍历全部标记，没有条数上限。
- 证据：`if (marks.length > 0 && cases.length === 0 && skipped === marks.length) throw new Error(...)`（`:169-170`）。
- 建议：区分「存储/解密失败」与「标记在读取时已被删除」；对导出加合理上限或分页。

**7. 取消标记的事务已删除载荷后仍调用 `seal.release`，可能把已成功的取消变成报错（读代码证实）**

- 文件: `apps/agent-service/src/production-observation.ts:321-324`、`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1774-1780`
- 问题：`marks.unmark` 已在事务里删掉 `payloads` 行；随后 `seal.release` 走 `deletePayload`，其第一步是 `this.assertDiskHeadroom()`。磁盘紧张时会抛错，命令失败，但标记和载荷其实都已删除。重试才会显示 `replayed: true`。
- 证据：`if (ref !== null) await seal.release({ ...scope, refs: [ref] });`（`production-observation.ts:323`）；`deletePayload` 首行 `this.assertDiskHeadroom();`（`sqlite-durable-operations.ts:1775`）。
- 建议：取消路径不再调用 `seal.release`（或改为忽略删除结果），把释放只留给标记失败/重复标记路径。

## 侧重检查

- **错误路径**：导出全不可读会 500 空体（测试覆盖）；并发取消会误报 500（问题 6）；取消标记后多余 `release` 可能报错（问题 7）；标记写库失败会主动释放快照（`production-observation.ts:334-340`，未见测试，未核实）。
- **不可信输入**：`caseId` 过网关 `machineString`（`validation.ts:49-60`，允许 `_`，长度 24 的 `gap_` id 可过）；`endDay` 过 `jstDaySchema`；快照 JSON 经 `isGapCaseSnapshot` + `parsed.id === mark.caseId`；超长/畸形快照跳过。均读代码证实。
- **安全**：导出口令经 `BearerGate`（SHA-256 + `timingSafeEqual`，最小 32 字符，认证 30/分、失败 60/分）；`gapExportSecretRef` 在 `strict-configuration.ts:1418-1427` 强制用途 `gap-export`；清除 Muse 数据的三语文案都写了会删 Backlog 标记。读代码证实。
- **资源耗尽**：`readGapCandidates` 硬上限 1000、案例上限 50；但导出遍历全部标记无上限（问题 6）。
- **不可逆操作**：取消标记、清除 Muse 数据均不可撤销；清除前 UI 有确认，取消标记无二次确认（符合「再点一次取消」的交互）。历史周标记无法取消（问题 4）。
- **规则/文档与代码一致性**：ADR 的「标记时先遮盖再截断」「同事务删行+载荷」「导出 id 必须一致」「Rollout 示例含 generatedAt/skipped」均已和代码核对一致。唯一不一致是「覆盖所有生成路径」：周报快照未遮盖（问题 2）。三语清除文案与 `clearAll` 实际行为一致（`zh-CN.ts:1067/1069`、`en.ts:1142/1144`、`ja.ts:1136/1138`）。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本改动只新增/修改主动周报查询响应、导出接口、数据库标记表和 UI，没有新增模型或嵌入请求（ADR 第 8 条，代码里也找不到 `gapCases` 进入模型请求的路径）。系统提示、工具定义、历史消息、遮盖规则均未改。发给模型的内容仍然只在末尾追加；本轮新增的每请求变化值 `generatedAt` 只出现在导出 HTTP 响应里，不在模型请求里。结论：不改变请求前缀（读代码证实；「将来若把周报快照喂给模型」未核实，目前无此路径）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
- 模型侧：不涉及，没有新增遮盖或序列化进入模型请求。
- 标记快照：`maskForExport` 调 `redactForEgress` 时不传 `known/trusted`，对同一输入输出确定；先遮盖后 `clean`，同一字段每次字节相同。`gapCases` 顺序由 SQL `ORDER BY e.muse_at, e.id` 固定，`Promise.all` 保持输入顺序，`marked` 只做集合判断，不改变顺序。读代码证实。
- 导出响应：整体字节不固定，因为每次 `generatedAt` 是 `clock.now()`，`skipped` 也可能因并发变化；但这是响应元数据，不是模型内容。若下游按整包哈希去重需注意。
- 结论：同一段文字本身不会因前后文遮成不同字节；模型可见内容不受影响。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
- 取消标记删快照：`gap-cases.test.ts:504-519` 直接调 `marks.unmark`，旧实现（只删标记行）会让 `payloadStore.get` 仍有值，必失败。有效。
- 清除 Muse 数据删快照：`:436-453` 直接调 `clearAll` 并检查载荷，旧实现必失败。有效。
- 导出 id 不一致跳过：`:547-580` 旧实现会多返回一条、`skipped` 也只有 1，必失败。有效。
- 先遮盖后截断：`:521-545` 在旧顺序（先 `clean` 后 `mask`）下，截断后只剩 8 位「4111 1111」不满足 13 位卡号规则，`masked` 会含 `4111`，必失败。有效。
- 缺口：没有走 `proactive.gapcase.mark` 的接线测试（问题 1）；没有验证事务原子性的用例；没有标记写库失败时主动释放快照的用例。部分有效。

**4. 每个产生/修改的值，使用方都能接受吗？**
逐项核对（读代码证实）：
- `caseId`：生产 `gapCaseId` = `gap_` + 20 位十六进制，长度 24（`production-gap-cases.ts:39-41`）；DB `CHECK (case_id GLOB 'gap_*' AND length(case_id) = 24)`（`0082_gap_case_marks.sql:4`）；网关 `machineString` 允许字母数字和 `._:-`，`gap_...` 通过（`validation.ts:49-60`）；导出再校验 `parsed.id === mark.caseId`（`gap-export.ts:147`）。两端一致。
- `snapshotRef`：`createProactiveSeal` 生成，先 `payloads.put` 再 `marks.mark`，满足 `REFERENCES payloads(ref)`（迁移 0082:5）；读取用 `seal.open`。两端一致。
- `markedAt`：`clock.now()` 在生产是 `new Date().toISOString()`（`service-main.ts:205-206`），满足 `GLOB '????-??-??T??:??:??.???Z'`（迁移 0082:6）。一致。
- `clearAll` 返回的 `refs`：现在只含 title/text，消费方 `production-muse-intake-control.ts:171-172` 只做 `seal.release`，类型和语义都接受；旧测试已改成不期望 snapshotRef（`gap-cases.test.ts:444-448`）。一致。
- `gapExportSecretRef`：`strict-configuration.ts:1064-1077` 接受该键，`:1418-1427` 校验用途必须是 `gap-export`；`service-main.ts:1688-1712` 只有在 `museIntake.enabled` 时解析，否则启动报 `GAP_EXPORT_RUNTIME_UNAVAILABLE`。两端一致。
- 周报快照新增 `gapCases/gap` 字段：`contracts-v2.ts:874-919` 的 schema 与 `production-observation.ts:261-281` 输出匹配；`museTitle/museText/himawariReason` 经 `clean` 去掉控制字符并按 300/500 截断，能过 `boundedString`。一致。
- 导出响应 `generatedAt/skipped`：ADR Rollout 示例已补上（`docs/adr/0187...:70`），接口 `GapExportBody` 一致。一致。
