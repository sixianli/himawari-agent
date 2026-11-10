## 作者说法核对（先对照代码）

- 实体名、人物名/别名、来源编号、决定记录 `subjectRef`/`inputs`/信号 `detail`/`sourceRef`/`pushSourceKey`：确实都过了 `safeString`/`safeJson`（`export.ts:113-129,214,217,230-236,301-302,315-320`）。但对象 **键名** 和 `counts` 没有过遮盖（`export.ts:125` 只递归值；`export.ts:311` 直接 `JSON.parse`），且这些遮盖结果**没有写进封存文件 `originals`**（见问题 3）。
- 占位线程写 `archived_at`：属实（`import.ts:395-402`），列在 `0015_thread_lifecycle_and_search.sql:9`。
- 历史封存原文编号改用最终数组下标：属实（`export.ts:157-163`），能修好“前一条被丢弃后密钥错位”。
- 空库检查增加三张表：属实（`import.ts:56-65`）。
- 2GB 总量上限、写前 chmod 0700、编号 Schema 128→512、单行 8MB→64MB：属实（`directory.ts:8,16,43-45`、`schemas.ts` 多处、`verify.ts:24`）。但 512 与数据库 128 不一致，见问题 2。
- `before_superseded_by` 按已导出记忆过滤：只在**导出**端过滤（`export.ts:264`），**导入**端没有按实际导入集合过滤（见问题 4）。
- `ciphertext_file` 记忆正文导出明确报错：属实。`snapshot.ts:211-219` 把非 `sqlite_blob` 标成 `unavailable`，记忆正文经 `requiredText` 抛 `PAYLOAD_UNAVAILABLE`（`export.ts:130-138`）。
- 门槛 40 条：属实。`check-data-export.mjs:14` 要求 40；我数到 29 个带 `[P1-6]` 的 `it`，其中一个循环展开 12 次，共 40 条断言结果。

## 读代码证实的问题

### 1. 高：逐值遮盖会把不同秘密压成同一个占位符，导入时撞主键/唯一键，整份导出无法恢复

- 文件:行：`packages/persistence-sqlite/src/data-export/export.ts:113-117`、`:214`、`:217`、`:236`、`:302`；`packages/sensitive-capture/src/redaction.ts:69-70`、`:317-328`；`packages/sensitive-capture/src/external.ts:60-73`
- 问题：`safeString` 对每个字段**单独**调用 `policy.mask`。机器密钥固定遮成 `[密钥]`（`MACHINE_SECRET_PLACEHOLDER = "[密钥]"`），其余类型每次调用都从 `aaaaaaaa` 重新编号。因此两个不同的秘密出现在两个不同的实体名/别名/来源编号里时，会被压成**完全相同的字符串**。
  - `memory_entities` 主键是 `(memory_id, name)`，且 `name` 还有 `length 1..64`（`0052_memory_engine.sql:8-10`）；
  - `memory_person_aliases` 主键是 `(person_id, alias)`（`0057_memory_page.sql:44-47`）；
  - `memory_provenance` 主键是 `(memory_id, source_type, source_id)`（`0001_initial_product_schema.sql:410-412`）；
  - `decision_signals` 唯一键是 `(decision_id, signal, source_ref)`（`0080_decision_signals.sql:2-11`）。

  例如同一记忆的两条来源编号分别是两个不同的 `sk-...`，遮盖后都变成 `[密钥]`，导出文件仍合法（Schema 只要求字符串），导入时却在 `memory_provenance` 主键上失败，整个导入回滚。别名、实体名同理。
- 另一个同源问题：遮盖后的字符串可能**变长**，超过字段上限。`entities`/人物名/别名最大 64、`relation`/`reverseRelation` 最大 32、`subjectRef`/`pushSourceKey`/`sourceRef` 最大 256（`schemas.ts:118,129-135,206,210,226`）。`safeString` 不做长度检查，导出也不在写盘前自校验，结果会导出一个自己的 `parsePortable` 都拒绝的包（`verify.ts:265-270` 的 `LINE_INVALID`）。
- 证据：`export.ts:113-117` 只返回遮盖值，没有去重/长度处理；`redaction.ts:69-70` 的固定占位符；`export.ts:214` 对 `sourceId` 逐个映射。
- 建议：占位符改成由秘密值本身确定性派生的标识（例如对原值做 HMAC/哈希后取简短后缀），让不同秘密必得不同占位符；导出落盘前对所有生成行跑一遍同一套 Schema 校验；补“两个不同秘密进入实体/别名/来源编号”的往返测试，以及“遮盖后长度超限”的反向用例。

