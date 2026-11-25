## 范围说明

当前仓库的 HEAD 是 `dd2ecc223`，我按第一份「本次材料」核对：基准 `16cc3ac2f`，上一轮到 `d56988281`，本轮增量 `d56988281..dd2ecc223`（即 `348d5069b` 的 gitleaks 白名单 + `dd2ecc223` 合入 main）。第二份材料写的 `ab4d011f6` / `ed3f8d0df` / `2903004a1` 是更早一轮的材料，与当前检出的 HEAD 不一致；其中第 2 轮的 waiter、TOTP 清零等修复我确认在当前代码里仍在（`approve` 先取走 waiter 再解密、`itemKey.fill(0)` 在 `finally`），但本轮不以那一份为准。增量没碰、行为也没被增量改变的前几轮旧问题，我只在证据指向时跟读。

---

### 1. 高：新增 gitleaks 白名单必然让现有白名单结构测试失败，新条目也没有反向用例

- 文件:行：`ci/rules/gitleaks.toml:158-164`、`test/tooling/gitleaks-allowlist.test.mjs:64`、`:67`、`:74-124`
- 问题：`gitleaks.toml` 现在有 20 个 `[[allowlists]]`，去掉测试自己拆出去的前三个后，`scoped` 是 17 个；测试仍断言 16 个。并且该测试要求所有 `scoped` 条目 `regexTarget` 必须是 `"secret"`，新条目是 `"line"`。新的 vault 条目也不在后面的反向样例数组里（16 个样例只覆盖前 16 个 `scoped`），所以既会红、也没有覆盖新条目的反向检查。
- 证据（亲自读到）：
  - `test/tooling/gitleaks-allowlist.test.mjs:64`：`expect(scoped).toHaveLength(16);`
  - `test/tooling/gitleaks-allowlist.test.mjs:67`：`expect(block.regexTarget).toBe("secret");`
  - `ci/rules/gitleaks.toml:158-164` 新增的块末尾：`regexTarget = "line"`、`regexes = ['''^\s*"(?:wrappedKey|password)": "[A-Za-z0-9+/]{40,}={0,2}",?\s*$''']`
- 影响：`ci/policy.json:238` 把 `test/tooling/**/*.test.mjs` 放进 `tooling` 项目，CI 的 tests 项目会跑；`npm run check:gitleaks`（作者只跑了这一条）不会覆盖它。
- 建议：把断言改成 17（或改成从配置推导，不写死），并单独允许 vault 条目的 `regexTarget = "line"`；同时在 `gitleaks-config.test.mjs` 的夹具里加入 `vault-contract.json`，再加“同文件别的字段/别的路径/改一个字符仍被报”的反向用例，最后至少跑 `--project tooling`。
- 结论：读代码证实，不是推测。

### 2. 中：上轮第 3 条没有改好：解密/批准写失败恰逢过期时，模型仍拿 denied，数据库最终是 expired

- 文件:行：`packages/application/src/services/vault-service.ts:544-555`（本轮增量未改动此文件）；`test/integration/vault-approval.test.ts:373-399`
- 问题：catch 分支里 `await decide("denied", "failed")` 的返回值被丢掉。若请求在此时已经过期，`store.decideRequest` 会返回 `null`（`sqlite-vault-operations.ts:331-349` 的 `close` 只更新仍 pending 且未过期的行），但 `finally` 仍然 `deliver({ kind: "denied" })`；请求行留在 pending，之后由 `expireOverdue` 记成 expired。模型看到的 denied 和数据库最终 expired 仍然不一致。作者说已修改，但这份代码与 `d56988281` 一致，增量没有碰它。
- 证据（亲自读到）：
  - `vault-service.ts:548-552`：`try { await decide("denied", "failed"); } finally { deliver({ kind: "denied" }); }`
  - `sqlite-vault-operations.ts:334-349`：`UPDATE ... WHERE ... AND status = 'pending' AND (? = 'expired' OR expires_at > ?)`，`if (changed.changes !== 1) return null;`
  - 测试 `vault-approval.test.ts:393-398` 明确写了 `expect((await outcome).kind).toBe("denied")`，随后 usage 断言为 `["expired"]`，等于把这个不一致固化了。
