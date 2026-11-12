现在我来根据代码核对 ADR 0242 中的前提。
现在我来检查一下关于 masking 的声明（decision 14 对比现有的 ADR 0219 text），因为这两者可能存在冲突。
# 复核报告：PR 411（ADR 0242 + 四处 ADR 补注 + 案例 91）

## 侧重检查（走过的流程与结论）

我走的是「外部 agent 调 `find_memories`」这条最普通的流程，并把它当作文档正确性的对照物：

1. 入口 `/api/mcp/v1`（`apps/agent-service/src/production-mcp-read.ts:89`）→ Cloudflare Access 校验 + 主人核对（ADR 0227，声称由 `test/integration/mcp-read.test.ts` 把关，本次未重跑）→ `MCP_READ_TOOL_NAMES`（production-mcp-read.ts:94-95）→ `recallOutsideRun`（`apps/agent-service/src/production-memory-recall.ts:144-149`，传 `"public"` 作请求分级）→ `allowed = modelVisibleClassifications()`（production-memory-recall.ts:185）→ 输出分级 `highestClassification(requestClassification, …)`（production-memory-recall.ts:333）→ `maskForExternalRead`（production-mcp-read.ts:247-256）→ 决策记录。**本 PR 没改任何代码，这条路径一个字节没变，测试覆盖情况也没变。**
2. 文档本身的“使用流程”是：后来的编码线程读 ADR 0242 → 按后果一节的分工做编码任务 → 任务清单在 `/mnt/project-files/p5-memory-hub/coding-tasks.md`。**该清单在仓库外，本次环境读不到，其存在与内容未核实——这是“让后来线程照着做”的唯一悬空点。**
3. 作者的检查声称：`validate_docs.py` 不在仓库内（外部技能，见 docs/adr/0133 第 2 条的描述），无法复跑；7 个具名 check 脚本（check-glossary.mjs、check-markdown-tables.mjs、check-adr-numbers.mjs、check-docs-links.mjs、check-instruction-links.mjs、check-incident-gates.mjs、check-format.mjs）在 `scripts/` 下确实存在。作者声称的输出结果均未核实（我不能运行命令）。
4. `.agents/reviews/topic-p5-memory-hub/` 的文件结构（两个模型 × 两轮 + prompt + usage.jsonl）与作者描述一致（git diff stat 可见），但**内容被复核环境拒绝读取（`REVIEW_GIT_REFUSED records-path`），讨论记录、`0.26 美元`、“六处会出错”均未核实**。

## 发现的问题（按严重度排列）

### 1.（中）ADR 0242 决定 14 的动机句与代码现状不符，且与所注条目的保留原文自相矛盾

