## 结论摘要

本轮增量（`f4026aa9e`、`01547efdc`）的生产代码改动很小：MCP `find_memories` 的参数错误改为 `isError` 并记成失败读取；recall 收窄错误映射；提示词说明补了参数范围；新增跨时区单元测试。逐项对照后，未发现高、中严重度的生产缺陷；发现的主要是测试覆盖、文档说法与运行时时区数据依赖问题。运行测试、计算 manifest 的 sha256、验证全部时区算法这三件事在本环境无法执行，均标为未核实。

## 读代码证实的问题

### 1. 低：MCP 路径上「query 为空 / 多余参数」不会走到新说明

- 文件：`apps/agent-service/src/production-mcp-read.ts:502-510`、`packages/prompt-catalog/src/tools.ts:198`
- 问题：新说明写「query 不能为空……只能用工具定义里列出的参数」，但 MCP 的 `find_memories` 在进入 `#findMemories` 前已有 schema：`query` 有 `minLength: 1`，对象有 `additionalProperties: false`。这些输入由 MCP 框架先拒绝，不会返回这条工具结果说明。真正会走到新说明的 MCP 输入主要是「格式对但日历上不存在」的日期（例如 `2026-02-30`）。
- 证据：
  - `production-mcp-read.ts:502`：`query: { type: "string", minLength: 1, maxLength: 500 },`
  - `production-mcp-read.ts:510`：`additionalProperties: false,`
  - `production-mcp-read.ts:1142`：`const { auto, ...recallArgs } = args;`——如果 schema 不先校验，`auto: "yes"` 会被丢掉而不会报错；但 `test/integration/mcp-read.test.ts:1058-1063` 的「rejects a non-boolean auto」明确期望 `isError === true`，说明类型校验确实在进入处理器前发生。
- 建议：保留新说明（对内部 recall 是有意义的），但把提交说明/ADR 里的「MCP 也覆盖 query 为空和多余参数」改成「内部 recall 覆盖；MCP 由 schema 先拒绝」，或者补一条断言 MCP schema 错误文案的用例。若确实希望 MCP 也统一回这条说明，需要让 `#findMemories` 之前不先做 schema 拒绝，或把 schema 错误映射成同一条说明。

### 2. 低：新增的 `includeHistory` 用例没有真正断言它被转发

- 文件：`test/integration/mcp-read.test.ts:866-871`
- 问题：新增用例只断言第二次调用没有报错、ledger 里出现 `find_memories`，没有断言 recall 收到的 scope 是 `{ includeHistory: true, from: null, to: null }`。因此它只能证明 schema 接受了 `includeHistory` 并且调用成功，不能证明参数确实传到了检索层。提交说明里的「验证 includeHistory 能传到 recall」目前没有测试证据。
- 证据：
  ```ts
  const history = await f.call(client, "find_memories", { query: "牙医", includeHistory: true });
  expect(history.result.isError).not.toBe(true);
  expect((await f.ledger()).map(({ reasonCode }) => reasonCode).sort()).toEqual([
    "find_memories",
    "find_memories_failed",
  ]);
  ```
- 建议：在 `setup()` 的 provider.search 上记录输入，或断言返回的 `window`/结果差异；否则把提交说明改成「验证 schema 接受 includeHistory」。代码本身我已核对：`#findMemories` 除 `auto` 外原样转发，`argumentsOf` 返回 `includeHistory: args["includeHistory"] === true`，转发逻辑是正确的。

### 3. 低：ADR 的「前后三天」和测试实现不一致

- 文件：`docs/adr/0262-memory-time-scope-comes-from-the-model.md:50`、`packages/memory-engine/test/time-scope.unit.test.ts:76`
- 问题：ADR 写「逐个时区核对 2026 年每个切换日前后三天」，测试实际是 `shift of [-1, 0, 1]`，即切换日及其前后各一天，共 3 天，不是前后各三天（7 天）。
- 证据：
  ```ts
  for (const shift of [-1, 0, 1]) {
  ```
- 建议：把 ADR 改成「切换日前后各一天」，或把循环扩成 `[-3, -2, -1, 0, 1, 2, 3]`。另外 `Intl.supportedValuesOf("timeZone")` 返回的是运行时 ICU 的规范时区列表，不保证包含所有别名，「全部 IANA 时区」这个说法略强。

### 4. 低：`retrieval-comparison.json` 没有生成或校验链路

