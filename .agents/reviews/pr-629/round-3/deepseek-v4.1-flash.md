**本轮查过的范围**
增量 diff（`e7f93e1..b76d951`）只动了 5 个源/测试文件：`apps/agent-service/src/production-memory-open.ts`、两个单测、`packages/prompt-catalog/src/tools.ts`、`prompt-manifest.json`、`test/integration/memory-numbers.test.ts`。我读了这些文件的完整现状，并顺证据跟到：`production-runtime-tools.ts` 的 `#memoryOpen`/`#ownerScoped`、`production-conversation-tools.ts` 搜索分页、迁移 `20261124205713_memory_numbers.sql`、`sqlite-memory-operations.ts` 的 `numbers`/`byNumber`/保存校验、`model-visibility.ts`、`prompt-catalog.unit.test.ts`、`production-runtime-tools.unit.test.ts`、ADR 0286、设计文档和 `prompt-prefix.md`。没有整份重读与本增量无关的旧模块。

**上一轮两条意见的核对**
- 意见 1（长正文仅半页）已修好：`production-memory-open.ts:96-113` 新增 `textPieces` 按字节预算切全文，`:216-219` 把每段分别成页；测试 `production-memory-open.unit.test.ts:84-95` 断言各页 `text` 拼起来等于原文，截断会失败。
- 意见 2（第 100 页后丢 nextPage）已修好：`MAXIMUM_PAGE` 已删，`:241` 改为 `page < pages.length` 即给 `nextPage`；测试 `:111-136` 要求页数 >100、150 个版本各出现一次、越界页抛 `MemoryOpenInputError`，旧上限会失败。

### 1 中 历史版本/原话的密级只用当前记忆，可能把 restricted 旧版本内容发给模型（旧代码，非本轮增量）
文件:行：`apps/agent-service/src/production-memory-open.ts:163-176`、`:242-244`；`packages/persistence-sqlite/src/sqlite-memory-operations.ts:782-783`、`:939-950`；`packages/application/src/services/model-visibility.ts:10-14`

问题：版本正文和 quote 是从各自的历史 payload 读出来的，但返回的 `contentClassification` 只取 `invocation.dataClassification` 和**当前** `memory.dataClassification` 的高者，从不看这些历史 payload 自己的分类。可见性过滤（`:148-156`）也只判断当前记忆。

证据（读代码证实）：
- `:171-175` 对每个历史事件无条件 `readText(event.contentRef)` / `readText(event.quoteRef)`；
- `:242-244` `highestClassification(invocation.dataClassification, [memory.dataClassification])`；
- 保存时 `sqlite-memory-operations.ts:782-783` 只要求当次 payload 分类等于当次记忆分类，且更新语句会写入新的 `classification`（`:847-858`），因此旧版本 payload 可以保留更高分类；
- `model-visibility.ts:10-14` 可见集合不含 `restricted`。

推测/条件：只有在一条记忆曾为 `restricted`、之后被调低为 `private`/`sensitive` 时才会真正泄露旧版本原文；`prompt-prefix.md` 把“数据分类变低了”列为会发生的情况，所以不能排除。当前记忆本身若仍是 `restricted`，`memory_open` 会按“没有这个编号”回答，这点正确。

建议：让端口在历史事件上暴露 payload 分类，或在 `open` 里对每个要展示的版本/原话取 `highestClassification` 并据此拒绝不可见分类；至少对分类高于当前记忆的历史 payload 做过滤。若确定不会降级，应在保存/导入层加硬约束并在文档里写明。

### 2 低 正文为 null 时每页预算少算 2 字节，且没有对应自动检查（本轮增量）
文件:行：`apps/agent-service/src/production-memory-open.ts:208-219`、`:230`；`apps/agent-service/test/production-memory-open.unit.test.ts:84-136`

问题：`bareWithText` 用 `text: ""`（值 2 字节）算基数，而 `text === null` 分支把 `used = bareWithText`，实际输出 `"text":null` 是 4 字节，跟踪值少 2；往这一页继续塞版本时判断也少 2。

证据（读代码证实）：
- `:208` `serializedLength(pageOutput({ text: "", versions: [] }, widest, widest))`；
- `:212-214` `if (text === null) { pages.push({ text: null, versions: [] }); used = bareWithText; }`；
- `:230` 用 `used + size > budget` 决定换页。

推测/分析：因为 `:207` 把 `page` 和 `nextPage` 都取 `Number.MAX_SAFE_INTEGER`（16 位）来算基数，实际页码远小于 16 位，正好留下约 30 字节余量，所以按生产的 `pageCharacters ≥ 2000`（`toolResultCharacters` 的下限，见 `production-conversation-tools.ts:79-83`）和测试的 330，当前**不会真的超预算**。但这是隐性兜底：一旦固定字段变长、`pageCharacters` 变小或页数大到接近 16 位，就会突破“每页不超过 pageCharacters”。另外 `tools.ts:63` 写“正文给完以后的页不再有 text”，而 `text=null` 的第一页仍带 `text: null`，措辞也不完全一致。

