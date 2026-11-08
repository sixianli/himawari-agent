## 发现

### 中 — 每个聊天检索都会对同一查询做两次并发向量化，违反 prompt-prefix 规则 17，并放大费用/限流风险【读代码证实并发；失败后果为推测】

- 文件: `apps/agent-service/src/production-memory-recall.ts:169`
- 问题: 第一次检索和 `tentativeOnly` 第二次检索用 `Promise.all` 同时启动，两次都把同一个 `input.query` 交给 `provider.search`；`HybridMemoryProvider.search` 每次都会重新调用 `embedder.embed`。因此每次聊天 recall（`limit >= 2`）都会对完全相同的输入并发发两次 embedding 请求，即使没有任何待确认记忆也一样。
- 证据:
  - `apps/agent-service/src/production-memory-recall.ts:169-192`
    ```ts
    const [hits, tentativeHits] = await Promise.all([
      this.#options.embedWithin(invocation, "memory-recall", () =>
        this.#options.provider.search({ ... query: input.query, limit: input.limit * 3, scope: searchScope }),
      ),
      tentativeLimit === 0
        ? Promise.resolve([])
        : this.#options.embedWithin(invocation, "memory-recall-tentative", () =>
            this.#options.provider.search({ ... query: input.query, limit: input.limit * 3, scope: searchScope,
              includeTentative: true, tentativeOnly: true }),
          ),
    ]);
    ```
  - `packages/memory-engine/src/hybrid-memory-provider.ts:139-149` 每次 `search` 都执行 `await embedder.embed(...)`。
  - `.claude/rules/prompt-prefix.md:69`：`并发发出、开头相同的请求，要等第一个请求开始返回，再发后面的。`
  - ADR 只承认“多一次对同一问题的向量化”，没有说明这次是并发且相同的请求。
- 建议: 让一次 embedding 服务两次索引查询：给 provider/index 增加“用已算好的 embedding 分别查正式/待确认”的入口，或让一次索引查询同时返回 `confirmed` 和 `tentative` 两组候选。这样既避免双倍费用，也不违反规则 17。退而求其次也应串行化，并让待确认检索失败时只回退为空，不影响正式结果。

### 低 — `MemoryIndexStorePort` 的新字段 `tentativeOnly` 被现有内存实现静默忽略（I-73 类“产生方加入、消费方不认”）【读代码证实】

- 文件: `packages/testing/src/in-memory/memory-index.ts:35`
- 问题: 端口和 sqlite 实现都接受 `tentativeOnly`，但 `inMemoryMemoryIndex().search` 完全不过滤 `includeTentative` / `tentativeOnly`，返回所有文档。生产用的是 sqlite，所以当前线上路径不受影响；但任何使用这个测试/开发用实现的组件都会得到“包含正式记忆”的结果，且可能因为先 `slice` 而把待确认记忆挤出候选。
- 证据: `packages/testing/src/in-memory/memory-index.ts:35-62`
  ```ts
  search: async (input) => {
    const scoped = [...documents.values()].filter(
      (document) => document.ownerId === input.ownerId && document.agentId === input.agentId,
    );
    ...
    .slice(0, input.limit);
    return { vector, lexical, entity: [], ... };
  },
  ```
  这里没有读取 `input.includeTentative` 或 `input.tentativeOnly`。
- 建议: 在内存实现里补上两个开关的过滤；或者不支持时明确抛错，避免静默忽略新契约。

### 低 — 可选的待确认检索失败会连累整个 recall 失败【读代码证实结构；是否实际触发为推测】

