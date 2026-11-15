本轮核对范围：`982da2990` 之后的首父链为 `c2ff65472`（修复 #2）、`73fe5e3a3`、`d3fb9752c`（两次合 main）、`db9cfae62`（材料）。我用 `git diff 7ea1a6b6c..db9cfae62`（`7ea1a6b6c` 是 `d3fb9752c` 的第二父，即合入时最新 main）看 PR 净改动，用 `git show --cc` 看两次合并的冲突解，用 `git diff c2ff65472^..c2ff65472` 看修复本身。`.agents/reviews/.../judgments.md` 被仓库的 git 规则拒绝读取，前轮判断只能按本次材料中的摘要核对。

作者说法核对：第 1 条属实；第 2 条中 `externalContent` 确实只在 `apps/agent-service/src/service-main.ts:1597` 构造一次，设备动作在 `:1604` 使用它，事件流的 `streamAlive` 在撤销检查之后（`packages/platform-node/src/device-api-routes.ts:1466-1469`），两次合并的关键冲突两侧都保留了（如 `data-export/snapshot.ts` 同时有 `ownerProposals` 和 `perception.deviceActions`）。第 3 条的“56 步全过、76 条全过”无法核实，本轮禁止运行测试。另需指出：材料开头把上一轮意见 3、4、5 也列为“作者已修改”，但作者正文只声称修了 #2，增量里也确实没有 3、4、5 的代码改动；按材料后段，这三条归入“之前判为不成立、不重提”。

### 1. 低 — 新增 UNION 把 runIds 绑定两次，超长监控历史可能永久卡在 retry_wait

文件：`packages/persistence-sqlite/src/sqlite-durable-operations.ts:3908-3914`

问题：这段查询把 `runIds` 同时用于两个 `IN (...)`，参数是 `[...runIds, ...runIds]`，一次绑定 `2N` 个变量；同函数其他查询都只绑定 `N` 个。SQLite 有最大变量数（现代版本默认 32766，旧编译可能是 999）。当单个 GitHub monitor 的 run 数超过约一半上限（现代 SQLite 约 1.6 万）时，这条语句会报 “too many SQL variables”，整个 `deleteGitHubMonitorHistory` 事务回滚，外层 `catch` 把操作写成 `retry_wait/history_apply_failed`（`:3756-3762`），同样的输入会一直重试，owner 无法删除该监控历史。

证据（亲自读到）：
```ts
3908:      payloadRefs.push(
3909:        ...this.sqlValues(
3910:          `SELECT arguments_ref AS value FROM device_actions WHERE run_id IN (${placeholders(runIds)})
3911:          UNION SELECT result_ref AS value FROM device_actions
3912:          WHERE run_id IN (${placeholders(runIds)}) AND result_ref IS NOT NULL`,
3913:          [...runIds, ...runIds],
3914:        ),
3915:      );
```
同 PR 的 `packages/persistence-sqlite/src/sqlite-governed-deletion.ts:1033-1043` 采用“一次查询同时取 `arguments_ref`/`result_ref`，在 JS 里 flatMap”的写法，没有把参数翻倍。

推测：本轮没有构造超长 run 列表实际触发；是否达到上限取决于运行环境的 SQLite 编译参数和该 monitor 的历史长度。

建议：改成一次查询取两列后在 JS 展开，或在 SQL 里只绑定一次 `runIds`（例如用子查询/CTE），与 `#removeDeviceActions` 保持一致。

### 2. 低 — 删除历史会抹掉已交付但未回报动作的证据，设备再回报得到 404

文件：`packages/persistence-sqlite/src/sqlite-durable-operations.ts:3916-3918`、`packages/application/src/services/device-action-service.ts:611-613, 651-652`、`packages/platform-node/src/device-api-routes.ts:795-806`

问题：新代码按 `run_id` 删除设备动作时不区分状态，`queued`、`delivered` 的行也会被删。设备如果在删除前已经拿到动作，仍可能执行并随后调用 `POST /actions/result`；服务端 `store.read` 查不到记录，`report()` 返回 `not_found`，路由映射成 `404 DEVICE_ACTION_NOT_FOUND`。这样设备读回的结果和证据不会落库，且客户端是否把 404 当作终态、会不会重试，本仓库没有可核实的端实现。

