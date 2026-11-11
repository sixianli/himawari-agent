## 结论摘要

作者关于“参数原样字符串、历史最后一版=当前行、内置规则不进 rules.jsonl、v1 拒绝、响应头取 enforcedRules、不加迁移、不改模型请求”的主要说法，代码基本对得上。但“逐字节往返”有一个会实际失败的口子：`parameters` 的 schema 上限 16,384，而合法的“重要发件人”设置可以达到约 50KB。另有 RULES.md 校验只认编号，改正文仍能通过。以下按严重度列出。

## 读代码证实的问题

### 1. 高：大一点的重要发件人设置能导出，却导入不了，违反“逐字节往返”

文件：`packages/persistence-sqlite/src/data-export/schemas.ts:243`

问题：导出 schema 把规则参数限制为 `text(2, 16_384)`，但数据库允许的合法设置远大于它。

证据：

- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:287-298` 只拒绝 `input.importantSenders.length > 200` 或单个 sender 长度 `> 254`：
  ```ts
  input.importantSenders.length > 200 ||
  input.importantSenders.some(
    (sender) => typeof sender !== "string" || sender.length < 1 || sender.length > 254 || ...)
  ```
- 同文件 `325-329` 把它整体 `JSON.stringify({ senders: input.importantSenders })` 写入规则参数。
- `packages/gateway-contracts/src/contracts-v2.ts:356-369` 同样允许最多 200 个、每个最多 254 字符的地址/域名。
- 导出时 `packages/persistence-sqlite/src/data-export/export.ts:405-417` 对无机密参数直接返回原字符串，不检查长度。
- 导入时 `verify.ts:314` 用 `RULE_SCHEMA` 解析，`verify.ts:275-276` 一旦 `validateAgainst` 失败就抛 `LINE_INVALID`。

200 × 254 字符已经是约 50,800 字符，再加 JSON 结构，远超 16,384。也就是说：一个合法的设置能成功导出，生成的 `data/rules.jsonl` 甚至违反同包里导出的 `schema/rules.schema.json`，但导入时会被自己的 schema 拒绝。测试夹具只用了很小的 sender 列表，所以没覆盖到。

建议：把 `parameters` 的上限对齐数据库实际能力，或干脆取消长度上限；同时在导出侧用 `RULE_SCHEMA`/`storedRuleProblem` 自检，宁可导出时明确失败，也不要生成一个自己导不回去的包；补一条 200 个长地址的往返测试和一条“超限参数导入失败/导出自检失败”的反向测试。

### 2. 中：RULES.md 只校验编号，改正文、状态、出处、内置规则段都不会被发现

文件：`packages/persistence-sqlite/src/data-export/rules.ts:235-254`

问题：`checkRulesMarkdown` 只统计 `〔r:编号〕` 出现次数，不核对行内文字是否与 `rules.jsonl` 一致。

证据：

```ts
const listed = new Map<string, number>();
for (const line of markdown.split("\n")) {
  const match = RULE_LINE.exec(line);
  if (match === null) continue;
  const id = match[1] ?? "";
  listed.set(id, (listed.get(id) ?? 0) + 1);
}
for (const rule of rules)
  if (listed.get(rule.ruleId) !== 1) return ...;
for (const id of listed.keys())
  if (!rules.some(({ ruleId }) => ruleId === id)) return ...;
