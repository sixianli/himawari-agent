**读代码证实的**

### 1. 中低：第 6 轮第 1 条只改好了文档，自主“想一想”运行仍能枚举保险箱元数据
- 文件:行：`docs/architecture-v0.1.md:437`；`apps/agent-service/src/service-main.ts:1799-1806`；`apps/agent-service/src/production-tool-actions.ts`（`vault_list` 行）；`apps/agent-service/src/production-vault-tools.ts:47-54`
- 问题：增量把 `vault_list` 补进了架构文档的只读工具枚举，文档与代码不一致这一半确实改好了；但被同一条意见点名的行为——“自主运行可枚举保险箱元数据”——没有任何变化。`vault_list` 现在仍会被发给“想一想”运行。
- 证据：`docs/architecture-v0.1.md:437` 新写“现在是 web_search、web_fetch、recall、conversation_search、conversation_open、reminder_list、rule_list、tool_result_recall、perception_read、vault_list；vault_list 只给保险箱里各项的名字、类型和网站，不给值”。代码侧 `service-main.ts:1799-1806` 无条件构造 `vault: new ProductionVaultTools({...})`，并令 `readOnlyRun` 对想一想来源返回 true；`production-tool-actions.ts` 把 `vault_list` 登成 `actionKind: "READ", sideEffect: "none", family: "builtin"`，正好通过 `readOnlyRow`（`tool-action-registry.ts:99-105`）进入想一想工具集。`production-vault-tools.ts:47-54` 返回条目清单。
- 建议：如果“想一想可枚举保险箱元数据”是有意接受的风险，请在文档/ADR 里明确写“想一想运行可以读到保险箱清单的元数据”及理由；如果不接受，就在 `listAuthorized` 的只读过滤之外再按运行来源排除 `vault_list`（运行来源已经查得到），并补反向用例。仅补文档不能算这条意见全部改好。

### 2. 低：新增的 `vault_list` 说明漏写了它还会返回条目 `id`
- 文件:行：`docs/architecture-v0.1.md:437`；`packages/application/src/services/vault-service.ts:57-62`；`apps/agent-service/src/production-vault-tools.ts:47-54`
- 问题：增量新增的说明说只给“名字、类型和网站”，但工具结果还带 `id`。这是本轮增量直接引入的文档/代码不一致（旧的设计文档 `docs/execution/specs/2026-11-25-secret-vault-design.md:129` 也漏了 `id`，属于同一个简化）。
- 证据：`VaultListedItem` 是 `{ id; name; kind; sites }`（`vault-service.ts:57-62`）；`production-vault-tools.ts:47-54` 显式返回 `id: item.id, name: item.name, kind: item.kind, sites: item.sites`；模型拿到的是 `JSON.stringify(value)`（`production-runtime-tools.ts` 的 `modelContent`），因此 `id` 确实到模型。没有返回字段值本身，所以“不给值”这半句是对的。
- 建议：改成“只给编号、名字、类型和网站，不给值”，或写“只给不含秘密值的元数据”，并同步改设计文档那一句。

### 3. 低：第 6 轮第 2 条仍在：解密/批准写失败恰逢过期时，模型拿 denied，库里最终记 expired
- 文件:行：`packages/application/src/services/vault-service.ts:546-555`；`packages/persistence-sqlite/src/sqlite-vault-operations.ts:331-349`；`test/integration/vault-approval.test.ts:373-398`
- 问题：失败分支调用 `decide("denied","failed")` 后不看返回值，`finally` 一律 `deliver({kind:"denied"})`。若请求已过期，`close` 的 WHERE 条件 `(? = 'expired' OR expires_at > ?)` 对 `denied` 要求 `expires_at > now`，更新不到行就返回 null；状态留在 `pending`，之后 `expireOverdue` 再补成 `expired` 并写 `expired` 使用记录。于是模型看到 denied，数据库/手机最终看到 expired，正好是上一轮第 2 条描述的情况。
- 证据：`vault-service.ts:546-552`：
  ```
  wipeAll();
  try {
    await decide("denied", "failed");
  } finally {
    deliver({ kind: "denied" });
  }
  ```
  `sqlite-vault-operations.ts:332-348` 的 UPDATE 带 `status = 'pending'` 与 `(? = 'expired' OR expires_at > ?)`，`changed.changes !== 1` 就 `return null`。现有测试 `vault-approval.test.ts:393-398` 甚至固定了“模型 denied，随后 usage 为 expired”。
