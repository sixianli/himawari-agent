### 1. 高：敏感记忆和对话摘要并没有被隐藏，与作者“不显示敏感”的说法相反

文件:行：`apps/agent-service/src/production-search.ts:168`、`:237`、`:262`、`:274`；`packages/application/src/services/daily-review.ts:172-174`；`packages/application/src/services/model-visibility.ts:10-14`

问题：搜索用 `reviewMemoryVisible` 判断可见性，但它只是 `isModelVisible` 的别名，而 `isModelVisible` 明确把 `sensitive` 列为可见。因此 `dataClassification === "sensitive"` 的记忆和对话摘要都能成为答案或来源；建议问题同样不过滤 sensitive。

证据（读代码证实）：

```ts
// daily-review.ts:172-174
export function reviewMemoryVisible(classification: string): boolean {
  return isModelVisible(classification);
}
// model-visibility.ts:10-14
const MODEL_VISIBLE: readonly DataClassification[] = Object.freeze([
  "public",
  "private",
  "sensitive",
]);
```

```ts
// production-search.ts:237
!reviewMemoryVisible(memory.dataClassification)
// production-search.ts:262
allowedClassifications: modelVisibleClassifications(),
// production-search.ts:274
!reviewMemoryVisible(episode.dataClassification)
```

只要查询只命中一条 sensitive 记忆（例如测试里的“青霉素”），它就会直接作为 `answer` 原文返回；如果同一查询也命中 private 记忆，则只是被排序盖住，见第 3 条。

建议：为搜索单独定义可见分类（例如只允许 `public`/`private`，或 `classificationRank(classification) <= classificationRank("private")`），并用同一个集合传给 `episodes.search` 的 `allowedClassifications`；增加“只有 sensitive 命中时必须 not_found”的反向用例。

### 2. 中：过期和被取代记忆的过滤在“答案”和“建议”两条路径上不一致

文件:行：`apps/agent-service/src/production-search.ts:163-169`、`:230-238`；参考正确写法 `packages/application/src/services/owner-profile-service.ts:114-119`；被取代时的写入 `packages/application/src/services/durable-memory-service.ts:557-568`

问题：建议路径检查了 `tentative` 和 `supersededBy`，却没检查 `validTo`；答案路径检查了 `tentative` 和 `validTo`，却没检查 `supersededBy`。结果是过期记忆的实体仍可出现在建议问题里，而被取代记忆只有在 `validTo` 恰好被写成过去时间时才被答案路径排除。

证据（读代码证实）：

```ts
// production-search.ts:163-169（建议路径）
!attributes ||
attributes.tentative === true ||
attributes.supersededBy !== null ||
!SUGGESTION_CATEGORIES.has(attributes.category) ||
!reviewMemoryVisible(record.dataClassification)
```

```ts
// production-search.ts:230-238（答案路径）
const validTo = memory?.attributes?.validTo ?? null;
if (
  !memory ||
  memory.status !== "active" ||
  memory.providerRecordId !== hit.providerRecordId ||
  memory.attributes?.tentative === true ||
  (validTo !== null && validTo <= now) ||
  !reviewMemoryVisible(memory.dataClassification)
)
```

```ts
// owner-profile-service.ts:114-119（仓库已有的完整有效性判断）
function currentlyValid(memory: ProductMemoryRecord, now: string): boolean {
  const attributes = memory.attributes;
  if (!attributes) return false;
  if (attributes.supersededBy !== null || attributes.tentative === true) return false;
  return attributes.validTo === null || attributes.validTo > now;
}
```

推测：`durable-memory-service.ts:557-568` 在写 `supersededBy` 时通常同时把 `validTo` 设成过去时间，所以答案路径的 superseded 泄漏不一定每次出现；但这不是协议保证，而建议路径的过期泄漏是确定的。

建议：抽出或复用 `currentlyValid` 这类共享判断，答案和建议都同时检查 `status`、`supersededBy`、`tentative`、`validTo`；补“过期记忆不出现在建议”和“被取代记忆不出现在答案”的用例。

### 3. 中：现有“隐藏敏感记忆”反向用例是假绿，测不出第 1 条问题

文件:行：`apps/agent-service/test/production-search.unit.test.ts:46-56`、`:158-164`

问题：该用例把 `secret` 记为 `sensitive`，但同一查询也命中 private 的 `allergy`；`allergy` 在 provider 返回顺序中更靠前，且默认 `basisLimit = 1`，所以即使完全删掉 sensitive 过滤，断言仍然通过。

