# 「记忆中心」方案设计

## 一、方案依赖的前提

### 读代码或来源证实的

| # | 前提 | 来源与原话 |
|---|------|-----------|
| P1 | 发给模型的内容只追加，会变的值放最后 | `.claude/rules/prompt-prefix.md:35`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”；`:28`：“每轮都会变的内容只放在最后一条用户消息里。例如当前时间、本轮选中的记忆……” |
| P2 | 只追加有自动检查且反向用例必须失败 | `prompt-prefix.md:74`：“它还带反向用例：改写历史里的用户消息、让系统提示带上每轮变化的值、关掉冻结……检查都必须报告失败。” |
| P3 | 对外 MCP 入口现状：三个读工具 + 两个提议工具、Cloudflare Access 认证、读结果遮盖、自报客户端名记台账 | `apps/agent-service/src/production-mcp-read.ts:94-95`（工具名清单）、`:93`（`cf-access-jwt-assertion` 头）、`:829`（`JSON.stringify(maskForExternalRead(outcome.output))`）、`:867`（`subjectRef: \`mcp-client:${client}\``） |
| P4 | MCP 服务创建时没有 instructions | `production-mcp-read.ts:400-406`：`new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { requestState…, inputRequired… })`，没有 instructions/serverInfo 说明 |
| P5 | 客户端能力是动态探测的（确认框支持与否） | `production-mcp-read.ts:331-342` `elicitationSupported`：读 `CLIENT_CAPABILITIES_META_KEY` 里的 `elicitation` 能力判断 |
| P6 | Himawari 自己用的主人概况已有组装逻辑，2000 字预算，五个固定节，按重要度+id 排序（确定性） | `packages/application/src/services/owner-profile-service.ts:14`（`OWNER_PROFILE_CHARACTER_BUDGET = 2000`）、`:25-31`（PROFILE_SECTIONS）、`:114-118`（`byImportance`，重要度并列时按 `id` 比较） |
| P7 | 不支持确认框的客户端现被直接拒绝；P5-3 计划改为待确认表 + 批量确认 + 稳定键替换 + 规范化正文去重 | `docs/adr/0225-…md` 决定 6：“客户端不支持确认框时，直接拒绝，不写。Andy 在 P5-3 里同意了以后改成「先存成待确认，Andy 批量确认」”；材料第四节（P5-3 计划，`/mnt/project-files/p5-3-pending-writes/integrated-plan.md` 在本检出里不存在，未直接读到） |
| P8 | 提议编号、记忆编号、requestState 已有完整产生/消费链 | `production-mcp-read.ts:579,722`（`proposalId: randomUUID()`）、ADR 0225 决定 3：“记忆编号是 `memory:mcp:<提议编号>`”；`:356-360`（`createRequestStateCodec` + HMAC + 绑定方法名和主体） |
| P9 | 外部客户端身份只能自称，不是安全边界 | `docs/adr/0227-…md:115`：“所有客户端都以 Andy 本人登录，凭证主体相同，所以「这条提议来自哪个客户端」仍然只能靠客户端自报的名字。” |
| P10 | 认证反向用例已验证会失败 | `docs/adr/0227-…md:118`：“把校验换成「有凭证就放行」，或者去掉主人核对，拒绝用例会失败（已手动验证）。” |
| P11 | 规则是硬性设定不是记忆；规则手册有导出格式（RULES.md + rules.jsonl，带校验） | `docs/product-vision.md:59`：“规则不是记忆，是硬性设定：记忆只保存一条规则的出处和修改历史”；`docs/adr/0233-…md` 决定 2 |
| P12 | 台账已记外部读取，每次读取一条（客户端名、工具名、命中记忆 id） | `packages/application/src/ports/decision-ledger.ts:38,58`（`external_read`，结果只允许 `"read"`）；`production-mcp-read.ts:860-886` |
| P13 | 争议合并等主人裁决；模型可预评待决事项 | `docs/adr/0220-…md`（标题“整合冲突等主人裁决”）、`docs/adr/0237-…md`（标题“模型预评等待中的决定”） |
| P14 | I-73 的教训：值的两端都要校验，门槛要能抓“清单里的 id 过不了后端校验” | `docs/incidents-and-gates.md:112`：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」……门槛是 `npm run check:model-ref-contract`” |
| P15 | 文件导入靠关键词正则分类，去重是子串包含、依赖 existingTexts 的遍历顺序 | `apps/control-center/src/memory-import.ts:29-49`（`guessCategory` 正则）、`:59-66`（`isDuplicate` 用 `includes`） |
| P16 | 每人一个程序、一个数据库文件 | `docs/adr/0234-…md` 决定 2 |
| P17 | Claude Code 钩子：http 与 mcp_tool 两种处理方式；additionalContext 进模型上下文；钩子不会发起 OAuth 登录；启动时的 SessionStart 早于 MCP 可用、mcp_tool 钩子会被跳过；输出上限 1 万字符 | <https://code.claude.com/docs/en/hooks>：“MCP tool hooks (`type: \"mcp_tool\"`): call a tool on a configured MCP server. The tool's text output is treated like command-hook stdout.”；“The hook never starts an OAuth flow, so authenticate the server from `/mcp` first.”；“`SessionStart` at launch … fire before the session's MCP servers are available to hooks. Claude Code skips their `mcp_tool` hooks without calling the tool … For anything the session needs at launch, use a `type: \"command\"` hook on `SessionStart` instead.”；“The `additionalContext` field passes a string from your hook into Claude's context window. Claude Code wraps the string in a system reminder …”；“capped at 10,000 characters” |
| P18 | MCP 2026-07-28：无 initialize 握手、每次请求自带能力和身份；`server/discover`；tools/list 顺序应确定；DCR 被弃用、改推 CIMD | <https://modelcontextprotocol.io/specification/2026-07-28/changelog>：“Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake. Every request now carries its protocol version and client capabilities in `_meta`”；“Add `server/discover`”；“Servers **SHOULD** return tools from `tools/list` in a deterministic order to enable client-side caching and improve LLM prompt cache hit rates.”；“Deprecate the OAuth 2.0 Dynamic Client Registration Protocol … in favor of Client ID Metadata Documents” |

