## 结论

未发现高、中严重度缺陷。改动确实只新增了一条集成测试（`git diff --numstat`：`60 0 test/integration/sqlite-capability-invocations.test.ts`，`git diff --check` 无空白错误），没有改生产代码。作者最终描述与代码基本一致；下面几条是低严重度观察，不构成阻断。

## 发现（按严重度从高到低）

### 低 1 — 同键回放用的是 `T2`，这条断言本身不能证明“撤销后仍回放”

- 文件:行：`test/integration/sqlite-capability-invocations.test.ts:1081`
- 问题：同键回放用 `consumedAt: T2`，而 `T2` 同时是 `deadlineAt` 和 `expiresAt`。因此这条断言实际验证的是“过了截止/过期时间仍可回放”，不是“撤销后仍可回放”。如果只把撤销改成空操作，这条断言仍会通过；测试整体失败靠的是后面的新键和 read 断言。
- 证据：
  - `1081-1084`：
    ```ts
    await expect(consume(invocation({ consumedAt: T2 }))).resolves.toMatchObject({
      replayed: true,
      receipt: { invocationId: "invocation-capability-invocation" },
    });
    ```
  - fixture `test/fixtures/sqlite-capability-invocation-fixture.ts:70-76`：`T1 = ...00:00:01.000Z`，`T2 = ...00:05:00.000Z`；`invocation()` 的 `deadlineAt` 也是 `T2`（同文件 `451` 行）。
  - `sqlite-capability-invocation-operations.ts:1773-1802` 的 `replayOrConflict` 只用 fingerprint 比较，fingerprint 不含 `consumedAt`，也不检查 `revokedAt`。
- 建议：如果目标是“撤销后回放”，同键回放也改用 `T1`；如果确实想覆盖“过期后回放”，在测试名或注释里写明“after deadline and revocation”。注意：既有测试 `test/integration/sqlite-capability-invocations.test.ts:595` 也用 `consumedAt: T2`，所以这不是新引入的行为，只是描述不够精确。

### 低 2 — `reopened` 没有放进 `finally`，失败路径会泄漏数据库连接

- 文件:行：`test/integration/sqlite-capability-invocations.test.ts:1071-1077`
- 问题：`reopened` 在 `try` 内打开，但 `finally`（`1104-1108`）只关闭 `database` 和已经关闭过的 `resource.repository`。如果 `revokeExecutionHandle` 或 `reopened.close()` 抛错，`reopened` 不会被关闭，SQLite 连接泄漏（Linux 上 `rm` 通常仍能删文件，但句柄会留着）。
- 证据：
  ```ts
  1071: const reopened = await SqliteProductStateRepository.open({
  ...
  1076: await reopened.capabilityStore(OWNER_ID, AGENT_ID).revokeExecutionHandle(handle().ref, T1);
  1077: await reopened.close();
  ...
  1105: database?.close();
  1106: await resource.repository.close();
  ```
- 建议：把 `reopened` 提到外层变量并纳入 `finally`，或用嵌套 `try/finally`。

### 低 3 — 测试固定了“同一已撤销 Handle，consume 报 NOT_AUTHORITATIVE、read 报 HANDLE_REVOKED”的不一致

- 文件:行：`test/integration/sqlite-capability-invocations.test.ts:1086-1095`、`1097-1103`
- 问题：新键 consume 断言 `PORT_NOT_AUTHORITATIVE`，read 断言 `PORT_HANDLE_REVOKED`。两者面对的是同一个已撤销 Handle，错误码不同。测试会把这种现状固定下来；如果产品希望统一为 `HANDLE_REVOKED`，以后改代码会先撞到这条测试。
- 证据：
  - 测试 `1095`：`.rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });`
  - 测试 `1103`：`.rejects.toMatchObject({ code: PORT_ERROR_CODES.HANDLE_REVOKED });`
  - 生产 `sqlite-capability-invocation-operations.ts:1616-1632`：`assertLiveInvocationAuthority` 对 `row.handleStatus !== "active"`、`current.revokedAt !== null` 统一返回 `PORT_NOT_AUTHORITATIVE`。
  - 生产 `sqlite-capability-invocation-operations.ts:1374-1378`：`assertReceiptReadable` 对 `current.revokedAt !== null` 返回 `PORT_HANDLE_REVOKED`。
- 建议：确认错误码语义是否就是如此；若是，在测试里加一句注释说明“consume 走 authority 校验所以是 NOT_AUTHORITATIVE，read 走 receipt 可读性校验所以是 HANDLE_REVOKED”。

### 信息 — 分支历史里有一条被后续提交纠正的错误说明

