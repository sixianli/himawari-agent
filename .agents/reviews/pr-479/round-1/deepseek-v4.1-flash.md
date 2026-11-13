复核基准：`735962e686eb9654be5071d9f95a6d2ed67a8227`，对比 `2b1e2d2e5a189ac909239ba825af2407172d44b2`。以下结论来自读代码和现有测试文件，未运行测试。

## 读代码证实的问题（按严重度）

### 1. 严重度：高 — 带密钥的 MCP 路径会进入慢请求诊断日志
- 文件:行：`packages/platform-node/src/http-gateway-server.ts:832-843`、`apps/agent-service/src/service-main.ts:2908-2913`、`packages/platform-node/src/service-runtime.ts:85-86`
- 问题：MCP 路由自己设了 `logLevel: "silent"`，但慢请求钩子挂在应用层，仍然把原始 `request.url` 的路径交给 `onSlowRequest`。超过 2 秒或被中途取消的 MCP 请求会把 `/api/mcp/v1/<密钥>` 写进 `http.slow_request` 诊断日志，违反“日志、错误信息、决策记录只写接入编号”的约束。
- 证据：
  ```ts
  // http-gateway-server.ts:832-843
  const path = requestPath(request);
  if (totalMs < SLOW_REQUEST_MILLISECONDS || STREAM_PATH.test(path)) return;
  onSlowRequest({ method: request.method, path, ... });
  ```
  `requestPath` 就是 `request.url.split("?", 1)[0]`（同文件 237-239）。`service-main.ts` 又原样展开：
  ```ts
  onSlowRequest: (request) =>
    writeServiceDiagnostic(errorOutput, {
      component: "agent-service",
      event: "http.slow_request",
      ...request,
    }),
  ```
  `writeServiceDiagnostic` 只做 `redactMachineSecrets`（`service-runtime.ts:85-86`），而 `machine-secrets.ts:18-43` 的规则没有裸 43 位 base64url 密钥这一条，所以不会被遮掉。
- 建议：慢请求日志改用路由模板（如 `/api/mcp/v1/:secret`）或显式给 MCP 路径做脱敏，绝不使用原始 URL；同时补一条用例：构造超 2 秒/中止的 MCP 请求，断言日志、错误上报和指标里都搜不到密钥。现有“从不写密钥”用例只查了 failures、ledger、usage、连接记录和响应体，没有查慢请求日志。

### 2. 严重度：中 — 已撤销的接入仍占 200 个名额，页面却显示“不算已撤销”
- 文件:行：`packages/persistence-sqlite/src/sqlite-mcp-connection-operations.ts:151-156`、`apps/agent-service/src/production-mcp-connections-control.ts:172-177`、`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:254`
- 问题：新建时用 `COUNT(*)` 统计该 owner/agent 下所有接入，不排除 `revoked`；页面显示的上限用量却排除 `revoked`。撤销不可恢复，`McpConnectionStorePort` 也没有删除方法（`packages/application/src/ports/mcp-connections.ts:80-108`），因此一个用户只要累计建过 200 个接入（哪怕全部撤销），就永久不能再建，属于不可逆的资源耗尽。
- 证据：
  ```ts
  // sqlite-mcp-connection-operations.ts:151-156
  SELECT COUNT(*) FROM mcp_connections WHERE owner_id = ? AND agent_id = ?
  if (count >= MCP_CONNECTION_MAXIMUM)
    return this.fail("PORT_CONFLICT", "MCP_CONNECTION_LIMIT_REACHED");
  ```
  ```ts
  // production-mcp-connections-control.ts:172-177
  { key: "mcp.connections", value: MCP_CONNECTION_MAXIMUM,
    used: connections.filter(({ status }) => status !== "revoked").length }
  ```
  ADR 明确写“接入最多 200 个（不算已撤销的）”（ADR 0242:254）；`schema-catalog.ts:699` 还写明“a revoked connection stays so its usage stays explained”。
- 建议：新建计数改为只算非 `revoked`，或提供删除/清理已撤销接入的路径；补一条反向用例：建满、撤销一个后仍能新建。现有“stops at 200 connections”用例没有覆盖撤销后的情况。

