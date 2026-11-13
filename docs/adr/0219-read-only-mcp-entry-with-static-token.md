---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amended_by: "docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md, docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md"
date: "2026-11-11"
---

# ADR 0219：对外只读 MCP 入口，静态令牌鉴权，按 2026-07-28 版规范

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

Andy 要把自己的记忆、规则和今天的情况集中放在 Himawari 一处，Claude Code、Codex 这类外部 agent 都从这里读，不各记各的。外部 agent 读取的通道是 MCP（Model Context Protocol，让 AI 客户端调用外部工具的开放协议）。这是任务 P5-1。Andy 在 2026-11-11 同意了变更清单（原文在 `/mnt/project-files/p5-1-mcp/change-list.md`），并选择先做三个只读工具，把「近一两天的对话摘要」留到任务 P3-6 合并以后再接。后续：P3-6 合并后已补上，见[决定 7](#decision)。

本 ADR 记录这个入口的鉴权方式、协议版本、三个工具，以及外部读取怎样写进决策记录。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. MCP 的鉴权不是必选项：<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization> 原话 “Authorization is **OPTIONAL** for MCP implementations. When supported: Implementations using an HTTP-based transport **SHOULD** conform to this specification.”
2. Claude Code 可以带固定的请求头连接远程 MCP 服务：<https://code.claude.com/docs/en/mcp> 原话 `claude mcp add --transport http secure-api https://api.example.com/mcp --header "Authorization: Bearer your-token"`。
3. Codex 也可以：<https://learn.chatgpt.com/docs/extend/mcp?surface=cli> 原话 “`bearer_token_env_var` (optional): Environment variable name for a bearer token to send in `Authorization`.”
4. 2026-07-28 版把协议改成无状态，并用「多轮请求」代替服务端主动向客户端提问：<https://modelcontextprotocol.io/specification/2026-07-28/changelog> 原话 “Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake.”
5. 仓库已经依赖官方 SDK `@modelcontextprotocol/server` 2.0.0（`packages/platform-node/package.json`）。它的 `createMcpHandler` 原话 “Creates an HTTP handler that serves the 2026-07-28 protocol revision from a per-request server factory and, by default, falls back to old-school stateless serving for 2025-era traffic.”
6. 现有的外部推送入口已经有一套鉴权：[ADR 0162](0162-receive-muse-data-through-a-service-token-and-an-app-secret.md) 原话 “边缘层用 Cloudflare Access 的服务令牌……应用层再要求 `Authorization: Bearer <应用密钥>`”。应用层的实现是 `apps/agent-service/src/bearer-admission.ts` 的 `BearerGate`。
7. 决策记录已经有「外部读取」这一类，只是还没有任何代码写它：`packages/application/src/ports/decision-ledger.ts` 原话 `external_read: ["read"],`。
8. 给外部的数据要先遮掉敏感内容：周报导出先例 `apps/agent-service/src/production-gap-export.ts` 原话 `return redactForEgress(text).text;`。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **鉴权用静态令牌，复用现有的 `BearerGate`。**
   - 新配置项 `runPolicy.mcpRead.secretRef`，密钥用途写 `mcp-read`，写法和 Muse 推送入口的 `museIntake.secretRef` 一样。
   - 密钥不少于 32 个字符；限流照 `BearerGate` 的规则，每分钟最多 30 次有效请求、60 次无效请求。
   - 没带令牌或令牌错时回 401，并带上 `WWW-Authenticate: Bearer`，请求不进入 MCP，也不写库；超过限流回 429。
   - 没有配置这个密钥时，路由不注册。配置了却建不起这个入口（例如记忆功能没开，或者没开网页服务）时，服务启动失败（`MCP_READ_RUNTIME_UNAVAILABLE`），不会悄悄不注册。
   - 上线到公网时，在 Cloudflare 上给这条路径加一条服务令牌策略，做法和 Muse 推送入口一样。这样有两层鉴权，任何一层失效，另一层仍挡着。这一步属于生产改动，要等 Andy 同意。
   - 不实现 OAuth 2.1 授权服务。理由见前提 1–3：鉴权本身不是规范的必选项，而 Claude Code 和 Codex 都支持带固定令牌头。
   - 2026-11-11 起：本条的固定令牌认证由 [ADR 0227](0227-mcp-entry-checks-cloudflare-access-sign-in.md) 取代。入口改为校验 Cloudflare Access 凭证，因为 Claude 应用和 Muse 接不上固定令牌。本条原文保留不改。
2. **协议用官方 SDK 的 `createMcpHandler`。** 它按 2026-07-28 版服务；还没升级的客户端发来的老版本请求，由它自带的无状态兼容方式接住。
   - 路径是 `/api/mcp/v1`，挂在现有的 Fastify 上。工具调用走 `POST`；同一路径也接 `GET` 和 `DELETE`，同样先过鉴权，再交给 SDK 按规范处理。Fastify 的请求先转成标准的 Web `Request`，交给 `handler.fetch`，再把返回结果写回 Fastify 的响应。
   - 不新增依赖 `@modelcontextprotocol/node`。它要额外引入 Hono 一套框架，而 `handler.fetch` 本来就是官方提供的标准入口。
3. **三个只读工具，列出时顺序固定，都标为只读（`readOnlyHint`）。**
   - **`find_memories`（按问题找记忆）**：直接调用聊天里 `recall` 工具用的 `ProductionMemoryRecall`，只返回模型能看到的那几档记忆。为它新加了一个不属于任何一轮对话的入口 `recallOutsideRun`。
     - 算问题向量时，走 `createProductionRunMemory` 新加的 `embedForExternalRead`。它和 Gmail 检查用的是同一套做法：同一个嵌入出口，带截止时间，费用累加到这一次读取上。
   - **`today_context`（今日上下文）**：返回主人所在时区的今天日期、现在的时间，以及 48 小时内的提醒。提醒复用 `ProductionReminderWriter.list` 来取，它加了一个时间窗口参数。近一两天的对话摘要等任务 P3-6 合并后再加。后续：已补上，见决定 7。
   - **`rule_book`（规则手册）**：返回 `ruleBookFor(settings)` 列出的每条规则，包括编号、版本、作用在哪一步、结果、来源、状态。主人自己设的规则还带上设置值，即重要发件人名单和静默时段。
     - 不返回规则的表达式。理由是 [ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md) 原话 “用户在界面看到的是试算例子，不是代码”。
   - 2026-11-12 起：[ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 2、3 在这三个工具之外加 `start_here`，并给 `find_memories` 加 `project`、`auto` 两个可选参数；决定 4 给每个接入加读取级别上限，连同 `today_context` 在内的四个读工具都受它管。`start_here` 和 `auto` 已经做出来（PR 413，2026-11-12 合并），`start_here` 按读取上限过滤，默认到 private；`project` 参数和另外三个读工具的上限，在对应的编码任务合并之前仍按本条。本条原文保留不改。
   - 2026-11-13 起：P 系列任务 B 第一部分（PR 469）让 `find_memories`、`today_context`、`rule_book` 也按读取上限过滤，默认到 private：找记忆只给不高于上限的记忆和摘要，今日上下文的提醒和摘要同样，规则手册里主人规则按出处那条记忆的分级过滤，出处找不到的不给，内置规则只在它声明的参数分级不高于上限时带参数。读工具在一处登记，每个都必须写明要读哪些数据源，只拿到按上限绑定好的那几个。上限仍是全局的一个值，按接入分开的上限等第二部分。本条原文保留不改。
4. **返回给外部之前，先遮掉敏感内容。** 返回值里的全部文字一起交给新加的 `maskSensitiveTexts` 遮好再发出去。这个函数在专门识别敏感内容的包 `@himawari-agent/sensitive-capture`，内部调用 `redactForEgress`，和 Himawari 自己发给模型的出口用同一套规则：机器密钥、密码、验证码、银行卡号、证件号。
   - 一次返回里先过一遍所有文字，记下认出的密码、验证码，再遮第二遍。这样同一个密码在一段里被点名、在另一段里单独出现时，两处都遮掉，和模型出口记住已点名值的做法一致。返回给对方的占位符只写类别（例如 `[密码]`），不带序号，所以同一段文字的遮法不随这次一起返回的其他无关内容变化。银行卡照现有规则保留尾号四位（`[银行卡 尾号1234]`），其余类别不含原值的任何信息。
   - 限制：只有这次返回的文字里有一处把这个值点名为密码或验证码，别处单独出现的同一个值才会被遮。一条记忆里只写了值、没写「密码」之类的字样，又没有和点名的那条一起返回时，它原样发出；这和 Himawari 自己的模型出口按对话记住点名值是同一种限制，只是这里的范围是一次返回。
   - 和模型出口不同的地方：模型出口遮完后发现还有机器密钥会整条扣下不发；这里 `redactForEgress` 本身已经把机器密钥换成占位符（出口检查 `check:egress-redaction` 只允许敏感包和出口模块直接调用它，所以多段文字的遮法放在敏感包里）。这道检查管的是 Himawari 向外发出的请求，不管 MCP 回给对方的响应；响应有没有遮，由 `test/integration/mcp-read.test.ts` 里密码不出现的用例把关，去掉遮盖这几条用例会失败，所以不再另做一遍。
   - 外部 agent 会把这些内容转发给它自己用的模型，而这一段路不经过 Himawari 的出口，所以遮盖要在这里先做。
5. **每次外部读取都写一条决策记录**，类别是 `external_read`，结果是 `read`。
   - `reasonCode` 写工具名；读取失败时写 `<工具名>_failed`。
   - `subjectRef` 写 `mcp-client:<客户端名>`。客户端名先取 2026-07-28 版请求自带的客户端信息；老版本请求不带这项，就取 User-Agent 请求头的开头一段。两者都只是对方自己报的名字。
   - `inputs.memoryIds` 只写这次返回了正文的那些记忆的编号（返回给对方的内容里不带编号），不写正文（依据 `docs/execution/specs/2026-11-09-decision-record-write-convention.md`）。
   - `ruleIds` 写空数组：按 [ADR 0215](0215-decision-record-points-at-the-rule-version.md) 决定 1，`ruleIds` 只记真正起了作用的规则和修订号；外部读取规则手册时没有哪条规则在做判断，和那份 ADR 决定 2 的记忆候选记录一样留空。
   - `costMicros` 写这次算问题向量花的钱；读取中途失败时，也写失败前已经花掉的钱（找记忆时两路检索都结束后才报失败，所以另一路的嵌入费也算在内）。
   - 决策记录写不进去时，这次读取按失败处理：不把内容交给对方，只回工具错误。这样「每次外部读取都有一条记录」始终成立。
   - 2026-11-12 起：[ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 1 把来源从 `mcp-client:<客户端名>` 改成服务端生成的接入编号；决定 13 让钩子每句话自动搜的读取里空手而归的只在按天的统计表里计数、不写决策记录，交出了内容的仍然每次一条。对应的编码任务合并之前，代码仍按本条。本条原文保留不改。
6. **工具说明文字登记进提示词目录**，编号是 `mcp.find-memories`、`mcp.today-context`、`mcp.rule-book`、`mcp.tool-result-failed`。Himawari 自己发给模型的请求一个字节都不变。
7. **（2026-11-11 补，P3-6 合并后）`today_context` 带上今天和昨天的对话摘要。**
   - 用 [ADR 0216](0216-gmail-check-reads-recent-day-summaries.md) 新加的 `MemoryEpisodeService.recent`，按主人时区取今天和昨天的日摘要，最多 8 段，只取模型可见的分级。只读已经生成的摘要，不补生成，所以外部读取不花模型的钱。
   - 返回字段是 `recentDays`（每段的日期和正文）；有摘要没读到时多一个 `recentDaysComplete: false`。摘要正文和其他文字一起遮盖。
   - 摘要读取失败不挡提醒：照常返回日期和提醒，`recentDays` 为空并标 `recentDaysComplete: false`。服务日志写 `mcp-read.summaries-failed`，不写整次失败的 `mcp-read.failed`；摘要不完整（部分正文读不到，或候选太多被截断）时也写这条，错误码是 `MCP_READ_SUMMARIES_INCOMPLETE`。决策记录里这六项只在输入字段里，「依据」抽屉不显示。没接上摘要读取（对话摘要没启用）时不返回 `recentDays`。
   - 决策记录按 ADR 0216 决定 6 写 `summary` 六项：`summaryIds`、`summaryDays`、`summaryCharacters`、`summaryRead`（`ok`、`partial`、`failed`；提醒先读失败、摘要还没读时记 `off`）、`summaryInjected`（是否真的交给了对方）、`summaryGenerated` 固定为 0。通用的决策记录写入（`insertLedgerRow`）原来只落四个键，这次让它在 `external_read` 记录上也落这六项，校验和 Gmail 检查共用同一个函数 `summaryInputsValid`；别的类别带这六项、或只带其中一部分，一律拒绝，`insertLedgerRow` 自己也拒绝（记忆整理直接调用它）。
8. **（2026-11-11 补，P2-3 合并后）`rule_book` 也列出主人在对话里立的长期规则。**
   - [ADR 0213](0213-owner-sentence-becomes-a-standing-rule.md) 决定 4 把这些规则存在 `rule_book_rules`，编号以 `owner:` 开头；Gmail 检查每次都读它们并执行。外部程序替主人做判断时同样要知道这些规矩，所以 `rule_book` 在内置规则之后按编号顺序列出生效中和待重新确认的主人规则，不列已撤销的。
   - 每条带编号、版本、出处、状态、类型、一句话说明，以及是否正在执行（`enforced`）。能执行的再带作用在哪一步、结果和参数（发件域名、词语这些）；参数不合法或类型不认识的，和规则列表一样标 `enforced: false`，不给参数。
   - 和内置规则一样不给表达式，返回内容整体遮盖。
   - 2026-11-13 起：按决定 3 的 2026-11-13 补充，主人规则只在出处记忆的分级不高于读取上限时列出，出处找不到的不列；内置规则带参数改为由规则自己声明参数和分级（`RuleRecord.sharedParameters`），不再按规则编号写死。已知缺口：规则出处记忆的分级目前只在含证件号或凭据时升到 sensitive，健康、财务这类规则仍是 private，默认上限下照样列出；所有写入点改用模型判断定级另作一项处理。本条原文保留不改。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- 远程 MCP 服务用静态令牌接入很常见。GitHub 官方的 MCP 服务就是这样：在 Claude Code 里用 `--header "Authorization: Bearer <个人令牌>"` 连接（见前提 2 的文档）。
- MCP 官方 SDK 推荐用 `createMcpHandler` 同时服务新旧两版协议（见前提 5）。我们照着这个做，没有自己写协议层。
- ChatGPT 和 Claude 的记忆只给自家客户端用，没有对外的读取入口。Himawari 要做的是「一个大脑，所有 agent 共用」，所以要开这个入口。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **现在就实现 OAuth 2.1 授权服务。** 放弃的原因是两家客户端都支持静态令牌头，而授权服务要多出发令牌、存令牌、撤销令牌这一整套东西，现在用不上。以后要接只支持 OAuth 的客户端时，再另开 ADR。
- **每个客户端各发一把密钥。** 现在只有一把密钥，所以撤销时所有客户端一起停。这一点在变更清单里已经告诉 Andy；他要分开撤销时，再把配置改成多把带名字的密钥。
- **在决策记录的 `inputs` 里记客户端名。** 放弃的原因是 `insertLedgerRow` 对这类记录只落四个键，要改写入路径。现在改记在 `subjectRef` 里。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 每次 `find_memories` 都要算一次问题向量，会产生嵌入费用，和聊天里找记忆一样。这笔费用记在那条决策记录上，没有单独的每日上限；有限流兜底，每分钟最多 30 次。
- 「今日上下文」的近两天对话摘要已在 P3-6 合并后补上，见决定 7。
- 写操作和确认框（2026-07-28 版的多轮请求，结果标为「需要输入」）不在这一步里做。后续：提议新记忆见 [ADR 0225](0225-external-agents-propose-memory-with-in-client-confirmation.md)，它用一把单独的写令牌，只读令牌的权限不变。
- 测试：
  - `test/integration/mcp-read.test.ts` 用真实的 SQLite、真实的记忆检索和官方 SDK 客户端，新旧两版协议都连一遍。
  - 正向：三个工具都能列出、能调通，并且写了决策记录。
  - 反向：没带令牌或令牌错时回 401 且不写记录；不相关的问题返回空；49 小时后的提醒不出现；密码不原样出现；读取失败时作为工具错误返回并记一条带已花费用的失败记录；决策记录写不进去时不交出内容。
  - `apps/agent-service/test/production-mcp-read.unit.test.ts`：同一个密码先点名、后单独出现，或先单独出现、后点名，都遮掉。
  - `apps/agent-service/test/production-http-composition.unit.test.ts`：真实的 HTTP 组装里没配这个入口时，`/api/mcp/v1` 回 404；配了时只凭令牌就能调通工具，没令牌回 401 且不写记录。
  - `packages/sensitive-capture/test/redaction.unit.test.ts`：`maskSensitiveTexts` 不论顺序都遮掉点名过的值，同一段文字的遮法不受无关内容影响。
  - `packages/platform-node/test/startup-configuration.unit.test.ts`：`runPolicy.mcpRead` 只接受一把用途是 `mcp-read` 的密钥。后续：[ADR 0225](0225-external-agents-propose-memory-with-in-client-confirmation.md) 加的写令牌 `writeSecretRef` 只接受一把用途是 `mcp-write`、和只读令牌不同的密钥，同一个测试文件覆盖。
  - `apps/agent-service/test/production-mail-embedding.unit.test.ts` 覆盖不属于任何一轮对话的嵌入入口。
  - 2026-11-11 起：上面几条里关于令牌的测试已按 [ADR 0227](0227-mcp-entry-checks-cloudflare-access-sign-in.md) 改成校验 Cloudflare Access 凭证，`runPolicy.mcpRead` 也改成 `{ audience, proposals? }`，旧的密钥配置会被拒绝。以上原文保留不改。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0162：用服务令牌和应用密钥接收 Muse 数据](0162-receive-muse-data-through-a-service-token-and-an-app-secret.md)
- [ADR 0143：模型门槛决策的决策记录](0143-decision-ledger-for-model-gate-decisions.md)
- [ADR 0209：规则手册用 CEL 表达式，由一个裁判计算](0209-rule-book-with-cel-expressions-and-judge.md)
- [决策记录写入约定](../execution/specs/2026-11-09-decision-record-write-convention.md)
- [ADR 0232](0232-memory-corrections-flag-derived-memories-and-recheck-rules.md)：`rule_book` 里的规则可以是已暂停（`suspended`），此时不执行（后续）。

[返回阅读导航](#contents)
