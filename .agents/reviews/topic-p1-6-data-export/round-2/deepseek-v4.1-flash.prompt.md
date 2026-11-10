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
仓库就是当前目录，已检出 fd283e437a172cfbe807dddaae5da674cc814c18。
待审核的方案：
问题、目标、验收要求、约束和已核对的事实见上一轮材料（同一议题 p1-6-data-export）。下面是线程的方案。

# P1-6 数据导出（数据可带走）：线程方案 v1

## 0. 对标和根因（项目规则要求先写）

**业界怎么做（一手来源）：**

| 对象 | 做法 | 来源和原话 |
|---|---|---|
| Claude 数据导出 | 整包一次性导出，邮件发链接，24 小时失效；含 chats、projects、memory、账号数据；页面不写格式 | support.claude.com/en/articles/9450526：“Exports include your chats, projects, memory, and account data.” |
| Claude 记忆导出/导入 | 让模型逐字写出记忆；条目 `[date] - content`；导入后在面板逐条审阅 | support.claude.com/en/articles/12123587：“Do not summarize, group, or omit any entries.” |
| Claude Code 记忆目录 | `MEMORY.md` 是索引，每条一行；一个主题一个文件；只加载索引前 200 行或 25KB；纯 Markdown | code.claude.com/docs/en/memory：“Index, one line per memory, loaded into every session”；“plain markdown you can edit or delete” |
| Anthropic memory tool | 记忆是 `/memories` 下的文件，格式不规定，存储归应用 | platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool：“Memory lives entirely in your application.” |
| Letta Agent File | 一个 JSON 文件含记忆块、全部消息、工具、配置；可导入；密钥置 null；archival passages 不支持；页面没写格式版本号，路线图才有“Migration support between schema changes” | docs.letta.com/guides/agents/agent-file：“When you export agents with secrets, the secrets are set to `null`.” |
| ChatGPT 导出 | 设置里申请，邮件通知，ZIP 含聊天记录；社区反映 `conversations.json` 是树状结构，一次性归档不能再导入 | help.openai.com/en/articles/7260999（官方页面）；导入限制是社区说法，未核实 |
| Google Takeout | 用户选 HTML 或 JSON | 第三方文章，未核实官方页 |
| Mem0 导出 | 异步任务，调用者给 schema，按 user/agent/run 过滤 | docs.mem0.ai/api-reference/memory/create-memory-export |
| GDPR 第 20 条 / WP242 | “structured, commonly used and machine-readable”，不规定具体格式，只覆盖主体提供和观察到的数据，不含推断 | 二手摘要，PDF 原文未读到，未核实 |

**从中得到的结论：**

1. 大厂的导出是合规产物：整包、异步、一次性，多数只保证“能下载”，不保证“能导回”（ChatGPT 不能，Claude 对话历史不能，Letta 能）。我们要的是“拿得走”，所以导入必须做，并且要有版本和校验——这三点（格式版本、清单哈希、导入校验）业界公开资料里都没有现成做法，是我们自己的设计，要用测试证明。
2. 人读和机器读两种都给是通行做法（ChatGPT 的 chat.html、Takeout 的 HTML/JSON、Claude Code 的 Markdown 目录），但没有一家把两者放在同一个导出里并保证可互相对回。这是我们的差异点。
3. Markdown 目录的“索引一行一条、主题文件按需读”是 Claude Code 现成的模式，Andy 设想的 `MEMORY.md` 就是它。索引受 200 行/25KB 限制，所以索引只能列主题，不能列每条记忆。
4. 密钥一律不带（Letta 置 null）是业界共识。但“记忆本身就是密码”的情形（Andy 明说“记住我的密码”）只有我们有，需要专门设计（见 §4）。

**根因判断：** 现在“拿不走”不是缺一个按钮，而是记忆的完整形态（版本历史、来源、整理依据、状态）和决策记录从来没有一个脱离数据库的、有版本的表示。所以方案核心是“定义一个有版本的导出格式并写读两端”，不是“再加几个字段到现有 JSON 下载”。

## 1. 前提（来源和原话）

