## 结论摘要

改动的主流程（按接入读 `pushPolicy`、直接存非敏感记忆、共用批次号、规则不动）在代码里基本成立。但发现两处高严重度问题：敏感的兜底可被外部 agent 用分类标签绕过；设置页默认值改动后有一条现成的浏览器集成测试仍断言旧值，按代码推导会失败。另有资源放大、撤销语义不实等中低问题。

### 1. 高：“敏感内容一律待确认”没有真正兜住，外部 agent 可把健康/财务内容标成 `other` 直接存

- 文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:94-101,199,285`；`packages/gateway-contracts/src/contracts-v2.ts:2010`；`packages/sensitive-capture/src/identifiers.ts:20-28`；`apps/agent-service/src/production-mcp-read.ts:783-787`
- 问题：直接存的安全边界依赖 `proposal.dataClassification`，而 `proposalClassification` 只有在 `category` 命中 `["health","finance"]` 或正文命中受限证件号/凭据模式时才返回 `sensitive`。`category` 是外部 agent 在工具参数里自己选的。把“主人有高血压，每天吃降压药”标成 `preference`/`other`，它会得到 `private`，然后被直接保存。ADR 0281 决定 3、工具说明和作者材料都写成“敏感内容即使设了直接存也先放进待确认”，实际代码不保证这一点。
- 证据：
  - `proposalClassification`：`return (MEMORY_SENSITIVE_CATEGORY_NAMES as readonly string[]).includes(category) ? "sensitive" : classificationWithIdentifiers(text, "private");`
  - `MEMORY_SENSITIVE_CATEGORY_NAMES = ["health", "finance"]`
  - `classificationWithIdentifiers` 只检查 `containsRestrictedIdentifier` 和 `containsCredential`，不识别健康/财务自然语言。
  - `keepDirect`：`if (proposal.status === "pending" && proposal.dataClassification !== "private") return "pending";`
  - 工具 schema 直接接受客户端给的 `category`：`category: { type: "string", enum: [...EXTERNAL_PROPOSAL_CATEGORIES] }`
  - 新测试只用 `category: "health"` 验证敏感（`test/integration/mcp-write.test.ts:2123-2126`），没有测“健康正文 + `preference` 分类”。
- 建议：在直接存前补一层与分类标签无关的内容检查（至少对健康/财务词表和现有敏感材料识别做保守判断），或对 `other`/`preference` 等分类仍做敏感内容扫描；同时修正 ADR/工具说明，并加反向用例“健康正文 + `preference` 仍待确认”。
- 读代码证实：分类只看自报 category 和受限标识符；外部 agent 能控制 category。推测：外部 agent 被提示注入或本身不可信时会利用这一点。

### 2. 高：设置页默认改成“直接存”后，现有浏览器集成测试仍断言新建接入发送 `ask`，按代码会失败

- 文件:行：`test/integration/mcp-connections-browser.test.ts:139-149`；`apps/control-center/src/components/mcp-connections-settings.tsx:236-241`；`apps/control-center/src/mcp-connections.ts:51-55`
- 问题：设置页新建接入的初始 `draft.pushPolicy` 已改成 `"direct"`，`createMcpConnection` 又把 `draft.pushPolicy` 原样发出；但浏览器测试仍精确断言创建命令 payload 为 `pushPolicy: "ask"`。按代码推导该测试会失败。我没有运行测试环境，但这是确定的值不一致。
- 证据：
  - 组件：`const [draft, setDraft] = useState<McpConnectionDraft>({ ..., pushPolicy: "direct" });`
  - 创建：`{ ...draft, capabilities: [...draft.capabilities] }`
  - 测试：`payload: { ..., pushPolicy: "ask" }`
- 建议：把该断言改成 `"direct"`，并补一个“已有接入仍是 ask、在设置页改成 direct 后快照为 direct”的用例；若产品其实想保持新建为 ask，则应改回组件默认值而不是留下互相矛盾的测试。
- 读代码证实：UI 默认 direct、命令透传 direct、测试期望 ask。推测：未更新浏览器测试，CI 会红。

### 3. 中：`propose_memories` 直接存时对每条都全量扫描并解密全部活跃记忆，缺少网页确认路径已有的摘要缓存

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:1157-1178`；`apps/agent-service/src/production-mcp-memory-writer.ts:279-290,307,579-607`（对照 `:536-566`）
- 问题：`propose_memories` 一次最多 50 条，直接存循环对每条调用一次 `keepDirect`；`keepDirect` 调 `#keep` 时没有传 `digestCache`，于是每条都执行 `#digests(undefined)` → `#activeDigests()` → 遍历全部活跃记忆并逐条 `payloads.get` + `protector.unprotect`。网页确认的 `respond` 明明创建并在整批内复用 `digestCache` 来避免这件事。外部连接可以把 50 条塞进一次调用，把开销放大到“50 × 全部活跃记忆”，这是新增的资源放大路径。
- 证据：
  - `keepDirect`：`await this.#keep(proposalId, { ...input, direct: true });`（没有第三个参数）
  - `#keep`：`const digests = await this.#digests(digestCache);`
  - `#activeDigests` 遍历 `listActive` 并对每条 `unprotect`。
  - `respond`：`const digestCache: ExternalProposalDigestCache = {};` 然后 `await this.keep(..., digestCache);`
