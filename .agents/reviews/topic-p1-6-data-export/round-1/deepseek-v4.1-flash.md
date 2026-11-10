# 方案：Himawari 记忆与决策记录的可携带导出/回导

## 一、方案依赖的前提

### 1.1 读代码和仓库规则证实的

1. **产品目标要求“拿得走”，并且其他 Agent 要通过 Himawari 认识主人。**
   - 来源：`docs/product-vision.md:99`、`:107`
   - 原话：`每条记忆带来源、可回滚，改一条推论跟着改，整套可导出带走`；`拿得走——记忆、规则、工具可导出，换模型、换平台仍在我手里`。

2. **当前 PRD 明确不做通用导出，必须改。**
   - 来源：`docs/prd-v0.2.md:67`
   - 原话：`人类可读或通用机器可读的数据导出；只提供受控权威迁移所需的机器迁移包。`

3. **发给模型的内容只追加，每轮变化的值只能放最后一条消息；导出不得改变任何模型请求。**
   - 来源：`.claude/rules/prompt-prefix.md:28`、`:35`、`:36`、`:84-85`
   - 原话：`每轮都会变的内容只放在最后一条用户消息里`；`已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加`；`存历史时存实际发出去的那一条`；`这个改动会不会让模型已经见过的请求开头变化？会，就停下来出方案`。

4. **导出遮盖必须复用 `packages/sensitive-capture`，不能另写规则。**
   - 来源：`packages/sensitive-capture/src/redaction.ts:244`、`:434`、`:542`，`packages/sensitive-capture/src/identifiers.ts:20-28`
   - 代码事实：`redactForEgress(input, options)`、`findSensitiveValues(input)`、`maskSensitiveText(input)`、`classificationWithIdentifiers(text, classification)` 已有；`scripts/check-egress-redaction.mjs:178-181` 规定 `只有出口模块能直接调用 redactForEgress`，新导出模块要么走 `maskSensitiveText`/`findSensitiveValues`，要么登记进 `REDACTOR_ONLY_FILES`。

5. **数据分级四档，`restricted` 候选在写入时被丢弃。**
   - 来源：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:61`、`:400`；`docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:43`
   - 原话：`classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted'))`；`代码里 restricted 的候选仍被丢弃，只是提示词不再主动让模型这样标。`

6. **记忆文字本体在加密 `payloads` 里，读取要经 `PayloadProtectorPort`；版本历史是独立表。**
   - 来源：`packages/persistence-sqlite/src/migrations/0065_memory_history.sql:3-13`；`packages/application/src/ports/observability.ts:97-99`
   - 原话/代码：`memory_history_events(kind ∈ created/updated/reaffirmed/edited/restored, content_ref, stance, quote_ref, source_thread_id, source_deleted, occurred_at)`；`PayloadProtectorPort.protect/unprotect/rewrap`。

7. **决策记录的 `inputs` 只放编号，不放正文；模型输入输出是单独的加密 payload。**
   - 来源：`docs/adr/0143-decision-ledger-for-model-gate-decisions.md:38`；`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:1-56`；`migrations/0070_decision_ledger_payloads.sql:1-7`
   - 原话：`inputs（JSON，只放记忆编号 memoryIds 和规则编号 ruleIds，不放正文...）`；`decision_ledger_payloads.role ∈ model_input/model_output`，`payload_ref` 指向 `payloads`。

8. **现有记忆页导出是浏览器端拼字段，字段不全且只导 active。**
   - 来源：`apps/control-center/src/components/memory-page.tsx:2034-2052`；`apps/control-center/src/memory-import.ts:151-183`
   - 代码事实：导出字段只有 `text/category/subCategory/sensitive/status/recordedAt/lastUsedAt`；导入 `parseMemoryExport` 只收 `status === "active"`，忽略历史、评价、`trashed/archived`。

9. **现有 backup/transfer 是整库权威迁移，不是通用导出。**
   - 来源：`docs/adr/0019-offline-authority-transfer.md:28`；`packages/persistence-sqlite/src/sqlite-recovery-point.ts:40-42`、`:619-621`
   - 原话：`迁移包只服务于活动权威迁移，不提供人类可读或通用机器可读导出`；`MANIFEST_SCHEMA = "himawari.recovery-point.v1"`；导出用 `source.backup(snapshotPath)` 生成一致性快照。

10. **SQLite 在线备份能生成一致性快照，并发写入会让备份重启。**
    - 来源：https://www.sqlite.org/backup.html
    - 原话：`The effect of completing the backup call sequence is to make the destination a bit-wise identical copy of the source database as it was when the copying commenced. (The destination becomes a "snapshot.")`；`If another thread or process writes to the source database while this function is sleeping, then SQLite detects this and usually restarts the backup process...`

11. **需要确定性 JSON 才能稳定计算哈希。**
    - 来源：RFC 8785（JCS），https://www.rfc-editor.org/rfc/rfc8785.html
    - 原话：`Cryptographic operations like hashing and signing need the data to be expressed in an invariant format so that the operations are reliably repeatable.`；`JSON object properties MUST be sorted recursively`。

### 1.2 业界一手事实

- **Claude 数据导出**：https://support.claude.com/en/articles/9450526-how-can-i-export-my-claude-data
  原话：`Data exports include your chats, projects, memory, and account data. They don't include the original files you uploaded.`；`Exported data can't be imported into another personal Claude account`。
  值得学：记忆在总导出里；下载链接有时效、需要重新认证。不该学：一次性归档、不能回导。