### 材料给了、本次未逐一复核的（按材料原文引用）

- Claude/Gemini 的官方导入流程（提示词导出 + 压缩包导入）：<https://support.claude.com/en/articles/12123587>、<https://support.google.com/gemini/answer/16868299>。
- Supermemory 的两条经验（模型可能不主动调工具；插件钩进 agent 才不等模型判断）：<https://supermemory.ai/blog/how-to-make-your-mcp-clients-share-context-with-supermemory-mcp.md>。
- mem0 的 Codex 接入分简版（全靠模型调工具）/完整版（钩子采集召回）：<https://docs.mem0.ai/integrations/codex.md>。
- Codex 钩子 14 个事件、输出作 “extra developer context”：<https://learn.chatgpt.com/docs/hooks.md>（这个域名本身可疑，未核实）。
- Grok 自定义 MCP 连接器：<https://docs.x.ai/grok/connectors>；Claude 应用全档位可加自定义连接器、Muse 不能弹确认框（ADR 0227 引的 Muse 原话）。
- MacPaw Portable Memory 征求意见稿：<https://research.macpaw.com/publications/portable-memory.md>。

### 明确未核实的（方案里不依赖它们）

ChatGPT 个人版能否加自定义 MCP；各客户端是否把服务端 instructions 放进模型上下文；Claude 云端会话里钩子/连接器的行为；Codex 钩子有没有 mcp_tool 等价物。这四条都影响 tier-B 的覆盖面，见「风险」。

---

## 二、方案本身

### 0. 总体形态：一个协议、三种挂接、能力动态分级

接入面只有一个：`/api/mcp/v1`（MCP 2026-07-28，P18 无状态化后任何新客户端自带协议版本和身份，`server/discover` 可选）。新 agent 出现时，Himawari **不改代码**，由客户端落在三档之一，档位由运行时能力探测决定（P5 的 `elicitationSupported` 已是先例），不维护客户端名单：

- **A 档（MCP 客户端）**：Claude 应用、Grok、Muse、Claude Code、未来 Codex/ChatGPT——只要它能加远程 MCP 连接，粘一个 URL 完事。能弹确认框的就是 A+ 档。
- **B 档（钩子连接器）**：本地 agent（Claude Code、Codex）装一个 Himawari 发布的插件/钩子包，把「读取」和「推送」都做成钩子，不靠模型自觉（P17、Supermemory 经验）。
- **C 档（文件桥）**：接不了前两档的（自家网页聊天、语音产品），走导出/粘贴桥和文件导入。

### 1. 读：从「等模型调工具」改成「会话开始就有，工具负责追问」