- 建议：让 `keepDirect`/直接存批次接受并复用同一个 `ExternalProposalDigestCache`（或增加按批次直接保存的接口），并在测试里用可计数的 `listActive`/`unprotect` 断言一次批次只全量扫描一次左右。
- 读代码证实：直接存路径没有摘要缓存；网页确认路径有。

### 4. 中：去重命中已有记忆时仍回 “saved / 可以撤销”，但该批次撤销是静默空操作

- 文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:307-324,392-407,490-527`；`apps/agent-service/src/production-mcp-read.ts:1223`
- 问题：当正文与一条已有活跃记忆相同（例如主人自己加过的记忆、导入或整理产生的记忆）时，`#keep` 的 `same` 分支会把提议直接提交到那条**既有记忆**上，随后 `#commit` 记下的是 `input.batchId`，但 `memoryId` 仍是既有记忆的编号。`undoBatch` 只撤销 `member.memoryId === externalProposalMemoryId(member.id, batchId)` 的成员，因此这个批次撤销时不会删任何记忆，只会把 `batch_id` 从提议上摘掉并返回成功。外部 agent 收到 `MCP_PROPOSE_MEMORY_SAVED_DIRECT`（“可以撤销”），主人在记忆页看到一条可撤销批次，实际撤销没有效果；该记忆的来源也不会显示为 `external_direct`。
- 证据：
  - `same` 分支：`if (same) { await this.#commit(proposal, same, input); return same; }`
  - `#commit` 用 `input.batchId` 记决策，但 `memoryId` 是 `same`。
  - 撤销条件：`member.status === "committed" && member.memoryId === externalProposalMemoryId(member.id, batchId)`
  - 直接存回执：`if (kept === "saved") return proposalReply(MCP_PROPOSE_MEMORY_SAVED_DIRECT.text, false);`
- 建议：`same` 分支应向调用方返回“已存在/已保存但不是本批新建”（例如 `already_saved`），不要让它进入一个可撤销的直接存批次；或者让撤销逻辑把这种成员单独标成不可撤销并给出明确结果。补一条“直接推送与主人已有记忆同文，再撤销该批”的测试。
- 读代码证实：`same` 时 memoryId 不等于本批应新建的编号，撤销不会删。补充：网页确认批次本来也有类似语义，但这次把它带到了默认开启的直接存路径，并新增了“可以撤销”的回执，影响面变大。

