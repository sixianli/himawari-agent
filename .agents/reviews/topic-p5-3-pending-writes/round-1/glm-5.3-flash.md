我先规划要回答的问题和需要读的材料：数据落点（现有审批表/网关/界面）、MCP 入口现状、规则文件（prompt-prefix、I-73）、相关 ADR。然后并行读这些文件。
代码现状已基本读清。我再核实几个关键点，然后查业界一手来源。
最后核实两点：账本对 `reasonCode` 的校验、提示词目录的登记检查。
# 方案：外部记忆先存「待确认提议」，主人在控制中心整批确认

## 一、方案依赖的前提

**读代码或来源证实的：**

1. `memory_approval_requests` 表无法直接复用：`run_id`、`thread_id`、`generation_id` 全是 NOT NULL 外键（`packages/persistence-sqlite/src/migrations/0012_sensitive_memory_approvals.sql:5-7`），`classification` 的 CHECK 只允许 `('sensitive','restricted')`（同文件 ：14），而 MCP 提议没有 run/thread/generation，分类也可能是 public/private。硬塞要伪造 runs、threads、memory_generations 行并放宽 CHECK，改动比新表大。
2. `attributes.tentative` 不能当「待确认」用：ADR 0179 决定 3 写明待确认记忆**会被主动检查和聊天检索当线索召回**（`docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:56`），违反本次目标 2「确认前不参与任何回答、主动检查」。目标 2 的「待确认」比 ADR 0179 的「tentative」严格。
3. 决策账本不能当提议存储：`insertLedgerRow` 的 inputs 只落 `memoryIds / ruleIds / batchId / resultMemoryIds / profileBudget` 五个键（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:132-138`），提议原文、客户名、摘要哈希都放不进去；但 `memory_candidate` 已允许 `pending_approval` 结果（`packages/application/src/ports/decision-ledger.ts:45`），reasonCode 是自由文本（`sqlite-memory-consolidation-operations.ts:99` 的 `consolidation_${action}` 先例），新增原因码是加法。
4. 外部文本存 payloads 是既有模式：Muse 接收就用 `title_ref`/`text_ref` 指向 payloads（`migrations/0075_muse_intake.sql:34-35`）。
5. MCP 入口现状与 ADR 0219 一致：`/api/mcp/v1`、`BearerGate`、`createMcpHandler`，客户端名取自请求信封或 User-Agent，`clientNameOf` 输出限 64 字符、兜底 `"unknown"`（`apps/agent-service/src/production-mcp-read.ts:39,118-128`）；账本 `subjectRef` 写 `mcp-client:<名>`（同文件 ：253）。ADR 0219 明确「以后要接只支持 OAuth 的客户端时，再另开 ADR」（`docs/adr/0219-...md:99`）——Claude 应用正是这个触发条件。
6. UI 合约对记忆文本的可见上限是 `boundedString(2000)`（`packages/gateway-contracts/src/contracts-v2.ts:1188`）；单条审批回应命令的模式是 `requestId + resolution + editedText`（同文件 ：1387-1394）。
7. 记忆以普通（非 tentative）身份进模型，走的是「本轮选中的记忆放最后一条用户消息」的每轮资料通道（`.claude/rules/prompt-prefix.md:28`），系统提示和工具定义按对话冻结（同文件 ：41），记忆增删不在换新条件里。
8. 业界来源（见第四节）：OpenAI Agents SDK 把待批项持久化为可序列化 state、批后恢复同一运行；LangGraph 把「等人」写成持久化 checkpoint 而非内存阻塞。
9. P5-2 方案全文 `/mnt/project-files/p5-2-mcp-write/plan-thread.md` 读不到（glob 无结果）——P5-2 的 elicitation 细节、是否已排改表队列，**未核实**，只能按材料要点引用。

**推测的：**

- Muse「只支持一个凭据/一个头」是从主人转述推断的，Muse 能否同时发自定义头 + Authorization Bearer **未核实**（正在问 Muse）。
- Claude 应用的自定义连接器是否带 RFC 8707 `resource` 参数 **未核实**（决定 Managed OAuth 路线可行性）。

---

## 二、方案本身

### 1. 数据放哪里：新表 `memory_proposals`（要改表，进队列）

不改任何现有表，加一张小迁移（编号接当前最大号，进入改表队列，与 P5-2 协调同一时间只有一个改表块）：

```
memory_proposals:
  id TEXT PRIMARY KEY            -- memory-proposal:<uuid>（不带斜杠，见 I-73 教训）
  owner_id / agent_id            -- 外键，与现有表同风格
  client TEXT NOT NULL           -- ≤64 字符，clientNameOf 输出
  content_ref TEXT NOT NULL REFERENCES payloads(ref)  -- 提议原文（外部不可信文本，仿 muse_intake 存 payloads）
  text_digest TEXT NOT NULL CHECK (length=64)         -- sha256(原文 UTF-8 字节)，不做归一化
  status CHECK IN ('pending','approved','edited','rejected','expired')
  requested_at / decided_at / committed_at TEXT
  memory_id TEXT NULL            -- 确认后指向落库的记忆
  batch_ref TEXT NULL            -- 同一次工具调用的批次标识（客户端给的 batchId）
