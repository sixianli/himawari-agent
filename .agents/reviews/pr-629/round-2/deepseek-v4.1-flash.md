**本轮范围**：读了 `git diff 1bf660d..e7f93e1` 与增量 `git diff f1ef788..e7f93e1`；增量真正相关的只有提交 `6011c1404`（`schema-catalog.ts`、`production-memory-open.ts`、新增单测），其余是 main 合入的 PR 625/628。逐行读了 `production-memory-open.ts`、新迁移、`schema-catalog.ts` 相关段、`migration-engine.contract.test.ts`、`schema-contract.contract.test.ts`、`sqlite-memory-operations.ts` 的 `numbers/byNumber`、新单测、`production-runtime-tools.ts` 的 `#memoryOpen` 与描述符拼接、`TOOL_MEMORY_OPEN`、`TOOL_RESULT_CONVERSATION_NO_MORE`、`prompt-prefix.md`。没有运行测试（工具受限），运行结果均为未核实。

**上一轮意见核对**
- 意见 1（schema-catalog）：已修好。`schema-catalog.ts:589-604` 登记了两张表；`migration-engine.contract.test.ts:75-80` 用 `sqlite_master` 全表与目录逐项相等，缺表必然失败。读代码证实。
- 意见 2（每页总长）：预算推导在 `pageCharacters>=2000` 的路径上成立（头部和每个版本都按 `serializedLength` 截断），但付出了“正文被截断且无法翻页取回”的代价，见下面意见 1。读代码证实 + 推导。
- 意见 3（分页边界）：越界页现在抛 `MemoryOpenInputError`，`nextPage` 不会再是 101；但第 100 页以后仍有版本时改为静默不出现 `nextPage`，见意见 2。读代码证实。

**作者说法核对**
1. 迁移与测试和说法一致（`ORDER BY COALESCE(recorded_at, updated_at), id`、按 owner/agent 分区、计数器只增），但迁移不在增量内，未运行测试。
2. 成立：`sqlite-memory-operations.ts:1021-1049` 的 `numbers/byNumber` 都带 `owner_id`/`agent_id` 条件；集成测试也覆盖了别的 agent。
3. 总长在真实配置（最低 2000）下成立；但“只截断版本正文和原话”不完整——头部正文也被截断；且超过 100 页时后段版本不可达。
4. 成立：`production-memory-open.ts:110-114,195-196` 抛输入错误，`production-runtime-tools.ts:912-921` 映射为 `MEMORY_OPEN_INPUT_INVALID`/`MEMORY_OPEN_UNAVAILABLE`，不把内部 message 放进结果。
5. 成立：`production-memory-open.ts:203-205` 取两者较高密级。

### 1 中 超长记忆正文被截到约半页且没有下一页，memory_open 拿不回“全文”
文件: `apps/agent-service/src/production-memory-open.ts:168-172`、`:194-202`、`packages/prompt-catalog/src/tools.ts:63`
问题: 头部 `text` 被 `fitted` 到 `floor((budget-headBare)/2)+2`，而 `pages` 只装 `versions`，`nextPage` 只看 `page < pages.length`。当 `versions` 为空，或正文不等于某个版本正文时，被截掉的后半段永远没有入口；工具说明却写“看它的全文”。
证据（读代码证实）:
```ts
const headBare = serializedLength({ ...headWithoutText, versions: [], nextPage: MAXIMUM_PAGE });
const head = { ...headWithoutText, text: fitted(text, Math.floor((budget - headBare) / 2) + 2) };
...
if (current.length > 0 || pages.length === 0) pages.push(current);
const shown = pages[page - 1];
if (!shown) throw new MemoryOpenInputError();
...(page < pages.length && page < MAXIMUM_PAGE ? { nextPage: page + 1 } : {}),
```
`tools.ts:63`：“按编号打开一条记忆，看它的全文……结果里有 nextPage 时，版本没列完”。新单测 `production-memory-open.unit.test.ts:85` 还断言每一页的 `text` 都以 `…` 结尾，等于把截断写死，没有覆盖“跨页拼回全文”。
触发面（读代码 + 推测）: `toolResultCharacters` 最低 2000（`production-conversation-tools.ts:31,79-83`），小窗口/未知窗口时约 900 序列化字符即截断；大窗口 1M×2% 约 2 万字符才触发。正常后台抽取对正文限 500（`production-memory-capture.ts:79,364`），但导出导入 schema 允许 1,000,000 字符文本（`packages/persistence-sqlite/src/data-export/schemas.ts:37`），导入/遗留/合并产生的长记忆会命中；具体导入写入路径未逐条跟踪，标为推测。
建议: 把头部正文也纳入分页（或至少当 `versions` 为空时用整页预算），并加“所有页的正文拼接等于原文”的正向用例；若确定只给预览，就不要在工具说明里承诺全文，并返回明确的截断标记。

