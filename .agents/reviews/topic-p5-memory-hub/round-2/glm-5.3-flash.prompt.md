你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 074ee342f78805edd45077185ca7e252db711a03。
待审核的方案：
# P5 记忆中心总方案（线程版，供两个模型审核）

核对的代码：main 074ee342。本文是线程自己的方案；两个模型独立出的方案在 `.agents/reviews/topic-p5-memory-hub/round-1/`，线程写本文时没有看。

## 一、前提（附来源和原话）

1. 主人要的是「记忆中心」：别的 agent 产生的记忆能主动存进来；换任何 agent 都能来读记忆、规则、习惯。来源：主人 2026-11-11 在本线程的原话（见问题材料第一节）。愿景 `docs/product-vision.md:61`：“它们通过 Himawari 认识我，而不是各自记住我。”
2. 只挂 MCP 时，读和存取决于对方模型愿不愿意调用工具。来源：<https://supermemory.ai/blog/how-to-make-your-mcp-clients-share-context-with-supermemory-mcp.md>：“With MCP, say it plainly when something matters …, because the model may not call a tool on its own.”；“The plugins hook into the agent instead, so nothing waits on the model's judgment.”
3. Himawari 现在的读写都靠对方模型调用：`apps/agent-service/src/production-mcp-read.ts:94-95`（`MCP_READ_TOOL_NAMES = ["find_memories", "today_context", "rule_book"]`、`MCP_WRITE_TOOL_NAMES = ["propose_memory", "propose_rule"]`）；创建服务时没有使用说明（同文件约 400 行 `new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { requestState…, inputRequired… })`）。
4. Claude Code 的钩子可以直接调用已连接的 MCP 服务上的工具，不需要另外的凭据。来源：<https://code.claude.com/docs/en/hooks>：“`mcp_tool`: call a tool on a configured MCP server. The tool's text output is treated like command-hook stdout”；“The hook never starts an OAuth flow, so authenticate the server from `/mcp` first”；启动时的 SessionStart 早于 MCP 服务可用，mcp_tool 钩子被跳过；UserPromptSubmit 的输出会进模型上下文（“Claude Code adds plain-text stdout as context that Claude can see and act on”）。
5. Claude Code 自己会记笔记，存成磁盘文件，按仓库分。来源：<https://code.claude.com/docs/en/memory>：“Each project gets its own memory directory at `~/.claude/projects/<project>/memory/`”；“notes Claude writes itself based on your corrections and preferences”。Codex 的在 `~/.codex/memories/`（<https://developers.openai.com/codex/memories>）。
6. 主人不要把别家的原始对话送到 Himawari 再抽取，理由是耗 token；要对方产生记忆再推过来。来源：主人 2026-11-12 00:02 JST 本线程原话：“为什么不在……Claude Code 里面直接把产生的记忆推过来”。
7. 主人定过：推来的记忆先让他确认再存。来源：`/mnt/project-files/p5-3-pending-writes/integrated-plan.md` 前提 1 引的原话：“推过来的记忆先让我确认，我觉得 OK 了，再存到我们自己的记忆里面去”。同一方案已定待确认表、批量工具 `propose_memories`、稳定键、整批确认可撤销。
8. Himawari 已有「主人概况」的生成代码，MCP 入口没用它。来源：`packages/application/src/services/owner-profile-service.ts:14`（`OWNER_PROFILE_CHARACTER_BUDGET = 2000`），块种类 `owner-rules`、`owner-profile`、`owner-agenda`（同文件 33 行）。
9. 大厂的记忆搬家都是一次性、只进不出。来源：<https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude>：“Memory imports are experimental and still in active development”；Gemini 另可导入对话历史压缩包（<https://support.google.com/gemini/answer/16868299>）。
10. 认证是 Cloudflare 的 OAuth 登录，所有客户端凭证主体相同，客户端名只能自报。来源：`docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:115`：“来源只能靠客户端自称”。

## 二、对标和根因

- ChatGPT、Claude 怎么做：它们的记忆只给自家用；对外只提供一次性搬进来。用户看到的是一个「导入记忆」页面：复制提示词、贴回结果。没有一家做「别家持续来读、持续来存」。专做这件事的 mem0、Supermemory 的做法是：MCP 当通用入口，再给每类客户端做钩子插件，让读和存不依赖模型判断。
- 根因：P5 把「入口」做了，没做「触发」。入口谁都能连，但没有任何机制保证对方在该读的时候读、该推的时候推。补触发是治根；只写一份接入步骤、指望模型自觉是表面。

## 三、方案

一句话：**门只有一个（MCP）；读一个动作、推一个动作，对所有 agent 相同；触发方式按 agent 的能力分档；每个接入的 agent 在 Himawari 里有一条记录，能看、能限、能停。**

### 1. 接入：一个门，加一张「接入的 agent」表

