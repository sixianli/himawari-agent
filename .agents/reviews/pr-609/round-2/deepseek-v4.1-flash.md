这一轮复核范围：`760f903a..8158c059` 增量（`test/integration/production-http-composition-process.test.ts` 与 `.agents/reviews` 记录），并跟到 `dfd125ca..8158c059` 的测试改动；读了 MCP 路由、准入、工具注册、`mcp_connections` 表结构与读写实现、控制中心合约里的对应字段，以及 CI 分片配置。没有修改任何文件，也没有运行测试。

作者说法核对：上一轮意见 1 已改好。增量把同根因的 audience 用例从 `/api/mcp/v1` 改成 `/api/mcp/v1/${secret}` 并补种子；工具列表用例已在上一提交 `760f903a` 修好。作者的问题描述写的是“工具列表为空”，而本轮增量实际修的是另一个 `[P5-3]` audience 用例，两者根因相同。“仅测试文件”对产品代码成立；diff 里另有 `.agents/reviews/pr-609` 复核记录，不是功能代码。

## 侧重检查

- 错误路径：读了 `ProductionMcpRead.admit`（`apps/agent-service/src/production-mcp-read.ts:590-655`）与 `registerMcpReadRoute`（`production-mcp-read.ts:1987-2049`）。无 assertion→401；错误 audience→401；subject 未绑定 owner→401；secret 格式不符→404；revoked→404；paused→429；active 走放行。种子写的是 `active`，会走放行分支。
- 不合规/不可信输入：secret 必须匹配 `^[A-Za-z0-9_-]{43}$`（`production-mcp-connections.ts:11`），摘要必须 64 位小写 hex（`sqlite-mcp-connection-operations.ts:46-47` 与 `205-210`）；name、capabilities、read_ceiling、push_policy、status、时间戳都受表 CHECK（`migrations/20261115113156_mcp_connections.sql:1-24`）。种子值逐个满足。
- 安全：固定 secret 只存在于测试，生产代码未改；MCP 请求体上限仍是 65536（`production-mcp-read.ts:132`），没有新增暴露面。
- 资源耗尽/不可撤销：只向临时 stateRoot 的 SQLite 插一行，`afterAll` 会删临时目录（`test/integration/production-http-composition-process.test.ts:791-810`）；没有不可撤销操作。
- 规则/文档一致：增量没有文档改动；`prompt-prefix` 规则不涉及。I-73 要求的“产生端/消费端”已逐个核对，见必答问题 4。
- 同根因扫描：`grep` 整个 `test/` 的 `/api/mcp/v1`，只剩本文件两处（都已带 secret）和浏览器 fixture；单测 `apps/agent-service/test/production-http-composition.unit.test.ts:982-996` 故意保留裸路径作为反向断言。

## 意见

### 1、低、种子的 `INSERT OR IGNORE` 会把写入失败推迟成后面的 401/空工具列表，摘要计算也重复实现

文件: `test/integration/production-http-composition-process.test.ts:2168-2192`（关键行 `2174`）

问题：`seedMcpConnection` 用 `INSERT OR IGNORE` 写库，然后无条件 `return secret`。按 SQLite 的冲突处理语义，`OR IGNORE` 会跳过 CHECK/UNIQUE/NOT NULL 冲突；如果以后表约束或字段变化使这条种子无效，插入会被静默跳过，测试不会在写入处报错，而是在后面表现为 401 或空工具列表，排查成本更高。另外，摘要用 `createHash("sha256")` 重算，而生产端有 `mcpConnectionSecretDigest`（`production-mcp-connections.ts:18-20`），两处以后可能漂移。

证据：

