仓库里没装 node_modules，SDK 的 API 面只能靠一手来源核对。先查 SDK 和 MCP 规范。
SDK 的 API 面（`createRequestStateCodec`/`inputRequired`/`legacyShim`）已证实存在。现在核对仓库内的写路径与规则文档。
# 审核结论：外部 agent 经 MCP 提议记忆

## 证实的（按严重度从高到低）

**1.〔中高〕同一个静态令牌的授权范围从「只读」扩成「读+写」，但没有修 ADR 0219 和配置语义**
- 证据：ADR 0219 标题即「对外**只读** MCP 入口」，决定 3「三个只读工具」，后果明确「写操作和确认框……不在这一步里做」（`docs/adr/0219-read-only-mcp-entry-with-static-token.md:10,63,111`）。配置项 `runPolicy.mcpRead.secretRef` 的密钥用途写死 `mcp-read`（同文件 :54，测试 `packages/platform-node/test/startup-configuration.unit.test.ts` 按此把关）。方案第 1 条「配了 runPolicy.mcpRead 就有这个工具」等于让这把 Andy 按「只读」前提同意的令牌自动获得写权限，方案只说把「服务端看不到人」写进 ADR，没有说修订 ADR 0219 本身。
- 建议：出一份新 ADR（或明确修订 0219），写清：令牌授权范围变化、信任模型、`readOnlyHint:false` 工具进同一入口的理由；同时把 `startup-configuration` 测试和文档同步。这一步不该只靠方案正文里的「已知限制」。

**2.〔中〕HMAC 密钥从 MCP 令牌派生不可取——令牌在客户端手里，等于 requestState 可被持有令牌者伪造**
- 证据：SDK 文档对 requestState 的定位原话："requestState is an opaque, **server-minted** string echoed back verbatim by the client"，且警告 "Mint only what earlier rounds already proved. The token is bearer proof of whatever it claims: state minted as `{ step: 'confirmed' }` before the confirmation arrives grants that step to anyone who echoes it"（https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.html）。令牌派生密钥意味着客户端自己就是「server」，今天 state 只带 `{tool, proposalId, argsHash}`、写库前还要 `inputResponses` accept，所以没有现实提权；但这是在靠「state 里恰好没放重要东西」撑着，将来任何一次往 state 里加声明（例如 confirmed 标志、跳过某步）都会立刻变成真漏洞。另设密钥不是零收益：伪造者最多「新起一个流程」，不能伪造任何已有流程的续轮；且密钥轮换和令牌轮换解耦。
- 建议（回答作者问题 1）：另设服务端专用密钥（仓库已有先例：`BearerGate` 的 secret 就是独立配置，`production-mcp-read.ts:137-142`）；成本几乎为零。可以顺带用 codec 自带的 `bind` 选项做上下文绑定（`createRequestStateCodec({ key, ttlSeconds?, bind? })`，https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/requestStateCodec.html），不过单令牌模型下 principal 绑定意义不大，`tool`+`argsHash` 已够。

**3.〔中〕argsHash 的「规范化参数」没有规定键序固定的序列化，合法重试可能被误判「换参数」**
- 证据：SDK 语义是客户端「retries the original call」——原参数原样重发（https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html），JSON 对象键序由客户端序列化决定；方案第 2 条写 `argsHash(sha256 规范化参数)` 但没定义规范化是否含键序归一。prompt-prefix 规则第 10 条对同类问题的要求是「JSON 的键顺序……都要固定」（`.claude/rules/prompt-prefix.md:51`）。
- 建议：明确 argsHash 只对「分类校验+默认值填充+键序归一后的规范 JSON 字符串」计算，并在单元测试里放一个「同参数不同键序」用例。

**4.〔中〕decline 分支「写 discarded 记录，返回非 isError 的成功」——写失败时不能返回成功**
- 证据：discarded 记录是单独写（方案第 3 条），不在任何事务里；如果 handler 吞掉写失败仍返回「主人没有同意，未保存」，这条流程就永远处于「没记录」状态，下次重放会重新弹确认框（不算危险但违背「已决定」语义）。对照只读入口的既有约定：「决策记录写不进去时……只回工具错误」（ADR 0219 :80）。
- 建议：discarded 写失败时返回 isError；这样重试无害（inputResponses 仍是 decline，重写同样记录）。（回答作者问题 3：kept 侧可靠——`applyProposal` 第三参经 `saveWithProjection` 把 ledger 传进同一事务，`packages/application/src/services/durable-memory-service.ts:599-616`；决策记录适配层本来就是 `ON CONFLICT (id) DO NOTHING`，`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:121`。discarded 侧按上面改即可。）