- 入口仍是 `/api/mcp/v1` 加 OAuth。新 agent 只要支持 MCP，填网址就能连，Himawari 不改代码。
- 新增「接入的 agent」记录：某个客户端第一次成功调用时自动建一条（名字用它自报的，标「自称」），不写死名单。主人可以改名、暂停、撤销，设置它能读什么、能不能推、推来的要不要先问。
- 每次调用带一个「触发来源」标记：钩子、定时、模型自己、手动。由调用方在参数里声明，用来统计，不用来做权限判断。

### 2. 读：一个「先看这个」的工具

- 新工具（暂名 `start_here`）：一次返回主人概况（复用 `OwnerProfileService`）、规则摘要、今天的情况（现在 `today_context` 的内容），以及一段固定文字说明「学到关于主人的新东西，用同步工具推回来」。
- `today_context` 并进它，不再单独保留。`find_memories` 保留做中途深挖；`rule_book` 保留给要完整规则的场景。现在没有任何客户端连过，改工具清单没有兼容负担。
- 服务带使用说明：最重要的内容放在前 512 个字符（「这是主人的记忆中心；开场先调 `start_here`；学到新东西调同步工具」）。工具描述也写成触发条件。
- 有钩子的 agent 另加「每句话自动搜一次」：钩子把主人这句话发给 `find_memories` 的一个变体，相关度够才返回内容，不够就返回空，不往对方上下文里塞无关的东西。相关度门槛沿用聊天检索的那一个（ADR 0221），不新设数值。向量在本机算，不花模型 token。
- 不能挂 MCP 的 agent：网页上生成一段「关于我」的文本（同一份概况加规则），主人贴进对方的自定义指令；文本带生成日期。

### 3. 推：一个「同步记忆」的工具

- 新工具（暂名 `sync_memories`）取代 `propose_memory` 和计划中的 `propose_memories`：
  - 一次发一批，每条带对方自己的稳定编号（例如笔记文件路径）、正文、类别提示（关于主人 / 项目知识 / 像一条规则）、项目名（可空）。
  - 可重复发送：同编号同内容不产生新东西；同编号新内容算更新，留历史版本；可以声明「这一批是我这边的全部」，Himawari 据此发现对方删了哪些。
  - 返回里带「主人已经在 Himawari 删掉或拒绝的编号」，并用一句固定文字请对方从自己的记忆里也删掉。
- 记忆由对方 agent 产生，Himawari 不收原始对话（前提 6）。服务端只做校验、去重、敏感分级、加密，不调模型，保证快。
- 三种内容三个去处：
  - 关于主人的：进待确认，主人整批确认后成为正式记忆（前提 7 的规矩不变）。
  - 项目知识：单独存成「项目笔记」，按项目和来源 agent 归档，不进主人概况，`find_memories` 带项目范围时才搜得到。不需要主人逐条确认，因为它不是关于主人的断言，只是对方工作笔记的一份镜像。价值在于换 agent 时项目知识跟着走（下个月换 Codex，同一个仓库的笔记它读得到）。
  - 像规则的（「以后都不要……」）：不当记忆存，转进现有的规则提议流程（ADR 0226）。
- 类别提示由对方给，Himawari 不盲信：每天的后台整理（已有的「做梦」任务）用低价模型抽查分错类的，改判的记一条决策记录。条目很短，费用在方案评审时估算并显示。
- 「接入的 agent」记录上有一个开关：这个 agent 推来的关于主人的记忆「先问我」（默认）或「直接存，可整批撤销」。默认照主人定的规矩；他信得过哪个 agent 可以自己放开。
- 去掉客户端里的确认框这条路（只针对记忆；规则提议保留）。理由：所有客户端都能走待确认，确认框在主人的主力客户端上还有不弹的 bug，两条路并存只增加出错的地方。

### 4. 触发：按能力分四档

| 档 | agent 的能力 | 读怎么触发 | 推怎么触发 |
| --- | --- | --- | --- |
| 一 | 有钩子，且钩子能调 MCP 工具 | 第一句话时钩子调 `start_here`，之后每句话钩子搜一次 | 对方写自己的记忆文件时，钩子把这次写入的内容交给 `sync_memories`；对话结束时再发一次全量 |
| 二 | 能挂 MCP，能跑定时任务 | 使用说明加固定指令 | 定时任务调 `sync_memories` 发全量 |
| 三 | 只能挂 MCP | 使用说明加固定指令 | 主人说一句「同步记忆」，或模型自己调 |
| 四 | 不能挂 MCP | 主人贴「关于我」文本 | 主人贴提示词让它吐出来，再贴回 Himawari |