建议：按实际 text 形态算基数（null 时用 `text: null` 或直接加 2），并补一条 `readText` 返回 `undefined`（text=null）且版本很多、预算很紧的正向预算用例；描述里补一句“读不到正文时 text 为 null”。

**侧重检查**
- 错误路径：参数缺 `number`、非正整数、`page` 越界、多余键都走 `MemoryOpenInputError`（`production-memory-open.ts:132-139`、`:238-239`）；其他读库/解密错误在 `production-runtime-tools.ts:912-921` 统一映射为 `MEMORY_OPEN_UNAVAILABLE`，`modelContent` 只放目录里的固定说明（`:1033-1041`），未外露内部错误。读代码证实。
- 不可信输入：`wholeNumber` 用 `Number.isSafeInteger`，超大 `page` 只会 `pages[page-1]` 取到 undefined 后抛错，不会分配大数组；`byNumber`/`numbers` 都是参数化 SQL，且 `owner_id`/`agent_id` 双绑定，`read` 后再核对 owner/agent（`:145-156`）。读代码证实，未见注入或越权。
- 资源耗尽：每次 `open` 都会读完全部历史版本并解密、重建全部分页，即使只取第 1 页；这是旧行为，去掉页数上限没有改变单次成本，只让模型可以继续往后翻。`textPieces` 现在会处理整段正文（旧代码只截半页），但设计规定单条记忆 ≤300 字（ADR 0286），影响有限；没有新的硬上限，属于可接受但值得留意的放大面。部分读代码证实，部分推测。
- 不可撤销操作：本工具是只读，没有写库或外发；无。
- 文档/规则一致：工具说明已改成“正文分页、版本截断以…结尾、nextPage 接着看”，与新代码基本一致（除上面 null 的措辞）；`prompt-manifest.json` 与 `tools.ts` 的改动同步，`prompt-catalog.unit.test.ts:300-318` 会比对摘要；`memory_open` 仍是工具列表最后一个（`production-runtime-tools.unit.test.ts:2186-2199`、`:2421`）。哈希值本身无法在本环境计算，见 Q3/Q4。
- 安全残余：`correctedBy` 通过 `numbers` 拿编号（`production-memory-open.ts:158-162`），该查询不筛分类/状态；若被取代的记忆已 `restricted`/`deletion_pending`，会暴露它的编号（不暴露内容，打开仍按不存在回答）。这是旧代码、程度较低，仅记录。

**必答问题**
1. 请求开头：不涉及本轮增量的破坏。系统提示、历史、遮盖都没改；`memory_open` 仍追加在工具列表最末尾（`production-runtime-tools.ts:628-635`，测试 `names.at(-1)==="memory_open"`），它之前的所有定义由 `slice(0,-1)`/`slice(0,-3)` 哈希锁住（`production-runtime-tools.unit.test.ts:2190-2199`），`recall` 只是结果多一个 `number`（尾部）。需要说明两点：新增工具本身会让已有对话按 ADR 0165 换新一次；本轮把 `page` 的 `maximum` 删掉属于“去掉说明文字后的参数结构”变化，如果上一轮的 `memory_open` 曾冻结在线上，会再触发一次换新——因为这些改动都在同一未合并 PR 内，生产上不成立。每轮会变的值（`page`、`nextPage`、`text`、`status`）都在工具结果里，没进开头。
2. 同内容同字节：分页在给定数据、`pageCharacters` 和 `now()` 下是确定的；版本按 `occurredAt` 再按 `id` 排序（`:165-167`），`numbers` 按 `number` 排序（`sqlite-memory-operations.ts`），文本切片顺序固定，未见无序集合。唯一的非确定来源是 `status` 依赖 `now()`，且不同状态字符串长度不同，跨时间边界重开同一记忆时分页边界可能移动；这只会影响新追加的工具结果，不影响请求开头。
3. 自动检查：有，且两条反向用例有区分力——长正文拼接等于全文（截断会失败）、超过 100 页可达且越界页抛错（旧上限会失败）。缺口是 `text=null` 和极紧预算没有用例；另外 manifest 摘要与 `TOOL_DEFINITIONS_BEFORE_MEMORY_OPEN_SHA256` 我无法在本环境算 sha256，标“未核实”（只用了 read/grep/git，不能跑测试或 node）。
4. 产生/修改的值与使用端：`page`/`nextPage` 在 `open` 里产出，唯一程序化使用端就是模型把它作为下一次 `page` 传回；`wholeNumber` 接受任意安全正整数，`nextPage` 总是 `page+1 ≤ pages.length`，两端能对上。`text` 变为“仅在正文页出现”，没有发现模型之外的程序化消费者（grep 只命中本文件、测试和 manifest）。描述符去掉 `maximum` 与执行端放宽后一致。`TOOL_MEMORY_OPEN.text` 的使用端是 `memoryOpenDescriptor` 和 `prompt-catalog` 摘要测试，manifest 已同步；`EVERY_TOOL_DEFINITIONS_SHA256` 与 `TOOL_DEFINITIONS_BEFORE_MEMORY_OPEN_SHA256` 只被测试使用，均已更新但无法数值核对（未核实）。`pageCharacters` 由 `service-main.ts:1598-1601` 统一计算，与对话工具共用同一个值，类型和下限一致。
