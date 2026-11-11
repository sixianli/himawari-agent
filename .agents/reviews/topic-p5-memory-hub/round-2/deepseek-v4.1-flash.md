## 结论摘要

方案方向（一个 MCP 门 + 按客户端能力补触发 + 待确认表）是对的，但按现在的写法直接实施，会踩到四个高严重度问题：**把自报的客户端名当权限身份**、**项目知识绕过主人确认**、**外部稳定编号过不了记忆 ID 合约**、**批量/全量同步撞 64 KB 请求体上限**。另外，`today_context` 合并、新参数透传、遮盖确定性、钩子读文件这几处都有具体的代码触点，不是“只改工具清单”那么简单。

---

## 一、已证实的问题（按严重度）

### 高 1. 用“客户端自报的名字”做每-agent 权限，暂停/撤销/读范围/直接存都不可靠

- **问题**：方案第 1、3、8 节把“接入的 agent 记录”作为权限主体：能读什么、能不能推、推来的要不要先问、暂停/撤销，都按客户端名判断。但 ADR 0227 已明确：所有客户端都以主人本人登录，凭证主体相同，客户端名只能自报。
- **证据**：
  - `docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:115`：“来源只能靠客户端自称。所有客户端都以 Andy 本人登录，凭证主体相同，所以「这条提议来自哪个客户端」仍然只能靠客户端自报的名字。”
  - `apps/agent-service/src/production-mcp-read.ts:106` 的 `CLIENT_NAME` 和 `:315-325` 的 `clientNameOf` 都取 `clientInfo.name` 或 `User-Agent`；`:394-395` 返回的 `authInfo.clientId` 是 `externalSubjectRef`，所有客户端相同。
  - `production-mcp-read.ts:867` 的决策台账 `subjectRef` 也是 `mcp-client:${client}`，同样只是自称。
- **后果**：任何能连上的客户端改个名字就能冒充“已允许直接存”或“可读全部”的 agent；主人“撤销/暂停”某个 agent 后，对方只要换名重连即可绕过。这不是“显示名”问题，而是权限边界失效。
- **建议**：不要把客户端名当身份。优先用 OAuth 客户端登记信息（若 Cloudflare 提供 `client_id`/`azp` 之类）或给每个 agent 发独立凭据（设备密钥/服务令牌）生成服务端 `agentId`；做不到时，所有 agent 统一走保守策略（全部先问、统一读范围），客户端名只做展示和统计，并在页面上删掉“暂停/撤销立即生效”的承诺。

### 高 2. 项目知识“不确认直接存”绕过了前提 7，且跨 agent 共享不可信内容

- **问题**：方案第 3 节把“项目知识”单独存成项目笔记，不需要主人逐条确认，理由是“不是关于主人的断言”。这直接违背方案自己列的前提 7（推来的记忆先让主人确认）和 ADR 0225 的“每次写入都要 Andy 确认”。更关键的是，判断“这是项目知识还是关于主人”的依据是对方给的类别提示，服务端只做事后抽查。
- **证据**：
  - 方案第 3 节：“项目知识：…不需要主人逐条确认，因为它不是关于主人的断言，只是对方工作笔记的一份镜像。”
  - `docs/adr/0225-external-agents-propose-memory-with-in-client-confirmation.md:28`：“每一次写入都要 Andy 在他正在用的客户端里点确认，拒绝就什么都不写，没有绕过确认的后门。”
  - 现有代码已经有同步分类能力：`apps/agent-service/src/production-mcp-memory-writer.ts:56-63` 的 `proposalClassification`，健康/财务直接判 sensitive，其他内容用 `classificationWithIdentifiers`。方案却说“类别提示由对方给，Himawari 不盲信，每天后台抽查”。
- **后果**：外部 agent 把一条“关于主人的健康/财务/身份”标成“项目知识”，就能跳过确认直接进入可搜索存储；而项目笔记按方案又要让下一个 agent（Codex）读到，等于把未确认的、可能敏感的内容跨 agent 传播。事后抽查发生在数据已经可读之后，挡不住首日泄露。
- **建议**：写路径上同步执行与 `proposal_memory` 相同的分类和敏感检测；凡是 sensitive/健康/财务/身份/关系，一律进待确认，不能由发送方选择绕过。项目笔记要么单独存储且默认不跨 agent，要么也走确认。把“项目知识”和“关于主人的项目事实”分成两个明确的 `kind`，不要用同一个 `project` 类别承载。

### 高 3. 外部稳定编号（文件路径）不能直接用成记忆 ID/contentRef，正是 I-73 的同类问题

- **问题**：方案说每条带“对方自己的稳定编号（例如笔记文件路径）”。但现有外部写入把提议编号直接拼进记忆 ID 和内容引用；文件路径含 `/`、空格、可能超过 128 字符，过不了 `machineString`。
- **证据**：
  - `apps/agent-service/src/production-mcp-memory-writer.ts:69-71`：`externalProposalMemoryId` 返回 `memory:mcp:${proposalId}`；`:147` 的 contentRef 是 `memory-content:mcp:${proposalId}`。
  - `packages/gateway-contracts/src/validation.ts:49-59`：`machineString` 要求 1–128 字符，且 `^[A-Za-z0-9][A-Za-z0-9._:-]*$`，**不允许 `/`**。
  - `packages/gateway-contracts/src/contracts-v2.ts` 中 `memoryId` 用的就是 `machineString`。
  - `docs/incidents-and-gates.md:112`（I-73）：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”。
