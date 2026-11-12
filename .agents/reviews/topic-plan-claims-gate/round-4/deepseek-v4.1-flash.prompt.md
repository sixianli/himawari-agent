你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号从 1 起，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；字段里不要出现竖线字符。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 e98a036ef87e523d086791c744bbf92c5a581bef。
待核对的方案：
方案文件：docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md（在提交 e98a036ef87e523d086791c744bbf92c5a581bef 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
amends: "docs/adr/0219-read-only-mcp-entry-with-static-token.md, docs/adr/0225-external-agents-propose-memory-with-in-client-confirmation.md, docs/adr/0226-external-agents-propose-rules-through-the-rule-proposal-flow.md, docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md"
superseded_by: ""
date: "2026-11-12"
---

# ADR 0242：外部 agent 经一个入口接入记忆中心：专属网址定身份，`start_here` 读，`sync_memories` 推，按能力分档触发

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

Andy 要 Himawari 当他的“记忆中心”：别的 AI agent（Claude Code、Codex、ChatGPT、Muse、Grok 这类编码或对话程序）产生的关于他的记忆能存进 Himawari；他换用任何一个 agent，那个 agent 都能来读他的记忆、规则和习惯。

P5 系列已经做了入口：[ADR 0219](0219-read-only-mcp-entry-with-static-token.md) 开了对外的 MCP 入口（MCP 即 Model Context Protocol，让 AI 程序调用外部工具的开放接口）和三个只读工具，[ADR 0225](0225-external-agents-propose-memory-with-in-client-confirmation.md)、[ADR 0226](0226-external-agents-propose-rules-through-the-rule-proposal-flow.md) 加了提议记忆和提议规则，[ADR 0227](0227-mcp-entry-checks-cloudflare-access-sign-in.md) 把认证改成 Cloudflare 的登录凭证。

这些做完之后还差三样，本 ADR 补上：

- **触发。** 入口谁都能连，但读和存都要对方的模型自己想起来调用工具。没有任何机制保证对方该读时读、该存时存。
- **身份。** 所有客户端都用 Andy 本人的登录，名字是对方自报的，分不清是谁在读，也就没法按 agent 暂停、撤销或限制范围。
- **看得见。** 周报只有一个外部读取的总数，网页上看不到哪个 agent 读了几次。

