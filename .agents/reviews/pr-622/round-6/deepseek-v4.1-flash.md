## 审查范围

当前工作区实际 HEAD 是 `c155f95f2`（`git log`/`git status` 可见），不是材料第二段写的 `ab4d011`。我按实际 HEAD 和第一段材料审查了 `a5a7f14f5..c155f95f2` 全量，并重点看 `c9d9cd01c..c155f95f2` 增量：`production-runtime-tools.ts`、`production-conversation-tools.ts`、`think-run-pieces.unit.test.ts`、`docs/architecture-v0.1.md`、`tool-result-clearing.ts`、`sensitive-capture/redaction.ts`、配置解析和新增测试；再回到增量没改的 `vault-service.ts`、`sqlite-vault-operations.ts`、`vault-approval.test.ts` 核对上一轮两条。Swift 页面/推送客户端、真实运行测试、完整 vault HTTP 端到端未核实。

## 意见

### 1. 中低：vault_list 被写进“想一想”只读工具测试，但架构文档的只读工具枚举不含它，自主运行可枚举保险箱元数据

文件：`docs/architecture-v0.1.md:437`、`apps/agent-service/test/think-run-pieces.unit.test.ts:33-44`、`apps/agent-service/src/production-runtime-tools.ts:627-636`、`docs/execution/specs/2026-11-25-secret-vault-design.md:129,133`

问题：增量把“想一想”只读工具测试改成精确的 10 项并加入 `vault_list`，但同一轮修改的架构文档在枚举“想一想”只读工具时仍写 9 项，没有 `vault_list`；保险箱规格又要求 `vault_list` 工具始终在。代码上 `vault_list` 确实是 `READ`/`sideEffect: none`，所以思考运行会实际拿到它，只返回名字、类型、网站，不返回值。

证据：

```ts
// think-run-pieces.unit.test.ts
expect([...readOnly].sort()).toEqual([
  "conversation_open",
  "conversation_search",
  ...
  "vault_list",
  ...
]);
```

```text
// architecture-v0.1.md:437
这种运行只拿到只读工具：……（现在是 web_search、web_fetch、recall、conversation_search、conversation_open、reminder_list、rule_list、tool_result_recall、perception_read）。
```

```ts
// production-tool-actions.ts:415-422
tool: "vault_list",
...
authorization: "read",
executor: "owner_scoped",
```

读代码证实：`readOnlyRow` 会让 `vault_list` 通过，`ProductionRuntimeTools` 只要配置了 `vault` 就会把它加入候选。推测：文档漏写可能只是疏忽，也可能是故意不让自主运行看保险箱元数据；但“想一想”由外部内容触发、又能上网，模型可把条目名字/网站拼进搜索或网页请求，这是元数据外泄面（不涉及密码值）。

建议：明确取舍。若允许，更新架构文档的枚举，并补一条真正走 `ProductionRuntimeTools` + `readOnlyRun: true` 的测试；若不允许，应在只读清单/运行层排除 `vault_list`，而不是只改测试期望。`docs/execution/specs/2026-11-25-secret-vault-design.md:133` 的“工具列表不随保险箱里有没有东西变化”也需要和这个决定对齐。

### 2. 低：上一轮第 1 条没有改好：解密失败恰逢过期时，模型拿 denied，数据库状态和 usage 仍可能是 expired

文件：`packages/application/src/services/vault-service.ts:546-555`、`packages/application/src/services/vault-service.ts:352-368`、`test/integration/vault-approval.test.ts:373-398`

问题：`approve` 的失败分支忽略 `decideRequest` 的返回值。若定时器或并发的 `expireOverdue` 已先把请求写成 `expired`，这里再写 `denied` 会返回 `null`，但代码仍无条件 `deliver({ kind: "denied" })`，模型拿到 denied，数据库和 usage 却是 expired。增量没有改 `vault-service.ts`（`c9..c155` 的文件清单中没有它），所以上一轮这条仍在。

证据：

```ts
} catch (error) {
  wipeAll();
  try {
    await decide("denied", "failed");
  } finally {
    deliver({ kind: "denied" });
  }
```

```ts
// 定时器路径先写 expired
status: "expired",
...
usage: "expired",
...
if (closed) this.#settle(id, { kind: "expired" });
```

现有测试反而把这个不一致固定成了预期：

