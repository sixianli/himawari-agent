## 复核范围与前置核对

- 实际检出：`git show -s --oneline HEAD` = `2d9e9d322 Merge origin/main into claude/project-thread-nneec2`。材料后半段写的“已检出 `ab4d011f`”与实际不符；`ab4d011f` 在当前仓库里存在，但不在 HEAD 上，其 `vault-service.ts` 与当前工作树不同（当前树已有 `expireOverdue`、`decide(status, usage)`）。我以实际代码为真相，按第一段材料复核 `0229e79..2d9e9d322`，重点看增量 `dd2ecc223..2d9e9d322`。
- 增量内容：`f15d18529` 改 gitleaks 白名单/结构测试/端到端测试；`2d9e9d322` 合入 main（`memory_open`、主对话、control-center 等）。本轮只深查与保险箱相交的 `production-runtime-tools.ts`、`production-tool-actions.ts`、只读工具清单、prompt-catalog，以及 gitleaks 相关文件；main 的主对话/control-center 大量代码属于 PR 629/631，未重读。
- 关于 `ab4d011f` 那一组第 2 轮意见：我用 `git show ab4d011f:...` 看到等待者先取走并取消计时器、坏 TOTP 时不再创建 `itemKey`、规格承认入口未接；但那不是当前检出，故不下“已改好”的结论，标为不适用于本轮。

---

## 读代码证实的问题

### 1. 中：上轮第 2 条仍未改好——解密失败恰逢过期时，模型拿到 denied，数据库/使用记录却是 expired

文件：`packages/application/src/services/vault-service.ts:546`、`packages/application/src/services/vault-service.ts:371`、`packages/persistence-sqlite/src/sqlite-vault-operations.ts:331`

问题：`approve` 在解密前就把 waiter 从表里删掉（第 474 行），计时器不再能关它；但 `snapshot`/`usage` 会先跑 `expireOverdue`（第 229、240 行）。如果手机在批准页轮询、同时固定期限已到，`expireOverdue` 会把这个请求在库里改成 `expired` 并写 `expired` 使用记录；随后解密失败，`catch` 里的 `decide("denied","failed")` 因请求已不是 `pending` 返回 `null`，代码却仍无条件 `deliver({ kind: "denied" })`。

证据：
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
// sqlite-vault-operations.ts:332
UPDATE vault_release_requests SET status = ?, decided_at = ?, device_id = ?
 WHERE id = ? AND owner_id = ? AND agent_id = ? AND nonce = ? AND status = 'pending'
   AND (? = 'expired' OR expires_at > ?)
```
```ts
// vault-service.ts:371
async #expireOverdue(scope: VaultScope): Promise<void> {
  const expired = await this.#options.store.expireOverdue({ ...scope, now: this.#now().toISOString() });
  for (const id of expired) this.#settle(id, { kind: "expired" });
}
```
结论：此时模型得到 `denied`，数据库请求行和使用记录是 `expired`，与规格第 130 行“解不开就改写成拒绝并记 failed”也不一致。现有测试只覆盖“批准记录期间计时器触发但 waiter 已删”的路径，没有覆盖解密失败与 `expireOverdue` 并发。

建议：在 `catch` 里检查 `decide("denied","failed")` 的返回值；返回 `null` 时回读请求最终状态，按 `expired`/`denied` 交付，或让存储层提供一个“失败结案并返回最终状态”的原子操作，保证模型结果、请求状态、使用记录三者一致，并补一条并发反向用例。

### 2. 低：上轮第 4 条仍未改好——文档仍说 `vault_list` 只给名字、类型、网站，实际返回 `id`

文件：`apps/agent-service/src/production-vault-tools.ts:47`、`docs/execution/specs/2026-11-25-secret-vault-design.md:129`、`docs/execution/specs/2026-11-25-secret-vault-design.md:62`、`docs/adr/0287-passwords-and-keys-live-in-a-vault-the-phone-unlocks.md:49`

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
// spec:62
她列出保险箱，只拿到名字和网站。
// ADR 0287:49
她只看到每一项的名字和允许的网站
```
工具描述本身已经正确写了“每一项的编号、名字、类别……”（`packages/prompt-catalog/src/tools.ts:36`），所以矛盾只在规格/ADR 与代码之间。增量没有改这些文档行，故仍未改好。

