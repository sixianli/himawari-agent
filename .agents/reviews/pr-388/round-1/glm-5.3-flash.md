现在我读取关键源文件进行验证。
现在我来检查应用包中的 `parseOwnerRuleParameters`，以及 `#proposeMemory` 是如何计算其 `argsHash` 以进行对比的。
我先检查一下 `normalizeProposalText` 和 `ready()` 方法，并验证 ADR 0226 的 premise 6 行引用。
# 复核报告：PR 388（d590e1b6）外部 agent 经 MCP 提议邮件长期规则

## 发现的问题（按严重度从高到低）

**1. 低 | packages/prompt-catalog/src/tools.ts:466（`MCP_PROPOSE_RULE_INVALID` 文本）**
问题：回给外部 agent 的「参数不合法」文本说「每项 1 到 64 字」，但解析器对 `phrases`/`excludePhrases` 的下限是 2 字。
证据：tools.ts 里 text 为「…params 至少给一项条件，每项 1 到 64 字、每列最多 32 项…」；`packages/application/src/rules/rule-types.ts:61` 是 `const PHRASE_MIN = 2;`，第 80-83 行 `const minimum = PHRASE_KEYS.has(key) ? PHRASE_MIN : 1;`。1 字短语会被拒但提示说合法，外部 agent 可能反复重试。测试用例（mcp-write.test.ts 的拒绝列表）也没有 1 字短语这一反例。
建议：把文本改成「每项 1 到 64 字，词语类每项至少 2 字」，或放宽解析器，并补一条 1 字短语的反向用例。

**2. 低 | apps/agent-service/src/production-mcp-read.ts:541-543、production-mcp-rule-writer.ts:72、77、92-97**
问题：规则流程的失败分支全部没有测试覆盖。`catch` 返回 `MCP_PROPOSE_RULE_FAILED`、`accept` 里 `MCP_RULE_PROPOSAL_NOT_STORED` / `MCP_RULE_NOT_ACTIVE` 两个防御性 throw、标记写入的 `PORT_ERROR_CODES.DUPLICATE` 吞掉分支，都无用例走到。
证据：test/integration/mcp-write.test.ts 新增的 5 条规则用例里没有任何让 `accept` 抛错或让标记写入冲突的安排；对比 memory 流程有「拒绝记录写不进去时回错误」的用例（同一文件既有部分）。
建议：至少给「生效时规则写入失败 → 回 MCP_PROPOSE_RULE_FAILED 且不写标记」补一条用例。

**3. 低 | apps/agent-service/src/production-mcp-read.ts:489-491**
问题：`argsHash` 直接 `JSON.stringify(parsed.params)`，靠 `parseMailMatch` 的固定键序和排序来保证稳定，但规则流程没有像 memory 流程那样有「参数键序不同算同一提议」的反向用例。
证据：memory 的 hash 只含 text/category（production-mcp-read.ts:619-621），规则的是 `[\"propose_rule\", parsed.type, parsed.params, parsed.summary, reason]`；键序稳定性完全依赖 `rule-types.ts:109-115`（固定键序构造）和第 71-87 行（去重排序）。我读代码确认行为正确（推测成分：未实际运行验证）。
建议：补一条同参数不同键序算同一提议的用例，把对解析器实现顺序的隐式依赖变成被守护的契约。

**4. 低 | apps/agent-service/src/production-owner-rules.ts:501-515**
问题：ADR 0226 决定 3 说「同一组参数已有规则时，返回那一条并重新确认」，MCP 路径走到 `#activate` 的 `same` 分支（含 `reconfirm`）没有任何测试。
证据：`#activate` 里 `same` 找到后调 `reconfirm(same.ruleId)` 并返回 `ruleId: same.ruleId`；mcp-write.test.ts 新用例全部走新建分支。
建议：补一条「第二次提议同参数、不同提议编号 → 复用已有规则且只有一条」的用例。

**5. 信息 | packages/prompt-catalog/prompt-manifest.json:309-324**
问题：`mail.judgment.recent-summaries-header` 条目只是按字典序移位，sha256 未变。
证据：diff 中该条目原样搬动，sha `b271c465…` 不变；消费方 `apps/agent-service/test/prompt-catalog.unit.test.ts:184` 用 `manifest[entry.id]` 对象查找，与键序无关。无实际影响，应是补齐排序。

**6. 信息 | apps/agent-service/src/production-mcp-read.ts:497**
问题：规则提议的「就绪」检查借用 memory 写入器的 `proposals.ready()`（只查记忆册 latestGeneration）。语义上成立（`#activate` 写记忆也依赖记忆册，`RULE_MEMORY_NOT_READY`），但这是隐式耦合，规则没有自己的 ready。仅记录，不要求改。

**未核实**：`.claude/rules/prompt-prefix.md` 在仓库里不存在（glob 找不到），规则原文没读到，只能按题面转述理解；ADR 0213 第 61 行的引用原文没读，但「撤销后 confirm 会恢复」的实质我已从代码证实（见下）；service-main.ts:1810 一带把 `rules` 接进 MCP 写选项的这段真实接线，测试是直接构造 `ProductionMcpRead`，未核实是否有集成测试覆盖 `runAgentService` 的这段装配。

## 侧重检查（走过的一条普通流程）

