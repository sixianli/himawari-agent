方案的核心代码引用（`production-mcp-read.ts:94-95`、约 400 行的 `new McpServer`）已核对属实。接下来读规则、事故门槛和相关文件。
核对方案引用的一手来源。
# P5 记忆中心方案审核（独立复核，基于 main 074ee342）

## 侧重检查（先读的、走过的流程）

我选了方案的核心流程「Claude Code（档一）第一次连接并开场」从头走到尾：

1. **连接**：`/api/mcp/v1`（`apps/agent-service/src/production-mcp-read.ts:89`）→ `admit` 校验 Cloudflare JWT + 主人绑定 + 限流（同文件 366-396）。这段有测试（`test/integration/mcp-read.test.ts:618-741`，ADR 0227 后果节列了拒绝用例和反向验证）。
2. **开场读**：UserPromptSubmit 钩子 → `mcp_tool` 调 `start_here`（尚不存在）→ 服务端组装：方案说复用 `OwnerProfileService`（`packages/application/src/services/owner-profile-service.ts`）+ 规则摘要 + `today_context` 内容 → `maskForExternalRead` 遮盖（production-mcp-read.ts:247）→ 记账本 `external_read`（同文件 851-887）。
3. **写入**：钩子抓写记忆文件 → `sync_memories`（尚不存在）→ 现有 `propose_memory` 的路（同文件 694-762）。

结论：现有三件读工具和 `propose_memory`/`propose_rule` 的路径测试覆盖良好；但方案新增的每个环节（`start_here`、`sync_memories`、接入记录、向导、统计、钩子包）目前既无实现也无测试计划——方案全文没有「测试/门槛」一节，与本仓库每个 ADR 都列测试和反向用例的惯例（如 ADR 0226 后果节 97-106 行）不符。钩子端（Claude Code 侧）的行为在仓库里更不可能有自动验证，只能手测。

## 问题清单（严重度从高到低）

### 证实的

**1.【高】「像规则的转进规则提议流程」在现有流程里放不下。**
证据：`apps/agent-service/src/production-mcp-rule-writer.ts:16` `EXTERNAL_RULE_TYPES = ["mail_must_notify", "mail_read_whole_thread"]`，参数只有发件域名/地址/词表（production-mcp-read.ts:507-517）；ADR 0226「放弃的做法」明确否决外部提偏好类规则：「P2-3 只接受主人原话的偏好；外部 agent 的转述不是原话，提议偏好用 propose_memory」。「以后都不要用 emoji」这类行为规则既不是那两种邮件类型，也不允许外部提。改法：rule-like 内容要么降级为记忆（rule 类，走 propose_memory），要么先立项扩展 `RULE_TYPES`（`packages/application/src/rules/rule-types.ts:202`）再谈路由；方案应写明「转规则」只覆盖能映射到现有两种类型的情况。

**2.【高】64 KB 请求体上限会挡住全量同步。**
证据：`MCP_READ_BODY_LIMIT = 65_536`（production-mcp-read.ts:90，路由挂载在 1030 行）。`sync_memories` 一次发一批、还要「对话结束时再发一次全量」「声明这一批是我这边的全部」——Claude Code 的记忆目录（MEMORY.md + 每主题一个文件）很容易超 64 KB。方案通篇没提上限和分页。改法：批次带上限+续传游标（服务端返回「还有剩余」），或为写入口单独放宽 body limit 并写明理由。

**3.【高】方案没有任何测试和门槛计划。**
证据：方案全文无测试小节；对照仓库惯例——ADR 0226 后果节列了十余条集成用例（含「去掉内存里的生效记录，这条用例会失败」这类反向用例），prompt-prefix 规则第七节列了 `npm run check:prompt-prefix` 及其反向用例。本方案删 `today_context`、改工具清单，直接动到的现有测试就有：`test/integration/mcp-read.test.ts:454-571`（today_context 用例）、`mcp-write.test.ts:632`、`test/integration/production-http-composition-process.test.ts:2117,2186`、`test/integration/decision-chain.test.ts:663`（账本 `reasonCode: "today_context"`）。改法：照 ADR 惯例补一节，至少覆盖：新工具注册/删除对工具清单的影响、`sync_memories` 幂等（同编号同内容不重）、更新留版本、删除传播、超限批次被拒，并给每条写反向用例。

