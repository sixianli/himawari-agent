---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0219-read-only-mcp-entry-with-static-token.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0225-external-agents-propose-memory-with-in-client-confirmation.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0226-external-agents-propose-rules-through-the-rule-proposal-flow.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0246-external-proposals-join-the-data-export-and-web.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0261-external-proposals-follow-restricted-deletion-and-expiry.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0281-memory-from-outside-agents-saves-directly-when-the-owner-turns-it-on.md"
superseded_by: ""
date: "2026-11-26"
covers: "apps/agent-service/src/production-mcp-read.ts, apps/agent-service/src/production-mcp-authorization.ts, apps/agent-service/src/production-mcp-authorization-routes.ts, apps/agent-service/src/production-mcp-client-metadata.ts, apps/agent-service/src/production-mcp-memory-writer.ts, apps/agent-service/src/production-mcp-rule-writer.ts, apps/agent-service/src/production-mcp-sync.ts, apps/agent-service/src/production-mcp-connections-control.ts, packages/persistence-sqlite/src/sqlite-mcp-oauth-operations.ts, packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts, packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts, packages/persistence-sqlite/src/external-proposal-text.ts"
verified_at: "25bf70417f1e982afea4a04437b43ca13dbf8d11"
---

# ADR 0307：外部 agent 经一个 MCP 入口读写 Himawari 的记忆

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [入口和登录](#entry)
  - [接入](#connections)
  - [读](#read)
  - [推送记忆](#push)
  - [待确认和保存](#pending)
  - [提议规则](#rules)
  - [项目笔记](#projects)
  - [怎样触发读和推](#triggers)
  - [用量和上限](#usage)
  - [数据导出和删除](#export)
- [还没做到的](#not-yet)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

Andy 要 Himawari 当他的记忆中心：别的 AI agent（Claude Code、Codex、Muse 等）从 Himawari 读他的记忆、规则和习惯，自己学到的关于他的事再推回来（2026-11-11、11-12 原话：“其他 AI agent 产生的记忆都能主动存到 Himawari 里面”“有没有一种最好的办法，让所有的 AI agent 都能很方便地接入我们的记忆？”）。愿景原则 5：“它们通过 Himawari 认识我，而不是各自记住我。”

这件事先后由九份 ADR 一步步定下来（0219 只读入口、0225 提议记忆、0226 提议规则、0227 改用 Cloudflare Access 登录、0228 待确认表、0242 一个入口的整体方案、0246 待确认进网页和导出、0261 受限记忆的删除、0281 直接存），后一份不断改写前一份。本 ADR 把其中现在仍然有效的决定合成一份，旧的九份删除；每条决定的原始理由和取舍见 `supersedes` 里的固定提交链接。

<a id="decision"></a>

## 决定

总的做法：门只有一个（MCP，模型上下文协议，让 agent 调用外部工具的公开协议）；读和推对所有 agent 用同样的工具；什么时候读、什么时候推，按对方的能力分档触发，不指望对方模型自觉；每个接入有一条主人建的记录。

<a id="entry"></a>

### 入口和登录

1. 路径只有 `/api/mcp/v1`（`MCP_READ_PATH`），所有 agent 填同一个网址，挂在现有的 Fastify 上，用官方 SDK 的 `createMcpHandler`，按 2026-07-28 版规范服务。请求体上限 64 KiB（`MCP_READ_BODY_LIMIT`）。
2. 登录按 MCP 授权规范（[2025-11-25 版](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)）用 OAuth 2.1 访问令牌（[ADR 0309](0309-apps-sign-in-with-passkeys-and-the-web-is-removed.md#mcp-oauth) 第 12 条）。请求头 `Authorization: Bearer <令牌>`；没有、认不出、过期、被吊销、所属接入已撤销的一律 401，带 `WWW-Authenticate` 头，里面写 `resource_metadata`（受保护资源说明的网址）和 `scope`（`himawari:read himawari:write`），让客户端自己找到授权服务器；接入暂停的回 403。令牌的受众必须是本入口（RFC 8707 的 `resource`），别的服务的令牌不收。读令牌库出错回 503，不当成 401。
3. Himawari 自己当授权服务器，路径前缀 `/api/mcp-auth/v1`（`MCP_AUTH_PREFIX`）：
    - 发现：受保护资源说明在 `/.well-known/oauth-protected-resource/api/mcp/v1`（RFC 9728，根路径也给一份），授权服务器说明在 `/.well-known/oauth-authorization-server`（RFC 8414），写明只支持授权码加 PKCE S256、公开客户端（`none`）、`client_id_metadata_document_supported: true`、`authorization_response_iss_parameter_supported: true`。
    - 客户端登记两种都收：客户端说明文件（client_id 本身是一个 https 网址，`McpClientMetadataCache` 去取，只连公网地址、不跟随跳转、最多 5 KiB、5 秒超时，按对方缓存头缓存 5 分钟到 24 小时，client_id 必须和文件里一字不差，带共享密钥的认证方式拒绝）和动态登记（RFC 7591，`/register`，只发公开客户端；24 小时没用上的登记自动清掉，同时最多 100 个没绑定接入的登记，`MCP_OAUTH_UNBOUND_CLIENT_MAXIMUM`）。回调地址只收 https、本机回环 http（端口不比）和反向域名的自定义协议。
    - 授权：`/authorize` 检查客户端、回调地址、PKCE、`resource` 后，生成一条待同意的授权（10 分钟有效，同时最多 20 条），给主人的 iPhone 发推送（`mcp_grant`），网页上只显示“去 iPhone 上同意”和对方名字、回调地址的域名；主人在 App 里用面容 ID 同意（网关操作 `mcp.grant.approve`，需要设备签名，`change` 级）或拒绝（`mcp.grant.deny`），等候页自己轮询 `/authorize/status` 后跳回对方，回调带 `code`、`state`、`iss`。动态登记的客户端在批准页标“未经核实”。
    - 换令牌：`/token` 校验授权码（5 分钟、只能用一次，重用就吊销这次发出的全部令牌）、PKCE、回调地址、`resource`；访问令牌 1 小时，刷新令牌 90 天、每次刷新都换新的，旧刷新令牌再被用就吊销整组（OAuth 2.1 对公开客户端的要求）。`/revoke`（RFC 7009）吊销令牌。
    - 令牌只存 SHA-256（表 `mcp_oauth_tokens`），客户端存在 `mcp_oauth_clients`；过期的令牌每小时最多清一次。待同意的授权和授权码只在内存里，服务重启后要重新接入一次。
    - 权限范围：`himawari:read` 读，`himawari:write` 推送和提议；主人在批准页可以只给读。原来的 `runPolicy.mcpRead` 配置停用，写着也被忽略（启动时记入 `retiredKeys`）。
4. 限流：全入口有效请求每分钟 30 次、无效请求 60 次（`AdmissionWindows`）；每个接入另有自己的一份，钩子的自动搜索单独每分钟 60 次（`MCP_HOOK_READS_PER_MINUTE`）。公钥集遇到不认识的 `kid` 时 30 秒内不重复下载，和 jose 库的 `cooldownDuration` 同样做法。
5. 确认框的状态（`requestState`）用 SDK 的 `createRequestStateCodec` 加 HMAC 签名，有效期 10 分钟（`MCP_PROPOSAL_STATE_TTL_SECONDS`），签名密钥在进程启动时随机生成，服务重启后旧状态全部失效。

<a id="connections"></a>

### 接入

6. 接入不再由主人手动建：对方第一次经主人同意拿到令牌时，服务端按批准页上的设置建一条接入（表 `mcp_connections`），客户端登记记下它绑定的接入；同一个客户端再次授权沿用原来的接入，编号、设置和统计不变。日志、错误和决策记录只写接入编号，不写令牌。`mcp_connections.secret_sha256` 这一列已不使用，新接入填一个随机值（SQLite 删不掉带唯一约束的列）。
7. 每个接入有：名字、读取上限（`public`、`private`、`sensitive`，默认 `private`）、推送设置 `pushPolicy`（`ask` 先问我，`direct` 直接存；批准页默认选直接存，`MCP_DEFAULT_PUSH_POLICY`，Andy 2026-11-15 定）、状态（在用、暂停、撤销）。在 App 的“接入的 agent”里可以改名、改上限和推送设置、暂停、撤销（网关操作 `mcp.connection.change`）；撤销后这个接入的令牌立刻失效，对方再来要重新经主人同意，并建新的接入。
8. 对方自报的客户端名只当附注显示，标“自称”，不当权限。能分清是哪个接入的只有令牌。不写死客户端名单。
9. 令牌在请求头里，不在网址里，不会留在对方的配置文件或沿途访问日志里。残余风险：动态登记的客户端名字是对方自己写的，可能冒充；应对是批准页标出“未经核实”、显示回调地址的域名，回调指向本机的另外提示。

<a id="read"></a>

### 读

10. 只读工具在一处登记（`MCP_READ_TOOLS`），每个都必须写明读哪些数据源和受不受读取上限管，没写的登记不上（`MCP_READ_TOOL_CEILING_MISSING`）。现有四个，列出时顺序固定，都标为只读：
    - `start_here`：一次返回主人概况和习惯（`OwnerProfileService`，2000 字预算，带内容摘要当版本号）、正在执行的主人规则摘要（每条一句话、不带参数，1200 字预算）、今天的情况；固定的在前，会变的在后，键顺序固定。
    - `find_memories`：调用聊天里 `recall` 用的同一套检索。可选参数 `project` 只搜某个项目的笔记；`auto` 给钩子用，最多 3 条（`AUTO_FIND_LIMIT`），相关度不够就返回空，不带“没找到”这类文字。
    - `today_context`：主人时区的今天日期和时间、48 小时内的提醒、今天和昨天的对话摘要（最多 8 段，只读已生成的，不补生成）；摘要读失败不挡提醒，标 `recentDaysComplete: false`。
    - `rule_book`：内置规则和主人立的生效中、待重新确认的规则，带编号、版本、作用在哪一步、结果、来源、状态；不给表达式。内置规则带哪些参数由规则自己声明（`RuleRecord.sharedParameters`），主人规则只在出处记忆的分级不高于读取上限时列出。
11. 四个读工具按接入的读取上限过滤，提醒正文、对话摘要也一样；restricted 永远不给。
12. 返回之前把全部文字一起交给 `maskSensitiveTexts` 遮盖（机器密钥、密码、验证码、银行卡号、证件号），一次返回里点名过的密码在别处单独出现也遮；占位符只写类别不带序号，所以同一段文字的遮法不随同批其他内容变。外部 agent 会把内容转给它自己的模型，这一段不经 Himawari 的出口，所以在这里先遮。
13. 每次交出了内容的读取写一条 `external_read` 决策记录：`reasonCode` 是工具名，`subjectRef` 是接入编号，`inputs.memoryIds` 只写返回了正文的记忆编号，`costMicros` 是算问题向量的钱。决策记录写不进去，这次读取按失败处理，不交出内容。钩子自动搜索空手而归的只在按天统计表里计数，不写决策记录。
14. 服务带使用说明，同样的触发条件也写进每个工具的描述；这些文字是固定的，登记在提示词目录（`mcp.*`）。它们只发给外部客户端，Himawari 自己发给模型的请求一个字节都不变。

<a id="push"></a>

### 推送记忆

15. 主力工具是 `sync_memories`：一批若干条，每条有对方自己的稳定编号（笔记文件路径之类的文字）、正文、种类（`owner` 关于主人，或 `project_note` 项目笔记）、类别提示、项目名（可空）。种类只按“是不是关于主人的话”分，不按来源分。
    - 稳定编号和项目名统一成 NFC，带控制字符或看不见的字符（`INVISIBLE_FORMATTING`，在 `packages/persistence-sqlite/src/external-proposal-text.ts`）的拒绝；正文里的这些字符换成空格。
    - 类别提示以 `MEMORY_CATEGORIES` 去掉 `rule` 为准；不给按“其他”收，给了清单里没有的值这一条判不合格，不悄悄改成“其他”（判敏感会看类别）。
    - “接入编号 + 项目编号 + 稳定编号”三列联合唯一（表 `mcp_sync_entries`）；记忆自己的编号由服务端生成。同编号同内容不产生任何东西；同编号新内容算更新，留历史版本（`mcp_sync_versions`）。
    - 每条推成功后回一个版本标记（服务端对存下的正文算的摘要）。逐条返回：待确认、已存、没变、已更新、主人拒绝过、不合格（附原因）。
    - 一批在一个数据库事务里写完，连同决策记录；中途失败整批回滚，对方原样重发不会重复。超过上限整批拒绝。
    - 服务端只做校验、去重、敏感分级、加密，不调模型。
16. 删除只认助手程序明说的：记录里有的文件连续两次完整扫描都没看到，才报删除，带上推送时的版本标记；版本标记对不上就不动。只认用服务令牌进门的助手程序报的删除，模型所在客户端经 OAuth 报的不处理。刹车：按“接入 + 项目”，一天内自动处理的删除超过当天第一次报删除时现有条数的一半（默认值，可在设置里改，`mcp_sync_limits`），这次报的都不自动处理，在待确认页放一条请主人决定。
17. 主人在 Himawari 删掉或拒绝的，只在返回里告诉这个接入“主人已删除，不再接收”；Himawari 不动主人电脑上的任何文件。
18. 旧工具 `propose_memory`（单条）和 `propose_memories`（批量，1 到 50 条）仍在，走同一张待确认表。正文规范化后要 1 到 2000 个字符（NFC，控制字符、格式字符、落单的代理项、行段分隔符换成空格，合并空格）。正文或固定编号里有机器密钥的直接拒绝。

<a id="pending"></a>

### 待确认和保存

19. 推来的关于主人的内容先进待确认表 `external_memory_proposals`，主人确认后才成为正式记忆（Andy 2026-11-11：“推过来的记忆先让我确认，我觉得 OK 了，再存到我们自己的记忆里面去”）。这张表只有写工具和记忆页的确认操作读写，组装发给模型的内容的代码不读它：没确认的内容不进记忆、不进概况、不进对话请求。
20. 分级由 Himawari 自己判，不信对方标的种类：健康、财务两类，或正文带证件号这类标识（`classificationWithIdentifiers`），按敏感处理；只升不降。像规则的话（“以后都不要……”）按偏好类记忆进待确认。
21. 去重按正文摘要，不按客户端：同一作用域里除被替换的以外同一摘要只有一行；同样的正文再来，回原来那一行的结论（待确认、已保存过、主人没有同意）。带固定编号的，同一编号带来新正文时旧的待确认标为被替换（`superseded`）；编号按客户端分开，一段正文被几个编号同时指着时，全都换掉才算被替换。待确认最多 1000 条，待确认加 30 天内拒绝和被替换还留正文的合计最多 5000 条，满了不收新正文（回 `mcp.propose-memory-full`）。
22. 直接存：接入设成 `direct` 时，先照常提交进待确认，再由写入器的 `keepDirect` 在同一把队列锁里检查，敏感的留在待确认，其余按网页确认同一套代码保存，批次号 `batch-direct-` 开头，可以整批撤销。来源写“外部 agent 送来，未经确认直接保存”，决策记录原因码 `mcp_proposal_kept_direct`。依据“边界与可逆性”：敏感内容存错的代价更大。
23. 网页确认：记忆页最上面一节“来自其他 agent · N 条待确认”（N 是 `status = 'pending'` 的行数，最多列 100 条），可以勾选后整批保存或不要、单条改一下再保存（最多 2000 字）；下面列最近 10 批，每批可以撤销。网关操作 `memory.external.respond`（一次 1 到 500 条）和 `memory.external.undo`。撤销把这批新建的记忆移进回收站，条目回到待确认。保存时用最终正文重算分级；已有一条正文完全相同、分级不低于它的正式记忆时，挂到那条上，不新建。记忆和“保存”决策记录在同一个事务里写（`DurableMemoryService.applyProposal`）。
24. 不支持确认框的客户端、确认框被关掉、或回答快于 1.5 秒（`MCP_PROPOSAL_UNSEEN_ANSWER_MS`，Claude 桌面 App 的 Code 标签声明支持确认框却约 10 毫秒自动回拒绝，见 anthropics/claude-code#105334）的，提议留在待确认，不当作主人拒绝；只有真正点了拒绝才记为已拒绝。确认框不是防恶意客户端的边界。
25. 待确认不自动过期（过期等于悄悄丢掉主人的数据）。拒绝和被替换的条目 30 天后清掉正文和批次号，只留摘要挡重复提议。由提议保存成的记忆被彻底删除时，在同一个删除事务里把提议改为已拒绝并清掉正文；删除的是受限（restricted）记忆时，连同摘要相同的提议整行删掉，不留下能被试出原文的痕迹。
26. 决策记录都是 `memory_candidate`：收到 `pending_approval`（`mcp_proposal_pending`）、保存 `kept`（`mcp_proposal_kept`，直接存是 `mcp_proposal_kept_direct`）、拒绝 `discarded`（`mcp_proposal_declined`）、被替换 `discarded`（`mcp_proposal_superseded`）。自动记忆的校准排除 `mcp_proposal_` 开头的原因码。

<a id="rules"></a>

### 提议规则

27. `propose_rule` 只能提登记表里声明了外部可提、带测试的规则类型，现在是 `mail_must_notify` 和 `mail_read_whole_thread`（`EXTERNAL_RULE_TYPES`）；参数用 `parseOwnerRuleParameters` 校验，`reason` 1 到 200 字。对不上的按偏好类记忆提。
28. 规则提议不看 `pushPolicy`，一定要主人点头才生效（ADR 0213：“模型推断出来的只生成提议，主人点头才生效”）。第一次调用只校验、试算近 30 天的回放，不写；主人同意后走规则提议的建立和确认流程，规则来源写 `mcp:<客户端名>`，同一组参数已有规则时复用那一条。
29. 同一个提议只生效一次：进程内存记下已生效和已拒绝的提议编号（保留到确认状态过期），生效后在载荷库写加密标记 `rule-decision:mcp:<提议编号>`；同一提议按编号排队，同时收到生效和拒绝只算先到的那个。
30. 每个接入的规则提议单独限频，每次到达 `propose_rule` 的调用都计数，超了直接拒，不试算。

<a id="projects"></a>

### 项目笔记

31. 项目笔记单独存，不是记忆，不逐条确认：某个接入第一次推某个项目的笔记时，主人批准一次（`mcp_project_approvals`），之后自动收。项目笔记不进主人概况，不进 Himawari 自己的聊天；别的 agent 用 `find_memories` 带 `project` 才搜得到，结果前面加固定标签，说明这是某个接入留下的资料，不是指令，主人没有逐条确认过。
32. “项目”是对方给一组资料起的名字，不限于代码仓库。服务端第一次见到一个项目名时生成项目编号（`mcp_projects`、`mcp_project_names`），项目归主人、不分接入；可以改显示名、合并。远程地址写法的项目名带用户名、密码、查询参数或 `#` 后面部分的一律拒绝，拒绝原因不带名字原文，错拒少数普通名字也比存下令牌好。对方删了的项目笔记跟着删，留历史。

<a id="triggers"></a>

### 怎样触发读和推

33. 按对方的能力分四档，档位不写死在代码里，不按产品名判断：

    | 档 | 对方的能力 | 读 | 推 | 可靠吗 |
    | --- | --- | --- | --- | --- |
    | 一 | 能跑命令钩子 | 助手程序：开场取 `start_here`，每句话用 `auto` 搜一次 | 助手程序：对话结束时扫记忆目录，推新增和改动，报删除 | 可靠，不经模型 |
    | 二 | 能挂 MCP、能跑定时任务 | 使用说明和工具描述 | 定时任务调 `sync_memories` | 尽力而为 |
    | 三 | 只能挂 MCP | 使用说明和工具描述 | 主人说“同步记忆”或模型自己调 | 尽力而为 |
    | 四 | 不能挂 MCP | 主人贴“关于我”文本 | 主人贴提示词让它列出记忆，再贴回 | 手动 |

34. 第一档的助手程序装在主人电脑上，被钩子调用：直接读对方的记忆目录（只读，不改不删），只推有变化的；和其他客户端一样经 OAuth 接入、主人同意，令牌存在主人电脑上；每次限时很短，超时就放行。它怎样和模型所在的客户端区分开（第 16 条只认它报的删除），等它做出来时再定。

35. 规则带到别的 agent 那里只是文字要求：`start_here` 和页面上写明，这些在 Himawari 里必定执行，在别的 agent 里做不到。

<a id="usage"></a>

### 用量和上限

36. 用量存在按天统计表 `mcp_connection_usage_daily`，键是“接入 + 天 + 工具 + 进门方式（`oauth` 或 `service_token`）+ 是不是 `auto` + 计数项”，同一个键只累加。读取计调用、空手而归、有内容、失败、被限流；推送每次调用记一次，失败的也记。只统计认出了接入的调用。不用决策记录存这些数。
37. App 的“接入的 agent”显示每个接入的用量和最近一次的时间；周报用同一套统计函数。每个上限都在页面上显示当前用量。

<a id="export"></a>

### 数据导出和删除

38. 待确认表随数据导出一起导出（全部状态），文件 `data/external-memory-proposals.jsonl` 和对应的结构文件，清单 `counts.externalProposals`。像机密的正文明文层只放遮盖后的样子，原文和摘要进封存文件。和任何一条受限记忆（含历史版本）正文相同的提议整条不导出，计入 `omitted`。没有正文的提议 `batchId` 置空。导入时目标库的这张表必须为空，按提议的规范化方式重算摘要，对不上整份拒绝（`DATA_IMPORT_SEAL_MISMATCH`）。现行导出格式见 [ADR 0289](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0289-data-export-v5-drops-owner-proposals.md)。

<a id="not-yet"></a>

## 还没做到的

这些是已经定下、代码里还没有的部分，按 2026-11-26 的 main 核对：

- 确认统一到 Himawari 里做：现在 `propose_memory` 和 `propose_rule` 在支持确认框的客户端里仍会弹框（`elicitationSupported`）；目标是去掉客户端里的确认框，规则提议也到 Himawari 的待确认页确认。
- 第一档的助手程序和 Claude Code 插件不在本仓库里。
- 网页上的“接入一个 agent”向导、待确认页的“先帮我筛一遍”（由低价模型给建议，要另出 ADR 定发给哪些模型、怎样遮盖）、第四档的“关于我”文本生成。
- Himawari 自己的日志、错误和指标里不出现令牌的自动检查。
- iPhone 和 Mac App 上的批准页和“接入的 agent”页（服务端的网关操作已经有了）。

<a id="options"></a>

## 放弃的做法

- **固定令牌认证**（原 ADR 0219、0225）：Claude 应用和 Muse 接不上固定令牌，一个入口只留一套认证。
- **Cloudflare Access 登录加路径里的接入密钥**（原第 2、3、6、9 条）：不是 MCP 规范的接法，Claude 等客户端不能自己完成接入，要主人手动拷网址；网页删掉后也没有地方建接入（[ADR 0309](0309-apps-sign-in-with-passkeys-and-the-web-is-removed.md#mcp-oauth)）。
- **只做动态登记，不做客户端说明文件**：规范把说明文件排在动态登记前面，Claude 连接器两种都支持；只做一种会让另一类客户端接不上。
- **收别家的原始对话，由 Himawari 抽取记忆**：要用 Himawari 的模型逐段抽，Andy 2026-11-12 选了不做，只收对方记好的笔记。
- **让项目笔记进 Himawari 自己的聊天**：会让每个老对话的请求开头换新一次，Andy 2026-11-12 选了不做。
- **按字段各自遮盖**：会漏掉“后面才点名、前面单独出现”的密码。
- **用 mcp_tool 钩子做推送**：它读不了文件。

<a id="consequences"></a>

## 后果

- 确认之后的记忆和主人自己在 Himawari 里产生的记忆走同一条路，后面的检索、概况、主动提议不按“它是哪个 agent 推来的”分别处理。
- 第二、三档仍靠对方模型自觉，产品里如实标为“尽力而为”。
- 门槛：`test/integration/mcp-read.test.ts`（令牌、遮盖、读取上限）、`test/integration/mcp-connections-store.test.ts`（令牌轮换和重用吊销）、`apps/agent-service/test/production-http-composition.unit.test.ts`（从发现到换令牌、调用、吊销的整条流程）、`npm run check:data-export`（待确认表的导出导入）、`npm run check:prompt-catalog`（工具说明文字）。