### 5. 低：并发把提议标成 `superseded` 时，`propose_memories` 会把结果报成 `pending`

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:1167-1176`；`apps/agent-service/src/production-mcp-memory-writer.ts:248-254`
- 问题：直接存循环捕获 `isAlreadyDecided` 后只区分 `kept` 和 `declined`，其他一律回落为 `"pending"`；但 `decided()` 还可能返回 `"superseded"`。如果另一并发调用在提交和保存之间用同 key 替换了这条提议，它会永远不再保存，却对调用方显示“待主人确认”。
- 证据：
  - `decided()`：`if (found.status === "committed") return "kept"; if (found.status === "rejected") return "declined"; return found.status;`
  - 循环：`decided === "kept" ? "already_saved" : decided === "declined" ? "declined_before" : "pending"`
- 建议：显式处理 `superseded`（例如返回 `replaced`/`superseded` 状态），或在异常后重新读取提议状态再决定结果。
- 读代码证实：状态回落路径存在；触发需要并发 supersede，属于推测的竞态场景。

### 6. 低：新建接入直接存没有对应的自动检查，原来的反向用例被删除而不是改成正向

- 文件:行：`apps/agent-service/test/production-http-composition.unit.test.ts:1177-1206`
- 问题：改动删掉了“create 传 direct 应被拒绝”的用例，但只补了“创建时传 ask、再 change 成 direct”的路径；如果以后有人在 create 分支重新加回 `askFirstOnly`，现有测试不会发现。设置页默认值也没有被自动测试覆盖（第 2 条正好暴露了这个缺口）。
- 证据：当前测试创建时明确传 `pushPolicy: "ask"`，之后用 `mcp.connection.change` 切到 `direct`；没有 `mcp.connection.create` 直接传 `direct` 的成功断言。
- 建议：增加 create 传 `pushPolicy: "direct"` 的 200 + 快照断言；把浏览器测试的默认值断言更新为 direct，并补一条设置页/接口默认值的测试。

## 侧重检查

- 不可信输入：`#readProposalArgs` 和 `#submit` 仍先校验正文长度、分类枚举、key 长度、机器密钥；直接存是在 `submit` 成功之后才走，普通输入校验没有被绕过。已看代码证实。
- 安全/隐私：机器密钥拒收仍在；规则仍不走直接存；但“敏感内容一律待确认”可被外部 agent 自选分类绕过（第 1 条）。已看代码证实。
- 资源耗尽：直接存逐条全量解密所有活跃记忆，缺少 `respond` 的摘要缓存（第 3 条）。已看代码证实。
- 不可撤销：直接存声称可整批撤销，但去重命中既有记忆时批次撤销是空操作（第 4 条）；敏感项不进批次、留在待确认，符合预期。已看代码证实。
- 错误路径：`isAlreadyDecided` 在单条 `propose_memory` 里能进入 `settled` 回执；`propose_memories` 里逐条吞错并保留 `pending`；`superseded` 回落成 `pending`（第 5 条）。已看代码证实。
- 规则/文档一致性：`propose_rule` 没有使用 `pushPolicy`，规则路径不变；ADR 0281 的默认值、原因码、来源文案与代码大部分一致；不一致集中在敏感兜底和撤销语义（第 1、4 条）。
- 跨边界校验：`batch-direct-<24hex>` 长度 36，`external_memory_proposals.batch_id` 上限 128，`memory.external.undo` 的 `machineString` 上限 128 且允许 `:`/`-`；`mcp_proposal_kept_direct` 长度 24，决策账本 `reason_code` 上限 64，`outcome: "kept"` 对 `memory_candidate` 合法。已看代码证实。
- 提示词/缓存：改动的 `MCP_TOOL_*`/`MCP_PROPOSE_*` 只在 `production-mcp-read.ts` 用来服务外部 MCP 客户端，没有看到内部模型请求引用它们；记忆块在 `turnPrompt` 里拼到最后一条用户消息（`packages/runtime-pi/src/pi-runtime-adapter.ts:644-662`）。未核实：`prompt-manifest.json` 的 sha256 是否与当前文字精确匹配（受工具限制无法计算/运行测试）。

## 作者说法核对

