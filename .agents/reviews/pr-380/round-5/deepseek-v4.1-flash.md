## 一、侧重检查（错误路径、不可信输入、安全、资源、不可逆操作、文档一致性）

我按这个侧重点查了以下地方，结论如下：

- **出处记忆删除/归档的错误路径**：`#reviveMemory` 对 `archived`/`trashed` 调 `recover`，对 `deletion_pending`/`deleted_verified`/记录不存在一律报 `RULE_UNAVAILABLE`（`production-owner-rules.ts:694-702`）；`#archiveMemory` 把 `INVALID_OPERATION`/`NOT_FOUND` 当“已不可归档”吞掉（`:704-718`）。对由本代码创建的规则（`sourceMemoryId` 一定非空），`#activate` 和 `reconfirm` 都会先恢复再动作，删除后确实报错、不重建；但 `#writeMemory` 自己遇到“没有记录”时会新建记忆（`:417-420`），所以“不重建”完全依赖调用方先做 `prior` 恢复；`sourceMemoryId` 为 NULL 的历史/手工行会绕过这个保护（见发现 8）。
- **不可信输入**：`rule_set` 工具参数有 schema，落地又经 `parseMailMatch`/`parseOwnerRuleParameters` 校验（长度、代理项、`Cc/Cf`、域名/地址/英文整词、排除词、总大小），提案 JSON 在 `confirm` 里重新走 `#draft`/`parseOwnerRuleParameters`；决策链对 `ruleHits`/`floorHits` 用 `Object.hasOwn` 防原型键（`production-observation.ts:323-324`）。没发现外部输入可直接越权写规则；但 `confirm` 的 `JSON.parse(text) as Proposal` 没有 try/catch（`:645`），载荷损坏时会抛原始异常，不是 `RULE_NOT_FOUND`（低）。
- **安全**：规则工具走 `#ownerScoped`，结果按 `runId+toolCallId` 幂等缓存，只对已暴露工具放行（`production-runtime-tools.ts:673-740`、`:779-785`）；错误详情只截 200 字回给模型。控制中心规则文本由 React 转义。没发现提权或跨 owner 读取。另有一个“守卫看起来失效”的点：`#writeText` 先落库再拒绝 `restricted`，而 `classificationWithIdentifiers` 只会返回 `private`/`sensitive`（`sensitive-capture/src/identifiers.ts:20-27`），因此 `RULE_TEXT_REFUSED` 对新写入基本不可达——含口令/验证码的原文会以 `sensitive` 保存（见“推测”）。
- **资源耗尽**：32 条活跃规则、每列 32×64 字、参数 16 KB、回放 4×`mailsPerOutcome`、扫最近 200 条消息，都有硬上限。但 `create` 在判断 `explicit` 之前就做历史回放（`production-owner-rules.ts:598-609`），即使最终只是提议/不是常设要求也会跑最多约 1200 封邮件的回放；模型可以用多个不同 `toolCallId` 连续触发。没有时间上限，只有每次检查的配置上限。属低风险成本问题。
- **不可逆操作**：`undo` 先归档记忆再停用规则（`:720-748`），规则行和历史保留；撤销后可用同一提案卡再确认。并发下 `reconfirm` 可能在 `undo` 之后把记忆重新恢复，见发现 1。
- **规则文件/文档/代码一致性**：ADR 0213 关于“只记在 ruleHits（带版本号）”“重建失败安全”“推迟语/整词”大体和代码一致；不一致处是“恢复记忆后改状态失败就重新归档”只做在 `#activate` 的 retired 分支，`reconfirm` 没做（发现 1），以及“观测里版本号正确”实际观测丢掉了版本（发现 6）。实测门槛的确写进了结果文件和 ADR（`evals/owner-rule/result.json:4`、ADR 第 100 行）。

---

## 二、按严重度的发现

### 1. 中：`reconfirm` 恢复出处记忆后状态变更失败，没有重新归档，和 ADR/第 4 轮说法不一致