**5.〔中〕`memory:mcp:` 前缀在控制中心 UI 会落进错误来源分类（I-73 式两端核对缺口）**
- 证据：`apps/control-center/src/memory-source.ts:14-30` 的 `memorySourceState` 只认 `memory:owner:`（:21）；MCP 记忆没有 `sourceThreadId`、没有 `importBatchId`，会落到 ：29 的兜底 `history[0]?.sourceDeleted ? "deleted" : "tidy"`，网页上把主人确认过的外部提议显示成「整理」来源。
- 建议：`memorySourceState` 加分支（显示为「主人确认的外部提议」一类），并补 UI 用例。这正是 I-73 的教训——「每个使用它的地方都能接受吗」要逐处查，方案没有查到这一处。

**6.〔中低〕规范化「去控制字符」若按 `\p{Cc}` 实现，剥不掉双向格式符，确认框显示可被伪装**
- 证据：U+202A–202E、U+2066–2069 属于 Cf 不是 Cc；仓库先例 `daily-review.ts:186-195` 的 `clipTo` 是 `\p{Cc}` 加这两段 bidi 一起剥。确认框正文和最终存储若允许 RLO 类字符，显示顺序和存储字节可以不一致。
- 建议：规范化沿用 `clipTo` 的剥离集合。

**7.〔低〕并发重放同一 state 会撞主键**
- 证据：`applyProposal` create 分支是先读后插（`durable-memory-service.ts:122-144`），两个并发轮次都可能读到不存在；方案的「同 id 同内容直接返回已有」只在串行时成立。决策记录侧 `ON CONFLICT DO NOTHING` 没问题。
- 建议：handler 捕获冲突后重读，或测试加并发重放用例（方案的测试清单只有顺序重发）。

**8.〔低〕TTL 600 秒过期后是裸 -32602 协议错误，无法优雅重来**
- 证据：SDK 文档："tampered or expired state never reaches the handler at all. Retrying … answers a wire-level protocol error: -32602"（https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.html）。用户在确认框停留超 10 分钟就只看到协议错误。
- 建议：可接受，但工具说明和 ADR 要写「过期后重新提议一次即可」。

**9.〔低〕「客户端没声明 form elicitation」的 handler 自查分支可能不可实现或测不出来**
- 证据：SDK seam 已经在进 handler 前拒绝："Each embedded request is checked against the capabilities the client declared; a missing capability rejects the call with **-32021** before anything reaches the wire"（https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.html）。handler 侧能否拿到客户端能力声明，方案没写来源。未核实 handler 侧 API。
- 建议：先确认 ctx 上有可读的能力信息；拿不到就删掉这条分支，靠 -32021，测试改为断言 -32021。

**10.〔低〕测试与文档缺口（侧重）**
- 写完立刻 `find_memories` 未必找得到：投影 job 是异步的（`durable-memory-service.ts:594-597`），现有 harness 在 recall 前手动 `runProjectionBatch(10)`（`test/integration/mcp-read.test.ts:145`）。方案的「能被 find_memories 读到」测试和 Hermes 验收都要写明这一步，生产语义是「投影完成后可检索」。
- 方案引用了 daily-review 的两处消费（`daily-review.ts:224-226` 用 subjectRef 当记忆 id；:268 按 `approval_rejected` 跳过——两处形状核对均吻合），但测试清单里没有对应回归用例。按 I-73 的口径，两端都要有用例钉住。
- `memorySourceState` 新前缀无用例（见第 5 条）。

## 推测

- 2026-era 客户端若不支持 elicitation（有些非交互客户端），会吃 -32021；方案假设「新版客户端都能弹框」，未核实 Claude Code / Codex 当前版本对 form elicitation 的支持面。
- 生产投影 worker 的实际延迟（几秒还是几分钟）未核实，只确认了机制是异步 job。
- handler 侧读取客户端能力的 API 是否存在（第 9 条）。

## 侧重检查

