本轮查过的范围：增量 `2d9e9d322..01eb2c3e5`（包含 `10c4132d0` 第 9 轮复核记录和 `01eb2c3e5` 保险箱 ADR 改号），以及改号牵涉到的 `docs/adr/0185`、`docs/adr/0288`、`docs/execution/specs/2026-11-25-secret-vault-design.md`、`packages/prompt-catalog/prompt-manifest.json`，并顺着上轮 3 条意见跟到 `vault-service.ts`、`sqlite-vault-operations.ts`、`production-vault-tools.ts`、`package.json` 和 `vault-approval.test.ts`。没有重读 PR 622 其余基线代码。

### 1. 中：解密失败恰逢过期时，模型拿到 denied，数据库/使用记录却是 expired（上轮第 2 条未改好）

文件:行：`packages/application/src/services/vault-service.ts:485-494`、`546-552`；`packages/persistence-sqlite/src/sqlite-vault-operations.ts:331-349`

问题：`approve` 在解密失败后调用 `decide("denied","failed")`，但没看它的返回值；而 `close()` 的 UPDATE 带 `(? = 'expired' OR expires_at > ?)`，当这一刻请求已过期时更新 0 行、返回 `null`，`vault_usage` 也不写。随后代码仍无条件 `deliver({ kind: "denied" })`。结果：内存里模型拿到 denied，数据库行先保持 pending，下一次 `snapshot`/`usage` 的 `#expireOverdue` 再把它写成 expired/expired，两边不一致。

证据（亲自读到）：

```ts
// vault-service.ts:546
} catch (error) {
  wipeAll();
  try {
    await decide("denied", "failed");
  } finally {
    deliver({ kind: "denied" });
  }
```

```ts
// sqlite-vault-operations.ts:334
`UPDATE vault_release_requests SET status = ?, decided_at = ?, device_id = ?
 WHERE id = ? AND owner_id = ? AND agent_id = ? AND nonce = ? AND status = 'pending'
   AND (? = 'expired' OR expires_at > ?)`,
...
if (changed.changes !== 1) return null;
```

读代码证实：该路径在 `expires_at <= now` 时确实静默失败，且 `decide` 返回值被忽略。
推测：无（直接读代码确认）。现有 `test/integration/vault-approval.test.ts:373-399` 只覆盖“decide 抛错（存储坏掉）”的情形，断言模型 denied、usage 之后为 expired；没有覆盖“decide 因过期返回 null”的组合，因此反向用例不会抓到本条。

建议：在 catch 里接住 `decide` 的返回值；为 `null` 时先跑 `#expireOverdue` 并按数据库真实状态投递（例如过期就 `deliver({kind:"expired"})` 并抛 `REQUEST_CLOSED`），保证模型结果与 `vault_release_requests`/`vault_usage` 一致；补一个把时钟推过 `expiresAt`、同时让字段解密失败的集成测试。

### 2. 低：ADR/规格要求五道 `check:vault-*`，`package.json` 只有四道（上轮第 6 条未改好）

文件:行：`docs/adr/0288-passwords-and-keys-live-in-a-vault-the-phone-unlocks.md:54`；`docs/execution/specs/2026-11-25-secret-vault-design.md:111-115`；`package.json:42-45`（以及 `:27` 的 `check:steps`）

问题：ADR 和规格都把 `check:vault-egress` 列为硬门槛之一，但 `package.json` 只定义了 canary/contract/approval/recovery 四道，`check:steps` 也只跑这四道，仓库里也没有对应的 egress 测试文件。本次改号只动了 ADR 标题/链接和 manifest 的 `changedIn`，完全没碰这段，所以上轮意见仍在。

证据：

```md
// ADR 0288:54
6. **五道自动检查是硬门槛。** `check:vault-canary`…、`check:vault-contract`、`check:vault-approval`、`check:vault-egress`、`check:vault-recovery`，每条都有“去掉防护就必须失败”的反向用例，接进 `npm run check`；
```

```json
// package.json:42-45
"check:vault-canary": …,
"check:vault-contract": …,
"check:vault-approval": …,
"check:vault-recovery": …,
```

读代码证实：不存在 `check:vault-egress` 脚本或 `*egress*` 的 vault 测试。
推测：无。

建议：要么补 `check:vault-egress` 及其反向用例，要么在 ADR/规格/PR 说明里明确写成“四道已接、egress 随第四步接上”，避免把尚未存在的门槛说成已生效。

### 3. 低：文档仍说 `vault_list` 只返回名字/类型/网站，实际还返回 `id`（上轮第 4 条未改好）

