## 复核结论

先说明：本次只读了代码和 diff，未运行测试；下面标「未核实」的部分不能当作已通过。

## 已读代码证实

### 1. 中（安全）：外部读取的遮盖不等同于模型出口，同一秘密重复出现时可能原样发给外部 agent

- 文件：`apps/agent-service/src/production-mcp-read.ts:76-87`
- 问题：`maskDeep` 对每个字符串单独调用 `maskSensitiveText`。
- 证据：

```ts
// production-mcp-read.ts:76-77
function maskDeep(value: unknown): unknown {
  if (typeof value === "string") return maskSensitiveText(value);
```

```ts
// sensitive-capture/src/redaction.ts:542-543
export function maskSensitiveText(input: string): string {
  return redactForEgress(input).text;
}
```

`redactForEgress` 只有在调用方传入 `known` 时，才会记住已认出的密码/验证码并遮掉后续重复出现：

```ts
// redaction.ts:322-326
if (
  rememberValue &&
  known !== undefined &&
  ...
) known.set(original, placeholder);
```

```ts
// redaction.ts:411-425
if (known !== undefined && known.size > 0) {
  for (const [value, placeholder] of known) { ... }
}
```

而 Himawari 真正发给模型的出口明确传了 `known`、`trusted`、`ruleset`，并在遮完后再自检一次机器密钥：

```ts
// packages/application/src/services/model-egress.ts:221-225
const result = redactedOrRefused(value, {
  tag: placeholderTag(this.#options, key),
  known: this.#known,
  table: this.table,
  trusted: this.#options.trusted ?? TRUSTED_PROMPT_TEXTS,
  ...
```

```ts
// model-egress.ts:233-239
try {
  assertMachineSecretFree(result.text);
} catch {
  ... withheld ...
```

所以 ADR 0219 第 69 行“遮的范围和 Himawari 自己发给模型的出口一样”的说法不成立：外部读取没有跨字段的 `known` 记忆，也没有遮完后的机器密钥自检。例如记忆正文里先出现“密码：Sunflower-8841”，后面又单独出现 `Sunflower-8841`，第一次会被遮，后一次在 `maskSensitiveText` 下不会被遮；在模型出口里会因 `known` 被遮。现有测试只断言一段提醒里的完整密码不出现，见 `test/integration/mcp-read.test.ts:284` 一带，没有覆盖重复出现。
- 建议：为外部读取复用一条真正的“外部出口”路径：整次响应共享一个 `known` Map，使用当前 `ruleset`，并在发送前做 `assertMachineSecretFree` 一类的自检；如果故意采用更弱的遮盖，必须在 ADR 里改掉“和模型出口一样”的表述并说明风险。

### 2. 中：失败的外部读取把已经发生的嵌入费用记成 0

- 文件：`apps/agent-service/src/production-mcp-read.ts:241-252`、`:223-238`
- 问题：`find_memories` 在局部 `context` 上累计 `costMicros`，但只有成功返回 `ToolOutcome` 时才把费用交给记录逻辑；抛错时 `outcome` 是 `undefined`，决策记录写 `costMicros: 0`。
- 证据：

```ts
// production-mcp-read.ts:242-252
const context: MailEmbeddingContext = {
  ...
  costMicros: 0,
};
const result = await this.#options.sources.recall(...);
return { output: result.output, memoryIds: result.memoryIds, costMicros: context.costMicros };
```

```ts
// production-mcp-read.ts:235
costMicros: outcome?.costMicros ?? 0,
```

例如命中搜索的嵌入已经成功、随后 `readMany`/`readText` 失败，实际已经花了嵌入费，但记录仍是 0。ADR 第 76 行说“costMicros 写这次算问题向量花的钱”，失败路径不成立。失败用例 `test/integration/mcp-read.test.ts:328-337` 只检查了 `reasonCode`，没检查费用。
- 建议：把费用累计对象提升到 `#call` 能读到的位置，失败时也把实际累计值传入 `#record`。

### 3. 低（审计语义）：遮盖子或序列化抛错时，响应是失败，决策记录却写成成功

- 文件：`apps/agent-service/src/production-mcp-read.ts:202-213`、`:230`
- 问题：`outcome` 在 `maskDeep`/`JSON.stringify` 之前就赋值；后者抛错会进入 `catch` 返回工具错误，但 `finally` 仍看到 `outcome` 非空，于是 `reasonCode` 写成成功的工具名，并带上 `memoryIds` 和费用。
- 证据：

```ts
// production-mcp-read.ts:203-212
try {
  outcome = await run(args, signal);
  return {
    content: [{ type: "text", text: JSON.stringify(maskDeep(outcome.output)) }],
  };
} catch (error) {
  this.#options.onFailure(error);
  return { content: [{ type: "text", text: MCP_TOOL_RESULT_FAILED.text }], isError: true };
} finally {
  await this.#record(name, client, outcome, started);
}
```

```ts
// production-mcp-read.ts:230
reasonCode: outcome ? name : `${name}_failed`,
```

