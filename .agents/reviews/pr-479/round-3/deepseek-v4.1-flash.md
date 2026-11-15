## 读代码证实的问题

### 1. 中：慢请求脱敏的新用例没有走到真正的修复分支

- 文件：`packages/platform-node/src/http-gateway-server.ts:835`、`packages/platform-node/test/http-gateway-server.contract.test.ts:405-411`
- 问题：新用例用 **GET** 打 `/api/mcp/v1/<key>/extra`，而应用的 `/*` 兜底是 GET 路由。GET 会命中 `"/*"`，所以 `routeOptions.url` 是 `"/*"`；旧代码 `request.routeOptions.url ?? raw` 也会写 `"/*"`。这个用例在修复前就能通过，没有覆盖新增的 `UNMATCHED_ROUTE` 分支。真正会落到 `raw` 的 POST/DELETE 无匹配路由没有测。
- 证据：
  - `http-gateway-server.ts:835`：`const path = request.routeOptions.url ?? UNMATCHED_ROUTE;`
  - `http-gateway-server.ts:1581`：`app.get<{ Params: { readonly "*": string } }>("/*", async (request, reply) => {`
  - 测试 405-410 行用的是 GET，并断言 `path: "/*"`。
- 建议：增加慢速 POST（或 DELETE）到无匹配路径且路径含 key 的用例，断言 `path === "(no route)"` 且不含 key；再做反向验证：临时改回 `?? raw`，该用例必须失败。

### 2. 中：浏览器夹具没有绑定生产常量，作者“真实 65536 限制”的说法不成立

- 文件：`test/e2e/fixtures/control-center-browser-server.mjs:616,622`、`test/integration/mcp-connections-browser.test.ts:136,182-183`、`packages/application/src/ports/mcp-connections.ts:29`、`apps/agent-service/src/production-mcp-read.ts:117`
- 问题：夹具把接入上限写成 `20`，生产是 `200`；把请求体上限硬编码成 `65536`。浏览器测试只是断言夹具输出的文字，改生产常量不会让测试失败。集成测试虽然发了 70,000 字节请求，但没有断言状态码 413。因此“测试了真实 65536 限制”不成立。
- 证据：
  - `control-center-browser-server.mjs:616`：`{ key: "mcp.connections", value: 20, used: live.length },`
  - `mcp-connections-browser.test.ts:136`：断言“接入个数：最多 20 个”。
  - `packages/application/src/ports/mcp-connections.ts:29`：`export const MCP_CONNECTION_MAXIMUM = 200;`
  - `test/integration/mcp-read.test.ts:1621-1627`：70,000 字节请求后只收集响应正文，未断言 413。
- 建议：夹具从生产常量派生，或在 `production-http-composition.unit.test.ts` 直接断言 `limits` 含 `mcp.connections = 200`、`mcp.request.body_bytes = MCP_READ_BODY_LIMIT`；并给超限请求加 `expect(status).toBe(413)`。

### 3. 中：新建接入的幂等是“先查后插”，并发重发会撞主键；撤销后重放语义也不对

- 文件：`apps/agent-service/src/production-mcp-connections-control.ts:215-230`、`packages/persistence-sqlite/src/sqlite-mcp-connection-operations.ts:155-188,191-196`、`apps/agent-service/test/production-http-composition.unit.test.ts:1170-1178`
- 问题：
  - `list` 和 `create` 分成两步，没有原子性。两个相同 `idempotencyKey` 的并发请求都查不到时会同时进入 `create`，后一个被 SQLite 主键约束拒绝；代码没有把约束错误映射成 `replayed`。
  - `store.list` 不过滤 `revoked`。同一命令在接入被撤销后重发，会返回 `replayed: true` 和已撤销的 id，但服务端不会再持有地址；网页随后取地址会 404，表现为“创建失败”。
  - 组合测试只断言第二次返回同一 id、连接数仍是 1，没有断言 `replayed === true`，也没有撤销后重放或并发重放用例。