- 文件:行：提交 `0fe22c89` 的说明
- 问题：`0fe22c89` 说“换新幂等键被拒绝其实是 Handle 一次性已被消费”，但 fixture 的 `maxUses` 是 2（`test/fixtures/sqlite-capability-invocation-fixture.ts:334`），该说法错误；后续 `c7c6bffd` 已纠正。若分支直接合并，这条错误说明会留在历史里。
- 证据：`git show 0fe22c89` 的提交说明；`c7c6bffd` 的说明明确承认上一提交“没有核实，是错的”。
- 建议：合并前 squash，或在 PR 描述里注明以 `c7c6bffd` 为准。

## 读代码证实的 / 推测

**读代码证实的：**
- 改动只涉及一个测试文件，净增 60 行，无生产代码变化。
- 第一次 consume 用默认 `invocation()`（`consumedAt: T1`），`maxUses: 2`，消费后 `uses: 1`、状态仍 `active`。
- 撤销后同键回放返回 `replayed: true` 且回执仍 1 行；新键在 `assertLiveInvocationAuthority` 的 `row.handleStatus !== "active"` / `current.revokedAt !== null` 处被拒，回执仍 1 行；read 在 `assertReceiptReadable` 的 `current.revokedAt !== null` 处返回 `HANDLE_REVOKED`。
- 把撤销改成空操作时，新键会成功插入第 2 条回执、read 会成功，因此 `1086-1095` 和 `1097-1103` 两条断言会失败，测试整体失败。作者的反向验证结论成立。
- 新键的时间 `T1` 满足 `T0 <= T1 < T2`，所以拒绝不是时间原因；同键回放的 `T2` 不参与 fingerprint，所以仍能回放。

**推测：**
- 第 `1051` 行测试名约 119 字符，超过 `biome.json` 的 `lineWidth: 100`；我无法运行 `format:check`，是否会被 Biome 判为未格式化未核实（作者称 `npm run check` 通过）。
- 如果将来把 `consumedAt` 纳入 replay fingerprint，`1081` 这条断言会变成 `PORT_CONFLICT`；这是测试隐含的约束，不是当前代码的问题。

## 侧重检查

- **错误路径**：检查了已撤销 Handle 的 consume（新键）与 read、同键 replay、事务回滚。`consume` 用 `.transaction(...).immediate()`，失败会整体回滚，回执数保持 1。
- **不合规范/不可信输入**：新测试的字面量都经过 `parseConsume` 的 `assertKeys`/`text()`/`dateText()`；DB schema 对 `receipt_ref`、`invocation_id`、`idempotency_key` 有非空 CHECK 和唯一索引，新值均合法且唯一。
- **安全**：撤销后新键不能产生新回执，read 被拒；同键只返回冻结回执。测试没有直接断言“Handle 的 uses 不再增加”，但回执数 1 加 `replayed: true` 已能覆盖主要副作用。
- **资源耗尽**：临时 stateRoot 和 DB 正常路径都会关闭；失败路径存在 `reopened` 未关闭的问题（低 2）。
- **不可撤销操作**：撤销只发生在测试临时数据库，`finally` 里删除 stateRoot，不影响生产。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 未被触碰；I-73 要求的“两端校验”已逐项核对，没有发现清单值过不了后端校验的错配；作者最终描述与代码一致，只有中间提交说明有已纠正的错误。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。diff 只改测试文件，没有触碰系统提示、工具定义、历史消息或遮盖逻辑；测试本身不向模型发请求。发给模型的内容仍只在末尾追加，每轮会变的值仍在最后一条消息里（这是既有机制，本次未改）。依据 `prompt-prefix.md` 第 4 条。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。没有改序列化、遮盖或集合顺序。新增的 `T1`/`T2` 只作为 SQLite fixture 的 `consumedAt`，不进入模型请求。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有，新增的这条集成测试就是自动检查（`integration` project）。反向用例不是仓库里单独的自动 mutation 测试，而是作者手工改撤销验证；读代码推导，撤销空操作会让新键 consume 和 read 两条断言失败，测试整体失败。但同键回放那条断言本身不依赖撤销，仍会通过。测试未实际运行（工具限制）。
4. **每个值两端是否都能接受？** 能。`receiptRef`/`invocationId`/`idempotencyKey` 满足 `text()` 非空和 DB 非空/唯一约束；`consumedAt: T1` 满足 `T0 <= T1 < T2`，因此新键拒绝只能来自撤销；`consumedAt: T2` 被 `dateText` 接受且不参与 replay fingerprint；`handle().ref` 与 `seed()` 创建的 Handle 一致，撤销查询能命中；`readInvocation()` 的 handleRef/invocationId/authority 与 receipt 一致，最后在可读性检查处返回 `HANDLE_REVOKED`。没有发现 I-73 式的两端错配。