遮盖实现存在 `EgressRedactionError` 抛错路径，见 `packages/sensitive-capture/src/redaction.ts:274`。
- 建议：用单独的 `succeeded` 标志，在成功构造完响应后才置真；失败路径统一记 `<tool>_failed`。

### 4. 低：决策记录写失败被吞掉，外部读取仍正常返回

- 文件：`apps/agent-service/src/production-mcp-read.ts:223-238`
- 问题：`ledger.append(...).catch(this.#options.onFailure)` 只记诊断，不改变响应。数据库写失败时，这次外部读取就发生了但没有任何 `external_read` 记录，和 ADR 第 71 行“每次外部读取都写一条决策记录”不一致。
- 证据：

```ts
await this.#options.ledger
  .append({ ... })
  .catch(this.#options.onFailure);
```

- 建议：明确这是可接受降级还是必须失败关闭。若是审计要求，记录失败应让本次工具调用失败或至少返回可识别的降级状态。

### 5. 低：反向用例“没配密钥时路由不存在”没有测到该行为

- 文件：`test/integration/mcp-read.test.ts:339-350`
- 问题：该用例新建一个 Fastify 实例，既没有调用 `registerMcpReadRoute`，也没有走 `createProductionHttpComposition`，所以它永远返回 404；即使未来有人在没有配置时无条件注册路由，这个用例也不会失败。
- 证据：

```ts
it("does not register the route without a configured secret", async () => {
  const app = Fastify({ logger: false });
  closers.push(() => app.close());
  await app.ready();
  const response = await app.inject({ ... url: MCP_READ_PATH ... });
  expect(response.statusCode).toBe(404);
});
```

- 建议：用真实的 `createProductionHttpComposition`（不传 `mcpRead`）或至少按配置条件调用 `registerMcpReadRoute`，再断言 404；同时补 `parseMcpRead` 的正反用例（未知键、缺失 secretRef、purpose 不是 `mcp-read`）。目前 `packages/platform-node/test/startup-configuration.unit.test.ts:1439-1462` 只有 `museIntake` 的同类用例，没有 `mcpRead`。

### 6. 低（文档与代码不一致）

- `docs/adr/0219-read-only-mcp-entry-with-static-token.md:61` 写“路径是 `POST /api/mcp/v1`”，但路由实际注册了 GET、POST、DELETE：

```ts
// apps/agent-service/src/production-mcp-read.ts:333-337
scope.route({
  method: ["GET", "POST", "DELETE"],
  url: MCP_READ_PATH,
  ...
```

- `docs/adr/0219-read-only-mcp-entry-with-static-token.md:74` 写 `inputs.memoryIds` 是“返回给对方的记忆编号”，但 `find_memories` 的实际输出没有记忆编号（`production-memory-recall.ts:247-255` 返回的只有 `text`、`current`、`recordedAt` 等）。记录编号本身符合写入约定，但 ADR 这句话不准确。
- ADR 第 69 行“和模型出口一样”的问题见第 1 条。

## 推测 / 未核实

- **推测**：`mcpRead` 的初始化在 `if (memoryComposition) { ... }` 内部（`service-main.ts:1153` 起，`memoryRecall` 在 `:1242`，`mcpRead` 在 `:1730`）。如果配置了 `mcpRead` 但记忆组合不可用，代码可能直接跳过整块，路由静默不注册，而不会抛 `MCP_READ_RUNTIME_UNAVAILABLE`。需要确认该配置分支是否允许记忆关闭。
- **推测**：`validateLedgerWrite` 要求 `memoryIds` 内无重复（`sqlite-decision-ledger-operations.ts:40-47`）。`find_memories` 的 `shownIds` 来自检索命中列表；如果 provider 对同一 `productMemoryId` 返回重复命中，`append` 会被判非法，记录被吞（同第 4 条）。正常 provider 实现应会去重，未核实。
- **未核实**：官方 SDK `createMcpHandler` / `context.mcpReq.envelope` / `CLIENT_INFO_META_KEY` 的具体行为、2026-07-28 与 2025 版兼容性；四个新提示词在 `prompt-manifest.json` 里的 sha256 是否与实际文字一致；作者声称的 `npm run check` 48 步和 `npm run build` 是否真的通过。我没有运行这些命令。

## 侧重检查

