## 结论

作者第 6 轮的两条说法与代码一致：`07a6a368` 的三处修改都在，合入 main 时 `demo-pack.ts` 补的 rules 项、`demo-data.test.ts` 补的 `rulesWithoutOriginal`、`snapshot.ts` 和夹具里规则与预审并存、预审种子在 `seedRules` 之前，均已核对属实。没有发现高严重度问题；下面两处中低问题、两处低风险缺口。

## 发现（按严重度）

### [中] 导出端不校验规则编号/来源记忆编号，导入端却会拒绝，且编号直接拼进密封键

- 文件:行：`packages/persistence-sqlite/src/data-export/export.ts:432-457`、`packages/persistence-sqlite/src/data-export/rules.ts:41-45`、`packages/persistence-sqlite/src/data-export/verify.ts:286,371-379`、`packages/persistence-sqlite/src/migrations/0086_rule_book.sql:4`
- 问题：导出时只调用 `assertRuleHistory`，没有做导入端的 `RULE_ID_CHARACTERS`、来源记忆编号字符检查，也没有对非扣留版本调用 `storedRuleProblem`。数据库对 `rule_id` 只要求 `length BETWEEN 1 AND 64`，因此库里若有带 `/`、换行、`〔〕` 或参数不合法的规则，导出会成功，但再导入自己的包会被 `verify.ts` 拒绝。更具体地，`ruleId` 未经转义就进入密封键，`ruleId = "a/history/1"` 的当前参数键会和 `ruleId = "a"` 的第 1 版历史键同名：
  ```ts
  // rules.ts:41-45
  return revision === undefined
    ? `rule/${ruleId}/parameters`
    : `rule/${ruleId}/history/${revision}/parameters`;
  ```
  ```ts
  // export.ts:448-454
        ruleId,
        ...
        ...ruleParameters(row["parameters"], ruleParametersKey(ruleId), ruleId),
  ```
  而导入端新增了更严格的检查：
  ```ts
  // verify.ts:372-379
  if (!RULE_ID_CHARACTERS.test(rule.ruleId))
    throw new DataExportError(..., `规则编号不对：${rule.ruleId}`);
  for (const version of [rule, ...rule.history])
    if (version.sourceMemoryId !== null && /[\r\n〔〕]/u.test(version.sourceMemoryId))
      broken(`规则 ${rule.ruleId} 的来源记忆编号`);
  ```
- 证据：我亲自读到 `export.ts` 只做 `assertRuleHistory(rule)`（第 457 行），没有 `storedRuleProblem`；`verify.ts` 第 286 行定义 `RULE_ID_CHARACTERS = /^[A-Za-z0-9_:-]+$/u`；`0086_rule_book.sql` 第 4 行只有长度约束。
- 建议：把编号与参数的校验抽成一个函数，导出、导入共用；或在导出前按导入规则拒绝；同时把密封键里的 `ruleId` 做不可碰撞编码（如长度前缀/转义），并考虑给 `rule_book_rules.rule_id` 加同样的字符 CHECK。是否是真实触发要看库里是否会出现非法编号：生产写规则路径用 `owner:`+sha256 前 24 位十六进制（`apps/agent-service/src/production-owner-rules.ts:494`）或固定常量，未发现正常路径会生成非法编号，因此实际触发面主要是手工写入、旧版本或损坏数据。

### [中] `checkRulesMarkdown` 的新分组在同编号行很多时是 O(n²)，可被特制 RULES.md 拖死导入

- 文件:行：`packages/persistence-sqlite/src/data-export/rules.ts:245-250`
- 问题：新增的按编号分组每次都用数组展开复制：
  ```ts
  const byRule = new Map<string, string[]>();
  for (const line of listed) {
    const id = RULE_LINE.exec(line)?.[1] ?? "";
    byRule.set(id, [...(byRule.get(id) ?? []), line]);
  }
  ```
  当 RULES.md 里大量行使用同一编号时，累计复制量是 1+2+…+n，约 O(n²)。`readPortableDirectory` 允许单文件 512MB、总量 512MB（`directory.ts` 的 `MAXIMUM_FILE_BYTES`、`MAXIMUM_TOTAL_BYTES`），因此一个几十 MB、几十万行同编号的 RULES.md 就能让导入长时间占用 CPU/内存。第 5 轮之前是 `listed.filter(...)`，对“规则为空但 RULES.md 很大”的情况是线性的；这个改动把该路径变差了。
