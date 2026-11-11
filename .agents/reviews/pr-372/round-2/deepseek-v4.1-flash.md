## 结论

未发现高严重度问题。读代码确认了 2 条中等、4 条低严重度问题；另有 1 条只能标为推测。没有运行测试（本环境只能用 read/grep/glob 和 git），所以作者“测试通过”的结论未独立核实。

## 读代码证实的问题

### 中 1. 外部读取的遮盖结果依赖整次返回和出现顺序，同一段文字可能在不同请求里遮成不同字节

- 文件：`packages/sensitive-capture/src/redaction.ts:552-567`、`apps/agent-service/src/production-mcp-read.ts:92-101`
- 证据：

```ts
// redaction.ts
const tags = new Map<string, string>();
...
const created = sequenceTag(tags.size);
...
for (const input of inputs) redactForEgress(input, options);
return inputs.map((input) => redactForEgress(input, options).text);
```

```ts
// production-mcp-read.ts
const texts: string[] = [];
mapStrings(value, (text) => { texts.push(text); return text; });
const masked = maskSensitiveTexts(texts);
return mapStrings(value, () => masked[next++] ?? "");
```

- 问题：占位符后缀按“整次返回里第几个不同的敏感值”编号；`known` 又在第一遍扫过全部文字时累积，因此后面文字里点名的密码也会影响前面文字。同一段记忆如果这次排在另一个敏感值后面，占位符就会从 `#aaaaaaaa` 变成 `#aaaaaaab`。这正是问题 2 说的“依赖前后文的遮盖”。如果把它当作消息遮盖来用，也违反 `prompt-prefix.md:52` 的“只能取决于它自己和它前面的内容，不能取决于它后面的内容”。
- 当前影响范围有限：它只用于对外 MCP 返回，不进入 Himawari 自己的模型请求，所以不影响 KV 缓存前缀。但 `maskSensitiveTexts` 已从 `sensitive-capture` 导出，以后若被模型出口复用，会直接破坏前缀稳定。
- 建议：tag 改为由 `(kind, identity)` 稳定派生（例如取 sha256 的前 8 个字母），或者在敏感包里明确区分“外部读取用”并禁止模型出口调用；同时补一条“同一组文字换顺序后每段输出不变”的测试。

### 中 2. 新增提示词会自动进入 `TRUSTED_PROMPT_TEXTS`，作者“发给模型的请求一个字节都不变”的绝对说法不成立

- 文件：`packages/prompt-catalog/src/trusted.ts:10-14`、`apps/agent-service/src/production-memory-capture.ts:837`、`packages/prompt-catalog/src/tools.ts:224-258`
- 证据：

```ts
// trusted.ts
export const TRUSTED_PROMPT_TEXTS: readonly string[] = trustedPromptTexts(
  [background, chat, mail, memory, review, runtime, tools].flatMap((module) =>
    Object.values(module),
  ),
);
```

```ts
// production-memory-capture.ts
trusted: TRUSTED_PROMPT_TEXTS,
```

```ts
// tools.ts 新增
export const MCP_TOOL_FIND_MEMORIES = fixedPrompt({ ... });
export const MCP_TOOL_TODAY_CONTEXT = fixedPrompt({ ... });
export const MCP_TOOL_RULE_BOOK = fixedPrompt({ ... });
export const MCP_TOOL_RESULT_FAILED = fixedPrompt({ ... });
```

- 问题：`trustedPromptTexts` 会收下所有长度不少于 24 个字符的固定文字，因此这四条外部 MCP 文案会自动进入 Himawari 自己出口遮盖的“可信文字”白名单。正常路径下，因为旧提示词哈希没有变、聊天模板也没引用这些新文案，所以模型请求字节不变；但严格说，如果已有历史或记忆恰好包含这四条新句子，它们的遮盖结果会改变，作者“一个字节都不变”的承诺就不能无条件成立。`prompt-prefix.md:53` 正好提醒了改提示词文字要留意这一点。
- 建议：把这四条外部 MCP 文案放到不参与 `TRUSTED_PROMPT_TEXTS` 的独立模块，或在 `trustedPromptTexts` 里排除外部 MCP 条目；再加一条测试冻结“原有 prompt 的 trusted 集合和 manifest 哈希不变”。