### 2. 中：编号 Schema 放宽到 512，但数据库仍限制 128，JSON Schema 接受的值数据库不接受（I-73 同类）

- 文件:行：`packages/persistence-sqlite/src/data-export/schemas.ts:189,221,242,251,261,275,288,295`；`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:2,77,126`；`packages/persistence-sqlite/src/migrations/0080_decision_signals.sql:2`
- 问题：`DECISION_SCHEMA.id`、信号 `id`、证据里的 `decisionId`、`sourceInsights.id`、`processedMessages.decisionId`、`museEntries.id`/`pairedDecisionId` 都从 128 放宽到 512；但数据库是：
  - `decision_ledger.id ... CHECK (length(id) BETWEEN 1 AND 128)`（0069:2）
  - `source_insights.id ... CHECK (length(id) BETWEEN 1 AND 128)`（0069:77）
  - `muse_reference_entries.id ... CHECK (length(id) BETWEEN 1 AND 128)`（0069:126）
  - `decision_signals.id ... CHECK (length(id) BETWEEN 1 AND 128)`（0080:2）

  导入时 `parseLines` 用 Schema 校验会放行 129~512 字符的 id（`verify.ts:265-270`），到 `INSERT` 才撞数据库 CHECK/外键，抛出的是裸 SQLite 约束错误而不是 `DataExportError`。这正是 I-73 的类型：清单/Schema 里的值能通过前置校验，后端却不接受。
- 建议：要么把这几类字段的 Schema 仍限制为 128，要么同时迁移数据库约束；加一条 129/512 字符边界 id 的导入测试，明确期望的错误码。

### 3. 中：新增自由文字遮盖的原文没有进封存文件，清单也不算“扣留”，与 ADR 明确说法冲突

- 文件:行：`packages/persistence-sqlite/src/data-export/export.ts:90-117`、`:431-436`；`docs/adr/0200-portable-export-of-memories-and-decisions.md:53-54`
- 问题：ADR 第 53 条说实体名、人物名/别名、来源编号、决定主题/输入/信号细节“同样过一遍机密检查，命中就换成遮盖后的文字”，第 54 条接着说“原文只进封存文件的 `originals`”。但代码中只有 `exportedText` 会把原文写入 `originals`（`export.ts:102-111`）；新的 `safeString`（`export.ts:113-117`）只返回遮盖值，既不写 `originals`，也不加入 `withheldKeys`/`withheldOwners`，因此：
  - 即使提供了口令，这些字段的原文也无法从封存文件恢复，导入后永久丢失；
  - 清单 `withheld`（`export.ts:431-436`）不包含这些遮盖，用户看不到发生过遮盖；
  - CLI 的“有扣留项又不设口令时拒绝”判断（`data-command.ts:174-179`）不会触发，导出可以在没有任何提示的情况下把机密字段永久替换掉。
- 证据：`export.ts:106-110` 中 `exportedText` 有 `originals[key] = text` 和 `withheldKeys.add(key)`；`safeString` 对应位置完全没有。
- 建议：让 `safeString` 也接收 key/owner 并把原文写入 `originals`、计入 `withheld`；若确实打算“只遮不存”，就把 ADR 第 53-54 条改成明确说明这些字段不可恢复、且不触发口令要求。
- 同一问题还有个小分支：`safeJson` 只遮值不遮键（`export.ts:125`），`counts` 完全没遮（`export.ts:311`）。当前生产者写入的 `inputs` 键是邮件/记忆编号、`counts` 是数字，实际泄密概率低，但契约上没有保证。

### 4. 中低：`beforeSupersededBy` 只按“已导出”过滤，没按“已导入”过滤，无口令导入会留下悬空引用

