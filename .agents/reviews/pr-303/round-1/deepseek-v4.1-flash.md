## 侧重检查

- **错误路径**：`provider.search` 抛错仍由 `production-runtime-tools.ts:603-612` 转成 `MEMORY_RECALL_UNAVAILABLE`，`readText` 失败仍 `.catch(() => undefined)`（`production-memory-recall.ts:210`），本次改动没有新增未捕获路径。
- **输入校验**：`argumentsOf`（`production-memory-recall.ts:93-121`）未改，仍拒绝未知键、非法日期和超范围 `limit`；`includeTentative` 是服务端硬编码的 `true`，模型无法通过工具参数控制它（`memoryRecallDescriptor` 的参数表也没有它）。
- **安全/权限**：返回前仍逐条检查 `status`、`providerRecordId` 和 `dataClassification`（`production-memory-recall.ts:201-207`），待确认记忆不能绕过分类上限。但见下面第 4 条：即使待确认记忆因分类被过滤，仍可能影响正式记忆的排序。
- **资源耗尽**：`limit` 上限为 10，`readMany`/`readText` 最多处理 30 条，未见新的无界循环或放大。
- **不可撤销操作**：`recall` 是只读工具，没有副作用。
- **规则/文档一致性**：改动只动工具返回值，系统提示和工具定义未变，符合 `.claude/rules/prompt-prefix.md` 的只追加要求。但 ADR/作者说法里的“待确认最多占返回条数的一半”与实现不完全一致（见第 2 条）；`prompt-manifest.json` 的新摘要值无法用允许的工具计算，标为未核实。

## 问题（按严重度）

### 1. 中：待确认记忆占据候选名额，可能漏掉正式记忆、返回条数不足

- 文件:行：`apps/agent-service/src/production-memory-recall.ts:169`、`:196-210`
- 类型：读代码证实（结合 `hybrid-memory-provider.ts:161-178`、`fusion.ts:113-114`）
- 问题：搜索只取 `input.limit * 3` 条，且 `includeTentative: true` 后待确认记忆也进入这 3 倍名额。按分数排序后如果前 `3 * limit` 条几乎都是待确认记忆，循环会把超过 `floor(limit/2)` 的待确认跳过，但**不会再去取更后面的正式记忆**，于是明明数据库里还有高分正式记忆，返回值却可能只有 `floor(limit/2)` 条（甚至 0 条正式记忆）。
- 证据：
  ```ts
  // production-memory-recall.ts:169-171
  limit: input.limit * 3,
  ...
  includeTentative: true,
  ```
  ```ts
  // production-memory-recall.ts:196-209
  const tentativeLimit = Math.floor(input.limit / 2);
  if (tentative && tentativeCount >= tentativeLimit) continue;
  ```
  ```ts
  // hybrid-memory-provider.ts:161 / fusion.ts:113-114
  limit: Math.min(200, Math.max(CANDIDATES_PER_SIGNAL, input.limit)),
  .sort(...).slice(0, input.limit);
  ```
- 建议：对待确认和正式记忆分开取数，或把取数上限提高到足以覆盖实际需要的正式记忆（并在分类过滤之后再计算名额）；也可以让索引层直接按分类和待确认配额过滤，而不是先取 3 倍再丢弃。

### 2. 低：半额上限按“请求的 limit”而不是“实际返回条数”计算，与作者说法不一致

- 文件:行：`apps/agent-service/src/production-memory-recall.ts:196`；测试 `apps/agent-service/test/production-memory-recall.unit.test.ts:181-183`
- 类型：读代码证实
- 问题：作者说“待确认最多占返回条数的一半”。但实现用 `Math.floor(input.limit / 2)`，当正式记忆不够、结果少于 `limit` 时，待确认占比会超过一半。新增的反向用例本身就把这个行为固定下来：`limit: 4` 只返回 3 条，其中 2 条是待确认，已超过“返回 3 条的一半”。
- 证据：
  ```ts
  const tentativeLimit = Math.floor(input.limit / 2);
  ```
  ```ts
  // 测试：limit 4，期待 2 条 tentative，同时结果只有 3 条
  const result = (await f.service.recall(call({ query: "x", limit: 4 }))) as RecallResult;
  expect(result.memories.filter(({ tentative }) => tentative)).toHaveLength(2);
  ```
  另外 `limit=1` 且只有待确认命中时，返回空 `memories`，`note` 仍是 `TOOL_RESULT_RECALL_EMPTY` 的“没有找到相关的记忆或对话摘要”（`:246-250`），但实际存在待确认命中。
- 建议：要么把规则明确写成“最多占请求上限的一半”，要么按最终 `memories.length` 收紧/补齐；`limit=1` 只有待确认命中时，考虑用一句不否认其存在的说明，而不是“没有找到”。

### 3. 低：名为“逐字节相同”的反向用例其实没有验证字节相同

- 文件:行：`apps/agent-service/test/production-memory-recall.unit.test.ts:166-172`
- 类型：读代码证实
- 问题：该用例只有一条正式记忆，只断言没有 `tentative` 字段、没有 `tentativeNote`，没有比较完整 JSON/字段顺序，也没有覆盖多条正式记忆的排序，因此不能证明“没有待确认记忆时返回值与原来逐字节相同”。它也无法发现下面第 4 条那种“待确认存在但被过滤”导致的正式结果变化。
- 证据：
  ```ts
  it("[PA-2] REVERSE: confirmed memories look exactly as before and add no tentative note", async () => {
    const f = recallWith([{ id: "fact", text: "主人住在杭州", score: 1 }]);
    ...
    expect(result.memories[0]).not.toHaveProperty("tentative");
    expect(result).not.toHaveProperty("tentativeNote");
  });
  ```
