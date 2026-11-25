范围：当前检出为 `90d4e5b2c`，我按实际检出复核 `git diff 01eb2c3e5..90d4e5b2c`。这段增量实际包含三个提交：`79e0436f9`（第 10 轮复核记录）、`5a5f9e501`（合入 main，89 个文件，提交说明称未碰保险箱）、`90d4e5b2c`（只改 ADR 0288 决定 5 的一句 + 核对记录）。材料中第二段给出的 `ab4d011…`/`2903004…` 与当前检出不符，未采用。没有逐行重读 main 带来的 89 个文件；`.agents/reviews/` 下的复核记录在当前稀疏检出中未读到，标「未核实」。

**侧重检查**

- 过期/解密失败/落库失败路径：查了 `vault-service.ts` 的 `approve`、`#expire`、`#expireOverdue`，以及 SQLite 的 `close`、`expireOverdue`。第 10 轮意见 1 仍未修好，见下。
- 不可信输入与资源耗尽：本轮增量只改文档，没有触碰解析、限额、事务路径；旧代码未重读。
- 安全与不可撤销操作：ADR 决定 5 新说法「现有代理对 https 只做隧道、看不到内容」与 `packages/runtime-sandbox/src/network-egress.ts:91-124`（转发普通 http）、`:138-169`（https 走 CONNECT 隧道）一致，这句改对了，没有新错。
- 规则/文档/代码一致：核对了 ADR 0288、规格、`package.json`、`vault_list` 契约，发现两处文档与代码仍不一致，见意见 2、3。
- 合并：`5a5f9e501` 的文件清单不含 `vault`/`Vault` 文件，未发现合入 main 时把保险箱代码改坏；main 的其它改动不在本 PR 范围。

### 1. 中：解密或落库失败后模型拿到 denied，请求行却留在 pending 并最终记成 expired（第 10 轮第 1 条未改好）

文件:行：`packages/application/src/services/vault-service.ts:485-494,546-555`；`packages/persistence-sqlite/src/sqlite-vault-operations.ts:331-349`；测试 `test/integration/vault-approval.test.ts:373-398`。

问题：`approve` 的 catch 分支调用 `decide("denied", "failed")`，但不检查返回值；而 `close` 在请求已过期时会返回 `null`、不写任何记录。随后 `finally` 仍然 `deliver({ kind: "denied" })`，模型拿到 denied；请求行仍是 pending（或已被 `expireOverdue` 改成 expired），之后 `#expireOverdue` 把它记为 expired，使用记录也是 expired。第 10 轮意见未被本轮增量触碰，`90d4e5b2c` 只改 ADR 文字。

读代码证实的证据：

```ts
// vault-service.ts:546-552
} catch (error) {
  wipeAll();
  try {
    await decide("denied", "failed");
  } finally {
    deliver({ kind: "denied" });
  }
```

```ts
// sqlite-vault-operations.ts:334-336,349
UPDATE vault_release_requests SET status = ?, decided_at = ?, device_id = ?
 WHERE id = ? AND owner_id = ? AND agent_id = ? AND nonce = ? AND status = 'pending'
   AND (? = 'expired' OR expires_at > ?)
...
if (changed.changes !== 1) return null;
```

测试 `373-398` 已经把这种行为当成预期：写入失败时 `outcome` 是 `denied`，稍后 `usage` 变成 `expired`。也就是说模型结果与数据库/使用记录不一致不是偶发，而是当前代码会稳定走到的路径（例如手机在过期后批准、同时解不开密文）。

推测：无；触发条件（解密/落库失败与过期时间重合）虽不常见，但结论由上面的代码直接给出。

建议：不要忽略 `decide` 的返回值。返回 `null` 时读取当前请求状态，按实际状态给模型 `expired` 或 `denied`；或让 `close` 在「用户已签名批准过」时允许写入 `denied+failed`，并在同一事务里落使用记录。另加一条「解密失败且请求已过期」的反向用例。

### 2. 低：ADR/规格要求五道 `check:vault-*`，`package.json` 仍只有四道，`check:vault-egress` 不存在（第 10 轮第 2 条未改好）