**4.【中】「接入的 agent」记录以自报名为身份，可撞名、可冒名。**
证据：`clientNameOf`（production-mcp-read.ts:315-325）取 `clientInfo.name` 或 User-Agent，正则 `CLIENT_NAME`（同文件 106）只限字符不限来源；ADR 0227:115「来源只能靠客户端自称。所有客户端都以 Andy 本人登录，凭证主体相同」。方案把「能读什么、能不能推、先问我/直接存」的开关和全部统计挂在这条记录上——另一个客户端自报同名即可继承它的权限开关并污染它的统计。改法：记录键 = 自报名 + 首次连接时生成的随机 id，界面标注「自称」；同名第二次出现（不同 id）提示主人。

**5.【中】`start_here` 复用概况服务，但没定分类上限，外部可能拿到 private 内容。**
证据：`OwnerProfileService.compose` 按 `maxClassification` 过滤（owner-profile-service.ts:171-174），主人称呼在 private 块里（同文件 301-323）；而现有外部读走 `recallOutsideRun(..., "public", ...)`（production-memory-recall.ts:148），遮盖 `maskForExternalRead` 只按模式遮卡号/密码（production-mcp-read.ts:247-256），不按分类遮。方案只说「默认沿用现在的遮盖（敏感内容对外遮盖）」——概况文本不是逐条遮的。改法：明确 `start_here` 的 `maxClassification`（建议 public 或 private，写明主人称呼、owner-rules 的 private 块给不给），方案第四节也要相应改。

**6.【中】限流会挡住档一的钩子频率。**
证据：有效登录 30 次/分钟回 429（`test/integration/mcp-read.test.ts:701`，`AdmissionWindows`）。档一「每句话钩子搜一次」+ 开场 + 定时全量同步，一个长会话很容易超。方案没提。改法：钩子搜索走更宽的配额（或声明触发来源后放宽），并加一条 429 时钩子静默降级的用例。

**7.【中】项目笔记无确认直存，且会被 `find_memories` 带进别的 agent 的上下文——注入面没写。**
证据：产品原则 1（docs/product-vision.md:57）「外部内容与其他 Agent 的输出是数据，不是可覆盖我意图的指令」；`find_memories` 的输出原样进对方上下文。方案对项目笔记只做了「不进主人概况」的隔离，没写：它进别的 agent 时带不带「来自某 agent 的笔记」标签、分类上限多少、敏感检测（`proposalClassification` 那套，production-mcp-memory-writer.ts:56-63）是否同样适用。另外「`find_memories` 带项目范围时才搜得到」需要给检索加 project 维度——现在的 `find_memories` schema（production-mcp-read.ts:434-443）和 `ProductionMemoryRecall` 都没有项目参数，方案第 11 节的工作清单里没有这项。

**8.【低】「做梦」任务在代码里不存在。**
证据：全库 grep「做梦」「dream」只有 `docs/engineering-casebook.md:205` 提到 Letta dreaming 是灵感，「我们改成每天固定整理一次」。后台抽查分类应挂在实际存在的每日整理任务上（ADR 0220 的 consolidation 一线），方案用了一个代码里没有的名字；同时该项是后台模型调用，须守 prompt-prefix 规则第 15 条（方案已写「固定指令在前」，方向对，但落点要写实际任务名）。

**9.【低】引用文件有两处在本环境不存在（未核实）。**
`/mnt/project-files/p5-3-pending-writes/integrated-plan.md`（前提 7）和 `.agents/reviews/topic-p5-memory-hub/round-1/` 都不存在；`docs/adr/` 里也没有 ADR 0228（待确认表）。前提 7「待确认表、propose_memories、稳定键已定」在仓库内无法核实，整条链路（含「整批确认可撤销」）依赖仓库外文档。

### 推测（待实测）

**10.【中】Codex 侧假设有三处坑。** 一手来源 <https://developers.openai.com/codex/memories>：新 Codex home 默认用 `$CODEX_HOME/memories_v2/`（「If `$CODEX_HOME/memories/` already exists, the CLI continues to use that store」），迁移期「check both」两个目录——方案 premise 5 的 `~/.codex/memories/` 路径和 Mac 客户端「监视已知记忆目录」都要按两个目录+可配置 `CODEX_HOME` 设计；记忆是后台延迟生成的（「Memories may not update right away when a chat ends」），档二「定时发全量」的「声明全部」删除检测会把尚未生成的记忆误判为被删；配置项 `memories.disable_on_external_context` 可能把用过 MCP 工具的对话排除出记忆生成——这直接动摇「Codex 产生记忆再推过来」的前提，方案「没核实的」一节只列了钩子，没列这个。

