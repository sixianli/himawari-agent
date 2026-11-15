**本轮范围**：增量提交 `314f5895`（第 4 轮低问题修复）、`66505c39`（客户端能力表）；合并 `c4ecdef6`、`07e6d1ef` 落在 PR 文件上的冲突解决（`production-mcp-read.ts`、`production-mcp-rule-writer.ts`、`production-approval-gateway.ts`、`production-http-composition.ts`、`production-observation.ts`、control-center 设置/周报/i18n、`contracts-v2.ts`、`client-capabilities.ts`、SQLite 注册与迁移）。没有重读增量未触及、行为也未被增量改变的旧代码；证据指向旧代码时跟到了对应实现。

### 1 中 — 合并后参数错误的 `find_memories` 被计成“交出内容”，与决策记录里的失败矛盾

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:1330`、`:1353-1358`、`:1404`、`:1433-1438`、`:1556-1565`
- 问题：`c4ecdef6` 合并时把 main 的 `rejected` 结果与 PR 的按连接用量计数拼在一起，但 `readCounts` 只区分“未交付”和“空结果”。日期非法等 `MEMORY_RECALL_INPUT_INVALID` 会得到一个已定义的 `delivered`，其中 `rejected: true`、`empty: false`，于是 `#record` 写成 `find_memories_failed`，`#settle` 却记成 `{ delivered: 1 }`。同一笔调用在决策记录里是失败，在接入统计里是成功交付。
- 证据：
  ```ts
  memoryIds: outcome.rejected ? undefined : outcome.memoryIds,
  empty: outcome.empty === true,
  ...(outcome.rejected ? { rejected: true as const } : {}),
  ...
  await this.#settle(connection, tool.name, auto, readCounts(delivered));
  ...
  function readCounts(delivered: { readonly empty: boolean } | undefined) {
    if (!delivered) return { failed: 1 };
    return delivered.empty ? { empty: 1 } : { delivered: 1 };
  }
  ```
  以及 `#record` 的 `reasonCode: memoryIds ? name : `${name}${MCP_READ_FAILED_SUFFIX}``。现有 `[T6]` 日期错误用例（`test/integration/mcp-read.test.ts:966-986`）只断言了文本和决策记录，没有断言用量。
- 建议：让 `readCounts` 接受 `rejected`（命中时返回 `{ failed: 1 }`），或在 `#settle` 前显式判断 `delivered.rejected`。在 `[T6]` 或“输入检查拒绝”用例里补断言：`find_memories/model/failed = 1`，且没有 `delivered/empty`。

### 2 低 — 第 4 轮“隐藏字符测试没测到 store 完整校验”只修了一半，作者“compared against the store”的说法与代码不符

- 文件:行：`test/integration/mcp-connection-names.test.ts:1`、`:7`、`:18-31`；`packages/persistence-sqlite/src/sqlite-mcp-connection-operations.ts:56-64`；`test/integration/mcp-connections-store.test.ts:111-139`
- 问题：标签字符区 `U+E0000–U+E007F` 确实加进了 gateway 和 application 两处，测试也遍历到了该区。但测试比较的是 gateway schema 和 `mcpConnectionNameHasHiddenCharacter`，并没有调用 store 的 `name()`；store 的完整校验是 `text(value, 64)`（含 trim 和码点长度）再调用同一个 helper。store 测试仍只有 `\u200b`、`\u202e` 和 65 个 ASCII 字符，没有标签字符。若实现和测试都把标签区一起删掉，当前测试仍会通过；若 store 以后不再调用 helper，也没有测试会失败。
- 证据：
  ```ts
  import { mcpConnectionNameHasHiddenCharacter } from "@himawari-agent/application/mcp-connections";
  ...
  if (accepted === mcpConnectionNameHasHiddenCharacter(name))
  ```
  ```ts
  function name(value: unknown): value is string {
    return text(value, MCP_CONNECTION_NAME_MAXIMUM) && !mcpConnectionNameHasHiddenCharacter(value);
  }
  ```
  store 测试的隐藏字符用例只有 `{ name: "Claude\u200bCode" }`、`{ name: "Claude\u202eCode" }`。
