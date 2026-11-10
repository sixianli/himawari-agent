## 侧重检查

- **错误路径**：读了 `data-command.ts:80-88`（口令文件权限）、`directory.ts:10-28`（输出目录）、`verify.ts:162-274`（路径/清单/行校验）、`data-cli.test.ts:315-351`。口令 0700 确实会被 `(mode & 0o177) !== 0` 拒绝；符号链接输出目录会被 `lstat` 拒绝。但“输出路径是普通文件”那一分支实际到不了，见下面第 5 条。
- **不合规范/不可信输入**：读了 `export.ts:130-140`、`schemas.ts:187-233`、`import.ts:483-530`。`counts`/`inputs`/`detail` 的 JSON 键和值会进入 `safeString`；导入端只做 `JSON.stringify`，没有任何键冲突校验。
- **安全/机密**：读了 `export-text-policy.ts:14-20`、`identifiers.ts:3-8`。普通 `[已扣留:1]` 不会再被 `findSensitiveValues`/`containsRestrictedIdentifier` 命中，所以“导入后原样再导出”这一段是稳定的；但编号不跨导出稳定，见第 1 条。短文字原文不进封存文件、导入不恢复，和 PRD/ADR 的写法一致。
- **资源耗尽**：`verify.ts:24` 每行 64 MiB、`directory.ts:6-8` 4096 文件/512 MiB 总量仍在；`safeJson` 递归没有深度上限，但这是既有行为，本次没有加重（未实测）。
- **不可撤销操作**：导入仍在单个 `immediate()` 事务里，失败整体回滚（`import.ts:265-533`）；输出文件用 `flag: "wx"`（`directory.ts:26`），不会覆盖已有文件。
- **规则/文档一致性**：ADR 0200:53 写“不会撞主键”，与本轮编号实现不符，见第 1 条；覆盖清单里还留有 256 条的旧描述，见第 6 条。

## 发现的问题

### 1. 高：编号占位不跨导出稳定，导入后再加新机密会复用旧编号，可能撞主键或把不同原文并成同一占位

- 文件:行：`packages/persistence-sqlite/src/data-export/export.ts:117-126`，`docs/adr/0200-portable-export-of-memories-and-decisions.md:53`，`packages/persistence-sqlite/src/migrations/0052_memory_engine.sql:10-14`
- 问题：`shortTextNumbers` 每次导出都从空 `Map` 开始，只记录“本次导出里遇到的机密短文字”，不会识别或保留目标库里已经存在的 `[已扣留:N]`。导出→导入后，实体名/别名/来源编号在目标库里就是普通字符串 `[已扣留:1]` 等；之后若新增一条含机密的不同短文字，它在本轮仍会拿到 `N=1`，于是：
  - 若新旧两条落在同一条记忆/同一个人上，`memory_entities` 的 `PRIMARY KEY (memory_id, name)`（或 `memory_person_aliases(person_id, alias)`、`memory_provenance(memory_id, source_type, source_id)`）会冲突，下一次导入整份失败；
  - 若落在不同记忆上，两个不同原文会共用同一个 `[已扣留:1]`，直接违反 ADR 的“不同原文不同编号”。
- 证据：
  - `export.ts:121-126`：`let number = shortTextNumbers.get(value); if (number === undefined) { number = shortTextNumbers.size + 1; ... } return \`[已扣留:${number}]\`;`——编号只由**本次**遇到的顺序决定，没有来自数据库/清单的已用编号。
  - `import.ts:334` 直接把 `item.name` 写进 `memory_entities`，不会重编号或保留占位映射。
  - `0052_memory_engine.sql:13`：`PRIMARY KEY (memory_id, name)`；`0057_memory_page.sql:42`：`PRIMARY KEY (person_id, alias)`；`0001_initial_product_schema.sql:415`：`PRIMARY KEY (memory_id, source_type, source_id)`。
  - ADR 0200:53 明确写“同一原文同一编号、不同原文不同编号，不会撞主键”，与上述路径冲突。
  - 现有测试 `data-export.test.ts:638-641` 只覆盖“导入后没有新增机密”的再导出，因此看不到这个问题。
