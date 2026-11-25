本轮范围（已读）：`git show e976f2c66` 的 6 个文件（`vault-service.ts`、`ports/vault.ts`、`sqlite-vault-operations.ts`、`durable-adapters.ts`、spec、`vault-approval.test.ts`），并顺着证据读了 `sqlite-worker.ts`、`sqlite-execution-context.ts`、`device-api-routes.ts`、`vault.sql`、`package.json` 的 `check:vault-approval`。`.agents/reviews/pr-622/round-3/*` 在当前稀疏检出中不存在（读取报 File not found），上一轮原文以你给的摘要为准，未核实原文件。

### 1. 中低：读清单/使用记录现在先写库，写失败连只读请求也一起失败
文件:行：packages/application/src/services/vault-service.ts:229、240、371-377；packages/persistence-sqlite/src/sqlite-vault-operations.ts:303-304；packages/persistence-sqlite/src/sqlite-worker.ts:643-652；packages/platform-node/src/device-api-routes.ts:1022-1036

问题：`GET /vault` 和 `GET /vault/usage` 现在都先执行 `expireOverdue`（写事务，并在事务前 `assertDiskHeadroom()`）。即使没有任何过期请求，磁盘余量不足或写通道故障也会让这两个只读接口整体报错；而 `listItems`/`readManifest`/`listUsage` 本身并不做磁盘检查，改前这些读是能成功的。

证据：
- `vault-service.ts:229` `await this.#expireOverdue(scope);`（snapshot），`:240` 同样（usage）。
- `sqlite-vault-operations.ts:303-305` `private expireOverdue(...) { this.assertDiskHeadroom(); return this.database.transaction(...`。
- `sqlite-worker.ts:646-651` `if (freeBytes < configuration.minimumFreeBytes) { applicationFailure("PORT_CONFLICT", "SQLite writes are restricted by disk headroom", ...`。
- `device-api-routes.ts:1024` `const snapshot = await vault(authenticated).snapshot(...)`。

建议：读路径里的补记做成 best-effort（`catch` 后继续返回读结果），或移到定时器/后台维护；若必须同步，至少只在确实存在过期行时才进入写路径，并避免磁盘余量检查把读请求连带打死。

### 2. 低：过期边界上 `denied`/`failed` 会被 CAS 拒绝，模型结果与使用记录不一致，规格说过头了
文件:行：packages/application/src/services/vault-service.ts:546-555、271-274、388-392；packages/persistence-sqlite/src/sqlite-vault-operations.ts:333-348、303-327、213-231；docs/execution/specs/2026-11-25-secret-vault-design.md:130

问题：`close()` 对非 `expired` 状态仍要求 `expires_at > now`，所以已经过期但仍 `pending` 的请求上，`decide("denied","failed")` 返回 `null`，`failed` 记录不会写。由此有两个边界：
(a) 过期后解密失败：catch 仍给模型 `denied`，请求留 `pending`，之后 `expireOverdue` 记为 `expired`；
(b) 换钥匙/删项时已过期的 `pending` 请求：store 的 `close(denied)` 被 `expires_at > now` 跳过、不写记录，但服务层 `#closeAll` 仍把 waiter 结算成 `denied`，之后 `expireOverdue` 写 `expired`。
规格第 130 行写“解不开或写‘批准’失败时，改写成‘拒绝’并记一条 `failed`”“换钥匙或删项关掉请求，都同时写下对应的使用记录”，在这两个过期边界上不成立。

证据：
- `sqlite-vault-operations.ts:334-335` `WHERE ... AND status = 'pending' AND (? = 'expired' OR expires_at > ?)`；`:348` `if (changed.changes !== 1) return null;`。
- `vault-service.ts:548-551` `try { await decide("denied", "failed"); } finally { deliver({ kind: "denied" }); }`（返回 `null` 也不改结算）。
- `vault-service.ts:388-392` `#closeAll` 不看数据库实际关闭结果，一律 `this.#settle(id, { kind: "denied" })`。
- `sqlite-vault-operations.ts:220-230` 换钥匙/删项循环里调用 `this.close({... status: "denied" ...})`，过期行会被上面的 CAS 跳过。
- spec:130 “解不开或写‘批准’失败时，改写成‘拒绝’并记一条 `failed`” 与上述代码不符。

建议：catch 里 `decide` 返回 `null` 时回读请求状态，过期就给模型 `expired`（而不是 `denied`）；或把“这次交付失败”的 `failed` 记录与状态 CAS 解耦，即使请求已过期也留下这次失败记录；换钥匙/删项时让 store 返回实际关闭的 id（或对过期行直接记 `expired`），`#closeAll` 按实际结果结算。补两个用例：过期后解密失败、过期 pending 遇上换钥匙/删项；同时修正 spec 措辞。

### 3. 低（推测）：`approved` 写入在提交后才报错时，仍可能 DB approved / 模型 denied
文件:行：packages/application/src/services/vault-service.ts:544-555；packages/persistence-sqlite/src/sqlite-worker.ts:1112-1121；packages/persistence-sqlite/src/sqlite-execution-context.ts:220-222

问题：这是上一轮第 2 条同一类风险的反向残留。若 `decide("approved","approved")` 在数据库已提交后被判失败（worker 在 `postMessage` 前退出，主线程 `failAll` 拒绝挂起请求），catch 里再写 `denied/failed` 会因状态已是 `approved` 返回 `null`，模型仍被 `deliver({kind:"denied"})`，手机拿到错误，而 DB/usage 是 `approved`。

