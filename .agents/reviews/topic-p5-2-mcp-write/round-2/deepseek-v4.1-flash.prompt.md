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
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 d36e46eeb74ef85d19e0c1984ac6e5fdd4aec104。
待审核的方案：
# 线程方案：外部 agent 经 MCP 提议记忆（请审核）

背景、约束和已核对事实同独立出方案时的材料（`propose_memory`，只做记忆；规则提议等另一个任务的规则提议卡）。下面是线程现在的方案，请找漏掉的场景、判断错的地方、和规范或业界成熟做法不一致的地方。

## 方案

1. **工具 `propose_memory`**，注册在 `production-mcp-read.ts` 同一个 `/api/mcp/v1` 上，固定排在三个只读工具后面，不走只读工具的 `register()` 包装。参数 `text`（1–2000 字）、`category`（可选，默认 other；暂不允许 `rule`，规则走以后的规则提议工具）。标注 `readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false`。不设任何「confirm」参数。不新增配置开关：配了 `runPolicy.mcpRead` 就有这个工具（写操作本身一律要确认）。
2. **第一轮**（没有 requestState）：规范化正文（去控制字符、trim，确认框显示的、算摘要的、最终存的是同一份）；校验分类；用 `classificationWithIdentifiers(text, "private")` 算分级，restricted 直接拒；记忆功能未就绪直接拒；老版本连接（2025 era）直接返回「需要新版客户端，未保存」；客户端没声明 form elicitation 直接返回「此客户端不能弹确认框，未保存」。都不写库。通过后返回 `inputRequired`：一个 form elicitation（文字说明哪个客户端提议、分类、敏感时提示「会按敏感记忆保存」、正文；一个必填布尔字段「保存」），`requestState` = SDK `createRequestStateCodec` 签发的 `{v:1, tool, proposalId(随机), argsHash(sha256 规范化参数)}`，TTL 600 秒，HMAC 密钥由 MCP 令牌按固定标签派生。这一轮不写任何东西。
3. **重发**：`createMcpHandler` 的 `requestState.verify` 用 codec 校验签名和过期，失败回 -32602；handler 再核对 `tool` 和 `argsHash` 与本次参数一致，不一致回工具错误、不写库。先查决策记录 `ledger:mcp-memory:<proposalId>:kept` / `:discarded` 是否已存在：已存在就返回「已保存过」/「已拒绝过」，不再写（防止记忆被删后旧 state 让它复活）。再读 `inputResponse(..., "confirm")`：
   - 缺失 → 用同一 proposalId 重新发一次确认；
   - decline / cancel / accept 但没勾 → 不写记忆，写 discarded 记录，返回非 isError 的「主人没有同意，未保存」；
   - accept 且勾了 → 写入。
   没有 requestState 但带了 inputResponses → 当第一轮处理，重新要确认，绝不落库。
4. **写入**：从 `ProductionMemoryControl` 抽出网页新建记忆和 MCP 共用的写法。`memoryId = memory:mcp:<proposalId>`，`contentRef` 也由 proposalId 决定；正文先保护存储（重复时比对一致），再 `applyProposal(create, generation, ledgerWrite)`，kept 决策记录作为第三个参数和记忆在同一事务落库。同一 proposalId 重发多少次都命中同一 id，`applyProposal` 同 id 同内容直接返回已有，决策记录 `ON CONFLICT DO NOTHING`。
5. **决策记录**（不改表）：kept：`kind=memory_candidate, outcome=kept, reasonCode=mcp_proposal_kept, subjectRef=<memoryId>`（每日回顾把 kept 的 subjectRef 当记忆 id 读，`daily-review.ts:225`），`inputs.memoryIds=[memoryId]`。discarded：`reasonCode=approval_rejected`（每日回顾按主人已决定跳过，`daily-review.ts:268`），`subjectRef=mcp-client:<客户端名>`，不含正文。
6. **老版本客户端**：`createMcpHandler` 设 `inputRequired.legacyShim: false`，即使 handler 漏判也不会退回服务端主动请求。
7. **提示词目录**：工具说明、确认框文字、几种结果文字都登记（`mcp.propose-memory` 等）。Himawari 自己发给模型的请求不变。
8. **测试** `test/integration/mcp-write.test.ts`（真实 SQLite、官方 SDK 客户端）：正向 确认→落库、能被 `find_memories` 读到、kept 记录；同 state 重发两次只一条；反向 拒绝/取消/不勾、篡改 state、过期、换参数、没声明 elicitation、老版本客户端（断言没有任何服务端→客户端请求）、没令牌 401、restricted 内容、记忆删除后重放旧 state 不复活。单元：codec 和规范化。
9. **验收**：Hermes 起临时进程，Andy 在 Mac 的 Claude Code 交互会话里加 MCP，提议一条点保存、一条点拒绝，核对库。

## 已知限制

- 服务端看不到人：持令牌的客户端可以自己回 accept。这是协议的信任模型，写进 ADR。
- 非交互的 Claude Code（`claude -p`）不弹框，提议会失败，工具说明里写明。

## 请审核重点看

1. HMAC 密钥从 MCP 令牌派生，还是另设服务端专用密钥：持令牌者既然能合法走完确认，另设密钥有没有实际收益。
2. proposalId 随机 vs 按正文哈希。
3. 「已决定」检查放在决策记录上是否可靠（kept 和记忆同事务；discarded 单独写，写失败怎么办）。
4. 有没有漏掉的场景。
