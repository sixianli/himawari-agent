### 1、高、同根因的另一个 [P5-3] 用例仍走不带密钥的地址，改动后大概率仍然失败

- 文件:行：`test/integration/production-http-composition-process.test.ts:2137`、`test/integration/production-http-composition-process.test.ts:2159`、`test/integration/production-http-composition-process.test.ts:2161`
- 问题：作者只把「列工具」的用例改成带密钥地址，但同一文件里另一个 `[P5-3]` 用例仍然直接对裸路径 `/api/mcp/v1` 调用 `tools/call today_context`，并断言响应正文包含当前年份。按当前生产代码，裸路径即使 Cloudflare Access 校验通过也**不会注册任何工具**，这个用例仍会失败，或至少与作者描述的根因不一致。
- 证据（读代码证实）：
  - 该用例仍使用裸路径：`httpRequest(service.running().address, "/api/mcp/v1", {`，并断言 `expect(served.raw).toContain(String(new Date().getUTCFullYear()));`。
  - 生产代码在无 secret 时返回空 clientId：`apps/agent-service/src/production-mcp-read.ts:615-617`：
    ```ts
    if (secret === undefined) {
      if (this.#windows.admit(true) === "rate_limited") return { status: "rate_limited" };
      return { status: "ok", authInfo: { token: "", clientId: "", scopes: [], extra: {} } };
    }
    ```
  - `#server` 在拿不到连接时直接返回，不注册工具：`apps/agent-service/src/production-mcp-read.ts:771-782`：
    ```ts
    const connection = connectionOf(context.authInfo);
    const server = new McpServer(...);
    if (connection === null) return server;
    ```
  - 单元测试已经明确期望裸路径没有年份结果：`apps/agent-service/test/production-http-composition.unit.test.ts:990-991`：
    ```ts
    const bare = await call(await access.sign(), MCP_READ_PATH);
    expect(bare.body).not.toContain("2026");
    ```
- 建议：同样给这个用例插入有效接入记录并使用 `/api/mcp/v1/<密钥>`，或者把它改成明确验证「裸路径不提供工具」的反向用例。否则 CI 里可能仍会有一个 `[P5-3]` 用例红着。
- 说明：上述是读代码得出的确定结论；未实际运行该安装包用例。

### 2、中、测试直接写 `mcp_connections`，复制了生产的哈希与字段规则，后续容易漂移

- 文件:行：`test/integration/production-http-composition-process.test.ts:2167-2191`
- 问题：新函数直接 `INSERT INTO mcp_connections`，自己写 `createHash("sha256").update(secret, "utf8").digest("hex")`，并硬编码 `capabilities`、时间戳、id、name。今天这些值能通过约束，但它绕过了生产创建路径，未来生产侧改哈希方式、增加必填列或改校验时，测试可能插入一条「看起来成功、实际路由找不到」的记录。
- 证据（读代码证实）：
  - 测试自己算哈希：`createHash("sha256").update(secret, "utf8").digest("hex"),`。
  - 生产侧有统一函数：`apps/agent-service/src/production-mcp-connections.ts:18-20`：
    ```ts
    export function mcpConnectionSecretDigest(secret: string): string {
      return createHash("sha256").update(secret, "utf8").digest("hex");
    }
    ```
  - 生产创建路径还会做名称、能力、上限、数量等校验：`packages/persistence-sqlite/src/sqlite-mcp-connection-operations.ts:141-189`，测试的直接插入把这些都跳过了。
  - 当前值本身能通过 schema：`packages/persistence-sqlite/src/migrations/20261115113156_mcp_connections.sql:1-24` 要求 id 字符集、`secret_sha256` 为 64 位小写十六进制、`capabilities` 为 JSON 数组、`read_ceiling`/`push_policy`/`status` 在枚举内、时间格式匹配；测试写入的 `conn-installed-process`、64 位哈希、`'["mcp"]'`、`private`、`ask`、`active` 和 `2026-11-16T00:00:00.000Z` 都满足。
- 建议：优先通过生产仓储的 `mcpConnections().create(...)`，并用 `newMcpConnectionSecret()` / `mcpConnectionSecretDigest()`；或者走真实的 `mcp.connection.create` + 地址接口。若坚持直接写库，至少复用生产的 digest 函数，别在测试里复制实现。
- 说明：当前不会因此失败，这属于可维护性和测试真实性问题；未来漂移是推测。

### 3、低、集成用例只有正例，没有验证「无接入记录或密钥错误时列不出工具」

