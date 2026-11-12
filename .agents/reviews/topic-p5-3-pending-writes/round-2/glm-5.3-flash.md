# 审核结论：外部记忆先待确认、整批确认方案

## 一、证实的问题（按严重度从高到低）

**P1（高）· Muse 批量写入会被现有限流挡掉，方案没提**
- 证据：`apps/agent-service/src/bearer-admission.ts:4` `AUTHORIZED_PER_MINUTE = 30`，`bearer-admission.ts:32` 窗口内达到即 `rate_limited`；ADR 0219 决定 1（`docs/adr/0219-read-only-mcp-entry-with-static-token.md:55`）「每分钟最多 30 次有效请求」。`propose_memory` 每次调用是一条 tools/call，也就是一个 HTTP 请求。Muse 定时任务批量搬运几十条记忆就会超过 30 次/分钟，回 429；而按 brief 里已核对的事实，Muse「失败的写操作不自动重放」且 45 秒判失败——结果是这一轮数据静默丢失，且下一轮定时任务继续撞墙。
- 建议：写路径用独立的 `BearerGate` 实例和独立密钥用途（`mcp-write`），限流单独配置（和读取分开）；或者方案里明确要求 Muse 侧按分钟分片。这是目标 1「不丢」的直接威胁。

**P2（高）· 网关契约层完全没进方案（I-73 同款：只看改动本身，没核对两端）**
- 证据：每个网关操作都要在 `packages/gateway-contracts/src/contracts-v2.ts` 注册：操作名清单（`contracts-v2.ts:61-81` 一带）、命令 schema（先例 `memoryApprovalRespondCommandSchema`，`contracts-v2.ts:1387-1394`）、快照注册（`contracts-v2.ts:2257`）。UI 侧靠 `installedGatewayV2Operations` 广告判断入口可用（`apps/control-center/src/memory.ts:71`）。展示「来自其他 agent」的数据源是 `memory.overview.snapshot` 的 `pending` 数组，schema 里 `requestId/threadId` 是必填 `machineString`、`text` 是 `boundedString(2000)`（`contracts-v2.ts:1300-1309`）——外部提议的字段形状、正文长度上限、客户端名格式都必须在这个 schema 里能站住。
- 建议：PR A 明确列出契约改动清单：新操作名 + 批量 schema（先例：import 的批量上限 1–500，`contracts-v2.ts:1376`）+ overview 快照新增字段（或独立查询）+ 服务端能力广告 + UI 侧 gating 测试。不写这条，方案落到实现时必然撞上。

**P3（高）· 两个查重漏洞，违背目标 5「重发不重复」**
- 证据（方案原文）：「去重键 = sha256(客户端名 + 规范化正文)。同一键已有 pending 或 kept 时，不再新建」。
  - 漏洞 1：**被拒后可以无限重提**。键只挡 pending/kept，主人点了「不要」之后，Muse 下一轮定时任务又推同一条，又生成一条新的待确认，主人反复拒。被拒（rejected）也应挡，至少回应里要说明「这条你已拒绝过」。
  - 漏洞 2：**确认时不再查重**。提议时查了「正文与现有正式记忆完全相同则不新建」，但确认可能发生在几天后，期间主人可能自己新建了同样的记忆；确认路径直接建记忆，不重查 → 重复记忆。
  - 附带：键里含客户端名，而客户端名是对方自报的（`apps/agent-service/src/production-mcp-read.ts:118-128`，clientInfo.name 缺失时回退 User-Agent 开头一段）——Muse 换版本、UA 变化，同一段文字就算新提议；两个客户端发同一段文字产生两条待确认。
- 建议：去重键改为 `sha256(规范化正文)`（或正文+分类），客户端名只作展示元数据；rejected 也挡；确认路径在建记忆前再查一次与现有正式记忆的完全相同。

**P4（中）· 「和网页新建记忆相同的检查（restricted 直接拒）」与代码不符**
- 证据：`packages/sensitive-capture/src/identifiers.ts:20-28`，`classificationWithIdentifiers` 只可能返回入参值或 `"sensitive"`，永远不会返回 `restricted`；网页新建（`apps/agent-service/src/production-memory-control.ts:846-864`）根本没有 restricted 拒绝逻辑。网页口径是：正文含凭证/受限标识 → 升为 sensitive 照存。
- 建议：外部提议统一由服务端算分类（`classificationWithIdentifiers(text, "private")`，仓库规则也要求识别只能用 `@himawari-agent/sensitive-capture`），凭证类照网页口径升 sensitive（反正要主人确认）；含机器密钥的可以拒，但别写成「与网页相同」。

**P5（中）· 新 UI 操作要过发布演练覆盖门槛，方案没提**
- 证据：I-73 修复引入「入口覆盖由 `test/tooling/release-walkthrough-coverage.test.mjs` 守着」（`docs/incidents-and-gates.md:112`）；控制中心演练夹具逐个列操作（`apps/control-center/test/release-walkthrough.unit.test.ts:103-105` 列了 `memory.approval.respond`）。新增「来自其他 agent」分组和 `memory.external.respond` 按仓库惯例要在演练里加场景。
- 建议：写进 PR A 拆分；上线包验收（browser-acceptance）里也应该能看到这个分组。

