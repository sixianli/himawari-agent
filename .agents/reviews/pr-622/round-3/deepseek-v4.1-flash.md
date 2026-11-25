## 本轮范围与上一轮意见核对

本轮重点只读增量触及的 `packages/application/src/services/vault-service.ts`、`test/integration/vault-approval.test.ts`、`docs/execution/specs/2026-11-25-secret-vault-design.md`，并顺着证据读了 `sqlite-vault-operations.ts` 的 `decideRequest`/`applyChange`、`device-api-routes.ts` 的 vault 路由、`prompt-prefix.md`、`production-vault-tools.ts`/`service-main.ts` 的工具装配、`vault-crypto.ts` 的 `dispose`，以及 Swift 端 `VaultAPI.swift`/`VaultStrings.swift`。

上一轮意见：
- 第 1 条（高，计时器/换钥匙抢 waiter）：计时器正常返回 `null` 的路径已改好（新增 `closed === null` 早返回、approve 侧身份核对）；但错误路径仍未修好，且提前删除 waiter 引入换钥匙/删项的新回归，见下面第 1、2 条。
- 第 4 条（页面无入口、推送无人处理、生产无 `requestRelease`）：规格新增第 135 行“还没接上”，与代码现状一致，矛盾已消除；仍是未接上的产品缺口，不再是文档错误。
- 第 5 条（无效 TOTP 不擦钥匙）：已改好。`itemKey = Buffer.from(...)` 移到 `parseTotp` 之后，TOTP 非法时不会留下未清零的 Buffer（`vault-service.ts:518-520`）。
- 第 6 条（失败时 DB 状态 approved、内存/usage 是 denied/failed）：代码未改，改为规格第 130 行明确“status 只记决定，最终结果看使用记录”。设备快照只返回 pending（`device-api-routes.ts:378`），Swift 端认 `failed`（`VaultAPI.swift:39-45`、`VaultStrings.swift:72-78`），没有发现把 approved 当“已交付”的读取端，按文档化处理可以接受。

## 侧重检查

- 错误路径：解密失败、TOTP 非法、`recordUsage` 失败、过期与批准竞争、`decideRequest` 抛错。发现第 2、4 条；TOTP 清理已修好。
- 不合规范/不可信输入：`approve` 的 `exactKeys`、长度/base64 校验、sealed 数量、`item.version` 核对未变；本增量只改了 TOTP 校验与钥匙创建的先后顺序，未发现新校验缺口。
- 安全：临时私钥 `dispose` 后 `open` 必抛（`vault-crypto.ts:54-55,68-70`），字段和 itemKey 有清零路径；发现第 1 条的换钥匙/删项窗口。
- 资源耗尽：新增的 `closed === null` 早返回在“请求被本进程之外的决定/错误后不再重试”时可能让 waiter 与临时私钥常驻（推测；单进程正常路径有 approve/deny/`#closeAll` 兜底）。
- 不可撤销操作：第 1 条可能导致交付已删除/已换钥匙项的旧凭据。
- 规则/文档/代码一致：规格第 135 行与代码一致；第 130 行有第 4 条指出的过度承诺。作者说“19 个 Swift 测试”，我数到 `VaultContractTests` 12 个 + `VaultSessionTests` 7 个 = 19 个，但 Linux 实跑未核实（本轮不能运行测试）。`check:vault-*` 四个脚本确实在 `package.json:42-45`；`vault` 相关 Swift 代码未见注释；规格第 114 行提到的 `check:vault-egress` 在 `package.json` 中不存在，但它属于尚未实施的第四步，不是本增量引入。

## 意见

### 1. 中：提前删除 waiter 使换钥匙或删项无法中止正在交付的批准

文件：`packages/application/src/services/vault-service.ts:487-494`、`:383-387`、`packages/persistence-sqlite/src/sqlite-vault-operations.ts:211-217`

问题：`approve` 在 `decideRequest` 成功后立刻 `this.#waiters.delete(id)`，此后 `#closeAll` 遍历不到这个 waiter。换钥匙/删项的 `applyChange` 仍会把数据库中 `pending` 的请求改成 `denied`，但这时请求已经是 `approved`，不受影响。若轮换/删除发生在 `approve` 的 `listItems` 快照之后、交付之前，`approve` 会拿旧快照（旧 version、旧密文、旧 item key）完成交付。