文件:行：`docs/adr/0288-passwords-and-keys-live-in-a-vault-the-phone-unlocks.md:54`；`docs/execution/specs/2026-11-25-secret-vault-design.md:111-115`；`package.json:27,42-45`。

问题：ADR 说五道检查是硬门槛并「接进 `npm run check`」，规格逐条列出 `check:vault-egress`，但 `package.json` 只定义了 canary/contract/approval/recovery 四道，`check:steps` 也只串了这四道；仓库里也不存在 `vault-egress` 测试文件。作者自己的 PR 说法「四道 check:vault-*」正好暴露了这个缺口。本轮增量没有补。

读代码证实的证据：

```json
// package.json:42-45
"check:vault-canary": "...",
"check:vault-contract": "...",
"check:vault-approval": "...",
"check:vault-recovery": "...",
```

全仓库搜索 `vault-egress` 只命中 ADR 和规格两处文档，没有脚本、没有测试。

推测：无。

建议：要么补 `test/integration/vault-egress.test.ts`、`check:vault-egress` 脚本、反向用例并加进 `check:steps`；要么把 ADR、规格和 PR 说法统一改成「四道已接、第五道以后做」，并明确记录这个缺口。当前「硬门槛」的承诺与实现不符。

### 3. 低：规格仍写 `vault_list` 只给名字/类型/网站，实际还返回 `id`（第 10 轮第 3 条未改好）

文件:行：`docs/execution/specs/2026-11-25-secret-vault-design.md:129`；`apps/agent-service/src/production-vault-tools.ts:47-53`；`packages/application/src/services/vault-service.ts:184-199`；`packages/prompt-catalog/src/tools.ts:36`。

问题：规格「已做」仍写 `vault_list`「只给名字、类型、网站」，但工具实际返回 `id`，而且提示词描述明确写了「每一项的编号」。声明端和实现端对不上；本轮增量只改 ADR 决定 5，没有改这处。

读代码证实的证据：

```ts
// production-vault-tools.ts:47-53
return {
  items: items.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    sites: item.sites,
  })),
};
```

规格 `129` 行原文：「列出工具 `vault_list`（只给名字、类型、网站）」。

推测：无。

建议：把规格改成「编号、名字、类别、允许的网站」；如果产品决定不把 `id` 暴露给模型，则应从 `production-vault-tools.ts` 去掉 `id` 并同步改提示词描述，而不是只改文档。

**必答问题**

1. 本轮增量不改变模型已经见过的请求开头。增量只改 ADR 文字和复核记录，不进系统提示、工具定义或历史；`vault_list` 的工具定义和固定工具清单没有被增量修改（`production-vault-tools.ts:19-29`、`production-runtime-tools.ts:636`）。因此「仍在末尾追加、每轮变化的值都在最后一条消息」这一点本轮不涉及，既有的完整 prompt 拼装链路我没有重读。

2. 本轮不会让同一段文字在不同请求里变成不同字节。增量是纯文档，没有新的遮盖、时间字段或集合序列化；不涉及。

3. 增量本身（ADR 一句话）没有专门的自动检查。相关缺口是：`check:vault-egress` 不存在，ADR「五道硬门槛」的反向用例没有全部落地；第 10 轮意见 1 对应的「解密失败且已过期」也没有测试（`vault-approval.test.ts:316` 解密失败但不推进时钟，`:202` 推进时钟但解密成功，`:373` 是写入失败）。所以这两处都不能靠现有自动检查发现。

4. 增量只改文档，没有产生新的标识、字段、配置键或序列化格式。需要核对的三组既有值/声明端：
   - `check:vault-egress`：声明端在 ADR/规格，使用端 `package.json` 和测试里不存在，两端对不上（意见 2）。
   - `vault_list` 的返回字段：实现端有 `id`，文档端没有，两端对不上（意见 3）。
   - 请求状态 `denied`/`expired`：产生端在 `decideRequest`/`expireOverdue`，使用端在 `approve` 的 catch 和 `usage`/`snapshot`；catch 不核对写入是否成功，导致模型结果与数据库/使用记录不一致（意见 1）。
   - ADR 决定 5 的代理说法：与 `network-egress.ts` 一致，这一项核对通过。
