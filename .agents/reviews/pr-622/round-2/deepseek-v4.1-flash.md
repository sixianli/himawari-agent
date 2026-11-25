以下结论基于检出 `2903004`、对比 `859601..2903004` 的增量（含 `82c198a3a` 的保险箱修复和 `2903004` 的 main 合并）。我没有运行测试、Swift 或真实推送；除特别注明外都是读代码所得。

### 1. 高：批准成功路径可能被计时器或换钥匙抢走 waiter，已解出的字段不抹掉，模型和手机看到的结果还不一致

**文件:行**：`packages/application/src/services/vault-service.ts:350-371`、`:382-386`、`:373-380`、`:538-574`

**问题**：`approve` 先 `decideRequest({status:"approved"})`，再解密、写使用记录，最后才 `#settle(approved)`。但 `#expire` 无论 `decideRequest` 是否成功都会 `#settle(expired)`；`#closeAll`（换钥匙/删项）也会把仍在 `#waiters` 里的 waiter 结算成 `denied`。如果这两个动作发生在 `approve` 的 `await recordUsage` 期间，`#settle(approved)` 会因 waiter 已被删除而直接 `return`，携带 `wipeAll` 的 `secrets` 对象被丢弃，字段明文永远不会清零；同时手机收到 200/approved、使用记录写 approved，而模型收到 expired/denied。

**证据**：
```ts
// vault-service.ts:354-357
const closed = await this.#options.store
  .decideRequest({ ...scope, id, nonce, status: "expired", deviceId: null, now })
  .catch(() => null);
this.#settle(id, { kind: "expired" });

// :373-376
#settle(id: string, outcome: VaultReleaseOutcome): void {
  const waiter = this.#waiters.get(id);
  if (!waiter) return;

// :382-386
#closeAll(scope: VaultScope): void {
  for (const [id, waiter] of this.#waiters)
    if (...) this.#settle(id, { kind: "denied" });
}

// :538-547（新增的 await 窗口）
await this.#options.store.recordUsage({ ... outcome: "approved" ... });

// :566-574
this.#settle(id, {
  kind: "approved",
  secrets: Object.freeze({ ... wipe: wipeAll }),
});
```
这是读代码证实的竞态窗口；触发需要批准发生在 120 秒临近到期时，或期间另一请求换钥匙/删项。

**建议**：让 `#settle` 返回“是否真的交付了 waiter”；`approve` 在交付失败时调用 `wipeAll()` 并不要报成功。`#expire` 只在 `closed` 非空时结算；`#closeAll` 跳过已经 `decideRequest(approved)` 的 waiter（例如给 waiter 加 `deciding` 标记）。补一条测试：在 `decideRequest` 之后、`recordUsage` 之前触发计时器或换钥匙，断言字段被清零且模型/手机结果一致。

### 2. 高：清理旧工具结果会把“点名过的秘密”从出口遮盖的 known 集合里删掉，后面的裸值或取回的原文可能不遮就发给模型

**文件:行**：`packages/runtime-pi/src/pi-runtime-adapter.ts:1569-1572`、`packages/runtime-pi/src/tool-result-clearing.ts:127-139`、`packages/application/src/services/model-egress.ts:279-289`、`packages/sensitive-capture/src/redaction.ts:320-326`、`:411-423`

**问题**：清理在 `context` 钩子里把旧工具结果换成占位，出口遮盖随后才按请求体逐条消息建立 `known` 集合。如果某个旧工具结果里有“password: XYZ”这类内容，原先遮盖会记住 `XYZ`，后面同一次请求里裸出现的 `XYZ` 会被 `named-earlier` 规则遮掉。工具结果被清成占位后，`XYZ` 不再出现在请求里，后面的裸值就不会被遮。`tool_result_recall` 取回的是历史里的原文，同样可能因为原命名消息已被清理而不被 `named-earlier` 遮住。这会把本来遮住的秘密发给模型。