- 文件:行：`packages/persistence-sqlite/src/data-export/export.ts:140-142,264`；`packages/persistence-sqlite/src/data-export/import.ts:105-115,472`；`packages/persistence-sqlite/src/data-export/verify.ts:346-352`
- 问题：导出端 `keepMemoryRef` 用的是**导出集合** `memoryIds`（包含内容被扣留、稍后无口令会被跳过的记忆）。导入端无口令时会跳过这些记忆（`import.ts:109-115`），但写入整理改动时 `entry.beforeSupersededBy` 原样写库（`import.ts:472`），`parsePortable` 也没有校验这个字段（`verify.ts:346-352` 只查 `memoryId`/`relatedMemoryId`/`basis`）。结果是导入后的 `memory_consolidation_changes.before_superseded_by` 可能指向一条不存在的记忆；再次导出时又会被过滤成 `null`，所以“导入后再导出”在这里也不稳定。
- 建议：在导入写入前用 `importedMemoryIds` 过滤 `beforeSupersededBy`，或在 `parsePortable` 里校验；补无口令导入该场景的测试。

### 5. 低：写导出目录会在“非空检查”之前 chmod，且会跟随符号链接

- 文件:行：`packages/persistence-sqlite/src/data-export/directory.ts:15-18`
- 问题：先 `mkdir` → `chmod(root, 0o700)` → 再检查非空。若用户把 `--out` 指到一个已存在且非空的目录，命令虽然失败，但该目录权限已经被改成 0700；若 `root` 是指向别处的符号链接，`chmod` 会作用到链接目标（`path.resolve` 不解析符号链接）。这是不可逆的副作用。
- 建议：先 `lstat` 根目录（拒绝符号链接、确认是目录），完成“非空”检查后再 chmod；只对本次新建的目录 chmod。

### 6. 低：磁盘/内存上限仍有残留风险，且新上限无直接测试

- 文件:行：`packages/persistence-sqlite/src/data-export/directory.ts:43-46`；`packages/persistence-sqlite/src/data-export/verify.ts:24,250-258`
- 问题：`readPortableDirectory` 虽然把总量限制到 2GB，但仍然把所有文件完整读进 `Map`（`files.set(... new Uint8Array(await readFile(...)))`），2GB 加上 `decoder.decode`/`split` 的临时副本足以把 Node 堆打爆。单行上限从 8MB 提到 64MB 后，`text.slice(0,-1).split("\n")` 和一次 `JSON.parse` 的最坏内存占用也同步放大。这些新阈值没有测试。
- 建议：至少降低单行/总量上限，或改为流式逐行解析；补边界值测试（超总量、超单行）并断言返回 `PATH_UNSAFE`/`LINE_INVALID`。

### 7. 低：ADR 与代码还有两处小不一致

- 文件:行：`docs/adr/0200-portable-export-of-memories-and-decisions.md:59-60`；`packages/persistence-sqlite/src/data-export/import.ts:56-65`；`apps/admin-cli/src/data-command.ts:83`
- 问题：
  - ADR 第 59 条把“空库”定义为“没有任何记忆、决定记录、人物、导入批次、整理记录”，代码现在检查 8 张表（多了 `source_insights`、`proactive_processed_messages`、`muse_reference_entries`）。虽然更安全，但文档没有同步，且 `muse` 行在没有决定记录时也可能独立存在，会拒绝文档口径下“空”的目标库。
  - ADR 第 60 条说口令文件“权限为 0600”，代码只要求 group/other 位为空（`(status.mode & 0o077) !== 0` 才拒绝），`0700` 也会通过。
- 建议：同步 ADR 措辞，或把代码收紧到真正的 0600。

## 推测 / 未核实

- 问题 1 的主键冲突和长度溢出是**机制上确定成立**的，但具体触发取决于真实数据里是否存在“两个只差秘密的实体/别名/来源编号”或“遮盖后跨过 64/32/256 字符上限”的记录；我没有运行出实际失败样例。
- 问题 6 是否会在生产 OOM 取决于 Node 堆配置和实际最大导出体积，未实测。
- `status='open'` + `archived_at` 是否会被所有线程查询路径正确当成“已归档”，我只核对了 `sqlite-thread-operations.ts:1533` 一带的主列表查询（使用 `status='open' AND archived_at IS NULL`），没有逐个核对所有线程读取路径。
- `safeJson` 未遮对象键是否真的会造成泄密，取决于 `ProactiveCheckInputs` 里 `memoryByMail`/`relatedByMail` 的键是否可能带机密；我看到的键是邮件编号类，判断概率低但未穷举所有生产者。

