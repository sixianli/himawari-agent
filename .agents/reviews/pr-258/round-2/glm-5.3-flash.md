## 复核结论（PR #258 第 2 轮，1ccb5152）

先说总评：作者列的 5 处修改与代码逐一相符，没有发现会直接出错的新问题；主要遗留是**去重键变更对已有行的影响没有处理**，以及**两处新增合并缺少真正能反向失败的用例**。以下按严重度排列。

---

### 中 — packages/persistence-sqlite/src/sqlite-sensitive-interceptions.ts → dedupe_key 格式变更不迁移，已有行从此“静止”

- **问题**：`sensitiveInterceptionDedupeKey` 从键里去掉了 `ruleId`（operations 61-75 行）。已在库里的行（键仍含 ruleId）与新来的同值观测算出的 `dedupe_key` 不同，`ON CONFLICT(owner_id, agent_id, dedupe_key)`（129-131 行）不再命中：同值再出现会新增一行，旧行的 `seen_count`/`last_seen_at` 永远停在迁移前。列表里同一段文字会裂成两行。
- **证据**（我读到的）：operations 61-75 行键字段只有 `[threadId, source, purpose, part, category, fingerprint, outcome]`；`grep sensitive_interceptions` 显示 migrations 只有 `0078_sensitive_interceptions.sql`，且只有 `CREATE TABLE`，**没有**重算 dedupe_key 的迁移。
- **缓解**：该表本身也在本 PR 里新建（0078 未发布），影响面只是“跑过本分支早期构建的环境”。
- **建议**：若该分支已有测试/预发库，补一条一次性 `UPDATE` 重算 dedupe_key 的迁移；否则至少在 PR 说明里明确接受这个一次性割裂。

### 低-中 — 作者说法 2 的覆盖范围说大了：邮件判决和 embedding 仍归不进对话

- **问题**：“后台调用记录 threadId 为空 → 按 runs 表查出对话”只对 `generateTextOnce` 路径成立。邮件判决的上下文是 `threadId: null` 且**没有 runId**（apps/agent-service/src/service-main.ts:1546-1556）；而且 ProactiveModelInvoker 的 runId 是合成的 `proactive:<invocationId>`（production-model-composition.ts:519），`runs` 表只在 `sqlite-thread-operations.ts:993-1010` 写真实 run 的行，这种合成 id 查不到，即使 transport 合并了也会解析为 null。
- **证据**：service-main.ts 1547-1556（`threadId: null, source: "mail", purpose: "mail-judgment"`，无 runId）；production-model-composition.ts 519（`const runId = \`proactive:...\` as RunId`）。
- **判断**：不是错误（邮件本不属于某个会话），但作者“后台调用记录…按 runs 表查出对话”这一句与代码范围不符，需要修正如实陈述。

### 低 — model-egress 请求内合并的现有用例不具备反向力

- **问题**：`packages/application/test/model-egress.unit.test.ts:519-539` 的新用例"同 part 重复出现只报一次”，旧代码 identity `${part}\u0000${kind}\u0000${ruleId}\u0000${fingerprint}` 中同一规则两次产出的 identity 也相同，旧代码同样只报一次——这个用例在旧代码下也通过，不能证明“不同规则合并、保留首次”新行为。`reportMasked` 的合并（model-egress.ts:496-501，键 `${kind}\u0000${fingerprint}`）同样没有“不同规则同一值”的直接用例。
- **证据**：这实际风险低：真正的反向覆盖在 DB 层——`test/integration/sensitive-interceptions.test.ts` 新用例"keeps one row when a value is caught by a different rule"在旧代码下会得到两行、会失败，部分补齐了缺口。
- **建议**：给 `reportMasked` 加一条同一值两条不同 ruleId 的 sightings，断言只报一条、ruleId 取首次。

### 低 — fix 5 的反向用例缺口

- **问题**：现有 throw 用例（test/integration/proactive-mail-check.test.ts:464-471，`onMasked: () => { throw ... }`）在旧代码里本来就在 try 内（旧版 `try { onMasked(sightings) } catch`），所以它能反向失败的部分和本次改动无关；本次真正新纳入 try 的是 `findSensitiveValues` 的整个 sightings 计算（proactive-mail-check-service.ts:349-362），没有对应用例。
- **建议**：可接受（难以构造 findSensitiveValues 抛错），但应在说明里点明。

### 低（已声明的已知限制，核对属实）

- 发给模型：`proactiveMailView` 用 `windowMailBody(masked(item.body), bodyLimit)`——**先遮盖后截断**（proactive-mail-check-service.ts:198）；上报扫描用 `windowMailBody(item.body, ...)` **对原文截断后**找值（354 行）。遮盖占位符通常比原值长（如 `[密码#xxxxxxxx]`），窗口边界会错位，边界附近的值一个多报一个漏报，正如作者声明。