- 文件：`evals/memory-time-scope/retrieval-comparison.json:1`、`scripts/evals/memory-time-scope-live.eval.ts:204-223`
- 问题：ADR 引用了这个检索对比结果，但现有 eval 脚本只写 `result.json` 和 `test/fixtures/memory-evaluation/model-time-scopes.json`，不会生成也不会校验 `retrieval-comparison.json`。这个文件是手工维护的，重跑评测后可能过期，且仓库里没有命令能复现它。
- 证据：
  ```ts
  writeFileSync(path.join(OUTPUT_DIRECTORY, "result.json"), ...);
  writeFileSync(FIXTURE, ...);
  ```
  全仓库 grep `retrieval-comparison` 只命中 ADR 和该 JSON 自身。
- 建议：在 eval 脚本里同时生成该文件，或在 ADR 里写明产生它的具体命令并加一个简单的存在/字段检查。

### 5. 信息：ledger 只记 `find_memories_failed`，不记具体错误码

- 文件：`apps/agent-service/src/production-mcp-read.ts:1114`
- 问题：返回文本告诉模型具体错误 `MEMORY_RECALL_INPUT_INVALID`，但 ledger 的 `reasonCode` 统一记成 `find_memories_failed`。两者都表示失败，方向一致；但审计上无法区分「参数错误」和「后端故障」，因为 `inputs.memoryIds` 都是空数组、`outcome` 都是 `read`。
- 证据：
  ```ts
  reasonCode: memoryIds ? name : `${name}_failed`,
  ```
- 建议：这不是本轮引入的新缺陷（原有失败路径同样如此）。如果审计需要区分，可在 `inputs` 里增加一个受校验的错误码字段，或使用更具体的 reason code；注意 `validateLedgerWrite` 对 `reasonCode` 的限制是 1–64 字符，当前值可以通过。

## 推测 / 未核实

- **manifest sha256 未核实**：`packages/prompt-catalog/prompt-manifest.json:740-743` 已更新为新哈希，但本环境不能运行 `node`/`sha256sum`，无法确认它是否等于新文本的 `JSON.stringify(segments)` 摘要。好在 `apps/agent-service/test/prompt-catalog.unit.test.ts` 的 `manifestProblems` 会检查，若哈希不对 `check:prompt-catalog` 会失败。
- **跨时区测试是否全部通过未核实**：没有运行测试。按代码推演，旧算法在 America/Havana 2026-03-08、America/Santiago 2026-09-06 确实会返回错误的一天起点，新测试会报出；当前算法对这两个午夜切换场景的两次偏移修正也是合理的。但「全部时区 2026 年全部切换日」是否都通过只能以实际运行为准。
- **测试耗时是估计**：测试对每个有时区变化的 zone 扫 365 天，约十万次 `formatToParts`，另有约数千次 `localDayStart` 调用；按常见 Node/ICU 性能估计在数秒到十几秒，60 秒超时通常够用，但慢 CI 上可能偏紧。
- **`retrieval-comparison.json` 的数值来源未核实**：只能确认 ADR 表格里的 `qwen4096/*` 四组数值与 JSON 内部一致（例如 `temporal.staleFree = 0.9091` 对应表格 0.91，`history` 的 0.90–1.00 对应 run2 的 0.9），但无法确认它们是由哪次运行、哪份向量产生。

## 侧重检查

- **错误路径**：`requestedTimeScope` 只对 `MEMORY_TIME_SCOPE_INVALID` 抛 `RangeError`；recall 只把这个消息映射成 `MEMORY_RECALL_INPUT_INVALID`，其它异常原样抛出（`production-memory-recall.ts:133-139`）。MCP `#findMemories` 只捕获 `MEMORY_RECALL_INPUT_INVALID`，其它错误继续走原有失败路径（`production-mcp-read.ts:1176-1186`）。这与作者说法一致。
- **不合规范/不可信输入**：MCP 先做 JSON schema 校验；`argumentsOf` 再检查 query 长度、日期格式、`includeHistory` 类型、`limit` 整数范围、额外字段；`calendarDay` 拒绝不存在日期和 `from > to`。未发现新的越权或注入路径；错误输出不回显 query，也不含用户数据。
- **安全**：错误路径只返回固定的 `MEMORY_RECALL_INPUT_INVALID` 和目录里的固定说明，不含敏感值；`find_memories` 仍是只读工具，`isError` 不会改变读权限。
- **资源耗尽**：日期非法时在检索前就失败，不触发向量检索；只多写一条 ledger。生产路径没有新增无界循环或大对象。新增测试本身有较大计算量，但受 60 秒超时约束。
- **不可撤销操作**：本轮没有写记忆、删记忆或改外部状态的操作，只有 append-only ledger。
- **规则/文档/代码一致性**：ADR 0262 的新前提 1–3 基本能在代码里对上；前提 4 引用的 `prompt-prefix.md` 第 43、53 行内容正确；dataset 的 temporal 15、history 10、time_window 12、episode 8 已核对。发现的不一致是上面的「前后三天」和 MCP 说明可达性。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   本轮增量不会。改动的是 `tool-result.recall-input-invalid` 的文本，`TOOL_RESULT_RECALL_INPUT_INVALID` 的 `layer` 是 `"tool-result"`（`packages/prompt-catalog/src/tools.ts:196`），只在工具结果里使用（`production-runtime-tools.ts:646`、`production-mcp-read.ts:1181`）。工具结果是在工具调用之后追加的最后一条消息内容，不是系统提示或工具定义。`find_memories` 的错误 JSON 也是每次追加的工具结果；没有把本轮时间、日期、随机值放进前缀。老对话历史里已经存在的旧说明不会被改写；旧说明和新说明都没有数字，所以从 trusted 列表移除旧文本不会导致遮盖字节变化。需要说明的是，整个 PR 早先对 `TOOL_RECALL` 和 `MCP_TOOL_FIND_MEMORIES` 的说明文字改动会改变**新对话**的工具定义前缀，但按对话冻结规则，老对话沿用第一次发出的字节，这是规则允许的行为。
2. **同一段文字会不会在不同请求里变成不同字节？**
   本轮新增的 MCP 错误结果只包含固定的 `error` 字符串和固定说明，没有时间、随机数或无序集合；对象字面量键顺序固定，`JSON.stringify` 结果确定。ledger 里的 `decidedAt`、UUID 不发给模型。提示词说明本身也是固定文本。遮盖方面，新旧说明都不含会被认成敏感信息的数字，且说明是目录里的固定文本；因此本轮没有引入新的字节不确定性。唯一的既有特性是遮盖可能依赖同一消息之前的内容，但这没有被本轮改变。