- 建议：不要用“本次首次出现顺序”做跨导出可复现的标识。可选：
  1. 用固定密钥的 HMAC（类似 ADR 0148 的 `[验证码#kqzmdwrp]`）生成稳定占位；
  2. 或在导出前扫描已有 `[已扣留:N]` 并保留/跳过这些编号，同时把“已用编号”写进清单或封存文件；
  3. 至少要在生成占位时检测与已有 `[已扣留:N]` 或同批其他占位的冲突，冲突就明确失败，不能静默合并或让导入端报 SQLite 主键错误。

### 2. 中：`safeString` 处理 JSON 键会静默覆盖同名键，可能丢数据

- 文件:行：`packages/persistence-sqlite/src/data-export/export.ts:133-137`
- 问题：`safeJson` 对对象键也调用 `safeString`，随后直接 `result[safeString(key)] = ...`，没有检查转换后是否与已有键相同。若一个键本身含机密被改成 `[已扣留:1]`，而同对象恰好有一个普通键就叫 `[已扣留:1]`（最现实的来源是上一次导入留下的占位），后者或前者会被覆盖，导出静默丢字段。两个不同机密键不会分配同一个编号，但“机密键 → 占位”和“原本就是这个占位”会撞。
- 证据：`export.ts:135-136`：
  ```
  for (const [key, item] of Object.entries(value))
    result[safeString(key)] = safeJson(item as JsonValue);
  ```
  没有任何 `Object.hasOwn(result, ...)` 或冲突异常。
- 建议：要么不要改 JSON 键（只遮值），要么在写入前检测 `safeString(key)` 是否已存在，冲突时抛 `DataExportError`；也可以给占位加一个不可能与用户原键相同的保留前缀，并对导入端做同样校验。还要补一条“键本身含机密 + 已有同名占位”的反向测试。

### 3. 中：核心编号改动没有真正会失败的反向测试，`counts`/JSON 键路径完全没测到

- 文件:行：`test/integration/data-export.test.ts:611-642`、`test/integration/data-export.test.ts:540-558`
- 问题：新测试只能证明“两个不同机密不泄漏、且导入后能原样再导出”，不能区分“编号占位”和旧的“哈希占位”。把 `safeString` 改回旧实现（`[已扣留:<sha256 前 12 位>]`），下面这些断言仍然全部成立：
  - `data-export.test.ts:634` 只匹配 `name LIKE '[已扣留:%'`，旧哈希占位也匹配；
  - `data-export.test.ts:638-641` 的再导出相等，旧哈希占位导入后也不会被再次识别为机密，所以仍然相等；
  - `data-export.test.ts:628-629` 只检查不包含 `OTHER_API_KEY`，哈希占位也不包含。
  另外，本轮新增了 `safeJson(JSON.parse(counts))` 和 JSON 键遮盖，但测试里没有任何一条把机密放进 `counts`、`detail` 或 JSON 键；`data-export.test.ts:553` 只把机密放进 `inputs` 的值。
- 证据：`data-export.test.ts:634`、`638-641`；`grep` 结果中 `已扣留` 仅出现在这一处断言和 `export.ts`。
- 建议：直接断言占位形如 `[已扣留:1]`、`[已扣留:2]`（或至少断言不含 12 位十六进制），并补：
  - 导出→导入→新增机密短文字→再导出→再导入，验证不撞主键、不同原文不同号；
  - `counts`/`inputs`/`detail` 的值含机密；
  - JSON 键本身含机密且与已有 `[已扣留:N]` 同名；
  - 旧实现（哈希占位）下这些测试必须失败。

### 4. 中：新增的 0700 口令测试会让后面的“短口令”反向测试失效