**证据**：
```ts
// pi-runtime-adapter.ts:1569-1572（清理先于出口遮盖）
pi.on("context", (event) => {
  if (!clearing) return undefined;
  const messages = clearToolResults(event.messages, clearing);
  return messages ? { messages } : undefined;
});

// model-egress.ts:279-289（每次请求新建 known）
const text = (value: string, part) => {
  const result = redactedOrRefused(value, {
    ...
    known: this.#known,
    ...
  });

// redaction.ts:320-326（命名时记住值）
if (rememberValue && known !== undefined && original.length >= 6 && !known.has(original))
  known.set(original, placeholder);

// redaction.ts:411-423（后面的消息用 named-earlier 遮）
if (known !== undefined && known.size > 0) {
  for (const [value, placeholder] of known) {
    ...
    text = text.replace(pattern, () => { ... "named-earlier" ... });
  }
}
```
`Exchange` 是每次请求新建（`model-egress.ts:583-584`），所以 `known` 不会跨请求保留。机制已读代码证实；实际是否泄露取决于对话里是否存在只靠 `named-earlier` 才认出的秘密。

**建议**：出口遮盖的 `known` 集合要从“清理前的历史”建立，或维护按对话保存的已知秘密集合；清理时不要清掉作为秘密来源的工具结果；取回工具结果时也按原历史重算 known。补一条 `[CLEAR]` 用例：旧工具结果里点名密码，后面用户消息裸写同一个值，断言后面仍被遮。

### 3. 中：成功的 `tool_result_recall` 被写成 `succeeded + not_sent`，线程执行投影会把它当成矛盾并让整轮变成 unresolved

**文件:行**：`packages/runtime-pi/src/pi-runtime-adapter.ts:2252-2268`、`packages/application/src/services/thread-execution-projection.ts:387-409`、`packages/application/src/services/thread-execution-state.ts:200-204`

**问题**：成功的取回返回 `productOutcome: "succeeded"` 和 `dispatchState: "not_sent"`。`thread-execution-projection` 明确把“成功但没发出”当作 `unresolved`；`thread-execution-state` 只要有一个 operation 是 unresolved，整轮 `displayPhase` 就变成 `unresolved`。于是每次成功取回工具结果，界面/线程状态都显示成“未确认”，而不是完成。not-found 分支同样被投影成 `not_dispatched`，不是 failed。现有 `[CLEAR-2]` 只检查取回内容，不检查 details，所以抓不到。

**证据**：
```ts
// pi-runtime-adapter.ts:2257-2267
return {
  content: recalled.content,
  details: {
    productOutcome: recalled.found ? "succeeded" : "failed",
    dispatchState: "not_sent",
    ...
  },
  isError: !recalled.found,
};

// thread-execution-projection.ts:387-409
const notDispatched = dispatchState === "not_sent" || ...;
const unresolved =
  productOutcome === "result_unknown" ||
  (productOutcome === "succeeded" && notDispatched) || ...;
const lifecycle = !ended ? "preparing" : unresolved ? "unresolved" : notDispatched ? "not_dispatched" : null;

// thread-execution-state.ts:200-204
let displayPhase =
  operations.some((operation) => operation.displayPhase === "unresolved") || ... ? "unresolved" : ...;
```
现有测试还明确锁住了这个语义：
```ts
// thread-execution-state.unit.test.ts:769-790
it("still reports a contradictory succeeded-but-not-sent result as unresolved", ...)
```
**建议**：成功取回用 `dispatchState: "accepted"`（和 host read 的 `thread-execution-state.unit.test.ts:744-768` 一致）；not-found 要么省略 `dispatchState`，要么用与失败一致的值。补一条投影测试，覆盖取回成功和 not-found 两种 details。

### 4. 中：上一轮第 2 条没有真正改好：保险箱页面仍无入口、批准推送无人处理、生产没有 `requestRelease` 调用；规格还自相矛盾

**文件:行**：`clients/apple/Sources/HimawariManage/Vault/VaultPages.swift:42`、`apps/agent-service/src/production-apple-push.ts:186-190`、`packages/application/src/services/vault-service.ts:284`、`docs/execution/specs/2026-11-25-secret-vault-design.md:129-131`

**问题**：作者材料说“批准推送”“页面”已做。代码里 `VaultRootView` 只在 Vault 目录内定义，`grep` 没有找到任何外部引用；推送 payload 带了 `vaultRequestId`，但 `clients/apple/Sources` 里没有读取它的代码；`requestRelease` 只有测试调用。规格新增了“还没接上”，但同一段“已做”列表里仍写着“批准推送”，与“现在不会发出批准推送”直接矛盾。

**证据**：
```swift
// VaultPages.swift:42
public struct VaultRootView: View {
```
`grep -n "VaultModel|VaultRoot|VaultFlow|VaultListPage|VaultApprovalPage|VaultPages" clients/apple/Sources` 只命中 Vault 目录自身。

