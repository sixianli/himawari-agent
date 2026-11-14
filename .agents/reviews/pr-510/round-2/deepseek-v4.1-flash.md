**本轮范围**

本轮只核对了增量 `52535fdee..22e0f69f8` 改到的 `apps/agent-service/src/production-search.ts`、`apps/agent-service/test/production-search.unit.test.ts`（另有两份 review 记录）。为核对证据，跟读了：旧版 `production-search.ts`、`packages/gateway-contracts` 的 search 快照 schema 与 `boundedString`、`runPolicy.searchAsk` 配置边界、`HybridMemoryProvider`/`MemoryEpisodeService` 的 `lexicalOnly` 与分类过滤、`ProductionSearchControl` 的生产装配、vitest 测试注册、设备网关集成测试。增量没碰、行为也没被增量改变的旧代码未整份重读。

**上一轮意见核对（读代码证实）**

1. **敏感记忆未隐藏：已改好。** 新增 `SEARCH_VISIBLE = ["public", "private"]`，`#suggestions` 和 `#answer` 都走 `currentlyShown()`；对话摘要传给 `episodes.search` 的 `allowedClassifications` 也从 `modelVisibleClassifications()`（含 sensitive）改为 `SEARCH_VISIBLE`，循环里再按 `searchVisible` 过滤。见 `production-search.ts:114-126`、`:193`、`:252`、`:277`、`:286`。
2. **过期/被取代过滤不一致：已改好。** `currentlyShown()` 同时检查 `supersededBy !== null`、`tentative === true`、`validTo <= now`、分类可见性；两条路径共用。答案路径另有 `status === "active"`，建议路径的 `listActive` 本身只返回 active（`sqlite-memory-operations.ts:998-1008`）。
3. **答案/建议的契约长度和控制字符：已改好。** `singleLine` 现在去掉 `\p{Cc}`，`clip` 按 UTF-16 长度保证不超过上限；`contracts-v2.ts:800` 的 `boundedString(2000)` 与 `strict-configuration.ts:1453` 的 `answerCharacters` 上限 2000 一致。`asks` 每个名字 `singleLine` 后不超过 120，契约上限是 500（`contracts-v2.ts:811`）。
4. **`askLimit = 0` 仍全量扫描：已改好。** `production-search.ts:185` 在 `listActive` 之前直接返回空建议；新增测试 `production-search.unit.test.ts:220-233` 断言 `listActive` 未被调用。
5. 上一轮列表没有第 3 条意见，无需核对。

**意见**

### 1. 低：`asks` 的契约清洗没有专门的反向用例

文件:行：`apps/agent-service/test/production-search.unit.test.ts:213-218`、`:265-268`；`apps/agent-service/src/production-search.ts:128-130`、`:198`。

问题：上一轮第 4 条意见同时覆盖 `answer` 和 `asks`，但新增测试只对 `answer` 断言了长度和控制字符；建议问题里的实体名清洗（`singleLine` + 120 长度）没有专门的含 `\u0000`/超长实体的反向用例。代码本身按阅读是正确的，这是覆盖缺口，不是已发生的生产错误。

证据（读代码证实）：

```ts
// production-search.ts:128-130
function singleLine(text: string): string {
  return text.replace(/[\p{Cc}\s]+/gu, " ").trim();
}

// production-search.ts:197-198
const name = singleLine(entity);
if (name.length === 0 || name.length > ASK_MAXIMUM_CHARACTERS) continue;
```

```ts
// production-search.unit.test.ts:213-218：只测 answer
const long = `我对花生过敏\u0000${"😀".repeat(1500)}`;
const answer = (await only(single([record("m")], long), "花生过敏")).answer ?? "";
expect(answer.length).toBeLessThanOrEqual(DEFAULT_SEARCH_ASK.answerCharacters);
expect(answer).not.toMatch(/\p{Cc}/u);
```

建议：增加一个实体名含 `\u0000` 且长度超过 120 的 suggestion 测试，断言 `asks` 中无 `\p{Cc}`、每项长度不超过 120（或至少不超过契约的 500）。这样上一轮第 4 条的 `asks` 半边也有独立反向用例。

**侧重检查**

- 错误路径：`readText(...).catch(() => "")` 和 `episodes.search(...).catch(() => [])` 仍会把读取/摘要检索失败降级为跳过；`provider.search`、`readMany`、`listActive` 的错误仍向上抛（旧行为，增量未改）。敏感记忆在 `readText` 之前就被 `currentlyShown` 过滤，不会先解密敏感正文。
- 不合规范/不可信输入：入站 `query` 受 `boundedString(500)` 和无 C0/DEL 约束（`contracts-v2.ts:793`、`validation.ts:91-108`）；`singleLine` 去掉 `\p{Cc}` 并折叠空白。答案经 `clip` 后按 UTF-16 不超过配置值；建议项不超过 120。本轮未发现新的契约不一致。
- 安全/隐私：`sensitive`/`restricted` 在两条路径都被排除；摘要库查询本身也按分类过滤（`sqlite-memory-operations.ts:130-132`），并先经 `isModelVisible` 过滤（`episodes.ts:326`），不会把敏感摘要正文读出来再丢。
- 资源耗尽：`askLimit = 0` 提前返回；`candidateLimit` 1–200、`basisLimit` 1–10、`askLimit` 0–20、`answerCharacters` 1–2000、`minimumCoveragePercent` 1–100 均有配置边界（`strict-configuration.ts:1449-1455`）。`askLimit > 0` 时仍会扫描全部 active 记忆，这是建议功能的既有设计，不是增量引入。
- 不可撤销操作：搜索是只读操作，本轮没有新增写库、删除或外部副作用。
- 规则/文档一致性：PR 材料中的“不显示敏感、过期、待确认”“lexicalOnly 不调 embedder”“建议默认 0 条”与代码一致；未发现规则文件与代码冲突。`.agents/instructions/prompt-prefix.md` 在当前稀疏检出中不存在，**未核实**其原文，但见下面必答问题 1。