## 侧重检查

- **错误路径 / 不可信输入**：导入先 `parsePortable` 校验，再开事务写入，失败整体回滚（`import.ts:81,266-531`），这点是好的；`readPortableDirectory` 拒绝符号链接/非法路径、限制单文件和总字节（`directory.ts:31-47`）。但 Schema 与数据库约束不一致（问题 2）、遮盖后字段能通过 Schema 却撞数据库（问题 1），会让“整份拒绝”退化成裸 SQLite 错误。
- **安全 / 隐私**：内容正文遮盖仍会把原文放进封存文件，这部分正确；新增的自由文字遮盖没有进 `originals`（问题 3），且 `safeJson` 不遮键、`counts` 不过滤（低风险）。封存文件条数校验（`import.ts:89-96`）存在；提供了口令但目录里没有封存文件时，报告仍按清单写 `sealedOriginals`，而扣留记忆会被跳过，这一点我只读了代码，未核实是否有测试覆盖。
- **资源耗尽**：新增 2GB/文件 512MB/4096 文件/单行 64MB 上限是改进，但整目录读入内存的模型没变（问题 6）。
- **不可撤销操作**：导入只允许空库、单事务回滚；导出目录要求为空；但 `chmod` 已存在目录、以及遮盖原文不可恢复，都是不可撤销副作用（问题 3、5）。
- **规则/文档与代码一致性**：本改动不涉及提示组装，`prompt-prefix` 规则本身不受影响；ADR 与代码的冲突集中在问题 3、4、7。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这次改动全部在 `data-export` 的导出/导入与 CLI 路径，没有改系统提示、工具定义、历史序列化或请求组装代码；导入只写数据库并留下索引任务，且只允许空库，不会改写任何已有对话历史。导出清单里的 `exportedAt` 只是导出文件字段，不进模型请求。结论：仍满足“只追加；每轮变化的值不在头部”。（导入后检索块具体插在哪一条消息，本改动没有涉及，未核实。）
2. **同一段文字会不会在不同请求里变成不同字节？** 对模型请求没有影响，因为遮盖不在请求路径。就导出文本本身而言，标量遮盖是确定的、幂等的（占位符不会被再次识别；`external.unit.test.ts:60` 有“已遮过的不再变”的用例），但有两个反向问题：不同秘密会被压成**同一个**占位符（问题 1），以及导入后集合按遮盖后的值重新 `ORDER BY` 可能导致实体/别名/来源数组顺序变化，因此“导出→导入→再导出”不保证逐字节一致。导出清单还带 `exportedAt`，两次导出本来就不会逐字节相同。
3. **有没有对应的自动检查，反向用例会真的失败吗？** 有 `scripts/check-data-export.mjs`，要求 40 条通过，和当前 40 条断言结果一致。新增的“实体/别名/来源/决定输入遮盖”“历史下标”“归档占位线程”“muse 残余”以及 CLI 的“dry-run + 短口令”用例，在把对应实现改回去时会失败。但**新引入的失败模式没有覆盖**：遮盖导致主键冲突、遮盖后超长、Schema 512 通过而数据库 128 拒绝、2GB/64MB/chmod 行为，都没有测试；现有“遮盖测试”只验证文件中不出现秘密，没有做导入/再导出。
4. **每个改动值的使用端都能接受吗？** 不能全部接受：
   - `decision_ledger`/`decision_signals`/`source_insights`/`muse_reference_entries` 的 id Schema 放宽到 512，但数据库仍是 128（问题 2）。
   - 遮盖后的实体名/别名/来源编号/信号来源既可能撞数据库主键/唯一键，也可能超过 Schema 长度（问题 1）。
   - `beforeSupersededBy` 导出端过滤、导入端不过滤，留下悬空引用（问题 4）。
   - 其余值核对通过：`archived_at` 列存在且线程列表查询用它排除归档线程；`EMPTY_TARGET_TABLES` 新增的三张表都有 `owner_id`/`agent_id`；`SEALED_FILE` 常量已从 `data-export/index.ts` 导出且值不变；`REQUIRED=40` 与实际用例数一致。
