**这一轮查过的范围**：我先看了 `git diff 8e75d0b..ca95acb` 和增量 `git diff b76d951..ca95acb`，增量的有效代码提交是 `89ad002`（memory_open 密级与空正文页长）和 `e88e547`（生产进程测试），其余大量 CI 文件来自 main 合并，与本 PR 无关。逐项读了 `production-memory-open.ts`、`service-main.ts`、`production-runtime-tools.ts`、`production-memory-recall.ts`、`production-conversation-tools.ts`、prompt catalog、迁移与 sqlite 记忆操作、`durable-adapters.ts`、`schema-catalog.ts`、相关单测/集成测试，并跟到 `thread-prompt-bundle-service.ts`、`pi-runtime-adapter.ts`、`data-export/snapshot.ts`、`data-export/import.ts`、`model-visibility.ts` 和设计文档。没有运行测试，以下结论均来自读代码。

### 1 中 memory_open 的结果密级按所有页、所有版本计算，而不是按这次真正返回的那一页，可能过早抬高整轮可见密级，且与“作者说法 5”不一致

文件：`apps/agent-service/src/production-memory-open.ts:162-169`、`:220-247`、`:250-255`

问题：`shownClassifications` 在选页之前就把当前记忆、所有版本的正文和原话的可见密级都收集进来；`pages` 也是先把全文和全部版本分好页，`const shown = pages[page - 1]` 才选页，但最后返回的 `contentClassification` 用的是整份 `shownClassifications`。所以请求第 1 页、而第 5 页才有一条 sensitive 旧版本时，第 1 页只有 private 内容也会被标成 sensitive。`#raiseVisible` 会据此抬高整个 run 的可见密级；如果当前模型配置只接受 private（例如本仓库测试里的 `allowedDataClassifications: ["public", "private"]`），后续模型调用会被 model router 拒绝。作者说法 5 写的是“取请求密级和这条记忆密级里高的一个”，与代码已经不一致。

证据：
```ts
const shownClassifications: DataClassification[] = [memory.dataClassification];
const visibleText = async (ref: PayloadRef): Promise<string | null> => {
  const read = await this.#options.readText(ref, scope);
  if (!read || !modelVisibleClassifications().includes(read.dataClassification)) return null;
  shownClassifications.push(read.dataClassification);
  return read.text;
};
...
const shown = pages[page - 1];
...
contentClassification: highestClassification(
  invocation.dataClassification,
  shownClassifications,
),
```
下游：`packages/runtime-pi/src/pi-runtime-adapter.ts:2312-2313` 调用 `#raiseVisible(request.runId, result.contentClassification, request.dataClassification)`。

建议：按页保存密级（例如 `ShownVersion`/`ShownPage` 带 `classifications`），选页后只汇总 `shown` 里的内容；或者选页时再计算。增加一条反向测试：第 1 页 private、后面页有 sensitive 旧版本，断言打开第 1 页的 `contentClassification` 仍是 private。若确实想“读过就算，不管哪一页”，应把作者说法 5 和工具说明改准。

### 2 中低 新增的 memory_numbers / memory_number_counters 没有进入可移植导出/导入和导入目标空检查，导出再导入后编号会重排

文件：`packages/persistence-sqlite/src/data-export/snapshot.ts:8-43`、`:59-68`；`packages/persistence-sqlite/src/data-export/import.ts:87-101`、`:518-526`；迁移 `packages/persistence-sqlite/src/migrations/20261124205713_memory_numbers.sql:8-22`

问题：`PortableSnapshot` 和 `readSnapshot` 只导出 `memory_records`/`memory_history_events` 等字段，没有 `memory_numbers`；导入只 `INSERT INTO memory_records`，编号由迁移的 AFTER INSERT 触发器重新分配。`EMPTY_TARGET_TABLES` 也只查 `memory_records`，没有查 `memory_number_counters`。因此把一个实例的记忆导出后导入另一个实例（或清空记忆但计数表还在的实例），同一个记忆的短编号会变化，旧对话/旧导出里已经出现的编号可能指向别的记忆。这是 I-73 那类“新值只在产生端被考虑”的缺口。

