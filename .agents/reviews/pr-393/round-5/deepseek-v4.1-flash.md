## 复核范围

`b66ed74..41bcc489` 里混入了从 `origin/main` 合进来的其它 PR（P3-1、PR 381/392/394/398 等）；PR 393 本轮真正的增量就是 `c97d84fa` 的 8 个文件（`rules.ts`、`verify.ts`、`import.ts`、`schemas.ts`、`export.ts`、测试、`check-data-export.mjs`、ADR 0233）。下面以这 8 个文件为主，另外报告我在同一条数据通路上看到的残留问题。

我没有运行测试或 lint（工具限制只允许读文件和 Git），以下结论都来自静态核对。

## 发现的问题（按严重度）

### 1. 低：封存原文的类型校验只加在规则上，记忆/决策原文仍不检查

- 文件:行：`packages/persistence-sqlite/src/data-export/schemas.ts:341-345`、`import.ts:111-114`、`import.ts:158-160`、`import.ts:190-195`，对照新增的 `import.ts:241-245`
- 问题：`SEALED_SCHEMA` 只声明 `originals: { type: "object" }`，没有约束每个 value 必须是字符串；本轮只给 `restoreVersion`（规则参数）加了 `typeof parameters !== "string"` 检查。记忆正文和决策正文仍走 `original()`，直接把任意 JSON 值当 `string` 返回。
- 证据（读代码证实）：
  ```ts
  // schemas.ts:341-345
  export const SEALED_SCHEMA = objectOf({
    format: { type: "string", const: FORMAT_VERSION },
    originals: { type: "object" },
    evidence: nullable(EVIDENCE_SCHEMA),
  });
  ```
  ```ts
  // import.ts:111-114
  const original = (key: string, text: ParsedText): string | null => {
    if (text.withheld !== true) return text.text;
    return sealed?.originals[key] ?? null;
  };
  ```
  ```ts
  // import.ts:158-160：拿到后直接当明文用
  const contentRef = await protect(
    memory.content,
    original(`memory/${memory.id}/content`, memory.content) ?? "",
  );
  ```
  ```ts
  // import.ts:241-245：只有规则路径做了类型判断
  if (typeof parameters !== "string")
    throw new DataExportError(
      DATA_EXPORT_ERROR_CODES.SEAL_MISMATCH,
      `规则 ${ruleId} 的原文不是文字`,
    );
  ```
- 后果：恶意或损坏的封存文件把 `originals["memory/.../content"]` 设成数字/对象时，规则路径会规范地报 `SEAL_MISMATCH`，记忆/决策路径则可能把值交给 `TextEncoder.encode`。具体是抛原生 `TypeError` 还是转成字符串取决于运行时（**未核实**，不能在这里运行 Node 验证）；无论哪种，都不是 `DataExportError`，与规则路径不一致。
- 建议：抽一个 `sealedText(key): string | null`，所有 `originals` 读取都走它；缺失返回 `null`，存在但非字符串统一抛 `SEAL_MISMATCH`。这属于本轮修复的同类路径，**不是本轮引入的回归**。

### 2. 低：`ruleLine` 仍把 `ruleId`/`sourceMemoryId` 原样拼进 RULES.md

- 文件:行：`packages/persistence-sqlite/src/data-export/rules.ts:206-207`、`rules.ts:250-253`
- 问题：本轮把规则文字和出处做了 `plainText`，但两个标识仍是直接插值，没有折叠换行或转义。
- 证据（读代码证实）：
  ```ts
  // rules.ts:206-207
  const source = rule.sourceMemoryId === null ? "" : `；来源记忆〔m:${rule.sourceMemoryId}〕`;
  return `- 〔r:${rule.ruleId}〕 ${KIND_LABELS[kind]}。${plainText(text)}（第 ${rule.revision} 版，${STATUS_LABELS[rule.status]}；出处：${plainText(rule.source)}${source}）`;
  ```
  导入侧仍扫描整行：
  ```ts
  // rules.ts:250-253
  const memories = [...(lines[0] ?? "").matchAll(MEMORY_MARK)].map((match) => match[1]);
  const expected = rule.sourceMemoryId === null ? [] : [rule.sourceMemoryId];
  if (memories.length !== expected.length || memories.some((id, index) => id !== expected[index]))
    return `${RULES_INDEX_FILE} 里规则 ${rule.ruleId} 的来源记忆和 data/rules.jsonl 对不上`;
  ```
- 后果：记忆 id 在 `MEMORY_SCHEMA` 里只有 `text(1, 512)`，没有字符集限制；如果 id 含换行，渲染出的 RULES.md 会被拆成多行，导入时 `checkRulesMarkdown` 拒绝整包（自伤式 DoS，不是提权）。如果 id 含 `〔m:`，它会嵌进生成的 `〔m:...〕` 里，虽然当前正则仍把整段算作一个捕获，不会伪装成另一条来源记忆，但文本上会出现额外的标记样式。正常应用生成的 id 是安全的，只有手工构造/导入的异常数据会触发。
- 建议：在导出或导入时对 `ruleId`、`sourceMemoryId` 做字符集校验（例如只允许当前 id 生成器会产出的字符），或在渲染时对它们也做折叠/转义；不建议直接 `foldText` 改变 id 语义。