- 建议：用改前的返回值做完整快照/`JSON.stringify` 比较，至少准备多条同分和不同分的正式记忆；再补一条“数据库里有一条不可返回分类的待确认记忆”的用例。

### 4. 低（推测）：待确认记忆即使最终不返回，也可能改变正式记忆的顺序

- 文件:行：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:240-243`、`packages/memory-engine/src/fusion.ts:88-97`、`apps/agent-service/src/production-memory-recall.ts:200-207`
- 类型：推测（机制可读出，未构造真实数据跑）
- 问题：`includeTentative` 只放宽了 SQL 的 `indexScope`，分类过滤是在 `ProductionMemoryRecall` 里最后才做的。融合阶段按每个信号列表里的名次累加 RRF（`weight / (rrfK + rank + 1)`）。一条最终会因分类过高而被丢弃的待确认记忆，如果插在某个正式记忆前面，也会把后者的名次往后推、分数降低，从而改变正式记忆的排序甚至入选结果。也就是说“正式记忆看起来和以前一样”只在库里完全没有待确认记忆时成立；有待确认记忆但被过滤时不一定。
- 建议：在索引/融合阶段就按本次请求允许的分类过滤，或为待确认记忆单独排序后再与正式结果合并，避免不可见条目影响正式结果。

### 5. 未核实：新提示词的 manifest 摘要

- 文件:行：`packages/prompt-catalog/prompt-manifest.json:431-435`
- 类型：未核实
- 说明：`prompt-catalog.unit.test.ts:172-173` 的摘要是 `sha256(JSON.stringify(entry.segments))`。允许的工具里没有可计算 SHA-256 的命令，无法确认 `e7421b...` 是否与 `background.ts:94-101` 的文本一致；若摘要不对，`npm run check:prompt-catalog` 会直接失败。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只发生在 `recall` 工具的返回值里（`production-memory-recall.ts:215-250`），工具定义 `memoryRecallDescriptor`（`:29-48`）和系统提示目录文字都没有改；工具结果由 `production-runtime-tools.ts:664-671` 追加并序列化。本次涉及的每轮变化值（`tentative`、`tentativeNote`、检索到的记忆）都在这次工具调用的结果消息里，不在请求开头。依据的“只追加”规则满足。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
本次新增的值本身是确定的：`tentative` 来自存储的 `attributes.tentative`，说明文字是固定的提示词，排序比较器有 `score`、`tentative`、原始下标三级 tie-break，不依赖对象遍历或无序集合。没有新增时间、哈希或遮盖相关字段。需要保留的例外是第 4 条：待确认记忆存在但被过滤时，正式结果的顺序可能被融合名次影响；这是数据库状态决定的，不是同一输入下的随机字节。

**3. 有没有对应的自动检查，反向用例是否真会失败？**
有新增单测，但覆盖不足：
- 第一条用例在去掉同分时“正式在前”比较器时确实会失败（mock 返回顺序是 guess、fact）。
- 配额反向用例在去掉 `tentativeCount` 判断时会失败（会返回 3 条 tentative）；把 `floor` 改成 `ceil` 时 `limit=1` 那条也会失败。
- 但“逐字节相同”的反向用例只检查两个字段是否存在，且只有一条正式记忆，防范不了排序变化（第 3 条）。
- 没有覆盖第 1 条的“待确认挤占 3 倍名额导致漏掉正式记忆”，也没有覆盖第 4 条的“待确认被分类过滤但仍影响正式排序”。
- manifest 摘要是否被校验由 `prompt-catalog.unit.test.ts` 负责，但摘要值本身未核实。

**4. 新增/修改的每个值，使用它的地方都能接受吗？**
- `includeTentative: true`：`MemoryProviderProjectionPort.search` 接受该可选字段（`packages/application/src/ports/memory-projection.ts:201`），`HybridMemoryProvider.search` 会继续传给索引（`hybrid-memory-provider.ts:165`），SQL 端有对应参数（`sqlite-memory-operations.ts:1079`，过滤在 `:242`）。两端一致。
- `tentative` 属性：`ProductMemoryAttributes.tentative?: boolean`（`memory-projection.ts:36`），SQLite 读取时写回 `attributes.tentative`（`sqlite-memory-operations.ts:493`）；`production-memory-recall.ts:184-185,208` 的读取类型成立。
- 输出里的 `tentative: true`：只进入工具结果 JSON，没有后端 schema 或下游解析器要求固定字段；`production-runtime-tools.ts:671` 直接 `JSON.stringify`，可接受。
- 输出里的 `tentativeNote`：同样只进入工具结果 JSON，没有下游解析器；`prompt-catalog.unit.test.ts` 的 tool-result 字面量扫描不会误扫到它（正则只匹配小写 `note:`），值是目录里的固定文字。
- 新提示词 id `tool-result.recall-tentative`：`background.ts:94` 定义、`index.ts:1` 重导出、manifest 有登记，命名和 `usedBy`（`production-memory-recall.ts`）一致；摘要在上面标为未核实。
- ADR/作者说法层面有一处不一致：`pending` 上限实际按请求的 `limit` 计算，不是按“返回条数”计算（第 2 条）；“没有待确认记忆时逐字节相同”在“库里完全没有待确认记忆”时成立，但在“有待确认记忆却被过滤”时不成立（第 4 条）。