- **鉴权**：`BearerGate` 用 SHA-256 恒时比较，密钥最少 32 字符，有效请求 30/分钟、无效请求 60/分钟（`bearer-admission.ts:17-35`）。未发现绕过；未授权在 `onRequest` 直接返回 401/429，不进入 MCP，也不写决策记录，和测试一致。
- **不可信输入**：`find_memories` 有 JSON Schema 限制，`ProductionMemoryRecall.argumentsOf` 再次校验查询、日期、`limit`、未知键（`production-memory-recall.ts:90-117`）；请求体上限 64 KiB。未发现注入路径。工具级 schema 校验失败在 SDK 进入回调之前发生，可能不会写 `external_read` 记录，属边界行为。
- **敏感信息保护**：核心问题是第 1 条，外部读取没有复用模型出口的 `known`/`ruleset`/`assertMachineSecretFree`。没有发现新的敏感识别正则绕过 `sensitive-capture` 包。
- **资源耗尽**：限流存在，但 `find_memories` 一次可触发两次嵌入检索并返回最多 10 段完整记忆正文；没有每日费用上限，响应整体 `arrayBuffer()` 缓冲。ADR 已承认“没有单独每日上限”，属已知取舍，不是代码缺陷。多进程部署下限流是每进程独立。
- **不可撤销操作**：只有追加决策记录，没有写工具或删除操作；`randomUUID` 保证记录 id 不覆盖已有行。
- **规则/文档一致性**：发现第 6 条的 POST 与实际方法不一致、遮盖等价性表述不成立；没有发现新配置键漏过 `strict-configuration` 校验。缺少 `mcpRead` 的启动配置测试和运维启用说明（例如对应 `muse-intake-runbook.md` 的 MCP 版本）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动没有触碰 Himawari 内部请求的组装顺序；`production-memory-recall.ts` 只是把 `embedWithin` 的调用方式抽成 `within` 参数，`recallWithClassification` 仍传 `invocation.dataClassification`，原有 `recall` 路径的输出和字节不变。`createProductionRunMemory` 只是新增 `embedForExternalRead` 别名。新 MCP 路由是入站 HTTP，返回值发给外部 agent，不进入 Himawari 的系统提示、工具定义或历史；每轮变化的 `now`、`today` 只出现在外部 MCP 工具结果里，不在 Himawari 的请求开头。新增的四个提示词只进入 `prompt-catalog` 和可信文本集合，不被插入内部请求。**依据成立：发给模型的内容仍然只追加、每轮变化的值不在内部请求头里。**

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   - Himawari 内部：不会，本次没有修改内部请求的序列化。
   - 外部 MCP：`today_context` 的 `now` 和 `today` 每次按设计不同；规则顺序由 `ruleBookFor` 固定，提醒按 `ORDER BY due_at, id` 固定（`sqlite-memory-reminder-operations.ts:143-144`）。遮盖对同一字符串是确定的，不依赖时间或密钥。**但**因为缺少跨字段 `known`，同一次响应里后出现的秘密可能不被遮，这是安全差异，不是“同文字不同字节”的随机性。`find_memories` 的结果顺序依赖 provider 返回顺序，未显式排序；如果 provider 有并列分数，跨请求顺序可能变，这点未核实。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有 10 个集成用例，覆盖新旧两版协议、三工具、401、空结果、48 小时窗口、密码遮盖、失败记录和路由不存在。但：
   - “没配密钥时路由不存在”的用例是空转（见第 5 条），不会因错误注册而失败。
   - 没有 `runPolicy.mcpRead` 配置解析的正反用例。
   - 没有覆盖“秘密重复出现”“失败路径的费用”“遮盖抛错”“ledger 写失败”的用例。
   - `npm run check` 走的是 `check:steps`（`scripts/run-all-checks.mjs:32`），不包含 `test/integration/mcp-read.test.ts`；作者是另外单独跑的，未核实实际结果。

4. **每个新值两端都能接受吗？**
   - `runPolicy.mcpRead.secretRef`：`parseMcpRead` 接受，`assertIdentitySecretReference` 要求 ref 唯一且 purpose 为 `mcp-read`（`strict-configuration.ts:1081-1085`、`:1430-1435`）；`service-main.ts:1723-1728` 用同样的 ref+purpose 查找，匹配。**通过。**
   - 决策记录 `id`、`reasonCode`、`subjectRef`、`durationMs`：`validateLedgerWrite` 要求 id ≤128、reasonCode ≤64、subjectRef ≤256、duration ≤1 天（`sqlite-decision-ledger-operations.ts:57-76`）；实际值都远低于上限。**通过。**
   - `inputs.memoryIds`：`idList` 要求 ≤200、每项 1-256、无重复。提醒的 `memoryId` 由 `reminder:<memoryId>` 一对一产生，正常不会重复；`find_memories` 的 `shownIds` 最多 10 条且通常唯一。**正常通过**；重复命中的极端情况见“推测”。
   - `ruleIds: []`：通过 `idList`。**通过。**
   - `ListedReminder.memoryId`：新增字段，内部 `ProductionReminderTools` 只读取 `reminderId/text/due/repeat`，不受影响；MCP 用它写 ledger。**通过。**
   - `RecallResult.memoryIds`：运行时工具只解构 `output`、`contentClassification`，额外字段不影响；测试已同步补空数组。**通过。**
   - 提示词 id：`mcp.find-memories` 等四个 id 已登记 manifest；sha256 未核实。
   - 路由方法：文档说 POST，代码额外接受 GET/DELETE，属于文档不一致，不是后端校验拒绝。

**总体判断**：核心读路径和鉴权实现没有发现会让 Himawari 自身提示词前缀变化的改动；主要问题集中在外部返回的遮盖强度与 ADR 声明不一致、失败路径的费用/记录记账，以及反向测试和配置测试不足。
