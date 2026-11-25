---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-10"
covers: ".agents/instructions/model-review.md, apps/admin-cli/src/data-command.ts, apps/admin-cli/src/stopped-target-lock.ts, packages/persistence-sqlite/src/data-export/snapshot.ts, packages/platform-node/src/export-text-policy.ts, scripts/boundary-policy.mjs, scripts/check-egress-redaction.mjs, test/integration/data-cli.test.ts, test/integration/data-export-retrieval.test.ts, test/integration/data-export.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0200：长期记忆与决定记录可以导出，也可以再导入

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

愿景要求数据由 Andy 自持，[PRD](../prd-v0.2.md) 原来写着“不做通用机器可读的数据导出”，只有受控权威迁移用的机器迁移包。记忆页有一个浏览器端 JSON 下载，但它不带历史版本、来源和评价，也不是为再导入设计的。Andy 的任务 P1-6 要一个真正能把记忆和决定记录带走、并且能再放回去的导出。

方案按[模型复核规则](../../.agents/instructions/model-review.md)由两个模型各自出方案再审线程方案，Andy 在 2026-11-10 对整合后的方案和改动清单回了“同意”。

<a id="premises"></a>

## 前提

1. 数据库里用于导出的表由迁移定义，本决定不加迁移：`packages/persistence-sqlite/src/data-export/snapshot.ts` 只读已有表（记忆、历史、来源、实体、人物、导入批次、整理、决定账本、信号、荷载）。
2. 记忆正文是加密存的，读它必须经荷载保护器（`PayloadProtectorPort`）；持久化包不得导入敏感信息包：`scripts/boundary-policy.mjs:29-37`，`persistence-sqlite` 允许的内部依赖里没有 `@himawari-agent/sensitive-capture`。所以文字策略由 `packages/platform-node/src/export-text-policy.ts` 注入。
3. 只有登记过的文件可以调用整段拦下的敏感检查：`scripts/check-egress-redaction.mjs` 的 `SENSITIVE_GATE_CALLS`，本决定为 `export-text-policy.ts` 新增一行。
4. 管理命令行只能依赖应用、持久化和 Node 平台三个包：`scripts/boundary-policy.mjs:122-128`。
5. 已有的服务停机锁：`apps/admin-cli/src/stopped-target-lock.ts`（`lockStoppedTarget`），记忆整理命令也用它。
6. [ADR 0193](0193-memory-is-visible-to-the-model.md)：存入记忆的内容必须能被模型看到；本决定不改变这一点，导出只是副本。

<a id="decision"></a>

## 决定

1. **格式 `himawari.data-export.v1`，一个文件夹：**
   - `manifest.json`：格式版本、迁移序号、导出时间、出口规则版本、每个文件的路径、角色、字节数、行数、SHA-256、各类条数、扣留数和未导出项。
   - `data/{memories,people,import-batches,consolidations,decisions}.jsonl`：键排序的规范 JSON，一行一条；每条记忆的历史、来源、实体、人物、置顶嵌在它自己那一行，决定记录的信号嵌在它那一行。
   - `schema/*.schema.json`：每类数据的 JSON Schema。
   - `MEMORY.md` 和 `memory/<类别>[-NN].md`：给人读的目录，每行 `- > 折成一行的正文 〔m:<编号>〕`，只含在用且非暂定的记忆，每个文件最多 500 条记忆。
   - `sealed/sealed.enc`（可选）：口令加密的封存文件，scrypt（N=32768, r=8, p=1）派生密钥加 AES-256-GCM，文件头作为认证数据。