方案经过两个模型的独立出方案和审核，讨论记录在 `.agents/reviews/topic-p5-memory-hub/`，整合后的方案原文在 `/mnt/project-files/p5-memory-hub/integrated-plan.md`。Andy 2026-11-12 在方案线程的卡片上选了“四件都按建议”，同意了方案和其中要他定的四件事（[决定](#decision)第 4、8、9、11 条）。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. **主人要的是记忆中心，读和存两半都要。** 来源：Andy 2026-11-11 在方案线程的原话：“其他 AI agent 产生的记忆都能主动存到 Himawari 里面”“以后无论换哪一个 AI agent，只要 Himawari 提供一个读或搜记忆的服务，任何 AI agent 都能通过该服务来记忆中心获取我的记忆、规则或各种使用习惯”。愿景 `docs/product-vision.md` 原则 5：“它们通过 Himawari 认识我，而不是各自记住我。”
2. **不收原始对话，由对方产生记忆再推过来。** 来源：Andy 2026-11-12 在方案线程的原话：“这个办法不是会很消耗 Himawari 的模型 token 吗？为什么不在……Claude Code 里面直接把产生的记忆推过来”。
3. **做法要对所有 agent 通用。** 来源：Andy 2026-11-12 在方案线程的原话：“有没有一种最好的办法，让所有的 AI agent 都能很方便地接入我们的记忆？”
4. **推来的记忆先确认再存。** 来源：`/mnt/project-files/p5-3-pending-writes/integrated-plan.md` 前提 1 引的 Andy 2026-11-11 原话：“推过来的记忆先让我确认，我觉得 OK 了，再存到我们自己的记忆里面去”。
5. **确认也有预算。** 来源：`docs/product-vision.md` 原则 2：“需要我确认或介入的事项同样受预算约束：常规判断应由规则手册预先授权，不逐次确认”。
6. **别的 agent 的输出是数据；信息只在必需范围内披露。** 来源：`docs/product-vision.md` 原则 1：“外部内容与其他 Agent 的输出是数据，不是可覆盖我意图的指令；我的信息只在完成任务所必需的范围内被使用和披露。”
7. **现在的读写都靠对方模型调用，服务没带使用说明。** 来源：`apps/agent-service/src/production-mcp-read.ts`：`MCP_READ_TOOL_NAMES = ["find_memories", "today_context", "rule_book"]`、`MCP_WRITE_TOOL_NAMES = ["propose_memory", "propose_rule"]`；`new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, …)` 没有传 `instructions`。
8. **客户端的名字只能自报。** 来源：[ADR 0227 的后果](0227-mcp-entry-checks-cloudflare-access-sign-in.md#consequences)：“所有客户端都以 Andy 本人登录，凭证主体相同，所以「这条提议来自哪个客户端」仍然只能靠客户端自报的名字。”
9. **外部读取现在能读到 sensitive（敏感）级别的记忆。** 来源：`apps/agent-service/src/production-memory-recall.ts`：`const allowed = modelVisibleClassifications();`；`packages/application/src/services/model-visibility.ts`：`MODEL_VISIBLE` 是 `"public"`、`"private"`、`"sensitive"` 三级。`recallOutsideRun` 传的 `"public"` 只是输出级别的下限（`highestClassification(requestClassification, …)`），不是上限。`today_context` 也一样：近两天的对话摘要同样按 `modelVisibleClassifications()` 取（`apps/agent-service/src/service-main.ts`：`allowedClassifications: modelVisibleClassifications()`），提醒正文只排除 restricted（`apps/agent-service/src/production-reminder-writer.ts`：`memory.dataClassification !== "restricted"`）。对外遮盖只按格式遮密码、验证码、证件号、银行卡号这类值（`production-mcp-read.ts` 的 `maskForExternalRead`），不按级别整条隐藏。
10. **记忆编号有格式限制，文件路径过不了。** 来源：`packages/gateway-contracts/src/validation.ts` 的 `machineString`：`input.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)`；`apps/agent-service/src/production-mcp-memory-writer.ts`：`` return `${EXTERNAL_PROPOSAL_MEMORY_PREFIX}${proposalId}` ``。
11. **入口有请求体上限和频率上限。** 来源：`production-mcp-read.ts`：`MCP_READ_BODY_LIMIT = 65_536`；`apps/agent-service/src/bearer-admission.ts`：`AUTHORIZED_PER_MINUTE = 30`；`production-mcp-memory-writer.ts`：`EXTERNAL_PROPOSAL_TEXT_MAXIMUM = 2000`。
12. **外部 agent 能提的规则只有两种邮件规则；转述的偏好按记忆提。** 来源：`apps/agent-service/src/production-mcp-rule-writer.ts`：`EXTERNAL_RULE_TYPES = ["mail_must_notify", "mail_read_whole_thread"]`；[ADR 0226 放弃的做法](0226-external-agents-propose-rules-through-the-rule-proposal-flow.md#options)：“外部 agent 的转述不是原话，提议偏好用 `propose_memory`。”
13. **Claude Code 的钩子（agent 在固定时刻自动执行的一条命令）。** 来源 <https://code.claude.com/docs/en/hooks>：命令钩子从标准输入拿到完整事件；`mcp_tool` 钩子“call a tool on a configured MCP server”，参数只能做 `${path}` 替换，不能读文件；“The hook never starts an OAuth flow”；UserPromptSubmit 上默认超时 30 秒；“Claude Code adds plain-text stdout as context that Claude can see and act on”。
14. **Codex 有同名钩子，输出同样进上下文。** 来源 <https://learn.chatgpt.com/docs/hooks.md>：它列出的事件里有 `SessionStart`、`UserPromptSubmit`、`Stop`，和 Claude Code 的事件同名；“Plain text on `stdout` is added as extra developer context.”“Hooks are enabled by default”。Codex 的钩子里跑命令行程序有什么限制没有核实，列在[后果](#consequences)的实测项里。
15. **两家自己记的笔记都是磁盘上的文件。** 来源 <https://code.claude.com/docs/en/memory>：“Each project gets its own memory directory at `~/.claude/projects/<project>/memory/`”，目录可用 `autoMemoryDirectory` 改；<https://developers.openai.com/codex/memories>：`~/.codex/memories/`，新安装用 `memories_v2`，“Memories may not update right away when a chat ends”。
16. **已有“主人概况”的生成代码，MCP 入口没用。** 来源：`packages/application/src/services/owner-profile-service.ts`：`OWNER_PROFILE_CHARACTER_BUDGET = 2000`，`compose` 接受 `maxClassification`。
17. **不经浏览器登录的程序入口已有先例。** 来源：[ADR 0162](0162-receive-muse-data-through-a-service-token-and-an-app-secret.md) 决定第 1 条：“边缘层用 Cloudflare Access 的服务令牌（Service Auth 策略，请求头 `CF-Access-Client-Id` 与 `CF-Access-Client-Secret`）”“应用层再要求 `Authorization: Bearer <应用密钥>`”。
18. **多人时是一个网址。** 来源：[ADR 0234](0234-one-program-per-person-database-file.md) 决定第 5 条：“一个网址、一个 Cloudflare Access 应用，名单里放所有受邀邮箱。”
19. **待确认表还没进 main。** 写本 ADR 时 main 上没有 ADR 0228，也没有 `external_memory_proposals` 表；它在任务 P5-3 的 PR 里，设计见 `/mnt/project-files/p5-3-pending-writes/integrated-plan.md`。本 ADR 把它当正在落地的依赖。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

总的做法：门只有一个（MCP）；读一个动作、推一个动作，对所有 agent 相同；什么时候读、什么时候推，按对方的能力分档去触发，不指望对方模型自觉；每个接入有一条主人建的记录。

1. **每个接入由主人在网页上建，得到一个带随机密钥的专属网址。**
   - 主人起名字、勾选对方有哪些能力。服务端只存密钥的摘要，按密钥认出是哪个接入，生成自己的接入编号。接入编号以字母或数字开头，之后只含字母、数字和 `._:-`，长度 1 到 128 个字符，能通过网关契约的 `machineString` 校验（`packages/gateway-contracts/src/validation.ts`）。日志、错误信息和决策记录只写接入编号，不写密钥，也不写带密钥的路径。
   - 密钥放在网址路径里，因为“填一个网址”是各家客户端都有的接法，自定义请求头不是每家都能填（[ADR 0227](0227-mcp-entry-checks-cloudflare-access-sign-in.md) 前提 2：Claude 应用的自定义连接器里，固定请求头 `static_headers` 还在内测，官方文档对它的说明是 “Beta, for a limited set of organizations”）。不放查询参数：它和路径一样会被沿途的日志记下，没有好处，只多一种要测的写法。
   - Cloudflare 的登录对带密钥的子路径不能照常工作时，能填请求头的客户端改放请求头；填不了请求头的客户端那时没有现成的接法，编码任务先停下报告，另出方案，不自行换做法。
   - 残余风险：密钥在路径里，会留在对方客户端的配置文件里，也可能被 Cloudflare 这类沿途设施的访问日志记下（没有核实 Cloudflare 记不记完整路径，按会记处理）。应对有三条：只有这把密钥进不了门，还要过 Cloudflare 登录或服务令牌；密钥可以在页面上随时撤销、换新；Himawari 自己的日志、错误信息、决策记录、指标和错误上报里不得出现密钥或带密钥的路径，有一条自动检查守着（见[后果](#consequences)）。
   - 权限和统计都挂在接入编号上：暂停、撤销（网址立刻失效）、换密钥（同一个接入换一把新的，旧的立刻失效，接入编号、设置和统计不变）、能读到哪一级、推来的要不要先问。
   - 对方自报的名字只在页面上当附注显示，标“自称”。不带密钥的网址不提供工具，只回一句提示，让主人去网页建一个接入。
   - 不写死客户端名单，不自动建记录。
   - 这把密钥用来分清是哪个接入、让暂停和撤销真的生效；它防不了主人自己电脑上已经拿到登录的恶意程序，那一层仍靠 Cloudflare 登录。
   - 改掉 ADR 0227 后果里“来源只能靠客户端自称”的现状，以及 ADR 0219 决定 5 里决策记录用 `mcp-client:<客户端名>` 当来源的写法。
   - 和 ADR 0227 决定 3 的关系：全局配置 `runPolicy.mcpRead.proposals` 仍然决定写工具出不出现；接入上的设置只能在它之内再收窄（某个接入能不能推、推来的要不要先问、能读到哪一级），不能放宽。
   - 理由：名字能自报，就不能当权限（前提 8）。
2. **读：新工具 `start_here`，`today_context` 保留。**
   - `start_here` 一次返回三段，固定的在前、会变的在后：主人概况和习惯（复用 `OwnerProfileService`，只取文字，不带内部编号）；规则摘要；今天的情况（和 `today_context` 同一个函数）。末尾一句固定文字，告诉对方学到关于主人的新东西用 `sync_memories` 推回来。
   - 每段有字数预算，超了按重要度截断，并写明还有几条没列出。概况沿用 `OwnerProfileService` 的 2000 字预算，并带一个内容摘要当版本号，方便对方判断变没变；规则摘要只列正在执行的主人规则，每条一句话。三段的键顺序固定。
   - `start_here` 和别的读工具一样写一条 `external_read` 决策记录。
   - 末尾那句“用 `sync_memories` 推回来”等 `sync_memories` 做出来时再加，不提前指向一个不存在的工具。
   - `today_context` 保留，给对话中途刷新“今天”用。
   - 在 ADR 0219 决定 3 的三个只读工具之外加一个。
3. **`find_memories` 加两个可选参数。** `project`：只搜某个项目的项目笔记（见决定 8）。`auto`：调用方是钩子时用，最多 3 条，相关度不够就返回空（也不带“没有找到记忆”这类提示文字），门槛沿用 [ADR 0221](0221-memory-retrieval-relevance-cutoff-and-same-source-dedupe.md) 已有的那个。两个参数在 MCP 这一层处理，不原样交给检索代码。
4. **每个接入有读取级别上限，新建的接入默认到 private。**
   - 四个读工具 `start_here`、`find_memories`、`today_context`、`rule_book` 走同一道检查。`today_context` 和 `start_here` 里“今天的情况”带的提醒正文、近两天的对话摘要也按这个上限过滤（前提 9）。主人可以在页面上把某个接入调高到 sensitive。
   - `start_here` 默认不带邮件规则的参数（免打扰时段、重要发件人）。
   - 依据：边界与可逆性，以及前提 6。内容给了别家就收不回来；编码 agent 用不上主人的健康、财务情况。
   - 改掉前提 9 的现状。Andy 2026-11-12 同意。
5. **服务带使用说明，同样的触发条件也写进每个工具的描述。** MCP 规范里使用说明是可选的，客户端不一定给模型看，工具描述更可靠。这些文字是固定的，登记进提示词目录，不含时间、名字这类会变的值。
6. **推：新工具 `sync_memories`，取代 `propose_memory` 和 ADR 0228 计划中的 `propose_memories`。**
   - 一批若干条。每条有对方自己的稳定编号（笔记文件路径之类的文字）、正文、种类（“关于主人”或“项目笔记”）、类别提示、项目名（可空）。稳定编号和项目名按普通文字存，有长度上限，统一成 NFC 写法；带控制字符或其他看不见的字符（零宽字符、改变文字方向的字符、不成对的代理项、行分隔符）的拒绝，字符集和 `apps/agent-service/src/production-mcp-memory-writer.ts` 里清洗正文用的 `INVISIBLE_FORMATTING` 相同。它们不进任何要求 `machineString` 的字段。
   - 对方的稳定编号只当业务键，存在“接入编号 + 项目 + 稳定编号”的唯一键表里，三样分三列存、联合唯一，不拼成一个字符串；记忆自己的编号由服务端生成（前提 10）。
   - 可以重复推：同编号同内容不产生任何东西；同编号新内容算更新，留历史版本。
   - 助手程序（决定 11）完整扫完记忆目录之后，附上“我这边现有的全部编号”，并在请求里写明这是完整名单。以前推过、这次不在完整名单里的，算对方删了。扫描超时、目录读不到或中途出错时，助手程序不附名单，这一次只推它读到的新增和改动；服务端没收到写明完整的名单，就什么都不算删除。
   - 名单和内容分开算上限。内容按批推；名单单独发，条数多时分几次发，带同一个同步编号，最后一次写明发完了。服务端收齐了才判断删除，没收齐的名单过期作废。
   - 完整名单也可能是错的：记忆目录被清空，或者设置指到了别的目录，照样能完整扫完。所以有两道刹车。助手程序在本地记下上次同步的是哪个目录（解析后的绝对路径），目录变了就不附名单，在统计里记一次“目录变了”，页面上提示主人。服务端这边，一次要算删除的条数超过这个接入在这个项目现有条数的一半，或者名单是空的而库里有东西，就一条都不自动处理，在待确认页面放一条“这个接入那边少了 N 条，要不要跟着处理”，主人点了才处理。“一半”是默认值，可以在设置里改，页面上显示。模型自己调用时不认这个名单，免得漏报被当成删除。服务端按进门的方式区分两者：助手程序用服务令牌加接入密钥进门，模型所在的客户端用 Cloudflare 的 OAuth 登录加接入密钥进门；只有前一种请求带的全量名单才用来判断删除。
   - 逐条返回结果：待确认、已存、没变、已更新、主人拒绝过、不合格（附原因）。超过上限整批拒绝，不写半批。
   - 一批在一个数据库事务里写完，连同它的决策记录。中途任何一步失败就整批回滚，只回工具错误，库里不留半批；对方原样重发不会重复（同编号同内容不产生任何东西）。
   - 主人在 Himawari 删掉或拒绝的，只在返回里告诉这个接入自己的那几条“主人已删除，不再接收”。不用命令口气要求对方删文件；Himawari 不动主人电脑上的任何文件。
   - 服务端只做校验、去重、敏感分级、加密，不调模型。
   - 取代 ADR 0225 决定 2（在客户端里确认）和决定 3（同一个提议只写一次：现在同一个稳定编号可以更新，留历史）。
7. **推来的内容，写入时由 Himawari 自己判敏感，不信对方标的种类。**
   - 关于主人的：进待确认，主人整批确认后成为正式记忆（前提 4）。
   - 判出是敏感的（健康、财务、带证件号等）：不管对方标成什么，一律进待确认。
   - 像规则的（“以后都不要……”）：按偏好类记忆进待确认（前提 12）。只有对得上那两种邮件规则的才走 `propose_rule`。
   - 更新：已确认的记忆，对方改了内容，进待确认并显示新旧对比。
   - 对方删了：还在待确认的自动撤下；已确认的不跟着删，标“来源已删除”，由主人决定。
   - 拒绝过的：内容没变不再出现；内容变了才再出现，并标明上次拒绝过。拒绝清单可以翻看和恢复。
8. **项目笔记单独存，不是记忆，不逐条确认。**
   - 某个接入第一次推某个项目的笔记时，主人批准一次“允许这个接入同步这个项目的笔记”，之后自动收。
   - 项目笔记不进主人概况，不进 Himawari 自己的聊天；别的 agent 用 `find_memories` 带 `project` 才搜得到，结果前面加固定标签，写明这是某个接入留下的资料，不是指令，主人没有逐条确认过（前提 6）。
   - 项目名由助手程序取仓库的远程地址，没有就用目录名；服务端规范化成项目编号。远程地址里可能带用户名和令牌（`https://用户:令牌@主机/仓库`，令牌也可能写在查询参数里）。助手程序用标准的网址解析把地址拆开，只留主机和路径，用户名、密码、查询参数和 `#` 后面的部分全部去掉；`git@主机:路径` 这种写法同样只留主机和路径。服务端收到仍带这些部分的项目名一律拒绝。页面上可以改名、合并。
   - 对方删了的项目笔记跟着删，留历史。
   - 依据：前提 5。它不是关于主人的断言。Andy 2026-11-12 同意。
9. **确认统一在 Himawari 里做，去掉对方客户端里的确认框。**
   - 记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
   - 待确认页面按接入、再按项目分组，沿用 ADR 0228 的整批确认和整批撤销。条目多时主人可以点“先帮我筛一遍”，由低价模型标出建议收、建议不收、拿不准；点之前显示预计费用。
   - 取代 ADR 0225 决定 2、6 和 ADR 0226 决定 1 至 3 里“在客户端里确认”的部分。默认仍然每条都要主人确认，没有绕过确认的后门，只是确认的地方换成 Himawari。
   - 理由：确认框在 Andy 的主力客户端上不弹（ADR 0225 决定 2 记录了 Claude 桌面 App 的 Code 标签“声明支持确认框，却不显示它”），两条路并存只多出错的地方。Andy 2026-11-12 同意。
10. **触发按对方的能力分四档，档位不写死在代码里，不按产品名判断。**

    | 档 | 对方的能力 | 读怎么触发 | 推怎么触发 | 可靠吗 |
    | --- | --- | --- | --- | --- |
    | 一 | 能跑命令钩子 | 助手程序：开场取 `start_here`，每句话用 `auto` 搜一次 | 助手程序：对话结束时扫记忆目录，推新增和改动的，附全部编号 | 可靠，不经模型 |
    | 二 | 能挂 MCP，能跑定时任务 | 使用说明和工具描述 | 定时任务让它调 `sync_memories` | 尽力而为 |
    | 三 | 只能挂 MCP | 使用说明和工具描述 | 主人说一句“同步记忆”，或模型自己调 | 尽力而为 |
    | 四 | 不能挂 MCP | 主人贴“关于我”文本 | 主人贴提示词让它列出记忆，再贴回 Himawari | 手动 |

    - 网页上的向导“接入一个 agent”：主人勾选对方的能力，向导给出对应的步骤和要复制的内容，并实时显示是否已收到第一次读取、第一次同步。各家的具体步骤是一份数据，加一家不改代码。
    - 第二、三档仍然靠对方模型自觉，产品里如实标为“尽力而为”。
11. **第一档用一个装在主人电脑上的助手程序。**
    - 它是一个被钩子调用的小命令行程序。Claude Code 和 Codex 的钩子事件同名（前提 13、14），共用一个程序，只是配置不同。
    - 它直接读对方的记忆目录，在本地记下每个文件上次推送时的摘要，只推有变化的。它只读不写：不改、不删主人电脑上的任何文件。目录位置从对方的设置里读，不写死路径（前提 15）。
    - 凭据：Cloudflare 服务令牌过第一道门，接入密钥定身份，照 ADR 0162 的先例（前提 17）。
    - 每次调用限时很短，超时就放行，不拖慢主人打字；失败记在本地日志和 Himawari 的统计里。
    - Claude Code 做成一个插件，一次安装带上 MCP 连接、钩子和助手程序。
    - Himawari 的 Mac 客户端（[ADR 0229](0229-native-apple-clients-and-device-api.md)）做出来之后，助手程序的活并进去，凭据换成设备密钥。
    - 不用 `mcp_tool` 钩子做推送，因为它读不了文件（前提 13）。Andy 2026-11-12 同意在他的 Mac 上放这个程序。
12. **存量搬家。** 第一档的 agent 第一次同步就是全量，不需要单独搬家。其他的在向导里：给一段提示词让对方列出记住的内容，主人贴回 Himawari，用低价模型解析，开始前显示预计费用，结果进同一个待确认页面。不能挂 MCP 的 agent，网页生成一段“关于我”文本，主人勾选包含哪几类、预览后贴进对方的自定义指令。
13. **“接入的 agent”页面和周报显示每个接入的用量。**
    - 每个接入：读了几次（按工具）、空手而归几次、自动搜了几次其中有内容几次、推来几条（待确认、已存、被拒、项目笔记）、自动和模型调用各几次、失败几次、最近一次的时间。
    - 周报加同样的一节，和网页用同一套统计函数（[ADR 0155](0155-decision-record-observation-and-weekly-report-page.md)）。
    - 读取的用量数字存在一张单独的按天统计表里，键是“接入 + 天 + 工具 + 触发方式”（触发方式分助手程序自动调用和模型调用两种，按进门的方式认，同决定 6），记调用次数、空手而归次数、有内容次数、失败次数；同一个键只累加，不新增行。推来几条和各自的结果从业务键表和待确认表算；最近一次的时间记在接入记录上。每个数字从哪里算，在编码任务里逐个写明定义。
    - 不用决策记录存汇总：决策记录一条对应一次决定，编号是随机的，写入后不改（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts` 里是 `ON CONFLICT (id) DO NOTHING`）；它的输入里的数字字段（例如 `packages/application/src/ports/decision-ledger.ts` 的 `DecisionInputs.relatedStats`）记的都是那一次决定自己的数，没有按接入、按天累加的地方。
    - 每句话自动搜（`auto`）的读取：空手而归的只在统计表里计数，不写决策记录；交出了内容的仍然每次写一条 `external_read` 决策记录，和别的读取一样。改掉 ADR 0219 决定 5 里“每次外部读取都写一条”对空手而归的自动搜的要求。理由：决策记录记的是给了外部什么；什么都没给的自动搜一天可能上百次，逐条写只会把真正给出内容的记录淹掉。
    - 某个接入建好后 7 天没有任何读取，在每日回顾里提示一次；7 天可在设置里改。
    - 每个上限（单条长度、批量条数、请求体大小、`start_here` 字数、钩子读取频率、接入个数）都在页面上显示当前用量。钩子读取用单独的频率额度。每个上限的数值在对应的编码任务里按主人真实的笔记文件和实测定，本 ADR 不写具体数；没有上限的入口不得合并，超限被拒的用例是那个任务的完成条件。
14. **对外遮盖不改，所有列表固定排序。** 遮盖沿用 ADR 0219 决定 4：一次返回里的全部文字一起遮，后面一段点名的密码或验证码，在前面一段单独出现时也会被遮。提醒、摘要、逐条结果、“主人已删除”的编号这些列表都有固定顺序。
    - 方案原先打算改成“按字段各自遮”，理由是“占位编号随前面内容变化”。这个理由核对代码后不成立：`maskSensitiveTexts` 输出前把占位符里的序号去掉了，现有测试断言同一段文字不受同批无关内容影响（`packages/sensitive-capture/test/redaction.unit.test.ts`：`expect(withOthers[1]).toBe(alone[0]);`）。各段分开遮反而会漏掉“后面才点名、前面单独出现”的值，所以不改。那条现有测试守不住“改成各段分开遮”这种改法（各段分开遮时它照样通过）；守住它的是[后果](#consequences)里 `start_here` 那条用例，在读的一侧的编码任务里补上。
15. **规则带到别的 agent 那里只是文字要求。** `start_here` 和页面上都写明：这些在 Himawari 里必定执行，在别的 agent 里做不到必定执行。
16. **多人。** 所有东西都在每个人自己的库里。主机名和入口是同一个（前提 18），各个接入只是路径里的密钥不同。走 OAuth 登录的请求，服务端先按登录的人找到库，再在这个库里认接入密钥，密钥不属于这个人就拒绝。助手程序走服务令牌，没有登录的人，所以共用层要有一张“接入密钥的摘要对应哪个人”的索引表，只放摘要和人，不含私人内容，做法和 [ADR 0229](0229-native-apple-clients-and-device-api.md) 的设备索引表一样。
    - 本人库里的接入记录说了算，索引只用来找到是哪个人。新建、暂停、撤销都先写本人库，再写索引。
    - 服务令牌的请求要同时满足两条才放行：索引里找得到这把密钥的摘要；那个人库里有这条接入记录，而且没有暂停、没有撤销。任何一边对不上就拒绝，宁可拒绝，不放行。所以撤销后索引没删干净、或者建到一半只写了本人库，结果都是这条路进不来，不会进到别人的库。
    - 只建了一半的接入在页面上显示“助手程序这条路还没建好”，可以重试或删掉。
    - 本人库写失败，这次操作就算失败，页面如实报错，不写索引。本人库写成了、索引没写成，暂停和撤销已经生效（本人库说了算），索引稍后重试，页面上标“索引还没同步”。

**这次不做的：** 对话历史压缩包的导入（要用 Himawari 的模型逐段抽取，和前提 2 的理由一样贵）；让项目笔记进 Himawari 自己的聊天（要改它自己的检索工具的参数，会让每个老对话的请求开头换新一次，要做另出方案）；在对方执行工具之前来问 Himawari 的规则检查（现在没有管工具调用的规则）。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- **Claude、ChatGPT、Gemini：** 记忆只给自家用。对外只有一次性的导入：复制一段提示词到别家，把结果贴回来。来源 <https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude>：“Memory imports are experimental and still in active development”。没有一家做“别家持续来读、持续来存”。
- **mem0：** MCP 当通用入口，再给每类客户端做钩子插件。它的 Codex 接入文档写明完整版用钩子，只挂 MCP 的简版读写全靠模型自己调用。来源 <https://docs.mem0.ai/integrations/codex.md>。
- **Supermemory：** 同样是 MCP 加钩子插件。它的博客（厂商自述，只作旁证）写：“the model may not call a tool on its own”“The plugins hook into the agent instead, so nothing waits on the model's judgment.”来源 <https://supermemory.ai/blog/how-to-make-your-mcp-clients-share-context-with-supermemory-mcp.md>。
- **我们为什么这样做：** “MCP 加钩子助手”是唯一同时满足“通用”（前提 3）和“不靠模型自觉”的组合。和 mem0 不同的是，我们不采集对话原文（前提 2），只同步对方已经记好的笔记。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **把别家的原始对话送到 Himawari，由 Himawari 的模型抽取记忆。** 编码对话动辄十万 token，贵（前提 2）。
- **只挂 MCP，靠使用说明让对方模型自觉。** 不可靠（前提 7 和业界做法）；它只作为第二、三档的做法，并如实标为尽力而为。
- **每家 agent 写一个专用对接。** 等于写死名单，新 agent 出来就要改代码（前提 3）。
- **用对方自报的名字建记录、当权限。** 换个名字就能绕过暂停和撤销（前提 8）；自动建记录还会被随机名字刷出无数条。
- **用 `mcp_tool` 钩子做推送。** 它不能读文件，只能拿到一次写入的片段，对话结束时的全量同步做不了（前提 13）。它只适合“把这句话交给检索”这类不读文件的事。
- **项目笔记和关于主人的记忆一样逐条确认。** 一个仓库就有几十个笔记文件，每次改动都要主人点，超出确认预算（前提 5）。
- **项目笔记不经任何批准直接存、直接给别的 agent。** 对方把敏感内容标成项目笔记就能绕过确认，还会传到别的 agent（前提 6）。所以写入时同步判敏感，并要主人按“接入 + 项目”批准一次。
- **像规则的内容转进 `propose_rule`。** 外部只能提两种邮件规则，行为偏好放不下（前提 12）。
- **删掉 `today_context`，并进 `start_here`。** 对话中途刷新“今天”就得把概况再拿一遍，现有的统计口径也会断。
- **拒绝过的条目过一段冷却期后重新出现。** 到期再问一遍是多余打扰；改成内容变了才再出现。
- **让对方 agent 按 Himawari 的返回自动删它自己的笔记。** 这是在主人电脑上的不可撤销操作，编号对错了会误删。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- **实施前，代码仍按原来的 ADR。** 本 ADR 只记决定，没有改代码。实施分成几个编码任务，清单在 `/mnt/project-files/p5-memory-hub/coding-tasks.md`：读的一侧（决定 2、3、5、14；读取上限在决定 4 的任务里统一接到四个读工具上）；接入记录、读取上限和统计（决定 1、4、13，改表）；`sync_memories`、项目笔记和待确认页面（决定 6 至 9，改表，依赖 ADR 0228 的待确认表）；助手程序、插件和向导（决定 10、11）；存量搬家（决定 12）。每个任务合并时在被改的 ADR 上补注。进度：读的一侧已由 PR 413 合并（2026-11-12），做了 `start_here`、服务使用说明和 `find_memories` 的 `auto`；`start_here` 已按读取上限过滤，另外三个读工具的上限和 `project` 参数还没做。
- **对发给模型的请求：** Himawari 自己发给模型的请求不变。新工具只注册在对外的 MCP 服务上；待确认的内容和项目笔记不进 Himawari 自己的任何请求；确认后的记忆和网页新建的记忆走同一条路；复用 `OwnerProfileService` 时不改它。外部 agent 那边，工具清单会变一次。新登记进提示词目录的使用说明和工具描述只用在对外的 MCP 服务上，不得进入 Himawari 自己的系统提示和工具定义；带这些改动的编码 PR 照常要过 `npm run check:prompt-prefix`。“先筛一遍”和“解析贴回的文本”是两处新的后台模型调用，固定指令在前、数据在后，只用低价模型。
- **要补的自动检查**（`npm run check:prompt-prefix` 只管 Himawari 自己的请求，管不到 MCP 这一侧）。每条带反向用例：
  - 新增一步 `npm run check`：稳定编号（含路径、空格、中文、比 128 个字符长但没超过上限的）、种类、类别、项目名，从推送端走到存储和读取端都通过；把服务端生成编号换成直接用对方的编号，必须失败。
  - 同编号同内容不新增，新内容出新版本，重试不重复。
  - 删除只认助手程序的全量名单：走 OAuth 登录的请求带上全量名单，什么都不删；已确认的不跟着删。
  - 写到一半数据库出错，整批回滚，库里没有半批；原样重发不重复。
  - 甲接入读不到乙接入的范围，收不到乙的“主人已删除”；暂停或撤销后立刻被拒。
  - 对方把健康、财务内容标成项目笔记，仍然进待确认；读取上限以下的接入读不到上限以上的内容，四个读工具各一条；其中 `today_context` 和 `start_here` 要分别覆盖提醒正文和对话摘要。
  - 不带 `project` 时，项目笔记不出现在概况、Himawari 自己的聊天、Gmail 检查里。
  - 超批量、超请求体、超长，整批拒绝且库里没有半批。
  - 同一份数据生成两次 `start_here`，字节相同；`find_memories`、`rule_book`、`sync_memories` 的逐条结果和统计页面，同样的数据每次顺序相同。
  - 验证码只在“今天的情况”里被点名、同一个值在概况里单独出现，`start_here` 的输出里两处都被遮；把遮盖换成各段分开遮，这条用例必须失败。
  - 稳定编号或项目名超过上限、带控制字符、零宽字符、改变文字方向的字符、不成对的代理项、行分隔符（U+2028、U+2029），项目名带用户名、密码、令牌、查询参数或 `#` 后面的部分，都被拒绝。
  - 接入编号：生成出来的都能通过 `machineString`；129 个字符的、以符号开头的、空的编号被拒绝。
  - 不同的“接入 + 项目 + 稳定编号”组合不会撞成同一个键，用项目名和稳定编号里带分隔符的用例验证。
  - 记忆目录清空或设置指到别的目录之后同步：库里什么都不自动删，待确认页面出现一条“少了 N 条”；要删的没到门槛时照常处理。
  - 名单分几次发，没收齐时不判断删除；条数接近上限的目录能完成一次全量同步。
  - 换密钥后旧密钥立刻被拒；本人库写成、索引没写成时，暂停照样生效。
  - 助手程序扫描超时或只扫了一半：请求不带完整名单，库里什么都不删，待确认的也不撤下。
  - 索引里有、本人库里没有（或已暂停、已撤销）的密钥，服务令牌这条路被拒绝；本人库里有、索引里没有的也被拒绝。
  - 拿一把已知的密钥把各种成功和失败的请求跑一遍，Himawari 的日志、错误信息、决策记录、指标和错误上报里搜不到这把密钥；故意在一处错误信息里带上请求路径，这条用例必须失败。
  - 空手而归的自动搜不写决策记录、统计表里计数加一；有内容的自动搜写一条决策记录。
  - 页面和周报的每个数字各有一条正向、一条反向用例。
- **真实客户端的验收按档位分。** 第一档要求全程没有人工操作，页面上出现自动读取和自动同步；其余档位由主人手动验证一次。
- **动工前要实测的**（不影响决定，影响具体做法）：
  - Cloudflare 的 OAuth 登录对带密钥的子路径是否照常工作；不行时按决定 1 处理（能填请求头的换请求头，其余先停下报告）。
  - Cloudflare 的访问日志记不记完整路径；记的话在页面上提示主人定期换密钥。
  - Claude 桌面 App 里的 Claude Code 是否执行用户级钩子和插件；它的笔记是否都落在记忆目录。
  - Codex 的钩子里跑命令行程序有什么限制；`memories.disable_on_external_context` 会不会让用过 MCP 工具的对话不产生记忆，会的话 Codex 这一档要重想。
  - 云端会话（在 claude.ai 云端跑的 Claude Code）的笔记不在主人电脑上，先按第三档接。
- **要 Andy 亲手做的：** 在 Cloudflare 后台建一个服务令牌；在 Mac 上装插件。
- **安全上多出来的东西：** 一个不经浏览器登录的程序入口（服务令牌加接入密钥），和主人电脑上的一份凭据。凭据可以在页面上随时撤销；助手程序只能调用 MCP 入口上这个接入被允许的工具。
- **原任务 P5-4（外部读取统计进周报）** 并进决定 13。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0219：对外只读 MCP 入口，静态令牌鉴权](0219-read-only-mcp-entry-with-static-token.md)
- [ADR 0225：外部 agent 提议新记忆，主人在客户端确认后才保存](0225-external-agents-propose-memory-with-in-client-confirmation.md)
- [ADR 0226：外部 agent 提议新规则，主人在客户端确认后按规则提议流程生效](0226-external-agents-propose-rules-through-the-rule-proposal-flow.md)
- [ADR 0227：对外 MCP 入口改为校验 Cloudflare Access 登录凭证](0227-mcp-entry-checks-cloudflare-access-sign-in.md)
- [ADR 0162：用服务令牌和应用密钥接收 Muse 数据](0162-receive-muse-data-through-a-service-token-and-an-app-secret.md)
- [ADR 0155：决策记录观察期与校准周报网页](0155-decision-record-observation-and-weekly-report-page.md)
- [ADR 0221：记忆检索的相关度门槛](0221-memory-retrieval-relevance-cutoff-and-same-source-dedupe.md)
- [ADR 0229：原生苹果客户端和设备接口](0229-native-apple-clients-and-device-api.md)
- [ADR 0234：每个人一个程序、一个数据库文件](0234-one-program-per-person-database-file.md)
- 产品愿景 `docs/product-vision.md` 的原则 1、2、5
- 两个模型的讨论记录：`.agents/reviews/topic-p5-memory-hub/`

[返回阅读导航](#contents)