**读代码证实的**

- `HybridMemoryProvider.search` 在 `lexicalOnly === true` 时把 `embedder` 置空（`hybrid-memory-provider.ts:152`），不会调用 `embedQuery`。
- `MemoryEpisodeService.search` 同样在 `lexicalOnly === true` 时不取 embedder（`episodes.ts:308`）。
- 生产装配把搜索的 `provider.search` 直接指向 `HybridMemoryProvider.search`，`episodes.search` 指向 `MemoryEpisodeService.search`（`service-main.ts:2987-2995`）。
- `production-search.unit.test.ts` 会被 `vitest.workspace.ts:79-84` 的 `node-services` 项目匹配。

**推测 / 未核实**

- 无法运行测试（工具限制）；“新增反向用例在旧代码上会失败”是按旧版 `production-search.ts` 的逻辑推断，不是实际执行结果。
- `answer` 的契约上限 2000 和配置上限/default 2000 分别硬编码在 `contracts-v2.ts:800`、`strict-configuration.ts:1453`、`configuration.ts:254`；当前一致，但以后若只改一边会漂移。这是维护风险，不是当前错误。
- 设备端 Swift 是否已实现 `search.ask.snapshot` 的解码**未核实**；本轮只在 `clients/apple/.../ClientCapabilities.swift` 看到能力声明。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 本增量只改搜索快照生成；搜索不参与系统提示、工具定义、历史消息或遮盖结果的构造，也没有新增模型请求（两处检索都传 `lexicalOnly: true`，见上）。因此发给模型的内容仍然只在末尾追加、每轮会变的值仍在最后一条消息里这一规则不受影响；本改动无需触碰该规则。
2. **不影响模型请求的字节稳定性。** 搜索响应里的 `generatedAt` 和 `basis.label` 的年份判断会随 `clock.now()` 变化，同一记忆在不同时间可能产生不同字节，但这是搜索响应字段的既有设计（`production-search.ts:28-41`、`:170`），不进入模型请求；本增量没有引入依赖前后文的遮盖或无序集合。`asks` 的排序仍按 `uses`、`updatedAt`、名称稳定排序（`production-search.ts:207-215`）。
3. **有自动检查，且反向用例在旧代码上会失败（按代码推断）。** 新增覆盖：敏感答案/建议（`:191-200`）、被取代答案和过期建议（`:202-211`）、答案长度与控制字符（`:213-218`）、`askLimit = 0` 不读记忆（`:220-233`）。旧版答案路径不查 `supersededBy`、建议路径不查 `validTo`、分类用的是含 sensitive 的 `reviewMemoryVisible`、`clip` 按码点计长、`askLimit = 0` 仍调用 `listActive`，所以上述断言在旧代码上会失败。唯一缺口是 `asks` 的长度/控制字符没有专门测试，见意见 1。
4. **增量产生/修改的值，使用端都能接受。** 没有新增导出函数、配置键、字段或序列化格式。逐个核对：
   - `SEARCH_VISIBLE`（内部常量）→ `searchVisible`/`currentlyShown`，并作为 `allowedClassifications` 传给 `episodes.search`；该端用 `CLASSIFICATIONS` 校验且用 `isModelVisible` 过滤，`public`/`private` 都合法（`sqlite-memory-operations.ts:1411-1412`、`episodes.ts:326`）。
   - `currentlyShown`（内部函数）→ 建议和答案两条路径；`attributes` 可选、`supersededBy`/`validTo` 用 `?? null` 处理，SQLite 读取会提供 `null` 或合法值（`sqlite-memory-operations.ts:546-547`）。
   - `singleLine`（内部函数）→ 查询、记忆正文、摘要正文、实体名；下游是长度检查和 `boundedString`，`\p{Cc}` 已去掉、空白已折叠。
   - `clip`（内部函数）→ 只供 `payload.answer`；`boundedString(2000)` 和配置上限 2000 使用同一 `.length` 口径，当前一致。
   - `askLimit === 0` 的空返回 → `search.ask.snapshot` 契约要求的 `state/query/answer/notFoundText/basis/asks/generatedAt` 全部存在，`state` 是合法枚举值，设备端可接受。
   - `asks` 名称 → 契约 `boundedString(500)`，代码限制 120 且去掉 `\p{Cc}`，长度和控制字符都满足。
   - `query` → 回显的 `asked` 来自入站 500 长度字符串，`singleLine` 只会缩短，契约 500 满足。
