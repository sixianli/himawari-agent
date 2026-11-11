## 发现（按严重度）

### 高 1. 网关契约 fixture 没跟上新 schema，`test:contracts` 会失败
文件：`packages/gateway-contracts/test/gateway-v2.fixture.ts:422-431`

问题：契约里 `decision.chain.snapshot` 的规则项已改成一组新的必填字段，但 fixture 仍是旧形状，带 `document`，缺 `revision/current/kind/source/status/changedAt/memory/wording/tests`。

证据：
- fixture 仍是：
  ```ts
  { ruleId: "floor_important_sender", origin: "owner_setting",
    document: "ADR 0106 第 4 条", mailCount: 1 }
  ```
  （`gateway-v2.fixture.ts:424-430`）
- schema 已要求：
  ```ts
  revision: nullable(integer(0)),
  current: booleanValue,
  kind: enumeration([...]),
  source: nullable(boundedString(256)),
  ...
  tests: object({...}),
  ```
  （`contracts-v2.ts:1036-1075`）
- 校验器对未知字段和缺失必填字段都报错：
  ```ts
  if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
  ...
  if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
  ```
  （`validation.ts:174-180`）

建议：把该 fixture 更新为新字段，删除 `document`，并跑 `npm run test:contracts`。这是一个现有测试夹具，PR 没有改它。

---

### 中 2. “出处”没有从规则手册读，仍来自当前代码里写死的字符串
文件：`packages/application/src/rules/rule-version.ts:179`、`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:354-362`、`packages/application/src/rules/rule-ref.ts:19-25`、`packages/application/src/rules/rule-book.ts:235,311`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:318,324`

问题：抽屉显示的 `source` 是 `rebuilt.rule.source`，也就是当前代码里 `importantSenderRule()` / `quietHoursRule()` 写死的出处；读取端根本没有取 `rule_book_rules.source` 或 `rule_book_history.source` 列。`RuleBookVersion` 类型里也没有 `source`。这跟 ADR 0215 后果里“规则的来源和出处直接从规则手册读”以及任务里“不写死能动态获取的东西”不一致。

证据：
- `readRuleVersions` 的 SELECT 只有：
  ```sql
  SELECT rule_id AS ruleId, revision, parameters, status,
         source_memory_id AS sourceMemoryId, updated_at AS changedAt
  ```
  （`sqlite-decision-ledger-operations.ts:354-356`；history 同样没有 `source`）
- `describeRuleVersion`：
  ```ts
  origin: rebuilt?.rule.origin ?? null,
  source: rebuilt?.rule.source ?? null,
  ```
  （`rule-version.ts:178-179`）
- owner 规则的 source 是构造函数里写死的：
  ```ts
  source: "ADR 0106 第 4 条；主人的设置“重要发件人”",
  ```
  （`rule-book.ts:235`）
- 而写设置时实际写进规则手册的 source 是：
  ```ts
  "owner setting: quiet hours"
  "owner setting: important senders"
  ```
  （`sqlite-proactive-operations.ts:318,324`），这条路径永远不会显示。

建议：给 `RuleBookVersion` 增加 `source`，SELECT 中取 `source`，读取时优先用 `stored.source`；内置规则没有库行时再回退到代码。同步更新集成测试，它现在把写死的 ADR 字符串当成期望值。

---

### 中 3. `thisMail` 不会标出新增的“小额不推送”规则
文件：`apps/agent-service/src/production-observation.ts:390`、`apps/control-center/src/components/mail-decision-page.tsx:103-108`、`apps/control-center/src/components/decision-chain-drawer.tsx:264`、`packages/application/src/services/proactive-mail-check-service.ts:907-909`

问题：邮件详情页传给抽屉的 `thisMail.ruleIds` 仍只来自 `floorHits`；但本 PR 把 `ruleHits` 也并进了决策记录的 `ruleIds`，抽屉里会出现 `suppress_small_amount` 规则，并且 `mailCount` 能统计到 1（`production-decision-chain.ts:100-104`），却不会显示“这封邮件用到”。静默时段不是按邮件命中，可以不加；但 `suppress_small_amount` 是按邮件记在 `ruleHits` 里的，语义上应属于这封邮件。

证据：
- `ruleIds: forMail("floorHits")`（`production-observation.ts:390`）
- `ruleHits[item.messageId] = suppressing`（`proactive-mail-check-service.ts:909`）
- UI 只比较 `thisMail?.ruleIds.has(rule.ruleId)`（`decision-chain-drawer.tsx:264`）

建议：邮件详情快照的 `ruleIds` 同时并入该 messageId 的 `ruleHits`，或抽屉的 `thisMail` 同时匹配 `floorHits` 和 `ruleHits`；静默时段单独处理。

---

### 低 4. 说明文档与代码不一致
文件：`docs/adr/0195-show-the-whole-chain-of-one-decision-record.md:39,58`、`docs/adr/0212-hard-rules-step2-amount-field-and-push-suppression.md:54`

问题：
- ADR 0195 仍说规则出处登记在 `DECISION_RULE_CATALOG`，并列出 `packages/application/test/decision-rule-catalog.unit.test.ts`；这两者在本次改动里都删了。
- ADR 0212 仍写“原有的 `floorHits`、`ruleIds` 不变”；本次 `ruleIds` 已改成 `id@revision` 并加入 `ruleHits` 与静默时段。

建议：更新 ADR 0195/0212 的相关句子，或在 ADR 0215 明确写出取代了这两条说法，避免下一个读文档的人按旧约定实现。

---

### 低 5. `revision === 0` 默认值读取路径没有自动检查
文件：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:388`、`packages/application/test/rule-version.unit.test.ts`

