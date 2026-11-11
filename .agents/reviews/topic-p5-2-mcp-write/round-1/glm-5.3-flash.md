# 方案：外部 agent 经 MCP 提议写入主人记忆（MRTR + 表单确认）

## 一、方案依赖的前提（均已读到原话）

**代码事实**

1. 只读入口结构：`apps/agent-service/src/production-mcp-read.ts:130-206`——`#server()` 每请求新建 `McpServer`，用 `register()` 包装三个工具并**硬编码** `annotations: { readOnlyHint: true }`（第 166 行），`#call`（208-236 行）统一写 `external_read` 决策记录。写工具不能走这个包装。
2. 鉴权与限流：`apps/agent-service/src/bearer-admission.ts:10-36`——单把令牌，每分钟 30 次有效请求；`service-main.ts:1725-1749` 组装 `ProductionMcpRead`，作用域、时钟、时区都在手上。
3. 幂等落库先例：`apps/agent-service/src/production-memory-control.ts:846-855`（`#create` 用 `memory:owner:${idempotencyKey}` 作 id）、`240-246`（`protector.protect` 用确定性 ref，撞 `DUPLICATE` 就复用已有 payload）；`packages/application/src/services/durable-memory-service.ts:121-144`——`applyProposal` 同 id 同内容直接返回已有记录，同 id 不同内容抛 `CONFLICT`。
4. 决策记录约束：`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:64-72`——`memory_candidate` 允许 outcome `kept / discarded / pending_approval`，且是唯一允许 category/confidence/inferred 的 kind；id 长度 1–128（18 行）、reason_code 1–64（35 行）、subject_ref 1–256（36 行）。`decision_ledger` 不需要新 kind。
5. 决策记录写入约定：`docs/execution/specs/2026-11-09-decision-record-write-convention.md` 第 35 行——非 proactive 种类经 `append` 只落 `memoryIds / ruleIds / batchId / resultMemoryIds` 四个键。方案只能依赖这四个键。
6. 表约束：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:57-74`（payloads.ref 无长度/格式 CHECK，classification 允许 `private`）、`:393-408`（memory_records.id 无格式 CHECK，classification CHECK 含 `private`）。
7. 规范：MCP 2026-07-28 MRTR，https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr 原话：“servers MUST treat requestState as an attacker-controlled input … MUST protect its integrity (e.g. HMAC or AEAD)”；“Servers MUST NOT send an inputRequests that the client has not declared support for in its capabilities”；“Servers MUST NOT assume that clients will fulfill the inputRequests or retry the original request”。
8. SDK（官方 v2 文档，与本仓库 `packages/platform-node/package.json:30` 锁定的 `@modelcontextprotocol/server 2.0.0` 对应）：https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.html 原话：“return `inputRequired(...)` … the client answers the embedded requests and retries the call”；“`createRequestStateCodec` returns an HMAC-SHA256 `{ mint, verify }` pair — pass `verify` as `ServerOptions.requestState.verify` and it runs before every handler entry that carries state”；“The codec is signed, not encrypted — the client can base64url-decode the payload”；“Set `ServerOptions.inputRequired.legacyShim: false` to fail loudly instead”。能力门：“Each embedded request is checked against the capabilities the client declared; a missing capability rejects the call with `-32021` before anything reaches the wire。”
9. Claude Code 客户端行为：https://code.claude.com/docs/en/mcp 原话（第 1660 行）“Claude Code displays an interactive dialog in the terminal and passes your response back to the server. No configuration is required on your side”；第 1686 行“Claude Code declares `elicitation: {form: {}, url: {}}`”；第 652 行“`elicitation/create` is served only in interactive terminal sessions”（非交互会话会拒绝，见风险）。
10. 提示词门槛先例：`docs/lessons.md:668`——`apps/agent-service/test/prompt-catalog.unit.test.ts` 按路径扫源码字符串字面量，提示词标记词出现在目录之外即失败，且 `check-layer0-tests.py derive` 推不出它，必须手工加进第 0 层。
11. 本仓库检出里 **没有 node_modules**（SDK 类型文件读不到），SDK API 形状以上面第 8 条官方文档为准；材料里的 `.d.mts` 引用我无法本地复核。

## 二、方案

### 1. 工具定义

新工具 `propose_memory`，与三个只读工具并列注册在同一个 `/api/mcp/v1` 服务上，但**不走** `register()` 包装（那个包装硬编码 `readOnlyHint: true` 并统一写 `external_read` 记录）：

- 参数（JSON Schema，`additionalProperties: false`）：
  - `text`：string，1–2000 字符，必填；
  - `category`：enum，可选（取值与网页 `memory.create` 合同同一组，默认 `other`）。
- `annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }`。
- 说明文字登记进 `packages/prompt-catalog/src/tools.ts`，新条目（`layer: "tools"` / `"tool-result"`）：
  - `mcp.propose-memory`（工具描述：这是唯一能改动记忆的工具，调用后主人会在客户端界面看到确认框，拒绝就不会保存）；
  - `mcp.propose-memory-confirm`（确认框 message 模板：固定文字 + 提议正文原样引用 + 分类）；
  - `mcp.tool-result-proposal-saved`、`mcp.tool-result-proposal-rejected`、`mcp.tool-result-proposal-unavailable`（客户端不支持/老版本/出错时回给外部 agent 的固定文字）。

### 2. 确认流程（一次写好的 handler，每轮重入）

```
第 1 轮：tools/call propose_memory {text, category}
  服务端：normalize(text)（去控制字符、trim、≤2000，复用 production-memory-control.ts:102 的 singleLine 语义）
  digest = SHA-256(canonical JSON {category, text})   ← 固定键序，确定性
  未带有效 requestState → 返回 inputRequired：
    inputRequests: { confirm: inputRequired.elicit({ message: 模板+正文, requestedSchema: { confirm: boolean } }) }
    requestState: codec.mint({ v:1, proposalDigest: digest })      ← HMAC 签名
  （同时写一条「提议」决策记录，见 §5）