- 证据：上面第 246-250 行；同一文件第 245 行 `markdown.split("\n").filter(...)` 没有总行数/总字节限制。
- 建议：改成 `const bucket = byRule.get(id); if (bucket) bucket.push(line); else byRule.set(id, [line]);`，或者在分组前直接限制 RULES.md 的字节/行数。

### [低] 第 5 轮新增的规则编号、来源记忆编号校验没有反向用例

- 文件:行：`packages/persistence-sqlite/src/data-export/verify.ts:371-379`；`test/integration/data-export-rules.test.ts:349-436`
- 问题：新增了两条拒绝路径（`RULE_ID_CHARACTERS`、`sourceMemoryId` 不含 `\r\n〔〕`），但 `data-export-rules.test.ts` 的篡改用例只覆盖参数不合法、历史缺当前版本、来源记忆不存在、内置规则混入、RULES.md 缺行/错标记等，没有构造“规则编号含 `/` 或换行”“来源记忆编号含 `〔`/`〕` 或换行”的用例。我按关键字检索测试文件未找到对应用例。
- 证据：用例数组从第 350 行开始，到第 436 行结束，共 8 条；没有 `规则编号不对` 或 `来源记忆编号` 相关构造。
- 建议：在 `cases` 里补两条：把某条 `ruleId` 改成 `owner:bad/id`、把 `sourceMemoryId` 改成 `m-〔x〕` 或带换行，断言 `LINE_INVALID`/`REFERENCE_BROKEN` 且目标库仍为空。

### [低，错误路径] `EVIDENCE_SCHEMA` 不要求 `prereviews`，导入却无条件遍历

- 文件:行：`packages/persistence-sqlite/src/data-export/schemas.ts:336-366`、`packages/persistence-sqlite/src/data-export/import.ts:714-715`
- 问题：`EVIDENCE_SCHEMA` 的 required 列表是空的：
  ```ts
  // schemas.ts:366
    [],
  ```
  但导入时直接：
  ```ts
  // import.ts:714-715
  for (const row of evidence.prereviews)
      prereview.run(
  ```
  如果密封文件里的 `evidence` 缺少 `prereviews`，`validateAgainst(SEALED_SCHEMA, ...)` 会通过，随后抛的是 `TypeError`（undefined 不可迭代），而不是受控的 `DataExportError`。这属于错误路径的健壮性问题；正常当前导出一定带该字段。
- 证据：`schemas.ts:336` 定义了 `prereviews`，第 366 行 required 为 `[]`；`import.ts:714` 无 `?? []`。
- 建议：把 `prereviews`（以及同样被无条件遍历的其它 evidence 字段）加入 required，或在 `writeEvidence` 里用 `evidence.prereviews ?? []`。

## 推测（未完全证实，单独列出）

- `assertEmptyTarget` 的表清单没有 `decision_prereviews`（`import.ts:66-77`），合入时只补了 `rule_book_rules`、`rule_book_history`。因为 `decision_prereviews` 的 CHECK 要求 `decision_id` 与 `message_id` 二选一，而二者分别外键到 `decision_ledger`、`proactive_processed_messages`，这两张表都在非空检查里，所以正常库中预审非空通常会被间接拦下。未核实外键关闭或悬挂行的情况，暂不列为确定缺陷。
- 第 5 轮的“原文不是文字”测试改成了改记忆原文（`data-export-rules.test.ts:493` 起），规则参数原文非字符串的专门用例没有了；由于记忆、决策、规则共用 `sealedText`，覆盖仍有效，但规则路径的针对性变弱，属于测试覆盖取舍，不是代码错误。

## 侧重检查