```

`verify.ts:380-387` 只调用这个函数。于是把某条规则的“退款”改成“发票”、把“已撤销”改成“在用”、把“出处”改掉、把“产品自带”两行删掉、或把“共 N 条”改错，只要每条规则编号仍恰好出现一次，校验都会通过。记忆的 Markdown 是逐条核对文字的（`verify.ts:434-466`），规则这里没有做到同等强度。现有反向用例只覆盖了“缺一条规则”（`test/integration/data-export-rules.test.ts:346-358`）。

建议：用 `rules` 重新生成 `renderRulesMarkdown(rules, WITHHELD_PLACEHOLDER)`，与文件内容逐字节比较；或至少逐行核对类型、版本、状态、出处和来源记忆编号。补“只改正文/改状态/删内置段”的反向用例。

### 3. 中低：扣留版本在“有口令但缺原文”时被静默跳过，且恢复后不再检查历史不变量

文件：`packages/persistence-sqlite/src/data-export/import.ts:231-262`

问题：`restoreVersion` 在 `withheld: true` 但封存文件里没有对应 key 时返回 `null`，整条规则被跳过并只计入 `rulesWithoutOriginal`。有口令时也没有区分“口令不对/封存文件被裁剪”和“本来就没导出原文”。恢复出的原始参数也未再执行一次 `assertRuleHistory`。

证据：

```ts
const parameters = sealed?.originals[key];
if (parameters === undefined) return null;
const restored = { ...version, parameters } as T;
const problem = storedRuleProblem(ruleId, restored);
if (problem !== null) throw ...;
...
if (current === null || history.some((version) => version === null)) {
  rulesWithout += 1;
  continue;
}
```

`verify.ts:369-378` 对 `withheld` 版本直接 `continue`，不校验明文参数。导入后只做了来源记忆置空（`import.ts:255-261`），没有再次 `assertRuleHistory`。如果封存原文件里当前版和最后一版历史被构造成不同但各自合法的参数，导入可以写出“当前行 ≠ 历史最后一版”的行，而下次导出会在 `export.ts:450` 的 `assertRuleHistory` 处失败，导致数据再也导不出去。

建议：有口令时，`withheld` 缺少封存原文应视为 `SEAL_MISMATCH` 并整份拒绝，而不是静默跳过；恢复完成后对每个 `rulePlans` 条目重新执行 `assertRuleHistory`。补“有口令但封存缺 rule key”和“恢复后历史不一致”的反向测试。

## 推测 / 未核实

### 4. 低：`changeReason` 未走短文字遮盖，当前写入路径是常量，暂不可达

文件：`packages/persistence-sqlite/src/data-export/export.ts:430-432`

证据：

```ts
source: safeString(str(version["source"])),
sourceMemoryId: ruleMemoryLink(version["source_memory_id"]),
changeReason: optionalString(version["change_reason"]),
```

`source` 走了 `safeString`，`changeReason` 却原样导出。当前所有写入点（`sqlite-owner-rule-operations.ts:162/193`、`0087_rule_book_memory_link.sql:322-330`）都只写 `owner_sentence`、`owner_undo`、`owner_confirmed`、`memory_removed` 等常量，所以现在没有用户文字进入这里，不能算已可利用的泄漏。但如果以后有写入点把自由文字放进 `change_reason`，它会直接出现在明文 `rules.jsonl` 里。

建议：和 `source` 一样统一走 `safeString`，或至少在 schema 中限制为已知枚举。

### 5. 低：机密检测基于解析后的 JSON，而导出的是原始字符串

文件：`packages/persistence-sqlite/src/data-export/export.ts:405-417`

`ruleParameters` 检测的是 `JSON.parse(parameters)` 后的值，但导出的是原始 `parameters` 字符串。正常应用写入都用 `JSON.stringify`，键不会重复；如果数据库里存在带重复键的合法 JSON（SQLite 只校验 `json_valid` 和 `json_type='object'`），被 JSON.parse 丢弃的早期重复键/值不会参与 `hasSecretLeaf`，却会随原字符串进入明文层。这是理论性绕过，当前正常写入路径不可达，标为推测。

### 6. 低：目标空库检查不含 `rule_book_history`

文件：`packages/persistence-sqlite/src/data-export/import.ts:64-74`

`EMPTY_TARGET_TABLES` 含 `rule_book_rules`，但不含 `rule_book_history`。正常应用不可能留下“有历史没有当前行”的状态，所以不是现实问题；但如果目标库存在这种孤儿历史，导入会在事务内撞主键，抛出原生 SQLite 错误而不是 `TARGET_NOT_EMPTY`，虽然事务会回滚，但错误路径不干净。

## 侧重检查

- **错误路径 / 不可信输入**：v1 被 `readManifest` 的格式检查拒绝；规则 schema、重复编号、历史递增、来源记忆、未扣留规则可执行性、RULES.md 编号都有校验。发现 RULES.md 正文可被改而不被发现；扣留规则缺原文时静默跳过。
- **安全 / 遮盖**：规则参数按叶子检测并遮盖，当前规则和每个历史版本分别进封存文件；`source` 有短文字遮盖；`changeReason` 未遮盖但有常量写入约束。未发现已可利用的机密进入明文层；重复键/拆分叶子是理论性缺口。
- **资源耗尽**：历史数组没有条目上限，但单行仍受 64MB 上限约束；RULES.md 没有单独大小上限，沿用了记忆 Markdown 的既有模式。没有发现本次改动独有、明显的资源耗尽路径。
- **不可撤销操作**：导入要求目标主要表为空，写操作在 `IMMEDIATE` 事务里完成，不会覆盖已有规则；但 `rule_book_history` 未纳入空库检查。
- **规则、说明文档和代码一致性**：ADR 0233 对参数原样、历史复制、内置规则、v1 拒绝、响应头、无迁移的叙述与代码基本一致；“逐字节往返”在超大重要发件人设置上不成立。另需注意：本次 `3ede75ba..6856c8c0` 范围还夹带了 PR391 删除记忆体检等无关改动，以上结论针对 `230459ed` 的规则导出提交，未把无关改动一并计入。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。规则导出/导入只读写数据库和文件；本次功能提交没有改系统提示、工具定义、历史消息或请求构造代码。发给模型的内容仍然只在末尾追加这一机制没有被触碰；新增的 `exportedAt`、清单计数等可变值只出现在导出文件里，不在模型请求里。需要保留一点：未逐文件审计 base..head 中夹带的无关改动，但已查的 `daily-review.ts`、`service-main.ts` 等处不是模型提示词构造。

2. **同一段文字会不会在不同请求里变成不同字节？** 对模型请求不会。导出侧对同一数据库是确定性的：规则按 `rule_id`、历史按 `revision` 排序；遮盖按单个叶子做，不依赖请求顺序；规则参数本身除机密替换外保持原字符串。唯一随每次导出变化的是 `manifest.exportedAt`（以及封存随机数等既有字段），它们不在模型请求里。若问导出文件字节，同一 `now()` 下重复导出应稳定；不同 `now()` 下 manifest 会变是设计使然。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：`scripts/check-data-export.mjs:9-16` 加入了 `data-export-rules.test.ts`，下限从 53 提到 68；规则测试包含 13 条，加上 HTTP 和 data-export 的新增反向用例共 15 条。现有反向用例（非法参数、历史缺当前版、来源记忆缺失、内置规则混入、RULES.md 缺规则、目标库非空、v1 拒绝）按代码路径都会失败并回滚。但覆盖有缺口：没有“只改 RULES.md 正文”、没有“参数超过 16384”、没有“有口令但封存缺原文”、没有“恢复后当前行≠历史最后一版”的用例。测试未实际运行，以上按代码路径判断。

4. **新增或修改的每个值，使用它的地方都能接受吗？**
   - `ruleId`：产生于 `rules.jsonl`/RULES.md；使用于 schema 64 字符上限、数据库 `length(rule_id) BETWEEN 1 AND 64`、`storedRuleProblem` 的 owner 正则、RULES.md 编号匹配。正常编号两端一致；扣留规则在无原文时会被跳过而不是写入。
   - `parameters`：这是唯一明确对不上的值。数据库允许的大设置可以超过 schema 的 16,384，导入会拒绝（见问题 1）。
   - `source`、`sourceMemoryId`、`revision`、`status`、`changedAt/updatedAt`、`changeReason`：schema 上限与数据库 CHECK 基本一致（`source` 1-256、`sourceMemoryId` 1-128、`revision ≥1`、状态枚举、`changeReason` ≤64）；时间字段只校验长度，和既有导出格式一致。
   - 封存 key `rule/<id>[/history/<rev>]/parameters`：生产端和导入端使用同一函数，正常编号不会冲突；只有带 `/history/` 的非法 `ruleId` 才可能制造 key 碰撞，而这种编号在恢复时会被 `storedRuleProblem` 拒绝，当前不可达。
   - `x-himawari-export-rules`：服务端写 `manifest.counts.enforcedRules`（`production-data-export.ts:139`），前端用安全整数兜底读取（`apps/control-center/src/data-export.ts:16-28`），测试也覆盖了有规则和无规则两种值，接受方一致。注意它只统计“存下来的非 retired 规则”，不含两条产品内置规则，这与 ADR 的定义一致。
   - 清单新增的 `rules`、`enforcedRules`、`ruleHistoryVersions`、`withheld.rules`：前三个在 `verify.ts:398-400` 重新计算并核对，能互相约束；`withheld.rules` 只是信息字段，导入时没有与实际扣留数交叉核对，这是既有清单字段的同类弱点，不影响导入数据本身。