走的流程：外部客户端持 Bearer 令牌 → `POST /api/mcp/v1`（`BearerGate`，`production-mcp-read.ts:359-367`）→ `createMcpHandler` per-request server（:143,152-206）→ `propose_memory` 第一轮（规范化/分级/generation 检查——`MEMORY_GENERATION_MISSING` 先例在 `production-memory-control.ts:279-290`，方案「记忆功能未就绪直接拒」可行）→ `inputRequired` + requestState → 客户端确认重试 → SDK seam verify（-32602）→ handler 决策记录检查 → 共享写路径（payload 保护存储先例 `production-http-composition.ts:479-519` 的「重复时比对一致」模式，`#createMemory` 复用 `production-memory-control.ts:795-844`）→ 消费端（daily-review、控制中心、find_memories）。
结论：主干路径方案都有测试计划覆盖；没有测试覆盖的路径是——`memorySourceState` 的 UI 来源分类、daily-review 对 MCP 记录的两处消费、投影完成前的检索窗口、discarded 写失败分支。

## 如果由我来定这份方案

1. 保留整体结构（第一轮只校验不落库、requestState 携 `{tool, proposalId, argsHash}`、决策记录防复活、kept 与记忆同事务），这套设计与 SDK 的 MRTR 模式一致，是对的。
2. 按第 1 条先补 ADR（令牌授权范围变化），再动工。
3. HMAC 换服务端专用密钥；proposalId 保持随机（按正文哈希会让「拒绝过一次的正文永久无法再提议」——discarded 记录按 proposalId 查，正文哈希会永远命中「已拒绝过」，且把正文相等性泄进记录。回答作者问题 2：随机）。
4. argsHash 规范化写死：分类校验+默认值填充+键序归一后的规范 JSON；规范化补 bidi 剥离；decline 写失败必须 isError。
5. 补四处用例：memorySourceState 新前缀、daily-review 两端消费、argsHash 键序、并发重放；测试和验收写明投影异步。

## 必答问题

1. **不改变模型已见过的请求开头。** `propose_memory` 全程不进 Himawari 的模型请求：工具定义只经 `tools/list` 发给外部 MCP 客户端（per-request server，`production-mcp-read.ts:152-206`），不在系统提示或工具定义里；提示词目录只新增 `mcp.propose-memory` 等键，不改任何已冻结的键；新记忆进入模型上下文只能走每轮检索，属于「每轮会变的值放最后一条消息」（规则第 2 条，`.claude/rules/prompt-prefix.md:28`）。发出的内容仍只在末尾追加，`npm run check:prompt-prefix` 的反向用例与本改动正交。ADR 0219 决定 6 的先例（「Himawari 自己发给模型的请求一个字节都不变」）在这里同样成立。
2. **不会。** 确认框显示的、算摘要的、最终存的是同一份确定性规范化文本（方案已明确）；分级用 `classificationWithIdentifiers`（纯函数，`packages/sensitive-capture/src/identifiers.ts:20`）；遮盖只发生在读取出口，不进存储。唯一的字节确定风险是 argsHash 的键序（证实问题第 3 条），修掉即可。
3. **有对应自动检查，反向用例基本都会真失败**：篡改/过期 state → SDK seam -32602（SDK 文档证实）；换参数 → handler argsHash 核对；没令牌 → `BearerGate` 401（`production-mcp-read.ts:359-367`）；restricted → 分类拒绝；重放旧 state → 决策记录拦截（`ON CONFLICT DO NOTHING` 适配层已证实）。例外：「没声明 elicitation」这条反向用例可能测的是 SDK 的 -32021 而不是 handler 自己的分支（证实问题第 9 条）。
4. **逐值核对（I-73 口径）**：`memory:mcp:<id>` —— `MemoryId` 是无格式校验的 `Identifier<"MemoryId">`（`packages/domain/src/identifiers.ts:23`），后端不会拒，但 UI 来源分类会误判（证实问题第 5 条）；`ledger:mcp-memory:*` —— `validateLedgerWrite` 只限长度与 kind/outcome/reasonCode 白名单，`memory_candidate`+`kept/discarded` 都在 `DECISION_OUTCOMES`（`decision-ledger.ts:44-51`），subjectRef ≤256、reasonCode 1–64 自由文本，均通过；kept 的 subjectRef 当记忆 id、discarded 按 `approval_rejected` 跳过——`daily-review.ts:224-226`、:268 均吻合；`mcp.propose-memory` 目录键为新增，不影响旧字节；requestState payload 经客户端可解码（"signed, not encrypted"，SDK 文档），内含 proposalId 和哈希，无敏感内容，可接受。唯一不达标的是 UI 来源分类一处，按第 5 条修。