问题根源（Supermemory 原话、mem0 完整版存在本身就是证据）：挂上 MCP 工具不等于模型会调。解法分三层：

1. **新工具 `owner_context`（一次给全）**：复用 `owner-profile-service` 的组装逻辑（P6：五节、预算、确定性排序），外加 today_context 的当日信息和规则手册摘要，一次返回。它存在的意义是给 B 档钩子和 A 档连接器的「开场调用」当唯一入口——客户端只需要调这一个工具。参数 schema 里没有会变的东西；响应末尾放 `generatedAt`。预算（2000 字）沿用，不加写死的阈值。
2. **钩子注入（B 档主动送达）**：Claude Code 上用 SessionStart 的 **command** 钩子（不用 mcp_tool——P17 明说启动时的 SessionStart 会跳过 mcp_tool 钩子）或 UserPromptSubmit 的 **http** 钩子调 Himawari，把 `owner_context` 的文本作为 `additionalContext` 注入（P17）。注意 P17：“The hook never starts an OAuth flow”——钩子的认证不能走 Cloudflare Access OAuth，要给装了插件的机器发一把独立的设备密钥（认 ADR 0229 的设备密钥路线，不新造机制），且这把密钥能随时在网页上撤销。
3. **A 档的残余**：给 MCP serverInfo 加 instructions（P4 缺失），说明里写清「会话开始先调 owner_context」； Whether 客户端把它放进上下文未核实（P-未核实第二条），所以这层只算尽力，不作为承诺。遮盖照旧走 `maskForExternalRead`（P3）。

另外加 **`changes_since`**（增量同步）：参数一个不透明游标，返回上次同步以来新增/修改/删除的记忆（删除给墓碑）。它是第 9 题「遗忘传播」的机制基础，也是度量「这个客户端几天没同步了」的数据来源。

### 2. 推：记忆在对方侧产生（同意主人的倾向），但触发不靠模型

主人担心 token（材料·约束），且数据本来就在对方侧。我同意「**推记忆条目，不推原始对话**」，但把「谁触发」从模型手里拿走：

- **B 档（钩子，主通道）**：Stop / SessionEnd 钩子把**该 agent 自己已经落盘的记忆**（Claude Code 的 `~/.claude/projects/<project>/memory/`、Codex 的 `~/.codex/memories/`）做一次 diff，把新增和修改的条目用 `propose_memories`（批量、带稳定键）推过来。推的是对方自己已经提炼好的条目，Himawari 不跑任何抽取模型，token 成本≈0。云会话里钩子怎么工作未核实，这档在云端会话退化为 A 档。
- **A 档（模型提议，兜底）**：`propose_memory` / `propose_rules` 照 ADR 0225/0226；Muse 这类有定时任务的客户端，定时任务扫自己的记忆变化推增量（Muse 原话支持定时任务，ADR 0227 前提 3）。
- **改与删**：稳定键（客户端名 + 对方侧的键）是主键语义：同键新内容在待确认阶段直接替换（P5-3 已定）；**对已保存的记忆**，同键新提议作为「修订」出现，确认时展示新旧对比，接受即把旧记忆标 supersededBy（P6 里 `currentlyValid` 已认这个字段，`owner-profile-service.ts:110`）。对方删了一条：钩子推一条墓碑提议，确认后把对应记忆标记「来源已删」，不物理删。全部动作进台账、可撤销。

### 3. 信任与确认：能力定档、内容分库、预评辅助、冲突等主人

- **信任档位随能力走，不写名单**：A+ 档（声明了 elicitation）→ 客户端内逐条确认（ADR 0225）；A 档/B 档 → 待确认表批量确认（主人 2026-11-11 的标准，P7）。B 档的钩子推量最大，逐条确认必累。解法不是调高「自动放行」，而是**确认界面按稳定键/类别分组 + 复用 ADR 0237 的模型预评**：每组先标「像该收/像该拒/拿不准」，主人主要裁决「拿不准」和抽查，一键收下一组。自动放行仅当主人自己在设置里打开（配置项，不写死阈值），且只对非敏感类别生效。
- **「关于主人的事」与「项目技术知识」分开，答案是分开**：编码 agent 一次几百条项目笔记，既不该进主人概况，也不该靠主人逐条点。给 `propose_memory` 加一个 `scope`（固定枚举，沿用 `EXTERNAL_PROPOSAL_CATEGORIES` 的收法，`production-mcp-read.ts:708`）：`personal`（进主人记忆，现有九类）或 `project`（进新表 agent_notes，带项目名/稳定键，重要度低、不入主人概况、`find_memories` 默认不搜、专门一个 `project_notes` 查询或 `find_memories` 的显式参数）。project 类默认整批确认时折叠预览。**敏感判定照旧**（`classificationWithIdentifiers`，ADR 0225 决定 5），project 里有敏感内容的单独浮出来。
- **冲突**：同键=修订（上面处理）；不同来源说法矛盾→两条都存、标 tentative，进主人的裁决队列（沿用 ADR 0220 的「冲突等主人」），裁决前 `owner_context` 里两条都给、各带来源。