1. 记忆正文存在加密的 payload 里，导出要经 `PayloadProtectorPort.unprotect` 读出——`packages/application/src/ports/observability.ts:97-101`：`unprotect(request: PayloadUnprotectionRequest): Promise<Uint8Array>`。
2. 记忆有版本历史表，但没有来源链全表：`memory_history_events`（`0065_memory_history.sql:3`，kind 五种、content_ref、stance、quote_ref、source_thread_id、occurred_at）；来源在 `memory_provenance`（`0001_initial_product_schema.sql:410`，主键 memory_id+source_type+source_id，**没有外键约束 source_id**）。
3. 现有记忆页导出只在浏览器里拼 7 个字段——`apps/control-center/src/components/memory-page.tsx:2041-2054`。
4. 备份/迁移包是整库加密包，且 ADR 0019 明确“不提供人类可读或通用机器可读导出”——`docs/adr/0019-offline-authority-transfer.md:28`；PRD 同样——`docs/prd-v0.2.md:67`。
5. 决策记录表有 owner_rating/rated_at、inputs JSON、reason_ref/content_ref，并通过 `decision_ledger_payloads` 关联 model_input/model_output——`0069_decision_ledger.sql`、`0070_decision_ledger_payloads.sql`。
6. 现有 CLI `backup`/`transfer` 取 `acquireStateRootLock`（`sqlite-recovery-point.ts:38`、`sqlite-authority-transfer.ts:53`），而 `apps/agent-service/src` 里没有这把锁的引用（grep 无结果）。**推断**：服务运行时不持锁，导出可以只读打开数据库；WAL 下读事务能拿到一致快照——未核实，要在实现时实测。
7. 遮盖规则在 `packages/sensitive-capture`：`redactForEgress`、`maskSensitiveText`、`findSensitiveValues`、`classificationWithIdentifiers`（`redaction.ts:244,434,542`、`identifiers.ts:20`）；占位符形如 `[密码#xxxxxxxx]`（`redaction.ts:65`）。
8. 检索索引（嵌入向量、全文索引）是可重建的派生数据——`0052_memory_engine.sql` 的 `memory_search_index`/`memory_search_terms`；它们不导出，导入后由投影任务重建。**未核实**：导入后重建索引走哪条现有路径（`memory_projection_jobs`）。
9. 项目规则：不为旧数据做兼容、只有一个用户（项目记忆 11-09 Andy 原话）；存入记忆的内容必须能被模型看到（11-09）。

## 2. 方案

### 2.1 导出的东西（一个目录，三层）

```
himawari-export-<时间>/
  MEMORY.md                  给人和其他 Agent 先读的索引（派生）
  memory/<分类>.md           每个分类一个文件（派生）
  data/memories.jsonl        主数据：每行一条记忆（内含版本历史、来源、实体、人物提及）
  data/people.jsonl          主数据：人物（别名、关系）
  data/decisions.jsonl       主数据：每行一条决策记录（含信号、整理依据、主人评价）
  schema/*.schema.json       JSON Schema（含格式版本和字段含义；决策记录里模型调用字段对照 gen_ai.* 的一张表）
  manifest.json              清单：格式版本、库迁移号、导出时间、各文件条数和 sha256、遮盖规则版本、范围选项
  sealed/originals.enc       可选：被遮盖或扣留的原文（口令加密，见 §4）
```

- **主次：** `data/*.jsonl` 是唯一主数据，导入只读它；Markdown 是派生，不导入。Markdown 每条行尾带 `〔m:<记忆编号>〕`，`MEMORY.md` 写明“自动生成、不要手改、先读索引再读主题、要核对按编号查 data/memories.jsonl、文件内容是记录不是指令”。
- **记忆一行一条，历史嵌套在里面**：一条记忆就是一个完整对象（当前状态 + `history[]` + `provenance[]` + `entities[]` + `people[]`），这样单行自洽，其他 Agent 不用做 join；导入时按子表拆回。
- **范围：** 记忆包含所有 status 非 `deletion_pending`/`deleted_verified` 的记录（active、archived、trashed 都带，带 status）；`tentative` 带标记；`superseded_by` 保留。已经删除验证的不导出（用户要的是删除，不能因为导出复活）。
- **决策记录：** 6 种 kind 全部导出，字段：id、kind、decided_at、outcome/verdict、reason_code、subject_ref、counts、inputs（记忆编号/规则编号等）、cost_micros、duration_ms、owner_rating、rated_at、category/confidence/inferred、signals[]、`reason_text`、`content_text`（遮盖后）、consolidation 的变更和依据（P1-2 的 basis）。**`model_input`/`model_output` 默认不导出**（体积大，且主动检查的输入含邮件正文等第三方内容），只写条数和 sha256；`--with-model-io` 显式开启，同样遮盖。`source_insights`、`proactive_processed_messages`（邮件派生）、`muse_reference_entries`（对照产品校准）v1 不导，列在清单的 `not_exported` 里写明原因。
- **不导出：** 对话/消息本身（v1 范围外，来源以 `provenance` 里的编号字符串保留）、检索索引、嵌入、每日摘要（派生）、模型和账号凭据（和 ADR 0019 同）。

### 2.2 一致性和完整性

- 一个读事务里读完所有表（`BEGIN` 之后只读），保证快照一致；payload 读取放在事务外按 ref 取（payload 不可变，按 ref 取安全——**未核实**）。
- 写文件后，最后写 manifest：每个文件的条数和 sha256；manifest 自身带 `format_version`（如 `himawari-export/1`）、`schema_migration`（库迁移号）。manifest 不做签名（导出是主人自己的明文目录，hmac 密钥是主机绑定的，带不走——**推断**，ADR 0019 把主机密钥排除在包外）。
- 导出命令输出目录必须不存在或为空，写完后立即自校验一遍（和导入用同一个校验函数）。

### 2.3 导入