第 2 轮：客户端在自家界面弹表单，主人选择后，客户端带同一 args + inputResponses + requestState 重发
  服务端：SDK 的 requestState.verify（HMAC+TTL）先验，伪造/过期 → -32602，handler 不执行
  ctx.mcpReq.requestState() 读出 payload，校验 proposalDigest === 本次 args 的 digest   ← 绑定确认与提议
  inputResponse(ctx.mcpReq.inputResponses, "confirm")：
    - decline / cancel → 不落记忆；写「拒绝」决策记录；返回 isError + 固定文字
    - accept 且 confirm === true → 落库（§3），返回结果
    - accept 但 confirm !== true → 视为拒绝
```

关键点：

- **requestState 不携带正文**。正文靠 MRTR「重发原请求」天然带回（规范原文：重试 “retries the original request including the additional requested information”），state 里只放 proposalDigest。codec 是“签名不加密”（前提 8），放哈希无害。
- **codec 密钥**从现有 MCP 令牌做域分离派生：`HMAC-SHA256(mcpSecret, "himawari:mcp:request-state:v1")`。不新增配置键；换令牌只会让未决的 requestState 失效（本来就有 TTL）。`ttlSeconds` 取 900（确认框是人在眼前点，Claude Code 文档说对话框是同步的）。
- **`inputRequired.legacyShim: false`**：主人明确不用旧式服务端主动请求，对 2025 年老客户端大声失败（前提 8），回固定错误文字。
- **客户端能力不足**（未声明 elicitation）：SDK 在出网前以 `-32021` 拒绝，handler 捕获后回 `mcp.tool-result-proposal-unavailable`，不写任何库。这也是对规范第 7 条 MUST NOT 的服从——不额外自判能力，交给 SDK 的既有门。

### 3. 认出同一次提议、只落一次（无服务端状态）

全部用**确定性 id**，不建任何新表、不加迁移：

- 记忆 id：`memory:external:${digest}`；payload ref：`memory-external:${digest}`（protect 撞 `DUPLICATE` 即复用，先例 production-memory-control.ts:240-246）。
- 落库：`protector.protect({ ref, dataClassification: "private", contentType: "text/plain", plaintext })` → `applyProposal({ decision: "create", memory: { id, contentRef, inference: false, confidencePermille: 1000, policyVersion: "memory-external:v1", attributes: { category, importancePermille: 500, … } } }, generationId)`。`generationId` 来自 `book.latestGeneration`（没有代次时拒绝，与网页 manualAddReady 同一前提）。
- 同一次提议重发（无论多少次）：同 digest → 同 id → `applyProposal` 返回已有记录，永不重复建记忆；重试还能自愈“记忆已建、决策记录没写成”的中间态。
- 决策记录防重：结果记录 id 也是确定性的 `ledger:mcp-memory:${digest}`；append 前先 `ledger.read({ decisionId })`，已存在就跳过（复用 `DecisionLedgerPort.read`，decision-ledger.ts:266-268）。这样“一次提议最多一条结果记录”也不依赖内存状态。

### 4. 拒绝 / 取消 / 不支持 / 老客户端

| 情形 | 行为 | 落库 |
|---|---|---|
| 主人 decline / cancel / 表单未勾选 | 回 `isError` + `mcp.tool-result-proposal-rejected` | 写 outcome=`discarded` 的记录（确定性 id 防重），不建记忆 |
| 客户端未声明 elicitation | SDK 出网前拒绝，回 `…unavailable` 固定文字 | 无（提议记录在 mint 前不写，见 §5 取舍） |
| 2025 老客户端（legacyShim 关） | 大声失败，回 `…unavailable` 固定文字 | 无 |
| requestState 篡改 / 过期 / args 换了内容 | SDK `-32602` 或 handler 内 digest 不匹配拒绝 | 无 |
| 正文为空 / 超 2000 字 / 全是控制字符 | 校验失败，回错误文字 | 无 |

### 5. 决策记录

不新增 kind（改表排队，`memory_candidate` 的 CHECK 已覆盖三种结局，前提 4）：

- **提议时**（第 1 轮 mint requestState 的同一步）：kind=`memory_candidate`，outcome=`pending_approval`，reasonCode=`mcp_memory_proposal`，id=`ledger:mcp-proposal:${digest}`（防重），subjectRef=`mcp-client:<客户端名>`，inputs 四键照约定（memoryIds 留空——此时记忆还不存在，避免“依据”抽屉渲染“这条记忆已不存在”）。
- **落库时**：kind=`memory_candidate`，outcome=`kept`，reasonCode=`mcp_memory_proposal_accepted`，id=`ledger:mcp-memory:${digest}`，memoryIds=[`memory:external:${digest}`]。
- **拒绝时**：同一确定性 id，outcome=`discarded`。

写入顺序：先建记忆、再写记录；记录写失败时返回工具错误但不回滚记忆，靠确定性 id 在重试时补写（对齐 ADR 0219 第 5 条“记录写不进去按失败处理”的口径）。costMicros=0（写路径没有嵌入费用）。

### 6. 测试（正向 + 反向，参照 `test/integration/mcp-read.test.ts` 的真实 SQLite + 官方 SDK 客户端 2.0.0 路子）

新文件 `test/integration/mcp-write.test.ts`：

- 正向：提议 → SDK 客户端收到 `input_required`（断言含 form 请求和 requestState）→ 回 accept → 重发 → 记忆行存在（解密回正文、classification=private、category 正确）→ 两条决策记录（pending_approval + kept）字段符合 §5。
- 正向：同文同分类再次完整提议 → 仍只有一条记忆、结果记录不重复。
- 正向：ledger 先写失败（fixture 注入）→ 工具报错；重试后记录补齐、记忆只有一条。
- **反向（每条都对应一个可拆掉的守卫，拆掉即红）**：
  1. 篡改 requestState 一个字节 → 报错，handler 不执行，零写入（守卫：`requestState.verify` 钩子）；
  2. ManualClock 拨过 TTL 后重发 → 报错，零写入（守卫：codec ttlSeconds）；
  3. 拿 A 提议的 accept 去确认 B 的 args → digest 不匹配拒绝，零写入（守卫：proposalDigest 绑定检查）；
  4. 未声明 elicitation 能力的客户端 → 错误结果、零写入，且断言客户端的 `elicitation/create` handler 从未被调（守卫：不绕过 SDK 能力门）；
  5. 2025 老客户端 → 必须失败且**没有任何服务端→客户端请求**发出（守卫：`legacyShim: false`——把这一项删掉这条用例就失败，这是“不用旧方式”的自动化落实）；
  6. decline / cancel / 勾选 confirm=false → 无记忆行，记录 outcome=discarded；
  7. 空正文 / 2001 字 → 校验拒绝，零写入。
- 单元：digest 确定性（同文同分类同 digest；分类不同 digest 不同）；固定文字全部在目录里（沿用 `apps/agent-service/test/prompt-catalog.unit.test.ts` 的路径扫描门槛，按 lessons.md:668 手工加入第 0 层清单）。
- 门禁：新测试进 `npm run check`（与 mcp-read 同目录同机制）；`check:prompt-prefix` 应保持通过——本改动不碰任何组装模型请求的代码。

### 7. Claude Code 验收

1. `claude mcp add --transport http himawari https://<host>/api/mcp/v1 --header "Authorization: Bearer <token>"`（ADR 0219 前提 2 的写法）；
2. 交互式会话里让它“把……记到我的 Himawari 记忆里”→ Claude 调 `propose_memory` → 终端弹出确认框（Claude Code 文档：无需任何配置，交互式会话才支持）→ 点确认 → 工具返回已保存；
3. 到 Himawari 记忆页看到新记忆、分类正确；“依据”抽屉里能看到 pending_approval→kept 两条记录；
4. 再走一遍拒绝路径：确认框选拒绝 → 记忆页无新条目；
5. `/mcp` 面板显示 4 个工具。
6. 生产前置：Cloudflare 对该路径的服务令牌策略照 ADR 0219 决定 1 覆盖（生产改动，需 Andy 同意）。

