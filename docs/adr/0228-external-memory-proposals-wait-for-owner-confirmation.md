---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "apps/agent-service/src/production-mcp-read.ts, packages/persistence-sqlite/src/migrations/0012_sensitive_memory_approvals.sql, packages/sensitive-capture/src/identifiers.ts, packages/sensitive-capture/src/machine-secrets.ts, test/integration/mcp-write.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0228：其他 agent 写进来的记忆先存「待确认」，主人在 Himawari 里确认后才保存（部分取代 ADR 0225 决定 2、3、6）

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0225](0225-external-agents-propose-memory-with-in-client-confirmation.md) 让外部 agent 用 MCP 工具 `propose_memory` 提议新记忆。MCP（Model Context Protocol）是让 AI 客户端调用外部工具的开放协议。按 ADR 0225，Himawari 在客户端里弹一个确认框（MCP 叫 elicitation，服务端请客户端向人要一个回答），Andy 点同意才保存。客户端弹不出确认框时，Himawari 直接拒绝，什么都不存。

Andy 平时用的三个客户端里，有两个在这一步会丢数据：

- Muse 根本不声明支持确认框。
- Claude 桌面 App 里的 Claude Code 声明支持，却不弹框，约 10 毫秒后自动回「拒绝」（ADR 0225 已记下，`mcpProposalAnswer` 把这种回答判为 `unseen`）。

Andy 2026-11-11 在任务 P5-3 的线程里改了完成标准：弹不出确认框的客户端推过来的记忆，先让他确认，他觉得可以了，再存进 Himawari 自己的记忆。方案原文在 `/mnt/project-files/p5-3-pending-writes/integrated-plan.md`，Andy 同日回「同意」。