### 3. 低：`checkRulesMarkdown` 是 O(规则数²)，导入没有规则条数上限

- 文件:行：`packages/persistence-sqlite/src/data-export/rules.ts:245-255`；调用点 `verify.ts:365-392`
- 问题：每条规则都要在 `listed` 全表里 `filter` 一次；`parseLines` 只限制单行长度，不限制文件行数/规则条数。
- 证据（读代码证实）：
  ```ts
  const listed = markdown.split("\n").filter((line) => RULE_LINE.test(line));
  for (const rule of rules) {
    const lines = listed.filter((line) => RULE_LINE.exec(line)?.[1] === rule.ruleId);
    ...
  }
  ```
- 后果：一个包含大量小规则的恶意压缩包会让导入时间按平方增长，属于资源耗尽风险。导入是本地、由主人主动执行的操作，威胁模型有限，所以定为低；但这是 PR 393 新加文件的代码，第 5 轮没有改。
- 建议：先把 `listed` 聚成 `Map<ruleId, string[]>`，再按规则查；另外给规则数/总行数一个上限，和 `MAXIMUM_LINE_LENGTH` 一起作为导入的资源边界。

### 4. 提示（未核实是否已发布 v2）：已导出的旧 v2 包仍然导不进

- 文件:行：`rules.ts:198-207`、`rules.ts:250-253`
- 问题：本轮只修正了“新导出的 RULES.md”。修复前生成的 v2 包，规则文字/出处里仍有字面 `〔m:...〕`，导入侧仍按整行扫描，所以那些旧包还是会被误拒。
- 证据（读代码证实）：`plainText` 只在渲染时调用；导入校验逻辑没有兼容旧格式的分支。
- 后果：如果 v2 已经发布给用户，用户此前导出的备份无法导入；如果 v2 仍在同一个 PR 里、尚未发布，则没有实际影响。
- 建议：确认 v2 是否已经上线；若已上线，需要在导入侧对旧包做兼容或提升格式版本，而不是只修导出端。

## 侧重检查

- **不可信输入/封存文件**：`SEALED_SCHEMA` 的 `originals` 值只校验“是对象”，规则参数在本轮补了字符串类型检查；记忆/决策原文没有补（见问题 1）。规则参数恢复后还会走 `storedRuleProblem`，这一步是合理的。
- **不合规输入**：`data/rules.jsonl` 的 `ruleId`/`sourceMemoryId` 仍被原样拼进 RULES.md（见问题 2）。`RULE_SCHEMA` 的 `ruleId` 只限制长度，导入侧对 `owner:` 开头的 id 有正则，对内置 id 通过 `STORED_KINDS` 兜底；整体上没有发现可绕过 `storedRuleProblem` 的路径。
- **安全/卸载**：本轮没有新增外发、解密或权限操作；`plainText` 是纯字符串变换，没有依赖前后文。
- **资源耗尽**：发现 `checkRulesMarkdown` 的 O(n²) 和规则条数无上限（问题 3）；单行上限 64 MiB 在导出和导入两端使用同一常量、同一 `.length` 单位。
- **不可撤销操作**：导入在 `parsePortable`、解封、`assertEmptyTarget`、`restoreVersion` 全部成功后才进入数据库事务（`import.ts:92-109`、`233-275`、`325`），本轮的 `SEAL_MISMATCH` 在事务前抛出；没有发现新增的“失败后已写入”路径。`rule_book_history` 的不可变触发器仍在。
- **规则/文档一致性**：ADR 0233 新增的“〔〕换［］”与代码一致；声称的 3 条新测试、`check:data-export` 下限 79 也与测试文件一致。唯一未覆盖的是旧 v2 包的兼容（问题 4）。

## 作者说法逐条核对