## 三、考虑过但不选的做法

1. **服务端存“待确认提议”表，主人在 Himawari 网页确认**——违背“确认框出现在调用方界面”的硬要求，还要新表新迁移。不选。
2. **保留 legacyShim（默认开）**——对老客户端会走旧式服务端主动请求，主人明令禁止；宁可大声失败。不选。
3. **提议正文放进 requestState**——codec 签名不加密，正文会明文可读；且 MRTR 重发本来就把 args 带回来，state 里放正文纯属冗余。不选。
4. **不用 requestState，只看 inputResponses 里有没有 confirm**——确认就无法绑定到具体提议参数：同一把共享令牌下，A 提议的确认能被套到 B 提议上。不选（这正是规范第 5 条要求把“发起请求的标识+参数摘要”放进完整性保护内的原因）。
5. **新增 kind `external_write`**——要重建 `decision_ledger`（迁移 0087 的重建式改表），而 `memory_candidate` 的三种 outcome 语义完全吻合。不选。
6. **先落 tentative 记忆、确认后转正**——违反“拒绝则不落库”，且 applyProposal 没有 tentative-create 路径。不选。
7. **要求外部 agent 先调 protectText 传 contentRef**——外部客户端没有加密入口和对应令牌粒度；服务端代为 protect 更简单。不选。

