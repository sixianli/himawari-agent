## 结论摘要

第 3 轮的 5 处修改在当前代码里都能找到；同版本内没有发现“正常写入参数被误扣留”或“合法导出被 RULES.md 校验误拒”的直接缺陷。主要风险是：RULES.md 校验把“人类可读文案”当成校验值（跨版本会误拒）、新上限分支缺少反向测试、长度单位前后端不一致，以及导入端没有复用“非 canonical 即扣留”的不变量。另有一处 `withheld.texts` 语义变化需要补文档。

## 一、读代码证实的问题（按严重度）

### 1. 【中】`RULES.md` 校验依赖当前版本的展示文案，跨版本会拒绝合法旧包

文件：`packages/persistence-sqlite/src/data-export/rules.ts:197-203`、`239-253`

问题：`checkRulesMarkdown` 用当前代码的 `ruleLine()` 重算期望行，而 `ruleLine()` 含 `KIND_LABELS`、`STATUS_LABELS`、`WEEKDAY_LABELS`、`wording()`、`foldText()`（`rules.ts:60-77`、`132-193`）和 `totalLine()` 的中文文案。只要以后改任何一个标签、文案或格式化，旧版本导出的 v2 包就会被新版本拒绝；反过来新包也会被旧版本拒绝。ADR 只写了“产品自带一节随版本变，有意不比较”，没有覆盖“存下来的规则行也依赖版本”。

证据：
```ts
// rules.ts:202
return `- 〔r:${rule.ruleId}〕 ${KIND_LABELS[kind]}。${foldText(text)}（第 ${rule.revision} 版，${STATUS_LABELS[rule.status]}；出处：${foldText(rule.source)}${source}）`;
// rules.ts:248-251
const expected = rules.map((rule) => ruleLine(rule, withheldText));
for (const [index, line] of expected.entries())
  if (listed.filter((candidate) => candidate === line).length !== 1)
    return `${RULES_INDEX_FILE} 里规则 ${rules[index]?.ruleId ?? ""} 那一行和 data/rules.jsonl 对不上`;
```
建议：不要用完整人类文案做跨版本校验。可改为只校验稳定字段（`ruleId` 唯一、`revision/status/sourceMemoryId` 与数据一致、规则行数），或给 `manifest` 加 `rendererVersion`，只有版本相同才逐字比对；同时加一条用旧版 RULES.md 固定 fixture 的跨版本用例，或在改任何文案时强制升 `FORMAT_VERSION`。

### 2. 【中】新上限 `262144` 的导出拒绝分支没有反向测试

文件：`packages/persistence-sqlite/src/data-export/export.ts:413-417`；测试缺口在 `test/integration/data-export-rules.test.ts:302-325`

问题：新增的“参数超过上限就抛 `LINE_INVALID`”是这次“不生成导不回去的包”的核心保护，但现有最大用例只验证了 `>40_000` 能通过，没有任何用例构造 `262145` 个字符并断言导出失败。如果这段代码被误删或上限写错，`check:data-export` 仍会通过。

证据：
```ts
// export.ts:413-417
if (parameters.length > RULE_PARAMETERS_MAXIMUM_LENGTH)
  throw new DataExportError(
    DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    `规则 ${ruleId} 的参数超过 ${RULE_PARAMETERS_MAXIMUM_LENGTH} 个字符`,
  );
// test:320
expect(stored.length).toBeGreaterThan(40_000);
```
建议：补一条反向用例，直接写一条长度 `262145` 的规则参数，断言 `buildPortableExport` 抛 `DATA_EXPORT_ERROR_CODES.LINE_INVALID` 且不产出文件；再补一条恰好 `262144` 的边界通过用例。

### 3. 【低】导出端与 Schema 端的长度单位不一致

文件：`packages/persistence-sqlite/src/data-export/export.ts:413`；`packages/persistence-sqlite/src/data-export/schema.ts:32`；`packages/persistence-sqlite/src/data-export/schemas.ts:244`

问题：`export.ts` 用 JavaScript 字符串 `.length`（UTF-16 code unit）判断上限，而 `validateAgainst` 用 `[...value].length`（Unicode code point）判断 `maxLength`。含代理对（emoji 等）时，同一字符串会得到不同长度：导出可能拒绝一个 Schema 会接受的参数，或接受一个导入端会按不同口径处理的参数。当前正常写入路径基本碰不到（收件人写入拒绝 surrogate，owner 规则上限 16384），所以是低严重度，但两端校验口径确实不一致。

证据：
```ts
// schema.ts:32
const length = [...value].length;
// export.ts:413
if (parameters.length > RULE_PARAMETERS_MAXIMUM_LENGTH)
```
建议：两端统一用 code point 计数，或明确上限按 UTF-16 单位并在 Schema 注释/校验中同步；加一条含非 BMP 字符的边界测试。

