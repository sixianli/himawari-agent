## 一、读代码证实的问题

### 1. 严重度：中 — 单号抽取的预算预留小于真实判断提示词，仍可能吃掉判断预算

- 文件：`packages/application/src/services/proactive-mail-check-service.ts:912-930`、`:960-982`、`:997-1009`
- 问题：`referenceReserveMicros` 用“空 related、空记忆、空摘要”的提示词估算一批判断的费用；真正判断时的提示词还包含 `relatedViews`、`promptMemories`、`summaries`，按字符计费的生产估算下必然更大。抽取的预算检查允许把余额花到只剩这个偏小的 reserve，随后判断循环又按真实估算检查，可能直接 `capped_daily`，没有判断。
- 证据：
  - 抽取预留只传空数据：`proactivePrompt(this.#fitBatch(... new Map<string, RelatedView>()), ..., [], perMail, new Map<string, RelatedView>(), [])`（912-930）
  - 判断预留本身会为摘要留整块空间：`judgmentReserveMicros` 里构造了 `text: "。".repeat(...summaryLimits.characters)`（971-980）
  - 实际判断提示词包含 related、记忆和摘要：`proactivePrompt(batch, ..., promptMemories, bodyLimits.perMail, relatedViews, summaries)`（999-1007）
  - 抽取检查条件：`budget.spentToday + budget.costMicros + budget.reserveMicros + estimate > daily`（686-690）
  - 判断检查：`spentToday + costMicros + estimate > daily`（1009）
- 建议：抽取前就按“最坏情况判断提示词”预留，至少覆盖最大 related 块、摘要块和记忆块；可把 `judgmentReserveMicros` 的摘要补位逻辑提前复用，再用反向测试覆盖 `estimatePerCharacter` + `recentSummaries` + 有 related 的场景。现有新增反向测试用固定估算且没有 related/摘要，抓不到这个问题。

### 2. 严重度：中 — 相关邮件读取的“半窗”计时在抽取之前就开始了，抽取实际会占掉它

- 文件：`packages/application/src/services/proactive-mail-check-service.ts:904-910`、`:936-953`；`docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:85`
- 问题：`relatedSignal` 在单号抽取之前就用 `AbortSignal.timeout(perCheckMs / 2)` 创建，随后才执行抽取，再执行 `#related`。因此抽取耗时（最多可到 `perCheckMs / 6`）会从这个半窗里扣掉，相关邮件读取实际只剩约 `1/2 - 抽取耗时`。这与 ADR 0249 写的“抽取……不占相关邮件读取的半窗”以及 ADR 0180 的“从它开始算起”不一致。
- 证据：
  ```
  904: const relatedSignal = AbortSignal.any([...
  906:   AbortSignal.timeout(Math.floor(this.#options.limits.perCheckMs / 2)),
  ...
  936: const references = ... await this.#references(...)
  943: const relatedViews = ... await this.#related(... relatedSignal ...)
  ```
  ADR 0249:85：“它用检查时间窗的六分之一做超时，不占相关邮件读取的半窗。”
- 建议：把 `relatedSignal` 的创建移到 `#references` 之后、`#related` 之前；如果希望仍从检查开始计时，就把 ADR 改成“总时间窗内，两个阶段共享剩余时间”，并加一个小 `perCheckMs`、抽取故意慢的反向测试，验证相关读取仍拿到完整的半窗。

### 3. 严重度：中低 — “不是日期”的校验只覆盖 `YYYY-MM-DD`，紧凑日期会被当成单号搜索

- 文件：`packages/application/src/services/proactive-references.ts:8`；`test/integration/proactive-mail-check.test.ts:2660`；`packages/application/test/proactive-references.unit.test.ts:19`
- 问题：`DATE_SHAPE` 只排除 `2026-11-07` 这种带横线格式。模型若返回邮件里逐字出现的 `20261107`，它满足 `REFERENCE_SHAPE`（8 位、含数字、整词出现），会被接受并拼进 Gmail 查询。ADR 0249:53 写的是“含数字、不是日期”，测试标题也写“a date is never searched”，但反向用例只用了带横线的日期。
- 证据：
  ```ts
  const REFERENCE_SHAPE = /^(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{7,39}$/u;
  const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/u;
  ```
  现有反向用例只包含 `"2026-11-07"`。
- 建议：至少拒绝 `/^\d{8}$/`，并考虑 `YYYY/MM/DD`、`YYYY年MM月DD日` 等日期形态；补充 `20261107`、电话号码式纯数字的失败用例。若这些形态故意交给模型判断，就修改 ADR 和测试标题，明确程序只保证“逐字出现 + 格式”，不再声称“日期绝不搜索”。

