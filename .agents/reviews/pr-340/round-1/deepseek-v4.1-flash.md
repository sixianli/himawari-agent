## 读代码证实的问题（按严重度）

### 1. 中：只要任一记忆正文是 `ciphertext_file`，整份导出会直接失败
- 文件：`packages/persistence-sqlite/src/data-export/snapshot.ts:211-219`，`packages/persistence-sqlite/src/data-export/export.ts:113-120`
- 问题：快照只接受 `storage_kind === "sqlite_blob"` 且 `ciphertext !== null`；其他情况一律记成 `{ unavailable: true }`。记忆正文用的是 `requiredText`，拿不到就抛 `PAYLOAD_UNAVAILABLE`，整次导出中止；而 `payloads` 表明确允许 `ciphertext_file`（`migrations/0001_initial_product_schema.sql:62`）。
- 证据：
  - `snapshot.ts:211-219`：`!row || row.storage_kind !== "sqlite_blob" || row.ciphertext === null ... payloads.set(ref, { unavailable: true });`
  - `export.ts:118-120`：`const value = exportedText(...); if (value === null) throw new DataExportError(... PAYLOAD_UNAVAILABLE ...)`
- 建议：导出应通过 `PayloadStorePort` 读取 `ciphertext_file`；若确实无法读取，按记忆逐条跳过并写进 `omitted`，不要因一条正文让整份导出失败。
- 说明：`HybridPayloadStore` 在生产是否已接线我未核实；但表结构与现有恢复/迁移代码允许该状态存在。

### 2. 中：明文层的机密/受限检查只覆盖 payload 正文，其他自由文本未检查
- 文件：`packages/persistence-sqlite/src/data-export/export.ts:102-111`、`:192-201`、`:276-300`
- 问题：只有 `exportedText()` 里的正文经过 `hasSecret/mask`；`memory_entities.name`、`people.name/aliases`、`provenance.sourceId`、`decision.subjectRef/pushSourceKey/inputs/signal.detail` 都原样写进明文文件。`restricted` 也只按 `memory_records.classification` 过滤（`snapshot.ts:42,52`），没有排除 `payloads.classification='restricted'` 的正文或证据。
- 证据：
  - `export.ts:102`：`if (!options.policy.hasSecret(text)) return { ...base, text };`（只对正文）
  - `export.ts:197`：`entities: ...map((entity) => str(entity["name"]))`
  - `export.ts:296`：`inputs: JSON.parse(str(row["inputs"])) as JsonValue`
  - `snapshot.ts:223` 只是把 `row.classification` 放进结果，`export.ts` 未据此拒绝。
- 建议：对所有导出字符串统一走策略，或至少对实体、人名/别名、来源 id、决策 inputs/detail 做同样的敏感值扫描；额外拒绝 `payloads.classification='restricted'`。
- 说明：`restricted` payload 与普通记忆/决策的组合在生产上的可达性我未完全核实，但表结构允许。

### 3. 中：导入创建的骨架线程是“活动”线程，和 ADR/文档不符
- 文件：`packages/persistence-sqlite/src/data-export/import.ts:393-398`；`docs/adr/0200-portable-export-of-memories-and-decisions.md:88`
- 问题：导入把线程插成 `status='open'` 且没有写 `archived_at`。线程列表的 `active` 查询条件是 `status='open' AND archived_at IS NULL`，因此这个空线程会出现在活动线程列表里；ADR 却说它是“已关闭的线程……不显示在线程列表的活动区”。
- 证据：
  - `import.ts:395-396`：`INSERT INTO threads ... VALUES (?, ?, ?, 1, 'open', ?, ?)`
  - `sqlite-thread-operations.ts:1406-1407`：`case "active": return "(status = 'open' AND archived_at IS NULL)"`
  - ADR 0200:88：“导入会留下一个空的、已关闭的线程……不显示在线程列表的活动区。”
- 建议：写入 `archived_at = now`（或改成归档状态），并加一条集成测试断言 `thread.list(statuses:["active"])` 看不到它。

