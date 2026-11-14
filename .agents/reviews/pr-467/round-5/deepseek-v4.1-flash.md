回答如下（只基于已读内容；未核实处已标注）。

## 结论

未发现高、中严重度缺陷。逐条核对后，作者关于这一轮合并的说法与代码一致：main 的 ceiling 过滤保留，`rejected` 只影响 `find_memories`，没有残留的 `parseTimeScope` / `startOfDay`。发现 1 个低严重度的日期边界问题，以及 2 处低严重度的测试覆盖缺口；测试实际执行结果和哈希正确性无法运行验证，标为未核实。

---

## 侧重检查

- **错误路径**：非法日期在 `requestedTimeScope` 抛 `MEMORY_TIME_SCOPE_INVALID`，`production-memory-recall.ts` 窄映射成 `MEMORY_RECALL_INPUT_INVALID`；内部 recall 与 MCP `find_memories` 都只按这条错误消息处理。MCP 路径返回 `isError: true`，ledger 记为 `find_memories_failed`，不回显模型输入。已读代码确认。
- **不合规范 / 不可信输入**：`query`、`from`、`to`、`includeHistory`、`limit`、未知参数都有校验；MCP schema 与 `argumentsOf` 两端都接受 `includeHistory: boolean`；日期做历法校验。发现年份 `0000`–`0099` 的合法日期会被误拒，见下面低严重度条目。
- **安全**：改动只读，没有不可撤销操作；新错误文本是固定提示词，不拼接模型输入；`maskForExternalRead` 仍对输出做遮盖；新提示词会进入动态 trusted 清单。
- **资源耗尽**：日期校验发生在搜索和 embedding 之前，非法输入不会触发检索；没有新增无界循环或大对象。`time-scope.unit.test.ts` 遍历全部时区只是测试耗时。
- **规则 / 文档一致性**：ADR 0262 引用的 `find_memories` 行号 `1508` 与当前代码一致；引用的 `prompt-prefix.md` 第 43、53 行正确；golden 与 main 的差异确实只有 recall 说明这一行；没有生产 TS 残留 `parseTimeScope` 或 `startOfDay`。

---

## 发现的问题（按严重度）

### 低：合法年份 `0000`–`0099` 会被当成不存在的日期

- **严重度**：低
- **文件:行**：`packages/memory-engine/src/time-scope.ts:32-44`
- **问题**：`calendarDay` 用 `Date.UTC(year, ...)` 构造日期。JavaScript 会把 0–99 年解释为 1900–1999 年，随后 `parsed.getUTCFullYear() === year` 永远不成立，所以 `0099-01-01` 这类历法上真实存在、且符合 `^\d{4}-\d{2}-\d{2}$` 的日期会被拒绝为 `MEMORY_TIME_SCOPE_INVALID`。ADR 0262 写的是“不存在的日期一律拒绝”，这里多拒了合法日期。
- **证据**：
  ```ts
  const instant = Date.UTC(year, month - 1, date);
  const parsed = new Date(instant);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === date
    ? instant
    : null;
  ```
- **建议**：显式处理 `< 100` 的年份（例如先 `new Date(0)` 再 `setUTCFullYear(year, month - 1, date)` 后校验），或明确把允许年份限制为 `0100`–`9999` 并在提示词/ADR 中写清楚，并补一个 `0099-01-01` 的用例。

### 低：T6 测试没有锁住 `includeHistory` 在两条检索上都生效

- **严重度**：低（测试覆盖缺口）
- **文件:行**：`apps/agent-service/test/production-memory-recall.unit.test.ts:400-402`；`test/integration/mcp-read.test.ts:940-945`
- **问题**：单元测试用 `toHaveBeenCalledWith` 只要求“某一次”调用匹配预期 scope，confirmed 与 tentative 两次检索中若只有一次带上了正确的 `includeHistory`，测试仍会通过。MCP 集成测试只断言 `includeHistory: true` 时 `isError` 不为真，没有断言它真的改变了检索窗口或历史包含行为。
- **证据**：
  ```ts
  expect(f.search).toHaveBeenCalledWith(
    expect.objectContaining({ scope: { includeHistory: false, from: null, to: null } }),
  );
  ```
  ```ts
  const history = await f.call(client, "find_memories", { query: "牙医", includeHistory: true });
  expect(history.result.isError).not.toBe(true);
  ```