### 2 中 第 100 页之后仍有版本时 nextPage 被删掉，后段版本静默丢失
文件: `apps/agent-service/src/production-memory-open.ts:201`、`apps/agent-service/test/production-memory-open.unit.test.ts:110-121`
问题: `page` 上限是 100，`nextPage` 又加了 `page < MAXIMUM_PAGE`。当实际页数超过 100 时，第 100 页明明还有后续版本，却不给 `nextPage`，也没有任何说明；模型会以为版本已经列完。
证据（读代码证实）:
```ts
...(page < pages.length && page < MAXIMUM_PAGE ? { nextPage: page + 1 } : {}),
```
新测试自己构造了 150 个长版本（每页约一个，共约 150 页），却断言第 100 页没有 `nextPage`：
```ts
const tool = memoryTool({ text: "短", versions: 150, versionText: "长".repeat(2000), pageCharacters: 2000 });
const last = await tool.open(call({ number: 1, page: 100 }));
expect(last.output).not.toHaveProperty("nextPage");
```
即后 50 个版本不可达，且测试把这个行为固定成了期望。
建议: 要么允许 `page` 超过 100（与 `pages.length` 对齐），要么在第 100 页且 `pages.length>100` 时返回明确的“还有更多但超出翻页上限”说明；不要既不给 `nextPage` 也不提示。测试应改为能发现丢失，而不是断言丢失。

### 3 低 “memory_open 之前所有定义未变”没有被测试真正锁住
文件: `apps/agent-service/test/production-runtime-tools.unit.test.ts:2190-2194`、`:2389-2417`
问题: 作者说“测试锁住了 memory_open 之前所有定义的哈希，等于 main 的”，但断言用的是 `descriptors.slice(0, -3)`，末尾三项是 `conversation_search`、`conversation_open`、`memory_open`。也就是说 `conversation_search/open` 这两个位于 `memory_open` 之前的定义并没有被这个“等于 main”的哈希锁住。
证据（读代码证实）:
```ts
.update(JSON.stringify(descriptors.slice(0, -3)))
```
```ts
"conversation_search",
"conversation_open",
"memory_open",
```
本次 diff 确实没有改这两个描述符，所以事实成立；但测试没有提供作者声称的保证。
建议: 改成 `slice(0, -1)` 锁定 `memory_open` 之前的全部定义，或单独为 conversation 定义加一个等于 main 的哈希。

### 4 低（推测）pageCharacters 很小时 fitted 的最小结果仍可能超出预算
文件: `apps/agent-service/src/production-memory-open.ts:78-90`、`:179-185`
问题: 这次把原来的 `Math.max(1, ...)` 去掉了。若 `room < 3`，即使 `keep=0`，`shortened(0)` 也是 `"…"`，其序列化长度为 3，`fitted` 仍会返回它，单个版本可能比推导预算多 1–2 字节。
证据（读代码证实）:
```ts
const shortened = (keep: number) => `${characters.slice(0, keep).join("")}…`;
...
return shortened(low);
```
```ts
const room = Math.floor((budget - fixed - bare) / 2) + 2;
```
推测: 生产路径 `pageCharacters>=2000` 且版本元数据不可能吃掉全部预算，所以生产不可达；只有直接构造 `ProductionMemoryOpen` 传很小的 `pageCharacters`（如测试里 330 再配更长 `conversationId`）才可能。建议把 `room` 下限钳到 3 或在无法放下时显式处理。