证据：
```ts
const memories = all(
  `SELECT id, status, revision, classification, ... FROM memory_records
   WHERE ... ORDER BY COALESCE(recorded_at, updated_at), id`,
);
...
const memory = database.prepare(
  `INSERT INTO memory_records (
    id, owner_id, agent_id, ... ) VALUES (...)`,
);
```
触发器：`INSERT INTO memory_number_counters ... DO UPDATE SET last_number = last_number + 1`，随后把新编号写进 `memory_numbers`。

读代码证实：两张表不参与导出/导入，导入后编号由触发器重排。推测：如果产品把“导出/导入”当作恢复或迁移路径，旧对话/旧决策里的编号引用会变；如果编号明确只是实例内短标识，则应写清楚并在导入时清空计数表，避免从 N 开始。建议在导出格式中带上 `memoryNumbers` 和计数器，或明确声明编号不跨实例，并补一条导出→导入的 I-73 式往返测试。

### 3 低 修红测试时 P3-2 只断言“轮索引嵌入存在”，没有断言已结算或数量，重复或失败的轮索引调用会被漏掉

文件：`test/integration/production-http-composition-process.test.ts:1911-1917`、`:1552-1560`、`:1662-1677`

问题：`turnIndexEmbeddings` 只按 `logical_slot LIKE 'conversation-turn-%'` 查；P3-2 用 `.length > 0` 判断“有轮索引嵌入”，不检查 `status`，也不检查是否只有一条。因此同一轮如果多出一次轮索引嵌入（多余调用/重复计费），或者这次嵌入最终失败，测试仍会通过。`NOT LIKE` 还会把 `logical_slot` 为 NULL 的 embedding 排在结果之外。R2-L5 的 `.toBe(6)` 和精确 source 列表能抓住当时已落账的多余调用，但 poll 成功之后才发生的调用仍有时间窗。

证据：
```ts
"SELECT source, status FROM model_invocation_identities WHERE run_id = ? AND source = 'embedding' AND logical_slot NOT LIKE 'conversation-turn-%'"
...
await expect
  .poll(() => turnIndexEmbeddings("run:memory-fallback-recall").length, { timeout: 30_000 })
  .toBeGreaterThan(0);
```
建议：P3-2 至少断言轮索引 embedding 的 `status` 为 `settled`，需要防重复时按 run 断言精确条数（或按预期轮数）；如果 `logical_slot` 可能为 NULL，用 `logical_slot IS NULL OR ...` 明确处理。

**侧重检查**