- 文件：`apps/agent-service/src/production-owner-rules.ts:664-682`
- 问题：`reconfirm` 先 `#reviveMemory`，再 `setStatus`；`setStatus` 返回 `undefined` 时直接抛 `RULE_UNAVAILABLE`，没有把刚刚恢复的记忆重新归档。并发场景（例如另一个请求先 `undo` 归档并退用）下，可能留下“规则已 retired，但出处记忆是 active”，模型仍可能在记忆里看到这条规矩，正好违反 ADR 0213 想避免的“规则已停用而模型仍看得到这条规矩”。
- 证据：
  ```ts
  670:    if (current.sourceMemoryId) await this.#reviveMemory(current.sourceMemoryId as MemoryId);
  671:    const changed =
  672:      current.status === "needs_review"
  673:        ? await this.#options.rules.setStatus({ ... })
  ...
  682:    if (!changed) throw new OwnerRuleError("RULE_UNAVAILABLE");
  ```
- 建议：记录本次是否真的从 `archived/trashed` 恢复过；若恢复过且最终状态不是 `active`，在执行失败分支重新归档，再抛错。注意不要对本来就 active 的记忆无条件归档（并发时可能误伤）。

### 2. 中：`ruleHits` 每封邮件最多 16 条，而允许 32 条生效规则，主人规则会被静默截断

- 文件：`packages/application/src/services/proactive-rules.ts:37-46`；`apps/agent-service/src/production-owner-rules.ts:52`
- 问题：`outcomeHits` 先按 ref 排序再 `.slice(0, 16)`。主人规则 id 是哈希，截断等于随机丢弃；而 `ACTIVE_RULE_LIMIT` 是 32。若一封邮件同时命中超过 16 条 `require_notify`/`require_whole_thread`，被丢掉的那条仍在执行（`forced` 用的是完整 `notifyRules`/`threadRules`），但 `ruleHits` 和由它拼出的 `ruleIds` 都不会记录，决策记录/依据抽屉无法解释这封邮件为什么被强制交给主人。这正是这次合并强调的“命中只记在 ruleHits（带版本号）”的可追溯性缺口。
- 证据：
  ```ts
  44:    .map(({ id, revision }) => ruleRef(id, revision));
  45:    return [...new Set(hits)].sort().slice(0, 16);
  ```
  ```ts
  52: const ACTIVE_RULE_LIMIT = 32;
  ```
- 建议：截断上限至少不小于生效规则上限，或把主人规则优先保留；如果确实要限长，记录一个“已截断”标志，避免静默丢审计信息。

### 3. 中低：同一 rule id 的确认路径只处理 `retired`，不处理 `needs_review`，回执会说“已立为长期规则”但规则仍待重审

- 文件：`apps/agent-service/src/production-owner-rules.ts:507-547`
- 问题：同一 `ruleId` 的规则在 `needs_review` 时，`#activate` 会恢复出处记忆、`create` 返回 `replayed`，但只有 `stored.status === "retired"` 才把状态改回 `active`；`needs_review` 会直接落到返回值，回执 `status: "active"`，实际库里仍是 `needs_review`（虽然仍执行）。这会让回执卡和记忆页的“待重新确认”互相矛盾。
- 证据：
  ```ts
  534:    if (stored?.status === "retired") {
  535:      const revived = await this.#options.rules.setStatus({ ... status: "active" ... });
  ...
  543:      if (!revived) { await this.#archiveMemory(memoryId); throw ... }
  548:    return Object.freeze({ status: "active", ... });
  ```
- 建议：把条件改成 `stored && stored.status !== "active"` 统一处理 `retired`/`needs_review`，或回执返回真实状态。并为“同一提案在出处记忆被归档后再次 confirm”补反向用例。

### 4. 低：英文整词边界没有排除数字和下划线，`must2fa`、`never_x` 会被当成 `must`、`never`

- 文件：`apps/agent-service/src/production-owner-rules.ts:279-284`
- 问题：英文 marker 用 `(?<![a-z'])...(?![a-z'])`，边界只排字母和撇号，不排数字/下划线；而规则参数里的 `content_words` 用的是 `[a-z0-9_]+`。这会造成“未明说也自动生效”的假阳性。
- 证据：
  ```ts
  283:    return new RegExp(`(?<![a-z'])${words}(?![a-z'])`, "u").test(clause);
  ```
