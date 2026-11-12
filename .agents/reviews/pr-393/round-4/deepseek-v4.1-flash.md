## 已读代码证实的问题（按严重度）

### 1. 高：合法规则文字里出现〔m:…〕会让“自己导出的包”无法导入

**文件:行**：`packages/persistence-sqlite/src/data-export/rules.ts:203`、`rules.ts:246-249`

**问题**：生成 `RULES.md` 时，规则说明和出处文字被原样拼进同一行；导入核对时又扫描整行的所有〔m:…〕，要求数量、顺序与 `sourceMemoryId` 完全一致。只要用户的规则说明、出处或重要发件人里出现一个完整的〔m:…〕，导出能成功，导入却会整份报 `REFERENCE_BROKEN`。

**证据**（我亲自读到的代码）：

```ts
// rules.ts:203
return `- 〔r:${rule.ruleId}〕 ${KIND_LABELS[kind]}。${foldText(text)}（第 ${rule.revision} 版，${STATUS_LABELS[rule.status]}；出处：${foldText(rule.source)}${source}）`;
```

```ts
// rules.ts:246-249
const memories = [...(lines[0] ?? "").matchAll(MEMORY_MARK)].map((match) => match[1]);
const expected = rule.sourceMemoryId === null ? [] : [rule.sourceMemoryId];
if (memories.length !== expected.length || memories.some((id, index) => id !== expected[index]))
  return `${RULES_INDEX_FILE} 里规则 ${rule.ruleId} 的来源记忆和 data/rules.jsonl 对不上`;
```

这些文字确实允许包含该字面量：

```ts
// packages/application/src/rules/rule-types.ts:248-254
export function validRuleSummary(summary: string): boolean {
  const trimmed = summary.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= OWNER_RULE_SUMMARY_LIMIT &&
    !/[\p{Surrogate}\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)
  );
}
```

规则说明会进入生成行（`rules.ts:174`：`return \`${String(parameters["summary"] ?? "")}（...）\`;`），重要发件人也只校验长度和控制字符（`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:287-298`），并未禁止〔m:〕。因此这不是纯推测：正常工具写入的 owner 规则说明就可以触发。

**建议**：不要把任意文字里的〔m:〕当成结构标记。可选做法：
- 渲染 `RULES.md` 时转义规则说明/出处/名单里的〔（或把标记改成不会与正文混淆的编码）；
- 或者只核对生成器写在固定位置的来源记忆后缀，而不是扫描整行；
- 补一条“规则说明/出处/发件人包含〔m:other〕仍能导出并导入”的正向用例，以及 `sourceMemoryId === null` 时同样场景的用例。

---

### 2. 中：非法 JSON 参数会抛原生 `SyntaxError`，不是文档承诺的 `LINE_INVALID`

**文件:行**：`packages/persistence-sqlite/src/data-export/verify.ts:375`

**问题**：`RULE_SCHEMA` 只把 `parameters` 校验为 2 到 262144 个字符的字符串，没有校验它是合法 JSON。随后直接 `JSON.parse`，非法 JSON 会抛出普通 `SyntaxError`，绕过 `DataExportError`，与作者说法“否则 LINE_INVALID”不一致。

**证据**：

```ts
// verify.ts:375
if (JSON.stringify(JSON.parse(version.parameters)) !== version.parameters)
  throw new DataExportError(
    DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    `规则 ${rule.ruleId} 第 ${version.revision} 版的参数不是写规则的程序会写出的形式`,
  );
```

`schema.ts:31-37` 对字符串只查长度；`storedRuleProblem` 本来会用 `parseParameters` 捕获非法 JSON 并返回 `LINE_INVALID`，但新检查放在它前面，先抛了 `SyntaxError`。

**建议**：先调用 `storedRuleProblem`（或把 `JSON.parse` 包在 try/catch 里并抛 `DataExportError(LINE_INVALID)`）；补一条 `parameters: "{not json"` 的反向用例。顺带说明：`export.ts:413` 对数据库里的参数也是裸 `JSON.parse`，数据库里若有坏 JSON 会让导出抛普通 `SyntaxError`，这条是此前已有代码，不是本轮新增。

---

### 3. 低：恢复封存原文前没有确认它是字符串，可能抛 `TypeError`

**文件:行**：`packages/persistence-sqlite/src/data-export/import.ts:239-245`

**问题**：`SEALED_SCHEMA.originals` 只校验为对象，值的类型没有约束；`restoreVersion` 假定 `sealed.originals[key]` 是字符串，直接 `[...parameters]`。如果封存文件里该值是数字、`null` 或对象，会先抛 `TypeError`，而不是作者说的 `SEAL_MISMATCH`。

**证据**：

```ts
const parameters = sealed?.originals[key];
if (parameters === undefined) return null;
if ([...parameters].length > RULE_PARAMETERS_MAXIMUM_LENGTH)
  throw new DataExportError(DATA_EXPORT_ERROR_CODES.SEAL_MISMATCH, `规则 ${ruleId} 的原文超过上限`);
```

`schemas.ts` 中 `SEALED_SCHEMA` 的 `originals` 只有 `{ type: "object" }`，没有逐值 `string` 约束。需要口令才能构造这种封存文件，所以不是普通未授权输入，但仍是错误路径不一致。

**建议**：先判断 `typeof parameters === "string"`，否则抛 `SEAL_MISMATCH`；再检查长度。补一条恢复原文超限/类型不符的反向用例。

---

### 4. 低：`MAXIMUM_LINE_BYTES` 实际比较的是 UTF-16 代码单元，不是字节；新增测试也没有打到这条分支

**文件:行**：`packages/persistence-sqlite/src/data-export/schemas.ts:238`、`export.ts:484`、`verify.ts:267`