### 4. 中：指向未导出记忆/上游记录的编号没有按 ADR 过滤
- 文件：`packages/persistence-sqlite/src/data-export/export.ts:194`、`:244`、`:296`、`:300`、`:282`
- 问题：ADR 0200 第 53 行要求“线程编号和上游记录编号去掉”，并“指向未导出记忆的取代关系、关联和整理条目置空或过滤”。代码只过滤了 `supersededBy`、`relatedMemoryId`、`basis`；`beforeSupersededBy`、`provenance.sourceId`、决策 `inputs`（含 `sourceIds`/`memoryByMail`）、`subjectRef`、`pushSourceKey`、`signal.sourceRef` 都原样保留。
- 证据：
  - `export.ts:244`：`beforeSupersededBy: optionalString(change["before_superseded_by"])`（无过滤）
  - `export.ts:194`：`sourceId: str(source["source_id"])`
  - `export.ts:296`：`inputs: JSON.parse(str(row["inputs"])) as JsonValue`
  - `export.ts:300`：`pushSourceKey: optionalString(row["push_source_key"])`
- 建议：对全部指针型字段统一按“目标是否已导出”过滤，或把决策 `inputs` 中的 `sourceIds/memoryByMail` 等键清洗掉；并在测试里放一条引用 restricted/已删除记忆的用例。

### 5. 中：导入目录读取没有总大小上限，可被大目录耗尽内存
- 文件：`packages/persistence-sqlite/src/data-export/directory.ts:6-7,38-40`，`packages/persistence-sqlite/src/data-export/verify.ts:24`
- 问题：只限制单文件 512MB、文件数 4096，却把每个文件完整读进内存；总量可到约 2TB。`parseLines` 也先把整个文件解码成字符串再按行切。恶意或损坏的导出目录可让 `data inspect/import` 耗尽内存。
- 证据：
  - `directory.ts:6-7`：`MAXIMUM_FILE_BYTES = 512 * 1024 * 1024; MAXIMUM_FILES = 4096`
  - `directory.ts:40`：`files.set(relative, new Uint8Array(await readFile(full)))`
- 建议：增加总字节上限、逐文件流式校验，或至少达到上限时立即拒绝。

### 6. 低：历史封存原文的 key 用数据库序号，导入却用导出数组序号，可能静默丢历史
- 文件：`packages/persistence-sqlite/src/data-export/export.ts:138-143`，`packages/persistence-sqlite/src/data-export/import.ts:149-154`
- 问题：导出时 `forEach` 的 `index` 是数据库历史数组下标；如果前面某条事件因正文不可用被跳过，后面被扣留的事件仍用原下标生成 key。导入时却按“导出文件里的 history 数组下标”去找 key，二者错位，被扣留的历史事件会被当成找不到原文而跳过。
- 证据：
  - `export.ts:138-143`：`(history.get(id) ?? []).forEach((event, index) => { ... \`memory/${id}/history/${index}/content\` ... if (content === null) { ... return; }`
  - `import.ts:149-154`：`for (const [index, event] of memory.history.entries()) { const text = original(\`memory/${memory.id}/history/${index}/content\`, event.content); ...`
- 建议：导出时先生成最终事件数组，再用最终数组下标写 key；或给 key 用稳定 id 而不是数组下标。

### 7. 低：导出侧不限制文件/行大小，导入侧却有限制，自己的导出可能导入不了
- 文件：`packages/persistence-sqlite/src/data-export/directory.ts:6-7`，`packages/persistence-sqlite/src/data-export/verify.ts:24,257-258`，`packages/persistence-sqlite/src/data-export/schemas.ts:30`
- 问题：单段文本允许 1,000,000 字符，历史事件数量不限；导出 `put()`（`export.ts:317-335`）不做行大小/文件大小检查。导入却限制单行 8MB、单文件 512MB。一条带多版本长文本的记忆可以生成合法导出，但 `parseLines` 会以 `LINE_INVALID` 拒绝。
- 证据：
  - `verify.ts:24`：`const MAXIMUM_LINE_BYTES = 8 * 1024 * 1024;`
  - `verify.ts:257-258`：`if (line.length > MAXIMUM_LINE_BYTES) throw ...`
  - `export.ts:317-335` 的 `put()` 没有对应上限。