```ts
expect((await outcome).kind).toBe("denied");
...
context.advance(121_000);
expect((await context.service.usage(scope, itemId)).map((entry) => entry.outcome)).toEqual([
  "expired",
]);
```

读代码证实：模型结果与数据库/usage 可以不一致。没有“解密失败与过期同时发生”的反向用例；`373` 这条测试在模型 denied 后要求 usage 为 expired。

建议：在失败分支检查 `decide` 返回值；为 `null` 时调用 `expireOverdue`/重读请求状态，只有状态仍是 `denied` 才给 denied，否则给 expired。补一条测试：解密失败时触发过期，断言模型、数据库、usage 三边一致，并相应修改 `373` 这条测试。

### 3. 低（推测）：上一轮第 2 条没有改好：approved 提交后抛错时，仍可能 DB approved / 模型 denied

文件：`packages/application/src/services/vault-service.ts:545-555`

问题：`decided = await decide("approved", "approved")` 如果底层存储已经提交、然后在提交后抛错，会进入 catch；catch 再写 denied 时，请求已不是 pending，返回 `null`，但代码仍 `deliver(denied)`，并且因为 `decrypted` 为真而重新抛出。结果是数据库/usage 为 approved，模型却拿到 denied。

证据：

```ts
decrypted = true;
decided = await decide("approved", "approved");
} catch (error) {
  wipeAll();
  try {
    await decide("denied", "failed");
  } finally {
    deliver({ kind: "denied" });
  }
  if (error instanceof VaultError || decrypted) throw error;
```

推测：当前 SQLite 实现把 `close` 包在事务里，正常不会“提交后再抛”，所以这是低概率的存储适配器/未来实现问题。`vault-approval.test.ts:340-371` 只覆盖了“写 approved 之前就抛错”，没有覆盖提交后抛错。

建议：catch 中重读请求状态，若已是 approved，不要把模型结果降成 denied（同时注意当前 `wipeAll()` 已把已解出的值抹掉，需调整抹除时机）；并补一个“commit 后抛错”的存储桩测试。

### 4. 低：翻旧对话的 page 超过最后一页时，工具错误地说“没有找到相关的旧对话”

文件：`apps/agent-service/src/production-conversation-tools.ts:259,276-277`、`test/integration/conversation-turns.test.ts:819-820`

问题：`shown = pages[page - 1] ?? []` 无法区分“确实没有命中”和“页码超过最后一页”。后者也返回空数组，并在 `shown.length === 0` 时加上 `TOOL_RESULT_CONVERSATION_EMPTY`，模型可能据此告诉主人没有相关旧对话，而实际上有结果。

证据：

```ts
const shown = pages[page - 1] ?? [];
...
...(shown.length === 0 ? { note: TOOL_RESULT_CONVERSATION_EMPTY.text } : {}),
```

测试只检查了空数组，没有检查误导性说明：

```ts
const beyond = await call("conversation.search", { query: "面试", page: 9 });
expect(beyond.output["turns"]).toEqual([]);
```

读代码证实。建议：区分 `hits.length === 0` 与 `page > pages.length`；页码越界时返回“没有更多了”之类的说明或不做“没有找到”的断言；补一条检查 `note` 的测试。

## 侧重检查

