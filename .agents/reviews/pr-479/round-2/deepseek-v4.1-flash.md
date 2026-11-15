我读了 `2b1e2d2e..95f54b69` 的完整改动，以及 `735962e6..95f54b69` 的增量，重点核对了 MCP 密钥、限流、撤销/换密钥、控制中心快照和 ADR 0242。下面按严重度排列。

## 发现

### 高：慢请求日志在未匹配路由/中止时仍可能把 MCP 密钥原样写入日志

文件：`packages/platform-node/src/http-gateway-server.ts:832-834`

问题：匹配到 `/api/mcp/v1/:secret` 时确实用路由模板；但 `routeOptions.url` 不存在时直接回退到原始路径。原始路径含密钥，而 `writeServiceDiagnostic` 的机器密钥规则不识别 43 位 base64url 的 MCP 密钥（`packages/sensitive-capture/src/machine-secrets.ts:18-43` 只覆盖 Bearer、JWT、OpenAI/GitHub/AWS 和带键名的赋值）。ADR 0242 写的“日志只写接入编号”因此仍可能被打破。

证据：

```ts
const raw = requestPath(request);
if (totalMs < SLOW_REQUEST_MILLISECONDS || STREAM_PATH.test(raw)) return;
const path = request.routeOptions.url ?? raw;
```

新增测试只覆盖了成功匹配的 GET：`packages/platform-node/test/http-gateway-server.contract.test.ts:374-406`，没有 404、尾斜杠、多一段路径或 aborted 的用例。

建议：对以 `/api/mcp/v1/` 开头的路径永不回退原文，至少替换成固定模板或占位符；补 404/abort 的反向测试。
**推测**：Fastify 5.12.1 对未匹配路由的 `routeOptions.url` 是 `undefined` 还是空串，我未能在当前稀疏检出中核实；若为 `undefined`，上述泄露可直接触发。回退写法本身已不应保留。

### 中：撤销不占 200 名额后，记录、统计和快照都没有上限

文件：`packages/persistence-sqlite/src/sqlite-mcp-connection-operations.ts:150-158`、`apps/agent-service/src/production-mcp-connections-control.ts:133-171`

问题：以前 revoked 也计数，行数被 200 封顶；现在只数非 revoked，记录又永久保留，且 `list()`/`mcp.connections.read` 全量返回。反复“建满 200 → 撤销 → 再建”可让 `mcp_connections`、`mcp_connection_usage_daily` 和每次设置页快照无限增长；计数查询也因此退化为扫描大量历史 revoked 行。

证据：

```ts
"SELECT COUNT(*) FROM mcp_connections WHERE owner_id = ? AND agent_id = ? AND status <> 'revoked'"
```

```ts
const connections = await this.#options.store.list(scope);
...
connections.map((connection, index) => { ... })
```

建议：给 revoked 记录和 usage 行设保留策略或分页；快照限制返回数量；至少给 `(owner_id, agent_id, status)` 建索引，并补“长期 churn 后 list/snapshot 有界”的测试。

### 中：每连接每分钟窗口把握手请求和 `propose_rule` 也算进“读取和推送”

文件：`apps/agent-service/src/production-mcp-read.ts:626-642`

问题：`windows.regular.admit(true)` 在判断 `known`/`call === null` 之前执行。`initialize`、`tools/list`、`notifications/*` 都会消耗普通额度；`propose_rule` 也消耗同一个 regular 窗口，但只把拒绝计入 `ruleProposalsRateLimited`。控制中心却说“每个接入每分钟读取和推送”（`apps/control-center/src/i18n/resources/zh-CN.ts:1526-1527`），定义又说被限流不含规则提议。实际语义比文案宽。

证据：

```ts
const limited = (auto ? windows.hook : windows.regular).admit(true) === "rate_limited";
if (!known || call === null)
  return limited ? { status: "rate_limited" } : { status: "ok", authInfo };
```

建议：只在确认是工具调用时消耗额度；若规则提议继续共用该额度，文案应写成“工具调用（含规则提议）”或把规则提议拆到独立额度，并补对应测试。

### 中：create / rotate 没有使用幂等键，重试会重复建接入或再次换密钥

文件：`apps/agent-service/src/production-mcp-connections-control.ts:212-227,260-272`