文件:行：`apps/agent-service/src/production-vault-tools.ts:47-54`；`docs/execution/specs/2026-11-25-secret-vault-design.md:129`（另见 `:62`）；`packages/prompt-catalog/prompt-manifest.json:978`、`:1391`

问题：工具结果包含 `id`，但规格写“只给名字、类型、网站”，manifest 的 reason 也写“模型只看到每一项的名字、类型和网站”。本次改号没改工具实现，也没改这两处描述，所以仍未对齐。

证据：

```ts
// production-vault-tools.ts:47
return {
  items: items.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    sites: item.sites,
  })),
};
```

```md
// spec:129
列出工具 `vault_list`（只给名字、类型、网站）
```

读代码证实：模型实际会收到 `id` 字段。
推测：无。

建议：确认 `id` 是否确有必要给模型（现在唯一的 `vault_list` 不吃参数）；不需要就从结果里去掉 `id`，需要就把规格和 manifest reason 改成包含 `id`，并补一条断言工具结果字段的测试。

**侧重检查**

- 错误路径：核了 `approve` 的取消计时器/取 waiter（`vault-service.ts:472-476`）、解密失败 catch（`:546-555`）、`#expire` 写失败仍结算（`:352-369`）、`#expireOverdue`（`:371-377`）和存储层 `close()` 的过期守卫（`sqlite-vault-operations.ts:298-349`）；发现第 1 条。
- 不可信输入：`approve` 对 `requestId/nonce/deviceId/itemIds/itemVersions/origin/pageVersion/ephemeralPublicKey/expiresAt/sealed` 做了逐字段比对和 base64 长度校验（`vault-service.ts:425-471`），本次增量没有改动，未发现新问题。
- 安全：第 1 条只是审计记录与模型可见结果不一致，denied 方向不泄露密钥，解密失败的值有 `wipeAll()`（`:547`），未见新的泄密路径。本增量没碰 gitleaks/遮盖。
- 资源耗尽/不可逆：`decideRequest`、`expireOverdue`、`recordUsage` 都先 `assertDiskHeadroom()`（`sqlite-vault-operations.ts:298-368`），写失败不会留下错误的“成功”记录；本次增量未改。
- 规则/文档与代码一致：改号部分逐个核过——`0287-ci-*`（CI）保留、保险箱改 `0288-*`，`0185` 正文、规格链接、manifest 两条 `changedIn` 都已指向 0288，没有残留指向 `0287-passwords*` 的链接；其余发现见第 2、3 条。
- 改号本身：`scripts/check-adr-numbers.mjs:24-28/53-66/72-97` 会查重号、标题号、链接存在；改号后 0287（CI）与 0288（保险箱）不重复，链接目标存在，`prompt-catalog` 测试只要求 `changedIn` 非空（`apps/agent-service/test/prompt-catalog.unit.test.ts:188`），所以新值 `ADR 0288` 能被接受。未发现增量引入的新错。

**必答问题**

1. **不涉及。** 增量只改 ADR 编号/文件名/链接和 manifest 的 `changedIn` 元数据；`packages/prompt-catalog/src/tools.ts` 未改、`tools.vault-list` 与 `tool-result.vault-unavailable` 的 `sha256` 未变，系统提示、工具定义、历史消息、遮盖都不变，发给模型的内容仍只在末尾追加，每轮变化仍在最后一条消息。依据 [prompt-prefix](../../.agents/instructions/prompt-prefix.md#rules)。
2. **不涉及。** `changedIn` 不参与渲染，ADR 编号只出现在文档和清单元数据里；同一段提示文本的字节未变（manifest `sha256` 未改），没有引入时间字段或无序集合。
3. **有，但只覆盖改号。** `check:adr-numbers`（重号/标题号/链接）、`check:docs-links`、`check:prompt-catalog` 会覆盖这次改号；改号前 0287 重号会触发 `ADR_NUMBER_DUPLICATE`，改成 0288 后应通过（读脚本推断，未实际运行）。对第 1 条没有“过期+解密失败”的反向用例；第 2 条的 `check:vault-egress` 根本不存在，反向用例无从失败。
4. **改号产生的值都能被使用端接受**：`0288` 文件名经 `check-adr-numbers` 的 `ADR_FILE` 校验并通过标题号一致性检查；`0185`/规格两条 Markdown 链接目标存在；manifest 两条 `changedIn` 被 `prompt-catalog` 测试接受，`changedIn` 在 `prompt-wording` 测试里只有 `ADR 0161` 特殊分支、不受影响。对第 1 条，`vault_usage.outcome` 的 CHECK 只限长度（`20261124155152_vault.sql:58`），`failed/denied/expired` 都写得进去，问题是读取端看到的值和模型看到的不一致，而非类型不接受。