```ts
// production-apple-push.ts:186-190
tag: `vault-${input.requestId}`,
...
vaultRequestId: input.requestId,
```
`grep "vaultRequestId" clients/apple/Sources` 无结果。

```ts
// vault-service.ts:284
async requestRelease(
```
`grep "requestRelease("` 只命中 `test/integration/vault-*.test.ts` 和 `vault-service.ts` 定义。

```md
// 2026-11-25-secret-vault-design.md:129,131
- 已做：...批准推送；...
- 还没接上：...服务器这一步也还没有调用 requestRelease 的地方，所以现在不会发出批准推送。
```
**建议**：要么在本 PR 接上设置页入口、通知跳转和 `requestRelease` 调用，要么把“批准推送”从“已做”移到“还没接上”，并明确这一步端到端不可用。补一个检查或测试证明 `vaultRequestId` 有消费端。

### 5. 中低：手机发来无效 TOTP 时，已解出的项钥匙没有清零

**文件:行**：`packages/application/src/services/vault-service.ts:507-515`、`:533-535`

**问题**：`itemKey` 在第 511 行赋值，`parseTotp` 在第 512 行调用；它外面那层 `try/finally` 只清 `opened`。如果手机在 HPKE 明文里放一个无效的 `totp`（`parseTotp` 会抛 `VaultError`），异常会在 `fields` 的 `try/finally` 之前抛出，`itemKey` 不会被清零。这违反“用完抹掉”，而且这是手机可控的输入路径。

**证据**：
```ts
// vault-service.ts:507-515
let itemKey: Buffer | undefined;
let totp: VaultTotpCode[] = [];
try {
  const parsed = record(JSON.parse(opened.toString("utf8")));
  exactKeys(parsed, ["itemKey"], ["totp"]);
  const key = vaultBase64(parsed["itemKey"], 32, 32) ?? invalid();
  itemKey = Buffer.from(key, "base64");
  if (parsed["totp"] !== undefined) totp = parseTotp(parsed["totp"]);
} finally {
  opened.fill(0);
}

// :533-535（只有走到这里才清 itemKey）
} finally {
  itemKey.fill(0);
}
```
**建议**：把 `itemKey` 的赋值和 `parseTotp` 放进同一个 `try/finally`，无论解析成功与否都清零；补一条无效 `totp` 的失败测试，断言 `itemKey` 缓冲区被清零。

### 6. 低：上一轮第 3 条只改了一半：失败时内存结果和 usage 是 denied/failed，但数据库请求状态仍是 approved

**文件:行**：`packages/application/src/services/vault-service.ts:478-486`、`:548-564`、`packages/persistence-sqlite/src/sqlite-vault-operations.ts:289-291`

**问题**：`approve` 在解密前就把请求标成 `approved`；解密或写使用记录失败后，`catch` 只 `#settle(denied)` 并写 `failed` usage，没有再改 `vault_release_requests.status`。`decideRequest` 的 UPDATE 只匹配 `status='pending'`，所以 approved 的行改不回去。当前没有外部消费者读这个 status（`snapshot` 只列 pending），影响主要是审计和未来消费者。

**证据**：
```ts
// vault-service.ts:478-486
const decided = await this.#options.store.decideRequest({
  ...scope,
  id,
  nonce: stored.nonce,
  status: "approved",
  ...
});

// :548-564
} catch (error) {
  wipeAll();
  this.#settle(id, { kind: "denied" });
  await this.#options.store.recordUsage({ ... outcome: "failed" ... }).catch(() => undefined);
  ...
}

// sqlite-vault-operations.ts:289-291
UPDATE vault_release_requests SET status = ?, decided_at = ?, device_id = ?
WHERE ... AND status = 'pending' ...
```
**建议**：给失败路径加一个 approved→denied/failed 的存储转换，或在请求行记录失败原因；补一条测试断言失败后 `readRequest` 的 status 与 usage 一致。如果决定 status 只表示“批准决定”、usage 才是最终结果，要在规格里写明。

### 7. 低（推测）：`tool_result_recall` 可以无限次取回大结果，没有看到每次调用或每轮的大小上限

**文件:行**：`packages/runtime-pi/src/tool-result-clearing.ts:148-168`