- 建议：边界改为 `(?<![a-z0-9_'])` / `(?![a-z0-9_'])`，并补 `must2fa`、`never_x` 的反向断言。

### 5. 低：中文推迟语按子串匹配，会误伤“再说明”“回头客”等，导致该直接生效的规则退化成提议

- 文件：`apps/agent-service/src/production-owner-rules.ts:279-281`、`:103-112`
- 问题：非 ASCII marker 走“去空白后 includes”，所以 `再说` 会命中“再说明”、`回头` 会命中“回头客”、`再看` 会命中“再看完”。方向上是安全的（只生成提议，不会擅自生效），但与 ADR 说的“推迟语”语义不完全一致，也会让合法常设要求多一次确认。
- 证据：
  ```ts
  280:    if (!/^[a-z' ]+$/u.test(marker))
  281:      return clause.replace(/\s+/gu, "").includes(marker.replace(/\s+/gu, ""));
  ```
- 建议：对中文推迟语也做词/短语边界（或至少排除“再说明/回头看”这类常见合成词），并在测试里加这两个例子。

### 6. 低：观测里主人规则只剩 rule id，版本号被丢掉，“观测里版本号正确”不成立

- 文件：`apps/agent-service/src/production-observation.ts:329-335`
- 问题：`rulesForMail` 对 `ruleHits` 调 `parseRuleRef(ref).ruleId`，明确去掉了 `@revision`，再用 `displayRuleId` 输出。决策记录 `ruleHits` 和决策链有版本，但邮件观测 `decision.email.snapshot.mail.ruleIds` 没有版本，无法知道当时是哪一版规则参与判断。
- 证据：
  ```ts
  331:      ? tidy([
  332:            ...mailValues(inputs.floorHits),
  333:            ...mailValues(inputs.ruleHits).map((ref) => parseRuleRef(ref).ruleId),
  334:          ])
  ```
- 建议：若契约允许，观测也返回带版本号的 ref；否则在文档里明确“观测只显示规则 id，不显示版本”，不要把“版本号正确”当成已经满足。

### 7. 低：达到规则上限前就先恢复出处记忆，会留下已恢复但规则仍 retired 的副作用

- 文件：`apps/agent-service/src/production-owner-rules.ts:507-510`
- 问题：`prior` 的恢复发生在 `ACTIVE_RULE_LIMIT` 检查之前。已有 32 条生效规则时，重新确认一条 retired 规则会先把它被归档的出处记忆恢复，然后抛 `RULE_LIMIT_REACHED`，留下“规则 retired、记忆 active”的状态。
- 证据：
  ```ts
  507:    const prior = await this.#options.rules.read({ ...this.#scope(), ruleId });
  508:    if (prior?.sourceMemoryId) await this.#reviveMemory(prior.sourceMemoryId as MemoryId);
  509:    if (!existing.some((row) => row.ruleId === ruleId) && existing.length >= ACTIVE_RULE_LIMIT)
  510:      throw new OwnerRuleError("RULE_LIMIT_REACHED", String(ACTIVE_RULE_LIMIT));
  ```
- 建议：先做上限检查，再做恢复；或恢复后失败时把记忆归档回去。

### 8. 低：`#writeMemory` 自身在“记录不存在”时会重建记忆，“删除后不重建”只靠调用方的 prior 恢复

- 文件：`apps/agent-service/src/production-owner-rules.ts:417-422`；相关保护在 `:507-508`
- 问题：`#writeMemory` 只在“记录存在”时走恢复分支；记录不存在会继续 `#writeText` + `applyProposal(create)`，真正重建记忆。由本代码创建的规则一定先经过 `#activate` 的 `prior?.sourceMemoryId` 恢复，所以当前路径安全；但 `sourceMemoryId` 为 NULL 的旧行/手工行，或未来新调用方绕过 `prior`，就会把删掉的出处记忆重新建出来，和 ADR 0213 的措辞不一致。
- 证据：
  ```ts
  417:    if (await this.#options.memories.read(memoryId)) {
  418:      await this.#reviveMemory(memoryId);
  419:      return memoryId;
  420:    }
  421:    const classification = await this.#writeText(contentRef, input.text);
  422:    await this.#options.memory.applyProposal({ decision: "create", ... });
  ```