- 建议：批准路径的 catch 里，如果 denied 写入返回 `null`，应按实际读回状态给模型 expired（或至少把 waiter 结果改成与 DB 一致）；若这是有意设计，应在规格里写明“模型可能收到 denied 而审计是 expired”，并加专门测试说明原因。当前文档只写了“手机报错、请求行留等待、之后补记过期”，没有写模型会拿 denied。
- 结论：读代码证实。

### 3. 低：上轮第 4 条没有改好：翻旧对话超过最后一页时仍说“没有找到相关的旧对话”

- 文件:行：`apps/agent-service/src/production-conversation-tools.ts:259`、`:276-277`；`packages/prompt-catalog/src/tools.ts:234`
- 问题：`page` 超出实际页数时 `shown = pages[page - 1] ?? []` 为空，随后只要 `shown.length === 0` 就附 `TOOL_RESULT_CONVERSATION_EMPTY`（“没有找到相关的旧对话”）。查询其实命中了，只是页码越界。增量未改动此文件。
- 证据（亲自读到）：
  - `production-conversation-tools.ts:259`：`const shown = pages[page - 1] ?? [];`
  - `production-conversation-tools.ts:277`：`...(shown.length === 0 ? { note: TOOL_RESULT_CONVERSATION_EMPTY.text } : {}),`
- 建议：只有 `pages.length === 0` 时才说没找到；页码越界时改为“这个页码没有内容，实际只有 N 页”之类的固定说明，或把 `page` 夹到 `pages.length`，并补一条 `page > pages.length` 的测试。
- 结论：读代码证实。

### 4. 低：文档和清单仍写“只给名字、类型、网站”，但 `vault_list` 现在也返回 `id`

- 文件:行：`apps/agent-service/src/production-vault-tools.ts:48-53`；`docs/execution/specs/2026-11-25-secret-vault-design.md:62`、`:129`；`docs/adr/0287-passwords-and-keys-live-in-a-vault-the-phone-unlocks.md:49`；`packages/prompt-catalog/prompt-manifest.json:1366`
- 问题：上轮第 2 条修的是模型可见的工具说明（`packages/prompt-catalog/src/tools.ts:36` 已写“每一项的编号、名字、类别……和允许使用的网站”），但规格/ADR/manifest 的 reason 仍写“只拿到名字和网站”“只给名字、类型、网站”。工具实际返回 `id`、`name`、`kind`、`sites` 四项，文档与代码不一致。
- 证据（亲自读到）：
  - `production-vault-tools.ts:48-53` 的返回对象含 `id: item.id`；
  - 规格 `:62`“她列出保险箱，只拿到名字和网站”；
  - 规格 `:129`“列出工具 `vault_list`（只给名字、类型、网站）”；
  - ADR `:49`“她只看到每一项的名字和允许的网站”。
- 建议：文档改为“编号、名字、类型、网站”，或明确 `id` 只是不透明编号、不算“看到的内容”；manifest reason 也同步。
- 结论：读代码证实。

### 5. 低：新白名单按值的形状放行，没有像同类条目那样锚定精确值，范围偏宽

- 文件:行：`ci/rules/gitleaks.toml:158-164`（对比同文件 `:26-28`、`:36`、`:44` 等）
- 问题：已有白名单大多按精确值放行（例如只放行一个 SHA-256、一个固定 token）。新条目只要求整行是 `"wrappedKey"` 或 `"password"` 加 40 位以上标准 base64，不限定到 fixture 里那 4 个值。以后若在这个夹具的同名字段里放入真正像密码/密钥的 base64，扫描会静默放过。路径和字段名已经收窄，风险低，但比同类条目宽。
- 证据（亲自读到）：`regexes = ['''^\s*"(?:wrappedKey|password)": "[A-Za-z0-9+/]{40,}={0,2}",?\s*$''']`；而 `:28` 是 `^p4-save-secrets-final\.log": "0803...416a"$` 这种精确值。
- 建议：把 `regexes` 收窄到 fixture 里实际被报的 4 个固定值（或至少限定为这两个字段的已知 fixture 值），保留 path/规则/整行三个条件。
- 结论：读代码证实配置形状；“以后可能漏放真密钥”是风险推测。