- 文件:行：`test/integration/data-cli.test.ts:315-351`，`apps/admin-cli/src/data-command.ts:83`
- 问题：先 `chmod(target.passphraseFile, 0o700)`，随后用 `writeFile(..., { mode: 0o600 })` 写短口令。Node 的 `mode` 只在**创建新文件**时生效，对已存在的文件不会改权限，所以文件仍是 0700。下一段“短口令被拒绝”的断言实际是被 0700 权限检查拒绝的，不是被 `text.length < 12` 拒绝。即使删掉长度校验，这条测试仍会通过。
- 证据：
  - `data-cli.test.ts:315`：`await chmod(target.passphraseFile, 0o700);`
  - `data-cli.test.ts:335`：`await writeFile(target.passphraseFile, "short\n", { mode: 0o600 });`
  - `data-command.ts:83`：`if (!status.isFile() || (status.mode & 0o177) !== 0)`，0700 会命中 `0o100`。
- 建议：在写短口令前显式 `await chmod(target.passphraseFile, 0o600)`，或改用另一个新文件；并断言错误码是 `ADMIN_DATA_ARGUMENT_INVALID`，把“权限拒绝”和“口令太短”分开。

### 5. 低：输出路径是普通文件的测试是空转，且错误码不是 `PATH_UNSAFE`

- 文件:行：`packages/persistence-sqlite/src/data-export/directory.ts:15-18`，`test/integration/data-export.test.ts:646-648`
- 问题：`writePortableDirectory` 先执行 `mkdir(root, { recursive: true })`，普通文件已存在时 `mkdir` 本身就会抛 `EEXIST`，根本到不了 `lstat` 的 `!status.isDirectory()` 检查。测试只写 `rejects.toBeDefined()`，所以即使删掉这个目录类型检查，文件用例仍然通过；同时 CLI 返回的是原始 `EEXIST`，不是 `DATA_EXPORT_PATH_UNSAFE`。
- 证据：
  - `directory.ts:15`：`await mkdir(root, { recursive: true, mode: 0o700 });`
  - `directory.ts:16-18`：`const status = await lstat(root); if (!status.isDirectory()) throw ... PATH_UNSAFE`
  - `data-export.test.ts:648`：`await expect(writePortableDirectory(file, files)).rejects.toBeDefined();`
- 建议：文件用例断言 `code` 为 `PATH_UNSAFE`；如果希望统一错误码，需要在 `mkdir` 失败时把 `EEXIST` 包装成 `DataExportError(PATH_UNSAFE)`。符号链接用例是有效的，不受影响。

### 6. 低：文档里还留有旧条款数，和“覆盖清单摘要同步”不完全一致