- 建议：把“是否允许新建记忆”显式作为参数传入 `#writeMemory`，或在规则恢复路径里断言 `sourceMemoryId` 非空；对 NULL 的历史行给出明确错误。

### 9. 低/设计提示：`RULE_TEXT_REFUSED` 对新写入基本是死路，含口令的规则原文会以 sensitive 保存

- 文件：`apps/agent-service/src/production-owner-rules.ts:386-403`；`packages/sensitive-capture/src/identifiers.ts:20-27`
- 问题：`#writeText` 用 `classificationWithIdentifiers(text, "private")` 定级，这个函数最多返回 `sensitive`，不会返回 `restricted`；随后却又用 `payload.dataClassification === "restricted"` 拒绝。结果规则原文里如果有银行卡号、密码、验证码，仍会以 `sensitive` 落库并创建规则。是否属于预期需要产品确认。
- 证据：
  ```ts
  394:        dataClassification: classificationWithIdentifiers(text, "private"),
  ...
  400:    if (!payload || payload.dataClassification === "restricted")
  401:      throw new OwnerRuleError("RULE_TEXT_REFUSED");
  ```
- 建议：明确策略——要么把含凭据的规则文本升级为 `restricted` 并真正拒绝，要么删掉这条不可达的 `RULE_TEXT_REFUSED` 分支并在文档里说明敏感文本会以 sensitive 保存。

---

## 三、读代码证实的 / 推测的

**读代码证实：**

- 主人规则只进 `ruleHits`，不进 `floorHits`：`floorHitIds` 只取 `raise_floor`（`proactive-rules.ts:28-35`），两种主人规则的结果是 `require_notify`/`require_whole_thread`（`rule-types.ts:202-213`）；集成测试也断言 `floorHits` 不含 `owner:immigration`（`proactive-mail-check.test.ts:2776-2783`）。
- `ruleHits` 带版本号：`outcomeHits` 用 `ruleRef(id, revision)`（`proactive-rules.ts:44`），`#finish` 合并 `ruleHits` 后再去重排序（`proactive-mail-check-service.ts:1643-1652`）。
- 主人规则在决策链里按存的类型显示：`ownerRuleKind` 从 `stored.parameters["type"]` 取 `mail_must_notify`/`mail_read_whole_thread`，`describeRuleVersion` 用它重建规则（`rule-version.ts:188-203`、`:122-142`）。
- 重建失败是安全的：`ownerRuleRecord` 校验失败被 `catch` 成 `undefined`，视图显示 `unavailable`/`unknown`，不会抛到决策链接口（`rule-version.ts:125-142`）。
- 契约和三种语言已补两个 kind，规则列表/撤销/重新确认命令的契约和 fixture 都在（`contracts-v2.ts:1043-1052`、`:1341-1372`；`gateway-v2.fixture.ts`）。
- 反向用例真实存在且会因旧行为失败：`isStandingQuote("nevertheless send it")` 为 false、`"please pass the mustard"` 为 false（旧子串匹配会返回 true）；`"这封先不用管，以后再说"` 为 false；`"今天起每次都提醒我"` 为 true（`production-memory-capture.test.ts:1978-1986`）。
- 同参数已有规则按重新确认处理、出处记忆删除报错：`production-memory-capture.test.ts:1988-2009`、`:2039-2057`。
- 观测里同一规则只出现一次：`rulesForMail` 合并后 `new Set` 再排序（`production-observation.ts:325-335`），`decision-email.test.ts:286-299` 断言了去重后的顺序。

**推测：**

- `reconfirm` 的并发失败场景（undo 先归档/退用，reconfirm 后恢复）会留下“规则 retired + 记忆 active”，需要并发时序；正常单用户串行操作下不容易触发。
- 发现 7（先恢复再报上限）和发现 8（`sourceMemoryId` 为 NULL 时重建）需要特定的库状态或未来调用方；当前生产数据里主人规则都是本代码新写的，触发概率低。
- 发现 9 是否有实际安全影响取决于产品对“规则文本里含口令”的接受度；代码层面可以确认 `RULE_TEXT_REFUSED` 对新写入不可达。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？是不是仍然只在末尾追加？每轮会变的值是不是都在最后一条消息里？