### 4. 严重度：低 — 盘点文档第 211 行仍写着“名单和词表有两种存法”

- 文件：`docs/agent-rulebook-inventory.md:211`
- 问题：正文已经只描述重要发件人名单和公共机构后缀，但仍写“名单和词表有两种存法”。涉钱词表已经删除，这句话会让读者以为仍有金钱词表。作者说“第 207、211 行去掉词表说法”，这一说法与代码/文档不符：第 207 行改了，第 211 行没改干净。
- 证据：
  ```
  5. **地板规则的名单和词表有两种存法。** 重要发件人名单存在数据库，主人能改；公共机构后缀现在是规则手册里的内置规则……
  ```
- 建议：改为“地板规则的名单有两种存法”或“重要发件人名单和公共机构后缀有两种存法”。

### 5. 严重度：低 — ADR 0180 仍指向已被删除的 `extractReferenceIds` 和旧标签规则

- 文件：`docs/adr/0180-gmail-check-reads-earlier-mail-about-the-same-matter.md:41`；`packages/platform-node/src/gmail-related.ts:145`
- 问题：ADR 0180 的现行决定仍写“规则见 `gmail-related.ts` 的 `extractReferenceIds`，只认 order、booking……等明确标签，标签后面跟至少 8 位……”。但该函数已删除，当前代码从 `input.references` 读取模型抽取并经程序逐字校验的单号。ADR 0249 的前置说明也承认这是对 ADR 0180 的修改，但 0180 本身没有更新或加注。
- 证据：
  - ADR 0180:41 仍写：`规则见 packages/platform-node/src/gmail-related.ts 的 extractReferenceIds`
  - 当前 `gmail-related.ts:145`：`const references = input.references?.get(item.messageId) ?? [];`
- 建议：在 ADR 0180 第 41 条加“本段已被 ADR 0249 修改”的注记，或直接改成当前行为，避免后来人按不存在的函数和标签规则理解代码。

## 二、推测 / 未核实

- **`TRUSTED_PROMPT_TEXTS` 的间接影响。** 新增和修改的固定提示词会进入全局可信提示词清单，而该清单是出口遮盖的输入。我没有找到任何对话路径使用这些后台提示词，也没有证据表明旧对话包含被改文字；因此我判断不会改变对话请求开头，但这是唯一需要确认的间接路径，未核实旧数据。
- **夹具里的 `current: true` 与生产语义可能不一致。** `packages/application/src/rules/rule-version.ts:205` 的 `current` 只在 `ref.revision === null` 时为真；测试夹具 `apps/control-center/test/weekly-report.unit.test.ts:1354` 和 `test/e2e/fixtures/control-center-browser-server.mjs:1247` 对 revision 2 设了 `current: true`，会走到“只记了规则名”的 UI 分支，但测试没有断言它不存在。这可能只是夹具语义不同，未核实是否应从真实接口生成。
- **`money_state` 暴露在公共字段目录，但只有地板路径提供值。** `field-catalog.ts:47` 新增了 `money_state`；`floorHitIds` 会传模型结果，但 `outcomeHits`、`suppressPushHits`、`owner-rule-replay.ts:155` 都用默认 `unknown`。当前没有发现任何 owner 规则使用这个字段，因此是潜在问题而非现存故障。
- **抽取超时后保留已成功批次的结果。** `#references` 在超时/失败后只跳过当前批次，之前批次已收集的 references 仍会传给 `#related`；ADR 0249:53 的“超时时不搜单号”如果指整个阶段，措辞就偏严。未核实作者意图。

## 三、侧重检查