问题：命令带 `idempotencyKey`，网关也校验请求头一致（`packages/platform-node/src/http-gateway-server.ts:1098-1101`），但这里每次 create 都生成新 id/新密钥，每次 rotate 都重新生成密钥，始终返回 `replayed: false`。响应丢失或人工重试会留下重复接入，或把刚生成、尚未取走的新密钥再次作废。

证据：

```ts
const secret = newMcpConnectionSecret();
const record = await this.#options.store.create({ ... });
this.#options.addresses.hold(record.id, secret);
return { resultRef: record.id, replayed: false };
```

建议：按 `command.idempotencyKey` 去重；重试返回原 `resultRef`/`replayed: true`，并补“同一幂等键提交两次只产生一个接入/一次轮换”的测试。

### 低：名称在两端的校验不一致，隐藏字符可能让快照整体校验失败

文件：`packages/persistence-sqlite/src/sqlite-mcp-connection-operations.ts:55-59`、`packages/gateway-contracts/src/contracts-v2.ts:947-963`

问题：网关的 `mcpConnectionNameSchema` 拒绝零宽、控制字符等隐藏字符；存储层 `text()` 只检查 trim 和长度。当前正常写入都先过网关，所以不可直接利用；但未来迁移、导入或直接调用 store 写入隐藏字符后，`mcp.connections.snapshot` 和每周报告会因同一名称过不了网关校验而整体失败。

证据：

```ts
function text(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const length = [...value].length;
  return length >= 1 && length <= maximum;
}
```

建议：把名称校验抽成共享实现，或在 store 中补隐藏字符检查，并加“store 直接写入隐藏字符应被拒绝”的反向测试。

### 低：新增测试没有覆盖声明中的几个关键点

文件：`packages/platform-node/test/http-gateway-server.contract.test.ts:374-406`、`test/integration/mcp-connections-browser.test.ts:177-184`、`test/e2e/fixtures/control-center-browser-server.mjs:622`

问题：

- 慢请求只测匹配成功的 GET，没有 404/abort，无法守住“密钥永不进日志”。
- 浏览器测试只验证了名称和请求体文案；没有断言“被限流：读取和推送（不含规则提议）”以及“每分钟读取和推送”的新措辞，改回旧文案测试仍会通过。
- 名称限制的 `used` 只测了一个 active 连接，没有反向测试“revoked 名称不参与最长值”。
- e2e fixture 的请求体上限是 `1048576`，生产是 `65536`；测试没有断言数值，fixture 漂移不会暴露。

建议：补上述反向用例；fixture 与生产常量对齐。

## 作者说法核对

- #1 路径模板部分正确，但“密钥永不进日志”过强：`?? raw` 仍留了原文回退路径，且没有 404/abort 测试。
- #2 正确：计数只排除 revoked；但由此带来的记录无限增长没有说明，见上。
- #3 正确：create/change 都只接受 `"ask"`；网关契约和数据库仍接受 `"direct"`，目前只是 control 层拦截，符合“任务 C 前”的临时状态。
- #4 三语文案确实改了，但测试只覆盖名称/请求体两条；限流定义和每分钟措辞没有断言。
- #5 ADR 0242 的补充与代码基本一致；但“日志只写接入编号”沿用了 #1 的过强说法。
- 对 round 1 的三条判断：`Sec-Fetch-Site` 缺失不构成跨站读取，且会话 cookie 是 `SameSite=Strict`（`packages/platform-node/src/built-in-identity-routes.ts:48-54`），我接受；capabilities 没有权限语义，我接受；没有独立的 `propose_rule` 限流，我接受，但普通窗口确实把 `propose_rule` 算进去了。

## 读代码证实的 / 推测

**已证实：** 上述慢日志回退、撤销计数、全量 list/snapshot、`#connectionWindows` 不随撤销清理、握手和 `propose_rule` 消耗 regular 窗口、create/rotate 未用幂等键、名称 store/网关校验不一致、测试覆盖缺口、e2e fixture 请求体数值不一致。

**推测/未核实：**

- Fastify 5.12.1 在 404 时 `routeOptions.url` 的具体取值；这决定慢日志泄露是否能直接复现。
- 除网关外是否真有其他路径把隐藏字符名称写进 `mcp_connections`。
- 我没有运行 `npm run check`、`npm run check:prompt-prefix` 或 vitest；`prompt-manifest.json` 的新哈希也未重算。
- `.agents/reviews/pr-479/round-1` 在当前稀疏检出中不存在，我未读到 round 1 的原始判决文件。