- 文件:行：`test/integration/production-http-composition-process.test.ts:2237-2245`
- 问题：改动只验证了「插入接入记录后能列出工具」，没有在集成层加一个反向断言，例如未插入记录时 `listTools` 为空、错误 secret 返回 404。这样测试无法证明「发工具列表确实依赖这条接入记录」，也无法防止将来裸路径重新意外提供工具。
- 证据（读代码证实）：
  - 新用例只有正例：`const secret = seedMcpConnection();` 后直接 `const names = await installedMcpToolNames(...)`，随后只断言 `today_context` 和 proposal 工具。
  - 反向覆盖目前只在单元层：`apps/agent-service/test/production-http-composition.unit.test.ts:985-996` 有错误 secret（404）和裸路径（不含年份）的检查；集成层没有对应检查。
- 建议：在集成用例里补一个很短的负例，例如在 `seedMcpConnection()` 之前或使用另一个 secret 调用一次 `listTools`，断言拿不到 `today_context`；或者单独加一个「裸路径无工具、带密钥有工具」的用例。
- 说明：不是当前改动导致的失败，是覆盖缺口。

**侧重检查**

我检查了错误路径和不可信输入相关的代码：无 secret 返回空 authInfo（`production-mcp-read.ts:615-617`）、secret 格式不合法返回 404（`:619-620`）、库中查不到或已撤销返回 404（`:632-633`）、暂停返回 403（`:634-635`），以及路由层如何把 secret 传给 `admit`（`:2007-2013`）。也核对了数据库约束与生产插入路径：id 字符集、`secret_sha256` 格式、`capabilities` 的 JSON 数组要求、`read_ceiling`/`push_policy`/`status` 枚举、时间格式（迁移 `20261115113156_mcp_connections.sql:1-24`），并核对了测试写入的 `ownerId`/`agentId` 在 `initializeTestDatabase` 中确有对应 `owners`/`agents` 行（`production-http-composition-process.test.ts:726-741`）。结论：新插入值本身能通过数据库和后端读取校验，没有发现「清单里的 id 过不了后端校验」这类问题；但发现同根因的另一个 `[P5-3]` 用例仍使用裸路径，见意见 1。安全、资源耗尽、不可撤销操作方面：这是测试代码，固定 secret 只进入测试数据库，没有发现生产影响；直接写库确实绕过了生产创建的校验，见意见 2。

**必答问题**

1. 这个改动会不会改变模型已经见过的请求开头？
   不会。`git show --stat` 显示只改了 `test/integration/production-http-composition-process.test.ts` 一个文件，没有改生产侧组装、系统提示、工具定义、历史或遮盖代码。新插入的 MCP 接入记录只影响外部 MCP 客户端通过 `/api/mcp/v1/<密钥>` 读取工具列表，不属于发给模型的内容。因此发给模型的内容仍然只在末尾追加，每轮变化的值也不会被这个改动带进前面的请求头。

2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？
   不会。改动本身没有引入依赖前后文的遮盖、时间字段或无序集合；新增的 secret 是固定的 `"A".repeat(43)`，哈希也是确定的。需要提醒的是，同一文件里未改动的 `[P5-3]` 用例仍用 `new Date().getUTCFullYear()` 做断言，但那是测试期望值，不是发给模型的内容。

3. 改动有没有对应的自动检查，反向用例是否真的会失败？
   有正例检查：新用例会断言带密钥地址能列出 `today_context`，并按 `proposals` 开关断言 `propose_memory`/`propose_rule` 的有无。但集成层没有为这次改动新增反向用例，验证「无接入记录或错误密钥时列不出工具」；反向覆盖目前只在单元测试 `production-http-composition.unit.test.ts:985-996`。另外，意见 1 中的 `[P5-3]` 用例与当前生产行为矛盾，说明这组自动检查本身并不一致。

4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？
   新产生的值包括：`id="conn-installed-process"`、`ownerId`/`agentId`、`name="installed-process"`、`secret_sha256`（64 位小写十六进制）、`capabilities='["mcp"]'`、`read_ceiling='private'`、`push_policy='ask'`、`status='active'`、`created_at/updated_at`。逐项核对：schema 约束都接受（迁移 `20261115113156_mcp_connections.sql:1-24`）；`ownerId`/`agentId` 有对应外键行（`production-http-composition-process.test.ts:726-741`）；路由用 `MCP_CONNECTION_SECRET_PATTERN` 校验 43 位 secret（`production-mcp-read.ts:619-620`），`findBySecret` 用相同 digest 和 owner/agent 范围查找（`sqlite-mcp-connection-operations.ts:205-211`），都能匹配。没有发现两端校验不一致。需要说明的是，直接插入绕过了生产 `create` 的数量限制和名称/能力校验，虽然当前值合法，但这是测试真实性问题，见意见 2。作者说的「PR 479 起裸路径不给工具」与当前代码行为一致；「是否为 PR 479 引入」我未核对历史提交，标为未核实。「云端跑不了、靠 CI 验证」也无法在当前环境核实。