- **后果**：如果按最直接实现把稳定编号当 proposalId，`/Users/andy/...` 这类路径会在 `applyProposal`/合约层被拒；如果截断或替换字符，又会造成跨 agent/跨项目碰撞，更新和删除可能命中别人的条目。
- **建议**：服务端生成代理 ID（UUID/ULID）作为 `memoryId`/contentRef；另建 `(sourceAgentId, projectId, stableId)` 的唯一键表，稳定号只做业务键。稳定号单独规范化（NFC、长度、允许字符），必要时哈希。新增 `check:*` 合约检查：从每个客户端的真实稳定号（含路径、空格、中文、超长）生产出的所有 ID 都必须能通过两个合约包，并加反向用例（去掉代理 ID 后必须失败）。这正是 I-73 要求的“两端都校验 + 自动门槛”。

### 高 4. 批量/全量 `sync_memories` 会撞现有 64 KB 请求体上限，且部分失败语义未定义

- **问题**：方案说“一次发一批”“对话结束时再发一次全量”，但没有批量大小、总字节上限、分片和部分失败规则。现有 MCP 入口的请求体上限是 64 KB，单条正文上限 2000 字，二者相乘很容易超。
- **证据**：
  - `apps/agent-service/src/production-mcp-read.ts:90`：`MCP_READ_BODY_LIMIT = 65_536`；`:1030` 对所有方法（GET/POST/DELETE）生效。
  - `apps/agent-service/src/production-mcp-memory-writer.ts:26`：`EXTERNAL_PROPOSAL_TEXT_MAXIMUM = 2000`。
  - 方案第 3 节：“一次发一批”“可以声明「这一批是我这边的全部」”“对话结束时再发一次全量”。
- **后果**：30 条 2000 字的笔记加 JSON 开销就超过 64 KB，全量同步直接 413；如果服务端先写了一半再失败，客户端重试会重复创建或重复产生历史版本；删除/更新按“编号”处理但拿不到逐条结果，客户端无法判断该重试哪些。
- **建议**：明确 `maxEntries`、`maxTotalBytes`、单条上限和分片协议；返回逐条 `{stableId, status, version}`；用 `(agentId, projectId, stableId, contentHash)` 做幂等键；整批要么一次事务提交，要么用可重试的逐条提交并保证重试幂等。若确实要传全量，给同步单独开一条带更高上限的路由，并加反向用例（超限必须被拒且不产生半批数据）。

### 中高 5. 新参数（触发来源、项目范围）会被现有 `find_memories` 校验拒绝；`today_context` 合并会漏记台账字段

- **问题**：方案说“每次调用带一个触发来源标记（在参数里声明）”“`find_memories` 带项目范围”。但 `find_memories` 的参数会原样交给 `ProductionMemoryRecall`，后者明确拒绝未知键；同时 `today_context` 被并进 `start_here` 后，现有按工具名写摘要字段的逻辑不会自动跟着改名。
- **证据**：
  - `apps/agent-service/src/production-mcp-read.ts:902-904` 把 `args` 直接传给 `sources.recall`。
  - `apps/agent-service/src/production-memory-recall.ts:92-111` 的 `argumentsOf` 只接受 `query/from/to/includeHistory/limit`，其他键直接 `MEMORY_RECALL_INPUT_INVALID`。
  - `production-mcp-read.ts:837` 写的是 `name === "today_context" && this.#options.sources.summaries`，summary 台账字段只在这个分支写。
  - `docs/execution/specs/2026-11-09-decision-record-write-convention.md:45` 明确说 `external_read` 的六个 summary 字段“只在外部读取的 `today_context` 接上了摘要读取时写”。
- **后果**：客户端一加 `triggerSource` 或 `project`，`find_memories` 直接报参数不合法；`today_context` 改名后 summary 字段静默消失，决策记录和周报的口径断掉，历史 `reasonCode: "today_context"` 也需要兼容。
- **建议**：在 MCP 层把 `triggerSource`/`project` 剥离后再交给 recall，或给 recall 增加显式的项目/分类参数；`start_here` 的记录分支改为按新工具名写，并保留 `today_context` 别名或做一次 ledger 口径迁移；同步更新决策记录约定、测试和报表过滤条件。

### 中高 6. `start_here` 合并输出会让同一段文字因遮盖标签顺序不同而变成不同字节

- **问题**：方案要求 `start_here` 复用现有读取路径。现有外部读取会把整个输出对象里的所有字符串收集起来，交给 `maskSensitiveTexts`。这个函数用共享的 `tags` 映射按输入顺序分配 `[a]`、`[b]`…；同一段敏感文字在字段顺序、列表顺序或前面敏感值数量变化时，会得到不同占位符。
- **证据**：
  - `apps/agent-service/src/production-mcp-read.ts:247-256` 的 `maskForExternalRead` 先 `mapStrings` 收集 `texts`，再整体 `maskSensitiveTexts(texts)`。
  - `packages/sensitive-capture/src/redaction.ts:552-568`：`const tags = new Map...`，`tag` 回调里 `sequenceTag(tags.size)`，先遍历所有输入再逐条输出。