- 建议：在 `mcp-connections-store.test.ts` 增加直接 `store.create` 的标签字符用例（例如 `a\u{E0001}b`）和 64/65 码点边界用例，断言 `PORT_INVALID_OPERATION`；同时把测试标题或注释改准，避免继续声称直接测了 store。若想锁死“标签字符必须拒绝”，应显式断言拒绝，而不只是两边一致。

### 3 低 — 页面名称截断改为码点后仍与后端“先 trim 再计数”有边界差异，且没有自动检查

- 文件:行：`apps/control-center/src/components/mcp-connections-settings.tsx:24-25`、`:116-121`、`:300-305`；`packages/gateway-contracts/src/contracts-v2.ts:1297-1302`
- 问题：页面现在按码点截 64 个，方向正确；但它对**未 trim 的原始值**切片，gateway 是 `trim()` 后按码点计数。名称带首尾空白时，页面可能比后端早截掉一个有效字符。更关键的是，这次修复没有测试：`withinNameLimit` 未导出，`mcp-connections.unit.test.ts` 和浏览器测试都只填 `"Claude Code"`，没有验证 64 个码点、64 个 emoji 或首尾空白。样例值从 20 改成 200 只影响 i18n 格式化，没有任何断言它和服务端常量一致。
- 证据：
  ```ts
  function withinNameLimit(value: string): string {
    return [...value].slice(0, MCP_CONNECTION_NAME_CHARACTERS).join("");
  }
  ```
  ```ts
  const trimmed = input.trim();
  const characters = [...trimmed];
  ```
- 建议：先 trim 再切片（或只对 `value.trim()` 的结果切片），补一个页面/单元测试：64 个 astral 字符可保留、65 个被截、首部空格不额外占一个名额；另可加断言让 `MCP_CONNECTION_MAXIMUM`、序列化样例和页面显示保持一致。修复本身已让页面/网关/存储都按 64 码点计数，我未发现新的越界接受路径。

**侧重检查**

- 错误路径：重点跟了 `MEMORY_RECALL_INPUT_INVALID` 的产出（`production-memory-recall.ts:140-141`）和消费（`production-mcp-read.ts:1556-1565`），发现意见 1 的计数不一致；其余 `rejected` 路径会写失败决策记录、返回 `isError`，没有静默成功。
- 不可信输入：连接名在 gateway（trim + 码点长度 + 隐藏字符）、store（trim 拒绝 + 码点长度 + helper）和页面（码点截断）三处都受控；标签字符已补。未发现注入、路径穿越或 SQL 拼接路径（store 使用参数化 SQL）。
- 安全：`66505c39` 让 `mcp.connection.create/change/rotate` 从“手机上不存在”变成 `change` 档。设备网关对 `change` 档要求确认（`packages/platform-node/src/device-gateway.ts:154-155`），服务端控制仍校验 owner/agent scope（`production-mcp-connections-control.ts:109-125`）；`mcp.connections.read` 是只读快照，不含密钥。未发现新的未认证入口；不过“这些管理操作是否应在手机上可用”是产品策略，代码里没有手机端调用方，属未核实。
- 资源耗尽：新增测试多遍历 256 个码点，可忽略；页面 `[...value]` 对超大粘贴是 O(n) 内存，但只发生在用户自己的浏览器输入上，未发现服务端可触发的放大路径。
- 不可撤销操作：撤销/换密钥在网页有确认对话框，在设备侧走 challenge/confirm；本次新增的客户端能力登记没有绕过确认或审计。
- 规则/文档一致性：作者关于迁移 SQL“只有新表和新索引、无需 `.meta.json`”、durable adapters/operations 同时注册、周报和设置页同时保留两侧内容、routeOptions 参数顺序等说法，读代码核对属实。只有“compared against the store”不属实，见意见 2。