- 证据：
  - 控制层 215-217 行：先 `list`，找到就 `return { resultRef: id, replayed: true }`。
  - 存储层 155-170 行：事务内 `SELECT COUNT(*)` 后直接 `INSERT`，没有 `ON CONFLICT`。
  - 存储层 191-196 行：`list` 只按 `owner_id, agent_id` 过滤，没有 `status <> 'revoked'`。
  - 测试 1176-1178 行只断言 `resultRef` 和长度。
- 建议：把幂等判断放进存储层，用原子 `INSERT ... ON CONFLICT` 返回已有记录；明确撤销后同一幂等键的行为（返回冲突/要求换键，或允许重新创建）；网页区分 `replayed`，无地址时不要提示“创建失败”；补并发、撤销后重放和 `replayed` 断言。

### 4. 低：隐藏字符规则在两处重复，缺少跨包一致性检查

- 文件：`packages/gateway-contracts/src/contracts-v2.ts:564-574`、`packages/application/src/ports/mcp-connections.ts:33-46`
- 问题：网关合约和存储各有一份完全相同的字符区间判断。当前确实一致，但没有“两端拒绝同一集合”的自动检查，后续很容易漂移（I-73 的教训：值只在两端各自认）。
- 证据：
  - 网关：`function isHiddenNameCharacter(code: number): boolean { ... }`
  - 应用：`export function mcpConnectionNameHasHiddenCharacter(name: string): boolean { ... }`
- 建议：共用同一份常量/表，或加跨包契约测试，用完整字符集逐项验证网关与存储接受/拒绝一致。

### 5. 低：连接窗口 Map 在撤销后不清理，长期可增长

- 文件：`apps/agent-service/src/production-mcp-read.ts:515-518,629-639`、`apps/agent-service/src/production-mcp-connections-control.ts:260`
- 问题：每个新接入 id 会创建两个 `AdmissionWindows` 并放进 `#connectionWindows`，但撤销时只 `addresses.drop()`，没有删除窗口。反复创建/撤销可让这个进程内 Map 无界增长；同时新建接入的幂等检查每次都 `store.list` 全部记录（包括撤销记录），成本随历史增长。这不是重提“撤销记录行数”的旧判断，而是新增的进程内资源问题。
- 证据：
  - `production-mcp-read.ts:515-518`：`readonly #connectionWindows = new Map<...>();`
  - `production-mcp-read.ts:629-639`：只有 `get` 和 `set`，没有 `delete`。
  - `production-mcp-connections-control.ts:260`：撤销时只 `this.#options.addresses.drop(changed.id);`
- 建议：撤销/暂停时删除窗口，或给 Map 加 TTL/上限；幂等检查改用按 id 的 `read`，不要拉全量 `list`。

## 推测（未执行验证）

### 6. 低：慢请求日志仍可能通过 `body.type` 带入密钥

- 文件：`packages/platform-node/src/http-gateway-server.ts:836-840`
- 推测：路径已经脱敏，但 `operation` 直接取自请求体的 `type` 字段。若客户端把密钥放进 `type`，慢请求日志仍会原样记录。这个需要客户端主动把密钥放在错误字段，实际触发概率低。
- 证据：`...(typeof body?.type === "string" ? { operation: body.type } : {})`
- 建议：不要记录任意 `body.type`，或只记录白名单/长度受限的枚举值。

## 侧重检查