外部客户端 → `POST /api/mcp/v1` → `registerMcpReadRoute` → `ProductionMcpRead`（写令牌 + 2026-07-28 版才注册 `propose_rule`，production-mcp-read.ts:415-419）→ `#proposeRule`（parse → 失败即 INVALID；通过 → mint requestState → elicitation 确认框）→ 主人勾选 → 客户端带 `requestState` 重发 → 验签、`#oneAtATime` 按提议编号排队 → 查 `#declinedRules` → `rules.decided()`（标记 + `storedFor`）→ `ProductionMcpRuleWriter.accept` → `create(inferred=true)` 存提议载荷 → `confirm` → `#activate`：写规则记忆（`memory:rule:mcp:<uuid>`）、写规则行（source=`mcp:claude-code`）、写加密标记 → 回 SAVED。
- 有测试覆盖：成功生效（含表达式命中断言）、拒绝/取消/没勾、非法参数、只读/老版本/不支持确认框、重发只生效一次、删标记后旧确认不复活、并发生效+拒绝两序。
- 无测试覆盖的路径（上面问题 1、2、4 列出的）：FAILED 分支、accept 两个防御 throw、标记 DUPLICATE 分支、`same` 参数复用分支、1 字短语反例。
- 文档核对：ADR 0226 引用的行号我逐个对了——`rule-types.ts:202/204/209`（RULE_TYPES 及两个类型，✓）、`production-owner-rules.ts:641`（`if (explicit) return this.#activate…`，✓）、`677`（confirm 返回 `#activate(proposal, null)`，✓）、`proactive-mail-check-service.ts:982`（`ruleHits[...] = [...new Set(ruled)].sort().slice(0, 16);`，✓）。prompt 目录门槛（prompt-catalog.unit.test.ts）要求每个发给模型的 prompt 都登记且带反向用例，新 13 条 prompt 已登记。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会（读代码证实）。改动集中在：外部 MCP 服务器新增工具（只对持有写令牌的 2026-07-28 版外部连接注册，production-mcp-read.ts:415-462，和 `propose_memory` 同门槛）；`ProductionOwnerRuleWriter` 的 `source` 是可选参数，chat 流程 `?? chat:<对话>` 的结果逐字节不变（production-owner-rules.ts:531）；`service-main.ts` 只是提取变量 + 接线，构造参数一字未改；prompt-manifest 只新增条目和一次无 sha 变化的排序移位，目录门槛测试（prompt-catalog.unit.test.ts:300-319）守护 sha 一致。发给 Himawari 自己模型的内容（系统提示、工具定义、历史、遮盖）没有触碰点；确认框和回执文字只发给外部客户端，不进 Himawari 的请求。

**2. 同一段文字会不会变成不同字节？** 规则提议流不会（读代码证实）：`argsHash` 虽用 `JSON.stringify(parsed.params)`，但 `parseMailMatch` 固定键序构造输出、列表去重排序（rule-types.ts:109-115），键序和重复项不影响字节；`reason`/`summary` 经 `normalizeProposalText`/trim 归一后才进 hash；生效后写下的记忆正文、规则参数、标记内容都与时间无关，且同一提议重放走 `decided()` 短路，不会重算。每轮会变的值（回放数字、createdAt）只出现在给主人的确认框和加密载荷里，不在任何发给模型的文本里。唯一遗留：`#declinedRules` 用 `Date.now()` 墙钟（production-mcp-read.ts:524），与注入 clock 的其余部分时钟源不同，进程内一致，风险可忽略。

**3. 有没有对应的自动检查、反向用例会不会真失败？** 有，且我逐条推演过失败路径（读代码推演，未实际运行）：「撤销后删标记重放旧确认仍不复活」——去掉 `storedFor` 这步，`decided()` 变 false，重放会走到 `#activate`，其中 `rules.read`（sqlite-owner-rule-operations.ts:95-102，无 status 过滤，含 retired）读到旧规则、`#reviveMemory` 恢复归档记忆、`rules.create` 返回 `replayed` 后 `setStatus active`（production-owner-rules.ts:539-556），规则复活，用例断言 `status === \"retired\"` 必然失败；「去掉内存拒绝记录」——decline 先到、accept 后到那一序里，accept 会保存成功，texts 变成 `[DECLINED, SAVED]` 而用例按 kept 期望 `[SAVED, ALREADY_SAVED]`，必然失败（accept 先到的另一序不依赖拒绝记录，靠标记，也算自洽）。参数校验反向用例（空 params、换行、不可见字符、超长 reason）也都存在。缺口见问题 2、3、4 条目。

**4. 每个产生/使用的值两端都核对了吗？** 逐个核对（读代码证实）：
- 工具名 `propose_rule`：注册端 modern+写令牌门槛（:415-419），`MCP_WRITE_TOOL_NAMES` 只被测试用；测试验证只读/老版本调不到。
- `ProposalState.tool` 扩为两值：两端各自严格校验 `propose_memory`/`propose_rule`（:638、:509），且 argsHash 首元素带工具标签，篡改状态跨工具用会被「内容变了」拒。
- key `mcp:<uuid>` → ruleId `owner:<24hex>`：通过后端校验 `/^owner:[A-Za-z0-9_-]{1,58}$/`（sqlite-owner-rule-operations.ts:8）；memoryId `memory:rule:mcp:<uuid>` 通过 `/^[\\x21-\\x7e]{1,128}$/`（:9）；source `mcp:<client>` 激活时 `.slice(0,256)`，通过 `length 1..256` 校验（:123-124）。
- 标记 `rule-decision:mcp:<uuid>`：只被 `decided()` 读，put 的 DUPLICATE 分支已吞；ref 以 `rule-` 开头，与测试的查询口径一致。
- `storedFor` 的 ruleId 推导与 `#activate` 第 496 行完全一致，`read` 含 retired（:95-102 无 status 过滤），保证「含已撤销」。
- 新 prompt id：全部登记进 manifest，只被 production-mcp-read.ts 使用；INVALID 文本与解析器有一处不符（问题 1 条目），是唯一两端不一致的值。
