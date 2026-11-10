## 侧重检查

- **错误路径**：读了 `apps/admin-cli/src/data-command.ts`、`directory.ts`、`import.ts`、`verify.ts`。口令错误、清单/哈希/行数/路径被篡改、目标非空、`../` 逃逸都有反向用例；但新改的 `0o177` 口令权限只测了 `0644`，`0700` 没测；输出目录“不是普通目录”没测；`beforeSupersededBy` 过滤没有用例。
- **不合规范/不可信输入**：`parsePortable` 会做 Schema、哈希、行数、清单条数、引用校验；`readPortableDirectory` 用 `lstat` 拒绝符号链接和非普通文件；`assertSafePath` 拒绝 `..`/绝对路径。未发现明显绕过。`SEALED_SCHEMA.originals` 只校验为 object，不校验值必须是字符串（低风险，未验证实际影响）。
- **安全**：发现明文占位符是未加盐的 `sha256(原文)[:12]`，这是可离线枚举的指纹；`safeJson` 不遮盖对象键；`counts` 完全没过遮盖。
- **资源耗尽**：单文件/总量 512MB、4096 文件；但 `readdir` 会先完整列出目录，且所有文件会整体读入内存，最坏接近 512MB+，没有对应测试。
- **不可撤销操作**：短文字（实体名、别名、来源编号、决定主题/输入/信号细节）的原文既不入封存文件，也不进入导入报告的跳过计数；导出后不可恢复。
- **规则/文档与代码**：ADR 0200 第 53 行明确“原文不进封存文件”，但 PRD 第 272 行和 egress 门禁第 140 行写“原文只放进加密封存文件”；`prompt-prefix` 规则文件在稀疏检出中未找到，未核实原文。

## 结论

### 1. 高（读代码证实，安全）
- **文件:行**：`packages/persistence-sqlite/src/data-export/export.ts:117-120`，`export.ts:406-408`，`docs/adr/0200-portable-export-of-memories-and-decisions.md:53`
- **问题**：短文字占位符是 `[已扣留:<sha256 原文前 12 位十六进制>]`，即 **48 bit 的未加盐哈希**。对低熵机密（银行卡号、身份证号、弱口令等），拿到明文导出文件的人可以枚举候选值并比对哈希；例如卡号经 Luhn/BIN 约束后数量级约 `10^13`，小于 `2^48 ≈ 2.8×10^14`，可离线恢复。同一原文在不同导出中哈希恒定，还会形成可关联指纹。清单里“不可还原的占位”和 ADR“不同原文占位不同，不会撞主键”都过于绝对。
- **证据**：
  ```ts
  const safeString = (value: string): string => {
    if (!options.policy.hasSecret(value)) return value;
    replacedShortTexts += 1;
    return `[已扣留:${sha256Hex(encoder.encode(value)).slice(0, 12)}]`;
  };
  ```
  ```ts
  reason: "已换成不可还原的占位（带原文哈希前 12 位，不同原文得到不同占位）..."
  ```
- **建议**：改用带密钥的 HMAC（例如沿用 ADR 0148 的 `HMAC-SHA256`、密钥由 `payload-encryption` 派生，并输出不含数字的短编号），或写入目标库后原样保留的随机 opaque token。这样同一库重复导出稳定、导入后再导出也稳定，但导出文件本身不能当离线字典校验器。若短期保留裸哈希，至少删除“不可还原”的措辞并在文档中承认低熵值可被枚举。

### 2. 中（读代码证实，测试缺口）
- **文件:行**：`test/integration/data-export.test.ts:610-638`
- **问题**：测试标题是“two different secrets”，但两条实体和两条来源用的都是**同一个** `SECRET_API_KEY`，只是前后缀不同。旧的“只遮盖机密子串”实现也会得到 `密钥甲 [密钥]` 和 `密钥乙 [密钥]Zz`，仍然不同、仍然能过这个测试。因此它没有验证“不同机密值在相同上下文里必须得到不同占位”，也没有覆盖别名、`decision_signals.source_ref`、`inputs` 的同一上下文场景。真正会撞主键的情形（同一前缀 + 两个不同 API key）没有被测到。
- **证据**：
  ```ts
  insertEntity.run(`密钥甲 ${SECRET_API_KEY}`);
  insertEntity.run(`密钥乙 ${SECRET_API_KEY}Zz`);
  ...
  insertSource.run(`id-${SECRET_API_KEY}`);
  insertSource.run(`id-${SECRET_API_KEY}Yy`);
  ```