证据（读代码证实）：

```ts
// 46-56
record("allergy", { sourceThreadId: "thread-1" as never }, { entities: ["花生", "过敏"] }),
record(
  "secret",
  { dataClassification: "sensitive" },
  { entities: ["青霉素"], category: "health" },
),
```

```ts
// 158-164
it("never answers from a hidden, expired or tentative memory", async () => {
  const result = await payload(control(), "我对什么过敏");
  const shown = JSON.stringify(result);
  expect(shown).not.toContain("青霉素");
  expect(shown).not.toContain("花粉");
  expect(shown).not.toContain("虾");
});
```

建议：让 provider 只返回 `secret`，或改用只有 `secret` 能命中的查询，并断言 `state === "not_found"`；同时单独断言建议问题不包含 sensitive 记忆的实体。

### 4. 低：发送的 `answer`/`asks` 可能与网关契约的长度和控制字符规则不一致

文件:行：`apps/agent-service/src/production-search.ts:116-118`、`:129-131`、`:306`；`packages/gateway-contracts/src/validation.ts:91-104`；`packages/gateway-contracts/src/contracts-v2.ts:800`、`:811`

问题：契约的 `boundedString` 用 UTF-16 `input.length` 限长并拒绝 C0/DEL 控制字符；`clip` 却按 Unicode 码点计数，`singleLine` 只压缩空白，不删除 NUL/ESC 等控制字符。含大量 emoji 的记忆原文可能超过 UTF-16 2000 的上限；记忆正文或实体里带控制字符时，`answer`/`asks` 会违反契约。当前设备路由直接 `sendJson`，没有在服务端重新校验出站快照（`packages/platform-node/src/device-api-routes.ts:690-707`），所以不会当场 500；严格校验的客户端可能解析失败（推测）。

证据（读代码证实）：