问题：`defaultRuleParameters` 只在 `revision === 0` 且查不到历史时使用，但没有测试覆盖“主人从没保存过设置，静默时段使用默认值，决策记录写 `quiet_hours@0`，再打开抽屉”的完整路径。另外，旧的普通 id（没有 `@修订号`）在规则手册里也没有当前行时，不会回退到默认值，而是显示“查不到”；这对默认真实执行过的静默时段规则可能不准确。

证据：
```ts
const defaults = revision === 0 ? defaultRuleParameters(ruleId) : undefined;
```
（`sqlite-decision-ledger-operations.ts:388`）

建议：补一个集成用例覆盖 `quiet_hours@0` / `floor_important_sender@0`，并决定旧普通 id 在无当前行时是否按 revision 0 默认值解释。

---

## 侧重检查

- **不可信/旧输入**：`parseRuleRef` 对 `a@b@x`、`@3`、`x@01`、非数字修订号都回退成普通 id；未知规则 id 显示为 `unknown`；旧 memory_candidate 记录即使 `ruleIds` 里仍有原因代码，也因 `rulesRecorded` 为 false 而不显示规则节。这些路径有覆盖（`rule-version.unit.test.ts:31-66`、`decision-chain.test.ts:594-618`）。
- **规则参数错误路径**：`stringList`、`quietPeriods`、`amountParameters` 会拒绝错误类型；金额规则构造失败被 `try/catch` 吞掉并显示 `unavailable`。但 `readRuleVersions` 直接 `JSON.parse(found.parameters)`，数据库 CHECK 保证合法性，正常运行不可触发；若库被手工破坏会抛异常导致整条链读取失败。
- **安全/隐私**：规则来源记忆的文字经过 `dependencies.texts`，受限档返回 `text: null, hidden: true`（`production-memory-control.ts:546-568`），没有把受限正文带进抽屉；`sourceMemoryId` 只用于按 owner/agent 范围查询，未发现越权读取。
- **资源耗尽**：外部入口有上限（决策输入最多 500 个 id，设置最多 200 个发件人、8 个静默时段）。但 `readRuleVersions` 对每个 ref 单独查询，最多 500 次；`describeRuleVersion` 每个 ref 都会重建规则并编译表达式、跑例子。正常规模可接受，极端多修订号时会变慢，未压测。
- **不可撤销操作**：没有改表、没有迁移、没有删除业务数据；只是删除了 `DECISION_RULE_CATALOG` 代码和对应单元测试。可逆性没有问题。
- **规则/文档一致性**：发现上面的 source 写死、ADR 0195/0212 过期、网关 fixture 未同步。
- **边界例子**：跨午夜、终点 `00:00`、空名单、域名含子域名、重复项这几种情况，我对照了 `quietPeriodExpression`/`importantSenderExpression` 和 `inQuietPeriod`/`senderListed`：判断条件一致，没有发现会误报“不符”的边界。例子覆盖面较窄：重要发件人只取前三项，静默时段每个时段只用 `days[0]`，但不会因此产生错误结果。

---

## 作者说法核对

