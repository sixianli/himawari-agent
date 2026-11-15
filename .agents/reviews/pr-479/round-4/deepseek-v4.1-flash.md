## 结论

增量本身（`1d3425c5..c46bdf28`）没有发现高严重度的生产逻辑错误；第 3 轮修的三处代码与作者描述基本一致。主要问题集中在**新加的并发测试可能没有真正覆盖 catch 分支**、**隐藏字符测试的覆盖面与说法不一致**，以及少量长期资源和纵深校验问题。

## 发现（按严重度从高到低）

### 中（推测）— 并发创建测试可能根本没有打到新加的 catch 分支

- 文件:行：`apps/agent-service/test/production-http-composition.unit.test.ts:1281-1294`；`apps/agent-service/src/production-mcp-connections-control.ts:216-235`
- 问题：这是本轮核心修复唯一的自动检查，但它只是两个 `Promise.all` 的 HTTP 请求，没有任何屏障或假 store 强制两个请求都先通过 `created()` 预检查。若第二个请求的 `created()` 在第一个请求提交之后才执行，它会在第 218 行直接返回 replay，第 231-234 行新增的 catch 永远不会执行。此时即使删掉 catch，测试仍可能通过。
- 证据（读代码证实）：
  - 测试：`const twice = await Promise.all([0, 1].map(() => command("mcp.connection.create", "mcp-create-race", ...)))`，只断言 `[200, 200]`、`resultRef` 相同、过滤后一条记录。
  - 生产代码：`if (await created()) return { resultRef: id, replayed: true };` 在 `create` 之前；catch 分支是 `.catch(async (error) => { if (await created()) return null; throw error; })`。
- 影响：这是测试可靠性问题，不是已证实的产品缺陷；我没有运行测试（工具受限），所以“会不会真的漏掉”属于推测。
- 建议：加一个可控 store 的单元测试（例如让两个 `list` 都先返回空、再让其中一个 `create` 成功、另一个 `create` 失败），或加 barrier；并断言一个响应 `replayed:false`、另一个 `replayed:true`。

### 低 — 隐藏字符测试没有测到 store 的完整校验，也覆盖不到 Unicode 标签字符区

- 文件:行：`test/integration/mcp-connection-names.test.ts:7-28`；`packages/application/src/ports/mcp-connections.ts:33-45`
- 问题：作者说它比较“gateway 和 store 的隐藏字符拒绝”，但测试实际比较的是 gateway schema 与 `mcpConnectionNameHasHiddenCharacter` 这个共享谓词，并没有调用 `SqliteMcpConnectionOperations` 的 `name()` 校验。因此 store 端的 trim、长度、未来改用别的谓词等差异，这个测试都发现不了。
- 证据（读代码证实）：
  - 测试第 9 行只到 `code <= 0xffff`，第 10 行跳过代理项，第 11 行固定包成 `a${char}b`，第 25 行用 `mcpConnectionNameHasHiddenCharacter(name)` 比较，没有调用 store。
  - 新谓词只覆盖 `code < 0x20`、`0x7f-0x9f`、零宽/双向控制区等，**没有** `U+E0000–E007F`；而仓库已有的 `packages/platform-node/src/gmail-body.ts:59-69` 和 `packages/application/src/services/proactive-mail-body.ts:34-44` 都包含 `code >= 0xe0000 && code <= 0xe007f`。这类标签字符不可见，可用于名称伪装。
- 影响：名称由主人自己填写，React 渲染会转义，当前不是 XSS；属于输入规范/显示一致性缺口，严重度低。
- 建议：把隐藏字符谓词集中到一个共享函数并让 gateway、store 都引用；测试补 `U+E0000–U+E007F` 等 astral 码点以及实际的 `store.create` 路径（含首尾空白、超长）。

### 低 — 已撤销连接和每连接限流窗口没有上限或清理