- **Claude 记忆导入/导出**：https://support.claude.com/en/articles/12123587-importing-and-exporting-your-memory
  原话：`Do not summarize, group, or omit any entries.`；条目格式 `[date saved, if available] - memory content`；`Memory imports are experimental and still in active development`；`Claude may not always successfully incorporate imported memories.`
  值得学：人类可读条目格式、导入后逐条审阅。不该学：让模型“verbatim 写出记忆”，会摘要、改写、漏项。

- **Claude Code 记忆目录**：https://code.claude.com/docs/en/memory
  原话：`The directory contains a MEMORY.md index and one topic file per memory`；`The first 200 lines of MEMORY.md, or the first 25KB, whichever comes first, are loaded at the start of every conversation`；`Auto memory files are plain markdown you can edit or delete at any time.`
  值得学：`MEMORY.md` 索引 + 主题文件、按需读取、纯 Markdown。不该学：把 200 行/25KB 的上下文加载限制当成导出上限。

- **Anthropic memory tool**：https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
  原话：`The memory tool operates client-side: Claude requests file operations, and your application runs them. You control where and how the data is stored through your own infrastructure.`
  值得学：存储与视图分离，格式由应用定。不该学：格式完全不定，无法校验。

- **Letta Agent File**：https://docs.letta.com/guides/agents/agent-file
  原话：`AgentFile (.af) is an open standard file format for serializing stateful agents`；`A .af file contains all the state required to re-create the exact same agent`；`When you export agents with secrets, the secrets are set to null for security reasons.`；`Archival memory passages are planned.`
  值得学：开放 JSON、状态完整、秘密置空、可导入。不该学：把系统提示、工具源码、模型配置都塞进本任务；该页也没有展示格式版本号，说明必须有版本与迁移。

- **OpenAI ChatGPT 导出**：https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data
  本次抓取返回 403，**未核实**。用户材料说它是 ZIP、`conversations.json` 为树状 mapping、一次性归档、不能再导入；按“未核实”处理，不作为核心依据。

- **Google Takeout / Data Portability API**：https://support.google.com/accounts/answer/3024190；https://developers.google.com/data-portability
  原话：`To keep your records or transfer your data to another service, you can create an archive.`；`HTML files can be opened... CSV and JSON files can be opened...`；`Your archive expires in about 7 days.`；`The Data Portability API lets you build applications that help users export their data from Google products.`
  值得学：用户可选范围、JSON/HTML 两种视图、第三方代导要验证。不该学：把过期链接当作产品导出机制（Himawari 是本地自持）。

- **Mem0 导出**：https://docs.mem0.ai/api-reference/memory/create-memory-export
  原话：`Submit a job to create a structured export of memories using a customizable Pydantic schema`；`You can tailor the export by applying various filters`。
  值得学：schema 化、按 user/agent 过滤。不该学：调用方自定义 schema 作为权威格式，会不稳定。

- **GDPR 第 20 条**：https://gdpr-info.eu/art-20-gdpr/
  原话：`in a structured, commonly used and machine-readable format`；`shall not adversely affect the rights and freedoms of others`。
  值得学：机器可读、可传输、不能损害他人权利。注意：这要求我们对第三方邮件正文保守处理。

### 1.3 推测/未核实

- `0085` 迁移新增的枚举值具体是什么，**未核实**；方案要求导出/导入从共享常量和当前 schema 读取，不能硬编码旧枚举。
- 检索评测导入后分数是否完全一致，取决于嵌入模型是否确定；**需用确定性测试嵌入器或缓存验证**，不能口头上保证。
- 浏览器端是否适合弹出口令、流式生成大文件，**未实现验证**；方案默认走本地 admin CLI。
- OpenAI 导出细节、GDPR WP242 PDF 原文、OpenTelemetry GenAI 当前状态，**未核实**，不作为核心依据。

---

## 二、方案本身

### 2.1 总体判断

采用**三层产物**，而不是“一个加密整库”或“一个浏览器 JSON”：

1. **机器可读主数据**：`data/records.jsonl`，明文 JSONL，按记录类型一行一条，包含所有元数据和不含机密/受限内容的文本；敏感、凭据、受限、第三方原文在这里是 `null` + `withheld` 标记。
2. **密封补充**：`data/withheld.jsonl.enc`，AES-256-GCM 加密的 JSONL，只放被主数据 withhold 的字段（敏感文本、凭据原文、决策证据、第三方正文等），每条带 `recordId` 和字段名。
3. **可读投影**：`readable/MEMORY.md`、`readable/memories/<category>.md`、`readable/decisions.md`，从主数据生成，凭据一律遮盖，敏感默认占位；每条都带 `recordId`，可回到主数据。

`manifest.json` 是唯一清单，记录版本、范围、条数、每个文件的 SHA-256、密封文件的加密参数、遗漏项、检索基线，并用 passphrase 派生密钥做 HMAC。导入必须同时拿主数据 + 密封补充 + passphrase，合并后逐条还原。

**为什么不是把整个导出都加密**：主数据要能给其他 Agent 读，也要能被人直接检查；把全部内容加密会让“机器可读主数据”名存实亡。**为什么不是全部明文**：`sensitive`、凭据、`restricted`、第三方邮件正文不能以明文落盘。分层正好同时满足“拿得走”和“不外泄明文”。