- **错误路径与不可信输入**：读了 `admit`、`begin`、路由错误处理和存储校验。未知/格式错误密钥 404、暂停 403、撤销 404、限流 429、JSON 错误 400、超限 413 的映射基本成立；但超限 413 没有自动断言，见问题 2。
- **安全**：密钥从路由模板进入慢日志的路径已堵住；地址接口有登录校验、`no-store`、`no-referrer`；确定性连接 id 不含密钥。剩余风险是 POST/DELETE 无匹配路由没有回归用例（问题 1），以及 `body.type` 的推测路径（问题 6）。
- **资源耗尽**：撤销记录本身不再重提；但 `#connectionWindows` 不清理、幂等检查每次全量 `list`，属于新增的进程内/时间成本增长（问题 5）。
- **不可撤销操作**：撤销后不能再改回 active，存储层会以 `PORT_CONFLICT` 拒绝；网页有二次确认。问题是撤销后同一幂等键重放会返回已撤销连接（问题 3）。
- **规则/文档与代码一致**：ADR 的 200、64、65,536、30/60 与代码一致；页面文案与 `begin`/`getUsage` 的统计口径一致。浏览器夹具的 20 与生产 200 不一致，且 65,536 没有绑定常量（问题 2）。
- **提示词前缀**：本轮没有改 `packages/runtime-pi`、出口遮盖或历史消息组装；新增 `mcp.server-connection-required` 的 `usedBy` 只有 `production-mcp-read.ts`，`pi-runtime-adapter.ts` 导入的是另一组提示词。未发现 Himawari 自身模型请求前缀发生变化。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。Himawari 自己发给模型的系统提示、工具定义、历史消息和遮盖结果没有改动；新增 MCP 提示词和工具描述只用于对外 MCP 服务，`usedBy` 指向 `production-mcp-read.ts`。对外部 agent 来说，工具清单/说明只在新建或重连 MCP 会话时出现，属于新会话；同一连接内工具定义固定，工具结果作为响应追加，不是改写已经发出的历史。
未核实：`.claude/rules/prompt-prefix.md` 不在当前稀疏检出中，未能直接读规则原文；结论依据代码调用关系和仓库里的 I-66/ADR 0149、0164 说明。

**2. 同一段文字会不会在不同请求里变成不同字节？**

就模型请求而言不会。隐藏字符判断是纯函数；连接 id 由固定输入确定性推导且不进入模型文本；随机密钥、地址、`generatedAt`、当天日期等只出现在网页/存储/日志，不出现在模型消息里。对外 MCP 的 `MCP_SERVER_INSTRUCTIONS` 与 `MCP_SERVER_CONNECTION_REQUIRED` 是“按 URL 是否带密钥”二选一的固定文本，不是同一段文字依赖前后文变化。未发现依赖前后文的遮盖。

**3. 有没有对应的自动检查，反向用例真的会失败？**

有，但不完整：

- 隐藏字符：存储集成测试和网关合约测试都有反向用例；移除检查会让测试失败（已读断言）。
- 撤销名称不计入最长名：组合测试在撤销后断言 `used: 0`；移除 `status !== "revoked"` 过滤会让它失败。
- 新建幂等：顺序重发断言同 id 且只多 1 条；改成随机 id 会让它失败。但没有断言 `replayed`，没有并发/撤销后重放用例。
- 慢请求：GET 用例不能证明修复有效；改回旧代码它仍然通过，见问题 1。
- 65536：只有夹具硬编码和页面文字断言；改生产常量不会失败，集成测试也没有断言 413，见问题 2。
- “握手占额度但不计入限流数”没有直接行为测试，只有文案断言。

**4. 每个新值两端都能接受吗？**

逐项核对结果：

- **连接 id**：`mcpConnectionIdFor` 产生 `conn-` + 24 位十六进制；存储 `CONNECTION_ID`、迁移 CHECK、地址路由 `CONNECTION_ID_PATTERN`、网关 `machineString`/变更与轮换字段都能接受。
- **名称**：网关先 trim、限 64、查隐藏字符；存储 `name()` 同样限 64、查隐藏字符，快照/周报 schema 也复用同一规则。目前两端一致；但规则重复，见问题 4。
- **幂等键**：网页产生 `idempotency:<uuid>`，网关 `machineString` 允许冒号和连字符，长度也够；控制层直接用它做 sha256 输入，未发现不匹配。
- **请求体上限**：控制层由 `MCP_READ_BODY_LIMIT` 产生 65,536，快照 schema 接受整数，网页能显示；但夹具是硬编码，没有绑定生产值。
- **接入上限**：代码和 ADR 都是 200；浏览器夹具和测试断言是 20，明确不一致。
- **能力、读取上限、推送策略、状态、计数名、限制键**：网关枚举、应用常量、迁移 CHECK、存储校验和网页枚举一致。
- **提示词清单项**：`mcp.server-connection-required` 已登记；其 sha256 是否与正文一致，因不能运行哈希命令，未核实。

未核实项：`.agents/reviews/pr-479/round-2/judgments.md` 不在当前工作树中；本轮未运行任何测试，以上测试结论来自读测试代码和断言。