- **建议**：改成相同前缀 + **两个不同机密**（例如两个不同的 `sk-` key），断言两个占位符不相等；再补别名和 `decision_signals.source_ref`。若只想防“常量占位”，也应有反例：把 `safeString` 临时改成常量时，导入应因唯一键冲突失败。

### 3. 中（读代码证实，行为/文档不一致）
- **文件:行**：`packages/persistence-sqlite/src/data-export/import.ts:100-103,244-253`，`packages/persistence-sqlite/src/data-export/export.ts:116-120`，`apps/admin-cli/src/data-command.ts:98-100,174-179`
- **问题**：短文字占位符不是 `withheld` 文本，`original()` 只对 `withheld === true` 查封存原文，所以导入时这些占位符被当成普通文字直接写入，既不跳过也不进入 `skipped` 报告。ADR 第 59 行说“没有口令或扣留项的原文缺失时，那几条跳过并在报告里写条数”，但短文字既没跳过也没报告。CLI 的 `totalWithheld()` 只统计 `withheld.texts/memories/decisions`，因此**只有短文字机密时，导出不设口令也不会被 `UNSEALED_WITHHELD` 拦住**，不会要求 `--allow-unsealed`。
- **证据**：
  ```ts
  const original = (key: string, text: ParsedText): string | null => {
    if (text.withheld !== true) return text.text;
    return sealed?.originals[key] ?? null;
  };
  ```
  ```ts
  function totalWithheld(withheld: { texts: number; memories: number; decisions: number }) {
    return withheld.texts + withheld.memories + withheld.decisions;
  }
  ```
- **建议**：在 `ImportReport.skipped` 增加短文字占位数量（或把导出清单里的 `omitted` 计数带入导入报告）；CLI 的“有扣留项必须设口令/显式允许未封存”应覆盖短文字替换，或在输出中明确提示“这些字段不可恢复”。

### 4. 中（读代码证实，安全缺口）
- **文件:行**：`packages/persistence-sqlite/src/data-export/export.ts:124-133,326`
- **问题**：`safeJson` 只处理对象的值，**对象键原样复制**；若机密集出现在 `inputs` 或 `signals.detail` 的 JSON 键中，会明文导出。`counts` 直接 `JSON.parse(...)` 后输出，完全没过 `safeJson`/`safeString`。作者说“决定记录的主题/输入/信号细节”都过机密检查，但这两种路径不在其中。
- **证据**：
  ```ts
  for (const [key, item] of Object.entries(value)) result[key] = safeJson(item as JsonValue);
  ```
  ```ts
  counts: JSON.parse(str(row["counts"])) as JsonValue,
  ```
- **建议**：`safeJson` 对键也跑 `safeString`（或明确拒绝含机密的键）；`counts` 也走 `safeJson`。若认为 `counts` 只含数字、无需处理，至少在代码/文档中写明并在 Schema 上限制其值类型。

### 5. 低（读代码证实，文档/门禁文案）
- **文件:行**：`docs/prd-v0.2.md:272`，`scripts/check-egress-redaction.mjs:140`，`export.ts:406-408`，`ADR:53`
- **问题**：PRD 和门禁理由写“原文只放进用口令加密的封存文件 / 原文只放进加密封存文件”，但短文字的原文被直接丢弃（`safeString` 不写 `originals`），ADR 第 53 行也确实说“原文不进封存文件”。同时 `omitted.reason` 的“不可还原”与裸哈希指紋矛盾。三处口径不一致。
- **证据**：
  ```md
  原文只放进用口令加密的封存文件，没有口令就拿不到。
  ```
  ```ts
  reason: "已换成不可还原的占位（带原文哈希前 12 位...）"
  ```