### 2.2 目录结构

```text
himawari-export-<exportId>/
├── manifest.json
├── README.md
├── data/
│   ├── records.jsonl          # 明文主数据；敏感文本为 null + withheld
│   └── withheld.jsonl.enc     # 密封补充；AES-256-GCM
└── readable/
    ├── MEMORY.md              # 索引：分类、条数、链接
    ├── memories/
    │   ├── identity.md
    │   ├── preference.md
    │   ├── relationship.md
    │   └── ...                # 每个分类一个主题文件
    └── decisions.md           # 决策记录，按时间/类型分组
```

需要单文件交付时，再把整个目录打成 zip；清单中的路径仍然是目录内相对路径。

### 2.3 主数据格式

`data/records.jsonl`：一行一个 JSON 对象，UTF-8，键递归排序（JCS 或仓库已有 `stableJson`），数组顺序保留（`inputs.memoryIds` 等有语义的数组不排序）。记录信封：

```json
{
  "schema": "himawari.data-export.record.v1",
  "type": "memory",
  "recordId": "memory:abc123",
  "data": {
    "id": "memory:abc123",
    "revision": 3,
    "status": "active",
    "classification": "private",
    "category": "preference",
    "text": null,
    "withheld": ["text"]
  },
  "source": { "table": "memory_records" }
}
```

记录类型至少包括：

| 类型 | 关键内容 |
|---|---|
| `header` | `exportId`、来源版本、schema sequence、redaction ruleset、范围、检索配置 |
| `owner` / `agent` | 仅身份元数据，不含密钥 |
| `memory` | `memory_records` 全列 + 解密后的 `text`（或 `null` + withheld） |
| `payload` | `ref`、`classification`、`contentType`、`text`、`contentDigest`、`createdAt`；不导加密元数据和密钥引用 |
| `memory_history` | `memoryId`、`kind`、`contentRef`、`stance`、`quoteRef`、`sourceThreadRef`、`sourceDeleted`、`occurredAt`、逻辑 `historyKey` |
| `memory_provenance` | `sourceType/sourceId/sourceDeleted` |
| `memory_entity` | `memoryId/name` |
| `memory_person` / `alias` / `link` / `mention` | 人物、别名、关系、提及 |
| `memory_profile_pin` | 置顶状态 |
| `memory_import_batch` | 原始导入批次，保留原 id、source、item_count |
| `memory_consolidation_run/change/change_basis` | 整理记录及依据链 |
| `memory_episode` | 每日摘要文本与线程/序列元数据；**不导 embedding** |
| `decision` | `decision_ledger` 全列（kind、counts、verdict、outcome、reason_code、subject_ref、inputs、cost、duration、rating、rated_at、category、confidence、inferred 等） |
| `decision_payload` | `role`、`sequence`、`payloadRef`；原文进密封补充 |
| `decision_signal` | opened/undone/replied、时间、延迟、detail、source_ref |
| `source_insight` | 邮件洞察元数据、状态、rating；原文进密封补充 |
| `proactive_processed_message` | message/thread/decision、outcome、skip_reason、rating；邮件头原文进密封补充 |
| `muse_reference_entry` | Muse 校准元数据、内容/备注引用、配对决策；原文进密封补充 |
| `omission` | 被排除的 id、原因（deleted/restricted/third-party/unsupported）、条数 |

**关键点**：`decision_ledger` 用业务字段导出，绝不使用 OpenTelemetry `gen_ai.*` 字段；如需说明模型调用部分，只在文档里给对照表，不进入格式。

### 2.4 可读版

- `readable/MEMORY.md`：**分类索引**，不是全部正文。每条分类给计数、文件链接、最近更新时间；不复制正文，避免变成第二个事实源。
- `readable/memories/<category>.md`：每条记忆一个锚点块，包含：
  - `recordId`、状态、分类、重要度、记录时间、有效时间、实体；
  - 文本（已遮凭据；`sensitive` 默认占位，如 `[敏感内容未在可读版展开，见 memory:abc]`）；
  - 版本历史逐条列出；每条历史也有 `recordId`/`historyKey`；
  - 来源线程只给链接/标记，不展开整段对话。
- `readable/decisions.md`：每条决策一行/一块，带 `recordId`、kind、时间、结果、原因码、成本、耗时、主人评价、相关记忆/规则编号；模型输入输出只显示“已密封/已排除”的元数据，不显示第三方正文。

**索引 + 主题文件**是学 Claude Code；**不采用“一条记忆一个文件”**，因为一个人的记忆数可能上千，文件数过多；按分类分文件、每类内一条一块，兼顾可读性和文件数。如果 Andy 要求与 Claude Code 完全一致，可切换成一条记忆一个文件，这是展示层选择，不影响主数据。

**映射规则**：可读版每一条都带 `recordId`，且 `data/records.jsonl` 中必须有且只有一条同 `recordId` 的记录；决策证据的密封字段用 `recordId + field` 定位。测试按这个规则逐条对回。

### 2.5 导出范围与状态处理