2. **导出范围：**记忆的在用、已归档、回收站三种状态；人物、导入批次、整理记录；决定账本。不导出：删除流程中和已验证删除的记忆、restricted 记忆（清单里写条数）、对话、事件段、检索索引。线程编号和上游记录编号去掉（记忆来源里的来源编号保留，它们只是编号，不含正文）；实体名、人物名和别名、来源编号、决定记录的主题、输入、信号细节这些自由文字同样过一遍机密检查，命中就整段换成 `[已扣留:<编号>]`（编号接着该库里已有占位的最大编号往后排（新库从 1 开始），同一原文同一编号、不同原文不同编号，不会撞主键，也不能用哈希去猜原值；原文不保留，不进封存文件，清单 `omitted` 里写条数）；指向未导出记忆的取代关系、关联和整理条目置空或过滤。
3. **机密的处理：**一段文字只要 `findSensitiveValues` 认出值，或 `containsRestrictedIdentifier` 为真，明文层就放遮盖后的文字；遮盖后仍像机密则放占位符 `[内容含机密，已扣留]`，该条标 `withheld: true`。原文只进封存文件的 `originals`。话题类敏感（健康、财务等）但没有机密值的记忆，按 Andy 的决定放明文层。
4. **证据默认不导出。**决定记录里模型的输入输出、来源洞察、已处理消息和每日记录，只在 `--with-evidence` 且设了口令时进封存文件的 `evidence`；没有口令就拒绝。
5. **一致性与校验：**
   - 在同一个只读事务里读完所有行和荷载，再异步解密，保证导出是一个时间点的快照。
   - 导入前先校验：路径安全、文件清单、字节数、SHA-256、数据文件行数、每行对照 JSON Schema、引用完整、清单条数、Markdown 与 JSONL 的对应。任何一项不符，整份拒绝，不写任何数据。
6. **导入：**只导入到没有任何记忆、决定记录、人物、导入批次、整理记录、来源洞察、已处理邮件记录和 Muse 校准记录的空库；用目标库自己的保护器重新加密，荷载引用换新；在一个事务里写入，失败整体回滚；支持只校验不写入（`--dry-run`）。没有口令或扣留项的原文缺失时，那几条跳过并在报告里写条数。导入后建检索所需的最小骨架（一个空的已归档线程、一个生成批次、每条在用记忆一个待建索引任务），服务启动后按已有流程建索引。
7. **命令行：**`himawari-admin data export|inspect|import`（另有生成示范记忆包的 `data demo-pack`，见 [ADR 0236](0236-trial-users-get-demo-memories-and-a-fake-inbox.md)）。导出和导入要求服务已停（`lockStoppedTarget`）；口令只从权限为 0600（或更严）的文件读取（至少 12 个字符），不进命令行参数；有扣留项又不设口令时拒绝，除非明确给 `--allow-unsealed`；导入要 `--confirm IMPORT_DATA_<agentId>`；导出目录必须不存在或为空，权限 0700。
8. **门槛：**`npm run check:data-export`（属于 `npm run check`）跑 `test/integration/data-export*.test.ts` 和 `data-cli.test.ts` 里带 `[P1-6]` 的测试，要求至少 53 条通过。
9. **网页导出（第 2 个 PR）：**记忆页的“导出全部记忆”改为下载同一格式的压缩包（`GET /api/data-export/v1/archive`），替换原来在浏览器里拼 JSON 的下载。接口在服务内运行，用一个只读的数据库连接读取，不需要停服务；要求已登录的主人会话，并且请求来源是同源（`Sec-Fetch-Site` 为 `same-origin` 或 `none`），未登录返回 401，跨站返回 403，同时只生成一份（第二个并发请求返回 429）。网页导出不设口令，所以不带加密封存文件和证据：含机密的文字在文件里只留占位符，页面写明“要完整带走请用命令行加密导出”，并显示被扣留的处数。响应头 `x-himawari-export-memories` 是清单里的记忆条数；`x-himawari-export-withheld` 是文件里被换成占位符的文字段数，等于清单的 `withheld.texts`（含机密而被遮盖或扣留的文字段，一段里有几个密钥都只算一处）加上“含机密的短文字”那一项的条数（记忆条数和决策条数是另一个口径，不加进去，否则同一处会算两次）。网页导出和命令行一样，回收站里的记忆和敏感主题记忆也会导出，其中的正文除机密外是明文（机密仍留占位符），页面文案写明了这一点。
10. **网页不提供导入：**导入只能进空库，而网页里的 Himawari 已经有数据；记忆页现有的“导入记忆”是从其他助手搬进来，是另一个功能，不动；其中“Himawari 导出的文件”一项只认以前下载的 `himawari-memories.json`，三语帮助文案已改成“旧版 JSON，新版压缩包不能在这里导入”，读不出文件的报错改成不限定格式的通用文案。