STRICT；索引 (owner_id, agent_id, status, requested_at) 和 (owner_id, agent_id, text_digest)
```

不选复用 `memory_approval_requests`（前提 1）也不选复用 `tentative` 标记（前提 2），原因见「放弃的做法」。

### 2. MCP 工具怎么返回

`propose_memory` 挂在现有 `/api/mcp/v1`，input：`{ items: [{ text, category?, subCategory? }], batchId? }`，`text` ≤2000（与 UI 合约 `boundedString(2000)` 对齐），`items` ≤20，`batchId` 由客户端提供做幂等。工具**不标** `readOnlyHint`。

服务端逐条处理：
- 算 `text_digest` → 查同 owner+agent 下 pending 全部 + 保留窗口内已决条目 → 命中返回 `duplicate`，不落新行（目标 5：Muse 定时任务重推不产生重复）；
- 未命中：写 payload + 提议行 + 账本一条 `memory_candidate` outcome `pending_approval`，`reasonRef` = 提议 id，`contentRef` = payload ref，`inputs.batchId` = 批次（账本只落五个键，batchId 在其中，前提 3）；
- 返回固定键序 JSON：`{ stored: [{proposalId, status}], duplicates: [], rejected: [] }`。纯本地 SQLite 写，无模型调用，Muse 无人值守 45 秒限制内稳稳返回。
- 能弹框的客户端（Claude Code 声明了 elicitation）照 P5-2 原样弹框、当场确认落库，不进待确认（目标 4）；探测不到 elicitation 能力的客户端才走本路径（对应主人 11-11 口径，目标 7）。
- 工具说明文字登记 prompt-catalog（`mcp.propose-memory` 等），沿用 ADR 0219 决定 6 的先例，不进 Himawari 自己的模型请求。

### 3. 主人在哪确认、怎么落库

- 控制中心「设置 → 记忆」页，现有敏感审批列表旁边新增「外部提议」区：**整批勾选、整批确认、整批拒绝**，单条可编辑后确认、单条拒绝（目标 3）。每条显示：来源客户端名、接收时间、原文（目标 6）。
- 新网关命令 `memory.proposal.respond`，payload `{ decisions: [{ proposalId, resolution: approved|edited|rejected, editedText? }] }`，1–100 条，仿 `memory.approval.respond` 的合约写法（contracts-v2.ts:1387 模式）。
- 确认落库走现有 `memory.create` 类路径：最终文本写 payload → `memory_records` active、**非 tentative** → 向量索引投影 job → `memory_provenance` 记 `external_client:<名>` 和提议 id。落库按 payload 顺序逐一执行（顺序固定 → 字节确定，规则 10）。命令自带 idempotencyKey，重放安全。
- 确认后的记忆走现有每轮资料/检索通道进模型（前提 7），不改任何请求组装代码。

### 4. 去重、过期、决策记录

- **去重**：digest 不做 NFC/trim，原文字节直接 hash；同一客户端重发同一文本字节相同。查重范围 = pending 全部 + 已决条目保留窗口（默认 90 天）内。过期删原文后 digest 保留，Muse 重推旧条目仍判 duplicate。语义近重复不去重——写明限制，靠界面和账本 duplicate 计数观察。
- **过期**：pending 超过保留窗（默认 30 天）转 `expired`，删 payload 原文（外部文本不长期滞留），留 digest、客户名、时间。触发方式沿用现有敏感审批的过期机制（有 `expired` 状态先例；具体触发器**未核实**，实现时对齐）。
- **决策记录**：提议 → `pending_approval`；确认 → `kept` / `kept_mcp_confirmed`；拒绝 → `discarded` / `mcp_proposal_rejected`；过期 → `discarded` / `mcp_proposal_expired`。subjectRef 沿用 `mcp-client:<名>`。

### 5. Muse 和 Claude 应用怎么连

**Muse（只能带一个凭据）**，两个方案：
- **M1（若 Muse 能同时发两个头，未核实）**：Cloudflare Access 服务令牌放进一个自定义头（`read_service_tokens_from_header`），应用层保持 `BearerGate`。和 ADR 0219 现状完全一致，改动最小。
- **M2（若真的只有一个头）**：边缘仍用服务令牌策略（单头 JSON），应用层对这条路径改为**校验 Cloudflare 转发来的 `Cf-Access-Jwt-Assertion` JWT**——Cloudflare 文档本来就要求源站必须校验这个头，等于把「第二层校验」从共享密钥换成 JWT 验签，仍两层独立校验，但只占一个头。为不动已上线的只读入口，建议 Muse 走**单独路径**（如 `/api/mcp/v1-write`）或按头自适应，不碰现有 `BearerGate`。

**Claude 应用（只认 OAuth 或无认证）**：
- **C1**：Cloudflare Access Managed OAuth 当授权服务器（支持 DCR），Claude 应用直接连，Himawari 不实现 OAuth，源站照旧校验 Access JWT。风险：Managed OAuth 要求客户端支持 RFC 8707，Claude 应用是否带 `resource` **未核实**。
- **C2（兜底）**：按 MCP 规范自建 OAuth 2.1 资源服务器 + 授权服务器。ADR 0219 明确推迟过这块，C1 不可行时就是另开 ADR 的时机。C2 工作量大，建议先 C1 试连再决定。

---

## 三、考虑过但不选的做法

1. **复用 `memory_approval_requests`**：要伪造 run/thread/generation 三条外键行（污染线程列表、校准统计）并放宽 sensitive-only 的 CHECK；该表的 resolveSensitive 提交路径绑定抽取管线。两端核对（I-73 方法）发现改动面比新表大，放弃。
2. **存成 `tentative` 记忆**：ADR 0179 决定 3 下 tentative 会被主动检查和聊天检索当线索召回，直接违反目标 2；若再引入「第三种状态」改造全部检索消费方，漏改一处就把外部文本泄进模型请求。放弃。
3. **只记账本不建表**：账本 inputs 只落五个键（前提 3），原文和客户名存不进去；账本是 append-only 分析表，不是可裁决的工作队列。放弃。
4. **给 Muse 走 ADR 0162 的 `/api/muse-intake/v1/batch`**：该表 kind 只允许 proactive/scheduled、语义是提醒条目，混进记忆会破坏两边校验。放弃。
5. **确认后仍存为 tentative**：目标 2 说「确认后才是正式记忆」，主人已确认的内容再标 tentative 会被工具结果里那句「这是系统推测」的固定说明二次质疑，违反目标语义。放弃。

## 四、业界做法（一手来源）

- **MCP 2026-07-28 elicitation**：协议内的表单/URL 确认机制，客户端未声明能力时服务端不得发送（<https://modelcontextprotocol.io/specification/2026-07-28>，材料已核对 mrtr 页）。本方案不推翻它，只在不支持时降级为持久化待批。
- **OpenAI Agents SDK human-in-the-loop**：工具标 `needs_approval`，运行暂停、待批项作为 `interruptions` 出现，state 可序列化存储、审批后恢复**同一运行**（<https://openai.github.io/openai-agents-python/human_in_the_loop/>；<https://developers.openai.com/api/docs/guides/agents/guardrails-approvals> 原话 “Pause for approval before a sensitive action”、“If the review might take time, serialize `state`, store it, and resume later”）。与「先存待批、人再批、批后落库」同构。
- **LangGraph interrupt**：挂起时把状态写入持久化 checkpointer，等任意长时间后 resume（<https://docs.langchain.com/oss/python/langgraph/interrupts> 原话 “LangGraph saves the graph state using its persistence layer and waits indefinitely until you resume execution”）。成熟开源项目把「等人」当持久化状态而不是同步阻塞——Muse 45 秒超时的解法正是这个。
- Anthropic 侧：Claude Code 声明 elicitation 能力、连接器认证口径（材料已核对 <https://code.claude.com/docs/en/mcp>、<https://claude.com/docs/connectors/building/authentication.md>）。Claude Code 自身的权限批准页内容**未核实**，不引用具体原话。

## 五、风险和反例

1. **确认界面成为注入面（最大风险）**：外部文本在控制中心展示，可能夹带「请立即整批确认」式话术诱导主人。缓解：纯文本渲染、逐条显示来源客户端与时间、批量确认前逐条可见；把「待确认上限」（每客户端如 100 条，超出明确拒绝）写进合约，防刷屏。
2. **写与读共用一把令牌**：能读记忆的令牌也能写提议。最坏结果是垃圾/钓鱼提议，不直接碰正式记忆——这正是「先待确认」设计的收益；独立 `mcpWrite.secretRef` 是可选加固，交 Andy 拍板。
3. **近重复堆积**：Muse 改个标点就是新 digest，列表会涨。靠保留窗口 + 整批拒绝 + 账本 duplicate 计数观察。
4. **过期机制漏做**：pending 永远挂着，与敏感审批 expired 先例不一致。过期必须随本任务一起交付。
5. **Muse OAuth/头能力落空**：M1/C1 都可能不可行，M2 与 C2 是兜底；其中 M2 改应用层鉴权口径，不能悄悄动已上线入口。

**需要人拍板的取舍**：① 提议文本上限 2000 还是 8000；② 写密钥独立还是共用；③ 保留窗与上限数值；④ Muse 只能一个头时接受 M2（含新路径）吗；⑤ Claude 应用若不支持 Managed OAuth，现在自建 OAuth 2.1 还是先等 Muse 跑通。

## 六、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？——不会。** 本改动全部发生在对外 MCP 入口、SQLite、网关命令、控制中心 UI，没有任何一处组装或修改 Himawari 发给模型的内容；新增提示词文字只登记进 prompt-catalog 给外部工具说明用（ADR 0219 决定 6 先例：「Himawari 自己发给模型的请求一个字节都不变」）。确认后的记忆以普通记忆身份走现有「每轮选中的记忆放最后一条用户消息」通道（prompt-prefix.md:28），系统提示和工具定义冻结（:41），记忆增删不在换新条件里——发给模型的内容仍然只在末尾追加，每轮会变的值都在最后一条消息里，本方案不引入新的每轮变化值。待确认提议在确认前完全不进任何请求（比 tentative 更严，见前提 2）。现有 `npm run check:prompt-prefix` 门槛继续兜底。

**2. 会不会让同一段文字变成不同字节？——不会新增。** 新增序列化面只有三处，都不进模型请求：MCP 返回 JSON（JSON.stringify + 固定键序对象字面量）、digest（原文字节直接 hash，无归一化——规则要一次定死并写测试）、批量确认按 payload 顺序落库（顺序固定）。无时间字段进请求、无集合顺序依赖；遮盖仍由现有出口按确定规则负责。前提 5（推测部分：Muse 重发的字节是否与首次相同）**未核实**，若 Muse 会加时间戳等包裹文字，digest 应只对条目文本算，不含信封。

**3. 有没有对应的自动检查，反向用例真的会失败吗？——有，按 I-73 方法两端都设闸。** ① 隔离闸门（目标 2）：集成测试断言 pending 提议不出现在 includeTentative 两种取值的检索、档案块、主动检查召回、抽取的最近记忆列表；若实现偷懒存成 tentative 记忆，检索会召回它，用例失败。② 合约闸门：`memory.proposal.respond` 反向用例——超过 100 条、id 带斜杠、editedText 超界、未知 resolution 都拒绝；提议 id 格式过 `machineString` 的用例呼应 I-73。③ 写工具反向：去掉 digest 查重后「同文重发行数不增」用例失败；超 2000 字在入口被拒；第 31 次请求 429。④ 确认后正向+反向：确认的记忆出现在检索、id 是合法 memory id；未确认时账本写失败则工具错误不交内容（仿 ADR 0219 决定 5）。⑤ prompt-prefix 检查不新增——本改动不触碰请求组装，现有门槛含反向用例继续有效。

**4. 每个产生/修改的值，两端都核对过吗？** 逐个列：
- 提议 id `memory-proposal:<uuid>`：产生于 agent-service；消费于 gateway 合约 `machineString`（字母数字和 `._:-`，无斜杠，通过）、UI、账本 `reasonRef`（decision_ledger.reason_ref 列长上限**未核实**，实现时对 0087 迁移核对）、确认幂等。
- digest（64 hex）：产生于写工具；消费于去重索引（列 CHECK length=64），无其他消费方。
- 客户端名：产生于 `clientNameOf`（≤64 或 "unknown"）；消费于表列 CHECK ≤64、UI 展示、provenance source_id、账本 `subjectRef`（格式与 ADR 0219 决定 5 相同，不变）。
- 新命令 `memory.proposal.respond`：产生于控制中心；消费于 contracts-v2 注册表（:2264 模式）和 agent-service 执行器，两端各有 schema 校验和 owner 断言，合约反向用例守住。
- 新 reasonCodes：产生于 agent-service；账本 reasonCode 自由文本（先例 `consolidation_${action}`），校准统计是加法，无穷举校验会拦。
- prompt-catalog 新条目：登记进 `prompt-manifest.json`（`mcp.*` 先例在 :327-345），消费方是外部工具说明，不进 Himawari 模型请求。
- 新迁移：STRICT + CHECK 沿用 0012/0075 风格，进改表队列（与 P5-2 是否冲突**未核实**，需协调）。