**侧重检查**
- 错误路径与输入：`onlyKeys` 拒绝多余参数，`wholeNumber` 拒绝缺失、0、小数、字符串、超过 100 的 page；越界页抛 `MemoryOpenInputError`；运行层映射为 `MEMORY_OPEN_INPUT_INVALID`，其他异常统一 `MEMORY_OPEN_UNAVAILABLE`，结果里只有 errorCode 和固定说明，不泄露内部错误。读代码证实。
- 不可信输入与安全：`byNumber`/`numbers` 都是参数化 SQL 且带 owner/agent 条件；`read` 后再次核对 owner/agent；`deletion_pending`/`deleted_verified` 与不可见密级都按“没有这个编号”返回；工具只读，无可撤销操作。读代码证实。
- 资源耗尽：`open` 在任何分页前会读完该记忆的全部历史正文和原话（`production-memory-open.ts:140-153`）；新的 `fitted` 对每段文本做 `O(长度·log 长度)` 的 JSON 序列化，且每请求都会对全部版本重算，长历史/大文本下比旧的一次性 `JSON.stringify` 更贵。本次没有新增并发或写操作；这是性能提醒，未实测。推测。
- 规则与文档一致：`prompt-prefix.md` 的“只追加”在这个增量本身不受影响，`memory_open` 仍在工具列表最后（`production-runtime-tools.ts:631-637`）；但 `TOOL_MEMORY_OPEN` 的“全文”与代码的头部截断不一致，见意见 1。`TOOL_RESULT_CONVERSATION_NO_MORE` 的改动（`production-conversation-tools.ts:278-285`）逻辑正确：无命中才是“没有找到”，有命中但页码越界是“没有更多了”，读代码证实。
- 未核实：没有运行任何测试；`EVERY_TOOL_DEFINITIONS_SHA256` 的新值 576d… 是否与合并后的实际定义一致未独立计算。

**必答问题**
1. 这个增量本身不改变模型已见的请求开头：没有改系统提示、工具文字或历史，只改了数据表和工具结果逻辑。就整个 PR 而言，`memory_open` 定义追加在最末（`production-runtime-tools.ts:631-637`，`EVERY_TOOL_NAMES` 最后一项），`slice(0,-3)` 的哈希等于 main（`4fb0ef8b5` 已把它更新为 a41c…），所以原有定义不变；但新增工具会改变工具集合，按规则第 6 条会让已有对话换新一次，这是 ADR 0165 允许的例外，不是每轮变化。每轮会变的值（`status` 依赖 `now()` 等）只出现在追加的工具结果里，不在请求开头。
2. 增量没有引入新的非确定性：截断按确定的 JSON 长度二分，`versions` 按 `occurredAt`、`id` 排序，`correctedBy` 只查单个 id，输出对象键顺序固定；`status` 随时间变，但只存在于追加的工具结果，且同一 tool call 的结果会被持久化复用。没有依赖前后文的遮盖、无时间字段进入头部、无无序集合。
3. 有自动检查：新单测覆盖页预算、越界页、`nextPage` 上限，表目录由迁移契约测试守着；预算和越界页两条在旧代码上会失败，是有效反例。但缺少“长正文跨页拼回原文”的反例，且第 100 页用例把“后段版本丢失”写成了期望，不能发现意见 2。作者声称的“memory_open 之前所有定义”也没有真正锁住（意见 3）。测试是否全部通过未核实。
4. 逐个核对：`schema-catalog` 的两个表名与迁移一致，消费端是迁移契约测试，能接受；`productPort` 写 `ProductMemoryStatePort`，实际端口名一致，但没有校验，属未核实。`memory_open` 的 `page`/`nextPage` 使用端是工具说明（填回 `page`）和描述符（page 最大 100），能接受；越界页的新错误有对应的 `TOOL_RESULT_MEMORY_OPEN_INPUT_INVALID` 说明，能接受。`text` 的使用端是 `TOOL_MEMORY_OPEN`，它要求“全文”，而新代码只给约半页且不可继续读取，这一端不能接受（意见 1）。