| 对象 | 默认是否导出 | 主数据 | 可读版 | 说明 |
|---|---|---|---|---|
| `active` 记忆 | 是 | 元数据 + 可公开/私密文本；敏感文本 withheld | 是 | 核心 |
| `archived` | 是 | 同上 | 是 | 保留状态，不自动恢复 |
| `trashed` | 是 | 同上 | 是，标“已删除/可恢复” | 可恢复内容不应因导出丢失 |
| `tentative` | 是 | 同上 | 是，标“待确认” | 是记忆的一种状态 |
| `superseded_by` 指向的旧记忆 | 是 | 保留 `superseded_by` 链 | 是 | 版本历史要求 |
| `sensitive` / `sensitive_topic` | 是 | 文本进密封补充 | 默认占位；可选 `--readable-include-sensitive` 后用遮盖文本 | 不破坏回导 |
| `restricted` | **默认拒绝导出** | 无明文 | 无 | 见下 |
| `deletion_pending` / `deleted_verified` | 否 | 只记 `omission` | 否 | 尊重删除意图 |
| `memory_history_events` | 是 | 文本/引文进密封补充 | 是 | 版本历史核心 |
| `memory_provenance`、`entities`、`people`、`pins` | 是 | 明文元数据 | 人物页可选 | 检索和关系需要 |
| 整理记录、导入批次 | 是 | 明文元数据 | 摘要 | 保证“说得清” |
| `memory_episodes` | 是 | 摘要文本进密封补充；不导 embedding | 可选 | embedding 是可重建派生 |
| 决策记录 + 评价 + signals | 是 | 全部业务字段 | 是 | 评价必须逐条一致 |
| 决策模型输入输出 | 是（密封） | 原文进密封补充 | 否 | 默认保留以支持回导和审计；可用 `--decision-evidence=omit` 排除 |
| `source_insights` / `proactive_processed_messages` | 是（元数据 + 密封原文） | 邮件正文/头进密封补充 | 否 | 第三方内容不明文 |
| `muse_reference_entries` | 是（元数据 + 密封原文） | 内容/备注进密封补充 | 否 | 校准记录 |
| 检索索引、FTS、embedding | 否 | 无 | 无 | 派生数据，导入后重建 |
| 规则、工具、系统提示 | 否 | 无 | 无 | 本任务不混入；规则/工具另做开放格式导出 |

**`restricted` 的取舍**：按 ADR 0185，写入时就不应该有 `restricted` 记忆；如果历史数据里仍有，默认**整个导出失败**并列出 id，要求 Andy 先处理。若 Andy 明确允许，`--seal-restricted` 把其原文放进密封补充（仍无明文、可逐条回导）；`--omit-restricted` 则写 `omission`，但该条不能逐条一致。这是唯一需要 Andy 明确取舍的冲突点。

**`sensitive` 不冲突**：原文只进加密密封补充，明文主数据和可读版用占位符；导入时合并密封补充即可逐条一致，同时文件里没有明文敏感内容。

### 2.6 一致性快照

导出时服务可能在跑。采用以下顺序：

1. 打开产品 SQLite 的只读连接，开启一个读事务，读取所有相关表；在同一事务内读取 `payloads` 行。
2. 对 `storage_kind = ciphertext_file` 的 payload，读取密文文件并核对 `content_digest`/加密元数据；若文件在导出期间被删除或重包导致不一致，**中止本次导出并重试**。
3. 内存中解密文本后立即写入主数据/密封补充；不把明文 DB 快照落盘。若数据量大到读事务不可接受，再退回 `source.backup()` 生成临时快照，文件权限 `0600`，导出结束立即删除；该临时文件不属于导出产物。
4. manifest 记录 `snapshotAt`、各表/各记录类型条数；导出开始后新产生的记忆/决策不在本次快照内，这是**时间点快照**，不是停机冻结。
5. 导入必须停机：获取 state-root 锁或要求 `--confirm-stopped`，拒绝在服务运行时导入。

### 2.7 清单、加密、校验

`manifest.json` 关键字段：

```json
{
  "schema": "himawari.data-export.v1",
  "exportId": "export-...",
  "createdAt": "...",
  "source": {
    "ownerId": "...",
    "agentId": "...",
    "schemaSequence": 84,
    "commit": "...",
    "redactionRuleset": 2
  },
  "scope": {
    "memories": ["active", "archived", "trashed", "tentative", "superseded"],
    "withheldPolicy": "sensitive+credential+third-party",
    "decisionEvidence": "sealed",
    "restricted": "abort"
  },
  "counts": {
    "records": 0,
    "byType": {},
    "withheldPatches": 0,
    "readableEntries": 0
  },
  "files": [
    { "path": "data/records.jsonl", "sha256": "...", "bytes": 0 },
    { "path": "data/withheld.jsonl.enc", "sha256": "...", "bytes": 0 },
    { "path": "readable/MEMORY.md", "sha256": "...", "bytes": 0 }
  ],
  "crypto": {
    "kdf": "scrypt",
    "salt": "...",
    "n": 32768,
    "r": 8,
    "p": 1,
    "cipher": "aes-256-gcm",
    "wrappedDek": "...",
    "wrapNonce": "...",
    "wrapTag": "..."
  },
  "omissions": { "restricted": 0, "deleted": 0, "thirdParty": 0 },
  "retrieval": {
    "datasetSha256": "...",
    "model": "qwen3-embedding-8b",
    "dimensions": 4096,
    "thresholds": [],
    "metrics": {}
  },
  "authentication": { "algorithm": "hmac-sha256-v1", "value": "..." }
}
```