**问题**：`recallToolResult` 直接 `structuredClone(found.content)` 返回原文，没有截断；工具是只读且可反复调用。模型（或被提示注入诱导）可以反复取回同一个大结果，增加 token 和内存开销。我没有找到全局的工具结果大小/次数限制，所以标为推测。

**证据**：
```ts
if (found && !(found.toolName === TOOL_RESULT_RECALL_TOOL_NAME && found.isError))
  return { content: structuredClone(found.content), found: true };
```
**建议**：确认现有工具结果大小限制是否覆盖取回；如果没有，给取回内容或每轮取回次数加界。补一条资源上限测试。

## 侧重检查

- **错误路径**：`approve` 的解密失败和 `recordUsage` 失败两条新测试逻辑上确实覆盖了修复；但过期/换钥匙竞态仍会丢明文（意见 1）。无效 `totp` 会漏清项钥匙（意见 5）。失败后数据库状态仍是 approved（意见 6）。
- **不合规范/不可信输入**：手机传来的 sealed 明文、`totp`、字段密文都经过校验；空字段现在被手机 `seal` 拒绝，服务器最小 29 字节（`vault-service.ts:170`）与非空密文最小 29 字节一致，上一轮第 5 条已改好。`tool_result_recall` 的 `toolCallId` 限 1–256、会 trim、不会执行工具。
- **安全**：字段清零在竞态和无效 TOTP 两条路径仍有缺口（意见 1、5）；出口遮盖会被清理破坏（意见 2）；外部内容标记按 thread 作用域持久化（`context-external-content.ts:161-168`），取回旧外部结果不会绕过“读过外来内容”的判断；取回内容会重新走 `model-egress` 的 `tool_result` 遮盖，但依赖 `known` 集合，仍受意见 2 影响。
- **资源耗尽**：取回可重复复制大结果（意见 7，推测）；清理每次按历史长度做一遍估算，未发现明显无界循环。
- **不可撤销操作**：`tool_result_recall` 只读、不重执行；清理只改发给模型的那份；保险箱批准会解出真实字段，生产端还没有调用 `requestRelease`/交付 secrets 的消费者，所以“调用方负责 wipe”目前没有生产调用方。
- **规则/文档一致**：`prompt-prefix.md` 第 4/14 条与清理代码、ADR 0285 的 10 万/15 万/保留 3 次/至少 5000 一致；ADR 0210 已标 superseded；但保险箱规格“已做…批准推送”与“不会发出批准推送”矛盾（意见 4），设计规格里 `compaction-prefix.ts:75` 的行号也已过时（低，未单列）。

## 上一轮意见核对

- **第 1 条（未完全改好）**：新增两条失败注入用例确实覆盖“解密失败”和“写使用记录失败”，这两条在去掉修复后会失败；但意见 1 的竞态仍会让已解出的字段不抹掉。
- **第 2 条（未改好）**：只改了规格说明，代码里仍无设置页入口、无 `vaultRequestId` 消费、无生产 `requestRelease` 调用（意见 4）。
- **第 3 条（部分改好）**：内存结果和 usage 已改成 denied/failed，但数据库请求状态仍是 approved（意见 6）。
- **第 5 条（已改好）**：`VaultCrypto.seal` 拒绝空字段，手机不再生成 28 字节空密文；服务器下限 29 字节不变，两端一致。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

- 保险箱修复 `82c198a3a` 本身不改系统提示、工具定义、历史或遮盖规则，只改服务器错误路径和 Swift 空字段校验，**不改变请求开头**。
- 本轮合并增量把 `tool_result_recall` 加进工具定义（这个 PR 本身还加了 `vault_list`），老对话的工具定义会换新一次。按 `prompt-prefix.md` 第 6 条这是允许的“工具集合变了就换新”，但不是每轮变化，需要在记录里写明。
- 清理旧工具结果按第 14 条是**已批准的例外**，它不是只在末尾追加，而是会在清理发生的那一次请求里改写较早的工具结果；清理之后才恢复只追加。这一点符合规则预留的例外。
- **但意见 2 是额外的问题**：清理会让后面消息的遮盖结果变化，等于在清理点之外又改了字节，并且可能把本来遮住的秘密露给模型。这不是“每轮变的值都在最后一条消息里”的问题，而是遮盖依赖被清理的前文。
- 每轮会变的值（时间、记忆等）没有被这个改动放进系统提示或工具定义；`vault_list` 的输出按 name/id 排序，是工具结果，不在开头。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**

