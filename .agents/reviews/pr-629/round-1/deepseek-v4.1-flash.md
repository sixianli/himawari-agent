### 1 高 新表没有登记进 schema-catalog，迁移契约测试会直接失败
文件:行：`packages/persistence-sqlite/src/migrations/20261124205713_memory_numbers.sql:1`、`packages/persistence-sqlite/test/migration-engine.contract.test.ts:75`
问题：迁移新建了 `memory_number_counters` 和 `memory_numbers`，但 `packages/persistence-sqlite/src/schema-catalog.ts` 没有对应条目。现有契约测试把数据库里的实际表名与 `schemaCatalog` 做全等比较：

证据（已核实）：
```ts
const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")...
expect(tables).toEqual(schemaCatalog.map(({ table }) => table).sort());
```
`schemaCatalog` 目前只有 `memory_records`、`memory_history_events` 等旧表，没有这两张新表。这个测试是现有自动检查，本改动会把它跑红，不是“只加不改”就够。
建议：在 `schema-catalog.ts` 为两张新表补 entry，明确 productPort、生命周期、`metadata_only`、删除关系（随 memory 级联；计数器随 owner/agent 删除）。如果确实不该进目录，则必须同步改契约测试和文档说明原因，不能默认漏掉。

### 2 高 每页 JSON 总长可能远超 pageCharacters，作者说法 3 不成立
文件:行：`apps/agent-service/src/production-memory-open.ts:122`、`143-176`
问题：`head.text` 是记忆全文，被放进每一页，却从未截断或分页。只要记忆正文本身超过 `pageCharacters`，每页都会超预算；`room = Math.max(1, ...)` 也无法压缩 `head`。这不是理论值：MCP 同步允许 note 正文默认 20,000 字符、上限 60,000 字符（`packages/application/src/ports/mcp-memory-sync.ts:43-57`），而 `pageCharacters` 的最小值只有 2,000。

证据（已核实）：
```ts
const text = (await this.#options.readText(memory.contentRef, scope)) ?? null;
...
const head = { number, found: true, text, ... };
...
let used = JSON.stringify({ ...head, versions: [], nextPage: MAXIMUM_PAGE }).length;
const fixed = used;
```
另外，`clipped` 按 Unicode 字符数截断（`production-memory-open.ts:74-78`），而每页大小用 `JSON.stringify(version).length` 计算（`:168`）。引号、反斜杠、换行等转义后长度会膨胀；且单个版本在空页时会被无条件 `current.push(version)`（`:169-174`），此时即使 `size` 超预算也仍会输出。现有 330 字符分页测试只用了短中文，不会失败。
建议：不要把全文塞进每页 head；正文单独分页或首页只给截断摘要。最终预算应按转义后的实际序列化长度计算，并对“一页放不下单个版本”的情况强制再截断或明确失败。补长正文、含大量引号/换行/控制字符的反向用例。

### 3 中 分页边界不一致：超过最后一页静默空，`nextPage` 还可能指向非法的第 101 页
文件:行：`apps/agent-service/src/production-memory-open.ts:16`、`33-34`、`102`、`177-184`
问题：`MAXIMUM_PAGE` 是 100，`page` 超过 100 会抛 `MEMORY_OPEN_INPUT_INVALID`；但 `nextPage` 只按 `page < pages.length` 生成，没有夹到 100。版本很多时 `pages.length` 可以超过 100，第 100 页会返回 `nextPage: 101`，模型按提示去打开第 101 页必然得到输入非法，剩余版本永远看不到。反过来，`page` 只是超过实际页数（例如只有 2 页却请求第 5 页）时，返回 `found: true`、`versions: []`、无 `nextPage`、无说明，模型会误以为没有版本。作者说法 4 里的“page 越界一律输入非法”只对 page>100 成立，对“超过实际页数”不成立。
证据（已核实）：
```ts
...(page < pages.length ? { nextPage: page + 1 } : {}),
```
以及：
```ts
const page = args["page"] === undefined ? 1 : wholeNumber(args["page"], MAXIMUM_PAGE);
```
建议：要么让 `nextPage` 永远不超过 100（并说明版本太多），要么提高/去掉 100 的上限；超出实际页数时像 `conversation_search` 一样返回“前面几页已列完，没有更多版本”的 note，或明确规定为输入非法。补 page=pages.length+1 和 pages.length>100 的用例。

