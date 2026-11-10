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
仓库就是当前目录，已检出 fd283e437a172cfbe807dddaae5da674cc814c18。
问题、目标和约束：
# 问题：Himawari 的「数据拿得走」——记忆和决策记录怎么导出、导回

## 背景和目标

Himawari 是 Andy（唯一的用户，也是主人）的个人 Agent。产品愿景（`docs/product-vision.md` 第 98、99、107 行）把「拿得走」当作护城河：记忆、规则、工具可导出，换模型、换平台仍在主人手里；愿景要求「整套可导出带走」，并且其他 Agent 能通过 Himawari 认识主人。

现状是：记忆页有一个浏览器端生成的 JSON 下载，字段不全，也导不回去；仓库里记录“系统每个由模型做出的门槛决策、并让主人一键评价”的那张表（决策记录，表名 `decision_ledger`）完全带不走；`docs/prd-v0.2.md:67` 写着「不做人类可读或通用机器可读的数据导出」，和上面矛盾，需要改。

请你给出「数据导出（数据可带走）」的最佳方案：导出什么、用什么格式和目录结构、怎么分层、怎么保证完整性和可校验、要不要导入以及怎么导入、敏感内容怎么处理、怎么测试。方案要建立在主流 AI 厂商和成熟开源项目的一手做法上。

## 验收要求（主人已定，不能改）

1. 导出再导入一个空库后，记忆和决策记录逐条一致（含记忆的版本历史和决策记录里主人的评价）；检索评测（`evals/memory-retrieval/dataset.json` 及 `scripts/memory-retrieval-eval/live.mjs`）的分数与导出前一致。
2. 清单（manifest）里的哈希或条数对不上时，拒绝导入。
3. 给人和其他 Agent 读的版本里的每一条，都能找回到机器可读的主数据里对应的那一条。
4. 导出的文件里不含明文的机密或受限内容，要有自动测试。
5. 新增测试要进仓库的自动检查，不能只在本地跑一次。

## 约束（来自仓库规则，每条给出处）

- 发给模型或嵌入服务的请求必须走统一出口（它先遮盖密钥、密码、验证码、银行卡号、证件号）；导出内容的遮盖复用统一出口用的那套识别规则（在 `packages/sensitive-capture`，导出的函数有 `redactForEgress`、`maskSensitiveText`、`findSensitiveValues`、`classificationWithIdentifiers`），不得另写识别规则。
- 发给模型的内容只追加（`.claude/rules/prompt-prefix.md`）；本任务不应改变任何发给模型的请求。
- 数据分级有四档：`public`、`private`、`sensitive`、`restricted`（`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql` 的 `memory_records.classification`）；另有 `sensitive_topic`。`restricted` 的候选在写入时被丢弃（`docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md`）。
- Himawari 在哪里运行、数据存在哪里由主人控制（自有优先、数据自持）；只有一个用户；不需要为旧数据做兼容。
- 产品规则：存入记忆的内容必须能被模型看到（凭证类以占位符给模型）；规则是硬性设定，不是记忆。
- 不要用 OpenTelemetry GenAI（`gen_ai.*`）字段当决策记录的导出格式（它仍标 Development，描述的是单次模型调用而非业务记录）。如果需要，只在字段说明里给出模型调用部分的对照。
- 不写代码注释；文档用简体中文。
- 迁移（数据库表结构变化）要尽量避免；如果必须加，说明理由。

## 已核对的事实（读代码得来）

- 记忆存储：`memory_records`（id、revision、status ∈ active/archived/trashed/deletion_pending/deleted_verified、content_ref 指向加密的 `payloads`、classification、source_thread_id、inference、confidence_permille、policy_version、category、sub_category、importance_permille、valid_from、valid_to、superseded_by、use_count、evidence_verified、sensitive_topic、last_used_at、recorded_at、tentative、import_batch_id、stance），`memory_provenance`，`memory_entities`，`memory_history_events`（kind ∈ created/updated/reaffirmed/edited/restored；content_ref、stance、quote_ref、source_thread_id、source_deleted、occurred_at），`memory_consolidation_runs/changes/change_basis`（整理记录），`memory_people` 及别名、关系、提及，`memory_profile_pins`，`memory_import_batches`，`memory_episodes`（每日摘要，带嵌入）。检索索引 `memory_search_index`（含嵌入向量）和 `memory_search_terms`（全文索引）是可重建的派生数据。
- 记忆文字本体存在 `payloads` 里（`content_ref` 引用），加密保存，读取要经 `PayloadProtectorPort`（`packages/application/src/ports/observability.ts:97`）。
- 记忆页现有导出：`apps/control-center/src/components/memory-page.tsx` 的 `ExportPanel`，在浏览器里把 overview 拼成 `himawari-memories.json`（字段 text、category、subCategory、sensitive、status、recordedAt、lastUsedAt），默认不含敏感条目，勾选后含；对应的导入在 `apps/control-center/src/memory-import.ts`（`parseMemoryExport`、`parseMemoryText`），导入时按文字去重、按启发式猜分类。
- 备份和迁移：`apps/admin-cli/src/index.ts` 有 `backup create|verify|restore` 和 `transfer export|inspect|import|activate|abandon`；实现在 `packages/persistence-sqlite/src/sqlite-recovery-point.ts`（清单 `himawari.recovery-point.v1`，aes-256-gcm 信封加密文件，清单带 hmac-sha256 认证）和 `sqlite-authority-transfer.ts`。这是整库加密的权威迁移包，`docs/adr/0019-offline-authority-transfer.md` 明确写它“不提供人类可读或通用机器可读导出”。
- 决策记录：`decision_ledger`（kind ∈ proactive/memory_candidate/consolidation/context_truncation/retrieval_degrade/external_read；counts、verdict、outcome、reason_code、subject_ref、inputs（JSON：memoryIds、ruleIds、batchId、resultMemoryIds、sourceIds 等）、reason_ref、content_ref（payload 引用）、cost_micros、duration_ms、owner_rating ∈ useful/unneeded/missed、rated_at、category、confidence_permille、inferred），`decision_ledger_payloads`（role ∈ model_input/model_output，指向 payload），`decision_signals`（opened/undone/replied，不可改），`source_insights`、`proactive_processed_messages`（邮件主动检查结果，含邮件头 payload 引用），`muse_reference_entries`（Andy 拿 Muse 这个对照产品做的校准记录）。主动检查的 `model_input` 里可能含邮件正文等第三方内容。
- 数据库层迁移最新是 0084，另有 PR 在加 0085；同一时间只允许一个改表结构的块。
- 检索评测脚本在 `scripts/memory-retrieval-eval/`，数据集 `evals/memory-retrieval/dataset.json`（合成数据，含 memories、queries、expected）。
- 另一个并行任务正在改：敏感记忆的分级、遮盖占位符（形如 `[密码#xxxxxxxx]`，见 `redaction.ts:65`）、记忆日期；导出的遮盖要对齐它的结果。

