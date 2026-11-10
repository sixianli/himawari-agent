I'll start by exploring the repository structure and reading the key files referenced in the plan.
Bash only permits git commands. Let me use the file tools.
Now let me examine the schema, the memory page download, the ports, and how redaction is invoked in production.
I have enough code evidence. Let me verify one key external claim that shapes the design (Claude Code memory index limits) from the primary source.
# P1-6 数据导出方案审核

核对提交：`fd283e437a172cfbe807dddaae5da674cc814c18`。我只读了文件和一手资料，没有运行代码。除了 Claude Code 的 memory 文档（已重新打开核对），方案里的其他厂商页面没有重新抓取，相关结论标“未核实”。

## 侧重检查

| 路径 | 查了什么 | 结论 |
|---|---|---|
| 错误路径 | import 的校验顺序、事务、空库判断、FK、索引重建、payload 解密失败、磁盘满、写一半崩溃 | 索引重建走不通；多处 FK 会被违反；空库判断范围不足；没有磁盘/大小上限 |
| 不可信输入 | manifest、jsonl、schema、sealed、路径、格式版本、迁移号 | 只校验 `format_version`，未提 `schema_migration`、路径穿越、未知字段、行长度/文件大小 |
| 安全 | 遮盖、裸密码、机器密钥、sealed KDF、导出文件权限、Markdown 注入、下载鉴权 | `redactForEgress` 认不出“记忆本身就是密码”；机器密钥不可还原；sealed 的占位符方案不成立；文件权限/鉴权未设计 |
| 资源耗尽 | 100 万条记忆、全部历史、解密、sha256、zip、长读事务、WAL | 方案没有流式、上限、磁盘预检；长读事务会让 WAL 增长 |
| 不可撤销 | 导入到运行中的库、没有备份/回滚、状态根锁 | 服务实际持有状态根锁；导入是写操作，方案没有要求停机/单写者 |
| 规则/文档一致 | prompt-prefix、ADR 0019、PRD 67、ADR 0148/0183/0188、`check:egress-redaction`、`check:glossary`、`ci/policy.json` | 方案与 PRD 67 直接冲突；直接调用 `redactForEgress` 会被 `check:egress-redaction` 拒绝；对 `check:glossary` 的理解有误 |

## 证实的（按严重度）

### 高

**1. “版本历史”的正文根本没有保存，方案的核心数据模型不成立**