- 文件:行：`packages/persistence-sqlite/src/sqlite-mcp-connection-operations.ts:191-195`；`apps/agent-service/src/production-mcp-connections-control.ts:133,176`；`apps/agent-service/src/production-mcp-read.ts:515-518`
- 问题：`list()` 返回所有记录，包括已撤销的；快照和周报也全部返回。`#connectionWindows` 只在首次请求时增加，撤销连接时不会删除。接入数上限 200 只限制未撤销记录，所以主人可以长期“创建→使用→撤销”无限累积已撤销记录和窗口条目。
- 证据（读代码证实）：
  - `list`：`SELECT ... WHERE owner_id = ? AND agent_id = ? ORDER BY created_at, id`，没有状态过滤，也没有分页。
  - 快照只把 `status !== "revoked"` 用于计数和名称长度，但 `connections` 仍返回全部。
  - `#connectionWindows = new Map(...)`，代码中没有按连接删除；撤销路径只 `addresses.drop(id)`。
- 影响：当前是主人手动操作才能增长，短期风险低；长期会让设置页响应、周报和内存持续变大。作者第 3 轮说“只随主人逐个创建的连接增长”基本成立，但漏掉了“撤销后不清理、总量无上限”。
- 建议：撤销时清理对应窗口（需要一个从 control 到 read 的回调或共享注册表）；对保留的已撤销记录设上限/分页；把 `Math.max(0, ...数组)` 改成 `reduce`，避免极端数量下的参数上限问题。

### 低 — `addUsage` 没有核对 connection 与 owner/agent 的归属

- 文件:行：`packages/persistence-sqlite/src/sqlite-mcp-connection-operations.ts:308-346`；`packages/persistence-sqlite/src/migrations/0095_mcp_connections.sql:28-39`
- 问题：`addUsage` 校验了 `connectionId` 是字符串、`day`、`tool`、`entry`、`auto`、counter，但没有确认这个连接确实属于传入的 `ownerId/agentId`。表的 FK 只是 `connection_id REFERENCES mcp_connections(id)`，不是复合外键。
- 证据（读代码证实）：`INSERT INTO mcp_connection_usage_daily (owner_id, agent_id, connection_id, ...)` 直接写入；迁移第 31 行只有 `connection_id TEXT NOT NULL REFERENCES mcp_connections(id)`。
- 影响：当前内部调用方 `recordMcpUsage` 使用 `findBySecret` 返回的、已按 scope 查到的连接，所以没有现成 bug；这是纵深防御缺口，一旦将来调用方传错 scope，会产生“归属错误但外键通过”的用量行。
- 建议：在同一事务里按 `(ownerId, agentId, connectionId)` 读取连接再写入，或把外键改成复合外键。

### 低 — 页面与后端对名称长度的计数口径不同；样例上限仍是旧值

- 文件:行：`apps/control-center/src/components/mcp-connections-settings.tsx:114,299`；`packages/application/src/ports/mcp-connections.ts:30`；`packages/gateway-contracts/src/contracts-v2.ts:946`
- 问题：前端用 `maxLength={64}`（按 UTF-16 码元计数），后端用 `[...name].length` / SQLite `length()`（按码点计数）。含 emoji 的名字在前端会更早被截断，后端本可接受。
- 另外：`apps/control-center/src/i18n/message-ids.ts:1765` 的样例仍是 `"agents.limit.connections": { value: 20, used: 1 }`，而真实上限和浏览器夹具已是 200（`test/e2e/fixtures/control-center-browser-server.mjs:616`）。这不是运行时错误，但容易让说明书/样例和代码漂移。
- 建议：统一样例值为 200；如果要求严格一致，前端改为按码点校验，或明确接受 UTF-16 口径并在文档中写清。

## 侧重检查