### 低 1. 失败时费用可能少记，和“失败也记已花费用”的说法存在竞态

- 文件：`apps/agent-service/src/production-memory-recall.ts:191-214`、`apps/agent-service/src/production-mcp-read.ts:270-277`
- 证据：

```ts
const [hits, tentativeHits] = await Promise.all([
  within("memory-recall", () => ...),
  tentativeLimit === 0
    ? Promise.resolve([])
    : within("memory-recall-tentative", () => ...).catch(() => []),
]);
```

```ts
} finally {
  cost.costMicros = context.costMicros;
}
```

- 问题：如果确认搜索先失败，`Promise.all` 会立即 reject，但未完成的 tentative 搜索仍可能继续执行 `embedOutsideRun` 并累加 `context.costMicros`；`finally` 此时已经复制完费用，失败记录就会少记这笔钱。作者说“失败也记已花费用”，在这个竞态下只是近似成立。
- 建议：用 `Promise.allSettled` 或显式等待两个搜索都结束后再快照 `costMicros`，或者让费用累加器与失败记录共享同一个引用，在记录前再读一次最终值。

### 低 2. `MCP_READ_RUNTIME_UNAVAILABLE` 没有自动测试，而且检查在 `webEnabled` 条件内

- 文件：`apps/agent-service/src/service-main.ts:667-669`、`:1225`、`:2117-2118`
- 证据：

```ts
const webEnabled =
  configuration.publicMode ||
  (configuration.identity?.kind === "built-in" && Boolean(configuration.http));
...
if (webEnabled) {
...
if (configuration.runPolicy?.mcpRead !== undefined && !mcpRead)
  throw new Error("MCP_READ_RUNTIME_UNAVAILABLE");
```

- 问题：ADR 0219 第 57 行说“配置了却建不起这个入口时，服务启动失败”。读代码看，这个检查只在 `webEnabled` 为真时执行；如果 `webEnabled` 为假，配置了 `mcpRead` 也不会走到这里。正常的 Web 生产路径会先被前面的内存依赖检查拦住，所以不是实际高危，但作者承诺的绝对条件与代码路径不完全一致，而且仓库里搜不到这个错误码的测试。
- 建议：把检查移到 `if (webEnabled)` 之外，或在 ADR 里写明只适用于 Web 模式；补一条启动失败用例。

### 低 3. 主集成测试只把路由挂在裸 Fastify 上，没有走真实组装的正向路径

- 文件：`test/integration/mcp-read.test.ts:193-196`、`apps/agent-service/test/production-http-composition.unit.test.ts:312-322`
- 证据：

```ts
const app = Fastify({ logger: false });
registerMcpReadRoute(app, mcp);
closers.push(() => app.close());
await app.listen({ host: "127.0.0.1", port: 0 });
```

```ts
const mcpRead = await composition.app.inject({ ... });
expect(mcpRead.statusCode).toBe(404);
```

- 问题：真实组装里只验证了“没配置时 404”；没有验证“配置了 `mcpRead` 时通过 `createProductionHttpComposition` 能正常列出/调用工具”。全局 onRequest、body 解析、路由顺序、真实认证组合都不在覆盖内。
- 建议：在 `production-http-composition` 测试里加一条带 `mcpRead` 的正向用例，或让 `mcp-read.test.ts` 通过真实组装启动。

### 低 4. 部分失败路径和遮盖函数本身缺少直接测试