### 6. 低：ADR/规格说五道 `check:vault-*`，代码只有四道

- 文件:行：`docs/adr/0287-passwords-and-keys-live-in-a-vault-the-phone-unlocks.md:54`、`docs/execution/specs/2026-11-25-secret-vault-design.md:114`、`package.json:42-45`
- 问题：ADR 决定 6 和规格都写五道硬门槛，包含 `check:vault-egress` 并“接进 `npm run check`”；`package.json` 只有 canary/contract/approval/recovery 四个 `check:vault-*`，没有 egress，`check:steps` 里也没有。作者的“四道 check:vault-*”与代码一致，但与 ADR/规格不一致。
- 证据（亲自读到）：ADR 原文列 `check:vault-canary、check:vault-contract、check:vault-approval、check:vault-egress、check:vault-recovery`；`package.json:42-45` 只有四项。
- 建议：如果 egress 属于后续“第 4 步”，在 ADR/规格里标明“本次不包含、第 4 步接上”；否则补脚本并接进 `check:steps`。
- 结论：读代码证实；是否为有意留到后续步骤，未核实。

---

## 上一轮意见核对

- 上轮第 2 条（`vault_list` 说明漏写 `id`）：已改好。`packages/prompt-catalog/src/tools.ts:36` 已写“每一项的编号、名字、类别……和允许使用的网站”，同一提交 `af0c6eb27` 同时更新了 manifest 的 `55c491…` 摘要。没有找到专门断言“说明里必须有编号”的语义测试，只有 manifest 摘要检查。
- 上轮第 3 条（写失败恰逢过期）：未改好，见第 2 条意见。增量没有碰 `vault-service.ts`。
- 上轮第 4 条（翻页越界仍说没找到）：未改好，见第 3 条意见。增量没有碰 `production-conversation-tools.ts`。
- 上轮第 6 条（approved 提交后抛错 → DB approved / 模型 denied）：仍未复现。`sqlite-vault-operations.ts:298-300` 的 `decideRequest` 是 `assertDiskHeadroom()` 后整个 `close` 在一个事务里；`close` 的 UPDATE、`readRequest`、`insertUsage` 都在事务内，任何抛错会回滚，没有看到“提交后抛错”的路径。维持“推测、未证实”。

---

## 侧重检查

- **错误路径与竞态**：核对了 `approve`/`deny`/`#expire`/`#expireOverdue`。`approve` 先 `waiters.delete` + `timer.cancel` 再解密（当前代码仍在），未发现上轮第 6 条那条“提交后抛错”路径；上轮第 3 条的不一致仍在（第 2 条意见）。`#expire` 写失败时仍 settle expired、请求行留给下次 `expireOverdue`，与作者描述一致。
- **不可信输入**：`vault_list` 不接受参数（`production-vault-tools.ts:44-45` 拒绝非空参数）；保险箱项编号在写入时用 `VAULT_PATTERNS.itemId` 校验；设备接口按 `ownerId/agentId` 限定（`production-http-composition.ts:1806-1810`）。推送里的 `requestId` 来自服务端生成的 `vr_` token，手机端不读它，规格已写明（`...secret-vault-design.md:135`）。
- **安全/不可逆操作**：本轮没有新增不可逆动作；`vault_list` 只读且不返回值。gitleaks 白名单只影响这一个夹具文件，但形状偏宽（第 5 条意见）。
- **资源耗尽**：`vault_list` 最多 500 项（`VAULT_LIMITS.items`），但 Pi 侧 `fitPiResultOutput` 会按预算截断工具结果（`packages/runtime-pi/src/model-output-budget.ts:33-100`），未发现新增的无限增长路径。
- **合并正确性**：`production-apple-push.ts` 合并后 `requestVaultApproval`（`:327-359`）、`applePushVaultApprovalPayload`（`:169-193`）和 main 的 `#retryLater`（`:404`、`:590-602`）都在；`service-main.ts:1735-1744` 仍把 notifier 接到 `applePush.requestVaultApproval`。没有残留 `production-think*` 导入（`git grep` 无匹配）。合并本身没发现新错。
- **未接上但已写明**：生产代码仍没有 `requestRelease` 调用方（只有测试和规格 `:135`），所以批准推送目前不会发出；这是规格明确记录的限制，不是本轮新增缺陷。
- **文档/代码一致性**：发现第 4、6 条不一致；上轮第 2 条的说明文字已与工具返回对齐。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   本轮增量（gitleaks + 合入 main）本身不改变发给模型的系统提示、工具定义、历史或遮盖结果。整个 PR 新增了固定的 `vault_list` 工具定义：这会让已有对话的工具集合变一次，按规则第 6 条属于“工具集合变了换新一次”的例外，是对话重建时一次性的头部变化，不是每轮变化；`service-main.ts:1796` 始终创建 `ProductionVaultTools`，`production-runtime-tools.ts:627` 无条件加入，工具列表不随保险箱状态变化。保险箱的内容只通过 `vault_list` 的工具结果追加在末尾。每轮会变的值（列表内容）不在系统提示/工具定义里。增量没有碰 prompt-prefix 相关代码。