### 4. 【低】导入端没有复用“非 canonical 即扣留”的不变量，且恢复后的封存原文没有重新过长度校验

文件：`packages/persistence-sqlite/src/data-export/verify.ts:370-379`；`packages/persistence-sqlite/src/data-export/import.ts:238-244`

问题：导出端在 `export.ts:418` 把 `JSON.stringify(JSON.parse(raw)) !== raw` 的参数标成 `withheld`，但导入端对**未扣留**版本只调用 `storedRuleProblem`，不检查 canonical 形式。手工修改并重算哈希的包可以写入一个非 canonical 但合法的参数，之后用户保存设置时会因为字符串比较不等而凭空多出版本——正是这次修改想避免的问题。另一个方向：`restoreVersion` 从封存文件恢复原文后只跑 `storedRuleProblem`，不再检查 `RULE_SCHEMA` 的 `maxLength`，所以封存原文可以绕过新的 262144 上限。

证据：
```ts
// verify.ts:375-378
if (version.withheld === true) continue;
const problem = storedRuleProblem(rule.ruleId, version);
if (problem !== null) throw ...
// export.ts:418
if (!hasSecretLeaf(parsed) && JSON.stringify(parsed) === parameters) return { parameters };
```
建议：在 `parsePortable` 对未扣留版本、以及 `restoreVersion` 对恢复后的原文，都检查 `JSON.stringify(JSON.parse(parameters)) === parameters` 和长度上限；或者在 ADR/错误信息里明确“只保证本程序导出的包”。

### 5. 【低】`withheld.texts` 的含义被扩大，`withheld.rules` 的语义和消费方没有同步写清

文件：`packages/persistence-sqlite/src/data-export/export.ts:419-420`；`apps/admin-cli/src/data-command.ts:98-99`；`test/integration/data-export-http.test.ts:88-91`

问题：`ruleParameters` 现在把规则参数 key 也加进 `withheldKeys`，所以 `manifest.withheld.texts` 不再只是记忆/决策文字，也包含规则参数版本。这其实让 CLI 的 `UNSEALED_WITHHELD` 守卫仍然有效（它看的是 `withheld.texts`），但：
- ADR 0200 对 `withheld.texts` / `x-himawari-export-withheld` 的定义没有更新；
- `withheld.rules` 统计的是“规则条数”，而 `withheldKeys` 统计的是“版本 key 数”，两者口径不同；
- `totalWithheld` 的参数类型仍只写 `texts/memories/decisions`，没有把 `rules` 写进去，靠 `texts` 间接覆盖，容易在后续重构中失效；
- CLI 的反向用例只 seed 了记忆，没有 seed 含机密规则，所以“只有规则被扣留”时守卫是否触发没有被测试锁住。

证据：
```ts
// export.ts:419-420
withheldKeys.add(key);
withheldRules.add(ruleId);
// data-command.ts:98-99
function totalWithheld(withheld: { texts: number; memories: number; decisions: number }) {
  return withheld.texts + withheld.memories + withheld.decisions;
}
// data-export-http.test.ts:89-90
expect(manifest.withheld.texts).toBe(8);
expect(manifest.withheld.rules).toBe(1);
```
建议：在 ADR 0200/0233 里明确 `withheld.texts` 现在包含规则参数版本、`withheld.rules` 是规则条数；把 `totalWithheld` 参数改成完整的 `PortableManifest["withheld"]` 并显式决定是否加 `rules`；补一条“只有规则含机密、无口令导出必须被 CLI 拒绝”的反向测试。

### 6. 【低】“withheld 表示参数里有机密”的说明与非 canonical 扣留不一致

文件：`packages/persistence-sqlite/src/data-export/schemas.ts:266`；`packages/persistence-sqlite/src/data-export/types.ts:10`

问题：现在 `withheld: true` 还可能只是因为参数不是 `JSON.stringify` 形式（没有机密）。但 Schema 描述仍写“withheld 为 true 时参数里有机密”，`WITHHELD_PLACEHOLDER` 仍写“内容含机密，已扣留”。用户会在 RULES.md 里看到“含机密”的提示，实际可能只是格式问题。

证据：
```ts
// types.ts:10
export const WITHHELD_PLACEHOLDER = "[内容含机密，已扣留]";
// schemas.ts:266
"withheld 为 true 时参数里有机密，parameters 是遮盖后的 JSON..."
```
建议：把描述和占位文字改成“含机密或无法原样安全导出”，并在 ADR 0233 的机密一节明确非 canonical 情况。

## 二、推测（未证实）