3. **有没有自动检查，反向用例是否真的会失败？**
   - MCP 新行为有集成用例 `test/integration/mcp-read.test.ts:852-872`，检查 `isError`、说明文本和 ledger 的 `[["find_memories_failed","read"]]`；如果回退成原来的成功空结果，这两项断言都会失败。
   - recall 映射有 `production-memory-recall.unit.test.ts:416-423`，非法日期必须抛 `MEMORY_RECALL_INPUT_INVALID`；但没有专门反向用例证明「非 `MEMORY_TIME_SCOPE_INVALID` 的 RangeError 不会被误映射」，建议补一条。
   - 新时区用例是属性检查，并且有 `switchDays > 300` 防止一个时区都没扫到；按推演旧算法会在 Havana/Santiago 上让 `wrong` 非空，因此能抓住已知回归。但它只检查切换日 ±1，不是 ±3；且具体期望值（Santiago/Beirut/New York）依赖 tzdata，规则变化时可能需要更新。
   - prompt 文本有 `prompt-catalog.unit.test.ts` 的 manifest 摘要检查和反向用例；哈希是否正确本环境无法计算，未核实。
4. **每个改动值的产生处和使用处都能接受吗？**
   - `ToolOutcome.rejected`：只在 `ToolOutcome` 和 `#call` 使用，其它工具不设置；`#call` 只在它存在时加 `isError`，其它工具行为不变。
   - `memoryIds: undefined`：`#record` 接受 `readonly string[] | undefined` 并写成 `memoryIds ?? []`；ledger 校验 `validateLedgerWrite` 的 `idList` 接受空数组，`reasonCode: find_memories_failed` 满足 1–64 字符；decision chain 合约用 `boundedString(64)` 接收。两端都能接受。
   - `find_memories_failed`：ledger 存储、decision chain、控制台展示都把它当普通字符串，没有白名单；长度和字符都合法。
   - `includeHistory`：MCP schema 是 boolean，`argumentsOf` 校验 boolean，`requestedTimeScope` 使用它，provider/episodes 接受 `MemoryTimeScope`；链路一致。
   - 新提示词文本和 manifest 哈希：目录测试是消费端，`changedIn`/`reason` 存在；哈希未核实。
   - `retrieval-comparison.json`：没有代码消费端，只有 ADR 引用，因此不会被后端校验，也不存在 I-73 那种「清单 id 过不了校验」的问题；代价是它可能过期。
   - `MEMORY_RECALL_INPUT_INVALID`：recall 抛出，runtime 和 MCP 都按消息匹配；ledger 不保存这个具体码，只保存通用的 `find_memories_failed`，属于既有失败记录约定。

## 结论

本轮改动方向正确：MCP 参数错误不再被记成一次成功空读取，recall 的错误映射也收窄了；未发现会改变请求开头、破坏响应确定性或让其它工具受影响的缺陷。需要跟进的是测试/文档精度：`includeHistory` 转发没有被断言、「前后三天」与实现不符、`retrieval-comparison.json` 缺少生成/校验链路，以及跨时区测试对运行时时区数据和绝对阈值的依赖。
