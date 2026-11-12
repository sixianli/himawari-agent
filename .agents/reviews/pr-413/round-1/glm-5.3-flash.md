# 复核结论（PR 413 / P5 任务 A：外部 agent 读记忆）

## 按严重度排列的发现

**1.（中）production-mcp-read.ts:118,1027 + production-memory-recall.ts:260 — readCeiling 只约束 start_here 的 profile 段，find_memories 仍可把 sensitive 级记忆给外部 agent**
- 证据（读代码证实）：`START_HERE_DEFAULT_CEILING: DataClassification = "private"`（production-mcp-read.ts:118），只在 `#startHere` 里用于 profile 来源（:1027）；而 `recallOutsideRun` 走 `isModelVisible(memory.dataClassification)` 过滤，`modelVisibleClassifications()` 含 `"sensitive"`（model-visibility.ts:10-18，production-memory-recall.ts:260）。也就是说，新参数造成的“默认 private”保护是单工具的：同一次会话里外部 agent 用 find_memories 仍能取到 sensitive 级内容。这不是本次引入的回归（find_memories 行为没改），但容易让人误读为整个对外读取被限到 private。作者“重点请看”里问“敏感级别是否会越过上限”——答案：走 find_memories/today_context 可以越过 start_here 的上限。
- 建议：在 ADR/服务说明里写明 readCeiling 的适用范围，或后续把上限应用到全部读工具。

**2.（中）production-mcp-read.ts:1049-1051 — 作者说法“规则摘要只列正在执行的主人规则”与代码不符**
- 证据（读代码证实）：`enforcedOwnerRule` 内部用 `enforceableOwnerRule`，它只排除 `status === "retired"`（rule-types.ts:300-311），`needs_review` 的规则照样列出。集成测试自己就期待 needs_review 的 `owner:a-refund`（“退款邮件先读完整串”）出现在 `rules.items` 里（test/integration/mcp-read.test.ts:845 一带，种子里 status 是 "needs_review"，:160-168）。“正在执行”应为“未撤销且能解析的规则”。
- 建议：修正说法，或在摘要里标注该规则处于 needs_review。

**3.（中低）production-mcp-read.ts:1003,1036-1042 + test/integration/mcp-read.test.ts:194 — “保证同一份数据两次 start_here 字节相同”的说法过强**
- 证据（读代码证实）：today 段带 `now`（:1003），生产时钟每次调用都变，所以整份响应两次调用不会逐字节相同；测试里 `const clock = new ManualClock(NOW)`（mcp-read.test.ts:194）是冻结时钟，才让 `expect(second.text).toBe(first.text)` 成立。另外遮盖是全量批内互相影响的（`maskForExternalRead` 把整个输出一起交给 `maskSensitiveTexts`，:264-273；redaction.ts:552-568 共享点名值），当 today 的新提醒点名了一个值（如验证码），profile/rules 段里同一个值的字节也会跟着变——这是 ADR 0219 决定 4 接受的行为，但与“前两段固定”并读时要说明。
- 建议：把说法改成“排序固定、同一份数据+同一时刻字节相同；遮盖可因 today 点名值牵连固定段”。给“遮盖牵连改变 profile 字节”补一条集成用例（现在只有 unit 层的 [P5-A]）。

**4.（低）production-mcp-read.ts:1026-1030,855-878 — profile 来源失败的路径没有测试**
- 证据（读代码证实）：profile 来源抛错会沿 `#call` 的 catch 变成整工具失败（`MCP_TOOL_RESULT_FAILED` + 决策记录 `start_here_failed`），没有“profile 段缺失、today 照常”的降级；`sources.profile` 未接线时静默返回空 profile（`outline?.… ?? 空`，:1029-1034）。行为本身合理（fail-closed），但没有用例覆盖。
- 建议：补一条 profile 来源抛错的用例，断言返回 isError 且 ledger 记 `start_here_failed`。

**5.（低）service-main.ts:2254-2283 — 生产组合根里的 profile 接线没有任何测试走到（侧重检查发现）**
- 证据（读代码证实）：集成测试的 profile 来源是测试里另写的一份平行副本（mcp-read.test.ts:326-333，readText 缺 payload 时**抛错**），而生产接线（service-main.ts）的 readText 是**吞错返回 undefined**、还多了 `contentType !== "text/plain"` 分支和解码 try/catch——这些分支在仓库里找不到覆盖。两份实现已经出现行为分歧（失败语义不同）。
- 建议：把 profile 来源的构造提取成可复用函数，测试直接用生产版。

**6.（低）production-mcp-read.ts:1004-1011,976-978 — 新增的排序没有专门的顺序断言**
- 证据（读代码证实）：reminders 排序（并列 dueAt 时靠 remindAt/text/memoryId 决胜负）和 recentDays 排序是本次新代码，现有测试没有构造并列键的数据，排序逻辑实际未被区分性验证（同数据两次调用相同字节的断言在冻结时钟下对任何顺序都成立不了差别——因为同一次调用的数据不变）。
- 建议：加一条并列 dueAt 的提醒用例，断言输出顺序。

**7.（低，措辞）作者说法“每段有字数预算”对 today 段不成立**
- 证据（读代码证实）：profile 2000 字（owner-profile-service.ts:14）、rules 1200 字（production-mcp-read.ts:115）有预算；today 段只有 48 小时窗口和 8 条摘要上限（:112-114），没有字数预算。另外规则预算记账 `[...summary].length + 3`（:1056）与实际 JSON 数组渲染不符，只是近似。`sync_memories` 没写进 start_here 文字——这条说法与代码一致（tools.ts 里 start_here 描述无此句）。