- 建议：失败分支保存 `decide("denied","failed")` 的返回值；返回 null 时像 `approve` 的 `!decided` 分支那样先跑 `expireOverdue`/读状态，再按真实状态交付（expired 或 denied），而不是无条件 denied；补一条“已过期时解密失败”的用例。

### 4. 低：第 6 轮第 4 条仍在：翻旧对话超过最后一页时仍说“没有找到相关的旧对话”
- 文件:行：`apps/agent-service/src/production-conversation-tools.ts:259,276-277`；`packages/prompt-catalog/src/tools.ts:234`；`test/integration/conversation-turns.test.ts:819-820`
- 问题：`page` 超过总页数时取到空数组，随后按“空结果”加上固定文案“没有找到相关的旧对话”，而实际上前面的页有结果。本轮增量没碰这段。
- 证据：`production-conversation-tools.ts:259` `const shown = pages[page - 1] ?? [];`，`276-277` 在 `shown.length === 0` 时加 `note: TOOL_RESULT_CONVERSATION_EMPTY.text`；该文案在 `tools.ts:234` 为“没有找到相关的旧对话。不要编造……”。测试 `conversation-turns.test.ts:819-820` 只断言 `beyond.output["turns"]` 为 `[]`，没有断言这条 note，所以不会失败。
- 建议：区分“零命中”和“页号超过末页”。当 `pages.length > 0 && page > pages.length` 时，明说“这一页没有更多了，结果到第 N 页为止（可回到第 N 页或换关键词）”，不要复用“没有找到”；同时补一条断言 note 的反向用例。

### 5. 低：架构文档的只读工具枚举没有自动检查，这次修好的文档漂移还会再发生
- 文件:行：`apps/agent-service/test/think-run-pieces.unit.test.ts:33-44`；本轮提交 `d56988281`（`Layer-0-tests: none`）
- 问题：代码侧有精确清单测试，但没有任何自动检查把 `docs/architecture-v0.1.md` 的枚举和代码绑在一起。上一轮正是“代码有 `vault_list`、文档漏了”才出的问题；把文档改回来以后，反向用例（文档再次漏项）仍然不会让任何检查失败。
- 证据：`think-run-pieces.unit.test.ts:33-44` 精确断言 10 个只读工具名（含 `vault_list`），删掉 `vault_list` 会失败；但本增量只改 Markdown，提交说明写明 `Layer-0-tests: none`，只跑了 glossary 和 document-governance，没有比对文档列出的工具名与 `readOnlyRow` 结果。
- 建议：加一个轻量检查脚本（或现有 document-governance 的一条），从 `PRODUCTION_TOOL_ACTION_ROWS` + `readOnlyRow` 生成只读工具清单，再断言架构文档那一行包含全部名字；至少加一条测试，文档漏 `vault_list` 时失败。

**推测 / 未核实**

### 6. 低（推测）：第 6 轮第 3 条“approved 提交后抛错 → DB approved / 模型 denied”未能复现
- 文件:行：`packages/application/src/services/vault-service.ts:485-494,545-576`；`packages/persistence-sqlite/src/sqlite-vault-operations.ts:298-301`；`packages/platform-node/src/vault-crypto.ts:68-70`
- 问题/结论：当前生产 SQLite 适配器的 `decideRequest` 是单个事务（`transaction(() => this.close(input))()`），提交后再无会抛错的步骤；`deliver` 里唯一可能抛的 `ephemeral.dispose()` 在 Node 实现里是置空赋值，不会抛。因此我没有找到把“已提交 approved”和“模型 denied”连起来的路径，判定为推测、未证实。接口层没有写明 `decideRequest` 必须原子；若将来出现非原子的 `VaultStorePort` 实现，仍可能出现该不一致。
- 建议：在端口注释里写明 `decideRequest` 的原子性要求，或在 `approve` 的 catch 里先读回状态再决定交付结果，避免依赖实现细节。