证据（亲自读到）：
```ts
3916:      this.database
3917:        .prepare(`DELETE FROM device_actions WHERE run_id IN (${placeholders(runIds)})`)
3918:        .run(...runIds);
```
```ts
611:    const { scope, store } = this.#options;
612:    const existing = await store.read({ ...scope, id });
613:    if (!existing || existing.deviceId !== deviceId) return { kind: "not_found" };
```
```ts
804:        return options.sendJson(reply, result.kind === "not_found" ? 404 : 409, {
805:          code: `DEVICE_ACTION_${result.kind.toUpperCase()}`,
806:        });
```
读代码证实：服务端确实会对已删除动作的回报返回 404。推测：客户端可能重试或直接丢弃，未核实；删除本身是 owner 明确要求的历史删除，是否保留证据取决于产品语义。

建议：删除前把非终态动作明确转成 `rejected`/`result_unknown` 并写决策记录，或只删终态行；至少让设备端把该 404 当终态处理，避免反复回报。

### 3. 低 — 新测试只覆盖 arguments_ref，result_ref 与“别的 run 不受影响”没有反向用例

文件：`test/integration/github-durable-state.test.ts:390-402, 499-506`

问题：新增的 `device_actions` 行 `result_ref` 为 `NULL`，因此 UNION 的第二支（`result_ref` 的载荷收集）完全没被测试；新断言把“所有 device_actions 行数 + 指定 payload 行数”加在一起，也没有验证另一条 run 的设备动作和载荷不会被误删。现有 `test/integration/device-actions.test.ts:1373-1410` 有“删 run 不删另一个 run”的测试，但它走的是 `SqliteGovernedDeletionAdapter`，不是 `deleteGitHubMonitorHistory`。

证据（亲自读到）：
```ts
397:        ) VALUES (?, ?, ?, 1, 'dev_githubhistory000000000', 'home.read', 1,
398:          'payload:github-device-action', ?, 'READ', 'LOW', 0, NULL, 'private', 'rejected',
399:          'approval_not_connected', NULL, 'run-github-history-delete', 'call-1', ?,
```
```ts
500:        expect(
501:          afterSuccessfulDelete
502:            .prepare(
503:              "SELECT (SELECT COUNT(*) FROM device_actions) + (SELECT COUNT(*) FROM payloads WHERE ref = 'payload:github-device-action')",
504:            )
505:            .pluck()
506:            .get(),
507:        ).toBe(0);
```
读代码证实：`result_ref` 为 `NULL`，测试没有覆盖它。按代码路径推断，去掉修复后该断言会是 2（1 条动作 + 1 个 payload），所以 arguments_ref 这一支的反向用例确实会失败；但 result_ref 和跨 run 的反向用例不存在。

建议：再加一条带 `result_ref` 的动作，并插入另一个 run 的动作/载荷，分别断言“目标 run 的动作和两种载荷都消失、另一个 run 的仍保留”。

**侧重检查**