<a id="industry"></a>

## 业界怎么做

- Claude、ChatGPT、Gemini 的账号导出是合规用的整包下载，格式不保证能再导入到别处（[OpenAI 的导出说明](https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data)）。
- Letta 的 Agent File（[letta-ai/agent-file](https://github.com/letta-ai/agent-file)）可以导入导出整个 Agent，但没有文档化的版本号，密钥导出时置空。本决定借它“可再导入”的目标，补上版本号和哈希校验。
- Claude Code 的记忆是一个索引文件加按主题分的文件（[Memory](https://code.claude.com/docs/en/memory)），本决定的 `MEMORY.md` 加 `memory/<类别>.md` 照这个形状，让人和模型都能直接读。
- GDPR 第 20 条要求数据“in a structured, commonly used and machine-readable format”（[Art. 20](https://gdpr-info.eu/art-20-gdpr/)），JSONL 加 JSON Schema 符合这一点。

<a id="options"></a>

## 放弃的做法

- **整库 SQLite 复制。**会带上线程、索引和所有机密，也不能在不同迁移版本间导入；已有的备份和迁移包就是做这个的。
- **明文层放全部原文。**会让导出文件本身成为机密泄漏点；Andy 同意话题类敏感放明文、机密值只放封存文件。
- **导出里直接带证据。**决定记录的模型输入常含第三方邮件正文等内容，默认不带，Andy 同意。
- **自动定时导出。**PRD 不做自动外发；导出由所有者发起。

<a id="consequences"></a>

## 后果

- 零迁移。
- 记忆正文存成加密文件（`ciphertext_file`）的状态目前不支持：生产没有接线这种存储，遇到时导出会以 `DATA_EXPORT_PAYLOAD_UNAVAILABLE` 明确失败，不会漏掉记忆；以后接线时要补这一路。
- 命令行导出和导入要求服务停止；网页导出在服务内用只读连接做，不需要停服务；它读一个一致的快照，但整份内容在内存里生成，所以限制总量 512 MB（打包阶段才检查，峰值内存可能更高），同时只允许一个；读快照和打包是同步计算，期间主进程不处理其他请求，时长随数据量增加，本 PR 没有在大库上实测；数据变得很大时要改成放到单独的进程里做。
- 导入会留下一个空的、已归档的线程，名字是 `data-import-thread-<随机串>`（线程状态 `open` 但写了归档时间），只用来满足检索骨架的外键，不显示在线程列表的活动区。
- 实体名含机密的记忆，导出后实体名成了占位，导入后按词检索的词跟着变；“检索评测分数不变”只对不含被替换短文字的记忆成立。
- 导入后检索要等待建索引任务跑完；索引没建时检索命中为 0，测试明确断言了这一点。
- 封存文件口令丢了，被扣留的原文就找不回来；导出报告会写扣留条数。
- 门槛：`test/integration/data-export.test.ts`（往返逐条一致、12 种篡改整份拒绝、Markdown 对应、明文中搜不到机密及反向用例、封存文件）、`test/integration/data-export-retrieval.test.ts`（88 条检索评测问题导出导入前后命中一致）、`test/integration/data-cli.test.ts`。
- 事故清单不加行：这是新功能，不是事故修复。

<a id="references"></a>

## 关联文档

- [PRD v0.2](../prd-v0.2.md)
- [ADR 0193：存入记忆的内容必须能被模型看到](0193-memory-is-visible-to-the-model.md)
- [ADR 0183：只在数据离开时遮盖](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md)
- 代码：`packages/persistence-sqlite/src/data-export/`、`packages/platform-node/src/export-text-policy.ts`、`apps/admin-cli/src/data-command.ts`
- [ADR 0233：规则手册进入数据导出，格式升到 v2](0233-rule-book-joins-the-data-export.md)（后续）

[返回目录](#contents)

<a id="multi-user-follow-up"></a>

## 2026-11-11 后续：多人使用

[ADR 0234](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0234-one-program-per-person-database-file.md) 第 10 条要求导出按人做，并补上聊天记录，因为本 ADR 的导出不含对话。聊天记录导出的格式和范围另写 ADR；本 ADR 的决定不变。
