# 复核结论

**改动范围核实**：`git diff 8ae40ba..98ed3bd` 只含 `test/integration/sqlite-capability-invocations.test.ts` 新增 60 行一条测试，无生产代码改动。与作者说明一致。

## 发现（按严重度从高到低）

**低 — test/integration/sqlite-capability-invocations.test.ts:1090-1096 — 对「拒绝原因」的表述与代码成因有偏差（作者说法核对）**
- 证据：第三个 consume 被拒的真正成因是 Handle 已撤销：`sqlite-capability-invocation-operations.ts:1619` `current.revokedAt !== null` 落入 `:1629-1632` 的 `PORT_NOT_AUTHORITATIVE`。作者说「consumedAt 用 T1，早于 expiresAt 和 deadlineAt」——consumedAt=T1 只是为了满足全部时间检查（`:1612-1615`），从而把拒绝原因隔离到撤销这一件事上；即使 consumedAt 更晚也会因 `:1613` 被拒，但那是另一种成因。作者说法的意图（隔离撤销成因）与代码一致，仅表述上把时间条件当成了被测点。
- 建议：无需改代码；如在意，测试名或说明可写明「因 revokedAt 非空被拒」。

**观察（非本次改动引入，未列为缺陷）— sqlite-capability-invocation-operations.ts:1389-1406 与 :1338-1355 的不对称**
- `capabilityInvocation.read` 在 Handle 撤销后报 `PORT_HANDLE_REVOKED`（`:1378`，`current.revokedAt !== null`），但 `lookupFrozen`/`lookupOutput` 不检查 Handle 撤销状态，撤销后仍返回冻结回执。本次测试只把 `read` 的行为钉住了。属既有设计，读到的代码不足以判定是否有意，标「未核实」。

## 必答问题

**1. 是否改变模型已见过的请求开头？** 不涉及。diff 只新增一个测试文件内的 `it` 块，没有任何触及系统提示、工具定义、历史消息、遮盖的代码。发给模型的内容不受影响，规则前提（只追加、会变值在末条消息）无需逐条对照。

**2. 是否引入同一段文字在不同请求中字节不同？** 没有。测试默认模式用固定 T0/T1/T2（fixture :66-76，`LIVE_SANDBOX` 环境变量是既有机制，且 T1<T2 仍成立）；生产侧 replay 指纹是固定键序的 canonical JSON，且不含 `consumedAt`（`:363-405` 的 fingerprint 输入列表，`replayOrConflict` :1776-1794），确定性不变。

**3. 有无对应自动检查、反向用例会失败吗？** 本次改动本身就是集成测试（vitest 收集，`test/integration` 属常规测试层）。反向验证：我按代码推演——若撤销变空操作，第三个 consume 在 `assertLiveInvocationAuthority` 全部检查都通过（uses 1<maxUses 2、revokedAt null、时间合法、租约到 2999 年），会插入第二条回执，`:1090` 的 `rejects` 和 `:1094` 的 read `rejects` 都会失败，回执计数也会变 2。反向用例确实会失败。**未核实**：我没有运行该测试或 mutation（工具受限），作者「已跑过失败验证」的说法无法亲自确认。

**4. 每个产生/使用的值两端核对（I-73）**：改动不产生任何新生产值。用到的两个错误码两端都对上：
- `PORT_NOT_AUTHORITATIVE`：产生于 `assertLiveInvocationAuthority`（sqlite-capability-invocation-operations.ts:1629），消费于新测试 :1093，码值定义于 packages/application/src/ports/common.ts:25。
- `PORT_HANDLE_REVOKED`：产生于 `assertReceiptReadable`（:1378），消费于新测试 :1102。
- 测试写的表名 `capability_invocation_receipts` 与生产 INSERT（:1276）一致；`revokeExecutionHandle(handleRef, revokedAt)` 的签名与 durable-adapters.ts:450 及实现 sqlite-durable-operations.ts:2764-2784（置 `status='revoked'`、写 `revoked_at` 和 record_json）一致，测试传 `handle().ref` = fixture seed 的 ref。

## 侧重检查

走过的流程（一条普通使用流，从入口到结束）：
1. `seed` 创建 Handle（fixture :568-616，maxUses 2）→ **本次新测试覆盖**。
2. 首次 `capabilityInvocation.consume`：`consume`（:1163）→ `readReceiptByKey` 未命中 → `unconsumedHandle` → `assertLiveInvocationAuthority` → 插回执、Handle uses+1 → 覆盖。
3. 跨进程重开（`database.close()` + `SqliteProductStateRepository.open` 再 `operationsForDatabase`）→ 覆盖，且正确处理了 fixture `openOperations` 已关 repository 的状态根锁。
4. `revokeExecutionHandle`（durable-adapters :450 → sqlite-durable-operations :2764，置 revoked）→ 覆盖。
5. 同幂等键 replay：`consume` → `readReceiptByKey` 命中 → `replayOrConflict`（:1773，指纹一致即 `replayed:true`，不查 Handle 状态）→ 覆盖，回执计数 1。
6. 撤销后新键 consume 被拒 → 覆盖（成因 `:1619`）。
7. 撤销后 `capabilityInvocation.read` 被拒 → 覆盖（成因 `:1378`）。

**没有测试覆盖的相邻路径**（同一流程内，非本次改动义务）：撤销后 `lookupFrozen`/`lookupOutput`/`observeOutput` 的行为（见上文观察）；内存版实现（packages/testing/src/in-memory/capabilities.ts）只有已退役的直连 `consumeExecutionHandle`（:202-244），没有回执端口的对应实现，SQLite 回执语义是否与某内存对照实现有一致性门槛——未核实。文档/规则一致性：新测试无注释、风格与同文件相邻用例一致；prompt-prefix 规则和 I-73 教训均不要求本次改动做额外动作。

**未核实项汇总**：测试与反向 mutation 的实际运行结果；sparse checkout（91%）之外的文件；撤销后 lookup 路径是否有意不拒。
