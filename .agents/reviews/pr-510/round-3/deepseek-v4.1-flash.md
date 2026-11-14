## 范围

这一轮我核对了两次改动：

- 整个 PR 的基线差异 `8a9f844..8620bd5`。其中与 PR 510 相关的源码和测试共 20 个文件，包括 `production-search.ts` 及其单测、`production-http-composition.ts`、`production-approval-gateway.ts`、`service-main.ts`、契约、配置、memory-engine、设备集成测试等。
- 上一轮到本轮的增量 `22e0f69..8620bd5`。这部分主要是把 origin/main 的感知和首页紧急度代码合并进来；`production-search.ts`、memory-engine 的 `lexicalOnly`、`searchAsk` 配置解析、search 契约块都没有被增量改动。我检查了合并后的共享文件：`production-http-composition.ts` 中 `routeOptions` 的参数顺序与调用处仍然对齐，search 路由分支仍在 memory 之前，`installedOperations`／`installedGatewayV2Operations` 仍然一致，契约和 fixture、Swift 生成文件、operations-pending 都还保留 search 项。

上一轮“会出错”的意见列表为空；第 2 轮的修复提交 `22e0f69` 已在当前代码里：`currentlyShown` 同时用于建议和回答，`SEARCH_VISIBLE` 只含 public/private，episode 搜索传 `SEARCH_VISIBLE`，`askLimit === 0` 提前返回，`clip` 按 UTF-16 长度截断。这些与提交说明一致。

## 读代码证实的问题

### 1. 中：search.ask.read 也向网页网关开放并对外公布，不只是“设备经设备网关调”

文件：`apps/agent-service/src/production-http-composition.ts:776`、`apps/agent-service/src/production-approval-gateway.ts:326`

问题：作者说这个功能“设备经设备网关调”，`ci/operations-pending.json:36` 也写“调用方是 iOS 原生搜索页”“check:operations 认不出 Swift”。但代码把 `PRODUCTION_SEARCH_OPERATIONS` 放进了浏览器配置的 `installedGatewayV2Operations`，同时 `gatewayV2` 的 `installedOperations` 也包含它；网页 HTTP 网关和设备网关用的是同一个 `gatewayV2` 服务。因此网页会话也可以调用 `search.ask.read`，暴露面比说法大。

证据：

```ts
// production-http-composition.ts:776
...(searchAvailable ? PRODUCTION_SEARCH_OPERATIONS : []),
```
```ts
// production-approval-gateway.ts:326
...(options.searchControl ? PRODUCTION_SEARCH_OPERATIONS : []),
```

建议：确认这是有意让网页也能用，还是只想给设备。若只想给设备，网页侧不应公布/不应走到该分支；若有意开放，把作者说明和 operations-pending 理由改成“网页与设备共用”，并补一条网页路径的测试。

### 2. 低：生产组合里的 searchControl 装配没有自动测试

文件：`apps/agent-service/src/production-http-composition.ts:1316`、`apps/agent-service/src/production-http-composition.ts:1374`、`apps/agent-service/src/production-http-composition.ts:1470`、`test/integration/device-gateway.test.ts:582`、`test/fixtures/device-api-harness.ts:113`

问题：`ProductionSearchControl` 的单测直接 `new`；设备集成测试是自己构造 `ProductionSearchControl`，再经 `harness({ searchControl })` 注入。没有任何测试经过 `createProductionHttpComposition` 的 `options.memory.search` 分支去构造并传给 `createProductionApprovalGateway`。如果生产装配漏传 `searchControl`、漏传 `episodes`，或 `routeOptions` 参数错位，现有测试仍会全绿。

证据：

```ts
// production-http-composition.ts:1316
const searchControl = options.memory?.search
  ? new ProductionSearchControl({ ... })
  : undefined;
// production-http-composition.ts:1374
...(searchControl ? { searchControl } : {}),
```
```ts
// test/integration/device-gateway.test.ts:582
const searchControl = () =>
  new ProductionSearchControl({ ... });
```

建议：加一条使用真实 `createProductionHttpComposition`、配置 `memory.search` 的测试，至少断言 `search.ask.read` 在已安装操作里且设备请求能返回 `search.ask.snapshot`；或让 `device-api-harness` 可走生产组合而不再手工注入。

### 3. 低：MemoryEpisodeService 的 lexicalOnly 不调 embedder 没有反向测试

文件：`packages/memory-engine/src/episodes.ts:308`、`packages/memory-engine/test/hybrid-memory-provider.unit.test.ts:277`、`apps/agent-service/test/production-search.unit.test.ts:256`