### 3. 严重度：中 — `capabilities` / `pushPolicy` 只存不用，页面和 ADR 暗示的按接入权限没有生效
- 文件:行：`apps/agent-service/src/production-mcp-read.ts:597`、`apps/agent-service/src/production-mcp-read.ts:764-770`、`apps/agent-service/src/production-mcp-connections-control.ts:211-213`、`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:85`
- 问题：新建接入会保存主人勾选的能力和推送策略，但读服务注册工具时只看全局 `options.write`，不看当前接入的 `capabilities`，也不看 `pushPolicy`。全仓库搜索 `pushPolicy`，只有契约、存储、页面和测试引用，没有任何业务消费点。结果是：主人可以在页面上取消“能挂 MCP”，但该接入仍然能调用全部 MCP 工具；`pushPolicy: "direct"` 也不会改变推送行为。ADR 说接入设置应能在全局配置之内再收窄“某个接入能不能推、推来的要不要先问”。
- 证据：
  ```ts
  // production-mcp-read.ts:597
  const scopes = this.#options.write ? [READ_ACCESS, WRITE_ACCESS] : [READ_ACCESS];
  ```
  ```ts
  // production-mcp-read.ts:764-770
  const proposals = this.#options.write?.proposals;
  if (proposals && context.era === "modern" &&
      context.authInfo?.scopes.includes(WRITE_ACCESS) === true) { ...注册写工具... }
  ```
  保存处确实写入了能力/策略：
  ```ts
  // production-mcp-connections-control.ts:211-213
  capabilities: command.payload.capabilities,
  readCeiling: command.payload.readCeiling,
  pushPolicy: command.payload.pushPolicy,
  ```
- 建议：把连接的 `capabilities` / `pushPolicy` 放进 `ConnectionRef` 并用于注册或拒绝工具；若本 PR 只做存储，则至少不要让页面把“能力”呈现为已生效权限，并在 ADR/页面明确标注“暂未生效”。补反向用例：取消 MCP 能力后无工具或请求被拒；`pushPolicy: "direct"` 改变推送落点/确认行为。

### 4. 严重度：中 — 规则提议没有独立频率额度，页面上的“规则提议超频被拒”其实是通用每分钟额度
- 文件:行：`apps/agent-service/src/production-mcp-read.ts:627-649`、`apps/agent-service/src/production-mcp-read.ts:700-704`、`packages/calibration/src/mcp-connections.ts:95-98`、`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:126`
- 问题：`begin()` 对任何已知工具都使用同一个 `regular` 窗口（`auto` 时才用 hook 窗口）；`#knownTool` 也把 `propose_rule` 和推送工具包含进来。因此 `propose_rule` 被拒绝的原因是“普通读取/推送共享的每分钟 30 次”，不是 ADR 说的规则提议独立限频。统计函数又把所有非规则工具的 `rate_limited` 计入 `rateLimited`，而页面把这个数解释成“被限流的读取”，于是推送被限流也会被算进“读取被限流”。
- 证据：
  ```ts
  // production-mcp-read.ts:640
  const limited = (auto ? windows.hook : windows.regular).admit(true) === "rate_limited";
  ```
  ```ts
  // production-mcp-read.ts:700-704
  #knownTool(name: string): boolean {
    return this.#readTools.some((tool) => tool.name === name) ||
      (MCP_WRITE_TOOL_NAMES as readonly string[]).includes(name);
  }
  ```
  ```ts
  // calibration/src/mcp-connections.ts:95-98
  if (row.counter === "rate_limited") {
    if (rules.has(row.tool)) tally.ruleProposalsRateLimited += value;
    else tally.rateLimited += value;
  }
  ```
  ADR 0242:126 明确说“规则提议按接入单独限频率……超了直接拒，不试算、不发确认”。
- 建议：为 `propose_rule` 建独立窗口（或在 `begin` 中按工具类别选择窗口），并把“读取被限流”“推送被限流”“规则提议被拒”分开计数；若不打算本 PR 实现独立限频，就改页面定义并去掉“单独限频”的说法。补用例：大量读取不应改变规则提议的“超频被拒”数。

