**本轮范围**：实际检出 HEAD 为 `c9d9cd01c`，因此以 `git diff e976f2c66..c9d9cd01c` 为增量（只改了 `vault-service.ts`、`sqlite-vault-operations.ts`、`vault-approval.test.ts` 及复核记录）。材料里第二段 `ab4d011f6` 是历史祖先，按增量规则未整份重读，但证据指向旧代码时跟到了 `approve`/`close`/`decideRequest` 与设备接口。未读到的部分标「未核实」。

**侧重检查**（错误路径 / 不可信输入 / 安全 / 资源耗尽 / 文档一致）

- 只读失败路径：`snapshot`/`usage` 对 `#expireOverdue` 加了 `.catch(() => undefined)`，补记失败不再让读请求 500；新增测试覆盖。读代码证实。
- 过期边界 + 手机送坏数据：`approve` 解密失败走 `decide("denied","failed")`，该分支把 CAS 返回的 `null` 丢掉；若此刻已过期，CAS 拒绝，模型仍被 resolve 成 `denied`。读代码证实（见意见 1）。
- 磁盘余量 / 资源耗尽：`expireOverdue` 现在先 SELECT，空则提前返回，不再 `assertDiskHeadroom`；有过期请求时仍在写事务前检查。读代码证实。
- 不可信 TOTP：当前代码在 `parseTotp` 之前不创建 `itemKey`，`opened` 与字段/`itemKey` 都在 `finally` 清零；未发现新残留。读代码证实。
- 文档一致：spec 说「不会只写一半」，但意见 1 的失败组合会只写一半（模型 denied、记录 expired）。读代码证实与文档不符。
- 新增外部输入解析/新字段/新配置键：本增量没有。读代码证实。

### 1. 低（读代码证实，上一轮第 2 条未改好）：批准解密失败恰逢过期时，模型拿到 denied，数据库状态和 usage 却补记成 expired

文件:行：`packages/application/src/services/vault-service.ts:546-555`、`packages/persistence-sqlite/src/sqlite-vault-operations.ts:331-349`

问题：本轮增量只改了 `snapshot`/`usage` 和 `expireOverdue` 的结构，**没有碰** `approve` 的失败分支与 `close` 的 CAS。上一轮第 2 条仍然存在。

证据（亲自读到）：
```ts
} catch (error) {
  wipeAll();
  try {
    await decide("denied", "failed");   // 返回值被忽略
  } finally {
    deliver({ kind: "denied" });        // CAS 失败也照样告诉模型 denied
  }
```
```sql
UPDATE vault_release_requests SET status = ?, decided_at = ?, device_id = ?
WHERE ... AND status = 'pending'
  AND (? = 'expired' OR expires_at > ?)
```
`decide` 内部就是 `decideRequest`，当 `expires_at <= now` 且 `status='denied'` 时 CAS 返回 `null`，因此 `failed` 使用记录没写、请求行仍 `pending`；但 `deliver({kind:"denied"})` 已执行，模型拿到 denied。之后任何一次 `snapshot`/`usage` 的 `expireOverdue` 会把同一行补记成 `expired`。于是模型结果=denied，DB/usage=expired。

文档依据：spec「第一步和第二步做到了哪里」写「批准、拒绝、过期……都同时写下对应的使用记录，不会只写一半」「解不开或写『批准』失败时，改写成『拒绝』并记一条 `failed`」。该组合下这两句都不成立，属于文档说过头。

推测：触发需要「计时器尚未回调但时钟已过 `expiresAt`」且手机送来解不开的 `sealed`，窗口窄，后果是审计记录与模型结果不一致，不泄露明文。故低。

建议：catch 里检查 `decide` 的返回值；返回 `null` 时走与 `!decided` 相同的路径（先 `#expireOverdue`、再读状态），据实际状态 resolve（`expired` 或 `denied`），并补一条覆盖「解密失败恰逢过期」的测试。

### 2. 低（推测，上一轮第 3 条未改好）：`approved` 写入在提交后才抛错时，仍可能 DB approved / 模型 denied

文件:行：`packages/application/src/services/vault-service.ts:545-555`

问题：本轮增量未改动这段，上一轮第 3 条仍在。