- **后果**：`start_here` 把概况、规则、今日情况合并后，同一段记忆在“只有它”和“前面多了一条敏感值”的响应里会遮成不同字节；如果客户端把结果放进系统提示或历史开头，会破坏它自己的缓存；即使只放末尾，也不满足“同一段文字每次字节相同”的要求。
- **建议**：外部读取按字段独立遮盖（每个字段自己的 tag 空间），或固定字段顺序并对同一响应使用稳定的 tag 映射；对所有列表显式排序（提醒、近两天摘要、删除/拒绝编号、项目笔记）。加一个字节相等测试：同一份数据用不同来源顺序/不同无关字段生成两次响应，同一段文字的遮盖结果必须相同。

### 中高 7. 档一的“写入时钩子把内容交给 sync_memories”与 Claude Code `mcp_tool` 能力不匹配

- **问题**：`mcp_tool` 钩子只能把事件 JSON 里的字符串通过 `${path}` 替换成工具参数，不能自己读文件。`Write` 有 `content`，`Edit` 只有 `old_string`/`new_string`；所以“对方写记忆文件时把这次写入的完整内容交给 `sync_memories`”抓不全，`Stop` 时“发全量”也需要读目录，`mcp_tool` 做不到。
- **证据**：
  - Claude Code Hooks 文档（<https://code.claude.com/docs/en/hooks>）：“`mcp_tool`: call a tool on a configured MCP server. The tool's text output is treated like command-hook stdout”；`mcp_tool` 的 `input` 只支持 `${path}` 替换，例如 `"${tool_input.file_path}"`；命令钩子才从 stdin 拿完整事件。
  - 同一页：“The hook never starts an OAuth flow, so authenticate the server from `/mcp` first”；“`SessionStart` at launch … fire before the session's MCP servers are available … Claude Code skips their `mcp_tool` hooks”。
- **后果**：按 `mcp_tool` 实现，`Edit` 只能同步被替换的片段，`Stop` 全量同步无法读记忆目录；如果改用命令钩子读文件，又需要自己的凭据，和方案“钩子不需要另外的凭据”冲突。方案自己列了“Claude Code 写记忆文件是否都经过 Write、Edit”未核实，但这还不是全部问题。
- **建议**：档一改成“本地桥接”（Mac 客户端/本地守护进程）负责读记忆目录并用自己的凭据调用 `sync_memories`；或者用命令钩子读取目录，但明确它需要独立凭据。`mcp_tool` 只用于“把当前用户这句话发给检索工具”这类不读文件的操作。`start_here` 的首次调用用 `UserPromptSubmit`，不要用 `SessionStart`。

### 中高 8. 每句话自动检索 + 全入口共用 30 次/分钟 + 每次读都写台账，存在自我限流和资源耗尽

- **问题**：方案让每个有钩子的 agent 每句话调用一次检索，但 MCP 入口所有客户端共用每分钟 30 次有效请求；每次读取还写一条决策台账。钩子默认超时也不宽裕。
- **证据**：
  - `apps/agent-service/src/bearer-admission.ts:4-6`：`AUTHORIZED_PER_MINUTE = 30`、`UNAUTHORIZED_PER_MINUTE = 60`、60 秒窗口。
  - `production-mcp-read.ts:851-887` 的 `#record` 每次读取都 `ledger.append`。
  - Claude Code Hooks 文档：`UserPromptSubmit` 上 `mcp_tool` 默认超时从 600 秒降到 30 秒。
- **后果**：两个 agent 同时每句话检索，加上 `start_here`、`sync_memories`、确认来回，很容易打满 30 次，导致正常读取被 429；钩子超时后本轮没有记忆；台账按消息增长，长期膨胀。
- **建议**：给钩子读取单独的预算或按 agent 的令牌桶；同一 prompt 的重复检索做去重/缓存；台账按“agent + 天 + 工具”聚合，或对钩子路径采样，不要每条消息一行；钩子设置短超时并失败开放（不阻塞用户消息）。

### 中 9. `start_here` 没有总长度上限/降级；合并概况、规则、今日情况可能超过客户端或钩子的结果大小限制

- **问题**：方案只说“最重要的内容放在前 512 个字符”，没有说总上限、各段预算、超限时返回什么。概况本身最多 2000 字，规则手册和今日摘要没有同样上限；`mcp_tool` 钩子的输出太大时会“给不出裁决”。
- **证据**：
  - `packages/application/src/services/owner-profile-service.ts:14`：`OWNER_PROFILE_CHARACTER_BUDGET = 2000`；规则和 agenda 另算。
  - `production-mcp-read.ts:963-988` 的 `rule_book` 返回全部规则和设置，没看到总字符上限。
  - Claude Code Hooks 文档：工具结果太大时，`mcp_tool` 钩子会报“gave no answer that could be read / answered without its text … this hook gave no verdict”，`UserPromptSubmit` 上这个错误是非阻塞的。