```ts
const secret = "A".repeat(43);
...
`INSERT OR IGNORE INTO mcp_connections (
...
createHash("sha256").update(secret, "utf8").digest("hex"),
...
return secret;
```

当前种子值本身是合法的：id/name/capabilities/read_ceiling/push_policy/status/时间戳都过表 CHECK，`["mcp"]` 在 `MCP_CONNECTION_CAPABILITIES` 里（`packages/application/src/ports/mcp-connections.ts:14`）；`ownerId`/`agentId` 已由 `initializeTestDatabase` 插入（测试 `730-733`）。因此这不是当前会失败的缺陷，只是错误路径变模糊。

建议：改成普通 `INSERT`（每个 `openInstalledMain` 都是新库，种子每次只调用一次），或检查 `run().changes === 1`，为 0 时直接抛错；摘要改用 `mcpConnectionSecretDigest`。这样种子失败会在写入点暴露。

## 读代码证实的

- 无密钥 `/api/mcp/v1` 不注册工具：`#server` 在 `connectionOf(...) === null` 时直接 `return server`（`production-mcp-read.ts:769-782`）。这正是上一轮意见的根因，增量改成带 secret 的路径后能拿到工具。
- 有密钥时准入按 owner/agent + `secret_sha256` 查有效记录，并拒绝 revoked/paused（`production-mcp-read.ts:619-636`）；种子 `status='active'`、摘要与 `mcpConnectionSecretDigest` 一致，因此能通过。
- 种子的每个值都过对应校验：表 CHECK（`migrations/20261115113156_mcp_connections.sql:2-24`）、`DIGEST`（`sqlite-mcp-connection-operations.ts:46-47`）、`findBySecret` 查询（`sqlite-mcp-connection-operations.ts:205-210`）；控制中心若列这份连接，id 还过 `machineString`（`packages/gateway-contracts/src/validation.ts:51-61`），name/capabilities 也过对应 schema。
- 除本文件外，`test/` 里没有其他 MCP 集成用例仍走裸 `/api/mcp/v1` 取工具。
- 该测试属于 CI 的 `integration-2` 分片（`.github/workflows/ci.yml:258-266`），并依赖预构建产物（测试 `744-750`）。

## 推测 / 未核实

- 本环境没有 `HIMAWARI_TEST_ARTIFACT`/`HIMAWARI_TEST_CONTEXT`，没有实际运行这条集成用例，CI 结果未看到；结论来自代码推理。
- `INSERT OR IGNORE` 的未来“吞错”风险是推测；当前种子值已核对为合法。
- 在服务已启动后从测试进程直接写同一个 SQLite 文件，理论上可能遇到短暂写锁，但 `openQualifiedDatabase` 设了 `busy_timeout = 5000`（`packages/persistence-sqlite/src/migration-engine.ts:1213-1219`），且种子在服务启动完成后才执行，未看到实际冲突证据。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。增量只改测试文件的 MCP 请求地址和 SQLite 种子，没有改系统提示、工具定义、历史消息、遮盖或模型请求组装。发给模型的内容仍只在末尾追加、每轮会变的值仍在最后一条消息里这一规则没有被本改动触及；请求组装实现这一轮未重读（增量没有碰）。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及。改动不生成或修改任何发给模型的文本；时间戳只在测试数据库里，secret 只在测试 HTTP 路径里。没有依赖前后文的遮盖、带时间字段或无序集合进入模型请求。
3. **有没有对应的自动检查，反向用例会失败吗？** 有。改动本身就是集成用例修复，位于 integration-2；另有单测 `production-http-composition.unit.test.ts:982-996` 覆盖裸路径无内容、带 secret 有内容。反向推理：若仍走裸 `/api/mcp/v1`，`#server` 在无 connection 时提前返回，`listTools()` 为空、`tools/call today_context` 不会带出年份，两个断言都会失败，因此反向用例确实会失败。本环境缺预构建产物，未实际运行。
4. **改动产生或修改的每个值，使用端都能接受吗？** 能。`secret`（43 位）同时满足 `MCP_CONNECTION_SECRET_PATTERN` 和摘要消费端；`id`/`name`/`secret_sha256`/`capabilities`/`read_ceiling`/`push_policy`/`status`/时间戳分别过表 CHECK、`DIGEST`、`mcpConnectionSecretDigest`、`findBySecret`、`MCP_CONNECTION_CAPABILITIES` 和控制中心 schema。唯一需要留意的是写入方式：`INSERT OR IGNORE` 会在未来约束变化时静默跳过（低意见 1），当前值没有两端不一致。