- 【推测】导出只检查每个 `parameters` 字符串长度，不检查整条 JSONL 序列化后的行长。导入端 `verify.ts:34` 有 `MAXIMUM_LINE_BYTES = 64 * 1024 * 1024`；若一条规则有很多历史版本、每版接近 262144 字符，`262144 × 约 250` 就可能超过 64MB，导致自己导出的包里 `data/rules.jsonl` 被自己的导入端拒绝。当前正常写入的每版参数远小于 262144（设置约 10 万、owner 规则 16384），要积累约 600 个最大设置版本才可能触发，所以只是理论风险。
- 【推测/未核实】历史数据是否可能是非 canonical：我确认了当前两个写入器都用 `JSON.stringify`，迁移 0086 用 SQLite `json_object('periods', json(quiet_hours))`，SQLite 的 `json()` 会压缩空白，正常情况下应一致。但我没有逐一核对所有历史版本的写入代码和旧数据；如果旧数据里存在空格、`\/`、控制字符转义等非 `JSON.stringify` 形式，新逻辑会把它标成 withheld，网页无口令导入时整条规则会被跳过。
- 【未核实】`.agents/reviews/pr-393/round-2/*` 不在当前稀疏检出里，`git show` 对 records 路径被拒绝，因此没有读到第 2 轮两位复核者的原文，只按作者描述和代码核对。测试也没有运行（工具限制），只能从代码判断反向用例会走到新分支。

## 三、侧重检查

- 错误路径：检查了导出超限、导入恢复扣留原文、`assertRuleHistory` 二次校验、目标表非空、封存原文与历史不一致。无写入前抛错的设计是对的：`assertRuleHistory` 和 `restoreVersion` 都在 `database.transaction` 之前执行（`import.ts:248-265`、`315` 起），失败不会写库；测试也断言失败后 `rule_book_rules`/`memory_records` 为 0。
- 不可信输入：`parseLines`、Schema、`storedRuleProblem`、`assertRuleHistory`、`withheld` 恢复都有校验；发现的问题是恢复后的封存原文没有重新过长度/canonical 校验（见问题 4），以及未扣留参数在导入端没有 canonical 检查。
- 安全/机密：`hasSecretLeaf` + `maskLeaves` 对普通机密和重复键隐藏值的方向是对的；非 canonical 参数会走封存路径，明文层不会包含被 `JSON.parse` 丢掉的重复键内容。没有发现新的明文泄漏。
- 资源耗尽：导出端先 `JSON.parse` 再检查长度，超大参数仍会先被解析；上限 262144 本身不构成大问题，但整条规则行超过导入端 64MB 行限制是理论风险（见推测）。
- 不可撤销操作：导入在空库事务里执行，规则历史也纳入 `EMPTY_TARGET_TABLES`（`import.ts:65-76`）；未发现新的“部分写入”路径。
- 规则/文档/代码一致：ADR 0233 已同步上限、RULES.md 校验、`rule_book_history` 空库检查和测试下限；但 `withheld.texts` 语义扩大、`withheld.rules` 口径、非 canonical 的“含机密”文案没有完全同步（见问题 5、6）。

## 四、作者说法核对

1. **上限 16384 → 262144、超限抛 `LINE_INVALID`**：代码符合。`schemas.ts:237` 是 `262_144`，`export.ts:413-417` 抛 `LINE_INVALID`。上限对正常写入数据足够：设置写入允许最多 200 个收件人、每个最多 254 字符（`sqlite-proactive-operations.ts:287-292`），即使全部是引号/反斜杠需要 JSON 转义，也约 10 万字符，小于 262144；owner 规则写入器另有 16384 上限（`sqlite-owner-rule-operations.ts:10,132`）。但没有超限反向测试，且长度单位与 Schema 不同（问题 2、3）。
2. **`checkRulesMarkdown` 改为总数行 + 每条规则行恰好一次 + 行数等于规则数**：代码符合。`rules.ts:246-253` 用 `totalLine`、`ruleLine` 重算，并检查 `listed.length === expected.length`。同版本内不会误拒合法导出；跨版本改文案时会（问题 1）。
3. **导入恢复后重跑 `assertRuleHistory`；`EMPTY_TARGET_TABLES` 加 `rule_book_history`**：代码符合。`import.ts:257` 调用，`import.ts:74-75` 加表；表确有 `owner_id/agent_id` 列（迁移 0086/0087），测试也覆盖了 leftover history。
4. **`changeReason` 走 `safeOptional`；参数非 `JSON.stringify` 形式按扣留**：代码符合。`export.ts:438` 是 `safeOptional(optionalString(...))`，`export.ts:418-422` 是非 canonical 扣留。需要限定：**只有 `sealPassphrase` 存在时**原样字符串才进封存文件；网页导出没有封存文件时 `originals` 会被丢弃（`export.ts:495-508`），这类规则只能看、不能无口令导入，ADR 0233 的后果一节写了这一点。正常写入器都使用 `JSON.stringify`，不会误判；迁移 0086 的 SQLite `json()` 也会压缩空白，正常数据应一致。
5. **6 条新测试、`check:data-export` 下限 74、ADR 同步**：代码符合。新增 6 条测试在 `data-export-rules.test.ts`，`scripts/check-data-export.mjs:16` 是 `REQUIRED = 74`，ADR 第 2/3/5/6/8 条已改。测试未运行，实际通过数是否 ≥74 未核实。