- 封存原文不是文字：`sealedText` 对 `undefined` 返回 `null`、非字符串抛 `SEAL_MISMATCH`；记忆/决策经 `original()`、规则经 `restoreVersion()` 都走它（`import.ts:112-120,239-256`）。改动正确。
- 缺口令/缺原文：记忆跳过并计数，规则整条跳过并计入 `rulesWithoutOriginal`，预审证据不导入并置 `evidenceNotImported`（`import.ts:257-314`）。行为与 ADR 0233 一致。
- RULES.md 篡改：缺行、多行、行内 `〔m:〕` 与数据不一致、多余规则行都会被 `checkRulesMarkdown` 拒绝（`rules.ts:240-263`）；新增分组不改变这些判定。
- 非空目标：规则两表已加入 `EMPTY_TARGET_TABLES`；预审表按上面的理由通常会被间接拦住。
- 不可撤销操作：导入在 `dryRun` 之后才进入事务，`assertEmptyTarget` 在写入前执行，写入集中在 `transaction(...).immediate()`（`import.ts:315-628`）；规则历史表有 `no_update/no_delete` 触发器，导入只插入，没有额外破坏。
- 资源耗尽：发现第 2 条的 O(n²) 分组是本次新引入的主要风险；规则参数长度上限、单行长度上限、封存原文长度上限均有检查。
- 规则文件/文档与代码一致性：ADR 0233 的 v2、`data/rules.jsonl`、`RULES.md`、`withheld.texts`/`withheld.rules`、`x-himawari-export-rules`、v1 拒绝、目标规则表为空等，与代码逐项对得上；ADR 0236 的“格式变化后示范包要跟着改”也已有 `demo-data.test.ts` 覆盖。
- 合入手工调整：`demo-pack.ts` 确实补了 `data/rules.jsonl`、`RULES.md`、`counts.rules/enforcedRules/ruleHistoryVersions`、`withheld.rules`、`omitted` 的“规则”；`SCHEMA_FILES` 迭代自动带上 `schema/rules.schema.json`；夹具里预审种子在 `seedRules` 之前；`snapshot.ts` 同时有 `rules`/`ruleHistory`/`prereviews`。未发现互相覆盖计数或漏项。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 本 PR 自身改动（data-export 的规则导出/导入、demo pack、UI 文案）不进入模型请求组装路径，不改系统提示、工具定义、历史消息或遮盖结果。合入 main 带来的 `packages/prompt-catalog` 等改动相对 main 没有新增变化，不属于本 PR 的新请求头改动。因此就本改动而言，发给模型的内容仍然只在末尾追加，每轮变化的值仍应在最后一条消息；没有把时间、路径、规则清单塞进系统提示。假收件箱的示范邮件是作为数据进入后台主动检查的输入，不是请求开头。
2. **同一段文字会不会在不同请求里变成不同字节？** 规则导出/`RULES.md` 的输入顺序由 `ORDER BY rule_id`、`ORDER BY rule_id, revision` 固定，文件清单排序固定，对象字段按代码固定顺序构造；`withheld` 相关的 Set 只取数量，不参与序列化顺序。同一库、同一口令、同一策略下重复导出得到相同字节。demo pack 按设计依赖生成时刻 `now`（日期会随生成时间变），但这是“每次生成一份新示范包”，不是同一请求内的非确定性。未发现依赖对象遍历顺序的规则/清单输出。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有：`scripts/check-data-export.mjs` 已加入 `data-export-rules.test.ts`，`REQUIRED` 从 53 提到 79；我按用例数核对为 40（data-export）+24（rules）+4（cli）+2（retrieval）+9（http）=79，数量对得上。第 5 轮的“封存原文不是文字”有反向用例；合并后的 demo pack 由 `demo-data.test.ts` 的 `parsePortable`/导入路径间接覆盖。缺口是新增的规则编号字符、来源记忆编号字符校验没有专门反向用例（见发现第 3 条）。我未运行测试（只能读文件和用 git 命令），以上是代码与用例计数核对结果。
4. **每个产生或修改的值，使用它的地方都能接受吗？** 计数三项 `rules/enforcedRules/ruleHistoryVersions`：`MANIFEST_SCHEMA` 已要求，export/verify/import/demo-pack 都填写，admin CLI 透传，HTTP 用 `enforcedRules` 生成响应头，网页端按整数解析，均接受。`withheld.rules`：schema、类型、export、demo-pack 都填写，admin inspect 透传，接受。`data/rules.jsonl`、`RULES.md`：export 与 demo-pack 都生成，import/verify 按同一 `DATA_FILES`/`RULES_INDEX_FILE` 读取；空文件走 `parseLines` 的 `text === ""` 分支，空规则时 `checkRulesMarkdown` 也通过，均接受。`x-himawari-export-rules` 生产端与网页端取值口径一致。唯一有两端不一致的是规则编号/来源记忆编号：导入端新增了严格校验，导出端和数据库约束没有同步（发现第 1 条）。`withheld.texts` 与 `withheld.rules` 的关系也核对过：规则参数被扣留时同时进 `withheldKeys` 和 `withheldRules`，前者已计入 `withheld.texts`，因此 `totalWithheld` 不另加 `withheld.rules` 不会漏拦，也不会重复计数。
