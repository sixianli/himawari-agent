## 侧重检查

我按本轮侧重逐项看了以下路径（只读代码/文档，未运行任何测试）：

- **错误路径**：`#references` 对每次模型调用都有 try/catch（`proactive-mail-check-service.ts:691-697`），`#related` 对读取异常统一降级（`731-758`）。本轮改动只移动了 `relatedSignal` 的创建位置、给预留多算一段摘要，没有新增错误分支。
- **不可信输入**：模型返回的单号仍先过 `REFERENCE_SHAPE`、`DATE_SHAPE` 和 `appearsAsWholeToken`（`proactive-references.ts:5-6,25-41`）；本轮未改这些校验。新增的摘要占位是程序自己生成的字符串，不来自模型或邮件。
- **安全 / 注入**：单号字符集仍限于 `[A-Z0-9-]`，拼进 Gmail 查询前已过滤，本轮未放宽。
- **资源耗尽 / 不可撤销操作**：本轮新增的分配是 `"。"` 重复 `summaryLimits.characters` 次（生产未传 `summaryLimits`，默认 4000，见 `service.ts:209-214`、`production-proactive.ts:196-230`），本身有限；不可撤销的只有已经花掉的模型调用费用，仍受每日上限约束。
- **文档与代码一致**：核对了 `agent-rulebook-inventory.md:211`（与删除 `MONEY_SUBSTRINGS`/`MONEY_WORDS` 一致）、ADR 0249:53（与 `DATE_SHAPE` 一致）、ADR 0180:41（发现仍引用已删除的 `extractReferenceIds`，见下）。

---

## 发现的问题（读代码证实的）

### 1. 中：ADR 0180 第 41 行仍是自相矛盾、引用已删除的代码

- 文件：`docs/adr/0180-gmail-check-reads-earlier-mail-about-the-same-matter.md:41`
- 问题：本轮加的括注说“下面说的标签正则和 `extractReferenceIds` 已删除”，紧接着同一句仍以现在时写“规则见 `packages/platform-node/src/gmail-related.ts` 的 `extractReferenceIds`：……”。而 `gmail-related.ts` 里已经没有 `extractReferenceIds`，全仓库也搜不到该符号，只剩这一处文档引用。作者说“ADR 0180 第 41 行的说法已更新”，实际只加了半句说明，旧描述没有改成过去时/删除。
- 证据：
  - `0180...:41`：`（本条的单号来源已被 [ADR 0249]... 改为模型抽取、程序逐字校验；下面说的标签正则和 \`extractReferenceIds\` 已删除。）正文或标题里带标签的编号（...规则见 \`packages/platform-node/src/gmail-related.ts\` 的 \`extractReferenceIds\`：...）`
  - `gmail-related.ts:145-146`：现在只消费 `input.references`；全仓库 grep 除该文档外没有 `extractReferenceIds`。
- 建议：把整条旧规则改成过去时或删掉，规则来源指向新的 `packages/application/src/services/proactive-references.ts` 的 `parseMailReferences` / `validMailReferences`，不要继续指向已删除符号。

### 2. 中：单号抽取的预留补了摘要，但仍没有覆盖相关邮件和记忆，仍可能吃掉判断预算

- 文件：`packages/application/src/services/proactive-mail-check-service.ts:908-941`（预留）与 `974-997`（实际判断）
- 问题：新的 `referenceReserveMicros` 用 `proactivePrompt` 估算判断成本，但传的是空 `related`（`:917`）和空 memories（`:921`），只额外补了摘要占位（`:924-939`）。实际判断用的 `firstBatch` 含 `relatedViews`（`:974,985`）和 `#batchMemories`（`:983`）。相关邮件上限是每封 `charactersPerMail: 12_000`、整串往来 `wholeThreadCharactersPerMail: 60_000`（`:167-174`），而 `#fitBatch` 对第一个邮件无论多大都会放入（`:1238-1245`）。因此第一封带整串往来的邮件，实际判断提示词可比预留多出约 6 万字符；在每日额度紧张时，单号抽取会先花掉本应留给判断的钱，随后 `:1024` 的检查只能 `capped_daily` 停止，邮件没被判断。每日上限不会被突破，但“单号抽取不占判断的房间”这个保证仍不成立。
- 证据：
  - `:917` `new Map<string, RelatedView>()`；`:921` `[]`（预留时空的相关邮件和记忆）
  - `:974` `const firstBatch = this.#fitBatch(candidates, batchSize, bodyLimits, relatedViews);`
  - `:985` `relatedViews,`；`:983` `this.#batchMemories(firstBatch, recalled.hits),`
  - `:167-174` `charactersPerMail: 12_000, wholeThreadCharactersPerMail: 60_000`
  - `:1240-1245` 第一个 item 无条件放入，`if (batch.length > 0 && size + next > bodyLimits.perBatch) break;`
