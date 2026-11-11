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
仓库就是当前目录，已检出 d36e46eeb74ef85d19e0c1984ac6e5fdd4aec104。
问题、目标和约束：
# 问题：外部 agent 经 MCP 提议写入主人的记忆，要主人在客户端里确认

## 背景和目标

Himawari 是一个个人 agent 服务。主人要把自己的记忆、规则、今日上下文集中放在 Himawari，Claude Code、Codex 等外部 agent 通过 MCP 读。只读入口已经在 main：`apps/agent-service/src/production-mcp-read.ts`，路径 `/api/mcp/v1`，静态令牌鉴权（`BearerGate`），三个只读工具，每次读取写一条决策记录（`docs/adr/0219-read-only-mcp-entry-with-static-token.md`）。

现在要加写工具：外部 agent 提议一条新记忆（这次只做记忆；提议规则要等另一个尚未合并的任务做出「规则提议卡」之后再接，不在本次范围）。

要求（主人原话的要点）：
- 写操作必须经主人确认，确认框出现在调用方自己的界面里（例如 Claude Code 终端），不让主人切到 Himawari 网页。
- 按 MCP 2026-07-28 版做：服务端不再中途主动向客户端发请求，而是把工具结果标成「需要输入」并附问题，客户端问完主人后带着答案把同一个调用再发一次，然后才落库；拒绝则不落库。
- 写操作全部走确认，不留后门；不用旧的「服务端中途主动向客户端发请求」方式。
- 重发的调用要能认出是同一次提议，不能重复落库。
- 做到什么算完：在 Claude Code 中端到端走通一次提议 → 确认 → 落库。

## 已核对的事实

1. MCP 2026-07-28 的多轮请求（MRTR）：https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr 。原话：“The previous pattern of server-initiated requests is no longer supported.” “servers MUST treat requestState as an attacker-controlled input … MUST protect its integrity (e.g. HMAC or AEAD)” “Servers for which a given requestState must be consumed at most once … MUST enforce that invariant server-side.” “Servers MUST NOT send an inputRequests that the client has not declared support for in its capabilities.”
2. Claude Code 文档 https://code.claude.com/docs/en/mcp ：在 2026-07-28 版连接上声明 `elicitation: {form: {}, url: {}}`；表单模式显示一个对话框。
3. 仓库依赖官方 SDK `@modelcontextprotocol/server` 2.0.0（类型在 `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-*.d.mts`）：有 `inputRequired()`、`inputRequired.elicit()`、`acceptedContent()`、`inputResponse()`、`ctx.mcpReq.requestState()`、`createMcpHandler` 选项 `requestState.verify` 钩子、`inputRequired.legacyShim`（默认开：对 2025 年老版本连接，SDK 在服务端改用旧式的服务端主动请求来完成「需要输入」）。
4. 网页新建记忆的写法：`apps/agent-service/src/production-memory-control.ts` 的 `#create`（id 为 `memory:owner:${idempotencyKey}`）和 `#createMemory`（检查正文、拒绝 restricted 分级）。`packages/application/src/services/durable-memory-service.ts` 的 `applyProposal` 遇到同 id 同内容直接返回已有记录。网页端在 `apps/control-center/src/memory.ts` 先 `protectText` 存正文拿到 `contentRef`。
5. 决策记录种类和结果在库里有 CHECK 约束（`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql`），代码侧表在 `packages/application/src/ports/decision-ledger.ts`。改表要排队，尽量不改表。
6. 仓库规则：发给模型或嵌入服务的请求必须走统一出口；新加提示词文字（包括工具说明）要登记进 `packages/prompt-catalog` 并过它的检查；识别敏感内容的规则只能写在 `packages/sensitive-capture`；「决策账本」已改名「决策记录」；不写代码注释；新测试要进自动检查。
7. 只有一把 MCP 令牌（`runPolicy.mcpRead.secretRef`），所有外部客户端共用。

## 请你做的

读相关代码和上面的资料，提出你认为最好的实现方案：工具怎么定义、确认怎么发、重发怎么认出同一次提议并保证只落一次、拒绝/取消/客户端不支持/老版本客户端怎么处理、决策记录怎么写、要哪些测试（正向和反向）、怎么在 Claude Code 里验收，以及你看到的风险。