- 文件: `apps/agent-service/src/production-memory-recall.ts:169`
- 问题: 待确认检索只是增强项，但被放在 `Promise.all` 里，没有单独的 `catch`。一旦第二次检索在 `provider.search` 的索引层抛错（例如未来某个索引实现对未知参数 `tentativeOnly` 严格拒绝、或这次查询的数据库错误），即使第一次检索已经成功，整个 recall 仍会失败，退化成 `MEMORY_RECALL_UNAVAILABLE`。注意：当前 `HybridMemoryProvider` 会吞掉 embedding 错误，所以主要是索引/数据库错误才会逃逸；生产 sqlite 当前不会因为 `tentativeOnly` 本身报错。
- 证据: `apps/agent-service/src/production-memory-recall.ts:169-192` 的 `Promise.all`；`apps/agent-service/src/production-runtime-tools.ts:603-611` 把任何非输入错误都映射为 `MEMORY_RECALL_UNAVAILABLE`。
- 建议: 对待确认检索单独 `.catch(() => [])`，或改用 `Promise.allSettled`，保证正式记忆检索成功时仍能返回结果。

### 低 — 集成反向用例的断言较脆弱，不能直接证明“只返回待确认”【读代码证实】

- 文件: `test/integration/memory-consolidation.test.ts:450`
- 问题: 反向用例用“`only` 的长度等于 `includeTentative` 结果中 `insight` 出现次数”来间接判断。它当前能抓到“去掉 SQL `tentativeOnly` 条件”（因为 `includeTentative` 会返回多条正式记忆，长度对不上），但：
  - 若以后新增另一条也命中该查询的待确认记忆，`only` 长度会变大而测试失败；
  - 它没有直接断言“`only` 中每个 id 都是待确认”以及“某个已知正式 id 不在 `only` 中”。
- 证据: `test/integration/memory-consolidation.test.ts:450-455`
  ```ts
  const only = await resource.searchable("半程马拉松晨跑", "only");
  expect(only).toContain(insight?.id);
  expect(only).toHaveLength(
    (await resource.searchable("半程马拉松晨跑", true)).filter((id) => id === insight?.id).length,
  );
  ```
- 建议: 直接读取 `only` 中每个 id 对应的记录并断言 `attributes.tentative === true`，同时断言某条已知正式记忆（如 `run-b`）不在 `only` 中。

### 未核实

- `packages/prompt-catalog/prompt-manifest.json:431` 新增条目的 `sha256` 是否等于 `JSON.stringify(segments)` 的 SHA-256，无法在不运行哈希命令的情况下核对。若不一致，`apps/agent-service/test/prompt-catalog.unit.test.ts:187` 会报 `PROMPT_MANIFEST_STALE`。本轮 d8 未改动该文件，属于既有改动，标为未核实。

---

## 侧重检查

- **错误路径**：第二次检索放在 `Promise.all` 中，未单独兜底；embedding 错误会被 `HybridMemoryProvider` 吞掉并回退到词法/实体，但索引层错误会逃逸（见上）。未发现新的未捕获同步异常路径。
- **不合规范/不可信输入**：`argumentsOf`（`production-memory-recall.ts:93-121`）没有变化，`tentativeOnly` 是内部字段，不能由工具调用参数注入；用户可传的 `query/from/to/limit` 校验不变。
- **安全/分类**：`render` 在调用 `readText` 之前先检查 `memory.status`、`providerRecordId`、`dataClassification`（`production-memory-recall.ts:211-219`），待确认记忆即使分类高于当前运行也不会被解密/返回；新增测试覆盖了这一点。
- **资源耗尽**：每次 `limit >= 2` 的 recall 固定多一次 embedding 模型调用；模型预算/限流压力见上。除此之外没有新增无界循环或无界集合。
- **不可撤销操作**：recall 本身只做读查询；新增的副作用是额外 embedding 调用（费用不可撤销）和工具结果的持久化，后者是既有行为。
- **规则/文档一致性**：ADR 0179 第 3 条与代码在“两次检索、正式在前、最多一半、limit=1 不查待确认”上一致；但 ADR 只写了“多一次向量化”，没有覆盖规则 17 的“相同请求并发”约束。`includeTentative`/`tentativeOnly` 的 SQL 绑定与三条索引路径一致。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会（就本提交的增量而言）。`memoryRecallDescriptor()` 没有变化，工具定义不变；新增的 `tentativeNote` 只在 `ProductionMemoryRecall.recall` 的返回值里，由 `ProductionRuntimeTools.#ownerScoped` 以 `modelContent: JSON.stringify(value)` 追加到工具结果（`apps/agent-service/src/production-runtime-tools.ts:663-672`），属于末尾追加。第二次检索也不会改写系统提示、历史或遮盖结果；每轮变化的 `tentativeNote` 和待确认记忆都只出现在本轮新增的工具结果里。
   注：新增提示词条目会扩大 `trustedPromptTexts` 清单，但它没有删除或修改任何旧提示词文字，旧对话前缀不会因此改变；清单哈希未核实。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会因为这个改动而新增不确定性。`tentativeNote` 是固定文本，`memories` 顺序由 `fuseCandidates` 的 `score DESC, memoryId` 确定性排序决定（`packages/memory-engine/src/fusion.ts:113`），`render` 只是保持该顺序并把正式记忆放在待确认之前。`current` 和结果成员仍取决于数据库状态和时间，这是既有行为，而且位于追加的工具结果中，不改变已发出的前缀字节。