### 4. 存量

- **能导出的产品（ChatGPT、Claude）**：用各家官方导出/导入机制反过来用——Himawari 生成一段「把你记住的关于我的东西逐条列出来」的提示词（Claude/Gemini 的官方导入就是这么做的，材料第一节），主人贴进旧 agent，把输出贴回 Himawari 的导入页。**和网页现有文件导入走同一条候选管线**（`parseMemoryText` → ImportCandidate → 确认）。
- **本地 agent（Claude Code、Codex）**：文件导入直接吃它们的记忆目录/MEMORY.md（现有 `memory-import.ts` 已认 Codex 文件和 AGENTS.md，P15），引导流程写进产品页（约束：不会编程的人也能走完）。
- **聊天历史压缩包**：导入后只作为**存档**（可搜、不抽取、不进概况）；要抽取的话主人逐批明确勾选，且声明 token 消耗——把「抽不抽」的决定权留给主人，方案不默认抽。
- 分类建议仍是关键词正则（P15），但只作为**可编辑的建议值**（ImportCandidate.checked 已有这个语义）；不往正则里继续投资。

### 5. 规则

在 Himawari 里照旧是硬性设定（P11）。对别的 agent，诚实定位：**规则在别处只是文字**（ADR 0233 背景里已经承认这一点）。做法：

- `rule_book` 工具照旧；B 档钩子把 `RULES.md`（ADR 0233 导出的、给人读也给 agent 读的形式）写进该项目的 AGENTS.md/CLAUDE.md，并在注入的 owner_context 里带规则摘要。文字里明说「这是主人定的硬性规则，请当作约束；违反时把情况告诉主人」，但不假装能强制——强制只在 Himawari 自己的 judge 里存在（ADR 0209）。
- `propose_rule` 保留（ADR 0226）：外部 agent 发现的新规则仍要经主人和规则流程生效，不得以记忆形式绕过（P11）。

### 6. 度量

台账骨架已有（P12：每次读取一条，带客户端名、工具名、命中 id）。补三件事，全在既有表上做：

1. 周报从「总条数」改成**按 客户端×动作（读/推/确认/拒）×工具** 分组，并给出「哪些记忆 30 天没人读过」。
2. `changes_since` 的游标水位本身就是「每个客户端最后一次同步时间」，没同步过的客户端直接可见。
3. B 档钩子每次推送回执记台账（原因码区分 `hook_push_kept/pending/declined`），能算「哪个 agent 推得勤、推了没人收」。

### 7. 遗忘与范围

- **删除传播**：主人在 Himawari 删除 → 墓碑进 `changes_since` → B 档钩子同步时删掉自己侧的对应条目、A 档客户端下次拉增量时得知；对同步不了的客户端（Claude 自家记忆），做不到强删，诚实处理：`owner_context` 自然不再含它，响应 `_meta` 里带 `revokedMemoryIds` 供客户端自觉清理，未清理的责任在客户端——所以**尽量少给**（遮盖 + 范围控制）才是第一防线。
- **范围**：记忆记录加可见范围字段（全部 agent / 排除某 agent / 仅某 agent），读取端按自报客户端名过滤。**明说这是相关性过滤，不是安全边界**（P9：客户端身份只能自称、主体都是 Andy 本人）；真正的边界还是 Cloudflare Access 的主人核对（P10）和遮盖。

### 8. P5 现状的取舍

