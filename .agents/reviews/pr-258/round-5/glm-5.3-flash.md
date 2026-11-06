现在让我来看一下传输/记录部分的改动。
现在我来检查 `sqlite operations` 的 `fail` 方法、`schema` 的 `FK`，以及生产环境的 `base egress context`。
我来检查一下这些改动所依据的规则。
# 复核结论（PR #258 第 5 轮，3da891a1，基线 f6829fa，上轮复核 3af08b66）

## 侧重检查

我走了一条最普通的使用流程——**动作复核的敏感信息拦截记录**：`run` 内低于阈值的动作 → `action-policy-service.ts:436` → `AutomaticActionReviewService.review`（automatic-action-review.ts:86）→ `ModelActionReviewer.review`（model-action-reviewer.ts:93，用 `intent.runId` 调 `model.invoke`）→ `TrustedModelProviderAdapter`（production-model-composition.ts:413，transport 是 `modelTransportFor` 的 `piTransport`，egressContext `threadId: null` + `egressThreadOf`）→ `PiModelTransport.invoke`（pi-model-transport.ts:300，发请求前查 thread）→ 出口遮盖在 `Exchange.#prepare` 里 `report(context, …)`（model-egress.ts:221）→ `SensitiveInterceptionRecorder.reportEgress`（入队，200 毫秒后写）→ `SqliteSensitiveInterceptionOperations.record`（threadExists 校验 + 外键级联）。

**没有测试覆盖的代码路径**：
- service-main.ts:299–304 的 `egressThreadOf` 接线（作者已承认；apps/agent-service 全部测试 grep 无 `egressThreadOf`/`threadOfRun`）。
- production-model-composition.ts:337 把该选项透传给 transport：无任何断言。
- 集成测试 test/integration/sensitive-interceptions.test.ts 的“运行被删后记录保留”用例**直接调 `store.record`**，没有走 “PiModelTransport 先查 thread → 记录器 200ms 后写” 的完整链条；该链条在传输层（pi-model-transport）、对象层（recorder）、存储层（integration）各测了一段，端到端（尤其“发请求前是运行仍在、写库时刚被删”窗口）没有整体用例。

## 读代码证实的

**1（低）/ pi-model-transport.ts:250–254** — `#egressContextFor` 把**一切**异常（包括数据库损坏、端口被关、`threadOfRun` 里 `fail` 抛出的 PORT_INVALID_OPERATION）都吞掉，返回基础 context（threadId=null），请求照发。后果：故障时的记录以 thread_id=NULL 落库——dedupe_key 含 threadId（sqlite-sensitive-interception-operations.ts:61–70），同一段文字第一次故障、第二次成功的两条记录 key 不同，同一条秘密会占两行，NULL 行永远无法归因、也不会随对话删除。这与作者说的“按 threadId=null 上报”一致（设计如此），但“故障时的归因劣化 + 行分裂”是新增的持久化副作用，建议（不应阻塞）：考虑在 report 端对“查询失败”与“文本异常”留不同标记或在 dedupe 里区分。证据：pi-model-transport.ts:245–255；sqlite 操作 61–70、45–59（`validObservation` 已不再校验 runId）。

**2（低）/ redaction.ts:371–380（occurrences）** — `occurrences` 用裸 `indexOf` 数次数，不认 `\b` 词边界；而识别（machine-secrets.ts 的正则）认。如果一个被识别的值在正文里以“无边界”形态多出现一次（例如黏在更长 token 里 `xsk-abc…y`），次数会虚增 → 误判为 null。证据：machine-secrets.ts:32 的 `\bsk-…\b`；occurrences 无边界检查。影响只在邮件上报降级到近似（proactive-mail-check-service.ts:191–193），不产生错配行为，可接受；如要收窄可放宽为"出现次数 ≥ 识别次数"再靠重叠位检查兜底。

**3（低，测试覆盖缺口）** — 三处行为均有直接测试且反向用例成立（见必答问题 3），但生产接线（service-main ↔ composition ↔ transport）没有一条测试走到；作者已如实申报。这条我核对过：apps 下全部 4 个 `createProductionModelComposition` 调用点的测试均未断言 `egressThreadOf`（grep 无命中）。

## 未核实（推测）