- 文件：`test/integration/mcp-read.test.ts:335-355`、`packages/sensitive-capture/src/redaction.ts:552-567`
- 证据：现有失败用例只覆盖 `find_memories` 的检索失败和“决策记录写不进去”；`today_context`、`rule_book` 的失败记录，以及 `maskSensitiveTexts` 直接单测都不存在（全仓 grep 只有 `maskForExternalRead` 的间接测试）。作者提交说明里提到的 `redaction.unit.test.ts` 在这两个提交里没有新增行。
- 建议：补 `today_context` / `rule_book` 的失败记录用例，以及 `maskSensitiveTexts` 的“返回长度、顺序、同一值跨段、无敏感值时原样返回”单测。

## 推测 / 未核实

- **GET 的 SSE 响应可能被整体缓冲。** `production-mcp-read.ts:356` 允许 GET/DELETE，`sendWebResponse` 在 `:339` 用 `await response.arrayBuffer()`。如果 `@modelcontextprotocol/server` 对 GET 返回长连接 SSE，这里会一直等到流结束，占用连接。当前 checkout 没有 `node_modules`，无法读 SDK 源码确认；标为未核实。建议核对 SDK 行为，若 GET 可能返回流，使用 `reply.raw` 转发并加超时，或直接只允许 POST。
- **`webRequest` 重新序列化 JSON 但保留原始 `content-length`。** `production-mcp-read.ts:320-331` 用 `JSON.stringify(request.body)`，headers 里仍带原始 `content-length`。对 SDK 客户端的紧凑 JSON 通常一致；第三方客户端发非规范 JSON 时长度可能不同。SDK 是否依赖该头未核实。

## 侧重检查

- **鉴权**：`BearerGate.admit` 的 `timingSafeEqual`、32 字符下限、401/429 映射都正确；未认证请求在 `onRequest` 直接返回，不进入 handler，也不写决策记录。已核对 `production-mcp-read.ts:359-367`、`bearer-admission.ts:17-36`。
- **不可信输入**：`find_memories` 的 schema 和 `argumentsOf` 都限制 query 长度、limit 1–10、日期格式；非法日期会在 `startOfDay` 抛错，最终变成工具错误和失败记录。bodyLimit 64 KiB。未发现注入 SQL 的路径，`memoryIds` 来自系统记录。
- **错误路径**：读取失败写 `<工具>_failed`；决策记录写不进去时扣下内容只回工具错误；这两条代码正确，集成测试也覆盖了主要两条。费用竞态见低 1。
- **资源耗尽**：限流 30 次/分钟有效请求、60 次/分钟无效请求；`find_memories` 最多 10 条，提醒最多 `LISTED` 条；嵌入有截止时间和请求 abort。没有整体工具调用超时，也没有每日嵌入费用上限，ADR 已声明。SSE 缓冲风险未核实。
- **不可撤销操作**：三个工具都是只读，`readOnlyHint: true`；只写决策记录，不写记忆、不取消提醒。未发现不可逆副作用。
- **敏感数据**：`maskForExternalRead` 会遍历所有字符串值再统一遮盖；输出对象的键都是固定字段，未见动态键泄漏。已知边界：按 `prompt-prefix.md:54`，点名值只有“前后不紧挨字母、数字、汉字或下划线”时才替换，中文直接相邻的值可能漏遮；这是现有规则本身的取舍，不是本次新增。
- **规则/文档一致性**：新提示词都有 manifest 行和 `usedBy`；旧提示词哈希未变（只能从 diff 看出是纯新增，无法重算 SHA-256）；ADR 与代码在路由方法、`inputs.memoryIds` 含义、遮盖做法上基本一致；唯一明显不一致是启动失败条件的 `webEnabled` 范围。
- **依赖与打包**：`@modelcontextprotocol/server` 从 platform-node 的 devDependency 提升为 agent-service 的生产依赖，package-lock 中 `dev: true` 已去掉；运行时打包脚本从 workspace manifests 派生外部依赖，理论上会带上它。构建未在本环境运行。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - **Himawari 自己的模型请求：正常路径不会。** 新提示词只用于 `production-mcp-read.ts` 的 MCP 工具描述；聊天用的 `ProductionMemoryRecall` 重构后输出字段和顺序不变（`production-memory-recall.ts:132-147` 只是把 `invocation` 里的参数拆出来）；提醒工具输出仍然只映射 `reminderId/text/due/repeat`，没有把新增的 `memoryId` 发给模型。manifest 只新增条目，旧条目哈希未改。
   - **需要保留的例外：** 新提示词进入 `TRUSTED_PROMPT_TEXTS`（中 2），严格说已有历史若包含这四条新句子，遮盖字节可能变；正常内容不会。
   - **外部 MCP 不是 Himawari 的模型请求**，它是单独通道；每轮变化的 `now`、提醒、记忆都只在工具返回里，不写进 Himawari 的系统提示或工具定义。因此对 Himawari 自己而言仍是“只在末尾追加”。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   - **Himawari 自己的请求：没有新增变化。** 出口遮盖规则没改，遮法仍由文本和已有 known 值决定。
   - **外部 MCP 返回：会。** 有敏感值时，占位符后缀按整次返回的首次出现顺序编号，且两遍扫描会让前面的文字受后面文字影响；同一段记忆随返回集合或顺序不同可能得到不同字节。`today_context` 的 `now` 也是每次不同的值，但这是外部工具结果，不是 Himawari 的请求前缀。见中 1。