3. **有没有自动检查，反向用例是否真会失败？**
   有：
   - 若 recall 不传 `tentativeOnly`：`production-memory-recall.unit.test.ts:172-177` 的 `toMatchObject({ includeTentative: true, tentativeOnly: true })` 会失败。
   - 若 SQL `tentativeOnly` 条件被删或 `HybridMemoryProvider` 不转发：`memory-consolidation.test.ts:450-455` 的 `only` 长度会变成包含正式记忆的数量，与右侧的 1 不一致，会失败（该查询能命中多条 active 正式记忆）。
   - 若 `tentativeNote` 无条件添加：`production-memory-recall.unit.test.ts:212` 的 `Object.keys(result)` 断言会失败。
   - 若“待确认最多一半”被去掉：`production-memory-recall.unit.test.ts:218-230` 的精确文本和 `single` 断言会失败。
   - 若去掉分类过滤：`production-memory-recall.unit.test.ts:236-243` 会失败。
   缺口：SQL 的“`tentativeOnly` 为真时强制 `includeTentative=1`”没有单独反向用例（当前调用方总是两者都传）；实体索引路径没有单独命中实体的反向用例（不过三路共用同一个 `indexScope`，绑定已核对）；内存索引实现未覆盖。

4. **每个新值两端是否都能接受？**
   - `tentativeOnly`：`MemoryProviderProjectionPort`/`MemoryIndexStorePort` 定义 → `HybridMemoryProvider.search` 转发 → worker → `SqliteMemoryOperations.searchIndex`。SQL 中 `indexScope` 使用 `@tentativeOnly`，向量（sqlite-vec/javascript）、FTS、实体三条语句都通过 `scope`/`vectorScope` 绑定了该参数（`sqlite-memory-operations.ts:1103,1151,1168`），已核对。旧调用未传该字段时 `scope.tentativeOnly=0`，行为不变。
   - `includeTentative` 的强制：仅在 sqlite `searchIndex` 里处理（`sqlite-memory-operations.ts:1082`），端口和 Hybrid 不强制；当前 recall 同时传两个开关，因此生产路径没问题，但契约上“只传 tentativeOnly 就隐含 includeTentative”并未由端口保证，也没有测试。
   - `tentativeNote`、`tentative` 字段：只作为 recall 工具结果的 JSON 返回，`production-runtime-tools.ts:671` 直接 `JSON.stringify(value)`，没有额外 schema 拒绝；模型可接受。
   - 提示词 id `tool-result.recall-tentative`：代码导出、`usedBy` 路径存在、manifest 有条目；manifest 的 `sha256` 未核实。
   - 清单项/序列化格式：`memories` 中确认记忆不加 `tentative` 键，待确认记忆加 `tentative: true`，无正式记忆时返回对象与原来键顺序一致（测试 `:203-213` 覆盖）。
   - 唯一明确的两端不一致：`packages/testing/src/in-memory/memory-index.ts` 作为 `MemoryIndexStorePort` 实现不识别 `tentativeOnly`（也不识别 `includeTentative`）。