- **后果**：数据一多，钩子静默拿不到记忆；`start_here` 作为入口工具反而最不稳定。
- **建议**：给 `start_here` 设总字符/字节上限和分段预算（概况、规则摘要、今日、固定说明），超限按优先级截断并带明确标记；`isError` 只用于真正失败，部分内容用结构化字段标明；用最大数据量做反向测试。

### 中 10. 项目笔记和普通 `project` 类别同名，会进入主人概况或普通聊天检索

- **问题**：方案说项目笔记“不进主人概况，`find_memories` 带项目范围时才搜得到”。但现有 `OwnerProfileService` 的“进行中的事”就是 `project` 类别；普通聊天记忆检索也会搜所有记忆。如果项目笔记复用同一张表/同一个类别，它会被带进 Himawari 自己的请求或概况。
- **证据**：
  - `packages/application/src/services/owner-profile-service.ts:25-31`：`PROFILE_SECTIONS` 包含 `["project", "进行中的事"]`；`:204-216` 会把 importance ≥ 600 的 project 类记忆放进 profile。
  - `packages/application/src/services/context-formation-service.ts:241-252`：聊天每轮 `memory.search` 搜全部记忆；`production-memory-recall.ts:193-202` 同样。
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:623-641` 把 context blocks 放进最后一条用户消息。
- **后果**：项目笔记可能出现在主人概况或普通聊天里，违反方案自己的“不进概况 / 只有带项目范围才搜得到”；虽然它在最后一条消息里，不破坏请求开头，但会污染模型输入和主人可见内容。
- **建议**：项目笔记用独立存储/独立记录类型（`sourceKind: "external_project_note"`），普通 profile/聊天检索显式排除；只有 `find_memories` 带项目范围时通过单独的查询端口读取。加测试：没有项目范围时，项目笔记绝不出现在 profile、聊天自动记忆、Gmail 检查里。

### 中 11. “请对方从自己的记忆里也删掉”可能跨 agent 误删，且不可撤销

- **问题**：方案让 `sync_memories` 返回“主人已经在 Himawari 删掉或拒绝的编号”，并请对方从自己的记忆里删除。但没有说只返回**这个 agent 自己**的编号，也没有带内容哈希/版本。
- **证据**：方案第 3 节原文；现有 `production-mcp-read.ts:867` 用 `mcp-client:${client}` 做来源，但同步记录若按项目全局键，可能跨 agent 命中。方案第 8 节说“Himawari 不去动主人电脑上的文件”，但返回的指令会让外部 agent 去动。
- **后果**：agent B 可能收到 agent A 的编号，或收到一个被复用的文件路径，删掉自己的笔记；这是主人电脑上的不可逆操作，且主人可能不知道外部 agent 会照做。
- **建议**：删除建议只返回同 `agentId` + `projectId` 命名空间下的 tombstone，并带 `contentHash`/`version`；默认只展示“主人已删除，请自行处理”，不要用命令式文字要求自动删除；真正删除外部文件必须由主人显式确认。加跨 agent 隔离和版本不匹配的测试。

### 中 12. “敏感内容对外遮盖”的判断不准确：当前外部读取会返回 sensitive，只排除了 restricted

- **问题**：方案第 8 节说“默认沿用现在的遮盖（敏感内容对外遮盖）”。但当前模型可见上限是 `sensitive`，`restricted` 才不可见；`maskForExternalRead` 只按模式遮盖密码/验证码/银行卡等标识，不会把健康、财务、关系等整条内容隐藏。
- **证据**：
  - `packages/application/src/services/model-visibility.ts:10-25`：`MODEL_VISIBLE = ["public", "private", "sensitive"]`，`modelVisibleCeiling()` 返回 `"sensitive"`。
  - `apps/agent-service/src/production-mcp-read.ts:247-256` 只调用 `maskSensitiveTexts`，没有按 classification 过滤。
- **后果**：默认情况下，外部 agent 可以读到健康/财务等敏感记忆（除非内容里正好有可识别标识被遮）；主人以为“敏感内容被遮住了”，实际没有。第 2 节“不能挂 MCP 的 agent：网页生成关于我文本”同样没有让主人选择范围，粘到 ChatGPT 可能泄露敏感信息。
- **建议**：把“敏感级别上限”和“模式遮盖”分开写清楚；默认对外上限建议低于 `sensitive`（例如 private），或至少让主人在每个 agent 上显式选择。`start_here`、`find_memories`、`rule_book` 统一走同一个 classification gate。网页“关于我”文本提供分类勾选、预览和警告。

### 中 13. 规则提议仍保留客户端确认框，但方案自己承认主力客户端不弹框

- **问题**：方案只为“记忆”去掉客户端确认框，规则提议保留。但 ADR 0225/0226 记录的“Claude 桌面 App Code 标签声明支持确认框却不显示、约 10ms 自动拒绝”对规则同样成立；规则提议在该客户端会走 `unseen`/拒绝，方案没有给替代路径。
- **证据**：
  - `docs/adr/0225-external-agents-propose-memory-with-in-client-confirmation.md:58` 和 `docs/adr/0226-external-agents-propose-rules-through-the-rule-proposal-flow.md:55` 都记录了同一个 bug 与 `MCP_PROPOSAL_UNSEEN_ANSWER_MS` 处理。
  - 方案第 3 节：“去掉客户端里的确认框这条路（只针对记忆；规则提议保留）”。
- **建议**：规则提议也走 Himawari 待确认表，或明确说明该客户端不能提规则并提供“到 Himawari 里新建”的兜底；不要在记忆和规则上采用两套不一致的确认策略。

### 中 14. “补触发是治根”只对档一成立；档二/三/四仍然依赖模型自觉

- **问题**：方案第 2 节说“只写接入步骤、指望模型自觉是表面”，但第 4 节表格里档二、档三的读仍然靠“使用说明加固定指令”，档三的推也靠“模型自己调”。这仍是原问题。
- **证据**：方案第 4 节表格；前提 2 引用的 Supermemory 原话：“With MCP … the model may not call a tool on its own.”（注意这是厂商博客，不是一手文档）。
- **后果**：验收“至少两个 agent 有读取/同步记录”可能只证明主人手动点过，不证明触发可靠；对档二/三的产品承诺会过高。
- **建议**：把四档的可靠性写清楚：档一是自动触发，档二/三是 best-effort，档四手动；验收按档位分别定，不要用统一的一周试用代替。档二/三若要可靠，需要外部定时器/本地 helper，而不是服务说明。

### 中 15. `rule_book`/`start_here` 的规则和设置没有按 agent 读范围过滤

- **问题**：方案第 8 节只给“记忆类别和敏感级别”设上限，但 `rule_book` 和 `start_here` 里的规则摘要包含邮件规则参数（免打扰时段、重要发件人），不属于记忆分类。
- **证据**：`production-mcp-read.ts:963-988` 返回 `ruleBookFor(settings)` 和 owner rules，`ruleParameters` 会带出 `quietHours`、`importantSenders`；方案第 8 节没有规则级 scope。
- **后果**：低信任的 coding agent 也能读到主人的邮件规则和邮箱地址；而且把邮件规则当“主人的硬性要求”塞给 coding agent，可能造成无关行为。
- **建议**：规则也按 agent 设可见范围；`start_here` 默认只给“与当前 agent 相关”的规则，或明确标注“这些是 Himawari 的邮件规则，不适用于你的任务”。`rule_book` 加同样的 gate 和测试。

---

## 二、推测/未核实的问题

1. **推测：Codex 钩子未必能直接调 MCP 工具。** OpenAI 官方插件文档（<https://developers.openai.com/plugins/build/plugins>）的钩子示例是 `"type": "command"`，并说“Hook scripts must exist in the execution environment”；“Plugin hooks use the same event schema as regular hooks”。这支持“事件同名”，但不等于支持 `mcp_tool`。方案自己已把这条列为未核实，建议不要把“两家逻辑共用”写成已定事实。
2. **推测：服务说明（MCP `instructions`）不保证进入模型上下文。** MCP 规范只说 `instructions` 是 “Optional instructions for the client”（<https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle>）。档二/三把触发建立在这上面，风险较高；工具描述是更可靠的载体。
3. **未核实：`/mnt/project-files/p5-3-pending-writes/integrated-plan.md` 和 ADR 0228。** 仓库里没有 ADR 0228，也没有待确认表实现；方案把“待确认表、批量工具、稳定键、整批确认可撤销”当成已定，需在仓库里落成 ADR/表结构后才能作为前提。
4. **推测：`start_here` 若直接序列化 `OwnerProfileService.compose` 的返回值，会泄露 `payloadRef`/`memoryIds`。** `owner-profile-service.ts:33-45`、`:359-387` 返回这些内部字段；实现时应只投影文本，不返回内部引用。
5. **推测：每次 `start_here` 调用 `compose` 都会 `storeText` 写新载荷。** `owner-profile-service.ts:374-380` 每次按 digest 写入；钩子按会话/消息调用会增加存储。需要缓存或读路径不写。
6. **推测：Mac 客户端监视记忆目录、对话历史压缩包导入缺少路径/大小/符号链接/zip bomb 限制。** 方案只写“直接读文件”“逐段抽取”，没有 allowlist、大小上限、解压比、条目数、超时和取消。按“不可信输入 + 资源耗尽”应补。
7. **推测：项目名/触发来源/客户端名会进入 UI、周报和模型提示，存在 XSS/prompt injection/统计污染风险。** 方案没有给这些字段的枚举、长度、字符集和渲染方式；`production-mcp-read.ts:106` 的 `CLIENT_NAME` 只约束了客户端名，项目名和触发来源未定义。
8. **推测：自动创建“接入的 agent”记录可被随机 `clientInfo.name` 刷出无限记录。** 方案没有上限/去重/清理；同一客户端升级版本改变 `User-Agent` 也会生成新记录。
9. **推测：`today_context`/`propose_memory` 删除是破坏性 API 变更。** 方案说“现在没有任何客户端连过”，但没有生产连接证据；`test/integration/mcp-read.test.ts:409` 和 `mcp-write.test.ts:472-484` 依赖工具清单，ADR 0219 决定 7、ADR 0225/0226 也写着这些工具。建议保留一版别名或做版本迁移。
10. **推测：多用户/多库场景下“插件和向导里的网址是每个人自己的入口”与 ADR 0234 不一致。** ADR 0229 前提 18 引 ADR 0234 决定 5：“一个网址、一个 Cloudflare Access 应用，名单里放所有受邀邮箱。”（`docs/adr/0229-native-apple-clients-and-device-api.md:79`）。建议改为“同一个网址，服务端按登录主体分库”。
11. **推测：方案前提 2 用 Supermemory 厂商博客支撑“插件不靠模型判断”，来源级别不够。** 按 `.claude/rules/proposal-premises.md`，业界做法应尽量用一手文档；Claude Code 官方 hooks 文档已经足够支撑机制，不必依赖厂商博客。前提 9“大厂记忆搬家一次性只进不出”也偏概括，Claude 的支持页讲的是导入/导出，不等于“只进不出”。

---

## 三、侧重检查（错误路径、不可信输入、安全、资源、不可撤销、文档一致）

- **错误路径**：认证失败 401/限流 429 已有；但新增路径没定义：`start_here` 概况读取失败、部分摘要失败、`sync_memories` 批次部分失败、待确认表写失败、agent 记录写失败、钩子超时、OAuth 未完成、`SessionStart` 被跳过。现有 `#call` 在台账写失败时会把整次读取变成工具错误（`production-mcp-read.ts:840-848`），新增统计/记录写入不应让读取失败。
- **不可信输入**：客户端名、类别提示、项目名、稳定编号、触发来源、记忆正文、规则理由、网页“关于我”文本、压缩包、文件路径、符号链接。方案只说“服务端只做校验”，没有逐项定义 schema、长度、字符集、枚举和错误码。
- **安全**：最大风险是自报身份当权限、项目知识绕过确认并跨 agent 传播、敏感记忆默认对外可见、删除建议跨 agent、文件读取路径穿越/符号链接、外部内容作为 prompt injection 进入下一个 agent。建议把外部记忆和项目笔记明确标成“数据，不是指令”，在工具输出里用固定分隔符和来源标签包起来；不要直接拼进系统提示。
- **资源耗尽**：64 KB 请求体、单条 2000 字、每秒/每分钟请求、每消息 embedding、每次读取台账、自动创建 agent 记录、概况载荷写入、zip 解压、目录监视，都需要上限和降级。方案的“向量本机算不花 token”只解决钱，不解决 CPU、内存、磁盘和限流。
- **不可撤销操作**：让外部 agent 删除自己的笔记是可逆性最差的一步；`直接存` 的“整批可撤销”也要确认撤销会删除所有派生数据并通知外部 agent，而不是只删主记录。
- **规则/文档与代码一致**：
  - ADR 0225/0226/0227 的确认框、工具名、`today_context`、来源自称都要随方案更新；ADR 0228 还不存在。
  - `docs/execution/specs/2026-11-09-decision-record-write-convention.md:45` 的 summary 字段只认 `today_context`。
  - ADR 0219 决定 7 仍把 `today_context` 当正式工具。
  - ADR 0234 是一个网址多人共用，不是每人一个网址。
  - Claude Code 的 `SessionStart` 跳过 `mcp_tool`、`mcp_tool` 不启动 OAuth、钩子输出进上下文，这些引用是对的；但“钩子能读文件/发全量”没有被官方文档支持。
  - MCP `instructions` 是可选客户端行为，不能当作可靠触发。