- **密钥**：passphrase 从 TTY 或 `--passphrase-file`（权限 0600）读取，绝不出现在命令行、日志、Trace（沿用 ADR 0019 的做法）。`scrypt` 派生 KEK，HKDF 分出 `manifestMacKey` 和 `dataKey`；随机 DEK 包住数据密钥。密文 AAD 包含 `exportId + logicalPath`，防止文件互换。
- **清单认证**：对去掉 `authentication` 的 canonical manifest 做 HMAC-SHA256；导入先验 HMAC，再验每个文件 SHA-256/字节数，再验条数。
- **严格解析**：字段集合、枚举、路径白名单（`data/records.jsonl`、`data/withheld.jsonl.enc`、`readable/*`）都像 `sqlite-recovery-point.ts:385-520` 那样严格；拒绝未知字段、重复路径、`../`、绝对路径、符号链接。
- **版本**：`schema` + `source.schemaSequence` + 每条记录的 `schema`。导入要求目标 schema sequence 与清单一致；按约束不做旧数据兼容，版本不符直接拒绝。

### 2.8 导入

新增本地 admin CLI（不经过模型、不经过浏览器）：

```text
himawari data export --out <dir> --passphrase-file <file>
himawari data inspect <bundle> --passphrase-file <file>
himawari data verify <bundle> --passphrase-file <file>
himawari data import <bundle> --target <state-root> --confirm-empty --passphrase-file <file>
```

导入步骤：

1. 校验 manifest 认证、文件哈希/大小、记录条数、记录 schema、ID 格式、枚举、引用图。
2. 解密密封补充，按 `recordId + field` 合并到主数据；要求每个 `withheld` 字段正好一个补丁，拒绝无主补丁和重复补丁。
3. 校验目标为空、schema sequence 一致、目标 owner/agent 唯一；若目标没有 owner/agent，用导出里的身份创建；若不同，导入时把 `owner_id/agent_id` 重写为目标身份（记忆/决策自身的 id 不重写）。
4. 在**一个 SQLite 事务**里按依赖顺序插入：owner/agent → payloads → 线程桩 → 导入批次 → 记忆 → 历史/来源/实体/人物 → 整理 → episodes → 决策/信号/相关表。自引用列（`superseded_by`、`merged_into`）先插 null 再更新。
5. 应用现有约束（外键、CHECK、`decision_signals` 不可改触发器）；任何失败整体回滚，目标保持空库。
6. 导入后重建派生数据：`memory_search_index`、`memory_search_terms`、`memory_episode_terms` 不导入，走现有记忆投影/嵌入路径重建；离线无法嵌入时明确返回 `DERIVED_REINDEX_REQUIRED`，不能假装检索已可用。
7. 输出 `import-report.json`（CLI 侧，不写新表）：记录导入条数、遗漏条数、重建状态、检索基线对比。**不需要新迁移**；如果 Andy 要求库内审计回执，才另议最小新表。

**为什么只导入空库、不做合并**：合并会遇到 id 冲突、版本分叉、评价冲突，且无法保证“逐条一致”；空库导入是可验证、可回滚的。合并留到未来单独 ADR。

### 2.9 与现有机制的关系

- **backup/restore**：保持同机恢复，不动。数据导出不是备份的替代，恢复点包含运行态、密钥包装、outbox 等，导出只含记忆/决策业务数据。
- **transfer**：保持权威迁移，不扩成通用导出；两者可复用 canonical manifest、AEAD、路径白名单、在线快照这些底层原语，但格式和语义分开（`himawari.authority-transfer.v1` vs `himawari.data-export.v1`）。
- **记忆页 `himawari-memories.json`**：改为“可读副本下载”，带 `schema` 和 `recordId`，明确**不是权威导出、不能回导**；或者直接删掉该按钮，指向 CLI。原 `parseMemoryExport` 只保留给第三方导入，并明确拒绝 `himawari.data-export.v1`/bundle，避免用户把完整导出误丢进“按文字去重、猜分类”的旧路径。
- **`memory.import.commit`**：保留用于粘贴/第三方文本导入，但它有 500 条上限、按文字去重、启发式分类；**不能**承担完整回导，否则历史、评价、敏感原文都会丢。

---

## 三、业界做法：学什么、不学什么

| 来源 | 做法 | 结论 |
|---|---|---|
| Claude 数据导出 | 记忆包含在总导出；邮件链接、24 小时失效、需登录 | **学**：记忆是用户数据的一部分；**不学**：只能下不能回导 |
| Claude 记忆导入/导出 | 推荐 `[date saved] - memory content`；强调 verbatim、不要摘要/分组/省略；导入实验性 | **学**：人类可读条目格式、导入后审阅；**不学**：让模型生成导出，天然有损 |
| Claude Code | `MEMORY.md` 索引 + 每主题一个文件；启动只读前 200 行/25KB；纯 Markdown | **学**：索引 + 主题文件、按需读取；**不学**：把上下文加载限制当导出限制 |
| Anthropic memory tool | `/memories` 文件目录，存储由应用控制，格式不规定 | **学**：存储/视图分离；**不学**：无格式、无校验 |
| Letta AgentFile | 开放 JSON，含记忆、消息、系统提示、工具源码、模型配置；秘密置 null；有迁移路线图 | **学**：开放格式、完整状态、秘密排除、版本化；**不学**：本任务不需要系统提示/工具源码，也不应让导入改变模型行为 |
| OpenAI ChatGPT 导出 | ZIP + `conversations.json` 树；一次性归档、不可导入（未核实） | **不学**：一次性 dump 不是可携带 |
| Google Takeout / Data Portability API | 用户选择产品；HTML/JSON；归档约 7 天过期；第三方应用要验证 | **学**：用户选择范围、JSON 机器可读、第三方代导要验证；**不学**：过期链接不适合本地自持 |
| Mem0 导出 | 异步任务、调用方给 Pydantic schema、按 user/agent 过滤 | **学**：schema 化、过滤范围；**不学**：调用方自定义 schema 作为权威格式 |
| GDPR Art. 20 | structured、commonly used、machine-readable；不损害他人权利 | **学**：JSONL/JSON + Markdown 是通用格式；**不学**：把第三方邮件正文当自己的可自由再分发数据 |

