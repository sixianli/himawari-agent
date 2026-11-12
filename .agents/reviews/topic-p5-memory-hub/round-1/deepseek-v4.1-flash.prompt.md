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
仓库就是当前目录，已检出 074ee342f78805edd45077185ca7e252db711a03。
问题、目标和约束：
# 问题材料：让 Himawari 成为主人所有 AI agent 共用的「记忆中心」

## 一、问题

主人（Andy）同时用好几个 AI agent：Claude Code、Claude 应用、Meta 的 Muse，以后可能换成 Codex、ChatGPT、Grok 或还没出现的产品。每一家都在自己那里记他，记忆分散在各处；换一家就要从头教一遍。

主人的原话（2026-11-11）：

> 我希望 Himawari 能把我的记忆全部聚在一起。……如果把 Himawari 作为我的记忆数据仓库，也就是一个「记忆中心」：1. 其他 AI agent 产生的记忆都能主动存到 Himawari 里面；2. 以后无论换哪一个 AI agent，只要 Himawari 提供一个读或搜记忆的服务，任何 AI agent 都能通过该服务来记忆中心获取我的记忆、规则或各种使用习惯。

> 有没有一种最好的办法，让所有的 AI agent 都能很方便地接入我们的记忆？推记忆过来，然后读记忆出去。

愿景原则 5（`docs/product-vision.md` 第 61 行）：“其他 Agent（Claude Code、Codex 等编码或办公 Agent）是我的工具，也是 Himawari 的消费者：它们通过 Himawari 认识我，而不是各自记住我。”

## 二、目标

请设计「记忆中心」的整体方案，至少回答：

1. 接入：所有 agent（包括以后才出现的）用什么方式接进来最好？接一个新 agent 时，Himawari 这边最好不用改代码。
2. 读：怎样让各种 agent 真的在需要的时候读到主人的记忆、规则、今天的情况，而不是工具挂上了却没人调用？读的接口应该长什么样？
3. 推：怎样让各种 agent 产生的记忆真的进到 Himawari？谁来产生记忆、什么时候推、推什么（记忆条目还是原始对话）、对方后来改了或删了怎么办？
4. 信任和确认：别的 agent 推来的内容怎么把关？量大时（一个编码 agent 可能有几百条项目笔记）主人怎么确认才不累？「关于主人的事」和「某个项目的技术知识」要不要分开？几家说法冲突怎么办？
5. 存量：各家已经记下的记忆、已有的对话历史，怎么搬进来？
6. 规则：主人定的规则在 Himawari 里是硬性设定（写进程序、必定执行）。到了别的 agent 里怎么办？
7. 度量：怎么知道每个 agent 实际读了没有、推了没有？
8. 接不了通用接口的 agent 怎么办？
9. 遗忘和范围：主人在 Himawari 里删掉一条记忆，别的 agent 那里怎么办？哪些记忆可以给哪个 agent 看？
10. 现有的 P5 实现（见第四节）哪些保留、哪些要改、哪些该去掉？

## 三、约束

- 主人的数据由主人自持；Himawari 只跑在主人控制的一台生产服务器上，不另租机器，不在 GitHub 上花钱。
- 花钱敏感：模型调用只用低价模型或套餐内额度。主人对「把别的 agent 里的原始对话全部送到 Himawari 再抽取记忆」明确担心 token 消耗，他的倾向是「记忆在对方 agent 那里产生，再推过来」。这是主人的倾向，不是定论，你认为有更好的办法可以直说。
- 主人 2026-11-11 给另一块任务定过的标准：不支持确认框的客户端推来的记忆「先让我确认，我觉得 OK 了，再存到我们自己的记忆里面去」。同样，如果你认为量大时这条需要调整，请说明怎么调整、风险是什么。
- 不要顾虑开发量和工期；方案往效果最好的方向想，做成可撤销、有记录即可。
- 不许写死：客户端名单、选项、阈值，能动态获取的一律动态。
- Himawari 最终要给不会用 AI 编程工具的人用，接入步骤要能在产品里引导完成。
- 以后会有多个人各用各的 Himawari（每人一个程序、一个数据库文件，ADR 0234）。
- Himawari 自己发给模型的内容只能在末尾追加，不能改动已发出的开头（`.claude/rules/prompt-prefix.md`）。
- 规则是硬性设定，不是记忆，不得把规则当记忆条目存。

## 四、Himawari 现状（已对着 main 074ee342 的代码核对）