- **建议**：把 PRD/门禁理由改成“短文字原文不保留；记忆/决定正文的原文才进封存文件”，并删除“不可还原”或改为“不可直接读出，低熵原值可能被枚举”。

### 6. 低（读代码证实，缺反向测试）
- **文件:行**：`apps/admin-cli/src/data-command.ts:83`，`test/integration/data-cli.test.ts:232`，`packages/persistence-sqlite/src/data-export/directory.ts:16-21`，`import.ts:472-474`
- **问题**：本轮新增/修改的几条错误路径没有针对性测试：
  - `0o177` 现在会拒绝 **owner execute bit**（如 `0700`），但测试只把口令文件改成 `0644`，没有 `0700`/`0400` 边界用例。
  - 输出目录 `lstat` 后 `isDirectory()` 的新检查没有“普通文件/符号链接”反例。
  - `beforeSupersededBy` 按已导入记忆过滤是新增逻辑，但 fixture 的整理改动该列都是 `null`（`data-export-fixture.ts:266-271`），现有测试不会走到过滤分支。
  - `MAXIMUM_TOTAL_BYTES = 512MB` 没有读目录超限测试。
- **建议**：补 `0700` 口令文件拒绝、`0400` 接受；补输出路径为普通文件/符号链接时拒绝；补“跳过一条记忆后其 `beforeSupersededBy` 变为 null”的用例；补 512MB 总量边界。

### 7. 低（读代码证实 + 推测，检索口径）
- **文件:行**：`packages/memory-engine/src/hybrid-memory-provider.ts:85-86`，`test/integration/data-export-retrieval.test.ts:192-213`，`docs/prd-v0.2.md:274,402`
- **问题**：索引词由 `[content, ...entities]` 组成。若某条记忆的实体名命中机密，导出后实体名变成 `[已扣留:<hash>]`，导入后索引词也随之变化，和 PRD“检索结果不变 / 检索评测分数不变”的绝对表述不完全一致。现有检索评测的数据集实体来自 `dataset.json`，我没有逐条核实其中是否含机密实体；从代码看它没有专门造“机密实体名”场景，因此大概率测不到。
- **建议**：要么把验收口径限定为“不含被扣留短文字的记忆”，要么在文档中承认这些记忆的检索词会改变，并补一个含机密实体名的检索对比用例。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
不会。`git diff --stat 28845722..8c4bf452` 只涉及 admin CLI、data-export、测试和文档；`grep buildPortableExport/importPortableExport` 只出现在 `apps/admin-cli/src/data-command.ts` 和 `test/integration/*`，没有进入 prompt 组装、工具定义或历史消息构造链。该功能只写/读导出目录，不向模型请求追加任何内容。`prompt-prefix` 规则文件在稀疏检出中未找到，规则原文未核实；但按代码路径判断，请求前缀、工具定义、历史消息和遮盖结果都不受影响。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
数据行不会：`safeString` 是纯 `sha256(value)`，同一值每次都一样；实体/别名/来源按遮盖后的字符串用 `compareText` 排序，顺序确定；数据行里没有时间字段，`canonicalJson` 又对对象键排序。
但整包不是完全确定：`manifest.exportedAt` 来自 `now()`（`export.ts:441`），`sealed/sealed.enc` 每次使用随机 salt/nonce（`seal.ts:43-44`），所以整包字节会变；测试比较的是解密后的 canonical JSON，不是密封文件原始字节。另一个方向的问题是：**同一机密值会得到同一个哈希占位**，即同一段文字在不同请求里反而完全一致，便于跨导出关联（见问题 1）。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有门禁：`package.json` 的 `check:data-export` 跑三个 `[P1-6]` 测试文件并要求至少 40 条通过；按代码数，`data-export.test.ts` 的 24 个 `it` 中含一个 12 案例循环，展开为 35 条，加上 `data-cli` 4 条、`data-export-retrieval` 2 条，共 41 条，新测试会被选中。未运行测试（工具限制）。
反向覆盖不足：新增的 `[P1-6]` 测试不是反向用例，而且用的还是同一个机密值，旧实现也能过（见结论 2）；新口令权限 `0700`、输出目录类型、`beforeSupersededBy` 过滤、512MB 总量都没有反向用例（见结论 6）。所以“有自动检查”成立，“反向用例真的会失败”只对旧的固定占位/关闭遮盖场景成立，对本次新增的“不同机密必须不同占位”并不成立。