## 侧重检查

- **错误密钥/缺少密钥/暂停/撤销**：`admit` 分别映射到 401/404/403/404；测试覆盖未知/格式错误密钥、暂停、撤销、轮换后旧密钥失效；失败对象和回复不写密钥。唯一缺口是慢请求日志。
- **不可信输入**：名称走网关 trim、64 字符、隐藏字符检查；能力去重并枚举；连接 id 有正则；body 限 65,536 字节；MCP 路由有独立错误处理。名称的 store 端校验偏松，见上。
- **安全边界**：地址接口要求 owner 会话、id 格式、一次性 10 分钟内存地址；会话 cookie 为 `SameSite=Strict`，跨站请求带不上 cookie，且无 CORS，跨站读取/消耗的路径不成立。
- **限流与资源**：普通/钩子窗口按连接隔离，但协议握手也计数；撤销后窗口不释放；revoked 记录永久保留且快照全量，存在长期资源增长。
- **不可撤销操作**：撤销不可恢复，UI 有确认；换密钥旧密钥立即失效，UI 有确认；create/rotate 的幂等缺口是主要错误路径问题。
- **规则/文档一致性**：Himawari 自己的系统提示和工具定义没有新增 MCP 内容；新提示只被 `production-mcp-read.ts` 使用。ADR 0242 关于“日志只写接入编号”的说法与慢日志回退不一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会改变 Himawari 自己的请求开头。新增的 `mcp.server-connection-required` 只被外部 MCP 服务 `production-mcp-read.ts` 使用，没有进入内部系统提示、内部工具定义或历史；`prompt-manifest.json` 只是登记了这个外部固定文本。外部 MCP 侧工具顺序由固定的 `MCP_READ_TOOLS` 决定，说明文字是固定常量；带密钥的 URL 每次拿到同一组说明和工具。没有发现把每轮变化值放进系统提示或工具定义。裸 URL 与带密钥 URL 的说明不同，但裸 URL 不提供工具，也不构成同一外部会话的逐轮变化。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   未发现。新增文本是固定提示；快照中的 `generatedAt`、窗口日期和用量只在控制中心/周报里，不进模型请求；`capabilities` 在 store 中排序，`readsByTool` 按固定工具顺序输出，连接列表按 `created_at, id` 排序。新增固定提示加入提示词目录理论上会改变“固定文本”集合，但这段新文字以前不可能出现在旧对话里，未发现对既有历史遮盖的实际影响。

3. **有没有对应的自动检查，反向用例会失败吗？**
   有，但不完整。store 的 revoked 计数测试有效：去掉 `status <> 'revoked'` 后 `conn-after-revoke` 会失败。pushPolicy 的 create/change 反向用例有效：去掉 `askFirstOnly` 后会返回 200。慢请求测试只能守住“匹配路由时不用原文”，守不住 404/abort。限流定义和“读取和推送”措辞没有断言，改回旧文案不会失败。名称 `used` 的 revoked 排除、名称 store 隐藏字符、create/rotate 幂等都没有反向用例。审查环境未实际运行这些检查。

4. **每个值两端都能接受吗？**
   当前主路径基本一致：操作 id 同时出现在 `contracts-v2.ts`、`PRODUCTION_MCP_CONNECTION_OPERATIONS`、安装列表、前端调用和测试中；`MCP_CONNECTION_LIMIT_KEYS` 的五个键与 control 输出的五个键一致，快照 `used` 均为整数或 null；`name_characters` 的 `used` 是整数，契约接受；`mcpConnections` 周报字段为 nullable，生产者也返回 null 或对象；`mcp-connection:` / `mcp:` 前缀长度都在 ledger 和 rule source 的限制内。
   仍有三个值得注意的边界：一是 revoked 记录不再受 200 约束，消费方 `list`/snapshot 没有分页；二是名称 store 端比网关快照端宽松；三是 `pushPolicy` 的 `"direct"` 仍被契约、数据库和 store 接受，只有 control 层拒绝，属于临时约定而非两端都拒绝。另有重复常量（`MCP_CONNECTION_NAME_MAXIMUM` 与 `MCP_CONNECTION_NAME_CHARACTERS`、两套状态/能力枚举）目前值一致但没有自动一致性测试；e2e fixture 的请求体上限也与生产 65,536 不一致。