---

## 四、如果由我来定，我会怎样改这份方案

1. **先做读，后做写。** 第一阶段只做 `start_here`、工具描述里的触发说明、`rule_book`/`find_memories` 的按 agent 读范围，先把“换 agent 能读”跑通；写同步等 ADR 0228 的待确认表和 agent 身份表落地后再上。
2. **身份先于权限。** 新建服务端 `external_agent` 表：`agentId`（服务端生成）、`displayName`（自称，仅展示）、`oauthClientId`（若可得）、`createdAt`、`lastSeenAt`、`status`。不要用 `displayName` 做权限键。拿不到稳定客户端标识时，所有 agent 统一“先问”，不做每-agent 直接存，也不承诺按名撤销。
3. **项目笔记独立存储。** 新表 `project_notes`：`agentId`、`projectId`（服务端规范化的稳定 ID）、`stableId`、`contentHash`、`version`、`classification`、`textRef`、`deletedAt`。普通 profile/聊天检索显式排除；`find_memories` 只有带 `projectId` 时查它。默认不跨 agent，跨 agent 共享要主人按项目显式打开。
4. **写路径同步分类。** 复用 `proposalClassification` + `classificationWithIdentifiers`，不靠对方类别和事后抽查。任何 sensitive/健康/财务/身份/关系都进待确认；项目笔记首次同步也要让主人看到并批准，之后才允许增量。
5. **同步协议工程化。** 明确批量上限、总字节、分片、逐条状态、幂等键、更新历史、全量删除对账、tombstone 命名空间。稳定编号只做业务键，记忆 ID 用服务端代理 ID。加 `check:mcp-sync-contract`：每个新值都从生产端跑到消费端，反向用例必须失败（I-73）。
6. **触发分层，但不夸大。** 档一用本地 helper/命令钩子读记忆目录并带自己的凭据；`mcp_tool` 只做“把当前问题交给检索”。档二/三明确是 best-effort；档四手动导出并提供分类选择。`start_here` 首次调用放 `UserPromptSubmit`，输出只追加到最后一条用户消息，不放系统提示。
7. **确定性和上限。** 所有列表排序；遮盖按字段独立或固定顺序；`start_here` 设总预算和分段预算；`today_context` 保留别名或做 ledger 口径迁移；新后台分类调用按“固定指令在前、数据在后”并加 prompt-prefix 检查和费用估算。
8. **安全与资源门槛。** 外部内容标注为数据、固定分隔符、纯文本渲染；文件读取 allowlist、拒绝符号链接/路径穿越、大小/条目/解压比上限；台账按 agent/天聚合；钩子短超时、失败开放；自动 agent 记录去重和上限。
9. **文档一起改。** 新 ADR 0228（待确认表）+ 修订 ADR 0225/0226/0227/0219；更新决策记录约定、报表、测试、界面文案；把“每人一个网址”改成“一个网址、按登录主体分库”；把厂商博客换成官方文档。
10. **验收按档位。** 档一要求自动读取/同步各至少一次且无人工点击；档二/三只要求主人手动验证；加自动门槛覆盖幂等、更新、删除、部分失败、跨 agent、超限、敏感、路径攻击，反向用例逐条证明会失败。