**P6（中）· 正文与编辑文本的长度边界没有定义**
- 证据：契约先例 `editedText: nullable(boundedString(500))`（`contracts-v2.ts:1392`）；UI 展示正文 `boundedString(2000)`（`contracts-v2.ts:1305`）。`propose_memory` 的 inputSchema 长度上限方案没写——超过 2000 的提议落库后在 UI 里展示不了（契约校验会拦快照）。
- 建议：`propose_memory` 的 inputSchema 写死 `maxLength`，与快照契约一致；「改一下再保存」沿用 500 或明确放宽并同步契约。

**P7（低）· 新 MCP 工具的固定文字要登记提示词目录，工具注解要改**
- 证据：ADR 0219 决定 6 先例：「工具说明文字登记进提示词目录」（`docs/adr/0219-...md:81`）；现有三个工具都标 `readOnlyHint: true`（`production-mcp-read.ts:166`），写工具不能照抄；MCP 规范要求 tools/list 顺序固定、集合「MUST NOT vary per-connection」（<https://modelcontextprotocol.io/specification/2026-07-28/server/tools>）。`propose_memory` 的说明和「已收到，等主人确认…」这类固定回复应进 `packages/prompt-catalog`（先例 `mcp.tool-result-failed`）。
- 建议：补进 PR A。

**P8（低）· 批量确认的失败语义只写了一句「每条在事务里」**
- 建议：明确写成「逐条幂等：重复 id 返回已有结果；某条失败不影响已成功的条目，UI 重试只补剩余条目」，并配一条测试证明（先例：`memory.import.commit` 的幂等返回 `replayed: true`，`production-memory-control.ts:895`）。

## 二、推测 / 未核实

- **推测**：`memory:mcp:<提议 id>` 能通过标识符校验——`MACHINE_IDENTIFIER_PATTERN` 允许冒号、最长 128（`packages/domain/src/identifiers.ts:39`），但前提是提议 id 本身是机器标识符且总长 ≤128。提议 id 生成处要加这条约束（这正是 I-73 的教训模式：产生端和使用端都要验）。
- **未核实**：P5-2 的方案全文（`/mnt/project-files/p5-2-mcp-write/plan-thread.md`）在仓库外，读不到；`requestState` HMAC、写入函数能否被确认路径复用，只能按 brief 转述接受。
- **未核实**：Cloudflare Access Managed OAuth 的 DCR/RFC 8707 行为按 brief 引用接受；`packages/platform-node/src/identity-gateway.ts` 的 JWT 校验复用性我没有读，方案引用它但未给行号。
- **未核实**：Muse 的能力（OAuth 续期、单凭据）全是主人转述，与 ADR 0162 后果里记的「未验证的风险」（`docs/adr/0162-...md:61`）一脉相承，只能上线后实测。

## 三、侧重检查：从入口走到结束的一条普通流程

Muse 定时任务 → 连接 `/api/mcp/v1`（鉴权）→ 调 `propose_memory`（无 elicitation 声明）→ 服务端检查分类/长度 → 写 `external_memory_proposals` pending 行 + 账本 `memory_candidate/pending_approval` → 主人打开网页「设置 → 记忆」看到分组 → 点「全部保存」→ `memory.external.respond` → 逐条建记忆（`memory:mcp:*`）+ 标 kept + 账本 `kept` → 次日该记忆出现在聊天检索/档案。

未经测试覆盖的路径（按方案 PR A 现在只列了「官方 SDK 客户端不声明 elicitation」一个正向用例）：
1. 声明了 elicitation 的客户端走弹框、**不**落 pending（正向分支的另一半）；
2. 重复提议、超上限、429 限流后的行为；
3. **pending 永不出现在 recall/档案块/主动检查/记忆整理/抽取的「最近记忆」**——目标 2 是这条方案的立身之本，最需要「反向证明存在」的集成断言（先例：ADR 0179 用 `tentative-memory-capture.unit.test.ts` 这类测试守住边界）；
4. 批量确认的中途失败与重试；
5. 确认时与现有正式记忆撞车；
6. 新网关操作的发布演练场景（P5）。

文档与规则一致性：方案声称「六、对发给模型的请求」不变——查证成立，因为「每日回顾」是控制中心 UI 页（`apps/control-center/src/i18n/resources/zh-CN.ts:943`「每天打分」，非模型提示词），加一句话不改任何发给模型的字节。但 `prompt-catalog` 登记（P7）和客户端支持文档（方案已有）要补全。

## 四、必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？——不会。**
新工具定义只发给外部 MCP 客户端，不进 Himawari 自己的模型请求；待确认提议不进任何检索/档案/提示；确认后的记忆与网页新建记忆同路径，只出现在新对话的档案块或逐轮追加的记忆资料（每轮会变的值在最后一条消息里），已发内容仍只追加。两个注意点：若将来把「待确认 N 条」写进发给模型的回顾提示（而不是 UI），那就成了新提示词文字，必须登记 `prompt-catalog` 且只对新对话生效；`check:prompt-prefix` 不需要动，因为请求组装路径零改动。