建议：把规格第 62、129 行和 ADR 第 49 行补成“编号、名字、类型、网站”，或明确说明编号只给模型用于发起取用、不展示给主人。

### 3. 低：上轮第 6 条仍未改好——ADR/规格写五道 `check:vault-*`，`package.json` 只有四道

文件：`package.json:42`、`docs/adr/0287-passwords-and-keys-live-in-a-vault-the-phone-unlocks.md:54`、`docs/execution/specs/2026-11-25-secret-vault-design.md:111`

证据：
```json
// package.json:42-45
"check:vault-canary": ...
"check:vault-contract": ...
"check:vault-approval": ...
"check:vault-recovery": ...
```
没有 `check:vault-egress`；`check:steps`（`package.json:27`）也只串了这四道。ADR 0287 第 54 行和规格第 111–115 行都列了五道，包含 `check:vault-egress`。增量未改这些行，故仍未改好。

建议：要么补 `check:vault-egress` 脚本并接入 `check:steps`，要么把 ADR/规格改成“本步暂只做四道，egress 在第四步接”。

### 4. 低：上轮第 3 条的行为已修好，但没有对应的自动检查，反向用例不存在

文件：`apps/agent-service/src/production-conversation-tools.ts:278`

证据：
```ts
...(shown.length === 0
  ? {
      note:
        pages.length === 0
          ? TOOL_RESULT_CONVERSATION_EMPTY.text
          : TOOL_RESULT_CONVERSATION_NO_MORE.text,
    }
  : {}),
```
逻辑本身正确：`page` 超过 `pages.length` 时 `shown` 为空而 `pages.length > 0`，返回“这一页没有更多结果”。但我在仓库里 grep `TOOL_RESULT_CONVERSATION_NO_MORE` / `这一页没有更多结果`，只命中 `production-conversation-tools.ts`、`prompt-catalog/src/tools.ts` 和 `prompt-manifest.json`，没有任何测试引用或断言这条新说明。也就是说这是一处未加回归测试的行为修复。

建议：在 conversation 工具测试里加一条“搜索有结果、`page` 大于最后一页”的用例，断言 `note` 是 `TOOL_RESULT_CONVERSATION_NO_MORE.text`、不是“没有找到相关的旧对话”。

---

## 推测（未经运行验证）

- `ci/toolchain-lock.json` 里 `ci/rules/gitleaks.toml` 的新 sha256（`63e3ba18…`）是否符合文件实际内容，我只读到 diff，受工具限制无法计算 sha256，标为未核实。消费端存在：`scripts/ci/install-tools.mjs:370` 的 `verifyRuleFiles` 会重算并断言，`scripts/ci/check-security.mjs:612` 调用了它；若摘要不对，CI 的 security 检查会失败。这属于自动检查能兜住的项，但不是本轮新增的“业务值”。
- main 合入的 `memory_open` 把新工具加在工具列表最后（测试用 `TOOL_DEFINITIONS_BEFORE_MEMORY_OPEN_SHA256` 锁住它之前的字节），对已有对话属于“工具集合变化、换新一次”；这是 main 的 ADR 0286 行为，不是本 PR 的保险箱改动。我没有进一步核实换新记录在部署侧是否确实发生。

---

## 侧重检查

查过的错误路径/不可信输入/安全/资源/文档一致性：