- **建议**：对两次 `provider.search` 的 scope 分别断言，或在 MCP 集成测试里准备一条只在历史中可见的记忆，断言 `includeHistory: true` 能查到、`false` 查不到。

### 未核实：哈希和清单

- **文件:行**：`packages/prompt-catalog/prompt-manifest.json:358,756,909`；`apps/agent-service/test/production-runtime-tools.unit.test.ts:2105-2106`
- **说明**：manifest 中 `mcp.find-memories`、`tool-result.recall-input-invalid`、`tools.recall` 的 sha256 与 `EVERY_TOOL_DEFINITIONS_SHA256` 都按预期更新了，但只能 git/read/grep，不能运行 `check:prompt-catalog` 或 vitest，无法验证哈希值本身是否算对。当前代码里没有旧哈希残留副本。

---

## 读代码证实的（作者说法逐条核对）

- **合并提交与 ADR 提交**：`ebcdde4ed` 是合并提交；`652399a48` 只改 ADR 0262 一行，把 `find_memories` 行号从 `501` 改为 `1508`。当前 `production-mcp-read.ts:1508` 正是 `name: "find_memories",`，引用正确。
- **main 的 `#readTools` 与独立 `findMemories` 结构保留**：`production-mcp-read.ts:490` 有 `#readTools`，`:1292` 是独立 `findMemories`，`:1499-1540` 是 `MCP_READ_TOOLS` 列表。
- **ceiling 过滤没有丢**：`production-mcp-read.ts:1116` 把 ceiling 传给 `sources.recall`；`production-memory-recall.ts:142-145` 用 ceiling 过滤 `allowed`，`:216` 用 `allowed.includes(memory.dataClassification)` 过滤记忆，episodes 也传 `allowedClassifications: allowed`。main 的 `[P5-B]` ceiling 测试在 `test/integration/mcp-read.test.ts` 中未改动。
- **`rejected` 只影响 `find_memories`**：`ToolOutcome.rejected` 只由 `findMemories` 的 catch 设置（`production-mcp-read.ts:1330-1339`）；`#call` 在 `:1168` 把 rejected 的 `memoryIds` 置为 `undefined`，`:1194` 加 `isError: true`；其它读工具不设置 `rejected`，记录和返回路径不变。
- **ledger 记为失败**：`production-mcp-read.ts:1214` 用 `memoryIds ? name : `${name}${MCP_READ_FAILED_SUFFIX}``，rejected 时得到 `find_memories_failed`；`validateLedgerWrite` 允许 1–64 字符（`sqlite-decision-ledger-operations.ts:62`），gateway 合同用 `boundedString(64)`（`contracts-v2.ts:1574`），长度和字符集都能通过。
- **错误映射是窄的**：`production-memory-recall.ts:138-139` 只把 `RangeError("MEMORY_TIME_SCOPE_INVALID")` 转成 `MEMORY_RECALL_INPUT_INVALID`；其它错误原样抛出。`production-runtime-tools.ts:718-724` 只对 `MEMORY_RECALL_INPUT_INVALID` 使用新说明，其它仍用 `MEMORY_RECALL_UNAVAILABLE`。
- **没有残留 `parseTimeScope` / `startOfDay`**：全仓库 TS 中 `parseTimeScope` 只出现在 ADR/评测历史说明里；`startOfDay` 只出现在无关的 Swift `RelativeTime.swift`。`hybrid-memory-provider.ts` 也已删掉 `parseTimeScope` 兜底，改为只使用调用方传入的 `input.scope`。
- **MCP `find_memories` 加了 `includeHistory`**：`production-mcp-read.ts:1516` 有 `includeHistory: { type: "boolean" }`；`findMemories` 原样转发 `recallArgs`（`:1300-1309`），`argumentsOf` 接受并传给 `requestedTimeScope`。
- **golden 与 main 的差异只有 recall 说明一行**：`git diff 364c..652399a -- apps/agent-service/test/__prompt_golden__/tools.definitions.txt` 只显示 recall `description` 一行变化。
- **`localDayStart` 新行为已被调用方处理**：`production-memory-capture.ts:256-257` 对 `localDayStart` 返回 `null` 做了判断，非法日期不会导致崩溃或悄悄换成别的日期。
- **新提示词可被 trusted 清单收集**：`packages/prompt-catalog/src/trusted.ts` 动态遍历 `tools` 模块导出的所有条目；`TOOL_RESULT_RECALL_INPUT_INVALID` 在 `tools.ts` 导出且长度超过 24，会被收集。