- 档位不写死在代码里，也不按产品名判断。Himawari 网页上有一个「接入一个 agent」的向导：主人选对方有哪些能力，向导给出对应的步骤和要复制的内容，并在页面上实时显示「已收到它的第一次读取」「已收到它的第一次同步」。
- 第一档做成可安装的包：Claude Code 做一个插件，里面带 MCP 连接和钩子，装一次就全有。Codex 做对应的一份。两家钩子事件同名，逻辑共用。
- Himawari 的 Mac 客户端做出来之后（ADR 0229），加一个能力：直接监视本机已知 agent 的记忆目录并同步。它覆盖「有记忆文件但没有钩子」的 agent，也用来一次性搬存量。

### 5. 存量搬家

向导里的「从别的 AI 搬过来」：
- 对话类产品：给一段提示词让对方把记住的全列出来，主人贴回 Himawari。解析用模型做，不用现在的关键词正则；开始前显示预计费用。结果进同一个待确认页面。
- 有记忆文件的：直接读文件（Claude Code、Codex 的目录），走 `sync_memories` 同一条路。
- 对话历史压缩包：可以导入，但这一步要用 Himawari 的模型逐段抽取，费用可能高。先显示预计 token 和费用，主人点了才跑。

### 6. 规则

- 所有档位：`start_here` 里带规则摘要，写明「这些是主人的硬性要求」。这在别的 agent 里只是文字要求，做不到必定执行，页面上如实标明。
- 第一档：预留一个钩子位置，在对方执行工具之前调 Himawari 的规则检查。等规则手册里有了管「工具调用」的规则再启用（此前评估过，现有规则都挂在邮件上，带过去没东西可管）。

### 7. 度量

- 「接入的 agent」页面上每个 agent 显示：读了几次（按工具）、空手而归几次、推来几条（待确认 / 已存 / 被拒 / 项目笔记）、按触发来源各几次、最近一次是什么时候、失败几次。
- 周报加同样的一节。
- 某个 agent 连上之后 7 天没有任何读取，在每日回顾里提示一次「挂上了但没在用」。7 天是观察窗口，可在设置里改。

### 8. 范围和遗忘

- 每个 agent 能读的范围可设：记忆类别和敏感级别上限。默认沿用现在的遮盖（敏感内容对外遮盖）。
- 主人在 Himawari 删掉一条从外面来的记忆：下次同步的返回里告诉对方（见第 3 小节）。Himawari 不去动主人电脑上的文件。
- 对方删了一条：Himawari 里已经确认过的不跟着删，标「来源已删除」，由主人决定。Himawari 是主人的事实源，不是对方的镜像。

### 9. 多人

所有东西都在每个人自己的库里。插件和向导里的网址是每个人自己的入口。

### 10. 对现有 P5 的处置

- 保留：MCP 入口、OAuth、`find_memories`、`rule_book`、`propose_rule`、读取的决策记录、待确认表和整批确认页面（P5-3 PR A 的设计）。
- 改：加 `start_here` 和使用说明；`propose_memory`、`propose_memories` 合成 `sync_memories`（加更新、删除、类别、项目、触发来源）；待确认页面按 agent 和类别分组；新增「接入的 agent」记录和页面；P5-4 的统计并进这个页面和周报。
- 去掉：`today_context`（并进 `start_here`）；记忆的客户端确认框。

### 11. 顺序（按依赖，不按工作量）

1. 读取入口上线，待确认表落地（已在排队）。
2. Himawari 这一侧的通用部分：`start_here`、使用说明、`sync_memories`、「接入的 agent」记录、范围、统计。
3. 第一档的安装包和接入向导。
4. 存量搬家。
5. 其余三档的向导内容；Mac 客户端的目录同步。

验收：主人日常用一周，「接入的 agent」页面上至少两个 agent 有读取记录和同步记录（承接原 P5-4 的完成标准）。

## 四、对发给模型的请求

Himawari 自己发给模型的内容不变。待确认和项目笔记不进任何 Himawari 自己的请求开头；确认后的记忆和网页新建的记忆走同一条路。`start_here` 的返回是发给外部客户端的，不属于 Himawari 的模型请求。后台抽查分类是独立的后台调用，固定指令在前、数据在后。

## 五、要主人定的

1. 项目知识单独存成「项目笔记」，不用逐条确认。同意吗？
2. 每个 agent 一个「先问我 / 直接存」的开关，默认先问。同意吗？
3. 去掉记忆的客户端确认框，统一走 Himawari 里的待确认。同意吗？
4. 对话历史压缩包导入做不做（要花模型的钱，跑之前会显示预计费用）。

## 六、没核实的

- Codex 的钩子能不能直接调 MCP 工具；不能的话它的钩子脚本要另带凭据。
- ChatGPT 个人版能不能加自定义 MCP。
- 各客户端是否把服务的使用说明放进模型上下文。
- claude.ai 云端会话里钩子和连接器的行为。
- Claude Code 写记忆文件是否都经过 Write、Edit 工具（决定「写入时钩子」抓不抓得全）。