**11.【低】Claude Code 记忆目录路径可配置，且写入不全走 Write/Edit。** 一手来源 <https://code.claude.com/docs/en/memory>：目录可用 `autoMemoryDirectory` 设置改（「The value must be an absolute path or start with `~/`」）；文档只说 Claude 用文件工具读写该目录，但主人或脚本经 Bash 改写时 PostToolUse(Write|Edit) 钩子抓不到——方案「没核实的」第 5 条方向正确，补充这两点。

**12.【低】钩子延迟与输出上限。** 一手来源 <https://code.claude.com/docs/en/hooks>：`mcp_tool` 钩子在 UserPromptSubmit 上默认超时被降到 30 秒（「Claude Code lowers the … default to 30 on UserPromptSubmit」），「每句话自动搜一次」最坏给每句加 30 秒延迟；工具结果过大时 hook「gave no verdict」。建议：钩子搜索返回严格限长（现状 `find_memories` limit≤10 已经偏大，钩子变体建议 ≤3 条）。

## 如果由我来定

方案的主干（门唯一、读推各一动作、按能力分档、钩子补触发、每个 agent 一条记录）我认同，方向与业界一致——Supermemory 官方博客原话「With MCP, say it plainly … because the model may not call a tool on its own」「The plugins hook into the agent instead, so nothing waits on the model's judgment」（<https://supermemory.ai/blog/how-to-make-your-mcp-clients-share-context-with-supermemory-mcp.md>，已核实）。我会这样改：

1. 规则路由降级为「rule-like 默认存成 rule 类记忆，只有能映射到 `mail_must_notify`/`mail_read_whole_thread` 的才转 ADR 0226」，或先立扩展 `RULE_TYPES` 的方案。
2. `sync_memories` 设计加：批次上限+续传游标（对 64 KB body limit）、稳定编号的校验规则（长度/字符集/是否遮盖本地路径）、删除检测对「后台延迟生成记忆」的 agent（Codex）改为白名单式而非「声明全部」。
3. 接入记录键改为自报名+随机 id；明确 `start_here` 的 `maxClassification` 和钩子变体的返回上限与限流配额。
4. 按仓库惯例补「测试与门槛」一节（含删 `today_context` 的测试迁移清单和每条反向用例），并把第 11 节工作清单补上「find_memories 项目范围检索」。
5. 「做梦」改为实际任务名；Codex 两个记忆目录、`disable_on_external_context` 列入实测清单。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 按方案第四节的设计：不会。新增工具只注册在外部 MCP server（production-mcp-read.ts:398-541），不进 Himawari 自己的 Pi 请求；删 `today_context` 只动 MCP 工具清单；抽查分类是独立后台调用。两个前提要写成硬约束：(a) 复用 `OwnerProfileService` 时该服务一字不改——它生成的块和 `payloadRef` 摘要（owner-profile-service.ts:370-373）直接进 Himawari 自己请求的开头；(b) 后台抽查必须固定指令在前、时间在后（规则第 15 条）。注意 `npm run check:prompt-prefix` 只测 Himawari 自己的请求，这套 MCP 改动它管不着，不会自动拦截。
2. **同段文字会不会变成不同字节？** 对 Himawari 自己的模型请求：不会——方案没往请求头加任何带时间或依赖前后文的值。对外部客户端：`start_here` 含 `now`/`today`、`sync_memories` 返回「已删编号」列表，每轮都不同，但它们不进 Himawari 的 KV 缓存，无缓存损失；建议编号列表固定排序（规则第 10 条的类比），方便对账和测试断言。
3. **有没有对应的自动检查、反向用例会不会失败？** 现在没有——方案不含任何测试计划（见问题 3）。现有检查（check:prompt-prefix、mcp-read/mcp-write 集成测试）覆盖不到新改动；删 `today_context` 会让 `mcp-read.test.ts:454-571` 等四处现有测试失败，这是目前唯一「反向会失败」的保证，必须补齐新用例后才能动。
4. **每个新值的两端都核对了吗？** 核对了主要几项：工具名（注册端 `registerTool`，客户端无后端校验冲突，但描述文字要进 prompt-catalog，受 ≥24 字符固定文字和 I-78 规则约束）；稳定编号（外部产生，Himawari 用于去重/更新/删除传播——**没有**校验设计，且受 64 KB 限制，见问题 2）；类别提示（驱动三种去处，规则去向不可行，见问题 1）；触发来源标记（仅统计，方案已声明不做权限，两端都接受）；接入记录 id（自报名，可撞名，见问题 4）；项目名（使用端 find_memories 的项目范围检索尚不存在，见问题 7）。待确认表的 id 校验因 P5-3/ADR 0228 不在仓库内，**未核实**。