证据（读代码证实）：

```ts
if (!decided || this.#waiters.get(id) !== waiter)
  throw new VaultError(VAULT_ERROR_CODES.REQUEST_CLOSED, 410);
this.#waiters.delete(id);
waiter.timer.cancel();
```

```ts
#closeAll(scope: VaultScope): void {
  for (const [id, waiter] of this.#waiters)
    if (waiter.scope.ownerId === scope.ownerId && waiter.scope.agentId === scope.agentId)
      this.#settle(id, { kind: "denied" });
}
```

```sql
UPDATE vault_release_requests SET status = 'denied', decided_at = ?
 WHERE owner_id = ? AND agent_id = ? AND status = 'pending'
```

旧实现（`git show 2903004...:packages/application/src/services/vault-service.ts`）直到最后才 `#settle`，所以 `#closeAll` 能在交付期间 `dispose` 临时私钥，随后 `open` 必抛，从而中止交付；这次提前删除 waiter 把这个能力拿掉了。

推测：具体交错要求轮换/删除事务在 `vault-service.ts:500` 的 `listItems` 返回之后、`:574` 的 `deliver` 之前提交，窗口短，未写测试复现。

建议：不要提前删除 waiter，把 `delete`/`timer.cancel()` 放到 `deliver`/`#settle` 处；给 waiter 增加“已决定批准”标记，让 `#expire` 看到标记时不结算，而 `#closeAll` 仍能取消。或在交付前重新读当前项版本与存在性，发现变化就作废并擦除已解出的字段。

### 2. 中低：过期 CAS 抛错时仍按过期结算，错误路径仍可制造 DB 已批准、模型拿到 expired、手机拿到 410

文件：`packages/application/src/services/vault-service.ts:353-358`、`:479-494`

问题：`.catch(() => undefined)` 把“存储层抛错”变成一个非 `null` 值，于是继续 `#settle(expired)`。如果这个错误恰好发生在 `approve` 的 `decideRequest(approved)` 提交之前/之间，`#expire` 会先删掉 waiter、向模型 resolve `expired`；随后 approve 的 approved 在数据库提交成功，但 `this.#waiters.get(id) !== waiter` 让它抛 `REQUEST_CLOSED`。结果数据库是 approved，模型看到 expired，手机收到 410，且不会写 usage。上一轮第 1 条只修好了 `decideRequest` 正常返回 `null` 的路径。

证据（读代码证实）：

```ts
const closed = await this.#options.store
  .decideRequest({ ...scope, id, nonce, status: "expired", deviceId: null, now })
  .catch(() => undefined);
if (closed === null) return;
this.#settle(id, { kind: "expired" });
```

`decideRequest` 在事务里用 `WHERE ... AND status = 'pending' AND (? = 'expired' OR expires_at > ?)` 做 CAS（`sqlite-vault-operations.ts:284-305`），抛错意味着事务未提交，不能当作“过期已生效”。

推测：需要 `decideRequest` 抛错（如 `assertDiskHeadroom` 失败或数据库错误）与批准并发，概率低但属于错误路径。

建议：不要把抛错等同“过期成功”。错误时重新读取请求状态或重试；只在 CAS 确认成功（`closed` 非空），或确认不可能再有批准成功时，才 resolve。也可以把 `null` 和“抛错”分开处理，保留 waiter 直到重试结论。

### 3. 低：新增测试只覆盖“waiter 已删除”，没有覆盖新增的 `closed === null` 早返回

文件：`test/integration/vault-approval.test.ts:373-401`、`packages/application/src/services/vault-service.ts:357-358`

问题：测试里定时器是在 `recordUsage`（`vault-service.ts:546`）执行时触发的，而这时 waiter 已经在 `:489` 被删除，`#expire` 在 `:352` 的 `if (!waiter) return` 就返回了。即使删掉 `:357` 的 `if (closed === null) return;`，这个测试仍然通过。因此反向用例只证明了“提前删除 waiter”这一半，没证明新增的 null 早返回。

证据（读代码证实）：

```ts
async recordUsage(input: ...) {
  if (input.entries.some((entry) => entry.outcome === "approved")) {
    for (const timer of fire.timers) timer();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return real.recordUsage(input);
}
```