---

## 五、逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加？每轮会变的值是否都在最后一条消息里？

**对 Himawari 自己的请求：按方案文字不改，但需要补证明。** 现有代码把 owner profile、规则、选中记忆等 context blocks 放在 `turnPrompt` 的最后一条用户消息里（`packages/runtime-pi/src/pi-runtime-adapter.ts:623-641`），已确认的记忆走同一条路；系统提示和工具定义不变。所以“确认后的记忆”不会改请求开头。前提是项目笔记/待确认数据不进系统提示、工具定义或历史中间；方案第 4 节的说法成立，但目前没有自动检查证明。

**对外部 agent：会改一次它的工具定义。** 新增 `start_here`/`sync_memories` 会改变外部客户端的 MCP 工具列表，工具定义在请求最前面，已连接的 agent 会缓存失效一次。这是一次性的，应在发布说明和 ADR 里写明。

**每轮会变的值**：`start_here` 里的 `now`、`today`、`reminders`、`recentDays`、日期注记，以及每句话检索结果，必须只放在工具结果或最后一条用户消息里，不能进系统提示/MCP `instructions`/工具描述。方案没有明确钩子输出注入的位置；Claude Code 文档只说“added as context”，没有保证位置。建议明确写成“追加到最新用户消息”，并在真实客户端里验证。`SessionStart` 的 `mcp_tool` 会被跳过（官方文档已证实），所以首次 `start_here` 要用 `UserPromptSubmit`。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**会，至少有五处：**