- 批准失败路径：`listItems`、`open`、`decryptField`、`decide` 抛错；`wipeAll` 与内层 `fields`/`itemKey` 清零；发现“解密失败 + 并发过期”的三方不一致（意见 1）。
- 过期与关单：`close` 用 `status = 'pending'` 和 `expires_at > now`（除 expired 外）做条件更新，使用记录与状态在同一事务（`sqlite-vault-operations.ts:331`、`352`），这一点是可靠的。
- 换钥匙/删项：`applyChange` 在同一事务里把仍 `pending` 的请求逐条关成 `denied` 并写使用记录（`sqlite-vault-operations.ts:213`）。
- 不可信输入：`approve` 逐字段比对 nonce/设备/项/版本/网站/页面版本/临时公钥/过期时间，`sealed` 校验长度与 itemId；`memory_open` 的 `number`/`page` 只接受安全整数、未知键拒绝、页码越界报输入错误，已删/不可见记忆按“找不到”处理。
- 资源耗尽：`memory_open` 的分页用二分裁剪、页数由正文长度决定但每页不超预算；未发现无界循环或无限页。`conversation_search` 仍有 `SEARCHED_TURNS` 上限。
- 安全：gitleaks 白名单已锚定到单文件、单规则、4 个精确值，反向测试覆盖改一个字符、同长度任意值、别的文件；未发现放宽成形状匹配。
- 文档一致性：发现 `vault_list` 返回 `id` 但规格/ADR 仍写“只给名字/类型/网站”，以及五道 vs 四道 `check:vault-*`（意见 2、3）。另外规格第 130 行对“解密失败”的表述没有覆盖并发过期场景（并入意见 1）。

---

## 必答问题

1. 请求开头是否只在末尾追加？
   本轮保险箱相关增量只有 gitleaks 配置/测试，不进入模型请求；合入 main 的 `conversation-no-more` 只是新的工具结果文本，出现在工具结果位置；`memory_open` 是 main 已有工具，被加在工具列表末尾，对已有对话属于“工具集合变化→换新一次”，不是每轮变化。`vault_list` 本身本轮未改。每轮会变的值（时间、状态）没有进入系统提示或工具定义。结论：保险箱增量仍是只在末尾追加；`memory_open` 的工具定义会让已有对话的工具段变化一次，需要按规则 6 的换新/记录来理解，不是每轮变化。

2. 同一段文字是否会在不同请求里变成不同字节？
   本轮改动没有这样的路径。`vault_list` 按名字、再按 id 固定排序、无时间字段；新加的说明文字是固定文本；gitleaks 配置不进入模型请求。`memory_open` 的输出含日期/状态，但它是每次新生成的工具结果，不是在重写历史同一段文字。未发现依赖后文遮盖或无序集合的新值。

3. 有没有自动检查，反向用例真的会失败吗？
   gitleaks：有结构测试（17 条、路径/规则/regexTarget、「改一个字符不放行」、同长度他值不放行）和真实 gitleaks 端到端（夹具文件不报、同内容兄弟文件照报）；上轮的“结构测试必失败”问题已解决。`conversation-no-more`：没有测试，反向用例不存在（意见 4）。`memory_open`：有单测、工具清单测试、`TOOL_DEFINITIONS_BEFORE_MEMORY_OPEN_SHA256`。过期与失败并发：没有专门用例（意见 1）。toolchain sha 有 `verifyRuleFiles` 会在 CI 重算，但我无法本地验算摘要值。

4. 每个新值的两端是否能接受？
   - gitleaks 的 4 个精确值与 `vault-contract.json` 的 `vector`/`phoneVector` 的 `wrappedKey`、`password` 逐个一致（`vault-contract.json:83/85/117/127` 对 `ci/rules/gitleaks.toml` 末条）；消费端是 gitleaks，端到端测试证明可用。
   - `ci/toolchain-lock.json` 的 sha256 消费端是 `verifyRuleFiles`（重算）；值本身未核实。
   - `memory_open` 的 `capabilityRef = "memory.open"`、`targetType = "owner-memory-record"`、`tool = "memory_open"` 在描述符、action row、`#handlerFor`、`BUILTIN_PREFLIGHT`、只读清单测试之间一致；marker 新增 `"memory"` 只作为 `#ownerScopedOnce` 的 JSON 键和 `Partial<Record<...>>`，没有枚举 switch，安全。
   - `conversation-no-more` 的 prompt id 与 manifest 一致；没有测试消费它的文案。
   - `vault_list` 的 `id` 在代码里被正确返回，但文档消费端仍不接受（意见 2）。
   - `check:vault-*` 的“清单值”是五道，实际脚本消费端只有四道（意见 3）。