| 保留 | 改 | 去掉/不加 |
|---|---|---|
| MCP 入口 + Cloudflare Access（ADR 0227）；三个读工具；propose 流程（0225/0226）；遮盖；external_read 台账；P5-3 待确认表整套设计（待确认、批量、稳定键、去重） | 加 `owner_context`、`changes_since`、`project_notes`；serverInfo 加 instructions；周报分组；B 档插件（新做，发布为 Claude Code 插件，P17 说插件可同时带 MCP 服务和钩子） | memory-import 的正则分类不再投资（只作建议值）；不做把原始对话全量抽提取的默认路径；不做 Portable Memory 之类的第三方开放格式（尚在征求意见稿）；不做按正文哈希当提议号（ADR 0225 已弃） |

---

## 三、考虑过但不选的做法

1. **Himawari 主动拉对方的记忆 API/数据库**。没有通用 API，每接一家要写集成，违反「新 agent 不改代码」；而且各家记忆没有导出协议。CIMD/DCR 也只解决认证不解决语义。
2. **把原始对话推给 Himawari 统一抽取**。token 贵（主人的顾虑）、还把别家产品的会话原文复制了一份（扩大泄露面）；对方侧已经提炼过一遍，重复劳动。存档导入除外（不抽取）。
3. **用 Anthropic 官方「导入记忆」的提示词作为主通道**。它是一次性的、只面向 Claude，解决不了「持续双向」。只留作 C 档存量桥。
4. **等 MacPaw Portable Memory 这类开放格式成熟再设计**。征求意见稿、无实现约束；我们的稳定键 + 墓碑 + 导出 v2 已覆盖它的核心诉求，格式以后可以再适配。
5. **给每个客户端发独立令牌来做范围隔离**。所有客户端都是 Andy 本人登录（P9），令牌分不出「谁是谁」，反而多一套要撤销的东西。范围用自报名 + 诚实声明。
6. **敏感内容也交给钩子自动同步（双向镜像）**。镜像意味着主人的敏感记忆复制到多个 agent 的磁盘；方向只做「对方 → Himawari 确认后入库」和「Himawari → 按需读取」，不做全量镜像。

---

## 四、风险与反例

- **R1：模型不调 `owner_context`（A 档残余）**。反例：Muse 挂了连接器但从没读过。缓解：B 档钩子对本地 agent 是硬注入；Muse 有定时任务可当外力；度量能看见（没读过就在周报里），但根治不了纯对话型客户端。接受为已知残余。
- **R2：钩子推的量把待确认队列淹没**。反例：一个大型重构周末产生 300 条。缓解：分组 + 预评 + project 类折叠；若还累，需要主人拍板开启「非敏感自动收」（见七）。
- **R3：稳定键被滥用来探测/覆盖**。键是客户端可自报的（P9），恶意值可以撞别人已存记忆的键发起「修订」。缓解：键带客户端命名空间（`<自报客户端名>:<对方键>`），修订必须走确认，历史可撤销。
- **R4：云会话与未核实客户端**（第三节未核实清单）。Codex 钩子是否有 http/mcp_tool 等价物、ChatGPT 能否挂 MCP，直接决定 B/A 档对它们的覆盖；上线前必须在真客户端实测，未证实前对 Codex 只承诺文件桥。
- **R5：墓碑丢失导致「删了又复活」**。客户端离线很久、游标过期。缓解：墓碑保留期内游标有效，过期客户端必须全量重拉（`changes_since` 不带合法游标即返回全量+墓碑全表）。
- **R6：`isDuplicate` 的顺序依赖**（P15）。同一批候选以不同顺序跑，去重结果不同——违反确定性精神。修：去重前先对 existingTexts 排序，加反向用例。

---

## 五、需要人拍板的取舍

1. **量大时是否开「非敏感 project 类自动收下」**。主人 2026-11-11 的标准是「先让我确认」；我建议默认遵守，把自动收作为主人可开的配置（默认关、能随时关、全程留台账可撤销）。风险：编码 agent 的错误说法未经人眼进入知识库——但 project 类不进主人概况、影响面窄。
2. **B 档设备密钥是否接受**。钩子不能走 OAuth（P17），要另发一把可撤销的设备密钥；这是对 ADR 0227「一个入口一套认证」的例外，需要 Andy 同意这个例外及其撤销流程。
3. **聊天历史压缩包是否允许（按批勾选的）模型抽取**。默认只存档；抽取要花 token，花多少、抽哪批由主人定。
4. **`owner_context` 的预算**（沿用 2000 字还是给外部读取单独定）——不写死进代码，作为配置默认值，但初值要 Andy 认。

---

## 六、证实与推测的划分