- **错误路径**：查了创建失败/replay、非法密钥、暂停、撤销、无效连接 id、超大请求体、非法 JSON、地址已被取走/过期、store 异常。结论：`not_found/paused/rate_limited/unavailable` 的 HTTP 映射完整；413 由 `bodyLimit` 和自定义 error handler 处理；store 异常走 `onFailure`，不会把密钥写进错误。
- **不合规范/不可信输入**：密钥符合 43 位 base64url；连接 id 有统一 pattern；名称有 trim、长度、隐藏字符校验；capabilities 拒绝重复和未知值；`reportedClient` 由 ASCII 正则截到 64；`day`、时间戳、counter 都有校验。发现的缺口是上面的 Unicode 标签字符和 `addUsage` 归属。
- **安全**：密钥只存 SHA-256；快照不返回摘要；慢请求日志改为记录路由模式，不再是带密钥的原始路径；地址接口要求 CF Access 断言和会话 cookie 同时存在（`packages/platform-node/src/identity-gateway.ts:636-647`），并设置 `no-store`、`no-referrer`、`sec-fetch-site` 检查，取一次即删除。密钥仍会出现在 URL 路径并被 Cloudflare Logpush 记录，这一点 ADR 和页面已明确提示，代码层面无法避免。
- **资源耗尽**：请求体 65,536 字节上限、每连接 30 次/分钟、自动读取 60 次/分钟均生效；发现的问题是已撤销记录和限流窗口长期无清理。
- **不可撤销操作**：撤销后 store 拒绝一切 change/rotate，UI 有二次确认；rotate 会让旧地址立即失效，UI 也有确认。新建/换密钥不要求最近重新登录是 ADR 明确选择，不是遗漏。
- **规则/文档/代码一致性**：ADR 0242 写的 200/64/65,536/30/60 与代码一致；浏览器夹具为 200；i18n 样例仍是 20，属于文档样例滞后。新增的 `mcp.server-connection-required` 只用于对外 MCP 服务，不进入 Himawari 自己的系统提示和工具定义。其 manifest sha256 **未核实**（无法运行校验命令）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - Himawari 自己的模型请求：不会。这个增量没有改对话请求的组装；新增的固定提示只供对外 MCP 服务使用，`MCP_SERVER_CONNECTION_REQUIRED` 不进入内部系统提示和工具定义。仍然只在末尾追加，每轮变化的值没有进入开头。
   - 对外部 agent：会变一次。不带密钥的旧地址现在不给工具、只给说明；带密钥的新地址才提供工具（`production-mcp-read.ts:730-743`）。ADR 0242 已明确“外部 agent 那边工具清单会变一次”，这是有意变更，不是缓存回归。
   - 另一个理论风险：把新固定文字加入提示词目录会扩大遮盖豁免清单；但这是新文字，且不含容易被当成秘密的数字，老历史里不应出现，故没有发现实际会改变老请求字节的路径。

2. **同一段文字会不会在不同请求里变成不同字节？**
   - 未发现新增问题。capabilities 由 `sortedCapabilities` 按固定顺序序列化；连接列表按 `created_at, id` 排序；用量行按固定字段排序，`readsByTool` 按 `MCP_READ_TOOLS` 顺序输出；limits 的键顺序固定；连接 id 由 owner/agent/idempotency key 的哈希确定性生成。`createdAt`、`lastSeenAt`、`generatedAt`、`reportedClient` 和计数会变，但它们只出现在网关快照/周报/页面，不进入模型提示前缀。对外 MCP 工具结果里仍有随机的 proposal id/时间（这是原有行为）。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   - 有：并发创建、慢 POST 未匹配路由、413、上限常量绑定、隐藏字符全 BMP 循环、store/UI/calibration 单测。
   - 会失败的反向用例：隐藏字符两边范围一旦不同，循环会报 disagree；去掉 body 上限，413 断言会失败；慢请求若记录原始 URL，测试会因日志含密钥失败。
   - 不足：并发创建测试是时序依赖的，**不能确定**去掉 catch 一定会失败；隐藏字符测试只到 `0xFFFF`、只比较谓词而非 store 校验，也不会覆盖 `U+E0000–U+E007F`。这两点见上面的中/低发现。

4. **每个值两端都能接受吗？**
   - 逐个核对后基本一致：`conn-<24hex>` 同时满足 control 的 `CONNECTION_ID_PATTERN`、SQLite CHECK、地址路由 pattern 和测试正则；43 位密钥满足 `MCP_CONNECTION_SECRET_PATTERN`、地址路由测试和 SHA-256 摘要格式；capabilities/status/readCeiling/pushPolicy 在 application、gateway contracts、SQL CHECK、UI 之间取值一致；limits 的 5 个键在控制层、gateway 枚举、UI 和夹具之间一致；迁移序号 95 在 engine、测试和审计脚本里同步更新。
   - 例外已在上面列出：名称长度前端按 UTF-16、后端按码点；i18n 样例仍是 20；`addUsage` 未校验连接归属；隐藏字符谓词与仓库已有清理函数不一致。