---

## 推测 / 未核实

- **测试是否实际通过**：未运行 vitest / npm check（工具限制只允许 git 和只读工具）。按断言逻辑推断，去掉 `rejected` 处理会让 MCP T6 的 `isError` 和 `find_memories_failed` 断言失败；去掉新说明会让 runtime-tools 的“改正后再查一次 / 不含查不了记忆”断言失败；去掉历法校验会让非法日期继续检索。但“实际运行是否红/绿”未核实。
- **哈希是否正确**：manifest 与 `EVERY_TOOL_DEFINITIONS_SHA256` 的新值未实际计算，未核实。
- **旧对话的遮盖字节**：ADR 认为旧 recall 说明不含会被认成敏感信息的数字，我核对了旧/新文本确实没有数字，因此推断旧对话的遮盖结果不变；没有实际跑遮盖对比。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会改变已经发给过模型的内容；发给 Himawari 模型的内容仍然只在末尾追加。唯一模型可见的固定文字变化是 `recall` 工具说明，它属于工具定义头部，但按 ADR 0165 / `prompt-prefix.md` 第 6 条按对话冻结，只对新对话生效，老对话继续用旧字节。MCP `find_memories` 的描述和 schema 变化是给外部 agent 看的，不属于 Himawari 自己的模型请求。每轮会变的值（`now`、`window`、`current` 等）仍在工具结果/最后一条消息里，没有新增到系统提示或工具定义中。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   没有新增这种问题。`requestedTimeScope` 只依赖模型给的日期和配置时区，不依赖 `now`；新错误输出是固定字符串，且不拼接输入；`JSON.stringify` 的键顺序固定；没有新增无序集合进入模型可见文本。新提示词是固定文本并会进入 trusted 清单；旧 recall 文本离开 trusted 清单，但旧/新文本都没有像敏感信息的数字，所以旧对话的遮盖字节按代码推断不变。真正带时间的 `current` / `now` 是既有的工具结果字段，不在请求开头。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有：`time-scope.unit.test.ts` 覆盖非法日期、`from > to`、全部时区夏令时；`production-memory-recall.unit.test.ts` 的 `[T6]` 覆盖“不从问题文字猜时间”和非法日期；`production-runtime-tools.unit.test.ts` 覆盖 `MEMORY_RECALL_INPUT_INVALID` 使用新说明且不再出现“查不了记忆”；`test/integration/mcp-read.test.ts` 的 `[T6]` 覆盖 MCP 非法日期返回 `isError`、新说明和 ledger `find_memories_failed`；main 原有的 `[P5-B]` ceiling 反向用例仍在。按断言逻辑，撤掉对应修复这些用例会失败；但没有实际运行测试，执行结果未核实。

4. **每个新值的使用两端都能接受吗？**
   - `includeHistory`：MCP schema 声明 boolean → `findMemories` 转发 → `argumentsOf` 校验 boolean → `requestedTimeScope` 使用；两端一致。
   - `rejected`：只由 `findMemories` 产生，只由 `#call` 消费；其它读工具从不设置，类型上是可选字段。
   - `MEMORY_RECALL_INPUT_INVALID`：`argumentsOf` 直接抛，`requestedTimeScope` 的 `MEMORY_TIME_SCOPE_INVALID` 被窄映射成它；`production-runtime-tools` 和 `findMemories` 都按精确消息匹配；没有其它生产调用方依赖不同错误码。
   - `MEMORY_TIME_SCOPE_INVALID`：内部 RangeError，只在 `production-memory-recall` 映射，不会暴露给模型。
   - `tool-result.recall-input-invalid`：manifest 有对应项，`trusted.ts` 动态收集，两个 `usedBy` 文件都通过包入口导入；哈希未实际验证。
   - `find_memories_failed`：由 `#record` 的 `_failed` 后缀产生；`validateLedgerWrite` 允许 1–64 字符，gateway 合同是 `boundedString(64)`，集成测试也按这个值断言；没有发现第二套会拒绝它的白名单。
   - `EVERY_TOOL_DEFINITIONS_SHA256`：只被测试消费，已随 recall 说明更新；正确性未核实。
   - ADR 行号 `1508`：与当前文件一致。
   - `requestedTimeScope`：`packages/memory-engine/src/index.ts` 通过 `export * from "./time-scope.js"` 导出，生产 import 能解析。