- **会**。同一工具结果在清理前是原文、清理后是占位；同一段后面的用户/助手文字也可能因为“点名”它的工具结果被清掉，而从不遮变成不遮（意见 2）。占位文本本身是确定的（只含 toolName 和 toolCallId），没有时间字段；vault 列表顺序固定；清理按历史顺序重放，决定是确定的。主要风险是遮盖对前文的依赖被清理改变，而不是清理本身不确定。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

- 保险箱：新增两条失败注入用例（后一个字段解密失败、写使用记录失败），读代码判断去掉修复后都会失败；Swift 新增空字段反向断言。但没有覆盖竞态、项钥匙清零、数据库状态。
- Prompt prefix：新增 `[CLEAR-1]` 到 `[CLEAR-5]`，含“不到 5000 不清”“声明 keep 不清”的反向用例，`check:prompt-prefix` 要求 17 条通过。但没有覆盖“清理 + 出口遮盖”的交互；`[CLEAR-2]` 只查内容不查 details，所以意见 3 抓不到。
- 上一轮第 2 条没有自动检查（页面入口缺失无法由现有测试发现）。
- 我**没有运行测试**；作者说的“Swift 19 个测试通过”“四道 check:vault-* 全过”“合约夹具互相解开”未核实。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**

- `dispatchState: "not_sent"` + `productOutcome: "succeeded"`：消费端 `thread-execution-projection` **不接受**，会当成矛盾并标 unresolved（意见 3）。
- `capabilityRef: "context.tool_result_recall"`：`ToolActionRegistry.forCapability`、`preflight` 能接受；它没有登记到能力清单，但走 `authorization: "read"` 路径，不查能力清单。未发现直接消费端拒绝。
- 三个新 prompt id（占位、取回工具描述、not-found）在 `runtime.ts` 和 `prompt-manifest.json` 里对齐；消费端是 adapter 和 `tool-result-clearing.ts`。manifest 哈希我未计算。
- `contextRetention: "keep"` 只加在 `RuntimeCustomToolDescriptor`。当前生产没有工具设置它；未来给计划、子线程结果、同意卡片加时，要确认它们是 custom 描述符，否则需要扩类型（未来实现，未核实）。
- `COMPACTION_TRIGGER_CAP_TOKENS = 150_000`：`compactionModelOverrides`、测试和文档已同步，消费端一致。
- 保险箱空字段：手机 `seal` 拒绝空值，服务器 `vaultBase64(..., 29, ...)` 接受非空最小 29 字节，两端一致。
- 保险箱失败路径：`listPendingRequests` 只查 pending，当前不会把失败请求显示成 pending；但数据库没有 failed 状态，审计会看到 approved + usage failed（意见 6）。

## 本轮查过的范围

- 增量：`git diff 859601055151b95ace941bf8471fa8233b773da0..2903004a184f22a324e1caad5ad570abf4bd521d`，重点看 `82c198a3a`（保险箱修复）和 `2903004`（main 合并）。
- 保险箱：`vault-service.ts`、`VaultCrypto.swift`、`VaultContractTests.swift`、`vault-approval.test.ts`、`sqlite-vault-operations.ts`、`production-vault-tools.ts`、`service-main.ts` 的 vault 接线、`production-apple-push.ts`、`VaultPages.swift` 的引用搜索、`2026-11-25-secret-vault-design.md`。
- 合并增量：`tool-result-clearing.ts`、`compaction-prefix.ts`、`pi-runtime-adapter.ts`、`prompt-catalog` 的 runtime/manifest、`production-runtime-tools.ts`、`production-tool-actions.ts`、`production-context-recall.ts`、`check-prompt-prefix.mjs`、`prompt-prefix.md`、`kv-cache-guide.md`、`pi-development-guide.md`、ADR 0210/0285、`prompt-prefix.compat.test.ts`、`tool-result-clearing.unit.test.ts`、`production-runtime-tools.unit.test.ts`、`thread-execution-projection.ts`、`thread-execution-state.ts`、`model-egress.ts`、`redaction.ts`。
- 未读/未核实：`.agents/reviews` 的上一轮记录不在工作区；未运行 Swift、vitest、`check:prompt-prefix`；未连真实 APNs；未计算 manifest 哈希；未逐条重读保险箱清单签名/换钥匙/设备注销的旧路径。