**问题**：常量名为 `BYTES`，作者说法也是“每一行不超过 MAXIMUM_LINE_BYTES”，但两端都用 `line.length`。导出和导入一致，所以不会造成“导不回去”，但如果目的确实是 64 MiB 字节上限，含多字节字符时实际允许的字节数可远超 64 MiB。另外，新增反向用例 `test/integration/data-export-rules.test.ts:452` 用 1100 个发件人，参数长度约 27 万字符，会先命中 `export.ts:414` 的每版本 262144 字符上限，`export.ts:484` 的行上限分支并没有被测试覆盖。

**建议**：要么改名为“代码单元上限”，要么在两端统一用 `Buffer.byteLength(line, "utf8")`；并补一条通过大量历史版本触发单行上限的测试。

---

## 推测 / 未核实

- **未核实测试通过数**：不能运行测试，只能静态看代码。`scripts/check-data-export.mjs:16` 的下限确实是 `76`，但实际是否有 76 条带 `[P1-6]` 的用例通过，未核实。
- **MCP 客户端名路径**：`apps/agent-service/src/production-owner-rules.ts:531` 的来源可以是 `mcp:${proposal.client}`，我确认了这里会进入 `source`，但没有继续追到 MCP 客户端名的上游校验；如果客户端名允许任意字符，则问题 1 还会通过“出处文字”触发。
- **未运行任何测试或构建**；以上反向用例是否会失败，是按代码路径推断。

---

## 侧重检查

- **不可信导入输入**：我检查了 `parsePortable` 的 schema 校验、封存文件解密与恢复、事务前空目标检查。导入写入发生在全部校验之后，测试也检查失败后目标库为 0 行；未发现“先写后校验”的新问题。
- **错误路径**：发现两处新检查会抛非 `DataExportError` 的原生异常（问题 2、3）。
- **安全/机密**：非原样参数会被标 `withheld` 并只进封存文件，正常写入路径（`sqlite-owner-rule-operations.ts:131`、`sqlite-proactive-operations.ts:316/328`）都使用 `JSON.stringify`，因此“非原样检查”不会误拒正常写入的参数；误拒来自标记核对，不是非原样检查。封存原文的长度检查发生在完整解密之后，不能防止解密阶段的资源消耗，但这是既有设计。
- **不可撤销操作**：导入是事务性写入，且要求目标规则表为空；本轮没有引入新的不可撤销操作。
- **规则/文档一致性**：ADR 0233 关于“只核对〔r:〕〔m:〕标记”“非原样参数扣留”“withheld.texts 包含规则参数版本”“下限 76”与代码基本一致；不一致的是作者说法中的 `LINE_INVALID`（非法 JSON 会抛 `SyntaxError`）和“行上限按字节”（实际按 UTF-16 长度）。
- **与模型请求开头的关系**：本轮增量只改 `data-export`、ADR、测试和 `check-data-export.mjs`，没有改提示词目录、运行时、工具定义或历史存储；`RULES.md` 是导出压缩包里的只读文件，不进入模型请求。

---

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本轮改动没有触碰系统提示、工具定义、历史消息或遮盖逻辑；新增的 `RULES.md` / `rules.jsonl` 只在导出归档里。发给模型的内容仍然只由原有请求组装逻辑决定，没有新增“每轮会变的值”，所以不违反“只在末尾追加”。

2. **不会让同一段文字在不同模型请求里变成不同字节。** 本轮没有改请求序列化；导出侧 `rules.jsonl` 按 `ORDER BY rule_id, revision` 生成，封存文件用 `canonicalJson`，`withheldRules`/`withheldKeys` 这类 Set 只用于计数，输出顺序不依赖它们。`manifest.exportedAt` 是既有字段，不属于模型请求内容。新增的标记核对本身是纯函数，不改变导出字节。

3. **有自动检查，但不够完整。** 已有反向用例覆盖：改写 RULES.md 来源记忆标记被拒、非原样参数被拒、超参数上限导出失败。静态推断这些用例会失败。但缺少：规则说明/出处里含〔m:…〕的合法导出用例、非法 JSON 参数的 `LINE_INVALID` 用例、恢复封存原文超限的用例；新增的“超上限导出失败”用例实际先命中每版本参数上限，没有覆盖 `export.ts:484` 的行上限分支。测试未运行，通过条数未核实。

4. **逐个核对主要新值：**
   - `RULE_PARAMETERS_MAXIMUM_LENGTH`：schema 的 `maxLength`、导出 `export.ts:414`、导入恢复 `import.ts:241` 都用 `[...值].length`，口径一致，正常写入不会误拒。
   - `MAXIMUM_LINE_BYTES`：导出和导入都用 `line.length`，两端能互相接受，但实际不是字节，见问题 4。
   - `〔r:id〕` / `〔m:id〕`：生成端在 `rules.ts:203`，消费端在 `rules.ts:241-249`；两端格式能识别，但生成端没有隔离正文中的同形文字，导致合法导出被误拒，见问题 1。
   - `withheld.rules`：已加入 `MANIFEST_SCHEMA` 和 ADR；管理 CLI 的 `totalWithheld` 虽然只接收 `texts/memories/decisions`，但规则参数版本已经计入 `withheld.texts`，所以不会漏报或重复计数。
   - `rules` / `enforcedRules` / `ruleHistoryVersions`：导出生成、`verify.ts` 重新计算并与清单比较、导入报告复用同一口径，未发现两端口径不一致。
   - `SEAL_MISMATCH`：超长恢复原文本应走该错误码，但非字符串原文会先抛 `TypeError`，见问题 3；该分支也没有自动测试。