- 问题：方案说每条记忆导出“当前状态 + history[]”，并把“版本历史”当作完整形态。但 `MemoryHistoryNote` 只有 `kind/quoteRef/sourceThreadId`（`packages/application/src/ports/memory-projection.ts:99-103`）；写历史时 `content_ref` 用的是 `memory.contentRef`，也就是当前正文（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:856-870`）；更新路径先改 `memory_records.content_ref`，再写历史（同文件 `767-809`）。所以所有历史行都指向当前正文，`stance` 也是当前 stance。ADR 0113 说“每行存当时的文字”，代码没有做到。
- 影响：导出端拿不到旧版本正文；方案里的“造一个有版本历史的库 → 导出 → 导入 → 逐字节相同”和“逐条一致”会失败，或者只是把当前正文重复 N 次。
- 建议：v1 明确只导出历史元数据（kind/stance/quote/source/occurred_at），并在方案和验收里写明“旧版本正文不可得”；如果确实要完整版本历史，先补 `history_content_ref` 或历史快照 payload（并同步修 ADR 0113），再谈“完整导出”。

**2. 导入后没有任何现成路径能重建检索索引**

- 问题：方案说“导入后由投影任务重建”，并标“未核实”。实际路径是 `requeueProjection`，但它只处理已经有投影任务的记忆：`jobs.listByMemory(memoryId)).at(-1)?.generationId`，没有就 `continue`（`packages/application/src/services/durable-memory-service.ts:469-480`）。`memory_projection_jobs.generation_id` 又必须指向 `memory_generations`（`0001_initial_product_schema.sql:418-430`），而 `memory_generations` 需要 `thread_checkpoint_jobs` 和 `threads`（同文件 `381-391`）。空库导入后没有线程、检查点、generation、投影任务，启动时的 `listUnindexed` 循环调 `requeueProjection` 会全部跳过（`apps/agent-service/src/service-main.ts:1177-1193`）。仓库里也没有生产用的 reindex/rebuild 命令。
- 影响：导入的记忆进不了 `memory_search_index`/`memory_search_terms`，向量和全文检索都看不到；“导入后检索评测分数相同”不成立。
- 建议：给导入定义一条明确的重建路径：要么新增一个受支持的 reindex 命令，用 `MemoryIndexStorePort.upsert` 和配置好的 embedder 重建；要么在导入时创建合成 thread/checkpoint/generation 并走现有 `saveWithProjection`。把“索引重建成功”作为导入成功的条件，并加测试。

**3. 导出/导入模型漏了 payload 层，多个 NOT NULL/FK 列写不进去**

- 问题：记忆正文、历史正文、决策的 reason/content 都存在 `payloads`，由 `content_ref`/`quote_ref`/`reason_ref`/`content_ref` 引用（`0001_initial_product_schema.sql:57-74,399`；`0065_memory_history.sql:7-9`；`0069_decision_ledger.sql:22-23`；`0070_decision_ledger_payloads.sql:3-6`）。方案的 `data/*.jsonl` 没有 payload 文件或 ref 生成规则，§2.3 又说“只读 manifest + data/*.jsonl”“导入只写现有表”。`memory_records.content_ref` 是 NOT NULL，restricted 条目正文置 `null` 也仍然需要一个 payload 行。`memory_history_events.quote_ref` 还需要导出原话。方案完全没提这些。
- 影响：导入端无法合法写入 `memory_records`/`memory_history_events`/`decision_ledger`；或者只能生成新 ref，导致决策、历史、记忆之间的引用关系丢失。
- 建议：在导出格式里增加 `payloads` 段（ref、contentType、classification、lifecycle、明文或遮盖后文本），或者定义“导入时按内容重新生成 ref”的规则并给出 ref 映射。导入顺序必须是 payloads → memories → history → decisions → signals/basis。确保 `content_digest`、classification 与引用方一致。

**4. 服务运行时其实持有状态根锁；“导出可以只读打开数据库”的前提是错的**

- 问题：方案说 `apps/agent-service/src` 里没有 `acquireStateRootLock` 的引用，所以推断服务不持锁。实际锁在 persistence 包里：`SqliteProductStateRepository.open` 调 `acquireStateRootLock`（`packages/persistence-sqlite/src/product-state-repository.ts:220`），服务正是用它打开的（`apps/agent-service/src/service-main.ts:695`）。锁会拒绝活着的持有者（`packages/persistence-sqlite/src/state-root-lock.ts:139-145`）。所以独立 CLI 在服务运行时拿不到锁；直接打开数据库文件又绕开了“单写者/状态根锁”的设计。WAL 下读事务能拿到一致快照是对的（SQLite 官方 WAL 文档，`https://www.sqlite.org/wal.html`；ADR 0131 第 45 行也引用），但导入是写操作。
- 影响：按方案实现会出现“CLI 导出抢不到锁”或“绕过锁导入正在运行的库”；后者可能和服务的写连接、内存投影、删除流程冲突，是不可撤销操作。
- 建议：导出放在服务进程内，用已有的只读读 lane（ADR 0131 的 `readOnly: true` 连接）和单个读事务；或者要求停服务并取得状态根锁。导入必须要求停服务或走服务唯一写 lane，并在导入前创建 recovery point。把前提 6 改成“服务持有状态根锁，导出必须走服务内读 lane 或停机”。

**5. 敏感内容：裸密码、机器密钥、占位符还原三处都与方案说法不符**

- 问题：
  - `redactForEgress` 只认“关键词 + 值”的密码，值还要求有数字（`packages/sensitive-capture/src/redaction.ts:79-97`）。ADR 0188 第 53 行明确承认全字母口令、关键词和值隔开的写法认不出。“记忆本身就是密码”（方案 §4）正好是裸密码，明文层会直接漏。
  - 机器密钥在 `redactForEgress` 里被固定替换成 `[密钥]`，不走 `tag`/`table`（`redaction.ts:331-338`）；ADR 0148 第 42 行和 ADR 0183 第 38 行都写明“机器密钥不可还原”。方案的 sealed 层说“被遮盖的原文都能还原”，对机器密钥不成立。
  - 默认 `redactForEgress(text)` 产出的是 `[密码]`，不是方案引用的 `[密码#xxxxxxxx]`（`redaction.ts:317`；测试 `packages/sensitive-capture/test/redaction.unit.test.ts:337-338` 直接断言 `密码：[密码]`）。`#xxxxxxxx` 需要传 `tag` 回调。多个同类值如果都用 `[密码]`，sealed 里无法区分谁对应谁；如果改用主机密钥 tag（`model-egress.ts:121-126`），导出不跨主机、不能带走；如果改用普通哈希，低熵密码的指纹可被离线爆破。
- 影响：验收 4“导出文件无明文机密”无法由 `redactForEgress` 单独保证；sealed 层对机器密钥和同类多值都还原不了。
- 建议：单独做“导出遮盖”，不要直接复用模型出口的默认行为。至少要做到：按 classification/sensitiveTopic 对裸密码做扣留或遮盖；明确机器密钥永不进 sealed；sealed 层用带认证的加密（如 scrypt/Argon2id + AES-256-GCM），占位符到原文的映射用唯一标识并整体放进 sealed；把 tag 方案、是否可移植、是否可爆破写进方案和安全测试。

**6. 决策记录/信号/整理依据的字段过不了数据库 CHECK，或所需父表没导出**

- 问题：`decision_ledger` 的 CHECK 要求：`proactive` 必须有 `scenario` 和 `verdict`、`outcome IS NULL`；`memory_candidate` 才有 category/confidence/inferred；`owner_rating` 与 `rated_at` 成对（`0069_decision_ledger.sql:11-55`）。方案的字段表只写“outcome/verdict”“category/confidence/inferred”，没有 `scenario`、`checked_at`、`push_source_key`。`decision_signals` 还要求 `detail` JSON 对象、`source_ref`、毫秒格式的 `occurred_at`/`recorded_at`（`0080_decision_signals.sql:5-12`），方案只写 `signals[]`。`decision_ledger_payloads` 需要 `sequence` 和 `role`（`0070_decision_ledger_payloads.sql:3-6`）。`memory_consolidation_change_basis` 的 `change_id` 引用 `memory_consolidation_changes`、后者引用 `memory_consolidation_runs`（`0084_memory_consolidation_basis.sql:1-7`），方案说要导“依据”，却没导这两张父表。
- 影响：导入 6 种 kind 的决策记录时，部分 kind 会因 CHECK 失败；signals 和 consolidation basis 写不进去。
- 建议：逐个列出 `decision_ledger` 所有列、所有 CHECK 分支、`decision_signals` 所有列、`decision_ledger_payloads` 的 sequence/role；把 `memory_consolidation_runs/changes/basis` 加入导出，或删掉“依据”承诺。加一个覆盖 6 种 kind 的导入测试。

**7. 指向未导出对象的 FK 没有逐个列举；provenance 的 source_type 也写错**

- 问题：方案 §2.5 只提到 `memory_history_events.source_thread_id`，但同类 FK 至少还有：
  - `memory_records.source_thread_id → threads`（`0001_initial_product_schema.sql:401`）
  - `memory_records.import_batch_id → memory_import_batches`（`0057_memory_page.sql:13-14`）
  - `memory_records.superseded_by → memory_records`（`0052_memory_engine.sql:5`）；如果被指向的记忆是 `deletion_pending` 而不导出，导入会 FK 失败
  - `memory_person_mentions.person_id`、`memory_person_links.other_person_id → memory_people`（`0057_memory_page.sql:39-58`）；只导出“被记忆提到的人”可能不闭合
  - `decision_ledger.owner_id/agent_id → owners/agents`（`0069_decision_ledger.sql:3-4`）

  另外，现有代码写 `memory_provenance` 用的是 `source_type='reference'`，不是 `'thread'`（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:818-824`）。方案 §2.5 说“导入时写入 `source_type='thread'`”，与生产写入不一致；读取方 `sources()` 目前不按 type 过滤（同文件 `455-462`），所以不会立刻出错，但改变了数据语义。
- 影响：导入会因 FK 失败；或者为了让 FK 通过而丢掉本应保留的引用；provenance 的类型被改写，未来按类型消费的代码会漏。
- 建议：列一张“所有指向未导出对象的 FK”清单，逐列决定置 NULL、保留原值并导出父表、还是用 `xxxById` 字段保留引用。`memory_provenance` 保留导出的 `source_type/source_id/source_deleted`，不要改写成 `thread`。`superseded_by` 指向未导出记忆时置 NULL 并保留 `supersededById` 供人读。people 导出要包含被 links/merged_into 引用的全部人物，或裁剪关系。

**8. 导入是不可撤销操作，但“空库”判断和停机要求都不足**

- 问题：方案 §2.3 第 ④ 步只要求“没有任何记忆和决策记录”。目标库可能已有 threads、payloads、people、import_batches、owners/agents，甚至服务正在运行。导入保留原 id，一旦写错或写一半，没有备份/回滚/dry-run。方案没有要求停服务，也没有在导入前创建 recovery point。
- 影响：可能把数据写进非空库、和现有线程/人物/批次的 id 冲突，或服务并发写入造成不可撤销的损坏。
- 建议：导入前检查所有会写入的表和 FK 父表；要求服务停止并取得状态根锁，或走服务唯一写 lane；导入前自动创建 recovery point；提供 `--dry-run` 和确认提示；失败整体回滚；文档写明如何撤销。

### 中

**9. 字节确定性：嵌套数组顺序和序列化规则没有定义**

- 问题：规则要求 JSON 键顺序、列表顺序固定（`.claude/rules/prompt-prefix.md:51`），但方案只写“jsonl 每行键顺序固定（Schema 里按固定顺序序列化）”。JSON Schema 不控制序列化顺序，需要显式稳定序列化器。`history[]`、`provenance[]`、`entities[]`、`people[]`、`signals[]` 都没有排序规则；现有 `memory_history_events` 读取用 `ORDER BY occurred_at, rowid`（`sqlite-memory-operations.ts:907`），而方案说顶层按 `recorded_at, id`。`recorded_at` 在 schema 里允许 NULL（`0053_memory_episodes.sql:1-2`），NULL 的排序语义也要定。`redactForEgress` 还可能依赖 `known`/`trusted`/`tag` 参数（`redaction.ts:248-272,411-425`）。
- 影响：往返测试“逐字节相同”不稳定；同一份数据在不同版本/不同导出参数下字节不同。
- 建议：用显式 canonical serializer（可参考 recovery point 的 `stableJson`），固定每个字段的顺序；给每个数组定排序键（provenance 按 `(source_type, source_id)`，entities 按 name，people 按 id，history 按 `(occurred_at,rowid)`，signals 按 `(decision_id, signal, source_ref)`）；把 `recorded_at` 改成 `COALESCE(recorded_at, updated_at)` 并在 manifest 记录规则；导出遮盖固定 `{ruleset}`，不要共享 `known/trusted/table`，除非 manifest 一并记录。

**10. manifest/jsonl/sealed 是不可信输入，但只校验了 format_version**

- 问题：方案只写“校验 manifest 格式版本（只认已知版本）”。没有 `schema_migration` 校验（导出较新库、导入较旧代码时会静默写错）；没有 manifest 文件名的路径穿越检查；没有未知字段/文件大小/单行长度上限；`schema/*.schema.json` 根本不被 import 读取，用它校验又可能被篡改（manifest 不签名）。sealed 文件在“不给口令”时是否校验也没有说。
- 影响：恶意或损坏的目录可能写到导出目录外、耗尽内存、或用宽松 schema 绕过校验。
- 建议：用内置 schema 校验 manifest，拒绝未知字段；固定文件清单；路径 canonicalize 后必须落在导出目录内；限制单文件大小/行数/总条数；校验 `schema_migration` 不高于目标库的迁移序列；import 使用代码内置的 JSON Schema，导出目录里的 schema 只做对照并校验其 sha256；无论是否使用 sealed 都校验它的 sha256。

**11. 资源耗尽：100 万条记忆的导出/导入没有边界**

- 问题：方案要导出所有记忆、历史、决策，逐条 `unprotect`、序列化、算 sha256，可能还要 zip。没有总字节/条数上限、没有磁盘预检、没有超时；导入“一个事务写入”也没有说明是否流式。持久层本身有 `assertDiskHeadroom`（如 `sqlite-memory-operations.ts:689`），但方案没用。长读事务在 WAL 下会让 WAL 增长，可能撑满磁盘。
- 影响：导出可能把磁盘写满或让服务变慢；导入可能在事务中耗尽内存或触发 WAL 膨胀。
- 建议：流式逐条写；设置可配置的总条数/总字节上限并提前失败；导出前后检查磁盘余量；读事务设超时；导入分两遍（先校验哈希/条数，再流式写一个事务）或写临时库再原子切换；文档写明内存/WAL 限制。

**12. 导出文件权限和下载鉴权没有设计**

- 问题：导出目录是主人的全部明文记忆，还可能有 sealed 原文。方案只写“服务端生成、前端下载 zip”，没有说目录/文件权限、临时目录清理、下载接口的 owner 鉴权/CSRF、旧文件保留时间。
- 影响：同机其他用户或未授权请求可能读到明文导出。
- 建议：目录 0700、文件 0600；在临时目录生成并在下载后删除；下载接口只允许已认证 owner，带 CSRF 防护；UI 明确提示导出包含敏感内容；sealed 口令文件也按 0600 检查。

**13. `check:egress-redaction` 会直接拒绝新导出模块**

- 问题：`scripts/check-egress-redaction.mjs:18-26` 规定只有 `REDACTOR_ONLY_FILES` 里的文件能直接调用 `redactForEgress`；`:178-181` 明确报“只有出口模块能直接调用 redactForEgress，请改走 ModelEgress”。方案 §2.4 说“只调 `redactForEgress`”，但没有把新导出文件登记进这个白名单，也没提 `check:egress-redaction`。
- 影响：实现后 `npm run check` 会失败；如果为了通过而改共享的 egress 逻辑，又可能改变发给模型的遮盖字节。
- 建议：要么把新导出模块加入 `REDACTOR_ONLY_FILES` 并写明理由，要么在 `sensitive-capture` 里新增一个专门的 `redactForExport` 入口（不改变 `ModelEgress` 的默认行为），再更新检查脚本和测试。把这一步写进方案的自动检查清单。

**14. 与 PRD/ADR 的明确非目标冲突**

- 问题：`docs/prd-v0.2.md:67` 明确写“本版本不包含：人类可读或通用机器可读的数据导出；只提供受控权威迁移所需的机器迁移包”。方案自己也引用了这一行，但只打算“在 ADR 0019 里加一条”，没有说要改 PRD 或取得 Andy 的明确拍板。ADR 0019:28 也说不提供这类导出。
- 影响：实现完成的产品与 v0.2 PRD 直接矛盾；按项目规则，这需要显式决策记录，不能只加一行 ADR 备注。
- 建议：把“数据导出是 P1-6 的新目标，取代 PRD v0.2 的非目标”写成 Andy 拍板 + 新 ADR（或修订 ADR 0019），并同步 PRD、glossary、界面文案。否则方案不应动工。

**15. Markdown 导出可能被当成指令执行**

- 问题：方案让 `MEMORY.md`/主题文件“给人和其他 Agent 先读”，并写“文件内容是记录不是指令”。但记忆来源可能是外部内容（`memory_provenance.source_type='reference'`），另一 Agent（如 Claude Code）会把 Markdown 当上下文读取；一句“忽略之前的指令”可能被遵循。Claude Code 官方文档也说明 memory 文件是“context, not enforced configuration”（https://code.claude.com/docs/en/memory）。
- 影响：导出可能成为提示注入的传递通道。
- 建议：生成 Markdown 时把记忆正文放在明确的分隔块/引用块里，转义控制字符和明显的指令性前缀；不要只依赖一行警告；机器读路径仍以 `data/*.jsonl` 为准。

**16. 记忆页现有导出的语义会被静默改变**

- 问题：当前导出排除 `trashed`、`tentative`，且只有勾选“导出敏感”才包含 sensitive/topic 条目（`apps/control-center/src/components/memory-page.tsx:2033-2052`）。方案的新服务端导出包含 active/archived/trashed、并总是处理 sensitive。原来的复选框会失去意义，用户可能意外导出已 trash 的内容。
- 影响：界面行为和文案不一致；用户预期被打破。
- 建议：在 UI 保留范围选项（active/archived/trashed、是否包含敏感），映射到 manifest 的 `scope`；更新 i18n/帮助文案；不要静默扩大范围。

**17. 测试有循环论证，且关键路径没有反向用例**

- 问题：
  - 测试 4 用 `findSensitiveValues` 扫描导出目录，但 `findSensitiveValues` 自己就是 `redactForEgress` 的观察模式（`redaction.ts:434-437`）。遮盖漏掉的值，扫描同样漏掉，测试仍通过。它无法证明“裸密码”“机器密钥”不在目录里。
  - 测试 1 想用 `evals/memory-retrieval` 验证分数相同，但 `eval:memory-retrieval` 是需要 `--confirm-cost` 的真实付费资格测试（`package.json:93`），并被 `ci/policy.json:166` 排除在常规集成测试之外；方案说的“已有评测替身/固定向量”并不存在现成 CI 路径。
  - 没有针对 FK 失败、索引重建失败、manifest 路径穿越、`schema_migration` 不匹配的失败用例。
- 影响：安全检查会给出虚假通过；核心导入路径没有被测试覆盖。
- 建议：对每个构造的敏感值做字面断言（包括裸密码、机器密钥、银行卡、证件号），并分别做“关掉遮盖必须失败”的反向用例；用确定性的嵌入替身做 CI 内往返/检索测试，付费 live 测试只作为上线前手动项；为每个 FK、索引重建、路径穿越、迁移号不匹配加导入失败测试。

**18. 字段覆盖不完整，往返“逐条一致”会漏列**

- 问题：方案的记忆字段是“当前状态 + 历史 + 来源 + 实体 + 人物提及”，但没有逐一列出 `use_count`、`last_used_at`、`evidence_verified`、`valid_from/valid_to`、`importance_permille`、`tentative`、`sub_category`、`stance`、`provider_record_id`、`import_batch_id`、`source_thread_id`、`policy_version` 等。当前页面导出只导 7 个字段，方案也没给出完整的列清单。`provider_record_id` 还有 UNIQUE 约束（`0001_initial_product_schema.sql:405`），导入保留它但外部 provider 状态没导入，会让系统误以为已同步。
- 影响：往返不一致；某些列导入后丢失或冲突。
- 建议：以 `memory_records` 的当前全部列（以及 `0042`/`0052`/`0053`/`0054`/`0057` 加的列）为清单，逐列说明导出/导入/置 NULL 的规则；`provider_record_id` 要么置 NULL 等重新投影，要么把外部投影状态一起迁移并测试。

### 低（可以更好）

**19. 对 `check:glossary` 的理解有误**

- 证据：`scripts/check-glossary.mjs:101-150` 只检查“旧叫法”是否还在用，不要求把新词登记进词表。方案 §5 Q4 说“新词‘导出包’‘密封层’要登记词表”，这不是该检查的作用。
- 建议：把这条从“必须做”改为“如果替换了旧叫法才需要登记”；真正要检查的是新 UI 文案不要引入旧词。

**20. `schema/*.schema.json` 和 sealed 的清单覆盖不一致**

- 问题：§2.3 说 import 只读 `manifest.json` + `data/*.jsonl`，但 §2.1 又说 schema 文件含格式版本和字段含义；sealed 文件在 `--seal` 时存在。如果 import 不读 schema，它只是文档；如果 sealed 不在 manifest 里，篡改无法发现。
- 建议：明确 schema 文件是“文档”还是“校验输入”；manifest 必须覆盖所有实际存在的文件（含 sealed），不论 import 是否使用。

**21. 新 CLI 命令命名和入口不清**

- 证据：现有 admin CLI 已有 `backup`、`transfer export/import/activate`（`apps/admin-cli/src/index.ts:104-125`）。方案新增顶层 `himawari import <目录>`，容易和 `transfer import` 混淆。
- 建议：命名为 `himawari data export/import` 之类；说明它从哪里取 owner/agent 身份、是否需要配置、是走服务内 HTTP 还是 CLI。

**22. 按“分类”分 Markdown 文件可能过大**

- 证据：方案说 `memory/<分类>.md` 每个分类一个文件；Claude Code 官方文档说 `MEMORY.md` 只加载前 200 行或 25KB，主题文件按需读（https://code.claude.com/docs/en/memory）。分类只有 10 个左右，100 万条记忆会让一个主题文件极大，按需读也会一次加载过多。
- 建议：按更细的主题分文件，并给单文件大小/行数上限；`MEMORY.md` 只做索引和指针。

## 推测 / 未核实

- **资源耗尽的实际影响**：1M 条时 WAL 增长、内存峰值、zip 时间没有实测，属于推断。
- **Markdown 注入的实际可利用性**：取决于读取导出目录的 Agent 是否把 Markdown 当指令；Claude Code 文档说它当 context，但不同 Agent 行为不同。
- **导出目录/HTTP 下载的实际暴露面**：方案没有写部署方式，无法确认是否同机多用户或公网可达。
- **sealed 导入后再导出的字节是否稳定**：如果不带口令导入，占位符被当普通文本保存，再导出可能一致；带口令还原后再导出会重新生成映射，方案没有说测试口径，未核实。
- **`recorded_at` 在生产是否可能为 NULL**：schema 允许，0053 给旧数据回填；新写入用 `updatedAt`，但直接 SQL 或其他路径是否会产生 NULL 未逐一核实。
- **其它厂商页面**：除 Claude Code memory 文档外，Claude 导出、Letta、ChatGPT、Mem0、GDPR 的原文这次没有重新抓取，方案里的引用按“未核实”对待。

## 如果由我来定，我会这样改这份方案

1. **先把数据模型补全，再谈格式**：以 `payloads` + `memory_records` + `memory_history_events` + `memory_provenance` + `memory_entities` + `memory_people/aliases/links/mentions` + `decision_ledger` + `decision_signals` + `decision_ledger_payloads` + `memory_consolidation_*` 为完整清单，逐表写“导出哪些列、导入怎么落、哪些 FK 置 NULL”。不要在没有 payloads 段的情况下声称能逐条一致。
2. **修正“版本历史”的承诺**：v1 只导历史元数据，明确旧正文不可得；要完整版本历史就先改历史写入模型（新增历史正文 payload），否则验收标准改成“历史元数据一致”。
3. **导出走服务内读 lane 或停机取锁**：不要在服务运行时用第二个进程直接打开 SQLite。导出用只读连接 + 单读事务；导入要求停服务/状态根锁 + 导入前 recovery point + dry-run + 回滚。
4. **把索引重建当成导入的一部分**：新增可测试的 reindex 路径（`memoryIndex.upsert` + embedder），或者导入时创建合成 generation；没有重建成功就不算导入成功。
5. **敏感策略单独设计**：新增“导出遮盖”入口，不复用模型出口默认行为；裸密码按 classification/sensitiveTopic 扣留；机器密钥明确不可还原；sealed 用认证加密 + 唯一映射；把 tag 方案、可移植性、离线爆破风险写清楚。
6. **字节确定性写死**：显式 canonical serializer、所有数组的排序键、`COALESCE(recorded_at, updated_at)`、固定遮盖 `ruleset`、manifest 记录这些规则。
7. **输入校验和资源上限**：manifest 内置 schema、固定文件清单、路径穿越检查、大小/条数上限、`schema_migration` 校验、流式读写、磁盘预检。
8. **补齐自动检查和反向用例**：`check:egress-redaction` 登记新模块；`check:prompt-prefix` 证明共享遮盖未变；字面敏感值断言；FK/索引/路径/迁移号失败用例；CI 内确定性检索测试。
9. **文档先行**：请 Andy 明确拍板 P1-6 取代 PRD v0.2 的非目标，更新 PRD 和 ADR 0019（或新 ADR），再动代码。

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**导出本身不会，但有三个条件必须写死。**

- 导出/导入不向模型发请求；只要不改系统提示、工具定义、历史消息，也不改 `ModelEgress` 的默认遮盖行为，就不会改变已见请求开头。
- **遮盖结果属于请求开头的一部分**。方案 §2.4 说要对齐并行线程“让模型能用上敏感记忆”的占位符和分级。如果为此改 `redactForEgress` 的默认参数、`EGRESS_RULESET_CURRENT` 或 `ModelEgress` 的 tag 方案，就会改变新对话的请求字节；已有对话有按对话冻结的 ruleset 版本（ADR 0188:54-60），绝不能改。导出必须用独立的遮盖配置，不能反过来影响出口。
- 导入会把遮盖后的文本写进库里。之后这些记忆进入“最后一条用户消息”的资料块，属于末尾追加，符合只追加；但如果导入到已有对话/已有记忆并替换文本，就会改历史，方案已经用“目标库必须空”避免了这一点，需要保持。
- **每轮会变的值**：导出功能本身没有每轮值；`manifest` 的导出时间不进入模型请求。索引重建的 embedding 调用是后台调用，不是对话前缀，不涉及 KV 缓存；但它会产生模型/嵌入请求和费用，方案不能写“导入不发任何模型请求”。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**严格说不适用（导出不发对话请求），但导出文件本身有两个确定性缺口。**

- 如果导出复用 `ModelEgress` 的主机 HMAC tag，占位符字节依赖主机密钥；跨主机或密钥轮换后同一段文字会不同。如果导出复用 `known`/`trusted`/`table`，遮盖还会依赖前文或提示词目录，不满足“只取决于该条自身文字”。
- 导出文件的字节：方案说“Schema 里按固定顺序序列化”是错的；JSON Schema 不控制键顺序。`history[]`、`provenance[]`、`entities[]`、`people[]`、`signals[]` 没有排序规则；`recorded_at` 允许 NULL；manifest 带导出时间。必须用显式稳定序列化器、固定每个数组的排序、明确 `COALESCE(recorded_at, updated_at)`，才能让往返测试稳定。
- 如果使用 sealed 且导入时还原原文，再导出会重新生成占位符映射，字节可能不同；方案要明确 sealed 路径是否参与“逐字节相同”测试。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**方向对，但现有测试不足以证明它说的东西。**

- 测试 2（改文件/删行/加行/改条数/改格式版本必须拒绝且一行不写）是好反向用例；需要补：manifest 未知字段、路径穿越、`schema_migration` 不匹配、每个 FK 失败。
- 测试 4 **循环论证**：`findSensitiveValues` 就是同一个 `redactForEgress`，遮盖漏掉的值扫描也漏掉。必须对每个构造的敏感值做字面断言，并覆盖裸密码、机器密钥、“记忆本身就是密码”；反向用例要证明关掉遮盖后这些字面断言失败。
- 测试 1 的检索评测目前是付费 live 资格测试（`package.json:93`，`ci/policy.json:166` 排除），不是 CI 测试；需要确定性的嵌入替身或固定向量夹具，否则“分数相同”无法在 CI 里守。
- 测试 5 的快照一致性只在“导出用单个读事务”时成立；payload 在事务外读虽然因不可变而相对安全，但 lifecycle 变化、删除/回收站场景没有覆盖。
- 还必须加 `check:egress-redaction` 的用例：新导出模块直接调用 `redactForEgress` 会被现有检查拒绝（`scripts/check-egress-redaction.mjs:178-181`），要么登记，要么走新入口。`check:prompt-prefix` 要继续通过，证明没有改到模型出口。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

逐个核对后的结论是 **不能全部接受**：

- `format_version`：import 只认已知版本，可以。
- `schema_migration`：manifest 里有，但方案没有说 import 校验；必须拒绝“导出库比目标代码新”的情况。
- manifest 文件清单/路径：没有路径穿越和固定文件清单校验；`schema/*.schema.json` 不被 import 读取，可能只是文档或被篡改。
- `source_type`：生产写入是 `'reference'`（`sqlite-memory-operations.ts:818-824`），方案却写 `'thread'`；使用方 `sources()` 目前不按类型过滤，但这是隐性契约变更，必须保留原值。
- `memory_records.source_thread_id`/`import_batch_id`/`superseded_by`、`memory_person_mentions`/`links`、`decision owner/agent`：都是 FK，目标空库没有对应行；方案只处理了 history 的 `source_thread_id`，需要逐列置 NULL/导父表/保留引用字段。
- `decision_ledger.scenario`、`verdict`、`outcome`、`owner_rating/rated_at`、`category/confidence/inferred`：数据库 CHECK 有严格组合；方案的字段表没有覆盖全部，导入会失败。
- `decision_signals.detail/source_ref/occurred_at/recorded_at`：方案只写 `signals[]`，不够。
- `decision_ledger_payloads.sequence/role`：方案没写；`--with-model-io` 时缺少这个映射就写不进去。
- `memory_consolidation_change_basis.change_id`：父表 `memory_consolidation_changes/runs` 没导出，依据写不进去。
- `memory_projection_jobs.generation_id`/`memory_search_index.memory_revision`：没有 generation 就没有索引重建路径；导入后检索不可用。
- `provider_record_id`：UNIQUE；保留但外部 provider 状态没导入会不一致，建议置 NULL 等重新投影。
- 占位符：默认 `[密码]` 不带编号；sealed 需要唯一映射；方案引用的 `[密码#xxxxxxxx]` 只在传 `tag` 时出现。
- `check:egress-redaction`：新的直接 `redactForEgress` 调用会被现有检查拒绝，必须登记或改用新入口。
- `check:glossary`：新词不要求登记；方案的“待核”项本身理解有误。
- PRD v0.2:67：仍然是“不做人类可读/通用机器可读导出”；这是文档与代码一致性问题，必须在动工前由 Andy 拍板并改文档。