---

### 作者各修法的核对（读码证实）

| 修法 | 核对 |
|---|---|
| 1 窗口/附件上限 | ✅ 354-355 行与 198、209-213 行口径一致（都 `perMail`、都 `slice(0, 10)`）；边界差异如上、已声明 |
| 2 runId | ✅ ModelEgressContext 加 runId（model-egress.ts:31）；PiModelTransport 每次 invoke 合并 `{...ctx, runId: request.runId}`（pi-model-transport.ts:281-285，不改动共享对象）；SQLite 按 owner+agent+runId 查 thread_id（operations 121-123、138-145）；generateTextOnce 带 `request.threadId`（composition 452、462-468、576-581）。范围偏差见上表第 2 条 |
| 3 去重不含 ruleId | ✅ Exchange identity（model-egress.ts:202）、reportMasked 键（498）、DB 键（operations 64-74）都不含 ruleId；upsert 不更新 rule_id（129-131）→ 保留首次规则。对已有数据的影响见最上条 |
| 4 先 schedule 后 onDropped | ✅ recorder.ts 125-134：`#schedule()` 在溢出裁剪和 `onDropped` 之前 |
| 5 整个 #reportMasked 进 try | ✅ 349-362 行 |

### runId 查对话的担心点核对（读码证实）

- run 不存在 → `pluck().get(...)` 返回 undefined，`?? null` → 记 threadId null（operations 138-145；集成测试 run-unknown → null 覆盖）。
- 跨 owner/agent → 查询带 `owner_id = ? AND agent_id = ?`（121-123），不会串。
- run 存在但对话已删 → `threadExists` 查不到 → **该观测整体 skipped**（146-152），不是记 null。合理，属行为选择。
- threadId 非空但有 runId → 直接用 threadId，不查（138 行 `observed.threadId === null` 条件）。

### “判为不成立”四条复核

1. **清除竞态**：成立。clear 前 flush 证实在：`ProductionSensitiveInterceptionsControl.execute` 94 行 `await beforeRead?.()` 后才 95 行 `store.clear`；`beforeRead` 即 `flushSensitiveInterceptions`（production-http-composition.ts:1099 → production-model-egress.ts:44-46）。flush 会 `while` 排空队列（recorder 156-184）。flush 返回后到 DELETE 之间到达的拦截按“新拦截”账，边界语义本来就模糊，站得住。
2. **role "function"**：**未核实**——pi-ai 是外部依赖（packages/runtime-pi/package.json:10，`@earendil-works/pi-ai 0.84.2`，仓库无源码）。已核实的是影响面：即使出现，`partOf`（model-egress.ts:294-307）落到默认分支继承 part，只影响记录的 `part` 字段，遮盖本身不受影响。可接受，但严格说这条是“靠依赖版本事实”。
3. **UTC 分组**：成立。`localDay` 用本地 getter（control-center/src/components/sensitive-interceptions.tsx:21-24）。
4. **记忆规则映射**：成立。`memoryCategory` 直接用 `MACHINE_SECRET_RULE_IDS`（recorder.ts:32-37）。

---

### 必答问题

**1. 会不会改变模型已见过的请求开头？** 不会。读码证实：本轮全部改动都在“上报/持久化元数据”侧——runId/threadId 只进 `ModelEgressContext`（model-egress.ts:27-34、pi-model-transport.ts:281-285），请求体遮盖仍只由 `tag`/`known`/`table` 决定，`observe` 是旁路（190-211 行）；`#reportMasked` 只读邮件原文调 `findSensitiveValues`，不触碰 prompt 组装（prompt 由 `proactivePrompt`→`proactiveMailView` 的先遮盖后截断结果构成，194-245 行）；数据库去重键只影响落库。发给模型的内容字节与改动前完全一致，“只追加”规则无触碰点。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。fingerprint 和占位符仍由 `sign(key, kind+value)` 决定（199-206），遮盖确定性未动；runId/threadId/上报 Map 顺序都不进请求。唯一“同文字不同字节”的路径是遮盖密钥轮换，那是既有变化且与本 diff 无关。落库字节方面，dedupe_key 格式变更会让**库里**旧值新值分成两行（上面第 1 条），但那是数据库，不是发给模型的字节。

**3. 改动有没有对应的自动检查、反向用例真的会失败？** 部分有：fix 1→[SI-3]（旧代码会报 middlepass99/lastfile99.txt，断言必失败）；fix 2→[SI-2]（旧代码 context 缺 runId，失败）+ SQLite 集成两条（run 解析、跨规则合并行，旧代码均失败）；fix 4→recorder 单元（旧代码 onDropped 抛错后不 schedule，poll writes=1 失败）。fix 3 请求内合并与 fix 5 的现有用例在旧代码下**同样通过**，反向力不足（见上面低严重度两条）。