## 四、风险与反例

- **确认疲劳 / 共享令牌**：任何持令牌的外部 agent 都能反复提议，主人会被确认框轰炸。缓解：BearerGate 每分钟 30 次（bearer-admission.ts:4）+ 确定性 id 防重。反例：把限流调高再让三个 agent 同时提议，确认框会排队刷屏——这是可接受的已知代价，还是要per-client令牌（ADR 0219 已否决）需 Andy 再拍。
- **确认框是给“人”看的，内容却来自外部 agent**：提议正文里可能带指令式文字（“确认即视为同意…”）。缓解：message 模板固定、正文原样引用且仅此一段，参数里除 text/category 外无自由字段。反例：text 写满社会工程话术——只能靠主人看清再点，工具无法替人判断。
- **凭据入库**：外部 agent 提议的正文若含密码/密钥，会以 `private` 档存进去（网页端主人自己建记忆也要自己勾敏感）。读回时 `maskForExternalRead` 会遮（ADR 0219 决定 4），但存储本身不设防。是否在提议时用 `packages/sensitive-capture` 的检测把含机器密钥的提议直接拒掉，见“需拍板”第 2 条。
- **非交互 Claude Code 会话**（`claude -p`）不支持 `elicitation/create`（Claude Code 文档第 652 行），提议一律失败回固定文字——预期行为，不算缺陷，但要写进工具描述免得 agent 反复重试。
- **ledger 与记忆非原子**：记忆建成、结果记录没写成的窗口存在；确定性 id 保证重试收敛，但期间“依据”抽屉少一条记录。反例：注入 ledger 故障，重试前抽屉里只有 pending_approval。
- **换 MCP 令牌**会作废所有未决 requestState（TTL 内的确认框点完也过不了 verify）——影响面是“确认中途换钥匙”，可接受。