- **错误路径：** 单号输出不是 JSON、不是 `items` 数组、id 未知、references 不是列表、条目格式错，都会抛错或被跳过，最终不搜单号；判断/抽取超时和失败只降级为线程和同标题同参与人；不通过则没有额外请求。记忆确认裁判解析失败会重试一次，仍失败返回 `false` 且不写缓存；评测泄露裁判失败返回 `true`，按泄露处理，预算错误单独抛出。涉钱字段只接受 `yes`/`no`，其余为 `unknown`，默认不命中。总体失败方向是安全的。
- **不可信输入：** 模型返回的单号被限制为 `A-Z0-9-`、8-40 位、必须逐字整词出现在邮件中，不能注入 Gmail 查询操作符；每封最多 3 个。邮件内容有“不可信数据”提示。缺口是第 3 条：日期形态校验不完整，电话号码等也只能靠提示词约束。
- **安全与隐私：** 新调用都是后台提示词；邮件正文在 `baseMailView` 里先 `masked()`；支持裁判沿用 `plan.request` 的 `dataClassification`；缓存只存布尔值和哈希，不存正文。未发现新的日志泄密点。
- **资源耗尽：** 每日费用上限仍有检查，抽取有单独的 1/6 超时，输出有 `MAX_OUTPUT_BYTES`，单号每封最多 3 个，支持缓存最多 500 条后清空。问题是第 1、2 条：抽取预留可能不足，且抽取会挤占相关读取的半窗。
- **不可撤销操作：** 记忆确认只有裁判明确 `true` 才生效，失败不生效；评测只在泄露裁判判否时入库；Gmail 单号搜索是只读的。未发现新增不可撤销动作。
- **文档/规则一致性：** 第 4、5 条已确认两处不一致；ADR 0249 的两条后果与代码大部分一致，但“不占半窗”与第 2 条实现不一致。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会改变对话请求的系统提示、工具定义或历史。新提示词都标为 `layer: "background"`：`mail.judgment`、`mail.reference-extraction` 用于邮件后台检查，`eval.real-memory.leak-judge` 用于评测后台，`memory.confirmation-judge` 用于记忆后台。`proactivePrompt` 仍是固定文字在前、数据在后，`now` 放在最后一段（`proactive-mail-check-service.ts:476-503`）；`mailReferencePrompt` 也是固定文字后接 JSON（`:449-457`）。发给模型的内容仍只在末尾追加，每轮变化的值仍在最后。唯一间接路径是 `TRUSTED_PROMPT_TEXTS` 全局清单变化，见“推测”第一条，未核实有旧对话受影响。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   没有发现新的输入序列化不确定性：新提示词的 JSON 键顺序固定，邮件顺序来自候选列表，`validMailReferences` 按数组顺序处理，缓存键是固定 sha256，`parseMailMoney` 是确定性解析。单号抽取会让“同一封邮件”在不同运行中因为模型回答不同而关联到不同旧邮件，从而让判断提示词内容不同；这是模型输出和内容变化，不是同一段输入文字被序列化成不同字节。没有新增带时间的字段或无序集合进入模型请求。

3. **有没有自动检查，反向用例是否真的会失败？**
   有，但不完整。已覆盖：单号逐字校验、未知 id、非列表、不搜伪造号码/带横线日期、预算不足不抽取、抽取不占判断预算；涉钱 `yes/no/unknown` 和“词表命中但模型答否”；评测主问题/拒答题泄露、裁判故障、declined；记忆裁判 `true/false/格式错`。缺口：没有 1/6 超时测试；预算反向测试用固定估算且无 related/摘要，删掉预留会失败，但改小预留不会失败；没有 `20261107` 这类紧凑日期的反向用例，因此删掉日期校验后现有测试仍可能通过；没有直接测试支持裁判缓存键变更和批内顺序执行；文档不一致没有自动检查。结论：现有反向用例在它们覆盖的输入上确实会失败，但不覆盖第 1、3 条的问题。

4. **每个改动值的产生方和使用方都能接受吗？**
   - `money_state`：产生于 `parseMailMoney`/`parseJudgements`/`mailItemFacts`，用于 `floor_money_words` 表达式和 `floorHitIds`；UI、数据导出、规则版本和夹具已同步。`proactive-overview.ts:150` 会不带 money 重算地板，ADR 0248:80 已承认旧提醒行无法再按词表补判，因此可接受但会漏掉旧数据。其他 `outcomeHits`、`suppressPushHits`、`owner-rule-replay` 不提供 money，任何使用该字段的非地板规则都会得到 `unknown`；当前未发现这样的规则。
   - `references`：产生于 `#references`，端口新增可选字段，`gmail-source`、`demo-mailbox`、`findRelatedMail` 都接受；单号最终仍经过 `gmail-related.ts` 的逐字 `mentions` 检查。
   - `supportCheckKey`/缓存键：解析侧和裁判侧都用同一 `memoryId + quote` 作为 verdict 键，缓存键用 `memoryText + quote + prompt version`；两端一致。缓存不包含 owner/model，但内容相同则判定相同，当前可接受。
   - `rejected.leak`、declined：生产方在评测服务，使用方是 run summary 和测试；没有额外后端枚举校验。
   - 规则 id/版本：`floor_money_words` 仍是合法 id，revision 2 能被 `describeRuleVersion` 重建；revision 1 改为“内容查不到”，ADR 0248 已写明。决策记录里的 `floor_money_words@2`、UI 夹具、数据导出标签、提示词清单和契约测试都已同步。
   - 仍有一个使用方需要确认：夹具的 `current: true` 与 `describeRuleVersion` 的语义不一致，但当前没有测试因此失败，见“推测”第二条。