- 建议：给单号抽取单独设一个小的、独立于判断预算的额度（例如每日额度的一小部分），或按 `#relatedLimits()`/`memoryLimits` 给预留加一个上界（至少对第一个 item 加 `max(charactersPerMail, wholeThreadCharactersPerMail)` 和记忆上界）。并补一条“大整串往来 + 紧每日额度”的用例，断言单号抽取被跳过、判断仍执行。

### 3. 低：本轮的新增预留没有能让“反向用例真的失败”的自动检查

- 文件：`test/integration/proactive-mail-check.test.ts:3657-3680`、`2695-2704`
- 问题：作者说第 2 轮“单号抽取的预算预留补上摘要占位”，但该提交里测试文件只改了日期用例的标题，没有新增断言。现有摘要预留用例 `3657` 没有调用 `scriptReferences`，单号抽取走的是默认回退模型且 `cost = 0`（`:366-368`），所以即使把新加的摘要占位删掉，该用例的 `invocations() === 1`、`prompts[0]` 含标题、`summaryGenerated: 0` 仍会成立，抓不到回退。`2695` 那条例又没有摘要。也就是说，新预留逻辑没有任何测试会在它被改坏时失败。
- 证据：
  - `:3657-3665` 用 `recentSummaries` + `dailyCostMicros: 5_000`，但全用例没有 `scriptReferences(...)`
  - `:366-368` 参考抽取回退：`referenceEvents('{"items":[]}', 0)`，成本为 0
  - `:2695-2704` 无 `recentSummaries`，只覆盖“抽取 vs 判断”的裸场景
- 建议：加反向用例：`recentSummaries` + 紧每日额度 + `scriptReferences(..., 有非零成本)`，断言 `referencePrompts` 为空且判断仍执行；删掉摘要占位时该用例必须失败。同样，`relatedSignal` 移到抽取之后也没有任何时间/超时用例覆盖。

### 4. 低：改名后的集成反向用例实际上没有测到 `YYYY-MM-DD` 排除

- 文件：`test/integration/proactive-mail-check.test.ts:2652-2668`
- 问题：用例名改成“...or a YYYY-MM-DD date is never searched”，但被判断的 `today` 邮件正文（`:2568`）是 `ご注文番号 ${ORDER} の件、本日中に...`，不含 `"2026-11-07"`。因此该串会被“必须逐字出现在邮件里”这一关拒绝，而不是被 `DATE_SHAPE` 拒绝；把 `DATE_SHAPE` 删掉这条集成用例仍会通过。真正覆盖日期排除的是单元测试 `packages/application/test/proactive-references.unit.test.ts:18-26`（那里把 `2026-11-07` 放进了邮件正文）。
- 证据：
  - `:2657-2663` 提案里有 `"2026-11-07"`
  - `:2568` 邮件正文不含该日期
  - `proactive-references.ts:35-36`：先 `DATE_SHAPE.test`，再 `appearsAsWholeToken`
  - 单元测试 `:19-25` 的 `other` 邮件正文含 `予約日 2026-11-07` 并断言结果为 `[]`
- 建议：要么把日期写进被判断的邮件正文，让它真正走 `DATE_SHAPE`；要么把集成用例名改回“not in the mail”，日期排除交给单元测试，避免名称与实测不符。

### 5. 低：配置禁用摘要时，预留仍按 4000 字摘要占位，会不必要地跳过单号抽取