1. **遮盖标签顺序**：`maskForExternalRead` 把整个输出的所有字符串一起交给 `maskSensitiveTexts`，后者按输入顺序分配 `[a]`/`[b]`（`production-mcp-read.ts:247-256`、`redaction.ts:552-568`）。`start_here` 合并字段后，同一段记忆的占位符会随字段/列表顺序和前面的敏感值数量变化。
2. **时间/日期字段**：`start_here` 的 `now`/`today`、`memoryDateNote` 的日期注记每天/每次不同（`memory-dates.ts:49-57`）。
3. **无序集合**：提醒、近两天摘要、删除/拒绝编号、项目笔记如果没有显式排序，数据库返回顺序会让同样的状态序列化成不同字节。
4. **客户端名/User-Agent**：`clientNameOf` 用 `clientInfo.name` 或 `User-Agent`；同一客户端升级版本可能变成不同名字，影响 agent 记录、台账和统计。
5. **“关于我”文本带生成日期**：每次生成/复制的字节不同；这本身可以接受，但要固定生成时间和模板，避免同一天生成两次也不同。

**对 Himawari 自己的请求**：只要这些值只在最后一条消息里，尾部变化不改变前面的字节；但如果项目笔记进入 owner profile 或系统提示，就会改开头。建议所有列表排序、遮盖按字段独立或固定顺序、项目笔记独立存储并排除。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**没有。** 方案只给了“主人日常用一周，至少两个 agent 有记录”的验收；按 `.claude/rules/incident-gates.md:15`，“文档、案例库案例、记忆笔记或提醒都不是门槛”。现有 `npm run check:prompt-prefix` 覆盖的是 Himawari 自己的请求，不覆盖外部 MCP；`test/integration/mcp-read.test.ts`、`mcp-write.test.ts` 存在，但方案没有列要改哪些用例。