2. **同一段文字会不会在不同请求里变成不同字节？**
   本轮增量不会。`vault_list` 的输出顺序是确定的：`listedVaultItems` 按 `name`、再按 `id` 排序（`vault-service.ts:196-210`），`origins` 在写入时已经排序（`vault-service.ts:166`），对象键顺序也固定（`production-vault-tools.ts:48-53`）。保险箱批准推送里的 `requestId` 每次不同，但它不是模型输入。没有新增依赖前后文的遮盖、时间字段或无序集合。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有，但本轮新增白名单的检查是坏的：`test/tooling/gitleaks-allowlist.test.mjs` 的结构断言会立即失败（第 1 条意见），而且新条目没有反向样例；`gitleaks-config.test.mjs` 的端到端夹具也没有加入 `vault-contract.json`，所以新白名单没有被真正跑过。上轮第 3 条有测试，但测试断言的是 denied/expired 的不一致结果，不会把它当 bug 拦住；上轮第 4 条没有越界翻页测试；上轮第 6 条没有“提交后抛错”测试；合并后的保险箱推送也没有专门测试。`vault_list` 加入只读清单有 `tool-read-only-offer.unit.test.ts:32-43` 覆盖。

4. **增量产生或修改的每个值，使用端都能接受吗？**
   - `gitleaks` 新白名单：引擎本身接受（沿用同文件既有 `regexTarget` 写法）；但 `test/tooling/gitleaks-allowlist.test.mjs` 不接受（长度和 `regexTarget` 都断言失败）。`ci/toolchain-lock.json` 的摘要被 `scripts/ci/install-tools.mjs:370-383` 的 `verifyRuleFiles` 读取并重算；当前 lock 里是 `291bd1…`，我无法在不运行命令的情况下重算 sha256，标「未核实」，但合并没有改 `gitleaks.toml`，也保留了该值。
   - `VAULT_APPROVAL_PUSH_KIND = "vault_approval"`、`vaultRequestId`：生产使用端是 `service-main.ts:1738-1740` → `ProductionApplePush.requestVaultApproval`，`onDelivery` 只是写诊断字符串，不会因为新 kind 被枚举拒绝；手机端目前不读 `vaultRequestId`（规格写明），所以还没有校验端能拒绝它。
   - `vault_list` 返回的 `id`：产生端是 `listedVaultItems` / `production-vault-tools.ts:49`，格式由 `VAULT_PATTERNS.itemId` 在写入时保证；模型只是把它当不透明编号。直接使用端目前没有别的校验代码，文档却写“只给名字、类型、网站”（第 4 条意见）。
   - `TOOL_VAULT_LIST`：`usedBy` 指向 `production-vault-tools.ts`，口径一致；`tool-read-only-offer` 期望的只读清单包含 `vault_list`，与 `production-tool-actions.ts:413-425` 的 `READ_DEFAULTS` 配置一致。