- **证实**：第一节 P1–P18 全部（代码读到行、网页读到原话）；材料第五节中 Claude Code 钩子、MCP changelog 两条本次独立复核过，其余材料来源未逐一复核（已标注）。
- **推测**：Codex 钩子行为、ChatGPT 个人版 MCP、instructions 是否进上下文、云会话钩子、B 档钩子对两家用记忆文件 diff 的实际可行性（文件位置有来源，diff 的稳定性未实测）、`owner_context` 是否真能提升 A 档读取率（机制合理，效果要靠度量验证）。

---

## 七、必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？**
本方案的改动几乎全部发生在 MCP 出口和 B 档钩子上，**不进入 Himawari 自己发给模型的请求**：新工具说明照 ADR 0225 决定 8 的先例登记进提示词目录但只用于 MCP 响应（该 ADR 原话：“Himawari 自己发给模型的请求一个字节都不变”）。凡是确实要进 Pi 请求的新信息（例如每日回顾里新出现的「外部 agent 修订了某条记忆」、主人问起待确认队列），必须按 P1 做：只在末尾追加消息/资料块，每轮会变的值（待确认条数、最新提议正文）只放最后一条用户消息；系统提示与工具定义不动。现有机制已保证这一点，且有阻断检查（P2）。依据：P1。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会，前提是按确定性实现：`owner_context` 沿用 P6 的固定节顺序 + 重要度/id 排序；`changes_since` 按 (decidedAt, id) 字典序输出；去重用规范化正文（P5-3 既定方案）而不是 `isDuplicate` 那种子串匹配，且修掉 P15 的顺序依赖；遮盖照旧走 `maskForExternalRead`（确定性由 prompt-prefix 规则第 11 条保证，P1 出处同文件）。风险点只有 R6 一处，已列修法。

**3. 有没有对应的自动检查、反向用例会不会真的失败？**
分两类。已有的：`npm run check:prompt-prefix` 带反向用例（P2）；`mcp-read`/`mcp-write` 集成测试的反向用例「已手动验证」会失败（P10）；数据导出 82 条检查（ADR 0233 决定 8）。要新增的：按 I-73 的教训（P14），给记忆中心出一道 `check:memory-hub-contract` 门槛——**从产生端生成每一个新值（稳定键、墓碑 id、游标、scope 枚举、project 分类），跑过消费端的全部校验**，并带反向用例：非法字符集的稳定键必须被写入校验拒绝、指向不存在记忆的墓碑必须被拒、顺序打乱的去重必须结果一致——这些用例在实现正确时必须失败才算有效，验收方式照 ADR 0227 反向用例「手动验证换回旧写法会失败」的做法。

**4. 改动产生或修改的每个值，两端都能接受吗？**
逐个对（产生端 → 消费端）：
- **稳定键**：产生=客户端/钩子自报；消费=待确认表唯一键、替换逻辑、网页分组显示。两端校验：字符集+长度在写入时验证（新值，新检查），不能只靠客户端自觉（R3 的命名空间包装也在写入端做）。
- **提议编号/记忆编号**：产生=`randomUUID()`（`production-mcp-read.ts:579,722`）；消费=`proposals.decided/keep`、`memory:mcp:<id>` 幂等建（ADR 0225 决定 3）、台账 `subjectRef`。链路已闭合，方案不改它。
- **`owner_context` 里的记忆 id**：产生=记忆库现有 id；消费=外部客户端（回显）。若加「客户端报告清理了哪些 id」的回执，id 必须逐个对库校验，未知 id 记台账但不崩——这正是 I-73 的做法（P14）。
- **墓碑 id 与游标**：产生=Himawari 删除流程 / 同步服务；消费=客户端回传。游标做成不透明串+服务端验签（同 `createRequestStateCodec` 的思路，P8），篡改回错误而不是全量泄漏。
- **scope/category 枚举**：产生=客户端参数；消费=`EXTERNAL_PROPOSAL_CATEGORIES` 同款 includes 校验（`production-mcp-read.ts:708`）+ 消费端（概况组装、find_memories 过滤）各自只认同一份枚举。
- **RULES.md 的〔r:〕〔m:〕标记**：产生=导出器；消费=导入校验（ADR 0233 决定 5 已有双向核对）。
- **设备密钥（若 Andy 批）**：产生=设备登记流程；消费=钩子入口校验，复用主人核对+撤销，两端都要过 ADR 0229 的密钥格式校验。