- 建议：导出端使用与导入端相同的上限并在导出时明确失败/分片，或放宽导入端限制；补一条大文本/多历史的往返用例。

### 8. 低：空库检查只查 5 张表，muse 等表可能有残留，导致导入在事务中途失败
- 文件：`packages/persistence-sqlite/src/data-export/import.ts:56-62,525`，`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:125-146`
- 问题：`EMPTY_TARGET_TABLES` 只有 `memory_records/decision_ledger/memory_people/memory_import_batches/memory_consolidation_runs`。`muse_reference_entries.paired_decision_id` 是 `ON DELETE SET NULL`，所以决策删掉后 muse 行可以留下来；随后带 evidence 的导入可能撞主键或唯一键，在写入事务里才失败。
- 证据：`import.ts:56-62`；`import.ts:525` 的 `writeEvidence(...)`；`0069_decision_ledger.sql:135` 的 `paired_decision_id ... ON DELETE SET NULL`。
- 建议：把导入会写入的所有表都纳入空库检查，或在插入前按导入 id 检查冲突并给出明确错误。

### 9. 低：schema 的 maxLength 比数据库约束更严，合法库数据可能导出成自己不能导入的包
- 文件：`packages/persistence-sqlite/src/data-export/schemas.ts:76,82,113,157`；`packages/persistence-sqlite/src/migrations/0057_memory_page.sql:24-25`；`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:394-404`；`packages/persistence-sqlite/src/sqlite-memory-book-operations.ts:335`
- 问题：例如 `memory_people.id` 在数据库里是 `TEXT PRIMARY KEY`（无长度限制），生产代码会生成 `person:${memoryId}:${ordinal}`；`PERSON_SCHEMA.id` 却限制 128 字符。`policy_version`、`provenance.source_type/source_id`、`trigger_run_id`、`before_status` 等也存在“DB 宽、schema 窄”的情况。只要数据库里有超长值，导出会成功，`data inspect`/`import` 会因 schema 校验拒绝自己的导出。
- 证据：`schemas.ts:76`：`id: text(1, 128)`；`sqlite-memory-book-operations.ts:335`：`personId = \`person:${input.memoryId}:${ordinal}\``。
- 建议：让导出 schema 与数据库/生产生成规则取同一上限，或在导出时对超长值给出明确错误；补一条长 id 用例。

### 10. 低：几处文档/实现小偏差
- 权限：`directory.ts:13-16` 只对新建目录使用 `mode: 0o700`，已存在的空目录不会 `chmod`；ADR 0200:60 写“导出目录……权限 0700”。
- 报告：`import.ts:227-230` 在未解密封存文件时仍把 `sealedOriginals` 报成清单里的数量。
- `data-command.ts:121` 硬编码 `"sealed/sealed.enc"`，没复用 `SEALED_FILE`。
- `markdown.ts:12,57-70` 按“500 条记录”分片，但 ADR 0200:51 写“每个文件最多 500 行”；实际文件还有 5 行表头和空行。

---

## 推测 / 未核实

- `ciphertext_file` 在当前生产接线中是否会被记忆正文使用：未核实；代码和表结构允许，恢复/迁移代码也识别该状态。
- `restricted` payload 挂在非 restricted 记忆或决策上的组合是否真实出现：未核实；表结构允许，代码未拒绝。
- 非 payload 自由文本里是否会实际出现机密（实体名、别名、来源 id 等）：未核实；代码确实没有对它们调用 `hasSecret/mask`。
- `docs/prd-v0.2.md` 的新 SHA-256 和 269 条列表计数是否与文件逐字一致：未核实（本环境不能重算 SHA-256）。
- `test/fixtures/v0.2/coverage-manifest.json` 新增的 `V02-RULE-13A` / `V02-ACC-10A` 我已对照 S0 表确认两处 ID、owner 都存在且一致；但 PRD digest 仍要靠 `check:v0.2-coverage` 实际运行确认。