**结论**：机器格式和人类可读格式都要给；主数据用版本化 JSONL，人类/Agent 用 Markdown 索引 + 主题文件；导出要能回导，但只回导到空库；必须有格式版本、清单、哈希、条数、认证；不把模型生成内容当权威导出。

---

## 四、考虑过但不选的做法

1. **直接复用 backup/transfer 加密整库包**
   - 不选：含运行态、authority、密钥包装，且 ADR 0019 明确不是通用导出；没有人类可读版，不能给其他 Agent 读。

2. **整个导出全部明文 JSONL**
   - 不选：`sensitive`、凭据、`restricted`、第三方邮件正文会明文落盘，违反验收 #4。

3. **整个导出全部加密，只给一个密文包**
   - 不选：机器可读主数据不可读，其他 Agent 无法直接使用；只适合迁移，不适合“认识主人”。

4. **浏览器端生成完整导出**
   - 不选：浏览器拿不到决策账本、历史、加密 payload 的完整数据；无法做一致性快照、流式加密、大文件；passphrase/密钥在浏览器里风险高。

5. **让模型把记忆“verbatim”写出来作为导出**
   - 不选：模型会摘要、分组、改写、漏项；还会新增一次模型调用，可能改变请求和成本。Claude 的提示词也明说“不要摘要/分组/省略”，说明这是已知弱点。

6. **一条记忆一个 Markdown 文件（完全照 Claude Code）**
   - 不选为默认：文件数可能上千；按分类主题文件 + 每条锚点更合适。保留切换选项。

7. **一个巨大 JSON 数组**
   - 不选：不可流式、难以 diff、单条损坏影响全文件；JSONL 一行一条更适合记忆/决策这种追加型数据。

8. **把检索 embedding 一起导出**
   - 默认不选：embedding 是派生数据、模型相关、体积大；导入后重建。仅在需要离线精确复现评测时提供 `--include-derived-index` 作为可选项。

9. **用 CSV 导决策记录**
   - 不选：`counts`、`inputs`、`signals`、嵌套结构无法无损表达。

10. **用 OpenTelemetry GenAI 字段做决策记录格式**
    - 不选：约束明确禁止；`gen_ai.*` 描述单次模型调用，不是业务决策记录，且仍在 Development。

---

## 五、风险与反例

1. **反例：私有记忆里有规则没认出的秘密格式。** `redactForEgress` 是启发式，ADR 0185 已列出已知缺口；明文主数据/可读版仍可能漏掉未知格式。缓解：`sensitive`/凭据命中一律进密封补充；测试覆盖已知规则；文档明确“自动测试证明已知规则，不证明未知格式”。这是 Andy 要接受的残余风险。

2. **反例：同一段文字两次导出字节不同。** 如果在记录里放 `exportedAt`、随机 tag、依赖 `known` 的前后文遮盖，就会不同。缓解：记录内不放时间；`createdAt` 只在 manifest；每段文本独立 `maskSensitiveText`，不跨记录共享 `known`；数组顺序保留，对象键 canonical；测试导出两次解密后逐字节比较。

3. **反例：清单哈希对，但清单被改。** 只校验文件哈希不够；攻击者可重算哈希。缓解：manifest HMAC 用 passphrase 派生密钥；没有 passphrase 改不了认证值。反向测试要同时覆盖“改条数”“改文件哈希”“改 manifest 字段”。

4. **反例：`memory_history_events.rowid` 在导入后变化。** rowid 不是业务身份；可读版映射和验收必须用 `historyKey`（memoryId + occurredAt + kind + 序号/内容摘要），不能比 rowid。否则测试会假失败。

5. **反例：被删除记忆仍被 `superseded_by` 指向。** 导出排除 `deleted_verified` 后，live 记忆的 `superseded_by` 可能指向空。缓解：导出预检悬空引用；默认让该字段输出 `null` 并写 `omission`（记录原 id），或要求 Andy 先处理。不能生成导入必失败的包。

6. **反例：导入时 `restricted` 与“逐条一致”冲突。** 明文不能导出，密封可以但取决于是否允许“加密带走受限内容”。默认拒绝导出并让 Andy 处理；`--seal-restricted` 才可两者兼得（仍无明文）。这是明确的取舍。

7. **反例：并发写入/重包 payload。** 读事务快照与外部密文文件可能不一致。缓解：核对 `content_digest`，失败即中止重试；不接受“部分新部分旧”的包。

8. **反例：密码丢失。** 密封补充无法解密，只有明文主数据/可读版可用。必须在 README 和 CLI 明确警告，并建议把 passphrase 存在密码管理器；不提供后门。