- **文件：行**：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:148`；`docs/adr/0219-read-only-mcp-entry-with-static-token.md:76`
- **问题**：决定 14 说“现在整份输出共用一套占位编号，前面多一个敏感值，后面的编号全变”；0219 的补注说“因为一起遮时前面多一个敏感值，后面的占位编号全变”。但代码里占位编号**在发回外部之前就被剥掉了**，外部看到的占位符不带任何序号，所以“前面的值变了→后面编号变”在外部输出上根本观察不到。
- **证据**（读代码证实）：
  - `packages/sensitive-capture/src/redaction.ts:65`：`export const EGRESS_PLACEHOLDER_PATTERN = /\[(密码|验证码|证件号|银行卡 尾号\d{4})#([a-z]{8})\]/gu;`
  - `redaction.ts:566-568`（`maskSensitiveTexts`，即 MCP 对外路径用的函数）：`return inputs.map((input) => redactForEgress(input, options).text.replace(EGRESS_PLACEHOLDER_PATTERN, "[$1]"))` —— `#编号` 被替换掉，最终输出是 `[密码]` 这类纯类别占位符。
  - `apps/agent-service/src/production-mcp-read.ts:247-256`：`maskForExternalRead` 调的就是 `maskSensitiveTexts`。
  - 共用的编号只存在于中间过程（`redaction.ts:552-564` 的 `tags` Map），且同一值经 `known` Map 保持一致。
  - 更直接的矛盾：**补注正下方的保留原文**（0219 决定 4）写着“返回给对方的占位符只写类别（例如 `[密码]`），不带序号，所以同一段文字的遮法不随这次一起返回的其他无关内容变化”——补注在它底下说“编号全变”，两条并存，读者无法同时相信。
- **后果**：照决定 14 做的编码线程会发现“按字段各自编号”在当前输出上是无操作（编号本来就看不见），或者反过来把编号变成对外可见——后者是一个无人授权过的披露变化（外部客户端从此能数出一段输出里有几个不同的密码）。这正是作者请复核者查的“前提和代码现状不符”的一例。
- **建议**：改写决定 14 的动机句和 0219 补注，二选一：(a) 说明真正的耦合是整批遮盖的 `known` Map 让“前一段点名”决定“后一段遮不遮”（这确实随前文变化）；(b) 若意图是让占位编号对外可见以便区分同类别不同值，明说这是披露行为的变化，并把“同一份数据生成两次 `start_here`，字节相同”的反向用例与之对齐。

### 2.（低）ADR 0242 决定 6 声称取代 0225 决定 3，但 0225 决定 3 下没有补注

- **文件：行**：`docs/adr/0242-…md:95`（“取代 ADR 0225 决定 2、3 的提议方式”）；`docs/adr/0225-…md:62、77`（只有决定 2、6 有补注）
- **问题**：0242 说取代 0225 的决定 2 **和 3**，作者也只在决定 2、6 下补了注。决定 3（“同一个提议只写一次”，编号 `memory:mcp:<提议编号>`）被 `sync_memories` 的“同编号同内容不产生任何东西、同编号新内容算更新”取代——语义确实变了（从“只写一次”变成“可更新、留历史”）。后来的读者只看 0225 会以为决定 3 仍然有效。
- **证据**：0242:95 原句；0225 的 diff 只有两条新增注（决定 2 下、决定 6 下）。
- **建议**：在 0225 决定 3 下补一条注（指向 0242 决定 6），或把 0242 决定 6 的“决定 2、3”改窄为“决定 2”，二选一，保持两端一致。

### 3.（低）“决定编号对应关系”没有任何自动检查，本次恰好在这一处抓到实错

- **文件：行**：`scripts/check-adr-numbers.mjs:53-97`
- **问题**：check-adr-numbers 只查文件名编号、标题编号、ADR 链接和锚点，不查“注里引用的『决定 N』在目标 ADR 里是否真的存在/对应”。0242 后果一节列的“要补的自动检查”都是给未来编码任务的，不含这一条。作者声称跑过的 7 个脚本没有一个能拦住问题 1、2 这类错。
- **证据**：读 `check-adr-numbers.mjs` 全文，无任何决定编号校验逻辑。
- **建议**：给文档检查加一条：补注里引用的“决定 N”必须在目标 ADR 中存在且引语能在原文找到；反向用例（把编号改成不存在的值）必须失败。本 PR 我已人工核对全部 7 处补注的编号：0219 决定 3→(2,3,4)、决定 4→14、决定 5→(1,13)、0225 决定 2→(6,9)、决定 6→9、0226 决定 3→9、0227 后果→1，除问题 2 的覆盖缺口外**编号本身全部对得上**（读代码证实）。

### 4.（信息）案例编号 88→90 跳过 89

- **文件：行**：`docs/engineering-casebook.md:5606、5694`
- **证据**：`git log -S "案例 89" -- docs/engineering-casebook.md` 无任何提交，改动前已如此（读代码证实）。非本 PR 引入，只是新增 91 时顺着跳号的序列继续，建议顺手说明或补齐。

## 未核实项（推测/无法在本环境核实，非指控）

- 前提 2、3、4 引的 Andy 原话（`/mnt/project-files/...` 与线程记录）——仓库外文件。
- 前提 13、14、15 引的外部网址（code.claude.com、learn.chatgpt.com、developers.openai.com）——不能上网。
- `.agents/reviews/topic-p5-memory-hub/` 的讨论内容与 `usage.jsonl`（案例 91 的“0.26 美元”、“六处会出错”、“第 1/2 轮”）——复核环境返回 `REVIEW_GIT_REFUSED`。
- 作者声称的 `validate_docs.py --strict` 输出（13 条旧 Runbook 封存错误、前后相同）及 7 个 check 脚本的通过——不能运行命令。
- 愿景引文（前提 1、5、6）已逐字核实（`docs/product-vision.md:57、58、61`）；代码类前提 7-12、16-19 已逐字核实，**包括作者特别点名的前提 9：`recallOutsideRun` 传的 `"public"` 确实只是输出分级下限（production-memory-recall.ts:148、333），检索侧 `allowed` 确实含 sensitive（production-memory-recall.ts:185 + model-visibility.ts:10-14）——这条说法准确**。

## 必答问题逐条回答

1. **会不会改变模型已经见过的请求开头？** 不会（读 diff 证实）：全部改动是 5 份 docs markdown 和 `.agents/reviews/` 记录，没有碰任何构造请求的代码、提示词目录（`packages/prompt-catalog` 未变）、工具定义或遮盖代码。`.agents/` 下的 prompt 文件是当时跑两个复核模型的存档，不是 Himawari 运行时请求的一部分。ADR 0242 自己声称“Himawari 自己发给模型的请求不变”与其决定内容一致：新工具只注册在对外 MCP 服务、`OwnerProfileService` 复用不改、待确认和项目笔记不进自己的请求（决定 2、6、8、9 及后果一节）。每轮会变的值仍都在最后一条消息——本 PR 未触及该机制。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。改动全是静态文本，日期是固定字符串（“2026-11-12 起”），无时间戳、无依赖前后文的遮盖、无无序集合。`usage.jsonl` 是账本记录，不发给模型。
3. **有没有对应的自动检查、反向用例会不会失败？** 部分有：链接/锚点/表格/术语/ADR 编号类检查存在且覆盖了本 PR 的链接与表格改动（作者称已跑，我无法复跑）。**但“补注引用的决定编号”和“前提与代码一致”没有任何检查，也没有反向用例**——问题 1、2 正是从这个缺口里漏出来的实错，说明缺口是真实的。
4. **每个新值的两端校验都能接受吗？** 本 PR 没有产生任何进入代码的值（标识、配置键、清单项、序列化格式都不变），不存在需要核对后端校验的新值。文档层面新增的名字（`start_here`、`sync_memories`、参数 `project`/`auto`、“接入编号”）目前只在文档中，尚未进代码；ADR 0242 后果一节已把对应校验（含“把服务端生成编号换成直接用对方的编号，必须失败”、逐条正反向用例）列为动工前要补的检查，与 I-73 的教训对齐。文档引用的既有值（`MCP_READ_BODY_LIMIT = 65_536`、`AUTHORIZED_PER_MINUTE = 30`、`EXTERNAL_PROPOSAL_TEXT_MAXIMUM = 2000`、`machineString` 正则、`OWNER_PROFILE_CHARACTER_BUDGET = 2000`、`EXTERNAL_RULE_TYPES` 两项）逐一在源码核实，两端一致。

**总评**：文档质量整体高，引文核对纪律好；但决定 14 的动机句是一处与代码现状不符的陈述（还和它注解的原文互相矛盾），0225 决定 3 漏了补注——两条都建议合并前改掉。