```ts
// production-search.ts:116-118
function singleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}
// production-search.ts:129-131
function clip(text: string, limit: number): string {
  const characters = [...text];
  return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join("")}…`;
}
// validation.ts:91-104
typeof input !== "string" ||
input.length === 0 ||
input.length > maximum ||
[...input].some((character) => {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
})
```

建议：让截断与 `boundedString` 使用同一计数单位（UTF-16），在 `singleLine` 中去掉控制字符，或在返回前用 `gatewayV2MessageSchema.parse` 校验快照；为 emoji 和控制字符补边界测试。

### 5. 低：`askLimit = 0` 时仍全量扫描所有活动记忆和实体

文件:行：`apps/agent-service/src/production-search.ts:159-190`

问题：默认 `askLimit` 是 0，但每次空查询仍调用无上限的 `state.listActive`，遍历所有活动记忆的全部实体并建立 `counted` Map，最后才 `slice(0, 0)`。记忆很多时会做完全无用的 CPU/内存工作。

证据（读代码证实）：

```ts
const active = await this.#options.state.listActive(ownerId, agentId);
const counted = new Map<string, { uses: number; updatedAt: string }>();
for (const record of active) {
  ...
  for (const entity of attributes.entities) {
```

建议：在 `askLimit === 0` 时直接返回空 `asks`，或在扫描时提前按上限裁剪；给 `listActive` 增加可控上限。

**侧重检查**

- 不可信输入/错误路径：`search.ask.read` 的 `query` 是 `nullable(boundedString(500))`，`locale` 是 `HOME_LOCALES` 枚举，设备网关在转发前用 `gatewayV2MessageSchema.parse` 校验（`device-gateway.ts:229-237`）；查询全为空/全是停用词时 `queryTerms` 为空，走 `not_found`，不会触发搜索。`readText` 解码失败被 `.catch(() => "")` 吞掉；`episodes.search` 失败被 `.catch(() => [])` 吞掉；`provider.search` 失败没有捕获，会直接冒泡成请求错误。
- 安全/隐私：发现第 1 条 sensitive 泄漏；第 2 条过期/被取代泄漏；`restricted` 会被 `reviewMemoryVisible` 排除。搜索路径只读（`search`、`listActive`、`readMany`），没有 `markUsed`、写入或不可撤销操作。
- 模型调用：`lexicalOnly === true` 时 `HybridMemoryProvider` 与 `MemoryEpisodeService` 都把 embedder 置空（`hybrid-memory-provider.ts:152`、`episodes.ts:308`），生产装配的 provider 是 `HybridMemoryProvider`（`production-memory-composition.ts:49`），未发现新端点会触发 `embedQuery`。
- 资源消耗：`candidateLimit` 上限 200，`readMany` 硬上限 1000，episode store 查询上限 200；建议路径的全量扫描见第 5 条。
- 规则/文档/清单一致性：新增的 `searchAsk` 配置没有对应文档；`ci/operations-pending.json` 的 `search.ask.read` 键存在于契约中，`scripts/check-operations.mjs` 只在缺少调用方时允许它留在 `operations`，与“iOS 调用方待接”一致。未运行 `check:operations`。
- 未核实：仓库里没有 iOS 搜索页调用方或 `search.ask.snapshot` 的 Swift 解码代码；没有运行测试和 `check:prompt-prefix`；没有读取生产配置。

**必答问题**

1. 不会改变模型已经见过的请求开头。本改动未触及系统提示、工具定义、历史消息或遮盖逻辑；新增端点只做读取，不进入 Run 的提示词组装。发给模型的内容仍然只在末尾追加；每轮会变的值只出现在设备响应里：`generatedAt`（`production-search.ts:153`）和“是否显示年份”依赖当前年份的 `basis.label`（`production-search.ts:42`、`:48-58`），它们不是模型输入，不影响前缀缓存。依据 diff：没有修改 prompt 相关文件。未运行 `check:prompt-prefix`。
2. 对模型可见的文字不会因请求而变成不同字节。`answer` 来自存储原文加确定性的 `singleLine`/`clip`；遮盖逻辑没有改。设备响应本身不是字节稳定的：`generatedAt` 每次不同，`basis.label` 的年份显示依赖当前年份，建议排序依赖 `useCount` 和其他活动；但这些都不进入模型请求。若将来把搜索答案写回对话历史，这些时间/排序字段会进入模型上下文，需要重新评估（推测）。
3. 有自动检查，但覆盖不完整。已加：`production-search.unit.test.ts`、`hybrid-memory-provider.unit.test.ts` 的 `lexicalOnly` 用例、`startup-configuration.unit.test.ts` 的配置边界、`device-gateway.test.ts` 的设备通道集成、gateway fixture/契约测试。反向用例的问题：敏感记忆的反例是假绿（第 3 条）；`superseded` 答案和过期建议没有用例；`HybridMemoryProvider` 有“不调用 `embedQuery`”的真反例，但 `MemoryEpisodeService` 只有 mock 断言“传入了 `lexicalOnly: true`”，没有真实服务不调用 embedder 的反例。未运行测试，只按代码判断。
4. 逐个核对：
   - `searchAsk` 配置键：产生于 `DEFAULT_SEARCH_ASK`（`configuration.ts:250-256`）和 `parseSearchAsk`（`strict-configuration.ts:1446`）；使用于 `production-http-composition.ts:1291` 和 `ProductionSearchControl`。范围：`candidateLimit` 1–200（provider/readMany 上限 1000），`answerCharacters` 1–2000（契约 2000），`basisLimit` 1–10（契约无条数上限），`askLimit` 0–20，`minimumCoveragePercent` 1–100。除第 4 条的 UTF-16/控制字符差异外，两端一致。
   - `lexicalOnly`：产生于 `ProductionSearchControl` 的唯一调用点；使用于 `HybridMemoryProvider.search` 和 `MemoryEpisodeService.search`。生产实现都会跳过 embedder；其他实现只出现在 `test/integration/*` 的 stub 里，不影响生产。
   - `search.ask.read`：已加入 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、`CLIENT_CAPABILITY_TABLE`、生成的 Swift 能力清单、`PRODUCTION_SEARCH_OPERATIONS`、生产审批网关路由、HTTP 已安装操作清单和 `operations-pending.json`。设备网关用 `findClientCapability` 能找到它（query/read），v2 契约能接受其 payload；`check-operations` 的待办校验要求键在契约中且原因非空，当前满足（未实际运行）。
   - `search.ask.snapshot`：已加入契约和 `schemasByType`，并因 `endsWith(".snapshot")` 自动进入 `CLIENT_RESPONSE_ONLY_TYPES`；fixture 的字段与 schema 一致；不需要额外的能力清单项。
   - `generatedAt` 和 `basis.label`：只由 `ProductionSearchControl` 产生，当前只被 iOS 响应消费；iOS 解码实现不在仓库内，未核实。
   - `ci/operations-pending.json` 的 `search.ask.read` 清单项：键在契约中，后端有处理和路由，测试里出现，缺少的只有前端调用方，与待办原因一致。后端校验（设备网关 + 契约解析）能接受该操作。