**4. 改动产生/修改的每个值，每个使用它的地方都能接受吗？**
- **占位符 `[已扣留:<12 hex>]`**：长度 18 个码点。逐个核对：
  - `memory_entities.name`：Schema `text(1,64)`、数据库 `length(name) BETWEEN 1 AND 64`，18 通过。
  - `memory_people.name`：Schema 64、数据库 64，通过；`relation/reverse_relation`：Schema 32、数据库 32，通过。
  - `memory_person_aliases.alias`：Schema 64、数据库 64，通过。
  - `memory_provenance.source_id`：Schema 512，数据库无长度 CHECK，通过。
  - `decision_ledger.subject_ref/push_source_key`：Schema 256、数据库 256，通过。
  - `decision_signals.source_ref`：Schema 256、数据库 256，通过。
  - `decision.inputs` / `signals.detail`：Schema object、数据库 `json_valid/json_type='object'`，通过。
  没发现占位符超长。
- **唯一键**：
  - `memory_entities(memory_id,name)`、`memory_person_aliases(person_id,alias)`、`memory_provenance(memory_id,source_type,source_id)`、`decision_signals(decision_id,signal,source_ref)`。
  - 同一原文重复出现在同一唯一键命名空间，源库本身就不允许；不同原文靠 48 bit 哈希区分，理论上存在碰撞（每对约 `2^-48`），并且同命名空间内条目足够多时不再可忽略。作者“不同原文占位不同，不会撞主键”是概率上的近似，不是严格保证。
- **排序顺序**：实体、别名、来源三项在遮盖后重新排序，不再依赖快照的原始 SQL 顺序；导入后目标库再导出仍用同一比较函数，三项顺序稳定。其它数组（history、personIds、basis、signals 等）继续依赖 `snapshot.ts` 的 `ORDER BY`，导入按导出顺序插入、再导出顺序一致，没有发现排序依赖被破坏。
- **Schema 128/512 与数据库**：`decision_ledger.id`、`decision_signals.id`、`source_insights.id`、`muse_reference_entries.id` 及各自的 `decision_id` 外键都是数据库 128，当前 Schema 也改成 128，一致。记忆一侧的 `id`/`supersededBy`/`importBatchId`/整理记录 id 等仍是 512，但 `memory_records`、`memory_people`、`memory_import_batches`、`memory_consolidation_*` 这些表没有对应的 `length()` CHECK；这不是新引入的矛盾，但“512”只是导出格式限制，不是数据库限制。若存在超过 512 字符的旧 id，导出文件会被自己的 `parsePortable` 拒绝——未发现这种 id，标记为推测/未核实。
- **`beforeSupersededBy`**：产生端 `export.ts:279` 已用 `keepMemoryRef` 限制为导出记忆；导入端 `import.ts:472-474` 再按 `importedMemoryIds` 过滤，数据库该列无 CHECK/外键，接受 null 或已导入 id，两端一致。缺测试。
- **清单 `omitted` 新项**：`what`/`reason` 都是短字符串，`count` 是整数，符合 `MANIFEST_SCHEMA` 的 512/`nullable(integer(0))`；`replacedShortTexts` 按出现次数计数而非去重后的值数，和“条数”语义大体一致。
- **口令权限**：`0o177` 会拒绝 group/other 权限和 owner execute bit，`0600`、`0400` 通过，`0700` 拒绝，符合“0600 或更严”；但没有对应测试。
- **输出目录**：先 `mkdir`、再 `lstat` 确认目录、检查非空、再 `chmod 0700`；读目录有 512MB 总量和 4096 文件上限。逻辑与作者说法一致，但目录类型和总量上限没有测试。