建议：增加一个让定时器在 `decideRequest` 已提交 approved 之后、approve 尚未返回之前触发的用例（例如包装 `decideRequest`，在检测到 approved 后同步触发定时器），断言只得到一次 approved；再补一个换钥匙/删项与批准并发时不交付旧凭据的用例。同时验证“决定来自 deny/rotation 时 waiter 不会永久挂着”。

### 4. 低：规格说“写记录失败时交付失败记在使用记录里”，但失败的就是写使用记录时，补偿写也可能被吞掉

文件：`docs/execution/specs/2026-11-25-secret-vault-design.md:130`、`packages/application/src/services/vault-service.ts:546-570`

问题：规格第 130 行写“批准之后解密或写记录失败时……交付失败记在使用记录里（`outcome` 为 `failed`）”。但如果失败原因就是 `recordUsage` 本身（数据库或磁盘不可用），catch 里的补偿 `recordUsage` 也会抛错并被 `.catch(() => undefined)` 吞掉，结果既没有 approved 也没有 failed 行，请求状态仍是 approved。现有测试只模拟了“approved 那条被拒、failed 那条正常写入”的窄场景。

证据（读代码证实）：

```ts
      await this.#options.store.recordUsage({ ... outcome: "approved" ... });
    } catch (error) {
      wipeAll();
      deliver({ kind: "denied" });
      await this.#options.store
        .recordUsage({ ... outcome: "failed" ... })
        .catch(() => undefined);
```

推测：取决于失败类型；纯数据库/磁盘故障时补偿写同样会失败。

建议：规格改成“尽力记录 failed”；或者把最终交付结果放到不依赖同一失败写入的位置（例如独立的结果列/恢复时补写），否则承诺“查使用记录”在数据库故障时没有数据可查。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本增量没有碰系统提示、工具定义、历史消息、遮盖或压缩，只改了服务端过期/批准结算、测试和规格文档。整体 PR 的 `vault_list` 是静态描述符（`production-vault-tools.ts:19-29`；生产在 `service-main.ts:1737` 无条件装配），清单作为工具结果追加在末尾，`listedVaultItems` 按名字、id 排序且不带时间（`vault-service.ts:184-199`）。按 `prompt-prefix.md#rules` 第 4、6、7 条，新增工具集合会在下一轮按对话换新一次（允许的例外），之后仍是只在末尾追加；每轮会变的值不在请求开头。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。

2. **不会。** 增量没有引入依赖前后文的遮盖、时间字段或无序集合。唯一的 `now` 时间只进数据库和 usage，不进模型内容。整体 PR 的 `vault_list` 排序固定，`origins` 在写入时已排序（`vault-service.ts:175-176`），同一段清单文字在不同请求里字节一致。

3. **有自动检查，但反向覆盖不完整。** 新用例在 `check:vault-approval` 的 `-t vault-approval` 下会执行（describe 名含 `[vault-approval]`，`package.json:44`）；在旧实现上它会得到 `expired` 而断言 `approved`，所以这一条反向用例确实会失败。但没有反向用例单独验证 `vault-service.ts:357` 的 `closed === null` 早返回，也没有换钥匙/删项竞争和 `decideRequest` 抛错路径的用例，见意见 2、3。

4. **增量没有新增或修改对外值、字段、配置键、清单项、序列化格式。** 改动的 `closed` 的 `null`/`undefined` 是函数内哨兵。被写入的 `outcome` 仍是既有的 `approved`/`failed`：数据库 `vault_usage.outcome` 只校验长度（`20261124155152_vault.sql:58`），TS 侧 `VAULT_USAGE_OUTCOMES` 含 `failed`（`ports/vault.ts:21`），Swift 侧 `VaultUsageOutcome` 有 `failed` 和文案（`VaultAPI.swift:39-45`、`VaultStrings.swift:72-78`），使用端都能接受。用 grep 查过的产生/使用端没有发现新的不匹配；唯一的问题是规格对“failed 一定能写到使用记录”的承诺，见意见 4。

未核实：本轮只能执行 git 命令，不能运行 `check:vault-*`、`check:prompt-prefix` 或 Swift 的 19 个测试，所以“Linux 上通过”“SwiftUI 页面未编译”未实跑验证；`check:vault-egress` 未实现但不属于本增量。
