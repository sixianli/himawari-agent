本轮范围：先看 `66505c39..3c0f3604` 的增量，并用 `3cbd7735..3c0f3604` 的 `--stat` 确认增量落在哪些文件；重点读了 `production-mcp-read.ts`、控制中心的 `mcp-connections.ts`/设置组件、三个测试文件，以及下游的 gateway 契约、客户端 `commandMessage`、store 校验和 SQLite 迁移。上一轮 `judgments.md` 不在稀疏检出中，未带入。未运行测试，以下判断来自读代码。

### 1. 低 — 新增测试标题把“日期非法”的拒绝归因于 store，实际发生在 recall 的时间范围校验

文件: `test/integration/mcp-read.test.ts:1586`；`apps/agent-service/src/production-memory-recall.ts:85,140-141`；`packages/memory-engine/src/time-scope.ts:75-77`

问题：标题写的是“the store turns away for a bad date”，但代码里 `2026-02-30` 先在 `requestedTimeScope` 的 `calendarDay` 校验中失败，随后被 `production-memory-recall.ts` 映射为 `MEMORY_RECALL_INPUT_INVALID`，并没有走到 store。

证据：
- `test/integration/mcp-read.test.ts:1586`：`it("counts a recall the store turns away for a bad date as failed, not delivered", ...)`
- `packages/memory-engine/src/time-scope.ts:77`：`if (from === null || to === null || from > to) throw new RangeError("MEMORY_TIME_SCOPE_INVALID");`
- `apps/agent-service/src/production-memory-recall.ts:140-141`：把该 `RangeError` 转成 `MEMORY_RECALL_INPUT_INVALID`。

建议：把标题改成“recall input/time-scope check turns away...”；若想固定错误路径，可在测试里断言返回文本包含 `MEMORY_RECALL_INPUT_INVALID`，或断言 ledger 的 `reasonCode` 为 `find_memories_failed`。

### 2. 低 — 说明里的“shared check”不是共享实现，而是两份重复逻辑

文件: `packages/application/src/ports/mcp-connections.ts:33-47`；`packages/gateway-contracts/src/contracts-v2.ts:637-648`；`test/integration/mcp-connection-names.test.ts:7`

问题：作者说“dropping the tag range from the shared check”，但 store 使用的是 application 包的 `mcpConnectionNameHasHiddenCharacter`，gateway 契约使用的是 `contracts-v2.ts` 内的 `isHiddenNameCharacter`，两者是两份维护中的实现，不是同一个共享函数。

证据：
- application：`export function mcpConnectionNameHasHiddenCharacter(name: string): boolean { ... }`
- gateway：`function isHiddenNameCharacter(code: number): boolean { ... }`
- 现有测试 `mcp-connection-names.test.ts:7` 通过逐个码点比较，保证两边行为一致。

建议：修正 PR/测试说明的措辞，或把这段判断抽成单一共享函数；当前有交叉测试兜底，不是行为错误。

**读代码证实的上一轮三项修复**

1. `readCounts` 现在把 `rejected: true` 计为 `failed`：`apps/agent-service/src/production-mcp-read.ts:1433-1438`；新测试 `test/integration/mcp-read.test.ts:1586-1598` 用精确相等断言。若删掉 `|| delivered.rejected`，结果会变成 `delivered: 1`，测试会失败。
2. store 的新拒绝用例真实覆盖 tag 字符和超长 emoji：`test/integration/mcp-connections-store.test.ts:130-131` 拒绝 `U+E0001` 与 65 个 emoji，`:140-141` 接受 64 个 emoji；对应应用层校验 `packages/application/src/ports/mcp-connections.ts:33-47` 包含 `0xe0000..0xe007f`。若去掉 tag 范围，拒绝断言会失败。
3. `withinNameLimit` 已移到 `apps/control-center/src/mcp-connections.ts:116-120`，先保留前导空白，再对剩余部分按 code point 截到 64；单测在 `apps/control-center/test/mcp-connections.unit.test.ts:74-79`。若恢复旧的 `[...value].slice(0, 64)`，含前导空格的两空格 + 65 个 `n` 会变成两空格 + 62 个 `n`，测试会失败。

**推测/未决**

- `withinNameLimit` 会保留任意长度的前导空白到 React state；不过 `createMcpConnection`/`changeMcpConnection` 调用的 `commandMessage` 会在客户端用 `gatewayV2MessageSchema.parse` 把 name trim 掉（`apps/control-center/src/messages.ts:64-70`，契约在 `packages/gateway-contracts/src/contracts-v2.ts:1293-1309`），所以超长前导空白不会进入后端。MCP 路由另有 65,536 字节 body limit。影响主要是极端粘贴时浏览器状态偏大，推测不构成服务端资源问题；如果以后有人绕过 `commandMessage` 直接使用该 helper，前导空白就会变成 store 会拒绝的输入。

**侧重检查**

- 错误路径：非法日期在 recall 校验中被拒绝并转为 `MEMORY_RECALL_INPUT_INVALID`，`findMemories` 返回 `rejected: true`，`readCounts` 计为 failed；已核对。
- 不规范/不可信输入：store 对隐藏字符、超长名称、非 trim 输入仍有校验；控制中心输入会先经客户端契约解析，隐藏字符和长度仍由契约/服务端校验兜底；已核对。
- 安全：本轮没有新增日志、密钥字段或序列化格式；usage 只写 `connectionId/tool/entry/auto/counter/day`，不写名称或 secret；已核对。
- 资源耗尽：MCP body limit 为 `MCP_READ_BODY_LIMIT = 65_536`（`production-mcp-read.ts:118`），本轮新增路径受其约束；已核对。
- 不可撤销操作：本轮没有涉及 revoke/delete 等不可逆路径；已核对。
- 规则/说明一致性：本轮未改规则文件；发现上述两处说明措辞与代码不完全一致。

**必答问题**

1. 不会。增量只改 MCP 使用计数和一个控制中心名称 helper；MCP 工具结果文本没有变化（`isError` 逻辑在本次增量前已存在），没有改系统提示、工具定义、历史消息或遮盖结果。按 `prompt-prefix.md` 第 27-28、36 条，模型内容仍是只在末尾追加工具结果；每轮变化的计数值只写入 SQLite/控制中心，不在请求开头。本次增量不改变这一性质。
2. 不会。`withinNameLimit` 和 `readCounts` 都是纯函数，不依赖前后文、时间或无序集合；`recordMcpUsage` 使用日期只是写 usage 表，不进入模型请求字节。
3. 有。`readCounts` 的新测试用精确相等断言；store 测试包含真实拒绝用例；`withinNameLimit` 有 64/65 个 emoji 和前导空格用例。按代码推断，分别去掉条件、tag 范围或恢复旧实现都会使对应用例失败；未实际执行测试，实际运行结果未核实。
4. 能接受。`withinNameLimit` 只有两个设置组件调用点和单测使用，返回值随后经 `gatewayV2MessageSchema` 的 name schema trim 并校验，再进入 store；`MCP_CONNECTION_NAME_CHARACTERS` 为 64，与 application 的 `MCP_CONNECTION_NAME_MAXIMUM = 64` 及数据库 `length(name) BETWEEN 1 AND 64` 一致。`rejected?: true` 只由 `findMemories` 产生，`readCounts` 消费，`failed` 是合法的 `McpUsageCounter`，`addUsage` 和 usage 表都接受。未发现新增标识、配置键或序列化格式。