1. **基本属实。** `ruleRef()` 确实写 `id@revision`，`floorHits` 保持普通 id；`revision 0` 在读取端走 `defaultRuleParameters`。补充：`ruleRef()` 仍会 `slice(0, 256)`，规则 id 极长时可能截掉修订号，但规则手册 id 最长 64，正常不会触发。
2. **属实。** `readRuleVersions` 对带修订号查 `rule_book_history`，不带修订号查 `rule_book_rules`，`revision 0` 用默认参数（`sqlite-decision-ledger-operations.ts:354-391`）。
3. **属实。** 内置规则找不到对应修订号时 `rebuilt` 为空，`wording` 为 null、`tests` 为 `unavailable`（`rule-version.ts:171-184`）。但“出处”并非从库里的那一版读，见发现 2。
4. **基本属实，但覆盖面有限。** 命中判断确实由 `senderListed` / `inQuietPeriod` 独立于 CEL 计算，再跑 CEL 对照；重要发件人只生成前三项，静默时段只用每个时段的 `days[0]`。
5. **属实。** 触发器写普通规则 id，读取时按当前行显示，`current` 由 `ref.revision === null` 判断。
6. **属实。**

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。这个 diff 没有改 `packages/prompt-catalog`、系统提示、工具定义、历史消息或遮盖相关代码。新增的 `RuleRecord.examples` 只被 `assertRuleExamples` / `runRuleExamples` 使用，`RuleJudge.decide()` 只看 `rule.gate`、`rule.status`、`rule.expression`（`rule-judge.ts:29-37`），不会把例子发给模型。邮件检查里 `ruleBookFor(settings)` 也是在模型判断循环之后才调用（`proactive-mail-check-service.ts:762-826`）。所以仍然是只在末尾追加，每轮会变的值仍在最后一条消息里；`check:prompt-prefix` 不涉及。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

对模型内容不会。决策记录里的 `ruleIds` 在写入口做了去重和排序（`proactive-mail-check-service.ts:1379-1385`），`ruleHits` 本身在 `suppressPushHits` 里排序（`proactive-rules.ts:40-46`），生成例子完全由设置参数决定，不依赖当前时间或数据库返回顺序。

需要区分的是展示层：`tests` 是“打开抽屉时当场算”，所以代码或设置变化后同一旧记录显示不同，这是 Andy 选定的行为；`source` 用的是当前代码字符串而不是那一版存的 source，也会随代码变化。两者都不是模型请求内容。

### 3. 有没有对应的自动检查，反向用例会真的失败吗？

有，但有一个明显缺口。
- 新增 `rule-version.unit.test.ts`，覆盖 `id@revision` 解析、未知规则、内置规则版本不符、owner 规则重建、`expression: "false"` / `"true"` 的反向例子、跨午夜和空静默时段。
- `decision-chain.test.ts` 覆盖历史修订号、当前版本、规则记忆原文、suppress 规则无内容、未登记规则。
- `proactive-mail-check.test.ts` 覆盖静默时段 ref、`suppress_small_amount@3`、地板规则 `@1` 的反向空数组。
- `automatic-memory-golden.test.ts` 覆盖所有 memory_candidate 记录 `ruleIds` 为空。
- 这些反向用例在实现回退时确实会失败，例如 `runRuleExamples({ ...rule, expression: "false" })` 期望 `failedAt: 1`。
- 缺口：网关契约 fixture 没更新，所以 `test:contracts` 本身会失败；`revision 0` 默认值路径没有集成测试；source 从库读取这条没有反向测试（现有测试反而把写死的 ADR 字符串当期望）。
- 我受工具限制没有运行测试，以上失败判断来自 schema 和 fixture 的静态对照。

### 4. 每个新值/新格式的使用端都能接受吗？

逐个核对结果：

- **`ruleIds` 的 `id@revision` 格式**：SQLite `idList` 只校验长度 1–256、唯一，`@` 合法（`sqlite-decision-ledger-operations.ts:42-48`）；proactive 写入校验同样允许（`sqlite-proactive-operations.ts:656-660`）；网关原始 `ruleIds` 是 `boundedString(256)`，也接受（`contracts-v2.ts:1149`）；`parseRuleRef` 能回读。**通过。**
- **`floorHits` 保持普通 id**：邮件详情页和 `thisMail` 继续按普通 id 匹配，格式上通过；但新增的 suppress 规则不会进 `thisMail`（发现 3）。
- **`ruleHits` 并入 `ruleIds`**：`mailCount` 现在会统计 suppress 规则（`production-decision-chain.ts:100-104`）；静默时段因为不在 `ruleHits`，`mailCount` 固定为 0，测试也这样期望（`decision-chain.test.ts:697-703`）。功能上能接受，但“命中 0 封邮件”对一条实际压后了推送的规则可能误导。
- **`revision 0`**：`rule_book_rules.revision` 有 `CHECK (revision >= 1)`，rev 0 只会出现在读取端的默认值路径，不会写非法行。**通过。**
- **`RuleBookVersion` 新字段**：`revision/status/changedAt/sourceMemoryId` 与契约基本对齐；`source` 没有从库里读，见发现 2。
- **`wording` 字段**：`values` 在输出前截断到 256，DB 写入发件人最长 254；静默时段时间写入时校验为 `HH:MM`；金额币种经过 `amountThresholdExpression` 校验。**通过。**
- **`tests.failedAt`**：代码返回 1-based 失败序号，契约为 `nullable(integer(1))`，一致。**通过。**
- **网关契约 fixture**：**不通过**，见发现 1。
- **文档**：ADR 0195/0212 有过期说法，见发现 4。