- 作者说 34912da1/合并提交“本 PR 自己的文件没有变化”——我从 `git log` 确认是合并 origin/main（#250–#257），未逐行核对合并后的每个文件。基线 f6829..head 的其余改动都来自已进 main 的 PR，不在本轮核对范围。
- `npm run check` 全量（33 steps）通过是作者自述，我未运行。

## 必答问题逐条回答

1. **会不会改变模型已经见过的请求开头？** 不会，证实。改动只触及：`machinePositions`（只被 `locateMaskedValues` 使用，属邮件上报路径，不用在发给模型的遮盖里）、egress 上下文的 thread 解析、SQLite 抽查指令、record 写入。发给模型的内容仍由 `redactForEgress` 产出（未被本次修改），`Exchange.#prepare` 里 context 只传给 `report` 监听器（model-egress.ts:126–134、221），不进请求体——每轮会变的 threadId 不在发给模型的消息里，仍然只在末尾追加、值只在观测端。符合 [prompt-prefix.md](../../.claude/rules/prompt-prefix.md#rules) 第 4 条。
2. **同一段文字会不会在不同请求里变成不同字节？** 发给模型的字节不变：遮盖.getTag 用同名密钥、`machinePositions` 只影响上报 Span 的定位，不影响正文遮盖的字节（redactForEgress 未被修改）。定位函数是输入的纯函数，确定。受影响的只是记录表里的 threadId/dedupe_key——那不在模型请求里，但见上面问题 1（故障时同一内容会产生 key 不同的两行）。
3. **有没有自动检查、反向用例会不会失败？** 有，且我逐条逆向核过：红色测试「Bearer 里和单独各有一个同样的密钥」——旧代码 `openai` sighting 会被 `indexOf` 放进 Bearer 里那次出现的坐标，排序后配到错误的占位符，返回非 null 的错配结果，测试断言 null 会失败（由 machine-secrets.ts:67–71 规则顺序 + redaction.ts 旧实现推证）；「同值出现两次且都被遮」在新逻辑下仍能定位（test 277–279）。集成用例反向：旧 record() 在 run 不存在时 `run === undefined` → `skipped`（旧代码 sqlite-sensitive-interception-operations.ts，作者引的 `{recorded:0,skipped:1}` 成立）。[SI-2] 覆盖查一次/不传不变/抛错按 null 上报。缺口仅生产接线（上面第 3 条发现问题）。
4. **每个新值两端的校验能接住吗？** 逐个核对：
   - `threadOfRun`（S：port，D：durable-adapters.ts:1080，C：service-main.ts:299）：SQLite 端 `validScope` + `boundedText(runId,256)`，SQL 里带 `owner_id=? AND agent_id=?`（sqlite-…-operations.ts:229–237）——作用域限定在本 owner/agent；service-main 传 `configuration.ownerId/agentId`，与 review 运行的归属一致（production-automatic-review.ts:55、123–126 全部按 configuration 落）。无效输入 `this.fail` 抛错（`:never`），transport 捕获后回退。
   - `SensitiveInterceptionRunInput` / `SensitiveInterceptionStorePort.threadOfRun`：实现者只有 SQLite 适配器和两个测试桩（recorder.unit.test.ts:36、集成测试走 repository），都已补齐。生产实现走 `context.read`，未知操作名会 fail 抛错——集成测试证明该名字已被 dispatch（sqlite-…-operations.ts:102–103）。
   - 删除的 `runId`（ModelEgressContext / SensitiveInterceptionObservation）：grep 全仓无残留引用（`egressRunScoped` 0 处、非测试处无 `runId` 传给 context）；`validObservation` 相应删行；record upsert 列固定，残留 runId 字段即使出现也被 schema 自然忽略。
   - 新增 NULL-thread 记录：schema 允许（0078 SQL `thread_id TEXT` 允许 NULL，复合外键对 NULL 不强制），threadExists 对 NULL thread 跳过检查 + 外键级联由 autoreview 外已有的机制兜底，行为与作者描述一致。

——总结：两处修改（位置配对改为“实证不改证” + thread 在发请求前解析）方向和实现与作者描述一致，未发现会导致错误结果的缺陷；发给他模型的字节稳定；建议保留意见集中在上面 3 条低严重度问题。