- 错误路径与事务：`deleteGitHubMonitorHistory` 在 `transaction(...).immediate()` 内（`:3731-3735`），新增删除与载荷收集同事务；失败会回滚并进入 `retry_wait`。没有发现部分提交。
- 外键约束：`device_actions.arguments_ref`/`result_ref` 都是 `REFERENCES payloads(ref) ON DELETE RESTRICT`（`migrations/20261114172043_device_actions.sql:23,52`），所以必须先删 `device_actions`；代码顺序正确。全仓 `REFERENCES device_actions` 无匹配，删除设备动作不会触发子表约束。
- 载荷误删：`isPayloadReferenced` 枚举所有指向 `payloads` 的外键；`decision_ledger_payloads.payload_ref`（`20261114110331_decision_ledger_reference_tables.sql:178`）和 `thread_messages.content_ref`（`0001_initial_product_schema.sql:96`）都是 RESTRICT，审计和对话历史不会被误删。
- 不可信输入与注入：新增 SQL 只绑定数据库里取出的 `runIds`，表名/列名固定，没有字符串拼接用户输入；未发现注入或路径问题。
- 资源耗尽：除第 1 条的 `2N` 参数问题外，`isPayloadReferenced` 对每个 ref 扫所有表的外键，成本随 ref 数和表数增长；这是旧逻辑，本次只是增加了设备动作的 ref 数量。
- 规则与代码一致性：`.agents/instructions/prompt-prefix.md:46` 要求 `device_action`/`perception_read` 的定义是固定文字、不随设备变化；`packages/prompt-catalog/src/perception.ts:15` 确实是无时间、无设备列表的固定文字，`describe` 的结果作为工具结果追加。工具定义仍说“会先请主人确认”（`:15`），而生产授权 `ReadOnlyDeviceActionAuthorization` 仍拒绝所有非只读动作（`device-action-service.ts:177-182`）；这与材料中“审批下一个 PR 接上、不重提”一致，本轮不重报。
- 数据导出：合并后 `DEVICE_ACTION_SCHEMA` 的 `state`、`reasonCode`、`actionKind`、`risk` 枚举与 `device_actions` 迁移和 `DEVICE_ACTION_REASON_CODES` 逐项一致；`deviceActions`/`devicePolicies` 已加入 `MANIFEST_SCHEMA` 必填计数、`DATA_FILES`、`PERCEPTION_FILE_KEYS`、`PERCEPTION_FILE_SCHEMAS`，`export.ts`、`verify.ts`、`demo-pack.ts` 都通过统一的 `PERCEPTION_FILE_KEYS` 消费；设备动作导出测试 `test/integration/device-actions.test.ts:1320-1368` 断言了清单计数和请求/结果内容。未发现该链路的格式不一致。

**必答问题**

1. 不影响。本次增量没有改提示词目录、消息组装或遮盖逻辑；`c2ff65472` 只改删除和测试，两次合并的冲突解只涉及装配、导出和测试夹具。设备动作的工具定义是固定文字（`prompt-catalog/src/perception.ts:15`），动态的 `describe` 结果作为工具结果追加在末尾；删除历史也不会删掉已发出的对话，因为 `thread_messages.content_ref` 有 `ON DELETE RESTRICT` 外键，`isPayloadReferenced` 会跳过仍被引用的载荷。结论：发给模型的内容仍然只在末尾追加，每轮会变的值仍在最后一条消息里。
2. 本增量不会让模型请求里的同一段文字变成不同字节。新增的 `UNION` 查询结果只进入 `Set` 用于删除，删除顺序不影响任何序列化内容；合并后的导出查询都有 `ORDER BY`（如 `snapshot.ts:207-211` 的 `ORDER BY created_at, id`），而且导出不是模型请求。设备动作的动态内容仍在工具结果里，不进入系统提示或工具定义。
3. 有自动检查：`test/integration/github-durable-state.test.ts:499-506`。按代码路径推断，去掉修复后该断言会得到 2 而不是 0，反向用例会失败；但我没有运行测试。覆盖缺口见意见 3：`result_ref` 和“另一个 run 不受影响”没有反向用例。`npm run check` 的 56 步和 76 条测试结果本轮无法核实。
4. 增量没有新增标识、配置键或导出函数；它修改的值是“要删除的 `device_actions` 行和它们的 `arguments_ref`/`result_ref` 载荷”。使用端逐个核对：`device_actions` 的 `read/list/claim/report/settleDue` 都能接受行不存在（`report` 返回 `not_found`，路由映射 404）；载荷删除前有全库外键扫描，`decision_ledger_payloads` 和 `thread_messages` 的 RESTRICT 外键会保护审计和对话历史；`device_actions` 没有子表外键，删除顺序安全。合并新增的数据导出值 `deviceActions`/`devicePolicies` 在 `schemas.ts`、`snapshot.ts`、`export.ts`、`verify.ts`、`demo-pack.ts` 和测试之间一致，schema 枚举与数据库约束一致。发现的两个边界是：`runIds` 绑定两次（意见 1）和已交付动作的迟到回报 404（意见 2）。