## 五、必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

就本 PR 的提交（`230459ed`、`6856c8c0`、`4777fd0d`）而言，不会。改动只涉及数据导出包、导出 CLI/网页、RULES.md 校验和测试，没有改系统提示、工具定义、历史保存或 prompt 组装；`230459ed` 唯一碰到 HTTP composition 测试的改动只是新增 `x-himawari-export-rules` 响应头断言。因此没有新增“每轮会变的值”进入请求头，也没有改变已有历史的字节。合入 main 的 `525b8bd8` 带进的其他功能不在本 PR 范围，我未把它们当作本 PR 的改动审计。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

不会影响模型请求。数据导出不是发给模型的内容；同一 DB 状态下 `data/rules.jsonl` 的规则顺序由 `ORDER BY rule_id, revision` 固定，`RULES.md` 和规则行也是确定的。导出包本身有 `manifest.exportedAt = options.now()` 和 zip 时间戳，所以包字节会随时间变化；短文字（`source`/`changeReason`）的 `[已扣留:N]` 编号还依赖同一导出里的其他内容和遍历顺序，这是 ADR 0200 已有的出口遮盖规则，不是模型请求的遮盖。规则参数本身用 `maskLeaves` 按值遮盖，同一参数在同一策略下字节相同。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有，但覆盖不完整。新增反向用例：
- `RULES.md` 少一条规则、规则行文字被改、总数行被改（`data-export-rules.test.ts:394-428`）会命中新 `checkRulesMarkdown`，应抛 `REFERENCE_BROKEN`；
- 封存原文与历史最后一版不一致（`441-467`）会命中新导入端 `assertRuleHistory`；
- 目标库已有 `rule_book_history`（`469-483`）会命中新的 `EMPTY_TARGET_TABLES`；
- 大参数列表和非 canonical 参数（`302-346`）命中新上限/扣留路径。
缺口是：**没有 `>262144` 的导出拒绝反向用例**；**没有“只有规则被扣留时 CLI 无口令导出必须拒绝”的用例**（CLI 用例只 seed 了记忆）。我没有运行测试，所以不能确认这些用例实际通过，只能从代码路径判断反向用例会走到新检查。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

逐项核对结果：
- `RULE_PARAMETERS_MAXIMUM_LENGTH`：Schema 使用同一个数值；但导出用 UTF-16 `.length`、Schema 用 code point，单位不一致（问题 3）。
- `withheld.rules`：manifest/类型/Schema 都有；`withheld.texts` 已包含规则参数 key，所以 CLI 的 `UNSEALED_WITHHELD` 守卫和网页 `x-himawari-export-withheld` 实际仍会覆盖规则（测试里 6 个记忆 key + 2 个规则版本 key = 8 也证明了这一点）；但 `withheld.rules` 本身只有测试在消费，且它统计“规则条数”而 `texts` 统计“参数版本 key 数”，文档没有写清（问题 5）。
- 封存 key `rule/<id>/parameters`、`rule/<id>/history/<revision>/parameters`：导出和导入都用 `ruleParametersKey`，两端一致。
- `rule_book_history` 清单项：表存在且有 `owner_id/agent_id`，导入端 `assertEmptyTarget` 能正常查询。
- `changeReason` 的 `safeOptional`：Schema 是 `nullable(text(1,64))`，`[已扣留:N]` 长度可接受；按 ADR 0200 短文字策略不进封存文件，导入会变成占位符，这是设计内的有损行为。
- `totalLine`/`ruleLine`：导出与导入同版本使用同一函数，能互相接受；跨版本改文案会误拒（问题 1）。
- `x-himawari-export-rules`：生产端是 `enforcedRules` 整数，控制台用 `Number.isSafeInteger(value) && value >= 0` 接收，两端一致。
- 导出超限抛出的 `LINE_INVALID`：值是 `DATA_IMPORT_LINE_INVALID`，HTTP 处理器会因为消息里带详情而回退成通用 `DATA_EXPORT_FAILED` 日志/500；功能上不破坏，但错误码命名和日志可读性一般，属于低优先级的命名/观测问题。