1. **“规则文字和出处经 plainText，〔r:〕〔m:〕只会是生成的标记；checkRulesMarkdown 仍扫描整行”**：基本准确。`rules.ts:198-207` 的 `text` 和 `rule.source` 都过了 `plainText`；`rules.ts:250` 仍对整行做 `MEMORY_MARK`。严格说，内置规则段落里的 `rule.source` 没有过 `plainText`（`rules.ts:230-233`），但那来自代码常量，不是用户输入。
2. **“未扣留版本先跑 storedRuleProblem，再查原样形式”**：准确。`verify.ts:375-382` 的顺序与说法一致，坏 JSON 会在 `storedRuleProblem` 里返回问题并以 `LINE_INVALID` 抛出，不再漏出原生 `SyntaxError`。
3. **“restoreVersion 里封存原文不是字符串时 SEAL_MISMATCH”**：准确。`import.ts:241-245`。
4. **“单行上限常量改名 MAXIMUM_LINE_LENGTH”**：准确。`schemas.ts:238` 定义，`export.ts:484` 与 `verify.ts:267` 两处使用，全仓库没有残留 `MAXIMUM_LINE_BYTES`；两处比较的都是字符串 `.length`，改名比原名更准确，行为不变。
5. **“新测试 3 条；check:data-export 下限 79；ADR 0233 写明〔〕替换”**：静态核对准确。新增的是非 JSON 反向用例、带字面标记的正向用例、非字符串封存原文反向用例；`scripts/check-data-export.mjs:16` 从 76 改为 79，正好加 3；ADR 0233 第 2 条已写明替换规则。实际测试是否执行通过我未能运行（**未核实**）。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。PR 393 只改数据导出/导入和网页导出按钮，`RULES.md` 只在 `packages/persistence-sqlite/src/data-export/` 和测试、i18n、ADR 里出现；`packages/prompt-catalog`、`packages/runtime-pi` 没有读取 `RULES.md` 的路径，规则进入模型请求走的是另一套 owner-rules 块。因此本改动没有改系统提示、工具定义、历史消息或遮盖，也不涉及“每轮会变的值只能放最后一条消息”的约束。

注意：`b66ed74..41bcc489` 里确实包含来自 main 的 `packages/prompt-catalog` 改动（P3-1 等），那不是 PR 393 的提交；如果要求把整个 merge 后的 diff 都当作本次改动审查，这部分我没有按 PR 393 的标准核实（**未核实**）。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

本轮新增的 `plainText` 是纯函数：`foldText` + 两次 `replaceAll`，不依赖时间、前后文或集合遍历顺序。`renderRulesMarkdown` 的规则顺序来自 `snapshot.ts` 的 `ORDER BY rule_id` / `ORDER BY rule_id, revision`，历史顺序固定；遮盖逻辑（`maskLeaves`、`exportedText`）本轮未改，仍是确定性的。没有新增“带时间的字段”或“无序集合”。唯一自然会变的是既有的 `manifest.exportedAt`，与本轮无关。

**3. 有没有自动检查，反向用例是否真的会失败？**

有。新增 3 条测试：
- 非 JSON 参数：旧代码会先执行 `JSON.stringify(JSON.parse(...))`，抛出原生 `SyntaxError`，测试要求的 `code: LINE_INVALID` 不成立；新代码先走 `storedRuleProblem`，会以 `LINE_INVALID` 拒绝，所以反向用例确实会由红转绿。
- 非字符串封存原文：旧代码执行 `[...parameters]` 会对数字/对象抛 `TypeError`，不是 `SEAL_MISMATCH`；新代码先做类型判断，测试才会通过。
- 带字面标记的正向用例：旧代码渲染出的 RULES.md 会多出 `〔m:m-other〕`/`〔m:m-elsewhere〕`/`〔m:y〕`，`checkRulesMarkdown` 的核对数量对不上，导入会失败；新代码替换为 `［］` 后通过。

`check:data-export` 下限从 76 改为 79，与新增 3 条吻合。实际执行结果我未能运行（**未核实**）。另：常量改名没有专门测试，但它不改变行为，由 TypeScript 编译/现有检查覆盖。

**4. 新产生的值两端都能接受吗？**

逐项核对结果：
- `MAXIMUM_LINE_LENGTH`：产生于 `schemas.ts:238`，只被 `export.ts:484` 和 `verify.ts:267` 使用，两端都按字符串 `.length` 比较，单位一致。
- `data/rules.jsonl` 的字段：导出端 `export.ts:432-459` 产生；导入端 `verify.ts:314` 按 `RULE_SCHEMA` 解析，`import.ts:592-623` 写入数据库。数据库约束（`migrations/0087_rule_book_memory_link.sql:242-275`）为 `rule_id` 1..64、`parameters` 必须是 JSON object、`source` 1..256、`source_memory_id` 1..128、`change_reason` 1..64，与 `schemas.ts:240-268` 的 `RULE_SCHEMA` 对得上；`RULE_PARAMETERS_MAXIMUM_LENGTH` 在导出、导入和本地 `validateAgainst` 里都按 Unicode 码点计算（`schema.ts:31-36`），一致。
- manifest 新增的 `counts.rules`/`enforcedRules`/`ruleHistoryVersions`、`withheld.rules`：导出端都产生，`MANIFEST_SCHEMA` 都要求为 `integer(0)`，`verify.ts:393-414` 重新计算并逐项比对；消费方 `production-data-export.ts:139` 把 `enforcedRules` 放进响应头，前端 `data-export.ts:16-19` 只接受安全非负整数，能接受。
- 封存原文：产生端 `export.ts:120`、`422` 只放字符串；消费端规则路径本轮已检查字符串（`import.ts:241-245`），记忆/决策路径仍未检查（问题 1）。
- `check-data-export` 的 `REQUIRED = 79`：只被 `scripts/check-data-export.mjs:49-53` 使用，和新增用例数一致。

因此 I-73 式的“清单/数据两端的校验对不上”在本轮新增的规则字段上没有发现；剩下的两端不一致就是问题 1 的封存原文类型。