9. **反例：`0085` 新枚举没进导出校验。** 导出/导入硬编码旧枚举会拒绝新值。缓解：从共享常量和当前 schema 读取；契约测试在最新迁移上跑；导入的 schema sequence 必须与目标一致。

10. **反例：导入目标非空。** 合并会覆盖/冲突。强制空库 + 事务回滚；反向测试先写入一条记忆，再导入，必须拒绝。

---

## 六、需要 Andy 拍板

1. **明文主数据的边界**：`public` + `private`（不含凭据）可进明文主数据，`sensitive/restricted/凭据/第三方正文` 进密封补充；还是连 `private` 也只给元数据+占位符？我建议前者，否则其他 Agent 几乎学不到偏好。
2. **`restricted` 历史数据**：默认拒绝导出并要求先处理；还是允许 `--seal-restricted` 加密带走以保证逐条一致；还是 `--omit-restricted` 只留 tombstone。
3. **决策证据**：默认把 `model_input/model_output`、邮件正文/头放进密封补充以支持完整回导；还是默认排除以最小化第三方内容。我建议默认密封、可读版永不展示，并给 `--decision-evidence=omit`。
4. **可读版的敏感内容**：默认只给占位符；还是允许主人显式 `--readable-include-sensitive` 输出遮盖后的敏感原文。
5. **导入范围**：只允许空库、精确 schema 版本、不合并；确认不做“导入已有库”。
6. **派生索引**：导入后重建（可能需要嵌入模型/网络）；还是允许 `--include-derived-index` 导出/恢复 embedding 以离线精确复现。我建议默认重建，评测用确定性嵌入器验证。
7. **trashed/archived/tentative**：默认全部导出（尊重可恢复/版本历史）；确认 `deletion_pending/deleted_verified` 不导出。
8. **浏览器旧导出**：删掉 `himawari-memories.json` 的“权威导出”语义，改成可读副本；还是暂时保留并明确标注不可回导。我建议改掉，避免两套格式。
9. **人类可读组织**：索引 + 按分类主题文件（推荐）；还是完全照 Claude Code 一条记忆一个文件。
10. **范围**：v1 是否包含 `memory_people`、`memory_episodes`、`muse_reference_entries`、`source_insights`；我建议包含，否则“拿得走”仍不完整。

---

## 七、逐条回答必答问题

### Q1：这个改动会不会改变模型已经见过的请求开头？

**不会。** 导出/导入是离线读库/写库路径，不新增模型工具，不改系统提示、工具定义、历史消息、遮盖规则，也不向任何线程追加消息。发给模型的内容仍然只在末尾追加，每轮变化的值仍然只在最后一条消息里。依据是 `prompt-prefix.md:28`、`:35`、`:36`、`:84-85`，以及本方案不触碰 `packages/prompt-catalog`、`runtime-pi`、`model-egress`。即使未来让模型读取可读导出，也必须作为**末尾追加的工具结果/消息**，不能插入系统提示；本次不做这个入口。

### Q2：会不会让同一段文字在不同请求里变成不同字节？

**模型请求不会**：本改动不产生/修改任何模型请求。
**导出文件本身**：采用 canonical JSON、固定记录排序、每段文本独立遮盖、记录内不放时间/随机值；同一规则集下同一文本产生相同字节。`manifest.createdAt`、`exportId`、加密 nonce 会每次不同，但它们不参与“同一段文字”的内容；测试只比较解密后的记录和可读投影。遮盖规则版本记录在 manifest，规则升级后旧导出仍可解释；不要跨记录共享 `known` map，不要用随机 `tag`。这与 `prompt-prefix.md:51` 的“同样的内容，每次都要序列化成同样的字节”一致。

### Q3：有没有对应的自动检查，反向用例是否真的会失败？

有。新增 `npm run check:data-export`，并加入 `package.json` 的 `check:steps`（当前 `check` 已包含 `check:egress-redaction`、`check:prompt-prefix`，同样方式扩展）。测试包括：

| 测试 | 正向 | 反向用例（必须失败） |
|---|---|---|
| 往返一致 | 导出→空库导入→逐条比较记忆/历史/评价/信号 | 少一条历史、改一个 rating、改一个 id，比较必须失败 |
| 清单 | 正确包导入成功 | 改 `counts`、改文件 SHA-256、截断文件、加未列文件、`../` 路径，导入必须拒绝且目标仍为空 |
| 可读映射 | 每个 Markdown 条目 `recordId` 都能在主数据找到 | 删掉一个 `recordId`/改成不存在的 id，映射检查必须失败 |
| 机密不外泄 | 种子密码/卡号/证件号/验证码，明文文件扫描无原值 | 去掉 `maskSensitiveText` 调用，扫描必须失败 |
| 敏感/受限 | 敏感原文只在密封文件；restricted 默认拒绝 | 把敏感原文写进 `records.jsonl` 或可读版，扫描/断言必须失败 |
| 确定性 | 同一快照导出两次，解密后记录字节相同 | 在记录里加 `Date.now()`，测试必须失败 |
| 生产者→消费者（I-73） | 导出里的每个 id/枚举都能过导入校验 | 造一个带 `/` 或超长 id，导出预检或导入契约必须失败 |
| 空库/版本 | 空库、同 schema 成功 | 非空目标、旧 schema、错 passphrase，必须拒绝且不部分写入 |
| 检索评测 | 用同一数据集/确定性嵌入器，源库与导入库分数一致 | 不重建索引或改 importance/entities，分数必须变化并被测试捕获 |