- 文件：`packages/application/src/services/proactive-mail-check-service.ts:924-939` 与 `#summaries` 的 `1514`
- 问题：预留只判断 `recentSummaries !== undefined`，就加 4000 字摘要占位；但 `#summaries` 在 `limits.days < 1 || limits.perCheck < 1 || limits.characters < 1` 时直接返回 `[]`（`:1514`）。如果配置把摘要关闭，实际判断没有摘要块，预留却仍多算 4000 字，额度紧张时会无谓地跳过单号抽取。生产当前不传 `summaryLimits`，所以影响只在自定义配置/测试接线时出现。
- 证据：`:924-939` 只看 `recentSummaries`；`:1513-1514` 才检查三个上限。
- 建议：预留时用与 `#summaries` 相同的“是否真的会有摘要”判断（三个上限都大于 0），而不是只看 `recentSummaries` 是否存在。

---

## 推测（未运行验证）

- 第 2 条的实际后果是“先花抽取费、后判断被 `capped_daily` 截断”，这是我从 `:687` 的额度检查、`:1024` 的判断额度检查和 `#fitBatch` 的首项例外推出来的，没有运行用例复现；每日总花费仍不会超过 `dailyCostMicros`。
- 摘要占位只放一个对象、最多 4000 字，而真实摘要最多 8 个对象、总字数同为 4000（`:1509-1574`），JSON 对象开销会多出几十到一百多字符，属于轻微低估；因生产默认 `estimateCostMicros` 按字符数计价（`production-proactive.ts:87-91`），影响很小。
- 第 3 条“即使删掉摘要占位测试也会通过”是基于 `MAIL_JUDGMENT` 文本长度和 `estimatePerCharacter` 的手工推算，未实际运行；但无论如何，该用例从未断言 `referencePrompts`，覆盖缺口是确定的。

未核实：未运行 `npm test`/`npm run check`；`.agents/reviews/pr-423/round-2/*` 只能通过 git 看到是二进制条目，`git show` 被环境拒绝，工作树里也没有这些文件，因此没有读到上一轮复核原文。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本轮对服务端只改了“预算预留的估算字符串”和“相关邮件超时信号的创建时机”。预留用的 `proactivePrompt(...)` 返回值只喂给 `estimateCostMicros`（`service.ts:911-941`），从不发给模型；实际判断提示词仍是“固定指令 → 摘要 → 记忆 → 邮件 → 最后的 `现在是…`”（`mail.ts:89-101`，`service.ts:476-503,1014-1022`），和改动前相同。本轮没有改动聊天路径的系统提示、工具定义、历史或遮盖。依据 `.claude/rules/prompt-prefix.md` 第 4、10、15 条：发给模型的内容只在末尾追加，会变的时间仍在最后。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。新增的摘要占位只在进程内用于估算，`day`/`text` 都不进入模型请求，也不落库；`relatedSignal` 只是定时器。文档和测试标题不参与序列化。没有新增无序集合、时间字段或依赖后文的遮盖。唯一与时间有关的差异仍是原有的“相关邮件是否在超时前取到”，那不是同一内容的不同序列化。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
部分有、部分是缺口：
- 摘要预留：没有能让“删掉占位”失败的用例（见问题 3）。
- `relatedSignal` 后移：没有时间/超时用例。
- 日期说法：`DATE_SHAPE` 有真正的反向覆盖（`proactive-references.unit.test.ts:18-26`，日期在邮件正文里），但改名的集成用例 `proactive-mail-check.test.ts:2652` 实际没有测到日期分支（见问题 4）。
- 文档改动：无自动检查，需人工核对。

**4. 每个产生/修改的值，使用它的地方都能接受吗？**
- 新占位对象 `{id:"reserve", day, text, dataClassification}`：只被 `proactivePrompt` 读取 `day`/`text`（`service.ts:467,478-482`），`id` 和 `dataClassification` 根本没被使用，也不进入 `trace`、决策记录、清单或数据库；没有跨边界的校验问题。
- `referenceReserveMicros`：只在 `#references` 的数值比较里使用（`service.ts:944,686-690`），类型和含义匹配。
- `relatedSignal`：只在 `#related` 的 `AbortSignal.any` 中使用（`service.ts:954-957,728`），语义匹配。
- `day: startedAt.slice(0,10)`：是 `YYYY-MM-DD`，但不落库、不经过 `summaryDays` 的校验；因此不存在“清单 id 过不了后端校验”那类问题（I-73 不适用）。
- 文档里的 `extractReferenceIds`：这是唯一“使用方已不存在”的名字，见问题 1；ADR 0249:53 的新说法与代码 `DATE_SHAPE`/`REFERENCE_SHAPE` 一致，盘点文档第 211 行与已删除的两张词表一致。