---

## 侧重检查（错误路径、不可信输入、安全、资源、不可撤销操作、文档一致性）

- 错误路径：错口令、篡改文件、缺文件、多文件、路径逃逸、迁移号不符、条数不符都有明确错误码；导入在数据库事务里，失败回滚。已核对 `verify.ts:205-240`、`import.ts:262-527`。
- 不可信输入/路径：`assertSafePath` 拒绝绝对路径、`..`、反斜杠、NUL；`readPortableDirectory` 用 `lstat` 拒绝符号链接；已核对 `verify.ts:162-172`、`directory.ts:28-41`。
- 安全：封存使用 scrypt(N=32768,r=8,p=1) + AES-256-GCM，头部作 AAD，salt/nonce 校验长度；口令文件拒绝 group/other 位；已核对 `seal.ts:41-112`、`data-command.ts:79-87`。但明文层仍有第 2 条所述未检查字段。
- 资源耗尽：单文件/文件数有上限，但总量无上限（第 5 条）；导出端无对应限制（第 7 条）。
- 不可撤销操作：`--confirm IMPORT_DATA_<agentId>`、`--dry-run`、非空目标拒绝、单事务写入均已实现；但空库检查不完整（第 8 条），且导出中途 I/O 失败可能留下部分目录。
- 文档一致性：ADR 的“已关闭线程”“0700”“过滤未导出引用”“每文件 500 行”与代码存在上述偏差；PRD 的核心验收（往返一致、整份拒绝、Markdown 回查、无明文机密）整体方向与实现一致。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次 diff 只新增数据导出/导入、`platform-node` 文本策略、admin CLI、文档和测试；没有改系统提示、工具定义、历史消息或模型出口遮盖代码。发给模型的内容没有新增任何“中途改写”；导入产生的新记忆只会在后续轮次按现有记忆注入逻辑出现，不属于本次改动对请求开头的改写。具体注入位置未在本次核对范围内（未核实）。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对模型请求：不会，本 PR 不触碰请求组装。对导出数据：`canonicalJson()` 递归排序对象键，SQL 都有显式 `ORDER BY`，遮盖 `redactForExternalText` 不依赖前后消息，同一文本在同一策略版本下字节确定。会变化的只有 `manifest.exportedAt`（`now()`）和密封文件的随机 salt/nonce，因此整个目录/封存文件每次导出不同，但 `data/*.jsonl`、`schema/*`、`memory/*.md` 在同一数据库和策略下是确定的；这些不发给模型。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   有：`package.json` 把 `check:data-export` 加进 `check:steps`，`scripts/check-data-export.mjs` 跑 35 条带 `[P1-6]` 的测试，失败或通过数不足都会非零。反向用例是实打实的断言：改字节/截断/改条数/改哈希/多余文件/缺文件/路径逃逸/未知格式/迁移号不符/非法枚举/断引用/数据库约束/错误口令/遮盖关闭/无索引检索/未确认导入等都会报错。缺口是：门槛按“通过条数”而不是按“具体反向用例存在”判断，删掉一条反向用例再加一条普通用例仍会通过；另外 ciphertext_file、超大文件/行、非 payload 自由文本机密都没有覆盖。

4. **每个产生/修改的值，使用它的地方都能接受吗？**
   已逐个核对：manifest 格式/迁移号/角色/计数/哈希由 `MANIFEST_SCHEMA` 和 `verifyIntegrity` 校验；数据文件路径经 `assertSafePath`；记忆/人物/批次/整理/决策的枚举、状态、类别、评分、信号类型与数据库 CHECK 一致；`withheld`、JSON 字段、密封条数也有对应校验。发现的不能接受或未覆盖之处已在第 1、2、4、6、7、8、9 条列出，尤其是 `ciphertext_file`、未过滤的指针/inputs、历史 key 错位、以及 schema 长度比数据库窄。新增的 coverage manifest 的 `V02-RULE-13A`、`V02-ACC-10A` 已确认在 manifest 和 S0 覆盖表中都存在且 owner 一致；PRD digest 未核实。