### 4 中 导出导入会重新编号，恢复后旧对话里的 number 可能指向别的记忆
文件:行：`packages/persistence-sqlite/src/data-export/snapshot.ts:59-68`、`packages/persistence-sqlite/src/data-export/import.ts:87-101`、`518-526`、迁移 `20261124205713_memory_numbers.sql:24-34`
问题：导出只取 `memory_records` 的既有字段，没有导出 `memory_numbers` / `memory_number_counters`；导入用普通 `INSERT INTO memory_records`，会触发新触发器按导入顺序重新发号。原库只要出现过删除造成的编号空洞、或 restricted 记忆未导出、或目标计数器已经大于 0，恢复后的编号就不再等于导出时。已经存进历史工具结果里的“第 7 条”在恢复后可能打开另一条记忆或打不开，违反“编号固定不变”的用户可见语义。
证据（已核实）：`snapshot.ts` 的 `SELECT` 列表里没有 number；`import.ts` 的插入是普通 `INSERT INTO memory_records`；触发器在每次插入后从 `memory_number_counters` 取下一个号。
建议：明确产品语义。若编号要跨导出/导入稳定，导出并导入 `memory_numbers` 和计数器，校验完整性；若不要求，至少写进文档/ADR，并考虑旧工具结果中的编号失效处理。补一个带删除空洞的导出导入反向用例。