证据：
```ts
decrypted = true;
decided = await decide("approved", "approved");
} catch (error) {
  wipeAll();
  try { await decide("denied", "failed"); } finally { deliver({ kind: "denied" }); }
```
若 `decide("approved","approved")` 在数据库已提交后 reject，catch 里再写 `denied` 会因 `status='pending'` 条件不再满足而返回 `null`（被忽略），`finally` 仍把模型 resolve 成 denied，结果 DB=approved、模型=denied。

推测：当前 `SqliteVaultOperations.decideRequest` 是同步事务（`sqlite-vault-operations.ts:298-301`），`close` 抛错会整体回滚，提交成功后才返回，正常路径下走不到「提交后仍 reject」；只有换用别的 `VaultStorePort` 实现或包装层在提交后抛错才会出现。故属防御性问题。

建议：对 `decide("approved")` 的失败区分「确定回滚」与「结果未知」，未知时不要无条件 `deliver(denied)`；或把「批准+交付」改成可重放的确定结果，并在端口契约里写清「失败即未提交」。

### 3. 低（建议/推测）：`.catch(() => undefined)` 静默吞掉补记错误，永久性失败没有任何信号

文件:行：`packages/application/src/services/vault-service.ts:229`、`:240`

问题：读接口确实不再因补记失败而失败（第 4 轮第 1 条已改好），但 catch 吞掉所有错误且不记录、不上报。若磁盘长期满或写通道持续故障，`expireOverdue` 会每次读都失败，过期请求永远补不上 usage，外部完全无信号。

证据：
```ts
await this.#expireOverdue(scope).catch(() => undefined);
```
读代码证实：没有任何日志/指标；spec 只说「下次读再补」，未定义失败告警。

推测：这是可观测性/运维问题，不是功能错误；但对「资源耗尽」路径应按项目门禁给出可观察状态。

建议：只吞掉可预期的存储错误并记录一次告警/计数（或在健康检查里暴露「补记持续失败」），不要把编程错误也一并静默。

---

**必答问题**

1. **是否改变模型已见过的请求开头？** 不涉及。本增量只改服务器内部 DB 读写的错误处理，未触及系统提示、工具定义、历史消息或遮盖逻辑；`vault_list` 的工具清单/输出（`listedVaultItems` 按 name、id 排序，`origins` 在解析时已排序）未变。发给模型的内容仍只在末尾追加，本轮改动不产生新的每轮变化值。依据 `prompt-prefix` 的要求，本增量没有触碰该约束。

2. **同一段文字是否会在不同请求里变成不同字节？** 对模型可见内容不涉及。唯一相关的顺序变化是 `usage` 列表：补记过期条目会拿到新的 `sequence`，定位随补记时机变化（`sqlite-vault-operations.ts:398` `ORDER BY u.sequence DESC`），但这是设备侧使用记录、不进模型上下文，也未在本轮增量中新增。读代码证实 `vault_list` 仍无时间字段、排序稳定。

3. **自动检查？反向用例会失败吗？** 有。新增 `test/integration/vault-approval.test.ts:458-487`，由 `check:vault-approval` 运行（`package.json` 的 `-t vault-approval` 匹配 describe 名）。在旧代码（`e976f2c66`）上 `snapshot` 会直接抛出被 override 的 `disk full`，测试会在 `const snapshot = await ...` 处失败，反向用例有效。不足：作者声称的「没有过期请求时不查磁盘余量、不开写事务」没有专门测试；意见 1 的「解密失败恰逢过期」也没有反向用例。

4. **改动产生/修改的值，使用端都能接受吗？** 没有新增标识、字段、配置键或序列化格式。被修改的只有两个既有契约的语义：`VaultStorePort.expireOverdue`（仍返回 `readonly string[]`，空时返回冻结空数组）和 `VaultService.snapshot/usage` 的失败行为。逐个直接使用端核对：`VaultService.#expireOverdue`（`vault-service.ts:371-377`）只遍历 id，空数组可接受；`durable-adapters.ts:1051` 与 `sqlite-vault-operations.ts:120-121` 的 `vault.expireOverdue` 类型未变；`device-api-routes.ts:1024`、`:1031` 消费的 `snapshot`/`usage` 形状未变。两端校验均接受。