本 ADR 定后端：新表、MCP 工具的行为、确认和撤销的网关操作。网页上「来自其他 agent」那一节界面和数据导出放在下一个 PR（见[后果](#consequences)），这样改表队列可以先放行。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. **Andy 的完成标准。** 2026-11-11 P5-3 线程里 Andy 的原话：“如果不支持确认框的话，对方把新的记忆推到 Himawari 这边，推过来的记忆先让我确认，我觉得 OK 了，再存到我们自己的记忆里面去”。同日他对方案第五节两项都回「同意」：Claude Code 也改用 OAuth；“弹框无人答转待确认”。
2. **客户端没声明确认框时，服务端不得发确认请求，也不能指望客户端会重发。** 来源 <https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr>：“if a client does not declare support for `elicitation`, the server **MUST NOT** include any `elicitation/create` requests”；“Servers **MUST NOT** assume that clients will fulfill the `inputRequests` or retry the original request.”
3. **「取消」不等于「拒绝」。** 同一规范的 elicitation 页 <https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>：`decline` 是 “User explicitly declined the request”，`cancel` 是 “User dismissed without making an explicit choice”。
4. **已有的待确认标记不能用。** `docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md` 第 56 行：tentative 记忆在“主动检查的记忆召回……和聊天里的记忆检索工具……打开”。模型能看到它，违反前提 1 的“确认后才存进我们自己的记忆”。
5. **敏感记忆审批表不能直接复用。** `packages/persistence-sqlite/src/migrations/0012_sensitive_memory_approvals.sql` 第 5 到 7 行：`run_id`、`thread_id`、`generation_id` 都是 NOT NULL，外部提议没有这些值。
6. **分级函数只会调高。** `packages/sensitive-capture/src/identifiers.ts` 的 `classificationWithIdentifiers` 只返回传入的分级或 `"sensitive"`，不会返回 `restricted`。
7. **机器密钥有现成的识别函数。** `packages/sensitive-capture/src/machine-secrets.ts` 的 `scanMachineSecrets` 识别私钥块、Bearer 令牌、JWT、OpenAI 和 GitHub 令牌、AWS 访问密钥和「password=…」这类赋值。
8. **P5-2 留下的判定和接口。** `apps/agent-service/src/production-mcp-read.ts` 的 `mcpProposalAnswer(action, askedAt, answeredAt)` 返回 `"accepted"`、`"declined"` 或 `"unseen"`，阈值 `MCP_PROPOSAL_UNSEEN_ANSWER_MS` 是 1500 毫秒。合并前判出 `unseen` 时回 `mcp.propose-not-shown`，什么都不写。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **新表 `external_memory_proposals`（迁移 0093）。** 一行是一条提议：
   - 字段：提议编号、作用域、登录身份（Access 凭证主体的摘要）、客户端自称的名字、客户端给的固定编号（`source_key`，可空）、规范化正文的 SHA-256 摘要和规范化版本（`mcp-text:v1`）、正文（加密存在 `payloads` 里，表里只存引用）、分类、分级、状态、收到时间、决定时间、确认批次号、落库后的记忆编号、被哪条替换。
   - 状态四种：`pending`（待确认）、`committed`（已保存）、`rejected`（已拒绝）、`superseded`（被同一个固定编号的新内容替换）。
   - 这张表只有 MCP 写工具和记忆页的确认操作读写，没有任何组装发给模型内容的代码读它。依据「用户主权」：确认前 Himawari 不用它。
   - 2026-11-12 补：[ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 9 有一处例外：主人在待确认页面点“先帮我筛一遍”时，待确认的正文进一次独立的后台模型调用，只用来给主人出建议。这个功能等 ADR 0242 决定 9 补注说的另一份 ADR 定下按分级能发给哪些模型、怎样遮盖之后才做。别的不变：没确认的内容不进记忆、不进概况、不进对话请求。对应的编码任务合并之前，代码仍按本条。本条原文保留不改。
2. **去重按正文，不按客户端。**
   - 同一作用域里，除被替换的以外，同一个正文摘要只有一行（唯一索引）。同样的正文再来，不管哪个客户端、带不带固定编号，都回原来那一行的结论：待确认的回同一张回执，已保存的回「已保存过」，拒绝过的回「主人没有同意」。所以拒绝过的内容不会再出现。同样的正文以更高的分级再来（例如第一次分类是「其他」、第二次是「健康」），待确认那一行的分级调成敏感，只升不降；待确认正文的 payload 引用里带分级，调高时换成按敏感加密的那份，旧的没人引用就删掉。
   - 待确认的正文存在 `memory-content:mcp-proposal:<作用域、分级和摘要的哈希>`，同一段正文同一分级只存一份。
   - 待确认最多 1000 条；待确认加上 30 天内拒绝、被替换还留着正文的，合计最多 5000 条，这样一个编号反复换正文也绕不过上限。满了以后新的正文不再收（同样的正文已在表里的照常回结论），单条回 `mcp.propose-memory-full`，批量里那一条回 `full`，本次写下的正文同时删掉。依据「记忆可靠性」：不悄悄丢掉已经收下的内容，也不让一个客户端无限写满磁盘、拖垮其他写入。
   - 客户端带了固定编号（`key`，最长 200 字），同一个编号带来不同的正文时，旧的待确认那条标为 `superseded`，新的进待确认；新正文已经在待确认里（例如之前没带编号提过）时，旧的同样标为被替换，那一行补上这个编号。
   - 每个固定编号指向它最近一次带来的正文，记在另一张表 `external_memory_proposal_keys`（同在迁移 0093，一个客户端的一个编号一行）。编号按客户端自称的名字分开：Muse 和 Claude Code 都用 `memory/coffee` 时互不替换。带来的正文已经保存过或拒绝过时，编号同样改指那一行，它原来指着的待确认正文照样标为被替换。替换只看编号原来指着的那一行，不按 `source_key` 列找：主人撤销后回到待确认的正文，编号早已改指别处，不会被这个编号后来的新正文替换。有客户端不带编号送来过同一段话时，记在 `external_memory_proposal_unkeyed`（同在迁移 0093），别的客户端的编号改指时不替换这一行，依据同上。同一段正文可以被几个编号同时指着：编号甲和编号乙都带来过同一段话，之后甲换了新正文，那段话还被乙指着，就留在待确认里；乙也换了，才标为被替换。依据「记忆可靠性」：一个客户端更新自己的内容，不能把另一个客户端还在用的那条挤掉。
   - 写入器自己再查一遍正文长度、机器密钥和编号长度，不只靠 MCP 入口；存储层也查各字段的长度和分类、分级的取值，坏输入回 `PORT_INVALID_OPERATION`，不会变成数据库约束错误。
3. **MCP 工具。**
   - `propose_memory`（单条）第一次调用就把提议存进待确认（草稿），再看能不能弹框：
     - 客户端没声明确认框，或记忆功能还没就绪：直接回回执「已收到，等主人在 Himawari 里确认」（`mcp.propose-memory-pending`），不是错误。回执里只有提议编号和收到时间，同一条提议每次回执的字节都相同。
     - 能弹框：照 ADR 0225 弹框。同意就保存并把这一行标为已保存；拒绝就标为已拒绝。
     - 判为 `unseen`（不到 1.5 秒就回来的回答）或者主人关掉了确认框（`cancel`）：这一行留在待确认，回回执。客户端不再重发的，这一行也已经在待确认里，不会丢（前提 2）。
     - 依据「用户主权」和「记忆可靠性」：主人没有明确说不要的，不替他扔掉。
   - 新工具 `propose_memories`（批量，一次 1 到 50 条）：不弹框，每条都进待确认，按顺序逐条回结果：`pending`、`replaced`（被同一次调用里后面同一个 `key` 的条目替换）、`already_saved`、`declined_before`、`invalid`（规范化后正文为空或超过 2000 字；正文缺失、分类不在九种里、条数超过 50 由工具参数格式挡下，整次调用被拒；字数按 UTF-16 码元算，和记忆页的长度上限一致，一个表情符号算两个）、`secret`（正文或 `key` 里有机器密钥）。一次调用只占一次限流额度。给 Muse 这类定时搬运用。
   - 两个工具都由 `runPolicy.mcpRead.proposals` 打开（ADR 0227），写进 `MCP_WRITE_TOOL_NAMES`。
   - 正文或 `key` 里有机器密钥（前提 7）的直接拒绝，回 `mcp.propose-memory-secret`。分类仍是九种，不能选「规则」。分级由服务端算，只会调高（前提 6）。
   - 只做校验、分级、加密、写表，不调模型、不算向量，一次调用在毫秒级返回。
4. **主人在 Himawari 里确认。** 记忆页的数据（`memory.overview.snapshot`）多一项 `externalProposals`：
   - `total` 是表里状态为 `pending` 的行数；`items` 是最早收到的 100 条，每条有正文、分类、分级、客户端自称的名字、收到时间；`batches` 是最近 10 个确认批次，每个有已保存和已拒绝的条数。
   - 新网关操作 `memory.external.respond`：一次 1 到 500 条，每条选保存（可附改过的正文）或拒绝。批次号是命令幂等键（`idempotencyKey`，最长 128 字）的 SHA-256 摘要前 32 位加 `batch-` 前缀：幂等键直接拼进决策记录编号会超过 128 字的上限。逐条处理，某条失败不回滚已成功的；全部失败时回第一条的错误。同一批次重发时已处理的条目按原结果计，不重复写。
   - 新网关操作 `memory.external.undo`：撤销一个批次，删掉（移进回收站）这批新建的记忆，这些条目和这批拒绝的条目回到待确认；正文已按第 6 条清掉的拒绝条目留在已拒绝。这批里挂到已有记忆的条目不回待确认、仍算已保存，只是离开这个批次，因为那条已有记忆没有被撤销，回到待确认会出现「记忆还在、正文却待确认」。撤销按提议编号和批次号算出这批新建的记忆编号，逐条比对，不按编号后缀猜。移进回收站中途失败时，已经移进回收站的那几条记忆对应的提议照样回到待确认，其余条目留在这个批次里，可以再撤销一次。移进回收站的记忆上还挂着别的提议（同一批里改成同样正文的，或者别的批次挂上来的）时，这些提议一起回到待确认，不留下指向回收站里记忆的「已保存」。正文已按第 6 条清掉的拒绝条目留在已拒绝，并离开这个批次，所以同一批不会被撤销第二次。如果一批里的条目全都已经在别的地方决定过，确认操作报冲突，不算成功。
5. **保存时怎么落库。**
   - 网页确认的记忆编号是 `memory:mcp:<提议编号>:<批次号>`，正文存在 `memory-content:mcp:<提议编号>:<批次号>`；在客户端确认框里同意的仍是 ADR 0225 的 `memory:mcp:<提议编号>`。都以 `memory:mcp:` 开头，所以记忆页仍显示「外部 agent 提议、主人确认的」。撤销后再确认，会用新批次号建一条新记忆，不和回收站里的那条撞号。
   - 用最终正文（改过的就用改过的）重新算分级，原来是敏感的不会变低。
   - 保存前对比现有记忆：已有记忆（只看已确认、没被新版本取代的 active 记忆，不看暂定的）的规范化正文和这条完全相同，就不再新建，把这一行标为已保存并指向那条记忆。已有记忆的分级低于这条提议要求的分级（例如提议是敏感、已有记忆是 private 或 public）时不挂，另建一条按提议分级的记忆，依据「边界与可逆性」：挂上去等于把敏感内容按较低的分级保存。网页确认和客户端确认框里的同意都这样做；同一批里两条改成同样的正文，只建一条。所有提交、决定、撤销和过期正文清理在同一个写入器里排队，一次只处理一个，所以网页确认、客户端确认、撤销和同一编号的替换不会交错；比对用的已有记忆摘要在本写入器新建过记忆后重新计算。客户端确认框回答时主人已在网页上决定了的，按实际结果回「已保存过」或「主人没有同意」。
   - 记忆和「保存」决策记录在同一个事务里写（`DurableMemoryService.applyProposal`）。之后再把这一行标为已保存；中途失败时重试会看到记忆已存在，只补标记。
6. **保存期限。** 待确认不自动过期：过期等于悄悄丢掉主人的数据。拒绝的条目 30 天后清掉正文（删掉 payload），只留摘要，用来挡重复提议。被替换的条目同样 30 天后清掉正文，但同样的正文又在待确认里时保留 payload。清理在每次收到提议和每次读待确认列表时顺手做；记忆页轮询变化用的修订串只读条目编号和分级，不解密正文。拒绝的正文清掉后又收到同样的正文，回「主人没有同意」，不再留下这段正文。由提议保存成的记忆被彻底删除（清空回收站或立即删除）时，在同一个删除事务里把那条提议改为已拒绝、清掉它的正文并让它离开批次，只留摘要：主人删掉的内容不再从提议那里留一份原文，以后同样的正文也不会再进待确认。
7. **决策记录。** 都是 `memory_candidate`：收到时记 `pending_approval`（原因码 `mcp_proposal_pending`），保存记 `kept`（`mcp_proposal_kept`），拒绝记 `discarded`（`mcp_proposal_declined`），被替换记 `discarded`（`mcp_proposal_superseded`）。网页确认的决策记录编号带批次号。决策记录表不用改。收到时和被替换的两种记录不进每日回顾：主人还没决定，保存后的那条才进。
8. **工具说明和回复文字登记进提示词目录**：改 `mcp.propose-memory`，新增 `mcp.propose-memories`、`mcp.propose-memory-pending`、`mcp.propose-memory-secret`、`mcp.propose-memories-result`，去掉不再用的 `mcp.propose-memory-not-ready`。这些只发给外部客户端；Himawari 自己发给模型的请求一个字节都不变。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- ChatGPT 和 Claude 的记忆都只来自自家对话。Claude 的「导入记忆」是直接存，事后在记忆面板里查看和删除（<https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude>）。两家都没有「外部 agent 写入、先审后存」的先例。
- 最接近的依据是 MCP 规范的人工把关原则：“there SHOULD always be a human in the loop with the ability to deny tool invocations”（<https://modelcontextprotocol.io/specification/2026-07-28/server/tools>）。规范同时要求服务端不能指望客户端一定会弹框或重发（前提 2）。
- 所以把确认从客户端挪到 Himawari 自己的界面里异步做：任何客户端都适用，确认弹不弹得出来不再取决于客户端。Himawari 比两家更严：确认前不用，这是 Andy 选的（前提 1）。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **用 tentative 记忆当待确认**（前提 4）：模型能看到，不符合「确认后才存」。
- **复用敏感记忆审批表**（前提 5）：字段对不上，硬塞会让两种审批在界面上一键一起点掉。
- **每个客户端最多 200 条，超了就拒**：Muse 失败后不重发，会丢数据。改成按登录身份限流加批量工具。
- **待确认 30 天自动过期**：等于悄悄丢掉主人的数据。
- **「取消」也算拒绝**（ADR 0225 原来的做法）：规范里取消是没做选择（前提 3），按拒绝处理会让同样的内容以后再也提不进来。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- **下一个 PR 要做的**（不改表，所以拆出来，好让改表队列先放行）：
  - 网页「设置 → 记忆」顶部的「来自其他 agent」一节：勾选后「保存所选」「不要所选」、全选、单条改了再保存、撤销一批；来源按「自称：Muse」显示；数字按第 4 条的定义。
  - 每日回顾在待确认条数大于 0 时加一行提示。
  - 数据导出带上这张表。在那之前，导出清单的 `omitted` 里写明这张表还没导出、有几行。
  - 上线前这两个 PR 都要合并。
- **ADR 0225 被部分取代：** 决定 2 里「取消算没同意」改为留在待确认；决定 3 的「重发时看决策记录和记忆」改为看这张表；决定 6 的「不支持确认框直接拒绝」改为存进待确认。ADR 0225、0226 里「P5-3 的待确认写入计划复用这个判定」已经实施。规则提议（ADR 0226）不进这张表，判为 `unseen` 时仍回「没显示出来」。
- **来源只能靠客户端自称。** 所有客户端都以 Andy 本人登录（ADR 0227），登录身份相同，所以界面上客户端名要标「自称」。
- **同一个进程内排队。** 网页确认和客户端确认用同一个写入器实例，同一条提议的决定按提议编号排队，表的「只改待确认的行」再兜一层，所以同一条不会被既保存又拒绝。
- **测试：** `test/integration/mcp-write.test.ts` 用真实 SQLite、官方 MCP SDK 客户端和真实的 `ProductionMemoryControl`：
  - 不能弹框的客户端存进待确认，回执固定；同样正文重发、换客户端名重发都只有一条。
  - 关掉确认框、不到 1.5 秒就回来的拒绝或同意，都留在待确认。
  - 拒绝后再提同样的正文回「主人没有同意」，不再弹框。
  - 批量 50 条一次过；51 条被拒；空正文、机器密钥逐条报告；同一个固定编号的新内容替换旧的待确认。
  - 网页上保存、改了再保存、拒绝一批；保存后 `find_memories` 能查到，确认前查不到；撤销后记忆进回收站、条目回到待确认，再确认用新批次号。
  - 和现有记忆正文相同的，不新建，指向那条记忆。
  - 待确认的正文不在任何记忆记录、检索索引、`find_memories` 和 `today_context` 里。
  - 拒绝 30 天后正文被清掉，同样的正文仍被挡住。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0225：外部 agent 提议新记忆，主人在客户端确认后才保存](0225-external-agents-propose-memory-with-in-client-confirmation.md)
- [ADR 0226：外部 agent 提议新规则，主人在客户端确认后按规则提议流程生效](0226-external-agents-propose-rules-through-the-rule-proposal-flow.md)
- [ADR 0227：对外 MCP 入口改为校验 Cloudflare Access 登录凭证，去掉固定令牌](0227-mcp-entry-checks-cloudflare-access-sign-in.md)
- [ADR 0179：低置信度的记忆候选存为待确认](0179-keep-low-confidence-memory-candidates-as-tentative.md)
- [ADR 0246：其他 agent 的提议进入网页和数据导出，格式升到 v3](0246-external-proposals-join-the-data-export-and-web.md)（后续，做了上面「下一个 PR 要做的」三件事）

[返回阅读导航](#contents)