**8.（信息，推测部分已证实）auto 的运行时类型校验实际不可达**
- 证据（读代码证实）：MCP schema 已把 `auto` 限为 boolean 且 `additionalProperties: false`（:468,471），运行时 `throw new Error("MCP_FIND_AUTO_INVALID")`（:924）正常到不了；“rejects a non-boolean auto” 用例在改动前的代码上也会因 schema 拒绝而通过，它证明的是 schema，不是这条新校验。防御性代码，无害。
- 另（读代码证实）：unit 的跨字段遮盖测试把值同时放进 profile 和 reminder 两处，不能唯一证明“只在 today 点名也会遮 profile”这一个方向；不过 `maskSensitiveTexts` 的实现（整批共享 known/tags，redaction.ts:552-568）保证了该性质。

**未核实**：prompt-manifest.json 里 6 个条目的 sha256 具体值（无法运行命令计算）；但清单一致性有自动检查守着（apps/agent-service/test/prompt-catalog.unit.test.ts:187 `PROMPT_MANIFEST_STALE`，改文字不更新清单会失败，且带反向用例），工具描述属 tools 层还会被 `volatileProblems` 查日期/哈希（:197-209）。@modelcontextprotocol/server 库内部如何暴露 instructions 未读（node_modules），但集成测试断言 `client.getInstructions()` 含 "start_here" 能兜住。

## 侧重检查

走过的普通流程：外部 agent → HTTP POST `/api/mcp/v1`（registerMcpReadRoute，production-mcp-read.ts:1136-1176）→ `admit`（JWT 验证+绑定检查，:387-417）→ initialize（instructions 固定文字，:424）→ listTools（固定顺序 start_here 在前，:100-105,478）→ tools/call start_here → `#call` → `#startHere` → profile 来源（**service-main.ts:2254-2283，生产组合根，无测试**）→ `maskForExternalRead` → 决策记录 `#record`（external_read/start_here/六项摘要字段）→ 纯文本响应。处理层以上全部有集成测试覆盖（[P5-A] 7 例，真实 SQLite、真实 OwnerProfileService、真实 ledger 校验）；缺口见第 4、5、6 条：生产 profile 接线、profile 失败路径、排序断言。find_memories 的 auto 流程：schema 校验 → `#findMemories` 剥离 auto 并压 limit（:923-935）→ recall 白名单（production-memory-recall.ts:107-109，不认识的参数会被拒，作者说法属实）→ 空结果去 note（:947-955）→ 有专门正反用例。

## 必答问题逐条

1. **不会。** 读代码证实：改动只涉及对外 MCP 读服务、service-main.ts 的 MCP sources 接线、以及 `mcp.*` 前缀的提示词；grep 证实这些提示词只在 production-mcp-read.ts 使用，Himawari 自己发给模型的系统提示、历史、工具冻结没有变。对外新增的内容（instructions、start_here 工具、结果）都是新追加；工具描述文字变了（find_memories/today_context），那是发给外部 agent 的定义，不属于 prompt-prefix 规则管辖的“发给模型的请求”。start_here 结果里每轮会变的值（`now`、`today`）都在最后一段 today 里；系统提示和工具描述里没有会变的值（volatileProblems 自动守着）。
2. **部分。** 列表排序已固定（reminders 按 dueAt/remindAt/text/memoryId，recentDays 按 day/id，规则按 ruleId），没有无序集合；遮盖编号会被去掉（redaction.ts:567）不影响字节。但注意两点（见发现 3）：整份响应含每次都变的 `now`，“两次调用字节相同”只在同数据同时刻成立；遮盖是全量批内互相影响，today 点名值会牵连 profile/rules 的字节（ADR 0219 决定 4，同一份数据内仍确定）。
3. **有，但有缺口。** 集成 [P5-A] 7 例（含 2 个真反向用例：auto 无关问题无 note、无敏感内容原样返回）、unit [P5-A] 2 例（含 1 反向）、清单哈希有自动检查+反向用例。缺口：profile 失败路径无用例；“rejects a non-boolean auto” 在旧代码上也过（测的是 schema 不是新校验）；排序无顺序断言（发现 6）；生产接线无用例（发现 5）。
4. **逐值核对均一致（读代码证实）。** `start_here` 工具名：注册处与 MCP_READ_TOOL_NAMES 及两个测试文件一致；`reasonCode: "start_here"/"start_here_failed"` ↔ 校验端只限 1..64 字符（sqlite-decision-ledger-operations.ts:61），outcome `"read"` ∈ external_read（decision-ledger.ts:58）；memoryIds 上限 200 + 去重（production-mcp-read.ts:1070-1078）↔ `MAX_IDS=200`、去重、每项 1..256（:33,44-51,66-67），两端一致；`auto`：MCP 层剥离后才转发 ↔ recall 白名单会拒未知参数；`readCeiling`：内部 option，默认 private，服务端未从配置传入（与“先留出参数”说法一致），越界值不会崩（NaN 比较导致全部过滤）但也不报错；4 个新 prompt id + 2 个更新 id 在清单里有行，一致性由自动检查守着（具体哈希值未核实）。未发现“只在一端认”的值；最接近的是发现 1（readCeiling 单端收紧造成的保护不对称，属策略而非校验问题）。