问题：作者声称 `lexicalOnly` 为真时 `HybridMemoryProvider` 和 `MemoryEpisodeService` 都不调 embedder。`HybridMemoryProvider` 有测试真的断言 `embedQuery` 未被调用；`MemoryEpisodeService` 只有生产层断言“传了 `lexicalOnly: true`”，没有断言 episode 搜索自身不调 embedder。若 `episodes.ts:308` 被改坏，现有测试不会失败。

证据：

```ts
// episodes.ts:308
const embedder = input.lexicalOnly === true ? null : this.#options.embedder;
```
```ts
// production-search.unit.test.ts:256
expect(f.episodeSearch.mock.calls[0]?.[0]).toMatchObject({ lexicalOnly: true });
```

建议：在 `packages/memory-engine` 的 episode 测试里加一条和 HybridMemoryProvider 相同的反向用例：`lexicalOnly: true` 时 `embedder.embedQuery` 不得被调用，`store.search` 收到 `embedding: null`。

## 推测/需确认

### 4. 中：带 sensitiveTopic 但分级已降为 private 的记忆，可能被搜索返回

文件：`apps/agent-service/src/production-search.ts:114`、`packages/application/src/services/automatic-memory-service.ts:374`、`apps/agent-service/src/production-memory-control.ts:1583`

问题：`currentlyShown` 只看 `dataClassification` 是否在 public/private，不看 `attributes.sensitiveTopic`。但代码里存在“敏感候选审核通过后，分级从 sensitive 降为 private、同时保留 sensitiveTopic”的记忆：`automatic-memory-service.ts:374-381` 明确这样写；`production-memory-control.ts:1583-1587` 也把 `attributes.sensitiveTopic` 当作敏感标记，拒绝改分类。

证据：

```ts
// production-search.ts:114-125
const SEARCH_VISIBLE = ["public", "private"];
...
return searchVisible(memory.dataClassification);
```
```ts
// automatic-memory-service.ts:374-381
dataClassification:
  candidate.dataClassification === "sensitive" &&
  (request.sourceClassification === "public" || request.sourceClassification === "private")
    ? "private"
    : candidate.dataClassification,
attributes: {
  ...(candidate.attributes ?? DEFAULT_MEMORY_ATTRIBUTES),
  sensitiveTopic: candidate.sensitiveTopic ?? "other",
},
```

如果需求里的“不显示敏感记忆”只指 `dataClassification === "sensitive"`，当前实现是对的；如果也包含 `sensitiveTopic`（健康、财务等）的记忆，那么这些已降级为 private 的条目会作为答案和建议实体返回。这个判断需要产品确认，我没有找到明确文档定义“搜索里的敏感记忆”是否包含 sensitiveTopic（未核实）。

建议：确认定义。若应排除 sensitiveTopic，`currentlyShown`/episode 路径也要检查 `attributes.sensitiveTopic === null`，并补一条“private + sensitiveTopic 不展示”的反向用例。

## 侧重检查（错误路径、不可信输入、安全、资源、文档一致性）

- **不可信输入**：`search.ask.read` 的 `query` 由契约 `boundedString(500)` 限长并拒绝控制字符，`locale` 是枚举，`singleLine` 再折叠空白/控制字符；回答也经 `singleLine` 和 `clip`，`boundedString(2000)` 能接受。没发现绕过。
- **敏感数据**：memory 答案在 `readText` 前先过 `currentlyShown`，sensitive/restricted 不会解密；episode 传 `SEARCH_VISIBLE` 且返回前再查 `searchVisible`，没发现解密后才判断的泄漏。唯一不确定的是上面 `sensitiveTopic` 的口径。
- **资源耗尽**：`candidateLimit` 上限 200 与 memory index 的 200 上限一致；`askLimit` 上限 20；`basisLimit` 上限 10；`answerCharacters` 上限 2000 与契约一致。`#suggestions` 在 `askLimit === 0` 时不解密、不扫记忆；但配置大于 0 时会遍历全部 active 记忆，没有分批上限，这属于个人数据规模下的可接受成本，未发现外部可触发的放大路径。
- **错误路径**：`readText` 失败被 `.catch(() => "")` 吞掉，按无文本处理；`episodes.search` 失败被 `.catch(() => [])` 吞掉；`provider.search` / `state.readMany` 失败会冒泡成 500。没有静默返回错误答案，但也没有诊断日志（未要求，故不作为缺陷）。
- **不可撤销操作**：本改动只有查询，没有写操作。
- **文档/规则一致性**：operations-pending 的 id 在契约和 `CLIENT_CAPABILITY_TABLE` 里都存在，`CLIENT_RESPONSE_ONLY_TYPES` 会自动把 `search.ask.snapshot` 归入回应类型，Swift 生成文件有对应项；`searchAsk` 配置键在严格配置的未知键拒绝列表里，默认值和边界都有用例。发现的唯一说明差异是上面第 1 条“设备专用”的口径。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。PR 510 没有改 `packages/prompt-catalog`、系统提示、工具定义或历史消息；`ProductionSearchControl` 只读 memory index 和 payload，直接把结果作为 `search.ask.snapshot` 返回设备，不调用模型，也不写入对话历史。新增的 `CLIENT_CAPABILITY_TABLE`、`GATEWAY_V2_MESSAGE_TYPES`、`searchAsk` 配置都不进入模型请求。增量合并进来的 home urgency 模型调用属于 main 的改动，不是本 PR 的 search 路径。因此不涉及“只在末尾追加”的规则，也没有把每轮会变的值放进请求开头。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

