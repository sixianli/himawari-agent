## 结论

第 2 轮列出的 5 项修改与代码基本一致：夹具已换成新字段；邮件详情确实做了 `floorHits ∪ ruleHits（parseRuleRef）`；`ruleRef` 确实只截 id、不截修订号；ADR 0215 对 ADR 0195 / 0212 的取代说法与原文对得上；新增测试覆盖了修订号 0、裸 id、ruleHits 并入和长 id。
但第 2 轮之外、同一 PR 里仍有几处不能放过的问题，其中一处会让决策链读取直接违反契约，另有一处是本轮 `ruleRef` 修法引入的隐性截断。

---

## 问题（按严重度）

### 1. 中：重要的发件人设置若含控制字符，决策链快照会违反契约，整条链读不出来

**文件:行**：`apps/agent-service/src/production-decision-chain.ts:140`、`packages/gateway-contracts/src/contracts-v2.ts:1060`、`packages/gateway-contracts/src/validation.ts:96-98`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:286-293`

**问题**：`writeSettings` 对 `importantSenders` 只校验长度和代理字符，不拒绝换行、制表符等控制字符；决策链读取时把规则参数里的发件人原样放进 `wording.values`，只做 `slice(0, 256)`；而契约的 `boundedString` 明确拒绝控制字符。于是主人只要有一个含控制字符的重要发件人，用到 `floor_important_sender` 的那条决策记录，读取时会通过 `gatewayV2MessageSchema.parse` 失败，控制中心整条链显示为读取失败。

**证据**：

- `production-decision-chain.ts:140`：
  ```ts
  values: view.wording.values.map((value) => value.slice(0, 256)),
  ```
  这里没有去掉控制字符。
- `contracts-v2.ts:1060`：
  ```ts
  values: array(boundedString(256)),
  ```
- `validation.ts:96-98`：
  ```ts
  [...input].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })
  ```
- `sqlite-proactive-operations.ts:286-293`：
  ```ts
  input.importantSenders.some(
    (sender) =>
      typeof sender !== "string" ||
      sender.length < 1 ||
      sender.length > 254 ||
      /\p{Surrogate}/u.test(sender),
  )
  ```
  只挡代理字符，不挡 `\n`、`\t`、`\u0001` 等。

**建议**：在写设置的一端就拒绝控制字符，和 `boundedString` 的规则保持一致；或者在拼决策链快照前统一做 `displayRuleId` / `singleLine` 式清洗。补一条集成测试：设置 `importantSenders: ["bank\n.example"]`，写入一条 `floor_important_sender@N` 的决策记录，读链不得抛 `CONTRACT_VALIDATION_ERROR`。
注：这不是第 2 轮新增的 5 项之一，而是同一 PR 前面提交带来的；本轮没有覆盖到。

---

### 2. 低：`ruleRef` 的 240 字符截断仍是有损的，可能碰撞、查不到规则且不保证总长 ≤ 256

**文件:行**：`packages/application/src/rules/rule-ref.ts:6-8`、`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:349-370`、`packages/application/test/rule-version.unit.test.ts:162-163`

**问题**：本轮把“整串截到 256”改成“id 截到 240，再拼 `@revision`”，确实修掉了修订号被截掉的问题；但仍有三个后果：

1. 两个前 240 个 UTF-16 单元相同的不同规则 id，会生成同一个 ref，决策记录里会被去重成一个，读端也分不出。
2. `readRuleVersions` 用截断后的 id 去 `rule_book_rules` / `rule_book_history` 查，长 id 永远查不到原规则，`wording` / `tests` 会显示“查不到”。
3. 函数没有保证总长 ≤ 256；id 占 240 后，修订号达到 16 位（JS 安全整数上限是 16 位）时总长会到 257，超过后端 `text(1, 256)` 和契约的 256 限制。另外 `.slice(0, 240)` 按 UTF-16 单元切，可能把代理对切成孤立代理。

**证据**：

- `rule-ref.ts:7`：
  ```ts
  return `${ruleId.slice(0, 240)}@${revision}`;
  ```
- `sqlite-decision-ledger-operations.ts:366-370`：
  ```ts
  const { ruleId, revision } = parseRuleRef(ref);
  const found = (
    revision === null
      ? current.get(scope.ownerId, scope.agentId, ruleId)
      : past.get(scope.ownerId, scope.agentId, ruleId, revision)
  )
  ```
  这里用的是截断后的 `ruleId`。
- 现有测试只验证往返：
  ```ts
  expect(ruleRef("x".repeat(300), 12)).toBe(`${"x".repeat(240)}@12`);
  expect(parseRuleRef(ruleRef("x".repeat(300), 12)).revision).toBe(12);
  ```
  没有验证“两个长 id 不碰撞”“长 id 仍能查到规则版本”“总长不超过后端上限”。

**建议**：如果规则 id 本来就应短，最好在创建规则时限制长度并拒绝超长，而不是在 ref 里静默截断；如果必须截断，使用稳定摘要（例如 id 哈希）并保留完整 id 的映射，或者把 id 与修订号拆成两个字段。至少补上“共享 240 前缀的两个 id 不相等”和“长 id 仍能查到 rule_book 行”的反向用例，并用码点安全的方式截断。

**推测部分**：当前生产规则 id 都是 `rule-book.ts` 里的固定常量，`ownerRules` 只在测试里传入，所以 240 字符碰撞目前没有现实生产路径；这是防御性/未来风险，不是当前可触发的线上故障。

---

### 3. 低：裸 id 没有对应规则行时仍标 `current: true`，界面会同时说“查不到”和“显示的是现在的版本”

**文件:行**：`packages/application/src/rules/rule-version.ts:176`、`apps/control-center/src/components/decision-chain-drawer.tsx:193`、`apps/control-center/src/components/decision-chain-drawer.tsx:201`、`packages/application/test/rule-version.unit.test.ts:150`

**问题**：`current` 只按“ref 里有没有修订号”判断，不看是否真的读到了当前版本。一个未登记的裸 id（`rule_book_rules` 里没有行，也不是内置规则）会得到 `current: true`、`revision: null`、`wording: null`。界面随后同时显示“这一版的规则内容查不到”和“只记了规则名，显示的是现在的版本”，对不存在的“现在的版本”作出肯定陈述，和 ADR 0215 “未登记的编号显示未登记的规则”的意图不一致。

**证据**：

- `rule-version.ts:176`：
  ```ts
  current: ref.revision === null,
  ```
- `decision-chain-drawer.tsx:193`：
  ```ts
  : message("decision.chain.ruleWordingMissing")}
  ```
- `decision-chain-drawer.tsx:201`：
  ```ts
  {rule.current ? ` · ${message("decision.chain.ruleCurrent")}` : ""}
  ```
- 测试把未知裸 id 固定成 `current: true`：
  ```ts
  expect(unknown).toMatchObject({ kind: "unknown", current: true, origin: null });
  ```
- 第 2 轮新增的 `decision-chain.test.ts` 也断言无行的裸 `quiet_hours` 为 `current: true`、`wording: null`、`tests: { state: "unavailable" }`。

**建议**：把 `current` 改成“真的用了当前版本”，例如 `ref.revision === null && (builtIn || stored !== undefined)`；或者在界面层只在 `wording` 存在时显示“显示的是现在的版本”。如果是刻意保留现在的行为，应在 ADR 里写明“未登记的裸 id 也显示 current 文案”，但目前文档没有这样说。

---

### 4. 低：`floorHitRefs` 的回退会写入不在规则手册里的裸 id，和本轮更新后的写入约定不一致

**文件:行**：`packages/application/src/services/proactive-rules.ts:83-88`、`docs/execution/specs/2026-11-09-decision-record-write-convention.md:39`

**问题**：`floorHitRefs` 在找不到规则时直接把原 id 放进 refs，不带修订号；但更新后的写入约定说 `proactive` 的 `ruleIds` 格式是“规则 id@修订号”，且“规则 id 必须是规则手册里的 id”。第 2 轮测试还把 `floorHitRefs({ m1: ["floor_not_in_book"] }) -> ["floor_not_in_book"]` 固化成正式行为。

**证据**：

- `proactive-rules.ts:87`：
  ```ts
  refs.add(rule ? ruleRef(rule.id, rule.revision) : id);
  ```
- 写入约定：
  ```
  | `ruleIds` | `proactive` 写真正起了作用的规则，格式是“规则 id@修订号”…… | 规则 id 必须是规则手册里的 id |
  ```

**建议**：要么删掉这个回退、拒绝写不在规则手册里的 id；要么在约定里明确写出“找不到规则时保留裸 id，用于显示未登记的规则”，并补一条读端测试证明这种裸 id 的显示不会误导。
**现状判断**：正常邮件检查里 `floorHits` 和 `finish` 用的是同一份 `rules`，这个回退目前只有测试能触发，所以严重度低。

---

## 侧重检查

我按“错误路径、不合规范/不可信输入、安全、资源耗尽、不可撤销操作、规则文件/文档和代码一致性”查了这些路径：

- **不合规范/不可信输入**
  - `production-observation.ts:323-335` 的 `mailValues` 对 `undefined`、`__proto__`、非数组做了防护；`Object.hasOwn` 的使用是对的，没有原型键泄漏。
  - `parseRuleRef` 对 `@3`、`x@01`、`a@b@x` 的边界行为已有单测，本轮没有被破坏。
  - 重要发件人含控制字符的路径：确认存在，见问题 1。
  - 长 id / 长修订号路径：确认 `ruleRef` 没有总长校验，见问题 2。
- **安全 / 隐私**
  - 决策链的规则来源记忆正文走 `texts()`；`production-memory-control.ts:561-563` 对受限记忆返回 `{ text: null, hidden: true }`，`production-decision-chain.ts` 不会把受限正文带出来，这一点没发现问题。
  - 规则 id 是标识符，不是正文；邮件详情只新增规则 id，没有新增正文暴露。
  - UI 用 React 文本渲染规则 id、来源和原话，未发现新的 HTML 注入路径；控制字符主要是契约失败问题，不是 XSS。
- **资源耗尽**
  - 邮件详情合并 `ruleHits` 的数量有 `ids(rules, 16)` 上限和每封邮件字段上限，排序去重后规模很小，未见新的资源耗尽风险。
  - `readRuleVersions` 每个 ref 做一次/两次 SQL 查询，proactive 记录最多 500 个 id；这是整个 PR 早先引入的 N+1 读法，不是本轮新增，但值得后续关注；未发现本轮把它放大。
- **不可撤销操作**
  - 本轮改动是读取、展示、写决策记录输入和测试夹具，没有删除、覆盖历史或不可逆操作。`automatic-memory-service` 的 `ruleIds` 清空也是写新的记录，不改旧记录。
- **规则文件、说明文档和代码一致性**
  - ADR 0215 对 ADR 0195 决定 4、ADR 0212 决定 4 的取代描述与两份原文一致。
  - `rule_book_rules.source` 不用于主人展示、代码使用 `RuleRecord.source`，与 ADR 0215 新写法一致。
  - 不一致点：写入约定说 `proactive` 的 `ruleIds` 都是 `id@修订号` 且必须是规则手册 id，但 `floorHitRefs` 有裸 id 回退，见问题 4。
  - `docs/execution/specs` 的其余描述与 `proactive-mail-check-service.ts` 的写入路径一致。

---

## 读代码证实的 / 推测的

**读代码证实：**

- 第 2 轮 `production-observation.ts:329-335` 确实把 `floorHits` 与 `ruleHits` 经 `parseRuleRef` 合并，并在 `:391` 用作邮件详情 `ruleIds`。
- `rule-ref.ts:7` 确实只截 id 到 240，不再截修订号。
- `gateway-v2.fixture.ts:426-440` 已包含 `revision/current/kind/.../tests` 新字段，且各值能通过 `contracts-v2.ts:1034-1078` 的枚举、长度、整数校验。
- 新增测试确实覆盖了：邮件详情 `ruleHits` 并入、修订号 0 的默认值、无行的裸 id、长 id 的修订号往返。
- `DECISION_RULE_CATALOG` / `decisionRuleDefinition` 在代码里已删除，只有历史 ADR 还提到。
- 控制字符导致 `wording.values` 契约失败是有完整代码路径的，见问题 1。
- `current` 的判断确实只看 `ref.revision === null`，见问题 3。

**推测 / 未核实：**

- **第 1 轮 judgments 的具体内容未核实**：仓库是稀疏检出，`.agents/reviews/pr-376/round-1/judgments.md` 在本地不可读（`read`/`glob` 找不到），`git show` 读取该路径被策略拒绝。因此无法逐条引用第 1 轮“低/可以更好”的原文，只能从作者列出的修改反推。
- 未运行任何测试，所以“反向用例会失败”是按代码路径推断的，不是实际执行结果。
- 问题 2 的 240 字符碰撞目前没有现实生产路径：规则 id 都是固定常量，`ownerRules` 只在测试中使用。
- 问题 1 的控制字符是否能从现有 UI 表单输入，未核实；但后端 API 的校验确实接受，按“不可信输入”应当处理。

---

## 逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本轮的代码改动集中在：

- `apps/agent-service/src/production-observation.ts`：决策记录读取和邮件详情展示；
- `packages/application/src/rules/rule-ref.ts`：规则 id 序列化；
- `packages/gateway-contracts/test/gateway-v2.fixture.ts`：契约测试夹具；
- 测试和 ADR。

没有改动系统提示、工具定义、历史消息的组装或出口遮盖。新增的 `RuleRecord.examples` 只用于规则测试状态和抽屉展示（`rule-version.ts` 的 `runRuleExamples`），没有进入任何发给模型的内容。决策记录里的 `ruleIds` 是保存到 SQLite 的元数据，不是模型请求的一部分。

因此：发给模型的内容仍然只在末尾追加；本轮没有把每轮变化的值放进请求头或最后一条消息之外的地方。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会有新的跨请求字节差异。** 本轮新增值的序列化都是确定的：

- `ruleRef` 是纯函数；
- 邮件详情 `tidy` 使用 `Set` 去重后 `.sort()`；
- 决策链 `sortedUnique(inputs.ruleIds)` 排序；
- `importantSenderExamples` / `quietHoursExamples` 由同一组存储参数确定性生成；
- `changedAt` 来自已存的 ISO 时间，不是读取时取当前时间。

需要注意的不是“同一文本不同字节”，而是问题 2 的“不同 id 被截成同一个字节串”。这属于标识碰撞，不是缓存前缀问题。

### 3. 有没有对应的自动检查，反向用例真的会失败？

**大部分有，且按代码看反向用例会失败；但邮件详情这一项不在 `check:rule-registry` 里。**

- 契约夹具：`packages/gateway-contracts/test/gateway-v2.contract.test.ts` 会解析 `compatibilityMessages`（包含 `governanceMessages`），夹具缺少本轮新字段或字段值超出枚举/长度时会失败。反向成立。
- 邮件详情 `ruleHits` 并入：`test/integration/decision-email.test.ts:296` 期望 `["floor.money", "rule with control", "suppress_small_amount"]`。如果退回只读 `floorHits`，实际缺少 `suppress_small_amount`；如果直接把 `suppress_small_amount@3` 放进去而不解析，实际会带 `@3`，都会失败。反向成立。
- 决策链修订号 0 / 裸 id：`test/integration/decision-chain.test.ts` 新用例断言了默认静默时段、空重要名单、无行裸 id 的 `unavailable`。如果 `defaultRuleParameters` 或 `describeRuleVersion` 退回，断言会失败。反向成立。
- 长 id：`rule-version.unit.test.ts:162-163` 断言 `240 个 x + @12` 且 `revision === 12`。旧的 `${id}@${rev}`.slice(0,256) 会得到 256 个 x、没有 `@12`，这两条都会失败。反向成立。
- **检查入口缺口**：`package.json` 的 `check:rule-registry` 新增了 `rule-version.unit.test.ts` 和 `decision-chain.test.ts`，但没有包含 `decision-email.test.ts`。邮件详情这条行为目前只能依赖全量集成测试，不在这个定向门槛里。建议把 `test/integration/decision-email.test.ts` 也加进 `check:rule-registry`（或对应的定向检查）。
- ADR 文档修改没有自动检查，只有人工核对；这不一定是问题，但“第 4 项修改”本身没有反向测试。

### 4. 每个新值/修改值的产生方和使用方都能接受吗？

逐项核对如下：

- **夹具新字段**
  产生：`packages/gateway-contracts/test/gateway-v2.fixture.ts:426-440`。
  使用：`gatewayV2.contract.test.ts` → `decisionChainSnapshotSchema`。
  结论：`revision/current/kind/origin/source/status/changedAt/memory/wording/tests` 的类型、枚举、长度、整数范围都接受；`tests.failedAt: 2` 满足 `integer(1)`，`wording.quietHours` 的时间串是 5 个字符，`amount.minor` 是非负整数。**两端接受。**

- **邮件详情 `ruleIds`（`floorHits ∪ ruleHits` 的基础 id）**
  产生：`production-observation.ts:329-335`，并经 `displayRuleId` 去掉控制字符。
  使用：`decision.email.snapshot` 契约（`ruleIds: nullable(array(boundedString(256)))`）、`mail-decision-page.tsx:105` 的集合、`:149` 的“命中规则 N 条”、`decision-chain-drawer.tsx:264` 的“这封邮件用到”标记。
  结论：基础 id 最长来自 `floorHits` 的 256 或 `parseRuleRef` 后的 240，契约接受；`mail-decision-page` 只是计数和做集合匹配，接受。**未发现漏掉的使用方。**
  语义变化：计数现在会把“小额不推送”也算作“命中规则”，这与 ADR 0215 新增的邮件详情说法一致；周报本身不直接消费邮件详情的 `ruleIds`，没有发现周报/导出端的遗漏。

- **`ruleRef` 的 `id@修订号`**
  产生：`suppressPushHits`、`quietHitRefs`、`floorHitRefs`。
  使用：`sqlite-proactive-operations.ts:656-660` 的 `ids` 校验（1..256）、`sqlite-decision-ledger-operations.ts:42-48` 的 `idList`（1..256）、`parseRuleRef` 的读端。
  结论：正常短 id 全部接受。**长 id 有碰撞/查不到/总长上限问题，见问题 2。**

- **`revision/current/kind/...` 等决策链字段**
  产生：`describeRuleVersion` + `readDecisionChain`。
  使用：`decisionChainSnapshotSchema` 和抽屉 UI。
  结论：枚举、长度基本对得上；**`wording.values` 的控制字符路径不接受，见问题 1；`current` 语义对无行裸 id 会产生误导文案，见问题 3。**

- **ADR 0215 的出处措辞**
  产生：文档修改。
  使用：人工阅读、后续规则文档。
  结论：ADR 0195 决定 4 和 ADR 0212 决定 4 的原文确实分别是“规则出处登记在 `DECISION_RULE_CATALOG`”和“原有的 `floorHits`、`ruleIds` 不变”，ADR 0215 的取代描述**准确**。ADR 0195 中 `decision-rule-catalog.unit.test.ts` 列在“后果/门槛”而不是决定 4 本身，文字上稍有歧义，但实质成立。

---

## 对作者说法的逐条核对

1. **“夹具规则项换成新字段”**：正确。`gateway-v2.fixture.ts:426-440` 已包含新字段，契约测试会解析这份夹具。
2. **“邮件详情 ruleIds = floorHits ∪ ruleHits 解析出的规则 id”**：正确。`production-observation.ts:329-335` 就是 `mailValues(inputs.floorHits)` 加上 `mailValues(inputs.ruleHits).map(ref => parseRuleRef(ref).ruleId)`，再 `displayRuleId`、去空、去重、排序。
3. **“ruleRef 只截规则 id 到 240，不截修订号”**：字面正确，`rule-ref.ts:7` 确实如此；但“只截 id”仍是有损的，见问题 2。
4. **“ADR 0215 改正出处，写明取代 ADR 0195 决定 4、ADR 0212 决定 4 关于 ruleIds 的说法”**：正确，与 ADR 原文一致。
5. **“新测试：decision-chain（修订号 0、无行裸 id）、decision-email（ruleHits 并入）、rule-version（floorHitRefs 回退、长 id）”**：代码中确实存在。补充：邮件详情的行为测试没有纳入 `check:rule-registry` 定向门槛；`floorHitRefs` 的裸 id 回退与写入约定存在文字不一致。

**未核实**：第 1 轮 `judgments.md` 的具体“低/可以更好”理由，以及测试的实际运行结果。