- “敏感内容仍待确认”：**部分不成立**。只对 `health`/`finance` 分类或受限标识符/凭据生效，外部 agent 改分类即可绕过（第 1 条）。
- “同一次调用共用批次号、可整批撤销”：**主流程成立，撤销语义有例外**。去重命中已有记忆时仍报 `saved`，但撤销是空操作（第 4 条）。
- “规则完全不变”：**成立**。`propose_rule` 路径没有读取 `pushPolicy`。
- “不新增全局配置、不改表”：**成立**。只新增常量、接口和回执，没有迁移。
- “默认值只在设置页新建接入时选直接存”：**代码成立，但测试不一致**。组件默认 `direct`，浏览器测试仍断言 `ask`（第 2 条）。
- “出处看得出来”：**新建的直接存记忆成立**；去重到既有记忆时不成立，来源仍是原来源（第 4 条）。
- “发给 Himawari 自己模型的请求不变”：**请求头/系统提示/工具定义不变**；后续轮次的“本轮选中的记忆”会因新记忆而进入最后一条用户消息，这是规则允许的动态尾部变化，但不是字面意义上的“一个字节都不变”。
- “四个 `[direct]` 用例”：**确实存在**，覆盖了直接存、ask 连接、按分类的敏感、规则；但漏了“健康正文错误分类”“去重后撤销”“新建 direct 接口”“摘要缓存”这些反向/边界用例。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会看到本次改动去改系统提示、工具定义或历史。变化的 MCP 工具说明和回执只服务于外部 MCP 客户端；内部模型请求仍由 `turnPrompt` 把上下文块（包括记忆）放在最后一条用户消息里（`packages/runtime-pi/src/pi-runtime-adapter.ts:644-662`），符合“只追加、会变的值在最后一条”的规则。**但**直接存会让新记忆更早进入后续轮次的动态尾部，所以作者“请求一个字节都不变”的字面说法不成立；准确说法是“请求开头不变”。依据：[prompt-prefix.md 第 4、7、28 条](../../.agents/instructions/prompt-prefix.md#rules)。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   本次没有新增时间字段、无序集合或依赖前后文的遮盖；正文本身不改。新增的随机性只有 `batch-direct-` 批次号，它进入记忆编号、内容引用和决策记录编号；这些标识在记忆创建时随机，撤销后重新推送会生成新的标识。只要记忆块在最后一条用户消息里，这属于被允许的动态内容；同一段文字在去重命中已有记忆时不会生成新记忆。没有发现新的“同一段文字在请求头/系统提示里因批次号不同而字节不同”的路径。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：`test/integration/mcp-write.test.ts` 的四个 `[direct]` 用例覆盖直接存、ask 连接仍待确认、按 `health` 分类的敏感仍待确认、规则不直接生效；如果直接存逻辑被错误地应用到 ask 连接、敏感项或规则路径，这些用例会失败。网关侧还有 `mcp.connection.change` 到 direct 的快照断言。
   但覆盖不完整：现有浏览器测试 `test/integration/mcp-connections-browser.test.ts:139-149` 仍断言新建接入发送 `ask`，而组件默认已经是 `direct`，按代码推导会失败；没有 create 传 direct 的接口测试；没有“健康正文 + 错误分类”的敏感反向用例；没有“直接存去重命中既有记忆后撤销”的用例；没有验证直接存批次的摘要缓存。`prompt-manifest.json` 的哈希是否匹配未核实（不能运行哈希命令）。

4. **每个新值/修改值的生产者与消费者是否都接受？**
   - `pushPolicy: "direct"`：UI 生产（组件 `:240`）→ `createMcpConnection` 透传（`:51-55`）→ 网关契约允许（`contracts-v2.ts:1283,1349,1378,1388`）→ 控制层不再拒绝（`production-mcp-connections-control.ts:212-259`）→ SQLite 校验允许（`mcp-connections.ts:11`、迁移 `:15`）→ `admit`/`connectionOf`/`#server` 读取（`production-mcp-read.ts:617,777,1507`）。两端一致。
   - `batch-direct-<24hex>`：生产者 `production-mcp-read.ts:1158,1289`；消费到 `external_memory_proposals.batch_id`（上限 128）、`memory.external.undo` 的 `machineString`（上限 128，允许 `:` 和 `-`）、`listBatches`/UI。长度 36，全部接受。
   - 记忆编号/内容引用：`externalProposalMemoryId` 生成，`memory_records.id` 无长度上限、`external_memory_proposals.memory_id` 外键接受；直接存编号约 82 字符，可接受。`memorySourceState` 用 `:batch-direct-` 子串识别来源，当前格式成立，但属于对编号格式的隐式依赖。
   - `mcp_proposal_kept_direct`：决策账本 `reason_code` 上限 64、值长 24；`outcome: "kept"` 对 `memory_candidate` 合法；校准用 `mcp_proposal_%` 模式仍会排除它；每日回顾不会把 `keptDirect` 当作未保存。两端一致。
   - `MemorySourceState = "external_direct"`：`memory-source.ts` 生产，`memory-page.tsx` 和 `memorySourceCounts` 消费，三种语言都加了 ICU 选项；没有发现需要同步的数据库枚举。
   - 新提示 `mcp.propose-memory-saved-direct` 和改动的工具/回执文字：`production-mcp-read.ts` 消费，`prompt-manifest.json` 已登记；哈希未核实。
   - `McpMemoryProposals.keepDirect`：接口、`ProductionMcpMemoryWriter` 实现、`#proposeMemory`/`#proposeMemories` 消费，类型两端一致。
   - i18n 新键：`message-ids.ts` 与 en/ja/zh-CN 三份资源都加齐，i18n 测试要求三份键集完全一致，当前满足。
   - `McpConnectionDraft.pushPolicy`/`McpConnectionEdit.pushPolicy`：组件、`createMcpConnection`、`changeMcpConnection` 都传值；接口 create 契约要求显式字段，已有调用都带。唯一不一致是上面第 2 条那条旧浏览器测试断言。