## 已查到的一手资料（只作参考，不限制你的思路）

- Claude 数据导出（Anthropic 帮助中心 support.claude.com/en/articles/9450526）：设置 > 隐私 > 导出，邮件发下载链接，链接 24 小时后失效；导出含“chats, projects, memory, and account data”，不含上传的原始文件；页面没写文件格式。
- Claude 记忆导入导出（support.claude.com/en/articles/12123587）：导出是让模型“verbatim”写出记忆、“Do not summarize, group, or omit any entries”；条目格式 `[date saved, if available] - memory content`；导入后在记忆面板逐条审阅；明说导入是实验性的、不保证全部保留。
- Claude Code 记忆目录（code.claude.com/docs/en/memory）：`MEMORY.md` 是索引（一条记忆一行），每个主题一个文件；启动时只加载 `MEMORY.md` 前 200 行或 25KB，主题文件按需读取；“plain markdown you can edit or delete”。
- Anthropic memory tool（platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool）：记忆是 `/memories` 目录下的文件，格式不规定，存储由应用自己控制。
- Letta Agent File（docs.letta.com/guides/agents/agent-file）：`.af` 是“open standard file format for serializing stateful agents”的 JSON，含记忆块、全部消息（有 `in_context` 标记）、系统提示、工具定义（含源码和 JSON Schema）、模型配置；“Archival memory passages”暂不支持；密钥导出时置为 `null`；页面没写格式版本号，路线图里有“Migration support between schema changes”。
- OpenAI ChatGPT 导出（help.openai.com/en/articles/7260999）：设置 > 数据控制 > 导出，邮件或短信通知，最长 7 天，链接 24 小时失效，ZIP 含聊天记录和账号数据；社区反映 `conversations.json` 是树状 mapping 结构，是一次性归档，不能再导入；官方页面没提单独的记忆文件（未核实）。
- Google Takeout / Data Portability API（developers.google.com/data-portability）：Takeout 让用户选 HTML 或 JSON；Data Portability API 让第三方应用代用户导出，要求应用验证。Gemini 数据在 My Activity 下（第三方文章，未核实官方页）。
- Mem0 记忆导出（docs.mem0.ai/api-reference/memory/create-memory-export）：异步任务，调用者提供 Pydantic 风格的 schema，按 user_id/agent_id/run_id 过滤。
- GDPR 第 20 条和 Article 29 工作组 WP242 rev.01（2017）：可携带的数据要“structured, commonly used and machine-readable”，不规定具体格式，鼓励行业共同的可互操作格式；只覆盖主体提供的和观察到的数据，不含控制者推断出的结果（从二手摘要得来，PDF 原文未能读取，未核实）。
- OpenTelemetry GenAI 语义约定：仓库里的 gen-ai 页已迁到单独的 GenAI 语义约定仓库，状态仍为 Development（Andy 的说明，未核实）。

## 请重点回答

- 业界真实做法里，哪些是值得学的、哪些是我们不该学的？（例如：只给机器格式 vs 只给人读格式 vs 两者都给；一个文件一条 vs 一个主题一个文件；导出能不能导入；有没有格式版本、清单、哈希、校验。）
- 导出什么格式、什么目录结构最合适；主数据和给人/Agent 读的版本怎么分主次；怎么让两者能互相对回。
- 应不应该做「导入」？导入读什么、校验什么、导进什么状态的库；与现有的备份/迁移包、记忆页的 JSON 导入是什么关系，是在它们上扩还是另起。
- 决策记录导出什么：里面有模型输入输出的原文（可能含邮件正文等第三方内容）、成本、评价；哪些该带走，哪些不该带或要遮盖，怎么遮盖才不另写识别规则。
- 记忆的哪些状态（trashed、deletion_pending、archived、tentative、superseded、sensitive、restricted）要不要导出，各怎么处理；“导出的文件里不含明文机密”和“导出再导入逐条一致”怎么同时成立（有冲突的话怎么取舍）。
- 导出时数据是否可能在变（服务在跑）；怎么得到一致的快照。
- 怎么在不改表结构的前提下做到；如果必须改表，最小改动是什么。
- 测试怎么设计：往返一致、清单被篡改、Markdown 对回主数据、机密不外泄，各自的反向用例怎么写才真的会失败。
- 需要 Andy 拍板的取舍有哪几项。
