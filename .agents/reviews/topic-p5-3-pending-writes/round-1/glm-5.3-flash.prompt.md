你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 6d70648373f50390c4818a5c29accd9a193cdb23。
问题、目标和约束：
# 方案讨论材料：外部 agent 写进来的记忆先存「待确认」，主人在 Himawari 里整批确认

下面列出的任何做法都只是参考，不要局限于它们。请从问题本身出发，提出你认为最好的方案；只要理由站得住，可以推翻这里的任何假设。

## 问题

Himawari 是主人（Andy）的个人 Agent。主人要把自己的记忆集中在 Himawari 一处。他平时主要用三个 AI 客户端：Muse（另一家的个人 Agent）、Claude Code、Claude 应用（claude.ai 网页、桌面、手机）。他希望这些客户端里产生的新记忆能写进 Himawari。

写入必须经主人确认。原计划（另一个任务 P5-2，正在实现）是 MCP 2026-07-28 版的「需要输入」（elicitation，表单确认）：服务端返回「需要输入」，客户端弹框问主人，主人点「保存」后客户端带着答案重发同一调用，再落库。但只有部分客户端能弹这个框。

主人 2026-11-11 的决定（原话）：“如果不支持确认框的话，对方把新的记忆推到 Himawari 这边，推过来的记忆先让我确认，我觉得 OK 了，再存到我们自己的记忆里面去”。

要设计的是：不能弹确认框的客户端调用写记忆的工具时，Himawari 怎样把提议先存成「待确认」，主人怎样在 Himawari 里高效地（最好整批）确认或拒绝，确认后怎样变成正式记忆；以及 Muse 和 Claude 应用怎样连得上 Himawari 的 MCP 入口。

## 目标

1. 不能弹框的客户端（Muse，可能还有 Claude 应用）写的记忆不丢，存为待确认。
2. 待确认的内容在主人确认前，不参与 Himawari 的任何回答、主动检查、记忆整理、档案块；主人确认后才是正式记忆。
3. 主人确认要少点击：能整批看、整批确认，也能单条改、单条拒。
4. 能弹框的客户端（Claude Code）仍当场弹框确认，不进待确认。
5. 同一条提议重发不重复；Muse 定时任务批量搬运时不产生大量重复待确认。
6. 每个待确认条目能看出来自哪个客户端、什么时候、原文是什么。
7. 「做到什么算完」（主人定，不能改，只有这一处已由主人改了口径）：客户端支持情况写入文档；不支持确认框的客户端调用写工具时，提议存为待确认（原文是“收到明确拒绝”，主人 11-11 改为存为待确认）。

## 已核对的事实（附来源）

### 客户端

- Claude Code：在 2026-07-28 连接上声明 `elicitation: {form: {}, url: {}}`（<https://code.claude.com/docs/en/mcp>，“Claude Code declares `elicitation: {form: {}, url: {}}` on the following connections”）。
- Claude 应用的自定义连接器认证只支持 OAuth（DCR、CIMD）或无认证；固定令牌请求头 `static_headers` 是 “Beta, for a limited set of organizations”，由组织 Owner 填（<https://claude.com/docs/connectors/building/authentication.md>）。Claude 应用不支持 “Resource subscriptions / Sampling / Advanced or draft capabilities”（<https://claude.com/docs/connectors/building>），文档没写是否支持 elicitation。工具调用超时 240 秒。
- Muse（主人 11-11 转述 Muse 自己查官方说明后的回答）：能当 MCP 调用方，自定义连接器支持 API key 类凭据（固定 Bearer 令牌或自定义头）和 OAuth 2.0 授权码；**不支持多密钥组合**；握手时 capabilities 为空，**不支持 elicitation**；定时任务无人值守，无响应连接 45 秒判失败不重试；它建议“确实需要人确认的动作，拆成无人值守先准备、有人时再确认执行两步”。Muse 的记忆本体是文件（MEMORY.md 和 memory 目录），可以定时读自己记忆文件、调写工具把增量同步过去。
- MCP 2026-07-28 规范：客户端没声明 elicitation，服务端 MUST NOT 发 elicitation 请求（<https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr>）。