**2. 会不会让同一段文字在不同请求里变成不同字节？——模型请求不会；存储侧有一处未定。**
不进模型请求的东西不影响字节。唯一的不确定点是去重键的「规范化正文」没有定义——必须写成固定规则（Unicode 正规化形式、空白折叠与否、大小写），并在测试里锁定；客户端名回退链是确定的（`production-mcp-read.ts:118-128`）但 UA 会变，影响去重（P3），不影响字节。

**3. 有没有对应的自动检查、反向用例会不会真的失败？——有测试框架先例，但方案列的用例不够。**
仓库先例是真实 SQLite + 官方 SDK 的集成测试（`test/integration/mcp-read.test.ts`），PR A 沿用是对的；但必须补上文「侧重检查」列的 6 组反向用例，并且按仓库惯例（如 `prompt-catalog.unit.test.ts:370` 的 REVERSE 用例）验证删掉守卫代码时测试确实失败。新增网关操作另有过 `release-walkthrough-coverage` 门槛这一层（P5）。

**4. 产生的每个值，两端都核对了吗？——逐值核对结果：**
- `pending_approval` 账本结果：已允许（`decision-ledger.ts:45`）✓；但 `insertLedgerRow` 只落 `memoryIds/ruleIds/batchId/resultMemoryIds` 四个键（写约定 `docs/execution/specs/2026-11-09-decision-record-write-convention.md:35`），收据记录 `memoryIds` 为空、确认记录要写落库后的编号，`subjectRef` 用什么（建议 `mcp-proposal:<id>`，与 `mcp-client:*` 先例一致）方案要写明。
- `memory:mcp:<id>`：标识符校验可过但需约束提议 id（见「推测」）。
- 新网关操作 + 快照字段：契约层缺口，P2。
- 客户端名：已有 `CLIENT_NAME` 正则（`production-mcp-read.ts:39`），UI 分组展示必须复用同一正则和长度上限。
- 每客户端上限 N：`startup-configuration` 校验要加（先例：`runPolicy.mcpRead` 只接受一把 `mcp-read` 密钥，ADR 0219 后果节）。
- 编辑文本：`boundedString(500)` 契约先例（P6）。
- 分类值：P4，`classificationWithIdentifiers` 的真实行为与方案表述不符。

## 五、如果由我来定，我会怎样改这份方案

1. 保留「新表 `external_memory_proposals`」——不复用 `memory_approval_requests`（`run_id/thread_id` NOT NULL，`packages/persistence-sqlite/src/migrations/0012_sensitive_memory_approvals.sql:5-6`）和不用 `attributes.tentative`（ADR 0179 决定 3/4 明确让它被主动检查和聊天检索召回）这两个论证都查证属实。
2. 去重键改为不含客户端名的 `sha256(规范化正文)`，写死规范化规则；pending/kept/rejected 都挡；确认时再查重一次（P3）。
3. 写路径独立密钥用途和限流（P1），并给 `propose_memory` 的 inputSchema 定长度上限（P6）。
4. PR A 的范围明确加上：契约层改动、发布演练场景、startup 配置校验、目标 2 的「不存在性」断言（P2/P5/侧重检查）。
5. 分类检查改按 `classificationWithIdentifiers` 的真实口径描述（P4）；工具说明与固定回复登记 prompt-catalog（P7）。
6. 连接方式维持方案的首选（Access Managed OAuth），但把退路明确记成对 ADR 0162「放弃的做法」的反转（`docs/adr/0162-...md:55`），理由要写清：应用层从 Bearer 换成 JWT 校验后原来「占用 Bearer 头」的冲突消失，两层认证仍是两层；待定的「两种都接受」要定死——写路径只收 JWT（或静态令牌 + 边缘策略并存但写明取舍），因为写入比读取更值得收紧。

**业界做法（一手来源）**：外部写入先待审这件事，业界没有一模一样的先例——ChatGPT/Gemini 的记忆都只来自本人会话。最接近的一手依据是：MCP 规范对工具调用的「human in the loop」原则（"there SHOULD always be a human in the loop with the ability to deny tool invocations"、"Prompt for user confirmation on sensitive operations"，<https://modelcontextprotocol.io/specification/2026-07-28/server/tools>），以及各大助手「记忆可查看/编辑/删除」的用户主权做法（Gemini Saved info：<https://support.google.com/gemini/answer/15637730>；Memory Summary 可增删改：<https://support.google.com/gemini/answer/13594961>；ChatGPT Memory：<https://help.openai.com/en/articles/8590148-memory-in-chatgpt>，此条转引自 ADR 0179，未重新抓取）。另外已核实一条 brief 的引用修正：客户端能力声明与「服务端不得发不支持的 elicitation 模式」的原话在 elicitation 页（"Servers **MUST NOT** send elicitation requests with modes that are not supported by the client"，<https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>），且空 capabilities 等价于只支持 form——方案按「声明了 form 才弹框」处理是对的。