## 五、需要人拍板的取舍

1. **提议时是否写 `pending_approval` 记录**：写了，主人没确认的提议也可追溯（我推荐写）；不写则库面更干净，但“外部 agent 问过什么”无据可查。
2. **是否拒绝疑似含机器密钥/密码的提议正文**（用 sensitive-capture 检测、命中即拒并回固定文字）：更安全但可能误伤主人真想记的内容（例如“服务器密码改成了……”这类主人明知故存的）。默认我**不拒**，只存 private 档，靠读回遮盖兜底。
3. **`propose_memory` 是否随 MCP 入口自动启用**：默认启用、不加新配置键；若要“写工具独立开关”，需要新配置键并同步 strict-configuration 校验（I-73 式两端核对），成本不小。
4. TTL 900 秒是否合适（主人手慢的场景）。

## 六、「读代码/来源证实的」与「推测」

**证实**：前提 1–6、10、11（文件：行均已读）；MRTR 规范条文（已抓原话）；SDK `inputRequired / acceptedContent / inputResponse / requestState / createRequestStateCodec / legacyShim` 的形状与行为（官方 v2 文档原话，与材料对 2.0.0 的描述一致）；Claude Code 声明 `elicitation:{form:{},url:{}}`、终端弹对话框、交互式才支持（官方文档原话）；0087 的 CHECK 允许 `memory_candidate + pending_approval/kept/discarded`；memory_records/payloads 的 id/ref 无格式约束、classification 允许 private；`append` 只落四个 inputs 键。

**推测（标「未核实」）**：SDK .d.mts 的具体签名（检出无 node_modules，以官方文档为准，实现时按本地类型再核）；`createRequestStateCodec` 载荷里是否自动带 iat/exp；memory_attributes 相关表的 CHECK（category 值走的是与网页完全相同的数据形状，风险低但未逐表核）；`test/integration` 新测试如何进入 `npm run check`（按 mcp-read 同目录机制推断）；Claude Code 真机上的对话框观感（文档证实存在，未实测）。