- Cloudflare Access 的 Managed OAuth 能把 Access 变成一个标准 OAuth 2.0 授权服务器，支持动态客户端登记（DCR），要求客户端支持 RFC 8707，源站收到 `Cf-Access-Jwt-Assertion` 并必须校验（<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/>）。
- Cloudflare Access 的应用设置 `read_service_tokens_from_header` 可以让服务令牌放进一个指定名字的请求头（值是含 client id 和 secret 的 JSON），给只能带一个头的客户端用（<https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>）。
- Muse 的 OAuth 是否带 RFC 8707 `resource`、定时任务里能否自动续期，正在问 Muse，未知。

### 仓库现状（main 6d70648）

- 对外 MCP 入口（P5-1，ADR 0219）：`apps/agent-service/src/production-mcp-read.ts`，路径 `/api/mcp/v1`，`BearerGate` 固定令牌，三个只读工具 `find_memories` / `today_context` / `rule_book`，每次读取写决策记录。ADR 0219 第 58 行：上线时“在 Cloudflare 上给这条路径加一条服务令牌策略，做法和 Muse 推送入口一样”（服务令牌要多带 `CF-Access-Client-Id`、`CF-Access-Client-Secret` 两个请求头）。
- P5-2（未合并，方案已获主人同意）：`propose_memory` 写工具，能弹框的客户端走 elicitation，`requestState` HMAC 签名、10 分钟过期、参数摘要，确认后用 `memory:mcp:<提议编号>` 作 id 落库，决策记录 `memory_candidate` kept/discarded；客户端没声明 elicitation 时原计划直接返回“不能弹确认框，没有保存”，现在会在这条路径留接口，换成“存为待确认”。方案全文：`/mnt/project-files/p5-2-mcp-write/plan-thread.md`（如读不到，以上为要点）。
- 已有的「敏感记忆审批」：表 `memory_approval_requests`（迁移 `0012_sensitive_memory_approvals.sql`），`run_id`、`thread_id` 都 NOT NULL；端口 `SensitiveMemoryApprovalStatePort`（`packages/application/src/ports/automatic-memory.ts:99`）；网关操作 `memory.approval.respond`（`apps/agent-service/src/production-memory-control.ts:978`）；网页「设置 → 记忆」顶部列出待审批（`apps/control-center/src/memory.ts`）。目前只能逐条回应。
- 已有的「待确认记忆」标记 `attributes.tentative`（ADR 0179）：不进档案块、默认不进向量检索，但**主动检查和聊天检索工具会把它当线索召回**；记忆页有「确认」动作。
- Muse 推送通道（ADR 0162）：`POST /api/muse-intake/v1/batch`，现在收的是提醒条目，不是记忆。
- 决策记录 `memory_candidate` 已允许 `pending_approval` 结果（`packages/application/src/ports/decision-ledger.ts:45`）。
- 规则的「提议卡」（P2-3）尚未合并。

### 仓库规则（约束）

- 改表要排队（同一时间只一个改表块），能不改表最好；要改就说清楚。
- 发给模型的内容只能在末尾追加（`.claude/rules/prompt-prefix.md`）；识别敏感内容只能用 `@himawari-agent/sensitive-capture`；新提示词文字要登记进 `packages/prompt-catalog`；不许写死能动态获取的值（例如客户端名单）。
- 界面上的每个数字要有可验证的定义。
- 产品愿景（`docs/product-vision.md`）原则顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。

## 请你回答

1. 你的完整方案：数据放哪里（复用哪个现有机制、要不要改表）、MCP 工具怎么返回、主人在哪个界面怎么确认、确认后怎么落库、怎么去重、过期怎么处理、决策记录怎么写。
2. Muse 怎么连上入口（它只能带一个凭据），Claude 应用怎么连上（只认 OAuth 或无认证）；各有什么取舍。
3. 业界（Anthropic、OpenAI、Google 或成熟开源项目）对“外部写入先待审、人再批准”的做法，附一手来源链接。
4. 这个改动会不会改变模型已经见过的请求开头？
5. 你认为最大的风险和最容易漏掉的场景。