需要补的门槛至少包括：
- `check:mcp-sync-contract`：稳定编号、类别、项目名、触发来源、批量上限，从生产端到消费端全链路校验；反向用例（去掉代理 ID/去掉机器字符串校验）必须失败。照 I-73 的 `check:model-ref-contract` 做。
- 同步幂等：同编号同内容不新增；同编号新内容产生新版本；重试不重复；反向用例（去掉幂等键）必须失败。
- 跨 agent 隔离：A 的编号/项目不能被 B 读到或删到；反向用例必须失败。
- 部分失败：一批里第 N 条非法/超限/敏感时，返回逐条状态且不产生半批不可重试状态；反向用例必须失败。
- `today_context`/`start_here` 台账字段：改名后 summary 字段仍写入，历史 `reason_code` 兼容；反向用例（改名不更新条件）必须失败。
- 遮盖确定性：同一份数据不同字段顺序生成两次，同一段文字字节相同；反向用例（共享 tag 顺序）必须失败。
- 资源上限：超过 `MCP_READ_BODY_LIMIT`、批量条目、单条长度、钩子超时的请求被明确拒绝且不产生部分写入。
- 安全：路径穿越/符号链接/zip bomb、把 personal 标成 project、跨 agent 删除建议，都要有反向用例。
- 提示词门槛：新增的后台分类调用和任何新的 Himawari 模型请求，纳入 `check:prompt-prefix` 或等价检查。

每个反向用例都要按事故规则“证明它在复现上会失败、原因去除后会通过”，并把证据写进提交说明。

### 4. 每个新值的生产端和消费端都能接受吗？

**不能，至少有下面这些两端不一致：**

| 新值/字段 | 生产端 | 消费端/校验 | 结论 |
| --- | --- | --- | --- |
| 外部稳定编号（文件路径） | 方案第 3 节 | `memory:mcp:<id>` / `contentRef`，`machineString` 不允许 `/`、≤128 字符（`validation.ts:49-59`、`production-mcp-memory-writer.ts:69-71`） | **会失败**；需服务端代理 ID + 业务键表 |
| 类别提示“像一条规则” | 方案第 3 节 | `EXTERNAL_PROPOSAL_CATEGORIES` 只有九类，不含 rule（`production-mcp-memory-writer.ts:27-37`、`production-mcp-read.ts:707-709`） | **会失败**；需独立 `kind` 字段/规则路由 |
| `triggerSource` 参数 | 方案第 1 节 | `find_memories` 原样传给 recall，`argumentsOf` 拒绝未知键（`production-mcp-read.ts:902`、`production-memory-recall.ts:92-111`） | **会失败**；MCP 层剥离或扩展 recall |
| `project` 参数 | 方案第 3/8 节 | 同上；项目笔记查询也没有现成端口 | **未接通**；需显式查询端口和 schema |
| `today_context` → `start_here` | 方案第 3 节 | `#record` 仍按 `name === "today_context"` 写 summary（`production-mcp-read.ts:837`）；决策记录约定只认 `today_context`（spec:45） | **会漏字段**；改条件、更新文档/测试 |
| 每-agent 读范围/敏感上限 | 方案第 8 节 | `OwnerProfileService.compose` 支持 `maxClassification`，但 `ProductionMemoryRecall` 没有该选项，`rule_book` 也没有（`owner-profile-service.ts:78-84`、`production-memory-recall.ts:48-63`、`production-mcp-read.ts:963-988`） | **未接通**；需统一 gate |
| 每-agent “先问/直接存/暂停/撤销” | 方案第 1/3 节 | 身份是自称的客户端名（ADR 0227:115）；台账/记录也用同名 | **不可靠**；需服务端 agentId/凭据 |
| 删除/拒绝编号列表 | 方案第 3 节 | 返回给当前 sync 客户端；没有按 agent 命名空间过滤或内容哈希 | **可能跨 agent 误删** |
| 项目名 | 方案第 3 节 | 若用于存储分区/文件路径/UI/周报，没有规范化、长度、字符集 | **未校验**；需 machine string/服务端项目 ID |
| 批次/全量数据 | 方案第 3 节 | `MCP_READ_BODY_LIMIT=65_536`（`production-mcp-read.ts:90`），单条 2000 字（writer:26） | **会 413**；需分片/上限/逐条结果 |
| `start_here` 合并输出 | 方案第 2 节 | 客户端/钩子结果大小限制、`maskForExternalRead` 的共享 tag 顺序（read:247-256、redaction:552-568） | **可能被截断/字节不稳定**；需总上限+独立遮盖 |
| `start_here` 复用 `compose` 返回值 | 方案第 2 节 | `payloadRef`/`memoryIds` 内部字段（owner-profile-service.ts:33-45、359-387） | **可能泄露内部 ID**；只投影文本 |
| “接入的 agent”记录 | 方案第 1 节 | 自动按自称名创建，无上限/稳定 ID；UI/台账/统计都用它 | **可刷记录/改名漂移**；需服务端 agentId |

结论：方案里“服务端只做校验”这句话不成立；目前至少三个新值会直接过不了现有合约（稳定编号、rule 类别、trigger/project 参数），还有几个值没有消费端校验。建议先做一张“值—生产者—消费者—校验—门槛”表，再动工；这正是 I-73 的教训，不能只看改动本身。