“反向用例真的会失败”按 I-73 的方式验收：在 PR 里逐个临时去掉对应校验，确认测试变红并记录；不是只写 happy path。I-73 的教训是“双模型复核只看了改动，没问清单里的 id 能通过后端校验吗”，所以本方案专门有“导出产物必须过导入校验器”的契约测试。

### Q4：每个产生/修改的值，使用它的地方都能接受吗？

按 I-73，逐个核对“产生端 → 消费端”：

| 值 | 产生端 | 消费端/校验 |
|---|---|---|
| `exportId` | 导出器生成 | manifest 严格解析（字符集/长度）、AAD、导入报告；不直接当 DB 主键 |
| `ownerId`/`agentId` | 源 DB / 目标解析 | 导入时用 domain `createOwnerId/createAgentId`；目标唯一性检查；重写所有 `owner_id/agent_id` |
| 记忆/历史/人物/批次/整理 id | 源 DB | domain `createMemoryId` 或对应 DB CHECK；导入前统一预检；I-73 契约测试逐个过 |
| 决策/信号/洞察/Muse id | 源 DB（DB CHECK 长度 1–128） | 导入 schema 按 DB CHECK 同规则校验，不额外加更严字符集 |
| `status/classification/category/kind/outcome/verdict/owner_rating/sensitive_topic` | 源 DB CHECK + 共享常量 | 导入枚举校验必须与当前迁移一致；0085 新值从共享常量读取 |
| `contentRef/reasonRef/payloadRef` | 源 DB | 导出预检每个引用都有 `payload` 记录；导入外键 + 先插 payload；缺失即拒绝 |
| `sourceThreadId` | 源 DB | 导出为线程 id；导入创建 stub thread（无消息）或按声明 omission 置空；不接受悬空外键 |
| `supersededBy/importBatchId/decisionId/pairedDecisionId/changeBasis.memoryId` | 源 DB | 导出预检引用图；导入按依赖顺序插入 + 外键；悬空即拒绝 |
| `inputs.memoryIds/ruleIds/resultMemoryIds...` | 源 DB JSON | 导出解析后 canonical 输出；导入解析并验证每个 id 存在于本包或 omission 声明 |
| `counts`、`rowCounts` | 导出器统计 | 导入重新计算并逐项比较；不一致拒绝 |
| `files[].sha256/bytes` | 导出器 | 导入重新计算；不一致拒绝 |
| `schemaSequence` | `schema_migration_ledger` | 导入要求与目标一致；不一致拒绝 |
| `redactionRuleset` | `EGRESS_RULESET_CURRENT` | 导出记录、测试和文档读取；导入不靠它恢复数据，但用于解释 |
| `historyKey`/`recordId` | 导出器 | 可读版与主数据映射测试；导入用于定位补丁，不写入 DB |
| `crypto.kdf/salt/nonce/tag/wrappedDek` | 导出器 | 导入严格解析、长度/算法校验；错了拒绝 |
| 文件路径 | 导出器 | 导入路径白名单、规范化、拒 `../`/绝对路径/符号链接 |
| passphrase | 主人输入 | 只从 TTY/0600 文件读；不进 argv/日志/Trace |

结论：不能只检查改动本身；导出器的每个输出都要走一遍导入器/DB 约束，测试里用同一套校验器验证“导出产物可导入”。

---

## 八、已证实与推测/未核实

**已证实（读代码/来源）**

- 记忆/历史/决策账本的表结构、字段、状态枚举、加密 payload 引用：迁移 `0001`、`0052`、`0057`、`0065`、`0069`、`0070`、`0080`、`0084` 及相应 operations。
- 现有导出只导 active 子集、无历史/评价/回导：`memory-page.tsx:2024-2060`、`memory-import.ts:151-183`。
- 现有 backup/transfer 是整库权威迁移、不提供通用导出：ADR 0019、`sqlite-recovery-point.ts`、`sqlite-authority-transfer.ts`。
- 遮盖函数和登记规则：`sensitive-capture`、`check-egress-redaction.mjs`。
- SQLite 快照语义、JCS、Claude/Claude Code/Anthropic memory tool/Letta/Google/Mem0/GDPR 的引文：对应网址已抓取。
- 自动检查入口：`package.json:14-27`、`:51-52`。

**推测/设计建议（未实现）**

- 用“明文主数据 + 密封补充 + 可读投影”的具体目录/字段拆分，是本方案的设计，不是仓库现状。
- 导入后的派生索引重建方式、CLI 命令名、passphrase UX、`--seal-restricted` 等，需要在实现时定。
- 检索评测“导入后分数一致”需要确定性嵌入器或缓存；真实嵌入服务是否逐位确定，**未核实**。
- OpenAI 官方页面 403、GDPR WP242 PDF、OTel GenAI 最新状态、0085 具体内容，**未核实**。

**未核实**

- OpenAI 导出的 `conversations.json` 细节、是否含单独记忆文件。
- Gemini 数据在 My Activity 的具体官方说明。
- GDPR WP242 rev.01 的 PDF 原文（仅依据二手摘要）。
- OpenTelemetry GenAI 语义约定的当前 Development 状态（按 Andy 说明，未逐页核实）。