### 5 中 打开记忆前会读出并解密全部历史版本，版本超过 1000 条则永远打不开
文件:行：`apps/agent-service/src/production-memory-open.ts:128-141`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:993-1001`
问题：分页只作用于最终 JSON；为了构造 `versions`，代码先对所有历史事件逐条 `await readText(event.contentRef)` 和 `await readText(event.quoteRef)`。`listHistory` 硬上限 1000 条，超过后直接抛 `PORT_INVALID_OPERATION`，被映射成 `MEMORY_OPEN_UNAVAILABLE`，这条记忆永远打不开。单条记忆正文可达数万字符，1000 个版本会产生很大的解密、内存和 CPU 开销；模型可以用新的 toolCallId 反复触发。
证据（已核实）：
```ts
const events = await this.#options.state.listHistory({ ...scope, memoryIds: [memory.id] });
for (const event of [...events].sort(...))
  versions.push({
    text: (await this.#options.readText(event.contentRef, scope)) ?? null,
    quote: event.quoteRef ? ... : null,
```
以及 `listHistory` 的 `if (input.memoryIds.length > 1000) fail(...)`（这里长度是 1，真正限制在 SQL 返回行数，但 1000 上限对应的是 memoryIds 数量，不是事件数；实际上 SQL 没有 LIMIT，超过 1000 个事件不会在这里报错，而是全部读出。更准确地说，是“不限量读取全部事件”，资源风险成立；“超过 1000 条打不开”这一点需修正：`listHistory` 的 1000 限制是 `memoryIds.length`，不是事件条数）。
建议：先按页读取历史事件，只读当前页需要的版本和原话；或给 `listHistory` 增加按事件分页/数量上限，并限制单次 `memory_open` 读取的版本数。补大量历史版本和长正文用例。上面“超过 1000 个事件必然报错”的部分是推测，已核实的是全量读取无分页。

### 5 说明
上面第 5 条标题里“版本超过 1000 条则永远打不开”与代码不符：`sqlite-memory-operations.ts:999` 的 1000 限制检查的是传入的 `memoryIds.length`，而 `memory_open` 只传 1 个 id，所以不会因此报错。实际问题是全量读取没有上限，资源风险成立；标题和结论应以“全量读取”为准，`1000 条事件上限`是推测，未核实。

## 侧重检查

- 迁移与 FK/级联：查看了新表、触发器、计数器；删除 `memory_records` 时编号级联删除、计数器不回退，符合“永不复用”。未发现 SQL 注入（全部参数化）。
- 编号查询范围：`numbers`、`byNumber` 都带 `owner_id + agent_id` 条件；`ProductionMemoryOpen` 还会再核对 `read()` 返回记录的 owner/agent，跨 agent 取数没有发现漏洞。
- 不可信输入：`number` 用 safe integer + >=1 校验；`page` 限制 1..100；多余参数直接拒绝；`arguments` 在 Pi 适配器里会被规范成对象。输入错误映射正确，内部错误会落到 `MEMORY_OPEN_UNAVAILABLE`，没有把异常文本透给模型。
- 隐藏数据：`restricted`、`deletion_pending`、`deleted_verified` 会返回“没有这个编号”；`trashed` 返回状态 `trashed`，与作者说法一致。
- 错误路径：`readText` 返回 undefined、`listHistory`/`byNumber` 抛错、`read` 抛错都会走 `MEMORY_OPEN_UNAVAILABLE`；但 `memory_open` 会把单个版本读取失败放大成整条不可用，属于可用性问题。
- 外部内容标记：成功打开且 `memory.sourceRefs` 含外部内容时会记 `recalled_external_record`，与 recall 一致；未找到时不标记。
- 规则/文档一致性：prompt-manifest 新增条目齐全，工具描述没有日期/哈希等易变值；但 schema-catalog 漏登记两张新表，迁移契约测试会失败，这是明确的不一致。
- 导出导入：新编号值没有被导出；恢复后由触发器重新发号，稳定性存疑。
- 对话工具：`conversation_search` 超过最后一页时改为 `TOOL_RESULT_CONVERSATION_NO_MORE`，逻辑与测试一致；`pages.length === 0` 仍是“没有找到”。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   已发出的系统提示、历史消息没有被改写；`memory_open` 定义追加在整个工具列表末尾（`production-runtime-tools.ts:631-638`），原有工具定义没有改动（测试中 `TOOL_DEFINITIONS_BEFORE_CONVERSATIONS_SHA256` 未变）。但“工具集合”发生了变化，按 prompt-prefix 规则第 6/7 条，已有对话下一轮会触发一次冻结头换新，那个对话的请求开头会变一次；这属于规则允许的“工具集合变了”路径，不是每轮变化。换新后是否能保持后续稳定，取决于既有冻结机制，运行时代码我没有完整跟踪，标为未核实。每轮会变的 `status`（依赖 `now()`）只出现在 memory_open 的工具结果里，属于末尾追加的内容，不在工具定义或系统提示中。

2. **同一段文字会不会在不同请求里变成不同字节？**
   当前记忆正文、版本正文、原话都是按原文读取；输出对象的键顺序固定；编号由数据库持久化，同一记忆稳定（正常库内）。没有发现依赖前后文的遮盖或带时间的系统提示。有一个低风险点：版本排序用了 `localeCompare`（`production-memory-open.ts:130-132`），理论上受区域设置影响；虽然输入是定长 ISO 时间戳，风险低，建议改成普通字符串比较以彻底确定。`status` 依赖当前时间，但只影响新追加的工具结果，不影响已发字节。导出/导入重新编号是跨恢复场景的稳定问题，见第 4 条。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：`test/integration/memory-numbers.test.ts` 覆盖迁移补号、删除后不复用、按编号打开、`correctedBy`、状态、restricted 隐藏、分页和非法参数；`production-runtime-tools.unit.test.ts` 覆盖工具列表末尾、结果回放、外部内容标记和错误映射；对话集成测试覆盖超过最后一页的 `NO_MORE`；prompt-manifest 测试锁定新文案。反向用例中，“删除后复用编号”和 restricted 隐藏如果实现回退会失败。
   缺口：长正文/转义字符不会触发预算用例（当前 bug 能通过）；page 超过实际页数、`nextPage > 100` 没有用例；`deletion_pending` / `deleted_verified` 没有用例；`numbers()` 的跨 agent 过滤没有直接用例；导出后导入保持编号没有用例；新表漏登记 schema-catalog 会被现有契约测试抓住，但说明改动未通过自动检查。
   另：`[PA-2] REVERSE: with no tentative memory the result is exactly what it was before` 现在也期待 `number` 字段，名字说“和以前完全一样”但与新格式不一致，已不能再反向保护旧输出字节。

4. **每个新值的产生者和使用者是否对得上？**
   - `memory.open`：描述符、工具动作登记行、registry 的 `forCapability` 都使用同一常量，匹配。
   - 工具名 `memory_open`：描述符与登记行一致，`ToolActionRegistry.offer` 按名字过滤能接受。
   - 新 reasonCode `MEMORY_OPEN_OWNER_SCOPE`：`PI` 适配器的 `POLICY_BLOCKED_TEXT` 没有专门文案，会落到“产品策略不允许本轮执行这项操作”的通用兜底（`pi-runtime-adapter.ts:422-435`），功能上能接受，但不如给记忆打开一条清晰文案。
   - 新端口方法 `numbers` / `byNumber`：durable adapter 以 `memory.` 前缀分发，`SqliteMemoryOperations` 的 switch 已接住；两端签名一致。
   - 新表 `memory_numbers` / `memory_number_counters`：数据库内部使用没问题，但 `schema-catalog` 没有登记（测试失败），数据导出/导入没有接住（恢复后重新编号）。
   - recall 的 `number` 字段：输出是 JSON 工具结果，没有外部 schema 校验会拒绝；当前测试已更新。
   - prompt 清单项：manifest 有对应 id 和 hash，能够被 catalog 测试接受。
   结论：多数两端对得上，问题集中在 schema 目录、导出导入和分页边界。
