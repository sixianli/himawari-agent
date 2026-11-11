## 复核结论

本轮增量（`e947d5d0..8d3e75c0`）只改了 `production-run-memory.ts` 的一个兜底分支、对应单元测试和 ADR 文字。逐条对照后，作者关于本轮改动的说法与代码一致，没有发现高、中严重度问题。下面两条是低严重度问题或覆盖缺口。

## 读代码证实的发现

### 1. 低：取消/投影路径的 `markUnknown` 失败仍会覆盖原始嵌入错误

- 文件:行：`apps/agent-service/src/production-run-memory.ts:310`
- 问题：本轮只给“结清失败后的兜底 `markUnknown`”包了 try/catch。第 310 行的另一个 `markUnknown` 分支没有包裹。聊天路径被取消时（`context.signal.aborted`）或投影路径会走到这里；如果 `markUnknown` 本身失败（例如授权/租约已失效），抛出的会是记账错误，而不是原来的嵌入错误。
- 证据：

  ```ts
  } else if (started && !settled) await permit.markUnknown("transport_unresolved");
  else if (!started) await permit.releaseReserved();
  throw error;
  ```

  而新增的兜底分支在 300-309 行已经显式捕获并记录 `memory.embedding_unknown_failed`，随后继续 `throw error`。
- 建议：如果“记账失败也始终抛原始嵌入错误”是全局保证，把第 310 行也按同样方式包裹并记录；否则把 ADR 的“不论哪种”明确限定为“结清失败后的改记”，避免读者误解。该问题不是本轮引入，取消路径在改动前也存在。

### 2. 低：端到端测试删掉了网关原文断言，弱化了 I-11 的日志门槛

- 文件:行：`test/integration/production-http-composition-process.test.ts:1816-1819`
- 问题：原测试在 402 分支断言 `mainDiagnostics` 包含 `"User budget exceeded"`，本轮重写后只断言了 `memory.embedding_failed`、`"status":"402"` 和 `"gatewayErrorType":"quota_for_entity_exceeded"`，删掉了网关原文的断言。代码仍然保留原文（见下），所以不是行为回归，而是端到端门槛变弱；I-11 和 ADR 0109 都明确要求日志带网关原文，ADR 0223 决定 4 也保留这一点。
- 证据：

  ```ts
  expect(mainDiagnostics).toContain('"event":"memory.embedding_failed"');
  expect(mainDiagnostics).toContain('"status":"402"');
  expect(mainDiagnostics).toContain('"gatewayErrorType":"quota_for_entity_exceeded"');
  ```

  `git diff` 中被删除的一行是：

  ```diff
  -        expect(mainDiagnostics).toContain("User budget exceeded");
  ```

  代码侧原文仍在：`packages/memory-engine/src/embedding.ts:240` 把 `gatewayErrorMessage` 截到 300 字，`production-run-memory.ts:402` 把它展开进诊断事件。
- 建议：恢复对 `gatewayErrorMessage`（或原文子串）的端到端断言。单元测试 `packages/memory-engine/test/hybrid-memory-provider.unit.test.ts:357-383` 已覆盖原文，但这次删掉的正是事故 I-11 的集成门槛。

## 推测与未核实

- 未实际运行测试或 `npm run check`；下面关于“旧代码会失败”的判断是读代码推断的，不是执行结果。
- `[P3-2]` 新增单元测试在修复前的代码上确实会失败：旧代码直接 `await permit.markUnknown(...)`，会以 `UNKNOWN_REFUSED` 拒绝，而新断言要求 `EMBEDDING_VECTOR_INVALID` 且包含 `memory.embedding_unknown_failed` 日志。此为阅读旧代码后的推断。
- ADR 0223 中关于历史提交 `e7d735cc`、`030f81f5` 及“只删抛错、保留结果未知”的实测描述，未逐条核对提交内容，标为未核实。
- ADR 声称集成测试反向用例在改动前会失败，未实际运行验证，标为未核实。

## 侧重检查