3. **有没有对应的自动检查，反向用例是否真会失败？**
   - **有测试，但覆盖不完整。** 现有测试包括：新旧协议工具列表、find/today/rule 正向、401、无关问题、48 小时窗口、密码遮盖、读取失败记 `<tool>_failed`、记录写不进去时扣下内容、配置正反例、遮盖顺序单测、真实组装 404。
   - **从代码看反向用例会失败：** 逐段遮盖的旧写法会让“先出现、后被点名”的密码漏遮；旧的 `#call` 在决策记录写入失败时仍返回内容；旧代码失败时 `costMicros` 为 0；去掉 `parseMcpRead` 后配置正例会被 unknown key 拒绝；无条件注册路由时 404 用例会失败。
   - **不足：** 上述关键测试大多不在 `npm run check` 的专门门槛里；`MCP_READ_RUNTIME_UNAVAILABLE`、`today_context`/`rule_book` 失败、`maskSensitiveTexts` 直接单测、真实组装正向路径都缺。本环境无法运行测试，作者“通过”未核实。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `external_read` / `read`：`DECISION_OUTCOMES`、迁移 0069 和 0087 的 CHECK 都接受；`insertLedgerRow` 验证通过。
   - `reasonCode`：工具名和 `<工具>_failed` 都小于 64；`subjectRef` 是 `mcp-client:` 加最多 64 字符客户端名，小于 256；`id` 是 `ledger:` 加 UUID，小于 128。
   - `inputs.memoryIds`：是字符串数组，经过 `idList` 的 1–256 字符、去重和数量上限校验；插入时只落 `memoryIds/ruleIds/batchId/resultMemoryIds` 四个键，符合决策记录写入约定。
   - `costMicros` / `durationMs`：来自整数嵌入费用和时钟差值，非负，`durationMs` 上限 86400000。
   - `mcp-read` 配置：`parseRunPolicy` 接受 `mcpRead`，`assertIdentitySecretReference` 要求恰好一条 ref 匹配且 purpose 为 `mcp-read`；service-main 用同一 purpose 查找密钥。
   - 新提示词 ID：manifest 有对应行，`usedBy` 指向存在的 `production-mcp-read.ts`。
   - `ListedReminder.memoryId`：只有 `ProductionReminderWriter.list` 构造这个类型，已赋值；模型可见的提醒工具输出没有使用它。
   - `RecallResult.memoryIds`：`production-runtime-tools` 只解构 `output` 和 `contentClassification`，新增字段不影响聊天。
   - **唯一不一致：** `MCP_READ_RUNTIME_UNAVAILABLE` 在 `webEnabled` 为假时不会执行（低 2）；其余值两端校验一致。