- 已有一个对外的 MCP 入口 `/api/mcp/v1`（`apps/agent-service/src/production-mcp-read.ts`），认证是 Cloudflare Access 的 OAuth 登录（ADR 0227）。还没上线，没有任何客户端真的连过。
- 读：三个只读工具 `find_memories`（按问题搜记忆）、`today_context`（今天日期、提醒、昨天今天的对话摘要）、`rule_book`（规则清单）。全靠对方模型主动调用。没有「关于主人的概况」这类一次给全的读取；Himawari 自己聊天时用的概况由 `packages/application/src/services/owner-profile-service.ts` 生成（2000 字预算），MCP 入口没有用它。
- 写：`propose_memory`（单条）、`propose_rule`。要对方模型主动提议，主人在对方客户端的确认框里同意后才存（ADR 0225、0226）。
- 待确认（方案已定、代码排队中，`/mnt/project-files/p5-3-pending-writes/integrated-plan.md`）：不能弹确认框的客户端推来的记忆先存进新表 `external_memory_proposals`，主人在 Himawari 网页「来自其他 agent」里整批确认、可撤销；另有批量工具 `propose_memories`（一次最多 50 条）；客户端可带一个稳定键，同键的新内容替换还在待确认的旧内容；按规范化正文去重，被拒过的不再出现。
- 创建 MCP 服务时没有设置给客户端的使用说明（instructions）。
- 每次读取写一条决策记录（客户端自报的名字、工具名、命中的记忆）；周报里只有总条数。
- 网页上有文件导入：认 Codex 的记忆文件、AGENTS.md、Himawari 自己的导出文件，分类靠关键词正则（`apps/control-center/src/memory-import.ts`）。没有从其他 AI 产品搬记忆的引导流程，不能导入对话历史。
- 对外读取时敏感内容会被遮盖（`maskForExternalRead`）。
- 计划中有 Himawari 的原生 Mac、iPhone 客户端，带设备密钥（ADR 0229），还没开始编码。

## 五、已查到的一手资料

- Anthropic「导入记忆」：给一段提示词让原来的 AI 把记住的东西列出来，贴回 Claude；一次性；自称实验性。<https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude>
- Google Gemini：同样的提示词方式；另可上传 ChatGPT、Claude 的导出压缩包导入对话历史。<https://support.google.com/gemini/answer/16868299>
- Supermemory：“With MCP, say it plainly when something matters ("save this to Supermemory"), because the model may not call a tool on its own.”；“The plugins hook into the agent instead, so nothing waits on the model's judgment.” <https://supermemory.ai/blog/how-to-make-your-mcp-clients-share-context-with-supermemory-mcp.md>。它另有浏览器扩展，在 Claude、Gemini 网页输入框旁提示相关记忆、引导导入对话。
- mem0 的 Codex 接入：完整版用钩子采集和召回；只挂 MCP 的简版读写全靠模型调用工具。<https://docs.mem0.ai/integrations/codex.md>
- Claude Code 钩子：事件有 SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd、PreCompact、FileChanged 等；SessionStart 和 UserPromptSubmit 的输出会进模型上下文；处理方式有 command、http、mcp_tool、prompt、agent 五种，其中 mcp_tool 是“call a tool on a configured MCP server. The tool's text output is treated like command-hook stdout”，参数支持从钩子输入里代入（如 `${tool_input.file_path}`）；“The hook never starts an OAuth flow, so authenticate the server from `/mcp` first”；启动时的 SessionStart 早于 MCP 服务可用，这时的 mcp_tool 钩子会被跳过。插件可以同时带 MCP 服务和钩子。<https://code.claude.com/docs/en/hooks>
- Codex 钩子：SessionStart、UserPromptSubmit、Stop、SessionEnd 等 14 个事件，默认开启，输出 “added as extra developer context”。<https://learn.chatgpt.com/docs/hooks.md>
- Claude Code 自己的记忆是磁盘文件：`~/.claude/projects/<project>/memory/`，MEMORY.md 索引加每条一个文件，按仓库分。<https://code.claude.com/docs/en/memory>。Codex 的在 `~/.codex/memories/`，默认关。<https://developers.openai.com/codex/memories>
- MCP 2026-07-28 版去掉了 initialize 握手，服务信息改由 `server/discover` 返回，客户端不是必须调用。<https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- Claude 应用所有档位都能加自定义远程 MCP 连接（免费版一个）；Grok 可在 grok.com/connectors 加自定义 MCP 连接（<https://docs.x.ai/grok/connectors>）；Muse 能连 MCP、能跑定时任务、不能弹确认框（ADR 0227 引的 Muse 原话）。
- MacPaw 2026-07 提了开放格式 Portable Memory，还是征求意见稿。<https://research.macpaw.com/publications/portable-memory.md>

## 六、没核实的

- ChatGPT 个人版能不能加自定义 MCP 连接。
- 各客户端是否把 MCP 服务的使用说明放进模型上下文（只有第三方说法）。
- Claude 的云端会话（在 claude.ai 上跑的 Claude Code）里，记忆不在主人电脑上，钩子和连接器在那里怎么工作。
- Codex 钩子有没有类似 mcp_tool 的处理方式。

请自己读代码、上网核对，不要只信上面的整理。