### 5. 严重度：低 — 地址接口的“same-origin only”只在浏览器带了头时才生效
- 文件:行：`apps/agent-service/src/production-mcp-connections-control.ts:285-287`
- 问题：`Sec-Fetch-Site` 缺失时直接放行，因此“same-origin only”并非严格成立；非浏览器客户端或未发送该头的旧浏览器仍可用会话 cookie 读取一次性密钥地址。地址接口也没有 CSRF 校验。
- 证据：
  ```ts
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none")
    return reply.code(403).send();
  ```
- 建议：对这个仅浏览器使用的接口要求 `Sec-Fetch-Site` 必须是 `same-origin`/`none`，或增加 `Origin`/`Host` 校验；补一条跨站请求返回 403 的反向用例。现有测试验证了无 cookie 为 401、取过一次为 404，但没有验证跨站拒绝。

### 6. 严重度：低 — 名称和请求体上限没有显示“当前用量”，与作者说法和页面 ADR 不一致
- 文件:行：`apps/agent-service/src/production-mcp-connections-control.ts:178-179`、`apps/control-center/src/i18n/resources/zh-CN.ts` 的 `agents.limit.name` / `agents.limit.body`
- 问题：README/作者说“每个上限都显示数值和当前用量”，ADR 0242:176 和 253 也这么写；但 `mcp.connection.name_characters` 和 `mcp.request.body_bytes` 的 `used` 都是 `null`，页面文案只显示最大值，不显示当前用量。
- 证据：
  ```ts
  { key: "mcp.connection.name_characters", value: MCP_CONNECTION_NAME_MAXIMUM, used: null },
  { key: "mcp.request.body_bytes", value: MCP_READ_BODY_LIMIT, used: null },
  ```
- 建议：要么为这两项定义有意义的当前用量（如最长名称字数、最近请求最大体），要么在页面和 ADR 中明确它们是静态上限、不显示当前用量。

## 推测 / 未核实
- 未运行测试，因此不知道上述反向用例实际是否会失败；以下结论只说明“现有测试文件没有覆盖”。
- `store.create`/`store.change` 只检查名称的 trim 和长度，不检查隐藏字符；网关契约会拒绝隐藏字符。当前唯一生产入口经过网关契约，所以暂时不可达；如果以后有导入、服务令牌或直接 store 调用，隐藏字符名称会被存进去，随后 `mcp.connections.read` 的快照契约会拒绝整个响应。属于潜在一致性风险，未在现有路径证实可利用。
- 周报窗口沿用 `resolveWindow` 的日本时间（`packages/calibration/src/index.ts:259-270`），而用量按 `runPolicy.timeZone` 记日。生产配置是 `Asia/Tokyo`（runbook 明确），所以当前没有差异；如果将来允许非日本时区部署，周报和页面可能错开一天。此项未在本次改动范围内证实为实际问题。
- 新 prompt 的 manifest 哈希是否与 `packages/prompt-catalog/src/tools.ts` 完全一致，未运行构建/检查，未核实。

## 侧重检查
- 错误路径和不可信输入：未知/格式错误密钥返回 404，暂停 403，撤销 404，且都在 Cloudflare Access JWT 检查之后；无断言时即使密钥有效也是 401。以上与作者说法一致，已读代码确认。
- 密钥泄露：响应、`failures`、决策记录、用量记录、连接记录未见密钥或摘要；但慢请求日志路径会泄露（第 1 条）。
- 资源耗尽：单请求体上限 65,536 仍由 Fastify `bodyLimit` 守住；`#connectionWindows` 和 `#unsettled` 的上界受接入数和在途请求限制；但 200 接入上限因撤销记录永久占用（第 2 条）。
- 不可撤销操作：撤销后不能恢复（`change` 对 `revoked` 返回 `PORT_CONFLICT`），且没有删除接口；与第 2 条叠加会永久耗尽名额。
- 规则/文档一致性：ADR 说按接入收窄推送权限、规则提议独立限频、每个上限显示当前用量，代码分别未实现或部分未实现（第 3、4、6 条）；ADR 说 200 不算撤销，代码算（第 2 条）。
- 自动化检查：键拒绝、裸地址无工具、读取上限隔离、空自动搜、hook 额度、密钥不出现在响应/记录、地址一次性、存储校验、周报/页面共用统计都有测试；但慢请求日志、撤销后的上限、跨站地址请求、按接入能力/推送策略没有反向用例。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - Himawari 自己发给模型的请求、系统提示、工具定义、历史、遮盖结果：这个 PR 没有改这些组装路径，新增的 MCP 提示词只被 `production-mcp-read.ts` 用在对外 MCP 服务上。
   - 对外 MCP 客户端：会变一次。以前用裸地址的客户端现在拿不到任何工具，并且收到新的提示说明；ADR 0242 已明确接受“外部 agent 那边，工具清单会变一次”。使用新专属地址的客户端从一开始就是新开头，之后同一 URL 的说明和工具集合稳定。
   - 每轮会变的值：没有新增到提示里。连接编号、密钥、数量、最近使用时间、页面统计都不进入 MCP 系统提示或工具定义。对于固定专属 URL，后续请求的工具集合和说明不再按请求变化；这仍符合“固定的在前、会变的在后”，但不是字面意义上的“只追加”——对旧裸地址客户端是一次性的替换，且已由 ADR 记录。`npm run check:prompt-prefix` 只覆盖 Himawari 自己的请求，覆盖不到这一层。