**读代码证实的**

- `U+E0000–U+E007F` 已同时出现在 `contracts-v2.ts` 和 `application/ports/mcp-connections.ts`，store 的 `name()` 调用后者。
- 页面使用 `MCP_CONNECTION_NAME_CHARACTERS = 64`，与应用层 `MCP_CONNECTION_NAME_MAXIMUM = 64`、SQLite `length(name) BETWEEN 1 AND 64` 一致。
- `MCP_CONNECTION_MAXIMUM = 200`，store 限额、快照 limits、页面样例、e2e fixture 都是 200。
- 四个客户端能力项与 `GATEWAY_V2_MESSAGE_TYPES`、各 schema 的 kind 一致，Swift 生成文件中的四行与表顺序一致；`client-capabilities.contract.test.ts` 和 `client-parity.test.ts` 能反向发现漏登记或 Swift 未重生成。
- 迁移文件只含 `CREATE TABLE`/`CREATE INDEX`，目录里没有旧 `0095_mcp_connections` 的残留引用；`sqlite-durable-operations.ts`、`durable-adapters.ts`、`product-state-repository.ts` 都注册了 `mcpConnection.*`。
- 合并后的 `production-mcp-read.ts` 确实保留了 `empty` 与 `rejected` 两个字段，但 `readCounts` 没有接受 `rejected`，见意见 1。

**推测 / 未核实**

- 作者列出的 Fast-mode checks 全部通过，我无法运行测试，未独立核实。
- 手机端目前没有发现调用 `mcp.connection.*` 的界面代码；把这几项登记为 `change` 是否违反产品分层，需要产品/规则文件确认，代码本身不构成可利用漏洞。
- 若已有开发库在 `c4ecdef6` 之前执行过 `0095_mcp_connections`，改名后该库的迁移状态可能对不上；这是开发环境问题，PR 尚未部署，未作为生产缺陷列入。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 本轮增量改的是名称校验、control-center 页面/i18n、客户端能力表和迁移文件名；系统提示、工具定义、历史消息、遮盖结果都没有被本轮修改。合并带入的 `find_memories` 变化（`includeHistory`、`rejected`）是外部 MCP 工具结果路径，结果作为末尾工具结果返回，不是请求开头；发给模型的内容仍只在末尾追加。每轮会变的值仍由既有设计放在最后一条消息/工具结果里。
2. **不会。** 新加的隐藏字符集合、客户端能力表顺序、示例值都是静态的；没有依赖前后文的遮盖、时间字段或无序集合进入请求字节。名称校验只决定接受/拒绝，不参与模型请求文本的重新序列化。
3. **部分有。** 标签字符有 gateway/application 的一致性测试，但只保证两边一致，不能保证“两边一起回退”时失败，也没有直接测 store（意见 2）。页面码点截断没有测试（意见 3）。客户端能力表有契约测试和 Swift 生成比对，反向用例会失败。合并新增的 `rejected` 与用量计数之间没有测试，补上日期错误用例的用量断言即可覆盖（意见 1）。
4. **逐个核对后，除 `rejected` 外两端都能接受。** `MCP_CONNECTION_NAME_CHARACTERS`/`MCP_CONNECTION_NAME_MAXIMUM`/SQLite 长度都是 64 码点；`MCP_CONNECTION_MAXIMUM` 的使用端都是 200；四个 `mcp.*` 标识都存在于 v2 契约中，kind/档位一致，Swift 生成文件和设备网关 `findClientCapability` 都接受；迁移文件名没有残留引用，SQL 与 schema catalog 一致。唯一不接受新增字段的是 `readCounts`：`findMemories` 产出 `rejected`，`readCounts` 没有处理它，导致用量与决策记录矛盾（意见 1，对应 I-73 的“清单值必须通过所有使用端”）。