证据：
- `vault-service.ts:544-555` `decrypted = true; decided = await decide("approved", "approved");` … `catch { wipeAll(); ... await decide("denied", "failed"); ... deliver({ kind: "denied" }); ... }`。
- `sqlite-worker.ts:1112-1113` 先完成 `durableOperations.execute(...)`（事务已提交）再 `channel.postMessage`；`sqlite-execution-context.ts:220-222` `failAll` 在 worker 退出时拒绝所有 pending。
- 这是“写入返回失败但实际已提交”的假设，故标为推测；上一轮第 2 条正是把这类“出错时 DB 已批准”当成真问题，因此值得留一条核对。

建议：decrypted 之后的写失败，回读请求状态再决定交付什么；若已是 `approved`，不要对外声称 `denied`，应给手机一个“结果未知/请重试新请求”的明确错误，并补一条与 usage 对账的记录。

**侧重检查（查过的路径与结论）**
- 错误路径：`approve` 解密失败、写 `approved` 失败、补偿写 `failed` 也失败（测试有覆盖）；`deny`；定时器 `#expire` 写失败；`expireOverdue` 写失败。结论：主竞态已修好（waiter 在写 `approved` 前已取走、计时器已取消），但过期边界（意见 2）与提交后失败（意见 3）仍有不一致。
- 不可信输入：`approve`/`deny`/`requestRelease` 的字段、nonce、设备、清单校验未改；`expireOverdue` 只收服务端 scope 和 `now`，没有新增客户端字段。未发现新入口。
- 安全：失败路径都调用 `wipeAll()` 并 `waiter.ephemeral.dispose()`；`vault_usage` 只落 item id/origin/outcome/at，无明文。未发现泄漏。
- 资源耗尽：`expireOverdue` 每次读都跑、`SELECT` 无 `LIMIT`，一次事务内按过期请求数×项数写 usage；积压很多时会把一次 GET 拖成长写事务（推测性风险）。磁盘余量不足直接让只读失败见意见 1。
- 不可撤销操作：状态只从 `pending` 单向转出，CAS 保证一次；过期/拒绝不可撤销符合设计，但也正是意见 2 的来源。
- 规则/说明与代码一致性：spec:130 与代码在“过期边界记 failed / 换钥匙逐条记 denied”上有出入，见意见 2。

**读代码证实的**
- 意见 1、2 的代码路径；`decideRequest`/`close`/`expireOverdue` 的事务与 CAS 行为；`#closeAll` 结算逻辑；`GET /vault`、`GET /vault/usage` 路由；`assertDiskHeadroom` 抛错条件。
- `expireOverdue` 已接入 `VaultStorePort`、`SqliteDurableAdapters.vault()`、`SqliteVaultOperations.execute` 和 `vault.` 前缀分发；除 SQLite 适配器外没有别的 `VaultStorePort` 实现遗漏。
- 5 个新测试确实在 `test/integration/vault-approval.test.ts`，并由 `check:vault-approval`（package.json:44，`-t vault-approval`）收集；按旧代码逻辑推演这几个用例会失败（未实际运行）。

**推测**
- 意见 3 依赖“写操作在提交后才被拒绝/worker 退出”这一少见路径，未在真实进程里复现。
- `expireOverdue` 无 `LIMIT` 的积压放大风险尚未用数据验证。

**必答问题**
1. 不涉及。增量只改服务器存储/设备接口和 SQLite 操作，`listForModel` 仍是 `listedVaultItems(await store.listItems(scope))`（vault-service.ts:220-222）；系统提示、工具定义、历史、遮盖都没改，仍是末尾追加，每轮会变的值（`at`、过期）不进模型请求。整份 PR 的 `vault_list` 固定性本轮未重读（未核实）。
2. 不涉及。新增的 `at` 只写 `vault_usage` 和设备 `GET /vault/usage` 的返回，不进发给模型的内容；没有改遮盖，也没有引入依赖前后文的遮法；usage 列表顺序由既有的 `ORDER BY u.sequence DESC` 固定。不会让同一段模型输入在不同请求里变成不同字节。
3. 有。5 个新用例在 `vault-approval.test.ts`，归 `check:vault-approval`；静态推演旧代码上会失败，但我没有运行。覆盖了写 `approved` 失败、写 `failed` 也失败、计时器与批准并发、写 `expired` 失败、换钥匙关请求；未覆盖：过期后解密失败、过期 pending 遇上换钥匙/删项、`expireOverdue` 自身失败导致只读接口失败。
4. 逐个核对了：`expireOverdue` 的产出（`readonly string[]`）→ `#expireOverdue` 只拿来 `#settle`，端口、适配器、分发三处都已加；`decideRequest` 新 `usage` 参数的所有产生点（`#expire`、`deny`、`approve` 的 `decide`、`applyChange` 的 `close`）都传 `approved/denied/expired/failed`，都属于 `VAULT_USAGE_OUTCOMES`，`vault_usage.outcome` 的数据库约束只校验长度 1..32，能接受；`listUsage` 原样透传。未发现“新值被后端校验拒绝”的问题。使用端语义上的不一致见意见 2。