**会改变一次。** 这个 PR 给每次运行多暴露了三个工具 `rule_set`/`rule_list`/`rule_undo`（`production-runtime-tools.ts:563`）。工具定义在请求最前面，按 `.claude/rules/prompt-prefix.md` 第 6 条，老对话在下一轮开始时会因“工具集合变了”换新一次，系统提示和历史整段按全价重算一次；ADR 0213 也明确写了这个后果（ADR 第 94 行）。换新之后，同一对话内工具定义和系统提示仍然冻结，后续只在末尾追加。新增的规则说明文字只进工具定义/新对话的冻结内容，不会每轮变化。

**每轮会变的值**：这次没有把时间、规则列表、规则命中数等放进系统提示或工具定义。规则的执行结果、回放结果、新建的规则记忆都是追加到历史/最后一条消息里；决策链和观测是控制中心查询，不进模型请求。因此“每轮变化的值都在末尾/最后一条消息”在这一改动后仍成立（除了老对话因工具集合变化的一次性换新）。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**没有发现新的非确定性来源。** 具体核对过：

- `ruleHits` 的值先 `new Set` 再 `.sort()` 再截断（`proactive-rules.ts:44-45`），`ruleIds` 最后 `new Set([...]).sort()`（`proactive-mail-check-service.ts:1643-1649`）；决策链用 `sortedUnique`（`production-decision-chain.ts:65-67`、`:105-112`）；观测用 `tidy` 的 `new Set(...).sort()`（`production-observation.ts:325-326`）。
- 决策链的 `ruleMailCounts` 只是计数，键来自 ref 解析，输出按 `ruleViews` 的排序结果，不依赖对象遍历顺序。
- 新增的 `updatedAt`（`memory.rules.snapshot`）、`generatedAt`、回放里的天数/命中数只出现在控制中心快照或那一次 `rule_set` 的追加工具结果里，不会写回已有请求的开头。
- 规则记忆文本是 `${quote}\n${summary}`，写入后固定；没有时间、随机数、无序集合进入系统提示或工具定义。
- 遮盖：规则记忆是新的末尾内容，已发历史的遮盖不会因为它而改变；没有新增依赖后文的分段遮盖逻辑。

一个已存在但不算这次引入字节问题的点：`floorHits` 原始数组没有排序，但它是决策记录里的内部字段，决策链/观测显示前都会排序，且不进模型请求。

### 3. 有没有对应的自动检查？反向用例是否真的会失败？

**有，覆盖了大部分关键行为；有三处缺口。**

会失败的反向用例（读代码确认断言方向与旧实现相反）：

- `isStandingQuote`：`nevertheless send it`、`please pass the mustard`、`这封先不用管，以后再说`、`今天先这样，以后再看` 都为 false；`今天起每次都提醒我`、`From now on, always...` 为 true（`test/integration/production-memory-capture.test.ts:1978-1986`）。旧的子串匹配会让前两个英文用例变成 true，因此这些用例能抓住回退。
- 同参数重新确认：`production-memory-capture.test.ts:1988-2009`；删除出处记忆后报错且不重建：`:2039-2057`。
- 主人规则只进 ruleHits、退用后下一次检查不再命中、整串读全后保留模型判断：`test/integration/proactive-mail-check.test.ts:2776-2783`、`:2809-2838`、`:2870-2887`。
- 规则类型注册表反向：缺测试文件/无标签/跳过/不在检查命令里/未测类型都报错（`test/tooling/rule-type-tests.test.ts:79-94`）；两种规则类型的参数拒绝用例也在各自 `rule-type-*.unit.test.ts`。
- 决策链/邮件观测的规则版本、默认值、未知规则：`test/integration/decision-chain.test.ts:680-752`、`:754-...`，`decision-email.test.ts:286-299`、`:361-368`。

**缺口：**

- 没有用例覆盖“恢复出处记忆后 `setStatus` 失败要重新归档”（发现 1），所以作者这条说法目前没有自动保护。
- 没有用例覆盖“同一 rule id 处于 `needs_review` 时再次 confirm”（发现 3）。
- 没有用例覆盖“同一封邮件命中超过 16 条规则时 `ruleHits` 被截断”（发现 2）。