- 文件:行：`test/fixtures/v0.2/coverage-manifest.json:7`、`:346`；`docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md:42`、`:280`
- 问题：清单已把 `markdownListClauseCount` 改为 269，但同一清单的 S0-A01 `planEvidence` 仍写“digest、256 条款”；同一份 Spec 第 42 行写 269，第 280 行仍写“256 个列表条款”。这不是本轮引入的（旧值本来就陈旧），但与“PRD、门禁理由、ADR 口径统一，覆盖清单摘要同步”的说法不一致。
- 证据：`coverage-manifest.json:7` 为 269，`:346` 为 `"planEvidence": "digest、256 条款、S0–S9 与 Plan/Task manifest"`；Spec 第 42 行 269，第 280 行 256。
- 建议：把清单和 Spec 中剩余的 256 一并改成 269，或在说明里注明 planEvidence 是历史证据、不随 PRD 条款数更新。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 这次增量只动 `packages/persistence-sqlite/src/data-export/`、`apps/admin-cli/src/data-command.ts`、脚本、测试和文档；`buildPortableExport` 只被 `apps/admin-cli/src/data-command.ts:153` 调用，没有进入系统提示、工具定义、历史或出口遮盖的组装路径。发给模型的内容仍然只由原来的请求组装逻辑决定，本改动没有新增“每轮会变的值”到前缀里。导入后实体名变成占位可能改变检索结果，但检索结果属于运行时数据，本来只能出现在最后一条用户消息里，不改变前缀。
2. **对模型请求：不适用，本改动没有改模型遮盖。对导出文件：同一段短文字可能在不同导出里变成不同字节。** 编号由 `shortTextNumbers.size + 1` 按本次导出遇到顺序分配（`export.ts:121-126`），所以同一机密原文在“多了一个更早出现的机密”或“导出范围不同”时会从 `[已扣留:1]` 变成 `[已扣留:2]`。同一个数据库、同一份数据连续导出是确定的（`snapshot.ts` 各查询都有 `ORDER BY`，`data-export.test.ts:504-510` 也覆盖了），但跨不同导出状态不稳定。另外 `manifest.json` 的 `exportedAt` 是时间字段，本来就会让同一数据的两次导出清单字节不同；现有确定性测试只比较 data 文件，不比较清单。
3. **有自动检查，但反向用例只覆盖了一部分。** `scripts/check-data-export.mjs` 会跑带 `[P1-6]` 的测试并要求至少 40 条通过。输出路径符号链接、0700 口令文件这两类反向用例在去掉保护后确实会失败；但编号格式/跨导出冲突、`counts` 和 JSON 键遮盖都没有会因回退而失败的测试（见第 3 条）；“输出路径是普通文件”的用例也不会因删除文件类型检查而失败（见第 5 条）。
4. **逐个核对两端后：长度/格式校验都能接受，唯一性和 JSON 键没有保证。**
   - 产生处：`export.ts:126` 生成 `[已扣留:N]`，用于实体名、别名、人物名、关系、来源编号、`subjectRef`、`pushSourceKey`、`counts`/`inputs`/`detail` 的键和值、信号 `sourceRef`。
   - 格式/长度：`schemas.ts` 对实体名/人物名/别名限制 1–64，`sourceId` 1–512，`subjectRef`/`sourceRef` 1–256，`counts`/`inputs`/`detail` 是任意对象；占位串在这些上限内，编号也不会长到 64/256 个字符（无现实超长风险）。数据库 `STRICT` 的长度检查同样能接受。
   - 唯一性：`memory_entities`、`memory_person_aliases`、`memory_provenance` 的主键会拒绝重复占位；当前编号实现可能产生重复（第 1 条）。JSON 对象键没有任何唯一性校验，重复键会被静默覆盖（第 2 条）。
   - 封存文件/导入：短文字根本不进 `originals`，导入的 `original()` 只对 `withheld === true` 的长文字查封存（`import.ts:100-103`）；短文字占位按普通文字导入，原文永久丢失，这是 ADR/PRD 写明的设计，不是遗漏。
   - 清单：`omitted.count` 是 `replacedShortTexts`，每次调用都自增（含同一原文重复出现和键），因此是“替换次数”而非“不同原文数”；清单 schema 只要求整数，能接受。再导出时这些占位不再被当成机密，`omitted.count` 会变成 0，清单不再报告这些已丢失的短文字（既有行为，不是本轮新增）。

## 推测/未核实

- 未执行测试命令（受工具限制），以上测试结论来自读代码和断言语义；实际 green/red 未核实。
- `test/fixtures/v0.2/coverage-manifest.json` 中 `prd.sha256` 是否真的等于当前 `docs/prd-v0.2.md`，无法用允许的工具计算 SHA-256，未核实；只核实了 269 这个数字在清单和 Spec 第 42 行一致。
- `safeJson` 的递归深度在恶意构造的超深 JSON 下可能栈溢出，但这是既有实现，且导出源是本地数据库，本次未证实可触发；列为未核实。
- 第 1 条中“导入后服务继续捕获新机密短文字”的具体触发频率取决于真实使用，代码层面的编号复用是确定的；业务上多久会遇到属于推测。