2. **同一段文字会不会在不同请求里变成不同字节？**
   - 不会因这个改动新增不确定性。新加的 `MCP_SERVER_CONNECTION_REQUIRED` 是固定文本；读工具顺序由 `MCP_READ_TOOLS` 固定；遮盖逻辑没有改。
   - 统计和页面侧虽然用了时间和随机密钥，但它们不进入模型请求；用量统计由 SQL `ORDER BY`、固定工具清单和固定 `limits` 顺序生成，页面/周报重复读取的结果稳定。
   - 没有发现新代码把时间、连接名、密钥或无序集合放进模型可见的系统提示/工具定义。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   - 已有较好覆盖：存储层拒绝非法 id/名称/能力/上限/用量计数；未知/暂停/撤销密钥；裸地址无工具；读取上限隔离；空自动搜不写决策记录；hook 独立额度；密钥不出现在失败、决策记录、用量和响应；地址一次性；网关契约；页面/周报共用统计。
   - 但反向覆盖不完整，而且已被第 1 条击穿：`test/integration/mcp-read.test.ts` 的“never writes the key”只检查了 failures、ledger、usage、connection 和响应体，没有检查慢请求日志/指标，因此即使日志泄露密钥该用例仍会通过。
   - 上限测试只测了连续建满 200 个，不测撤销后再建，因此第 2 条不会被发现。
   - 地址接口没有跨站 `Sec-Fetch-Site` 的反向用例；`MCP_SERVER_CONNECTION_REQUIRED` 也没有“不得进入 Himawari 自己系统提示”的断言（至少在新增测试中未看到）。

4. **每个新值/字段/键/清单项，两端都能接受吗？**
   - 已验证一致的：`newMcpConnectionId()` 生成的 `conn-<24 hex>` 能通过迁移的 id CHECK、地址路由的 `CONNECTION_ID_PATTERN` 和网关 `machineString`；`mcp-connection:<id>` 长度在决策记录 1..256 和外部提议 1..128 之内；`mcp:<id>` 在规则来源 1..256 之内；`readCeiling` 的 `public/private/sensitive` 在 application、gateway、SQLite CHECK 和 `ceilingOf` 一致；`newMcpConnectionSecret()` 的 43 位 base64url 与 `MCP_CONNECTION_SECRET_PATTERN` 一致；用量计数、day 格式、limits 的键、页面/周报的 snapshot 字段两端基本一致。
   - 不一致的：`mcp.connections` 上限的生产端（store）把 revoked 计入，消费端（页面）把 revoked 排除（第 2 条）；`capabilities` / `pushPolicy` 只有生产、存储和展示，业务端没有消费（第 3 条）；规则提议限流计数生产端和页面定义不一致（第 4 条）；名称隐藏字符网关契约拒绝、SQLite/存储层接受，当前入口不可达但两端校验不对称。
   - 所以不能只看改动本身：至少“已撤销接入仍占上限”和“能力/推送策略没有消费端”是跨生成端与使用端核对后才暴露的问题。