另外，`scripts/evals/owner-rule-live.eval.ts:226-227` 在默认 `EVAL_MINIMUM_PASS_SHARE=1` 下会因 GLM 14/15 失败；ADR 第 100 行已如实记录，且它不在自动检查里跑，所以不算 CI 红灯，但这条实测不是“通过门槛”的状态。

### 4. 每个产生/修改的值，两端都能接受吗？

我逐个核对了这次改动引入或修改的值和两端的校验：

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| `owner:<24 hex>` | `production-owner-rules.ts:487` | SQLite `OWNER_RULE_ID = /^owner:[A-Za-z0-9_-]{1,58}$/`（`sqlite-owner-rule-operations.ts`）；`reconfirm/undo` 要求前缀且 ≤64（`:665`、`:721`）；契约 `boundedString(256)` | 两端一致 |
| `memory:rule:<32 hex>` | `production-owner-rules.ts:415` | SQLite `MEMORY_ID = /^[\x21-\x7e]{1,128}$/`；`source_memory_id` 长度 1..128；记忆端口 | 一致 |
| `rule-proposal:<32 hex>` | `production-owner-rules.ts:616-624` | `confirm` 正则 `/^rule-proposal:[0-9a-f]{32}$/`（`:641`）；载荷 ref | 一致 |
| `type`：`mail_must_notify` / `mail_read_whole_thread` / `soft` | 工具 schema enum（`:169-172`） | `ruleType`/`parseMailMatch`；决策链 `kind` 枚举；契约两处；三种语言 select | 一致；未知类型安全降级为 `unknown`/`unavailable` |
| `params` 各列 32 项、每项 64 字、词语 ≥2、总参数字符串 ≤16384 | `rule-types.ts:71-116`、`:267-273` | 工具 schema 的 `maxItems`/`maxLength`；SQLite `MAX_PARAMETERS = 16_384` 且 `json_type='object'` | 一致（JS 与 SQLite 都按 JS 字符串长度/对象校验） |
| `status`：`active`/`needs_review`/`retired` | SQLite create/setStatus | `rule_book_rules` CHECK；快照契约只允许 active/needs_review（代码先过滤 retired，`production-memory-control.ts:414-438`）；决策链 nullable 枚举含 retired | 一致 |
| `source` ≤256 | `production-owner-rules.ts:522` `slice(0,256)` | SQLite `length(source) BETWEEN 1 AND 256` | 一致 |
| `summary` ≤200 UTF-16 | `validRuleSummary` / parse | 工具 schema `maxLength: 200`；快照 `Array.from(...).slice(0,200)`（原始已 ≤200 UTF-16，不会超）；决策链 `slice(0,256)` | 一致 |
| `updatedAt` / `changedAt` ISO 时间 | SQLite `now` 经 `valid()`；history 用 `updated_at`/`strftime` | 契约 `timestamp` | 一致（迁移旧行格式未逐一核实） |
| `wholeThreadMailsPerMail` / `wholeThreadCharactersPerMail` 配置键 | 这次合并带入的 main 代码 | `ProactiveRelatedLimits`、`ProductionProactive`、严格配置 | **未核实**（属于合并进来的 P3 改动，本次没有逐处追踪所有配置入口） |
| 观测 `ruleIds` | `production-observation.ts:329-335` | 契约只要求字符串；UI 不显示版本 | 两端能接受，但**丢版本**，与“观测里版本号正确”的说法不符（发现 6） |
| 决策记录 `ruleIds`/`ruleHits` | `proactive-mail-check-service.ts:1642-1652` | 决策链用 `parseRuleRef` + `ruleVersions`；`readRuleVersions` 对带版本 ref 查 history、裸 id 查当前行 | 一致；但 `outcomeHits` 的 16 条截断会让部分规则根本不在两端出现（发现 2） |

结论：除发现 2、6、8 外，这次新增的标识、字段、契约项和文案两端基本对得上；`owner:` id、`memory:rule:` id、`rule-proposal:` id、参数大小限制和状态枚举都能通过各自的写入校验和消费方校验。