- **结清失败错误路径**：`production-run-memory.ts:294-309`。结清失败先写 `memory.embedding_settle_failed`，再尝试 `markUnknown`；`markUnknown` 再失败时写 `memory.embedding_unknown_failed`，最后仍 `throw error`。读代码证实原错误在本路径会被保留。
- **取消路径**：`production-run-memory.ts:280-310`。取消时走未包裹的 `markUnknown`，见上面发现 1。
- **预算账户状态**：`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:684-689`。`markUnknownWithinTransaction` 把账户改为 `reconcile_required`；ADR“改记成功后账户变成 reconcile_required”与代码一致。
- **不可逆操作/阻塞**：`reconcile_required` 会让之后重新领取执行权被跳过；ADR 已写明这一后果，未新增更严重的不可逆操作。
- **资源耗尽**：新增代码没有重试循环；结清和改记各只尝试一次，失败后只写日志，不会持续占用资源。
- **不合规/不可信输入**：本轮没有新增外部输入解析。新增日志只输出内部错误消息；网关原文仍经 `gatewayErrorDetails` 截断到 300 字，并经过 `writeServiceDiagnostic` 的机器密钥遮盖。
- **安全**：嵌入失败后走关键词/实体检索，检索策略仍是 `modelVisibleClassifications()`，没有因降级放宽可见分级；未发现新的敏感数据出口。
- **规则文件与代码一致性**：`prompt-prefix.md:27-28` 要求每轮变化的记忆放在最后一条消息；本轮不改变系统提示、工具或历史，集成测试 `:1813-1815` 也断言降级找到的记忆出现在最后一条消息里。
- **文档一致性**：ADR 0223 决定 2/后果的新增文字与代码一致；`incidents-and-gates.md`、`engineering-casebook.md`、ADR 0109 中保留的旧失败码均带有“后续已删”的说明，属于历史记录，不是现行行为。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本轮只增加日志和兜底记账；更早的降级改动只改变“本轮检索到的记忆”，这部分按规则放在最后一条用户消息里，系统提示、工具定义和历史仍保持只追加。集成测试在 `test/integration/production-http-composition-process.test.ts:1813-1815` 用 `lastMessage` 检查记忆出现在最后一条消息。未实际运行 prompt-prefix 门槛，标为未核实执行结果。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会（就模型可见内容而言）。关键词/实体结果经 `fuseCandidates` 排序，分数相同用 `memoryId` 兜底（`packages/memory-engine/src/fusion.ts:113`）；SQL 词法和实体查询也都有 `m.id` 兜底（`sqlite-memory-operations.ts:1185、1202`）。决策记录使用随机 UUID 和当前时间（`production-decision-ledger.ts:18-22`），但这些只进数据库和网页，不进模型请求；日志时间戳同样不发给模型。

3. **有没有对应自动检查，反向用例真的会失败吗？** 有。单元测试 `production-model-composition.unit.test.ts:1788-1823` 覆盖“结清失败”和“结清、改记都失败”，其中两步都失败的用例在旧代码上会因抛出 `UNKNOWN_REFUSED` 而失败（按代码推断，未执行）。集成测试 `[P3-2]` 断言本轮完成、最后一条消息含关键词找到的记忆、恰好一条检索降级记录、嵌入已结清且预算账户为 `active`；若只删抛错而保留 `markUnknown`，嵌入状态会是 `unknown`，断言会失败。覆盖缺口是删掉了网关原文的端到端断言（发现 2），以及未覆盖取消路径下 `markUnknown` 失败（发现 1）。

4. **新增/修改的每个值两端都能接受吗？**
   - `retrieval_degrade` / `degraded` / `vector_search_unavailable`：产生于 `production-decision-ledger.ts:21-24`；数据库迁移和端口校验接受：`0069_decision_ledger.sql:5-19、53`、`packages/application/src/ports/decision-ledger.ts:43-50`，`reason_code` 长度 24 也在 1-64 内；控制中心 i18n 和校准表都有 `retrieval_degrade` 条目。
   - `memory.embedding_unknown_failed`：产生于 `production-run-memory.ts:305`；消费者是 `writeServiceDiagnostic`，接受任意事件名字符串，无白名单或格式校验，全部字段都是字符串。
   - `onVectorFailure` 改为必填：类型声明在 `production-memory-composition.ts:33`，所有直接调用点（`service-main.ts:359`、各测试和 `test/fixtures`、`test/qualification`）都已传入；未发现漏接的 TypeScript 调用点。
   - 删除的 `CONTEXT_MEMORY_UNAVAILABLE` / `CONTEXT_MEMORY_QUOTA_EXCEEDED`：全仓库已无代码引用，只剩文档历史记录；旧记录在 `execution-view.ts:24-25` 或 `thread-execution-projection.ts:497-499` 落到通用失败文案，和 ADR 决定 3 一致。