- 错误路径/不可信输入：`memory_open` 检查了多余参数、`number`/`page` 为正安全整数、页越界抛 `MemoryOpenInputError`；`pi-runtime-adapter.ts:325-327` 的 `safeArguments` 把 null/数组/非对象变成 `{}`，所以缺 `number` 会落到 `MEMORY_OPEN_INPUT_INVALID`。`byNumber` 还校验 `ownerId`/`agentId`，并在 `read` 后复核；跨 agent 测试存在。未发现新的输入错误映射错误。
- 安全：第 3 轮意见 1 已改好——旧版本正文和原话现在按 payload 的 `dataClassification` 过滤，restricted 内容返回 null，不再只按当前记忆密级判断；结果密级也包含可见 payload 的密级。当前确认为 `memory.dataClassification` 是 restricted 的记忆仍按 `missing` 处理；如果只是当前正文 payload 为 restricted 而记忆记录是 private，代码会返回 `found:true, text:null`，是否应整体按“没有这个编号”仍需产品确认（未核实产品语义）。
- 资源/不可逆操作：`memory_open` 只读，不产生不可逆操作；迁移只新增表和触发器。注意每次打开任意一页都会读取、解密并分页全部版本，正文极长或版本极多时单次调用成本与页数无关地增长；这是既有设计，本轮未改。
- 规则/文档一致性：工具定义确实排在工具列表最后，`production-runtime-tools.unit.test.ts` 锁住了 memory_open 之前的定义；但已有对话的 `identity.toolNames` 变化会触发 `thread-prompt-bundle-service.ts:89` 的 `tool_set_changed`，第一次运行会重建一次冻结工具包（属于规则第 6/7 条的换新例外，详见必答问题 1）。设计文档 `docs/execution/specs/2026-11-24-memory-redesign-design.md:82` 写“新加一列”，实现是两张新表，文档与实现不一致；作者说法 5 也与当前代码不一致（见意见 1）。
- 测试：迁移编号、不可复用、跨 agent、分页、非法输入有自动检查，反向用例（删除后不复用）会真的失败；密级新单测能证明旧逻辑会泄漏 restricted 旧版本。缺口是本轮没有“后续页有 sensitive 旧版本时当前页仍应 private”的反向用例，没有导出/导入往返用例，P3-2 的轮索引检查偏弱。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 系统提示：没有改；`memory_open` 没有 `promptSnippet`/`promptGuidelines`，`productSystemPrompt` 不会因它多出文字。工具定义：新定义排在工具列表最后，之前所有工具定义逐字节不变（单测哈希锁住）。历史消息和遮盖规则：不改，memory_open 的输出和 recall 新增的 `number` 都只作为新的工具结果追加在末尾。但要准确回答“只在末尾追加”：对已有对话不是严格的字节级只追加——`thread-prompt-bundle-service.ts:89` 比较工具名数组，多出 `memory_open` 会判为 `tool_set_changed` 并重建一次冻结工具包，工具 JSON 在原来最后一项之后插入新项（原数组的结尾 `]` 位置变了），因此已有对话部署后第一次运行会换新一次请求开头；这是 prompt-prefix 规则第 6/7 条允许的工具集变更例外，且原有工具、系统提示、历史内容本身都没变。每轮会变的值（编号、status、时间、版本）都在最后追加的工具结果里，不在头部。
2. **同一段文字会不会在不同请求里变成不同字节？** 本轮新增的 `number`、`memory_numbers`、页布局都是确定性的：版本按 `occurredAt`/`id` 排序，编号查询按 `number` 排序，`numbers` 去重不依赖 SQL 返回顺序。`memory_open` 的 `status`/`validTo` 和 recall 的 `current` 依赖 `now()`，所以同一条记忆在不同时刻打开可能出现不同 `status`，但它们只出现在新追加的工具结果里，不会改已发头部。既有风险：`production-memory-open.ts:178` 用 `localeCompare` 排版本，理论上受运行环境 locale 影响；本轮未改。除此之外未发现新的依赖前后文遮盖、时间字段或无序集合进入请求开头。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：`test/integration/memory-numbers.test.ts` 覆盖迁移编号、按 agent 分开、删除后不复用、跨 agent `byNumber`、分页、非法输入；`production-memory-open.unit.test.ts` 新增了“隐藏 restricted 版本/原话并取最高已示密级”的正向用例和“同密级版本全部显示”的反向用例，旧代码会在正向用例上失败（旧代码返回 restricted 文本、密级 private）。`conversation-turns.test.ts` 覆盖页码超过最后一页时的新说明。缺口：没有覆盖“后续页敏感、当前页 private”的反向用例；没有导出/导入往返用例；也没有“真正没有搜索结果时仍返回 EMPTY 而不是 NO_MORE”的直接反向用例。另外新单测里的 `not.toContain("restricted")` 断言很弱（测试文本本来就不含这个词），真正起作用的是 `text:null`/`quote:null` 断言。
4. **改动产生或修改的每个值，使用端都能接受吗？** `MemoryOpenText`/`readText` 新返回形状的调用端只有 `service-main.ts` 和两个测试，均已同步；`service-main` 返回的 `payload.dataClassification` 是合法的 `DataClassification`，`highestClassification` 能接受。`memory.open`、`owner-memory-record`、`MEMORY_OPEN_*`、`memory_open` 在工具动作表、预检表、运行时分发和测试里都成对存在；prompt-manifest 的新 id 与 `fixedPrompt` 的 id 一致，prompt-catalog 的 `index.ts` 也整体导出了 `tools.js`。`recall` 的 `number` 字段有精确输出测试，序号查询在 sqlite 操作和 durable adapter 两端都注册。`contextWindow: 32768` 与 `test/fixtures/product-path-configuration.ts:66` 一致，也在配置上限内。**不能接受/缺失的一处**是上面的可移植导出/导入：`memory_numbers`/计数器没有被导出或导入，编号会被触发器重排；另外设计文档说“新加一列”而实现是两张表，需要更新或确认。