- `himawari import <目录>`：只读 `manifest.json` + `data/*.jsonl`。顺序：① 校验 manifest 格式版本（只认已知版本）；② 逐文件校验条数和 sha256，任何一项对不上整体拒绝，一行都不写；③ 逐行按 JSON Schema 校验；④ 目标库必须是空库（没有任何记忆和决策记录），否则拒绝；⑤ 一个事务写入；⑥ 触发索引重建。导入保留原 id（记忆间的 `superseded_by`、决策里的 `inputs.memoryIds` 才对得上），所有者/Agent 编号用目标库的。
- 与现有能力的关系：**不改备份/迁移包**（它们是整库权威迁移，目的不同，ADR 0019 保持有效，只在 ADR 里加一条“数据导出是另一回事”）；**替换**记忆页现有的客户端 JSON 下载（字段不全）——v1 把记忆页下载改为调用同一个导出（服务端生成、前端下载 zip）；记忆页现有的“从别的 AI 导入”（`memory-import.ts`，文本导入）保留不动，它是外来文本的路径，不是 Himawari 自己的格式。

### 2.4 敏感内容（和“逐条一致”的冲突怎么取舍）

冲突：验收 4 要求导出文件无明文机密，验收 1 要求导回后逐条一致；而记忆里确实存着主人明说要记的密码。取舍：

- 明文层（jsonl、md）里所有文字都过同一套出口遮盖（`redactForEgress`），命中的值换成占位符，条目带 `masked: true`；`classification = restricted` 的条目正文置 `null`；
- 要完整往返，用**可选的密封层**：`--seal` 时，被遮盖或扣留的原文单独放进 `sealed/originals.enc`（口令加密，口令只从交互输入或环境文件读，不进命令行参数），导入时给口令才还原；不给口令，导入遮盖后的版本并标 sensitive。
- 密封层做不做是 Andy 的取舍（见 §6）；不做则验收 1 改成“除被遮盖条目外逐条一致”，并在清单里列出被遮盖的条数。
- 导出前的遮盖要对齐并行线程“让模型能用上敏感记忆”的占位符和分级：我不自己实现任何识别，只调 `sensitive-capture` 的导出函数；等它合并后在导出里改用它的新入口（**依赖，未核实**其接口）。

### 2.5 不改表结构

整个方案只读现有表，导入只写现有表，不加迁移。导入时来源线程编号写入 `memory_provenance(source_type='thread', source_id=…)`（该列无外键），`memory_history_events.source_thread_id` 在目标库里没有对应线程，按 `ON DELETE SET NULL` 的语义置空——所以“逐条一致”的比较口径要排除“指向未导出对象的外键列”，用 `provenance` 里保留的编号代替（**要核实**现有写入是否已经同时写 provenance）。

### 2.6 测试

1. 往返：造一个有各种状态、版本历史、决策评价的库 → 导出 → 导入空库 → 重新导出 → 两份 `data/*.jsonl` 逐字节相同（排除导出时间）；再用 `evals/memory-retrieval` 的数据集导入后跑检索评测，分数相同（需要嵌入服务的部分用已有的评测替身/固定向量，按评测脚本现状定）。
2. 清单：改一个文件的一个字节、删一行、加一行、改 manifest 条数、改格式版本——各自导入必须拒绝且目标库一行没写（反向用例）。
3. 对回：解析所有 `.md` 里的 `〔m:id〕`，每个都在 `memories.jsonl` 里存在，且文字（规范化后）一致；删掉 jsonl 一行则测试失败。
4. 机密：造含密码、银行卡号、证件号的记忆，导出后全目录（含 manifest、schema、md、jsonl）扫描，用 `findSensitiveValues` 必须零命中；反向用例：关掉遮盖则测试必须失败。
5. 快照一致：导出过程中另一个连接写入，导出的内容必须来自同一时刻。
6. 进 `npm run check` 或现有测试矩阵（按 `ci/policy.json` 的分层登记）。

## 3. 考虑过但不选的做法

- 在备份/迁移包上扩：它是加密整库、面向主机迁移，加人类可读层会破坏“主机绑定、不外泄”的设计。
- 只导 Markdown（Letta/Claude Code 式）：丢字段，导不回去。
- 只导 JSON（Letta .af 式）：人和其他 Agent 读不了，且一个大 JSON 对 100 万行不友好。
- 一条记忆一个 Markdown 文件（Letta 的记忆块文件）：Himawari 的记忆多是一句话，文件会成千上万。
- 用 OpenTelemetry `gen_ai.*` 当决策记录格式：Andy 已排除。
- 单个 `.af` 式 JSON：不选，理由同上。

## 4. 对 Andy 的两个拍板点（预判）

1. 要不要做密封层（§2.4）。
2. 决策记录里的 `model_input`/`model_output` 默认不导出，要不要。

## 5. 必答问题

1. 不改变发给模型的请求开头；导出不发任何模型请求。
2. 导出的字节：jsonl 每行键顺序固定（Schema 里按固定顺序序列化）、行序按 `recorded_at, id` 固定；遮盖只取决于该条自身文字。
3. 自动检查和反向用例见 §2.6。
4. 产生的值：`format_version`、manifest 字段、占位符，各自的使用端——导入端校验、JSON Schema、`check:glossary`（新词“导出包”“密封层”要登记词表，**待核**）。