**侧重检查**

- 错误路径：核对了 `approve` 的解不开、写批准失败、并发过期、计时器先触发等分支；确认第 3 条（过期时仍交付 denied）仍存在，第 6 条未能复现。
- 不合规范/不可信输入：`ProductionVaultTools.run` 校验 `capabilityRef` 且拒绝任何参数（`production-vault-tools.ts:44-45`），`vault_list` 参数定义为空对象且 `additionalProperties: false`；输出只映射 `id/name/kind/sites`，没有字段密文或密钥。
- 安全：确认“想一想”运行能拿到 `vault_list`（`service-main.ts:1799-1806` + 只读过滤），能读清单元数据，但拿不到秘密值；这是第 1 条的残留风险。
- 资源耗尽：本增量是纯文档，无新增运行时路径；`vault_list` 的条目数受 `VAULT_LIMITS.items = 500` 约束（`packages/application/src/ports/vault.ts`），本轮未发现新增的无界读取。
- 不可撤销操作：本增量不涉及任何执行/删除/发送路径。
- 规则/文档与代码一致性：架构文档工具清单现在与 `think-run-pieces` 的 10 项一致；`vault_list` 描述漏 `id`；设计文档 `2026-11-25-secret-vault-design.md:129` 同样漏 `id`。`readOnlyRow` 的“READ + none + builtin/web”与文档表述一致（`tool-action-registry.ts:97-105`）。

**本轮查过的范围**

- 增量 `c155f95f2..d56988281`：只改了 `docs/architecture-v0.1.md:437`（以及 Review 记录文件），`git show d56988281 --stat` 确认代码零改动。
- 上一轮第 6 轮的 4 条意见逐条对照：第 1 条文档部分已修、行为未变；第 2 条仍在；第 3 条推测未复现；第 4 条仍在。
- 为核对文档新增内容而跟进的代码：`production-vault-tools.ts`、`production-tool-actions.ts`、`tool-action-registry.ts`、`service-main.ts`、`vault-service.ts`、`sqlite-vault-operations.ts`、`production-conversation-tools.ts`、`prompt-catalog/src/tools.ts` 及相关测试。
- 未复核：Swift 端、推送、恢复等增量未触碰的旧代码；第 6 轮第 3 条之外的并发/存储实现细节。

**必答问题**

1. **请求开头是否变化**：本轮增量不涉及——它只改 Markdown，不碰系统提示、工具定义、历史或遮盖。需要说明的是，整份 PR 更早的增量已新增 `vault_list` 工具定义，按 `prompt-prefix` 规则第 6 条，老对话在第一次带上它时会重建一次请求开头（工具集合变了）；这是既有增量引入的一次性变化，不是本轮造成的。工具集合本身不随保险箱状态变化。
2. **同一段文字是否变成不同字节**：本轮增量不涉及——文档文本不会被序列化进请求。顺带核对 `vault_list` 结果：`listedVaultItems` 按 `name`、再按 `id` 排序（`vault-service.ts:184-198`），同一批条目每次顺序固定，不依赖数据库返回顺序。
3. **是否有自动检查、反向用例会不会失败**：代码侧有 `think-run-pieces.unit.test.ts:33-44` 的精确 10 项清单，删掉 `vault_list` 会失败；但本轮“文档漏项”这个反向场景没有自动检查，提交说明也是 `Layer-0-tests: none`，所以这次的文档修复没有回归保护（见第 5 条）。
4. **增量产生/修改的值的所有使用端能否接受**：本轮唯一改动的“值”是文档里的工具名枚举和 `vault_list` 说明。逐个核对：文档列出的 10 个名字都与 `PRODUCTION_TOOL_ACTION_ROWS` 和 `think-run-pieces` 的期望一致；`vault_list` 确实通过 `readOnlyRow`（READ、none、builtin）进入想一想工具集；但说明里的“只给名字、类型和网站”与代码实际返回的 `id` 不符（见第 2 条）。没有新增配置键、字段或序列化格式，其他使用端不涉及。