- 错误路径/不可信输入：`conversation_search/open` 有 `onlyKeys`、query 长度、日期正则、正整数页码/sequence 校验；`vault_list` 拒绝任何参数；`approve` 逐字段核对 nonce、设备、项、版本、origin、页面版本、临时公钥、过期时间。未发现 SQL 注入或越权读取（查询按 owner/agent 过滤；`window` 还排除了 `origin: "think"`）。
- 安全：`namesRememberedValue` 只在结果里出现密码/验证码原文时阻止清理，测试覆盖了正反例；`conversation_search/open` 对含外部内容的旧对话通过 `readThread` 打标记。发现的风险是第 1 条：自主思考运行可枚举保险箱条目元数据，且文档枚举与测试不一致。
- 资源耗尽：搜索固定最多 60 轮，页预算按模型窗口的 `toolResultShare`（配置限制为 `(0, 0.5]`，消费端最低 2000 字）计算；`conversation_open` 用同一字符预算。未发现无界循环。清理判断对旧工具结果逐个跑 `redactForEgress`，历史很长时有一定 CPU 开销，但有批量和阈值约束。
- 不可撤销操作：增量没有新增不可撤销操作；保险箱批准/拒绝仍是 pending 条件更新。
- 规则/文档一致性：`prompt-prefix.md` 的 `[CLEAR-6]/[CLEAR-7]` 与 `scripts/check-prompt-prefix.mjs` 的 `REQUIRED = 18` 对得上；第 1 条是明确的不一致。
- 值的使用端：`VAULT_LIST_CAPABILITY_REF = "vault.list"` 在描述符、动作行、`ProductionVaultTools.run` 三处一致；`RECALLED_EXTERNAL_CONVERSATION_ORIGIN` 被 `mark` 接受、`readThread` 按 thread 键读取，长度也在 256 以内；`namesRememberedValue` 经 `sensitive-capture` 的 `export *` 导出并被 `tool-result-clearing` 使用；`toolResultShare` 的严格解析和消费端一致。上一轮两条涉及的“数据库/usage”与“模型结果”两端仍不接受彼此的差异（第 2、3 条）。
- 未核实：Swift 页面/推送客户端对 `vaultRequestId` 等的处理；真实跑测试的结果（本环境只能读代码和看 git，不能运行测试）。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
保险箱本体：`vault_list` 是固定工具，是否出现只看服务配置，不看保险箱里有没有项、有没有待批准请求；保险箱数据只作为末尾追加的工具结果，不改系统提示、工具定义和历史消息。增量里的对话工具也是在配置了对话索引时固定追加在工具列表末尾，不随每轮状态变化；“想一想”的只读集合由运行来源决定，同一个运行内固定。需要注意的是一次性发布变化：新增工具会让已有对话下一次请求的工具列表改变一次，这是新功能上线的固有代价，不是每轮变化。另，工具结果清理在“清理发生的那一次”会改开头，这是既有设计允许的。
**2. 会不会让同一段文字在不同请求里变成不同的字节？**
保险箱列出结果只含 id/名字/类型/网站，没有时间或当前状态；批准请求的 nonce/expiresAt 不进模型上下文。旧对话搜索结果的 `time` 是存储的 `committedAt`，不是当前时间；同一历史、同一配置下结果是确定的。清理判断现在是确定性的，但它用当前出口规则集（`namesRememberedValue` 不传 `ruleset`），所以跨规则集版本升级时，同一段历史可能保留/清理不同的旧工具结果，从而改变开头字节——这是推测的跨版本影响，在当前版本内不成立；文档已说明用当前规则集，但没有把“跨版本可能变”写清。
**3. 有没有自动检查，反向用例真的会失败？**
有：思考运行只读清单、对话工具合约、`[CLEAR-6]`/`[CLEAR-7]`、`toolResultShare` 非法值、`check:vault-*` 四道门；`-t vault-approval`/`-t vault-recovery` 能匹配到对应的 `describe("[vault-approval]")`/`describe("[vault-recovery]")`，不是空跑。
但上一轮第 1 条没有对应的反向用例，`vault-approval.test.ts:373-398` 反而把“模型 denied、usage expired”固定成预期；第 2 条没有“提交后抛错”的用例；第 4 条页码越界的测试只断言 `turns` 为空，不检查误导性的 `note`。本环境不能运行测试，“会不会失败”是从断言和代码路径判断的，未实际执行。
**4. 每个产生/修改的值，使用端都能接受吗？**
逐个核对的结果：`vault.list` 的描述符、动作行、`ProductionVaultTools.run` 一致，动作行是 READ/none，注册表能接受；`vault_list` 返回的 `id/name/kind/sites` 正是消费端映射的字段。`RECALLED_EXTERNAL_CONVERSATION_ORIGIN` 被 `mark` 接受（origin 不设白名单），`readThread` 用 thread scope 读取，测试覆盖。`namesRememberedValue` 通过包根导出，清理端按单个 content block 调用，正反例都有。`toolResultShare` 严格配置只允许 `(0,0.5]`，消费端对缺省窗口有 2000 字下限。`conversationToolDescriptors`/`toolResultCharacters` 的调用端和测试对得上。
不能接受的是：`vault_list` 进入思考运行的测试/代码与架构文档的枚举不一致（第 1 条）；上一轮的数据库/usage 与模型结果两端仍可能一个 expired/approved、一个 denied（第 2、3 条）。Swift 推送字段和客户端处理未核实。