## 七、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动面是 MCP handler（外部客户端的入口）、提示词目录新增条目和测试；不碰任何组装 Himawari→模型请求的代码（系统提示、工具定义、历史、遮盖结果全部原样），因此发给模型的内容仍然只在末尾追加、每轮会变的值仍在最后一条消息里——这个性质没有被本次改动触碰，`npm run check:prompt-prefix` 应原样通过。唯一的新“会变值”（requestState、digest、decidedAt）只进 MCP 响应和数据库，永不进入模型请求。有一个连带说明：外部 agent（Claude Code）自己的请求里会多一个工具定义——那是它发给它模型的请求的开头变化，发生在连接建立时、一次性的，属于 MCP 客户端的标准行为，不在本仓库的缓存规范管辖内。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会。会字节化的东西全部确定性：digest 对固定键序的 canonical JSON 做 SHA-256；payload ref、记忆 id、决策记录 id 都是 digest 的确定性函数；遮盖不参与提议路径。逐请求变化的值只有三类——requestState（HMAC 载荷含时间，但对客户端是不透明串，规范明文要求客户端不得解析）、决策记录的 decidedAt/durationMs（只进 SQLite）、确认框 message（固定模板+正文，单次拼接）。没有依赖前后文的遮盖、没有无序集合（memoryIds 是单元素数组、JSON 键序固定）。同一提议第 1 轮和第 2 轮的 args 由客户端按规范原样重发，服务端不做任何会改变字节的改写。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有。正向 4 条 + 反向 7 条（§6），每条反向都绑定一个可单独拆掉的守卫：拆 `requestState.verify` → 篡改用例红；拆 TTL → 过期用例红；拆 digest 绑定 → 换内容用例红；拆 `legacyShim:false` → 老客户端用例红（这正是“不用旧方式”的机器落实）；拆能力门 → 不支持客户端用例红；拆确定性 id → 重复提议用例红。另外两道既有门继续生效：`check:prompt-patalog` 的路径扫描（新固定文字不入目录即红，lessons.md:668 的教训要求手工把该测试加进第 0 层清单）和 `check:prompt-prefix`（不碰模型请求路径的回归证明）。

**4. 每个产生/修改的值，两端都核对了吗？**
逐个核过（I-73 的教训：不看 diff，看两端校验）：
- 工具名 `propose_memory`：产生于 handler 注册；消费方是 Claude Code 工具清单与测试里的工具名常量；无后端格式校验需过。
- 确认框 requestedSchema `{confirm: boolean}`：产生于 handler；消费方是客户端表单 + 重入时 `acceptedContent` 用同一 schema 校验（SDK 文档明示 accepted content 不在协议层复查，必须 handler 侧用 schema 校验——本方案照做）。
- requestState 载荷 `{proposalDigest}`：mint 与消费都在本服务，SDK verify 钩子在 handler 之前跑；无第三方消费者（客户端按规范原样回显）。
- 记忆 id `memory:external:<digest>`：memory_records.id 无格式 CHECK、有 (owner,agent,id) 唯一约束（0001:393-408）；下游消费方 recall/网页展示按通用 id 处理；applyProposal 对同 id 异内容抛 CONFLICT 兜底哈希碰撞。
- payload ref `memory-external:<digest>`、classification `private`：payloads.ref 无格式 CHECK、classification CHECK 含 private（0001:57-74）；protect 的 DUPLICATE 复用有仓库先例；content_ref 外键成立。
- `policyVersion: "memory-external:v1"`：TEXT 列无 CHECK，网页先例同形。
- 决策记录：kind/outcome 过 0087:64-72 的 CHECK；id/reason_code/subject_ref 长度过 0087:18/35/36；inputs 只用 `insertLedgerRow` 实际落的四键（约定文档第 35 行）；`memoryIds` 指向刚建的记忆 id，读取端（依据抽屉）按“记忆不存在/受限”降级显示，已有约定。
- codec 密钥派生自现有 MCP 令牌：BearerGate 只存 sha256 摘要、互不影响；无新配置键，故无 strict-configuration 两端要新核对的项。