对发给模型的内容：不涉及，没有模型请求。对设备响应：会，但这是设计内的。`production-search.ts:170` 的 `generatedAt` 取 `clock.now()`；`dateParts` 生成的 `label` 依赖当前时间和 `runPolicy.timeZone`（`production-search.ts:28-40`、`319-325`）；建议问题的排序在 `uses`、`updatedAt` 相同时用 `localeCompare`（`production-search.ts:207-213`），结果可能随运行环境的 locale/ICU 变化。这些都不进入模型请求，不影响 KV 缓存或遮盖；如果客户端要求响应逐字节稳定，需要另行确认。遮盖逻辑没有新增。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，而且大部分反向用例写得是对的；我没有执行测试（本轮不允许运行命令），以下是静态阅读判断：

- `apps/agent-service/test/production-search.unit.test.ts`：未命中、sensitive-only 不返回也不建议、superseded/expired/tentative 隐藏、候选文本不含查询词时 not_found、`askLimit=0` 不读记忆、答案长度/控制字符、episode 来源、`lexicalOnly: true`。去掉 `currentlyShown`、`searchVisible`、覆盖率检查或 `askLimit` 早退，这些用例会失败。
- `test/integration/device-gateway.test.ts`：有搜索装配时的成功路径，以及没有 searchControl 时非 200 的反向用例。
- `packages/memory-engine/test/hybrid-memory-provider.unit.test.ts:277`：真的断言 `embedQuery` 未被调用。
- `packages/platform-node/test/startup-configuration.unit.test.ts:1104`：`searchAsk` 默认值、覆盖、越界和未知键。
- 缺口：`MemoryEpisodeService` 的 lexicalOnly 没有反向用例；生产 `createProductionHttpComposition` 的 searchControl 装配没有测试（见第 2、3 条）。

### 4. 每个产生/修改的值，使用端都能接受吗？

逐项核对结果：

- `search.ask.read`：产生于契约消息列表、`searchAskQuerySchema`、`CLIENT_CAPABILITY_TABLE`（query/read）、Swift 生成文件、`PRODUCTION_SEARCH_OPERATIONS`、`operations-pending`；使用于设备网关 `findClientCapability`、`AgentGatewayV2Service` 的 `installedOperations`、approval gateway 路由、http composition 的公布列表。两端都存在且 kind 一致，`check:operations` 和 `client-parity` 能守住大部分漂移；未发现不匹配。
- `search.ask.snapshot`：产生于契约消息列表、`searchAskSnapshotSchema`、fixture；`CLIENT_RESPONSE_ONLY_TYPES.v2` 由所有 `.snapshot` 自动派生，所以不需要单独登记能力项，parity 测试会覆盖。没发现问题。
- `lexicalOnly`：新增到 `MemoryProviderProjectionPort.search`、`HybridMemoryProvider.search`、`MemoryEpisodeService.search`，生产调用点传 `true`；两个实现都用 `=== true` 判空 embedder，使用端类型一致。测试只覆盖了前者。
- `searchAsk` 配置键：严格配置解析并在 `production-http-composition.ts:1320` 消费；`candidateLimit` 1–200 不超过 index 的 200 上限，`answerCharacters` 1–2000 与契约 `answer` 上限 2000 一致，`minimumCoveragePercent` 1–100、`basisLimit` 1–10、`askLimit` 0–20 都自洽。
- `basis.memoryId`/`threadId`：契约是 `nullable(machineString)`，领域 ID 由 `identifiers.ts:39-48` 的机器标识符规则创建，长度和字符集一致；`at` 是 `timestamp`，来自 `recordedAt/updatedAt/endedAt`，仓库其他快照也按同样假设使用这些字段。未发现不匹配。**未核实**：是否有历史/导入数据带着不符合 `machineString` 的 ID；home 代码有 `fitsMachineStrings` 过滤而 search 没有，如果存在这类数据，响应会过不了契约校验。
- `answer`/`asks`/`label`/`notFoundText`：生成端都经过长度限制或硬编码短文本，均在 `boundedString(2000/500/200)` 以内；`singleLine` 去控制字符与契约的 `boundedString` 检查一致。
